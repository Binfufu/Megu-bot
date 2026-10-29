/**
 * **刀一 · LLM 直连客户端**(2026-10-13,`docs\21` §三)。
 *
 * ## 为什么要有这个文件
 *
 * 梦境档(docs\21 §十)走 B 路:桥自己拼 messages、直接调 OpenAI 兼容 API,
 * 不再借 DSH 会话。这个文件就是那条路的**唯一**模型客户端 —— 并发队列、
 * 重试、超时、错误分类、usage 带出全在这里做一次(D159:必须一致的东西只有一份)。
 *
 * ## 形状(docs\21 刀一原文)
 *
 *   `chat(messages, {model, apiKey, baseUrl, timeoutMs, tools}) → {text, usage, raw}`
 *
 *  · **key/baseUrl/model 全是参数** —— 世界档与梦境档各配各的(§十三项拍板之 2),
 *    将来 BYOK 只是"这一轮用谁的关键"从配置变成按账号查表,客户端零改动。
 *  · **usage 从响应原样带出**(prompt/completion/缓存命中)—— 比 DSH 估的准,
 *    credits 记账与"先免费记账"的定价反推都吃这个值。
 *  · **tools 门(g4)**:透传 `tools` 参数、原样带回 `tool_calls` 响应,
 *    **不实现**工具循环/框架 —— 门留着,机器不造。
 *
 * ## 错误分类(重试判据的根)
 *
 *  · **401/403 = 坏 key:绝不重试**(docs\21 §十一护栏①:不许拿我们的队列打无限重试);
 *  · 400/404/422 = 请求本身坏:重试也不会好,不重试;
 *  · 429 / 5xx / 网络 / 超时 = 瞬时故障:按退避重试(复用 `retry.js` 的同族口径)。
 */

/** 重试与间隔的默认值:显式给在这里,不许调用方偷偷改大烧配额。 */
export const LLM_RETRY_ATTEMPTS = 3;
export const LLM_RETRY_DELAY_MS = 1500;
/** 单请求超时默认值(梦境一轮 N+1 次调用都排队,单次太长会把队列占死)。 */
export const LLM_TIMEOUT_MS = 120_000;
/** 客户端级并发上限:同一把上游 key 的 RPM/TPM 有限,排队的不是"通道"是"请求"(docs\20 附录§4)。 */
export const LLM_MAX_CONCURRENT = 3;

/**
 * 把 HTTP 状态/异常分类成「该不该重试」。
 * @param {{status?: number, name?: string}} [shape]
 * @returns {{kind: 'auth'|'request'|'rate_limit'|'server'|'network'|'none', retryable: boolean, note: string}}
 */
export function classifyLlmError(shape = {}) {
  const status = Number.isInteger(shape.status) ? shape.status : 0;
  if (status === 401 || status === 403) {
    return { kind: 'auth', retryable: false, note: 'key 被拒(换 key,不是重试)' };
  }
  if (status === 429) {
    return { kind: 'rate_limit', retryable: true, note: '上游限速,退避重试' };
  }
  if (status >= 500) {
    return { kind: 'server', retryable: true, note: '上游 5xx,退避重试' };
  }
  if (status >= 400) {
    return { kind: 'request', retryable: false, note: '请求本身不被接受,重试也不会好' };
  }
  // 没有 status:网络层(fetch failed / 超时 / 断流)。
  return { kind: 'network', retryable: true, note: '网络层故障,退避重试' };
}

/**
 * 并发队列:最多 `max` 个在飞,其余按先来后到等。
 * @returns {{run: <T>(fn: () => Promise<T>) => Promise<T>, pending: () => number, active: () => number}}
 */
export function createLlmQueue({ max = LLM_MAX_CONCURRENT } = {}) {
  const limit = Math.max(1, Number(max) || 1);
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < limit && waiting.length > 0) {
      const next = waiting.shift();
      active += 1;
      next();
    }
  };
  return {
    run(fn, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const cancel = () => {
          const index = waiting.indexOf(start);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason);
        };
        const start = () => {
          signal?.removeEventListener('abort', cancel);
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              pump();
            });
        };
        signal?.addEventListener('abort', cancel, { once: true });
        waiting.push(start);
        pump();
      });
    },
    pending: () => waiting.length,
    active: () => active,
  };
}

