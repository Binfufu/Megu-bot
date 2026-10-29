/**
 * **花费报表口径判据**(`scripts\admin-console.js usage report`;双审 Y8/Y9)。
 *
 * 跑法:
 *
 *     node scripts\selftest-usage-report.js
 *
 * 钉两件事:
 *   · Y8:D275 之前的历史行**没有 model 列**(迁移时如实 NULL,不回填)——
 *     它们不是"价目卡上缺了这个模型",必须单列成「历史行无模型」并说明会随窗口滚出;
 *     `unknownModels` 只放**真的卡外模型名**(否则人话让人去核一个不存在的模型名,白跑)。
 *   · Y9:`unknownCalls` 是个混装桶(completed 缺 usage / pending / cancelled / failed /
 *     账面不完整),人话与 payload 要**按原因拆开**;旧的 pending 要暴露年龄与笔数,
 *     但**不许**按时长改账、不许折零、不许当 failed。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteStateStore } from '../src/sqlite-store.js';

const SELF_FILE = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SELF_FILE));
const HOUR = 3_600_000;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-usage-report-'));
  const dbFile = path.join(dir, 'state.db');
  const store = new SqliteStateStore(dbFile);
  const at = Date.now();
  const complete = { promptTokens: 1000, completionTokens: 500, cacheHitTokens: 800, cacheMissTokens: 200 };

  // ① 可计价:卡内模型 + 账面完整
  const priced = store.startOwnLlmCall({ key: 'qqbot-group-u1', kind: 'reply', at });
  store.finishOwnLlmCall(priced, { status: 'completed', at: at + 1, model: 'deepseek-flash', usage: complete });
  // ② D275 之前的历史行:模型列如实 NULL
  const legacy = store.startOwnLlmCall({ key: 'qqbot-group-u2', kind: 'reply', at });
  store.finishOwnLlmCall(legacy, { status: 'completed', at: at + 1, usage: complete });
  // ③ 真的卡外模型
  const mystery = store.startOwnLlmCall({ key: 'qqbot-group-u3', kind: 'reply', at });
  store.finishOwnLlmCall(mystery, { status: 'completed', at: at + 1, model: 'mystery-model-v9', usage: complete });
  // ④ completed 但没 usage
  const noUsage = store.startOwnLlmCall({ key: 'qqbot-group-u4', kind: 'reply', at });
  store.finishOwnLlmCall(noUsage, { status: 'completed', at: at + 1, model: 'deepseek-flash', usage: null });
  // ⑤ failed(本来就没有可计费用量)
  const failed = store.startOwnLlmCall({ key: 'qqbot-group-u5', kind: 'reply', at });
  store.finishOwnLlmCall(failed, { status: 'failed', at: at + 1, model: 'deepseek-flash', usage: null });
  // ⑥ cancelled
  const cancelled = store.startOwnLlmCall({ key: 'qqbot-group-u6', kind: 'reply', at });
  store.finishOwnLlmCall(cancelled, { status: 'cancelled', at: at + 1, model: 'deepseek-flash', usage: null });
  // ⑦ pending 卡了 50 小时(只发起,没结算)
  const pending = store.startOwnLlmCall({ key: 'qqbot-group-u7', kind: 'summary', at: at - 50 * HOUR });
  // ⑧ 有账但不完整(只有 prompt)
  const incomplete = store.startOwnLlmCall({ key: 'qqbot-group-u8', kind: 'reply', at });
  store.finishOwnLlmCall(incomplete, { status: 'completed', at: at + 1, model: 'deepseek-flash', usage: { promptTokens: 10 } });

  return {
    dir,
    dbFile,
    store,
    ids: { priced, legacy, mystery, noUsage, failed, cancelled, pending, incomplete },
    cleanup() {
      try { store.close(); } catch { /* 已关 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runCli(args) {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'admin-console.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(out.stdout); } catch { /* 人话模式没有 JSON */ }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json };
}

