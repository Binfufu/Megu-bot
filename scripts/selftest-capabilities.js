/**
 * **公共能力运行时**(P3-a,2026-10-28)回归。
 *
 * 核心等式:可声明 = 注册 ∩ 授权 ∩ 用途 ∩ 模型已证兼容;**执行端再授权**。
 * 三个反证锚点(每一个都对应一种真实事故形状):
 *   · 模型伪造被隐藏工具的调用 → authorizeExecution 必须拦(隐藏 ≠ 禁用);
 *   · 模型能力 unknown → 不给工具(不赌);内部用途(摘要)→ 一个都不给;
 *   · 搜索 provider 的错误分类照官方表(402 不重试 / 429 可重试),key 零泄漏。
 */
import assert from 'node:assert/strict';
import {
  PURPOSE_TOOL_DEFAULTS,
  authorizeExecution,
  defineCapability,
  executeAuthorized,
  advertisedTools,
  turnContextFor,
  validateAgainstSchema,
} from '../src/capabilities.js';
import {
  budgetExhaustedText,
  buildAssistantMessage,
  buildToolResultMessages,
  extractToolCalls,
  nextLoopAction,
} from '../src/tool-loop.js';
import { SEARCH_LIMITS, createWebSearchProvider, validateFetchUrl } from '../src/web-search-provider.js';

const FAKE_KEY = 'sk-FIXTURE-NEVER-PRINT';
const searchCap = defineCapability({
  id: 'web_search',
  description: '搜索公开网页',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  effect: 'read-only',
  execute: async () => ({ ok: true, data: [] }),
});
const echoCap = defineCapability({
  id: 'fixture_echo',
  description: '测试用',
  inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
  effect: 'mutating',
  execute: async () => ({ ok: true }),
});

function fakeFetch(status, payload) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
}

