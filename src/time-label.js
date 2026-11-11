/**
 * 时间标签的唯一来源(C 刀 B,2026-11-11)。
 *
 * 为什么单开一个文件:引擎历史、滚动摘要、固化笔记、洞察四处都要给模型看"这是多久以前的"。
 * 各写各的格式,迟早出现"摘要写 10/01、笔记写 10月1日、历史没写"这种不一致 ——
 * 而模型只会把**没写时间的那一条**当成现在(D159:一个口径只写一处)。
 *
 * 只做**本地时区**的展示(机器人就跑在主人这台/那台机器上),不做时区参数化 ——
 * 没有第二个时区消费者,参数化只是把复杂度搬进来。
 */

const pad = (value) => String(value).padStart(2, '0');

/** 本地日历日键(排序/比较用;不是给人看的)。 */
export function dayKey(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 给人看的一天:`MM-DD`;跨年时补 `YYYY-`(否则"01-01"看不出是哪一年)。
 * @param {number} at 事件时刻(ms)
 * @param {{now?: number}} [options]
 */
export function formatDay(at, { now = Date.now() } = {}) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const current = new Date(Number(now) || Date.now());
  const sameYear = date.getFullYear() === current.getFullYear();
  return `${sameYear ? '' : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 给人看的时刻:`MM-DD HH:mm`(跨年补年份)。摘要材料/交接用。 */
export function formatStamp(at, { now = Date.now() } = {}) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  return `${formatDay(value, { now })} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把"多久以前"写成一句人话(健康/洞察/笔记共用)。 */
export function ageLabel(ms) {
  const value = Math.max(0, Number(ms) || 0);
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `约${Math.max(1, minutes)}分钟前`;
  const hours = Math.round(value / 3_600_000);
  if (hours < 24) return `约${hours}小时前`;
  const days = Math.round(value / 86_400_000);
  return `约${days}天前`;
}
