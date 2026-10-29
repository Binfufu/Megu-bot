/**
 * **DeepSeek 搜索/网页读取 provider**(P3-a,2026-10-28)。
 *
 * ## 为什么是"provider"而不是"能力"
 *
 * 能力(`web_search` 工具)在 capabilities 层定义;这一层只回答"**怎么调**"——
 * 换一家搜索供应商 = 换这个文件,能力定义/授权/循环都不动(主模型与搜索解耦)。
 *
 * ## 照搬出处(2026-10-28 已核官方全文)
 *
 * DeepSeek Search & Fetch:独立 JSON API,同 bearer 鉴权。
 *   Search: POST {base}/v1/tools/search {query, count, need_content}
 *   Fetch:  POST {base}/v1/tools/fetch  {url}
 * 计费按成功请求计;**402=余额不足不重试**,408/429/5xx 可重试,其余 4xx 不盲试。
 * https://api-docs.deepseek.com/guides/search/
 *
 * ## 安全边界
 *
 * · fetch 的 URL 校验在本层做(fail closed):必须 http/https、有 host、**不许带
 *   用户名/密码**(官方同款要求)、≤8192 字符;
 * · 网页内容是**外部不可信材料**——返回结构里带 `untrusted: true`,消费方(提示词装配)
 *   必须把它当资料而不是指令(不许因网页内容升级权限/读私有记忆);
 * · key 只进 Authorization 头,**任何日志/错误消息都不带 key**。
 */

/** 官方上限:count 1~50、query ≤128 字、URL ≤8192 字符(出处见文件头)。 */
export const SEARCH_LIMITS = Object.freeze({ countMin: 1, countMax: 50, queryMaxChars: 128, urlMaxChars: 8192 });

/**
 * **私网/本机/元数据地址**——一律不许 fetch(2026-10-28 主人拍板"按推荐来")。
 *
 * 推荐口径两条:
 *   ① **永远硬挡**:本机、内网、链路本地(含云厂商元数据 169.254.169.254)、
 *      `.local`/`.internal`/`.lan`/`.home` 这类内网域名 —— 不需要配置,写死在代码里;
 *   ② **可选白名单**:`QQBOT_WEBFETCH_ALLOW=example.com,baike.example` 一旦配置,
 *      fetch 只许这些域(含子域);不配 = 公网都可(配合上面的硬挡)。
 * 为什么不默认只许白名单:搜索结果天然跨域,默认白名单等于把 web_fetch 关掉;
 * 真正危险的是内网/元数据,那一类硬挡就够。要更严就配白名单。
 */
const PRIVATE_V4_RE = /^(?:0|10|127)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./;

/** 是不是私网/本机/元数据主机名(纯函数,只看 host)。 */
export function isPrivateHost(host) {
  const text = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (text === '') return true;
  if (text === 'localhost' || text.endsWith('.localhost')) return true;
  if (text.endsWith('.local') || text.endsWith('.internal') || text.endsWith('.lan') || text.endsWith('.home')) return true;
  if (text === '::' || text === '::1' || text === '0.0.0.0') return true;
  if (text.startsWith('fe80:') || text.startsWith('fc') || text.startsWith('fd')) return true; // 链路本地 / ULA
  if (PRIVATE_V4_RE.test(text)) return true;
  return false;
}

/**
 * URL 准入(纯函数)。返回 `{ok, url}` 或 `{ok:false, reason}`。
 * 顺序:形状闸 → 私网硬挡 → 可选白名单。
 *
 * @param {string} raw
 * @param {{allowedHosts?: string[]|null}} [options] 非空 = 只许这些域(含子域)
 */
