#!/usr/bin/env node
/**
 * JM 搜本/下本的**网络边界**（2026-11-12，独立 CLI；2026-11-12 v2 加编号解析与单元本）。
 *
 * 与 `scripts\meitu-fetch-one.mjs` 同构：bot 把它当子进程 spawn（`src\jm-service.js`），
 * 它只做三件事：
 *   ① 用 Node 内置 `fetch` 调**本机 JM 边车服务**（HTTP，默认 `http://127.0.0.1:8790`）；
 *   ② 拉整本/单单元/选集 PDF 到调用方给的临时目录（QQ 上传只认本地文件路径）；
 *   ③ 把结果写成 stdout **最后一行** JSON，日志一律走 stderr。
 *
 * 2026-11-12 v2（1.210.3）起：
 *   · 新增 `--op resolve`：纯数字**编号**先按 album/章节精确解析，**不再走站内关键词搜索**；
 *   · `--op download` / `--op pdf` 支持 `--unit`：只下载/只打包该作品下的一个单元本（章节）；
 *   · `--op search` 不再下载拼图/封面（Node 侧已不发图），并可传 `--images 0` 让边车
 *     跳过详情/封面/拼图，缩短搜索回执。
 *
 * 边车是唯一碰 JM/网络/漫画库的进程（部署与 API 契约见 `docs\45-JM搜本.md`）。
 * 本文件**不 import 任何 src/ 模块**：它保持"可单独跑、只依赖 Node 内置模块"的形状，
 * 方便部署者用 `node scripts\jm-fetch-one.mjs --op health` 自查。
 *
 * 用法：
 *
 *     node scripts\jm-fetch-one.mjs --op health --api http://127.0.0.1:8790
 *     node scripts\jm-fetch-one.mjs --op search --q 全彩 --limit 3 \
 *       --api http://127.0.0.1:8790 --images 0 --timeout 120000
 *     node scripts\jm-fetch-one.mjs --op resolve --id 1205081 --api http://127.0.0.1:8790
 *     node scripts\jm-fetch-one.mjs --op download --id 1195659 --unit 1205081 \
 *       --api http://127.0.0.1:8790 --timeout 120000
 *     node scripts\jm-fetch-one.mjs --op pdf --id 1195659 --unit 1205081 \
 *       --api http://127.0.0.1:8790 --out-dir %TEMP%\jm-pdf --timeout 180000
 *
 * 参数：
 *   --op search|resolve|download|pdf|health  必填（分别对应边车的
 *        /search、/resolve/<id>、/download+/jobs、/pdf、/health）
 *   --q <关键词>                 search 必填，1..60 字符
 *   --limit N                    search 用；普通搜索 1..5（默认 5），
 *                                结构化模式/细节模式最多 10（边车契约上限）
 *   --mode site|work|author|tag|actor  search 可选：站点/原作/作者/标签/角色模式
 *   --page N                     search 可选：页码，默认 1
 *   --order mr|mv                search 可选：排序，mr=最新、mv=观看数/热门；
 *                                不传 = 不发 order 参数（边车缺省 mr；bot 默认显式传 mv）
 *   --window 1|0                 search 可选：1 = 逻辑翻页（第 page 页 = 第
 *                                (page-1)*limit+1 .. page*limit 条，边车映射到上游分页，
 *                                只回文字清单，须配合 --images 0）；默认 0 = 旧口径（page 是上游页）
 *   --details 1|0                search 可选：1 = 只取文字详情（作者/标签/页数），
 *                                不取封面/拼图；默认 0
 *   --id <编号>                  resolve/download/pdf 必填，纯数字（作品或单元编号）
 *   --unit <单元编号>            download/pdf 可选：只处理该作品下的一个单元本
 *   --units <111,222,333>        仅 pdf：合并所选单元，与 --unit 互斥；不改变 download API
 *   --images 0|1                  search 可选：0 = 不要图（边车跳过详情/封面/拼图）；默认 1
 *   --api <base>                 边车地址，默认 http://127.0.0.1:8790
 *   --out-dir <dir>              pdf 必填：PDF 落到这里（调用方负责清理）
 *   --timeout <ms>               整个操作的**总预算**，默认 120000
 *   --request-timeout <ms>       单次 HTTP 请求上限，默认 45000（2026-11-20 可配；
 *                                旧版硬编码 15000，比边车自己的 JM 超时 30s 还短）
 *   --pdf-max-bytes N            pdf 上限，默认 200MB（QQ 群文件硬限）
 *
 * 成功/失败都输出 JSON（退出码恒 0，调用方只认那条 JSON；可读的失败比"崩了"好排查）：
 *
 *   health   → {"ok":true,"op":"health","service":"jm-service","version":"1.0.0",
 *               "viewerBase":"http://127.0.0.1:8088","downloadedAlbums":12}
 *   search   → {"ok":true,"op":"search","query":"全彩","mode":"author","page":1,"order":"mr",
 *               "window":false,"details":true,"total":10000,"cached":false,"text":"1.…",
 *               "results":[{rank,id,title,authors,tags,pageCount,detailOk}]}
 *   resolve  → {"ok":true,"op":"resolve","requested":"1205081","kind":"album"|"photo",
 *               "album":{id,title,authors,tags,pageCount,unitCount,
 *                        units:[{index,unitId,title,pageCount}]},
 *               "matchedUnit":{index,unitId,title,pageCount}|null}
 *               （authors/tags 缺字段 = 元数据未知；空数组 = 确认没有）
 *   download → {"ok":true,"op":"download","id":"1195659","unit":"1205081|null","status":"done",
 *               "title":"…","viewerUrl":"…","dir":"…"}
 *   pdf      → {"ok":true,"op":"pdf","id":"1195659","unit":"1205081|null",
 *               "path":"…\\JM1205081.pdf","bytes":123456}
 *   失败     → {"ok":false,"op":"…","reason":"service_down|timeout|bad_json|…",
 *               "detail":"人话"}
 *
 * 失败码：`bad_args`（参数不合法）/ `service_down`（连不上边车）/ `timeout`（整体超时）/
 * `bad_json`（响应不是约定形状）/ `http_error`（边车回 4xx/5xx）/ `api_error`（边车 ok=false）/
 * `download_failed`（下载任务失败）/ `too_large`（PDF 超上限）/ `bad_pdf`（不是 PDF）/
 * `io_error`（写不进临时目录）/ `internal`（兜底）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const DEFAULT_API = 'http://127.0.0.1:8790'; // 边车默认端口；部署可改 --api / QQBOT_JM_API
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PDF_MAX_BYTES = 200 * 1024 * 1024; // QQ file_type=4 的硬限就是 200MB
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 5; // QQ 侧普通搜索一次最多看 5 本（边车契约允许 10）
const MAX_LIMIT_DETAILS = 10; // 结构化检索需要多取候选做 AND 复核；边车上限就是 10
const SEARCH_MODES = new Set(['site', 'work', 'author', 'tag', 'actor']);
// 排序（边车契约 v4）：mr=最新、mv=观看数/热门；与边车 SEARCH_ORDERS 同一口径。
// 不传 = 不发 order（边车缺省 mr）；bot 的「默认热门」由服务层显式传 --order mv。
const SEARCH_ORDERS = new Set(['mr', 'mv']);
const MAX_SEARCH_PAGE = 100_000; // 与边车 /search 的 page 上界一致
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000; // 单次请求上限（2026-11-20：旧版硬编码 15s）
const POLL_MS = 1_500; // 下载任务轮询间隔
const MAX_KEYWORD_CHARS = 60;

/** 日志一律走 stderr：stdout 只留最后那一行 JSON。 */
const log = (...parts) => {
  try {
    process.stderr.write(`[jm] ${parts.join(' ')}\n`);
  } catch {
    // stderr 写不进去也不影响结果。
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 统一失败体：reason 机器可读，detail 给人看。 */
function fail(reason, detail) {
  return { ok: false, reason: String(reason ?? 'internal'), detail: String(detail ?? '') };
}

/** 边车 base 与相对路径拼绝对 URL（边车回包里的 `cover_http` 是站内绝对路径）。 */
function apiUrl(apiBase, pathname) {
  const base = String(apiBase ?? DEFAULT_API).trim().replace(/\/+$/u, '');
  const suffix = String(pathname ?? '');
  if (/^https?:\/\//iu.test(suffix)) return suffix;
  return `${base}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
}

/** 解析 CLI 参数。**不抛**：坏值就地修正并记 stderr（同 meitu 抓取器的口径）。 */
export function parseJmArgs(argv) {
  const options = {
    op: '',
    q: '',
    id: '',
    unit: '',
    unitGiven: false,
    // null = 未传；空串 = 显式空值，必须报错，不能退回整本。
    units: null,
    limit: DEFAULT_LIMIT,
    mode: 'site',
    page: 1,
    // '' = 未传（不发 order 参数，边车默认 mr）；显式值只收 mr/mv。
    order: '',
    // false = 旧口径（page 是上游站内页）；true = 逻辑翻页窗口（见文件头）。
    window: false,
    details: false,
    api: DEFAULT_API,
    outDir: '',
    images: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    pdfMaxBytes: DEFAULT_PDF_MAX_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    const next = () => {
      i += 1;
      return String(argv[i] ?? '');
    };
    switch (arg) {
      case '--op': options.op = next().trim().toLowerCase(); break;
      case '--q': case '--query': options.q = next().trim(); break;
      case '--id': options.id = next().trim(); break;
      case '--unit': options.unitGiven = true; options.unit = next().trim(); break;
      case '--units': options.units = next().trim(); break;
      case '--limit': options.limit = Number.parseInt(next(), 10); break;
      case '--mode': options.mode = next().trim().toLowerCase(); break;
      case '--page': options.page = Number.parseInt(next(), 10); break;
      case '--order': options.order = next().trim().toLowerCase(); break;
      case '--window': {
        const raw = next().trim().toLowerCase();
        options.window = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
        break;
      }
      case '--details': {
        const raw = next().trim().toLowerCase();
        options.details = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
        break;
      }
      case '--api': options.api = next().trim(); break;
      case '--out-dir': case '--out': options.outDir = next().trim(); break;
      case '--images': {
        const raw = next().trim().toLowerCase();
        options.images = !(raw === '0' || raw === 'false' || raw === 'no');
        break;
      }
      case '--no-images': options.images = false; break;
      case '--timeout': options.timeoutMs = Number.parseInt(next(), 10); break;
      case '--request-timeout': options.requestTimeoutMs = Number.parseInt(next(), 10); break;
      case '--pdf-max-bytes': options.pdfMaxBytes = Number.parseInt(next(), 10); break;
      default:
        log(`忽略不认识的参数:${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) options.limit = DEFAULT_LIMIT;
  const hardLimit = options.details || options.mode !== 'site' ? MAX_LIMIT_DETAILS : MAX_LIMIT;
  options.limit = Math.min(options.limit, hardLimit);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
    options.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  }
  options.requestTimeoutMs = Math.min(options.requestTimeoutMs, options.timeoutMs);
  if (!Number.isSafeInteger(options.pdfMaxBytes) || options.pdfMaxBytes <= 0) options.pdfMaxBytes = DEFAULT_PDF_MAX_BYTES;
  return options;
}

/** 带超时的 `fetch`；把超时/网络错误都翻译成稳定 reason。 */
async function fetchWithTimeout(url, init, timeoutMs, fetchImpl) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
  } catch (err) {
    const name = String(err?.name ?? '');
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`timeout:${url}`);
    throw new Error(`service_down:${err?.message ?? err}`);
  }
}

