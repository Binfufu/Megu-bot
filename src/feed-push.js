import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// 盯梢新消息 → QQ 私聊推送的纯逻辑层。零依赖、只读：
// 本模块不写 feed.db、不发网络、不读配置、不启动定时器；HTTP/发送器/接线在调用方。
// 输入权威是 SQLite feed.db（表结构见 src/feed.js）。summary 是来源正文提取（≤2400 字），
// 不是模型摘要；OpenRouter 的 summary 里嵌着 API 原始 pricing JSON，必须从文本中稳健提取。
// 纪律：所有判断失败都偏保守（不推），绝不因为「看不懂」而抛给调用方或猜一个价格。

const INBOX_COLUMNS = 'id, sourceId, sourceName, key, type, title, url, summary, publishedAt, detectedAt';
// 价格比较字段：prompt/completion 是核心，缓存读写价只在两版都存在时才参与。
const CORE_PRICE_FIELDS = ['prompt', 'completion'];
const CACHE_PRICE_FIELDS = ['input_cache_read', 'input_cache_write'];
// 只接受这种十进制（可带指数）数字字符串；JSON 里的数字本身走 typeof number。
const NUMERIC_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const BODY_LIMIT = 120;
const LABEL_NEWS = '【异界新闻】';
const LABEL_PRICE = '【异界新闻·价格】';
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/** 数字或数字字符串 → 有限数；其余（null、布尔、嵌套对象、非法数字串）→ null。 */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC_TEXT.test(value.trim())) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 从 start（text[start] === '{'）起用字符串/转义感知的括号扫描找配对的 '}'；失败 → -1。 */
function objectEnd(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * 从 OpenRouter summary 提取 pricing 对象；解析不出返回 null。
 * 形态（见 src/feed-sources.js）：`<名>; OpenRouter API 原始 pricing=<JSON>; 币种 USD…`。
 * 口径：
 *  - 用括号配对而不是切 `; 币种`：嵌套 overrides、字符串里的分号都不会切坏；
 *  - 只保留数值/数字字符串字段并统一成有限数；`overrides` 原样保留（不展开、不参与比较），
 *    其余未知嵌套对象丢弃；
 *  - 单个非法数字字段忽略（例如 "abc"、null、Infinity）；若一个可用数值字段都没有 → null；
 *  - `pricing=` 不存在、后面不是完整 JSON 对象、JSON.parse 失败、不是普通对象 → null。
 * 这里「看不懂 = null」而不是返回空对象，调用方据此保守跳过，不把坏数据当 0 价。
 */
export function parsePricingFromSummary(summary) {
  if (typeof summary !== 'string' || !summary) return null;
  const marker = summary.indexOf('pricing=');
  if (marker < 0) return null;
  const afterMarker = marker + 'pricing='.length;
  const brace = summary.indexOf('{', afterMarker);
  if (brace < 0) return null;
  // `pricing=null` / `pricing=[...]` / `pricing=garbage{...}` 都算不是对象。
  if (summary.slice(afterMarker, brace).trim() !== '') return null;
  const end = objectEnd(summary, brace);
  if (end < 0) return null;
  let parsed;
  try { parsed = JSON.parse(summary.slice(brace, end)); } catch { return null; }
  if (!isRecord(parsed)) return null;
  const pricing = {};
  let numericFields = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'overrides') {
      if (Array.isArray(value)) pricing.overrides = value; // 原样保留，不展开
      continue;
    }
    const number = finiteNumber(value);
    if (number !== null) {
      pricing[key] = number;
      numericFields++;
    }
  }
  return numericFields > 0 ? pricing : null;
}

/**
 * 两版 pricing 的最大相对变化百分比：|next-prev|/prev*100，涨跌同向取绝对值。
 * 比较 prompt、completion；input_cache_read/input_cache_write 仅当两版都有时参与。
 * prev 缺失或 ≤0 的字段跳过；next 缺失/非数的字段跳过；没有任何可比字段 → null。
 * 返回原始浮点（不四舍五入）；排版层负责取整展示。
 */
