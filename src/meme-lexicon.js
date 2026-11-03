/**
 * **群聊语用小词典**（2026-11-03，T3）。
 *
 * ## 它解决什么
 *
 * 「扎啤」被当成啤酒、「绷不住」被当成真崩溃 —— 角色不是笨，是**没有这个群的语用常识**。
 * 靠加大模型提示词治不了（她会把解释念出来），靠全局字符串替换更不行（"来两扎啤"会变成骂人）。
 *
 * 所以做成一份**人工维护、可解释、可回滚**的小词库：
 *   · 只在她真碰到那个词时注入一小块"听得懂"的事实（不是命令、不是台词）；
 *   · 命中还要看语境（`when`），并支持**反例**（`antiExamples` 直接不注入）；
 *   · 缺文件/坏文件 = 空词库，**不影响启动**（与复制粘贴梗库同一条契约）。
 *
 * ## 为什么读 `content/` 而不是工作区
 *
 * 词库是"这个群/这类群"的语言事实，不是某个角色的设定；放 C 区 `content/meme-lexicon.json`
 * 就能走既有 `deploy-runtime` 的 C 区覆盖，一次部署两只 bot 都拿到，不必两份角色仓各放一份。
 *
 * ## 不做什么
 *
 * 不生成台词、不要求解释词义、不替她决定要不要接梗 —— 那仍然是角色卡 + 模型的事。
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEXICON_FILE = 'meme-lexicon.json';
const MAX_ENTRIES = 200;
const MAX_TEXT = 240;
const SCHEMA_VERSION = 1;

const isText = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TEXT;
const isKeys = (v) => Array.isArray(v) && v.length > 0 && v.length <= 8
  && v.every((k) => typeof k === 'string' && k.trim().length >= 2 && k.length <= 24);

/**
 * 校验并规范化一份词库。**不合规的整条丢掉**（不截断、不改写），返回丢弃计数。
 *
 * @param {object} raw
 * @returns {{entries: object[], dropped: number}}
 */
