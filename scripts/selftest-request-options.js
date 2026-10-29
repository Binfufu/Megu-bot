import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { createLlmClient } from '../src/llm.js';
export function registerRequestOptionsTests({ test, assert }) {
  test('own采样:真实engine到HTTP体显式high/256000，缺省不变且配置快照不可漂移', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-sampling-'));
    const personaPath = path.join(dir, 'persona.txt'); fs.writeFileSync(personaPath, 'sampling-control-persona');
    const store = new SqliteStateStore(path.join(dir, 'state.db')); const bodies = []; let engine;
    const llm = createLlmClient({ baseUrl: 'https://offline.invalid', apiKey: 'offline', model: 'deepseek-flash', attempts: 1,
      fetchImpl: async (_url, request) => { bodies.push(JSON.parse(request.body)); return new Response(JSON.stringify({ choices: [{ message: { content: 'offline answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200 }); } });
    try {
      const requestOptions = { reasoningEffort: 'high', maxTokens: 256000 };
      engine = createOwnEngine({ store, personaPath, llm, budget: null, requestOptions });
      requestOptions.maxTokens = 1; requestOptions.reasoningEffort = 'off';
      await engine.initialize(); await engine.runTurn('diagnostic', 'sampling-user-control');
      assert.equal(bodies[0].model, 'deepseek-flash'); assert.equal(bodies[0].max_tokens, 256000);
      assert.deepEqual(bodies[0].thinking, { type: 'enabled' }); assert.equal(bodies[0].reasoning_effort, 'high');
      assert.ok(bodies[0].messages[0].content.includes('sampling-control-persona'));
      assert.equal(bodies[0].messages.at(-1).content, 'sampling-user-control');
      assert.equal(store.conversationTurns('diagnostic').at(-1).content, 'offline answer');
      await engine.stop(); engine = createOwnEngine({ store, personaPath, llm, budget: null });
      await engine.initialize(); await engine.runTurn('default', 'default control');
      assert.equal('max_tokens' in bodies[1], false); assert.equal('thinking' in bodies[1], false); assert.equal('reasoning_effort' in bodies[1], false);
      for (const effort of ['off', 'low', 'max']) {
        await llm.chat([{ role: 'user', content: effort }], { reasoningEffort: effort });
        const body = bodies.at(-1); assert.equal(body.thinking.type, effort === 'off' ? 'disabled' : 'enabled');
        assert.equal(body.reasoning_effort, effort === 'off' ? undefined : effort);
      }
      const before = bodies.length;
      for (const bad of [{ reasoningEffort: 'medium' }, { reasoningEffort: null }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: '256000' }, null]) {
        await assert.rejects(llm.chat([], bad));
        assert.throws(() => createOwnEngine({ store, personaPath, llm, requestOptions: bad }));
      }
      assert.throws(() => createOwnEngine({ store, personaPath, llm, requestOptions: { model: 'other' } }));
      assert.equal(bodies.length, before, 'invalid sampling must never cross fetch boundary');
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
