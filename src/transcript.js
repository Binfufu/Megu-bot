/**
 * 会话记录解析(2026-10-01,见 `docs\03` D90)。**这一层存在的唯一理由:与桥的取法一致。**
 *
 * ## 背景(一次误报)
 *
 * 排查群聊时我直接取了 `data.message.content[0].text` —— 而 DSH 的助手消息里
 * **第一个块常常是 `reasoning`(思考过程)**,不是要说出去的话。于是我把她的英文思考
 * 当成了"她发到群里的英文分析",报了一个**假 bug**(用户拿去核了一轮才发现)。
 *
 * 桥自己怎么取的?`src/dsh.js` 的 `extractAssistantText()`:**只挑 `block.type === 'text'`**。
 * 所以这里**直接复用它** —— 判据只有一个:**"我看到的"必须等于"群里实际发生的"**。
 *
 * ## 两个概念要分清
 *
 * | 记录 | 里面是什么 | 怎么读 |
 * |---|---|---|
 * | `user/message` | **喂给她的提示词**:桥自己写的指令 + 群上下文(别人说的话) + 状态/情绪要求 | 要**拆**:只有"最近群里的消息"那几行才是人说的 |
 * | `assistant/message` | 她的回复:`reasoning`(想) + `text`(说) | **只取 `text`** |
 *
 * ⚠️ 不拆的话会得出"群里的人在说'如果没什么想说的就回复 [跳过]'"这种荒唐结论 ——
 * 那些是**桥塞进去的指令**,不是人话。
 */
import { extractAssistantText } from './runner-contract.js';
import { normalizeSpokenForJudge } from './mood.js';
import { isSelfLifePrompt } from './memory-archive.js';
import { stripInjectMarks } from './inject-mark.js';

/** 群上下文那一段的开头(桥写的固定话术)。 */
const GROUP_CONTEXT_HEAD = /^最近群里的消息（供你参考，不必逐条回应）：\s*$/m;
/**
 * 桥自己写的**纯样板**(解析时要跳过它们)。
 * ⚠️ 别把 `有人戳了你一下（戳一戳）。` `群里已经安静了一会儿…` 这类**描述性**首行也当样板 ——
 *    它们是"为什么叫她"的答案,正是复盘时要看的东西(踩过:把它们丢掉会让触发语错位成下一句)。
 */
const BRIDGE_NOTES = /^(场合是群聊：|注意：|如果没什么想说的|（本次表达要求|（这一轮|（下面这些是|·|【|这是随手撩你一下|别问"有什么事"|群里说的话一句都不许复述|只当开场白|这轮的话题方向)/;

/**
 * **框架 / 桥整块注入的东西**(1.106.5 / D177)—— 它们不是"谁说了什么"。
 *
 * ⚠️ 为什么要有这一刀:`user/message` 一条记录里**混着三层来源**,而 `splitPrompt()` 原来的
 * 做法是"逐行过滤样板 + 取第一行人话"。那对**逐行**的样板有效,对**整块**的注入无效 ——
 * 整块的第一行不是样板,于是它自己成了"触发语"。2026-10-10 现场(`transcript.js` 的输出):
 *
 * ```
 * 18:55:14 [点名/触发] 把它当作背景：不要复述、不要说"你刚才说过"…   ← 桥的交接块第 2 行
 * 18:55:14 [点名/触发] <system-reminder>                          ← DSH 的工作区说明(她的角色卡!)
 * 18:55:14 [点名/触发] Current runtime context. This snapshot …    ← DSH 的运行时上下文
 * ```
 *
 * 三层分别是:① **桥**写的记忆交接块(`【记忆交接】…（现在开始。）`);
 * ② **DSH** 注入的工作区说明(`<system-reminder>…</system-reminder>`,内容是角色卡);
 * ③ **DSH** 注入的运行时上下文(`Current runtime context.` 打头,**没有结束标记**)。
 *
 * ⚠️ 第 ③ 条只能"从它到文末"整条丢掉 —— 它一定是一条**独立记录**(实测),不是夹在人话中间。
 * ⚠️ 这一刀和 D90 那条判据同源:**"我看到的"必须等于"群里实际发生的"**。
 */