export function validateLexicon(raw) {
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  const seen = new Set();
  const entries = [];
  let dropped = 0;
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const okId = /^[a-z0-9][a-z0-9-]{1,40}$/.test(id) && !seen.has(id);
    const senses = Array.isArray(item?.senses) ? item.senses : [];
    const okSenses = senses.length > 0 && senses.length <= 5 && senses.every((s) => {
      if (!isText(s?.sense)) return false;
      if (s.when !== undefined && !(Array.isArray(s.when) && s.when.length <= 10 && s.when.every((w) => typeof w === 'string' && w.length <= 24))) return false;
      if (s.priority !== undefined && !(Number.isSafeInteger(s.priority) && s.priority >= 0 && s.priority <= 1000)) return false;
      if (s.scope !== undefined && !isText(s.scope)) return false;
      return true;
    });
    const okAnti = item?.antiExamples === undefined
      || (Array.isArray(item.antiExamples) && item.antiExamples.length <= 10 && item.antiExamples.every((w) => typeof w === 'string' && w.length <= 60));
    if (!okId || !isKeys(item?.keys) || !okSenses || !okAnti) { dropped += 1; continue; }
    seen.add(id);
    entries.push({
      id,
      keys: item.keys.map((k) => k.trim()),
      senses: senses.map((s) => ({
        sense: s.sense.trim(),
        when: Array.isArray(s.when) ? s.when.map((w) => w.trim()) : [],
        priority: Number.isSafeInteger(s.priority) ? s.priority : 50,
        scope: typeof s.scope === 'string' ? s.scope.trim() : null,
      })),
      antiExamples: Array.isArray(item.antiExamples) ? item.antiExamples.map((w) => w.trim()) : [],
      source: isText(item?.source) ? item.source.trim() : null,
      at: isText(item?.at) ? item.at.trim() : null,
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { entries, dropped };
}

/**
 * 读词库。**读不到不是错误**：返回空词库，这一轮就是没有语用线索。
 *
 * @param {string} dir `content/` 目录
 * @param {{log?: Console}} [options]
 * @returns {{ok: boolean, entries: object[], dropped: number, file: string, schemaVersion: number|null}}
 */
export function loadMemeLexicon(dir, { log } = {}) {
  const file = path.join(dir, LEXICON_FILE);
  const empty = { ok: false, entries: [], dropped: 0, file, schemaVersion: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err && err.code !== 'ENOENT') log?.warn?.(`语用词库读不了（${file}）：${err.message} —— 本轮没有语用线索`);
    return empty;
  }
  if (raw?.schemaVersion !== SCHEMA_VERSION) {
    log?.warn?.(`语用词库版本不对（要 ${SCHEMA_VERSION}，读到 ${raw?.schemaVersion}）—— 整个词库不启用`);
    return empty;
  }
  const { entries, dropped } = validateLexicon(raw);
  if (dropped > 0) log?.warn?.(`语用词库丢了 ${dropped} 条（结构不合规）`);
  return { ok: true, entries, dropped, file, schemaVersion: SCHEMA_VERSION };
}

/**
 * 这一轮要不要用某条词条。**纯函数**。
 *
 * 顺序：反例命中 → 不用；没有 key 命中 → 不用；多条命中取"命中 key 总长度最长"的那条。
 * 然后选义项：`when` 命中的里取 priority 最高的；都不命中时取**没有 when 的默认义项**里
 * priority 最高的；再不行取 priority 最高的。保留"不确定就按字面"的保守方向。
 *
 * @param {object[]} entries
 * @param {string} text 这一轮用户原话
 * @returns {{entry: object, sense: object, matchedKeys: string[], matchedWhen: string[]}|null}
 */
export function matchLexicon(entries, text) {
  const s = String(text ?? '');
  if (s === '' || !Array.isArray(entries) || entries.length === 0) return null;
  let best = null;
  for (const entry of entries) {
    if (entry.antiExamples.some((w) => w !== '' && s.includes(w))) continue;
    const matchedKeys = entry.keys.filter((k) => s.includes(k));
    if (matchedKeys.length === 0) continue;
    const score = matchedKeys.reduce((a, k) => a + k.length, 0);
    if (best !== null && best.score >= score) continue;
    // 容忍未走 validateLexicon 的裸词条（测试/旧文件）：缺 when 就当空数组，不炸。
    const senses = (entry.senses ?? []).map((x) => ({ ...x, when: Array.isArray(x.when) ? x.when : [] }));
    const withWhen = senses.filter((x) => x.when.length > 0 && x.when.some((w) => s.includes(w)));
    const defaults = senses.filter((x) => x.when.length === 0);
    const byPriority = (a, b) => (b.priority ?? 0) - (a.priority ?? 0);
    const pool = withWhen.length > 0 ? withWhen : defaults.length > 0 ? defaults : senses;
    const sense = [...pool].sort(byPriority)[0];
    if (!sense) continue;
    const matchedWhen = sense.when.filter((w) => s.includes(w));
    best = { entry, sense, matchedKeys, matchedWhen, score };
  }
  return best === null ? null : { entry: best.entry, sense: best.sense, matchedKeys: best.matchedKeys, matchedWhen: best.matchedWhen };
}

/**
 * 把命中结果变成一小块**事实**（走注入块，不是命令）。
 *
 * 三条纪律：① 明说"别念出来、别解释"；② 说明它**不是**定论（打趣/谐音）；③ 给出字面备选，
 * 让模型自己按语境判 —— 词库不替她做决定。
 */
export function lexiconNote(hit) {
  if (!hit?.entry || !hit?.sense) return '';
  const term = hit.matchedKeys[0];
  const scope = hit.sense.scope ? `（常见于${hit.sense.scope}）` : '';
  const matchedByContext = Array.isArray(hit.matchedWhen) && hit.matchedWhen.length > 0;
  // 语境已经命中：直接把这一轮按那个意思读，不再给"按字面"的备选（否则模型会两边都选）。
  if (matchedByContext) {
    return [
      `群里的说法（只是让你听得懂，别念出来、也别解释词义）：这一轮的「${term}」是在打趣，按「${hit.sense.sense}」理解${scope}。`,
      '顺着这个意思接话就行，别科普、也别问"什么意思"。',
    ].join('\n');
  }
  // 没有语境证据：保守给候选 + 字面备选，让模型自己判。
  const literal = hit.entry.senses.find((x) => x !== hit.sense && /字面/.test(x.sense));
  return [
    `群里的说法（只是让你听得懂，别念出来、也别解释词义）：「${term}」在这里可能指「${hit.sense.sense}」${scope}。`,
    literal ? `如果这一轮明显是在说${literal.sense.split('（')[0]}那种意思，就按字面理解。` : '',
    '不确定时顺着语境接话即可，不要反问"这是什么意思"，也不要科普。',
  ].filter(Boolean).join('\n');
}
