/**
 * **搜本 / 发图两个工具适配层**的回归(2026-11-24,`src/search-tools.js`)。
 *
 * 跑法:
 *
 *     node scripts/selftest-search-tools.js
 *
 * 全部合成、**零网络 / 零真实群 / 零真实图源**:
 *   · 参数归一用纯函数表(正例/反例);
 *   · 能力定义 + execute 用**假 defineCapability / 假 handlers**,不碰服务层;
 *   · 执行端授权用 `capabilities.authorizeExecution`(mutating 默认拒 / 显式放行);
 *   · 另用"禁网 fetch"哨兵证明这一层不会自己发请求。
 *
 * 钉:
 *   · 关键词与结构化条件二选一、至少一个条件、60 字/控制字符/页码/数量边界;
 *   · original+character 同时出现拒、original/character 多值拒;
 *   · meitu 的 count/tag 白名单/tier 口径与现有服务 parsed 形状一致;
 *   · 两个能力的 id/effect/costCny/描述/schema/冻结;
 *   · mutating 未进 `allowMutatingIds` → EFFECT_DENIED(默认拒绝语义不变);
 *   · 非法参数回 INVALID_ARGUMENTS 且**不调用** handler。
 */
import * as assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authorizeExecution,
  defineCapability,
  executeAuthorized,
  turnContextFor,
} from '../src/capabilities.js';
import { DEFAULT_JM_MAX, MAX_JM_KEYWORD_CHARS } from '../src/jm-command.js';
import { DEFAULT_MEITU_COUNT, DEFAULT_MEITU_MAX } from '../src/meitu-command.js';
import {
  SEARCH_TOOL_IDS,
  buildSearchTools,
  normalizeJmSearchArgs,
  normalizeMeituArgs,
} from '../src/search-tools.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const CHAT_CTX = turnContextFor({ botId: 'aris', actorId: 'u1', scene: 'group', conversationKey: 'g1', purpose: 'chat' });
const INVALID = 'INVALID_ARGUMENTS';

/** 假 handlers:记录收到的 parsed/ctx,返回可控结果;不联网。 */
function fakeHandlers() {
  const calls = [];
  return {
    calls,
    handlers: {
      jmSearch: async (parsed, ctx) => {
        calls.push({ kind: 'jm', parsed, ctx });
        return { ok: true, data: { action: parsed.action } };
      },
      meituSend: async (parsed, ctx) => {
        calls.push({ kind: 'meitu', parsed, ctx });
        return { ok: true, data: { count: parsed.count, tier: parsed.tier } };
      },
    },
  };
}

/** 断言一个归一失败结果:ok=false 且带 INVALID_ARGUMENTS 与人类可读 message。 */
function assertInvalid(a, result, label) {
  a.equal(result?.ok, false, `${label}: 必须 ok=false`);
  a.equal(result?.error?.code, INVALID, `${label}: code 必须是 ${INVALID}`);
  a.equal(typeof result?.error?.message, 'string', `${label}: 要有 message`);
  a.ok(result.error.message.trim() !== '', `${label}: message 不能是空串`);
}

export function registerSearchToolTests({ test: testFn, assert: a }) {
  for (const [name, fn] of cases) testFn(name, fn);
}

// ——— 一、jm_search 参数归一:正例 ———

