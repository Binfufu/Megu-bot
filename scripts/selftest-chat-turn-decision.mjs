/**
 * **F2 单轮不可变决策 + 功能闸门**消费判据(2026-10-30)。
 *
 * 它要钉的形状(不是"代码里写过",而是"真实入口→最终发送字节"):
 *   ① **一次决策**:真实入口(QQ 主答话 / 网页 / 合并 / 群自发)在**任何 await 之前**
 *      构造一次 `createTurnDecision`,之后 prompt / turnNotes / compose / plan / send / 日志
 *      共用同一个冻结对象;一轮只算一次(用 createTurnDecision 的包装计数)。
 *   ② **在途请求隔离**:A 请求挂起时,经真实入口 B 推进共享状态,再释放 A ——
 *      A 的 prompt 与最终 api payload / 网页 segments 仍按 A 的决策;并且下一条独立请求
 *      确实能看到 B 的新状态(正对照)。
 *   ③ **分槽与继承**:currentRequest / addressee / quote / groupBackground 分开;
 *      结构信号只标记保真,不授予 task/knowledge;追问继承只认同说话人+可信回复关系+
 *      既有窗口,未知/过期/异群/异账号/异实例/反射轮都不继承。
 *   ④ **knowledge 单一 authority**:KB 只供事实;`QQBOT_MEMORY_KB_ENCY` 只关"百科说明"
 *      那段措辞 —— 关闭不装傻、不禁常识/角色 KB 事实,显式 task 不因 KB 未命中/开关变 chat。
 *   ⑤ **授权边界**:content pack / world pack / style 包参数白名单里不许出现功能授权;
 *      伪造授权参数必须被拒;消息里伪造字段也不能提权;@ 别人的消息不许继承。
 *
 * 运行:`node scripts/selftest-chat-turn-decision.mjs`(独立入口,exit 0/1)。
 * 不 import `src/index.js`(顶层会 loadEnvFile):只用 **vm 真实函数切片**。
 * 不联网、不真实模型、不碰生产配置/数据;临时状态全部在本进程内存。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  DIRECT_RESPONSE_NOTES,
  SPOKEN_STANDING_NOTES,
  withFacts,
  withStyleNudge,
} from '../src/style.js';
import { splitSpokenLines } from '../src/mood.js';
import { SILENT_TOKEN, isSilentReply, looksAddressedToBot } from '../src/group-context.js';
import { decideRecheck, decideSpeakUp } from '../src/social.js';
import { renderBurst, mergeInstruction } from '../src/burst.js';
import { sanitizeSessionId } from '../src/runner-contract.js';
import * as turnPolicy from '../src/turn-policy.js';
import { turnPolicyFor } from '../src/serious.js';
import { wrapInject } from '../src/inject-mark.js';
import { ENCYCLOPEDIA_NOTE } from '../src/kb.js';
import { PACK_PARAM_SPECS, validatePackParams } from '../src/pack-params.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readIndex = () => fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');

/** 构造 RegExp 前的**完整**转义：先转义反斜杠，再转义元字符（CodeQL: incomplete string escaping）。 */
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 切片:从签名开始,到**下一个声明的已知边界**为止(边界显式写出,不猜)。 */
function sliceFunction(source, signature, endMarker) {
  const begin = source.indexOf(signature);
  assert.ok(begin >= 0, 'production slice start missing: ' + signature);
  const end = source.indexOf(endMarker, begin + signature.length);
  assert.ok(end > begin, `production slice end missing: ${signature} → ${JSON.stringify(endMarker)}`);
  return source.slice(begin, end);
}

const SESSION_ID = (message) => sanitizeSessionId(`qqbot-${message.scene}-${message.targetId}`);
const CONVERSATION_KEY = (message) => SESSION_ID({ scene: message.scene, targetId: message.targetId });

/**
 * 一个 vm 运行时:把**真实入口与它们调用的真实函数**切片进去,外部依赖全部是本测试的桩。
 * 四个消费分叉(QQ 主答话 / 网页 / 合并 / 群自发)共用同一份上下文,因此它们消费的是
 * **同一份** turnDecisionState / 同一套发信咽喉。
 */
