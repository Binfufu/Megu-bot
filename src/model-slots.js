/**
 * **模型接入 · 两套配置的纯逻辑**(2026-10-18 / 1.153.0)。
 *
 * ## 为什么只有两个 slot
 *
 * 用户 2026-10-18 拍板:**前端只是连接块,Bot 后端只有一套身份/记忆/模型配置** ——
 * QQ、世界网页、以后的企业微信都共用 `bot` 这一套;梦境是仿酒馆的独立玩法,才单独一套。
 *
 * 所以这个模块里**没有** world/qqbot 之分:+ 以后新增前端也不许在这里加 slot。
 *
 * ## 这个文件管什么
 *
 * 全是**纯函数**:环境变量默认值、JSON 覆盖合并、URL/模型/key 校验、mask、指纹。
 * 真正的读写盘/建 client/热替换在 `llm-settings.js`。
 */

import { createHash } from 'node:crypto';

/** 固定两个 slot;顺序就是面板上的顺序。 */
export const MODEL_SLOTS = Object.freeze(['bot', 'dream']);

/** 思考档位:auto = 按模型/通道默认;off 尽量关;其余是显式档。 */
export const REASONING_LEVELS = Object.freeze(['auto', 'off', 'low', 'medium', 'high', 'max']);

export function normalizeReasoning(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '' || text === 'auto') return { ok: true, value: 'auto' };
  if (!REASONING_LEVELS.includes(text)) return { ok: false, error: 'bad_reasoning' };
  return { ok: true, value: text };
}

export const SLOT_META = Object.freeze({
  bot: Object.freeze({
    label: 'Bot 主模型',
    sub: '所有前端共用：QQ / 世界网页 / 以后的企业微信……',
    envPrefix: 'QQBOT_LLM_',
  }),
  dream: Object.freeze({
    label: '梦境',
    sub: '仿酒馆玩法，独立模型/key，不碰 Bot 记忆与身份。',
    envPrefix: 'QQBOT_LLM_DREAM_',
  }),
});

/**
 * 供应商预置。只用来**填 Base URL 和模型候选**,不是白名单 ——
 * 真正的可用性以“测试连接”那一次真调用为准(和 D159 的“一份口径”一致)。
 */
export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    models: Object.freeze(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat']),
    keyHint: 'sk-…',
  }),
  Object.freeze({
    id: 'xai',
    label: 'xAI 官方',
    baseUrl: 'https://api.x.ai/v1',
    models: Object.freeze(['grok-4.7', 'grok-4.6', 'grok-4.5']),
    keyHint: 'xai-…',
  }),
  Object.freeze({
    id: 'longapi',
    label: '龙API / 中转站',
    baseUrl: '',
    models: Object.freeze(['grok-4.7', 'gemini-3.8-flash', 'gemini-3-flash', 'grok-4.5']),
    keyHint: 'sk-…',
  }),
  Object.freeze({
    id: 'volcengine-agent-plan',
    label: '火山方舟 Agent Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    // ⚠️ Agent Plan 的模型名不带日期后缀;走 /responses(不是 /chat/completions)。
    // 目录来自官方 Agent Plan 目录(Seed 2.1 Turbo 在 Small 档;以控制台实际为准)。
    models: Object.freeze([
      'doubao-seed-2.1-turbo',
      'doubao-seed-2.0-mini',
      'doubao-seed-2.0-lite',
      'deepseek-v4-flash',
      'glm-5.3-flash',
    ]),
    keyHint: 'Agent Plan 专属 Key（ark-…）',
  }),
  Object.freeze({
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    baseUrl: '',
    models: Object.freeze([]),
    keyHint: '任意',
  }),
]);

export function providerById(id) {
  return PROVIDERS.find((one) => one.id === String(id ?? '').trim()) ?? null;
}

/** 从 Base URL 认一个预置供应商(认不出就是 custom,不猜)。 */
export function providerForBaseUrl(baseUrl) {
  const text = String(baseUrl ?? '').toLowerCase();
  if (text.includes('api.deepseek.com')) return 'deepseek';
  if (text.includes('api.x.ai')) return 'xai';
  if (text.includes('/api/plan/v3')) return 'volcengine-agent-plan';
  if (text.includes('openrouter.ai')) return 'custom';
  return 'custom';
}

