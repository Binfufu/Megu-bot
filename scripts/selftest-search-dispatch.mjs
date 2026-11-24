/**
 * **搜本/搜图命令唯一入口**的接线判据（2026-11-24 / 1.213.0）。
 *
 * 跑法：
 *
 *     node scripts\selftest-search-dispatch.mjs
 *
 * 为什么要有它：`tryHandleSearchCommand` 是 `main()` 里的闭包、单测拿不到；而它决定了
 * 「@ / 非 @、书 / 图 / 歧义、组件开关 / 群名单、追问 / 格式提示」这些**本轮新增的分派**。
 * 这里照 `selftest-chat-turn-decision.mjs` 的老办法：从 `src/index.js` **切出真实函数源码**，
 * 放进 vm 沙箱、注入桩依赖，然后对真实分支跑断言 —— 不是另抄一份分派逻辑。
 *
 * 钉：
 *   ① @ 搜本/发图 → 调真实服务入口（handleJmCommand / handleMeituCommand）；
 *   ② @ 歧义/缺关键词/格式错 → 只回固定话术，不执行；
 *   ③ 非 @ 只执行 search/download/send 确定性动作，不回追问/格式提示；
 *   ④ 非 @ 组件关 / 群不在名单 / 在这叫别人 → 不执行；
 *   ⑤ 目录收藏仍只认真 @；
 *   ⑥ 工具发送口 `makeToolRuntime`：被动槽位从账本接续、并回报给账本。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { allowsNonMentionTrigger, routeSearchCommand } from '../src/command-router.js';
import { looksLikeCatalogAttempt, parseCatalogCommand } from '../src/catalog-command.js';
import { buildJmParseFailureReply } from '../src/jm-service.js';
import { allowGroup as jmAllowGroup } from '../src/jm-service.js';
import { allowGroup as meituAllowGroup } from '../src/meitu-service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');

/** 从源码里切一段（端点是下一段的开头，防止把隔壁函数带进来）。 */
function sliceBetween(source, startMarker, endMarker) {
  const begin = source.indexOf(startMarker);
  assert.ok(begin >= 0, `生产源码缺少起点：${startMarker}`);
  const end = source.indexOf(endMarker, begin + startMarker.length);
  assert.ok(end > begin, `生产源码缺少终点：${startMarker} → ${endMarker}`);
  return source.slice(begin, end);
}

/** 固定话术从生产源码取原文，避免测试另抄一份（改文案时测试跟着走）。 */
function constString(name) {
  const match = new RegExp(`const ${name} = '([^']*)';`).exec(INDEX);
  assert.ok(match, `index.js 缺少常量 ${name}`);
  return match[1];
}

const DISPATCH_CODE = sliceBetween(
  INDEX,
  '  async function tryHandleSearchCommand(',
  '\n  async function handleMessage(',
);
const TOOL_RUNTIME_CODE = sliceBetween(
  INDEX,
  '  function makeOutboundBudget(',
  '\n  /** 该群此刻能不能用搜本/发图工具',
);
/**
 * 装配层真正的两个工具 handler（`runJmSearchTool` / `runMeituTool`）。
 * 2026-11-24 审查 P0 就是这里：`runMeituTool` 的 sendMedia 读了不存在的 `outbound`，
 * 真实发图必 ReferenceError、被服务层当"单张失败"吞掉。下面用真源码 + 假服务层跑一遍。
 */
const TOOL_HANDLERS_CODE = sliceBetween(
  INDEX,
  '  async function runJmSearchTool(',
  '\n  if (config.policy.tools?.enabled',
);
const MAX_PASSIVE_SEQ = Number((/const MAX_PASSIVE_SEQ = (\d+);/u.exec(INDEX) ?? [])[1]);

