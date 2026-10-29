/**
 * **钓鱼回路的纯内核**(D105 第①步:从 `src\index.js` 抽出来)。
 *
 * 抽出来的是**判定与状态迁移**,不是"发消息":
 *
 *     applyAction('fishing.begin' | 'fishing.cast' | 'fishing.reel_in'
 *                 | 'fishing.settle' | 'fishing.tick', state, action, ctx)
 *       -> { state, events[], lines[] }
 *
 * 调用方(适配器)负责:读/写 `meta`、发消息、调模型写台词、落 `stats_event`。
 *
 * ⚠️ **台词的分工**(沿用 D102 与 1.61.0 的口径):
 *   - **事实与操作提示由代码给**(`lines` + `buildFishingFlavorPrompt` 的 `fallback`),
 *     因为"鱼篓里有什么、值多少、有哪几个处置选项"不许由模型编;
 *   - **过程与感受交给模型写**(用户 2026-10-02:「每条播报的内容要随机性更强,交给 llm 写」)——
 *     模型写的那一段由适配器用 `action.flavor` 传进来,内核只负责把它与事实拼在一起。
 *     模型超时/沉默 → 传 `null`,内核用 `buildFishingFlavorPrompt()` 的兜底句。
 *
 * ⚠️ **判据(用户当场给的)**:selftest 全绿 **且 QQ 行为一字不变** ——
 *    所以这里的每一条 `lines` 都是**逐字照抄**原来 `src\index.js` 里的字符串。
 */

import { result } from './action.js';
import {
  FISH_BAITS,
  FISH_HANDLING,
  FISH_MAX_WAIT_MS,
  FISH_MIN_WAIT_MS,
  FISH_TABLE,
  FISHING_SPOTS,
  fishTableWeight,
} from '../company.js';
import { CURRENCY } from '../stats.js';
import { FISHING_NAME_PATTERN } from '../local-infra-content.js';

// ---------------------------------------------------------------------------
// 常量(原来散在 `src\fishing.js` 里的那一批;现在**内核**是它们的家)
// ---------------------------------------------------------------------------

/** "选饵"这一步最多等多久(等到就替她挑一个,别卡着)。 */
export const FISH_BAIT_TIMEOUT_MS = 5 * 60_000;
/** 分鱼(吃/卖/风干)给多久决定,超时就默认全卖。 */
export const FISH_KEEP_TIMEOUT_MS = 10 * 60_000;
/**
 * **多久没人理就自己收杆回家**(用户 ⑤:替掉"只能钓三条"那个限制)。
 * 判据是"这一局最后一次有人说话"起算 —— 期间有人聊别的也算有人(她还在陪着钓)。
 */
export const FISH_IDLE_TIMEOUT_MS = 30 * 60_000;

/** 档位的中文名(提示词与兜底台词都要用,免得把 `treasure` 念出来)。 */
export const TIER_LABELS = {
  fish: '普通的鱼',
  junk: '杂物',
  rare: '少见的好东西',
  treasure: '值钱的宝贝',
  legend: '传说中的东西',
};

/** 她主动"要去钓鱼"的说法(自然语言触发;**代码判据**,不靠模型)。 */
const FISHING_TRIGGER = [
  /去?钓鱼/,
  /钓鱼(去|吧|吗|不)/,
  FISHING_NAME_PATTERN,
  /\/钓鱼/,
];

// ---------------------------------------------------------------------------
// 纯判定(原来在 `src\fishing.js`,一并搬进内核 —— 网页端也要用同一套)
// ---------------------------------------------------------------------------

/** 这句话是不是在叫她/跟她去钓鱼(纯函数)。 */
export function detectFishing(text) {
  const source = String(text ?? '').trim();
  if (source === '' || source.length > 60) return false;
  return FISHING_TRIGGER.some((re) => re.test(source));
}

/**
 * 钓位的**存储键**(纯函数):`fishing:<scene>:<targetId>:<userId>` —— **按人**,不是按会话。
 *
 * ⚠️ 第一版按会话存,于是一个群只能有**一个**钓位(用户 2026-10-02:「@ 主实例好像同时
 *    只有一个人能钓鱼」)。三段都用 `:` 分隔,**三段都不含冒号**(QQ 的 openid/群号是十六进制)。
 */