export const INJECTED_BLOCK_RES = Object.freeze([
  // ① 桥的记忆交接块:从 `【记忆交接】` 到它的收尾行 `（现在开始。）`
  /^【记忆交接】[\s\S]*?^（现在开始。）[ \t]*$/m,
  // ② DSH 工作区说明(整块,有闭合标签)
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  // ③ DSH 运行时上下文(没有闭合标记 → 到文末)
  /^Current runtime context\.[\s\S]*$/im,
]);

/** 把整块注入换成一个空行(**行数不删**,免得把后面的人话和它粘成一行)。 */
export function stripInjectedBlocks(text) {
  let out = String(text ?? '');
  for (const re of INJECTED_BLOCK_RES) out = out.replace(re, '\n');
  // ④ 桥自己的注入块(1.146.2 / docs\21 §六 g2:自报家门标记,剥壳只认标记不认内容;
  //    截断的开标记剥到文末 —— 注入内容永远不算她的话)。
  return stripInjectMarks(out);
}

/**
 * 把一条 `user/message` 拆成"触发语 + 别人说的话"。
 *
 * @param {string} text
 * @returns {{trigger: string, context: string[]}}
 */
export function splitPrompt(text) {
  // ⚠️ 1.106.5(D177):**先整块剥掉框架/桥注入的东西**,再逐行拆 —— 顺序反了的话,
  //    交接块的第 2 行、`<system-reminder>`、`Current runtime context.` 都会成了"触发语"。
  const source = stripInjectedBlocks(text);
  const lines = source.split('\n');
  const headIndex = lines.findIndex((line) => GROUP_CONTEXT_HEAD.test(line.trim()));
  if (headIndex === -1) {
    // 私聊/@ 消息:去掉桥的指令行,剩下人话。⚠️ **只取第一行** ——
    // 后面的"别问'有什么事'""如果觉得没必要理"全是桥的样板,不是人说的(踩过)。
    const kept = lines
      // ⚠️ **先剥场合标记,再判是不是桥的样板** —— 顺序反了会把 `[群聊] 有人戳了你一下…`
      //    整行当成"桥的指令"丢掉,于是触发语错位成下一句(踩过)。
      .map((line) => line.replace(/^\[(群聊|私聊)\]\s*/, '').trim())
      .filter((line) => !BRIDGE_NOTES.test(line))
      .filter((line) => line !== '');
    return { trigger: kept[0] ?? '', context: [] };
  }
  const context = [];
  for (const line of lines.slice(headIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed === '') break; // 上下文到空行结束
    context.push(trimmed);
  }
  // "触发语" = 桥写的注意那一行(说明为什么叫她)——日志/复盘时最有用的一条。
  const note = lines.find((line) => /^注意：/.test(line.trim()));
  if (note) return { trigger: note.trim(), context };
  // ⚠️ 1.106.5(D177):**没有 `注意：` 那一行时,不能就给空** —— 群聊那一拍是
  //    `[群聊] 酸音盐777：你们支持谁`(被关键词叫到),紧挨着"最近群里的消息"。
  //    原来这里返回空,于是 transcript 只显示一堆群消息、**看不出为什么叫她**(现场)。
  const before = lines
    .slice(0, headIndex)
    .map((line) => line.replace(/^\[(群聊|私聊)\]\s*/, '').trim())
    .filter((line) => line !== '' && !BRIDGE_NOTES.test(line));
  return { trigger: before[before.length - 1] ?? '', context };
}

/**
 * 把若干条原始记录整理成**人能读的事件流**。
 *
 * @param {Array<{type: string, time?: number, data?: object}>} records
 * @returns {Array<{role: 'you'|'her'|'group', at: number|null, text: string, context?: string[],
 *                  thinkingChars?: number}>}
 */
