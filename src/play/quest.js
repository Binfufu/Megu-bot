/**
 * **委托三段闭环的纯内核**(B 那一刀;用户 2026-10-07 拍板的顺序 A→B→C→D)。
 *
 * ## 它解决什么
 *
 * 1.86.0 起公会能"接活"(`/接 N` 与面板上的「接 #N」),但那是**一次判定 + 一次结账**:
 * 挑一条、钱立刻进、体力立刻掉。而"三段闭环"要的是**这件事本身能玩**:
 *
 *     接取(押金/期限/条件) → 过程(分段目标 + 每段一次纯函数判定) → 结算(评级 / 加成 / 惩罚)
 *
 * `docs\08` 3.2 把三段与字段写死了;这一版把**判定与状态迁移**落成纯函数(照 `fishing.js` 那套),
 * 调用方(面板动作 / 以后的 QQ 适配器)只负责读库、写库、发消息、落账。
 *
 * ## 五条硬纪律(全部来自既有决策,不是这一版新定的)
 *
 * ① ⚠️ **LLM 不当裁判**:判定是纯函数;`rng` 与 `now` **注入** —— 同一个 seed 重放两次,
 *    骰值逐段相同(`docs\09` 的种子决定论三条)。
 * ② ⚠️ **必须落 `dc` 与 `roll`**:否则分不清"实力不够"和"运气差"(`docs\08` 3.1 原话)。
 * ③ ⚠️ **拔掉 LLM 也能跑通**:这个文件**不认识模型** —— 每一段的 `lines` 都是**模板句**,
 *    模型的作用只是"把这段事实说得好听"(由适配器另外拼),判据是"没有模型也走完全程"。
 * ④ ⚠️ **只用一个判定机制**:2d6 + 修正 vs DC 四档(`docs\08` 3.1 / 第七节选型)。
 *    判定**与模式无关**(`lawful` / `tricky` 只是同一套里的难度修饰),绝不引第二套骰子。
 * ⑤ **数值只经由调用方**:这里只算"该给多少",**不写账** —— 落账走 `store.applyStoryResult`
 *    (绑定表 `stat-binding.js` 的 `quest`,允许改的只有钱与体力)。
 *
 * ## 状态形状(存在 `meta` 里;键由调用方给,见 `questRunKey`)
 *
 * ```
 * { v:1, runId, phase: 'process'|'settled'|'abandoned', tier, label, baseReward, penalty, stamina,
 *   acceptedAt, deadlineAt,
 *   checks:  [{ at, kind, dc, roll, mod, tier, margin, ok, text }],   // 每一次判定都留痕
 *   results: [{ kind, tier, margin, at }],
 *   settle:  { at, grade, base, multiplier, bonus, penalty, paid, line } | null }
 * ```
 */

import { CURRENCY } from '../stats.js';

/** 三段(接取那一段由调用方先落账 —— 见 `openQuest`)。 */
export const QUEST_PHASES = Object.freeze(['process', 'settled', 'abandoned']);

/**
 * **判定机制**:2d6 + 修正 vs DC 四档(`docs\08` 3.1,用户已拍板)。
 *
 * ⚠️ 四档是**固定切点**(不是让模型解释骰值):`margin = roll + mod - dc`。
 */
export const QUEST_DICE = Object.freeze({ count: 2, faces: 6 });
export const QUEST_DC_TIERS = Object.freeze([
  { id: 'crit_fail', label: '大失败', min: -99, max: -6 },
  { id: 'fail', label: '失败', min: -5, max: -1 },
  { id: 'success', label: '成功', min: 0, max: 4 },
  { id: 'crit_success', label: '大成功', min: 5, max: 99 },
]);

/** 按 margin 读四档(纯函数)。 */
export function dcTierFor(margin) {
  const value = Number(margin) || 0;
  for (const row of QUEST_DC_TIERS) {
    if (value >= row.min && value <= row.max) return row;
  }
  return QUEST_DC_TIERS[0];
}

/**
 * **每一步的判定池**(设计声明;数值是**这一版定的第一版口径**)。
 *
 * ⚠️ 口径:`dc` 是"两颗骰子 + 修正"要到多少;`mod` 是这一段吃哪个属性 ——
 *    但**属性还不成体系**(角色构建=点数买卖那条还没做),所以第一版用**固定修正**,
 *    并把它写在这里(而不是散在代码里)。以后接上属性就只改这一格。
 */