export function fishingKey({ scene = 'c2c', targetId = '', userId = 'anon', appId = '' } = {}) {
  const place = scene === 'group' ? targetId : appId;
  return `fishing:${scene === 'group' ? 'group' : 'c2c'}:${place}:${userId || 'anon'}`;
}

/** 从键里解出"这是谁、在哪儿钓"(纯函数)。 */
export function parseFishingKey(key) {
  const [, scene, targetId, userId] = String(key ?? '').split(':');
  return { scene: scene === 'group' ? 'group' : 'c2c', targetId, userId };
}

/** 随机取一个水域+钓点、给几个鱼饵(纯函数)。 */
export function startFishing({ now = Date.now(), random = Math.random } = {}) {
  const where = FISHING_SPOTS[Math.floor(random() * FISHING_SPOTS.length)] ?? FISHING_SPOTS[0];
  const baits = [...FISH_BAITS].sort(() => random() - 0.5).slice(0, 3);
  return {
    phase: 'bait',
    water: where.water,
    spot: where.spot,
    baits,
    casts: 0,
    /** 鱼篓:钓到的都先放这儿(**收杆才结算**)。 */
    basket: [],
    startedAt: now,
    lastTouchAt: now,
    dueAt: null,
    userId: null,
    userName: null,
  };
}

/** 等动静要多久(3~8 分钟随机)。 */
export function waitMs(random = Math.random) {
  return Math.round(FISH_MIN_WAIT_MS + random() * (FISH_MAX_WAIT_MS - FISH_MIN_WAIT_MS));
}

/** 这一句像不像"在选饵"(纯函数)。**不像就不许吃掉这条消息**。 */
export function looksLikeBaitAnswer(state, text) {
  const source = String(text ?? '').trim();
  if (source === '') return false;
  if (/^[123]$/.test(source)) return true;
  if (/(随便|都行|听你的|你挑|哪样都)/.test(source)) return true;
  return (state?.baits ?? []).some((row) => source.includes(row.label));
}

/** 从"选饵"的话里挑出那一饵(纯函数)。 */
export function pickBait(state, text) {
  const source = String(text ?? '');
  const byName = state.baits.find((row) => source.includes(row.label));
  if (byName) return byName;
  const byIndex = state.baits.find((row, at) => source.trim() === String(at + 1));
  return byIndex ?? state.baits[0];
}

/**
 * **库外的饵,看好感度答不答应**(纯函数)。2026-10-03 从 `src\fishing.js` 搬进内核(D109):
 * 它带**概率**,所以第二个前端(小网站)不该自己再实现一份(两套判定必然分叉)。
 *
 * 用户原话:「同面对用户提出举例以外的鱼饵时也**看好感度**答应」——
 * 越亲近越愿意陪他胡闹(交心 90% / 朋友 75% / 说得上话 50% / 认得 25% / 眼熟 10%)。
 *
 * ⚠️ **台词不许写死在某个角色的口吻里**(用户实测:「**副实例**钓鱼换鱼饵好感不够的台词**串台了**」)。
 *    所以这里只回**中性的事实**(答不答应、概率),话由**模型按自己角色的口吻**写。
 * ⚠️ `random` 必须能注入(默认给 `Math.random` 只是方便直接调用 —— 适配器一律显式传)。
 *
 * @returns {{accept: boolean, chance: number, line: string, bait: object|null}}
 */
export function judgeCustomBait({ name = '', tierId = 'stranger', random = Math.random } = {}) {
  const label = String(name ?? '').trim();
  if (label === '') return { accept: false, chance: 0, line: '', bait: null };
  const chance = {
    close: 0.9, friend: 0.75, talked: 0.5, known: 0.25, stranger: 0.1,
  }[tierId] ?? 0.1;
  if (random() < chance) {
    return {
      accept: true,
      chance,
      // 中性兜底(不带口癖):真正的台词交给模型
      line: `（${label} 当饵 —— 答应了。）`,
      bait: { id: `custom:${label}`, label, good: true, custom: true },
    };
  }
  return {
    accept: false,
    chance,
    line: `（${label} 当饵 —— 不肯。）`,
    bait: null,
  };
}

