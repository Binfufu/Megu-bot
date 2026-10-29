import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/**
 * **日志 / 编年史**(C 那一刀的后半截;`docs\08` 2.1 的第四个分区)。
 *
 * ## 这一层解决什么
 *
 * 用户 2026-10-07 拍板的 C 是「页面不再打断玩家 + **「你不在的时候」结算**」。
 * 前一半(字段级更新)在 1.94.0 做了;这一半要两样东西:
 *   · **回来时的结算**:你不在的这段时间她做了什么(可关闭的弹窗,不强迫逐条点);
 *   · **日志/编年史**:同一份事实的常驻视图(手机上是第四个 tab)。
 *
 * ## ⚠️ 三条刻意的形状
 *
 * ① **纯派生,不新开存储**:编年史就是 `stats_event` 那张流水表 + 位置事实 ——
 *    它们**本来就在库里**(D99 起每一笔数值改动都有流水)。
 *    新开一张"日志表"= 抄第二份,一定会与流水分叉(这个项目最怕的形状)。
 * ② **只讲"有后果"的事**:全 0 增量的那一类(被搭话 +0/+0、面板审计行)**不进编年史** ——
 *    它们不是"发生了一件事",只是"有人碰了一下"。这正是 `docs\08` 3.3 那条
 *    "只讲有数值后果或钩子已收尾的事"。
 * ③ **措辞由代码拼**(`describeChronicleEntry`):数值与事实不许交给模型编 ——
 *    模型只负责"把这段说得好听"(那一步不在这里)。
 */

/** 哪些事件种类值得进编年史(其余一律丢弃 —— 宁缺毋滥)。 */
export const CHRONICLE_KINDS = Object.freeze(LOCAL_STORY_WORLD?.chronicleKinds ?? {
  meal: '吃了东西',
  fed: '被投喂',
  selfcare: '她自己过日子',
  event: '她自己的小事件',
  story: '她的小事件收了尾',
  quest: '委托',
  fish: '钓鱼',
  sell: '卖东西',
  home: '带回了东西',
  potion: '喝了药',
  sleep: '睡了一觉',
  move: '她出门了',
  // ⚠️ 1.106.4(D176):**生病 / 病好了**原来根本不在这张表里 ——
  //    于是"她病了"这件事**面板与摘要都看不到**(`stats_event` 里明明有 `illness` 这笔)。
  //    用户 2026-10-10 点名"生病"属于**有特殊性、值得记**的那一类,所以补上。
  illness: '生病了',
  heal: '病好了',
});

/** 每一条的"分量"(用来挑"你不在的时候"那几条;数字越大越值得讲)。 */
const WEIGHT = Object.freeze({
  quest: 10,
  story: 9,
  event: 8,
  // ⚠️ 生病 / 病好了 = **9**(暂定,2026-10-10;等用户拍板)——
  //    和"小事件收了尾"同级:它不是数值波动,是**她身上发生过的一件事**。
  illness: 9,
  heal: 9,
  meal: 6,
  selfcare: 6,
  fish: 5,
  home: 5,
  fed: 4,
  move: 4,
  potion: 4,
  sell: 4,
  sleep: 3,
});

/**
 * **"有特殊性的事"的门槛**(1.106.4 / D176)。
 *
 * 用户 2026-10-10 的口径:「她自己**鸡毛蒜皮、有重复性的日常不用记**,**有特殊性的事情可以记**
 * (如接委托受伤、生病、生日等等)。这种**算会话摘要里面**。」
 *
 * 判据**不另立一套**:直接复用编年史这张 `WEIGHT` 表 —— ≥ 8 的是"有特殊性"
 * (委托 10 / 小事件收尾 9 / 生病 9 / 随机事件 8),≤ 6 的是日常(吃饭 6 / 她自己过日子 6 /
 * 钓鱼 5 / 被投喂 4 / 睡一觉 3 …) —— 那些**不进摘要**,只在编年史/面板里留着。
 *
 * ⚠️ 三个数字都是**暂定**(用户只给了方向,2026-10-10 说"先按暂定走"):
 *    门槛 8 / 最多 2 条 / 回溯 24 小时。改这三个就改这一行,别在调用点各写一份。
 */