/**
 * 请求一个 JSON 接口。**不抛**（除把失败归好类）：
 * @returns {Promise<{ok: true, data: any} | {ok: false, reason: string, detail: string}>}
 */
async function fetchJson({ url, init, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs, fetchImpl);
  } catch (err) {
    const [reason, detail] = String(err?.message ?? err).split(/:(.*)/s);
    return fail(reason === 'timeout' ? 'timeout' : 'service_down', detail ?? String(err));
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status} ${url}`;
    let errorCode = '';
    try {
      const text = await response.text();
      const data = JSON.parse(text);
      if (data?.message) {
        errorCode = String(data.error ?? 'http_error');
        detail = `${errorCode}: ${data.message}`;
      }
    } catch {
      // 非 JSON 错误体就用 HTTP 状态。
    }
    // 边车自己的超时（如 jm_search_timeout → 504）要翻译成 timeout：
    // 超时口径对齐后 Node 会等得比边车久，这类 504 会真的走到这里；
    // 不翻译就会被误报成"JM 服务没启动"（2026-11-20）。
    return fail(/timeout/i.test(errorCode) ? 'timeout' : 'http_error', detail);
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    return fail('service_down', `读响应失败:${err?.message ?? err}`);
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return fail('bad_json', '边车响应不是 JSON');
  }
}

/**
 * 拉 PDF 到本地文件（`GET /pdf/<id>[?unit=]`）。先写 `.part` 再 rename；
 * 边车按需生成/缓存 PDF，所以这里用**整体预算**而不是 15s 的单请求上限。
 *
 * @returns {Promise<{ok:true, path:string, bytes:number} | {ok:false, reason:string, detail:string}>}
 */
async function fetchPdfToFile({ url, dir, fileKey, maxBytes, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
  } catch (err) {
    const name = String(err?.name ?? '');
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', `PDF 请求超时:${url}`);
    return fail('service_down', `PDF 请求失败:${err?.message ?? err}`);
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status} ${url}`;
    try {
      const text = await response.text();
      const data = JSON.parse(text);
      if (data?.message) detail = `${data.error ?? 'http_error'}: ${data.message}`;
    } catch { /* 非 JSON 错误体就用 HTTP 状态 */ }
    return fail('http_error', detail);
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) return fail('too_large', `PDF 超过上限 ${maxBytes} 字节`);
      chunks.push(chunk);
    }
  } catch (err) {
    return fail('service_down', `读 PDF 流失败:${err?.message ?? err}`);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return fail('bad_pdf', '边车返回的不是 PDF（可能被拦截或返回了错误页）');
  }
  const target = path.join(dir, `JM${fileKey}.pdf`);
  const part = `${target}.part`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(part, buffer);
    fs.renameSync(part, target);
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch { /* 清理失败不改变结果 */ }
    return fail('io_error', `写 PDF 失败:${err?.message ?? err}`);
  }
  log(`PDF 已落盘:${target}(${Math.round(buffer.length / 1024)}KB)`);
  return { ok: true, path: target, bytes: buffer.length };
}