test('normalizeJmSearchArgs 关键词:trim/NFKC、count 缺省与显式、countGiven 正确、只给清单', () => {
  assert.deepEqual(normalizeJmSearchArgs({ query: ' 全彩 ' }), {
    ok: true, action: 'search', keyword: '全彩', count: DEFAULT_JM_MAX, countGiven: false, page: 1, sort: null, listOnly: true,
  });
  assert.deepEqual(normalizeJmSearchArgs({ query: '　全彩　' }), {
    ok: true, action: 'search', keyword: '全彩', count: DEFAULT_JM_MAX, countGiven: false, page: 1, sort: null, listOnly: true,
  }, 'NFKC + trim 后应只剩关键词');
  assert.deepEqual(normalizeJmSearchArgs({ query: '全彩', count: 3 }), {
    ok: true, action: 'search', keyword: '全彩', count: 3, countGiven: true, page: 1, sort: null, listOnly: true,
  });
  // 2026-11-25：关键词检索也认 page/sort（主人拍板排序两种都要）。
  assert.deepEqual(normalizeJmSearchArgs({ query: '全彩', page: 2, sort: 'popular' }), {
    ok: true, action: 'search', keyword: '全彩', count: DEFAULT_JM_MAX, countGiven: false, page: 2, sort: 'mv', listOnly: true,
  });
  assert.equal(normalizeJmSearchArgs({ query: '全彩', sort: 'latest' }).sort, 'mr');
  assert.equal(normalizeJmSearchArgs({ creator: '甲', sort: 'popular' }).sort, 'mv');
  // 边界:长度 60 刚好收、count 1/5 收。
  assert.equal(normalizeJmSearchArgs({ query: '本'.repeat(MAX_JM_KEYWORD_CHARS) }).ok, true);
  assert.equal(normalizeJmSearchArgs({ query: '本', count: 1 }).count, 1);
  assert.equal(normalizeJmSearchArgs({ query: '本', count: DEFAULT_JM_MAX }).count, DEFAULT_JM_MAX);
  // 纯函数:不改输入(冻结参数也不炸)。
  const frozen = Object.freeze({ query: '全彩', count: 2 });
  assert.equal(normalizeJmSearchArgs(frozen).count, 2);
});

test('normalizeJmSearchArgs 结构化:单值数组/多值 AND/page、keyword 置空', () => {
  assert.deepEqual(normalizeJmSearchArgs({ creator: '甲' }), {
    ok: true, action: 'search', mode: 'structured',
    conditions: { creator: ['甲'] }, page: 1, sort: null, keyword: null, countGiven: false, listOnly: true,
  });
  assert.deepEqual(normalizeJmSearchArgs({ creator: ['甲', '乙'], tag: ['丁'], page: 3 }), {
    ok: true, action: 'search', mode: 'structured',
    conditions: { creator: ['甲', '乙'], tag: ['丁'] }, page: 3, sort: null, keyword: null, countGiven: false, listOnly: true,
  }, '多值按 AND 原样传给服务(数组),页码原样');
  for (const [field, value] of [
    ['original', '原作甲'], ['character', '角色乙'], ['title', '标题丙'], ['tag', '标签丁'],
  ]) {
    const parsed = normalizeJmSearchArgs({ [field]: value });
    assert.equal(parsed.ok, true, `${field} 单值应合法`);
    assert.deepEqual(parsed.conditions, { [field]: [value] });
  }
  // 页码边界。
  assert.equal(normalizeJmSearchArgs({ creator: '甲', page: 1 }).page, 1);
  assert.equal(normalizeJmSearchArgs({ creator: '甲', page: 9999 }).page, 9999);
  // 结构化值也走 NFKC/trim。
  assert.deepEqual(normalizeJmSearchArgs({ creator: '　甲　' }).conditions, { creator: ['甲'] });
});

// ——— 二、jm_search 参数归一:反例 ———

