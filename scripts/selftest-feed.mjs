import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const tmpdir = () => fileURLToPath(new URL('../data/index/', import.meta.url));
mkdirSync(tmpdir(), { recursive: true });
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFeedStore, nextAlignedCheck } from '../src/feed.js';
import { FIXED_FEED_SOURCES } from '../src/feed-sources.js';
import { createFeedNews, feedNewsSnippet, mapFeedNewsRows } from '../src/feed-news.js';

const source = { id: 'news', name: 'News', headers: { Authorization: 'SECRET-NEVER-EXPORT' } };
const item = (key = 'a', title = 'Title', extra = {}) => ({ key, title, url: `https://example.org/${key}`, summary: 'Extracted from source text', publishedAt: null, ...extra });
function fixture(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-feed-selftest-'));
  const dbPath = join(directory, 'authoritative.sqlite');
  let store = openFeedStore(dbPath);
  try { fn({ directory, dbPath, get store() { return store; }, reopen() { store.close(); store = openFeedStore(dbPath); return store; } }); }
  finally {
    store.close();
    // Only delete the exact temporary directory this fixture created, after verifying scope.
    assert.equal(resolve(directory), directory);
    assert.ok(directory.startsWith(join(tmpdir(), 'qqbot-feed-selftest-')));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('first nonempty successful sample establishes baseline, never historical inbox', () => fixture(({ store }) => {
  assert.deepEqual(store.applySnapshot(source, [item(), item('b')], { now: 1, etag: 'v1', lastModified: 'yesterday' }), { baseline: true, inserted: 0, coalesced: 0, suppressed: 0, count: 2 });
  assert.deepEqual(store.listInbox(), []);
  assert.equal(store.sourceState(source.id).baseline, true);
  assert.equal(store.sourceState(source.id).lastSuccessAt, 1);
}));

test('new and fact-updated items have required public inbox fields', () => fixture(({ store }) => {
  store.applySnapshot(source, [item()], { now: 1 });
  assert.equal(store.applySnapshot(source, [item('a', 'Changed'), item('b')], { now: 2 }).inserted, 2);
  const rows = store.listInbox();
  assert.deepEqual(rows.map(r => r.type).sort(), ['new', 'updated']);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id','sourceId','sourceName','key','type','title','url','summary','publishedAt','detectedAt'].sort());
    assert.match(row.id, /^[a-f0-9]{64}$/);
    assert.equal(row.sourceName, 'News'); assert.equal(row.detectedAt, 2);
    assert.equal(row.summary, 'Extracted from source text');
  }
}));

test('close/reopen preserves baseline, stable IDs and duplicate suppression', () => fixture(f => {
  f.store.applySnapshot(source, [item()], { now: 1 });
  f.store.applySnapshot(source, [item('b')], { now: 2 });
  const before = f.store.listInbox();
  f.reopen();
  assert.equal(f.store.applySnapshot(source, [item('b')], { now: 3 }).inserted, 0);
  assert.deepEqual(f.store.listInbox(), before);
}));

test('missing old entries never delete baseline or manufacture removal', () => fixture(({ store }) => {
  store.applySnapshot(source, [item(), item('b')]);
  store.applySnapshot(source, [item('b')]);
  assert.equal(store.status().itemCount, 2);
  assert.equal(store.applySnapshot(source, [item()]).inserted, 0);
  assert.equal(store.status().inboxCount, 0);
}));

test('A baseline -> B -> A produces each post-baseline fingerprint only once', () => fixture(({ store }) => {
  store.applySnapshot(source, [item()]);
  for (const title of ['B', 'Title', 'B', 'Title']) store.applySnapshot(source, [item('a', title)]);
  assert.equal(store.listInbox().length, 2);
}));

test('coalesce window updates one inbox row in place with the latest content', () => fixture(({ store, dbPath }) => {
  const coalesceMs = 1000;
  store.applySnapshot(source, [item('a', 'Base', { summary: 'base' })], { now: 100 });
  const first = store.applySnapshot(source, [item('a', 'V1', { summary: 'v1' })], { now: 200, coalesceMs });
  assert.deepEqual({ inserted: first.inserted, coalesced: first.coalesced }, { inserted: 1, coalesced: 0 });
  const [row] = store.listInbox();
  assert.deepEqual({ type: row.type, detectedAt: row.detectedAt, title: row.title }, { type: 'updated', detectedAt: 200, title: 'V1' });
  const second = store.applySnapshot(source, [item('a', 'V2', { summary: 'v2' })], { now: 400, coalesceMs });
  const third = store.applySnapshot(source, [item('a', 'V3', { summary: 'v3', url: 'https://example.org/a-v3', publishedAt: '2026-01-02' })], { now: 600, coalesceMs });
  assert.deepEqual({ inserted: second.inserted, coalesced: second.coalesced }, { inserted: 0, coalesced: 1 });
  assert.deepEqual({ inserted: third.inserted, coalesced: third.coalesced }, { inserted: 0, coalesced: 1 });
  const rows = store.listInbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, row.id);
  assert.equal(rows[0].detectedAt, 200);
  assert.equal(rows[0].type, 'updated');
  assert.deepEqual([rows[0].title, rows[0].summary, rows[0].url, rows[0].publishedAt], ['V3', 'v3', 'https://example.org/a-v3', '2026-01-02']);
  assert.equal(store.latestItems(source.id)[0].title, 'V3');
  // feed_items follows every sample; inbox fingerprint agrees with the newest one.
  const probe = new DatabaseSync(dbPath);
  try {
    const inboxFingerprint = probe.prepare('SELECT fingerprint FROM feed_inbox WHERE id=?').get(row.id).fingerprint;
    const itemFingerprint = probe.prepare('SELECT fingerprint FROM feed_items WHERE sourceId=? AND key=?').get(source.id, 'a').fingerprint;
    assert.equal(inboxFingerprint, itemFingerprint);
  } finally { probe.close(); }
  // A later change is still detected once the row's own window has expired.
  const fourth = store.applySnapshot(source, [item('a', 'V4')], { now: 1601, coalesceMs });
  assert.deepEqual({ inserted: fourth.inserted, coalesced: fourth.coalesced }, { inserted: 1, coalesced: 0 });
  assert.deepEqual(store.listInbox().map(r => r.title), ['V3', 'V4']);
}));

