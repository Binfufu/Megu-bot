/**
 * 本地目录收藏的**纯解析器**（2026-11-17）。
 *
 * 只做一件事：把群消息里的一条确定性指令认出来，输出结构化对象。
 * **不联网、不读文件、不碰数据库、不产生任何副作用**；落库/解析元数据在
 * `src/catalog-service.js`。
 *
 * 认的写法（`<>` 是占位，不是字面量）：
 *
 *     收藏 <条目ID> [标签:xxx] [标签:yyy]
 *     收藏 #3                         ← 最近一次「收藏夹」清单里的第 3 条（本群本用户）
 *     取消收藏 <条目ID>
 *     取消收藏 #3
 *     收藏夹                          ← 第 1 页
 *     收藏夹 2                        ← 第 2 页
 *     收藏夹 作者:xxx
 *     收藏夹 原作:xxx
 *     收藏夹 标签:xxx
 *     收藏夹 角色:xxx                 ← 与查询层同形的条件；JM 条目一般没有角色
 *     收藏夹 作者:xxx 标签:yyy 2       ← 多条件 AND + 页码
 *     收藏夹 全彩                     ← 标题文本
 *
 * 条目 ID / 来源：
 *   · `JM1490076` = 来源 jm 的 1490076（JM 清单里的显示形状）；
 *   · `jm:1490076` = 显式来源；
 *   · 裸数字 = 调用方给的默认来源（JM 接入时是 jm；其它接入可换）。
 *   · `#3` / `第3个` / `序号3` 是**最近清单序号**，不是条目 ID；服务层必须换算成稳定
 *     条目 ID 才能落库。
 *
 * 失败分支都带 `reason`（format / target / tag / page / unsupported），
 * 由服务层回固定格式提示；**不把解析失败的消息丢给模型闲聊**。
 */

/** 一条指令最多带几个用户标签；数值只是输入边界，不是业务策略。 */
export const MAX_FAVORITE_TAGS = 5;

/** 标签、条件值、文本的长度上限（按码点算）。 */
export const MAX_TAG_CHARS = 30;
export const MAX_FILTER_CHARS = 40;
export const MAX_LIST_TEXT_CHARS = 60;

/** 列表页码上限；越界回格式提示，不静默夹取（页码错了应让用户看见）。 */
export const MAX_PAGE = 9999;

/** 来源 id 的允许形状（站点 id / ISBN / 短 slug 都能装下；不接受空白与控制字符）。 */
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

/** 条件字段别名 → 查询层字段名。只收明确写出来的键。 */
const FILTER_ALIASES = new Map([
  ['作者', 'creator'],
  ['原作', 'original'],
  ['角色', 'character'],
  ['标签', 'tag'],
]);

const SORT_ALIASES = new Map([
  ['最新', 'recent'],
  ['标题', 'title'],
  ['编号', 'source_id'],
]);

function normalize(text) {
  return String(text ?? '')
    .trim()
    .replace(/^[，,、;；\s]+/u, '')
    .replace(/[。！!？?]+$/u, '')
    .trim();
}

/** 剥掉正文开头/末尾残留的纯文本 @（与 JM 解析器同一口径，最多三段）。 */
function stripMentions(text) {
  let out = text;
  for (let i = 0; i < 3; i += 1) {
    const match = /^@[^\s，,、;；。.!！?？]+[\s，,、;；。]*/u.exec(out);
    if (!match) break;
    out = out.slice(match[0].length);
  }
  for (let i = 0; i < 3; i += 1) {
    const match = /[\s，,、;；。.!！?？]*@[^\s@，,、;；。.!！?？]+$/u.exec(out);
    if (!match) break;
    out = out.slice(0, match.index).trimEnd();
  }
  return out.trim();
}

const isOrdinalToken = (token) => /^#\d+$/u.test(token) || /^第\d+(?:个|条)?$/u.test(token) || /^序号\d+$/u.test(token);

