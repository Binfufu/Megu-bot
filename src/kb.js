/**
 * 知识库:切块与渲染(2026-10-02,见 `docs\03` D95)。
 *
 * 它是**第二个记忆来源**:对话记忆是"她/你说过的话",知识库是"**她在原作里经历过的**"。
 * 用户 2026-10-02 的口径(照抄):「经历过原作故事性的[角色]与我们联系互动交流,
 * [角色]本身有经历过原作故事的记忆」—— 所以注入的措辞是"**她的经历**",
 * 而不是"一份外部资料";但仍然有两条硬边界:
 *   ① **不许跟"你们之间的事"混**(原作里的伙伴 ≠ 你);
 *   ② **永不进交接 / 摘要 / 固化 / 关于人的事实**(那四处是对话记忆的地盘)。
 *
 * ⚠️ 切块是**导入时**做的,检索那一路不做任何切分 —— 库里存的是成品。
 *    这样"她会看到什么"在导入时就能一眼看完(`kb-import.js --dry-run` 会打预览)。
 */

import { INFRA_CONTENT, infraText } from './local-infra-content.js';

/** 目标块长(字)。300–500 是"够一段完整的剧情、又不会一次占掉太多预算"。 */
export const CHUNK_TARGET = 420;
/** 硬上限:超过就一定要断(在句号处断)。 */
export const CHUNK_MAX = 600;
/** 太短的块会被并进上一块(免得"一句话一块"把预算切碎)。 */
export const CHUNK_MIN = 120;