export const SPECIAL_WEIGHT = 8;
export const SPECIAL_MAX = 2;
export const SPECIAL_WINDOW_MS = 24 * 60 * 60_000;

/**
 * **挑出"值得进摘要"的那几件特殊事**(纯函数;1.106.4 / D176)。
 *
 * 与 `pickAwayHighlights()` 的分工:那个是"**你不在的时候**"弹窗用的(按分量挑,不限种类);
 * 这个是"**她自己记住的**"用的 —— 多一道 `minWeight` 闸门,把日常小事挡在外面。
 *
 * @param {Array<object>} [entries] `buildChronicle()` 的输出
 * @param {{since?: number|null, minWeight?: number, max?: number}} [options]
 */
export function pickSpecialEntries(entries = [], {
  since = null,
  minWeight = SPECIAL_WEIGHT,
  max = SPECIAL_MAX,
} = {}) {
  const from = Number.isFinite(Number(since)) && Number(since) > 0 ? Number(since) : null;
  const floor = Math.max(1, Number(minWeight) || 1);
  return (entries ?? [])
    .filter((row) => (from === null ? true : Number(row?.ts) > from))
    .filter((row) => Number(row?.weight ?? 0) >= floor)
    .sort((a, b) => (Number(b.weight) - Number(a.weight)) || (Number(b.ts) - Number(a.ts)))
    .slice(0, Math.max(1, Number(max) || 1));
}

/**
 * 把挑出来的特殊事拼成**一段话**(纯函数;给摘要提示词用)。
 *
 * ⚠️ 这一段进的是**给模型看的提示词**,不是她要说的台词;`M/D + 事实(+数值)` 这种形状够用。
 * ⚠️ 空数组给空串(调用方就不用判"有没有")。
 */