export const QUEST_CHECKS = Object.freeze({
  trivial: {
    kind: 'trivial',
    label: '跑腿小活',
    steps: [
      { id: 'find', text: '找到地方（问路 / 认门牌）', dc: 7, mod: 0, kind: 'lawful' },
      { id: 'deliver', text: '把东西交到人手上', dc: 8, mod: 0, kind: 'lawful' },
    ],
  },
  normal: {
    kind: 'normal',
    label: '正经委托',
    steps: [
      { id: 'track', text: '循着痕迹找到目标', dc: 8, mod: 0, kind: 'tricky' },
      { id: 'fight', text: '把目标解决掉', dc: 9, mod: 0, kind: 'lawful' },
      { id: 'back', text: '把凭据带回去', dc: 7, mod: 0, kind: 'lawful' },
    ],
  },
  hard: {
    kind: 'hard',
    label: '危险委托',
    steps: [
      { id: 'scout', text: '先摸清对手的底细', dc: 9, mod: 0, kind: 'tricky' },
      { id: 'strike', text: '正面动手，别被反打', dc: 11, mod: 0, kind: 'lawful' },
      { id: 'survive', text: '受了伤也得走回来', dc: 9, mod: 0, kind: 'lawful' },
      { id: 'report', text: '回公会交差', dc: 7, mod: 0, kind: 'lawful' },
    ],
  },
  fiasco: {
    kind: 'fiasco',
    label: '看着就不对劲的活',
    steps: [
      { id: 'sniff', text: '先看出这活哪儿不对', dc: 10, mod: 0, kind: 'tricky' },
      { id: 'bail', text: '见势不对就撤', dc: 10, mod: 0, kind: 'tricky' },
    ],
  },
});

/** 一条委托有几个判定段(认不出的档位给 0 —— 不猜)。 */
export function stepsFor(tier) {
  return QUEST_CHECKS[String(tier ?? '')]?.steps ?? [];
}

/**
 * **把看板那一行的档位认成判定池的键**(纯函数)。
 *
 * ⚠️ 为什么需要它:`economy.js` 的 `TASK_TIERS` 用**英文 id**(`trivial`/`normal`/`hard`/`fiasco`),
 *    而 1.50.0 起 QQ 与面板落库的那一行 `tier` 用的是**中文标签**("普通"/"危险")——
 *    同一个东西两套写法。这里把两套都认下来(不猜:认不出返回 null,`openQuest` 会拒)。
 */
export function resolveQuestTier(tier) {
  const text = String(tier ?? '').trim();
  if (text === '') return null;
  if (QUEST_CHECKS[text]) return text;
  const byLabel = {
    跑腿小活: 'trivial', 送信: 'trivial', 找猫: 'trivial',
    正经委托: 'normal', 普通: 'normal', 清怪: 'normal', 护卫: 'normal',
    危险委托: 'hard', 危险: 'hard',
    看着就不对劲的活: 'fiasco', 搞砸: 'fiasco',
  };
  return byLabel[text] ?? null;
}

/**
 * 结算的**评级**(纯函数):按"成功过多少段"给倍率(`docs\08` 3.2 的 base + bonus + penalty)。
 *
 * ⚠️ 刻意**不是**"失败几次扣多少"的连续公式:评级要**枚举化、可解释**
 *    (用户要的"能解释"就在这一条上:需要 ≥10 而你掷到 8)。
 * ⚠️ **一段都没有**(认不出档位时)按 `success` 处理 —— 但那种委托本来也不该被接
 *    (`openQuest` 会把它挡掉)。
 */
export function gradeFor({ succeeded = 0, failed = 0, total = 0 } = {}) {
  if (total <= 0) return { id: 'success', label: '成功', multiplier: 1 };
  if (succeeded === total) return { id: 'crit_success', label: '大成功', multiplier: 1.5 };
  if (failed === 0) return { id: 'success', label: '成功', multiplier: 1 };
  if (failed < total) return { id: 'partial', label: '勉强完成', multiplier: 0.8 };
  return { id: 'fail', label: '砸了', multiplier: 0 };
}