test('coalesce window boundary is inclusive; outside starts a second row', () => fixture(({ store }) => {
  const coalesceMs = 1000;
  store.applySnapshot(source, [item('a', 'Base')], { now: 100 });
  store.applySnapshot(source, [item('a', 'V1')], { now: 200, coalesceMs });
  const boundary = store.applySnapshot(source, [item('a', 'V2')], { now: 1200, coalesceMs });
  assert.deepEqual({ inserted: boundary.inserted, coalesced: boundary.coalesced }, { inserted: 0, coalesced: 1 });
  assert.equal(store.listInbox().length, 1);
  const outside = store.applySnapshot(source, [item('a', 'V3')], { now: 1201, coalesceMs });
  assert.deepEqual({ inserted: outside.inserted, coalesced: outside.coalesced }, { inserted: 1, coalesced: 0 });
  assert.deepEqual(store.listInbox().map(r => r.title), ['V2', 'V3']);
  assert.deepEqual(store.listInbox().map(r => r.detectedAt), [200, 1201]);
  // The new row now owns the window; the older row is never rewritten again.
  const next = store.applySnapshot(source, [item('a', 'V4')], { now: 2200, coalesceMs });
  assert.deepEqual({ inserted: next.inserted, coalesced: next.coalesced }, { inserted: 0, coalesced: 1 });
  assert.deepEqual(store.listInbox().map(r => r.title), ['V2', 'V4']);
  assert.deepEqual(store.listInbox().map(r => r.detectedAt), [200, 1201]);
}));

test('coalesce windows are independent per source and key', () => fixture(({ store }) => {
  const coalesceMs = 1000;
  const other = { id: 'other', name: 'Other' };
  store.applySnapshot(source, [item('a', 'Base'), item('b', 'Base')], { now: 100 });
  store.applySnapshot(other, [item('a', 'Base')], { now: 100 });
  const a1 = store.applySnapshot(source, [item('a', 'V1'), item('b', 'Base')], { now: 200, coalesceMs });
  const b1 = store.applySnapshot(source, [item('a', 'V1'), item('b', 'V1')], { now: 300, coalesceMs });
  const a2 = store.applySnapshot(source, [item('a', 'V2'), item('b', 'V1')], { now: 400, coalesceMs });
  const o1 = store.applySnapshot(other, [item('a', 'V1')], { now: 400, coalesceMs });
  assert.deepEqual({ inserted: a1.inserted, coalesced: a1.coalesced }, { inserted: 1, coalesced: 0 });
  assert.deepEqual({ inserted: b1.inserted, coalesced: b1.coalesced }, { inserted: 1, coalesced: 0 });
  assert.deepEqual({ inserted: a2.inserted, coalesced: a2.coalesced }, { inserted: 0, coalesced: 1 });
  assert.deepEqual({ inserted: o1.inserted, coalesced: o1.coalesced }, { inserted: 1, coalesced: 0 });
  const rows = store.listInbox();
  assert.equal(rows.length, 3);
  const byKey = (sourceId, key) => rows.filter(r => r.sourceId === sourceId && r.key === key);
  assert.deepEqual(byKey(source.id, 'a').map(r => [r.title, r.detectedAt]), [['V2', 200]]);
  assert.deepEqual(byKey(source.id, 'b').map(r => [r.title, r.detectedAt]), [['V1', 300]]);
  assert.deepEqual(byKey(other.id, 'a').map(r => [r.title, r.detectedAt]), [['V1', 400]]);
}));

test('coalesced new-key row keeps its first type, time and id', () => fixture(({ store }) => {
  const coalesceMs = 1000;
  store.applySnapshot(source, [item('a')], { now: 100 });
  store.applySnapshot(source, [item('a'), item('b', 'New')], { now: 200, coalesceMs });
  const [row] = store.listInbox();
  assert.deepEqual([row.key, row.type, row.detectedAt], ['b', 'new', 200]);
  const result = store.applySnapshot(source, [item('a'), item('b', 'Changed')], { now: 300, coalesceMs });
  assert.deepEqual({ inserted: result.inserted, coalesced: result.coalesced }, { inserted: 0, coalesced: 1 });
  const [after] = store.listInbox();
  assert.equal(store.listInbox().length, 1);
  assert.deepEqual([after.id, after.type, after.detectedAt, after.title], [row.id, 'new', 200, 'Changed']);
}));

