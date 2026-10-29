import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
// 迷你预算:触发线低到几轮就超,方便把"压缩失败"这条路径逼出来(数值只属于这条判据,不是生产预算)。
const BUDGET = Object.freeze({ triggerTokens: 120, keepRecentTokens: 20, summaryCapTokens: 40,
  hysteresisMarginTokens: 20, coldGapMs: 3_600_000, coldKeepTokens: 10 });
export function registerCompactionBackoffTests({ test, assert }) {
  test('压缩退避:摘要一直压不下去时**不许每轮付费**(失败后要有实质增长才再试)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-backoff-'));
    const personaPath = path.join(dir, 'persona.txt');
    fs.writeFileSync(personaPath, '人设'.repeat(5));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const summaryCalls = [];
    let engine;
    try {
      // 摘要一律返回**很长**的文本 ⇒ 既超上限(二层也超)又比被压段大 ⇒ 必然失败。
      engine = createOwnEngine({ store, personaPath, budget: BUDGET,
        llm: { async chat(messages) {
          const text = String(messages[0]?.content ?? '');
          if (/【旧摘要】|【待压缩的对话段】/.test(text)) {
            summaryCalls.push(text.length);
            return { text: '很长很长的摘要'.repeat(40), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
          }
          return { text: '她答了', usage: null };
        } } });
      await engine.initialize();
      // 先把历史喂到超线(每轮约 25 字,十来轮就过 120 的触发线)。
      for (let i = 0; i < 10; i += 1) await engine.runTurn('k', `第${i}句` + '内容'.repeat(8));
      const afterFirst = summaryCalls.length;
      assert.ok(afterFirst >= 1, '起码要尝试过一次压缩(否则这条判据没打中路径)');
      assert.ok(afterFirst <= 2, `第一次尝试最多两层(实际 ${afterFirst})——二层压缩只许做一遍`);
      // ⚠️ 这里断言的是**不变量**:失败之后,慢速增长的那十几个短轮**不该线性烧钱**。
      //    修好之前 `s.armed = true` ⇒ 水位还超线就每轮再压(每轮 1~2 次付费调用);
      //    现在只有"水位比失败那次长够了"才允许再试 —— 慢速增长时**顶多多试一次**。
      const beforeSlow = summaryCalls.length;
      for (let i = 0; i < 14; i += 1) await engine.runTurn('k', `短${i}`);
      const slowGrowthCalls = summaryCalls.length - beforeSlow;
      assert.ok(slowGrowthCalls <= 2,
        `14 个慢速增长的短轮里最多再试一次(=2 次调用),实际 ${slowGrowthCalls} 次 —— 这就是"每轮一次付费摘要"的那个洞`);
      // 塞一大段 ⇒ 水位实质增长 ⇒ 允许再试(退避不是"永远不试")。
      const before = summaryCalls.length;
      await engine.runTurn('k', '长'.repeat(3000));
      assert.ok(summaryCalls.length > before, '水位实质增长后允许再试 —— 退避不是"永远不试"');
      assert.ok(summaryCalls.length <= before + 2, `再试也要有界(实际 +${summaryCalls.length - before})`);
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('二层压缩:摘要区超上限时按 docs\\21 压一遍"摘要的摘要"，成功就落库并记两条账', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-layer2-'));
    const personaPath = path.join(dir, 'persona.txt');
    fs.writeFileSync(personaPath, '人设');
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    let layer2 = 0; let engine;
    try {
      engine = createOwnEngine({ store, personaPath, budget: BUDGET,
        llm: { async chat(messages) {
          const text = String(messages[0]?.content ?? '');
          const isSummary = /【旧摘要】|【待压缩的对话段】/.test(text);
          if (!isSummary) return { text: '她答了', usage: null };
          // 二层认法:**待压缩段以"她:"开头** ⇒ 那一段就是刚压出来的长摘要(第一层压的是真实轮次,以"用户:"开头)。
          const isLayer2 = /【待压缩的对话段】\n她: /.test(text);
          if (!isLayer2) return { text: '第一层'.repeat(30), usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
          layer2 += 1;
          return { text: '二层摘要', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
        } } });
      await engine.initialize();
      for (let i = 0; i < 6; i += 1) await engine.runTurn('k', `第${i}句` + '内容'.repeat(8));
      assert.equal(layer2, 1, '超上限时正好压一次二层(不多不少)');
      const saved = JSON.parse(store.getMeta('own-engine:v1:k'));
      assert.equal(saved.summary, '二层摘要', '落库的必须是二层压出来的那份');
      assert.equal(saved.compactFailAt, null, '成功就不该留失败现场');
      const layers = saved.compactionCalls.map((c) => c.layer);
      assert.deepEqual(layers.slice(0, 2), [1, 2], '两条账要按层序记下来');
      assert.equal(saved.coveredId > 0, true, '覆盖位要推进');
    } finally { await engine?.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
