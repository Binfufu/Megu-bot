/**
 * **搜索指令的统一路由**（2026-11-24，收口「找本被当发图」的交叉混乱）。
 *
 * 背景：入口 `src\index.js` 里美图分支在前、JM 分支在后，各自只看“自己能不能解析”。
 * 美图解析器的“残缺指令”形状又特别宽（`来/找/发/搬 + 点/张 + 任意`），于是
 * 「来点本子」「来点作者甲的本子」先被美图吃掉；服务层查不到角色 → 走单次模型理解兜底 →
 * 常常回 character:null → **随机发图**。这是本轮要修的交叉混乱。
 *
 * 本模块是**纯函数、零 IO**（不联网、不读文件、不碰子进程），只把“这一句到底该谁处理”
 * 算清楚，供后续在 `src\index.js` 里接线（本轮**不改 index.js**）：
 *
 *     routeSearchCommand('来点本子')
 *     → { kind:'book', stage:'fuzzy', component:'jm', action:null, parsed:null,
 *         hint:'keyword', reason:'keyword' }
 *
 * 返回结构（固定字段）：
 *   · kind      'book' | 'image' | 'ambiguous' | 'none'
 *   · stage     'strict' | 'fuzzy'
 *               strict = 被**既有的严格解析器**原样接住（JM `parseJmCommand` / 美图
 *               `parseMeituCommand` 对原句直接解析成功）；fuzzy = 靠既有模糊解析器或本轮新增
 *               的自然句式/「搜」系形状接住。ambiguous / none 一律记 fuzzy（没有严格解析器接住）。
 *   · component 'jm' | 'meitu' | null —— 该谁执行；ambiguous/none 为 null
 *   · action    'search' | 'download' | 'pack' | 'page' | 'send' | null
 *               JM 侧沿用解析器给的 action；美图侧发图记 'send'；没解析出命令形状为 null
 *   · parsed    对应解析器的结果对象（成功才有；失败/澄清/不认都是 null）
 *   · hint      'clarify' | 'format' | 'keyword' | null
 *               clarify = 目标名词两边都有/两边都没有，只能问一句；
 *               format  = 明显在写指令但写歪了（调用方回格式/近失提示）；
 *               keyword = 只说了要找书、没给关键词（调用方要一句“搜什么？”）
 *   · reason    机器可读的原因（路由分歧用 `both-targets`/`no-target-noun`/`no-command`/`empty`；
 *               解析失败沿用解析器的 reason，如 `format`/`count`/`unsupported`）
 *
 * ── 路由规则（顺序）────────────────────────────────────────────────────────────
 * ① **目标名词闸**（必须有）：书/媒体名词（`hasBookTarget`：本、本子、书、漫画、单行本、资源…）
 *    且没有图像名词 → 归 book，**永不走 meitu**；只有图像名词（`hasImageTarget`：图、图片、
 *    美图、涩图、色图、擦边图、照片、壁纸、截图…）→ 归 image。
 *    两张词表分别只存在于 `src\jm-command.js` 与 `src\meitu-command.js`，这里只引用，不抄。
 * ② 两边都有名词，或两边都没有但**指令形状明显**（动词+张/点/些，或裸「搜」+关键词）→
 *    `ambiguous` + hint 'clarify'：**不猜**，宁可问一句也不把找本的指令发成图。
 * ③ book 侧依次复用：`parseJmCommand`（strict）→ `parseJmFuzzyCommand`（fuzzy）→
 *    本轮新增自然句式（fuzzy）→ `looksLikeJmAttempt`（只给格式提示）→ 都不是 = none。
 * ④ image 侧依次复用：`parseMeituCommand` 原句（strict）→ 本轮新增「搜」系形状（fuzzy）→
 *    `looksLikeMeituAttempt`（只给格式提示）→ 都不是 = none。
 *
 * ⚠️ **不要把「搜」加进美图动词表**（`src\meitu-command.js` 的 VERBS）：那会再次吞掉
 *    「搜点本子」。image 侧的「搜」形状只在本文件里做**动词替换**，解析仍交给
 *    `parseMeituCommand`（一份实现，角色/数量/修饰/档位一个字段都不另算）。
 *
 * ⚠️ 保守选择的代价（写在交接里）：没有目标名词的旧残缺发图形状（`来3张随便的`、`来2张`）
 *    现在会进 ambiguous 澄清，而不是直接随机发图 —— 目标名词闸是主人本轮拍板的硬闸。
 */