/**
 * 这句话是不是**在提一个库外的饵**(纯函数)。
 * 「用XX当饵」「拿XX钓鱼」两种说法都要认 —— 第一种测出来时我漏了第二种。
 */
export function looksLikeBaitSuggestion(text) {
  const source = String(text ?? '').trim();
  if (source === '' || source.length > 40) return false;
  return /(用|拿|换|改用).{1,12}?(当|做|作|当个)?(饵|鱼饵)/.test(source)
    || /(用|拿|换|改用).{1,12}?钓/.test(source)
    || /(.{1,12}?)(能|可以|行不行|能不能)(当|做|作)?(饵|鱼饵)/.test(source);
}

/** 从"用XX当饵"里把那个东西的名字抠出来(纯函数;抠不到返回 null)。 */
export function extractBaitName(text) {
  const source = String(text ?? '').trim();
  const match = /(?:用|拿|换|改用)(.{1,12}?)(?:当|做|作)?(?:饵|鱼饵)/.exec(source)
    ?? /(?:用|拿|换|改用)(.{1,12}?)(?:当|做|作)?钓/.exec(source)
    ?? /(.{1,12}?)(?:能|可以|行不行|能不能)(?:当|做|作)?(?:饵|鱼饵)/.exec(source);
  const name = match?.[1]?.trim();
  return name && name.length >= 1 ? name : null;
}

/** 按权重抽一档战利品,并在档内取一个钱数与名字(纯函数)。 */
export function rollCatch(random = Math.random) {
  const total = fishTableWeight();
  let roll = random() * total;
  let row = FISH_TABLE[FISH_TABLE.length - 1];
  for (const item of FISH_TABLE) {
    roll -= item.weight;
    if (roll < 0) { row = item; break; }
  }
  const name = row.names[Math.floor(random() * row.names.length)] ?? row.names[0];
  const money = Math.round(row.money[0] + random() * (row.money[1] - row.money[0]));
  return { tier: row.id, kind: row.kind, name, money };
}

/**
 * 收杆的说法(纯函数)。
 *
 * ⚠️ **不许太宽**(2026-10-03 现场:用户在钓鱼中聊到"回家了/走了",就被当成收杆,
 * 而且**状态已经是"分鱼"了还再收一次**,于是同一份鱼篓被反复播报 —— 看起来就是"收杆卡住了")。
 * 所以只留**明确在说收杆**的词;"回家/走了"这种日常话不再算。
 */
export function detectReelIn(text) {
  const source = String(text ?? '');
  return /(收杆|收竿|不钓了|不钓啦|收工|够吃了|别钓了|收了吧)/.test(source);
}

/**
 * **鱼篓汇总**(纯函数):按档位分组 + 总价值。**收杆那一刻**用它结算与询问。
 *
 * ⚠️ `items` 是 1.82.0 加的(**按"档位 + 名字"合并**):面板上原来把 15 件东西
 *    平铺成一行逗号串(`泥鳅、鲫鱼、泥鳅、半个木桶、…`),既看不出**几件**、
 *    也看不出**值多少** —— 用户 2026-10-05 说"接着优化主实例钓鱼的状态面板"时,
 *    第一眼看到的就是那一行。合并与排序都在**内核**里做,面板只渲染(两种视图同一份事实)。
 *    排序:先按小计(值钱程度),再按件数 —— "最该留意的排最上面"。
 */
export function summarizeBasket(state) {
  const basket = state?.basket ?? [];
  const total = basket.reduce((sum, row) => sum + (Number(row.money) || 0), 0);
  const byKind = {};
  const byName = new Map();
  for (const row of basket) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    const key = `${row.tier ?? row.kind ?? '?'}|${row.name ?? '?'}`;
    const at = byName.get(key) ?? {
      name: row.name ?? '（没有名字的东西）',
      tier: row.tier ?? row.kind ?? null,
      tierLabel: TIER_LABELS[row.tier ?? row.kind] ?? null,
      count: 0,
      money: Number(row.money) || 0,
      subtotal: 0,
    };
    at.count += 1;
    at.subtotal += Number(row.money) || 0;
    byName.set(key, at);
  }
  const items = [...byName.values()].sort((a, b) => (b.subtotal - a.subtotal) || (b.count - a.count));
  return { count: basket.length, total, byKind, distinct: items.length, items, basket };
}