/** 把边车返回的单元对象归一成 Node 形状（兼容 snake_case / camelCase）。 */
function normalizeUnit(raw, fallbackIndex = 0) {
  const pageCount = Number(raw?.page_count ?? raw?.pageCount ?? 0);
  return {
    index: Number(raw?.index) || fallbackIndex,
    unitId: String(raw?.unit_id ?? raw?.unitId ?? ''),
    title: String(raw?.title ?? ''),
    pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null,
  };
}

/**
 * 把边车 `album` 对象归一成 Node 形状（含 units）。
 *
 * 2026-11-17：把 `authors` / `tags` 一并透传，供本地收藏保存来源元数据。
 * ⚠️ 缺字段 = **未知**（null），不是空数组：边车详情没拿到时不能把作者写成"无"。
 * 边车契约 v3 的 `/resolve` 回包带这两项；旧边车缺字段时下游按"元数据未知"处理。
 */
function normalizeAlbum(raw) {
  const units = Array.isArray(raw?.units) ? raw.units.map((unit, index) => normalizeUnit(unit, index + 1)) : [];
  const unitCountRaw = Number(raw?.unit_count ?? raw?.unitCount ?? 0);
  const authors = Array.isArray(raw?.authors)
    ? raw.authors.map((name) => String(name ?? '').trim()).filter(Boolean)
    : null;
  const tags = Array.isArray(raw?.tags)
    ? raw.tags.map((name) => String(name ?? '').trim()).filter(Boolean)
    : null;
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    authors,
    tags,
    pageCount: Number(raw?.page_count ?? raw?.pageCount ?? 0) || 0,
    unitCount: Number.isFinite(unitCountRaw) && unitCountRaw > 0 ? unitCountRaw : units.length,
    units,
  };
}