test('normalizeJmSearchArgs 反例:空/非法/混用/越界全部 INVALID_ARGUMENTS', () => {
  const cases = [
    [null, 'null'],
    ['x', '字符串'],
    [[], '数组'],
    [{}, '没有任何条件'],
    [{ query: '' }, '空关键词'],
    [{ query: '   ' }, '纯空白关键词'],
    [{ query: '本'.repeat(MAX_JM_KEYWORD_CHARS + 1) }, '关键词超长'],
    [{ query: '甲\n乙' }, '关键词带换行'],
    [{ query: '甲\u0000乙' }, '关键词带控制字符'],
    [{ query: '甲\u2028乙' }, '关键词带行分隔符'],
    [{ query: 123 }, '关键词不是字符串'],
    [{ page: 2 }, '只有页码没有条件'],
    [{ query: '甲', creator: '乙' }, '关键词与结构化混用'],
    [{ creator: '' }, '空作者'],
    [{ creator: [] }, '空数组'],
    [{ creator: 123 }, '作者不是字符串'],
    [{ creator: Array.from({ length: 6 }, (_, i) => `作者${i}`) }, '条件值超过 5 个'],
    [{ original: '原作', character: '角色' }, '原作+角色同时出现'],
    [{ original: ['甲', '乙'] }, '原作多值'],
    [{ character: ['甲', '乙'] }, '角色多值'],
    [{ creator: '甲', count: 2 }, '结构化检索给 count'],
    [{ query: '甲', count: 0 }, 'count=0'],
    [{ query: '甲', count: -1 }, 'count 负数'],
    [{ query: '甲', count: DEFAULT_JM_MAX + 1 }, 'count 超上限'],
    [{ query: '甲', count: 2.5 }, 'count 小数'],
    [{ query: '甲', count: '2' }, 'count 字符串'],
    [{ query: '甲', page: 0 }, '关键词 page=0'],
    [{ query: '甲', page: 10000 }, '关键词 page 超上限'],
    [{ query: '甲', sort: 'hot' }, '未知排序值'],
    [{ query: '甲', sort: 123 }, 'sort 不是字符串'],
    [{ creator: '甲', sort: 'tr' }, '上游未开放排序值'],
    [{ creator: '甲', page: 0 }, 'page=0'],
    [{ creator: '甲', page: 10000 }, 'page 超上限'],
    [{ creator: '甲', page: 1.5 }, 'page 小数'],
  ];
  for (const [args, label] of cases) {
    assertInvalid(assert, normalizeJmSearchArgs(args), label);
  }
});

// ——— 三、meitu_send 参数归一:正例 ———

test('normalizeMeituArgs 正例:默认 1 张随机角色/美图档,产出服务可吃的 parsed', () => {
  assert.deepEqual(normalizeMeituArgs({}), {
    ok: true,
    count: DEFAULT_MEITU_COUNT,
    character: '',
    tags: [],
    ratingWanted: true,
    tier: 'meitu',
    random: true,
    ignored: [],
  }, '空参数 = 1 张随机角色美图');
  assert.deepEqual(normalizeMeituArgs({ count: 3, character: ' 示例甲 ', tags: ['thighhighs', 'twintails'], tier: 'seitu' }), {
    ok: true,
    count: 3,
    character: '示例甲',
    tags: ['thighhighs', 'twintails'],
    ratingWanted: true,
    tier: 'seitu',
    random: false,
    ignored: [],
  });
  // tag 去重、count 边界、tier 只有两档。
  assert.deepEqual(normalizeMeituArgs({ tags: ['swimsuit', 'swimsuit'] }).tags, ['swimsuit']);
  assert.equal(normalizeMeituArgs({ count: 1 }).count, 1);
  assert.equal(normalizeMeituArgs({ count: 3 }).count, 3);
  // 2026-11-24 审查 P1-4：工具侧最多 3 张（给最终回复留一个被动槽）；4/5 在下面反例里钉。
  assert.equal(normalizeMeituArgs({ tier: 'meitu' }).tier, 'meitu');
  assert.equal(normalizeMeituArgs({ character: '示例甲' }).random, false);
});

// ——— 四、meitu_send 参数归一:反例 ———

