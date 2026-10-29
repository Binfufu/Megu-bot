/**
 * **卡库索引**（A 刀；2026-10-13）。
 *
 * 分工（这是刻意的，别混）：
 *   · `src\dream-cards.js` = **纯函数内核** —— 字节 → 卡记录。不读盘、不写盘。
 *   · `src\dream-index.js` = **索引形状 + 合并规则** —— 怎么把 N 条卡记录落成一个库、
 *     怎么增量更新、怎么检索。**同样不读盘不写盘**（只认字符串与数组）。
 *   · `scripts\dream-index.js` = **唯一碰盘的地方** —— 扫目录、写 `data\cards\index.jsonl`。
 *
 * ⚠️ **为什么库文件是 JSONL 而不是 SQLite**（这一条要想清楚再改）：
 *   ① 卡库是**只读资产**（重建一次，之后只查），没有并发写、没有事务需求；
 *   ② JSONL **逐行可读**，出问题时 `Select-String` 一条就看见全文，而 SQLite 要工具；
 *   ③ 7000 行 ≈ 6~8 MB，`JSON.parse` 一次 100ms 级，比开库还快；
 *   ④ 它**可删可重建**（`data/` 整个不进版本库），坏了没有任何损失。
 *   ⇒ 什么时候该换 SQLite：出现"多人同时写卡"或"要按关系跨表联查"的时候，不是现在。
 *
 * ⚠️ **`index.jsonl` 的行序不稳定**（按目录遍历顺序），所以任何"第 N 条"的说法都不可信 ——
 *   要定位就用 `id`（`cardId(path)` 派生）。这一条我特意写下来，因为"看着是 A、重扫变成 B"
 *   这种毛病只有一句话的距离。
 */
import { cardId, INDEX_VERSION, KIND, searchCards, summarizeLibrary } from './dream-cards.js';

