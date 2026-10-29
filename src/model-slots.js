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
import { ParamError, defineParam, resolveParamLayers } from './params.js';

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

/**
 * 从 Base URL 认一个预置供应商(认不出就是 custom,不猜)。
 *
 * ⚠️ 按 **URL 解析出来的 host / pathname** 判定,不用 `includes('api.deepseek.com')`
 * 这种做法(1.204.9 安全加固):子串判定会被 `https://evil.example/api.deepseek.com`
 * 骗成 deepseek(CodeQL js/incomplete-url-substring-sanitization)。解析失败就当 custom。
 */
export function providerForBaseUrl(baseUrl) {
  const text = String(baseUrl ?? '').trim();
  if (!text) return 'custom';
  let host;
  let pathname;
  try {
    const url = new URL(text);
    host = url.hostname.toLowerCase();
    pathname = url.pathname.toLowerCase();
  } catch {
    return 'custom';
  }
  const hostIs = (suffix) => host === suffix || host.endsWith(`.${suffix}`);
  if (hostIs('api.deepseek.com')) return 'deepseek';
  if (hostIs('api.x.ai')) return 'xai';
  if (pathname.includes('/api/plan/v3')) return 'volcengine-agent-plan';
  if (hostIs('openrouter.ai')) return 'custom';
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

/** 五字段注册表。空连接字段是合法的“未配置”，不是可启动的 client。 */
const MODEL_PARAM_FIELDS = Object.freeze(['provider', 'baseUrl', 'model', 'apiKey', 'reasoning']);
const trustedParamSources = new WeakMap();

/** 单次 data-descriptor 快照，不执行 getter/继承属性/自定义 String，也不透传 Proxy 异常。 */
function modelDataSnapshot(raw, source, { optional = false, environment = false } = {}) {
  if (optional && (raw === undefined || raw === null)) return Object.create(null);
  try {
    if (!raw || typeof raw !== 'object') throw new Error();
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null && !(environment && raw === process.env)) throw new Error();
    const snapshot = Object.create(null);
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error();
      // 只允许本模块自己生成的非枚举旁路元数据；外部非枚举输入仍拒绝。
      if (key === 'paramSources' && trustedParamSources.has(raw) && !descriptor.enumerable) continue;
      if (!descriptor.enumerable) throw new Error();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    throw new ParamError('PARAM_UNSAFE', undefined, source);
  }
}