export function renderSpecialLine(entries = [], { tzOffsetMs = 8 * 3600_000 } = {}) {
  const rows = (entries ?? []).filter(Boolean);
  if (rows.length === 0) return '';
  const when = (ts) => {
    const at = Number(ts);
    if (!Number.isFinite(at)) return '';
    const d = new Date(at + tzOffsetMs);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  return rows
    .map((row) => `${when(row.ts)} ${String(row.text ?? '').trim()}${row.deltas ? `（${row.deltas}）` : ''}`)
    .join('；');
}


/**
 * **她自己小事件的 id → 人话**。
 *
 * ⚠️ 为什么要有它:`stats_event.detail.label` 里存的是 `RANDOM_EVENTS` 的 **id**
 *    (`someone_treats` 这种),而**内部 id 不许出现在给人看的页面上**(D111 那条口径)。
 *    找不到就退回"她遇上了一点小事" —— 宁可含糊,也不把 id 念出去。
 */
export const EVENT_LABEL = Object.freeze(LOCAL_STORY_WORLD?.eventLabels ?? {
  "found_coin": "在路上捡到少量货币",
  "someone_treats": "有人请客",
  "sold_loot": "出售了物品",
  "bought_staff": "购入了一件装备",
  "tax": "支付了会费",
  "lost_pouch": "遗失了钱包",
  "donated": "进行了捐赠"
});
const CHRONICLE_TEXT = LOCAL_STORY_WORLD?.chronicleText ?? { currency: '货币', manaLabel: '精力', healFailed: '这次治疗未成功' };

const NUM = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** 一行人话里的数值部分(只说有变化的;钱永远报数,别的用"涨/少了"的说法)。 */
export function describeDeltas(event = {}) {
  const parts = [];
  const push = (label, value) => {
    const n = Math.round(NUM(value));
    if (n === 0) return;
    parts.push(`${label}${n > 0 ? '+' : ''}${n}`);
  };
  push('饱食', event.satietyDelta);
  push('健康', event.healthDelta);
  push('心情', event.moodDelta);
  push('体力', event.staminaDelta);
  push(CHRONICLE_TEXT.manaLabel, event.manaDelta);
  const money = Math.round(NUM(event.moneyDelta));
  if (money !== 0) parts.push(`${money > 0 ? '进账' : '花掉'} ${Math.abs(money)} ${CHRONICLE_TEXT.currency}`);
  return parts.join('，');
}

/**
 * **一条流水 → 编年史里的一行**(纯函数)。看不懂的种类返回 `null`(不猜、也不硬编)。
 *
 * @param {object} event `stats_event` 的一行(`{ts, kind, ...Delta, detail}`)
 * @returns {null | {ts:number, kind:string, weight:number, text:string, deltas:string,
 *   detail:object|null, money:number}}
 */
export function describeChronicleEntry(event) {
  if (!event || !CHRONICLE_KINDS[event.kind]) return null;
  const deltas = describeDeltas(event);
  // ⚠️ 全 0 的那一类不进编年史 —— "有人碰了一下"不是"发生了一件事"。
  //    例外:委托与"她的小事件"即使数值为 0 也算事件(它们讲的是**过程**,不是数值)。
  const narrative = event.kind === 'quest' || event.kind === 'story' || event.kind === 'event'
    || event.kind === 'move' || event.kind === 'selfcare'
    || event.kind === 'illness' || event.kind === 'heal';
  if (deltas === '' && !narrative) return null;

  const detail = event.detail ?? null;
  let what = CHRONICLE_KINDS[event.kind];
  if (event.kind === 'quest') {
    const label = detail?.label ?? '委托';
    what = detail?.grade ? `委托《${label}》结算` : `接了委托《${label}》`;
  } else if (event.kind === 'meal') {
    what = detail?.food ? `吃了${detail.food}` : '吃了点东西';
  } else if (event.kind === 'fed') {
    what = detail?.food ? `被投喂了${detail.food}` : '被投喂';
  } else if (event.kind === 'event') {
    // ⚠️ 这里存的是**内部 id** —— 翻成人话;翻不出来就含糊过去(不把 id 念出来)
    what = EVENT_LABEL[String(detail?.label ?? '')] ?? '她遇上一点小事';
  } else if (event.kind === 'potion') {
    what = detail?.label ? `喝了${detail.label}` : '喝了药';
  } else if (event.kind === 'illness') {
    what = detail?.disease ? `生病了（${detail.disease}）` : '生病了';
  } else if (event.kind === 'heal') {
    // ⚠️ `ok === false` = 求治疗者没治好 —— 那也是"她身上发生过的一件事",照记
    what = detail?.ok === false ? CHRONICLE_TEXT.healFailed : '病好了';
  }
  return {
    ts: NUM(event.ts),
    kind: String(event.kind),
    weight: WEIGHT[event.kind] ?? 1,
    text: what,
    deltas,
    // ⚠️ **不给原始 detail**(1.95.1 复核抓到):它是 `stats_event` 那一行原样——
    //    里面的 `label` 是**内部 id**("someone_treats"),今天页面只渲染 text/deltas 所以没漏,
    //    但谁哪天渲染了 detail 就漏。宁可这一层只给"已经说成人话"的东西。
    detail: null,
    money: Math.round(NUM(event.moneyDelta)),
  };
}

/**
 * **编年史**(纯函数):把流水变成"最近发生的事",新的在前。
 *
 * @param {object} input
 * @param {Array<object>} [input.events] `recentStatsEvents()` 的输出(新的在前)
 * @param {Array<object>} [input.metas] 只要 `world:` 那几行(用来补"她出门了/她到了")
 * @param {number} [input.limit]
 * @returns {Array<object>} 编年史条目(≤ limit 条)
 */
export function buildChronicle({ events = [], metas = [], limit = 20 } = {}) {
  const rows = [];
  for (const event of events ?? []) {
    const entry = describeChronicleEntry(event);
    if (entry) rows.push(entry);
  }
  // ⚠️ 位置事实**不是流水**(它是"她此刻在哪",不是"发生了什么"),所以它单独补两条就够:
  //    她在路上 / 她到了哪儿 —— 两者都从同一条 meta 派生,不另存日志。
  const worldRow = (metas ?? []).find((row) => String(row.key) === 'world:her');
  if (worldRow) {
    try {
      const fact = JSON.parse(worldRow.value);
      const at = NUM(fact.arrivedAt) || NUM(fact.since);
      if (fact.to && Number(fact.arriveAt) > at) {
        rows.push({
          ts: at, kind: 'move', weight: WEIGHT.move ?? 4,
          text: fact.placeName ? `她出门了（从${fact.placeName}往${fact.toName ?? '别处'}）` : '她出门了',
          deltas: '', detail: null, money: 0,
        });
      } else if (fact.arrivedAt) {
        rows.push({
          ts: NUM(fact.arrivedAt), kind: 'move', weight: WEIGHT.move ?? 4,
          text: `她到了${fact.placeName ?? '一个地方'}`, deltas: '', detail: null, money: 0,
        });
      }
    } catch { /* 坏了就当没有这条 —— 不猜 */ }
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, Math.max(1, Number(limit) || 20));
}

/** 挑"你不在的时候"最值得讲的那几条(按分量,再按时间;最多 `max` 条)。 */
export function pickAwayHighlights(entries = [], { since = null, max = 6 } = {}) {
  const from = Number.isFinite(Number(since)) ? Number(since) : null;
  return (entries ?? [])
    .filter((row) => (from === null ? true : row.ts > from))
    .sort((a, b) => (b.weight - a.weight) || (b.ts - a.ts))
    .slice(0, Math.max(1, Number(max) || 6));
}

/**
 * **"你不在的时候"那一块**(纯函数):给弹窗与页面共用。
 *
 * ⚠️ 两种口径分开:
 *   · `away`(有"上次到访"时刻时):只讲**那之后**发生的事 —— 这是回来结算;
 *   · 没有那个时刻(第一次打开):退化成"最近发生的事"(不假装知道你不在多久)。
 *
 * @param {object} input
 * @param {Array<object>} [input.entries] `buildChronicle()` 的输出
 * @param {number|null} [input.lastSeenAt] 客户端上一次到访的时刻(由页面存在本机)
 * @param {number} [input.now]
 * @param {number} [input.max]
 */
export function summarizeAway({ entries = [], lastSeenAt = null, now = Date.now(), max = 6 } = {}) {
  // ⚠️ **`Number(null)` 是 0**(而且 `Number.isFinite(0)` 为真)—— 第一版直接拿它判,
  //    于是"没有上次到访"会被当成"上次到访 = 1970 年",一打开就弹一屏旧事。
  //    这里显式先挡 null/undefined,再谈是不是数字。
  const raw = lastSeenAt === null || lastSeenAt === undefined ? null : Number(lastSeenAt);
  const since = raw !== null && Number.isFinite(raw) && raw > 0 ? raw : null;
  // ⚠️ **没有"上次到访"就一条都不给**:那是第一次打开 —— 不许假装知道你不在多久
  //    (`pickAwayHighlights` 在 `since === null` 时的语义是"不带时间过滤地挑",
  //     那是**另一个用途**;这里必须显式挡住,否则第一次打开就会弹一屏旧事)。
  const highlights = since === null ? [] : pickAwayHighlights(entries, { since, max });
  const awayMs = since === null ? null : Math.max(0, Number(now) - since);
  return {
    since,
    awayMs,
    // ⚠️ 超过一天就不说"你不在的这段时间"了(那样读起来像指责,而且没人真的离开了一天)
    fresh: since === null ? false : awayMs <= 24 * 60 * 60_000,
    count: highlights.length,
    items: highlights,
  };
}