const SEARCH_CLARIFY_LINE = constString('SEARCH_CLARIFY_LINE');
const SEARCH_KEYWORD_LINE = constString('SEARCH_KEYWORD_LINE');
const MEITU_FORMAT_LINE = constString('MEITU_FORMAT_LINE');

/** 造一条群消息（默认被 @、没大图/表情、没叫别人）。 */
function message(overrides = {}) {
  return {
    scene: 'group',
    targetId: 'G1',
    senderId: 'U1',
    senderName: '群友',
    content: '',
    images: [],
    isMention: true,
    isPoke: false,
    isFace: false,
    mentionsForeignBot: false,
    mentionsOthers: false,
    messageId: 'MID-1',
    ...overrides,
  };
}

/** 跑一段生产源码 + 依赖桩，返回它暴露的对象。 */
function load(code, { deps, expose }) {
  const sandbox = {
    ...deps,
    SEARCH_CLARIFY_LINE,
    SEARCH_KEYWORD_LINE,
    MEITU_FORMAT_LINE,
  };
  vm.createContext(sandbox);
  return vm.runInContext(`${code}\n${expose};`, sandbox, { timeout: 5000 });
}

/** 一个可变的配置/依赖场景。 */
function scenario({ jmEnabled = true, meituEnabled = true, anyMessage = true, jmGroups = ['G1'],
  meituGroups = ['G1'], ignoreNames = [] } = {}) {
  const calls = { jm: [], meitu: [], sent: [] };
  const config = {
    jm: { enabled: jmEnabled, groups: jmGroups, max: 5 },
    meitu: { enabled: meituEnabled, groups: meituGroups, max: 5 },
    policy: { group: { commandsAnyMessage: anyMessage, searchAnyIgnoreNames: ignoreNames } },
  };
  const deps = {
    config,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    sendChunked: async (msg, text) => { calls.sent.push({ msg, text }); return { sent: 1 }; },
    handleJmCommand: async ({ message: msg, parsed }) => { calls.jm.push({ message: msg, parsed }); return { ok: true }; },
    handleMeituCommand: async ({ message: msg, parsed }) => { calls.meitu.push({ message: msg, parsed }); return { ok: true }; },
    routeSearchCommand,
    allowsNonMentionTrigger,
    parseCatalogCommand,
    looksLikeCatalogAttempt,
    buildJmParseFailureReply,
    jmAllowGroup,
    meituAllowGroup,
    DEFAULT_CATALOG_LINES: {
      unsupported: '收藏-unsupported',
      pageFormat: '收藏-page',
      tagFormat: '收藏-tag',
      format: '收藏-format',
    },
    describeMeituTask: () => '搬图任务',
    actionLog: { record() {} },
    createMeituInterpreter: () => async () => ({ ok: false }),
    meituGallery: null,
    stateStore: { recordMediaLink() {} },
    gateway: { botName: 'aris' },
    llmSettings: { scoped: () => ({}) },
    sessionIdFor: () => 'k',
    api: { uploadFile: async () => 'file', sendMedia: async () => ({ id: 'out' }) },
  };
  return { calls, config, deps };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------------------------------------------------------------------------
// ① @：书/图各走真实服务入口
// ---------------------------------------------------------------------------

test('dispatch:@ 搜本 → 调 JM 服务(解析为 search)，不发固定话术', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  const handled = await dispatch(message({ content: '搜本 全彩' }));
  assert.equal(handled, true);
  assert.equal(calls.jm.length, 1);
  assert.equal(calls.jm[0].parsed.action, 'search');
  assert.equal(calls.jm[0].parsed.keyword, '全彩');
  assert.equal(calls.sent.length, 0);
});

test('dispatch:@ 来点本子 → 只回「想搜什么本子」，不执行', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  assert.equal(await dispatch(message({ content: '来点本子' })), true);
  assert.equal(calls.jm.length + calls.meitu.length, 0);
  assert.deepEqual(calls.sent.map((one) => one.text), [SEARCH_KEYWORD_LINE]);
});

