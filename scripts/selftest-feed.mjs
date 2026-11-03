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
  assert.deepEqual(store.applySnapshot(source, [item(), item('b')], { now: 1, etag: 'v1', lastModified: 'yesterday' }), { baseline: true, inserted: 0, coalesced: 0, count: 2 });
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
