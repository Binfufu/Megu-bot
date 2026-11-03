import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Single-machine transactional outbox, not a cache: BACK UP THIS DATABASE.
// Reuse: SQLite UPSERT / unique constraints + atomic transaction, asOf 2026-11-02:
// https://sqlite.org/lang_UPSERT.html, https://sqlite.org/lang_transaction.html
// https://nodejs.org/docs/latest-v22.x/api/sqlite.html (22.5+; flag before 22.13).
// No sent flag: files are disposable projections of the authoritative inbox.
// Parser / HTTP / scheduler are deliberately outside this module. Callers inject
// parse(source,text), then pass its non-empty result to applySnapshot.
const hash = value => createHash('sha256').update(value).digest('hex');
function text(value, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new TypeError(`${label} must be a string`);
  return value;
}
function millis(value, label = 'now') {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
  return value;
}
function duration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}
function sourceInfo(source) {
  if (!source || typeof source !== 'object') throw new TypeError('source required');
  return { id: text(source.id, 'source.id'), name: text(source.name ?? source.id, 'source.name') };
}
function canonical(value, parents = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || parents.has(value)) throw new TypeError('observed must be finite JSON, without cycles');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('observed must be plain JSON');
  parents.add(value);
  const result = Array.isArray(value)
    ? `[${Array.from(value, v => canonical(v, parents)).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k], parents)}`).join(',')}}`;
  parents.delete(value);
  return result;
}
function normalizeItem(item) {
  if (!item || typeof item !== 'object') throw new TypeError('item required');
  const key = text(item.key, 'item.key');
  const title = text(item.title, 'item.title');
  const url = text(item.url, 'item.url');
  const parsed = new URL(url);
  // Public links only. Never serialize source config, HTTP headers or observed.
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      [...parsed.searchParams.keys()].some(k => /token|secret|password|authorization|api[-_]?key|credential|signature/i.test(k))) {
    throw new TypeError('item.url must be a public HTTP(S) link without credentials');
  }
  const summary = text(item.summary, 'item.summary', true);
  const publishedAt = item.publishedAt ?? null;
  if (publishedAt !== null && (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)))) throw new TypeError('invalid publishedAt');
  if (item.observed !== undefined && (!item.observed || typeof item.observed !== 'object' || Array.isArray(item.observed))) throw new TypeError('observed must be an object');
  const fingerprint = hash(canonical({ title, url, summary, publishedAt, observed: item.observed ?? null }));
  return { key, title, url, summary, publishedAt, fingerprint };
}
function validator(value, label) {
  return value === undefined || value === null ? null : text(value, label, true);
}
const inboxColumns = 'id, sourceId, sourceName, key, type, title, url, summary, publishedAt, detectedAt';

/** All methods synchronous; dbPath must be an explicit persistent path.
 * sourceState returns null for unknown ids. status returns counts + all states.
 * applySnapshot returns { baseline, inserted, coalesced, count }; invalid samples
 * throw and change nothing (caller may separately recordFailure). Missing keys never delete.
 * Fingerprint includes title/url/summary/publishedAt/observed (sorted JSON keys).
 * Each post-baseline fingerprint is delivered at most once per source/key EVER.
 * A baseline A -> B -> A emits B and then A once; subsequent cycles are silent.
 * Snapshot validators absent on a 200 clear old validators; on 304 absent retain.
 * Strings in parser output must be public content, never credentials. In particular
 * do not pass authenticated URLs or secrets disguised as titles/summaries/keys.
 *
 * opts.coalesceMs (non-negative safe integer, default 0 = pre-coalescing behavior):
 * a post-baseline change whose source/key already has an inbox row first detected in
 * [now-coalesceMs, now] updates that row in place: same id, same detectedAt, same
 * first type; title/url/summary/publishedAt/fingerprint become the newest. Such a
 * merge counts once in `coalesced`, never in `inserted`. Changes outside the window
 * insert as before, so the window is anchored to the row's first detectedAt, not to
 * each check. feed_items/feed_latest still advance on every sample; coalescing only
 * projects delivery, never change detection. A fingerprint already present in any
 * inbox row for the key (A -> B -> A) is not delivered twice: no row is added and
 * the unique constraint is never allowed to raise.
 */
export function openFeedStore(dbPath) {
  text(dbPath, 'dbPath');
  if (dbPath === ':memory:' || !isAbsolute(dbPath)) throw new TypeError('dbPath must be an explicit absolute persistent path (NOT a deletable cache)');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS feed_sources (
        sourceId TEXT PRIMARY KEY, sourceName TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
        lastCheckAt INTEGER, lastSuccessAt INTEGER, etag TEXT, lastModified TEXT,
        consecutiveFailures INTEGER NOT NULL DEFAULT 0, error TEXT, retryAt INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS feed_items (
        sourceId TEXT NOT NULL REFERENCES feed_sources(sourceId), key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, PRIMARY KEY(sourceId,key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS feed_latest (
        sourceId TEXT NOT NULL REFERENCES feed_sources(sourceId), key TEXT NOT NULL,
        title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT NOT NULL, publishedAt TEXT,
        observedAt INTEGER NOT NULL, PRIMARY KEY(sourceId,key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS feed_inbox (
        id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES feed_sources(sourceId),
        sourceName TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('new','updated')), title TEXT NOT NULL,
        url TEXT NOT NULL, summary TEXT NOT NULL, publishedAt TEXT, detectedAt INTEGER NOT NULL,
        UNIQUE(sourceId,key,fingerprint)
      ) STRICT;`);
  } catch (error) { db.close(); throw error; }
  const stateQuery = db.prepare('SELECT * FROM feed_sources WHERE sourceId=?');
  const ensure = db.prepare(`INSERT INTO feed_sources(sourceId,sourceName) VALUES (?,?)
    ON CONFLICT(sourceId) DO UPDATE SET sourceName=excluded.sourceName`);
  const getItem = db.prepare('SELECT fingerprint FROM feed_items WHERE sourceId=? AND key=?');
  const putItem = db.prepare(`INSERT INTO feed_items VALUES (?,?,?) ON CONFLICT(sourceId,key)
    DO UPDATE SET fingerprint=excluded.fingerprint`);
  const putInbox = db.prepare(`INSERT INTO feed_inbox
    (id,sourceId,sourceName,key,fingerprint,type,title,url,summary,publishedAt,detectedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sourceId,key,fingerprint) DO NOTHING`);
  const inboxFingerprint = db.prepare('SELECT id FROM feed_inbox WHERE sourceId=? AND key=? AND fingerprint=?');
  // The window is anchored at the row's first detectedAt, so [now-coalesceMs, now]
  // holds at most one row per source/key (a row is created only once its predecessor
  // has left the window). The newest row is chosen if history ever says otherwise.
  const inboxWindow = db.prepare(`SELECT id FROM feed_inbox WHERE sourceId=? AND key=?
    AND detectedAt>=? AND detectedAt<=? ORDER BY detectedAt DESC, id LIMIT 1`);
  const updateInbox = db.prepare(`UPDATE feed_inbox SET fingerprint=?,title=?,url=?,summary=?,publishedAt=?
    WHERE id=?`);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function sourceState(sourceId) {
    const row = stateQuery.get(text(sourceId, 'sourceId'));
    return row ? { ...row, baseline: Boolean(row.baseline) } : null;
  }
  return {
    close() { db.close(); },
    sourceState,
    latestItems(sourceId) {
      return db.prepare('SELECT key,title,url,summary,publishedAt,observedAt FROM feed_latest WHERE sourceId=? ORDER BY publishedAt DESC,key').all(text(sourceId,'sourceId')).map(row=>({...row}));
    },
    status() {
      return {
        authoritative: true,
        sources: db.prepare('SELECT sourceId FROM feed_sources ORDER BY sourceId').all().map(r => sourceState(r.sourceId)),
        itemCount: db.prepare('SELECT COUNT(*) AS n FROM feed_items').get().n,
        inboxCount: db.prepare('SELECT COUNT(*) AS n FROM feed_inbox').get().n,
      };
    },
    listInbox({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
      return db.prepare(`SELECT ${inboxColumns} FROM feed_inbox ORDER BY detectedAt,id LIMIT ?`).all(limit).map(r => ({ ...r }));
    },
    applySnapshot(source, items, { now = Date.now(), etag, lastModified, coalesceMs = 0 } = {}) {
      const s = sourceInfo(source); millis(now); duration(coalesceMs, 'coalesceMs');
      etag = validator(etag, 'etag'); lastModified = validator(lastModified, 'lastModified');
      if (!Array.isArray(items) || !items.length) throw new TypeError('empty/invalid snapshot is a source failure, not a baseline');
      const normalized = items.map(normalizeItem);
      if (new Set(normalized.map(i => i.key)).size !== normalized.length) throw new TypeError('duplicate snapshot keys');
      const windowStart = Math.max(now - coalesceMs, Number.MIN_SAFE_INTEGER);
      return transaction(() => {
        ensure.run(s.id, s.name);
        const baseline = !stateQuery.get(s.id).baseline;
        let inserted = 0, coalesced = 0;
        for (const i of normalized) {
          const old = getItem.get(s.id, i.key);
          if (!baseline && old?.fingerprint !== i.fingerprint) {
            // That content version already has an inbox row: keep it, never duplicate.
            const alreadyDelivered = coalesceMs > 0 && inboxFingerprint.get(s.id, i.key, i.fingerprint);
            if (!alreadyDelivered) {
              const anchor = coalesceMs > 0 ? inboxWindow.get(s.id, i.key, windowStart, now) : undefined;
              if (anchor) {
                // In-place delivery projection: id/detectedAt/type stay as first detected.
                updateInbox.run(i.fingerprint, i.title, i.url, i.summary, i.publishedAt, anchor.id);
                coalesced += 1;
              } else {
                const id = hash(JSON.stringify([s.id, i.key, i.fingerprint]));
                inserted += Number(putInbox.run(id, s.id, s.name, i.key, i.fingerprint, old ? 'updated' : 'new', i.title, i.url, i.summary, i.publishedAt, now).changes);
              }
            }
          }
          putItem.run(s.id, i.key, i.fingerprint);
          db.prepare(`INSERT INTO feed_latest VALUES (?,?,?,?,?,?,?) ON CONFLICT(sourceId,key)
            DO UPDATE SET title=excluded.title,url=excluded.url,summary=excluded.summary,
            publishedAt=excluded.publishedAt,observedAt=excluded.observedAt`)
            .run(s.id,i.key,i.title,i.url,i.summary,i.publishedAt,now);
        }
        db.prepare(`UPDATE feed_sources SET baseline=1,lastCheckAt=?,lastSuccessAt=?,etag=?,lastModified=?,
          consecutiveFailures=0,error=NULL,retryAt=NULL WHERE sourceId=?`).run(now, now, etag, lastModified, s.id);
        return { baseline, inserted, coalesced, count: normalized.length };
      });
    },
    recordFailure(source, { now = Date.now(), error = 'source failure', retryAt = null } = {}) {
      const s = sourceInfo(source); millis(now);
      if (retryAt !== null) millis(retryAt, 'retryAt');
      const message = text(error instanceof Error ? error.message : error, 'error', true);
      return transaction(() => {
        ensure.run(s.id, s.name);
        db.prepare(`UPDATE feed_sources SET lastCheckAt=?,consecutiveFailures=consecutiveFailures+1,
          error=?,retryAt=? WHERE sourceId=?`).run(now, message, retryAt, s.id);
        return sourceState(s.id);
      });
    },
    recordNotModified(source, { now = Date.now(), etag, lastModified } = {}) {
      const s = sourceInfo(source); millis(now);
      const e = validator(etag, 'etag'), l = validator(lastModified, 'lastModified');
      return transaction(() => {
        const state = sourceState(s.id);
        if (!state?.baseline) throw new Error('304 requires a successful baseline');
        ensure.run(s.id, s.name);
        db.prepare(`UPDATE feed_sources SET lastCheckAt=?,lastSuccessAt=?,etag=?,lastModified=?,
          consecutiveFailures=0,error=NULL,retryAt=NULL WHERE sourceId=?`)
          .run(now, now, etag === undefined ? state.etag : e, lastModified === undefined ? state.lastModified : l, s.id);
        return sourceState(s.id);
      });
    },
    exportInbox(directory) {
      if (typeof directory !== 'string' || !isAbsolute(directory)) throw new TypeError('export directory must be an explicit absolute path');
      mkdirSync(directory, { recursive: true });
      let exported = 0;
      for (const row of db.prepare(`SELECT ${inboxColumns} FROM feed_inbox ORDER BY detectedAt,id`).iterate()) {
        const destination = join(directory, `${row.id}.json`);
        const temporary = join(directory, `.${row.id}.${randomUUID()}.tmp`);
        let fd;
        try {
          fd = openSync(temporary, 'wx', 0o600);
          writeFileSync(fd, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
          fsyncSync(fd); closeSync(fd); fd = undefined;
          renameSync(temporary, destination); // same-directory atomic replacement; stable ID, never append
          exported++;
        } finally {
          if (fd !== undefined) closeSync(fd);
          try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      }
      return { directory, exported };
    },
  };
}

/** Strictly next UTC epoch grid, not now+interval (also Shanghai ten-minute grid). */
export function nextAlignedCheck(now, intervalMs = 600_000) {
  millis(now);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be positive');
  return millis((Math.floor(now / intervalMs) + 1) * intervalMs, 'next check');
}