/** 委托那一趟的存储键:`quest:<看板键>`(⚠️ 与 `quest.accept` 用的看板键区分开)。 */
export function questRunKey(boardKey) {
  const key = String(boardKey ?? '').trim();
  if (key === '') return null;
  return `quest:${key}`;
}

/** 这条委托现在**允许**哪些动作(**纯函数**;UI 的按钮从它来 —— 于是前端不自己编)。 */
export function legalMoves(state) {
  if (!state || !state.phase) return [];
  if (state.phase === 'process') {
    return [
      { kind: 'quest.step', label: '继续', primary: true },
      { kind: 'quest.abandon', label: '放弃（押金不退）' },
    ];
  }
  return [];
}

/** 阶段名(面板与 QQ 报幕共用一套说法)。
 * ⚠️ 名字不能叫 `phaseLabel` —— `play/index.js` 是**星号导出**,
 *    而 `fishing.js` 已经有一个同名的(冲突会让整个模块树加载失败,selftest 第一行就红)。
 */
export function questPhaseLabel(state) {
  if (!state || !state.phase) return null;
  if (state.phase === 'settled') return state.settle?.label ? `已结算（${state.settle.label}）` : '已结算';
  if (state.phase === 'abandoned') return '放弃了';
  const done = (state.results ?? []).length;
  const total = stepsFor(state.tier).length;
  return `第 ${Math.min(done + 1, Math.max(total, 1))} 段 / 共 ${total} 段`;
}

/** “现在该干什么”(给页面的那一行)。 */
export function objectiveText(state) {
  if (!state || state.phase !== 'process') return null;
  const steps = stepsFor(state.tier);
  const next = steps[(state.results ?? []).length];
  return next ? next.text : '收尾';
}

/**
 * **接下一条委托**(纯函数):从看板那一行开一局。
 *
 * ⚠️ **押金与期限**是 `docs\08` 3.2 点名的字段:`deadline_tick`(这一版用真实时间)
 *    与 `accept_fee`(这一版用"违约金"那一栏当押金的风险敞口:失败时按 `penalty` 赔)。
 * ⚠️ 认不出档位 / 行形状不对 → `null`(**不猜**)。
 *
 * @param {object} row 看板上那一行(`economy.js` 的 `rollQuestBoard` 产出的形状)
 * @param {{now?: number, ttlMs?: number, runId?: string}} [options]
 */
export function openQuest(row, { now = Date.now(), ttlMs = 6 * 60 * 60_000, runId = null } = {}) {
  if (!row || typeof row !== 'object') return null;
  // ⚠️ 档位有两套写法(英文 id / 中文标签)—— `resolveQuestTier` 认得出就归一,
  //    认不出返回 null(这一局**不接**,而不是拿一套瞎凑的判定去跑)。
  const tier = resolveQuestTier(row.tier);
  if (!tier) return null;
  const steps = stepsFor(tier);
  if (steps.length === 0) return null;
  const at = Number(now) || Date.now();
  return {
    v: 1,
    runId: runId ?? `q${at.toString(36)}`,
    phase: 'process',
    tier,
    /** 看板那一行原本的档位写法(中文标签 / 英文 id)—— 落账时照实记,不改写它。 */
    tierRaw: row.tier ?? null,
    // ⚠️ 看板那一行的 label 是给人看的(「危险委托（差点回不来）」),判定池的 label 更短 ——
    //    这一局用**看板那个**,因为回执要跟玩家刚点的那一条对得上。
    label: String(row.label ?? QUEST_CHECKS[tier]?.label ?? tier),
    baseReward: Math.max(0, Number(row.reward) || 0),
    penalty: Math.min(0, Number(row.penalty) || 0),
    stamina: Math.max(0, Number(row.stamina) || 0),
    line: row.line ?? null,
    acceptedAt: at,
    deadlineAt: at + Math.max(60_000, Number(ttlMs) || 0),
    checks: [],
    results: [],
    settle: null,
  };
}

/** 骰值:两颗 d6(纯函数,`rng` 注入)。 */
export function roll2d6(rng = Math.random) {
  const d1 = 1 + Math.floor(rng() * QUEST_DICE.faces);
  const d2 = 1 + Math.floor(rng() * QUEST_DICE.faces);
  return { d1, d2, roll: d1 + d2 };
}