test('normalizeMeituArgs 反例:数量越界/未知 tag/非白名单 tier/控制字符全部 INVALID_ARGUMENTS', () => {
  const cases = [
    [null, 'null'],
    [[], '数组'],
    [{ count: 0 }, 'count=0'],
    [{ count: DEFAULT_MEITU_MAX + 1 }, 'count 超上限'],
    [{ count: 2.5 }, 'count 小数'],
    [{ count: '3' }, 'count 字符串'],
    [{ character: 1 }, '角色不是字符串'],
    [{ character: '甲\n乙' }, '角色带换行'],
    [{ character: '甲\u0000乙' }, '角色带控制字符'],
    [{ tags: 'thighhighs' }, 'tags 不是数组'],
    [{ tags: ['thighhighs', 'twintails', 'swimsuit'] }, 'tags 超过 2 个'],
    [{ tags: ['不存在的tag'] }, '未知 tag'],
    [{ tags: ['thighhighs', 1] }, 'tag 不是字符串'],
    [{ tags: ['ThighHighs'] }, 'tag 大小写不匹配(只认表里的值)'],
    [{ tier: 'general' }, '非法档位'],
    [{ tier: '' }, '空档位'],
  ];
  for (const [args, label] of cases) {
    assertInvalid(assert, normalizeMeituArgs(args), label);
  }
});

// ——— 五、能力定义:形状/描述/冻结/构造期 fail loud ———

