/**
 * **刀二C · 注入自报家门 + 归档剥壳**(2026-10-14,`docs\21` §六 g2 / §十二)。
 *
 * ## 为什么要有这个文件
 *
 * 今天桥注入的东西(交接块/事实/情绪 nudge)靠 `transcript.js` 里**逐条认字面**剥
 * (`【记忆交接】…（现在开始。）` 那几张正则);断 DSH 之后我们自己注入的块会更多
 * (交接块/摘要区/记忆检索/turnFacts/场景注入),逐条认字面一定会漏 —— 漏一块,
 * 记忆管线就把它当"她说的话"归档(g2 的原话:**不把她没说过的话当她说的话入库**)。
 *
 * 解法不是更多正则,是**自报家门**:桥注入的每一块都包进**同一对标记**,
 * 剥壳只认标记,不认内容 —— 一条约定管所有现在与将来的注入块。
 *
 * ## 标记形状
 *
 *   [[bridge-inject handoff]]        ← 开标记(kind = 块的种类,人读得懂)
 *   …注入正文…
 *   [[/bridge-inject]]               ← 闭标记(固定,不带 kind)
 *
 * 选这个形状的理由:① `[[ ]]` 在真实聊天里几乎不出现(不像 XML 标签容易被 markdown/卡片文案
 * 撞上);② **不叫 `<system-reminder>`**(那是 DSH 的形状,我们的标记必须一眼分得清是谁注入的);
 * ③ 行式、无转义问题。
 *
 * ## 剥壳语义(保守:宁可多剥,不可把注入当成她的话)
 *
 *  · 完整块(含**嵌套**的同类块)→ 整块换成 `\n`(与 `stripInjectedBlocks` 同口径:行数不删,
 *    免得把后面的人话和它粘成一行);
 *  · **只有开标记没有闭标记**(被截断)→ 从开标记剥到文末 —— 注入内容永远不算她的话;
 *  · 孤立的闭标记 → 删那一行;
 *  · 没有标记 → 原样返回(不碰人话)。
 */

/** 闭标记(固定)。开标记带 kind:`[[bridge-inject handoff]]`。 */
export const INJECT_CLOSE = '[[/bridge-inject]]';

/** 已登记的 kind(开标记必须带其中之一;登记表防手滑写错 kind 后剥壳认不出来)。 */
// ⚠️ `kb` = 知识库块(W3 / P2-B,2026-10-22):doc/doc_chunk 里"她在原作经历过"的资料,
//    作为独立来源块注入(预算独立 ≤300 字)。照抄 insight 的登记形状 —— kind 不登记,
//    wrapInject 当场抛,别等归档剥壳时静默漏掉。
export const INJECT_KINDS = Object.freeze(['handoff', 'summary', 'recall', 'facts', 'notes', 'scene', 'insight', 'kb']);

const OPEN_RE = /^\[\[bridge-inject ([a-z0-9-]+)\]\][ \t]*$/;
const CLOSE_RE = /^\[\[\/bridge-inject\]\][ \t]*$/;

/** 开标记(本模块内部与测试用;调用方一般走 `wrapInject`)。 */
export function injectOpen(kind) {
  return `[[bridge-inject ${kind}]]`;
}

/**
 * 把一段注入正文包成自报家门的块(kind 必须在 `INJECT_KINDS` 里 —— 写错当场抛,
 * 别等剥壳时静默漏掉)。正文原样进块,不做任何转义(剥壳按标记行切,不看内容)。
 */
export function wrapInject(kind, body) {
  if (!INJECT_KINDS.includes(kind)) {
    throw new Error(`wrapInject: 未登记的注入 kind "${kind}"(登记表 INJECT_KINDS)`);
  }
  return `${injectOpen(kind)}\n${String(body ?? '').trim()}\n${INJECT_CLOSE}`;
}

/** 文本里有没有我们的注入标记(快速判,不做完整剥壳)。 */
export function hasInjectMarks(text) {
  const t = String(text ?? '');
  return t.includes('[[bridge-inject ') || t.includes(INJECT_CLOSE);
}

/**
 * 剥壳:去掉所有注入块(含嵌套;截断的开标记剥到文末)。纯函数、与 `stripInjectedBlocks`
 * 同一条"换行不删行"口径。**归档/记忆/transcript 的读路径统一走这里**(经
 * `transcript.stripInjectedBlocks` 并入,一个咽喉 —— D159)。
 */
export function stripInjectMarks(text) {
  const src = String(text ?? '');
  if (!hasInjectMarks(src)) return src;
  const lines = src.split('\n');
  const out = [];
  let depth = 0;
  for (const line of lines) {
    if (OPEN_RE.test(line.trim())) {
      if (depth === 0) out.push(''); // 外层块开头:块换成**一个空行**(换行不删行,与 stripInjectedBlocks 同口径)
      depth += 1; // 进块(嵌套的内层开头不再补空行)
      continue;
    }
    if (CLOSE_RE.test(line.trim())) {
      if (depth > 0) depth -= 1; // 闭标记:配对成功,块到这结束
      else out.push(''); // 孤立闭标记:也按"换成空行"处理
      continue;
    }
    if (depth > 0) continue; // 块内的行
    out.push(line);
  }
  // depth > 0 走到这里 = 开标记没闭合(截断):上面循环已把它后面的行全丢了,语义即"剥到文末"。
  return out.join('\n');
}