function createHarness({ source = readIndex(), kbEnabled = false, kbHit = false, kbEncy = true } = {}) {
  const decisions = []; // createTurnDecision 每次调用都记一笔(核对"一轮只算一次")
  const apiSent = []; // 最终 api payload(逐条 content)
  const runnerCalls = [];
  const logs = [];
  const recordTurns = [];
  const groupRenderCalls = [];
  let nextRunnerGate = null;
  let longTermHook = null;
  let replyText = 'DEFAULT-REPLY';
  const replyPlan = new Map(); // 指纹 → 这一轮模型输出(并发场景下不能共用一份可变 replyText)
  let nowMs = Date.now();

  const state = new Map();
  const lastOutboundMessageIds = new Map();
  // 旧"全群 lastMode"表:**生产路径一次都不许读/写**(F2 已改成按说话人继承)。
  // 用探针对象记录访问次数:生产路径必须 0 次;反证里撤掉决策传递后必须 >0。
  const lastTurnModeProbe = { reads: 0, writes: 0 };
  const probeLastTurnMode = {
    get: () => { lastTurnModeProbe.reads += 1; return undefined; },
    set: () => { lastTurnModeProbe.writes += 1; },
    has: () => false,
    delete: () => {},
  };
  const lastGroupMessage = new Map();
  const lastHumanAtAllRef = { value: 0 };

  const captureLog = {
    info: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
    debug: (...args) => logs.push(args.join(' ')),
  };

  const makeGate = () => {
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    let releaseResolve;
    const promise = new Promise((resolve) => { releaseResolve = resolve; });
    return {
      entered,
      wait: promise,
      markEntered: () => enteredResolve(),
      release: () => releaseResolve(),
    };
  };

  const moodNote = () => ({ mood: 'plain', label: '合成平静', maxChars: 38 });
  const replyFor = (prompt) => {
    const matched = [...replyPlan.entries()].find(([marker]) => prompt.includes(marker));
    return { text: matched ? matched[1] : replyText, timedOut: false };
  };

  const sandbox = {
    // ---- 纯模块(真实实现) ----
    createTurnDecision: (message, options) => {
      const decision = turnPolicy.createTurnDecision(message, options);
      decisions.push(decision);
      return decision;
    },
    detectTurnMode: turnPolicy.detectTurnMode,
    outputPolicyFor: turnPolicy.outputPolicyFor,
    noteGatesFor: turnPolicy.noteGatesFor,
    composeModeNote: turnPolicy.composeModeNote,
    groupLinesForDelivery: turnPolicy.groupLinesForDelivery,
    splitTurnSlots: turnPolicy.splitTurnSlots,
    turnPolicyFor,
    wrapInject,
    ENCYCLOPEDIA_NOTE,
    DIRECT_RESPONSE_NOTES,
    withStyleNudge,
    withFacts,
    withTurnFacts: withFacts,
    splitSpokenLines,
    maybeSpokenEmoji: () => null,
    recentSpokenEmoji: [],
    renderBurst,
    mergeInstruction,
    isSilentReply,
    looksAddressedToBot,
    decideSpeakUp,
    decideRecheck,
    sanitizeSessionId,
    SILENT_TOKEN,
    MAX_PASSIVE_SEQ: 5,

    // ---- 闭包状态(切片里的 const/let 由这里给) ----
    turnDecisionState: state,
    TURN_DECISION_MAX: 200,
    lastOutboundMessageIds,
    LAST_OUTBOUND_MAX: 200,
    lastTurnMode: probeLastTurnMode,
    rememberTurnMode: () => { throw new Error('生产路径不许再写旧 lastTurnMode'); },
    lastGroupMessage,
    groupTimers: new Map(),
    lastGroupActivity: new Map(),
    lastGroupHumanAt: new Map(),
    lastBotUtteranceAt: new Map(),
    lastSocialRecheckAt: new Map(),
    socialRecheckSkips: new Map(),
    retreatLoggedSince: new Map(),
    lastInteractionAt: new Map(),
    turnStatDeltas: [],
    lastHumanAtAll: 0,
    pendingCompany: null,
    pendingStory: null,

    // ---- 身份 / 配置 ----
    gateway: {
      botName: 'fixture-bot',
      foreignBotIds: new Set(),
      on: () => {},
    },
    config: {
      policy: {
        access: { mode: 'open' },
        c2cDebounceMs: 0,
        replyTimeoutMs: 5000,
        promptContext: true,
        maxChars: 1500,
        maxImages: 3,
        seriousGuard: true,
        replyJitterMs: 'off',
        stats: { enabled: false, money: false },
        growth: { enabled: false },
        explosion: { enabled: false },
        spoken: { enabled: true, maxChars: 60, emojiChance: 0, minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, perCharDelayMs: 0 },
        style: { nudgeCount: 1, kaomojiBreakWidth: 32, nameLabels: [] },
        group: {
          windowMs: 90_000,
          gapMs: 0,
          cooldownMs: 0,
          engagedCooldownMs: 0,
          minMessages: 0,
          debounceMs: 0,
          addressMarkers: ['你'],
          ignoreIds: new Set(),
          ignoreBots: true,
        },
        interaction: {
          pokeEnabled: true,
          faceEnabled: true,
          cooldownMs: 0,
          pokeChance: 1,
          faceChance: 1,
          windowMultiplier: 1,
        },
        selfcare: { enabled: false },
        memory: {},
      },
    },
    memoryCfg: {
      kb: { enabled: kbEnabled, ency: kbEncy, budgetChars: 600, maxChunks: 2 },
      insights: { enabled: false },
      embedding: { enabled: false, model: 'fixture', url: '', timeoutMs: 1 },
      longTerm: { enabled: false, budget: 300, limit: 2 },
    },
    // KB 开关/命中由构造参数给:turnNotes 消费的是真实 kbNote 切片(只供事实)。
    memoryDb: kbEnabled ? {} : null,
    kbProvider: kbEnabled
      ? () => ({
        text: kbHit ? 'KB-FACT-FP' : '',
        picked: kbHit ? [{ id: 'doc:1#1', why: ['fixture'] }] : [],
        reason: '',
      })
      : null,
    kbVectorMemo: { query: null, vector: null },
    log: captureLog,

    // ---- 入站/命令/群/经济等外部依赖(极少用到的用最小桩) ----
    sessionIdFor: SESSION_ID,
    conversationKeyFor: CONVERSATION_KEY,
    isAllowed: () => true,
    recordMetrics: () => {},
    touchSender: () => {},
    learnFactsFrom: () => {},
    settleInteraction: () => {},
    settlePotion: () => {},
    settleCompany: () => {},
    bumpAffinity: () => {},
    isReporter: () => false,
    readCondition: () => null,
    AQUA_PATTERNS: [],
    seekAquaCure: async () => false,
    storyKeyFor: () => 'fixture-story',
    noteGroupEngagement: () => {},
    rememberConversationImages: () => {},
    carriedConversationSources: () => [],
    fetchImageBlocks: async () => [],
    moodFor: () => moodNote(),
    rollEconomy: () => [],
    copypastaFor: () => null,
    turnFacts: () => ['FACT-FP:fixture-fact'],
    meituActionFact: () => null,
    resolveReferenceMedia: () => null,
    buildToolContext: () => null,
    recordTurn: (kind, info) => recordTurns.push({ kind, ...info }),
    recordTurnMetrics: () => {},
    recordStatDeltas: () => {},
    stateStore: {
      touchGroup: () => {},
      getPendingEvent: () => null,
      recordOutbound: () => {},
    },
    socialState: {
      modulationFor: () => ({ state: 'active', self: 1, interact: 1 }),
      snapshotOf: () => ({ since: 1 }),
      noteAddressed: () => {},
      noteGroupMessage: () => null,
      noteSpoke: () => {},
      noteIgnored: () => {},
      config: { answeredWindowMs: 1_000 },
    },
    groupContext: {
      isWindowOpen: () => true,
      shouldSelfReply: () => true,
      stats: () => ({ buffered: 3, pending: 3, lastReplyAt: null }),
      render: () => {
        groupRenderCalls.push(Date.now());
        return 'GROUP-BACKGROUND-FP';
      },
      noteReply: () => {},
      clear: () => {},
    },
    relayConfig: () => null,
    parseRelayCommand: () => null,
    handleRelayCommand: async () => {},
    isChatRecord: () => false,
    handleRelayRecord: async () => {},
    reportToOperator: async () => {},
    isExplosionFinisher: () => false,
    narrateExplosion: async () => {},
    matchesKeywords: () => null,
    scheduleGroupReply: () => {},
    maybeInteractionReply: async () => false,
    isMergeable: () => false,
    burstQueue: { push: () => {}, flush: () => {}, drop: () => 0 },
    semaphore: { acquire: async () => {}, release: () => {} },
    fishing: { handleMessage: async () => false },
    isOperator: () => false,
    handleAnnounceReply: async () => false,
    isAnnounceCommand: () => false,
    isBindAttempt: () => false,
    handleForget: async () => false,
    RESET_COMMANDS: new Set(),
    STATUS_COMMANDS: new Set(),
    GROWTH_COMMANDS: new Set(),
    QUEST_COMMANDS: new Set(),
    QUEST_TAKE_RE: /(?!)/,
    WALLET_COMMANDS: new Set(),
    SEND_IMAGE_COMMANDS: new Set(),
    HELP_COMMANDS: new Set(),
    RESTART_COMMANDS: new Set(),

    // ---- 出站咽喉:最终 api payload 由这里捕获 ----
    api: {
      sendDirect: (target, payload) => {
        apiSent.push({ scene: 'c2c', target, ...payload });
        return { id: `out-${apiSent.length}` };
      },
      sendGroup: (target, payload) => {
        apiSent.push({ scene: 'group', target, ...payload });
        return { id: `out-${apiSent.length}` };
      },
    },
    hasLeakedControlMarkup: () => false,
    stripLeakedControlMarkup: (text) => text,
    sanitizeOutgoingText: (text) => text,
    outgoingNameLabels: () => [],
    breakBeforeKaomoji: (text) => text,
    applyTypingJitter: async () => {},
    spokenLineGap: async () => {},
    describeError: (err) => String(err?.message ?? err),
    describeUserError: (err) => String(err?.message ?? err),
    // composeReply 的协议剥壳/收尾:本测试只关心"决策贯穿到最终字节",这些都返回原文。
    settleStory: (text) => text,
    settleIntake: (text) => text,
    applyAcceptedRelation: (text) => text,
    describeTurnEnd: () => '',
    statDeltaLine: () => '',

    // ---- 长期记忆:可被测试挂起(await 屏障反例) ----
    longTermNote: async (recall) => {
      if (longTermHook) return longTermHook(recall);
      return null;
    },
    renderInsights: () => '',
    latestInsights: () => null,
    filterInsightsForAccess: (rows) => rows,
    memoryAccessFor: () => ({ insights: true }),
    pendingStoryFor: () => null,
    buildStoryRespondPrompt: () => '',
    companyTurnNote: () => null,
    affinityNote: () => null,
    moodNotes: () => ['MOOD-LENGTH-STUB'],
    nextNudges: () => ['RANDOM-STYLE-STUB'],
    describeFishingScene: () => null,
    readFishing: () => null,
    panelPromptNote: () => null,
    describeLedgerForPrompt: () => null,
    claimNote: () => null,
    looksLikeEating: () => false,
    feedingNote: () => null,
    currentStats: () => ({ satiety: 50, health: 50, mood: 50, money: 0 }),
    readCondition: () => null,
    getBodyTheme: () => ({}),
    describeForPrompt: () => 'BODY-FP',
    currentGrowth: () => ({}),
    describeGrowthForPrompt: () => 'GROWTH-FP',
    getBodyThemeStub: () => ({}),

    // ---- runner:deferred 用这里的闸 ----
    runner: {
      isBusy: () => false,
      sessionIdFor: (key) => `dsh-${key}`,
      runTurn: async (key, prompt) => {
        runnerCalls.push({ key, prompt: String(prompt) });
        const result = replyFor(String(prompt));
        if (nextRunnerGate) {
          const gate = nextRunnerGate;
          nextRunnerGate = null;
          gate.markEntered();
          await gate.wait;
        }
        return result;
      },
    },

    // ---- 时间/数学(可推进,便于过期反例) ----
    Date: {
      now: () => nowMs,
      toISOString: () => new Date(nowMs).toISOString(),
    },
    Math,
  };

  const parts = [
    sliceFunction(source, 'export function withSceneTag(', "\n/** Commands handled by the bridge").replace(/^export\s+/, ''),
    sliceFunction(source, 'export function chunkText(', "\n/** Durable, restart-safe SDK session id").replace(/^export\s+/, ''),
    sliceFunction(source, '  function botIdentity(', '\n  /** 继承键'),
    sliceFunction(source, '  function turnSpeakerKey(', '\n  /**\n   * 上一轮可继承的口径'),
    sliceFunction(source, '  function previousTurnModeFor(', '\n  /**\n   * 这一轮**真的跑了模型**'),
    sliceFunction(source, '  function rememberTurnDecision(', '\n  /**\n   * 入口构造这一轮**唯一的一份**决策'),
    sliceFunction(source, '  function buildTurnDecision(', '\n  /**\n   * **反射轮/主动轮固定口径**'),
    sliceFunction(source, '  function reflexTurnDecision(', "\n  /** Draw this turn's style instructions"),
    sliceFunction(source, '  function kbNote(', '\n  /**\n   * 问本机那个 embedding 服务'),
    sliceFunction(source, '  async function turnNotes(', '\n  /**\n   * **这一轮说话的人在世界里的角色是谁**'),
    sliceFunction(source, '  function planSpokenLines(', '\n  /**\n   * **段间的自然间隔**'),
    sliceFunction(source, '  async function sendSpokenLines(', '\n  /**\n   * 「打字抖动」'),
    sliceFunction(source, '  async function sendChunked(', '\n  /**\n   * **释放咏唱技能**'),
    sliceFunction(source, '  function composeReply(', '\n  /**\n   * React to a small gesture'),
    sliceFunction(source, '  async function runWebChatTurn(', '\n  // ---------------------------------------------------------------------------\n  // **身份绑定**'),
    sliceFunction(source, '  async function handleMessage(', '\n  /**\n   * 把攒着的几条私聊消息**合成一轮**发出去'),
    sliceFunction(source, '  async function runBurstTurn(', '\n  /**\n   * **事件钩子的收尾**'),
    sliceFunction(source, '  async function maybeInteractionReply(', '\n  /**\n   * Debounce a possible self-initiated reply'),
    sliceFunction(source, '  async function maybeGroupReply(', "\n  gateway.on('message'"),
  ];
  const expose = [
    'withSceneTag', 'chunkText', 'previousTurnModeFor', 'rememberTurnDecision',
    'buildTurnDecision', 'reflexTurnDecision', 'turnNotes', 'planSpokenLines',
    'sendSpokenLines', 'sendChunked', 'composeReply', 'runWebChatTurn',
    'handleMessage', 'runBurstTurn', 'maybeInteractionReply', 'maybeGroupReply',
  ];
  const runtime = vm.runInNewContext(
    `${parts.join('\n\n')}\n\n({ ${expose.join(', ')} })`,
    sandbox,
  );

  return {
    ...runtime,
    decisions,
    apiSent,
    runnerCalls,
    logs,
    recordTurns,
    groupRenderCalls,
    state,
    lastTurnMode: probeLastTurnMode,
    lastTurnModeProbe,
    lastGroupMessage,
    lastOutboundMessageIds,
    moodNote,
    makeGate,
    setRunnerGate: (gate) => { nextRunnerGate = gate; },
    setLongTermHook: (hook) => { longTermHook = hook; },
    setReply: (text) => { replyText = text; },
    setReplyFor: (marker, text) => { replyPlan.set(marker, text); },
    advance: (ms) => { nowMs += ms; },
    now: () => nowMs,
  };
}