test('coalesce never duplicates an already delivered fingerprint (A -> B -> A)', () => fixture(({ store, dbPath }) => {
  const coalesceMs = 100;
  store.applySnapshot(source, [item('a', 'A')], { now: 100 });                       // baseline A
  store.applySnapshot(source, [item('a', 'B')], { now: 200, coalesceMs });           // row B at 200
  const back = store.applySnapshot(source, [item('a', 'A')], { now: 400, coalesceMs }); // outside B's window -> row A
  assert.deepEqual({ inserted: back.inserted, coalesced: back.coalesced }, { inserted: 1, coalesced: 0 });
  // B is already in an inbox row while A's row is inside the window: neither an
  // UPDATE (unique violation) nor a second identical B row is allowed.
  const result = store.applySnapshot(source, [item('a', 'B')], { now: 450, coalesceMs });
  assert.deepEqual({ inserted: result.inserted, coalesced: result.coalesced }, { inserted: 0, coalesced: 0 });
  const rows = store.listInbox();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.title).sort(), ['A', 'B']);
  assert.deepEqual(rows.map(r => r.detectedAt).sort(), [200, 400]);
  const probe = new DatabaseSync(dbPath);
  try { assert.equal(probe.prepare('SELECT COUNT(DISTINCT fingerprint) AS n FROM feed_inbox').get().n, 2); }
  finally { probe.close(); }
}));

test('coalesceMs=0 keeps legacy one-row-per-change behavior; invalid values change nothing', () => fixture(({ store }) => {
  store.applySnapshot(source, [item('a', 'Base')], { now: 100 });
  for (const [now, title] of [[200, 'V1'], [300, 'V2'], [400, 'V3']]) {
    const result = store.applySnapshot(source, [item('a', title)], { now, coalesceMs: 0 });
    assert.deepEqual({ inserted: result.inserted, coalesced: result.coalesced }, { inserted: 1, coalesced: 0 });
  }
  assert.deepEqual(store.listInbox().map(r => r.detectedAt), [200, 300, 400]);
  assert.deepEqual(store.listInbox().map(r => r.title), ['V1', 'V2', 'V3']);
  const before = store.status();
  for (const bad of [-1, 0.5, Infinity, NaN, '1000', null]) {
    assert.throws(() => store.applySnapshot(source, [item('a', 'V4')], { now: 500, coalesceMs: bad }), /coalesceMs/);
  }
  assert.deepEqual(store.status(), before);
}));

test('repeated identical apply never recounts or moves detectedAt', () => fixture(({ store }) => {
  const coalesceMs = 1000;
  store.applySnapshot(source, [item('a', 'Base')], { now: 100 });
  store.applySnapshot(source, [item('a', 'V1')], { now: 200, coalesceMs });
  const snapshot = [item('a', 'V2')];
  const first = store.applySnapshot(source, snapshot, { now: 300, coalesceMs });
  assert.deepEqual({ inserted: first.inserted, coalesced: first.coalesced }, { inserted: 0, coalesced: 1 });
  const afterFirst = store.listInbox();
  assert.deepEqual([afterFirst.length, afterFirst[0].title, afterFirst[0].detectedAt], [1, 'V2', 200]);
  for (const now of [300, 400]) {
    const repeat = store.applySnapshot(source, snapshot, { now, coalesceMs });
    assert.deepEqual({ inserted: repeat.inserted, coalesced: repeat.coalesced }, { inserted: 0, coalesced: 0 });
    assert.deepEqual(store.listInbox(), afterFirst);
  }
}));

test('fixed sources opt into the provisional 1h coalesce window', () => {
  assert.equal(FIXED_FEED_SOURCES.length, 3);
  assert.ok(FIXED_FEED_SOURCES.every(s => s.coalesceMs === 3_600_000));
});

test('fixed sources cap same-key inbox messages at 10 per Beijing day (owner 2026-11-04)', () => {
  assert.ok(FIXED_FEED_SOURCES.every(s => s.maxInboxPerKeyPerDay === 10));
});

test('observed facts canonicalize object keys; changed fact detected, never exported', () => fixture(({ store }) => {
  store.applySnapshot(source, [item('a', 'Title', { observed: { price: 1, nested: { b: 2, a: 1 } } })]);
  assert.equal(store.applySnapshot(source, [item('a', 'Title', { observed: { nested: { a: 1, b: 2 }, price: 1 } })]).inserted, 0);
  assert.equal(store.applySnapshot(source, [item('a', 'Title', { observed: { price: 2 } })]).inserted, 1);
  assert.equal('observed' in store.listInbox()[0], false);
}));

test('invalid samples never advance source state, validators or baseline', () => fixture(({ store }) => {
  assert.throws(() => store.applySnapshot(source, []));
  assert.equal(store.sourceState(source.id), null);
  store.applySnapshot(source, [item()], { now: 1, etag: 'good' });
  const before = store.status();
  const cyclic = {}; cyclic.self = cyclic;
  for (const sample of [[], [item(), item()], [item('b'), item('c', '')], [item('x', 'x', { observed: cyclic })], [item('x', 'x', { publishedAt: 'bad' })]]) {
    assert.throws(() => store.applySnapshot(source, sample, { now: 99, etag: 'bad' }));
    assert.deepEqual(store.status(), before);
  }
}));

test('real SQLite trigger abort rolls back earlier inbox, item and state writes', () => fixture(({ store, dbPath }) => {
  store.applySnapshot(source, [item()], { now: 1, etag: 'good' });
  const before = store.status();
  const probe = new DatabaseSync(dbPath);
  try {
    probe.exec(`CREATE TRIGGER selftest_abort BEFORE INSERT ON feed_items WHEN NEW.key='explode'
      BEGIN SELECT RAISE(ABORT,'injected transaction failure'); END`);
    assert.throws(() => store.applySnapshot(source, [item('new'), item('explode')], { now: 9, etag: 'bad' }), /injected transaction failure/);
    assert.deepEqual(store.status(), before);
    probe.exec('DROP TRIGGER selftest_abort');
    assert.equal(store.applySnapshot(source, [item('new')], { now: 10 }).inserted, 1);
  } finally { probe.close(); }
}));