/**
 * **这一步叫什么**(纯函数;面板上那枚阶段徽章与日志共用)。
 *
 * ⚠️ 名字只写在**内核**里:面板要是自己写一张 `{waiting: '等鱼上钩'}` 的表,
 *    那就成了"同一件事两份说法"(D105 起一直在防的那种)。
 */
export function phaseLabel(state) {
  if (!state?.phase) return null;
  if (state.phase === 'bait') return '选鱼饵';
  if (state.phase === 'waiting') return '等鱼上钩';
  if (state.phase === 'choosing') return '挑怎么处置';
  return null;
}

/** **按档位给处置选项**(用户④:"钓上了不同档位的东西要**配套不同的处理方法**")。 */
export function handlingFor(state) {
  const kinds = new Set((state?.basket ?? []).map((row) => row.kind));
  const ids = [];
  if (kinds.has('fish')) ids.push('grill', 'boil', 'sell', 'dry');
  if (kinds.has('junk')) ids.push('toss', 'keep_junk');
  if (kinds.has('rare') || kinds.has('treasure') || kinds.has('legend')) ids.push('sell_precious', 'keep_precious');
  if (ids.length === 0) ids.push('sell');
  return ids.map((id) => FISH_HANDLING.find((row) => row.id === id)).filter(Boolean);
}

/** 档位分组:一句话里提到哪一类东西。 */
const KIND_WORDS = {
  fish: /(鱼|鱼们|钓上来的|这些鱼)/,
  junk: /(杂物|垃圾|没用的|水草|破|烂)/,
  precious: /(值钱|好东西|宝贝|稀有|秘宝|贵的)/,
};

/** 认她选的是哪种处置(**按档位分组**;纯函数)。认不出返回 null。 */
export function detectHandling(text, options = FISH_HANDLING) {
  const source = String(text ?? '');
  if (source === '') return null;
  const hasPrecious = KIND_WORDS.precious.test(source);
  const hasJunk = KIND_WORDS.junk.test(source);
  const pick = (wanted, alternates = []) => {
    for (const id of [wanted, ...alternates]) {
      if (options.some((row) => row.id === id)) return id;
    }
    return null;
  };
  // ⚠️ **先看"对象"再看"动作"**(用户实测:"都卖了吧"原来命中了"卖掉"→ 被当成只卖值钱的)。
  if (/烤|架火|碳火/.test(source)) return pick('grill', ['fry', 'boil', 'sell']);
  if (/煮|汤|炖/.test(source)) return pick('boil', ['grill', 'fry', 'sell']);
  if (/煎|下锅|炒|吃|吃掉|啃/.test(source)) return pick('grill', ['fry', 'boil', 'sell']);
  if (/风干|挂起来|晾起来/.test(source)) return pick('dry', ['keep_precious']);
  if (/卖|出手|折现|换钱|变现|处理掉/.test(source)) {
    return hasPrecious ? pick('sell_precious', ['sell']) : pick('sell', ['sell_precious']);
  }
  if (/留着|收着|存着|收藏|摆着|收起来/.test(source)) {
    if (hasPrecious) return pick('keep_precious', ['keep_junk']);
    if (hasJunk) return pick('keep_junk', ['keep_precious']);
    return pick('keep_precious', ['keep_junk']);
  }
  if (/扔|丢|不要了|没用|清掉/.test(source)) return pick('toss', ['keep_junk']);
  return null;
}

/**
 * **把一句话拆成"哪一类怎么处理"的计划**(纯函数)。
 *
 * 用户 2026-10-03 的原话:「钓上来很多不同的东西,口头告诉她处理方法**她有时候听不懂**」——
 * 人的说法天然是**分组**的:「鱼烤了、杂物扔了、值钱的留着」「都卖了吧」。
 *
 * @returns {Array<{handling: string, kinds: string[]}>|null} null = 一句都没听懂(调用方**要反问**)
 */
