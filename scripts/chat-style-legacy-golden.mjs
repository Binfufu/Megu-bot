/** P0 compatibility: deterministic formatting/planning only, never the known lifecycle bugs.
 * Reuses the existing selftest-turn-policy production-closure VM harness, not a second formatter.
 * PRNG: reuses scripts/selftest-play.js seededRandom (0408103 baseline), Numerical Recipes
 * LCG a=1664525,c=1013904223, modulo 2^32; Math.imul makes integer arithmetic explicit.
 * Reference: https://www.nr.com/ (Numerical Recipes, asOf 2026-10-30); test-only seed.
 * node scripts/chat-style-legacy-golden.mjs --verify
 * Capture is exclusive and must target a NEW reviewed fixture, never overwrite a baseline.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildMoodNote, maybeSpokenEmoji, splitSpokenLines } from '../src/mood.js';
import { groupLinesForDelivery } from '../src/turn-policy.js';
import { DEMO_STYLE_NUDGES, SPOKEN_STANDING_NOTES, breakBeforeKaomoji, pickNudges, rememberNudges } from '../src/style.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = path.join(ROOT, 'scripts/fixtures/chat-style-legacy-v1.json');
const SEED = 20261030;
function seeded(fn) {
  let state = SEED >>> 0;
  const saved = Math.random;
  Math.random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  try { return fn(); } finally { Math.random = saved; }
}
function planner({ enabled = true, emojiChance = 0, maxChars = 20, wire = 'production' } = {}) {
  const source = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
  const start = source.indexOf('  function planSpokenLines(');
  const end = source.indexOf('\n  /**', start);
  assert.ok(start >= 0 && end > start, 'production planner boundary missing');
  const body = wire === 'mutation' ? 'function planSpokenLines(text) { return [text]; }' : source.slice(start, end);
  return vm.runInNewContext(body + '\nplanSpokenLines', {
    config: { policy: { spoken: { enabled, maxChars, emojiChance }, maxChars: 40 } },
    splitSpokenLines, groupLinesForDelivery, MAX_PASSIVE_SEQ: 5,
    maybeSpokenEmoji, recentSpokenEmoji: [], Math,
    log: { info() {}, warn() {} },
  });
}
export function snapshot({ mutate = false } = {}) {
  return seeded(() => {
    const run = planner({ wire: mutate ? 'mutation' : 'production' });
    const cases = [
      ['sentences', '好呀。明天再见！'],
      ['question', '这次到了吗？我还在等。'],
      ['pauses', '蓝色，或者绿色：你来挑。'],
      ['paragraphs', '第一段说完了。\n\n第二段另说。'],
      ['url', '看 https://example.invalid/a?x=1&y=2。然后回来。'],
      ['code', '```js\nconst x = { a: 1, b: 2 };\nconsole.log(x);\n```'],
      ['face', '可以呀 (￣ω￣;)。这下放心了。'],
      ['numbers', '12:30 见，带上 1,000 个样品。'],
      ['long-unbroken', '一'.repeat(75)],
      ['line-budget', '甲。乙。丙。丁。戊。己。庚。'],
      ['empty', '   \n'],
      ['whitespace', '  第一项\t第二项  \n  第三项  '],
      ['long-soft', '先去看一眼窗外的天气，再带上桌面上的雨伞，然后就可以放心出门了。'],
    ].map(([id, input]) => ({ id, input, output: Array.from(run(input, null)) }));
    cases.push({ id: 'decision-length', output: Array.from(run('先去看看门口，再回到座位，然后把笔记写完。', { maxChars: 8 })) });
    const faithful = '解释：\n```json\n{ "a": 1, "b": 2 }\n```\n最后一行。';
    cases.push({ id: 'preserve-format', input: faithful, output: Array.from(run(faithful, null, { preserveFormatting: true })) });
    cases.push({ id: 'disabled', output: Array.from(planner({ enabled: false })(' 原样。\n\n 原样！', null)) });
    const emojiRun = planner({ emojiChance: 1 });
    cases.push({ id: 'seeded-emoji-sequence', output: Array.from({ length: 4 }, () => Array.from(emojiRun('收到。待会儿见。', null))) });
    let recent = [];
    const draws = Array.from({ length: 6 }, () => {
      const picked = pickNudges(2, recent, DEMO_STYLE_NUDGES);
      recent = rememberNudges(recent, picked);
      return picked;
    });
    cases.push({ id: 'seeded-neutral-nudges', output: draws });
    cases.push({ id: 'standing-notes', output: [...SPOKEN_STANDING_NOTES] });
    cases.push({ id: 'mood-note', output: buildMoodNote({ mood: 'plain', label: '合成平静', maxSentences: 2, maxChars: 38, interjection: '唔', kaomoji: '(・_・)' }) });
    cases.push({ id: 'kaomoji-width', output: breakBeforeKaomoji('这是一句用于检查气泡宽度的原创合成文字 (￣▽￣)', { maxWidth: 32 }) });
    return { schemaVersion: 1, scope: 'legacy-format-and-planning-only; no lifecycle/classification golden', seed: SEED, cases };
  });
}
export function verifyGolden(file = DEFAULT) {
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  const actual = snapshot();
  assert.deepEqual(actual, expected);
  assert.throws(() => assert.deepEqual(snapshot({ mutate: true }), expected), 'negative control must detect bypassed production planner');
  return { passed: actual.cases.length + 1, failed: 0, cases: actual.cases.length, negativeControls: 1 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 2 && argv[0] === '--capture') {
      const out = path.resolve(argv[1]);
      assert.ok(out.startsWith(path.join(ROOT, 'scripts', 'fixtures') + path.sep), 'capture only into fixture directory');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(snapshot(), null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ captured: true, cases: snapshot().cases.length }));
    } else {
      assert.ok(argv.length === 0 || (argv.length === 1 && argv[0] === '--verify'), 'invalid arguments');
      console.log(JSON.stringify(verifyGolden()));
    }
  } catch { console.error('LEGACY_GOLDEN_FAILED'); process.exitCode = 1; }
}