test('same key across sources has independent baseline and inbox uniqueness', () => fixture(({ store }) => {
  const other = { id: 'other', name: 'Other' };
  for (const s of [source, other]) { store.applySnapshot(s, [item()]); store.applySnapshot(s, [item('a', 'Changed')]); }
  assert.equal(new Set(store.listInbox().map(r => r.id)).size, 2);
  assert.equal(store.status().itemCount, 2);
}));

test('304 without baseline rejects, including source with previous failure', () => fixture(({ store }) => {
  assert.throws(() => store.recordNotModified(source), /baseline/);
  assert.equal(store.sourceState(source.id), null);
  store.recordFailure(source, { now: 1, error: 'bad sample', retryAt: 10 });
  const before = store.status();
  assert.throws(() => store.recordNotModified(source, { now: 2 }), /baseline/);
  assert.deepEqual(store.status(), before);
}));

test('failure state preserves validators/baseline; success and 304 reset failure', () => fixture(({ store }) => {
  store.applySnapshot(source, [item()], { now: 1, etag: 'e1', lastModified: 'lm1' });
  store.recordFailure(source, { now: 2, error: new Error('offline'), retryAt: 20 });
  store.recordFailure(source, { now: 3, error: 'still offline', retryAt: 30 });
  let state = store.sourceState(source.id);
  assert.equal(state.consecutiveFailures, 2); assert.equal(state.lastCheckAt, 3);
  assert.equal(state.lastSuccessAt, 1); assert.equal(state.etag, 'e1'); assert.equal(state.retryAt, 30);
  state = store.recordNotModified(source, { now: 4, etag: 'e2' });
  assert.equal(state.etag, 'e2'); assert.equal(state.lastModified, 'lm1');
  assert.equal(state.lastSuccessAt, 4); assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.error, null); assert.equal(state.retryAt, null);
  store.applySnapshot(source, [item()], { now: 5 });
  assert.equal(store.sourceState(source.id).etag, null);
}));

test('file export is idempotent, reconstructs missing/corrupt projections after reopen', () => fixture(f => {
  f.store.applySnapshot(source, [item()]);
  f.store.applySnapshot(source, [item('b'), item('a', 'Changed')]);
  const output = join(f.directory, 'inbox');
  assert.equal(f.store.exportInbox(output).exported, 2);
  const names = readdirSync(output).sort();
  const contents = names.map(n => readFileSync(join(output, n), 'utf8'));
  f.store.exportInbox(output);
  assert.deepEqual(readdirSync(output).sort(), names);
  assert.deepEqual(names.map(n => readFileSync(join(output, n), 'utf8')), contents);
  assert.ok(contents.every(c => !c.includes('SECRET-NEVER-EXPORT') && !c.includes('Authorization')));
  writeFileSync(join(output, names[0]), 'corrupt');
  const missing = join(f.directory, 'fresh-projection');
  f.reopen(); f.store.exportInbox(output); f.store.exportInbox(missing);
  assert.deepEqual(names.map(n => readFileSync(join(output, n), 'utf8')), contents);
  assert.deepEqual(readdirSync(missing).sort(), names);
}));

test('failed export never loses authoritative inbox; retry repairs partial export', () => fixture(({ store, directory }) => {
  store.applySnapshot(source, [item()]); store.applySnapshot(source, [item('b')]);
  const output = join(directory, 'blocked'); mkdirSync(output);
  const id = store.listInbox()[0].id;
  mkdirSync(join(output, `${id}.json`));
  assert.throws(() => store.exportInbox(output));
  assert.equal(store.status().inboxCount, 1);
  assert.deepEqual(readdirSync(output), [`${id}.json`]);
  assert.equal(store.exportInbox(join(directory, 'recovered')).exported, 1);
}));

test('explicit persistent DB/export paths and public credential-free URLs required', () => fixture(({ store }) => {
  assert.throws(() => openFeedStore(':memory:'));
  assert.throws(() => openFeedStore('relative.sqlite'));
  for (const directory of [undefined, '', '.', 'relative']) assert.throws(() => store.exportInbox(directory));
  for (const url of ['file:///x', 'https://user:password@example.org/', 'https://example.org/?api_key=secret']) {
    assert.throws(() => store.applySnapshot(source, [item('a', 't', { url })]));
  }
  assert.equal(store.sourceState(source.id), null);
}));

test('inbox limit and unknown source state are explicit', () => fixture(({ store }) => {
  assert.equal(store.sourceState('unknown'), null);
  store.applySnapshot(source, [item()]); store.applySnapshot(source, [item('b'), item('c')]);
  assert.equal(store.listInbox({ limit: 1 }).length, 1);
  for (const limit of [0, -1, Infinity, 1.5]) assert.throws(() => store.listInbox({ limit }));
}));