/** One image boundary for QQ SDK blocks, URLs and OpenAI blocks. Persist normalized URLs. */

/** **接地指令**(1.150.81):图块后跟的工程话术 —— "追问颜色答白"现场的对症药:
 *  图附了但被记忆上下文带偏,把"以图为准"钉在图旁边。模块级一份(D159:测试引用同一份)。 */
export const IMAGE_GROUNDING_NOTE = '（上面这些是本轮对话真实附带的图片。用户问到图片的内容、颜色、文字、数量时，必须以这些图片为准作答；它们与你记忆或历史里的任何旧图无关，也不许用记忆里的旧图回答。）';

export function normalizeLlmImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw new Error('llm images must be an array');
  return images.map(img => {
    if (img?.type === 'image') {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(img.mimeType) ||
          typeof img.data !== 'string' || !img.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) {
        throw new Error('llm images: invalid encoded SDK image');
      }
      return `data:${img.mimeType};base64,${img.data}`;
    }
    const url = typeof img === 'string' ? img : img?.url ?? img?.image_url?.url;
    if (typeof url !== 'string' || !url) throw new Error('llm.chat: images 需是 URL/dataURL 字符串或 {url} 形状');
    return url;
  });
}

/** 从 OpenAI 兼容响应里取正文与 tool_calls(只取,不执行 —— g4 门)。 */
export function extractLlmChoice(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice && choice.message ? choice.message : {};
  const text = typeof message.content === 'string' ? stripReasoningTags(message.content) : '';
  return {
    text,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : null,
    finishReason: choice ? choice.finish_reason ?? null : null,
  };
}

const THINK_BLOCK_RE = /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi;
const THINK_OPEN_RE = /<think(?:ing)?\b[^>]*>/i;
const THINK_PARTIAL_RE = /<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?$/i;

/** 流式边界:把末尾可能是半个 `<think>` / `</think>` 的部分先扣住,别当正文发。 */
function holdPartialThinkTag(text) {
  const m = String(text ?? '').match(THINK_PARTIAL_RE);
  return m ? String(text).slice(0, m.index) : String(text ?? '');
}

/**
 * **剥掉推理块**(2026-10-19 / D259):龙API 等中转会把 Grok 的思考塞进
 * Chat `delta.content` 里(`<think>…</think>`),客户端不剥就会把思考当正文显示。
 * 只认 `<think>` / `<thinking>` 标签;正常正文里的尖括号不受影响。
 */
export function stripReasoningTags(text) {
  const raw = String(text ?? '');
  let out = raw.replace(THINK_BLOCK_RE, '');
  const open = out.search(THINK_OPEN_RE);
  if (open >= 0) out = out.slice(0, open);
  return out;
}

/** 流式增量过滤器:按"目前已剥出的全文"取新增可见字,标签跨 chunk 也不漏。 */
export function createReasoningTagFilter() {
  let raw = '';
  let visible = '';
  return {
    push(delta) {
      raw += String(delta ?? '');
      const next = holdPartialThinkTag(stripReasoningTags(raw));
      const added = next.length >= visible.length ? next.slice(visible.length) : '';
      visible = next;
      return added;
    },
    get text() { return visible; },
  };
}

/** usage 归一:各家的缓存命中字段名不一,认得出来的归到一处,认不出的原样保留。 */
export function normalizeLlmUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cacheHitTokens: usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? null,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? null,
    raw: usage,
  };
}

/**
 * **火山方舟 Agent Plan**(2026-10-18 / D257)走的是 OpenAI Responses,不是 Chat Completions:
 *   baseUrl = https://ark.cn-beijing.volces.com/api/plan/v3
 *   endpoint = .../responses
 * 这里只做"请求/响应形状适配",不复制重试/并发/key 逻辑(那些仍只有 createLlmClient 一份)。
 * 判据:假 fetch 钉住 URL、input 形状、max_output_tokens、output_text 解析、SSE 增量。
 */
