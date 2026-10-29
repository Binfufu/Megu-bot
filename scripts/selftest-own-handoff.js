import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
export function registerOwnHandoffTests({ test, assert }) {
  test('own交接:空库首轮真消费并持久化，重开不重复，已有历史及明确重置不复活', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-handoff-'));
    const personaPath = path.join(dir, 'persona.txt'); fs.writeFileSync(personaPath, 'control-persona');
    let store = new SqliteStateStore(path.join(dir, 'state.db')), engine;
    let count = 0; const captured = [];
    const handoff = async () => { count++; return 'unique-old-memory-fingerprint'; };
    const llm = { async chat(messages) { captured.push(structuredClone(messages)); return { text: 'reply', usage: null }; } };
    const open = () => createOwnEngine({ store, personaPath, llm, handoff, budget: null });
    try {
      engine = open(); await engine.initialize();
      await engine.runTurn('key', 'first');
      assert.equal(count, 1);
      assert.match(captured[0][0].content, /control-persona/);
      assert.match(captured[0].at(-1).content, /unique-old-memory-fingerprint/);
      assert.equal(store.conversationTurns('key')[0].meta.rawText, 'first');
      assert.equal(store.conversationTurns('key')[0].meta.handoffApplied, true);
      await engine.stop(); store.close();
      store = new SqliteStateStore(path.join(dir, 'state.db')); engine = open(); await engine.initialize();
      await engine.runTurn('key', 'second');
      assert.equal(count, 1);
      assert.equal(JSON.stringify(captured.at(-1)).split('unique-old-memory-fingerprint').length - 1, 1);
      assert.equal(captured.at(-1).at(-1).content, 'second');
      engine.resetConversation('key'); await engine.runTurn('key', 'after reset');
      assert.equal(count, 1);
      assert.doesNotMatch(JSON.stringify(captured.at(-1)), /unique-old-memory-fingerprint/);
      engine.resetConversation('never-used'); await engine.runTurn('never-used', 'empty reset');
      assert.equal(count, 1);
      store.appendConversationTurn({ key: 'existing', role: 'user', content: 'old own history' });
      await engine.runTurn('existing', 'existing followup'); assert.equal(count, 1);
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('own交接:挂起提供者被stop取消，无晚到落库/模型调用', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-handoff-cancel-'));
    const personaPath = path.join(dir, 'persona.txt'); fs.writeFileSync(personaPath, 'persona');
    const store = new SqliteStateStore(path.join(dir, 'state.db')); let engine, release, started;
    const entered = new Promise(resolve => { started = resolve; }); let calls = 0;
    try {
      engine = createOwnEngine({ store, personaPath, budget: null, llm: { async chat() { calls++; return { text: 'bad' }; } }, handoff: () => { started(); return new Promise(resolve => { release = resolve; }); } });
      await engine.initialize(); const pending = engine.runTurn('cancel', 'question');
      const rejected = assert.rejects(pending, /engine stopped/); await entered; await engine.stop(); await rejected;
      release('late old memory'); await Promise.resolve();
      assert.equal(store.conversationTurns('cancel').length, 0); assert.equal(calls, 0);
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('own交接(主人拍板,2026-10-15):先重试到成功；三次都不成才降级成"warn+照常回话"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-handoff-retry-'));
    const personaPath = path.join(dir, 'persona.txt'); fs.writeFileSync(personaPath, 'persona');
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    let engine; const warns = []; const captured = [];
    const log = { warn: (m) => warns.push(String(m)), info() {}, error() {} };
    try {
      // ① 前两次失败、第三次成功 ⇒ **带着旧记忆**回话,而且是一次成功的交接(不是"没记忆")。
      let tries = 0;
      engine = createOwnEngine({ store, personaPath, budget: null, log, handoffAttempts: 3,
        handoff: async () => { tries += 1; if (tries < 3) throw new Error(`第${tries}次读取失败`); return '唯一旧记忆指纹'; },
        llm: { async chat(messages) { captured.push(structuredClone(messages)); return { text: '答', usage: null }; } } });
      await engine.initialize(); await engine.runTurn('retry', '问');
      assert.equal(tries, 3, '要一直重试到成功');
      assert.match(JSON.stringify(captured.at(-1)), /唯一旧记忆指纹/, '重试成功后旧记忆必须真的进了这一轮');
      assert.equal(warns.filter((m) => /重试/.test(m)).length, 2, '每次失败都要留下一条 warn(不许静默)');
      // ② 三次全失败 ⇒ 降级:**照常回话**、但这一轮不带旧记忆,而且 warn 要大声说清"没拿到记忆"。
      let tries2 = 0;
      engine = createOwnEngine({ store, personaPath, budget: null, log, handoffAttempts: 3,
        handoff: async () => { tries2 += 1; throw new Error('handoff-storage-failure'); },
        llm: { async chat(messages) { captured.push(structuredClone(messages)); return { text: '照常答', usage: null }; } } });
      await engine.initialize();
      const turn = await engine.runTurn('degraded', '问');
      assert.equal(turn.text, '照常答', '交接彻底失败也不许让她凭空沉默(对齐 DSH 契约)');
      assert.equal(tries2, 3, '正好试三次');
      assert.match(warns.at(-1), /记忆交接失败\(已试 3 次\).*照常回话/, '要有一条说清"已试 3 次、这一轮不带旧记忆"的 warn');
      assert.equal(store.conversationTurns('degraded').length, 2, '这一轮照常落库(user + assistant)');
      assert.doesNotMatch(JSON.stringify(captured.at(-1)), /handoff-storage-failure/, '失败信息不许混进提示词');
      // ③ 取消/超时**不重试**(那是这一趟被掐了,不是交接本身坏了)。
      let tries3 = 0; let releaseHandoff;
      engine = createOwnEngine({ store, personaPath, budget: null, log, handoffAttempts: 3,
        handoff: () => { tries3 += 1; return new Promise((resolve) => { releaseHandoff = resolve; }); },
        llm: { async chat() { return { text: 'x', usage: null }; } } });
      await engine.initialize();
      const rejected3 = assert.rejects(engine.runTurn('aborted', '问'), /engine stopped/);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await engine.stop(); await rejected3;
      releaseHandoff('晚到的记忆'); await Promise.resolve();
      assert.equal(tries3, 1, '取消不该触发重试');
      assert.equal(store.conversationTurns('aborted').length, 0, '取消后不留半条');
      // ④ 返回值形状不对 = 代码错,重试也修不好 ⇒ 当场抛,不浪费三次调用。
      let tries4 = 0;
      engine = createOwnEngine({ store, personaPath, budget: null, log, handoffAttempts: 3,
        handoff: async () => { tries4 += 1; return 42; },
        llm: { async chat() { return { text: 'x', usage: null }; } } });
      await engine.initialize();
      await assert.rejects(engine.runTurn('shape', '问'), /handoff must return a string or null/);
      assert.equal(tries4, 1, '形状错只试一次');
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('own交接:生产own装配必须复用既有handoffFor，不让探针可用而生产没接', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    // 6B(1.150.84)之后没有 engineMode 分支:装配只有一处 —— 判据直接盯 createOwnEngine 那一段。
    const at = source.indexOf('runner = createOwnEngine({');
    assert.ok(at > 0, '生产装配里必须有 createOwnEngine 调用(own 是唯一引擎)');
    const block = source.slice(at, source.indexOf('});', at));
    assert.match(block, /handoff: memoryCfg\.enabled \? handoffFor : undefined/,
      '生产 own 装配必须复用既有 handoffFor(探针能用而生产没接 = 静默失效)');
  });
}