export function readTranscript(records) {
  const events = [];
  for (const record of records) {
    if (record?.type === 'user/message') {
      const text = record.data?.content?.find?.((block) => block?.type === 'text')?.text
        ?? record.data?.content?.[0]?.text ?? '';
      if (typeof text !== 'string' || text === '') continue;
      const { trigger, context } = splitPrompt(text);
      if (context.length > 0) events.push({ role: 'group', at: record.time ?? null, text: context.join('\n'), context });
      if (trigger !== '') {
        events.push({
          role: 'you',
          at: record.time ?? null,
          text: trigger,
          // ⚠️ 1.106.5(D177):这一条**没有人点她** —— 是"她自己开口"那一档的提示词
          //    (她自己过日子/到了/出发/钩子收尾)。显示时不该写成"点名/触发"。
          selfInitiated: isSelfLifePrompt(trigger),
        });
      }
      continue;
    }
    if (record?.type === 'assistant/message') {
      // ⚠️ **只用桥那一套取法**:这就是这个模块存在的理由。
      const said = extractAssistantText(record);
      const blocks = Array.isArray(record.data?.message?.content) ? record.data.message.content : [];
      const thinkingChars = blocks
        .filter((block) => block?.type !== 'text')
        .reduce((sum, block) => sum + String(block?.text ?? '').length, 0);
      if (typeof said !== 'string' || said === '') continue;
      events.push({ role: 'her', at: record.time ?? null, text: said, thinkingChars });
    }
  }
  return events;
}

/**
 * **把"她写出来的"和"真的发出去的"对上**(纯函数;1.106.3 / D175)。
 *
 * ⚠️ 为什么需要它:`readTranscript()` 读到的 `assistant/message` 是**模型原文**,
 *    而从"写了"到"发了"中间还有 `planSpokenLines()`(分条 / 去行尾标点)、
 *    `sanitizeOutgoingText()`(剥 @ 与名字前缀)、`chunkText()`(1500 字切块)。
 *    2026-10-10 现场:模型写了 64 字,群里只收到 28 字 —— 只看 transcript 会以为整段都发了。
 *
 * 判据很朴素:**时间最近 + 同一个会话**(`scene` / `target` 由调用方先过滤好),
 * 一条出站消息只认一次(`used` 记账),且不超过 `windowMs`。
 *
 * @param {Array<{at: number|null, role: string, text: string}>} events 聊天记录(时间正序)
 * @param {Array<{at: number, text: string}>} rows 出站留痕(时间正序)
 * @param {{windowMs?: number}} [options]
 * @returns {Map<number, {rows: Array, chars: number, same: boolean}>}
 *   key = `events` 里的下标(只有"她说的"且真配上了才有)
 */
export function matchOutbound(events, rows, { windowMs = 120_000 } = {}) {
  const matched = new Map();
  const used = new Set();
  const window = Math.max(0, Number(windowMs) || 0);
  // ⚠️ 比对归一用 `normalizeSpokenForJudge()`(1.171.0 / D288 起**与分段清理同一份**):
  //    分条发送会把每条的行尾标点剥掉、段内停顿标点换成空格 —— 那是**表达**上的差别,
  //    不是"内容被改"。判据仍然是"除标点/空白外内容逐字相同"。
  //    (以前这里自带一份 `CHAT_TRAILING_PUNCT` 过滤,D288 起归一只留一处实现。)
  const norm = (text) => normalizeSpokenForJudge(text);
  const list = Array.isArray(rows) ? rows : [];

  for (const [index, event] of (Array.isArray(events) ? events : []).entries()) {
    if (event?.role !== 'her') continue;
    const at = Number(event.at);
    if (!Number.isFinite(at)) continue;
    // 候选:还没被认领过、时间在窗口内 —— 取**离她这句最近**的那一条
    const candidates = list
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row, rowIndex }) => !used.has(rowIndex) && Number.isFinite(Number(row?.at))
        && Math.abs(Number(row.at) - at) <= window)
      .sort((a, b) => Math.abs(Number(a.row.at) - at) - Math.abs(Number(b.row.at) - at));
    if (candidates.length === 0) continue;

    // 以最近那条为锚,把**同一批**(紧跟其后、窗口内)的全部认领 —— 分条发就是好几条
    const anchor = Number(candidates[0].row.at);
    const batch = candidates
      .filter(({ row }) => Math.abs(Number(row.at) - anchor) <= window / 2)
      .sort((a, b) => Number(a.row.at) - Number(b.row.at));
    const texts = [];
    for (const { row, rowIndex } of batch) {
      used.add(rowIndex);
      texts.push(String(row.text ?? ''));
    }
    matched.set(index, {
      rows: batch.map(({ row }) => row),
      chars: texts.join('').length,
      same: norm(texts.join('')) === norm(event.text),
    });
  }
  return matched;
}
