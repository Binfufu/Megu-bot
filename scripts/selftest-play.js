/**
 * **玩法内核(D105 第①步)的用例**。
 *
 * 这一批回答的是那条判据:**"selftest 全绿 且 QQ 行为一字不变"** ——
 * 因为"一字不变"没法靠眼睛看,所以这里做的是**逐字对齐**:
 *   ① 内核发出的每一句(`lines`)与**原来 `src\index.js` 里手写的那一句**逐字相等
 *      (下面的 `FROZEN` 表就是那批冻结文案的**唯一真相**,改文案必须先改这里);
 *   ② `tick` 那一拍返回的**状态与旧实现**(`castLine`/`addCatch`/`reelIn`)算出来的**深度相等**,
 *      而且随机数**消耗的顺序**也要一致(不然等待时长会悄悄变)。
 *
 * 挂在 `scripts\selftest.js` 末尾(那边的 `test()` 是收集器,函数体最后统一跑)。
 */

import {
  ACTION_KINDS,
  FISH_BAIT_TIMEOUT_MS,
  FISH_IDLE_TIMEOUT_MS,
  FISH_KEEP_TIMEOUT_MS,
  addCatch,
  alreadyFishingLine,
  applyAction,
  baitLines,
  castLine,
  catchDue,
  describeFishingState,
  detectFishing,
  emptyReelText,
  handlingFor,
  isKnownActionKind,
  looksLikeBaitAnswer,
  phaseLabel,
  reducerFor,
  reelIn,
  reelSummaryLine,
  rollCatch,
  startFishing,
  summarizeBasket,
  unparsedHandlingLine,
  // —— 委托三段闭环(B / 1.93.0)——
  QUEST_CHECKS,
  QUEST_DC_TIERS,
  dcTierFor,
  describeQuestRun,
  gradeFor,
  legalMoves,
  objectiveText,
  openQuest,
  questPhaseLabel,
  resolveQuestTier,
  roll2d6,
  stepsFor,
} from '../src/play/index.js';

/**
 * 固定种子的伪随机(测"随机数消耗顺序"必须可复现)。
 * ⚠️ 别拿它当"地区选择器"用 —— 它选到哪儿是算出来的,不是写出来的。
 */
function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * **按剧本发牌的随机数**(只用来把"城东的湖 / 芦苇丛边 / 三个指定鱼饵"钉住):
 * 第一个值选水域(0.4 → 第 2 个钓点),后 15 个是三次 Fisher-Yates 的交换下标。
 */