export function validateFetchUrl(raw, { allowedHosts = null } = {}) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'URL 为空' };
  if (text.length > SEARCH_LIMITS.urlMaxChars) return { ok: false, reason: `URL 超过 ${SEARCH_LIMITS.urlMaxChars} 字符` };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: 'URL 无法解析' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `只许 http/https,收到 ${parsed.protocol}` };
  }
  if (!parsed.hostname) return { ok: false, reason: 'URL 没有 host' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'URL 不许带用户名/密码' };
  // ① 私网/元数据硬挡(不可配置放开)。
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: `私网/本机/元数据地址不许抓:${parsed.hostname}` };
  }
  // ② 可选白名单:配了就只许列表内(含子域)。
  const allow = Array.isArray(allowedHosts)
    ? allowedHosts.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (allow.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const hit = allow.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!hit) return { ok: false, reason: `域名不在许可清单:${host}` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * 造一个 DeepSeek 搜索/抓取 provider。
 *
 * @param {{baseUrl: string, apiKey: string, timeoutMs?: number,
 *          allowedHosts?: string[]|null,
 *          fetchImpl?: typeof fetch, now?: () => number}} input
 *   `baseUrl` = DeepSeek API 根(与主模型同一个部署可复用同一个 key 的引用,但**显式传入**,
 *   不许从模型客户端里"顺手拿"——搜索凭据是自己的配置项)。
 *   `allowedHosts` = 可选域名白名单(配了只许这些域;不配 = 公网可抓,私网/元数据永远硬挡)。
 * @returns {{id: string, search: Function, fetchPage: Function}}
 */
export function createWebSearchProvider({
  baseUrl, apiKey, timeoutMs = 20_000, allowedHosts = null, fetchImpl = fetch, now = Date.now,
}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('createWebSearchProvider: baseUrl 必填');
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error('createWebSearchProvider: apiKey 必填');
  if (typeof fetchImpl !== 'function') throw new Error('createWebSearchProvider: 没有 fetch 可用');
  // ⚠️ 凭据与 bot slot 共用后(P3 主人拍板:搜索用 bot 一样的 key),baseUrl 很可能带着
  //    `/v1` 尾(chat 端点用)。搜索端点自己拼 `/v1/tools/...`,这里把尾巴剥掉再拼,
  //    免得出现 `/v1/v1/tools/...`(2026-10-28)。
  const root = String(baseUrl).replace(/\/+$/, '').replace(/\/v\d+$/i, '');

  function headers() {
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  }

  /** 统一错误分类(照官方文档的"该不该重试"表,不发明)。 */
  async function callApi(path, body, signal) {
    const startedAt = now();
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return { ok: false, error: { code: 'CANCELLED', message: '已取消', retryable: false } };
      return { ok: false, error: { code: 'NETWORK', message: String(err?.message ?? err), retryable: true } };
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* 非 JSON:按状态码说 */ }
    if (!response.ok) {
      const message = payload?.error?.message ?? `HTTP ${response.status}`;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const code = response.status === 401 || response.status === 403 ? 'AUTH'
        : response.status === 402 ? 'NEED_BALANCE'
          : response.status === 429 ? 'RATE_LIMIT'
            : response.status === 404 ? 'NOT_FOUND'
              : retryable ? 'UPSTREAM' : 'BAD_REQUEST';
      return { ok: false, error: { code, message, retryable, status: response.status } };
    }
    return { ok: true, data: payload, elapsedMs: now() - startedAt };
  }

  return {
    id: 'deepseek-search',
    /**
     * 搜索。返回 `{ok, results:[{url,title,snippet,summary,date,untrusted:true}], error?, elapsedMs}`。
     * 空结果是**成功**(ok:true + 空 results)——"没搜到"不是失败,不许拿失败冒充没搜到或反之。
     */
    async search(query, { count = 5, signal } = {}) {
      const text = String(query ?? '').trim();
      if (text === '') return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: '搜索词为空', retryable: false } };
      if (text.length > SEARCH_LIMITS.queryMaxChars) {
        return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: `搜索词超过 ${SEARCH_LIMITS.queryMaxChars} 字`, retryable: false } };
      }
      const bounded = Math.max(SEARCH_LIMITS.countMin, Math.min(SEARCH_LIMITS.countMax, Number(count) || 5));
      const result = await callApi('/v1/tools/search', { query: text, count: bounded, need_content: false }, signal);
      if (!result.ok) return result;
      const results = (Array.isArray(result.data?.results) ? result.data.results : []).map((hit) => ({
        url: String(hit?.url ?? ''),
        title: String(hit?.title ?? ''),
        snippet: String(hit?.snippet ?? ''),
        summary: String(hit?.summary ?? ''),
        date: hit?.date == null ? null : String(hit.date),
        retrievedAt: new Date(now()).toISOString(),
        untrusted: true,
      }));
      return { ok: true, results, elapsedMs: result.elapsedMs };
    },
    /** 抓单页(返回 Markdown 正文)。同样带 untrusted 标记。 */
    async fetchPage(url, { signal } = {}) {
      const check = validateFetchUrl(url, { allowedHosts });
      if (!check.ok) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: check.reason, retryable: false } };
      const result = await callApi('/v1/tools/fetch', { url: check.url }, signal);
      if (!result.ok) return result;
      return {
        ok: true,
        url: check.url,
        title: String(result.data?.title ?? ''),
        content: String(result.data?.content ?? ''),
        retrievedAt: new Date(now()).toISOString(),
        untrusted: true,
        elapsedMs: result.elapsedMs,
      };
    },
  };
}