function parseOrdinalToken(token) {
  const match = /^(?:#|第|序号)(\d+)/u.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE ? value : null;
}

/**
 * 解析条目 ID。返回 `{source, id}`、`{ordinal}` 或 null。
 * 裸数字用调用方给的默认来源；`JM123` / `jm:123` 是显式来源。
 */
function parseTargetToken(token, defaultSource) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  if (isOrdinalToken(raw)) {
    const ordinal = parseOrdinalToken(raw);
    return ordinal ? { ordinal } : null;
  }
  if (/^JM\d+$/iu.test(raw)) {
    return { source: 'jm', id: raw.replace(/^JM/iu, '') };
  }
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const source = raw.slice(0, colon).trim().toLowerCase();
    const id = raw.slice(colon + 1).trim();
    if (!SOURCE_NAME_RE.test(source) || !SOURCE_ID_RE.test(id)) return null;
    return { source, id };
  }
  if (!SOURCE_ID_RE.test(raw)) return null;
  return { source: defaultSource ?? null, id: raw };
}

/** 把一个 `键:值` token 拆开；没有冒号返回 null。全角/半角冒号都认。 */
function splitKeyValue(token) {
  const match = /^([^:：]+)[:：](.*)$/u.exec(token);
  if (!match) return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

/** 解析「收藏 / 取消收藏」的剩余段。 */
function parseFavoriteRest(rest, { action, defaultSource, allowTags }) {
  const body = String(rest ?? '').trim();
  if (!body) return { ok: false, reason: 'format' };
  const tokens = body.split(/\s+/u).filter(Boolean);
  const tags = [];
  let target = null;
  let ordinal = null;

  for (const token of tokens) {
    const pair = splitKeyValue(token);
    if (pair) {
      if (pair.key === '标签') {
        if (!allowTags) return { ok: false, reason: 'format' };
        if (!pair.value) return { ok: false, reason: 'tag' };
        if (Array.from(pair.value).length > MAX_TAG_CHARS) return { ok: false, reason: 'tag' };
        const normalized = pair.value.normalize('NFKC').trim();
        if (tags.some((tag) => tag.toLowerCase() === normalized.toLowerCase())) continue;
        if (tags.length >= MAX_FAVORITE_TAGS) return { ok: false, reason: 'tag' };
        tags.push(normalized);
        continue;
      }
      // 显式来源写法 `jm:1490076`：source 必须是合法短名，id 必须是合法条目 id。
      // 来源名大小写不敏感（`JM:` 与 `jm:` 等价）；其它 `键:值`（如 `年份:2024`）明确报"不支持"。
      if (SOURCE_NAME_RE.test(pair.key.toLowerCase()) && SOURCE_ID_RE.test(pair.value)) {
        if (target || ordinal) return { ok: false, reason: 'format' };
        target = { source: pair.key.toLowerCase(), id: pair.value };
        continue;
      }
      return { ok: false, reason: 'unsupported', field: pair.key };
    }
    if (target || ordinal) return { ok: false, reason: 'format' };
    const parsed = parseTargetToken(token, defaultSource);
    if (!parsed) return { ok: false, reason: 'target' };
    if (parsed.ordinal) ordinal = parsed.ordinal;
    else target = { source: parsed.source, id: parsed.id };
  }

  if (!target && !ordinal) return { ok: false, reason: 'format' };
  return {
    ok: true,
    action,
    target,
    ordinal,
    tags: allowTags ? tags : [],
  };
}

/**
 * 解析「收藏夹」的剩余段：条件 + 文本 + 页码。
 *
 * 条件键只认 作者/原作/角色/标签；写了不认识的键（`年份:2024`）明确回 unsupported，
 * 不把它混进标题文本，更不静默忽略。
 */
function parseListRest(rest) {
  const body = String(rest ?? '').trim();
  const filters = {};
  const textParts = [];
  let page = 1;
  let pageGiven = false;
  let sort = 'recent';
  let sortGiven = false;

  if (!body) return { ok: true, action: 'list', text: null, filters, page, sort };

  for (const token of body.split(/\s+/u).filter(Boolean)) {
    const pair = splitKeyValue(token);
    if (pair) {
      const key = pair.key;
      if (key === '页码' || key === '页') {
        if (pageGiven || !/^\d+$/u.test(pair.value)) return { ok: false, reason: 'page' };
        const value = Number(pair.value);
        if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) return { ok: false, reason: 'page' };
        page = value;
        pageGiven = true;
        continue;
      }
      if (key === '排序') {
        const normalized = SORT_ALIASES.get(pair.value);
        if (!normalized || sortGiven) return { ok: false, reason: 'unsupported', field: '排序' };
        sort = normalized;
        sortGiven = true;
        continue;
      }
      const field = FILTER_ALIASES.get(key);
      if (!field) return { ok: false, reason: 'unsupported', field: key };
      if (!pair.value || Array.from(pair.value).length > MAX_FILTER_CHARS) {
        return { ok: false, reason: 'format', field: key };
      }
      const value = pair.value.normalize('NFKC').trim();
      filters[field] = Array.isArray(filters[field]) ? [...filters[field], value] : [value];
      continue;
    }

    if (/^\d+$/u.test(token)) {
      if (pageGiven) return { ok: false, reason: 'page' };
      const value = Number(token);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) return { ok: false, reason: 'page' };
      page = value;
      pageGiven = true;
      continue;
    }

    if (/^(?:第\d+页|页码\d+)$/u.test(token)) {
      if (pageGiven) return { ok: false, reason: 'page' };
      const value = Number(token.replace(/\D+/gu, ''));
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) return { ok: false, reason: 'page' };
      page = value;
      pageGiven = true;
      continue;
    }

    textParts.push(token);
  }

  const text = textParts.join(' ').trim();
  if (text && Array.from(text).length > MAX_LIST_TEXT_CHARS) return { ok: false, reason: 'format' };
  return { ok: true, action: 'list', text: text || null, filters, page, sort };
}