function fixedRandom() {
  const queue = [0.4, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
  let at = 0;
  return () => queue[at++] ?? queue[queue.length - 1];
}

/** 把 `Date.now` 钉住,免得文案里那个"约 N 分钟"跳来跳去。 */
function withFrozenClock(now, fn) {
  const real = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** 在冻结时钟下跑一个动作(适配器也是这么喂 `now` 的)。 */
function run(kind, state, action = {}, ctx = {}) {
  const now = ctx.now ?? 1_000_000;
  return withFrozenClock(now, () => applyAction(kind, state, action, { now, ...ctx }));
}

/**
 * **冻结文案表**:每一条都对应原来 `src\index.js` 里那一句(改文案 = 先改这里)。
 */
const FROZEN = {
  bait: '去城东的湖的芦苇丛边吧。\n鱼饵用哪种？1. 蚯蚓　2. 面包屑　3. 从和真那儿顺来的假饵（回个 1/2/3，或者直接说名字。）\n'
    + '（在岸边找了个位置坐下，一边晃腿一边等你挑。）',
  already: '（已经在钓了——在城东的湖的芦苇丛边，还没下饵。）',
  cast: '下饵了——用蚯蚓。（把浮标甩出去，往后一靠，盯着水面。）大概 3 分钟有动静。',
  reelEmpty: '杆收上来了——今天什么也没钓着。',
  reelAutoEmpty: '（半天没动静，吾收杆回去了。）',
};

/**
 * **旧版(1.64.0)收杆那一行的原文** —— 只作对照,不许再发出去。
 * 1.65.0 把它从 `（fish）`(档位 id)改成 `（普通的鱼）`(档位词),理由见 D105 第三节。
 */
const OLD_REEL_LINE = '鱼篓里：鳟鱼（fish）、湖底的秘宝（treasure），合起来大概值 50900 厄里斯。';

export function registerPlayTests({ test, assert }) {
  // -------------------------------------------------------------------------
  // 协议本身
  // -------------------------------------------------------------------------
  test('动作协议(D105):没声明过的 kind 一律 fail closed,绝不当成成功', () => {
    assert.equal(isKnownActionKind('fishing.begin'), true);
    assert.equal(isKnownActionKind('钓鱼'), false);
    assert.equal(isKnownActionKind(undefined), false);
    const out = applyAction('fishing.teleport', { phase: 'waiting' }, {});
    assert.deepEqual(out.state, { phase: 'waiting' }, '状态原样退回');
    assert.equal(out.lines.length, 0);
    assert.equal(out.events[0].type, 'warn');
    assert.equal(out.events[0].reason, 'unknown_action');
    for (const kind of Object.keys(ACTION_KINDS)) {
      assert.ok(kind.includes('.'), `kind 要带命名空间:${kind}`);
    }
  });

  test('动作协议(D105):内核是纯函数 —— 不改入参、events/lines 能直接 JSON 走网络', () => {
    const before = { phase: 'bait', water: '河边', spot: '石头', baits: [{ id: 'a', label: 'A' }], lastTouchAt: 0, startedAt: 0 };
    const snapshot = JSON.stringify(before);
    const out = run('fishing.cast', before, { baitId: 'a' }, { random: () => 0 });
    assert.equal(JSON.stringify(before), snapshot, '入参一个字节都不许动');
    assert.deepEqual(JSON.parse(JSON.stringify(out.events)), out.events, '事件必须可序列化(第③步要走 HTTP)');
    assert.deepEqual(JSON.parse(JSON.stringify(out.lines)), out.lines);
  });

  test('动作协议(D105):时间是注入的 —— 同一个动作、同一个 now,跑两次结果完全一样', () => {
    const one = run('fishing.begin', null, {}, { random: fixedRandom(), now: 555_000, userName: '和真', userId: 'U1' });
    const two = run('fishing.begin', null, {}, { random: fixedRandom(), now: 555_000, userName: '和真', userId: 'U1' });
    assert.deepEqual(one, two);
    assert.equal(one.state.startedAt, 555_000);
    assert.equal(one.state.userName, '和真');
    assert.equal(one.state.userId, 'U1');
  });

  // -------------------------------------------------------------------------
  // 开局 / 下饵 / 收杆 / 结算
  // -------------------------------------------------------------------------
  test('开局(D105):水域与钓点来自表、三个饵、马上给话;重复开局要有第二句', () => {
    const { state, events, lines } = run('fishing.begin', null, {}, { random: fixedRandom(), userName: '和真' });
    assert.equal(state.phase, 'bait');
    assert.equal(state.dueAt, null, '"还没下饵"就不该有截止时刻');
    assert.equal(state.baits.length, 3);
    assert.equal(events[0].type, 'fishing_begin');
    assert.deepEqual(lines, [FROZEN.bait], '开局那一句要逐字对齐(冻结表)');
    assert.equal(alreadyFishingLine(state, state.startedAt), FROZEN.already);
    assert.equal(baitLines(state), FROZEN.bait);
  });

  test('下饵(D105):从现在起计时 3~8 分钟,并按注入的随机数走', () => {
    const { state: started } = run('fishing.begin', null, {}, { random: fixedRandom() });
    const fast = run('fishing.cast', started, { baitId: started.baits[0].id }, { random: () => 0, now: 2_000_000 });
    assert.equal(fast.state.phase, 'waiting');
    assert.equal(fast.state.dueAt - 2_000_000, 3 * 60_000, '最短 3 分钟');
    assert.deepEqual(fast.lines, [FROZEN.cast], '下饵那一句逐字对齐');
    assert.equal(fast.events[0].type, 'fishing_cast');
    const slow = run('fishing.cast', started, { baitId: started.baits[0].id }, { random: () => 0.999, now: 2_000_000 });
    assert.ok(slow.state.dueAt - 2_000_000 <= 8 * 60_000 && slow.state.dueAt - 2_000_000 > 3 * 60_000);
    // 不是 bait 阶段就不许下饵(群里那句闲聊别被吃掉)
    const notBait = run('fishing.cast', { ...started, phase: 'waiting' }, { text: '1' });
    assert.equal(notBait.state.phase, 'waiting');
    assert.equal(notBait.events[0].reason, 'not_bait_phase');
  });

  test('选饵(D105):认得"1/2/3"、名字、"随便";认不出的话要原样放过去', () => {
    const { state: started } = run('fishing.begin', null, {}, { random: fixedRandom() });
    for (const [text, want] of [['2', 1], ['随便', 0], ['我用第一个', 0]]) {
      const out = run('fishing.cast', started, { text }, { random: () => 0 });
      assert.equal(out.state.bait, started.baits[want].id, `「${text}」该挑第 ${want + 1} 个`);
    }
    assert.equal(looksLikeBaitAnswer(started, '你们俩在干嘛'), false);
    assert.equal(detectFishing('去钓鱼吧'), true);
    assert.equal(detectFishing('今天天气不错'), false);
  });

  test('收杆(D105):空鱼篓不问处置;有货才进 choosing 并问"怎么处理"', () => {    const empty = run('fishing.reel_in', { basket: [], phase: 'waiting', water: '河', spot: '桥' });
    assert.equal(empty.state, null, '空鱼篓直接结束');
    assert.deepEqual(empty.lines, [FROZEN.reelEmpty]);
    assert.deepEqual(run('fishing.reel_in', { basket: [], phase: 'waiting' }, { auto: true }).lines, [FROZEN.reelAutoEmpty]);

    const full = run('fishing.reel_in', {
      basket: [
        { tier: 'fish', kind: 'fish', name: '鳟鱼', money: 900 },
        { tier: 'treasure', kind: 'treasure', name: '湖底的秘宝', money: 50_000 },
      ],
      phase: 'waiting',
      water: '城东的湖',
      spot: '芦苇丛边',
    }, { now: 1000 });
    assert.equal(full.state.phase, 'choosing');
    assert.equal(full.state.choosingUntil, 1_000_000 + FISH_KEEP_TIMEOUT_MS, '处置窗口从"现在"起算 10 分钟');
    const summary = full.events[0].summary;
    assert.equal(summary.count, 2);
    assert.equal(summary.total, 50_900);
    assert.equal(full.events[0].type, 'fishing_reeled');
    // 第二行(事实)由代码写死;第一行是模型写的过程(没传就没有)
    assert.equal(full.lines.length, 1, '没传 flavor → 只有事实那一行');
    assert.ok(full.lines[0].startsWith('鱼篓里：'), full.lines[0]);
    assert.ok(full.lines[0].includes('50900'), '数值不带千分位(和旧文案一字不差)');
    assert.ok(full.lines[0].includes('怎么处理？'));
    assert.ok(full.lines[0].includes('烤着吃'), '鱼 → 有"吃"这一档');
    // ⚠️ **这一条是 1.65.0 唯一一处有意的文案变更**(D105 第三节),不是"抽内核时不小心改的"
    //    —— 旧值是 `鳟鱼（fish）`:档位 id 直接印给了用户,而 D104 早就定了"前端只说档位词"。
    //    冻结旧值在这里,是为了**以后再有人动它**时当场红。
    assert.equal(OLD_REEL_LINE, '鱼篓里：鳟鱼（fish）、湖底的秘宝（treasure），合起来大概值 50900 厄里斯。', '旧版原样(对照用)');
    // 现在这一行与旧版**只差档位那两处**:其余文字(数值/选项/括号旁白)仍逐字相同
    const sameButTier = full.lines[0]
      .split('\n')[0]
      .replace('鳟鱼（普通的鱼）', '鳟鱼（fish）')
      .replace('湖底的秘宝（值钱的宝贝）', '湖底的秘宝（treasure）');
    assert.equal(sameButTier, OLD_REEL_LINE, '除了档位词,收杆那一行一个字都不许变');
    assert.ok(full.lines[0].includes('鳟鱼（普通的鱼）'), full.lines[0]);
    assert.ok(full.lines[0].includes('湖底的秘宝（值钱的宝贝）'), full.lines[0]);
    assert.ok(!full.lines[0].includes('（fish）'), '英文档位 id 不许露给用户');
    assert.equal(emptyReelText(), FROZEN.reelEmpty);
    assert.equal(emptyReelText({ auto: true }), FROZEN.reelAutoEmpty);
  });

  test('鱼篓汇总(D105/1.82.0):按"档位 + 名字"合并,值钱的排前面,阶段名只有一份', () => {
    // 面板原来把鱼篓平铺成一长串名字(15 件读不出几件、也读不出值多少)——
    // 合并逻辑放进内核,面板只渲染(两种视图同一份事实)。
    const state = {
      basket: [
        { tier: 'junk', kind: 'junk', name: '半个木桶', money: 40 },
        { tier: 'fish', kind: 'fish', name: '鳟鱼', money: 900 },
        { tier: 'fish', kind: 'fish', name: '鳟鱼', money: 500 },
        { tier: 'treasure', kind: 'treasure', name: '生锈的短剑', money: 60_000 },
      ],
    };
    const sum = summarizeBasket(state);
    assert.equal(sum.count, 4, '件数是**原来那些行**,不是合并后的条目数');
    assert.equal(sum.distinct, 3);
    assert.equal(sum.total, 61_440);
    assert.deepEqual(sum.items.map((row) => row.name), ['生锈的短剑', '鳟鱼', '半个木桶'], '按小计从高到低');
    assert.equal(sum.items[1].count, 2);
    assert.equal(sum.items[1].subtotal, 1_400);
    assert.equal(sum.items[0].tierLabel, '值钱的宝贝', '档位要给人话,不许把 treasure 念出来');
    // 兼容:原来那两样(byKind / basket)一个都没少 —— 收杆结算与询问还在读它们
    assert.deepEqual(sum.byKind, { junk: 1, fish: 2, treasure: 1 });
    assert.equal(sum.basket, state.basket);
    // 空鱼篓:合并成一个空清单,而不是报错
    assert.deepEqual(summarizeBasket(null).items, []);

    // 阶段名:三个相位各一句,没在钓给 null(面板那枚徽章用它)
    assert.equal(phaseLabel({ phase: 'bait' }), '选鱼饵');
    assert.equal(phaseLabel({ phase: 'waiting' }), '等鱼上钩');
    assert.equal(phaseLabel({ phase: 'choosing' }), '挑怎么处置');
    assert.equal(phaseLabel(null), null);
  });

  test('收杆的 state(D105):不许夹带模型那一段 —— 写回 meta 的字段要与旧版一致(1.65.1 复核)', () => {
    const state = {
      basket: [{ tier: 'fish', kind: 'fish', name: '鳟鱼', money: 900 }],
      phase: 'waiting',
      water: '城东的湖',
      spot: '芦苇丛边',
      userId: 'U1',
      userName: '和真',
    };
    const out = run('fishing.reel_in', state, { flavor: '（把竿收起来）今天够了。' }, { now: 1000 });
    assert.ok(!('reelFlavor' in out.state), '模型那段话只用来拼消息,不许写进状态(旧版没有这个字段)');
    assert.deepEqual(
      Object.keys(out.state).sort(),
      ['basket', 'choosingUntil', 'lastTouchAt', 'phase', 'spot', 'userId', 'userName', 'water'].sort(),
      '写回去的字段集合要正好是旧版那一套',
    );
  });

  test('结算(D105):按档位分组 —— 吃的算 meal、卖的算 fish、风干/留着算 home', () => {
    const state = {
      basket: [
        { kind: 'fish', name: '鳟鱼', money: 1000 },
        { kind: 'junk', name: '破靴子', money: 100 },
        { kind: 'treasure', name: '秘宝', money: 50_000 },
      ],
      phase: 'choosing',
      water: '湖',
      spot: '边',
    };
    const plan = [
      { handling: 'grill', kinds: ['fish'] },
      { handling: 'toss', kinds: ['junk'] },
      { handling: 'sell_precious', kinds: ['precious'] },
    ];
    const out = run('fishing.settle', state, { plan });
    const settled = out.events[0];
    assert.equal(settled.type, 'fishing_settled');
    assert.equal(out.state, null, '结算完状态清空');
    assert.equal(settled.kind, 'meal', '有"吃"就是 meal(绑定表里只有它准动饱食)');
    assert.ok(settled.effect.satiety > 0, '吃到了才有饱食');
    assert.equal(settled.effect.money, 50_000, '宝物按全价出手');
    assert.equal(settled.detail.kind, 'meal');
    assert.ok(settled.detail.plan.includes('grillx1'));
    assert.equal(settled.summary.count, 3, '鱼篓事实要带上(台账用)');
    // 只卖 → fish;只风干 → home(绑定表 fail closed,kind 错了数值会被丢掉)
    assert.equal(run('fishing.settle', state, { handling: 'sell' }).events[0].kind, 'fish');
    assert.equal(run('fishing.settle', state, { handling: 'dry' }).events[0].kind, 'home');
    // 单个处置 id 也要认(超时自动全卖走的就是这条路)
    const one = run('fishing.settle', { ...state, basket: [{ kind: 'fish', name: '鱼', money: 100 }] }, { handling: 'sell' });
    assert.equal(one.events[0].detail.plan, 'sellx1');
  });

  // -------------------------------------------------------------------------
  // tick:状态序列与随机数消耗顺序**必须**与旧实现一致
  // -------------------------------------------------------------------------
  test('tick(D105):上钩那一条 —— 鱼进鱼篓、自动接着钓、状态与旧实现深度相等', () => {
    const now = 5_000_000;
    const { state: started } = run('fishing.begin', null, {}, { random: fixedRandom() });
    const cast = run('fishing.cast', started, { baitId: started.baits[0].id }, { random: () => 0, now }).state;
    const due = cast.dueAt;
    // 旧实现:同一个 `Math.random` 上先 `rollCatch()` 抽一条、再 `addCatch()` 重新计时 ——
    // 所以两条腿**要用同一串随机数**,否则比的是"消耗几个随机数"而不是"结果一样不一样"。
    const oldRolls = seededRandom(11);
    const oldCatch = rollCatch(oldRolls);
    const oldNext = addCatch(cast, oldCatch, { now: due, random: oldRolls });
    const out = run('fishing.tick', cast, {}, { now: due, random: seededRandom(11) });
    assert.equal(out.events[0].type, 'fishing_caught');
    assert.deepEqual(out.events[0].catch, oldCatch, '抽到的档位/名字/钱数要与 rollCatch 完全一致');
    assert.equal(out.state.phase, 'waiting', '钓到一条之后**自动接着钓**');
    assert.deepEqual(out.state.basket, oldNext.basket);
    assert.equal(out.state.dueAt, oldNext.dueAt, '重新计时的时刻也要一致(随机数消耗顺序)');
    assert.equal(out.events[0].count, 1);
    assert.ok(out.events[0].tierLabel && !/^[a-z]+$/.test(out.events[0].tierLabel), '档位要说中文,不许把英文 id 露出来');
    // ⚠️ 上钩/接着钓两句**由适配器发**(模型写过程),内核这里不给 lines —— 那是故意的
    assert.deepEqual(out.lines, []);
  });

  test('tick(D105):没到点什么都不做;过了 30 分钟没人理就自己收杆', () => {
    const now = 9_000_000;
    const { state: started } = run('fishing.begin', null, {}, { random: fixedRandom() });
    const cast = run('fishing.cast', started, { baitId: started.baits[0].id }, { random: () => 0, now }).state;
    const early = run('fishing.tick', cast, {}, { now: cast.dueAt - 1 });
    assert.equal(early.events[0].reason, 'nothing_due');
    assert.equal(early.state.dueAt, cast.dueAt, '没到点不许重排时间');

    const idle = { ...cast, lastTouchAt: now - FISH_IDLE_TIMEOUT_MS - 1, basket: [] };
    const out = run('fishing.tick', idle, {}, { now });
    assert.equal(out.events[0].type, 'fishing_reel_empty');
    assert.equal(out.state, null);
    assert.equal(run('fishing.reel_in', idle, { auto: true }, { now }).state, null);
  });

  test('tick(D105):一直没选饵 → 过 5 分钟替她挑一个(不能卡在第一步)', () => {
    const { state: started } = run('fishing.begin', null, {}, { random: fixedRandom() });
    const late = run('fishing.tick', started, {}, { now: started.startedAt + FISH_BAIT_TIMEOUT_MS + 1, random: () => 0 });
    assert.equal(late.events[0].type, 'fishing_cast');
    assert.equal(late.state.phase, 'waiting');
    assert.deepEqual(late.lines, [FROZEN.cast], '替她挑第一个饵 —— 和"选 1"逐字一样');
    // 还没过时限就什么都不做(别提前替她决定)
    const soon = run('fishing.tick', started, {}, { now: started.startedAt + 1000 });
    assert.equal(soon.events[0].reason, 'nothing_due');
  });

  test('tick(D105):分鱼超时 → 默认全卖(钱不会凭空消失)', () => {
    const state = {
      basket: [{ kind: 'fish', name: '鳟鱼', money: 1000 }],
      phase: 'choosing',
      choosingUntil: 1000,
      water: '湖',
      spot: '边',
    };
    const out = run('fishing.tick', state, {}, { now: 2000 });
    assert.equal(out.events[0].type, 'fishing_settled');
    assert.equal(out.events[0].auto, true);
    assert.equal(out.events[0].detail.plan, 'sellx1');
    assert.equal(out.state, null);
  });

  test('tick(D105):脏数据(钓位是旧的/空壳)不许炸,也不许瞎收', () => {
    assert.equal(run('fishing.tick', null, {}).events[0].reason, 'no_state');
    assert.equal(run('fishing.tick', { water: '湖' }, {}).events[0].reason, 'no_state');
    assert.equal(run('fishing.reel_in', null, {}).events[0].reason, 'not_fishing');
    assert.equal(run('fishing.settle', null, {}).events[0].reason, 'not_fishing');
    // 状态里没有 dueAt(旧版钓位)也不该被判成"到点了"
    assert.equal(catchDue({ phase: 'waiting' }, Date.now()), false);
  });

  // -------------------------------------------------------------------------
  // 适配器与内核的分工
  // -------------------------------------------------------------------------
  test('下饵的名字(D105):说话的人改名了就按新名字叫 —— 消息在前、状态在后(1.65.1 复核)', () => {
    const state = {
      phase: 'bait',
      water: '湖',
      spot: '边',
      baits: [{ id: 'a', label: 'A' }],
      basket: [],
      userId: 'OLD',
      userName: '旧名字',
      startedAt: 0,
      lastTouchAt: 0,
    };
    const out = run('fishing.cast', state, { text: '1' }, { now: 1000, random: () => 0, userId: 'U9', userName: '新名字' });
    assert.equal(out.state.userName, '新名字', '旧实现是 message.senderName ?? state.userName');
    assert.equal(out.state.userId, 'U9');
    // 上下文没给名字时才回落到状态里的(这条别写成"状态优先")
    const fallback = run('fishing.cast', state, { text: '1' }, { now: 1000, random: () => 0 });
    assert.equal(fallback.state.userName, '旧名字');
    assert.equal(fallback.state.userId, 'OLD');
  });

  test('分工(D105):模型写的那一段由适配器传进来,事实与操作提示由代码挂上', () => {    const state = {
      basket: [{ kind: 'fish', name: '鳟鱼', money: 900 }],
      phase: 'waiting',
      water: '城东的湖',
      spot: '芦苇丛边',
    };
    const bare = run('fishing.reel_in', state, { now: 1000 });
    assert.equal(bare.lines.length, 1, '没传 flavor → 只剩事实那一行');
    assert.ok(bare.lines[0].startsWith('鱼篓里：'), '没台词时第一行就是事实(适配器再按提示词补兜底)');
    const withFlavor = run('fishing.reel_in', state, { now: 1000, flavor: '（把竿收起来）今天够了。' });
    assert.equal(withFlavor.lines[0], '（把竿收起来）今天够了。');
    assert.equal(withFlavor.lines[1], bare.lines[0], '事实那一行不随台词变');
    assert.ok(withFlavor.lines[1].includes('900'), '数值来自鱼篓,不由模型编');
    assert.ok(withFlavor.lines[1].includes('吾就全卖了'), '操作提示也是代码写的');
  });

  test('分工(D105):自定义饵(库外)不许被选饵逻辑顶掉', () => {
    const { state: started } = run('fishing.begin', null, {}, { random: fixedRandom() });
    const custom = { ...started, baits: [{ id: 'custom:肥皂', label: '肥皂', good: true, custom: true }, ...started.baits] };
    const out = run('fishing.cast', custom, { baitId: custom.baits[0].id }, { random: () => 0 });
    assert.equal(out.state.bait, 'custom:肥皂', '适配器先写状态再下饵,这条路径不许被 pickBait 顶掉');
    assert.ok(out.lines[0].includes('肥皂'));
  });

  test('分鱼反问(D105):"听不懂"那一句里要有鱼篓事实和可选档位', () => {
    const state = {
      basket: [{ kind: 'fish', name: '鳟鱼', money: 900 }, { kind: 'junk', name: '破靴子', money: 0 }],
      phase: 'choosing',
    };
    const line = unparsedHandlingLine(state);
    assert.ok(line.includes('鳟鱼') && line.includes('破靴子'), '要把鱼篓念出来(否则她不知道在说哪一批)');
    assert.ok(line.includes('分开说也行'));
    for (const option of handlingFor(state)) assert.ok(line.includes(option.label), `${option.label} 要在选项里`);
  });

  test('状态一句话(D105):四个阶段各有一句,日志/面板共用同一套口径', () => {
    assert.equal(describeFishingState(null), '（没在钓鱼）');
    assert.ok(describeFishingState({ phase: 'bait', water: '河', spot: '桥' }).includes('还没下饵'));
    assert.ok(describeFishingState({ phase: 'waiting', water: '河', spot: '桥', dueAt: 61_000, basket: [] }, 1000).includes('还有约 60 秒'));
    assert.ok(describeFishingState({ phase: 'choosing', water: '河', spot: '桥', basket: [1, 2] }).includes('鱼篓 2 条'));
    assert.equal(describeFishingState({ phase: 'bait', water: '城东的湖', spot: '芦苇丛边' }), '在城东的湖的芦苇丛边，还没下饵');
  });

  test('动作协议(D105):派发走表不写死 —— 加一个玩法不该回来改入口(1.65.1 复核)', () => {
    // 旧写法是 `kind.startsWith('fishing.')`:那样一加 `explore.begin`,就会得到
    // `reason:'unknown_action'`(明明已经声明过),而每加一个玩法都得回来改入口。
    assert.equal(typeof reducerFor('fishing.begin'), 'function');
    assert.equal(reducerFor('explore.begin'), null, '没登记的玩法返回 null(调用方按 unknown_action 处理)');
    assert.equal(reducerFor('fishing.根本不存在'), reducerFor('fishing.begin'), '同前缀走同一个 reducer');
    // 声明过、但没登记 reducer → 仍然是 fail closed(不许静默当成功)
    const out = applyAction('explore.begin', { phase: 'x' }, {});
    assert.deepEqual(out.state, { phase: 'x' });
    assert.equal(out.events[0].reason, 'unknown_action');
  });

  test('内核自洽(D105):旧名字(startFishing/castLine/reelIn)仍然从内核拿得到,适配器与旧测试不用改', () => {
    const started = startFishing({ now: 1000, random: () => 0.3 });
    assert.equal(started.phase, 'bait');
    const cast = castLine(started, { now: 1000, baitId: started.baits[0].id, random: () => 0 });
    assert.equal(cast.dueAt - 1000, 3 * 60_000);
    const { state } = reelIn({ ...cast, basket: [{ kind: 'fish', name: '鱼', money: 1 }] }, { now: 1000 });
    assert.equal(state.phase, 'choosing');
  });

  // =========================================================================
  // 委托三段闭环(B / 1.93.0)—— 纯内核那一层
  // =========================================================================

  test('委托内核(B):四档都有判定段、难度与骰子数写在表里、**认不出档位就拒**', () => {
    // 每一档都要有"分段目标 + 每段的 dc":这是三段闭环的"过程"那一段能不能玩的前提
    for (const [tier, row] of Object.entries(QUEST_CHECKS)) {
      assert.ok(row.steps.length >= 2, `${tier} 至少要有两段(不然"过程"没有过程)`);
      for (const step of row.steps) {
        assert.ok(step.text && step.text.length > 2, `${tier}/${step.id} 要有一句人话目标`);
        assert.ok(Number.isFinite(step.dc) && step.dc > 0, `${tier}/${step.id} 要有 dc(不然没法判)`);
      }
      // 同一档里 step id 不许重复(重复 = 两条一模一样的判定)
      const ids = row.steps.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, `${tier} 的 step id 不许重复`);
    }
    // ⚠️ **档位有两套写法**(看板落的是中文标签):归一认得出,认不出给 null(不猜)
    assert.equal(resolveQuestTier('hard'), 'hard');
    assert.equal(resolveQuestTier('危险'), 'hard');
    assert.equal(resolveQuestTier('跑腿小活'), 'trivial');
    assert.equal(resolveQuestTier('不知道什么活'), null);
    assert.equal(resolveQuestTier(''), null);
    assert.equal(openQuest({ tier: '不知道什么活' }), null, '认不出档位 → 这一局不接');
    assert.equal(openQuest(null), null);
    // 判定机制只有一套:两颗骰子、四档(docs\08 3.1)
    assert.equal(QUEST_DC_TIERS.length, 4);
    const dice = roll2d6(() => 0.5);
    assert.ok(dice.roll >= 2 && dice.roll <= 12, '两颗 d6 的取值范围');
    assert.equal(dcTierFor(0).id, 'success');
    assert.equal(dcTierFor(-1).id, 'fail');
    assert.equal(dcTierFor(-6).id, 'crit_fail');
    assert.equal(dcTierFor(5).id, 'crit_success');
  });

  test('委托内核(B):**同一个 seed 重放两次,骰值逐段相同**(seed 决定论)', () => {
    const seedSeq = [0.1, 0.9, 0.4, 0.7, 0.2, 0.8, 0.3, 0.6];
    const rngOf = () => {
      let at = 0;
      return () => seedSeq[at++ % seedSeq.length];
    };
    const row = { tier: 'hard', label: '危险委托', reward: 1000, penalty: -200, stamina: 20 };

    const replay = () => {
      let state = openQuest(row, { now: 1000 });
      const rolls = [];
      for (let i = 0; i < 4; i += 1) {
        const out = applyAction('quest.step', state, {}, { now: 2000 + i, rng: rngOf() });
        rolls.push(...(out.state.checks ?? []).slice(-1).map((c) => [c.d1, c.d2, c.roll, c.tier, c.dc]));
        state = out.state;
      }
      return { rolls, state };
    };
    const first = replay();
    const second = replay();
    assert.deepEqual(first.rolls, second.rolls, '同一个 seed:逐段骰值必须完全一样');
    assert.equal(first.rolls.length, 4);
    assert.deepEqual(first.state.settle, second.state.settle, '结算结果也要一样');
    // 每一次判定都留着 dc 与 roll(docs\08 3.2 判据①)
    for (const row2 of first.state.checks) {
      assert.ok(Number.isFinite(row2.dc) && Number.isFinite(row2.roll), 'dc 与 roll 一个都不能少');
    }
    // 时间也是注入的:期限过了 → 直接作废(不是静默什么都不做)
    const expiredRun = { ...openQuest(row, { now: 1000 }), deadlineAt: 1500 };
    const expired = applyAction('quest.step', expiredRun, {}, { now: 9999, rng: () => 0 });
    assert.equal(expired.state.phase, 'settled');
    assert.equal(expired.state.settle.grade, 'expired');
    assert.equal(expired.state.settle.paid, -200, '过期 = 押金/违约金照扣');
  });

  test('委托内核(B):评级与钱对得上(**不凭空多给、也不把失败算成倒赚**)', () => {
    const base = 1000;
    // 倍率那一栏就是这一版的全部口径
    assert.equal(gradeFor({ succeeded: 3, failed: 0, total: 3 }).multiplier, 1.5, '全过 → 大成功');
    assert.equal(gradeFor({ succeeded: 2, failed: 1, total: 3 }).multiplier, 0.8, '过一半以上 → 勉强完成');
    assert.equal(gradeFor({ succeeded: 1, failed: 2, total: 3 }).multiplier, 0.8, '只过一段 → 勉强完成(八成)');
    assert.equal(gradeFor({ succeeded: 0, failed: 3, total: 3 }).multiplier, 0, '全挂 → 砸了');

    const moneyOf = (results) => {
      const run = { ...openQuest({ tier: 'normal', reward: base, penalty: -150, stamina: 10 }, { now: 1000 }), results };
      // 直接调结算(过程那一段已经跑完)
      return applyAction('quest.settle', run, {}, { now: 2000 }).state.settle;
    };
    const perfect = moneyOf([
      { tier: 'crit_success', margin: 6, at: 1 }, { tier: 'success', margin: 1, at: 2 }, { tier: 'success', margin: 2, at: 3 },
    ]);
    assert.equal(perfect.paid, base + 500, '全过:基础 + 一半加成');
    const partial = moneyOf([
      { tier: 'success', margin: 1, at: 1 }, { tier: 'fail', margin: -2, at: 2 }, { tier: 'success', margin: 3, at: 3 },
    ]);
    assert.equal(partial.paid, 800, '挂一段:八成');
    assert.equal(partial.penalty, 0, '"失败不一定受伤"——只挂一段不扣违约金');
    const zero = moneyOf([
      { tier: 'fail', margin: -2, at: 1 }, { tier: 'crit_fail', margin: -8, at: 2 }, { tier: 'fail', margin: -1, at: 3 },
    ]);
    assert.equal(zero.paid, -150, '全挂:一分不给,还要赔违约金');
    assert.equal(zero.bonus, 0, '全挂没有加成(不许出现"倒赚")');
  });

  test('委托内核(B):合法动作清单由内核给、界面只有一句话说法(前端不许自己编)', () => {
    const run = openQuest({ tier: 'trivial', label: '送信', reward: 500, penalty: 0, stamina: 5 }, { now: 1000 });
    const moves = legalMoves(run);
    assert.deepEqual(moves.map((m) => m.kind), ['quest.step', 'quest.abandon']);
    assert.ok(moves[0].primary === true, '默认那一下是"继续"');
    assert.equal(questPhaseLabel(run), '第 1 段 / 共 2 段');
    assert.equal(objectiveText(run), QUEST_CHECKS.trivial.steps[0].text);
    // 结算之后:没有可点的动作,而阶段名说"已结算"
    const settled = applyAction('quest.settle', run, {}, { now: 2000 }).state;
    assert.deepEqual(legalMoves(settled), []);
    assert.ok(questPhaseLabel(settled).includes('已结算'));
    assert.equal(objectiveText(settled), null);
    // 没状态 → 什么按钮都不给(不许编一个"开始"出来)
    assert.deepEqual(legalMoves(null), []);
    assert.equal(questPhaseLabel(null), null);
    // 一句模板回执:dc/roll 都说得出来(拔掉 LLM 也读得懂)
    const text = describeQuestRun(run);
    assert.ok(text.includes('送信'));
    assert.ok(text.includes('下一步'));
  });
}
