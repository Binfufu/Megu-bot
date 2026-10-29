import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { backupAndRestore, verifyRestored } from './backup-stage1.mjs';
export function registerStage1Tests(test) {
  for (const memory of [false, true]) test('stage1: ' + (memory ? 'existing memory backupTo' : 'state backup') + ' WAL restore and manifest-bound negative controls', () => {
    const base = path.resolve('data/index'); fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'backup-test-'));
    const source = path.join(dir, 'live.db'), target = path.join(dir, 'snapshot.db'), restored = path.join(dir, 'restored.db');
    const db = new DatabaseSync(source);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fact(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE session(id INTEGER); CREATE TABLE turn(id INTEGER); INSERT INTO fact VALUES(1,'committed-in-wal'); INSERT INTO session VALUES(1); INSERT INTO turn VALUES(1); PRAGMA user_version=17;");
      assert.ok(fs.statSync(source + '-wal').size > 0);
      // Raw main-file copy is a real negative: schema/row exists only in WAL.
      const raw = path.join(dir, 'raw-main-only.db'); fs.copyFileSync(source, raw);
      const rawDb = new DatabaseSync(raw, { readOnly: true });
      try { assert.throws(() => rawDb.prepare('SELECT * FROM fact').all(), /no such table/); } finally { rawDb.close(); }
      db.exec("BEGIN; INSERT INTO fact VALUES(2,'uncommitted');");
      const report = backupAndRestore(source, target, restored, memory);
      assert.equal(report.counts.fact, 1); assert.equal(report.counts.session, 1); assert.equal(report.counts.turn, 1); assert.equal(report.userVersion, 17);
      assert.equal(db.isTransaction, true); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fact').get().n, 2);
      const copy = new DatabaseSync(restored);
      try { assert.equal(copy.prepare('SELECT value FROM fact').get().value, 'committed-in-wal'); copy.exec("UPDATE fact SET value='TAMPERED'"); } finally { copy.close(); }
      assert.throws(() => verifyRestored(target, restored, report.sha256), /hash mismatch/);
      fs.copyFileSync(target, restored); assert.equal(verifyRestored(target, restored, report.sha256), true);
      assert.throws(() => backupAndRestore(source, target, restored, memory), /overwrite/);
      const original = fs.readFileSync(target);
      const changed = new DatabaseSync(target); try { changed.exec("UPDATE fact SET value='both-tampered'"); } finally { changed.close(); }
      fs.copyFileSync(target, restored);
      assert.throws(() => verifyRestored(target, restored, report.sha256), /manifest hash/);
      fs.writeFileSync(target, original); fs.copyFileSync(target, restored);
      assert.equal(verifyRestored(target, restored, report.sha256), true);
      db.exec('ROLLBACK'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fact').get().n, 1);
    } finally { db.close(); /* Retain tiny isolated evidence; never clean live paths. */ }
  });
}
if (process.argv[1]?.endsWith('selftest-stage1.mjs')) {
  registerStage1Tests((name, fn) => { fn(); console.log('PASS ' + name); });
}
