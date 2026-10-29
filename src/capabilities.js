/**
 * **公共能力运行时**(P3-a,2026-10-28)—— "所有 bot 共享同一套办事能力"的地基。
 *
 * ## 核心等式(谁也不许绕过)
 *
 * ```text
 * 本轮可声明工具 = 能力注册 ∩ 实例/操作者授权 ∩ 场景用途允许 ∩ 模型已证兼容
 * ```
 *
 * 四个条件**缺一不可**,而且**执行时再授权一次**——光靠"没把 schema 发给模型"当权限,
 * 模型伪造一个 tool_call 就绕过了(隐藏 ≠ 禁用)。
 *
 * ## 三层分离(D159 精神:每层一个文件,不许互相抄判定)
 *
 * | 层 | 这个文件管 | 不管 |
 * |---|---|---|
 * | 能力定义/授权 | ✅ registry、turnContext、advertise、execute 前校验 | 怎么调 HTTP、怎么切块 |
 * | 模型协议 | ❌ (tool-loop.js) | 谁能用 |
 * | 搜索等具体能力 | ❌ (web-search-provider.js) | 权限 |
 *
 * ## 平台无关
 *
 * 纯函数、零 IO。QQ/网页只在**构造 turnContext** 时提供身份与场景——通道不决定能力。
 *
 * ## 与 P0 基线的关系
 *
 * `capability-baseline.mjs` 里 `functionToolsSupport: 'unknown'` 的那些模型,
 * 在 `advertisedTools()` 里**拿不到工具**(unknown ≠ 支持,不赌)——
 * 真探针验证过才能置 true,那是部署侧的事,不是这里的猜测。
 */

/**
 * 声明一个能力。**只校验形状,不执行任何东西**(D105 动作协议同款纪律)。
 *
 * @param {object} spec
 * @param {string} spec.id 工具名(发给模型的就是它;snake_case)
 * @param {string} spec.description 给模型看的说明(每轮都占 token,写清但别写长)
 * @param {object} spec.inputSchema JSON Schema(object/properties/required 简版)
 * @param {'read-only'|'mutating'} spec.effect 只读 = 可自动执行;mutating = 首批一律拒
 * @param {number} [spec.costCny] 每次成功调用的估算成本(¥;P3 日预算用。0/缺省 = 不计费)
 * @param {(args: object, ctx: object) => Promise<object>} spec.execute
 *   返回**结构化结果** `{ok, data|error}` —— 失败也要如实返回,不许抛到循环外装成功
 * @returns {object} 冻结的能力定义
 */
export function defineCapability(spec) {
  const { id, description, inputSchema, effect, execute, costCny = 0 } = spec ?? {};
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{2,40}$/.test(id)) {
    throw new Error(`defineCapability: 非法工具 id(${JSON.stringify(id)})`);
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`defineCapability(${id}): description 必填`);
  }
  if (!inputSchema || inputSchema.type !== 'object' || typeof inputSchema !== 'object') {
    throw new Error(`defineCapability(${id}): inputSchema 必须是 {type:'object'}`);
  }
  if (effect !== 'read-only' && effect !== 'mutating') {
    throw new Error(`defineCapability(${id}): effect 只许 read-only / mutating`);
  }
  if (typeof execute !== 'function') throw new Error(`defineCapability(${id}): execute 必填`);
  const cost = Number(costCny);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(`defineCapability(${id}): costCny 只许非负数,收到 ${JSON.stringify(costCny)}`);
  }
  return Object.freeze({ id, description, inputSchema, effect, execute, costCny: cost });
}

/**
 * **给能力包一层日预算**(P3,2026-10-28;主人拍板:搜索日额度 1¥)。
 *
 * · 预算耗尽 → `BUDGET_EXCEEDED`(结构化错误回给模型,她会如实说"今天额度用完了");
 * · **成功才记账**(官方计费口径一致:失败不计费);
 * · 预算对象由 `tool-budget.js` 提供(注入存储,不建新表)。
 *
 * @param {object} capability `defineCapability` 的产物
 * @param {{remainingCny: Function, record: Function}} budget `createToolBudget` 的产物
 * @returns {object} 新的冻结能力定义(execute 被包装,其余字段原样)
 */
export function withBudget(capability, budget) {
  if (!capability || typeof capability.execute !== 'function') {
    throw new Error('withBudget: capability 必须来自 defineCapability');
  }
  if (!budget || typeof budget.remainingCny !== 'function' || typeof budget.record !== 'function') {
    throw new Error('withBudget: budget 需要 remainingCny/record');
  }
  return Object.freeze({
    ...capability,
    execute: async (args, ctx) => {
      if (!(budget.remainingCny() > 0)) {
        return { ok: false, error: { code: 'BUDGET_EXCEEDED', message: '今日工具额度已用完', retryable: false } };
      }
      const outcome = await capability.execute(args, ctx);
      // 官方口径:成功调用才计费。provider 自报的 {ok:true} 才记。
      if (outcome && outcome.ok === true && capability.costCny > 0) {
        budget.record(capability.costCny);
      }
      return outcome;
    },
  });
}

/** 用途 → 默认给不给工具。**内部生成(摘要/播报/洞察)一律无工具**——它们不是办事的。 */
export const PURPOSE_TOOL_DEFAULTS = Object.freeze({
  chat: true,
  summary: false,
  internal: false,
});

/**
 * 构造**可信轮次上下文**。actorId 必须由桥的身份鉴别给出——
 * **不许**从会话 key、提示词正文或模型参数里"推"出来(那等于让被调用者自己授权自己)。
 *
 * @param {{botId: string, actorId: string|null, scene: string, conversationKey: string,
 *          purpose: 'chat'|'summary'|'internal'}} input
 */