/**
 * 跑一段(**唯一的判定入口**;纯函数)。
 *
 * @param {object} state
 * @param {{now?: number, rng?: () => number}} [ctx]
 * @returns {{state: object, events: object[], lines: string[]}}
 */
export function questAction(kind, state, action = {}, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;

  if (kind === 'quest.step') {
    if (!state || state.phase !== 'process') {
      return { state: state ?? null, events: [{ type: 'warn', reason: 'not_in_process' }], lines: ['（这一局委托已经不在过程里了。）'] };
    }
    // 期限:过了就算砸了(不静默 —— 如实说)
    if (Number(state.deadlineAt) > 0 && now > Number(state.deadlineAt)) {
      return settleQuest(state, { now, expired: true });
    }
    const steps = stepsFor(state.tier);
    const index = (state.results ?? []).length;
    const step = steps[index];
    if (!step) return settleQuest(state, { now });
    const { d1, d2, roll } = roll2d6(rng);
    // ⚠️ **角色能力从这里进来**(1.104.0 / D168):每一步自带一个 `kind`(`lawful` / `tricky`),
    //    而这一位 `mod` 一直是 0 —— 它就是留给"这个角色在这一类事上有多强"的接口。
    //    ⚠️ 注入而不是 import:`quest.js` 不认识角色卡(纯函数、可单测),谁来跑这一轮由**调用方**给。
    const actorMod = Number(typeof ctx.modFor === 'function' ? ctx.modFor(step.kind) : 0) || 0;
    const stepMod = Number(step.mod) || 0;
    const mod = stepMod + actorMod;
    const margin = roll + mod - Number(step.dc);
    const tier = dcTierFor(margin);
    const ok = tier.id === 'success' || tier.id === 'crit_success';
    const check = {
      at: now, kind: step.kind, stepId: step.id, text: step.text,
      dc: Number(step.dc), mod, stepMod, actorMod, d1, d2, roll, tier: tier.id, margin, ok,
    };
    const results = [...(state.results ?? []), { kind: step.kind, stepId: step.id, tier: tier.id, margin, at: now }];
    const next = { ...state, checks: [...(state.checks ?? []), check], results };
    const modText = mod === 0 ? '' : (mod > 0 ? ` + ${mod}` : ` − ${Math.abs(mod)}`);
    const line = `${step.text} —— ${tier.label}（需要 ≥${step.dc}，两颗骰子 ${roll}${modText} = ${roll + mod}）`;
    const checkEvents = [{ type: 'quest_check', stepId: step.id, tier: tier.id, dc: Number(step.dc), roll, mod, stepMod, actorMod, margin }];
    // 最后一段跑完就**自动进结算**(少一次点击;结算也是纯函数那一段)
    if (results.length >= steps.length) {
      const settled = settleQuest(next, { now });
      // ⚠️ **两边的 events 都要留**:结算会返回它自己那一条(`quest_settled`),
      //    而"最后一段的判定"那一条不能因此被丢掉 —— 丢了它,库里就查不到那一段的 `dc/roll`
      //    (`docs\08` 3.2 判据①);测试当场抓到(只剩 1 条 check)。
      return { ...settled, events: [...checkEvents, ...settled.events], lines: [line, ...settled.lines] };
    }
    return {
      state: next,
      events: checkEvents,
      lines: [line],
    };
  }

  // **显式结算**:正常那一路是"最后一段跑完自动结算",但界面/调用方也可以直接结算
  // (比如"提前收工"),所以这里留一个入口 —— 它和自动那条走**同一个** `settleQuest`。
  if (kind === 'quest.settle') return settleQuest(state, { now });

  if (kind === 'quest.abandon') {    if (!state || state.phase !== 'process') {
      return { state: state ?? null, events: [{ type: 'warn', reason: 'not_in_process' }], lines: ['（这一局委托已经不在过程里了。）'] };
    }
    const at = now;
    const penalty = Math.min(0, Number(state.penalty) || 0);
    return {
      state: { ...state, phase: 'abandoned', settle: { at, grade: 'abandoned', label: '放弃了', base: 0, multiplier: 0, bonus: 0, penalty, paid: penalty, line: '半路放弃，押金不退' } },
      events: [{ type: 'quest_abandoned', penalty }],
      lines: ['（放弃了这条委托 —— 押金不退。）'],
    };
  }

  return { state: state ?? null, events: [{ type: 'warn', reason: 'unknown_quest_action', kind }], lines: [] };
}