test('dispatch:@ 书/图分不清 → 只回澄清，不猜边', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  assert.equal(await dispatch(message({ content: '来点本子图' })), true);
  assert.equal(calls.jm.length + calls.meitu.length, 0);
  assert.deepEqual(calls.sent.map((one) => one.text), [SEARCH_CLARIFY_LINE]);
});

test('dispatch:@ 来点乐子 → 澄清(不再被当发图随机出图)', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  await dispatch(message({ content: '来点乐子' }));
  assert.equal(calls.meitu.length, 0);
  assert.deepEqual(calls.sent.map((one) => one.text), [SEARCH_CLARIFY_LINE]);
});

test('dispatch:@ 来3张随便的 → 仍走发图(既有随机能力)', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  assert.equal(await dispatch(message({ content: '来3张随便的' })), true);
  assert.equal(calls.meitu.length, 1);
  assert.equal(calls.meitu[0].parsed.random, true);
  assert.equal(calls.meitu[0].parsed.count, 3);
});

test('dispatch:@ 搜本 作都:甲 → 回近失/格式提示，不执行', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  await dispatch(message({ content: '搜本 作都:甲' }));
  assert.equal(calls.jm.length, 0);
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /作者/);
});

// ---------------------------------------------------------------------------
// ② 非 @：只执行确定性动作；不追问、不格式提示
// ---------------------------------------------------------------------------

test('dispatch:非@ 搜本 全彩 → 执行 JM 搜索', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  const msg = message({ content: '搜本 全彩', isMention: false });
  assert.equal(await dispatch(msg, { allowNonMention: true }), true);
  assert.equal(calls.jm.length, 1);
});

test('dispatch:非@ 来几本全彩的 → 自然写法也执行', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  const msg = message({ content: '来几本全彩的', isMention: false });
  assert.equal(await dispatch(msg, { allowNonMention: true }), true);
  assert.equal(calls.jm.length, 1);
  assert.equal(calls.jm[0].parsed.keyword, '全彩');
});

test('dispatch:非@ 下本 1 → 允许执行(序号) ；非@ 收藏 → 不执行', async () => {
  const { calls, deps } = scenario();
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  assert.equal(await dispatch(message({ content: '下本 1', isMention: false }), { allowNonMention: true }), true);
  assert.equal(calls.jm.length, 1);
  assert.equal(calls.jm[0].parsed.action, 'download');
  calls.jm.length = 0;
  // 目录收藏仍只认真 @。
  assert.equal(await dispatch(message({ content: '收藏 1490076', isMention: false }), { allowNonMention: true }), false);
  assert.equal(calls.jm.length, 0);
});

test('dispatch:非@ 追问/格式提示一律不回(只静默跳过)', async () => {
  for (const content of ['来点本子', '来点本子图', '来点乐子', '搜本 作都:甲']) {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    const handled = await dispatch(message({ content, isMention: false }), { allowNonMention: true });
    assert.equal(handled, false, content);
    assert.equal(calls.sent.length, 0, `${content} 非 @ 不该回话`);
    assert.equal(calls.jm.length + calls.meitu.length, 0, content);
  }
});

test('dispatch:非@ 组件关 / 群不在名单 / 在叫别人 → 不执行', async () => {
  {
    const { calls, deps } = scenario({ jmEnabled: false });
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(message({ content: '搜本 全彩', isMention: false }), { allowNonMention: true }), false);
    assert.equal(calls.jm.length, 0);
  }
  {
    const { calls, deps } = scenario({ jmGroups: ['OTHER'] });
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(message({ content: '搜本 全彩', isMention: false }), { allowNonMention: true }), false);
    assert.equal(calls.jm.length, 0);
  }
  {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(
      message({ content: '搜本 全彩', isMention: false, mentionsOthers: true }),
      { allowNonMention: true },
    ), false);
    assert.equal(calls.jm.length, 0);
  }
});