import {
  DEFAULT_JM_MAX,
  hasBookTarget,
  looksLikeJmAttempt,
  normalizeCommandText,
  parseJmCommand,
  parseJmFuzzyCommand,
} from './jm-command.js';
import {
  DEFAULT_MEITU_MAX,
  hasImageTarget,
  looksLikeMeituAttempt,
  parseMeituCommand,
} from './meitu-command.js';

/** 路由结果骨架（所有分支都补全这 8 个字段，调用方不必判 undefined）。 */
function baseResult(overrides) {
  return {
    kind: 'none',
    stage: 'fuzzy',
    component: null,
    action: null,
    parsed: null,
    hint: null,
    reason: null,
    ...overrides,
  };
}

/** 澄清结果：目标名词两边都有/两边都没有，不猜边。 */
function clarify(reason) {
  return baseResult({ kind: 'ambiguous', hint: 'clarify', reason });
}

/** book 侧成功结果（action 沿用 JM 解析器给的 search/download/pack）。 */
function bookResult(stage, parsed) {
  return baseResult({ kind: 'book', stage, component: 'jm', action: parsed.action, parsed });
}

/** image 侧成功结果（美图解析器的解析成功 = 要发图，action 记 send）。 */
function imageResult(stage, parsed) {
  return baseResult({ kind: 'image', stage, component: 'meitu', action: 'send', parsed });
}

/** image 侧“明显在写指令但写歪了”。 */
function imageFormat(reason) {
  return baseResult({ kind: 'image', hint: 'format', reason: reason ?? 'format' });
}

/**
 * 「本子来点」「来点本子」这类**只有目标名词、没有关键词**的形状。
 * 认得出意图，但没东西可搜 → hint 'keyword'（调用方问一句“搜什么？”）。
 * 单独列白名单而不是放宽正则：这些句子没有可提取的关键词，误判代价是白问一句。
 */
const BARE_BOOK_ATTEMPTS = new Set([
  '来点本子', '来点本', '来几本', '来几本本子', '来本', '来本子',
  '整点本子', '整点本', '搜点本子', '搜点本', '搜几本',
  '发点本子', '找点本子', '找本子', '要几本', '要本子', '查本子',
  '本子来点', '本子来几本', '本子整点', '本子搜点', '本子发点', '本子找点',
  '有本子吗', '有本吗', '有没有本子',
]);

/** 自然句式里的关键词清洗：去首尾标点/空白/「的」。 */
function cleanNaturalKeyword(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/^[，,、;；\s的]+/u, '')
    .replace(/[，,、;；\s的]+$/u, '')
    .trim();
}

/**
 * 自然句式统一收口：把抽出来的关键词**重写成「搜本 <关键词> [数量]」**，交给
 * `parseJmCommand` 解析 —— 关键词长度/数量夹取/结构化条件全部复用同一份实现，
 * 自然句式这一层不另算任何一个字段。
 *
 * @returns {{parsed: object} | {hint: 'keyword'|'format', reason: string}}
 */
function naturalBookFromKeyword(keyword, maxJm) {
  const cleaned = cleanNaturalKeyword(keyword);
  if (!cleaned) return { hint: 'keyword', reason: 'keyword' };
  const parsed = parseJmCommand(`搜本 ${cleaned}`, { max: maxJm });
  if (parsed.ok) return { parsed };
  return { hint: 'format', reason: parsed.reason ?? 'format' };
}

