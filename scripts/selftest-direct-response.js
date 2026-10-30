/** Direct-response rules must reach real turnNotes consumers, not a hand-built notes fixture.
 * Zero network: the end-to-end path uses the real own engine/client with fake fetch.
 * Standalone: node scripts/selftest-direct-response.js [--filter <name fragment>]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  DIRECT_RESPONSE_NOTES, SPOKEN_STANDING_NOTES,
  pickNudges, rememberNudges, withStyleNudge,
} from '../src/style.js';
import { getMoodTheme, splitSpokenLines } from '../src/mood.js';
import { composeModeNote, detectTurnMode, groupLinesForDelivery, noteGatesFor, outputPolicyFor } from '../src/turn-policy.js';
import { turnPolicyFor } from '../src/serious.js';
import { createOwnEngine } from '../src/engine.js';
import { createLlmClient, IMAGE_GROUNDING_NOTE } from '../src/llm.js';
import { SqliteStateStore } from '../src/sqlite-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readIndex = () => fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
const IMAGE = 'data:image/png;base64,QUJD';
const CONTROL = 'DIRECT-RESPONSE-CONSUMER-CONTROL';

// Preserve quoted literals (including import paths); remove comments before scanning imports.
// Only the static import prelude is scanned: no regex/template expression parser is needed.
function uncommentImportPrelude(source) {
  const prelude = source.slice(0, source.indexOf('\nconst '));
  return prelude.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (whole, quoted) => quoted ?? '');
}
function importsDirectResponse(source) {
  return [...uncommentImportPrelude(source).matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"]\.\/style\.js['"]/g)]
    .some((match) => match[1].split(',').some((binding) => binding.trim() === 'DIRECT_RESPONSE_NOTES'));
}
function sliceFunction(source, signature) {
  const begin = source.indexOf(signature);
  const end = source.indexOf('\n  /**', begin);
  assert.ok(begin >= 0 && end > begin, `production slice boundary: ${signature}`);
  return source.slice(begin, end);
}
function consumer({ source = readIndex(), theme = 'megumin', nudgeCount = 1, omitDirect = false } = {}) {
  const recallCalls = [];
  const sandbox = {
    ...(omitDirect ? {} : { DIRECT_RESPONSE_NOTES }),
    SPOKEN_STANDING_NOTES, pickNudges, rememberNudges,
    moodTheme: getMoodTheme(theme), recentNudges: [],
    detectTurnMode, composeModeNote, noteGatesFor, turnPolicyFor,
    lastTurnMode: new Map(), rememberTurnMode: () => {},
    config: { policy: {
      stats: { enabled: false }, growth: { enabled: false }, seriousGuard: true,
      style: { nudgeCount }, spoken: { enabled: true, maxChars: 60, emojiChance: 0 }, maxChars: 1500,
    } },
    pendingStoryFor: () => null, companyTurnNote: () => null,
    affinityNote: () => CONTROL,
    describeFishingScene: () => null, readFishing: () => null,
    panelPromptNote: () => null, describeLedgerForPrompt: () => null,
    conversationKeyFor: (message) => message.conversation,
    longTermNote: async (recall) => {
      recallCalls.push(recall);
      await Promise.resolve();
      return recall ? `RECALL-CONTROL:${recall.query}` : null;
    },
    claimNote: () => null, moodNotes: () => ['MOOD-LENGTH-CONTROL'],
    splitSpokenLines, groupLinesForDelivery, MAX_PASSIVE_SEQ: 5,
    maybeSpokenEmoji: () => null, recentSpokenEmoji: [], log: { info() {}, warn() {} },
  };
  const code = [
    sliceFunction(source, '  function nextNudges('),
    sliceFunction(source, '  async function turnNotes('),
    sliceFunction(source, '  function planSpokenLines('),
    '\n({ turnNotes, nextNudges, planSpokenLines })',
  ].join('\n');
  return { ...vm.runInNewContext(code, sandbox), recallCalls };
}
function occurrences(text, needle) {
  return text.split(needle).length - 1;
}
function assertRulesAtConsumer(a, prompt, label) {
  for (const note of DIRECT_RESPONSE_NOTES) {
    a.equal(occurrences(prompt, note), 1, `${label}: shared rule must arrive exactly once: ${note}`);
  }
  a.match(prompt, /本次表达要求，照做但不要念出来/);
  a.ok(prompt.includes(CONTROL), `${label}: companion control must also arrive`);
  a.doesNotMatch(prompt, /\[object Promise\]|policy-module-missing/);
}

export function registerDirectResponseTests({ test, assert: a = assert }) {
  test('直接回应/contract:真实共享常量冻结六条，图片边界、识别直答、明确复述例外和直接提问均有语义约束', () => {
    a.ok(Array.isArray(DIRECT_RESPONSE_NOTES));
    a.equal(DIRECT_RESPONSE_NOTES.length, 6);
    a.ok(Object.isFrozen(DIRECT_RESPONSE_NOTES));
    a.ok(DIRECT_RESPONSE_NOTES.every((note) => typeof note === 'string' && note.trim()));
    a.equal(new Set(DIRECT_RESPONSE_NOTES).size, 6);
    const [direct, image, detail, exceptions, silence, identify] = DIRECT_RESPONSE_NOTES;
    a.match(direct, /回答.*态度.*接话/);
    a.match(direct, /不先.*复述.*概括/);
    a.match(direct, /不先.*群聊/);
    a.match(direct, /括号里的动作不是固定开场/);
    a.match(direct, /不要求先写动作再说话/);
    a.match(direct, /有实际语境需要时仍可自然使用动作描写/);
    a.match(image, /图片.*共同上下文/);
    a.match(image, /直接回应/);
    a.match(image, /不先.*画面.*罗列物体.*重念.*图.*文字/);
    a.match(detail, /可以.*局部细节/);
    a.match(detail, /不要.*证明看懂/);
    for (const word of ['描述', '识别', '读字', '翻译', '总结', '复述', '原文照念', '引用', '消歧', '关键参数']) {
      a.ok(exceptions.includes(word), `explicit exception must be permitted: ${word}`);
    }
    a.match(exceptions, /明确要求/);
    a.match(exceptions, /不猜/);
    a.match(silence, /只有自发接话/);
    a.match(silence, /可以不发言/);
    a.match(silence, /被直接提问.*正常作答/);
    // 识别直答(2026-10-28 主人现场:角色图只回「还要再确认」):必须给最可能答案,不许拿
    // 「再确认/资料里没有记载」搪塞,且要写明防编造只管设定事实。
    a.match(identify, /识别/);
    a.match(identify, /最可能/);
    a.match(identify, /还要再确认/);
    a.match(identify, /资料里没有记载/);
    a.match(identify, /设定事实/);
    a.throws(() => DIRECT_RESPONSE_NOTES.push('mutation'), TypeError);
  });

  test('直接回应/wiring:真实import不靠注释喂绿，turnNotes开头复制规则且漏绑定立即暴露', async () => {
    const source = readIndex();
    a.ok(importsDirectResponse(source), 'index.js must really import DIRECT_RESPONSE_NOTES from style.js');
    const body = sliceFunction(source, '  async function turnNotes(');
    a.match(body, /\)\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\r\n]*\r?\n\s*)*const notes = \[\.\.\.DIRECT_RESPONSE_NOTES\];/,
      'shared notes must seed the real function before stats/random/task/serious gates');
    a.doesNotMatch(body, /typeof\s+DIRECT_RESPONSE_NOTES/, 'missing import is a wiring error, not a silent fallback');
    const missingImport = source.replace(/\bDIRECT_RESPONSE_NOTES\s*,\s*(?=[^}]*\}\s*from\s*['"]\.\/style\.js['"])/, '')
      .replace(/,\s*DIRECT_RESPONSE_NOTES(?=\s*\}\s*from\s*['"]\.\/style\.js['"])/, '');
    const commentBait = "// import { DIRECT_RESPONSE_NOTES } from './style.js';\n"
      + "/* import { DIRECT_RESPONSE_NOTES } from './style.js'; */\n";
    a.equal(importsDirectResponse(commentBait + missingImport), false,
      'line/block comments inside the scanned prelude cannot substitute for the real binding');
    await a.rejects(consumer({ omitDirect: true }).turnNotes(null, null), /DIRECT_RESPONSE_NOTES/,
      'real turnNotes must throw when the binding is missing');
  });

  test('直接回应/consumer:真实turnNotes+nextNudges+withStyleNudge的48格矩阵，规则独立于主题/随机/任务/严肃/图片/主动', async () => {
    const cases = [
      { name: 'chat', text: '你今天开心吗', mode: 'chat', random: true },
      { name: 'task', text: '帮我分析线程池死锁，给复现和修复步骤', mode: 'task', random: false },
      { name: 'knowledge', text: '光合作用是什么', mode: 'knowledge', random: false },
      { name: 'serious', text: '家人确诊癌症了，我很难受', mode: 'chat', random: false },
      { name: 'serious-knowledge', text: '解释一下癌症筛查原理', mode: 'knowledge', random: false },
      { name: 'proactive', text: '主动共同上下文', mode: 'chat', random: true, proactive: true },
    ];
    let checked = 0;
    for (const theme of ['megumin', 'aris']) for (const nudgeCount of [0, 1]) {
      for (const row of cases) for (const image of [false, true]) {
        const label = `${theme}/${nudgeCount}/${row.name}/${image ? 'image' : 'text'}`;
        const run = consumer({ theme, nudgeCount });
        const userFingerprint = `USER-BODY-CONTROL:${label}`;
        const message = row.proactive ? null : { content: row.text, conversation: label, images: image ? [IMAGE] : [] };
        const recall = row.proactive ? { conversation: label, query: row.text } : null;
        const notes = await run.turnNotes(null, message, [], recall, { hasImage: image });
        a.deepEqual(Array.from(notes).slice(0, DIRECT_RESPONSE_NOTES.length), [...DIRECT_RESPONSE_NOTES], `${label}: first notes are shared rules`);
        a.notEqual(notes, DIRECT_RESPONSE_NOTES, 'each turn gets its own mutable array');
        a.equal(detectTurnMode(message?.content ?? '').mode, row.mode);
        const prompt = withStyleNudge(`${userFingerprint}\n${row.text}`, notes);
        assertRulesAtConsumer(a, prompt, label);
        a.equal(occurrences(prompt, userFingerprint), 1, `${label}: real user text control remains`);
        a.ok(prompt.includes(`RECALL-CONTROL:${row.text}`), `${label}: awaited recall reaches same consumer`);
        a.equal(run.recallCalls.length, 1);
        a.equal(run.recallCalls[0].conversation, label);
        a.equal(run.recallCalls[0].query, row.text);
        const pool = getMoodTheme(theme).styleNudges;
        a.equal(notes.filter((note) => pool.includes(note)).length, row.random ? nudgeCount : 0,
          `${label}: real random styles are gated independently`);
        for (const note of SPOKEN_STANDING_NOTES) a.equal(notes.includes(note), row.random,
          `${label}: existing standing-style gate is unchanged`);
        a.equal(prompt.includes('本轮口径'), row.mode !== 'chat');
        a.equal(prompt.includes('严肃话题'), row.name === 'serious');
        a.equal(prompt.includes('MOOD-LENGTH-CONTROL'), row.random);
        checked += 1;
      }
    }
    a.equal(checked, 48);
  });

  test('直接回应/negative:只在内存破坏真实turnNotes接线，消费端必须发现规则丢失', async () => {
    const source = readIndex();
    const broken = source.replace('const notes = [...DIRECT_RESPONSE_NOTES];', 'const notes = [];');
    a.notEqual(broken, source, 'mutation must hit actual seed, not a synthetic fixture');
    const run = consumer({ source: broken });
    const notes = await run.turnNotes(null, { content: '你今天开心吗', conversation: 'negative' });
    const prompt = withStyleNudge('USER-NEGATIVE-CONTROL', notes);
    a.match(prompt, /USER-NEGATIVE-CONTROL/);
    a.match(prompt, /DIRECT-RESPONSE-CONSUMER-CONTROL/);
    a.throws(() => assertRulesAtConsumer(a, prompt, 'broken-production-slice'), /shared rule must arrive/,
      'removing production seed must fail the same consumer assertion while controls survive');
  });

  test('直接回应/engine:真实own+LLM假fetch请求同有规则和用户指纹，接地不变，一轮一调用，明确复述原样保留', async () => {
    const indexDir = path.join(ROOT, 'data', 'index');
    fs.mkdirSync(indexDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(indexDir, 'selftest-direct-response-'));
    a.equal(path.dirname(dir), indexDir, 'temporary stores must stay in this isolated worktree');
    let store, engine;
    try {
      store = new SqliteStateStore(path.join(dir, 'state.db'));
      const personaPath = path.join(dir, 'persona.txt');
      fs.writeFileSync(personaPath, '这是直接回应本地测试的人设对照：PERSONA-CONTROL。', 'utf8');
      const requests = [];
      let answer = '';
      const llm = createLlmClient({ baseUrl: 'https://invalid.test/v1', apiKey: 'local-fake-only', model: 'fake',
        attempts: 1, log: {}, fetchImpl: async (url, init) => {
          a.equal(url, 'https://invalid.test/v1/chat/completions');
          requests.push(JSON.parse(init.body));
          return { ok: true, status: 200, json: async () => ({
            choices: [{ message: { content: answer }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          }) };
        } });
      engine = createOwnEngine({ store, personaPath, llm, budget: null, log: {} });
      await engine.initialize();
      const rows = [
        { theme: 'megumin', text: '你今天开心吗', image: false, output: '挺开心的。' },
        { theme: 'aris', text: '这张图也太好笑了吧', image: true, output: '这一下没绷住。' },
        { theme: 'megumin', text: '帮我把以下原文照念，保留标点与换行：第一行；\n第二行。', image: false,
          output: '第一行；\n第二行。', repeat: true },
        { theme: 'aris', text: '帮我读图中文字并原文复述，保留标点与换行。', image: true,
          output: '图中文字：\n第一行：参数=7；\n第二行。', repeat: true },
      ];
      for (const [i, row] of rows.entries()) {
        const run = consumer({ theme: row.theme, nudgeCount: i % 2 });
        const key = `direct-response-local-${i}`;
        const userFingerprint = `USER-HTTP-CONTROL-${i}`;
        const message = { content: row.text, conversation: key, images: row.image ? [IMAGE] : [] };
        const prompt = withStyleNudge(`${userFingerprint}\n${row.text}`,
          await run.turnNotes(null, message, [], null, { hasImage: row.image }));
        answer = row.output;
        const before = requests.length;
        const result = await engine.runTurn(key, prompt, 5000, row.image ? [IMAGE] : []);
        a.equal(requests.length - before, 1, 'one model request; no rewrite/summary/extra call');
        const request = requests.at(-1);
        const finalUser = request.messages.at(-1);
        a.equal(finalUser.role, 'user');
        const text = typeof finalUser.content === 'string' ? finalUser.content
          : finalUser.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        assertRulesAtConsumer(a, text, key);
        a.equal(occurrences(text, userFingerprint), 1, 'user body and rules reach the same actual HTTP user message');
        a.ok(text.includes(row.text));
        a.ok(JSON.stringify(request.messages).includes('PERSONA-CONTROL'), 'stable persona control survives engine assembly');
        if (row.image) {
          a.deepEqual(finalUser.content, [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: IMAGE } },
            { type: 'text', text: IMAGE_GROUNDING_NOTE },
          ], 'existing image blocks/order/grounding remain untouched');
          a.match(IMAGE_GROUNDING_NOTE, /必须以这些图片为准作答/);
          a.match(IMAGE_GROUNDING_NOTE, /不许用记忆里的旧图回答/);
        } else a.equal(typeof finalUser.content, 'string');
        a.equal(result.text, row.output, 'prompt policy must not rewrite or suppress model output');
        a.equal(result.timedOut, false);
        a.equal(store.conversationTurns(key).at(-1).content, row.output, 'stored assistant text remains byte-for-byte');
        if (row.repeat) {
          const mode = detectTurnMode(row.text).mode;
          a.equal(outputPolicyFor(mode).preserveFormatting, true);
          const spoken = await run.planSpokenLines(result.text, null, {
            preserveFormatting: outputPolicyFor(mode).preserveFormatting,
          });
          a.equal(spoken.join('\n'), row.output, 'real delivery slice retains explicitly requested repetition');
        }
      }
      a.equal(requests.length, 4);
    } finally {
      if (engine) await engine.stop();
      if (store) store.close();
      // dir was created above under the checked worktree data/index parent, never production paths.
      a.equal(path.dirname(dir), indexDir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  const tests = [];
  registerDirectResponseTests({ test: (name, fn) => tests.push({ name, fn }), assert });
  const filterAt = process.argv.indexOf('--filter');
  const filter = filterAt >= 0 ? process.argv[filterAt + 1] : '';
  if (filterAt >= 0 && !filter) throw new Error('--filter requires a name fragment');
  const selected = tests.filter(({ name }) => !filter || name.includes(filter));
  if (!selected.length) throw new Error(`no direct-response tests matched: ${filter}`);
  let failed = 0;
  for (const { name, fn } of selected) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (error) { failed += 1; process.stdout.write(`FAIL  ${name}\n${error?.stack ?? error}\n`); }
  }
  process.stdout.write(`\n${selected.length - failed}/${selected.length} passed\n`);
  process.exitCode = failed ? 1 : 0;
}
