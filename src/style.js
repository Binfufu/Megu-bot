/**
 * Per-turn style nudges.
 *
 * Inside one session a model anchors heavily on its own recent replies, so a
 * persona with a narrow format drifts into a template: the same bracket-action
 * opening, the same closing threat, every single time. Naming one thing to do
 * differently this turn is a cheap and effective way to break that, and it does
 * so without inflating the character card for every request.
 *
 * These are about *form* only. Tone, catchphrases and kaomoji belong to
 * `mood.js`, which rolls them in code — an earlier version of this list handed
 * the model two example kaomoji and suggested "哼一声", and both went on to
 * dominate the real output (D22). Keep examples out of this file.
 */

import { hasInjectMarks, wrapInject } from './inject-mark.js';
import { LOCAL_TURN_CONTENT } from './local-turn-content.js';

/** Original neutral pool; never aliases optional local theme content. */
export const DEMO_STYLE_NUDGES = [
  '这次直接回答，不加动作描写。',
  '这次尽量用一个简短句子回答。',
  '这次不使用固定口头禅。',
  '这次先给结论，再补必要的细节。',
  '这次用平实的语气接话。',
  '这次把不同意思分行表达。',
];

/** Legacy theme identifiers remain API-compatible; displayed content is local or neutral. */
export const MEGUMIN_STYLE_NUDGES = LOCAL_TURN_CONTENT?.styleNudges?.megumin ?? [...DEMO_STYLE_NUDGES];
export const ARIS_STYLE_NUDGES = LOCAL_TURN_CONTENT?.styleNudges?.aris ?? [...DEMO_STYLE_NUDGES];

/** 样式主题名 → 提示词表；保留旧主题接口，并提供独立中性 demo。 */
export const STYLE_NUDGE_THEMES = {
  demo: DEMO_STYLE_NUDGES,
  megumin: MEGUMIN_STYLE_NUDGES,
  aris: ARIS_STYLE_NUDGES,
};

/**
 * 兼容旧名字：默认主题。新代码请从主题里取(`theme.styleNudges`)。
 */
export const STYLE_NUDGES = MEGUMIN_STYLE_NUDGES;

/**
 * 直接回应是共享对话要求，不随随机风格、任务或严肃场景的口语闸关闭。
 * 借鉴 Google Conversation Design 的简洁回应与按需确认（asOf 2026-10-28）：
 * https://developers.google.cn/assistant/conversation-design/confirmations?hl=en
 * 本项目扩展到图片共同上下文；不注入示范台词，避免 D22 的模板化。
 */
export const DIRECT_RESPONSE_NOTES = Object.freeze([
  '直接回应：先给回答、态度或自然接话，不先复述、转述或概括对方刚说的话，也不先总结群聊。括号里的动作不是固定开场，不要求先写动作再说话；有实际语境需要时仍可自然使用动作描写。',
  '日常看图接话时，把图片当共同上下文，直接回应其中的笑点、情绪或相关细节，不先介绍画面、罗列物体或重念图中文字。',
  '可以自然提及支撑回应的局部细节，但不要为了证明看懂了而补一段说明。',
  '用户明确要求描述、识别、读字、翻译、总结、复述、原文照念或引用，或确实需要消歧、核对关键参数时，按任务需要描述或引用；看不清的如实说，不猜。',
  '只有自发接话时，没有值得补充的反应可以不发言；被直接提问时正常作答，不用沉默代替回答。',
  // ⚠️ 2026-10-28(现场:识别图像却只回宽泛类别、回避具体答案):识别类问题
  //    要给最可能的答案,不许拿防编造纪律当搪塞 —— 那条纪律管的是设定事实,不管看图认人。
  '被问「图里是谁」「这是什么」这类识别时，直接给出最可能的答案，拿不准就带一句自然的不确定；不要拿「还要再确认」「资料里没有记载」当回答 —— 防编造只管设定事实，不挡看图认人认物。',
]);