// --- inbox 最新优先（2026-11-10）：默认 asc 保持兼容，desc 只作显式读取视图 ---
test('listInbox supports newest-first (desc) while default and export stay oldest-first with stable ids', () => fixture(({ store, directory }) => {
  const times = [2000, 3000, 4000, 5000, 6000];
  store.applySnapshot(source, [item('a', 'H0')], { now: 1000 });
  for (const [i, now] of times.entries()) store.applySnapshot(source, [item('a', `H${i + 1}`)], { now });
  const asc = store.listInbox({ limit: 5 });
  assert.deepEqual(asc.map(row => row.detectedAt), times);
  assert.deepEqual(asc.map(row => row.title), ['H1', 'H2', 'H3', 'H4', 'H5']);
  const desc = store.listInbox({ limit: 5, order: 'desc' });
  assert.deepEqual(desc.map(row => row.detectedAt), [...times].reverse());
  assert.deepEqual(desc.map(row => row.title), ['H5', 'H4', 'H3', 'H2', 'H1']);
  assert.deepEqual(store.listInbox({ limit: 3, order: 'desc' }).map(row => row.title), ['H5', 'H4', 'H3']);
  assert.deepEqual(store.listInbox({ limit: 3 }).map(row => row.title), ['H1', 'H2', 'H3']);
  // Ties on detectedAt are broken by id: asc id ASC, desc id DESC (explicit reversal).
  const tie = 10_000;
  store.applySnapshot(source, [item('a', 'TieA')], { now: tie });
  store.applySnapshot(source, [item('b', 'TieB')], { now: tie });
  const ascTie = store.listInbox({ limit: 200 }).filter(row => row.detectedAt === tie);
  const descTie = store.listInbox({ limit: 200, order: 'desc' }).filter(row => row.detectedAt === tie);
  assert.equal(ascTie.length, 2);
  assert.deepEqual(descTie.map(row => row.id), ascTie.map(row => row.id).slice().reverse());
  for (const order of ['newest', 'DESC', '', 1]) assert.throws(() => store.listInbox({ order }), /order must be asc or desc/);
  // Export is a projection of the authoritative inbox: same rows/stable ids, no reading
  // order leaks into the files or into the exported set.
  const output = join(directory, 'ordered-export');
  const allAsc = store.listInbox({ limit: 200 });
  assert.equal(allAsc.length, 7);
  assert.equal(store.exportInbox(output).exported, 7);
  assert.deepEqual(readdirSync(output).sort(), allAsc.map(row => `${row.id}.json`).sort());
  for (const row of allAsc) assert.deepEqual(JSON.parse(readFileSync(join(output, `${row.id}.json`), 'utf8')), row);
}));

test('WAL journal mode is enabled on open, persists, and upgrades an existing database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-feed-wal-'));
  const dbPath = join(directory, 'journal.sqlite');
  const journalMode = () => { const probe = new DatabaseSync(dbPath); try { return probe.prepare('PRAGMA journal_mode').get().journal_mode; } finally { probe.close(); } };
  try {
    // A database created by the pre-WAL build (rollback journal, no WAL header).
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('CREATE TABLE marker (n INTEGER); INSERT INTO marker VALUES (1)');
    legacy.close();
    assert.equal(journalMode(), 'delete');
    let store = openFeedStore(dbPath);
    assert.equal(journalMode(), 'wal');
    store.applySnapshot(source, [item()], { now: 1 });
    store.close();
    // Journal mode is a persistent database property: survives close/reopen.
    assert.equal(journalMode(), 'wal');
    store = openFeedStore(dbPath);
    assert.equal(journalMode(), 'wal');
    store.close();
    assert.equal(journalMode(), 'wal');
  } finally {
    assert.equal(resolve(directory), directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict next UTC grid including Shanghai boundary and custom interval', () => {
  assert.equal(nextAlignedCheck(0), 600000);
  assert.equal(nextAlignedCheck(600000), 1200000);
  assert.equal(nextAlignedCheck(600001), 1200000);
  assert.equal(nextAlignedCheck(-1), 0);
  const t = Date.parse('2026-11-02T18:09:59.999+08:00');
  assert.equal(nextAlignedCheck(t), Date.parse('2026-11-02T18:10:00+08:00'));
  assert.equal(nextAlignedCheck(10, 5), 15);
  for (const interval of [0, -1, 0.5, Infinity]) assert.throws(() => nextAlignedCheck(1, interval));
  assert.throws(() => nextAlignedCheck(NaN));
});

// --- 同一来源同一条目每天最多 10 条（主人 2026-11-04 拍板，按北京时间自然日）---
// 全部用带 +08:00 的绝对时刻，判据不依赖本机时区。

test('daily cap: 12 same-day changes keep exactly 10 inbox rows, suppress 2, baseline still advances', () => fixture(({ store, dbPath }) => {
  const t0 = Date.parse('2026-11-04T09:00:00+08:00');
  store.applySnapshot(source, [item('a', 'V0')], { now: t0 });
  let last, suppressedTotal = 0, insertedTotal = 0;
  for (let i = 1; i <= 12; i++) {
    last = store.applySnapshot(source, [item('a', `V${i}`)], { now: t0 + i * 60_000, maxPerKeyPerDay: 10 });
    suppressedTotal += last.suppressed; insertedTotal += last.inserted;
    assert.equal(last.inserted, i <= 10 ? 1 : 0, `change ${i} inserted`);
    assert.equal(last.suppressed, i <= 10 ? 0 : 1, `change ${i} suppressed`);
  }
  assert.deepEqual({ inserted: last.inserted, suppressed: last.suppressed }, { inserted: 0, suppressed: 1 });
  assert.deepEqual({ insertedTotal, suppressedTotal }, { insertedTotal: 10, suppressedTotal: 2 });
  const rows = store.listInbox();
  assert.deepEqual(rows.map(r => r.title), ['V1','V2','V3','V4','V5','V6','V7','V8','V9','V10']);
  // feed_latest follows every sample; a suppressed version is never a delivered message.
  assert.equal(store.latestItems(source.id)[0].title, 'V12');
  // Re-applying V12 is silent today AND tomorrow: feed_items already holds the newest
  // fingerprint, so the suppressed version is never backfilled as a next-day flood.
  for (const now of [t0 + 13 * 60_000, Date.parse('2026-11-05T09:00:00+08:00')]) {
    const repeat = store.applySnapshot(source, [item('a', 'V12')], { now, maxPerKeyPerDay: 10 });
    assert.deepEqual({ inserted: repeat.inserted, coalesced: repeat.coalesced, suppressed: repeat.suppressed }, { inserted: 0, coalesced: 0, suppressed: 0 });
  }
  const probe = new DatabaseSync(dbPath);
  try {
    const newest = probe.prepare('SELECT fingerprint FROM feed_items WHERE sourceId=? AND key=?').get(source.id, 'a').fingerprint;
    const delivered = probe.prepare('SELECT fingerprint FROM feed_inbox WHERE sourceId=? AND key=?').all(source.id, 'a').map(r => r.fingerprint);
    assert.equal(delivered.length, 10);
    assert.equal(delivered.includes(newest), false);
  } finally { probe.close(); }
}));