/**
 * **book 侧新增自然句式**（fuzzy 层；只在 strict/fuzzy 都失败后调用）。
 *
 * 覆盖（2026-11-24 现场实测不认识的说法）：
 *   来几本<kw>(的) / 来点<kw>的本子 / 整点<kw>本子 / 搜点<kw>本子 / 要几本<kw> /
 *   有<kw>本子吗 / 查(找)<kw>本子 / 来本<kw> / 本子来点(无关键词→hint 'keyword')
 *
 * 不认（交给调用方当闲聊/模型）：日本 / 本来 / 成本 / 基本 / 老板本来 /
 * 「这个本子不错」这类没有请求动词的讨论 —— 目标名词闸之外还有命令形状闸。
 *
 * 复合词护栏不在这里：`hasBookTarget` 已经用 `FUZZY_BEN_COMPOUNDS` 挡过一遍；
 * 这里再用 `cleanNaturalKeyword` 只做字符清洗，不复制词表。
 *
 * @param {string} text 已归一化的正文
 * @param {number} maxJm 一次最多搜几本
 * @returns {{parsed: object}|{hint: 'keyword'|'format', reason: string}|null}
 */
function parseNaturalBookCommand(text, maxJm) {
  const value = String(text ?? '');

  // ① 动词 + (数量) + 本 + 关键词(的)：来几本全彩的 / 要几本原神 / 来两本全彩 / 来本全彩。
  //    「来本子全彩」的「本子」是目标后缀，剥掉再取关键词。
  const verbBen = /^(?:来|找|整|要|搜|发|搬|搞|看)\s*(几|[一二两三四五]|\d{1,2})?\s*本\s*(.+?)的?$/u.exec(value);
  if (verbBen) {
    let rest = verbBen[2];
    if (rest.startsWith('子')) rest = rest.slice(1);
    if (rest) {
      // 「几」= 按上限（与美图「来几张=5」同口径），交给 jm 解析器时**不写数量**（默认上限）；
      // 只把 jm 严格解析器认得的数字/中文数量附在关键词后面，让数量夹取仍走同一份代码。
      const token = verbBen[1];
      const countSuffix = token && /^(?:\d+|[一二两三四五])$/u.test(token) ? ` ${token}` : '';
      return naturalBookFromKeyword(`${rest}${countSuffix}`, maxJm);
    }
  }

  // ② 动词 + 点 + 关键词 + 的本子/本：来点全彩的本子 / 搜点原神本子 / 整点原神本子。
  const verbDian = /^(?:来|找|整|搜|发|要|搬|搞|看)点\s*(.+?)\s*(?:的)?\s*(?:本子|本)$/u.exec(value);
  if (verbDian) {
    const rest = verbDian[1];
    // 「来点单行本」不是“关键词=单行 + 本”，而是只说了媒体名词 → 没关键词。
    if (/^(?:单行|同人|漫画)$/u.test(rest)) return { hint: 'keyword', reason: 'keyword' };
    return naturalBookFromKeyword(rest, maxJm);
  }

  // ③ 有<kw>本子吗：有原神本子吗 / 有全彩本子嘛？
  const youMa = /^有\s*(.+?)\s*本子\s*(?:吗|嘛|么|呢)?\s*[?？]?$/u.exec(value);
  if (youMa) return naturalBookFromKeyword(youMa[1], maxJm);

  // ④ 查/查找/找 + kw + 本子：查找全彩本子 / 查原神本子 / 找全彩的本子。
  const chaBen = /^(?:查找|查|找)\s*(.+?)\s*(?:的)?\s*本子$/u.exec(value);
  if (chaBen) return naturalBookFromKeyword(chaBen[1], maxJm);

  return null;
}

/** 裸「X本子」：关键词前缀里出现这些功能词就不当搜索请求（避免「我买了个本子」误触发）。 */
const BARE_BOOK_PREFIX_STOP = new Set([
  '这', '那', '这个', '那个', '这些', '那些', '这本', '那本', '一本', '两本', '几本',
  '什么', '哪', '哪本', '哪部', '我的', '你的', '他的', '她的', '它的', '我们', '你们',
  '他们', '咱们', '本', '这堆', '那堆',
]);
const BARE_BOOK_PREFIX_BAD = /[的了吗呢吧啊是在有没要想看写用买说和与及我你他她它这那]/u;
const BARE_BOOK_RE = /^([\u3400-\u9fffA-Za-z0-9·・_-]{1,16})(?:本子|本)$/u;

