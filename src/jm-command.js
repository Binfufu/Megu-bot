/**
 * 「搜本/找本 <关键词>」「下本 <编号/序号>」的**纯解析器**（2026-11-12）。
 *
 * 做的是与 `src\meitu-command.js` 同构的一件事：把群消息里的一条**确定性指令**认出来，
 * 正常命中不经过模型；网络/落盘/发送全在别处（`scripts\jm-fetch-one.mjs` 与
 * `src\jm-service.js`）。所以本文件**不联网、不读文件、不碰子进程**，输入输出都是普通对象。
 *
 * 认的写法（群里 @ 之后的正文；⚠️ 有的客户端会把 `@名字` 当成**纯文本**留在正文里，
 * 网关只剥段落 @，所以开头/末尾残留的 `@xxx` 要先剥掉）：
 *
 *     搜本 全彩                 ← 关键词搜索，数量用默认上限（`QQBOT_JM_MAX`，默认 5）
 *     找本 全彩                 ← 「找本」与「搜本」同义
 *     搜本 全彩 3               ← 末尾单独一个数量词（1..5，超出夹到上限）
 *     搜本 全彩 三               ← 中文数量也认
 *     下本 1490076              ← 直接给作品编号（至少两位数字；边车按 id 下载）
 *     下本 3                    ← 给**序号**：取本群最近一次搜索结果里的第 3 本
 *     下载本子 1490076          ← 「下载本子」是「下本」的别名
 *
 * 解析顺序（每一步只做一件小事，selftest 按表钉着）：
 *   ⓪ 归一化：trim → 去前导标点/空白 → 去句末标点 → 剥前导 `@残留` → 剥末尾 `@残留`；
 *   ① 搜索指令：`^(搜本|找本|搜索本子|找本子)\s*(.*)$` —— 剩余段非空、长度 1..60 字；
 *      剩余段**末尾以空白分隔**的数量词（阿拉伯或中文 1..5）当数量，其余全是关键词。
 *      ⚠️ 数量必须与关键词之间有空白：「搜本 全彩3」里的 `3` 算关键词（宁窄勿宽，
 *      关键词里出现数字很常见，不能瞎猜）；
 *   ② 下载指令：`^(下本|下载本子|下载本)\s*(.*)$` —— 去掉 `#`/`第`/尾部「号」之后：
 *      · **一位数字 1..5** = 序号（对应最近一次搜索的 rank，由服务层换算成 id）；
 *      · **两位及以上数字** = 作品编号，原样交给边车；
 *      · 其它 = 格式错误（回一句格式提示，别当闲聊丢掉）。
 *
 * 失败分支都带 `reason`：
 *   · `format` = 不是这条指令的形状（空关键词、下本没给东西、编号形状不对…）；
 *   · `count`  = 确实在写搜索指令，但数量写坏了（0 / 超过 60 位以外的怪数字）。
 *
 * 为什么数量上限**夹到**配置上限而不是报错：与搬图同口径（写多了夹到上限是既有行为，
 * 让用户少写一次；写 0 才明确拒绝）。
 */

/** 数量上限的兜底值（与配置 `QQBOT_JM_MAX` 的默认值同一口径，服务层会传真实配置）。 */
export const DEFAULT_JM_MAX = 5;

/** 边车 `/search` 契约 v1：`q` 长度 1..60 字符（按码点算，中文一个字算一个）。 */
export const MAX_JM_KEYWORD_CHARS = 60;

/** 搜索动词与下载动词。⚠️ 同义写法只在这里加一处，`looksLikeJmAttempt` 自动跟上。 */
const SEARCH_VERBS = '搜本|找本|搜索本子|找本子';
const DOWNLOAD_VERBS = '下本|下载本子|下载本';

/** 中文数量 → 数值（只收 1..5 与常见写法；「十几」之类落不到数字 = 当关键词）。 */
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };

/** 一位数字里可以当**序号**的取值（本群最近一次搜索最多 5 本）。 */
const MAX_RANK = 5;

/** 导航用的宽松形状：只要开头是搜索/下载动词，就算"在尝试这条指令"。 */
const ATTEMPT_RE = new RegExp(`^(?:${SEARCH_VERBS}|${DOWNLOAD_VERBS})`, 'u');

/**
 * 把一个数量词解析成数字：阿拉伯数字或中文 1..5；认不出返回 NaN。
 * ⚠️ 这里**不收** 0/6..9/十几 —— 写 0 是明确写错（reason=count），写 6..9 的阿拉伯
 *    数字会进 `parseSearchCount` 的夹取分支（写多了夹到上限）。
 */
function parseCountToken(token) {
  const raw = String(token ?? '').trim();
  if (/^\d+$/u.test(raw)) return Number.parseInt(raw, 10);
  return CN_NUM[raw] ?? Number.NaN;
}

/**
 * 剥掉正文开头残留的**纯文本 @**（`@副实例 搜本 全彩`）。
 * 只剥 `@` 到第一个空白/标点为止的那一段；最多剥三段，剥不出东西就原样返回。
 */
function stripLeadingMentions(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 3; i += 1) {
    const match = /^@[^\s，,、;；。.!！?？]+[\s，,、;；。]*/u.exec(out);
    if (!match) break;
    out = out.slice(match[0].length);
  }
  return out;
}

/**
 * 剥掉正文**末尾**残留的纯文本 @（`搜本 全彩 @副实例`）。只剥最后一段 `@+非空白`；
 * 最多连剥三段（多个提及并列的写法）。没有 `@` 就原样返回。
 */
