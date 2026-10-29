/**
 * Scheduled "warm the group up" behaviour.
 *
 * This is the only feature that spends model calls on a clock rather than on a
 * message, so it is deliberately gated on several things at once: its own
 * schedule says it is due, the group is currently quiet (warming an active chat
 * is pointless), the bot has not just spoken there, and it is not the middle of
 * the night.
 *
 * Two schedules exist. `interval` is the original "every N minutes per group"
 * rule; `random` gives each group at most one *chance* per slot, taken only some
 * of the time, at an unpredictable moment (see `warmupSlot`/`warmupDecision`).
 */

import { LOCAL_TURN_CONTENT } from './local-turn-content.js';

/**
 * Meal windows, local hours, used to keep food talk near actual mealtimes.
 *
 * Saying "好饿" at 3pm reads as a non-sequitur; around a mealtime it reads as
 * conversation. Windows are `[start, end)`.
 */
export const DEFAULT_MEAL_WINDOWS = [
  { label: '早餐', start: 6, end: 10 },
  { label: '午餐', start: 11, end: 14 },
  { label: '晚餐', start: 17, end: 20 },
];

/**
 * Opening directions for a warm-up.
 *
 * Each is a *springboard*, not a script: the character card still governs voice,
 * and the model may answer with the silence token if the moment is wrong.
 * `tag: 'meal'` entries are only eligible during a meal window.
 */
export const WARMUP_TOPICS = LOCAL_TURN_CONTENT?.warmupTopics ?? [
  { tag: 'meal', text: '问问大家今天吃了什么。' },
  { tag: 'meal', text: '聊聊附近有哪些家常小吃。' },
  { tag: 'meal', text: '问问大家有没有喜欢的早餐搭配。' },
  { tag: 'meal', text: '聊聊哪种做法简单又好吃。' },
  { tag: 'meal', text: '问问大家晚餐准备怎么安排。' },
  { tag: 'poor', text: '聊聊最近有哪些省钱的小办法。' },
  { tag: 'poor', text: '问问有没有实惠的日常用品推荐。' },
  { tag: 'rich', text: '聊聊最近有没有值得买的小东西。' },
  { tag: 'rich', text: '问问大家会怎么安排一笔小预算。' },
  { tag: 'general', text: '聊聊今天的天气适不适合出门。' },
  { tag: 'general', text: '问问大家最近有没有读到有趣的内容。' },
  { tag: 'general', text: '聊聊最近听到的一首歌。' },
  { tag: 'general', text: '问问大家今天有什么新发现。' },
  { tag: 'general', text: '聊聊周末想做的一件小事。' },
  { tag: 'general', text: '问问大家有没有想分享的日常趣事。' },
  { tag: 'general', text: '聊聊最近一次散步看到的景色。' },
  { tag: 'general', text: '问问大家喜欢怎样的休息方式。' },
  { tag: 'general', text: '聊聊最近学会的一点小技巧。' },
  { tag: 'general', text: '问问大家最近在忙什么项目。' },
  { tag: 'general', text: '聊聊一天中最喜欢的时段。' },
];

/** Whether an hour falls inside any meal window. */
export function isMealTime(hour, windows = DEFAULT_MEAL_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  return windows.some(({ start, end }) => hour >= start && hour < end);
}

/**
 * Pick one topic, avoiding the most recently used and respecting mealtimes.
 *
 * `moneyMood`(D42)把**钱**接进话题池:穷的时候只挑"赚钱/省着花"那几类,
 * 宽裕的时候才可能提"请客/想买什么"。这是让经济**影响行为**的地方 ——
 * 光有数值而话题池不变,钱就只是个提示词里的数字。
 *
 * @param {string[]} recent recently used topic texts.
 * @param {{hour?: number, mealWindows?: object[], moneyMood?: 'poor'|'rich'|'comfortable'}} [options]
 *   omitted `hour` disables the mealtime restriction (used by tests and by callers
 *   that do not care). `moneyMood` 省略 = 只出中性话题。
 * @returns {string} the topic text.
 */