/**
 * 2026-11-24 真实群语料（c106）新增：**裸「X本子」**（`加里奥本子`、`佛耶戈本子`、
 * `向日葵本子`）——用户不写动词。只认"一个短前缀 + 本子/本"，且前缀不能含功能词；
 * 复合词仍有 `hasBookTarget` 的 `FUZZY_BEN_COMPOUNDS` 兜底（账本/脚本/绘本…）。
 * 解析仍交 `parseJmFuzzyCommand`（关键词/数量/清洗一份实现）。
 */
function parseBareBookCommand(text, maxJm) {
  const match = BARE_BOOK_RE.exec(String(text ?? ''));
  if (!match) return null;
  const prefix = match[1];
  if (Array.from(prefix).length < 2) return null;
  if (BARE_BOOK_PREFIX_STOP.has(prefix) || BARE_BOOK_PREFIX_BAD.test(prefix)) return null;
  // 前缀不能是命令动词：「搜本子」「找本子」是“没给关键词”的残缺命令，不是「搜」+「本子」。
  if (/^(?:搜|找|查|下|下载|来|要|整|发|搬|搞|看|求|给|买)/u.test(prefix)) return null;
  if (!hasBookTarget(text)) return null;
  const parsed = parseJmFuzzyCommand(`来点${text}`, { max: maxJm });
  if (!parsed?.ok) return null;
  return { parsed };
}

/**
 * 没有目标名词、但明显在“搜/要一点东西”的形状（「来点乐子」「发点牢骚」「搜 全彩」）：
 * 只能澄清，不能替用户猜“这是找图还是找本”。普通闲聊（「今天天气不错」）不命中。
 */
function looksLikeDomainlessSearch(text) {
  const value = String(text ?? '');
  // 残缺发图/找东西的形状：动词 + (数量) + 张/点/些。
  if (/^(?:发|来|找|搬)\s*(?:\d+|[一二两三四五六七八九十几]+)?\s*[张点些]/u.test(value)) return true;
  // 裸搜索动词 + 内容（不含已经带目标名词的 搜本/搜本子/搜图）。
  if (/^(?:搜|查找|查)\s*\S/u.test(value) && !/^(?:搜本|搜图)/u.test(value)) return true;
  return false;
}

/**
 * book 侧路由：只有目标名词（无关键词）→ strict → fuzzy → 自然句式 → 仅格式提示 → 不认。
 * 目标名词闸已经确认“这句在找书/媒体”，所以这里只管命令形状。
 */
function routeBook(text, maxJm) {
  // 「本子来点」「来点本子」「要几本」这类**只有目标名词、没有关键词**的形状先认意图：
  // 否则既有模糊解析器会把残字「几」「子」当关键词（如「要几本」→ keyword='几'）。
  // 认得出意图但没东西可搜 → hint 'keyword'，比搜一个残字或回格式提示都有用。
  if (BARE_BOOK_ATTEMPTS.has(text.replace(/\s+/gu, ''))) {
    return baseResult({ kind: 'book', stage: 'fuzzy', component: 'jm', hint: 'keyword', reason: 'keyword' });
  }

  const strict = parseJmCommand(text, { max: maxJm });
  if (strict.ok) return bookResult('strict', strict);

  const fuzzy = parseJmFuzzyCommand(text, { max: maxJm });
  if (fuzzy && fuzzy.ok) return bookResult('fuzzy', fuzzy);

  const natural = parseNaturalBookCommand(text, maxJm);
  if (natural?.parsed) return bookResult('fuzzy', natural.parsed);
  if (natural?.hint) {
    return baseResult({
      kind: 'book', stage: 'fuzzy', component: 'jm', hint: natural.hint, reason: natural.reason,
    });
  }

  // 裸「X本子」（2026-11-24 c106 语料）：加里奥本子 / 佛耶戈本子 / 向日葵本子。
  const bare = parseBareBookCommand(text, maxJm);
  if (bare?.parsed) {
    return baseResult({
      kind: 'book', stage: 'fuzzy', component: 'jm', action: 'search',
      parsed: bare.parsed, reason: 'bare-book',
    });
  }

  // 写了明确的搜本/下本动词但形状不对 → 格式提示（沿用 JM 既有的 looksLikeJmAttempt）。
  if (looksLikeJmAttempt(text)) {
    return baseResult({
      kind: 'book', stage: 'fuzzy', component: 'jm', hint: 'format', reason: strict.reason ?? 'format',
    });
  }

  // 提到了书但不像在下命令（「这个本子不错」）→ 不认，交回模型/闲聊。
  return baseResult({ kind: 'none', reason: 'no-command' });
}