test('daily cap blocks only added rows: in-window coalescing still updates after the cap', () => fixture(({ store }) => {
  const coalesceMs = 1_000;
  const t0 = Date.parse('2026-11-04T10:00:00+08:00');
  store.applySnapshot(source, [item('a', 'Base')], { now: t0 });
  const first = store.applySnapshot(source, [item('a', 'V1')], { now: t0 + 10_000, coalesceMs, maxPerKeyPerDay: 2 });
  const second = store.applySnapshot(source, [item('a', 'V2')], { now: t0 + 20_000, coalesceMs, maxPerKeyPerDay: 2 });
  assert.deepEqual({ i: first.inserted, s: first.suppressed }, { i: 1, s: 0 });
  assert.deepEqual({ i: second.inserted, s: second.suppressed }, { i: 1, s: 0 }); // cap reached: 2 rows
  // V3 lands inside V2's window (anchored at its first detectedAt): a projection update,
  // not a new message, so it neither needs nor spends quota.
  const third = store.applySnapshot(source, [item('a', 'V3')], { now: t0 + 20_500, coalesceMs, maxPerKeyPerDay: 2 });
  assert.deepEqual({ i: third.inserted, c: third.coalesced, s: third.suppressed }, { i: 0, c: 1, s: 0 });
  assert.equal(store.listInbox().length, 2);
  // V4 falls outside the window: it would add a row, so the cap suppresses it.
  const fourth = store.applySnapshot(source, [item('a', 'V4')], { now: t0 + 30_000, coalesceMs, maxPerKeyPerDay: 2 });
  assert.deepEqual({ i: fourth.inserted, c: fourth.coalesced, s: fourth.suppressed }, { i: 0, c: 0, s: 1 });
  assert.deepEqual(store.listInbox().map(r => r.title), ['V1', 'V3']);
  assert.equal(store.latestItems(source.id)[0].title, 'V4');
}));

test('daily cap resets at Beijing midnight (UTC+8), not at UTC midnight', () => fixture(({ store }) => {
  store.applySnapshot(source, [item('a', 'Base')], { now: Date.parse('2026-11-04T23:00:00+08:00') });
  const used = store.applySnapshot(source, [item('a', 'Late')], { now: Date.parse('2026-11-04T23:59:59.000+08:00'), maxPerKeyPerDay: 1 });
  const sameDay = store.applySnapshot(source, [item('a', 'SameDay')], { now: Date.parse('2026-11-04T23:59:59.999+08:00'), maxPerKeyPerDay: 1 });
  const nextDay = store.applySnapshot(source, [item('a', 'NextDay')], { now: Date.parse('2026-11-05T00:00:00.000+08:00'), maxPerKeyPerDay: 1 });
  assert.deepEqual({ i: used.inserted, s: used.suppressed }, { i: 1, s: 0 });
  // 15:59:59.999Z and 16:00:00.000Z are the same UTC date: a UTC-day cap would keep
  // suppressing here, so this pins the boundary to Beijing 00:00.
  assert.deepEqual({ i: sameDay.inserted, s: sameDay.suppressed }, { i: 0, s: 1 });
  assert.deepEqual({ i: nextDay.inserted, s: nextDay.suppressed }, { i: 1, s: 0 });
  assert.deepEqual(store.listInbox().map(r => r.title), ['Late', 'NextDay']);
  assert.deepEqual(store.listInbox().map(r => r.detectedAt), [Date.parse('2026-11-04T23:59:59.000+08:00'), Date.parse('2026-11-05T00:00:00.000+08:00')]);
}));

test('daily cap is per source and key: other keys and sources keep their own quota', () => fixture(({ store }) => {
  const t0 = Date.parse('2026-11-04T12:00:00+08:00');
  const other = { id: 'other', name: 'Other' };
  store.applySnapshot(source, [item('a', 'A0'), item('b', 'B0')], { now: t0 });
  store.applySnapshot(other, [item('a', 'O0')], { now: t0 });
  const both = store.applySnapshot(source, [item('a', 'A1'), item('b', 'B1')], { now: t0 + 1_000, maxPerKeyPerDay: 1 });
  const overloaded = store.applySnapshot(source, [item('a', 'A2'), item('b', 'B2')], { now: t0 + 2_000, maxPerKeyPerDay: 1 });
  const otherSource = store.applySnapshot(other, [item('a', 'O1')], { now: t0 + 2_000, maxPerKeyPerDay: 1 });
  assert.deepEqual({ i: both.inserted, s: both.suppressed }, { i: 2, s: 0 });
  assert.deepEqual({ i: overloaded.inserted, s: overloaded.suppressed }, { i: 0, s: 2 });
  assert.deepEqual({ i: otherSource.inserted, s: otherSource.suppressed }, { i: 1, s: 0 });
  assert.equal(store.listInbox().length, 3);
  assert.deepEqual(store.latestItems(source.id).map(r => [r.key, r.title]), [['a', 'A2'], ['b', 'B2']]);
  assert.deepEqual(store.latestItems(other.id).map(r => [r.key, r.title]), [['a', 'O1']]);
  // A brand-new key has its OWN daily budget: the contract is "same source + same key",
  // not a source-wide cap, so a fresh key still delivers its first message.
  const freshKey = store.applySnapshot(source, [item('c', 'C1')], { now: t0 + 3_000, maxPerKeyPerDay: 1 });
  assert.deepEqual({ i: freshKey.inserted, s: freshKey.suppressed }, { i: 1, s: 0 });
  const freshOver = store.applySnapshot(source, [item('c', 'C2')], { now: t0 + 4_000, maxPerKeyPerDay: 1 });
  assert.deepEqual({ i: freshOver.inserted, s: freshOver.suppressed }, { i: 0, s: 1 });
  assert.equal(store.listInbox().length, 4);
  assert.deepEqual(store.latestItems(source.id).map(r => [r.key, r.title]), [['a', 'A2'], ['b', 'B2'], ['c', 'C2']]);
}));

