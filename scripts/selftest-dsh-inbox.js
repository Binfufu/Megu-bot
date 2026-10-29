import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { diagnoseDshInbox, readDshInboxDiagnostic } from './diagnose-dsh-inbox.js';

export function registerDshInboxTests({ test, assert: a }) {
  const key = 'PRIVATE-KEY-NEVER-REPORT';
  const prompt = 'PRIVATE-PROMPT-NEVER-REPORT';
  const event = (type, time, data) => ({ type, time, data });
  const insert = (id, time, p = prompt) => event('agent/inbox/spliced', time, { target: 'next-turn', inserted: [
    { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: p }] }] });
  const start = (turn, time) => event('turn/start', time, { turn });
  const end = (turn, time) => event('turn/end', time, { turn, reason: { kind: 'error', error: { message: prompt } } });
  const consume = (id, time) => event('user/message', time, { id, source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] });
  const row = (id, at, p = prompt) => ({ id, key, at, role: 'user', meta: JSON.stringify({ source: 'own-engine', rawText: p }) });
  const run = (records, rows, overrides = {}) => diagnoseDshInbox({ records, rows, key, windowMs: 100, returnSlackMs: 5, ...overrides });
  test('DSH inbox诊断:正常两轮身份消费、不把诊断当模型成功', () => {
    const records = [insert('SECRET-UUID-1', 10), start(1, 11), consume('SECRET-UUID-1', 12), end(1, 20),
      insert('SECRET-UUID-2', 30, prompt + '2'), start(2, 31), consume('SECRET-UUID-2', 32), end(2, 40)];
    const r = run(records, [row(1, 21), row(2, 41, prompt + '2')]);
    a.equal(r.verdict, 'diagnostic'); a.equal(r.matched, 2); a.equal(r.consumed, 2); a.equal(r.observedBeforeConsumption, 0);
    a.equal(r.entries[0].consumption.turn, 1); a.equal(r.entries[1].consumption.turn, 2);
    for (const secret of [key, prompt, 'SECRET-UUID']) a.equal(JSON.stringify(r).includes(secret), false);
  });
  test('DSH inbox诊断:旧轮结束桥先返回、FIFO稍后消费与未消费分别报告', () => {
    const records = [start(1, 1), insert('SECRET-UUID-1', 10), end(1, 20), start(2, 23), consume('SECRET-UUID-1', 24),
      insert('SECRET-UUID-2', 30, prompt + '2'), end(2, 40)];
    const r = run(records, [row(44, 21), row(49, 41, prompt + '2')]);
    a.equal(r.verdict, 'observed-shadow-before-consumption'); a.equal(r.observedBeforeConsumption, 1);
    a.equal(r.entries[0].userTurnId, 44); a.equal(r.entries[0].shadowObservedAt, 21);
    a.deepEqual(r.entries[0].oldEndCandidates, [{ at: 20, turn: 1 }]);
    a.deepEqual(r.entries[0].consumption, { at: 24, turn: 2 });
    a.equal(r.entries[1].consumption, null); a.deepEqual(r.entries[1].oldEndCandidates, [{ at: 40, turn: 2 }]);
    // A turn/start alone must never count as identity consumption.
    a.equal(r.consumed, 1);
    a.equal(r.entries[1].observedBeforeConsumption, null);
    // Queued observer time is not authoritative outcome time. A late observation
    // cannot establish that the authoritative outcome was late too.
    const delayed = run(records, [row(44, 28), row(49, 41, prompt + '2')]);
    a.equal(delayed.entries[0].shadowObservedAt, 28);
    a.equal(delayed.entries[0].observedBeforeConsumption, false);
    a.equal(Object.hasOwn(delayed.entries[0], 'bridgeReturnAt'), false);
    a.equal(delayed.timingLimit.includes('not exact bridge return'), true);
  });
  test('DSH inbox诊断:重复同文歧义不猜来源、旧无来源/空提示不匹配、坏输入脱敏', () => {
    const r = run([insert('SECRET-UUID-1', 10)], [row(1, 20), row(2, 30)]);
    a.equal(r.ambiguous, 1); a.equal(r.matched, 0); a.equal(r.entries[0].match, 'ambiguous');
    a.equal(Object.hasOwn(r.entries[0], 'userTurnId'), false);
    const old = { ...row(1, 20), meta: null };
    a.equal(run([insert('x', 10)], [old]).matched, 0);
    a.equal(run([insert('x', 10)], [row(1, 20, '')]).matched, 0);
    a.equal(run([insert('x', 10, 'prefix\n\n' + prompt)], [row(1, 20)]).matched, 1);
    a.equal(run([insert('x', 10, 'evilprefix' + prompt)], [row(1, 20)]).matched, 0);
    for (const meta of ['null', '[]', 'true', '42', '"' + prompt + '"', '{' + prompt]) {
      const bad = run([], [{ ...row(1, 20), meta }]); a.equal(bad.verdict, 'failed'); a.equal(JSON.stringify(bad).includes(prompt), false);
    }
    a.equal(run([start(1, 20), start(2, 10)], []).verdict, 'failed');
    a.equal(run([insert('x', 10), insert('x', 20)], []).verdict, 'failed');
    a.equal(run([insert('x', 10), insert('y', 11)], [row(1, 20)]).verdict, 'failed');
    a.equal(run([], [], { windowMs: 0 }).verdict, 'failed');
  });
  test('DSH inbox诊断:真实多帧会话/只读SQLite/CLI出报告且拒绝覆盖证据', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inbox-diagnostic-'));
    const sessionFile = path.join(dir, 'session.v3.jsonl.zstd'), stateFile = path.join(dir, 'shadow.db'), output = path.join(dir, 'report.json');
    try {
      const records = [start(1, 1), insert('SECRET-UUID-1', 10), end(1, 20), start(2, 23), consume('SECRET-UUID-1', 24)];
      fs.writeFileSync(sessionFile, Buffer.concat([{ type: 'header' }, ...records].map(r => zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))));
      const db = new DatabaseSync(stateFile);
      try { db.exec('CREATE TABLE conversation_turn (id INTEGER, key TEXT, at INTEGER, role TEXT, meta TEXT)');
        const r = row(44, 21); db.prepare('INSERT INTO conversation_turn VALUES (?,?,?,?,?)').run(r.id, r.key, r.at, r.role, r.meta); }
      finally { db.close(); }
      const beforeDb = fs.readFileSync(stateFile), beforeLog = fs.readFileSync(sessionFile);
      const r = readDshInboxDiagnostic({ sessionFile, stateFile, key, windowMs: 100, returnSlackMs: 5 });
      a.equal(r.verdict, 'observed-shadow-before-consumption'); a.equal(r.entries[0].consumption.turn, 2);
      const cli = ['scripts/diagnose-dsh-inbox.js', '--session', sessionFile, '--state', stateFile, '--key', key, '--window-ms', '100', '--return-slack-ms', '5'];
      const runCli = args => spawnSync(process.execPath, [...cli, ...args], { stdio: 'ignore', windowsHide: true });
      const first = runCli(['--out', output]); a.ifError(first.error); a.equal(first.status, 0);
      const snapshot = fs.readFileSync(output); a.deepEqual(JSON.parse(snapshot).entries, r.entries);
      a.equal(runCli(['--out', output]).status, 1); a.deepEqual(fs.readFileSync(output), snapshot);
      a.equal(runCli(['--out', sessionFile]).status, 1); a.equal(runCli(['--out', stateFile]).status, 1);
      a.deepEqual(fs.readFileSync(stateFile), beforeDb); a.deepEqual(fs.readFileSync(sessionFile), beforeLog);
      const missing = readDshInboxDiagnostic({ sessionFile: path.join(dir, prompt), stateFile, key, windowMs: 100, returnSlackMs: 5 });
      a.equal(missing.verdict, 'failed'); a.equal(JSON.stringify(missing).includes(prompt), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