export function isResponsesApi(baseUrl, hint = '') {
  if (hint === 'responses') return true;
  const text = String(baseUrl ?? '').replace(/\/+$/, '');
  return /\/api\/plan\/v3$/i.test(text) || /\/responses$/i.test(text);
}

/** Chat 消息 → Responses `input`。纯文本尽量发字符串(兼容面最广),多模态才用块数组。 */
export function toResponsesInput(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    // Responses 用 developer 代替 chat 的 system(Agent Plan 的兼容层声明支持 developer)。
    const rawRole = typeof message?.role === 'string' ? message.role : 'user';
    const role = rawRole === 'system' ? 'developer' : rawRole;
    const content = message?.content;
    if (Array.isArray(content)) {
      return {
        role,
        content: content.map((part) => {
          if (part?.type === 'text') return { type: 'input_text', text: String(part.text ?? '') };
          if (part?.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            return { type: 'input_image', image_url: String(url ?? '') };
          }
          return part;
        }),
      };
    }
    return { role, content: String(content ?? '') };
  });
}

/** Responses 非流式响应 → 统一 choice 形状(正文从 output 里的 output_text 拼)。 */
export function extractResponsesChoice(payload) {
  if (payload && typeof payload.output_text === 'string') {
    return { text: payload.output_text, toolCalls: null, finishReason: payload.status ?? null };
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  let text = '';
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'output_text' && typeof item.text === 'string') text += item.text;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
        if (part?.type === 'text' && typeof part.text === 'string') text += part.text;
      }
    }
  }
  const finishReason = payload?.status === 'incomplete'
    ? (payload?.incomplete_details?.reason ?? 'incomplete')
    : (payload?.status ?? null);
  return { text, toolCalls: null, finishReason };
}

/** Responses usage(input_tokens/output_tokens)→ 与 chat 同一套归一字段。 */
export function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = usage.input_tokens ?? usage.prompt_tokens ?? null;
  const completion = usage.output_tokens ?? usage.completion_tokens ?? null;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: usage.total_tokens ?? (Number.isFinite(prompt) && Number.isFinite(completion) ? prompt + completion : null),
    cacheHitTokens: usage.input_tokens_details?.cached_tokens ?? null,
    cacheMissTokens: null,
    raw: usage,
  };
}

/**
 * 造一个客户端。`fetchImpl`/`sleep` 只给测试注入用,生产不传。
 * @param {{baseUrl: string, apiKey: string, model?: string, api?: 'chat'|'responses',
 *          timeoutMs?: number, maxConcurrent?: number, attempts?: number, retryDelayMs?: number,
 *          fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>,
 *          log?: Console}} options
 */
export function validateLlmRequestOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('llm request options must be an object');
  const { reasoningEffort, maxTokens, maxAttempts } = options;
  if (maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0)) throw new Error('maxAttempts must be a positive safe integer');
  if (reasoningEffort !== undefined && !['off', 'low', 'high', 'max'].includes(reasoningEffort)) throw new Error('unsupported reasoningEffort');
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error('maxTokens must be a positive safe integer');
}

