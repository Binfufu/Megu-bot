/** P0: run existing focused offline regressions plus fixed legacy golden.
 * Not the private full-suite runner and not model/persona semantic evaluation.
 *
 * ⚠️ 2026-10-30 有意兼容例外（主人拍板「取消机械句前口头禅」）：`buildMoodNote` 不再写
 *    「语气词用「X」」，因此**旧 golden 的 `mood-note` 用例必然不同**。旧 golden 原件
 *    （`chat-style-legacy-golden.mjs` + `fixtures/chat-style-legacy-v1.json`）**一个字节不改**，
 *    也不重录；这里逐案对拍，只豁免这一个已登记的差异，并要求：
 *      · 差异集合**恰好等于**登记项（多一个差异就红，不能悄悄扩大）；
 *      · 该案的新输出 = 旧预期**只删掉那一句语气词要求**（其他字符逐字相同）；
 *      · 绕过生产 planner 的内存反证仍必须被判据抓住。
 *    新语义的正向基线见 `fixtures/chat-style-natural-v1.json` 的 `legacyCompat`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTurnPolicyTests } from './selftest-turn-policy.js';
import { registerDirectResponseTests } from './selftest-direct-response.js';
import { snapshot } from './chat-style-legacy-golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_FILE = path.join(ROOT, 'scripts/fixtures/chat-style-legacy-v1.json');
/** 已登记的有意差异（每条必须给出原因；不允许用通配/前缀）。 */
const INTENTIONAL_DIFFS = Object.freeze([
  { id: 'mood-note', why: '去机械化：不再强制「语气词用「X」」（2026-10-30 主人拍板）' },
]);

export async function runBaseline() {
  const cases = [];
  const test = (name, run) => cases.push([name, run]);
  registerTurnPolicyTests({ test, assert });
  registerDirectResponseTests({ test, assert });
  test('legacy golden: 只允许已登记的去机械化差异，其余逐字不变', () => {
    const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
    const actual = snapshot();
    // ① 结构相同（案例 id 与顺序）
    assert.deepEqual(actual.cases.map((one) => one.id), expected.cases.map((one) => one.id), '案例清单不许变');
    assert.equal(actual.schemaVersion, expected.schemaVersion);
    assert.equal(actual.seed, expected.seed);
    // ② 差异集合必须**恰好**等于登记项
    const diffs = expected.cases
      .map((one, index) => JSON.stringify(one) === JSON.stringify(actual.cases[index]) ? null : one.id)
      .filter(Boolean);
    assert.deepEqual(diffs, INTENTIONAL_DIFFS.map((one) => one.id), `未登记的 golden 差异:${diffs.join(',')}`);
    // ③ 被豁免的那一案：只差那句语气词要求，其余逐字一致
    const expectedNote = expected.cases.find((one) => one.id === 'mood-note').output;
    const actualNote = actual.cases.find((one) => one.id === 'mood-note').output;
    assert.equal(typeof expectedNote, 'string');
    assert.ok(expectedNote.includes('语气词用「'), '旧基线应仍含旧的强制语气词（原件不许改）');
    assert.equal(actualNote, expectedNote.replace(/；语气词用「[^」]*」/, ''),
      '去机械化后应只少那一句语气词要求，其余逐字相同');
    assert.doesNotMatch(actualNote, /语气词用/, '新语义不再强制语气词');
  });
  test('legacy golden: 绕过生产 planner 的内存反证仍必须红', () => {
    const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
    assert.throws(() => assert.deepEqual(snapshot({ mutate: true }), expected),
      '负对照必须抓出绕过生产 planner 的变异');
  });
  const results = [];
  for (const [name, run] of cases) {
    try { await run(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message ?? 'error') }); }
  }
  return { scope: 'focused-baseline-not-full-suite', passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runBaseline();
  const args = process.argv.slice(2);
  if (args.length) {
    assert.equal(args[0], '--out'); assert.equal(args.length, 2);
    fs.writeFileSync(path.resolve(args[1]), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.failed ? 1 : 0;
}
