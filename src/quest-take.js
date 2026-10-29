/**
 * **接委托**(D101 的规则;1.86.0 起 QQ 与面板**共用这一份**,见 `docs\03` D141)。
 *
 * ## 为什么单独一个模块
 *
 * 委托看板与结账属于**主世界的账本**(不是钓鱼那个纯状态机),但它有**两条渠道**:
 * QQ 的 `/接 N` 与网页上的「接取」按钮。规则(看板过期 / 冷却 / 每日上限 / 撕掉这一条)
 * 如果各写一遍,**两条路迟早会不一样** —— 而"网页上能刷、QQ 里不能"这种偏差不会报错,
 * 只会让人以为其中一边坏了。所以这里一条判定、一条结账,两边都调它。
 *
 * ## 三条纪律
 *
 * ① **判定是纯函数**(`pickQuestTake`):调用方把看板、今天的流水、`now` 喂进来 —— 可单测;
 * ② **闸门写在流水里**(`kind='quest'`),不依赖新表(D101 原话);
 * ③ ⚠️ **认不出就拒绝**:看板空了 / 过期 / 序号不对 / 冷却中 / 到上限,各给一条**人话**,
 *    绝不当成"接成功了"。
 */

import { QUEST_BOARD_TTL_MS, QUEST_TAKE_COOLDOWN_MS, QUEST_TAKE_PER_DAY } from './economy.js';
import { CURRENCY } from './stats.js';

/** 看板存在 `meta` 里的键前缀(面板把它当**不透明键**回传,自己不拼)。 */
export const QUEST_BOARD_KEY_PREFIX = 'quest_board:';

/** 今天零点的毫秒数(本地时区 —— 和"每日上限"的口径一致)。 */
export function startOfToday(now = Date.now()) {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  return since.getTime();
}

/** 从流水里挑出"今天接过的委托"(纯函数)。 */
export function questTakesToday(rows, since) {
  return (rows ?? []).filter((row) => row && row.kind === 'quest' && Number(row.ts) >= Number(since));
}

/**
 * 现在能不能接第 `index` 条(**纯函数**)。
 *
 * @param {object} input
 * @param {Array<object>} [input.board] 看板上的行(每行有 `index` / `label` / `reward` / `penalty` / `stamina` / `tier`)
 * @param {number} [input.at] 看板挂出来的时刻
 * @param {number} [input.now]
 * @param {Array<object>} [input.todayRows] 今天的流水(`recentStatsEvents()` 的输出)
 * @param {number|string} [input.index] 面板/QQ 传来的序号
 * @param {number} [input.cooldownMs]
 * @param {number} [input.perDay]
 * @returns {{ok:true,row:object} | {ok:false,reason:string,note:string,leftMs?:number,count?:number,total?:number}}
 */
export function pickQuestTake({
  board = [],
  at = 0,
  now = Date.now(),
  todayRows = [],
  index = null,
  cooldownMs = QUEST_TAKE_COOLDOWN_MS,
  perDay = QUEST_TAKE_PER_DAY,
} = {}) {
  const rows = Array.isArray(board) ? board : [];
  if (rows.length === 0) {
    return { ok: false, reason: 'board_empty', note: '看板上没有正在挑的活 —— 先让她去公会把看板挂出来。' };
  }
  if (now - Number(at ?? 0) > QUEST_BOARD_TTL_MS) {
    return { ok: false, reason: 'board_stale', note: '那块看板已经撤了（超过 6 小时）—— 得让她重新去公会看一次。' };
  }
  const picked = rows.find((row) => Number(row.index) === Number(index));
  if (!picked) {
    return {
      ok: false,
      reason: 'bad_index',
      note: `看板上只有 ${rows.length} 条 —— 刷新看看。`,
      total: rows.length,
    };
  }

  const today = questTakesToday(todayRows, startOfToday(now));
  const lastAt = today.reduce((max, row) => Math.max(max, Number(row.ts) || 0), 0);
  if (now - lastAt < cooldownMs) {
    const left = Math.ceil((cooldownMs - (now - lastAt)) / 60_000);
    return {
      ok: false,
      reason: 'quest_cooldown',
      note: `刚接过一条 —— 先歇 ${left} 分钟，腿还酸着呢。`,
      leftMs: cooldownMs - (now - lastAt),
    };
  }
  if (today.length >= perDay) {
    return {
      ok: false,
      reason: 'quest_daily_cap',
      note: `今天已经接过 ${today.length} 条了 —— 公会也没那么多活，明天再来。`,
      count: today.length,
    };
  }
  return { ok: true, row: picked };
}

/**
 * **结账**(有副作用;QQ 与面板共用):报酬进钱、体力往下掉、流水记一笔 `kind='quest'`,
 * 并把这一条从看板上**撕掉**(序号重排 —— 不然同一块面板能反复接同一张)。
 *
 * ⚠️ 数值一律过 `applyStoryResult`(绑定表,fail closed);这里**不自己加减**。
 *
 * 📌 **`payAtTake`(B / 1.93.0)**:面板那条路现在接的是"**三段闭环**":
 *    活要**做完才给钱**(`docs\08` 3.2 的三段,报酬在结算那一段),所以接取时只**撕板 + 扣体力**,
 *    钱留到 `quest.settle` 再落账。QQ 的 `/接 N` 仍走"接了就给"(`payAtTake` 默认 true)——
 *    ⚠️ 两条路目前口径不同,已记进 `docs\03`(等 QQ 那条也接上分段后统一)。
 *
 * @returns {{ok:true,row:object,stats:object,event:object,rest:Array<object>,paid:number,staminaDelta:number}}
 *          或 `{ok:false,reason:'bad_index'}`
 */
export function applyQuestTake({
  store,
  key,
  board = [],
  at = 0,
  index = null,
  now = Date.now(),
  sleep = null,
  payAtTake = true,
} = {}) {
  const picked = (board ?? []).find((row) => Number(row.index) === Number(index));
  if (!picked) return { ok: false, reason: 'bad_index' };

  const effect = payAtTake
    ? { money: picked.reward + picked.penalty, stamina: -picked.stamina }
    : { stamina: -picked.stamina };
  const { stats, event } = store.applyStoryResult(
    effect,
    now,
    { kind: 'quest', tier: picked.tier, index: picked.index, label: picked.label, line: picked.line, payAtTake },
    { sleep },
  );
  const rest = (board ?? [])
    .filter((row) => Number(row.index) !== Number(index))
    .map((row, i) => ({ ...row, index: i + 1 }));
  if (key) store.setMeta(key, JSON.stringify({ at, board: rest }));

  return {
    ok: true,
    row: picked,
    stats,
    event,
    rest,
    paid: event.moneyDelta,
    staminaDelta: event.staminaDelta,
    payAtTake,
  };
}

/** 一句人话回执(QQ 直接发这段;面板的回执也用它 —— 两条路说同一句话)。 */
export function describeQuestTake({ row, paid = 0, staminaDelta = 0, currency = CURRENCY.name } = {}) {
  const head = paid >= 0
    ? `接了第 ${row.index} 条：${row.label} —— 报酬 +${paid} ${currency}`
    : `接了第 ${row.index} 条：${row.label} —— 赔了 ${paid} ${currency}`;
  return `${head}，体力 −${Math.abs(staminaDelta)}`;
}