/**
 * **普通发言的固定表达要求**(1.171.0 / D288,拟人化普及)。
 *
 * 每一轮都排在随机 nudge **前面**(`nextNudges()` 里拼),它管"怎么说"的最底层
 * (短句 / 不带标点 / 不总结),随机 nudge 管这一轮的变化 —— 两层不混。
 * ⚠️ 只谈形式,不碰情绪、口头禅、颜文字(同文件头那条纪律)。
 * ⚠️ 严肃话题那一轮,整组 nudge 都会被 `turnPolicyFor().suppressNudges` 压掉,
 *    固定要求也跟着闭嘴 —— 安慰人的话不该强行去标点。
 */
export const SPOKEN_STANDING_NOTES = [
  '像发聊天消息一样说话：一次说一个意思，句子短，别写成一段书面话。',
  // ⚠️ 1.171.2 / D290(用户现场:更新后颜文字消失):"不用标点"被模型连颜文字一起收掉了 ——
  //    这句点名"颜文字不受影响"。刻意不给示例(D22:示例会主导输出)。
  '日常的话不用标点：想停顿就分句或换行；颜文字是例外，该带就带；链接、数字也照常。',
  '说完就停，不要总结，也不要客套收尾。',
];

/**
 * Pick `count` distinct nudges, preferring ones not used recently so the same
 * instruction does not land two turns in a row.
 *
 * @param {number} count
 * @param {string[]} recent nudges used on previous turns.
 * @param {string[]} [pool] 用哪套；缺省使用默认主题。
 */
export function pickNudges(count = 1, recent = [], pool = STYLE_NUDGES) {
  const table = Array.isArray(pool) && pool.length > 0 ? pool : STYLE_NUDGES;
  const fresh = table.filter((nudge) => !recent.includes(nudge));
  const available = fresh.length >= count ? [...fresh] : [...table];

  const picked = [];
  while (picked.length < count && available.length > 0) {
    const [nudge] = available.splice(Math.floor(Math.random() * available.length), 1);
    picked.push(nudge);
  }
  return picked;
}

/**
 * Append the nudge as a private note.
 *
 * Marked clearly so the model treats it as direction rather than content — it
 * must not read the instruction out loud.
 */
export function withStyleNudge(text, nudges) {
  if (!Array.isArray(nudges) || nudges.length === 0) return text;
  const blocks = [];
  let notes = [];
  const flushNotes = () => {
    if (!notes.length) return;
    blocks.push(wrapInject('notes', [
      '（本次表达要求，照做但不要念出来：）', ...notes,
    ].join('\n')));
    notes = [];
  };
  for (const nudge of nudges) {
    // F1：只给裸要求补 notes 边界；已有 recall/kb 等仍为独立来源块，顺序不变。
    if (hasInjectMarks(nudge)) { flushNotes(); blocks.push(nudge); }
    else notes.push(`· ${nudge}`);
  }
  flushNotes();
  return [text, '', ...blocks].join('\n');
}

/**
 * **把"事实"贴在消息旁边**(1.100.1 / D163)—— 与 `withStyleNudge` 是**两块不同**的东西。
 *
 * ⚠️ 为什么要分成两个函数(用户实测的现场):
 *   「绑定完没什么用,我在网站上说了我是防火门,到 QQ 就不知道了」。
 *   查下来:身份那句**生成是对的**(日志与活库都对得上),但它跟身体状态、好感一起被
 *   塞进了 `withStyleNudge` 那个「（本次表达要求，照做但不要念出来：）」的块里 ——
 *   而那一条是"**怎么说话**"的块。于是"这一轮跟你说话的人是网页上的某某"
 *   被当成一条**措辞要求**处理,她自然不会拿它回话。
 *
 * 📌 **事实与要求不能同居一栏**:要求是"照做别说",事实是"知道就行、要用就用" ——
 *    语气与位置都不一样,混在一起时模型只会听**块标题**那句。
 *
 * 用法(顺序也是刻意的:消息 → 事实 → 表达要求):
 *
 *   withStyleNudge(withFacts(sceneText, facts), styleNudges)
 *
 * @param {string} text 已经拼好的正文(场景标签 + 消息)
 * @param {string[]} facts 这一轮的事实(空/不是数组 → 原样返回)
 * @returns {string}
 */