function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isBlockedMetadataHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === '169.254.169.254'
    || host === 'metadata.google.internal'
    || host.endsWith('.metadata.google.internal');
}

/**
 * Base URL 校验。
 *
 * 安全边界(用户 2026-10-18 选“最安全的方法”):
 *  · 只许 https;http 只许本机回环(本地代理);
 *  · 不许 URL 里带账号密码;
 *  · 不许指向云元数据地址;
 *  · 不许 query/hash(它们会混进拼出来的 endpoint)。
 *
 * 注意:这是**站长**填的地址,不是普通用户输入;再叠 staff + nonce,不把它做成公开 SSRF 面。
 */
export function normalizeBaseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, error: 'empty_base_url' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'bad_base_url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'bad_protocol' };
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return { ok: false, error: 'http_not_allowed' };
  if (url.username || url.password) return { ok: false, error: 'credentials_in_url' };
  if (url.search || url.hash) return { ok: false, error: 'query_not_allowed' };
  if (isBlockedMetadataHost(url.hostname)) return { ok: false, error: 'metadata_host' };
  const path = url.pathname.replace(/\/+$/, '');
  const value = `${url.origin}${path === '/' ? '' : path}`;
  return { ok: true, value };
}

export function normalizeModel(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, error: 'empty_model' };
  if (text.length > 120) return { ok: false, error: 'model_too_long' };
  // 模型名允许字母数字和 . _ : / - @;不许空白/控制字符(上游 header/body 不接受)。
  if (!/^[A-Za-z0-9._:/@-]+$/.test(text)) return { ok: false, error: 'bad_model' };
  return { ok: true, value: text };
}

export function normalizeProvider(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return 'custom';
  if (text.length > 40) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(text)) return null;
  return text;
}

export function normalizeApiKey(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, value: '' };
  if (text.length < 4 || text.length > 512) return { ok: false, error: 'bad_key_length' };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: 'bad_key_chars' };
  return { ok: true, value: text };
}

/**
 * 保存/测试输入的校验。`apiKey` 允许空 —— 空的意思是“沿用当前已保存的 key”,
 * 由调用方(llm-settings)补;它在这里只负责格式。
 */
export function validateSlotInput(input = {}) {
  const slot = String(input.slot ?? '').trim();
  if (!MODEL_SLOTS.includes(slot)) return { ok: false, error: 'bad_slot' };
  const provider = normalizeProvider(input.provider);
  if (provider === null) return { ok: false, error: 'bad_provider' };
  const base = normalizeBaseUrl(input.baseUrl);
  if (!base.ok) return { ok: false, error: base.error };
  const model = normalizeModel(input.model);
  if (!model.ok) return { ok: false, error: model.error };
  const key = normalizeApiKey(input.apiKey);
  if (!key.ok) return { ok: false, error: key.error };
  const reasoning = normalizeReasoning(input.reasoning);
  if (!reasoning.ok) return { ok: false, error: reasoning.error };
  return {
    ok: true,
    value: { slot, provider, baseUrl: base.value, model: model.value, apiKey: key.value, reasoning: reasoning.value },
  };
}

