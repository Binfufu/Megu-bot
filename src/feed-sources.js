import { createHash } from 'node:crypto';

// Approved minimum set only; docs/31 is the source inventory, not a discovery feed.
// Provisional coalescing window: same source/key changes first detected inside one
// window update one inbox row in place instead of adding a row per jitter. 60 min is
// a TENTATIVE default (owner may tune per source); shopping-platform price watchers
// will reuse this exact `coalesceMs` name and per-source override.
const COALESCE_MS = 3_600_000;
// 主人 2026-11-04 拍板：同一来源同一条目每天最多 10 条入箱消息（按北京时间自然日计数）。
// 购物平台（淘宝／京东／拼多多）价格盯梢复用同名参数与语义；0 = 不限。
const MAX_INBOX_PER_KEY_PER_DAY = 10;
export const FIXED_FEED_SOURCES = Object.freeze([
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/models', kind: 'openrouter', frequency: 'high', coalesceMs: COALESCE_MS, maxInboxPerKeyPerDay: MAX_INBOX_PER_KEY_PER_DAY },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api-docs.deepseek.com/updates/', kind: 'deepseek', frequency: 'high', coalesceMs: COALESCE_MS, maxInboxPerKeyPerDay: MAX_INBOX_PER_KEY_PER_DAY },
  { id: 'glm', name: 'GLM', url: 'https://docs.bigmodel.cn/cn/update/new-releases.md', kind: 'glm', frequency: 'high', coalesceMs: COALESCE_MS, maxInboxPerKeyPerDay: MAX_INBOX_PER_KEY_PER_DAY },
].map(Object.freeze));