/** 「搜图」后面的角色位清洗：去首尾空白/标点与「的图/的/图」尾巴。 */
function cleanImagePayload(raw) {
  let text = String(raw ?? '')
    .normalize('NFKC')
    .replace(/^[，,、;；\s的]+/u, '')
    .trim();
  for (let i = 0; i < 2; i += 1) {
    if (text.endsWith('的图')) text = text.slice(0, -2);
    else if (text.endsWith('图')) text = text.slice(0, -1);
    else if (text.endsWith('的')) text = text.slice(0, -1);
    text = text.trim();
  }
  return text;
}

/**
 * image 侧路由：原句交给 `parseMeituCommand`（既有形状一个不丢）→ 新增「搜」系形状 → 格式提示。
 *
 * 新增形状（2026-11-24）：
 *   搜图 <角色> / 搜图<角色> / 搜<一|两|几|N>张<角色>(的)图 / 搜点<角色>的图 / 搜张<角色>的图
 *
 * 做法：把「搜」换成美图动词「来」，直接喂给同一个 `parseMeituCommand` —— 角色/数量/
 * 修饰/档位全由它解析，这里**不另算字段**（D159 一份实现）。「搜图」没有量词位，所以
 * 补成 `来1张<角色>美图` 再解析。
 */
function routeImage(text, maxMeitu) {
  const direct = parseMeituCommand(text, { max: maxMeitu });
  if (direct.ok) return imageResult('strict', direct);

  // 「搜图 <角色>」/「搜图<角色>」：搜图没有数量/量词位，补成 `来1张<角色>美图` 再解析。
  // ⚠️「搜图片」是「搜」+名词「图片」，不是「搜图」+角色「片」—— 先剥掉「片」再看有没有角色。
  const tu = /^搜图\s*(.*)$/u.exec(text);
  if (tu) {
    let raw = tu[1];
    if (raw.startsWith('片')) raw = raw.slice(1);
    const payload = cleanImagePayload(raw);
    if (!payload) return baseResult({ kind: 'image', component: 'meitu', hint: 'keyword', reason: 'keyword' });
    const parsed = parseMeituCommand(`来1张${payload}美图`, { max: maxMeitu });
    if (parsed.ok) return imageResult('fuzzy', parsed);
    return imageFormat(parsed.reason);
  }

  // 「搜2张爱丽丝的图」「搜点爱丽丝的图」「搜张爱丽丝的图」：只换动词，其余原样。
  // 只认带图像量词位的「搜」形状；「搜索…」这类不在这里猜，继续往下走（不吞成格式错误）。
  if (/^搜(?:[张点些]|[一二两三四五六七八九十几\d]+张)/u.test(text)) {
    const parsed = parseMeituCommand(`来${text.slice(1)}`, { max: maxMeitu });
    if (parsed.ok) return imageResult('fuzzy', parsed);
    return imageFormat(parsed.reason);
  }

  // 真实群语料（c106）：「来个加里奥大吊图」「来个镇长大吊图」——图 + 角色 + 俚语后缀。
  // 复用美图解析器：把角色位补成 `来张<角色>的图`，不在这层另算角色/数量；大吊/涩/色 → 擦边档。
  const slang = /^(?:来|发|找|整|搬)\s*(?:个|张|点|些)?\s*(.+?)(?:的)?(?:大吊图|涩图|色图)$/u.exec(text);
  if (slang) {
    const character = cleanImagePayload(slang[1]);
    if (character) {
      const parsed = parseMeituCommand(`来张${character}的图`, { max: maxMeitu });
      if (parsed.ok) {
        if (/大吊|涩|色/u.test(slang[0])) parsed.tier = 'seitu';
        return imageResult('fuzzy', parsed);
      }
    }
  }

  if (looksLikeMeituAttempt(text)) return imageFormat(direct.reason);
  return baseResult({ kind: 'none', reason: 'no-command' });
}