/**
 * **结算**(纯函数;也可以由"期限到了"直接调)。
 *
 * 钱的三分项与 `docs\08` 3.2 对得上:**基础 + 加成 − 惩罚**:
 *   · `base` = 看板上那一条的**基础报酬**(原样,不乘倍率);
 *   · `bonus` = 评级带来的加成(`倍率 − 1`,大成功那一档正好是一半);
 *   · `penalty` = 委托自带的那一条(负数),**只有 `fail` / 放弃 / 过期才扣**
 *     —— "失败不一定受伤"那条口径落在**过程**里,结算只认评级。
 */
export function settleQuest(state, { now = Date.now(), expired = false } = {}) {
  if (!state || state.phase !== 'process') {
    return { state: state ?? null, events: [{ type: 'warn', reason: 'not_in_process' }], lines: ['（这一局委托已经结算过了。）'] };
  }
  const at = Number(now) || Date.now();
  const total = stepsFor(state.tier).length;
  const succeeded = (state.results ?? []).filter((row) => row.tier === 'success' || row.tier === 'crit_success').length;
  const failed = (state.results ?? []).length - succeeded;
  const grade = expired ? { id: 'expired', label: '过期作废', multiplier: 0 } : gradeFor({ succeeded, failed, total });
  // ⚠️ `base` 是**看板那一条的原值**,倍率通过 `bonus` 体现 —— 第一版把倍率乘进 base 又加一次 bonus,
  //    于是大成功算成 500×1.5+250=1000(凭空多了 250;测试当场抓到)。
  const base = Math.max(0, Number(state.baseReward) || 0);
  // ⚠️ 钱**只由倍率决定**:`报酬 × 倍率`,再加减那条违约/赔偿。
  //    这样三分项与 `docs\08` 3.2 对得上(基础 × 评级倍数 + 加成 − 惩罚),而且两种坏写法都躲开了:
  //    · 第一版把倍率乘进 base **又**加一次 bonus → 大成功算成 1000(凭空多 250);
  //    · 第二版让 bonus 取 `base×(倍率−1)` → 失败那一档算出 −900,把"砸了"变成"倒赚 800"。
  const paidBase = Math.round(base * Number(grade.multiplier));
  const bonus = Math.max(0, paidBase - base);
  const penalty = (grade.id === 'fail' || grade.id === 'expired' || grade.id === 'abandoned')
    ? Math.min(0, Number(state.penalty) || 0)
    : 0;
  const paid = Math.max(0, paidBase) + penalty;
  const parts = [
    `${grade.label}`,
    `${succeeded}/${total} 段成功`,
  ];
  if (paidBase > 0) parts.push(`基础 ${base}${bonus ? ` + 加成 ${bonus}` : ''}`);
  if (penalty !== 0) parts.push(`赔偿 ${penalty}`);
  const coin = CURRENCY.name;
  return {
    state: {
      ...state,
      phase: 'settled',
      settle: { at, grade: grade.id, label: grade.label, base, multiplier: grade.multiplier, bonus, penalty, paid, line: parts.join('，') },
    },
    events: [{ type: 'quest_settled', grade: grade.id, base, bonus, penalty, paid, total, succeeded }],
    lines: [`【委托结算】${parts.join('，')} → 到手 ${paid} ${coin}`],
  };
}

/**
 * 一句**模板回执**(拔掉 LLM 也要能跑通的那一层)。
 *
 * ⚠️ 它就是 `docs\08` 3.2 判据②的落点:这条链路**不经过模型** ——
 *    调用方可以直接把 `lines` 发出去(面板现在就是这么做的)。
 */
export function describeQuestRun(state) {
  if (!state) return '（没有正在进行的委托。）';
  const head = `【委托】${state.label}（期限 ${new Date(Number(state.deadlineAt)).toTimeString().slice(0, 5)}）`;
  const done = (state.results ?? []).map((row, at) => `${at + 1}. ${dcTierFor(row.margin).label}（${row.margin >= 0 ? '+' : ''}${row.margin}）`);
  const tail = state.phase === 'process'
    ? `下一步：${objectiveText(state) ?? '收尾'}`
    : (state.settle?.line ?? '');
  return [head, ...done, tail].filter(Boolean).join('\n');
}