// As sampled 2026-11-02: OpenRouter models API schema (not an LLM summary):
// https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
// Docusaurus heading IDs and CommonMark ATX/strong blocks are reused as boundaries.
// https://docusaurus.io/docs/markdown-features/toc / https://spec.commonmark.org/0.31.2/
// Zero npm dependencies: intentionally a strict adapter for these observed shapes,
// NOT a general HTML/CommonMark parser. Unknown shapes fail closed, never [] success.
const SUMMARY_LIMIT = 2400;
const fail = message => { throw new Error(`feed source: ${message}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compact = value => value.replace(/[\s\u200b\ufeff]+/gu, ' ').trim();
const bound = (text, limit = SUMMARY_LIMIT) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const digest = text => createHash('sha256').update(text).digest('hex');
function entities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  });
}
const DROPPED_ELEMENTS = new Set(['script', 'style', 'nav', 'footer', 'aside']);
const TAG_AT = /^<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/i;
// One left-to-right scan per call: markup is consumed and never re-interpreted, so a tag
// split by another tag, a nested comment opener, or an unterminated sequence cannot
// re-emerge as markup. With keepTags=false this is the only HTML-to-text path; it replaces
// one-pass `replace()` chains that were provably bypassable (CodeQL
// js/incomplete-multi-character-sanitization).
function scanMarkup(html, keepTags) {
  const out = [];
  let i = 0;
  let dropped = '';
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) break; // unterminated comment: never guess a boundary, drop the remainder
      i = end + 3;
      continue;
    }
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const stop = next < 0 ? html.length : next;
      if (!dropped) out.push(html.slice(i, stop));
      i = stop;
      continue;
    }
    const tag = TAG_AT.exec(html.slice(i));
    if (!tag) {
      if (!dropped) out.push('<'); // a lone '<' is text, not a tag start
      i += 1;
      continue;
    }
    const name = tag[1].toLowerCase();
    const closing = tag[0][1] === '/';
    const selfClosing = /\/\s*>$/.test(tag[0]);
    i += tag[0].length;
    if (dropped) {
      if (closing && name === dropped) dropped = '';
      continue;
    }
    if (!closing && !selfClosing && DROPPED_ELEMENTS.has(name)) {
      dropped = name;
      continue;
    }
    if (keepTags) out.push(tag[0]);
    else out.push(' '); // tags separate words instead of gluing neighbouring text
  }
  return out.join('');
}
const stripNoise = html => scanMarkup(html, true);
const htmlText = html => compact(entities(scanMarkup(html, false)));
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? entities(m[1] ?? m[2]) : null;
}
// Balanced same-tag scan keeps nested divs inside the markdown container, but no
// surrounding TOC/pagination. Quoted attributes may contain '>' characters.
function contentOf(html, name, predicate = () => true) {
  const tokens = /<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  let start = -1, depth = 0;
  for (const m of html.matchAll(tokens)) {
    if (m[1].toLowerCase() !== name) continue;
    const closing = /^<\//.test(m[0]);
    if (start < 0) {
      if (!closing && predicate(m[0])) { start = m.index + m[0].length; depth = 1; }
    } else if (closing) {
      if (--depth === 0) return html.slice(start, m.index);
    } else if (!/\/\s*>$/.test(m[0])) depth++;
  }
  fail(`missing or unclosed ${name} content`);
}
function dateOnly(raw) {
  const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) fail(`invalid date ${raw}`);
  const value = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) fail(`invalid date ${raw}`);
  return value; // date precision only: never invent a publication time/time zone.
}
function normalized(value, depth = 0) {
  if (depth > 12) fail('pricing nesting too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => normalized(v, depth + 1));
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalized(value[k], depth + 1)]));
  fail('invalid pricing JSON');
}
function openrouter(source, text) {
  let body;
  try { body = JSON.parse(text); } catch { fail('OpenRouter invalid JSON'); }
  if (!record(body) || !Array.isArray(body.data) || !body.data.length) fail('OpenRouter missing/nonempty data array');
  return body.data.map(model => {
    if (!record(model) || typeof model.id !== 'string' || !model.id.trim() || typeof model.name !== 'string' || !model.name.trim()) fail('OpenRouter invalid model identity');
    if (!record(model.pricing) || !Object.keys(model.pricing).length) fail(`OpenRouter missing pricing: ${model.id}`);
    const pricing = normalized(model.pricing);
    // Missing optional pricing fields are allowed; an empty/garbled tariff is not.
    const money = ['prompt', 'completion', 'request', 'image', 'audio', 'web_search', 'input_cache_read', 'input_cache_write', 'internal_reasoning'];
    if (!money.some(k => Object.hasOwn(pricing, k))) fail(`OpenRouter unrecognized pricing: ${model.id}`);
    function validateTariff(tariff) {
      for (const k of money) {
        if (Object.hasOwn(tariff, k) && !((typeof tariff[k] === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(tariff[k])) || (typeof tariff[k] === 'number' && Number.isFinite(tariff[k])))) fail(`OpenRouter invalid pricing.${k}: ${model.id}`);
      }
      if (Object.hasOwn(tariff, 'overrides')) {
        if (!Array.isArray(tariff.overrides) || !tariff.overrides.every(record)) fail(`OpenRouter invalid pricing.overrides: ${model.id}`);
        for (const override of tariff.overrides) {
          if (!money.some(k => Object.hasOwn(override, k))) fail(`OpenRouter empty override tariff: ${model.id}`);
          validateTariff(override);
        }
      }
    }
    validateTariff(pricing);
    const priceText = JSON.stringify(pricing);
    const prefix = `${compact(model.name)}; OpenRouter API 原始 pricing=${priceText}; 币种 USD（美元）；prompt/completion/cache 等 token 项单位 USD/token；request/image/web_search 等按来源各字段计价单位，不统一换算。`;
    // Never truncate tariffs: all fields must be visible, or conservatively reject.
    if (prefix.length > SUMMARY_LIMIT) fail(`OpenRouter pricing exceeds summary bound: ${model.id}`);
    if (model.description != null && typeof model.description !== 'string') fail(`OpenRouter invalid description: ${model.id}`);
    const description = model.description ? compact(model.description) : '';
    const room = Math.min(320, SUMMARY_LIMIT - prefix.length - 1);
    const summary = description && room > 1 ? `${prefix} ${bound(description, room)}` : prefix;
    let publishedAt = null;
    if (model.created != null) {
      if (!Number.isFinite(model.created) || !Number.isFinite(new Date(model.created * 1000).getTime())) fail(`OpenRouter invalid created: ${model.id}`);
      publishedAt = new Date(model.created * 1000).toISOString();
    }
    return { key: model.id, title: compact(model.name), url: `https://openrouter.ai/${model.id.split('/').map(encodeURIComponent).join('/')}`, summary, publishedAt, observed: { pricing } };
  });
}
function deepseek(source, text) {
  const main = contentOf(stripNoise(text), 'main');
  const article = contentOf(main, 'article');
  const body = contentOf(article, 'div', tag => (attr(tag, 'class') ?? '').split(/\s+/).includes('theme-doc-markdown'));
  const headings = [...body.matchAll(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi)];
  const entries = [];
  let date = null, dateHadItem = true;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const title = htmlText(h[3]);
    if (h[1] === '2') {
      if (!dateHadItem) fail('DeepSeek date has no release');
      const m = title.match(/^Date:\s*(\d{4}-\d{1,2}-\d{1,2})$/i);
      if (!m) fail('DeepSeek unexpected date heading');
      date = dateOnly(m[1]); dateHadItem = false;
      continue;
    }
    if (!date || !title) fail('DeepSeek release missing date/title');
    const end = headings[i + 1]?.index ?? body.length;
    const summary = htmlText(body.slice(h.index + h[0].length, end));
    if (!summary) fail(`DeepSeek release missing body: ${title}`);
    const id = attr(`<h3 ${h[2]}>`, 'id');
    entries.push({ key: `${date}:${digest(title).slice(0, 24)}`, title, url: id ? `${source.url.split('#')[0]}#${encodeURIComponent(id)}` : source.url, summary: bound(summary), publishedAt: date, observed: { contentHash: digest(summary) } });
    dateHadItem = true;
  }
  if (!dateHadItem) fail('DeepSeek date has no release');
  return entries;
}
const markdownText = text => compact(entities(text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/[*_`#]/g, '')));
function glm(source, text) {
  if (/<(?:html|body|main)\b/i.test(text) || !/^#\s+模型与产品发布记录\s*$/m.test(text)) fail('GLM unexpected Markdown document');
  const clean = text.replace(/\r\n?/g, '\n').replace(/^This documentation is built and hosted on \[Mintlify\][\s\S]*$/m, '');
  const dates = [...clean.matchAll(/^(?:\*\*(\d{4}-\d{1,2}-\d{1,2})\*\*|#{2,4}\s+(\d{4}-\d{1,2}-\d{1,2}))\s*$/gm)];
  return dates.map((m, i) => {
    const date = dateOnly(m[1] ?? m[2]);
    const block = clean.slice(m.index + m[0].length, dates[i + 1]?.index ?? clean.length).trim();
    const lines = block.split('\n');
    const title = markdownText(lines.shift() ?? '');
    const summary = markdownText(lines.join('\n'));
    if (!title || !summary) fail('GLM release missing title/body');
    // One date/title announcement can describe several products; retain its whole
    // factual body (bounded), rather than dropping products after the first link.
    return { key: `${date}:${digest(title).slice(0, 24)}`, title, url: source.url, summary: bound(`${title} ${summary}`), publishedAt: date, observed: { contentHash: digest(`${title} ${summary}`) } };
  });
}

/** Pure parser. Caller owns HTTP/status/size/timeouts and fingerprints all fields
 * except time, including observed.pricing (never only the abbreviated description).
 * Any malformed item invalidates the whole snapshot: don't interpret it as deletion.
 */
export function parseFeedSource(source, text) {
  if (!record(source) || typeof source.url !== 'string' || !/^https:\/\//.test(source.url)) fail('invalid source');
  if (typeof text !== 'string' || !text.trim()) fail('missing response body');
  const parser = { openrouter, deepseek, glm }[source.kind];
  if (typeof parser !== 'function') fail('unsupported kind');
  const entries = parser(source, text);
  if (!entries.length) fail(`${source.kind}: no release entries`);
  const keys = new Set();
  for (const entry of entries) {
    if (keys.has(entry.key)) fail(`${source.kind}: duplicate entry key ${entry.key}`);
    keys.add(entry.key);
  }
  return entries; // No latest-date filtering: backdated/newly inserted entries matter.
}