function modelText(value, source, id) {
  if (value === undefined || value === null) return '';
  if (!['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
    throw new ParamError('PARAM_TYPE', id, source);
  }
  return String(value).trim();
}

function normalizedParam(normalize, { allowEmpty = false } = {}) {
  return (raw) => {
    const text = String(raw ?? '').trim();
    if (allowEmpty && text === '') return '';
    const result = normalize(text);
    if (!result.ok) throw new Error('invalid_model_param');
    return result.value;
  };
}

const modelParamSpecs = {
  provider: { default: 'custom', parse: (raw) => {
    const value = normalizeProvider(raw);
    if (value === null) throw new Error('invalid_model_param');
    return value;
  } },
  baseUrl: { default: '', parse: normalizedParam(normalizeBaseUrl, { allowEmpty: true }) },
  model: { default: '', parse: normalizedParam(normalizeModel, { allowEmpty: true }) },
  apiKey: { default: '', parse: normalizedParam(normalizeApiKey), sensitive: true },
  reasoning: { type: 'enum', values: REASONING_LEVELS, default: 'auto', parse: normalizedParam(normalizeReasoning) },
};

export const MODEL_PARAM_DEFS = Object.freeze(MODEL_PARAM_FIELDS.map((id) => defineParam({
  id, type: 'string', emptyAsUnset: false, scope: 'deployment', ...modelParamSpecs[id],
})));

export const MODEL_SLOT_PARAM_DEFS = Object.freeze(Object.fromEntries(MODEL_SLOTS.map((slot) => {
  const dream = slot === 'dream';
  const aliases = (suffix) => dream
    ? [`QQBOT_LLM_DREAM_${suffix}`]
    : [`QQBOT_LLM_${suffix}`, `QQBOT_LLM_DREAM_${suffix}`];
  const envNames = { baseUrl: aliases('BASEURL'), model: aliases('MODEL'), apiKey: aliases('KEY') };
  return [slot, Object.freeze(MODEL_PARAM_FIELDS.map((id) => defineParam({
    id, type: 'string', scope: 'deployment', ...modelParamSpecs[id],
    ...(id === 'baseUrl' && !dream ? { default: 'https://api.deepseek.com/v1' } : {}),
    ...(id === 'model' && !dream ? { default: 'deepseek-chat' } : {}),
    ...(envNames[id] ? { env: envNames[id] } : {}),
    emptyAsUnset: true,
  })))];
})));

/** 诊断只保留来源，永远不保留 inputs/values（尤其不保留 key/DPAPI blob）。 */
function attachParamSources(target, sources) {
  const safe = Object.fromEntries(MODEL_PARAM_FIELDS.map((id) => {
    const one = sources[id];
    const chain = Object.freeze((one?.chain ?? []).map((step) => Object.freeze({
      source: step.source,
      ...(step.env ? { env: step.env } : {}),
    })));
    return [id, Object.freeze({ source: one?.source ?? 'default', chain,
      sensitive: id === 'apiKey', ...(one?.derivedFrom ? { derivedFrom: one.derivedFrom } : {}),
    })];
  }));
  const metadata = Object.freeze(safe);
  Object.defineProperty(target, 'paramSources', { value: metadata, enumerable: false });
  trustedParamSources.set(target, metadata);
  return target;
}

/** 仅指配置/client 默认来源；本次请求的 callOptions.model/reasoningEffort 是另一层边界。 */
export function modelParamSources(config) {
  // 诊断也不执行调用方自带的同名 getter。
  try {
    const descriptor = config && Object.getOwnPropertyDescriptor(config, 'paramSources');
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  } catch { return null; }
}

/** 纯解析/诊断入口：env 默认永远低于 saved-file；只挑本模块五字段，兼容 UI 附属字段。 */
export function resolveModelSlotParams(defaults = {}, override = null) {
  const inherited = trustedParamSources.get(defaults);
  const base = modelDataSnapshot(defaults, 'slot-defaults');
  const over = pickOverride(modelDataSnapshot(override, 'saved-file', { optional: true }));
  return resolveModelSlotSnapshot(base, over, inherited);
}

function resolveModelSlotSnapshot(defaults, over, inheritedSources) {
  const values = Object.fromEntries(MODEL_PARAM_FIELDS.filter((id) => defaults[id] !== undefined)
    .map((id) => {
      modelText(defaults[id], 'slot-defaults', id); // 拒绝有自定义转换行为的对象。
      return [id, defaults[id]];
    }));
  const result = resolveParamLayers(MODEL_PARAM_DEFS, [
    { source: 'slot-defaults', kind: 'params', values },
    { source: 'saved-file', kind: 'params', values: over },
  ]);
  const sources = Object.fromEntries(MODEL_PARAM_FIELDS.map((id) => {
    const inherited = inheritedSources?.[id];
    const saved = result.sources[id].chain.filter((step) => step.source === 'saved-file');
    return [id, inherited ? {
      ...inherited,
      source: saved.length ? 'saved-file' : inherited.source,
      chain: [...inherited.chain, ...saved],
      ...(saved.length ? { derivedFrom: undefined } : {}),
    } : result.sources[id]];
  }));
  return { values: result.values, sources };
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
  const snapshot = modelDataSnapshot(env, 'env', { environment: true });
  // 环境入口原有 String+trim/空为未设语义保持；取数后只使用同一快照。
  const envValues = Object.fromEntries(['QQBOT_LLM_KEY', 'QQBOT_LLM_BASEURL', 'QQBOT_LLM_MODEL',
    'QQBOT_LLM_DREAM_KEY', 'QQBOT_LLM_DREAM_BASEURL', 'QQBOT_LLM_DREAM_MODEL',
  ].map((name) => [name, modelText(snapshot[name], 'env', undefined)]));
  // 所有别名层均校验；自己的合法 env 不得掩盖非法 dream 回退层。
  const resolved = Object.fromEntries(MODEL_SLOTS.map((slot) => [slot,
    resolveParamLayers(MODEL_SLOT_PARAM_DEFS[slot], [{ source: 'env', kind: 'env', values: envValues }]),
  ]));
  const botKeyOwn = envValues.QQBOT_LLM_KEY;
  const botKey = botKeyOwn || envValues.QQBOT_LLM_DREAM_KEY;
  const botBase = envValues.QQBOT_LLM_BASEURL
    || envValues.QQBOT_LLM_DREAM_BASEURL
    || 'https://api.deepseek.com/v1';
  const botModel = envValues.QQBOT_LLM_MODEL
    || envValues.QQBOT_LLM_DREAM_MODEL
    || 'deepseek-chat';
  const botSource = botKeyOwn
    ? 'env:QQBOT_LLM_KEY'
    : (botKey ? 'env:QQBOT_LLM_DREAM_KEY(回退)' : 'none');

  const dreamKey = envValues.QQBOT_LLM_DREAM_KEY;
  const dreamBase = envValues.QQBOT_LLM_DREAM_BASEURL;
  const dreamModel = envValues.QQBOT_LLM_DREAM_MODEL;

  const result = {
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
  for (const slot of MODEL_SLOTS) {
    const sources = { ...resolved[slot].sources };
    sources.provider = { ...sources.baseUrl, derivedFrom: 'baseUrl', sensitive: false };
    attachParamSources(result[slot], sources);
  }
  return result;
}

function pickOverride(snapshot) {
  const out = {};
  for (const key of MODEL_PARAM_FIELDS) {
    const text = modelText(snapshot[key], 'saved-file', key);
    if (text !== '') out[key] = text;
  }
  return out;
}

/**
 * 默认值 + JSON 覆盖。key 的优先级是“覆盖里有就用覆盖,否则用默认”;
 * 这就是“留空 = 不换 key”的唯一实现处。
 */
export function mergeSlot(defaults, override) {
  const inherited = trustedParamSources.get(defaults);
  const base = modelDataSnapshot(defaults, 'slot-defaults');
  const saved = modelDataSnapshot(override, 'saved-file', { optional: true });
  const over = pickOverride(saved);
  const resolved = resolveModelSlotSnapshot(base, over, inherited);
  const hasOverride = Object.keys(over).length > 0;
  const apiKey = Object.hasOwn(over, 'apiKey') ? over.apiKey : base.apiKey;
  modelText(saved.updatedAt, 'saved-file', undefined);
  const merged = {
    slot: base.slot,
    provider: over.provider ?? base.provider ?? 'custom',
    baseUrl: over.baseUrl ?? base.baseUrl ?? '',
    model: over.model ?? base.model ?? '',
    apiKey,
    reasoning: over.reasoning ?? base.reasoning ?? 'auto',
    source: hasOverride ? 'panel' : (base.source ?? 'none'),
    updatedAt: Number(saved.updatedAt) || 0,
    updatedBy: typeof saved.updatedBy === 'string' ? saved.updatedBy : null,
  };
  merged.configured = Boolean(merged.apiKey && merged.baseUrl && merged.model);
  return attachParamSources(merged, resolved.sources);
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