export function createLlmClient(options) {
  const {
    baseUrl,
    apiKey,
    model = '',
    api = '',
    reasoning = 'auto',
    timeoutMs = LLM_TIMEOUT_MS,
    maxConcurrent = LLM_MAX_CONCURRENT,
    attempts = LLM_RETRY_ATTEMPTS,
    retryDelayMs = LLM_RETRY_DELAY_MS,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    log = console,
  } = options || {};
  if (!baseUrl || !apiKey) throw new Error('createLlmClient: baseUrl 与 apiKey 必填');
  if (typeof fetchImpl !== 'function') throw new Error('createLlmClient: 没有 fetch 可用');
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const responsesApi = isResponsesApi(normalizedBase, api);
  const endpoint = responsesApi
    ? (/\/responses$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/responses`)
    : `${normalizedBase}/chat/completions`;
  const queue = createLlmQueue({ max: maxConcurrent });

  /**
   * 打一轮。messages 原样发(组装是调用方/组装器的事,这里不管注入位置)。
   * @param {Array<{role: string, content: string, name?: string}>} messages
   * @param {{model?: string, tools?: Array<object>, temperature?: number, maxTokens?: number,
   *          signal?: AbortSignal, maxAttempts?: number}} [callOptions]
   * @returns {Promise<{text: string, toolCalls: Array<object>|null, usage: object|null,
   *                     finishReason: string|null, model: string, raw: object}>}
   */
  /** 请求前统一剥掉空 tools(g4:透传但不发垃圾字段)。 */
  function buildBody(messages, callOptions) {
    if (responsesApi) {
      if (Array.isArray(callOptions.tools) && callOptions.tools.length > 0) {
        const error = new Error('responses API 暂不支持 tools(Agent Plan 目前只接文本/流式)');
        error.status = 400;
        throw error;
      }
      const body = {
        model: callOptions.model || model,
        input: toResponsesInput(messages),
        stream: false,
      };
      if (typeof callOptions.temperature === 'number') body.temperature = callOptions.temperature;
      if (callOptions.maxTokens !== undefined) body.max_output_tokens = callOptions.maxTokens;
      const effectiveModel = String(body.model);
      const requested = String(callOptions.reasoningEffort ?? reasoning ?? 'auto').toLowerCase();
      if (requested === 'off') {
        body.thinking = { type: 'disabled' };
      } else if (requested === 'auto') {
        if (/doubao-seed-2\.1-turbo/i.test(effectiveModel)) body.thinking = { type: 'disabled' };
      } else {
        body.thinking = { type: 'enabled' };
        // Seed 2.1 Turbo 只有 thinking 开关;其他 Responses 模型才带 effort。
        if (!/doubao-seed-2\.1-turbo/i.test(effectiveModel)) body.reasoning = { effort: requested };
      }
      return body;
    }
    const body = {
      model: callOptions.model || model,
      messages,
      stream: false,
    };
    if (Array.isArray(callOptions.tools) && callOptions.tools.length > 0) {
      body.tools = callOptions.tools;
    }
    if (typeof callOptions.temperature === 'number') body.temperature = callOptions.temperature;
    if (callOptions.maxTokens !== undefined) body.max_tokens = callOptions.maxTokens;
    const effectiveModel = String(body.model);
    const isGrok = /grok/i.test(effectiveModel);
    const isOfficialXai = /api\.x\.ai/i.test(normalizedBase);
    const isGlm53 = /glm-5\.3/i.test(effectiveModel);
    const requested = String(callOptions.reasoningEffort ?? reasoning ?? 'auto').toLowerCase();
    if (requested === 'auto') {
      if (isGrok) body.reasoning_effort = isOfficialXai ? 'low' : 'off';
    } else if (requested === 'off') {
      // Grok 官方 / GLM-5.3 不支持 off:按它们允许的最低档降级,而不是发一个会 400 的值。
      if ((isGrok && isOfficialXai) || isGlm53) body.reasoning_effort = 'low';
      else if (isGrok) body.reasoning_effort = 'off';   // 龙API 实测接受
      else body.thinking = { type: 'disabled' };        // GLM-5.2 / 通用模型
    } else {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = isGlm53 && requested === 'medium' ? 'high' : requested;
    }
    return body;
  }

  /** 打一发(不重试):把 HTTP 层的错归一成带 status 的 Error,给 classifyLlmError 用。 */
  async function callOnce(messages, callOptions) {
    const controller = new AbortController();
    callOptions.signal?.throwIfAborted();
    const requestTimeoutMs = callOptions.timeoutMs ?? timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error('超时')), Math.max(1, requestTimeoutMs));
    // 调用方自己的 signal 也要能取消(面板断开之类的场景)。
    const onOuterAbort = () => controller.abort(callOptions.signal.reason);
    if (callOptions.signal) {
      if (callOptions.signal.aborted) onOuterAbort();
      else callOptions.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let attemptId;
    let attemptStatus = 'failed';
    let attemptUsage = null;
    let httpStatus = null;
    const startedAt = Date.now();
    let ttftMs = null;
    try {
      attemptId = callOptions.onAttemptStart?.();
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildBody(messages, callOptions)),
        signal: controller.signal,
      });
      // **首字留痕**(2026-10-17 / D240):响应头到达的时刻。⚠️ `stream:false` 下这**约等于**
      //    总耗时(服务器生成完才回头),真正的"首字"要等③的流式 —— 先把这个数钉进日志,
      //    "备忘里 TTFT 300~800ms"那种说法以后必须对着这里的实测说话。
      ttftMs = Date.now() - startedAt;
      httpStatus = response.status ?? null;
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`LLM HTTP ${response.status}: ${detail.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const choice = responsesApi ? extractResponsesChoice(payload) : extractLlmChoice(payload);
      const usage = responsesApi ? normalizeResponsesUsage(payload.usage) : normalizeLlmUsage(payload.usage);
      attemptStatus = 'completed';
      attemptUsage = usage;
      const totalMs = Date.now() - startedAt;
      // 每发一行耗时账(ttft≈总计 = "憋成一坨"的直接证据;流式上线后两者才会拉开)。
      log.info?.(`[llm] ${payload.model || callOptions.model || model} ttft=${ttftMs}ms total=${totalMs}ms`
        + ` chars=${choice.text.length} completion=${attemptUsage?.completionTokens ?? '?'}tok`);
      return {
        text: choice.text,
        toolCalls: choice.toolCalls,
        finishReason: choice.finishReason,
        usage,
        model: payload.model || (callOptions.model || model),
        raw: payload,
      };
    } catch (error) {
      // fetch 的超时/取消会把 abort 原因吞成 AbortError —— 归一回网络类(可重试)。
      if (error && error.name === 'AbortError') {
        const wrapped = new Error(`LLM 请求超时或被取消(${timeoutMs}ms)`);
        wrapped.name = 'FetchError';
        throw wrapped;
      }
      // 失败的一发也记账(带 ttft —— 看得出"死在等待还是死在生成")。
      log.info?.(`[llm] ${callOptions.model || model} FAILED status=${httpStatus ?? '?'} ttft=${ttftMs ?? '?'}ms total=${Date.now() - startedAt}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
      if (callOptions.signal) callOptions.signal.removeEventListener('abort', onOuterAbort);
      if (attemptId !== undefined) callOptions.onAttemptEnd?.(attemptId, {
        status: controller.signal.aborted ? 'cancelled' : attemptStatus,
        usage: attemptUsage, httpStatus,
      });
    }
  }

  /**
   * 带 images 的一轮:把图片挂到**最后一条 user 消息**上(OpenAI 兼容多模态形状)。
   * 图片项:URL/dataURL 字符串,或 `{url}`;QQ 的图在桥里早转成 dataURL(刀三A 接线时)。
   *
   * ⚠️ 2026-10-16(1.150.81):图后面**跟一块接地指令**。现场:主人发红图后追问"什么颜色",
   * 模型答"白的"——裁决实验证明图**附了**仍被 ~3k 字记忆上下文带偏(交接里写着旧图旧事)。
   * 模型自己(无图时)会老实说"看不到图" ⇒ 它分得清"有没有图",分不清"该信哪张"。
   * 这块指令是**请求装配层**的工程话术(不是角色措辞,不进记忆、不进转写),把"以图为准"
   * 钉在图旁边。判据在 selftest 的 images 门那组。
   *
   * @param {Array<object>} messages
   * @param {Array<string|{url: string}>|undefined} images
   */
  const IMAGE_GROUNDING_NOTE = '（上面这些是本轮对话真实附带的图片。用户问到图片的内容、颜色、文字、数量时，必须以这些图片为准作答；它们与你记忆或历史里的任何旧图无关，也不许用记忆里的旧图回答。）';
  function withImages(messages, images) {
    const normalized = normalizeLlmImages(images);
    if (normalized.length === 0) return messages;
    const out = messages.map((m) => ({ ...m }));
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].role === 'user') {
        out[i].content = [
          ...(Array.isArray(out[i].content) ? out[i].content : [{ type: 'text', text: String(out[i].content ?? '') }]),
          ...normalized.map(url => ({ type: 'image_url', image_url: { url } })),
          { type: 'text', text: IMAGE_GROUNDING_NOTE },
        ];
        return out;
      }
    }
    throw new Error('llm.chat: 带 images 但 messages 里没有 user 消息可挂');
  }

  async function chat(messages, callOptions = {}) {
    return withRetry(messages, callOptions, (finalMessages) =>
      queue.run(() => callOnce(finalMessages, callOptions), { signal: callOptions.signal }));
  }

  /**
   * **重试骨架**(chat 与 chatStream 共用,2026-10-17 抽出 —— D159:退避/分类只有一份):
   * 取消检查、images 挂载、按类重试、指数退避全在这里;`run` 拿到挂好图的 messages。
   * `canRetry` 给流式用:只要有一个字已经出了门,就不许再拿重试糊弄(客户端看到了半截)。
   */
  async function withRetry(messages, callOptions, run, canRetry = null) {
    validateLlmRequestOptions(callOptions);
    // Per-call caps may only reduce the configured attempt budget (chat and stream share this gate).
    const attemptLimit = Math.min(Math.max(1, attempts), callOptions.maxAttempts ?? Infinity);
    let lastError = null;
    const checkCancelled = () => callOptions.signal?.throwIfAborted();
    async function backoff(ms) {
      checkCancelled();
      if (!callOptions.signal) return sleep(ms);
      const signal = callOptions.signal;
      let abort;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try { await Promise.race([sleep(ms), cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
    }
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      try {
        // 排队的是"请求"不是"通道":N+1 次调用共用一个并发上限,防打爆 RPM。
        // images 只在进队前挂一次(重试也用同一份多模态 body,不重复挂)。
        checkCancelled();
        const finalMessages = withImages(messages, callOptions.images);
        return await run(finalMessages, attempt);
      } catch (error) {
        checkCancelled(); // caller cancellation is terminal, never a retryable network failure
        lastError = error;
        const verdict = classifyLlmError({ status: error && error.status, name: error && error.name });
        if (!verdict.retryable || attempt >= attemptLimit || (canRetry && !canRetry(error))) {
          error.llmClass = verdict.kind;
          throw error;
        }
        log.warn?.(`[llm] 第 ${attempt} 次失败(${verdict.kind}:${verdict.note}),退避后重试`);
        await backoff(retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  /**
   * **流式一发(不重试)**:OpenAI 兼容 SSE(`stream:true` + `stream_options.include_usage`)。
   * 每个增量回调 `onDelta(delta, textSoFar)`;usage 从带 usage 的最后一个 chunk 归一。
   * @returns {Promise<{text: string, toolCalls: null, finishReason: string|null,
   *                     usage: object|null, model: string, raw: {streamed: true}}>}
   */
  async function callStreamOnce(messages, callOptions, onDelta) {
    const controller = new AbortController();
    callOptions.signal?.throwIfAborted();
    const requestTimeoutMs = callOptions.timeoutMs ?? timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error('超时')), Math.max(1, requestTimeoutMs));
    const onOuterAbort = () => controller.abort(callOptions.signal.reason);
    if (callOptions.signal) {
      if (callOptions.signal.aborted) onOuterAbort();
      else callOptions.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const startedAt = Date.now();
    let ttftMs = null;
    let httpStatus = null;
    try {
      const body = responsesApi
        ? { ...buildBody(messages, callOptions), stream: true }
        : { ...buildBody(messages, callOptions), stream: true, stream_options: { include_usage: true } };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      ttftMs = Date.now() - startedAt;
      httpStatus = response.status ?? null;
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`LLM HTTP ${response.status}: ${detail.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
      // —— 解析 SSE:Responses 认 response.output_text.delta / completed;Chat 认 choices.delta ——
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let usage = null;
      let finishReason = null;
      let streamModel = '';
      const thinkFilter = responsesApi ? null : createReasoningTagFilter();
      const onLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let chunk = null;
        try { chunk = JSON.parse(payload); } catch { return; }   // 半行/心跳容错
        if (responsesApi) {
          if (chunk.type === 'response.output_text.delta') {
            const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
            if (delta) {
              text += delta;
              onDelta?.(delta, text);
            }
            return;
          }
          if (chunk.type === 'response.completed') {
            const final = chunk.response && typeof chunk.response === 'object' ? chunk.response : {};
            usage = normalizeResponsesUsage(final.usage ?? chunk.usage);
            if (typeof final.model === 'string' && final.model) streamModel = final.model;
            finishReason = final.status === 'incomplete'
              ? (final.incomplete_details?.reason ?? 'incomplete')
              : (final.status ?? null);
            // 极少数网关只在 completed 里给整段正文:没有 delta 时补一次。
            if (!text) {
              const whole = extractResponsesChoice(final);
              if (whole.text) {
                text = whole.text;
                onDelta?.(whole.text, text);
              }
            }
            return;
          }
          if (chunk.type === 'response.failed' || chunk.type === 'error' || chunk.error) {
            const message = chunk.error?.message || chunk.response?.error?.message || 'responses stream failed';
            const error = new Error(`LLM Responses 流失败: ${String(message).slice(0, 200)}`);
            error.status = Number.isInteger(chunk.error?.status) ? chunk.error.status : 502;
            throw error;
          }
          return;
        }
        if (chunk.usage) usage = normalizeLlmUsage(chunk.usage);
        if (typeof chunk.model === 'string' && chunk.model) streamModel = chunk.model;
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';
        if (delta) {
          const visible = thinkFilter ? thinkFilter.push(delta) : delta;
          if (visible) {
            text += visible;
            onDelta?.(visible, text);
          }
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) {
          onLine(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
        }
      }
      if (buffer.trim()) onLine(buffer);   // 尾行没带换行的也认
      const totalMs = Date.now() - startedAt;
      // 有些网关"流式"其实一次整包 —— text 一次到齐也算流式成功(空回复由调用方按空轮处理)。
      log.info?.(`[llm] ${streamModel || callOptions.model || model} STREAM ttft=${ttftMs}ms total=${totalMs}ms chars=${text.length} completion=${usage?.completionTokens ?? '?'}tok`);
      return {
        text,
        toolCalls: null,
        finishReason,
        usage,
        model: streamModel || callOptions.model || model,
        raw: { streamed: true },
      };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        const wrapped = new Error(`LLM 请求超时或被取消(${timeoutMs}ms)`);
        wrapped.name = 'FetchError';
        throw wrapped;
      }
      log.info?.(`[llm] ${callOptions.model || model} STREAM FAILED status=${httpStatus ?? '?'} ttft=${ttftMs ?? '?'}ms total=${Date.now() - startedAt}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
      if (callOptions.signal) callOptions.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * **流式打一轮**:形状与 `chat()` 一致,多一个 `onDelta(delta, textSoFar)` 回调。
   * ⚠️ 重试只发生在**第一个字出门之前**(canRetry 守着)—— 字见了客户端再"重试",
   *    用户就会看到半截话接半截话,那是撒谎。
   */
  async function chatStream(messages, callOptions = {}, onDelta = null) {
    let streamed = false;
    return withRetry(messages, callOptions, (finalMessages) =>
      queue.run(() => callStreamOnce(finalMessages, callOptions, onDelta ? (delta, full) => {
        streamed = true;
        onDelta(delta, full);
      } : null), { signal: callOptions.signal }), () => !streamed);
  }
  return { chat, chatStream, queue };
}
