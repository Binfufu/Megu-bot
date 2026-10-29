/**
 * **酒馆卡解析内核**（A 刀：卡库 + 解析器 + 预览；2026-10-13）。
 *
 * 一条硬约定，先写在最上面：
 *
 * > **这里全是纯函数。不读盘、不联网、不写库、不认识任何路径。**
 *
 * 读完字节的那一步（`readTextChunks` / `readCardFile`）之所以也在本文件，是因为它同样
 * **不产生副作用**：调用方给个绝对路径，它把字节读出来就完了。真正的"往哪写"全在
 * `src\dream-index.js` 和 `scripts\dream-index.js`。
 *
 * ⚠️ **别在这里 import 上层**（D159 那条"不许写第二份必须一致的实现"的同族）：
 * 卡库是**独立产品线**，将来要么被面板用、要么被梦境引擎用、要么被生成卡工具用。
 * 它一 import 那些东西，第二份实现就出生了。
 *
 * ## 它到底认多少种卡（2026-10-13 实测，卡库 7138 个文件）
 *
 * | 形态 | 数量 | 怎么认 |
 * |---|---|---|
 * | PNG 角色卡（`chara`/`ccv3` tEXt 块 + base64 正文） | 6938 | `parsePngCard` |
 * | PNG **世界卡**（同一个卡壳，但 `first_mes` 空 + 世界书 ≥ 5 条） | 142 | `classifyCard` |
 * | 纯 JSON 角色卡（v1 平铺 / v2 套 `data`） | 378 个 json 里的多数 | `parseCardJson` |
 * | 纯 JSON 世界书（`{entries:{…}}` 或 `{entries:[…]}`） | 383 份 | `parseWorldBookJson` |
 * | 生成器卡（"角色生成器""人设提取"这类，是**工具**不是角色） | ~14 | `classifyCard` 的 `generator` |
 *
 * ## 踩过的坑（都在这一个文件里钉住了）
 *
 * - ⚠️ **`chara` 块里的正文是 base64**，不是 JSON。直接 `JSON.parse` 会炸；
 *   而 **`ccv3` 块是明文 JSON**（同一张卡里两份都有）。第一版我按 `{` 开头判断，
 *   结果把世界卡全判成了角色卡 —— 见 `readCardJson` 的注释。
 * - ⚠️ **`position` 有两种编码**：纯 JSON 世界书里是数字 `0..7`，
 *   而**嵌在卡壳里的世界书**里是字符串 `"before_char"` / `"after_char"`。
 *   两者都要收，统一成 `POSITION` 里的数字，否则激活顺序会静默错位。
 * - ⚠️ **`keys` 和 `key` 都出现过**（`key` 是 ST 老格式）。少认一个 = 整份世界书不触发。
 * - ⚠️ **世界书条目可能是数组也可能是对象**（`{entries:[…]}` vs `{entries:{"0":{…}}}`）。
 * - ⚠️ **有些条目的 key 是 `["."]` 这种荒唐值**（素晴世界卡里真有）。`constant` 才是它常驻的原因，
 *   所以类型判定**不能**只看 key 像不像话。
 */

/** 世界书条目的插入位置 —— 与 SillyTavern 的 `world_info_position` 数值**必须一致**。 */
export const POSITION = Object.freeze({
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
});

/**
 * `position` 的**字符串写法 → 数字**。
 *
 * ⚠️ 这是本文件最容易被写错的一处：卡壳里的世界书用字符串，纯 JSON 世界书用数字。
 * 漏了任何一边，条目的插入位置就全塌成"before"，而**表现是"模型好像没看见世界观"** ——
 * 极难查（它不是崩溃，是静默错位）。
 */
export const POSITION_BY_NAME = Object.freeze({
  before_char: POSITION.before,
  after_char: POSITION.after,
  before_an: POSITION.ANTop,
  after_an: POSITION.ANBottom,
  before_em: POSITION.EMTop,
  after_em: POSITION.EMBottom,
  at_depth: POSITION.atDepth,
  outlet: POSITION.outlet,
});

/** 条目的四种归属（渲染世界书时决定"给谁看"）。与 ST 的 `world_info_logic` 同值。 */
export const LOGIC = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });

/** 角色卡的形态。 */
export const KIND = Object.freeze({
  character: 'character',
  worldcard: 'worldcard',
  lorebook: 'lorebook',
  generator: 'generator',
});

const utf8 = new TextEncoder();

/**
 * **索引里最多留多少字正文**（见 `buildRecord` 的注释）。
 *
 * ⚠️ 这是"索引体积 / 检索覆盖"的取舍点，**不是随手取的**：① 索引是**每次缓存失效都在主线程
 * parse 一遍**的东西（56 MB → 285 ms，13 MB → ~80 ms）；② 逐字全文另有 `full\<id>.json`。
 * 想改它就跑一次 `scan --write` 再量 `stats` 的 MB 与首次请求延迟。
 */
export const INDEX_TEXT_CHARS = 1000;

/** 截断（不抛、不补省略号 —— 它是给检索用的，不是给人读的）。 */
function clampText(value, max = INDEX_TEXT_CHARS) {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? text.slice(0, max) : text;
}

/** 一个字符串的 **UTF-8 字节数**。入库一律按字节算，不按字符。 */
export function utf8Bytes(value) {
  return utf8.encode(typeof value === 'string' ? value : '').length;
}

/**
 * 粗略 token 估算 —— **故意粗糙**，只用来排序/预警，**不许拿它当预算的真值**。
 *
 * 口径：中文一字 ≈ 1 token（DeepSeek 系约 0.6~1.0），拉丁每 4 字符 ≈ 1。
 * ⚠️ 真实 token 数只有分词器知道；任何"精确到个位"的说法都该被打回来。
 */
export function approxTokens(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk + other / 4);
}

/** 把任意"字节 / 字符串 / 路径"读成一个文本。**同步能读的绝不等异步**（这里全是本地小文件）。 */
function coerceText({ bytes = null, path = '' } = {}) {
  if (typeof bytes === 'string') return bytes;
  if (bytes) return Buffer.isBuffer(bytes) ? bytes.toString('utf8') : Buffer.from(bytes).toString('utf8');
  return null;
}

// ---------------------------------------------------------------------------
// ① 找到 PNG 里的正文（tEXt / zTXt / iTXt）
// ---------------------------------------------------------------------------

/**
 * 扫一个 PNG 的所有文本块，返回 `{键: 正文}`。**同步、纯函数。**
 *
 * ⚠️ **只认 PNG 签名后的第一个 `IEND` 之前的块**，并且**遇到畸形长度立刻停**
 * （畸形长度会让 `p` 越界或死循环，而"死循环在扫描 7000 张卡的时候"是灾难）。
 * ⚠️ **只解 `tEXt`（未压缩）**：实测 7138 张卡 + 本机酒馆那 12 张卡**全是 `tEXt`**，
 * 压缩块（zTXt/iTXt）出现 0 次。压缩块要走 `openCardFile()` 那条**异步**的路，
 * 因为解压需要 `node:zlib` 而它是异步引入的。**这条分界是刻意的**：
 * 让"解析"保持同步可测，"读盘"才异步。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {Record<string,string>|null} 不是 PNG 时返回 `null`
 */