test('maxPerKeyPerDay=0 is the legacy unlimited behavior; invalid values change nothing', () => fixture(({ store }) => {
  const t0 = Date.parse('2026-11-04T12:00:00+08:00');
  store.applySnapshot(source, [item('a', 'V0')], { now: t0 });
  for (let i = 1; i <= 12; i++) {
    const result = store.applySnapshot(source, [item('a', `V${i}`)], { now: t0 + i * 1_000, maxPerKeyPerDay: 0 });
    assert.deepEqual({ i: result.inserted, c: result.coalesced, s: result.suppressed }, { i: 1, c: 0, s: 0 });
  }
  assert.equal(store.listInbox().length, 12);
  // Omitted option means the same 0 default: old callers keep one row per change.
  const omitted = store.applySnapshot(source, [item('a', 'V13')], { now: t0 + 13_000 });
  assert.deepEqual({ i: omitted.inserted, s: omitted.suppressed }, { i: 1, s: 0 });
  const before = store.status();
  const inboxBefore = store.listInbox();
  for (const bad of [-1, 0.5, Infinity, NaN, '10', null, 10n]) {
    assert.throws(
      () => store.applySnapshot(source, [item('a', 'V14')], { now: t0 + 14_000, maxPerKeyPerDay: bad }),
      error => error instanceof TypeError && /maxPerKeyPerDay/.test(error.message),
    );
  }
  assert.deepEqual(store.status(), before);
  assert.deepEqual(store.listInbox(), inboxBefore);
  assert.equal(store.latestItems(source.id)[0].title, 'V13');
}));

test('repeated identical apply never spends quota twice nor rewrites a capped key', () => fixture(({ store }) => {
  const t0 = Date.parse('2026-11-04T20:00:00+08:00');
  store.applySnapshot(source, [item('a', 'Base')], { now: t0 });
  const snapshot = [item('a', 'V1')];
  const first = store.applySnapshot(source, snapshot, { now: t0 + 1_000, maxPerKeyPerDay: 1 });
  assert.equal(first.inserted, 1);
  for (const now of [t0 + 2_000, t0 + 3_000]) {
    const repeat = store.applySnapshot(source, snapshot, { now, maxPerKeyPerDay: 1 });
    assert.deepEqual({ i: repeat.inserted, c: repeat.coalesced, s: repeat.suppressed }, { i: 0, c: 0, s: 0 });
  }
  assert.equal(store.listInbox().length, 1);
  const next = store.applySnapshot(source, [item('a', 'V2')], { now: t0 + 4_000, maxPerKeyPerDay: 1 });
  assert.deepEqual({ i: next.inserted, s: next.suppressed }, { i: 0, s: 1 });
  assert.deepEqual(store.listInbox().map(r => r.title), ['V1']);
}));

// --- 异界新闻(2026-11-10)：盯梢库的只读投影（网站世界地图页那块板的数据源）---
test('feed-news: read-only projection maps public fields newest-first with limit', () => fixture(({ dbPath, store }) => {
  const openrouter = { id: 'openrouter', name: 'OpenRouter' };
  const glm = { id: 'glm', name: 'GLM' };
  store.applySnapshot(openrouter, [item('a', 'M A')], { now: 1000 }); // 基线（不入箱）
  store.applySnapshot(openrouter, [item('a', 'M A'), item('b', 'M B newly listed', { url: 'https://example.org/b' })], { now: 2000 });
  store.applySnapshot(openrouter, [item('a', 'M A repriced'), item('b', 'M B newly listed', { url: 'https://example.org/b' })], { now: 3000 });
  store.applySnapshot(glm, [item('g', 'GLM release')], { now: 2500 }); // 基线
  store.applySnapshot(glm, [item('g', 'GLM release updated', { url: 'https://example.org/g' })], { now: 4000 });
  const reader = createFeedNews({ dbPath, limit: 10, log: () => {}, now: () => 9_999_999 });
  try {
    const latest = reader.latest();
    assert.equal(latest.updatedAt, 9_999_999);
    assert.deepEqual(latest.items.map((one) => one.detectedAt), [4000, 3000, 2000]);
    assert.deepEqual(latest.items.map((one) => one.type), ['updated', 'updated', 'new']);
    assert.equal(latest.items[0].sourceName, 'GLM');
    assert.equal(latest.items[0].url, 'https://example.org/g');
    assert.equal(latest.items[2].url, 'https://example.org/b');
    // 只给公开字段（不把 fingerprint/source 配置/任何本机信息带出去）。
    assert.deepEqual(Object.keys(latest.items[0]).sort(),
      ['detectedAt', 'id', 'publishedAt', 'source', 'sourceName', 'summary', 'title', 'type', 'url']);
    assert.equal('fingerprint' in latest.items[0], false);
    // limit 生效，且仍是最新在前。
    const two = createFeedNews({ dbPath, limit: 2, log: () => {} });
    try { assert.deepEqual(two.latest().items.map((one) => one.detectedAt), [4000, 3000]); } finally { two.close(); }
    // 行数没被 reader 改动（只读）。
    assert.equal(store.status().inboxCount, 3);
  } finally { reader.close(); }
  // close 之后就是关掉的 reader：再读返回 null，不抛。
  assert.equal(reader.latest(), null);
}));