export function parseHandlingPlan(text, options = FISH_HANDLING) {
  const source = String(text ?? '').trim();
  if (source === '') return null;
  const fragments = source
    .split(/[，,。；;、！!?？\n]+|(?:然后|接着|剩下|其余|其他的|别的)/)
    .map((part) => part.trim())
    .filter(Boolean);
  const plan = [];
  for (const fragment of fragments) {
    const handling = detectHandling(fragment, options);
    if (!handling) continue;
    const kinds = Object.entries(KIND_WORDS)
      .filter(([, re]) => re.test(fragment))
      .map(([kind]) => kind);
    const option = options.find((row) => row.id === handling);
    const inferred = option?.kinds ?? ['fish'];
    plan.push({ handling, kinds: kinds.length > 0 ? kinds : (handling === 'sell' ? ['all'] : inferred) });
  }
  return plan.length > 0 ? plan : null;
}

/** 这句话**像不像在说怎么处理**(纯函数)。用来决定"听不懂"时**要不要反问**。 */
export function looksLikeHandlingTalk(text) {
  return /(处理|怎么|吃掉|吃了|烤|煮|煎|炖|卖|留|扔|丢|风干|收起来|带走|折现)/.test(String(text ?? ''));
}

/**
 * **鱼篓 → 数值**(纯函数;收杆之后才用它)。钱与饱食都由这里给,不由模型编。
 * 支持**分组**:每一条计划只管它那一类东西(不然"值钱的卖掉"会按鱼价六成把宝物贱卖)。
 */
export function settleBasket(state, handlingId) {
  return settleBasketPlan(state, [{ handling: handlingId, kinds: ['all'] }]);
}

/** **按计划结算**(纯函数)。`plan` 来自 `parseHandlingPlan()`。 */
export function settleBasketPlan(state, plan = []) {
  const basket = state?.basket ?? [];
  const covered = new Set();
  const effect = { money: 0, satiety: 0, mood: 0, health: 0 };
  const lines = [];
  const runs = [];

  const kindsOf = (row) => (row.kind === 'rare' || row.kind === 'treasure' || row.kind === 'legend' ? 'precious' : row.kind);

  for (const step of plan) {
    const option = FISH_HANDLING.find((row) => row.id === step.handling);
    if (!option) continue;
    const target = basket
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => !covered.has(index)
        && (step.kinds.includes('all')
          || step.kinds.includes(kindsOf(row))
          || step.kinds.includes(row.kind)));
    if (target.length === 0) continue;
    const total = target.reduce((sum, item) => sum + (Number(item.row.money) || 0), 0);
    if (option.id === 'sell') effect.money += Math.round(total * 0.6);
    else if (option.id === 'sell_precious') effect.money += total;
    if (Number(option.effect?.satiety)) effect.satiety += Number(option.effect.satiety) / 3;
    if (Number(option.effect?.mood)) effect.mood += Number(option.effect.mood) / 3;
    if (Number(option.effect?.health)) effect.health += Number(option.effect.health) / 3;
    for (const item of target) covered.add(item.index);
    const names = target.map((item) => item.row.name).join('、');
    runs.push({ handling: option.id, label: option.label, count: target.length, money: total, names });
    lines.push(`${option.label}：${names}`);
  }

  // 计划没管到的东西:**默认卖掉**(钱不会凭空消失),而且和"说了卖掉"一个价(六成)。
  const leftover = basket.filter((_, index) => !covered.has(index));
  if (leftover.length > 0) {
    const total = leftover.reduce((sum, row) => sum + (Number(row.money) || 0), 0);
    effect.money += Math.round(total * 0.6);
    runs.push({ handling: 'sell', label: '剩下的卖掉', count: leftover.length, money: total, names: leftover.map((row) => row.name).join('、') });
    lines.push(`剩下的卖掉：${leftover.map((row) => row.name).join('、')}`);
  }

  const summary = summarizeBasket(state);
  // ⚠️ **`effect.homeItem` 是空头支票**(2026-10-03 补):`FISH_HANDLING` 里 `dry` / `keep_*`
  //    都声明了 `homeItem`,但**它不是一个数值**,`applyStory` 的绑定表按 `ALL_STATS` 过滤,
  //    所以这些东西**哪儿都没落** —— 玩家选了"带回家风干",账上什么也不会多。
  //    真正的落点(家园/典当铺)是 D100 那一批的事;在那之前**如实记账**,别假装成功:
  //    把它列进 `state.homeItems`,让面板/台词说得清"哪些没带走"。
  const homeItems = [];
  for (const run of runs) {
    const option = FISH_HANDLING.find((row) => row.id === run.handling);
    if (!option?.effect?.homeItem) continue;
    homeItems.push({ key: option.effect.homeItem, handling: run.handling, count: run.count, available: false });
  }
  return {
    effect,
    option: FISH_HANDLING.find((row) => row.id === plan[plan.length - 1]?.handling) ?? FISH_HANDLING[0],
    summary,
    runs,
    lines,
    homeItems,
  };
}

