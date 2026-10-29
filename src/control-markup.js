/**
 * 模型**泄漏成正文**的协议标记 —— 唯一一份剥除实现（2026-10-20 / D273）。
 *
 * 现场（2026-10-20 14:01:32，outbound #310）：`deepseek-flash` 在没有声明 `tools`
 * 的请求里，偶尔会把"想调用的工具"直接写成 DeepSeek 的原生**文本工具协议 DSML**：
 *
 *   `<｜｜DSML｜｜ calls="intake"></｜｜DSML｜｜ calls>`
 *
 * 它进了 `content`，于是三处都没接住：
 *   ① `extractIntake()`（stats.js）只认 `<intake …/>` 正则 —— 认不出；
 *   ② `sanitizeOutgoingText()`（qq.js）只剥 @ / CQ 码 / 名字前缀 —— 没剥；
 *   ③ 分条器（mood.js `splitSpokenLines`）按换行硬切 → 这行垃圾单独成一条发进群。
 *
 * DSML = DeepSeek 的文本工具协议（全角竖线 U+FF5C 包起来的特殊 token）。桥里
 * **不实现**工具循环（docs\21 g4：门留着、机器不造），所以正确做法不是"解析它"，
 * 而是在两个消费端把它当"不该出现的东西"剥掉：
 *   · 出站唯一咽喉 `sendChunked()`（index.js）；
 *   · 记忆归档 `whatSheSaid()`（memory-archive.js）—— 否则这行会被当成"她说的话"
 *     进摘要/检索的原料池（2026-10-20 当天 memory.db `turn` 里就中了一行）。
 *
 * 形状（2026-10-20 实测到的就这三种，别的先不猜）：
 *   · 一整对调用：`<｜｜DSML｜｜ calls="intake"></｜｜DSML｜｜ calls>`（开 + 体 + 闭）
 *   · 落单的开 / 闭（流式被切断、或只吐了一半）
 *   · 整枚被竖线包住的特殊 token：`<｜end▁of▁sentence｜>`（注意：**竖线在 `>` 前**）
 *
 * ⚠️ DSML 的标记形状是「**前缀**是竖线包着的 DSML，后缀是普通 `>`」——
 *    第一版按"整枚 `<｜…｜>`"写，结果只认得出 `<｜end…｜>`、认不出真现场，
 *    是单测的"落单开/闭"两条把它咬出来的（口径：判据要能说出"它为什么可能红"）。
 *
 * ⚠️ 分条器（`mood.js` 的 `splitLongPiece`）只按 `，,、：:…；;` 这些软边界切 —— 上面三种形状里
 *    没有这些字符，所以整行会一起送到这里。若将来现场出现"带这些标点、被切成半截"的标记，
 *    再补一条"半截标记"规则（现在**不做**：不为想象中的形状写判据）。
 *
 * 只认上面这几种形状，所以正常正文里的 `<`、`>`、书名号、颜文字、`A|B` 这种
 * 竖线都不受影响（有单测钉着）。
 */

/** 一整对 DSML 调用（开 + 空体或纯文本体 + 闭），一次吃完，不留半截。 */
const DSML_PAIR = /<[｜|]{1,2}DSML[｜|]{1,2}[^<>]*>[^<]*<\/[｜|]{1,2}DSML[｜|]{1,2}[^<>]*>/gi;

/** 落单的 DSML 开/闭标记（前缀竖线 + DSML + 任意属性）。 */
const DSML_TAG = /<\/?[｜|]{1,2}DSML[｜|]{1,2}[^<>]*>/gi;

/** 整枚被竖线包住的特殊 token（`<｜end▁of▁sentence｜>` 这种，竖线紧挨 `>`）。 */
const SPECIAL_TOKEN = /<\/?[｜|][^<>]{0,80}[｜|]>/g;

/** "有没有"版本：不带 `g`，免得 lastIndex 在调用之间残留。 */
const LEAK_TEST = /<\/?[｜|]{1,2}DSML[｜|]{1,2}[^<>]*>|<\/?[｜|][^<>]{0,80}[｜|]>/;

/**
 * **整行只是一串 HTML/XML 标记**(2026-10-21 / 1.171.1 / D289)。
 *
 * 现场(2026-10-21 22:50,outbound):deepseek-flash 把网页控件**原样**吐进正文 ——
 *   `<input type="text" placeholder="请输入内容" value=""/>`
 * 它没有竖线,旧剥除器认不出,整行进了群(和 1.167.4 的 DSML 同族:模型把"别的东西"
 * 当正文吐出来)。剥法与 DSML 同一条纪律:**整行只剩标记 → 该行整个不要**。
 *
 * ⚠️ 两条误伤护栏(有单测钉着):`<` 后必须紧跟**字母**(所以 `<3`、`>_<`、`A<B` 都安全);
 * 整行除标记外**不许有别的字符**(所以「看 <b>加粗</b> 吧」这种正文夹标记的行不动 ——
 * 那是她的话,不是泄漏)。
 */
const MARKUP_LINE_TEST = /^(?:<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[^\n<>]*)?\/?>[ \t\u3000]*)+$/;

/** 单行判定(导出给测试):这一行是不是"只剩标记"。 */
export function isMarkupOnlyLine(line) {
  const trimmed = String(line ?? '').trim();
  if (trimmed === '' || !trimmed.startsWith('<')) return false;
  // ⚠️ 本项目自己的 `<intake …/>` 标记**不归这一层**(stats.js 的 extractIntake 负责)——
  //    它长得确实像 HTML 自闭标签,但它是结构化数据;行里出现它就整行当正文留
  //    (宁可漏剥,不可错剥自己的标记;D273 交付时同一条边界)。
  if (/<\/?intake\b/i.test(trimmed)) return false;
  return MARKUP_LINE_TEST.test(trimmed);
}

function hasMarkupOnlyLine(source) {
  // 快路径:连"<字母"都没有就不可能有标记行
  if (!/<[a-zA-Z]/.test(source)) return false;
  return source.split('\n').some(isMarkupOnlyLine);
}

/**
 * 这条出站文本里有没有泄漏的协议标记。
 *
 * 调用方（`sendChunked`）用它决定要不要记一条 `warn` —— **剥除不许静默**，
 * 否则又变成"日志里什么都没有、群友看到一条乱码"。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasLeakedControlMarkup(text) {
  const source = String(text ?? '');
  return LEAK_TEST.test(source) || hasMarkupOnlyLine(source);
}

/**
 * 剥掉泄漏成正文的协议标记(DSML 三型 + 整行 HTML/XML 标记,D289)。
 *
 * @param {string} text 模型回复 / 待发正文
 * @returns {string} 剥完的正文；**整行只剩标记时那一行整个消失**（调用方按空串跳过该条）
 */
export function stripLeakedControlMarkup(text) {
  const source = String(text ?? '');
  if (!/[｜|]/.test(source) && !hasMarkupOnlyLine(source)) return source;
  const withoutDsml = source
    .replace(DSML_PAIR, '')
    .replace(DSML_TAG, '')
    .replace(SPECIAL_TOKEN, '');
  return withoutDsml
    .split('\n')
    // 整行只剩标记的行整个拿掉(D289;DSML 剥完留下的空行由下面两步收掉)
    .filter((line) => !isMarkupOnlyLine(line))
    .join('\n')
    // 剥完留下的"只有空白"的行清掉（它整行本来就是标记）；正常段落之间的空行保留
    .replace(/^[ \t\u3000]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