export function pickWarmupTopic(recent = [], options = {}) {
  const eligible = eligibleWarmupTopics(options);
  const fresh = eligible.filter((topic) => !recent.includes(topic.text));
  const pool = fresh.length > 0 ? fresh : eligible;
  return pool[Math.floor(Math.random() * pool.length)].text;
}

/**
 * 这一轮**允许**出现的话题池(纯函数 —— `pickWarmupTopic` 与测试共用)。
 *
 * 两个筛选叠在一起,而且**不能互相打架**:
 *   1. 饭点 —— 非饭点排除 `meal`;
 *   2. 钱的处境(D42)—— 穷只放 `poor`、宽裕只放 `rich`,其余只放中性。
 *
 * ⚠️ 为什么把它抽出来:"按概率抽到某类话题"这种断言**天生靠运气**。
 * 原来的测试跑 200 次看能不能抽到吃饭话题,加了一条新测试之后它就红了(顺序变了而已)。
 * 正确的判据是"**池子里有没有**",不是"抽不抽得到"。
 *
 * @param {{hour?: number, mealWindows?: object[], moneyMood?: 'poor'|'rich'|'comfortable'}} [options]
 */
export function eligibleWarmupTopics({ hour, mealWindows = DEFAULT_MEAL_WINDOWS, moneyMood = 'comfortable' } = {}) {
  const mealAllowed = hour === undefined ? true : isMealTime(hour, mealWindows);
  const moodTag = moneyMood === 'poor' || moneyMood === 'rich' ? moneyMood : null;
  return WARMUP_TOPICS.filter((topic) => {
    // ⚠️ 顺序要点:先放行"饭点允许的 meal",再处理其它。
    // 这里写错过一次 —— `(tag === 'meal' && !mealAllowed) ? false : …`
    // 在**饭点时也把 meal 判成 false**,于是白天一条吃饭话题都抽不到。
    // 是 `非饭点绝不会抽到吃饭话题` 那条测试抓出来的(它当时红得莫名其妙,
    // 而我一度以为"是测试不稳" —— 结论是:**测试是对的,实现是错的**)。
    if (topic.tag === 'meal') return mealAllowed;
    if (topic.tag === 'general') return true;
    return topic.tag === moodTag;
  });
}

/** Keep only the most recent topics, for the "don't repeat" filter. */
export function rememberWarmupTopics(recent, topic, limit = 4) {
  return [...recent, topic].slice(-limit);
}

/**
 * Parse a sleep window such as `23:00-08:00`.
 *
 * @returns {{start: number, end: number}|null} whole hours, or null when unset
 *   or unparseable.
 */
export function parseSleepWindow(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const match = /^\s*(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?\s*$/.exec(text);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 24) return null;
  return { start, end };
}

/**
 * Parse meal windows such as `6-10,11-14,17-20`.
 *
 * An empty value yields `[]`, which `isMealTime` reads as "no restriction" — the
 * operator explicitly asked for food talk at any hour.
 */
export function parseMealWindows(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const windows = [];
  for (const part of text.split(',')) {
    const match = /^\s*(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?\s*$/.exec(part);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > 23 || end > 24 || start === end) continue;
    windows.push({ label: `${start}-${end}`, start, end });
  }
  return windows;
}

/**
 * Whether a wall-clock hour falls inside the sleep window.
 *
 * Handles a window that crosses midnight (23 → 8), which is the normal case.
 * A zero-width window means "never sleep".
 */