test('dispatch:非@ 开关关 → 什么都不做(旧行为)', async () => {
  const { calls, deps } = scenario({ anyMessage: false });
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  assert.equal(await dispatch(message({ content: '搜本 全彩', isMention: false }), { allowNonMention: true }), false);
  assert.equal(calls.jm.length, 0);
});

test('dispatch:非@ 水群闲聊不得误执行(审查 P1-1 意图闸)', async () => {
  // 这些在宽路由里会命中 search/send，但都不是"叫她去搜"的显式请求。
  for (const content of ['找本工作', '看本小说睡觉了', '整本账', '来张纸', '来两张纸', '来几张纸', '来点乐子']) {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    const handled = await dispatch(message({ content, isMention: false }), { allowNonMention: true });
    assert.equal(handled, false, `${content} 非 @ 不该执行`);
    assert.equal(calls.jm.length + calls.meitu.length, 0, content);
    assert.equal(calls.sent.length, 0, `${content} 非 @ 不该回话`);
  }
});

test('dispatch:非@ 在叫另一只 bot 的名字 → 跳过(审查 P1-3)', async () => {
  const { calls, deps } = scenario({ ignoreNames: ['惠惠', 'megumin'] });
  const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
  // 「惠惠 来张图」在宽路由里是 image/send；带排除名时必须跳过（否则爱丽丝替惠惠发图）。
  assert.equal(await dispatch(message({ content: '惠惠 来张图', isMention: false }), { allowNonMention: true }), false);
  assert.equal(calls.meitu.length, 0);
  // 不带排除名的普通命令照常执行。
  assert.equal(await dispatch(message({ content: '搜本 全彩', isMention: false }), { allowNonMention: true }), true);
  assert.equal(calls.jm.length, 1);
});

// ---------------------------------------------------------------------------
// ③ 目录收藏仍只认真 @
// ---------------------------------------------------------------------------

test('dispatch:@ 收藏 → 走 JM 服务；@ 呼叫别的 bot → 整段不接', async () => {
  {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(message({ content: '收藏 1490076' })), true);
    assert.equal(calls.jm.length, 1);
  }
  {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(message({ content: '搜本 全彩', mentionsForeignBot: true })), false);
    assert.equal(calls.jm.length, 0);
  }
});

// ---------------------------------------------------------------------------
// ④ 工具发送口：被动槽位从账本接续并回报
// ---------------------------------------------------------------------------

test('tool-runtime:被动槽位从 outbound.seq 接续，并在发完后回报', async () => {
  const seen = [];
  const deps = {
    sendChunked: async (msg, text, opts) => {
      seen.push({ text, startSeq: opts.startSeq, active: opts.active });
      // 模拟真实 sendChunked：逐块回调 onPassiveSent(normalSeq)
      const used = 2;
      for (let i = 0; i < used; i += 1) opts.onPassiveSent(opts.startSeq + i + 1);
      return { sent: used };
    },
  };
  const sandbox = { ...deps };
  vm.createContext(sandbox);
  const factory = vm.runInContext(`${TOOL_RUNTIME_CODE}\n[makeOutboundBudget, makeToolRuntime];`, sandbox, { timeout: 5000 });
  const [makeOutboundBudget, makeToolRuntime] = factory;
  const outbound = makeOutboundBudget();
  const runtime = makeToolRuntime(message({ messageId: 'MID-1' }), outbound);
  const first = await runtime.reply('第一段');
  assert.deepEqual(first, { sent: 2 }, 'JM 服务要 `{sent}` 形状');
  assert.equal(outbound.seq, 2, '发完 2 块后账本到 2');
  const second = await runtime.reply('第二段');
  assert.deepEqual(second, { sent: 2 });
  assert.equal(seen[1].startSeq, 2, '第二段必须从账本接续，不能又从 0 开始');
  assert.equal(outbound.seq, 4);
  assert.equal(seen[0].active, false, '工具发送默认走被动（sendChunked 自己会在超 5 时转主动）');
});