export function turnContextFor(input) {
  const { botId, actorId, scene, conversationKey, purpose } = input ?? {};
  if (typeof botId !== 'string' || botId === '') throw new Error('turnContextFor: botId 必填');
  if (!PURPOSE_TOOL_DEFAULTS.hasOwnProperty(purpose)) {
    throw new Error(`turnContextFor: purpose 只许 ${Object.keys(PURPOSE_TOOL_DEFAULTS).join('/')},收到 ${JSON.stringify(purpose)}`);
  }
  return Object.freeze({
    botId,
    actorId: typeof actorId === 'string' && actorId !== '' ? actorId : null,
    scene: String(scene ?? ''),
    conversationKey: String(conversationKey ?? ''),
    purpose,
  });
}

/**
 * 本轮**可声明**给模型的工具列表(OpenAI function 形状)。
 *
 * @param {{capabilities: object[], turnContext: object,
 *          grant: {allowToolIds: Set<string>|null},
 *          modelCaps: {functionTools: boolean|'unknown'}}} input
 *   `grant.allowToolIds` = 部署/实例授权的工具集合;`null` = 一个都不许(fail closed)。
 *   `modelCaps.functionTools` = `'unknown'` 或 false 都不给(不赌模型支持)。
 * @returns {Array<{type:'function', function:{name,description,parameters}}>}
 */
export function advertisedTools({ capabilities, turnContext, grant, modelCaps }) {
  if (turnContext?.purpose && PURPOSE_TOOL_DEFAULTS[turnContext.purpose] === false) return [];
  if (modelCaps?.functionTools !== true) return [];
  const allowed = grant?.allowToolIds instanceof Set ? grant.allowToolIds : null;
  if (!allowed || allowed.size === 0) return [];
  return (Array.isArray(capabilities) ? capabilities : [])
    .filter((cap) => allowed.has(cap.id))
    .map((cap) => ({
      type: 'function',
      function: {
        name: cap.id,
        description: cap.description,
        parameters: cap.inputSchema,
      },
    }));
}

/**
 * 简版 JSON Schema 校验(object/properties/required + string/number/boolean/integer/array)。
 * **刻意不做全集**($ref/oneOf 等):这里的职责是 fail-closed 的形状闸,不是通用校验器;
 * 真需要全集时先接成熟实现,不自己长(D22 纪律)。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function validateAgainstSchema(args, schema) {
  if (!schema || schema.type !== 'object') return { ok: false, reason: 'schema 不是 object' };
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: '参数不是 object' };
  }
  for (const field of Array.isArray(schema.required) ? schema.required : []) {
    if (!(field in args) || args[field] === undefined) {
      return { ok: false, reason: `缺必填字段 ${field}` };
    }
  }
  const TYPES = { string: 'string', number: 'number', boolean: 'boolean', integer: 'integer', array: 'array' };
  for (const [field, def] of Object.entries(schema.properties ?? {})) {
    if (!(field in args) || args[field] === undefined || def?.type === undefined) continue;
    const value = args[field];
    const want = TYPES[def.type];
    if (want === undefined) continue;
    const got = Array.isArray(value) ? 'array' : typeof value;
    const ok = want === 'integer' ? Number.isInteger(value) : got === want;
    if (!ok) return { ok: false, reason: `字段 ${field} 应为 ${def.type},实际 ${got}` };
  }
  return { ok: true, reason: null };
}

/** 执行端拒绝的**结构化错误**(不许抛裸字符串,循环要把它们如实回给模型/日志)。 */
export function denial(effect, reason) {
  return { ok: false, error: { code: effect, message: reason } };
}

/**
 * **执行端再授权**——即使模型伪造了被隐藏工具的调用,这里也拦得住。
 *
 * @param {{capability: object|null, args: unknown, turnContext: object,
 *          grant: {allowToolIds: Set<string>|null}}} input
 * @returns {{ok: boolean, error?: {code: string, message: string}, capability?: object, args?: object}}
 */
export function authorizeExecution({ capability, args, turnContext, grant }) {
  if (!capability) return denial('UNSUPPORTED', '未知工具');
  if (turnContext?.purpose && PURPOSE_TOOL_DEFAULTS[turnContext.purpose] === false) {
    return denial('PURPOSE_DENIED', `内部用途(${turnContext.purpose})不许用工具`);
  }
  const allowed = grant?.allowToolIds instanceof Set ? grant.allowToolIds : null;
  if (!allowed || !allowed.has(capability.id)) {
    return denial('DENIED', `工具 ${capability.id} 未获实例授权`);
  }
  if (capability.effect !== 'read-only') {
    return denial('EFFECT_DENIED', `工具 ${capability.id} 是 ${capability.effect},首批只开放只读`);
  }
  const check = validateAgainstSchema(args, capability.inputSchema);
  if (!check.ok) return denial('INVALID_ARGUMENTS', check.reason);
  return { ok: true, capability, args };
}

/**
 * 安全执行一个已授权的调用。execute 抛错 ≠ 失败回话丢——**捕获并结构化**,
 * 可重试性由具体 provider 在 error.retryable 里自报,这里不猜。
 */
export async function executeAuthorized({ capability, args, turnContext, grant, signal }) {
  const check = authorizeExecution({ capability, args, turnContext, grant });
  if (!check.ok) return check;
  try {
    const data = await check.capability.execute(check.args, { turnContext, signal });
    // execute 必须自己返回 {ok,...};返回裸值当成功数据包一层,绝不把 undefined 当成功。
    if (data && typeof data === 'object' && 'ok' in data) return data;
    return { ok: true, data: data ?? null };
  } catch (err) {
    return { ok: false, error: { code: 'EXEC_FAILED', message: String(err?.message ?? err), retryable: false } };
  }
}