test('feed-news: snippet/row mapping is bounded and drops malformed rows', () => {
  const long = 'x'.repeat(500);
  assert.equal(feedNewsSnippet(long).length, 180);
  assert.ok(feedNewsSnippet(long).endsWith('…'));
  assert.equal(feedNewsSnippet('  a\n b\t c  '), 'a b c');
  const rows = mapFeedNewsRows([
    { id: 'ok', sourceId: 's', sourceName: 'S', type: 'new', title: 'T', url: 'https://example.org/a', summary: long, publishedAt: null, detectedAt: 2 },
    { id: 'bad-url', sourceId: 's', title: 'T', url: 'file:///etc/passwd', summary: '', detectedAt: 1 },
    { id: 'cred-url', sourceId: 's', title: 'T', url: 'https://u:p@example.org/', summary: '', detectedAt: 1 },
    { id: 'bad-time', sourceId: 's', title: 'T', url: 'https://example.org/b', summary: '', detectedAt: 'x' },
    { id: '', sourceId: 's', title: 'T', url: 'https://example.org/c', summary: '', detectedAt: 1 },
    null,
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'ok');
  assert.equal(rows[0].summary.length, 180);
  assert.equal(rows[0].publishedAt, null);
});

test('feed-news: missing or non-feed databases disable the board instead of throwing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-feed-news-'));
  try {
    const missing = createFeedNews({ dbPath: join(directory, 'nope.db'), log: () => {} });
    assert.equal(missing.configured, true); // 配置了库（还没尝试打开）
    assert.equal(missing.latest(), null);
    assert.equal(missing.configured, false); // 打开失败后整体判为不可用
    missing.close();
    // 一个能打开、但没有 feed_inbox 表的 SQLite 文件：同样 fail closed。
    const otherPath = join(directory, 'other.db');
    const other = new DatabaseSync(otherPath);
    other.exec('CREATE TABLE marker (n INTEGER)'); other.close();
    const notFeed = createFeedNews({ dbPath: otherPath, log: () => {} });
    try { assert.equal(notFeed.latest(), null); } finally { notFeed.close(); }
    // 没配库 = 模块不启用（装配层据此整块不建）。
    const off = createFeedNews({ dbPath: null, log: () => {} });
    assert.equal(off.configured, false);
    assert.equal(off.latest(), null);
    off.close();
  } finally {
    assert.equal(resolve(directory), directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('coalesced row keeps a stable id: content reverting after the window never throws UNIQUE(id)', () => fixture(({ store }) => {
  // 2026-11-10 白云生产实测的回归：合并窗口把行内 fingerprint 改写成后来那一版（id 不变），
  // 之后内容回退到旧版本、且旧行已出窗口时，按 (sourceId,key,fingerprint) 查不到旧行，
  // 但算出来的 id 正好撞上那一行的主键 → 整个源报 UNIQUE constraint failed: feed_inbox.id。
  const openrouter = { id: 'openrouter', name: 'OpenRouter' };
  const coalesceMs = 600_000;
  store.applySnapshot(openrouter, [item('a', 'base')], { now: 1000, coalesceMs });
  store.applySnapshot(openrouter, [item('a', 'B')], { now: 2000, coalesceMs });
  const first = store.listInbox();
  assert.equal(first.length, 1);
  const stableId = first[0].id;
  // 窗口内 C 改写同一行的 fingerprint（id 仍是 B 那一版的）
  store.applySnapshot(openrouter, [item('a', 'C')], { now: 3000, coalesceMs });
  assert.equal(store.listInbox().length, 1);
  assert.equal(store.listInbox()[0].title, 'C');
  // 出了窗口、内容回退到 B：以前这里抛 UNIQUE(feed_inbox.id)，整个源失败。
  assert.doesNotThrow(() => store.applySnapshot(openrouter, [item('a', 'B')], { now: 900_000, coalesceMs }));
  const rows = store.listInbox();
  assert.equal(rows.length, 1, '同一内容版本永远只有一行（稳定 id），不新增重复行');
  assert.equal(rows[0].id, stableId, 'id 仍是这个内容版本的稳定 id');
  assert.equal(rows[0].title, 'B', '行投影恢复成最新内容，而不是停在被合并改写的那一版');
  // 再重复同一版：幂等，不抛不增。
  assert.doesNotThrow(() => store.applySnapshot(openrouter, [item('a', 'B')], { now: 910_000, coalesceMs }));
  assert.equal(store.listInbox().length, 1);
  // 新内容 D 仍能正常新增一行（修复没有把"该进箱的"也吞掉）。
  store.applySnapshot(openrouter, [item('a', 'D')], { now: 2_000_000, coalesceMs });
  assert.equal(store.listInbox().length, 2);
  assert.deepEqual(store.listInbox().map(row => row.title), ['B', 'D']);
}));