/**
 * 搜索指令统一路由（纯函数、零 IO）。
 *
 * @param {string} text 消息正文（群里 @ 之后的文本；残留 @ 由 `normalizeCommandText` 剥）
 * @param {{maxJm?: number, maxMeitu?: number}} [options] 两侧一次最多几本/几张
 * @returns {{kind: 'book'|'image'|'ambiguous'|'none', stage: 'strict'|'fuzzy',
 *            component: 'jm'|'meitu'|null, action: 'search'|'download'|'pack'|'send'|null,
 *            parsed: object|null, hint: 'clarify'|'format'|'keyword'|null,
 *            reason: string|null}}
 */
export function routeSearchCommand(text, { maxJm = DEFAULT_JM_MAX, maxMeitu = DEFAULT_MEITU_MAX } = {}) {
  const normalized = normalizeCommandText(text);
  if (!normalized) return baseResult({ reason: 'empty' });

  // 翻页独立词（2026-11-25）：没有目标名词，但是明确的 JM 命令；与简写一样先走严格解析器。
  // 有没有清单/页码边界由服务层判（路由不持有状态）。
  if (/^(?:下一页|上一页)$/u.test(normalized)) {
    const direct = parseJmCommand(normalized, { max: maxJm });
    if (direct.ok) return bookResult('strict', direct);
  }

  // 2026-11-24 c106 语料：省掉「本」的 JM 简写（`下这个JM1485799`、`搜作者kusui`）——
  // 没有书/媒体目标名词，目标名词闸会把它当闲聊；但它是明确的 JM 命令，先走严格解析器。
  const jmShorthand = /^(?:下|下载)\s*(?:这个|那张|这条|这个本子|这本|这一本|那个)\s*\S/u.test(normalized)
    || /^(?:搜|找|查)\s*(?:作者名|作者|画师|原作|作品|角色|人物|标签名|标签|标题)(?=\S)/u.test(normalized);
  if (jmShorthand) {
    const direct = parseJmCommand(normalized, { max: maxJm });
    if (direct.ok) return bookResult('strict', direct);
    return baseResult({
      kind: 'book', stage: 'strict', component: 'jm', hint: 'format', reason: direct.reason ?? 'format',
    });
  }

  const book = hasBookTarget(normalized);
  const image = hasImageTarget(normalized);

  // 目标名词闸：两边都有 → 不猜（「来点本子图」）；只有书 → 永不走美图。
  if (book && image) return clarify('both-targets');
  if (book) return routeBook(normalized, maxJm);
  if (image) return routeImage(normalized, maxMeitu);

  // 带「张」量词、没写目标名词的残缺发图（「来3张随便的」「来2张」）是既有美图能力：
  // 「张」本身就是图的数量词，不能因为没写"图/美图"就被目标名词闸当歧义去澄清。
  // 「点/些」不走这条（「来点乐子」不是发图），仍按下面的"形状明显→澄清"处理。
  if (/^(?:发|来|找|搬)\s*(?:\d+|[一二两三四五六七八九十几]+)?\s*张/u.test(normalized)) {
    const parsed = parseMeituCommand(normalized, { max: maxMeitu });
    if (parsed.ok) return imageResult('fuzzy', parsed);
    return imageFormat(parsed.reason);
  }

  // 两边都没有：指令形状明显就澄清（「来点乐子」不再被当发图随机出图），否则不认。
  if (looksLikeDomainlessSearch(normalized)) return clarify('no-target-noun');
  return baseResult({ reason: 'no-target-noun' });
}

