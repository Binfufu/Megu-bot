import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { extractIntake, rejectsIntake, resolveIntake, narrateMeal } from '../src/stats.js';
import { getBodyTheme } from '../src/body-theme.js';

export function registerIntakeSettlementTests({ test, assert }) {
  test('进食生产消费:真实settleIntake补动作行无const错误，SQLite单次结算且拒绝不入账', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const start = source.indexOf('  function settleIntake(');
    const end = source.indexOf('\n  /**', start);
    assert.ok(start >= 0 && end > start, 'must execute actual production function, never a rewritten fixture');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-consumer-'));
    const store = new SqliteStateStore(path.join(dir, 'state.db'));
    const logs = [], errors = [], deltas = [], affinity = [];
    let applications = 0;
    const context = {
      config: { policy: { stats: { enabled: true, theme: 'megumin' }, warmup: { sleep: null } } },
      extractIntake, rejectsIntake, resolveIntake, narrateMeal, getBodyTheme,
      stateStore: { applyIntake(...args) { applications++; return store.applyIntake(...args); } },
      recordStatDeltas: event => deltas.push(event),
      log: { info: text => logs.push(text), warn: text => logs.push(text), error: (...args) => errors.push(args) },
      BAD_FOOD_RE: /发霉|过期/, tryCatchIllness() { throw new Error('unexpected illness'); },
      bumpAffinity: (...args) => affinity.push(args),
    };
    try {
      const settle = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', context);
      const message = { scene: 'c2c', senderId: 'isolated', content: '', images: ['image-control'] };
      const raw = '嗯…还不错，勉强收下。\n\n不愧是我，眼光一向准。\n\n<intake food="小食" kcal="150" health="+4" mood="+4"/>';
      const result = settle(raw, message);
      assert.equal(applications, 1, 'post-settlement narration must never reapply food');
      assert.equal(errors.length, 0, 'caught errors are failures too: ' + errors.map(row => row.map(String).join(' ')).join(';'));
      assert.ok(result.includes('小食'), 'actual returned outbound text must contain meal narration');
      assert.ok(!result.includes('<intake'), 'machine markup must not reach outbound');
      assert.ok(logs.some(row => row.includes('替她补了一句动作行')));
      assert.equal(deltas.length, 2, 'meal and fed deltas preserved');
      assert.equal(affinity.length, 1);
      const rejected = settle('这不是食物。<intake reject/>', message);
      assert.equal(applications, 1, 'model reject with image must not apply food');
      assert.ok(!rejected.includes('<intake'));
      context.config.policy.stats.enabled = false;
      assert.equal(settle(raw, message), raw, 'disabled policy remains unchanged');
      assert.equal(applications, 1);
    } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