/**
 * 装配层两个真实工具 handler 的脚手架：真 `makeToolRuntime` + 真 handler 源码，
 * 只把服务层/QQ API 换成桩（真跑时会发群消息，测试里只记录参数）。
 */
function toolHandlerScenario({ seq = 0, meituSends = 1, handlersCode = TOOL_HANDLERS_CODE } = {}) {
  const media = [];
  const replies = [];
  const jmCalls = [];
  const msg = message({ messageId: 'MID-1' });
  const outbound = { seq };
  const deps = {
    MAX_PASSIVE_SEQ,
    config: {
      engine: { requestOptions: {} },
      jm: { enabled: true, groups: ['G1'] },
      meitu: { enabled: true, groups: ['G1'] },
    },
    log: { info() {}, warn() {}, debug() {}, error() {} },
    sendChunked: async (msg, text, opts = {}) => {
      const passive = opts.active !== true && (opts.startSeq ?? 0) < MAX_PASSIVE_SEQ;
      replies.push({ text, startSeq: opts.startSeq, active: opts.active === true });
      if (passive) opts.onPassiveSent?.((opts.startSeq ?? 0) + 1);
      return { sent: 1 };
    },
    handleJmCommand: async ({ parsed, deps: inner }) => {
      jmCalls.push(parsed);
      await inner.reply('清单');
      return { ok: true, reason: null };
    },
    handleMeituCommand: async ({ message: msg, deps: inner }) => {
      await inner.reply('正在搬图');
      for (let i = 0; i < meituSends; i += 1) {
        await inner.sendMedia({ msgId: msg.messageId, scene: 'group', openid: msg.targetId, fileInfo: { index: i } });
      }
      return {
        ok: true,
        task: { status: 'done', sent: meituSends, resolved: meituSends, requested: meituSends, failed: 0, reason: null, taskId: 't1', originText: 'x' },
      };
    },
    api: {
      uploadFile: async () => ({ fileId: 'f' }),
      sendMedia: async (args) => { media.push(args); return { id: 'm' }; },
    },
    actionLog: { record() {} },
    describeMeituTask: () => '搬图任务',
    meituGallery: null,
    stateStore: { recordMediaLink() {} },
    gateway: { botName: 'aris' },
    llmSettings: { scoped: () => ({}) },
    sessionIdFor: () => 'k',
    createMeituInterpreter: () => async () => ({ ok: false }),
  };
  const sandbox = { ...deps };
  vm.createContext(sandbox);
  const [makeToolRuntime, runJmSearchTool, runMeituTool] = vm.runInContext(
    `${TOOL_RUNTIME_CODE}\n${handlersCode}\n[makeToolRuntime, runJmSearchTool, runMeituTool];`,
    sandbox,
    { timeout: 5000 },
  );
  return {
    media, replies, jmCalls, outbound, runJmSearchTool, runMeituTool,
    runtime: makeToolRuntime(msg, outbound),
    message: msg,
  };
}

test('tool-wiring(P0 回归):runMeituTool 真实发图用 runtime.outbound 接续 msg_seq', async () => {
  const kit = toolHandlerScenario({ seq: 2 });
  const result = await kit.runMeituTool({ count: 1, random: true, tier: 'meitu' }, { runtime: kit.runtime });
  assert.equal(result.ok, true, '工具结果要 ok');
  assert.equal(kit.media.length, 1, 'sendMedia 必须真的被调用（P0：原来 ReferenceError 被吞）');
  assert.equal(kit.replies[0].startSeq, 2, '文字回执从账本 seq 接续');
  assert.equal(kit.media[0].msgSeq, 4, '图片 msg_seq = 文字回执之后的下一个（2→3→4），不是又从 1 开始');
  assert.equal(kit.outbound.seq, 4, '账本要记到图片这一条');
  assert.deepEqual(kit.media[0].fileInfo, { index: 0 });
  assert.match(result.data.note, /发到群里/);
});