/** 只露尾号;绝不把 key 交给页面。 */
export function maskKey(key) {
  const text = String(key ?? '');
  if (text === '') return '';
  if (text.length <= 8) return '****';
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

/** 审计只记指纹,不记 key 本身。 */
export function keyFingerprint(key) {
  const text = String(key ?? '');
  if (text === '') return '';
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

function envText(env, name) {
  const value = env?.[name];
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * 环境变量默认值。
 *
 * ⚠️ **兼容现状,但如实标来源**:2026-10-18 之前 QQ 引擎的 key 是从
 * `QQBOT_LLM_DREAM_KEY` 回退借来的(`config.js` 原来就这么写),所以这里保留回退,
 * 但 `source` 会写成 `env:QQBOT_LLM_DREAM_KEY(回退)` —— 面板上一眼能看出“还没拆开”。
 *
 * 梦境**不**从 bot 回退:用户拍板“梦境没配就 503,不偷偷花 bot 的钱”。
 */
export function defaultsFromEnv(env = {}) {
  const botKeyOwn = envText(env, 'QQBOT_LLM_KEY');
  const botKey = botKeyOwn || envText(env, 'QQBOT_LLM_DREAM_KEY');
  const botBase = envText(env, 'QQBOT_LLM_BASEURL')
    || envText(env, 'QQBOT_LLM_DREAM_BASEURL')
    || 'https://api.deepseek.com/v1';
  const botModel = envText(env, 'QQBOT_LLM_MODEL')
    || envText(env, 'QQBOT_LLM_DREAM_MODEL')
    || 'deepseek-chat';
  const botSource = botKeyOwn
    ? 'env:QQBOT_LLM_KEY'
    : (botKey ? 'env:QQBOT_LLM_DREAM_KEY(回退)' : 'none');

  const dreamKey = envText(env, 'QQBOT_LLM_DREAM_KEY');
  const dreamBase = envText(env, 'QQBOT_LLM_DREAM_BASEURL');
  const dreamModel = envText(env, 'QQBOT_LLM_DREAM_MODEL');

  return {
    bot: {
      slot: 'bot',
      provider: providerForBaseUrl(botBase),
      baseUrl: botBase,
      model: botModel,
      apiKey: botKey,
      reasoning: 'auto',
      source: botSource,
      configured: Boolean(botKey && botBase && botModel),
    },
    dream: {
      slot: 'dream',
      provider: providerForBaseUrl(dreamBase),
      baseUrl: dreamBase,
      model: dreamModel,
      apiKey: dreamKey,
      reasoning: 'auto',
      source: dreamKey ? 'env:QQBOT_LLM_DREAM_KEY' : 'none',
      configured: Boolean(dreamKey && dreamBase && dreamModel),
    },
  };
}

function pickOverride(override) {
  if (!override || typeof override !== 'object') return {};
  const out = {};
  for (const key of ['provider', 'baseUrl', 'model', 'apiKey', 'reasoning']) {
    if (override[key] !== undefined && override[key] !== null && String(override[key]).trim() !== '') {
      out[key] = String(override[key]).trim();
    }
  }
  return out;
}

/**
 * 默认值 + JSON 覆盖。key 的优先级是“覆盖里有就用覆盖,否则用默认”;
 * 这就是“留空 = 不换 key”的唯一实现处。
 */
export function mergeSlot(defaults, override) {
  const over = pickOverride(override);
  const hasOverride = Object.keys(over).length > 0;
  const apiKey = Object.prototype.hasOwnProperty.call(over, 'apiKey') ? over.apiKey : defaults.apiKey;
  const merged = {
    slot: defaults.slot,
    provider: over.provider ?? defaults.provider ?? 'custom',
    baseUrl: over.baseUrl ?? defaults.baseUrl ?? '',
    model: over.model ?? defaults.model ?? '',
    apiKey,
    reasoning: over.reasoning ?? defaults.reasoning ?? 'auto',
    source: hasOverride ? 'panel' : (defaults.source ?? 'none'),
    updatedAt: Number(override?.updatedAt) || 0,
    updatedBy: typeof override?.updatedBy === 'string' ? override.updatedBy : null,
  };
  merged.configured = Boolean(merged.apiKey && merged.baseUrl && merged.model);
  return merged;
}

/** 出网/出页面的视图:永远不带 apiKey。 */
export function publicSlotView(effective) {
  return {
    slot: effective.slot,
    label: SLOT_META[effective.slot]?.label ?? effective.slot,
    sub: SLOT_META[effective.slot]?.sub ?? '',
    provider: effective.provider,
    baseUrl: effective.baseUrl,
    model: effective.model,
    reasoning: effective.reasoning ?? 'auto',
    keyMasked: maskKey(effective.apiKey),
    hasKey: Boolean(effective.apiKey),
    configured: Boolean(effective.configured),
    source: effective.source,
    updatedAt: Number(effective.updatedAt) || 0,
    updatedBy: effective.updatedBy ?? null,
  };
}