/** 收杆:进入"怎么处置"这一步。⚠️ 鱼篓空的时候**不用问**(纯函数)。 */
export function reelIn(state, { now = Date.now() } = {}) {
  const summary = summarizeBasket(state);
  if (summary.count === 0) return { state: null, summary, empty: true };
  return {
    state: { ...state, phase: 'choosing', choosingUntil: now + FISH_KEEP_TIMEOUT_MS, lastTouchAt: now },
    summary,
    empty: false,
  };
}

/** 该自动收杆了吗(太久没人理)。**纯函数**。 */
export function shouldAutoReel(state, now = Date.now()) {
  if (!state || state.phase === 'choosing') return false;
  return now - (state.lastTouchAt ?? state.startedAt ?? now) > FISH_IDLE_TIMEOUT_MS;
}

/** 到点了吗(纯函数)。**只看钟**。 */
export function catchDue(state, now = Date.now()) {
  return state?.phase === 'waiting' && Number.isFinite(state.dueAt) && now >= state.dueAt;
}

/** **下鱼饵**:从这一步起**开始计时**。此后任何消息都不许改 `dueAt`。 */
export function castLine(state, { now = Date.now(), baitId = null, random = Math.random } = {}) {
  const bait = state.baits.find((row) => row.id === baitId) ?? state.baits[0];
  return {
    ...state,
    phase: 'waiting',
    bait: bait?.id ?? 'worm',
    baitLabel: bait?.label ?? '蚯蚓',
    casts: (state.casts ?? 0) + 1,
    dueAt: now + waitMs(random),
    lastTouchAt: now,
  };
}

/** **钓上一条**:放进鱼篓,**然后自动继续钓**。⚠️ 这里**不落账**。 */
export function addCatch(state, catchRow, { now = Date.now(), random = Math.random } = {}) {
  return {
    ...state,
    basket: [...(state.basket ?? []), catchRow],
    casts: state.casts ?? 1,
    phase: 'waiting',
    dueAt: now + waitMs(random),
    lastTouchAt: now,
  };
}

// ---------------------------------------------------------------------------
// 文案(逐字照抄原来的拼接;两个适配器共用)
// ---------------------------------------------------------------------------

/** **她此刻在干嘛**(日志与"已经在钓了"那一句要用)。 */export function describeFishingState(state, now = Date.now()) {
  if (!state) return '（没在钓鱼）';
  const caught = (state.basket ?? []).length;
  if (state.phase === 'bait') return `在${state.water}的${state.spot}，还没下饵`;
  if (state.phase === 'waiting') {
    const left = Math.max(0, Math.round(((state.dueAt ?? now) - now) / 1000));
    return `在${state.water}的${state.spot}下着饵（还有约 ${left} 秒，鱼篓 ${caught} 条）`;
  }
  if (state.phase === 'choosing') return `刚收杆（鱼篓 ${caught} 条），正问怎么处理`;
  return '（没在钓鱼）';
}

/** 开局那一条:水域 + 钓点 + 三种饵(立刻给,不过模型)。 */
export function baitLines(state) {
  const baitList = state.baits.map((row, at) => `${at + 1}. ${row.label}`).join('　');
  return `去${state.water}的${state.spot}吧。\n鱼饵用哪种？${baitList}（回个 1/2/3，或者直接说名字。）\n`
    + '（在岸边找了个位置坐下，一边晃腿一边等你挑。）';
}