/**
 * 解析一条群消息。
 *
 * @param {string} input 消息正文（群里已剥掉段落 @ 也行）
 * @param {{defaultSource?: string}} [options] 裸条目 ID 的来源；JM 接入传 `'jm'`
 * @returns {object} 成功 = `{ok:true, action:'favorite'|'unfavorite'|'list', ...}`；
 *                   失败 = `{ok:false, reason:'format'|'target'|'tag'|'page'|'unsupported', field?}`
 */
export function parseCatalogCommand(input, { defaultSource = null } = {}) {
  const text = stripMentions(normalize(input));
  if (!text) return { ok: false, reason: 'format' };

  // 顺序：取消收藏 → 收藏夹 → 收藏（「收藏夹」不能被「收藏」先吃掉）。
  const unfavorite = /^取消收藏\s*(.*)$/u.exec(text);
  if (unfavorite) {
    return parseFavoriteRest(unfavorite[1], {
      action: 'unfavorite',
      defaultSource,
      allowTags: false,
    });
  }

  const list = /^收藏夹\s*(.*)$/u.exec(text);
  if (list) return parseListRest(list[1]);

  const favorite = /^收藏\s*(.*)$/u.exec(text);
  if (favorite) {
    return parseFavoriteRest(favorite[1], {
      action: 'favorite',
      defaultSource,
      allowTags: true,
    });
  }

  return { ok: false, reason: 'format' };
}

/**
 * 「看起来是在尝试收藏指令」—— 只给格式提示用。
 * 注意：`收藏夹` 也是这条功能的入口，别只认 `收藏`。
 */
export function looksLikeCatalogAttempt(input) {
  const text = stripMentions(normalize(input));
  return /^(?:收藏|取消收藏|收藏夹)/u.test(text);
}