/** 一行索引 → 一个对象。坏行返回 `null`（**不许让一行坏数据带走整个库**）。 */
export function parseIndexLine(line) {
  const text = String(line ?? '').trim();
  if (text === '') return null;
  try {
    const value = JSON.parse(text);
    // ⚠️ `Array.isArray` 这一条不能省：JSONL 的第一行如果是 `[]`（或有人手工写了个数组），
    //    `typeof [] === 'object'` 会放它进来，于是记录数组里混进一个**数组**，
    //    下游 `record.id` 是 undefined → 所有卡共用一个 undefined id → 静默并成一张。
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 库文件正文 → 记录数组 + 统计。
 *
 * @param {string} text
 * @returns {{records:object[], skipped:number, version:number|null}}
 */
export function parseIndex(text) {
  const records = [];
  let skipped = 0;
  let version = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const record = parseIndexLine(line);
    if (!record) {
      skipped += 1;
      continue;
    }
    if (record.$index === 'header') {
      version = Number(record.version) || null;
      continue;
    }
    records.push(record);
  }
  return { records, skipped, version };
}

/** 库里第一行是**头**（版本 + 生成时间 + 来源根）—— 版本对不上要能一眼看见。 */
export function indexHeader({ generatedAt = null, roots = [] } = {}) {
  return { $index: 'header', version: INDEX_VERSION, generatedAt, roots };
}

/** 记录数组 → 库文件正文。`\n` 结尾（POSIX 友好的那点小体面）。 */
export function serializeIndex(records, { generatedAt = null, roots = [] } = {}) {
  const lines = [JSON.stringify(indexHeader({ generatedAt, roots }))];
  for (const record of records) lines.push(JSON.stringify(record));
  return `${lines.join('\n')}\n`;
}

/**
 * **增量合并**：新扫到的记录覆盖旧的，没扫到的（别的根、别的批）原样留着。
 *
 * 为什么需要：卡库有 7000+ 张、跨 3 个根目录。每次全扫要几十秒，
 * 而"只扫改过的文件"要能留下**没变的那些**——这就是"合并"而不是"替换"。
 *
 * @param {object[]} existing
 * @param {object[]} incoming
 * @returns {{records:object[], added:number, updated:number, kept:number}}
 */
export function mergeRecords(existing, incoming) {
  const byId = new Map();
  for (const record of existing) byId.set(record.id ?? cardId(record.path), record);
  let added = 0;
  let updated = 0;
  for (const record of incoming) {
    const id = record.id ?? cardId(record.path);
    const key = id;
    if (byId.has(key)) updated += 1;
    else added += 1;
    byId.set(key, { ...record, id });
  }
  return { records: [...byId.values()], added, updated, kept: existing.length };
}

/**
 * 哪些文件需要重扫？
 *
 * 规则只有两条：**没见过**，或 **mtime 变了**（或大小变了）。
 * ⚠️ 不比对内容哈希：7000 个文件的 sha256 是几十秒的纯浪费，而卡库不是高安全资产。
 *
 * @param {object[]} existing
 * @param {{path:string, mtimeMs:number|null, size:number|null}[]} candidates
 */
export function staleCandidates(existing, candidates) {
  const byPath = new Map();
  for (const record of existing) byPath.set(record.path, record);
  const stale = [];
  for (const candidate of candidates) {
    const known = byPath.get(candidate.path);
    if (!known) {
      stale.push(candidate);
      continue;
    }
    if (candidate.mtimeMs != null && known.mtimeMs != null && candidate.mtimeMs !== known.mtimeMs) {
      stale.push(candidate);
      continue;
    }
    if (candidate.size != null && known.bytes != null && candidate.size !== known.bytes) {
      stale.push(candidate);
    }
  }
  return stale;
}

/** 按 id 取一条。 */
export function recordById(records, id) {
  const key = String(id ?? '');
  return records.find((record) => record.id === key) ?? null;
}

/**
 * 检索 + 过滤 + 分页。**纯数组操作**（真正的打分在 `searchCards`）。
 *
 * @param {object[]} records
 * @param {{text?:string, kind?:string, hasBook?:boolean, tag?:string, limit?:number, offset?:number}} [query]
 */
export function queryCards(records, { text = '', kind = '', hasBook = false, tag = '', limit = 50, offset = 0 } = {}) {
  let pool = records;
  if (tag) {
    const needle = String(tag).toLowerCase();
    pool = pool.filter((record) => (record.tags ?? []).some((t) => String(t).toLowerCase() === needle));
  }
  const matched = searchCards(pool, { text, kind, hasBook, limit: Number.MAX_SAFE_INTEGER });
  return {
    total: matched.length,
    limit,
    offset,
    items: matched.slice(offset, offset + limit),
  };
}

/**
 * 库的**体检报告** —— `scan` 完必须打一遍。
 *
 * 判据全在数字里：`raw`（认不出来的文件）和 `byKind` 对不对得上"我们以为的卡库形状"。
 * 对不上就是解析器有洞，而不是"卡太乱了"。
 *
 * ⚠️ **`unreadable` 只有条数是不够的**（我第一版就只给了条数，103 这个数字当时没法解释）。
 * 这 103 个里绝大多数**根本不是卡**：酒馆的预设（preset）、正则脚本（regex）、
 * 表格（dataTable）、JSON 补丁 —— 它们出现在卡库里是正常的，认不出来也**不是 bug**。
 * 所以这里按文件名特征把它们分桶，`scan` 时能直接打出来给人看。
 */
export function healthReport(records, { filesScanned = 0, unreadable = 0, unreadableFiles = [] } = {}) {
  const stats = summarizeLibrary(records);
  return {
    ...stats,
    filesScanned,
    unreadable,
    unreadableBuckets: bucketUnreadable(unreadableFiles),
    coverage: filesScanned > 0 ? Math.round((records.length / filesScanned) * 1000) / 10 : 0,
    emptyShells: records.filter((r) => r.sizes?.total === 0).length,
    generators: records.filter((r) => r.kind === KIND.generator).length,
    approxTokensTotal: records.reduce((sum, r) => sum + (r.book?.tokens ?? 0), 0),
    // 类型判定的"人说了算"那一层有多少条在用 —— 数字为 0 时要能一眼看出来
    forcedByDir: records.filter((r) => r.warnings?.includes('by_dir')).length,
  };
}

/**
 * 认不出来的文件按**文件名特征**分桶。
 *
 * 顺序有讲究：先判"明显是别的东西"（预设/正则/表格），最后才是"真的不认识"。
 * ⚠️ 只有 `unknown` 那一桶值得去看 —— 其它几桶是**卡库里本来就该有的非卡文件**。
 */
export function bucketUnreadable(files) {
  const buckets = {};
  const patterns = [
    ['preset', /预设|preset/i],
    ['regex', /正则|regex/i],
    ['table', /表格|dataTable/i],
    ['patch', /隐藏|删除|去除|cot/i],
    ['worldbook_json', /世界书.*\.json$/i],
    ['empty', /\.json$/i],
  ];
  for (const file of files) {
    const name = String(file ?? '');
    let hit = 'unknown';
    for (const [key, pattern] of patterns) {
      if (pattern.test(name)) {
        hit = key;
        break;
      }
    }
    buckets[hit] = (buckets[hit] ?? 0) + 1;
  }
  return buckets;
}

export { INDEX_VERSION, KIND };