export function isWithinSleepWindow(hour, window) {
  if (!window) return false;
  const { start, end } = window;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ---------------------------------------------------------------------------
// Slot scheduling (mode `random`)
//
// The original schedule was "every group, every N minutes", which is both
// relentless and perfectly periodic: two groups warmed within seconds of each
// other at the same minute past every hour. The slot model replaces it with
// "each group gets *at most* one chance per slot, and only sometimes takes it",
// which is what makes it read as a person rather than a cron job (D21).
//
// Everything below is pure: the caller passes in the clock, the two random
// draws, and the runtime gates. That keeps the whole state machine inside the
// unit tests instead of inside `main()`, which no test executes (see D19/D21).
// ---------------------------------------------------------------------------

/** Supported warm-up scheduling modes. */
export const WARMUP_MODES = ['interval', 'random'];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The parts of a local day during which a warm-up is allowed.
 *
 * @param {number} midnight epoch ms of local 00:00 for the day in question.
 * @param {{start: number, end: number}|null} sleep sleep window in whole hours.
 * @returns {Array<[number, number]>} `[from, to)` intervals, ascending.
 */
function awakeWindows(midnight, sleep) {
  const dayEnd = midnight + DAY_MS;
  if (!sleep || sleep.start === sleep.end) return [[midnight, dayEnd]];
  const start = midnight + sleep.start * HOUR_MS;
  const end = midnight + Math.min(sleep.end, 24) * HOUR_MS;
  const windows = sleep.start < sleep.end
    ? [[midnight, start], [end, dayEnd]]
    : [[end, start]]; // Wraps midnight: asleep 23→8 means awake 8→23.
  return windows.filter(([from, to]) => to > from);
}

/**
 * The slot containing `now`, clipped to the awake part of the day.
 *
 * Slots are aligned to local midnight, so with a 2-hour slot the boundaries sit
 * on even local hours and "which slot was that?" is answerable by looking at a
 * wall clock. A slot that is entirely inside the sleep window yields `null`.
 *
 * @returns {{key: number, start: number, end: number}|null}
 *   `key` identifies the slot (its unclipped start); `start`/`end` are the
 *   usable sub-range, which is what a plan must land inside.
 */
export function warmupSlot(now, { slotMs, sleep = null }) {
  const date = new Date(now);
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const slotStart = midnight + Math.floor((now - midnight) / slotMs) * slotMs;
  const slotEnd = slotStart + slotMs;

  for (const [from, to] of awakeWindows(midnight, sleep)) {
    const start = Math.max(slotStart, from);
    const end = Math.min(slotEnd, to);
    if (end > start) return { key: slotStart, start, end };
  }
  return null;
}

/**
 * Probability to use for a slot, after the "nobody answered last time" decay.
 *
 * Halving per unanswered warm-up bottoms out at `minChance` rather than at zero:
 * a group where nobody ever replies should go quiet, not go silent forever.
 */
export function effectiveChance(baseChance, misses = 0, minChance = 0) {
  const decayed = baseChance * 0.5 ** Math.max(0, misses);
  return Math.min(baseChance, Math.max(minChance, decayed));
}

/**
 * Settle the "did anyone answer the last warm-up?" verdict.
 *
 * @param {object|null} entry
 * @param {number} now
 * @param {number} engageWindowMs how long a reply still counts as an answer.
 * @param {{engaged: boolean}} outcome whether a group message arrived.
 * @returns {object|null} the entry with `misses`/`awaitingSince` updated. When
 *   nothing was awaiting a verdict the entry is returned untouched, and when
 *   the window has not closed yet an unanswered warm-up stays pending.
 */
export function settleWarmupEngagement(entry, now, engageWindowMs, { engaged }) {
  if (!entry || entry.awaitingSince === null || entry.awaitingSince === undefined) return entry;
  const elapsed = now - entry.awaitingSince;
  if (engaged && elapsed <= engageWindowMs) {
    return { ...entry, misses: 0, awaitingSince: null };
  }
  if (!engaged && elapsed <= engageWindowMs) {
    return { ...entry }; // Too early to call it: keep waiting.
  }
  return { ...entry, misses: (entry.misses ?? 0) + 1, awaitingSince: null };
}

/** Fill in the fields a state file written by an older version will not have. */
export function normalizeWarmupEntry(raw) {
  return {
    lastWarmupAt: Number.isSafeInteger(raw?.lastWarmupAt) ? raw.lastWarmupAt : null,
    slotKey: Number.isSafeInteger(raw?.slotKey) ? raw.slotKey : null,
    plan: Number.isSafeInteger(raw?.plan) ? raw.plan : null,
    misses: Number.isSafeInteger(raw?.misses) && raw.misses > 0 ? raw.misses : 0,
    awaitingSince: Number.isSafeInteger(raw?.awaitingSince) ? raw.awaitingSince : null,
  };
}

/**
 * Decide what this group should do this tick. Pure state machine.
 *
 * @param {object|null} entry persisted per-group scheduling state.
 * @param {object} ctx
 * @param {number} ctx.now
 * @param {{key: number, start: number, end: number}|null} ctx.slot
 * @param {number} ctx.baseChance
 * @param {number} [ctx.minChance]
 * @param {number} [ctx.engageWindowMs]
 * @param {number} [ctx.roll] first random draw `[0, 1)` — "does it hit?".
 * @param {number} [ctx.offset] second random draw `[0, 1)` — "when in the slot?".
 * @param {boolean} [ctx.quietOk] the group has been quiet long enough.
 * @param {boolean} [ctx.gapOk] the bot has not spoken here too recently.
 * @param {boolean} [ctx.busy] a turn is already running for this conversation.
 * @returns {{entry: object|null, action: string, chance?: number,
 *   abandoned?: boolean, reason?: string}}
 *   `action` is one of `asleep` / `first-sighting` / `rolled-miss` /
 *   `rolled-hit` / `idle` / `wait` / `drop` / `fire`.
 */
export function warmupDecision(entry, ctx) {
  const {
    now,
    slot,
    baseChance,
    minChance = 0,
    engageWindowMs = 0,
    roll = 1,
    offset = 0,
    quietOk = true,
    gapOk = true,
    busy = false,
  } = ctx;

  if (!slot) return { entry, action: 'asleep' };

  // A group the bridge has just met waits for the next slot: firing on first
  // sighting would greet a new group with an unprompted message (D13).
  if (!entry) {
    return {
      entry: {
        lastWarmupAt: null,
        slotKey: slot.key,
        plan: null,
        misses: 0,
        awaitingSince: null,
      },
      action: 'first-sighting',
    };
  }

  // New slot: settle the previous warm-up, then draw this slot's plan once.
  // Drawing once and persisting it is what stops a restart from re-rolling and
  // collecting extra chances.
  if (entry.slotKey !== slot.key) {
    const settled = settleWarmupEngagement(entry, now, engageWindowMs, { engaged: false });
    const chance = effectiveChance(baseChance, settled.misses ?? 0, minChance);
    const from = Math.max(now, slot.start);
    const hit = roll < chance && slot.end > from;
    const plan = hit ? from + Math.floor(offset * (slot.end - from)) : null;
    const abandoned = Number.isSafeInteger(entry.plan);
    return {
      entry: { ...settled, slotKey: slot.key, plan },
      action: plan === null ? 'rolled-miss' : 'rolled-hit',
      chance,
      abandoned,
    };
  }

  if (entry.plan === null || entry.plan === undefined) return { entry, action: 'idle' };
  if (now < entry.plan) return { entry, action: 'idle' };
  // Past the end of its slot: the chance is gone rather than carried over.
  // "Missed it, never mind" is the human behaviour, and it also stops a delayed
  // plan from stacking up against the next slot's plan.
  if (now >= slot.end) return { entry: { ...entry, plan: null }, action: 'drop', reason: 'slot-ended' };
  if (busy) return { entry, action: 'wait', reason: 'busy' };
  if (!quietOk) return { entry, action: 'wait', reason: 'noisy' };
  if (!gapOk) return { entry, action: 'wait', reason: 'just-spoke' };

  return { entry: { ...entry, plan: null }, action: 'fire' };
}

/** The message sent to the model for a warm-up. */
export function buildWarmupPrompt(topic, { context, silentToken }) {
  return [
    '[群聊] 群里已经安静了一会儿。你可以主动开口说一句，把气氛带起来。',
    `这轮的话题方向：${topic}`,
    '只当开场白 —— 一句话就够，别写成通知，也别追问太具体的事。',
    '群里说的话一句都不许复述，也别提"刚才没人说话"这种话。',
    '',
    context,
    '',
    `如果现在不适合开口，就只回复 ${silentToken}。`,
  ].join('\n');
}
