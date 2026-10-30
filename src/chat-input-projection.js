/**
 * F1：原档 append-only，消费端统一读取可重建投影（零依赖，不另造存储/解析器）。
 * 复用 Azure Architecture Center 的 Event Sourcing / Materialized View 原则
 * （文档无独立版本，asOf 2026-10-30；本次未联网刷新）：
 * https://learn.microsoft.com/azure/architecture/patterns/event-sourcing
 * https://learn.microsoft.com/azure/architecture/patterns/materialized-view
 * 本项目只借用“不改事件原档、派生视图可按新规则重建”，不引入事件框架。
 */
import { stripInjectMarks } from './inject-mark.js';
import { composeModeNote } from './turn-policy.js';
import { DIRECT_RESPONSE_NOTES, SPOKEN_STANDING_NOTES, STYLE_NUDGE_THEMES } from './style.js';

/** 升级投影规则时，own 摘要与归档派生视图必须一起失效/重建。 */
export const CHAT_INPUT_PROJECTION_VERSION = 3;
export const LEGACY_NOTES_TITLE = '（本次表达要求，照做但不要念出来：）';
const LEGACY_SEPARATOR = `\n\n${LEGACY_NOTES_TITLE}\n`;
const MODE_NOTES = ['task', 'knowledge'].map(composeModeNote);
const FIXED_NOTES = new Set([
  // 共享规则措辞升级后仍识别旧 producer 的完整尾缀（只用于旧记录兼容，不再注入）。
  '直接回应：先给回答、态度或自然接话，不先复述、转述或概括对方刚说的话，也不先总结群聊。',
  ...DIRECT_RESPONSE_NOTES, ...SPOKEN_STANDING_NOTES, ...Object.values(STYLE_NUDGE_THEMES).flat(),
]);
// buildMoodNote 的完整行式（不是“本轮情绪”四字命中就算来源）。
const MOOD_LINE = /^本轮情绪：[^；\n]+；[1-9]\d* 句以内、不超过 [1-9]\d* 字(?:；语气词用「[^」\n]+」)?(?:；句尾可以带 [^\n]+)?$/;
/**
 * **旧裸 notes 的格式截止版本**(固定常量,不随算法版本变大)。
 * 3 = 首次把临时注入包进 `[[bridge-inject notes]]` 的写入格式;此后所有记录都有自己的边界,
 * 不需要、也不允许再按"正文长得像旧提示"猜测 —— 否则将来升算法版本会把 v3 的
 * 用户逐字引文重新当成桥的指令删掉(审查 P2)。
 */
const LEGACY_FORMAT_CUTOFF = 3;
const isLegacyRecord = (version) => version == null
  || (Number.isSafeInteger(version) && version >= 0 && version < LEGACY_FORMAT_CUTOFF);

function stripLegacyNotes(source) {
  const cut = source.lastIndexOf(LEGACY_SEPARATOR);
  if (cut < 0) return source;
  const suffix = source.slice(cut + LEGACY_SEPARATOR.length);
  let rest = suffix;
  let known = false;
  // 唯一允许的未加 bullet 的续行来自完整、逐字相同的已登记 producer；
  // 随意缩进/额外正文都不能靠“标题之后全删”带走。
  for (const note of MODE_NOTES) {
    const serialized = `· ${note}`;
    const at = rest.indexOf(serialized);
    if (at >= 0 && (at === 0 || rest[at - 1] === '\n')
        && (at + serialized.length === rest.length || rest[at + serialized.length] === '\n')) {
      rest = rest.slice(0, at) + '· 已核完整本轮口径' + rest.slice(at + serialized.length);
      known = true;
    }
  }
  const lines = rest.split('\n').filter(line => line !== ''); // 已剥标记块留下的空行
  if (!lines.length || lines.some(line => !/^· [^\n]+$/.test(line))) return source;
  for (const line of lines) {
    const note = line.slice(2);
    if (FIXED_NOTES.has(note) || MOOD_LINE.test(note)) known = true;
  }
  return known ? source.slice(0, cut) : source;
}

/**
 * 统一读投影：新块只认标记；旧裸 notes 仅在明确桥历史来源 + 精确旧尾缀
 * + 至少一条完整已知 producer 指纹时兼容。rawText 从不作为可信替代正文。
 * 注意：来源标签/固定指纹不是认证；用户逐字模拟完整 producer 尾缀时无法区分。
 * 普通同名标题、任意 bullet、额外正文、非桥来源均保留，不猜用户意图。
 */
export function projectChatInput(text, { source = null, role = 'user', inputProjectionVersion = null } = {}) {
  const clean = stripInjectMarks(String(text ?? ''));
  // 新写入行已全用标记，禁止再对其中的用户引文作旧格式猜测；坏版本也不扩大兼容域。
  if (!isLegacyRecord(inputProjectionVersion) || role !== 'user'
    || !['own-engine', 'bridge-session'].includes(source)) return clean;
  // 历史可能先后拼过多次完整 producer 尾缀；一次投影到固定点，重复读不再改变正文。
  let projected = clean;
  for (;;) {
    const next = stripLegacyNotes(projected);
    if (next === projected) return projected;
    projected = next;
  }
}

/**
 * **只取"确认由 producer 写下的 notes 片段"**，供归档解析 topic/mood/nudge 等元字段。
 *
 * ⚠️ 为什么不直接对整条原文跑 `parseInjectedNotes`(F1 复核抓到):用户在同一条消息里
 *    逐字引用「· 这次…」这类行、同时这轮又真有一个 facts/notes 标记时,整条扫描会把
 *    **用户的引文**当成桥的表达要求写进元字段。这里只取两处已确认来源:
 *    ① 新格式 `[[bridge-inject notes]]` 块正文;② 通过严格校验的旧尾缀。
 *    没有确认来源 ⇒ 空串(不猜)。
 */
export function confirmedNotesSource(text, { source = null, role = 'user', inputProjectionVersion = null } = {}) {
  const original = String(text ?? '');
  if (role !== 'user' || !['own-engine', 'bridge-session'].includes(source)) return '';
  const parts = [];
  const open = '[[bridge-inject notes]]';
  const close = '[[/bridge-inject]]';
  let from = 0;
  for (;;) {
    const start = original.indexOf(open, from);
    if (start < 0) break;
    const bodyStart = start + open.length;
    const end = original.indexOf(close, bodyStart);
    if (end < 0) break; // 截断块:NUL 之外不猜(正文本来就被剥到文末)
    parts.push(original.slice(bodyStart, end));
    from = end + close.length;
  }
  const legacy = isLegacyRecord(inputProjectionVersion);
  if (legacy) {
    let probe = stripInjectMarks(original);
    for (;;) {
      const cut = probe.lastIndexOf(LEGACY_SEPARATOR);
      if (cut < 0) break;
      const next = stripLegacyNotes(probe);
      if (next === probe) break;
      parts.push(probe.slice(cut + LEGACY_SEPARATOR.length));
      probe = next;
    }
  }
  return parts.join('\n').trim();
}