export function priceChangePct(prevPricing, nextPricing) {
  if (!isRecord(prevPricing) || !isRecord(nextPricing)) return null;
  let largest = null;
  for (const field of [...CORE_PRICE_FIELDS, ...CACHE_PRICE_FIELDS]) {
    if (CACHE_PRICE_FIELDS.includes(field) &&
        (!Object.hasOwn(prevPricing, field) || !Object.hasOwn(nextPricing, field))) continue;
    const before = finiteNumber(prevPricing[field]);
    const after = finiteNumber(nextPricing[field]);
    if (before === null || after === null || before <= 0) continue;
    const percent = Math.abs(after - before) / before * 100;
    if (largest === null || percent > largest) largest = percent;
  }
  return largest;
}

/**
 * 只读盯梢库读取器。打开方式固定为 new DatabaseSync(dbPath, { readOnly: true })。
 * dbPath 空/非绝对/文件不存在/不是 feed 库（无 feed_inbox 表）/打开失败 → 整个 reader
 * 进入 disabled：latestDetectedAt()→null、pending()→[]、previousFor()→null，close() 安全，
 * 且只 log 一次（不刷屏）。所有查询错误吞掉返回兜底值，绝不抛给调用方。
 * 读不到最新数据时调用方应保持 cursor 不动，下一轮重试，而不是当成「没有新消息」推进。
 */
export function createFeedPushReader({ dbPath, log = () => {} } = {}) {
  let db = null;
  let disabled = false;
  let noted = false;
  const note = message => {
    if (noted) return;
    noted = true;
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* 日志通道自身失败不能影响推送 */ }
  };
  const closeQuietly = () => {
    const current = db;
    db = null;
    if (current) { try { current.close(); } catch { /* 已关闭/句柄损坏都不抛 */ } }
  };
  const disable = message => {
    if (!disabled) {
      disabled = true;
      note(message);
    }
    closeQuietly();
  };
  const guarded = (run, fallback) => {
    if (disabled || !db) return fallback;
    try { return run(db); } catch (error) {
      // 查询失败不永久关闭（可能是瞬时锁/文件被换），只记一次，下一轮再试。
      note(`feed-push reader query failed: ${error?.code ?? error?.message ?? String(error)}`);
      return fallback;
    }
  };
  const usable = typeof dbPath === 'string' && dbPath.trim() !== '' && isAbsolute(dbPath) && existsSync(dbPath);
  if (!usable) {
    disable('feed-push reader disabled: dbPath 缺失、不是绝对路径或文件不存在');
  } else {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='feed_inbox'").get();
      if (!table) disable('feed-push reader disabled: 不是盯梢库（缺少 feed_inbox 表）');
    } catch (error) {
      disable(`feed-push reader disabled: 打开只读库失败（${error?.code ?? error?.message ?? String(error)}）`);
    }
  }
  return {
    latestDetectedAt() {
      return guarded(database => {
        const row = database.prepare('SELECT MAX(detectedAt) AS latest FROM feed_inbox').get();
        return row && typeof row.latest === 'number' ? row.latest : null;
      }, null);
    },
    pending(options = {}) {
      if (disabled || !db) return [];
      const { cursor = 0, limit = 20 } = options ?? {};
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('cursor must be a non-negative safe integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be a safe integer between 1 and 200');
      return guarded(database => database.prepare(
        `SELECT ${INBOX_COLUMNS} FROM feed_inbox WHERE detectedAt > ? ORDER BY detectedAt ASC, id ASC LIMIT ?`,
      ).all(cursor, limit).map(row => ({ ...row })), []);
    },
    previousFor(options = {}) {
      if (disabled || !db) return null;
      const { sourceId, key, detectedAt } = options ?? {};
      if (typeof sourceId !== 'string' || sourceId.trim() === '') throw new TypeError('sourceId must be a non-empty string');
      if (typeof key !== 'string' || key.trim() === '') throw new TypeError('key must be a non-empty string');
      if (!Number.isSafeInteger(detectedAt)) throw new TypeError('detectedAt must be a safe integer');
      return guarded(database => {
        const row = database.prepare(`SELECT ${INBOX_COLUMNS} FROM feed_inbox
          WHERE sourceId=? AND key=? AND detectedAt < ? ORDER BY detectedAt DESC, id DESC LIMIT 1`)
          .get(sourceId, key, detectedAt);
        return row ? { ...row } : null;
      }, null);
    },
    close() { closeQuietly(); },
  };
}

