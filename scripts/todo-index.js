/**
 * 待办索引 —— 把 `TODO.md` 建成一个**可查询**的 SQLite 库。
 *
 * `TODO.md` 是唯一的真相;这个库是**可再生的派生数据**(见 D35)。
 * 删掉它、重建一次,什么都不会丢 —— 这正是它不会腐烂的原因。
 *
 * 用法:
 *   node scripts\todo-index.js                    # 重建 + 概览
 *   node scripts\todo-index.js --unverified       # 只列「★★★ 还没验证」
 *   node scripts\todo-index.js --doing            # 只列「进行中」
 *   node scripts\todo-index.js --section 运维      # 按分区过滤
 *   node scripts\todo-index.js --sql "SELECT ..." # 任意查询(这就是"能查"的意义)
 *   node scripts\todo-index.js --path             # 打印索引库路径
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { TODO_INDEX_VERSION, TODO_SCHEMA, formatItem, parseTodo, todoStats } from '../src/todo-index.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODO_FILE = path.join(ROOT_DIR, 'TODO.md');
const INDEX_FILE = path.join(ROOT_DIR, 'data', 'index', 'todo.db');

const out = (line = '') => process.stdout.write(`${line}\n`);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const source = fs.readFileSync(TODO_FILE, 'utf8');
const { items } = parseTodo(source);

// ---------------------------------------------------------------------------
// 重建(每次跑都重建 —— 它便宜,而且"索引新鲜"比"省一次写"重要得多)
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
const db = new DatabaseSync(INDEX_FILE);
db.exec(TODO_SCHEMA);

// `node:sqlite` 的 DatabaseSync **没有** `better-sqlite3` 那个 `db.transaction()`,
// 所以老老实实写 BEGIN / COMMIT / ROLLBACK(和 `src/sqlite-store.js` 一样的写法)。
db.exec('BEGIN');
try {
  db.exec('DELETE FROM item');
  const insert = db.prepare(
    `INSERT INTO item (section, ordinal, title, priority, status, unverified, line, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of items) {
    insert.run(
      item.section,
      item.ordinal,
      item.title,
      item.priority,
      item.status,
      item.unverified ? 1 : 0,
      item.line,
      item.body,
    );
  }
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  meta.run('index_version', String(TODO_INDEX_VERSION));
  meta.run('built_at', new Date().toISOString());
  meta.run('source', 'TODO.md');
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

// ---------------------------------------------------------------------------
// 只打印路径(给脚本用)
// ---------------------------------------------------------------------------
if (flag('--path')) {
  out(INDEX_FILE);
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 任意查询
// ---------------------------------------------------------------------------
const sql = valueOf('--sql');
if (sql) {
  if (!/^\s*select\b/i.test(sql)) {
    process.stderr.write('--sql 只允许 SELECT(这是只读索引,不指望你往里写)\n');
    process.exit(1);
  }
  const rows = db.prepare(sql).all();
  out(`${rows.length} 行`);
  for (const row of rows) out(JSON.stringify(row));
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 预置查询
// ---------------------------------------------------------------------------
const stats = todoStats(items);

if (flag('--unverified')) {
  const rows = db.prepare('SELECT * FROM item WHERE unverified = 1 ORDER BY priority DESC, ordinal').all();
  out(`★★★ 还没验证的 ${rows.length} 条:`);
  for (const row of rows) out(`  ${formatItem(toItem(row))}`);
  if (rows.length > 0) out('\n（TODO.md 顶部的约定:★★★ = 还没验证过。验证完请把它降级或删掉。）');
  db.close();
  process.exit(0);
}

if (flag('--doing')) {
  const rows = db.prepare("SELECT * FROM item WHERE status = 'doing' ORDER BY priority DESC, ordinal").all();
  out(`进行中 ${rows.length} 条:`);
  for (const row of rows) out(`  ${formatItem(toItem(row))}`);
  db.close();
  process.exit(0);
}

const section = valueOf('--section');
if (section) {
  const rows = db.prepare('SELECT * FROM item WHERE section LIKE ? ORDER BY ordinal').all(`%${section}%`);
  out(`分区含「${section}」的 ${rows.length} 条:`);
  for (const row of rows) out(`  ${formatItem(toItem(row))}`);
  db.close();
  process.exit(0);
}

out();
out(`TODO.md 解析出 ${stats.total} 条 —— 索引:${path.relative(ROOT_DIR, INDEX_FILE)}`);
out();
out('按分区:');
for (const row of stats.bySection) out(`  ${String(row.count).padStart(3)}  ${row.section}`);
out();
out('按优先级:');
for (const row of stats.byPriority) {
  const label = row.priority === 0 ? '未标星' : '★'.repeat(row.priority) + '☆'.repeat(3 - row.priority);
  out(`  ${String(row.count).padStart(3)}  ${label}`);
}
out();
out(`进行中 ${stats.doing} 条 ｜ ★★★ 还没验证 ${stats.unverified} 条`);
if (stats.unverified > 0) {
  out();
  out('⚠️ 还没验证的:');
  for (const item of items.filter((row) => row.unverified)) out(`  ${formatItem(item)}`);
}
out();
out('查询示例:');
out('  node scripts\\todo-index.js --unverified');
out('  node scripts\\todo-index.js --doing');
out('  node scripts\\todo-index.js --section 运维');
out("  node scripts\\todo-index.js --sql \"SELECT section, count(*) n FROM item GROUP BY section ORDER BY n DESC\"");
out();
out('（TODO.md 是真相;这个库是可再生的派生数据 —— 删掉重建即可。）');
db.close();

/** DB 行 → `formatItem` 要的形状。 */
function toItem(row) {
  return { title: row.title, priority: row.priority, section: row.section, line: row.line };
}