export function readTextChunks(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  // 签名 89 50 4E 47 0D 0A 1A 0A
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  const texts = {};
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    // 长度越界 = 文件畸形 → 就此收手（不抛，也不硬撑）
    if (len > buf.length - p - 8) break;
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const key = data.toString('latin1', 0, zero);
        texts[key] = (texts[key] ?? '') + data.toString('utf8', zero + 1);
      }
    }
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return texts;
}

/**
 * **读盘**：一个卡文件 → 文本块（压缩块在这里才会被解开）。
 *
 * 这是模块里**唯一**碰文件系统的函数，而且它只是"读"，不写任何东西。
 *
 * @param {string} filePath
 * @param {{fs?:object}} [options] `fs` 可注入（测试用假 fs，不碰真盘）
 * @returns {Promise<Record<string,string>|null>}
 */
export async function openCardFile(filePath, { fs = null } = {}) {
  const io = fs ?? (await import('node:fs'));
  const bytes = io.readFileSync(filePath);
  const chunks = readTextChunks(bytes);
  if (!chunks) return null;
  await inflateCompressedChunks(bytes, chunks);
  return chunks;
}

/** 把 zTXt / iTXt 块解开补进 `chunks`。同步版没做这件事，见 `readTextChunks` 的注释。 */
async function inflateCompressedChunks(bytes, chunks) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (len > buf.length - p - 8) break;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'zTXt' || type === 'iTXt') {
      const data = buf.subarray(p + 8, p + 8 + len);
      const zero = data.indexOf(0);
      if (zero > 0) {
        const key = data.toString('latin1', 0, zero);
        try {
          if (type === 'zTXt') {
            const body = await inflateAsync(data.subarray(zero + 2));
            chunks[key] = (chunks[key] ?? '') + body.toString('utf8');
          } else {
            const rest = data.subarray(zero + 1);
            const compressed = rest[0] === 1;
            let q = 3;
            q = rest.indexOf(0, q) + 1;
            q = rest.indexOf(0, q) + 1;
            let body = rest.subarray(q);
            if (compressed) body = await inflateAsync(body);
            chunks[key] = (chunks[key] ?? '') + body.toString('utf8');
          }
        } catch {
          /* 压缩块坏了就当它不存在 —— 不许让它把整张卡带走 */
        }
      }
    }
    p += 12 + len;
    if (type === 'IEND') break;
  }
}

/**
 * `node:zlib` 的**延迟**引入 —— 浏览器/打包环境里没有它，不许让整份模块在 import 期就炸掉。
 *
 * ⚠️ 为什么不用顶层 `import zlib from 'node:zlib'`：这份模块的定位是"纯函数内核"，
 * 将来要在**页面脚本**里也用（卡库预览页要就地解卡）。顶层 import 会让浏览器那一侧
 * 直接抛错，而且抛在 import 期、连错误处理都进不去。
 * ⚠️ 为什么不用 `require`：这是 ESM（`"type":"module"`），**`require` 根本不存在** ——
 * 我第一版就是那么写的，`node --check` 都不报，只有真跑才炸。
 * ⚠️ 为什么它在**下面**而不是上面：`readTextChunks` 要**同步**返回（它是纯函数内核的入口，
 * 一 async 就把 `parseCard` 整条链都染成 async）。所以这里只给 `openCardFile` 那条
 * **读盘**的路用 —— 实测 7138 张卡**全是 `tEXt`**（0 个 zTXt/iTXt），压缩块是防御性的。
 */
let zlibCache;
async function inflateAsync(bytes) {
  if (zlibCache === undefined) {
    try {
      zlibCache = await import('node:zlib');
    } catch {
      zlibCache = null;
    }
  }
  if (!zlibCache) throw new Error('这个运行环境没有 node:zlib，无法解压 zTXt/iTXt 块');
  return zlibCache.inflateSync(bytes);
}

// ---------------------------------------------------------------------------
// ② 把"卡正文"解析成对象
// ---------------------------------------------------------------------------

/**
 * 把一段卡正文（可能是 base64、可能是明文 JSON、可能还套着 `{data:{…}}`）解析成对象。
 *
 * ⚠️ **先看它像不像 JSON，再看要不要 base64** —— 反过来的话，"明文 JSON 里恰好全是
 * base64 字符"这类噪声会把它误解一次。第一版我就是这么把 142 张世界卡判成角色卡的。
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseCardText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const direct = tryJson(trimmed);
  if (direct) return direct;
  // 不是 JSON → 可能是 base64（ST 的 chara 块就是这么存的）
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return null;
  const decoded = tryBase64(trimmed);
  if (!decoded) return null;
  return tryJson(decoded.trim());
}

/**
 * 从一堆文本块里取出**角色卡 JSON**。
 *
 * ⚠️ 优先级是**明文优先**：`ccv3` 是明文，`chara` 是 base64。两份内容通常一样，
 * 但**明文那版一定不会因为 base64 被裁剪而坏**，所以先试它。
 *
 * @param {Record<string,string>} chunks
 * @returns {object|null}
 */