/** 已经在钓了:回一句现状,别重复开局。 */
export function alreadyFishingLine(state, now = Date.now()) {
  return `（已经在钓了——${describeFishingState(state, now)}。）`;
}

/** 下饵那一条(不含模型写的过程 —— 那一段在提示词里)。 */
export function castMessage(state, now = Date.now()) {
  const minutes = Math.round((state.dueAt - now) / 60_000);
  return `下饵了——用${state.baitLabel}。（把浮标甩出去，往后一靠，盯着水面。）大概 ${minutes} 分钟有动静。`;
}

/** 收杆(空)那两条:自动收杆 / 人叫她收杆,说的话不一样。 */
export function emptyReelText({ auto = false } = {}) {
  return auto ? '（半天没动静，吾收杆回去了。）' : '杆收上来了——今天什么也没钓着。';
}

/** 收杆(有货):事实那一行(念出来的是过程,这一行是账)。 */
export function reelSummaryLine(state, summary) {
  // ⚠️ 档位要说**中文**(D104 那条"前端只说档位词"的规矩):原来这里直接印 `row.tier`,
  //    于是鱼篓里会出现 `鳟鱼（fish）` —— 顺着 1.65.0 把文案搬进内核时一起改掉。
  const list = summary.basket.map((row) => `${row.name}（${TIER_LABELS[row.tier] ?? row.tier}）`).join('、');
  const options = handlingFor(state).map((row) => row.label).join(' / ');
  return `鱼篓里：${list}，合起来大概值 ${summary.total} ${CURRENCY.name}。\n怎么处理？${options}。`
    + '（不回的话吾就全卖了。）';
}

/** 分鱼还没听懂:反问那一条。 */
export function unparsedHandlingLine(state) {
  const groups = handlingFor(state).map((row) => row.label).join(' / ');
  return `（没听清哪一样怎么处理。）鱼篓里是：${(state.basket ?? []).map((row) => row.name).join('、')}。\n`
    + `分开说也行，比如「鱼烤了、杂物扔了、值钱的留着」。可选：${groups}。`;
}

/**
 * 群里/私聊里**点名**那个人(用户③:提及做不到就砍掉,改成正文里叫名字)。
 * 不知道名字就返回空串(别硬写"@某人")。
 */
export function namePrefix({ userName } = {}) {
  const name = String(userName ?? '').trim();
  return name ? `${name}，` : '';
}

// ---------------------------------------------------------------------------
// 内核入口
// ---------------------------------------------------------------------------

/**
 * 钓鱼的**类型化动作 reducer**。
 *
 * @param {'fishing.begin'|'fishing.cast'|'fishing.reel_in'|'fishing.settle'|'fishing.tick'} kind
 * @param {object|null} state 当前钓位状态(存在 `meta` 里那一份)
 * @param {object} action 动作载荷
 * @param {object} ctx `{ now, random, userId, userName, appId, scene, targetId }`
 */