/** 等一个条件成立(有界,不 sleep 固定时长)。 */
async function waitFor(predicate, label) {
  for (let i = 0; i < 2000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function c2cMessage({ id, sender, target, content, replyTo = null }) {
  return {
    scene: 'c2c',
    targetId: target,
    senderId: sender,
    senderName: 'fixture-user',
    messageId: id,
    replyToMessageId: replyTo,
    content,
    images: [],
    isMention: true,
    isPoke: false,
    isFace: false,
    mentions: [],
  };
}

const USER = (id) => `USER-FP:${id}`;
const PERSONA = (id) => `PERSONA-FP:${id}`;
const FACT = 'FACT-FP:fixture-fact';

function promptOf(call) {
  return String(call?.prompt ?? '');
}

function sentText(harness) {
  return harness.apiSent.map((row) => String(row.content ?? '')).join('\n');
}

// ---------------------------------------------------------------------------
// 1) 决策对象本身:冻结、分槽、结构只标记保真、knowledge 单一 authority
// ---------------------------------------------------------------------------
function testDecisionContract() {
  const task = turnPolicy.createTurnDecision(
    { content: '帮我分析线程池死锁，给复现和修复步骤', senderId: 'u1', messageId: 'm1', mentions: [{ id: 'other', username: 'someone', bot: false }] },
    { conversation: 'c1', instance: 'bot' },
  );
  assert.equal(task.mode, 'task');
  assert.equal(task.reason, 'action-verb');
  assert.equal(task.knowledge.authorized, false);
  assert.equal(Object.isFrozen(task), true, '决策必须冻结');
  assert.equal(Object.isFrozen(task.slots), true);
  assert.equal(Object.isFrozen(task.outputPolicy), true);
  assert.equal(task.slots.addressee[0].id, 'other', '@ 对象进 addressee 槽');
  assert.equal(task.outputPolicy.preserveFormatting, true);
  assert.ok(typeof task.id === 'number' && task.id > 0, '决策要有序号(供日志/测试核对只算一次)');
  assert.throws(() => { task.mode = 'chat'; }, TypeError, '冻结对象不许改');

  // 结构只标记保真,不授予 task/knowledge。
  for (const content of ['```python\nprint(1)\n```', '{"a":1,"b":2}', '看 https://example.invalid/a']) {
    const decision = turnPolicy.createTurnDecision({ content, senderId: 'u1' }, { conversation: 'c1' });
    assert.equal(decision.mode, 'chat', `结构不许单独授权:${content}`);
    assert.equal(decision.structural, true, `结构要标记保真:${content}`);
    assert.equal(decision.outputPolicy.preserveFormatting, true, '结构要打开保真交付');
  }

  // 引用/转发材料单独进 quote 槽,当前请求与结构判定只看正文。
  const quoted = turnPolicy.splitTurnSlots({
    content: '【引用材料 https://example.invalid/page 】\n这张也太好笑了',
    mentions: [{ id: 'a', username: '甲', bot: false }],
  });
  assert.equal(quoted.currentRequest, '这张也太好笑了');
  assert.match(quoted.quote, /引用材料/);
  // 异类结束标记不能关闭材料块；没有同类结束标记时，后面的正文仍是当前请求。
  const mismatched = turnPolicy.splitTurnSlots({
    content: '【引用材料】\n原文一行\n【转发结束】\n帮我修复故障',
  });
  assert.equal(mismatched.currentRequest.includes('帮我修复故障'), true, '异类结束标记不得吞掉后面的真实正文');
  const quotedDecision = turnPolicy.createTurnDecision(
    { content: '【引用材料 ```js\nx=1\n``` 】\n这张也太好笑了', senderId: 'u1' },
    { conversation: 'c1', previous: 'task' },
  );
  assert.equal(quotedDecision.mode, 'chat', '引用材料里的结构/任务词不许授予权限');
  assert.equal(quotedDecision.followUp, false, '只有引用材料不构成追问');
  for (const content of [
    '【引用材料\n帮我修复故障\n```js\ncode\n```】\n笑死了',
    '【引用材料】\n帮我修复故障\n【引用结束】\n笑死了',
    // 嵌套的【补充说明】不得提前结束材料块。
    '【引用材料\n说明里有【补充说明】\n帮我修复故障\n】\n笑死了',
  ]) {
    const multiline = turnPolicy.createTurnDecision({ content });
    assert.equal(multiline.slots.currentRequest, '笑死了', '显式多行引用整块只进引用槽');
    assert.equal(multiline.mode, 'chat', '引用续行任务词不许授予任务口径');
    assert.equal(multiline.structural, false, '引用结构不冒充当前请求结构');
  }

  // knowledge 单一 authority:实例关掉"百科说明"不撤销 knowledge 授权(不装傻)。
  const knowledge = turnPolicy.createTurnDecision(
    { content: '解释一下癌症筛查原理', senderId: 'u1' },
    { conversation: 'c1', allowKnowledgeNote: false },
  );
  assert.equal(knowledge.mode, 'knowledge');
  assert.equal(knowledge.knowledge.authorized, true, 'knowledge 授权仍在(不因开关变 chat)');
  assert.equal(knowledge.noteGates.includeEncyclopediaNote, false, '只关说明措辞');
  assert.equal(knowledge.noteGates.includeModeNote, true);
  const knowledgeAllowed = turnPolicy.createTurnDecision(
    { content: '解释一下癌症筛查原理', senderId: 'u1' }, { conversation: 'c1' },
  );
  assert.equal(knowledgeAllowed.noteGates.includeEncyclopediaNote, true);

  // 反射轮固定口径:不继承任务。
  const reflex = turnPolicy.createTurnDecision(
    { content: '继续', senderId: 'u1' }, { conversation: 'c1', previous: 'task', reflex: true },
  );
  assert.equal(reflex.mode, 'chat', '反射轮不许继承用户任务');
  assert.equal(reflex.reflex, true);
  assert.equal(reflex.followUp, false);
}

// ---------------------------------------------------------------------------
// 2) knowledge:显式 task 在 KB 开关开/关、命中/未命中都保持 task
// ---------------------------------------------------------------------------
async function testKnowledgeNeverChangesTask() {
  // 显式 task:KB 总闸开/关 × 命中/未命中 × 百科说明开/关,decision 都必须是 task,
  // 消费端都必须拿到 task 口径;KB 只供事实(仅开+命中时多一个事实块),不改口径。
  for (const kbEnabled of [false, true]) {
    for (const kbHit of [false, true]) {
      for (const ency of [true, false]) {
        const harness = createHarness({ kbEnabled, kbHit, kbEncy: ency });
        const decision = harness.buildTurnDecision(
          { content: '帮我列出修复步骤', senderId: 'u9', messageId: 'm9' },
          'c-kb',
        );
        assert.equal(decision.mode, 'task', `KB enabled=${kbEnabled} hit=${kbHit} ency=${ency} 时 task 不许变 chat`);
        assert.equal(decision.knowledge.authorized, false);
        const notes = (await harness.turnNotes(
          harness.moodNote(),
          { content: '帮我列出修复步骤', conversation: 'c-kb' },
          [], null, { decision },
        )).join('\n');
        assert.match(notes, /本轮口径/, '显式 task 必须始终拿到 task 口径');
        assert.equal(notes.includes('【科普模式】'), false, 'task 轮不许被塞成"百科说明"');
        if (kbEnabled && kbHit) {
          assert.match(notes, /KB-FACT-FP/, 'KB 命中时事实照常到达');
          assert.match(notes, /\[\[bridge-inject kb\]\]/, '事实块仍过 wrapInject("kb")');
        } else {
          assert.doesNotMatch(notes, /KB-FACT-FP/, 'KB 关/未命中 = 事实一字不加');
        }
        assert.equal(harness.lastTurnModeProbe.reads + harness.lastTurnModeProbe.writes, 0,
          '这一路不许读写旧的全群 lastTurnMode');
      }
    }
  }
  // knowledge 模式 + KB 命中:百科说明只由 decision.noteGates 决定;关掉它不撤销 knowledge。
  for (const ency of [true, false]) {
    const harness = createHarness({ kbEnabled: true, kbHit: true, kbEncy: ency });
    const decision = harness.buildTurnDecision(
      { content: '解释一下癌症筛查原理', senderId: 'u9', messageId: 'm-k' }, 'c-kb',
    );
    assert.equal(decision.mode, 'knowledge');
    assert.equal(decision.knowledge.authorized, true, 'knowledge 授权不受实例开关影响');
    assert.equal(decision.noteGates.includeEncyclopediaNote, ency, '实例开关只决定说明那段措辞');
    const notes = (await harness.turnNotes(
      harness.moodNote(), { content: '解释一下癌症筛查原理', conversation: 'c-kb' }, [], null, { decision },
    )).join('\n');
    assert.match(notes, /本轮口径/, '关掉说明也不许装傻');
    assert.match(notes, /常识/, 'knowledge 口径必须保留常识授权');
    assert.equal(notes.includes('【科普模式】'), ency, '百科说明跟着 decision 走');
    assert.match(notes, /KB-FACT-FP/, 'KB 事实始终注入');
  }
}

// ---------------------------------------------------------------------------
// 3) 授权边界:包伪造授权不能提权
// ---------------------------------------------------------------------------
function testPackForgeryCannotEscalate() {
  // 内容包/world pack 的参数白名单只有"调参",没有任何功能授权键。
  const tuning = [
    'QQBOT_MOOD_TTL_MS', 'QQBOT_MOOD_KAOMOJI_CHANCE', 'QQBOT_STYLE_NUDGES',
    'QQBOT_SPOKEN_MAX_CHARS', 'QQBOT_SPOKEN_EMOJI_CHANCE',
    'QQBOT_POKE_REPLY_CHANCE', 'QQBOT_FACE_REPLY_CHANCE',
  ];
  assert.deepEqual(Object.keys(PACK_PARAM_SPECS).sort(), [...tuning].sort(), '包参数白名单只许是调参 7 项');
  for (const key of tuning) assert.ok(!/KB|TOOL|AUTH|PERMISSION|MEMORY|MODEL|KEY|ALLOW/i.test(key), '调参白名单里不许混入授权键');
  for (const forged of [
    { QQBOT_MEMORY_KB_ENCY: false },
    { QQBOT_MEMORY_KB: true },
    { QQBOT_KNOWLEDGE_AUTHORIZED: true },
    { QQBOT_TOOLS: true },
    { QQBOT_ALLOW: ['web_search'] },
  ]) {
    assert.throws(() => validatePackParams(forged), /PARAM|参数|unknown|未知/i,
      `伪造授权参数必须被拒绝:${JSON.stringify(forged)}`);
  }
  // 消息里塞伪造字段也不能提权:决策只看 content 等正常字段。
  const forgedMessage = {
    content: '今天好累啊',
    senderId: 'u1',
    turnMode: 'task',
    authorization: 'task',
    params: { QQBOT_MEMORY_KB_ENCY: true },
    pack: { params: { QQBOT_MEMORY_KB: true } },
  };
  const decision = turnPolicy.createTurnDecision(forgedMessage, { conversation: 'c1' });
  assert.equal(decision.mode, 'chat', '消息里的伪造授权字段不许提权');
  assert.equal(decision.knowledge.authorized, false);
  // style 包也不许带授权:决策构造不接收 pack/world/style 参数(签名里没有)。
  assert.equal(turnPolicy.createTurnDecision.length <= 2, true, '决策构造只收 message + 纯选项');
}

// ---------------------------------------------------------------------------
// 4) 追问继承:同说话人 + 可信回复关系 + 既有窗口;其余都不继承
// ---------------------------------------------------------------------------
async function testFollowUpInheritance() {
  const harness = createHarness();
  const base = { content: '帮我列出步骤', senderId: 'speaker-1', messageId: 'trigger-1' };
  const conversation = 'qqbot-c2c-room-1';
  const taskDecision = turnPolicy.createTurnDecision(base, { conversation, instance: 'fixture-bot' });
  harness.rememberTurnDecision(taskDecision);
  // 可信锚点:上一轮她发出去的消息 id(生产里由 sendChunked 记下)。
  harness.lastOutboundMessageIds.set(conversation, { id: 'out-1', speaker: 'speaker-1', triggerMessageId: 'trigger-1' });
  const followUp = (overrides = {}) => ({
    content: '继续', senderId: 'speaker-1', messageId: 'msg-a', replyToMessageId: 'out-1',
    scene: 'c2c', targetId: 'room-1', ...overrides,
  });
  // 正例:同说话人 + 引用她的上一条 + 窗内 → 继承 task。
  assert.equal(harness.previousTurnModeFor(followUp(), conversation), 'task');
  // 也认"引用上一轮触发消息"这一种可信关系。
  assert.equal(harness.previousTurnModeFor(followUp({ replyToMessageId: 'trigger-1' }), conversation), 'task');
  harness.lastOutboundMessageIds.set(conversation, { id: 'out-other', speaker: 'speaker-2', triggerMessageId: 'trigger-other' });
  assert.equal(harness.previousTurnModeFor(followUp({ replyToMessageId: 'out-other' }), conversation), 'chat',
    'A 回复刚发给 B 的消息，不得续上 A 的旧任务');
  harness.lastOutboundMessageIds.set(conversation, { id: 'out-old', speaker: 'speaker-1', triggerMessageId: 'trigger-old' });
  assert.equal(harness.previousTurnModeFor(followUp({ replyToMessageId: 'out-old' }), conversation), 'chat',
    '同说话人不同交换的迟到回复也不作为本轮锚点');
  harness.lastOutboundMessageIds.set(conversation, { id: 'out-1', speaker: 'speaker-1', triggerMessageId: 'trigger-1' });
  // 对照组:换人 / 无回复关系 / 过期 / 异群 / 异实例 / @ 别人 / 只引用材料 → 一律 chat。
  assert.equal(harness.previousTurnModeFor(followUp({ senderId: 'speaker-2' }), conversation), 'chat', '换人不继承');
  assert.equal(harness.previousTurnModeFor(followUp({ replyToMessageId: null }), conversation), 'chat', '无回复关系不继承');
  assert.equal(harness.previousTurnModeFor(followUp({ replyToMessageId: 'out-999' }), conversation), 'chat', '引用别的消息不继承');
  assert.equal(harness.previousTurnModeFor(followUp({ mentionsOthers: true }), conversation), 'chat', '@ 别人不越权');
  harness.advance(120_000);
  assert.equal(harness.previousTurnModeFor(followUp(), conversation), 'chat', '过窗不继承');
  harness.advance(-120_000);
  // 异群:同一条消息换会话 key。
  assert.equal(harness.previousTurnModeFor(followUp(), 'qqbot-c2c-other-room'), 'chat', '异群不继承');
  // 异实例:记录写上别的 bot 身份。
  harness.state.set(`${conversation}\u0000speaker-1`, {
    ...harness.state.get(`${conversation}\u0000speaker-1`), instance: 'another-bot',
  });
  assert.equal(harness.previousTurnModeFor(followUp(), conversation), 'chat', '异实例不继承');
  // 恢复记录,验证"只引用 URL/代码 / 只有群背景"不继承。
  harness.rememberTurnDecision(taskDecision);
  const quoteOnly = harness.buildTurnDecision(
    { content: '> ```js\n> x=1\n> ```\n> https://example.invalid', senderId: 'speaker-1', messageId: 'msg-q', replyToMessageId: 'out-1', scene: 'c2c', targetId: 'room-1' },
    conversation,
  );
  assert.equal(quoteOnly.mode, 'chat', '只引用材料不许继承/提权');
  const backgroundOnly = harness.buildTurnDecision(
    { content: '', senderId: 'speaker-1', messageId: 'msg-bg', replyToMessageId: 'out-1', scene: 'c2c', targetId: 'room-1' },
    conversation,
    { groupBackground: '群背景里有人在求助：帮我列出步骤' },
  );
  assert.equal(backgroundOnly.mode, 'chat', '只有群背景不许提权');
  // 群聊:窗口必须真的开着(复用 group-context 判据)。
  const groupConversation = 'qqbot-group-g1';
  const groupTask = turnPolicy.createTurnDecision(
    { content: '帮我列出步骤', senderId: 'speaker-1', messageId: 'g-trigger' },
    { conversation: groupConversation, instance: 'fixture-bot' },
  );
  harness.rememberTurnDecision(groupTask);
  harness.lastOutboundMessageIds.set(groupConversation, { id: 'g-out-1', speaker: 'speaker-1', triggerMessageId: 'g-trigger' });
  const groupFollow = {
    content: '继续', senderId: 'speaker-1', messageId: 'g-msg', replyToMessageId: 'g-out-1',
    scene: 'group', targetId: 'g1',
  };
  assert.equal(harness.previousTurnModeFor(groupFollow, groupConversation), 'task', '群内窗开时可继承');
  // 过窗同样覆盖群聊的"既有窗口"判据(时间过期)。
  harness.advance(120_002);
  assert.equal(harness.previousTurnModeFor(groupFollow, groupConversation), 'chat', '群聊过窗不继承');
}

// ---------------------------------------------------------------------------
// 5) QQ 主答话:真实入口 → 一次决策 → prompt/compose/plan/send 同份消费
// ---------------------------------------------------------------------------
async function testQqEntryConsumesOneDecision() {
  const harness = createHarness();
  harness.setReply(`${PERSONA('qq-task')}\n步骤一：检查配置。\n步骤二：修复。`);
  const before = harness.decisions.length;
  await harness.handleMessage(c2cMessage({
    id: 'msg-1', sender: 'speaker-1', target: 'room-qq', content: `${USER('qq-task')} 帮我列出修复步骤`,
  }));
  assert.equal(harness.decisions.length - before, 1, '一轮只许构造一次决策');
  const prompt = promptOf(harness.runnerCalls.at(-1));
  assert.match(prompt, /USER-FP:qq-task/, 'USER 控制指纹要到达模型');
  assert.match(prompt, new RegExp(escapeRegExp(FACT)), 'FACT 控制指纹要到达模型');
  assert.match(prompt, /本轮口径/, 'task 决策要有口径说明');
  const payload = sentText(harness);
  assert.match(payload, /PERSONA-FP:qq-task/,
    'PERSONA 控制指纹要到达最终发送字节; api=' + JSON.stringify(harness.apiSent) + ' logs=' + harness.logs.join(' | '));
  assert.match(payload, /步骤一：检查配置。\n步骤二：修复。/, 'task 决策要整行保真交付');
  assert.equal(harness.apiSent.length, 1, '保真交付不该被口语分条切碎');

  // 闲聊:一次决策、无口径、口语分条。
  const harness2 = createHarness();
  harness2.setReply(`${PERSONA('qq-chat')}。第一句。第二句。`);
  await harness2.handleMessage(c2cMessage({
    id: 'msg-2', sender: 'speaker-1', target: 'room-qq', content: `${USER('qq-chat')} 今天好累啊`,
  }));
  assert.equal(harness2.decisions.length, 1);
  const chatPrompt = promptOf(harness2.runnerCalls.at(-1));
  assert.doesNotMatch(chatPrompt, /本轮口径/, 'chat 决策不许被改口');
  assert.equal(harness2.apiSent.length > 1, true, 'chat 决策走口语分条');
  assert.match(sentText(harness2), /PERSONA-FP:qq-chat/);

  // 群 @:群背景在入口**快照**进决策,prompt 用快照,await 之后不再读 buffer。
  const harness3 = createHarness();
  harness3.setReply('好。');
  await harness3.handleMessage({
    scene: 'group', targetId: 'group-qq', senderId: 'speaker-g', senderName: '群友',
    messageId: 'msg-g', content: `${USER('qq-group')} 帮我列出步骤`, images: [],
    isMention: true, isPoke: false, isFace: false, mentions: [],
  });
  assert.equal(harness3.groupRenderCalls.length, 1, '群背景只在入口快照一次');
  assert.match(promptOf(harness3.runnerCalls.at(-1)), /GROUP-BACKGROUND-FP/, '群背景快照要进 prompt');
  // 全局 lastTurnMode 表一次都没被读写(继承按说话人分键)。
  for (const h of [harness, harness2, harness3]) {
    assert.equal(h.lastTurnModeProbe.reads + h.lastTurnModeProbe.writes, 0, '生产路径不许碰全群 lastMode');
  }
}

// ---------------------------------------------------------------------------
// 6) 在途隔离 A(挂 runner):task→chat,交付按 A 的决策;下一条请求看到新状态
// ---------------------------------------------------------------------------
async function testInFlightRunnerIsolationTaskToChat() {
  const harness = createHarness();
  harness.setReplyFor('USER-FP:p', `${PERSONA('p')}\n步骤：检查。\n步骤：修复。`);
  // P:显式 task,先完成,写入继承记录与"她刚说那条"的锚点。
  await harness.handleMessage(c2cMessage({
    id: 'msg-p', sender: 'speaker-1', target: 'room-race', content: `${USER('p')} 帮我列出修复步骤`,
  }));
  const conversation = CONVERSATION_KEY({ scene: 'c2c', targetId: 'room-race' });
  const pOutbound = harness.lastOutboundMessageIds.get(conversation)?.id;
  assert.ok(pOutbound, 'P 之后要有可信回复锚点; api=' + JSON.stringify(harness.apiSent) + ' map=' + JSON.stringify([...harness.lastOutboundMessageIds]));

  // A:追问(正文以"继续"开头,继承 task);在 runner 处挂起。
  const gate = harness.makeGate();
  harness.setRunnerGate(gate);
  harness.setReplyFor('USER-FP:a', `${PERSONA('a')}\n步骤一：检查。\n步骤二：修复。`);
  const decisionsBefore = harness.decisions.length;
  const aPromise = harness.handleMessage(c2cMessage({
    id: 'msg-a', sender: 'speaker-1', target: 'room-race', content: `继续 ${USER('a')}`,
    replyTo: pOutbound,
  }));
  await gate.entered;
  const aPrompt = promptOf(harness.runnerCalls.at(-1));
  assert.match(aPrompt, /本轮口径/,
    'A 的决策在挂起前已定死为继承的 task; decisions=' + JSON.stringify(harness.decisions.map((row) => [row.id, row.mode, row.previous]))
    + ' state=' + JSON.stringify([...harness.state]) + ' map=' + JSON.stringify([...harness.lastOutboundMessageIds]));

  // B:另一轮(chat)经**真实入口**跑完,推进共享状态。
  harness.setReplyFor('USER-FP:b', `${PERSONA('b')}。第一句。第二句。`);
  await harness.handleMessage(c2cMessage({
    id: 'msg-b', sender: 'speaker-1', target: 'room-race', content: `${USER('b')} 今天好累啊`,
  }));
  gate.release();
  await aPromise;
  assert.equal(harness.decisions.length - decisionsBefore, 2, 'A/B 各一次决策(不许重判)');
  // A 的最终发送字节必须仍按 A 的决策(task → 整行保真)。
  const aApiRows = harness.apiSent.filter((row) => String(row.content).includes('PERSONA-FP:a'));
  assert.equal(aApiRows.length, 1, 'A 的保真交付只该一条; rows=' + JSON.stringify(harness.apiSent));
  assert.match(String(aApiRows[0].content), /步骤一：检查。\n步骤二：修复。/, 'A 交付按 A 的 task 决策');

  // 正对照:C = 追问 B 触发的那条 → 继承 B 的 chat(新状态确实生效,不是 A 的 task)。
  const cDecision = harness.buildTurnDecision(
    c2cMessage({ id: 'msg-c', sender: 'speaker-1', target: 'room-race', content: '继续', replyTo: 'msg-b' }),
    conversation,
  );
  assert.equal(cDecision.mode, 'chat', '下一条独立请求必须看到 B 推进后的新状态');
  assert.equal(cDecision.previous, 'chat');
}

// ---------------------------------------------------------------------------
// 7) longTermNote await 屏障:chat→task,A 在 turnNotes 内挂起,仍按 A 的 chat
// ---------------------------------------------------------------------------
async function testLongTermBarrierIsolationChatToTask() {
  const harness = createHarness();
  harness.setReplyFor('USER-FP:p2', `${PERSONA('p2')}。好的。`);
  // P:闲聊,先完成。
  await harness.handleMessage(c2cMessage({
    id: 'msg-p2', sender: 'speaker-1', target: 'room-barrier', content: `${USER('p2')} 今天好累啊`,
  }));
  const conversation = CONVERSATION_KEY({ scene: 'c2c', targetId: 'room-barrier' });
  const pOutbound = harness.lastOutboundMessageIds.get(conversation)?.id;
  assert.ok(pOutbound);

  // A:追问(继承 P 的 chat),在 turnNotes 的 longTermNote 处挂起。
  const gate = harness.makeGate();
  harness.setLongTermHook(async (recall) => {
    if (String(recall?.query ?? '').includes('USER-FP:a2')) {
      gate.markEntered();
      await gate.wait;
    }
    return null;
  });
  harness.setReplyFor('USER-FP:a2', `${PERSONA('a2')}。第一句。第二句。`);
  const decisionsBefore = harness.decisions.length;
  const aPromise = harness.handleMessage(c2cMessage({
    id: 'msg-a2', sender: 'speaker-1', target: 'room-barrier', content: `继续 ${USER('a2')}`,
    replyTo: pOutbound,
  }));
  await gate.entered;

  // B:显式 task 经**真实入口**跑完,写共享状态(task)。
  harness.setReplyFor('USER-FP:b2', `${PERSONA('b2')}\n步骤一：检查。\n步骤二：修复。`);
  await harness.handleMessage(c2cMessage({
    id: 'msg-b2', sender: 'speaker-1', target: 'room-barrier', content: `${USER('b2')} 帮我列出修复步骤`,
  }));
  gate.release();
  await aPromise;
  // A 的 prompt(挂起后恢复再拼的其余注入)与最终字节都必须仍按 A 的 chat 决策。
  const aPrompt = promptOf(harness.runnerCalls.find((call) => call.prompt.includes('USER-FP:a2')));
  assert.doesNotMatch(aPrompt, /本轮口径/, 'A 的决策是 chat,外层状态变 task 也不许改口');
  assert.match(aPrompt, /MOOD-LENGTH-STUB/, 'A 的 chat 决策要注入情绪/风格那一栏');
  const aRows = harness.apiSent.filter((row) => row.msgId === 'msg-a2');
  assert.equal(aRows.length > 1, true,
    'A 的 chat 交付要按口语分条; rows=' + JSON.stringify(harness.apiSent)
    + ' decisions=' + JSON.stringify(harness.decisions.map((row) => [row.id, row.mode, row.previous])));
  assert.equal(harness.decisions.length - decisionsBefore, 2, 'A/B 各一次决策(await 前后不许重判)');

  // 正对照:C = 追问 B 触发的那条 → 继承 B 的 task(状态确实推进了)。
  const cDecision = harness.buildTurnDecision(
    c2cMessage({ id: 'msg-c2', sender: 'speaker-1', target: 'room-barrier', content: '继续', replyTo: 'msg-b2' }),
    conversation,
  );
  assert.equal(cDecision.mode, 'task', '下一条独立请求必须看到 B 的 task');
  assert.equal(cDecision.previous, 'task');
}

// ---------------------------------------------------------------------------
// 8) 网页入口:segments 与 prompt 同份决策
// ---------------------------------------------------------------------------
async function testWebEntryConsumesDecision() {
  const harness = createHarness();
  const code = '```js\nconst x = 1;\nconsole.log(x);\n```';
  harness.setReply(code);
  const task = await harness.runWebChatTurn({
    scene: 'web', targetId: 'player-1', senderId: 'web:1', messageId: 'web-1',
    content: `${USER('web-task')} 帮我把这段代码解释清楚并给出修复步骤`, images: [],
  });
  assert.equal(harness.decisions.length, 1, '网页一轮只构造一次决策');
  assert.equal(task.segments.length, 1, 'task 决策:网页 segments 整条保真(不按口语切)');
  assert.equal(task.segments[0], code);
  assert.match(promptOf(harness.runnerCalls.at(-1)), /本轮口径/);

  const harness2 = createHarness();
  harness2.setReply('第一句。第二句。');
  const chat = await harness2.runWebChatTurn({
    scene: 'web', targetId: 'player-2', senderId: 'web:2', messageId: 'web-2',
    content: `${USER('web-chat')} 今天好累啊`, images: [],
  });
  assert.equal(harness2.decisions.length, 1);
  assert.equal(chat.segments.length > 1, true, 'chat 决策:网页 segments 按口语分条');
  assert.equal(chat.segments.join('\n').includes('第一句'), true);

  // 在途隔离(网页 segments):A 在 longTermNote 挂起时 B 推进到 task,释放后 A 的
  // segments 仍必须按 A 自己的 chat 决策(不许用 B 的 task 重判)。
  const harness3 = createHarness();
  const gate = harness3.makeGate();
  harness3.setLongTermHook(async (recall) => {
    if (String(recall?.query ?? '').includes('USER-FP:web-race-a')) {
      gate.markEntered();
      await gate.wait;
    }
    return null;
  });
  harness3.setReplyFor('USER-FP:web-race-a', `${PERSONA('web-race-a')}。第一句。第二句。`);
  const before = harness3.decisions.length;
  const aPromise = harness3.runWebChatTurn({
    scene: 'web', targetId: 'player-race', senderId: 'web:race', messageId: 'web-race-a',
    content: `继续 ${USER('web-race-a')}`, images: [],
  });
  await gate.entered;
  harness3.setReplyFor('USER-FP:web-race-b', '```js\nconst b = 1;\n```');
  await harness3.runWebChatTurn({
    scene: 'web', targetId: 'player-race', senderId: 'web:race', messageId: 'web-race-b',
    content: `${USER('web-race-b')} 帮我把这段代码解释清楚并修复`, images: [],
  });
  gate.release();
  const aResult = await aPromise;
  assert.equal(harness3.decisions.length - before, 2, 'A/B 网页各一次决策');
  assert.equal(aResult.segments.length > 1, true,
    'A 的网页 segments 仍按 A 的 chat 决策分条; segments=' + JSON.stringify(aResult.segments));
  assert.doesNotMatch(promptOf(harness3.runnerCalls.find((call) => call.prompt.includes('USER-FP:web-race-a'))), /本轮口径/);
}

// ---------------------------------------------------------------------------
// 9) 连发合并入口:合并正文决定这一轮,一次决策
// ---------------------------------------------------------------------------
async function testBurstEntryConsumesDecision() {
  const harness = createHarness();
  harness.setReply('```js\nconst a = 2;\n```');
  const message = c2cMessage({ id: 'burst-2', sender: 'speaker-1', target: 'room-burst', content: '' });
  const bursts = [
    { text: `${USER('burst')} 帮我看看这个`, at: harness.now() },
    { text: '```js\nconst a = 1;\n```', at: harness.now() + 1000 },
  ];
  const decisionsBefore = harness.decisions.length;
  await harness.runBurstTurn(CONVERSATION_KEY(message), bursts, message);
  assert.equal(harness.decisions.length - decisionsBefore, 1, '合并一轮只构造一次决策');
  assert.match(promptOf(harness.runnerCalls.at(-1)), /本轮口径/, '合并正文里的动作请求要得到 task 口径');
  assert.match(sentText(harness), /const a = 2;/, 'PERSONA/交付内容要到达最终发送字节');
}

// ---------------------------------------------------------------------------
// 10) 群自发 + 戳/表情:反射轮固定口径,不继承任务;群背景用入口快照
// ---------------------------------------------------------------------------
async function testGroupSelfReflexDoesNotInherit() {
  const harness = createHarness();
  const conversation = 'qqbot-group-group-1';
  // 先写一条"上一轮是 task"的记录(同说话人)—— 反射轮不许继承它。
  harness.rememberTurnDecision(turnPolicy.createTurnDecision(
    { content: '帮我列出步骤', senderId: 'speaker-1', messageId: 'g-trigger' },
    { conversation, instance: 'fixture-bot' },
  ));
  harness.lastOutboundMessageIds.set(conversation, { id: 'g-out-1', speaker: 'speaker-1', triggerMessageId: 'g-trigger' });
  const source = {
    scene: 'group', targetId: 'group-1', senderId: 'speaker-1', messageId: 'g-msg-2',
    replyToMessageId: 'g-out-1', content: '继续', images: [], mentions: [],
  };
  harness.lastGroupMessage.set('group-1', source);
  harness.setReply('第一句。第二句。');
  await harness.maybeGroupReply('group-1', { addressed: true, reason: '关键词', message: source });
  assert.equal(harness.runnerCalls.length, 1, '自发轮要真的跑一轮模型');
  assert.equal(harness.apiSent.length > 0, true, '自发轮要真的发出去');
  assert.equal(harness.groupRenderCalls.length, 1, '群背景只在入口快照一次(await 后不再读 buffer)');
  const prompt = promptOf(harness.runnerCalls.at(-1));
  assert.match(prompt, /GROUP-BACKGROUND-FP/, '群背景快照要进 prompt');
  assert.doesNotMatch(prompt, /本轮口径/, '群自发反射轮不许继承上一轮 task');
  assert.equal(harness.apiSent.length > 1, true, '反射轮按闲聊口径分条');

  const backgroundHarness = createHarness();
  backgroundHarness.lastGroupMessage.set('group-1', {
    ...source, content: '帮我修复后台故障',
  });
  backgroundHarness.setReply('第一句。第二句。');
  await backgroundHarness.maybeGroupReply('group-1');
  assert.equal(backgroundHarness.decisions.at(-1).mode, 'chat', '未被叫的群背景不授予任务口径');
  assert.equal(backgroundHarness.decisions.at(-1).slots.currentRequest, '', '群背景不冒充当前请求');
  assert.doesNotMatch(promptOf(backgroundHarness.runnerCalls.at(-1)), /本轮口径/);

  // 戳一戳:不继承用户任务。
  const pokeHarness = createHarness();
  pokeHarness.rememberTurnDecision(turnPolicy.createTurnDecision(
    { content: '帮我列出步骤', senderId: 'speaker-1', messageId: 'p-trigger' },
    { conversation: 'qqbot-group-group-2', instance: 'fixture-bot' },
  ));
  pokeHarness.setReply('第一句。第二句。');
  const poked = await pokeHarness.maybeInteractionReply('group-2', {
    scene: 'group', targetId: 'group-2', senderId: 'speaker-1', messageId: 'poke-1',
    content: '[戳一戳]', images: [],
  }, 'poke');
  assert.equal(poked, true, '戳一戳要反应');
  assert.doesNotMatch(promptOf(pokeHarness.runnerCalls.at(-1)), /本轮口径/, '戳一戳反射轮不许继承任务');
  assert.equal(pokeHarness.decisions.length, 1, '戳一戳一轮只构造一次决策');
}

// ---------------------------------------------------------------------------
// 11) 反证:撤掉"入口决策 → 消费端"的传递,同一判据必须当场红
// ---------------------------------------------------------------------------
async function testNegativeControlDecisionNotConsumed() {
  const source = readIndex();
  // 只撤**生产源码**里两处"消费入口决策"的接线(内存里改,不落盘):
  //   ① 答话的 turnNotes 不再拿入口决策;② 答话的 plan 不再读决策保真开关。
  const mutatedTurnNotes = source
    .replace(
      '        backgroundImages: turnHasBackgroundImages,\n        // **F2**:入口那份冻结决策;turnNotes 只消费,不再自己判 mode。\n        decision: turnDecision,',
      '        backgroundImages: turnHasBackgroundImages,',
    )
    .replace(
      "const replyLines = planSpokenLines(body, mood, { label: '答话', decision: turnDecision });",
      "const replyLines = planSpokenLines(body, mood, { label: '答话' });",
    );
  assert.notEqual(mutatedTurnNotes, source, '反证注入点必须真的存在');

  const harness = createHarness({ source: mutatedTurnNotes });
  harness.setReplyFor('USER-FP:neg-p', `${PERSONA('neg-p')}\n步骤：检查。\n步骤：修复。`);
  await harness.handleMessage(c2cMessage({
    id: 'neg-p', sender: 'speaker-1', target: 'room-neg', content: `${USER('neg-p')} 帮我列出修复步骤`,
  }));
  const conversation = CONVERSATION_KEY({ scene: 'c2c', targetId: 'room-neg' });
  const pOutbound = harness.lastOutboundMessageIds.get(conversation)?.id;
  assert.ok(pOutbound);
  harness.setReplyFor('USER-FP:neg-a', `${PERSONA('neg-a')}。第一句。第二句。`);
  await harness.handleMessage(c2cMessage({
    id: 'neg-a', sender: 'speaker-1', target: 'room-neg', content: `继续 ${USER('neg-a')}`,
    replyTo: pOutbound,
  }));
  const prompt = promptOf(harness.runnerCalls.at(-1));
  // 对照指纹仍在(证明不是"整条丢了")；但消费判据必须红:决策没被消费,继承的 task 丢了。
  assert.match(prompt, /USER-FP:neg-a/);
  assert.match(prompt, new RegExp(escapeRegExp(FACT)));
  assert.throws(
    () => assert.match(prompt, /本轮口径/),
    /本轮口径/,
    '撤掉决策传递后,消费判据必须当场红(否则判据就是自证的)',
  );
  assert.ok(harness.lastTurnModeProbe.reads > 0,
    '反证里必须看到旧 lastTurnMode 被读(说明生产路径没消费决策时才会回退到旧口径)');
}

// 四个主动入口的真实调用表达式 + 真实 turnNotes 消费（不是手写第五参喂绿）。
async function testProactiveDecisionArgument() {
  const source = readIndex();
  for (const anchor of [
    'conversation: conversationKey, query: activity.line ?? to.name,',
    'conversation: conversationKey, query,',
    'conversation: conversationKey, query: pending.setup,',
    'conversation: conversationKey, query: topic,',
  ]) {
    const at = source.indexOf(anchor);
    assert.ok(at >= 0, `真实调用锚点缺失: ${anchor}`);
    const begin = source.lastIndexOf('await turnNotes(', at);
    const end = source.indexOf(')', at);
    assert.ok(begin >= 0 && end > at);
    const expression = source.slice(begin, end + 1);
    const harness = createHarness();
    const decision = turnPolicy.createTurnDecision({ content: '解释光的原理' }, { reflex: true });
    const notes = await vm.runInNewContext(`(async () => ${expression})()`, {
      mood: { mood: 'plain', maxChars: 40, maxSentences: 2 },
      ledger: [], conversationKey: 'qqbot-group-synthetic',
      activity: { line: '解释光的原理' }, to: { name: '合成地点' },
      query: '解释光的原理', pending: { setup: '解释光的原理' }, topic: '解释光的原理',
      turnDecision: decision,
      turnNotes: (...args) => {
        assert.equal(args[4]?.decision, decision, `${anchor}: 决策必须进第五参`);
        assert.equal(args[3]?.decision, undefined, 'recall 槽不藏决策');
        return harness.turnNotes(...args);
      },
    });
    assert.match(notes.join('\n'), /本轮口径/);
    assert.doesNotMatch(notes.join('\n'), /MOOD-LENGTH-STUB/);
  }
}

// ---------------------------------------------------------------------------
const TESTS = [
  ['决策契约:冻结/分槽/结构只标记保真/knowledge 单一 authority', testDecisionContract],
  ['knowledge:显式 task 在 KB 开关与命中/未命中下都保持 task', testKnowledgeNeverChangesTask],
  ['授权边界:包伪造授权参数被拒、消息伪造字段不能提权', testPackForgeryCannotEscalate],
  ['追问继承:同说话人+可信回复关系+既有窗口,其余对照组不继承', testFollowUpInheritance],
  ['QQ 主答话:真实入口一次决策,prompt 与最终 api payload 同份消费', testQqEntryConsumesOneDecision],
  ['在途隔离 A(挂 runner):task→chat,交付按 A;下一条请求看到新状态', testInFlightRunnerIsolationTaskToChat],
  ['longTermNote await 屏障:chat→task,A 仍按自己的 chat 交付', testLongTermBarrierIsolationChatToTask],
  ['网页入口:segments 与 prompt 同份决策(保真/分条两态)', testWebEntryConsumesDecision],
  ['连发合并入口:合并正文决定口径,一轮一次决策', testBurstEntryConsumesDecision],
  ['群自发/戳表情:反射轮固定口径不继承任务,群背景用入口快照', testGroupSelfReflexDoesNotInherit],
  ['反证:撤掉入口决策传递,消费判据当场红(不是自证)', testNegativeControlDecisionNotConsumed],
  ['主动四入口:真实调用表达式把同份决策传入第五参并被 turnNotes 消费', testProactiveDecisionArgument],
];

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  let failed = 0;
  for (const [name, run] of TESTS) {
    try {
      await run();
      process.stdout.write(`  ok  ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL  ${name}\n${String(err?.stack ?? err).split('\n').map((line) => `      ${line}`).join('\n')}\n`);
    }
  }
  process.stdout.write(`\n${TESTS.length - failed}/${TESTS.length} passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