export function readCardJson(chunks) {
  if (!chunks) return null;
  for (const key of ['ccv3', 'chara', 'character', 'card']) {
    const parsed = parseCardText(chunks[key]);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

/**
 * 从一堆文本块里取出**世界书 JSON**。
 *
 * ⚠️ 纯 JSON 世界书在 ST 里是**裸的** `{entries:{…}}`，不带 `chara` 包装；
 * 而卡壳里的世界书在 `data.character_book`。两条路都要走（见 `parseCard`）。
 */
export function readBookJson(chunks) {
  if (!chunks) return null;
  for (const key of ['world', 'lorebook', 'world_info', 'worldInfo']) {
    const parsed = parseCardText(chunks[key]);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  // 兜底：整个块本身就是一份世界书
  for (const value of Object.values(chunks)) {
    const parsed = parseCardText(value);
    if (parsed && isWorldBookShape(parsed)) return parsed;
  }
  return null;
}

function tryJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function tryBase64(text) {
  try {
    const compact = text.replace(/\s+/g, '');
    const buffer = Buffer.from(compact, 'base64');
    // base64 解的字节数必须合理（≥ 原始长度的一半），否则那是噪声不是编码
    if (buffer.length === 0 || buffer.length < compact.length / 2) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

function isWorldBookShape(value) {
  if (!value || typeof value !== 'object') return false;
  const entries = value.entries;
  if (!entries || typeof entries !== 'object') return false;
  return Array.isArray(entries) || Object.keys(entries).length > 0;
}

// ---------------------------------------------------------------------------
// ③ 归一化
// ---------------------------------------------------------------------------

/** `keys` / `key` 两种写法都收，去掉空串、去重。 */
export function normalizeKeys(entry) {
  const raw = entry?.keys ?? entry?.key ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = typeof item === 'string' ? item.trim() : item == null ? '' : String(item);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 世界书条目的正文位置归一。字符串与数字都收（见 `POSITION_BY_NAME` 的注释）。 */
export function normalizePosition(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n >= 0 && n <= 7 ? n : POSITION.before;
  }
  if (typeof value === 'string') {
    const byName = POSITION_BY_NAME[value.trim()];
    if (byName !== undefined) return byName;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0 && n <= 7) return Math.trunc(n);
  }
  return POSITION.before;
}

/**
 * 一份世界书的 `entries` → 统一数组。
 *
 * ⚠️ 三种形状都出现过：数组、`{"0":{…}}` 对象、以及**条目本身就是数组的数组**（没见过，但防一手）。
 * 顺带把 `uid` 补上（有些卡不写 `uid`，靠索引派生）。
 */
export function normalizeBookEntries(book) {
  const raw = book?.entries ?? book;
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const out = [];
  let fallbackUid = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const uid = Number.isFinite(item.uid) ? Number(item.uid) : fallbackUid;
    fallbackUid = Math.max(fallbackUid, uid + 1);
    const position = normalizePosition(item.position);
    const content = typeof item.content === 'string' ? item.content : '';
    out.push({
      uid,
      comment: str(item.comment) || str(item.name) || '',
      keys: normalizeKeys(item),
      secondaryKeys: normalizeKeys({ keys: item.secondary_keys ?? item.secondaryKeys }),
      content,
      constant: item.constant === true,
      position,
      depth: Number.isFinite(item.depth) ? Number(item.depth) : 4,
      order: Number.isFinite(item.order) ? Number(item.order) : 100,
      role: Number.isFinite(item.role) ? Number(item.role) : null,
      selective: item.selective === true,
      // 匹配旋钮（少一个都会静默不触发）
      caseSensitive: readFlag(item, 'caseSensitive', 'case_sensitive') === true,
      matchWholeWords: readFlag(item, 'matchWholeWords', 'match_whole_words') === true,
      useRegex: readFlag(item, 'useRegex', 'use_regex') === true,
      probability: Number.isFinite(item.probability) ? Number(item.probability) : null,
      // 递归/深度（ST 把它挪进 extensions，老格式在顶层）
      excludeRecursion: readFlag(item, 'excludeRecursion', 'exclude_recursion') === true,
      preventRecursion: readFlag(item, 'preventRecursion', 'prevent_recursion') === true,
      delayUntilRecursion: item.delayUntilRecursion ?? item.delay_until_recursion ?? false,
      scanDepth: readNumber(item, 'scanDepth', 'scan_depth'),
      ignoreBudget: readFlag(item, 'ignoreBudget', 'ignore_budget') === true,
      disabled: readFlag(item, 'disable', 'disabled') === true,
      automationId: str(item.automationId ?? item.automation_id) || null,
      // 派生量：一入库就算好，免得每次预览都重算
      bytes: utf8Bytes(content),
      tokens: approxTokens(content),
    });
  }
  return out;
}

function readFlag(entry, ...names) {
  for (const name of names) {
    if (entry?.[name] !== undefined) return entry[name];
    if (entry?.extensions?.[name] !== undefined) return entry.extensions[name];
  }
  return undefined;
}

function readNumber(entry, ...names) {
  const value = readFlag(entry, ...names);
  if (value === undefined || value === null || value === '') return null;
  // ⚠️ **必须做数字转换**，不能只查 `Number.isFinite`：酒馆卡里 `talkativeness`
  //    绝大多数是**字符串** `"0.5"`（实测 6680/6938 张卡都在 `extensions` 里存成字符串）。
  //    只认 number 的写法会让话痨度**永远是 null** —— 而它的表现是"权重没生效"，
  //    静默、不报错、极难查。第一版就是这么错的（判据当场抓住）。
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 角色卡正文归一。
 *
 * ⚠️ **v1 是平铺的、v2/v3 套在 `data` 里**。两张形状都要认 —— 认错一边的表现是
 * "卡导进来了但人设是空的"，比报错难查得多。
 *
 * @returns {{name:string, description:string, …}|null}
 */
export function normalizeCharacter(card) {
  if (!card || typeof card !== 'object') return null;
  const d = card.data && typeof card.data === 'object' ? card.data : card;
  const name = str(d.name) || str(d.char_name) || '';
  // ⚠️ **`{}` 不是卡**：全空的归一化结果会让卡库里多出 7000 个空行为 0 的幽灵记录，
  //    而它们还会一起占住"同名去重"的键。判据当场抓住过这一条。
  const hasAny =
    name !== '' ||
    str(d.description) !== '' ||
    str(d.first_mes) !== '' ||
    str(d.personality) !== '' ||
    str(d.scenario) !== '' ||
    str(d.mes_example) !== '';
  if (!hasAny) return null;
  const fields = {
    name,
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    firstMes: str(d.first_mes),
    mesExample: str(d.mes_example),
    creatorNotes: str(d.creator_notes),
    systemPrompt: str(d.system_prompt),
    postHistoryInstructions: str(d.post_history_instructions),
  };
  const alt = d.alternate_greetings;
  fields.alternateGreetings = Array.isArray(alt) ? alt.filter((x) => typeof x === 'string' && x !== '') : [];
  fields.tags = Array.isArray(d.tags) ? d.tags.filter((x) => typeof x === 'string' && x !== '') : [];
  fields.creator = str(d.creator);
  fields.characterVersion = str(d.character_version);
  fields.spec = str(card.spec) || (d.spec_version ? `chara_card_v${d.spec_version}` : '');
  fields.extensions = d.extensions && typeof d.extensions === 'object' ? d.extensions : {};
  // 卡内嵌世界书 —— 这是"角色卡自带世界观"那条路，5200/6938 张卡都有
  fields.book = isWorldBookShape(d.character_book) ? normalizeBook(d.character_book) : null;
  // 派生量
  fields.bytes = utf8Bytes([
    fields.description,
    fields.personality,
    fields.scenario,
    fields.firstMes,
    fields.mesExample,
    fields.systemPrompt,
    fields.postHistoryInstructions,
    ...fields.alternateGreetings,
  ].join('\n'));
  fields.tokens = approxTokens(fields.description + fields.firstMes + fields.mesExample);
  fields.talkativeness = readNumber(fields.extensions, 'talkativeness') ?? null;
  fields.depthPrompt = str(fields.extensions.depth_prompt?.prompt);
  // 空壳判定（见 `classifyCard`）
  fields.emptyShell =
    fields.firstMes === '' &&
    fields.description === '' &&
    fields.personality === '' &&
    fields.scenario === '' &&
    fields.mesExample === '';
  return fields;
}

/** 世界书归一（保留书名与人设，其余派生量交给调用方）。 */
export function normalizeBook(book) {
  if (!book || typeof book !== 'object') return null;
  const entries = normalizeBookEntries(book);
  return {
    name: str(book.name) || '',
    description: str(book.description) || '',
    entries,
    entryCount: entries.length,
    constantCount: entries.filter((x) => x.constant).length,
    keyedCount: entries.filter((x) => !x.constant).length,
    bytes: entries.reduce((sum, x) => sum + x.bytes, 0),
    tokens: entries.reduce((sum, x) => sum + x.tokens, 0),
  };
}

// ---------------------------------------------------------------------------
// ④ 类型判定
// ---------------------------------------------------------------------------

/**
 * 这张卡到底是**角色卡 / 世界卡 / 世界书 / 生成器**？
 *
 * ## 先说清楚：自动判"世界卡"为什么**不可能**做到准确（实测数据说话）
 *
 * 我拿 `D:\BaiduNetdiskDownload\2025-11-19` 全库量过（真世界卡目录 201 个 PNG vs 其余 6877 个）：
 * 两边的字段分布**几乎重合** ——
 *
 * | 字段 | 世界卡（中位） | 角色卡（中位） |
 * |---|---|---|
 * | `first_mes` | 1254 | 1387 |
 * | `description` | 4 | 1306 |
 * | `character_book` 条数 | 20 | 8 |
 *
 * 也就是说：**世界卡和角色卡在结构上是同一种东西**（都是"PNG 壳 + 一段人设 + 一本世界书"），
 * 唯一的差别是**那段正文的语义**（作者写的是"世界的规则"还是"这个人是谁"）。
 * 我试过 12 组结构判据，最好的一组也只能覆盖 17% 的世界卡 —— 硬判据是行不通的。
 *
 * ## 所以这里的策略是三条，按优先级（**"判错一句话能改"比"猜得准"重要**）
 *
 * 1. **显式清单**（`overrides`）：`data\cards\overrides.json`，形如
 *    `{"<路径前缀或文件名>": "worldcard"}`。用户说一句就改过来，**它优先于一切**。
 * 2. **结构判据（保守）**：`first_mes` 空 + 世界书 ≥ `WORLD_SHELL_MIN_ENTRIES` 条 + 描述 ≥ 100 字
 *    → `worldcard`。这条**故意只抓最明显的那些**（卡壳里塞了本世界书、自己没开场白的），
 *    宁可漏判成角色卡，也不要把角色卡误判成世界卡（**误判成世界卡会让人设消失**，代价更大）。
 * 3. **生成器加分项**：文件名含 `生成器`/`制作器`/`提取` 这类词 → `generator`
 *    （它们的正文也是 `<char> 行为指导`，光看内容区分不了）。
 *
 * ⚠️ **`generator` 不是"坏卡"**：`2025年3月前\工具\` 那 14 张是**卡生成工具**
 * （角色生成器、人设提取、人设卡制作器…）。它们照样要能导入、能预览，只是不该出现在
 * "选一个人进梦境"的列表里 —— 所以它是个**分类**而不是**过滤器**。
 *
 * @param {{character:object|null, book:object|null, fileName?:string, sourceKind?:string,
 *          overrides?:Record<string,string>, path?:string}} input
 */
export function classifyCard({
  character = null,
  book = null,
  fileName = '',
  sourceKind = 'png',
  overrides = null,
  path: cardPath = '',
} = {}) {
  // ① 显式清单优先 —— 用户说了算（"判错一句话能改"是这一层存在的全部理由）
  const forced = matchOverride(overrides, cardPath, fileName);
  if (forced && Object.values(KIND).includes(forced)) return forced;

  const fileText = String(fileName ?? '');
  const pathText = String(cardPath ?? '');
  const entries = book?.entries ?? [];

  // ② **没有角色正文 = 一本世界书**。这一条**必须排在目录判型前面** ——
  //    那些文件本身就住在 `世界书及其他\世界书\` 里，路径里带"世界书"字样，
  //    先走目录判型会把 `lorebook` 全说成 `worldcard`（判据抓到过）。
  if (!character) return KIND.lorebook;

  // ③ **目录名是最强的信号**（实测：`已分类\世界卡\` 下 202 张，结构判据只认出 45 张 ——
  //    作者把它们做成"有开场白的世界卡"，结构上跟角色卡一模一样）。
  //    用户/资源作者**已经用目录分过一次类了**，那一次分类比任何启发式都可靠。
  //    ⚠️ 只认"带世界书"的那些；同目录下的空壳卡走后面的结构判据（它有自己的名字）。
  if (WORLD_DIR_HINTS.some((hint) => pathText.includes(hint)) && entries.length > 0) {
    return KIND.worldcard;
  }

  // ④ 生成器卡（工具）—— 判据见 `GENERATOR_PATTERN` 的注释（"生成"两个字太宽，踩过）
  if (GENERATOR_PATTERN.test(fileText) && !GENERATOR_DENY.some((word) => fileText.includes(word))) {
    return KIND.generator;
  }

  // ⑤ 结构兜底（保守）：自己没开场白 + 塞了本世界书 + 描述够长 → 世界卡
  const description = character.description.trim();
  const looksLikeWorldShell =
    character.firstMes.trim() === '' &&
    entries.length >= WORLD_SHELL_MIN_ENTRIES &&
    description.length >= WORLD_SHELL_MIN_DESC_CHARS;

  if (looksLikeWorldShell) return KIND.worldcard;
  return KIND.character;
}

/**
 * 显式清单匹配。
 *
 * 键可以是**完整路径**、**路径前缀**、或**文件名**（含扩展名）；值必须是 `KIND` 里的一个。
 * ⚠️ 最长键优先 —— 否则 `/世界卡/` 这条会把 `/世界卡/某某角色.png` 那条压掉，
 * 而用户写后者显然是想覆盖前者。
 */
export function matchOverride(overrides, cardPath, fileName = '') {
  if (!overrides || typeof overrides !== 'object') return null;
  const p = String(cardPath ?? '');
  const f = String(fileName ?? '');
  let best = null;
  let bestLen = -1;
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('$')) continue; // 备注字段（`$comment` 之类）不当清单用
    if (typeof value !== 'string') continue;
    const hit = (p && (p === key || p.startsWith(key))) || (f && f === key);
    if (hit && key.length > bestLen) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}

/** 世界卡判定至少要这么多条世界书条目（实测世界卡 p25=12、角色卡中位=8）——
 *  取 5 是为了**不误伤**，宁可漏判。 */
export const WORLD_SHELL_MIN_ENTRIES = 5;

/** 世界卡的"世界正文"至少要有这么多字。低于它是空壳卡，不是世界卡。 */
export const WORLD_SHELL_MIN_DESC_CHARS = 100;

/**
 * **目录名里的世界卡信号** —— 这一条是**实测加进来的**，不是想当然。
 *
 * 起因：`已分类\世界卡\` 底下 202 张，结构判据只认出 45 张。我把剩下 157 张一张张看过，
 * 结论是**判据没错、目录名才对** —— 作者把世界卡做成了"**有开场白**的世界卡"
 * （`firstMes` 中位 1254 字、书 20 条），结构上跟角色卡**完全一样**。
 * 换句话说：**光看文件内容，这个区别是不可判的**（见 `classifyCard` 上面那张对照表）。
 *
 * 而**资源作者/用户已经用目录分过一次类了**，那一次分类比任何启发式都可靠。
 * 所以：路径里出现这些词，且这张卡**确实带世界书**，就认它。
 */
export const WORLD_DIR_HINTS = Object.freeze(['世界卡', '世界书', 'lorebook', 'worldbook']);

/**
 * 生成器卡（**工具**，不是角色）的文件名判据。
 *
 * ⚠️ **不能用"生成"两个字做子串匹配** —— 我第一版就是那样，25 张里至少 9 张是误判：
 *
 * | 文件名 | 实际是 | 为什么被判错 |
 * |---|---|---|
 * | `转生成为纣王，逆转封神之战！.png` | 角色卡 | "转**生成**为" |
 * | `重生成狗的我只想在社畜家里混吃等死.png` | 角色卡 | "重**生成**狗" |
 * | `如果你性癖定制生成的世界.png` | 角色卡 | "定制**生成**的" |
 * | `魔法少女世界Ver2.0.png` | 角色卡 | "由 AI **生成**的卡牌战斗" |
 *
 * 真正要抓的是"**这东西是造卡的机器**"。所以：① 名字里有明确的工具词
 * （生成器/制作器/生成机器/百科/人设提取…），或 ② 名字以"生成"开头
 * （"生成人物与开局方式"那种）。并且用 `GENERATOR_DENY` **显式排除**转生/重生
 * —— 中文里这两个词带着"生成"字面，却是最常见的角色卡起手式。
 */
export const GENERATOR_PATTERN = /(生成器|制作器|生成机器|生成工具|提取|百科)|^生成|creator|generator|maker|how to use/i;

/** 生成器判定的**反例词**：出现这些就一定不是工具卡。 */
export const GENERATOR_DENY = Object.freeze(['转生成', '重生成']);

/** 兼容旧名字（判据里引用过）：把清单形状保留下来，但**真正的判据是 `GENERATOR_PATTERN`**。 */
export const GENERATOR_HINTS = Object.freeze(['生成器', '制作器', '提取', '百科', 'creator', 'generator', 'maker']);

// ---------------------------------------------------------------------------
// ⑤ 一张卡 → 一条索引记录
// ---------------------------------------------------------------------------

/**
 * 卡文件 → 索引记录。**这是本模块对外的唯一主入口。**
 *
 * @param {{path:string, bytes?:Uint8Array|Buffer, json?:object, sourceKind?:'png'|'json', mtimeMs?:number, size?:number}} input
 * @returns {object|null} 认不出来时返回 `null`（调用方负责记成"raw/坏文件"）
 */
export async function parseCard({
  path,
  bytes = null,
  json = null,
  sourceKind = 'png',
  mtimeMs = null,
  size = null,
  overrides = null,
} = {}) {
  const base = fileNameOf(path);
  let character = null;
  let book = null;
  let chunks = null;

  if (sourceKind === 'png') {
    // `bytes` 不给就直接读盘 —— 于是 CLI 与面板只需要一句 `parseCard({ path })`
    chunks = bytes ? readTextChunks(bytes) : await openCardFile(path);
    if (!chunks) return null;
    const card = readCardJson(chunks);
    if (card) {
      character = normalizeCharacter(card);
      if (!book && character?.book) book = character.book;
    }
    if (!book) {
      const loose = readBookJson(chunks);
      if (loose) book = normalizeBook(loose);
    }
  } else {
    // ⚠️ `sourceKind:'json'` 时**也要能自己读盘**：卡库里有 378 个纯 JSON 卡/世界书，
    //    调用方（CLI / 面板）只该给一个路径。只吃 `bytes` 的写法会让这批卡**全部解析失败**，
    //    而症状是"PNG 卡都好、JSON 卡一张都没有"—— 第一版就是这样，判据当场抓住。
    //
    // ⚠️ 这里的读盘走 `openCardFile`（模块里**唯一**碰文件系统的函数），
    //    而不是再写一个 `readFileSync` —— 两处读盘迟早会有一处忘记处理编码/坏文件。
    let text = coerceText({ bytes });
    if (text === null && path) {
      try {
        const io = await import('node:fs');
        text = io.readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    }
    const value = json ?? parseCardText(text ?? '');
    if (!value) return null;
    if (isWorldBookShape(value)) {
      book = normalizeBook(value);
    } else {
      character = normalizeCharacter(value);
      if (!book && character?.book) book = character.book;
    }
  }

  if (!character && !book) return null;

  const kind = classifyCard({ character, book, fileName: base, sourceKind, overrides, path });
  const name = character?.name || book?.name || stripExt(base);
  // 类型是"目录名说了算"还是"内容判出来的"—— 记进警示里，报告里能一眼看见有多少条走的是那条路
  const byDir =
    WORLD_DIR_HINTS.some((hint) => String(path ?? '').includes(hint)) &&
    (kind === KIND.worldcard || kind === KIND.lorebook) &&
    !matchOverride(overrides, path, base);

  // ⚠️ 形状只写一份：`buildRecord` / `buildFull`（D159：不许写第二份"必须一致"的实现）。
  return {
    record: buildRecord({ path, base, sourceKind, kind, name, character, book, bytes, size, mtimeMs, chunks, byDir }),
    full: buildFull({ path, name, base, character, book }),
  };
}

/**
 * 同步版 `parseCard` —— 只吃**已经拿到的**字节或对象。
 *
 * 存在的理由（不是我手痒）：单测要能在**内存里造坏样本**（截断的 PNG、畸形长度、
 * base64 里塞奇数长度的垃圾）并断言"它不抛、也不死循环"。测试不该为了这个去写临时文件。
 *
 * ⚠️ `bytes` 必须是**完整 PNG 字节**；`sourceKind:'json'` 时给 `json` 对象。
 */
export function parseCardSync(input = {}) {
  const { path = '', bytes = null, json = null, sourceKind = 'png', mtimeMs = null, size = null, overrides = null } = input;
  const base = fileNameOf(path);
  let character = null;
  let book = null;
  let chunks = null;

  if (sourceKind === 'png') {
    chunks = readTextChunks(bytes);
    if (!chunks) return null;
    const card = readCardJson(chunks);
    if (card) {
      character = normalizeCharacter(card);
      if (!book && character?.book) book = character.book;
    }
    if (!book) {
      const loose = readBookJson(chunks);
      if (loose) book = normalizeBook(loose);
    }
  } else {
    const value = json ?? parseCardText(typeof bytes === 'string' ? bytes : '');
    if (!value) return null;
    if (isWorldBookShape(value)) {
      book = normalizeBook(value);
    } else {
      character = normalizeCharacter(value);
      if (!book && character?.book) book = character.book;
    }
  }
  if (!character && !book) return null;

  const kind = classifyCard({ character, book, fileName: base, sourceKind, overrides, path });
  const name = character?.name || book?.name || stripExt(base);
  const byDir =
    WORLD_DIR_HINTS.some((hint) => String(path ?? '').includes(hint)) &&
    (kind === KIND.worldcard || kind === KIND.lorebook) &&
    !matchOverride(overrides, path, base);
  return {
    record: buildRecord({ path, base, sourceKind, kind, name, character, book, bytes, size, mtimeMs, chunks, byDir }),
    full: buildFull({ path, name, base, character, book }),
  };
}

/** 摘要记录的形状只有一份实现 —— 同步/异步两条路都走它（D159：不许写第二份必须一致的实现）。 */
function buildRecord({ path, base, sourceKind, kind, name, character, book, bytes, size, mtimeMs, chunks, byDir = false }) {
  const clean = name.trim() === '' ? stripExt(base) : name;
  return {
    id: cardId(path),
    path,
    fileName: base,
    sourceKind,
    kind,
    name: clean,
    spec: character?.spec ?? '',
    tags: character?.tags ?? [],
    creator: character?.creator ?? '',
    characterVersion: character?.characterVersion ?? '',
    creatorNotes: character?.creatorNotes ?? '',
    talkativeness: character?.talkativeness ?? null,
    hasArt: sourceKind === 'png',
    bytes: Number.isFinite(size) ? size : bytes ? bytes.length : 0,
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
    content: {
      // ⚠️ **索引里只留正文前 `INDEX_TEXT_CHARS` 字**，逐字全文在 `data\cards\full\<id>.json`。
      //    为什么：整份正文进索引后 `index.jsonl` 到了 **56 MB**，而它**每次缓存失效都要在
      //    面板进程的主线程上 JSON.parse 一遍**（实测 **285 ms**）—— 同一个进程里还跑着 QQ 收发。
      //    截到 1000 字足够"按正文找卡"，而索引缩到 ~13 MB（解析 ~80 ms）。
      //    📌 判据：`scan --write` 之后 `stats` 里的 MB 数 + 面板首次请求的延迟。
      description: clampText(character?.description, INDEX_TEXT_CHARS),
      firstMes: clampText(character?.firstMes, INDEX_TEXT_CHARS),
      mesExample: clampText(character?.mesExample, INDEX_TEXT_CHARS),
      personality: clampText(character?.personality, INDEX_TEXT_CHARS),
      scenario: clampText(character?.scenario, INDEX_TEXT_CHARS),
      alternateGreetings: character?.alternateGreetings?.length ?? 0,
    },
    sizes: {
      description: utf8Bytes(character?.description ?? ''),
      firstMes: utf8Bytes(character?.firstMes ?? ''),
      mesExample: utf8Bytes(character?.mesExample ?? ''),
      total: character?.bytes ?? book?.bytes ?? 0,
    },
    book: book
      ? {
          name: book.name,
          description: book.description.slice(0, 200),
          entryCount: book.entryCount,
          constantCount: book.constantCount,
          keyedCount: book.keyedCount,
          bytes: book.bytes,
          tokens: book.tokens,
        }
      : null,
    warnings: collectWarnings({ character, book, kind, chunks, byDir }),
  };
}

/** 完整正文的形状同样只有一份。 */
function buildFull({ path, name, base, character, book }) {
  return {
    id: cardId(path),
    path,
    name: name.trim() === '' ? stripExt(base) : name,
    character: character
      ? {
          description: character.description,
          personality: character.personality,
          scenario: character.scenario,
          firstMes: character.firstMes,
          mesExample: character.mesExample,
          alternateGreetings: character.alternateGreetings,
          systemPrompt: character.systemPrompt,
          postHistoryInstructions: character.postHistoryInstructions,
          creatorNotes: character.creatorNotes,
          depthPrompt: character.depthPrompt,
          extensions: character.extensions,
        }
      : null,
    book: book ? { name: book.name, description: book.description, entries: book.entries } : null,
  };
}

/**
 * 值得当面告诉用户/我的异常 —— **不抛异常，只记下来**。
 *
 * 判据是"静默出错比报错贵"：这 7138 张卡里有的是别人手搓的，缺字段很正常；
 * 我们要的是"能跑 + 知道自己跑了多少张有毛病的"，不是"因为第 5000 张缺个字段就整批停"。
 */
function collectWarnings({ character, book, kind, chunks, byDir = false }) {
  const out = [];
  if (byDir) out.push('by_dir');
  if (character) {
    if (!character.description && !character.personality && !character.firstMes) out.push('no_content');
    if (!character.firstMes) out.push('no_first_mes');
    if (character.firstMes.length > 8000) out.push('huge_first_mes');
  }
  if (book) {
    if (book.entryCount === 0) out.push('empty_book');
    // 荒唐 key（素晴里那条 `["."]`）—— 它本身不是错，但配合非 constant 就是永不触发
    const silly = book.entries.filter(
      (x) => !x.constant && x.keys.length > 0 && x.keys.every((k) => k.length <= 1),
    ).length;
    if (silly > 0) out.push(`silly_keys:${silly}`);
  }
  if (kind === KIND.worldcard) out.push('world_shell');
  if (chunks && !chunks.chara && !chunks.ccv3) out.push('odd_chunk_names');
  return out;
}

// ---------------------------------------------------------------------------
// ⑥ 身份 / 摘要 / 检索（都是纯函数）
// ---------------------------------------------------------------------------

/** 取路径最后一段。两种斜杠都认（Windows 卡库是 `\`）。 */
export function fileNameOf(p) {
  const text = String(p ?? '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut === -1 ? text : text.slice(cut + 1);
}

/** 去掉扩展名。 */
export function stripExt(fileName) {
  const text = String(fileName ?? '');
  const cut = text.lastIndexOf('.');
  return cut <= 0 ? text : text.slice(0, cut);
}

/**
 * **稳定的卡 id**：来源路径的 FNV-1a 32 位十六进制。
 *
 * 为什么不用自增/序号：路径不变 → id 不变，于是"重建索引"不会让引用卡的地方全失效
 * （梦境引用、收藏、预设都会引用 id）。⚠️ 它**不是**安全哈希，别拿它当完整性校验。
 */
export function cardId(path) {
  const text = String(path ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 一条索引记录的**一行摘要**（CLI 用；不含正文，省上下文）。 */
export function summarizeRecord(record) {
  const bits = [record.kind.padEnd(9), record.name.slice(0, 24).padEnd(24)];
  if (record.book) bits.push(`书${String(record.book.entryCount).padStart(4)}条`);
  if (record.sizes.description) bits.push(`设${record.sizes.description}`);
  if (record.sizes.firstMes) bits.push(`开${record.sizes.firstMes}`);
  if (record.warnings.length) bits.push(record.warnings.slice(0, 2).join(','));
  return bits.join(' ');
}

/**
 * 卡库统计。**索引库每次重建后都要打一遍** —— 数字是"这批卡到底能不能用"的唯一判据。
 */
export function summarizeLibrary(records) {
  const byKind = {};
  const warnings = {};
  let totalBytes = 0;
  let withBook = 0;
  let withFirstMes = 0;
  let bookEntries = 0;
  for (const record of records) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    totalBytes += record.bytes ?? 0;
    if (record.book) {
      withBook += 1;
      bookEntries += record.book.entryCount;
    }
    if (record.sizes?.firstMes > 0) withFirstMes += 1;
    for (const warning of record.warnings ?? []) {
      const key = warning.split(':')[0];
      warnings[key] = (warnings[key] ?? 0) + 1;
    }
  }
  const names = new Set(records.map((r) => `${r.kind}:${r.name}`));
  return {
    total: records.length,
    byKind,
    warnings,
    withBook,
    withFirstMes,
    bookEntries,
    duplicateNames: records.length - names.size,
    totalBytes,
    totalMB: Math.round(totalBytes / 1048576),
  };
}

/**
 * 关键词检索（**纯字符串打分，不做语义**）。
 *
 * 打分规则故意透明：名字命中 100/次，标签 40/次，世界书名 60/次，正文命中 8/次。
 * 这样"用户能预测排序"，而不是"好像有时候挺聪明"。
 *
 * ## 多词是 **AND**（这一条我写错过，记下来）
 *
 * `素晴 冒险` = 两条都要命中。第一版我写成"没全中就扣 5 分、照旧返回"，
 * 于是搜索**看起来**永远有结果 —— 而"永远有结果"等于没有搜索。
 *
 * ⚠️ 但**只有 `all` 一条路会让人打错一个词就搜不到任何东西**（中文输入法这种事天天有），
 * 所以形状是：**先严格 AND；一条都没有时，才退回"命中任意词"**，
 * 并且返回的 `partial` 标记告诉调用方"这批是退让结果"。
 *
 * ## 默认(无关键词)排序(2026-10-14 / D227 追加十一)
 *
 * 用户:「默认推荐的角色卡不够经典……能不能优先展示"同人"文件夹里面的」。
 * 无关键词时原来全员 0 分 → 纯按名字排序,同人卡混在中间。现在:
 * **标签命中 PRIORITY_TAGS 的卡排在最前**(同分仍按名字排),有关键词时打分规则不变。
 * 标签来自 folderTagsFor(分类文件夹名),所以"同人文件夹优先"落地为标签优先,口径一份。
 *
 * @param {object[]} records
 * @param {{text?:string, kind?:string, hasBook?:boolean, limit?:number}} [query]
 * @returns {{items:object[], partial:boolean, partialCount:number, terms:string[]}}
 */
/** 默认排序的置顶标签(用户 2026-10-14 拍板:优先展示"同人"文件夹里的卡)。 */
export const PRIORITY_TAGS = ['同人'];
export function searchCardsDetailed(records, { text = '', kind = '', hasBook = false, limit = 50 } = {}) {
  const needle = String(text ?? '').trim().toLowerCase();
  const terms = needle === '' ? [] : needle.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const record of records) {
    if (kind && record.kind !== kind) continue;
    if (hasBook && !record.book) continue;
    if (terms.length === 0) {
      const tags = (record.tags ?? []).map((t) => String(t));
      const priority = PRIORITY_TAGS.some((p) => tags.includes(p)) ? 1 : 0;
      scored.push({ record, score: priority, hitAll: true });
      continue;
    }
    const name = record.name.toLowerCase();
    const tags = (record.tags ?? []).join(' ').toLowerCase();
    const bookName = (record.book?.name ?? '').toLowerCase();
    const body = `${record.content?.description ?? ''} ${record.content?.firstMes ?? ''}`.toLowerCase();
    let score = 0;
    let hitAll = true;
    for (const term of terms) {
      let termScore = 0;
      if (name.includes(term)) termScore += 100;
      if (bookName.includes(term)) termScore += 60;
      if (tags.includes(term)) termScore += 40;
      if (body.includes(term)) termScore += 8;
      if (termScore === 0) hitAll = false;
      score += termScore;
    }
    if (score === 0) continue;
    scored.push({ record, score, hitAll });
  }
  const strict = scored.filter((x) => x.hitAll);
  // ⚠️ `partial` 必须是**布尔**：第一版写成了"退让结果的条数"（`strict.length === 0 && terms.length > 1 && scored.length`），
  //    于是 `partial` 在"有 3 条退让结果"时是数字 3 —— `if (partial)` 照样能进，
  //    但 `partial === true` 的判据会红。返回值的**类型**也是接口的一部分。
  const partialCount = strict.length === 0 && terms.length > 1 ? scored.length : 0;
  const pool = partialCount > 0 ? scored : strict;
  pool.sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name, 'zh'));
  return {
    items: pool.slice(0, limit).map((x) => x.record),
    partial: partialCount > 0,
    partialCount,
    terms,
  };
}

/** 只要结果那一层（大多数调用方要的就是它）。 */
export function searchCards(records, query = {}) {
  return searchCardsDetailed(records, query).items;
}

/**
 * **卡标签的合并**(1.130.0 / D227 追加三):卡自身 tags ∪ 人工维护的覆盖档 tags。
 *
 * 覆盖档是**人工维护的一层**(键 = 角色名或卡 id,值带 tags 与来源;文件在 gitignored
 * 的 `data\cards\` 里,不进版本库) —— 索引里的 tags 大多是空的,而检索与界面筛标签
 * 都要吃到这一层。这里只做**纯合并**:去重、保序(卡自己的在前,覆盖档补在后)。
 * **它不读盘、不知道覆盖档文件在哪** —— 读盘是调用方(面板)的事。
 */
export function mergeCardTags(ownTags, overlayTags) {
  const seen = new Set();
  const out = [];
  for (const tag of [...(Array.isArray(ownTags) ? ownTags : []), ...(Array.isArray(overlayTags) ? overlayTags : [])]) {
    const text = typeof tag === 'string' ? tag.trim() : '';
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * **分类文件夹名 → 标签**(2026-10-13,用户整理了 `D:\卡` 卡库:
 * 「直接使用分类的文件夹名称给里面的角色卡附加标签,如给"萝莉"文件夹里的角色卡都加上"萝莉"的标签」)。
 *
 * 口径:
 *  · 只对**卡根下的相对路径**算 —— 第一层段是"类别层"(主世界卡 / 次世界卡 / 角色卡),**不算标签**;
 *  · 类别层**之下**的每一层文件夹名都算一枚标签(`角色卡\萝莉\x.png` → ['萝莉'];
 *    `角色卡\同人\校园\x.png` → ['同人','校园'] —— 多层分类每层都是标签);
 *  · 卡直接躺在类别层里(没有分类子文件夹)= 没有文件夹标签,不硬造;
 *  · 段名 trim(用户的「角色卡 」文件夹名带尾随空格,分类名也可能带)。
 *
 * 纯函数:字符串进、字符串数组出,不碰盘 —— 判据在 selftest-dream.js。
 * @param {string} rootDir 卡根(D:\卡 这一级)
 * @param {string} filePath 卡文件完整路径
 * @returns {string[]}
 */
export function folderTagsFor(rootDir, filePath) {
  const base = String(rootDir ?? '').replace(/[\\/]+$/, '');
  const full = String(filePath ?? '');
  if (base === '' || !full.toLowerCase().startsWith(base.toLowerCase())) return [];
  let rel = full.slice(base.length).replace(/^[\\/]+/, '');
  rel = rel.replace(/[\\/]+[^\\/]*$/, '');          // 去掉文件名,只留目录段
  const segments = rel.split(/[\\/]/).map((s) => s.trim()).filter(Boolean);
  return segments.slice(1);                          // 第一段 = 类别层(主世界卡/次世界卡/角色卡),不算标签
}

/**
 * 索引库文件的**版本**。形状一变就要加 1 —— 否则新代码读旧库会静默拿到缺字段的记录。
 * （和 `SCHEMA_VERSION` 同一个道理。）
 *
 * ⚠️ **2 = 正文截到 `INDEX_TEXT_CHARS`**（1 的库有 56 MB、解析 285 ms）。版本对不上时
 *    `scan` 会**强制全量重扫**（见 `scripts\dream-index.js`）—— 否则旧的胖记录会被"增量合并"
 *    原样留着，而报告看起来一切正常。
 *
 * ⚠️ **3 = 记录加 `digest` 字段**（2026-10-14 / D227 追加十二：文件原始字节的 sha256 前 16 位）。
 *    起因：同一套系统世界书随多个角色包分发（同名文件躺在 N 个文件夹里），
 *    候选列表按路径派生 id 就列出 N 行一样的。digest 是"内容相同"的判据，
 *    展示层按它去重（`dedupeByDigest`）。版本对不上 → 全量重扫补字段。
 */
export const INDEX_VERSION = 3;

/**
 * **按内容摘要去重**(2026-10-14 / D227 追加十二)。同一份世界书/卡被复制进多个文件夹时,
 * 索引里是 N 条(路径不同 → id 不同),候选列表就重复 N 行。这里**保序保留每个 digest 的第一条**,
 * 没有 digest 的记录(旧库/派生记录)原样放行 —— 判据"内容完全相同"才去重,名字相同不去重。
 * 纯函数,只过滤不改记录;被隐藏的 id 仍能被房间的 manifest 引用(resolve 不受影响)。
 * @param {object[]} records
 * @returns {object[]}
 */
export function dedupeByDigest(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    const digest = typeof record?.digest === 'string' ? record.digest : '';
    if (digest === '') { out.push(record); continue; }
    if (seen.has(digest)) continue;
    seen.add(digest);
    out.push(record);
  }
  return out;
}

/**
 * **世界卡步的分类**(2026-10-14 / D227 追加二十,用户:「选世界卡没有出现全年龄和限制级的分类……
 * 能看到两个世界卡文件夹里的所有卡」)。
 *
 * 世界卡这类东西的**分类层就是根下第一层文件夹**(`主世界卡 / 次世界卡 / 世界卡-全年龄`),
 * 而 `folderTagsFor` 刻意**不算**这一层(那是角色卡那条口径)。所以世界卡步的分类在这里
 * 单独派生:按卡所在的**第一个文件夹段**映射 ——
 *   · 段名带「全年龄」→ `全年龄`;
 *   · 其余(`主世界卡` / `次世界卡`)→ `限制级`(用户自己用的叫法,两类合一枚 chip);
 *   · 认不出段(裸文件/路径对不上根)→ 空串(不硬造)。
 *
 * 纯函数:roots 传**该库索引头里的 roots**(面板侧现成有),不碰盘。
 * @param {string} cardPath 卡文件完整路径
 * @param {string[]} roots 该库的根(如 ['D:\\卡'] / ['D:\\卡-全年龄'])
 * @returns {string} 分类名(可能为空串)
 */
export function worldStepCategory(cardPath, roots) {
  const p = String(cardPath ?? '');
  const list = Array.isArray(roots) ? roots : [];
  let seg = '';
  for (const root of list) {
    const base = String(root ?? '').replace(/[\\/]+$/, '');
    if (base === '' || !p.toLowerCase().startsWith(base.toLowerCase())) continue;
    const rel = p.slice(base.length).replace(/^[\\/]+/, '');
    seg = rel.split(/[\\/]/)[0] ?? '';
    break;
  }
  seg = seg.trim();
  if (seg === '') return '';
  return seg.includes('全年龄') ? '全年龄' : '限制级';
}

/**
 * **标签路径**匹配(2026-10-14 / D227 追加十五,用户:「选择标签后能显示标签所指文件夹下…的所有角色卡」)。
 *
 * 卡记录的 `tags` 是**分类文件夹路径**(有序):`角色卡\同人\手游\x.png` → ['同人','手游']。
 * 所以"选中某个标签"= 选中一条**路径前缀**:
 *   · `tagPathMatches(['同人','手游'], ['同人'])` → true(前缀命中,子孙都算这一层之下);
 *   · `tagPathMatches(['萝莉'], ['同人'])` → false;
 *   · 空路径 = 谁都算(根)。
 * 大小写不敏感(标签是文件夹名,Windows 不管大小写);路径里的段做 trim。
 * @param {string[]} tags 卡记录的标签数组(路径)
 * @param {string[]} path 选中的路径
 * @returns {boolean}
 */
export function tagPathMatches(tags, path) {
  const list = Array.isArray(tags) ? tags : [];
  const want = (Array.isArray(path) ? path : []).map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean);
  if (want.length === 0) return true;
  if (list.length < want.length) return false;
  for (let i = 0; i < want.length; i += 1) {
    if (String(list[i] ?? '').trim().toLowerCase() !== want[i]) return false;
  }
  return true;
}

/**
 * **下一级标签 + 计数**(2026-10-14 / D227 追加十五)。用户:「每个标签都没有出现选择后的第二级
 * (如选择同人标签后应该显示动画、漫画、赛马娘等)」。
 *
 * 取"当前路径之下、再深一层"的段名与条数 —— 选 `同人` → 手游 147 / 动画 79 / 游戏 36 …;
 * 选 `同人>手游` → 碧蓝档案 / 明日方舟 / 米哈游 …;根路径 → 顶层文件夹名。
 * 计数 = 该子段下**整棵子树**的卡数(与"选中后能看到的条数"一致,不玩虚的)。
 * 按条数降序,截前 `limit` 枚。⚠️ 段名相同、层级不同算两枚(路径不同)。
 * @param {object[]} records
 * @param {string[]} path 当前路径
 * @param {(record:object)=>(string[])} [tagsOf] 取标签(默认取 record.tags;调用方可注入覆盖档合并口径)
 * @param {number} [limit]
 * @returns {[string, number][]}
 */
export function childTagsFor(records, path, tagsOf = (record) => record?.tags ?? [], limit = 12) {
  const depth = (Array.isArray(path) ? path : []).map((s) => String(s ?? '').trim()).filter(Boolean).length;
  const counts = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const tags = tagsOf(record) ?? [];
    if (!tagPathMatches(tags, path)) continue;
    const next = String(tags[depth] ?? '').trim();
    if (next === '') continue;
    counts.set(next, (counts.get(next) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, Math.max(0, limit));
}