export function fishingAction(kind, state, action = {}, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const who = { userId: ctx.userId ?? null, userName: ctx.userName ?? null };

  if (kind === 'fishing.begin') {
    const started = { ...startFishing({ now, random }), ...who };
    return result(started, [{ type: 'fishing_begin', phase: started.phase, water: started.water, spot: started.spot, baits: started.baits }], [baitLines(started)]);
  }

  if (kind === 'fishing.cast') {
    if (state?.phase !== 'bait') return result(state, [{ type: 'fishing_noop', reason: 'not_bait_phase' }], []);
    const bait = action.baitId ? state.baits.find((row) => row.id === action.baitId) : pickBait(state, action.text ?? '');
    const casting = castLine(state, { now, baitId: bait?.id ?? null, random });
    // ⚠️ 名字的优先级是**消息在前、状态在后**(和旧实现一致:说话的人改名了就按新名字叫)。
    const cast = { ...casting, userId: who.userId ?? state.userId ?? null, userName: who.userName ?? state.userName ?? null };
    return result(cast, [{ type: 'fishing_cast', baitId: cast.bait, baitLabel: cast.baitLabel, dueAt: cast.dueAt }], [castMessage(cast, now)]);
  }

  if (kind === 'fishing.reel_in') {
    if (!state) return result(null, [{ type: 'fishing_noop', reason: 'not_fishing' }], []);
    const { state: next, summary, empty } = reelIn(state, { now });
    if (empty) {
      return result(null, [{ type: 'fishing_reel_empty', auto: action.auto === true }], [emptyReelText({ auto: action.auto === true })]);
    }
    // ⚠️ 状态里**只多一个 `water`/`spot`**(提示词要用),其余与 `reelIn()` 的产物一字不差 ——
    //    `action.flavor` 只用来拼这一条消息、**不写进 state**(1.65.1 复核:旧版没这个字段,
    //    把模型那段话塞进 `state.db` 是白占地方,而且会让"状态一致"这条对拍失真)。
    const withPlace = { ...next, water: state.water, spot: state.spot };
    return result(
      withPlace,
      [{ type: 'fishing_reeled', auto: action.auto === true, summary }],
      [action.flavor ?? undefined, reelSummaryLine(next, summary)],
    );
  }

  if (kind === 'fishing.settle') {
    if (!state) return result(null, [{ type: 'fishing_noop', reason: 'not_fishing' }], []);
    const plan = Array.isArray(action.plan)
      ? action.plan
      : [{ handling: action.handling ?? 'sell', kinds: ['all'] }];
    const { effect, summary, runs, lines, homeItems } = settleBasketPlan(state, plan);
    const kindOfEffect = runs.some((run) => ['grill', 'boil', 'fry'].includes(run.handling))
      ? 'meal'
      : runs.some((run) => ['sell', 'sell_precious'].includes(run.handling))
        ? 'fish'
        : 'home';
    return result(
      null,
      [{
        type: 'fishing_settled',
        auto: action.auto === true,
        effect,
        kind: kindOfEffect,
        summary,
        runs,
        // ⚠️ "带回家"的东西**还没地方放**(见 `settleBasketPlan` 的注释)—— 如实带出来,别吞掉
        homeItems,
        detail: {
          kind: kindOfEffect,
          plan: runs.map((run) => `${run.handling}x${run.count}`).join('+'),
          catches: summary.basket.map((row) => `${row.tier}/${row.name}`).join('+').slice(0, 120),
        },
      }],
      [action.flavor ?? null],
    );
  }

  if (kind === 'fishing.tick') {
    if (!state || !state.phase) return result(state, [{ type: 'fishing_noop', reason: 'no_state' }], []);
    // ① 太久没人理 → 自己收杆回家
    if (shouldAutoReel(state, now)) {
      return fishingAction('fishing.reel_in', state, { ...action, auto: true }, ctx);
    }
    // ② 还没选饵且过太久 → 替她挑一个(不能一直卡在第一步)
    if (state.phase === 'bait' && now - state.startedAt > FISH_BAIT_TIMEOUT_MS) {
      return fishingAction('fishing.cast', state, { ...action, text: '' }, ctx);
    }
    // ③ 到点 → 上钩一条,**放鱼篓后接着钓**
    if (catchDue(state, now)) {
      const catchRow = rollCatch(random);
      const next = addCatch(state, catchRow, { now, random });
      const caught = { ...catchRow, tierLabel: TIER_LABELS[catchRow.tier] ?? catchRow.tier };
      return result(
        next,
        [{ type: 'fishing_caught', catch: catchRow, tierLabel: caught.tierLabel, water: state.water, spot: state.spot, count: next.basket.length }],
        [],
      );
    }
    // ④ 分鱼没回话 → 默认全卖(钱不会凭空消失)
    if (state.phase === 'choosing' && Number.isFinite(state.choosingUntil) && now >= state.choosingUntil) {
      return fishingAction('fishing.settle', state, { ...action, handling: 'sell', auto: true }, ctx);
    }
    return result(state, [{ type: 'fishing_noop', reason: 'nothing_due' }], []);
  }

  return result(state, [{ type: 'warn', reason: 'unhandled_fishing_action', kind }], []);
}