/**
 * **非 @ 触发闸**（2026-11-24 审查 P1-1）：非 @ 群消息没有"被点名"这层意图声明，
 * 只靠路由的宽形状（`来张纸`→发图、`找本工作`→搜本、`看本小说`→搜本）会在水群误执行。
 * 所以非 @ 另加一道**显式意图**判定：书侧必须出现明确的搜索/请求句式或句尾书名词；
 * 图侧必须有图像名词（图/美图/涩图/照片…）或显式的「搜图」动词。
 *
 * @param {object} route `routeSearchCommand()` 的返回值
 * @param {string} text 原始消息正文
 * @returns {boolean} true = 允许非 @ 触发
 */
export function allowsNonMentionTrigger(route, text) {
  if (!route || (route.kind !== 'book' && route.kind !== 'image')) return false;
  if (route.hint) return false;
  if (!route.action) return false;
  const normalized = normalizeCommandText(text);
  if (!normalized) return false;

  if (route.kind === 'image') {
    if (route.action !== 'send') return false;
    // 图像名词是唯一正常入口；显式「搜图」动词也放行（它本身就是"去搜图"的意思）。
    return hasImageTarget(normalized) || /^(?:搜图|找图|来图|发图)/u.test(normalized);
  }

  if (!['search', 'download', 'pack', 'page'].includes(route.action)) return false;
  // 翻页独立词（2026-11-25）：显式命令且只作用于本群已有清单，非 @ 也放行。
  if (route.action === 'page' && /^(?:下一页|上一页)$/u.test(normalized)) return true;
  // 省掉「本」的结构化搜索（`搜作者kusui`）：显式「搜/找/查 + 条件键」，放行。
  if (/^(?:搜|找|查)\s*(?:作者名|作者|画师|原作|作品|角色|人物|标签名|标签|标题)(?=\S)/u.test(normalized)) return true;
  // 裸「X本子」**只放行真 @**（2026-11-24 c106 语料是 @ 场景；水群里「作业本子」这类
  // 日常词不该自动开搜）。路由层仍负责挡功能词/复合词；但别把后面的显式请求规则短路掉。
  if (route.reason === 'bare-book') return false;
  // ① 明确的命令动词（不含裸「找本」：`找本工作` 是这句话里的"找本"）；
  if (NON_MENTION_BOOK_PREFIX_RE.test(normalized)) return true;
  // ② 明确的请求句式（来点/来几本/整点/搜点/找点/要几本/求几本/查/帮我搜…）；
  if (NON_MENTION_BOOK_REQUEST_RE.test(normalized)) return true;
  // ③ 问句「有没有 X 本子吗」；
  if (NON_MENTION_BOOK_QUESTION_RE.test(normalized)) return true;
  // ④ 后置请求「X 的本子来点 / 推荐」；
  if (NON_MENTION_BOOK_TAIL_RE.test(normalized)) return true;
  // ⑤ 句尾就是书名词（「找全彩本子」「来点作者甲的本子」）—— 前面的动词已在路由里认过。
  return /(?:本子|本)$/u.test(normalized);
}

/** 非 @ 书侧：明确的命令动词（不含裸「找本/看本」）。 */
const NON_MENTION_BOOK_PREFIX_RE = /^(?:搜本子|搜本|搜索本子|找本子|下本|下载本子|下载本)(?=\s|$)/u;
/** 非 @ 书侧：明确的请求句式。 */
const NON_MENTION_BOOK_REQUEST_RE = /^(?:来(?:点|些|几本|几本子|几|本)|整(?:点|些|几本|几本子)|搜(?:点|一下|下)|找(?:点|一下)|要(?:点|几本|几)|求(?:点|几本|几)|查(?:找|一下)?|帮我(?:搜|找)|给我(?:来|找|搜))/u;
/** 非 @ 书侧：问句「有没有 X 本子吗」。 */
const NON_MENTION_BOOK_QUESTION_RE = /^(?:有没有|有无|有).{0,16}(?:本子|本)(?:吗|嘛|？|\?)?$/u;
/** 非 @ 书侧：后置请求「X 的本子来点 / 推荐」。 */
const NON_MENTION_BOOK_TAIL_RE = /(?:本子|本)(?:来点|来几本|推荐)$/u;