/**
 * 执行一次边车操作。**不抛**：所有失败都收口成 `{ok:false, reason, detail}`。
 *
 * @param {ReturnType<typeof parseJmArgs>} options
 * @param {{fetchImpl?: Function, log?: Function, sleep?: Function, now?: Function}} [deps]
 *   `fetchImpl`/`sleep`/`now` 可注入 —— selftest 用假网络与假时钟，不联网、不等待。
 * @returns {Promise<object>} 见文件头"成功/失败 JSON"。
 */
export async function runJmFetch(options, deps = {}) {
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const emit = typeof deps.log === 'function' ? deps.log : log;
  const wait = typeof deps.sleep === 'function' ? deps.sleep : sleep;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const apiBase = String(options?.api ?? DEFAULT_API).trim().replace(/\/+$/u, '') || DEFAULT_API;
  const timeoutMs = Number.isSafeInteger(options?.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const requestTimeoutMs = Number.isSafeInteger(options?.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? Math.min(options.requestTimeoutMs, timeoutMs) : Math.min(DEFAULT_REQUEST_TIMEOUT_MS, timeoutMs);
  const pdfMaxBytes = Number.isSafeInteger(options?.pdfMaxBytes) && options.pdfMaxBytes > 0
    ? options.pdfMaxBytes : DEFAULT_PDF_MAX_BYTES;
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(1, Math.min(requestTimeoutMs, deadline - now()));

  const op = String(options?.op ?? '').trim().toLowerCase();
  emit(`op=${op || '(空)'} api=${apiBase} timeout=${timeoutMs}`);

  const unitsGiven = options?.units !== null && options?.units !== undefined;
  const unitGiven = options?.unitGiven === true || Boolean(String(options?.unit ?? '').trim());
  let units = null;
  if (unitsGiven) {
    if (op !== 'pdf') return { ...fail('bad_args', '--units 只用于 pdf'), op };
    if (unitGiven) return { ...fail('bad_args', '--unit 与 --units 互斥'), op };
    const raw = String(options.units);
    const ids = raw.split(',');
    if (!ids.length || ids.some((id) => !/^[1-9]\d{0,11}$/u.test(id))) {
      return { ...fail('bad_args', '--units 至少需要一个合法单元编号，用逗号分隔'), op };
    }
    units = [...new Set(ids)];
  }

  if (op === 'health') {
    const result = await fetchJson({ url: apiUrl(apiBase, '/health'), timeoutMs: remaining(), fetchImpl });
    if (!result.ok) return { ...result, op };
    const data = result.data;
    if (data?.ok !== true) return { ...fail('api_error', data?.message ?? '边车 /health 未就绪'), op };
    emit(`边车健康:${data.service ?? 'jm-service'} ${data.version ?? ''}`);
    return {
      ok: true,
      op,
      service: String(data.service ?? 'jm-service'),
      version: String(data.version ?? ''),
      viewerBase: String(data.viewer_base ?? ''),
      downloadedAlbums: Number(data.downloaded_albums ?? 0),
      capabilities: Array.isArray(data.capabilities)
        ? data.capabilities.filter((item) => typeof item === 'string')
        : [],
    };
  }

  if (op === 'search') {
    const query = String(options?.q ?? '').trim();
    if (!query) return { ...fail('bad_args', 'search 缺少 --q'), op };
    if (Array.from(query).length > MAX_KEYWORD_CHARS) return { ...fail('bad_args', `关键词超过 ${MAX_KEYWORD_CHARS} 字`), op };
    const mode = String(options?.mode ?? 'site').trim().toLowerCase();
    if (!SEARCH_MODES.has(mode)) {
      return { ...fail('bad_args', `search 的 --mode 只能是 site/work/author/tag/actor，收到 ${JSON.stringify(mode)}`), op };
    }
    const page = Number(options?.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_SEARCH_PAGE) {
      return { ...fail('bad_args', `search 的 --page 需在 1..${MAX_SEARCH_PAGE}`), op };
    }
    const order = String(options?.order ?? '').trim().toLowerCase();
    if (order && !SEARCH_ORDERS.has(order)) {
      return { ...fail('bad_args', `search 的 --order 只能是 mr/mv，收到 ${JSON.stringify(order)}`), op };
    }
    const limit = Number.isSafeInteger(options?.limit) && options.limit > 0
      ? Math.min(options.limit, options?.details || mode !== 'site' ? MAX_LIMIT_DETAILS : MAX_LIMIT)
      : DEFAULT_LIMIT;
    const images = options?.images !== false;
    const details = options?.details === true;
    const window = options?.window === true;
    const params = new URLSearchParams({ q: query, limit: String(limit), page: String(page) });
    if (mode !== 'site') params.set('mode', mode);
    if (order) params.set('order', order);
    if (window) params.set('window', '1');
    if (!images) params.set('images', '0');
    if (details) params.set('details', '1');
    const url = apiUrl(apiBase, `/search?${params.toString()}`);
    const result = await fetchJson({ url, timeoutMs: remaining(), fetchImpl });
    if (!result.ok) return { ...result, op };
    const data = result.data;
    if (data?.ok !== true) return { ...fail(String(data?.error ?? 'api_error'), data?.message ?? '搜索失败'), op };
    if (!Array.isArray(data.results)) return { ...fail('bad_json', '/search 响应缺少 results 数组'), op };

    const results = data.results.slice(0, limit).map((item, index) => ({
      rank: Number(item?.rank) || index + 1,
      id: String(item?.id ?? ''),
      title: String(item?.title ?? ''),
      authors: Array.isArray(item?.authors) ? item.authors.map(String) : [],
      tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
      pageCount: Number(item?.page_count ?? 0),
      detailOk: item?.detail_ok !== false,
    })).filter((item) => item.id !== '');

    emit(`搜索结果:${results.length} 本（mode=${mode} page=${page} order=${order || 'mr'} window=${window ? 'on' : 'off'} images=${images ? 'on' : 'off'} details=${details ? 'on' : 'off'}）`);
    return {
      ok: true,
      op,
      query,
      mode,
      page,
      order: String(data.order ?? order ?? '') || 'mr',
      window: data.window === true || window,
      details,
      total: Number(data.total ?? 0),
      cached: data.cached === true,
      elapsedMs: Number(data.elapsed_ms ?? 0),
      results,
      text: String(data.text ?? '').trim(),
    };
  }

  if (op === 'resolve') {
    const id = String(options?.id ?? '').trim();
    if (!/^\d{1,12}$/u.test(id)) return { ...fail('bad_args', 'resolve 缺少合法的 --id'), op };
    const result = await fetchJson({
      url: apiUrl(apiBase, `/resolve/${encodeURIComponent(id)}`),
      timeoutMs: remaining(),
      fetchImpl,
    });
    if (!result.ok) {
      // 边车 404 的 body 是 {"error":"not_found"}；HTTP 层先把它翻成稳定 reason，
      // 服务层才能回「没有这个编号」而不是笼统的「服务没启动」。
      if (result.reason === 'http_error' && /(^|[^a-z_])not_found([^a-z_]|$)/u.test(String(result.detail ?? ''))) {
        return { ...fail('not_found', result.detail), op };
      }
      return { ...result, op };
    }
    const data = result.data;
    if (data?.ok !== true) {
      return { ...fail(String(data?.error ?? 'api_error'), data?.message ?? '编号解析失败'), op };
    }
    if (!data.album || typeof data.album !== 'object') {
      return { ...fail('bad_json', '/resolve 响应缺少 album'), op };
    }
    const album = normalizeAlbum(data.album);
    if (!album.id) return { ...fail('bad_json', '/resolve 的 album 缺少 id'), op };
    const matchedRaw = data.matched_unit ?? data.matchedUnit ?? null;
    const matchedUnit = matchedRaw && typeof matchedRaw === 'object' ? normalizeUnit(matchedRaw, 0) : null;
    emit(`编号解析:${id} → ${data.kind === 'photo' ? '单元' : '作品'} ${album.id}（${album.units.length} 单元）`);
    return {
      ok: true,
      op,
      requested: id,
      kind: data.kind === 'photo' ? 'photo' : 'album',
      album,
      matchedUnit,
    };
  }

  if (op === 'pdf') {
    const id = String(options?.id ?? '').trim();
    if (!/^\d{1,12}$/u.test(id)) return { ...fail('bad_args', 'pdf 缺少合法的 --id'), op };
    const unit = String(options?.unit ?? '').trim();
    if (unit && !/^\d{1,12}$/u.test(unit)) return { ...fail('bad_args', 'pdf 的 --unit 不合法'), op };
    const outDir = String(options?.outDir ?? '').trim();
    if (!outDir) return { ...fail('bad_args', 'pdf 缺少 --out-dir'), op };
    const dir = path.resolve(outDir);
    // PDF 可能当场生成（几秒到几十秒），不吃 15s 的单请求上限，只受整体预算约束。
    const pdfTimeout = Math.max(1, Math.min(timeoutMs, deadline - now()));
    const saved = await fetchPdfToFile({
      url: apiUrl(apiBase, `/pdf/${encodeURIComponent(id)}${units ? `?units=${units.join(',')}` : unit ? `?unit=${encodeURIComponent(unit)}` : ''}`),
      dir,
      fileKey: units
        ? `${id}-pack-${createHash('sha256').update(units.join(',')).digest('hex').slice(0, 16)}`
        : unit || id,
      maxBytes: pdfMaxBytes,
      timeoutMs: pdfTimeout,
      fetchImpl,
    });
    if (!saved.ok) return { ...saved, op };
    emit(`PDF 就绪:${saved.path}(${Math.round(saved.bytes / 1024)}KB)`);
    return { ok: true, op, id, unit: unit || null, ...(units ? { units } : {}), path: saved.path, bytes: saved.bytes };
  }

  if (op === 'download') {
    const id = String(options?.id ?? '').trim();
    if (!/^\d{1,12}$/u.test(id)) return { ...fail('bad_args', 'download 缺少合法的 --id'), op };
    const unit = String(options?.unit ?? '').trim();
    if (unit && !/^\d{1,12}$/u.test(unit)) return { ...fail('bad_args', 'download 的 --unit 不合法'), op };

    /** 下载完成后拿网页阅读链接：优先任务/开始回包里的 viewer_url，缺了再查 /album/<id>。 */
    const viewerOf = async (candidate) => {
      const direct = String(candidate?.viewer_url ?? '').trim();
      if (direct) return direct;
      const album = await fetchJson({ url: apiUrl(apiBase, `/album/${encodeURIComponent(id)}`), timeoutMs: remaining(), fetchImpl });
      return album.ok && album.data?.ok === true ? String(album.data.viewer_url ?? '').trim() : '';
    };
    const doneOf = async (candidate) => {
      const viewerUrl = await viewerOf(candidate);
      const resolvedUnit = String(candidate?.unit ?? candidate?.unit_id ?? unit ?? '').trim();
      return {
        ok: true,
        op,
        id,
        unit: resolvedUnit || null,
        status: 'done',
        title: String(candidate?.album?.title ?? candidate?.title ?? ''),
        viewerUrl,
        dir: String(candidate?.dir ?? ''),
      };
    };

    const payloadBody = unit ? { id, unit } : { id };
    const start = await fetchJson({
      url: apiUrl(apiBase, '/download'),
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payloadBody) },
      timeoutMs: remaining(),
      fetchImpl,
    });
    if (!start.ok) return { ...start, op };
    const started = start.data;
    if (started?.ok !== true) return { ...fail(String(started?.error ?? 'api_error'), started?.message ?? '下载请求失败'), op };
    if (started.status === 'done') {
      emit(`已下载,直接取阅读链接:${id}${unit ? `（单元 ${unit}）` : ''}`);
      return doneOf(started);
    }
    const jobId = String(started.job_id ?? '').trim();
    if (!jobId) return { ...fail('bad_json', '/download 既不是 done 也没给 job_id'), op };
    emit(`下载任务已排队:${jobId}${unit ? `（单元 ${unit}）` : ''}`);

    while (now() < deadline) {
      await wait(POLL_MS);
      const job = await fetchJson({ url: apiUrl(apiBase, `/jobs/${encodeURIComponent(jobId)}`), timeoutMs: remaining(), fetchImpl });
      if (!job.ok) return { ...job, op };
      if (job.data?.ok !== true) {
        return { ...fail(String(job.data?.error ?? 'api_error'), job.data?.message ?? '/jobs 未就绪'), op };
      }
      const status = String(job.data?.status ?? '');
      if (status === 'done') {
        emit(`下载完成:${id}${unit ? `（单元 ${unit}）` : ''}`);
        return doneOf({ ...job.data, album: job.data?.album ?? { title: job.data?.title ?? '' } });
      }
      if (status === 'failed') {
        const detail = String(job.data?.error ?? job.data?.message ?? '下载任务失败');
        emit(`下载失败:${detail}`);
        return { ...fail('download_failed', detail), op };
      }
      emit(`下载中:${status || 'unknown'} ${job.data?.phase ?? ''}`.trim());
    }
    return { ...fail('timeout', '等待下载完成超时'), op };
  }

  return { ...fail('bad_args', `--op 只能是 search / resolve / download / pdf / health,收到 ${JSON.stringify(options?.op ?? '')}`), op };
}

/** CLI 入口：先跑操作，再只写一行 JSON 到 stdout（失败也由 JSON 表达，退出码恒 0）。 */
async function main() {
  const options = parseJmArgs(process.argv.slice(2));
  let result;
  try {
    result = await runJmFetch(options);
  } catch (err) {
    result = { ...fail('internal', `抓取器异常:${err?.message ?? err}`), op: options.op };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  await main();
}
