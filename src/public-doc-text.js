/**
 * **公开文档文案的中性化**(2026-10-30)—— 去掉内部决策号(`D##`),只留中性说明。
 *
 * ## 为什么单独一个模块
 * 公开集里的**生成类**文档(`docs\命令与关键字.md`、`docs\17-通道策略表.md`、
 * `docs\16-边界契约-公开版.md`)的数据源同时被私有侧复用;数据里的 `D##` 是**内部追溯号**,
 * 公开页不该出现。所以不在数据里删(私有侧还要拿它追决策),而是在**渲染这一步**去掉 ——
 * 与"文档是数据的渲染,不是第二份实现"同一个口径(见 `src\boundary-contract.js` 的头注释)。
 *
 * ⚠️ 只做字符级中性化(去掉号与挂着号的话头、清掉多余空格),不重写句子;语义靠数据本身写清。
 * 私有全量页**不用**这个函数:决定号在私有页里仍然保留。
 *
 * @module public-doc-text
 */

/** 一个决策号,或 `D32/D33` 这样的列表(只在 `D`+数字上匹配,不碰版本号)。 */
const DECISION_REF = String.raw`D\d{1,4}(?:\s*[/、,]\s*D\d{1,4})*`;

const ONLY_REF_PAREN = new RegExp(String.raw`[（(]\s*${DECISION_REF}\s*[)）]`, 'g');
const LEADING_REF_PAREN = new RegExp(String.raw`[（(]\s*${DECISION_REF}\s*[:：]?\s*([^()（）]*?)\s*[)）]`, 'g');
const TRAILING_REF_IN_PAREN = new RegExp(String.raw`([（(][^()（）]*?)\s*[,，;；、]\s*${DECISION_REF}\s*([)）])`, 'g');
/** 括号内“…,见 D135”:整段去掉,不留孤零零的"见"。 */
const SEEN_REF_AFTER_COMMA = new RegExp(String.raw`[,，;；]\s*见\s*${DECISION_REF}`, 'g');
/** “—— 见 D101 第五节”:公开页不该吊着一个读者看不到的章节号,整段去掉。 */
const SEEN_REF_SECTION = new RegExp(String.raw`\s*[—–\-]*\s*见\s*${DECISION_REF}\s*第[\d一二三四五六七八九十百]+节`, 'g');
/** 行内动词引用,留动词:“见 D101” → “见”。 */
const INLINE_VERB_REF = new RegExp(String.raw`(见|参见|判|按|照)\s*${DECISION_REF}\s*`, 'g');
const SLASH_REF = new RegExp(String.raw`\s*[/、]\s*${DECISION_REF}`, 'g');
const ANY_REF = new RegExp(String.raw`\s*${DECISION_REF}`, 'g');

/**
 * 把一段文档文案里的内部决策号去掉。纯函数、幂等为空(没有号时原样返回)。
 *
 * 处理形状(都是本项目公开页实际出现过的):
 * - 括号里只有号:`(D40)` / `(D32/D33)` → 整段去掉
 * - 括号以号开头还有说明:`(D104:好感度只有档位)` / `(D101 形态三)` → `(好感度只有档位)` / `(形态三)`
 * - 括号里逗号后挂着号:`(来自平台的群信息接口,D59)` → `(来自平台的群信息接口)`
 * - 指到私有记录的整句:`(…,见 D135)` / `—— 见 D101 第五节` → 整段去掉
 * - 行内动词引用:`见 D101` → `见`(保留动词)
 * - 斜杠附属引用:`1.171.0 / D288` → `1.171.0`
 * - 兜底:任何残留的号
 *
 * @param {string} text
 * @returns {string}
 */
export function neutralizeDecisionRefs(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  out = out.replace(ONLY_REF_PAREN, '');
  out = out.replace(LEADING_REF_PAREN, (_match, body) => {
    const cleaned = String(body).replace(/^[—–\-\s:：,，、;；]+/, '').trim();
    return cleaned ? `(${cleaned})` : '';
  });
  out = out.replace(TRAILING_REF_IN_PAREN, (_match, head) => `${String(head).replace(/^[（(]/, '(')})`);
  out = out.replace(SEEN_REF_AFTER_COMMA, '');
  out = out.replace(SEEN_REF_SECTION, '');
  out = out.replace(INLINE_VERB_REF, '$1');
  out = out.replace(SLASH_REF, '');
  out = out.replace(ANY_REF, '');
  // ⚠️ 别做"删空括号"的清理:`sendChunked()` 这类**代码记法**里的空括号是内容,不是残余。
  out = out
    .replace(/\s+([,，;；:：)）])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out;
}