test('tool-wiring:被动槽已用满时 runMeituTool 转主动（不带 msg_seq）', async () => {
  const kit = toolHandlerScenario({ seq: MAX_PASSIVE_SEQ });
  const result = await kit.runMeituTool({ count: 1, random: true, tier: 'meitu' }, { runtime: kit.runtime });
  assert.equal(result.ok, true);
  assert.equal(kit.media.length, 1);
  assert.equal(kit.media[0].msgSeq, undefined, '没被动槽了就不许再带 msg_seq（与 sendChunked 同口径）');
  assert.equal(kit.media[0].scene, 'group');
  assert.equal(kit.media[0].openid, 'G1');
  assert.equal(kit.outbound.seq, MAX_PASSIVE_SEQ, '主动发送不占被动账本');
});

test('tool-wiring:runJmSearchTool 走真服务层桩，结果形状给模型、无 runtime 明确拒', async () => {
  const kit = toolHandlerScenario({ seq: 1 });
  const parsed = { ok: true, action: 'search', keyword: '全彩', count: 5, countGiven: false, listOnly: true };
  const result = await kit.runJmSearchTool(parsed, { runtime: kit.runtime });
  assert.equal(result.ok, true);
  assert.equal(kit.jmCalls.length, 1);
  assert.deepEqual(kit.jmCalls[0], parsed, 'parsed 必须原样进服务层（含 listOnly）');
  assert.equal(kit.replies.length, 1);
  assert.equal(kit.outbound.seq, 2, '清单占掉一个被动槽，最终回复从 2 接续');
  assert.equal(result.data.action, 'search');
  assert.match(result.data.note, /发到群里/);

  const unavailable = await kit.runJmSearchTool(parsed, {});
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, 'UNAVAILABLE');
  assert.equal(kit.replies.length, 1, '没有 runtime 时不许发送');
});

test('tool-wiring 反证:删掉 runtime.outbound 那一行，P0 回归必须当场红', async () => {
  // 不是自证：把修复那一行拿掉，测试必须真的失败（原来那版 bug 就是 ReferenceError 被吞）。
  const broken = TOOL_HANDLERS_CODE.replace('const outbound = runtime.outbound ?? { seq: 0 };', '');
  assert.notEqual(broken, TOOL_HANDLERS_CODE, '反证前提：必须能删掉修复行');
  const kit = toolHandlerScenario({ seq: 2, handlersCode: broken });
  await assert.rejects(
    () => kit.runMeituTool({ count: 1, random: true, tier: 'meitu' }, { runtime: kit.runtime }),
    /outbound is not defined/,
    '去掉修复后必须抛 ReferenceError（说明这条判据真的咬住 P0）',
  );
});

test('dispatch:c106 真实语料 —— @「加里奥本子」→ 搜本；非 @ 同句不自动执行', async () => {
  {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(message({ content: '加里奥本子', isMention: true })), true);
    assert.equal(calls.jm.length, 1);
    assert.equal(calls.jm[0].parsed.keyword, '加里奥');
  }
  {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(message({ content: '加里奥本子', isMention: false }), { allowNonMention: true }), false);
    assert.equal(calls.jm.length, 0, '非 @ 的裸「X本子」不自动执行');
  }
  {
    const { calls, deps } = scenario();
    const dispatch = load(DISPATCH_CODE, { deps, expose: 'tryHandleSearchCommand' });
    assert.equal(await dispatch(message({ content: '来个加里奥大吊图', isMention: false }), { allowNonMention: true }), true);
    assert.equal(calls.meitu.length, 1);
    assert.equal(calls.meitu[0].parsed.character, '加里奥');
  }
});

export function registerSearchDispatchTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerSearchDispatchTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