function stripTrailingMentions(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 3; i += 1) {
    const match = /[\s，,、;；。.!！?？]*@[^\s@，,、;；。.!！?？]+$/u.exec(out);
    if (!match) break;
    out = out.slice(0, match.index).trimEnd();
  }
  return out;
}

/** 归一化：去装饰性标点与残留 @。返回空串 = 没有可用正文。 */
function normalize(text) {
  let out = String(text ?? '')
    .trim()
    .replace(/^[，,、;；\s]+/u, '')
    .replace(/[。！!？?]+$/u, '')
    .trim();
  out = stripLeadingMentions(out);
  out = stripTrailingMentions(out);
  return out.trim();
}

/**
 * 解析搜索指令的剩余段：「关键词 [数量]」。
 *
 * @param {string} rest 动词之后的正文
 * @param {number} max 数量上限（来自 `config.jm.max`）
 * @returns {{ok: true, action: 'search', keyword: string, count: number,
 *            countGiven: boolean}
 *   | {ok: false, reason: 'format'|'count'|'keyword'}}
 */
function parseSearchRest(rest, max) {
  const body = String(rest ?? '').trim();
  if (!body) return { ok: false, reason: 'format' };

  // 末尾单独一个数量词（必须**以空白分隔**，见文件头 ① 的宁窄勿宽口径）。
  let keyword = body;
  let count = null;
  const spaced = /^(.*?)\s+([0-9一二两三四五六七八九十]+)$/u.exec(body);
  if (spaced && spaced[1].trim()) {
    const parsed = parseCountToken(spaced[2]);
    // 「搜本 xxx 十几」这种落不到数字的，不当数量 —— 整段仍算关键词（不瞎猜）。
    if (Number.isSafeInteger(parsed)) {
      keyword = spaced[1].trim();
      count = parsed;
    }
  }
  if (!keyword) return { ok: false, reason: 'format' };
  if (count !== null && count <= 0) return { ok: false, reason: 'count' };
  if (Array.from(keyword).length > MAX_JM_KEYWORD_CHARS) return { ok: false, reason: 'keyword' };

  const limit = Number.isSafeInteger(max) && max > 0 ? max : DEFAULT_JM_MAX;
  return {
    ok: true,
    action: 'search',
    keyword,
    // 写多了夹到上限；没写用上限（一次最多看多少本）。
    count: count === null ? limit : Math.min(count, limit),
    countGiven: count !== null,
  };
}

/**
 * 解析下载指令的剩余段：「编号 / 序号」。
 *
 * @param {string} rest 动词之后的正文
 * @returns {{ok: true, action: 'download', target: string|null, ordinal: number|null,
 *            raw: string} | {ok: false, reason: 'format'}}
 */
function parseDownloadRest(rest) {
  const body = String(rest ?? '')
    .trim()
    .replace(/^[#＃]+\s*/u, '')
    .replace(/^第\s*/u, '')
    .replace(/\s*(?:本|号)$/u, '')
    .trim();
  if (!body) return { ok: false, reason: 'format' };
  if (!/^\d+$/u.test(body)) return { ok: false, reason: 'format' };

  // 序号只有一位 1..5；两位及以上一律当作品编号（JM 的 id 是六位数级别）。
  if (body.length === 1) {
    const rank = Number.parseInt(body, 10);
    if (rank < 1 || rank > MAX_RANK) return { ok: false, reason: 'format' };
    return { ok: true, action: 'download', target: null, ordinal: rank, raw: body };
  }
  return { ok: true, action: 'download', target: body, ordinal: null, raw: body };
}

/**
 * 解析一条群消息。成功 = 可以照做；失败 = 不是这条指令（由调用方决定要不要回格式提示）。
 *
 * @param {string} text 消息正文（群里已经剥掉段落 @ 也行，多剥一层无副作用）
 * @param {{max?: number}} [options] `max` = 一次最多搜几本（来自 `config.jm.max`）
 * @returns {{ok: true, action: 'search', keyword: string, count: number, countGiven: boolean}
 *   | {ok: true, action: 'download', target: string|null, ordinal: number|null, raw: string}
 *   | {ok: false, reason: 'format'|'count'|'keyword'}}
 */
export function parseJmCommand(text, { max = DEFAULT_JM_MAX } = {}) {
  const normalized = normalize(text);
  if (!normalized) return { ok: false, reason: 'format' };

  const search = new RegExp(`^(?:${SEARCH_VERBS})\\s*(.*)$`, 'u').exec(normalized);
  if (search) return parseSearchRest(search[1], max);

  const download = new RegExp(`^(?:${DOWNLOAD_VERBS})\\s*(.*)$`, 'u').exec(normalized);
  if (download) return parseDownloadRest(download[1]);

  return { ok: false, reason: 'format' };
}

/**
 * 「看起来是在尝试搜本/下本」—— 用来区分"格式写歪了"与"普通闲聊"。
 *
 * 只认动词**开头**（剥完 @残留之后）：`搜本`、`找本`、`下本`、`下载本子` 都算；
 * 写成 `搜本`（没关键词）、`下本 随便`（编号不是数字）这类也回一句格式提示。
 * ⚠️ 只给格式提示用：解析成功的那条根本到不了这里。
 *
 * @param {string} text
 */
export function looksLikeJmAttempt(text) {
  return ATTEMPT_RE.test(normalize(text));
}
