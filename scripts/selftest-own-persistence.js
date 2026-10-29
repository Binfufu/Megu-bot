import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
export function registerOwnPersistenceTests({ test, assert }) {
  test('own落库护栏:user 轮没落上库时**不许叫模型**(否则她答了却没有观测/归档的锚点)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-persist-'));
    const personaPath = path.join(dir, 'persona.txt'); fs.writeFileSync(personaPath, '人设');
    const real = new SqliteStateStore(path.join(dir, 'state.db'));
    let calls = 0;
    // 真实库的**空内容拒收**行为:`appendConversationTurn('') ⇒ null`(sqlite-store 的既有口径)。
    assert.equal(real.appendConversationTurn({ key: 'k', role: 'user', content: '   ' }), null,
      '空白内容本来就不落库 —— 这是被依赖的前提,先钉住');
    // 让引擎拿到一个"落库被拒"的库(其余接口都转发给真库)。
    const refusing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'appendConversationTurn') return () => null;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let engine;
    try {
      engine = createOwnEngine({ store: refusing, personaPath, budget: null,
        llm: { async chat() { calls += 1; return { text: '她答了', usage: null }; } } });
      await engine.initialize();
      await assert.rejects(engine.runTurn('k', '问一句'), /OWN_TURN_NOT_PERSISTED|user 轮没落上库/);
      assert.equal(calls, 0, '落库失败时一次模型都不许发 —— 发了就是"她答了、库里没有"的静默漂移');
    } finally { await engine?.stop(); real.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('own落库护栏:正常落库时 userTurnId 必须是正整数,而且观测/归档都拿得到它', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-persist-ok-'));
    const personaPath = path.join(dir, 'persona.txt'); fs.writeFileSync(personaPath, '人设');
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    let seen = null; let engine;
    try {
      engine = createOwnEngine({ store, personaPath, budget: null,
        llm: { async chat(_messages, options) { seen = options.observation; return { text: '答', usage: null }; } } });
      await engine.initialize();
      const result = await engine.runTurn('k', '正常一句');
      assert.equal(result.text, '答');
      assert.ok(Number.isSafeInteger(seen.userTurnId) && seen.userTurnId > 0, '观测锚点必须是正整数 id');
      assert.equal(seen.resetId >= 0, true);
      const turns = store.conversationTurns('k');
      assert.equal(turns.length, 2, 'user 与 assistant 都要在库里');
      assert.equal(turns[0].id, seen.userTurnId, '观测里的 id 要真的指向那条 user 轮');
      assert.equal(JSON.parse(JSON.stringify(turns[1].meta)).userTurnId, seen.userTurnId, '助手轮的 meta 要带上同一个锚点');
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