/** 小标题的样子:markdown 标题、`【…】`、`第 N 卷/章/节`、或 `1.2 xxx` 这类编号行。 */
const HEADING = /^(#{1,6}\s+\S|【[^】]{1,30}】|第[0-9一二三四五六七八九十百]+[卷章节话]|[0-9]+(\.[0-9]+){0,2}[、.．\s]\s*\S)/;
/** 句子边界(中文为主)。断块只在这里断,不留半句。 */
const SENTENCE = /(?<=[。！？；!?;])\s*/;

/**
 * 把一段原文切成**检索用的块**。**纯函数**(给同样的输入永远给同样的输出)。
 *
 * 规则(定死,不许模型自己决定):
 *   1. 先按空行/小标题切**段**;小标题进 `heading`,它同时是检索线索;
 *   2. 相邻段**攒到 `CHUNK_TARGET` 附近**再收一块(太短的块会把预算切碎);
 *   3. 单段超过 `CHUNK_MAX` → 在**句号**处断开;实在没有句号才硬切;
 *   4. **不重叠** —— 重叠会让同一条被端出来两遍。
 *
 * @param {string} text
 * @param {{target?: number, max?: number, min?: number, baseHeading?: string}} [options]
 * @returns {Array<{heading: string|null, text: string, chars: number}>}
 */
export function chunkKnowledge(text, { target = CHUNK_TARGET, max = CHUNK_MAX, min = CHUNK_MIN, baseHeading = null } = {}) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (source === '') return [];

  const blocks = [];
  let heading = baseHeading;
  for (const raw of source.split(/\n{2,}/)) {
    const block = raw.trim();
    if (block === '') continue;
    // 整段就是一个小标题(短、以标题形态开头)→ 只更新 heading,不产块。
    if (block.length <= 40 && HEADING.test(block) && !block.includes('\n')) {
      heading = block.replace(/^#{1,6}\s*/, '').replace(/^【|】$/g, '').trim();
      continue;
    }
    // 段内可能混着"标题行 + 正文行":逐行过一遍,遇到标题行就换 heading。
    for (const piece of splitByHeadingLines(block, heading)) {
      if (piece.heading !== heading) heading = piece.heading;
      for (const part of splitLong(piece.text, max)) {
        blocks.push({ heading, text: part });
      }
    }
  }

  // 攒块:把相邻的小块并起来,直到接近 target。
  const chunks = [];
  let buffer = null;
  for (const block of blocks) {
    if (buffer === null) {
      buffer = { ...block };
      continue;
    }
    const sameHeading = buffer.heading === block.heading;
    const room = buffer.text.length + 1 + block.text.length;
    // ⚠️ 上限要**同时**看目标长度与硬上限:只写 `target + max/4` 的话,
    //    调用方把 max 调小时(测试里用 200)块会长到 470 —— 硬上限就不是硬的了(测试抓到过)。
    if (sameHeading && room <= Math.min(target + max / 4, max)) {
      buffer.text = `${buffer.text}\n${block.text}`;
      continue;
    }
    chunks.push(buffer);
    buffer = { ...block };
  }
  if (buffer !== null) chunks.push(buffer);

  // 尾巴太短就并进上一块(但别越过 max,**也别跨小标题** —— 一块只讲一件事)。
  for (let index = chunks.length - 1; index > 0; index -= 1) {
    const chunk = chunks[index];
    const previous = chunks[index - 1];
    const sameChunkTopic = (chunk.heading ?? null) === (previous.heading ?? null);
    if (sameChunkTopic && chunk.text.length < min && previous.text.length + chunk.text.length + 1 <= max) {
      previous.text = `${previous.text}\n${chunk.text}`;
      chunks.splice(index, 1);
    }
  }
  return chunks.map((chunk) => ({ heading: chunk.heading ?? null, text: chunk.text, chars: chunk.text.length }));
}

/** 段内逐行拆:标题行单独成"换 heading 的信号"。 */
function splitByHeadingLines(block, initialHeading) {
  const out = [];
  let heading = initialHeading;
  let buffer = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text !== '') out.push({ heading, text });
    buffer = [];
  };
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '' && HEADING.test(trimmed) && trimmed.length <= 40) {
      flush();
      heading = trimmed.replace(/^#{1,6}\s*/, '').replace(/^【|】$/g, '').trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

/** 单段超长 → 在句号处断;没有句号才硬切(硬切是下策,所以留个标记好核对)。 */
function splitLong(text, max) {
  if (text.length <= max) return [text];
  const sentences = text.split(SENTENCE).filter((one) => one !== '');
  const parts = [];
  let current = '';
  for (const sentence of sentences) {
    if (current !== '' && current.length + sentence.length > max) {
      parts.push(current);
      current = '';
    }
    if (sentence.length > max) {
      // 一整句就超过上限(罕见):硬切,并在块里留个可见的续接标记。
      for (let offset = 0; offset < sentence.length; offset += max) {
        parts.push(sentence.slice(offset, offset + max));
      }
      continue;
    }
    current += sentence;
  }
  if (current !== '') parts.push(current);
  return parts.filter((one) => one.trim() !== '');
}

/** 导入前的预览:块的分布 + 预算估计(**先看再写**,与 `announce-preview` 同一个习惯)。 */
export function previewChunks(chunks, { target = CHUNK_TARGET } = {}) {
  const list = chunks ?? [];
  const chars = list.reduce((sum, chunk) => sum + chunk.chars, 0);
  const longest = list.reduce((best, chunk) => (chunk.chars > (best?.chars ?? 0) ? chunk : best), null);
  return {
    count: list.length,
    chars,
    // 中文粗估 1 字 ≈ 1 token;注入预算是"每轮最多花多少",所以看的是单块长度。
    longest: longest?.chars ?? 0,
    average: list.length === 0 ? 0 : Math.round(chars / list.length),
    overBudget: list.filter((chunk) => chunk.chars > target).length,
  };
}

/**
 * 把选中的块渲染成**要注入的那一小段**。
 *
 * ⚠️ 头一行是**口径**,不是客套:用户 2026-10-02 定的形状是
 * "她本人经历过原作故事" —— 所以她可以把它当**自己的经历**说;
 * 但必须同时挡住"把原作里的伙伴说成你们之间的人"这件最糟的事(C 档:错了不报错)。
 *
 * @param {Array<{heading?: string|null, text: string}>} picked
 * @param {{budgetChars?: number, budget?: number}} [options]
 */
export function renderKnowledge(picked, { budgetChars = 600 } = {}) {
  const list = (picked ?? []).filter((chunk) => String(chunk?.text ?? '').trim() !== '');
  if (list.length === 0) return '';
  const lines = [
    '【原作经历】以下是**她自己在原作故事里经历过**的（那是她的记忆，不是你们之间的经历）：',
    '可以当成自己的经历自然地提起；但**绝不要**把原作里的伙伴/事件说成「你们」之间发生过的。',
  ];
  let used = lines.join('\n').length;
  for (const chunk of list) {
    const heading = chunk.heading ? `〔${chunk.heading}〕` : '';
    const line = `· ${heading}${String(chunk.text).replace(/\s+/g, ' ').trim()}`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

/**
 * 百科模式(2026-10-22 主人拍板,D297):「细说 / 为什么 / 是什么」这类求知识的问题,
 * 不要她用聊天短句敷衍,而是基于知识库检索给**约 100 字**的说明式回答。
 *
 * · 识别用**纯字面**意图词表 —— 与 recallDecision 那套内容标签是两回事(那套是
 *   主实例世界观词表,管不了"这句话想学知识");
 * · 只在**知识库真的命中**时才生效(kbNote 里判定):命中才把 `ENCYCLOPEDIA_NOTE`
 *   附在资料块尾部;没命中 = 她照角色卡说话,行为一字不变;
 * · 指令写在 kb 块**内部** —— 归档剥壳时随块一起消失,不会漏进她的记忆
 *   (selftest-kb 的剥壳判据管着)。
 */

/** 触发百科模式的意图词(字面级;「为什么」泛,但它只影响回答形状,不新增触发路)。 */
export const ENCY_INTENT_RE = /细说|百科|科普|为什么|啥意思|什么意思|是什么|讲讲|介绍一下|解释一下/;

/**
 * 这句话是不是在求知识(「细说一下示例主题」→ true;「今天好热」→ false)。
 * 纯函数:空串/非字符串一律 false。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectEncyclopedia(text) {
  const query = String(text ?? '').trim();
  return query !== '' && ENCY_INTENT_RE.test(query);
}

/** 附在资料块尾部的措辞要求(回答形状;「约 100 字」出自主人 2026-10-22 的口径)。 */
export const ENCYCLOPEDIA_NOTE = infraText(INFRA_CONTENT.encyclopediaNote);