/**
 * 从一批 inbox 行里挑出可推送项，保持 rows 顺序。
 *  - type==='new' → 推，reason 'new'；
 *  - type==='updated' → 只有 sourceId==='openrouter' 且前后 summary 都能解析出 pricing、
 *    最大相对价格变化 ≥ pricePct 时才推，reason 'price'；changePct 记原始百分比。
 * updated 保守口径（有意）：非价格源的正文更新暂不推——没有模型摘要时容易变成每日噪音，
 * 价格变化才是「必须盯」的信号；OpenRouter 其它字段变化（描述/overrides）在价格不变时不推。
 * pricePct 必须是 [1,10000] 内的有限数（可以是小数）。previousFor 缺省 = 永远取不到前一条，
 * 于是所有 updated 都不推（保守），调用方应传入 reader.previousFor。
 */
export function selectPushable(rows, { pricePct = 50, previousFor = () => null } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (typeof pricePct !== 'number' || !Number.isFinite(pricePct) || pricePct < 1 || pricePct > 10_000) {
    throw new TypeError('pricePct must be a finite number between 1 and 10000');
  }
  if (typeof previousFor !== 'function') throw new TypeError('previousFor must be a function');
  const selected = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.type === 'new') {
      selected.push({ row, reason: 'new', changePct: null });
      continue;
    }
    if (row.type !== 'updated' || row.sourceId !== 'openrouter') continue;
    const previous = previousFor({ sourceId: row.sourceId, key: row.key, detectedAt: row.detectedAt });
    const before = parsePricingFromSummary(previous?.summary);
    const after = parsePricingFromSummary(row.summary);
    if (!before || !after) continue;
    const changePct = priceChangePct(before, after);
    if (changePct === null || changePct < pricePct) continue;
    selected.push({ row, reason: 'price', changePct });
  }
  return selected;
}