test('Y8/Y9:历史无模型与卡外模型分开列,用量不明按原因拆开且 pending 只暴露年龄', () => {
  const seeded = seed();
  try {
    const run = runCli(['usage', 'report', '--days', '7', '--db', seeded.dbFile, '--json']);
    assert.equal(run.status, 0, run.stderr);
    const { engine } = run.json;

    assert.equal(engine.calls, 8, '八行都在窗内');
    assert.equal(engine.pricedCalls, 1, '只有一行真正折钱');

    // —— Y8 ——
    assert.equal(engine.legacyUnpriced, 1, 'Y8:D275 前历史行(无 model)单列,不混进 unknownModels');
    assert.deepEqual(engine.unknownModels, ['mystery-model-v9'], 'Y8:unknownModels 只放真的卡外模型名');
    const legacyRow = engine.byModel.find((one) => one.model.includes('历史'));
    assert.ok(legacyRow, 'Y8:历史行要有自己的分节名,不许叫"(模型未知)"让人去核不存在的模型');
    assert.equal(legacyRow.calls, 1);

    // —— Y9 ——
    assert.equal(engine.unknownCalls, 5, '没完整 usage 的五行仍是 unknown(不计零)');
    assert.deepEqual(
      { ...engine.byReason },
      { missingUsage: 1, incompleteUsage: 1, pending: 1, cancelled: 1, failed: 1 },
      'Y9:混装桶要按原因拆开(completed 缺账 / 账面不完整 / pending / cancelled / failed)',
    );
    const sum = Object.values(engine.byReason).reduce((n, v) => n + v, 0);
    assert.equal(sum, engine.unknownCalls, 'Y9:原因之和对得上 unknownCalls,不许悄悄漏行');
    assert.ok(engine.pendingOldestHours >= 49 && engine.pendingOldestHours < 51,
      `Y9:旧 pending 要暴露年龄,实际 ${engine.pendingOldestHours}`);
    assert.equal(engine.pendingOver24h, 1, 'Y9:超过 24 小时的 pending 笔数要能一眼看到');

    // pending 行**不许**被改账:状态与结束时刻都不动
    const row = seeded.store.handle.prepare('SELECT status, ended_at FROM own_llm_call WHERE id = ?').get(seeded.ids.pending);
    assert.equal(row.status, 'pending', 'Y9:只暴露,不许按时长把 pending 改成 failed/其它');
    assert.equal(row.ended_at, null, 'Y9:不许替它补结束时刻');

    // —— 复核§3.1:分组之和必须等于总量(同一份聚合口径;半截 usage 不许只进分组不进总量) ——
    const groupTokens = engine.byModel.reduce((n, one) => n + one.tokens, 0);
    assert.equal(groupTokens, engine.tokens.promptTokens + engine.tokens.completionTokens,
      `§3.1:按模型 tokens 之和 ${groupTokens} 必须等于总量 ${engine.tokens.promptTokens + engine.tokens.completionTokens}(半截 usage 行不许只在分组里出现)`);
    const dayTokens = engine.byDay.reduce((n, one) => n + one.tokens, 0);
    assert.equal(dayTokens, engine.tokens.promptTokens + engine.tokens.completionTokens,
      '§3.1:按天 tokens 之和也要对上总量');

    // —— 人话版 ——
    const human = runCli(['usage', 'report', '--days', '7', '--db', seeded.dbFile]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /历史行/, 'Y8:人话要说明历史行无模型,会随窗口滚出');
    assert.match(human.stdout, /随.{0,6}窗.{0,4}滚出/, 'Y8:要告诉操作者这不是"价目表缺模型",会自愈');
    assert.match(human.stdout, /pending/i, 'Y9:人话要把 pending 单列出来');
    assert.match(human.stdout, /5[01](\.\d+)? 小时|5[01]h/, 'Y9:旧 pending 的年龄要出现在人话里');
  } finally {
    seeded.cleanup();
  }
});

export function registerUsageReportTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerUsageReportTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