test('buildSearchTools:两个 mutating 能力、id 钉字面值、costCny 0、描述讲清"真的会做"、冻结', () => {
  const { handlers } = fakeHandlers();
  const tools = buildSearchTools({ defineCapability, handlers });
  assert.equal(Object.isFrozen(tools), true, '能力数组必须冻结');
  assert.deepEqual(tools.map((tool) => tool.id), [SEARCH_TOOL_IDS.jmSearch, SEARCH_TOOL_IDS.meituSend]);
  assert.equal(SEARCH_TOOL_IDS.jmSearch, 'jm_search', 'id 是协议字面值,不许悄悄改');
  assert.equal(SEARCH_TOOL_IDS.meituSend, 'meitu_send', 'id 是协议字面值,不许悄悄改');
  for (const tool of tools) {
    assert.equal(Object.isFrozen(tool), true, `${tool.id} 定义必须冻结`);
    assert.equal(tool.effect, 'mutating', `${tool.id} 会发群消息/文件,effect 必须是 mutating`);
    assert.equal(tool.costCny, 0, `${tool.id} 本机组件零成本`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.id} schema 必须是 object`);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10, `${tool.id} 描述要够模型判断`);
  }
  // 描述必须让模型知道"不是 PPT 搜索,会真的做事"。
  assert.match(tools[0].description, /真的/, 'jm_search 描述要写清会真的搜');
  assert.match(tools[0].description, /一次只搜一件事/);
  assert.match(tools[1].description, /真的/, 'meitu_send 描述要写清会真的发图');
  assert.match(tools[1].description, /美图/);
  // jm_search schema 覆盖要求里的字段。
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(),
    ['character', 'count', 'creator', 'original', 'page', 'query', 'sort', 'tag', 'title'].sort());
  assert.deepEqual(Object.keys(tools[1].inputSchema.properties).sort(),
    ['character', 'count', 'tags', 'tier'].sort());
  // 构造期 fail loud(拼错装配不许静默上线)。
  assert.throws(() => buildSearchTools({}), TypeError);
  assert.throws(() => buildSearchTools({ defineCapability }), TypeError);
  assert.throws(() => buildSearchTools({ defineCapability, handlers: { jmSearch: async () => ({}) } }), TypeError);
  assert.throws(() => buildSearchTools({ defineCapability, handlers: { jmSearch: 'x', meituSend: 'y' } }), TypeError);
});

// ——— 六、execute:归一 → 调 handler(parsed,ctx) → 原样返回 ———

test('execute:合法参数透传 parsed 与 ctx,结果原样;非法参数回 INVALID_ARGUMENTS 且不调 handler', async () => {
  const { handlers, calls } = fakeHandlers();
  const tools = buildSearchTools({ defineCapability, handlers });
  const [jmTool, meituTool] = tools;
  const ctx = { turnContext: CHAT_CTX, signal: null };

  const jmResult = await jmTool.execute({ query: '全彩', count: 2 }, ctx);
  assert.deepEqual(jmResult, { ok: true, data: { action: 'search' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'jm');
  assert.deepEqual(calls[0].parsed, { ok: true, action: 'search', keyword: '全彩', count: 2, countGiven: true, page: 1, sort: null, listOnly: true });
  assert.equal(calls[0].ctx, ctx, 'ctx 必须原样透传(同一个对象)');

  const meituResult = await meituTool.execute({ count: 2, character: '示例甲', tags: ['swimsuit'] }, ctx);
  assert.deepEqual(meituResult, { ok: true, data: { count: 2, tier: 'meitu' } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].kind, 'meitu');
  assert.deepEqual(calls[1].parsed.tags, ['swimsuit']);
  assert.equal(calls[1].parsed.random, false);

  // 非法参数:不调 handler。
  const before = calls.length;
  for (const [tool, args, label] of [
    [jmTool, { query: '甲\n乙' }, '关键词注入'],
    [jmTool, {}, '无检索条件'],
    [meituTool, { tags: ['bogus_tag'] }, '未知 tag'],
    [meituTool, { count: 9 }, '数量越界'],
  ]) {
    const outcome = await tool.execute(args, ctx);
    assertInvalid(assert, outcome, label);
  }
  assert.equal(calls.length, before, '归一失败不许调 handler(别把坏参数送去服务层)');
});

// ——— 七、执行端授权:mutating 默认拒 / allowMutatingIds 显式放行 / 只读不变 ———

test('执行端授权:mutating 未放行 EFFECT_DENIED,显式放行才执行;只读与未知 id 语义不变', async () => {
  const { handlers, calls } = fakeHandlers();
  const tools = buildSearchTools({ defineCapability, handlers });
  const [jmCap, meituCap] = tools;
  const bothIds = new Set([SEARCH_TOOL_IDS.jmSearch, SEARCH_TOOL_IDS.meituSend]);

  // 只有 allowToolIds(旧装配):mutating 全部拒 —— 默认拒绝语义不变。
  const oldGrant = { allowToolIds: bothIds };
  for (const capability of [jmCap, meituCap]) {
    const denied = await executeAuthorized({ capability, args: {}, turnContext: CHAT_CTX, grant: oldGrant });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'EFFECT_DENIED', `${capability.id} 未显式放行时必须拒`);
  }
  assert.equal(calls.length, 0, '被拒的调用不许执行');

  // 只放行 jm_search:jm 执行、meitu 仍拒。
  const jmOnly = { allowToolIds: bothIds, allowMutatingIds: new Set([SEARCH_TOOL_IDS.jmSearch]) };
  const jmAllowed = await executeAuthorized({ capability: jmCap, args: { query: '全彩' }, turnContext: CHAT_CTX, grant: jmOnly });
  assert.equal(jmAllowed.ok, true);
  assert.equal(jmAllowed.data.action, 'search');
  const meituDenied = await executeAuthorized({ capability: meituCap, args: {}, turnContext: CHAT_CTX, grant: jmOnly });
  assert.equal(meituDenied.error.code, 'EFFECT_DENIED');
  assert.equal(calls.length, 1);

  // 两个都放行:都能执行。
  const fullGrant = { allowToolIds: bothIds, allowMutatingIds: bothIds };
  const meituAllowed = await executeAuthorized({ capability: meituCap, args: { count: 2 }, turnContext: CHAT_CTX, grant: fullGrant });
  assert.equal(meituAllowed.ok, true);
  assert.equal(calls.length, 2);

  // 只读能力不受影响:只给 allowToolIds 就放行(旧行为)。
  const readOnly = defineCapability({
    id: 'fixture_read', description: '测试只读',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    effect: 'read-only',
    execute: async (args) => ({ ok: true, data: args }),
  });
  const readOk = await executeAuthorized({ capability: readOnly, args: { q: 'x' }, turnContext: CHAT_CTX,
    grant: { allowToolIds: new Set(['fixture_read']) } });
  assert.equal(readOk.ok, true, 'read-only 行为必须一字不变');

  // allowMutatingIds 里有这个 id 但 allowToolIds 没有 ⇒ 仍是 DENIED(两道授权缺一不可)。
  const mutatingButNotListed = authorizeExecution({ capability: jmCap, args: { query: 'x' }, turnContext: CHAT_CTX,
    grant: { allowToolIds: new Set(), allowMutatingIds: bothIds } });
  assert.equal(mutatingButNotListed.error.code, 'DENIED');

  // 未知/非法 id:null 能力 → UNSUPPORTED;非法 id 在 defineCapability 就被拒。
  assert.equal(authorizeExecution({ capability: null, args: {}, turnContext: CHAT_CTX, grant: fullGrant }).error.code, 'UNSUPPORTED');
  assert.throws(() => defineCapability({
    id: 'JM Search', description: 'x', inputSchema: { type: 'object' },
    effect: 'read-only', execute: async () => ({ ok: true }),
  }));
});

// ——— 七点五、审查修复:只给清单 / 工具数量与角色名上限 ———

test('审查 P1-2:jm_search 产出 listOnly（服务层不得唯一命中自动下载）;纯数字编号明确拒', () => {
  // 关键词/结构化两条路都带 listOnly；服务层 autoSingle 条件里认它（见 jm-service 源码判据）。
  assert.equal(normalizeJmSearchArgs({ query: '全彩' }).listOnly, true);
  assert.equal(normalizeJmSearchArgs({ creator: '甲' }).listOnly, true);
  for (const query of ['1195659', ' 123 ', '０１２']) {
    const parsed = normalizeJmSearchArgs({ query });
    assert.equal(parsed.ok, false, `${query} 纯数字不该走搜索工具`);
    assert.equal(parsed.error.code, INVALID);
    assert.match(parsed.error.message, /下本/, '要明确让用户发「下本」');
  }
  // 描述不能再承诺"会下载"；要写清只给清单。
  const tools = buildSearchTools({ defineCapability, handlers: fakeHandlers().handlers });
  const jm = tools.find((tool) => tool.id === SEARCH_TOOL_IDS.jmSearch);
  assert.doesNotMatch(jm.description, /(?:会|将)自动下载/);
  assert.match(jm.description, /不自动下载文件/);
  assert.match(jm.description, /只给清单/);
});

test('审查 P2-12:meitu_send 的 count ≤3（给最终回复留被动槽），character ≤40 字', () => {
  assert.equal(normalizeMeituArgs({ count: 3 }).ok, true);
  for (const count of [4, 5, DEFAULT_MEITU_MAX]) {
    const parsed = normalizeMeituArgs({ count });
    assert.equal(parsed.ok, false, `count=${count} 应拒（工具不要把被动槽全吃掉）`);
    assert.match(parsed.error.message, /1\.\.3/);
  }
  assert.equal(normalizeMeituArgs({ character: '角'.repeat(40) }).ok, true);
  const tooLong = normalizeMeituArgs({ character: '角'.repeat(41) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error.message, /40/);
  const tools = buildSearchTools({ defineCapability, handlers: fakeHandlers().handlers });
  const meitu = tools.find((tool) => tool.id === SEARCH_TOOL_IDS.meituSend);
  assert.match(meitu.inputSchema.properties.count.description, /1\.\.3/);
});

// ——— 八、禁网哨兵:这一层不自己发请求 ———

test('不调真网络:归一/构造/执行(假 handler)全程不碰 fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => { fetched += 1; throw new Error('工具层不许自己发网络请求'); };
  try {
    const { handlers } = fakeHandlers();
    const tools = buildSearchTools({ defineCapability, handlers });
    const ctx = { turnContext: CHAT_CTX, signal: null };
    await tools[0].execute({ query: '全彩' }, ctx);
    await tools[0].execute({ creator: '甲', page: 2 }, ctx);
    await tools[1].execute({ count: 2, character: '示例甲', tags: ['swimsuit'] }, ctx);
    assert.equal(fetched, 0, '归一与调用 handler 都不该发网络请求(网络在服务层/抓取器里)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