export function withFacts(text, facts) {
  if (!Array.isArray(facts) || facts.length === 0) return text;
  // ⚠️ 2026-10-18(P0-2 注入卫生):整块包进 `[[bridge-inject facts]]` 自报家门标记。
  //    以前这块**裸着**贴在消息后面,归档时只靠 `stripInjectedNotes` 切字面 ——
  //    而它切的字面表里**没有「这一轮的事实」**,于是注入块被当成人话入库
  //    (旧实例实测:479 轮、153 条 note)。现在形状与交接块同一套约定(D177):
  //    剥壳只认标记,不认内容 —— 将来这块措辞怎么改都不会再漏。
  //    ⚠️ 标记里的正文**原样**保留:模型看到的是同一句话,只是多了两行边界。
  return [
    text,
    '',
    wrapInject('facts', [
      '（这一轮的事实（知道就行，别解释来源）：）',
      ...facts.map((fact) => `· ${fact}`),
    ].join('\n')),
  ].join('\n');
}

/** Keep only the most recent nudges, for the "don't repeat" filter. */
export function rememberNudges(recent, picked, limit = 4) {
  return [...recent, ...picked].slice(-limit);
}

/** Characters that only ever show up in a kaomoji, never in spoken prose. */
const KAOMOJI_CHARS = /[ω・∀Ддﾟ｀´๑٩۶✧✦◕‿ヽノヾゝゞ≧≦＞＜＾▽△∇￣﹏艸¯]/;
/** A parenthesised run at the end of a line, e.g. `(｀・ω・´)`. */
const TRAILING_KAOMOJI = /[（(][^）)\n]{1,20}[）)][ \t\u3000]*$/;

/** Ranges rendered two columns wide, which is what a chat bubble wraps on. */
const WIDE = /[\u1100-\u115F\u2E80-\u303F\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Rough display width: full-width characters count as two columns. */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) width += WIDE.test(char) ? 2 : 1;
  return width;
}

/**
 * Move a trailing kaomoji onto its own line when the current one is too wide.
 *
 * QQ wraps a message at the bubble's width, and a kaomoji is just characters to
 * it — `(｀・ω・´)` can be sliced down the middle when it does not fit at the end
 * of a line. Measured over 445 real replies, the text the bot *emits* never had
 * a newline inside a kaomoji, so what is seen in QQ is the client's own wrapping;
 * the only way to stop it is to not let the kaomoji sit at the end of a long line.
 *
 * This is done conditionally rather than always: a short line wraps nowhere, and
 * a kaomoji on a line of its own looks like a separate sticker.
 *
 * @param {string} text
 * @param {{maxWidth?: number}} [options] `0` pushes every trailing kaomoji down.
 */
export function breakBeforeKaomoji(text, { maxWidth = 32 } = {}) {
  if (!Number.isFinite(maxWidth)) return text;
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const match = TRAILING_KAOMOJI.exec(line);
      if (!match) return line;
      const kaomoji = match[0].trim();
      // A parenthesised action like `（把帽檐往下压了压）` is prose, not a face.
      if (!KAOMOJI_CHARS.test(kaomoji)) return line;
      const before = line.slice(0, match.index).replace(/[ \t\u3000]+$/, '');
      if (before === '') return line;
      if (displayWidth(before) + displayWidth(kaomoji) <= maxWidth) return line;
      return `${before}\n${kaomoji}`;
    })
    .join('\n');
}
