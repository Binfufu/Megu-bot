import { LOCAL_STORY_WORLD } from './local-story-world-content.js';

/** Optional authored calendar settings; dates and provenance remain in local content. */

/** 她的日子(月/日 + 说法 + 出处)。⚠️ 日期**不许**在这里改着玩 —— 改要写清新出处。 */
export const CHARACTER_DAYS = Object.freeze(Object.fromEntries(
  Object.entries(LOCAL_STORY_WORLD?.characterDays ?? {}).map(([theme, days]) =>
    [theme, Object.freeze(days.map((day) => Object.freeze(day)))]),
));

/** 按主题取出"她的日子"(认不出给空数组 —— 不猜)。 */
export function daysFor(theme) {
  return CHARACTER_DAYS[String(theme ?? '')] ?? [];
}

/**
 * **今天是不是她的某个日子**(纯函数)。
 *
 * ⚠️ 时间一律按**北京时间**(UTC+8):这台机器与日志都是 UTC,而"生日"是给人过的
 *    (与 `scripts\transcript.js` 的 `TZ_OFFSET_MS` 同一条口径)。
 *
 * @param {string} theme `megumin` / `aris`
 * @param {number} [now]
 * @param {number} [tzOffsetMs]
 * @returns {Array<object>} 今天命中的那几条(没有就空数组)
 */
export function daysToday(theme, { now = Date.now(), tzOffsetMs = 8 * 3600_000 } = {}) {
  const at = new Date(Number(now) + tzOffsetMs);
  const month = at.getUTCMonth() + 1;
  const day = at.getUTCDate();
  return daysFor(theme).filter((row) => row.month === month && row.day === day);
}

/**
 * 这一句给**摘要提示词**用(纯函数):今天是她生日时给一行,否则空串。
 *
 * ⚠️ 与 `chronicle.js` 的 `renderSpecialLine()` 拼在一起用 —— 两者都是"她自己的事",
 *    一个来自流水(发生过什么),一个来自设定(今天是什么日子)。
 */
export function renderDayLine(rows = []) {
  const today = (rows ?? []).filter(Boolean);
  if (today.length === 0) return '';
  return today.map((row) => `今天是她${row.label}（${row.month}月${row.day}日，出处：${row.source}）`).join('；');
}