export function registerCapabilityTests({ test, assert: a }) {
  test('defineCapability:形状不对当场抛(拼错不许静默上线)', () => {
    a.throws(() => defineCapability({ id: 'Bad-Id', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only', execute: async () => {} }));
    a.throws(() => defineCapability({ id: 'ok_id', description: '', inputSchema: { type: 'object' }, effect: 'read-only', execute: async () => {} }));
    a.throws(() => defineCapability({ id: 'ok_id', description: 'x', inputSchema: { type: 'array' }, effect: 'read-only', execute: async () => {} }));
    a.throws(() => defineCapability({ id: 'ok_id', description: 'x', inputSchema: { type: 'object' }, effect: 'danger', execute: async () => {} }));
    a.throws(() => defineCapability({ id: 'ok_id', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only' }));
    const cap = defineCapability({ id: 'ok_id', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only', execute: async () => ({}) });
    a.equal(Object.isFrozen(cap), true, '定义必须冻结(不许运行期改权限)');
  });

  test('可声明等式:内部用途/模型unknown/授权空 → 一个工具都不给;全过 → OpenAI 形状', () => {
    const ctx = turnContextFor({ botId: 'aris', actorId: null, scene: 'group', conversationKey: 'k', purpose: 'chat' });
    const grant = { allowToolIds: new Set(['web_search']) };
    a.deepEqual(advertisedTools({ capabilities: [searchCap], turnContext: ctx, grant, modelCaps: { functionTools: true } }),
      [{ type: 'function', function: { name: 'web_search', description: '搜索公开网页', parameters: searchCap.inputSchema } }]);
    // 模型能力 unknown / false → 不赌,不给。
    a.deepEqual(advertisedTools({ capabilities: [searchCap], turnContext: ctx, grant, modelCaps: { functionTools: 'unknown' } }), []);
    a.deepEqual(advertisedTools({ capabilities: [searchCap], turnContext: ctx, grant, modelCaps: { functionTools: false } }), []);
    // 授权 fail closed:null / 空集合 / 不含该工具 → 都不给。
    a.deepEqual(advertisedTools({ capabilities: [searchCap], turnContext: ctx, grant: { allowToolIds: null }, modelCaps: { functionTools: true } }), []);
    a.deepEqual(advertisedTools({ capabilities: [searchCap], turnContext: ctx, grant: { allowToolIds: new Set() }, modelCaps: { functionTools: true } }), []);
    a.deepEqual(advertisedTools({ capabilities: [searchCap], turnContext: ctx, grant: { allowToolIds: new Set(['other']) }, modelCaps: { functionTools: true } }), []);
    // 内部用途(摘要/后台生成)一个都不给 —— 它们不是办事的。
    for (const purpose of ['summary', 'internal']) {
      const inner = turnContextFor({ botId: 'aris', actorId: null, scene: '', conversationKey: 'k', purpose });
      a.deepEqual(advertisedTools({ capabilities: [searchCap], turnContext: inner, grant, modelCaps: { functionTools: true } }), [], `${purpose} 不许有工具`);
    }
  });

  test('turnContext:purpose 必须是三态之一,actorId 只许显式', () => {
    a.throws(() => turnContextFor({ botId: 'aris', purpose: 'boss' }));
    a.equal(turnContextFor({ botId: 'aris', purpose: 'chat', actorId: undefined }).actorId, null);
    a.equal(turnContextFor({ botId: 'aris', purpose: 'chat', actorId: 'openid-x' }).actorId, 'openid-x');
  });

  test('schema 校验:required / 类型 / integer 是形状闸,不是通用校验器', () => {
    const schema = { type: 'object', properties: { query: { type: 'string' }, n: { type: 'integer' } }, required: ['query'] };
    a.equal(validateAgainstSchema({ query: 'x', n: 2 }, schema).ok, true);
    a.equal(validateAgainstSchema({ n: 2 }, schema).ok, false, '缺 required 必拒');
    a.equal(validateAgainstSchema({ query: 1 }, schema).ok, false, '类型不对必拒');
    a.equal(validateAgainstSchema({ query: 'x', n: 2.5 }, schema).ok, false, 'integer 不收小数');
    a.equal(validateAgainstSchema(null, schema).ok, false);
    a.equal(validateAgainstSchema('x', schema).ok, false);
  });

  test('执行端再授权:被隐藏的工具、内部用途、mutating、坏参数全都拦得住', () => {
    const grant = { allowToolIds: new Set(['web_search']) };
    const ctx = turnContextFor({ botId: 'aris', actorId: 'u1', scene: 'c2c', conversationKey: 'k', purpose: 'chat' });
    // ① 模型伪造没被声明的工具 → UNSUPPORTED(哪怕 grant 里有别的)。
    const hidden = authorizeExecution({ capability: echoCap, args: { n: 1 }, turnContext: ctx, grant });
    a.equal(hidden.ok, false);
    a.equal(hidden.error.code, 'DENIED', 'mutating 未授权 → DENIED');
    // ② 隐藏的 read-only 工具:grant 不含 → DENIED(隐藏 ≠ 禁用的执行端闸)。
    const notGranted = authorizeExecution({ capability: echoCap, args: {}, turnContext: ctx, grant: { allowToolIds: new Set(['web_search']) } });
    a.equal(notGranted.error.code, 'DENIED');
    // ③ effect 闸:授权了也不给 mutating。
    const mutant = authorizeExecution({ capability: echoCap, args: { n: 1 }, turnContext: ctx, grant: { allowToolIds: new Set(['fixture_echo']) } });
    a.equal(mutant.error.code, 'EFFECT_DENIED', '首批只开放只读');
    // ④ 内部用途:一切拒。
    const inner = turnContextFor({ botId: 'aris', actorId: null, scene: '', conversationKey: 'k', purpose: 'summary' });
    a.equal(authorizeExecution({ capability: searchCap, args: { query: 'x' }, turnContext: inner, grant }).error.code, 'PURPOSE_DENIED');
    // ⑤ 坏参数 → INVALID_ARGUMENTS;好参数 → 放行。
    a.equal(authorizeExecution({ capability: searchCap, args: {}, turnContext: ctx, grant }).error.code, 'INVALID_ARGUMENTS');
    a.equal(authorizeExecution({ capability: searchCap, args: { query: 'x' }, turnContext: ctx, grant }).ok, true);
    a.equal(authorizeExecution({ capability: null, args: {}, turnContext: ctx, grant }).error.code, 'UNSUPPORTED');
  });

  test('executeAuthorized:抛错结构化、裸值包成功、{ok:false}如实透传', async () => {
    const grant = { allowToolIds: new Set(['boom', 'bare', 'failcap']) };
    const ctx = turnContextFor({ botId: 'aris', actorId: 'u1', scene: 'c2c', conversationKey: 'k', purpose: 'chat' });
    const boom = defineCapability({ id: 'boom', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only', execute: async () => { throw new Error('炸了'); } });
    const bare = defineCapability({ id: 'bare', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only', execute: async () => ({ hits: 1 }) });
    const failcap = defineCapability({ id: 'failcap', description: 'x', inputSchema: { type: 'object' }, effect: 'read-only', execute: async () => ({ ok: false, error: { code: 'RATE_LIMIT', retryable: true } }) });
    const boomResult = await executeAuthorized({ capability: boom, args: {}, turnContext: ctx, grant });
    a.equal(boomResult.ok, false);
    a.equal(boomResult.error.code, 'EXEC_FAILED', '抛错必须被接住结构化,不许把失败装成功');
    a.equal((await executeAuthorized({ capability: bare, args: {}, turnContext: ctx, grant })).data.hits, 1, '裸值包成 data');
    a.equal((await executeAuthorized({ capability: failcap, args: {}, turnContext: ctx, grant })).error.code, 'RATE_LIMIT', 'provider 的失败如实透传');
  });

  test('tool-loop:assistant 原样接回、结果按 call_id 配对、预算耗尽显式失败', () => {
    const calls = [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }];
    const response = { text: '', toolCalls: calls, raw: { reasoning_content: 'chain' } };
    a.deepEqual(extractToolCalls(response), calls);
    a.deepEqual(extractToolCalls({}), []);
    const assistant = buildAssistantMessage(response);
    a.equal(assistant.role, 'assistant');
    a.deepEqual(assistant.tool_calls, calls, 'tool_calls 必须原样带回(不许只抄正文)');
    a.equal(assistant.reasoning_content, 'chain', '思考态协议字段保留(带 tools 时官方要求完整回传)');
    const results = new Map([['c1', { ok: true, results: [] }]]);
    const [message] = buildToolResultMessages(calls, results);
    a.equal(message.role, 'tool');
    a.equal(message.tool_call_id, 'c1');
    a.match(message.content, /"ok":true/);
    const [missing] = buildToolResultMessages([{ id: 'c9', function: { name: 'x' } }], results);
    a.match(missing.content, /NO_RESULT/, '没结果的调用不许静默消失');
    // 循环动作。
    a.equal(nextLoopAction({ rounds: 1, maxRounds: 3, response }).action, 'execute');
    a.equal(nextLoopAction({ rounds: 3, maxRounds: 3, response }).action, 'budget-exhausted');
    a.equal(nextLoopAction({ rounds: 1, maxRounds: 3, response: { text: '答' } }).action, 'finish');
    a.equal(nextLoopAction({ rounds: 1, maxRounds: 0, response }).action, 'budget-exhausted', '非法预算按最保守处理');
    const text = budgetExhaustedText(['web_search']);
    a.match(text, /web_search/);
    a.match(text, /没能完成/, '预算耗尽必须显式说"没办完",不许拿中间文本装答案');
  });

  test('web provider(假上游):结果映射、空结果=成功、错误分类照官方表、key 零泄漏', async () => {
    const provider = createWebSearchProvider({
      baseUrl: 'https://api.example.test', apiKey: FAKE_KEY,
      fetchImpl: fakeFetch(200, { results: [{ url: 'https://a.b/c', title: 'T', snippet: 's', date: '2026-01-01' }] }),
    });
    const hit = await provider.search('测试', { count: 3 });
    a.equal(hit.ok, true);
    a.equal(hit.results[0].url, 'https://a.b/c');
    a.equal(hit.results[0].untrusted, true, '网页内容必须标不可信');
    a.ok(hit.results[0].retrievedAt, '要有取回时间');
    // 空结果 = 成功。
    const empty = await createWebSearchProvider({ baseUrl: 'https://api.example.test', apiKey: FAKE_KEY, fetchImpl: fakeFetch(200, { results: [] }) }).search('x');
    a.deepEqual([empty.ok, empty.results.length], [true, 0]);
    // 错误分类:402 不重试 / 429 可重试 / 401 AUTH / 网络异常可重试。
    const needBalance = await createWebSearchProvider({ baseUrl: 'https://api.example.test', apiKey: FAKE_KEY, fetchImpl: fakeFetch(402, { error: { message: 'no balance' } }) }).search('x');
    a.deepEqual([needBalance.error.code, needBalance.error.retryable], ['NEED_BALANCE', false]);
    const rate = await createWebSearchProvider({ baseUrl: 'https://api.example.test', apiKey: FAKE_KEY, fetchImpl: fakeFetch(429, {}) }).search('x');
    a.deepEqual([rate.error.code, rate.error.retryable], ['RATE_LIMIT', true]);
    const auth = await createWebSearchProvider({ baseUrl: 'https://api.example.test', apiKey: FAKE_KEY, fetchImpl: fakeFetch(401, {}) }).search('x');
    a.equal(auth.error.code, 'AUTH');
    const network = await createWebSearchProvider({ baseUrl: 'https://api.example.test', apiKey: FAKE_KEY, fetchImpl: async () => { throw new Error('boom'); } }).search('x');
    a.deepEqual([network.error.code, network.error.retryable], ['NETWORK', true]);
    // key 零泄漏:所有失败结果的整体序列化里不许出现 key。
    for (const bad of [needBalance, rate, auth, network]) {
      a.equal(JSON.stringify(bad).includes(FAKE_KEY), false);
    }
    // 参数闸:空词 / 超长词。
    const blank = await provider.search('  ');
    a.equal(blank.error.code, 'INVALID_ARGUMENTS');
    const tooLong = await provider.search('x'.repeat(SEARCH_LIMITS.queryMaxChars + 1));
    a.equal(tooLong.error.code, 'INVALID_ARGUMENTS');
  });

  test('fetch URL 闸:只许 http/https、不许 userinfo、超长拒;合法 URL 原样回流', async () => {
    a.equal(validateFetchUrl('ftp://a.b/c').ok, false);
    a.equal(validateFetchUrl('https://user:pass@a.b/c').ok, false, '不许带用户名/密码(官方同款)');
    a.equal(validateFetchUrl('').ok, false);
    a.equal(validateFetchUrl('https://a.b/' + 'x'.repeat(9000)).ok, false);
    const ok = validateFetchUrl('https://example.com/a?q=1');
    a.equal(ok.ok, true);
    a.equal(ok.url, 'https://example.com/a?q=1');
    const provider = createWebSearchProvider({
      baseUrl: 'https://api.example.test', apiKey: FAKE_KEY,
      fetchImpl: fakeFetch(200, { title: 'T', content: '# 正文' }),
    });
    const page = await provider.fetchPage('https://example.com/a');
    a.deepEqual([page.ok, page.untrusted, page.content], [true, true, '# 正文']);
    const bad = await provider.fetchPage('javascript:alert(1)');
    a.equal(bad.error.code, 'INVALID_ARGUMENTS');
  });
}