/** 控制字符压成一个空格（换行由排版层自己加入），再折叠空白。 */
function oneLine(value) {
  return String(value ?? '').replace(CONTROL_RUN, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * 从 summary 提取「可读正文」：
 *  - OpenRouter：去掉 pricing=<JSON> 段、去掉 `币种…不统一换算。` 释义句与
 *    `OpenRouter API 原始` 包裹语，剩下的是描述；模型的 summary 形如
 *    `<名>; OpenRouter API 原始 pricing={…}; 币种 USD…。 <描述>`。
 *  - 其它源：用 summary，去掉开头重复的标题（GLM 的 summary 是 `标题 正文`）。
 * 返回单行、无控制字符；空串表示没有可读正文。
 */
function readableBody(row) {
  const title = oneLine(row.title);
  let body = typeof row.summary === 'string' ? row.summary : '';
  if (row.sourceId === 'openrouter') {
    const marker = body.indexOf('pricing=');
    if (marker >= 0) {
      const brace = body.indexOf('{', marker + 'pricing='.length);
      if (brace >= 0) {
        const end = objectEnd(body, brace);
        if (end > 0) body = `${body.slice(0, marker)} ${body.slice(end)}`;
      }
    }
    const currency = body.indexOf('币种');
    if (currency >= 0) {
      const end = body.indexOf('不统一换算。', currency);
      if (end >= 0) body = `${body.slice(0, currency)} ${body.slice(end + '不统一换算。'.length)}`;
    }
    body = body.replace(/OpenRouter\s*API\s*原始/gu, ' ');
  }
  body = oneLine(body);
  if (title && body.startsWith(title)) body = body.slice(title.length);
  return body.replace(/^[\s;；,，·:：、|/-]+/u, '').trim();
}

/** 截到 max 个字符（含省略号）；max≤0 返回空串。 */
function clip(value, max) {
  if (max <= 0) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 单条推送文本。调用方负责分条发送；本函数纯排版、无随机、无时间，同一输入输出恒定。
 * 形状：第 1 行 `【异界新闻】<来源> · <标题>`（价格变体 `【异界新闻·价格】…（约 +NN%）`），
 * 有可读正文时第 2 行是 ≤120 字正文，最后一行永远是 url（绝不截 url）。
 * 总长 ≤ maxChars：先截正文再截标题，截断补 `…`；字段里的控制字符/换行/制表统一清掉。
 * 极端情况下 maxChars 小于「固定开销（标签+来源名+url）」，URL 完整与上限无法同时满足，
 * 此时返回最小可用形状（上限破例），调用方应给足 maxChars（默认 300 够用）。
 */
export function formatFeedPush(item, { maxChars = 300 } = {}) {
  if (!isRecord(item)) throw new TypeError('item required');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive safe integer');
  const row = isRecord(item.row) ? item.row : item;
  const reason = item.reason ?? row.type;
  const changePct = item.changePct ?? null;
  const label = reason === 'price' ? LABEL_PRICE : LABEL_NEWS;
  const percent = Number.isFinite(changePct) ? Math.round(Math.abs(changePct)) : null;
  const priceTag = reason === 'price' && percent !== null ? `（约 +${percent}%）` : '';
  const name = oneLine(row.sourceName) || '未知来源';
  const title = oneLine(row.title);
  const url = String(row.url ?? '').replace(CONTROL, '');
  const headerFor = text => text
    ? `${label}${name} · ${text}${priceTag}`
    : `${label}${name}${priceTag}`;
  const page = (text, body) => {
    const lines = [headerFor(text)];
    if (body) lines.push(body);
    lines.push(url);
    return lines.join('\n');
  };
  const rawBody = readableBody(row);
  let titleText = title;
  let bodyText = clip(rawBody, BODY_LIMIT);
  let text = page(titleText, bodyText);
  if (text.length > maxChars) {
    // 先截正文：在保留完整标题的前提下，算出正文还能占多少字。
    const withoutBody = page(titleText, '');
    const bodyRoom = maxChars - withoutBody.length - 1; // 正文行还占一个换行
    bodyText = bodyRoom > 0 ? clip(rawBody, Math.min(BODY_LIMIT, bodyRoom)) : '';
    text = page(titleText, bodyText);
  }
  if (text.length > maxChars) {
    // 再截标题：正文已经让到最小（可能为空），把剩余空间给标题。
    const withoutTitle = page('', bodyText);
    const titleRoom = maxChars - withoutTitle.length - ' · '.length;
    titleText = titleRoom > 0 ? clip(title, Math.min(title.length, titleRoom)) : '';
    text = page(titleText, bodyText);
  }
  return text;
}

/**
 * 从「最新优先」的会话键里发现主人的私聊目标。
 * 只认 `qqbot-c2c-<openid>`（可带 `-g<代数>` 后缀，如 qqbot-c2c-ABC-g3），
 * 群键（qqbot-group-*）忽略；按入参顺序取第一个；空串/非字符串忽略；
 * 给了 selfId 时排除它（防止把机器人自己当推送对象）。没有 → null。
 * 不修改入参，不联网、不读记忆库（调用方负责提供会话键快照）。
 */
export function discoverC2cTarget(conversationKeys, { selfId = null } = {}) {
  if (!Array.isArray(conversationKeys)) return null;
  const pattern = /^qqbot-c2c-(.+?)(?:-g\d+)?$/u;
  for (const key of conversationKeys) {
    if (typeof key !== 'string') continue;
    const matched = pattern.exec(key);
    if (!matched) continue;
    const openid = matched[1];
    if (!openid) continue;
    if (typeof selfId === 'string' && openid === selfId) continue;
    return openid;
  }
  return null;
}
