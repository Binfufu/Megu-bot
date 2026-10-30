/**
 * P0/F1 consumer RED gate. All prose/identifiers below are independently synthetic.
 * Run: node scripts/selftest-chat-input-lifecycle.mjs
 * Optional: --characterize prints the SAME failures but exits 0 for diagnostics only.
 * No expected-failure inversion, source-code assertions, production config/data,
 * real model, HTTP server, QQ, or private chat corpus. Shared runner invokes this
 * strict CLI in an isolated child so the global guard never affects other suites.
 * 边界说明:经 style/turn-policy 的静态依赖会加载仓内 content 加载器（C 区项目内容，
 * 非私密语料，且本文件不写不改）；除假 LLM 与临时库外不接触任何用户数据。
 * Real own engine + SqliteStateStore(':memory:') + E-drive restart state files +
 * real memory schema/archive/providers. Only llm.chat is replaced.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';

const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--characterize'), 'only --characterize is accepted');
const characterize = args.includes('--characterize');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_PARENT = path.resolve(ROOT, '..');
assert.match(TEMP_PARENT, /^E:[\\/]/i, 'temporary files must be on E:');
// Block transport BEFORE importing project modules. Guard failures are never a green gate.
let blocked = 0;
const deny = () => { blocked++; throw Object.assign(new Error('LIFECYCLE_NETWORK_OR_PROCESS_DENIED'), { code: 'LIFECYCLE_DENIED' }); };
for (const [object, keys] of [
  [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']],
  [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']],
  [dgram, ['createSocket']], [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
]) for (const key of keys) object[key] = deny;
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };
syncBuiltinESMExports();
assert.throws(() => globalThis.fetch('https://synthetic.invalid'), { code: 'LIFECYCLE_DENIED' });
assert.throws(() => net.connect(443, 'synthetic.invalid'), { code: 'LIFECYCLE_DENIED' });
const guardProbes = blocked;
blocked = 0;

const { createOwnEngine } = await import('../src/engine.js');
const { SqliteStateStore } = await import('../src/sqlite-store.js');
const { wrapInject } = await import('../src/inject-mark.js');
const { withStyleNudge, withFacts } = await import('../src/style.js');
const { composeModeNote } = await import('../src/turn-policy.js');
const { archiveOwnHistory } = await import('../src/own-memory-archive.js');
const { openMemory, makeHandoffProvider, makeLongTermProvider, conversationMemory,
  buildSummaryInput, summarizeConversation, saveSummary, ensureFtsSchema, indexTurnFts, saveEmbedding,
  embeddingBacklog, ownDerivedProjectionReady, turnsMentioningEntities } = await import('../src/memory-store.js');
const { startMemoryArchive } = await import('../src/memory-archive-tick.js');
const { isHumanTurn } = await import('../src/memory-archive.js');

const { log } = await import('../src/log.js');
log.setLevel('error'); // isolated process only, no sink or production logging config
const SILENT = { info() {}, warn() {}, debug() {}, error() {} };
const TITLE = '（本次表达要求，照做但不要念出来：）';
const TASK = composeModeNote('task'); // real producer's exemption, not a guessed substring
assert.ok(TASK?.length > 0, 'task note producer must return a note');
const TASK_FP = '这一轮不受角色卡里';
const REPLY = '助手事实：蓝色钥匙已归还。';
const SUMMARY_REPLY = '合成摘要：钥匙归还。';
const rows = [];
const fingerprints = [];
let fakeCalls = 0;
let fixtureRoot;

function check(id, actual, expected, detail = '') {
  const pass = Object.is(actual, expected);
  rows.push({ id, pass, actual, expected, detail });
  const show = value => typeof value === 'string' && value.length > 240 ? `[${value.length} synthetic chars]` : JSON.stringify(value);
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} actual=${show(actual)} expected=${show(expected)}${detail ? ` ${detail}` : ''}`);
}
function count(text, needle) { return String(text).split(needle).length - 1; }
function messageText(call) {
  assert.ok(call && Array.isArray(call.messages) && call.messages.length > 0, 'consumer capture must not be empty');
  return call.messages.map(message => typeof message.content === 'string' ? message.content :
    message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n');
}
function fp(id, call, needle, expected) {
  const actual = count(messageText(call), needle);
  fingerprints.push({ id, needle, actual, expected, kind: call.kind, messageCount: call.messages.length });
  check(id, actual, expected, `consumer=${call.kind} messages=${call.messages.length}`);
}
function snapshot(store, key) { return JSON.stringify(store.conversationTurns(key)); }
function legacy(body, notes) { return `${body}\n\n${TITLE}\n${notes.map(note => `· ${note}`).join('\n')}`; }
function seed(store, key, content, rawText = content) {
  const user = store.appendConversationTurn({ key, role: 'user', content, at: 1_798_500_000_000,
    meta: { source: 'own-engine', scene: 'world', resetId: 0, rawText } });
  store.appendConversationTurn({ key, role: 'assistant', content: REPLY, at: 1_798_500_000_001,
    meta: { source: 'own-engine', scene: 'world', resetId: 0, userTurnId: user } });
  return user;
}
const BUDGET = Object.freeze({ triggerTokens: 500, keepRecentTokens: 1, coldKeepTokens: 1,
  summaryCapTokens: 200, hysteresisMarginTokens: 10, coldGapMs: 1 }); // test-only stress values

async function fixture(name, run) {
  const dir = path.join(fixtureRoot, name);
  fs.mkdirSync(dir);
  const personaPath = path.join(dir, 'persona.txt');
  fs.writeFileSync(personaPath, '你是原创合成验收助手，不调用工具。', 'utf8');
  const stateFile = path.join(dir, 'state.sqlite');
  const stores = [];
  const engines = [];
  const databases = [];
  const memory = () => { const db = openMemory(':memory:'); databases.push(db); return db; };
  const store = (disk = false) => { const s = new SqliteStateStore(disk ? stateFile : ':memory:'); stores.push(s); return s; };
  async function engine(s, { budget = null, handoff = null, failSummary = false } = {}) {
    const calls = [];
    const e = createOwnEngine({ store: s, personaPath, budget, handoff, log: SILENT,
      now: () => 1_798_500_001_000,
      llm: { async chat(messages, options = {}) {
        const kind = options.observation ? 'main' : 'summary';
        calls.push({ messages: structuredClone(messages), kind }); fakeCalls++;
        if (kind === 'summary' && failSummary) throw new Error('SYNTHETIC_SUMMARY_FAILURE');
        return { text: kind === 'main' ? REPLY : SUMMARY_REPLY, usage: null, model: 'synthetic-fixed-no-transport' };
      } } });
    engines.push(e); await e.initialize(); return { e, calls };
  }
  try { await run({ dir, stateFile, store, engine, memory }); }
  finally {
    for (const e of engines) await e.stop();
    for (const s of stores) s.close();
    for (const db of databases) db.close();
  }
}

async function liveProducer() {
  await fixture('live', async ({ store, engine }) => {
    const s = store(); const { e, calls } = await engine(s); const key = 'qqbot-group-live';
    const body = 'USER_LIVE：我把蓝色钥匙放回原处。FACT_LIVE：周六归还。';
    const input = withStyleNudge(withFacts(body, ['FACT_INJECT_LIVE：本轮网页绑定。']),
      ['这次仅本轮使用 NOTE_LIVE。', TASK, wrapInject('recall', 'RECALL_LIVE'), wrapInject('kb', 'KB_LIVE')]);
    await e.runTurn(key, input, 5000);
    const before = snapshot(s, key);
    for (const needle of ['NOTE_LIVE', TASK_FP, 'FACT_INJECT_LIVE', 'RECALL_LIVE', 'KB_LIVE'])
      fp(`live.current.${needle}`, calls.at(-1), needle, 1);
    await e.runTurn(key, 'CURRENT_LIVE：现在聊盆栽。', 5000);
    for (const needle of ['NOTE_LIVE', TASK_FP, 'FACT_INJECT_LIVE', 'RECALL_LIVE', 'KB_LIVE'])
      fp(`live.next.${needle}`, calls.at(-1), needle, 0);
    for (const needle of [body, REPLY, 'CURRENT_LIVE']) fp(`live.keep.${needle.split('：')[0]}`, calls.at(-1), needle, 1);
    check('live.append-only', JSON.stringify(s.conversationTurns(key).slice(0, 2)), before);
  });
}

async function oldFormats() {
  for (const reliableRaw of [true, false]) await fixture(`legacy-${reliableRaw}`, async ({ store, engine }) => {
    const s = store(); const key = `qqbot-group-legacy-${reliableRaw}`;
    const body = `USER_LEGACY_${reliableRaw}：纸飞机在窗边。FACT_LEGACY_${reliableRaw}：约好周日取回。`;
    const input = legacy(body, [`这次只用 LEGACY_NOTE_${reliableRaw}。`, TASK]);
    seed(s, key, input, reliableRaw ? body : input);
    const before = snapshot(s, key); const { e, calls } = await engine(s);
    await e.runTurn(key, 'CURRENT_LEGACY：接着聊新话题。', 5000);
    fp(`legacy.${reliableRaw}.note-exits`, calls.at(-1), `LEGACY_NOTE_${reliableRaw}`, 0);
    fp(`legacy.${reliableRaw}.task-exits`, calls.at(-1), TASK_FP, 0);
    fp(`legacy.${reliableRaw}.body-fact-kept`, calls.at(-1), body, 1);
    check(`legacy.${reliableRaw}.append-only`, JSON.stringify(s.conversationTurns(key).slice(0, 2)), before);
  });
}

async function mixedRestartReset() {
  await fixture('restart-reset', async ({ store, engine }) => {
    let s = store(true); const key = 'qqbot-group-restart';
    const oldBody = 'USER_OLD_DISK：铜铃已交还。FACT_OLD_DISK：下周三见。';
    seed(s, key, legacy(oldBody, ['这次 OLD_DISK_NOTE。', TASK]));
    let active = await engine(s);
    const newBody = 'USER_NEW_DISK：绿围巾在柜里。FACT_NEW_DISK：周五取走。';
    await active.e.runTurn(key, `${newBody}\n${wrapInject('notes', 'NEW_MARKED_NOTE')}\n${wrapInject('recall', 'NEW_MARKED_RECALL')}`, 5000);
    const before = snapshot(s, key);
    await active.e.stop(); s.close();
    s = store(true); active = await engine(s);
    await active.e.runTurn(key, 'CURRENT_REOPEN：重开后的问候。', 5000);
    for (const needle of ['OLD_DISK_NOTE', TASK_FP, 'NEW_MARKED_NOTE', 'NEW_MARKED_RECALL'])
      fp(`restart.exit.${needle}`, active.calls.at(-1), needle, 0);
    for (const needle of [oldBody, newBody]) fp(`restart.keep.${needle.split('：')[0]}`, active.calls.at(-1), needle, 1);
    check('restart.append-only', JSON.stringify(s.conversationTurns(key).slice(0, 4)), before);
    const preReset = snapshot(s, key);
    active.e.resetConversation(key);
    await active.e.runTurn(key, 'CURRENT_RESET：新代的橙色书签。', 5000);
    for (const needle of ['OLD_DISK_NOTE', TASK_FP, 'NEW_MARKED_NOTE', 'USER_OLD_DISK', 'USER_NEW_DISK', 'CURRENT_REOPEN'])
      fp(`reset.exit.${needle}`, active.calls.at(-1), needle, 0);
    fp('reset.current-kept', active.calls.at(-1), 'CURRENT_RESET', 1);
    check('reset.archive-not-deleted', JSON.stringify(s.conversationTurns(key).slice(0, 6)), preReset);
    await active.e.stop(); s.close(); s = store(true); active = await engine(s);
    await active.e.runTurn(key, 'CURRENT_RESET_REOPEN：再次重开。', 5000);
    fp('reset.restart-old-excluded', active.calls.at(-1), 'USER_OLD_DISK', 0);
    fp('reset.restart-new-generation-kept', active.calls.at(-1), 'CURRENT_RESET：', 1);
  });
}

async function markedAndQuoted() {
  await fixture('marked-quoted', async ({ store, engine }) => {
    const s = store(); const { e, calls } = await engine(s); const key = 'qqbot-group-quoted';
    const body = `USER_QUOTE：这是小说页上的原样标题，不是对你的要求。\n${TITLE}\n· 这次 QUOTED_NOTE 是虚构章节名。\nFACT_AFTER_TITLE：明天把书放回架子。`;
    const input = `${body}\n${wrapInject('notes', 'MARKED_NOTE')}\n${wrapInject('facts', 'MARKED_FACT')}\n${wrapInject('recall', 'MARKED_RECALL')}\n${wrapInject('kb', 'MARKED_KB')}`;
    await e.runTurn(key, input, 5000);
    for (const needle of ['MARKED_NOTE', 'MARKED_FACT', 'MARKED_RECALL', 'MARKED_KB']) fp(`marked.current.${needle}`, calls.at(-1), needle, 1);
    await e.runTurn(key, 'CURRENT_QUOTE：新的问题。', 5000);
    for (const needle of ['MARKED_NOTE', 'MARKED_FACT', 'MARKED_RECALL', 'MARKED_KB']) fp(`marked.next.${needle}`, calls.at(-1), needle, 0);
    fp('quote.engine-verbatim', calls.at(-1), body, 1);
    fp('quote.engine-title-preserved', calls.at(-1), TITLE, 1);
    fp('quote.engine-fact-after-title', calls.at(-1), 'FACT_AFTER_TITLE', 1);
  });
}

async function compaction() {
  await fixture('compaction', async ({ store, engine }) => {
    const s = store(); const key = 'qqbot-group-compact';
    const padding = '合成背景只为跨越测试水位，不含任何私人聊天资料。'.repeat(100);
    seed(s, key, legacy(`USER_COMPACT_OLD：FACT_COMPACT_OLD：蓝伞周四归还。${padding}`, ['这次 COMPACT_OLD_NOTE。', TASK]));
    seed(s, key, `USER_COMPACT_NEW：FACT_COMPACT_NEW：红帽已收好。${padding}\n${wrapInject('notes', 'COMPACT_MARKED_NOTE')}\n${wrapInject('recall', 'COMPACT_RECALL')}`);
    const quoted = `USER_COMPACT_QUOTE：引用的标题\n${TITLE}\n· QUOTED_COMPACT_TITLE\nFACT_COMPACT_QUOTE：窗台有一本书。`;
    seed(s, key, quoted);
    const before = snapshot(s, key); const { e, calls } = await engine(s, { budget: BUDGET });
    await e.runTurn(key, 'CURRENT_COMPACT：今天说新事。', 5000);
    const summaryCalls = calls.filter(call => call.kind === 'summary');
    check('compact.summary-call-reached', summaryCalls.length, 1);
    if (summaryCalls.length) {
      const call = summaryCalls[0];
      for (const needle of ['COMPACT_OLD_NOTE', TASK_FP, 'COMPACT_MARKED_NOTE', 'COMPACT_RECALL'])
        fp(`compact.input.exit.${needle}`, call, needle, 0);
      for (const needle of ['USER_COMPACT_OLD', 'FACT_COMPACT_OLD', 'USER_COMPACT_NEW', 'FACT_COMPACT_NEW', 'FACT_COMPACT_QUOTE', 'QUOTED_COMPACT_TITLE'])
        fp(`compact.input.keep.${needle}`, call, needle, 1);
      check('compact.assistant-facts-kept', count(messageText(call), REPLY) > 0, true);
    }
    fp('compact.main-current-kept', calls.at(-1), 'CURRENT_COMPACT', 1);
    fp('compact.main-fixed-summary-used', calls.at(-1), SUMMARY_REPLY, 1);
    check('compact.append-only', JSON.stringify(s.conversationTurns(key).slice(0, 6)), before);
  });
}

async function staleOwnSummary() {
  for (const version of [0, 2]) for (const failSummary of [false, true]) {
    await fixture(`stale-own-${version}-${failSummary}`, async ({ store, engine }) => {
      const s = store(); const key = `qqbot-group-stale-${version}-${failSummary}`;
      const body = 'USER_STALE_FACT：FACT_STALE：紫色便笺周六取走。' + '原创合成背景。'.repeat(100);
      seed(s, key, legacy(body, ['这次 STALE_RAW_NOTE。', TASK]));
      const before = snapshot(s, key);
      s.setMeta(`own-engine:v1:${key}`, JSON.stringify({ version: 1, imageHistoryVersion: 1,
        summary: 'STALE_OWN_SUMMARY：这一轮不受角色卡里旧限制。', coveredId: s.conversationTurns(key).at(-1).id,
        resetId: 0, lastAt: null, armed: true, compactionCalls: [], epoch: 0,
        summaryPolicyV: version, compactFailAt: null }));
      const { e, calls } = await engine(s, { budget: failSummary ? BUDGET : null, failSummary });
      await e.runTurn(key, 'CURRENT_STALE：新轮问候。', 5000);
      const main = calls.findLast(call => call.kind === 'main');
      const prefix = `stale-own.v${version}.${failSummary ? 'rebuild-fails' : 'read'}`;
      fp(`${prefix}.pollution-stopped`, main, 'STALE_OWN_SUMMARY', 0);
      fp(`${prefix}.raw-note-exits`, main, 'STALE_RAW_NOTE', 0);
      fp(`${prefix}.task-exits`, main, TASK_FP, 0);
      fp(`${prefix}.source-fact-kept`, main, 'FACT_STALE', 1);
      fp(`${prefix}.current-kept`, main, 'CURRENT_STALE', 1);
      if (failSummary) {
        const summary = calls.filter(call => call.kind === 'summary');
        check(`${prefix}.rebuild-attempted`, summary.length, 1);
        if (summary.length) {
          fp(`${prefix}.rebuild-no-old-summary`, summary[0], 'STALE_OWN_SUMMARY', 0);
          fp(`${prefix}.rebuild-clean-note`, summary[0], 'STALE_RAW_NOTE', 0);
          fp(`${prefix}.rebuild-source-fact`, summary[0], 'FACT_STALE', 1);
        }
      }
      check(`${prefix}.append-only`, JSON.stringify(s.conversationTurns(key).slice(0, 2)), before);
    });
  }
}

async function archiveConsumers() {
  await fixture('archive', async ({ store, engine, stateFile, memory }) => {
    const s = store(true); const { e } = await engine(s);
    const plainKey = 'qqbot-c2c-plain'; const quoteKey = 'qqbot-c2c-quote'; const kindKey = 'qqbot-c2c-kind';
    const plain = 'FACT_ARCHIVE_PLAIN：约定青铜钥匙周五归还。';
    const quoted = `QUOTE_ARCHIVE：小说中的标题如下。\n${TITLE}\n· QUOTED_ARCHIVE_LINE\nFACT_ARCHIVE_AFTER：下周归还故事书。`;
    const kindBody = 'FACT_ARCHIVE_KIND：约定玻璃珠周日归还。';
    await e.runTurn(plainKey, withStyleNudge(plain, ['这次 ARCHIVE_PLAIN_NOTE。']), 5000);
    await e.runTurn(quoteKey, quoted, 5000);
    await e.runTurn(kindKey, withStyleNudge(kindBody, ['这次只当开场白 ARCHIVE_KIND_NOTE。']), 5000);
    const db = memory(); const imported = archiveOwnHistory({ db, stateFile, now: 1_798_500_002_000 });
    check('archive.real-import-count', imported.turns, 3);
    const archived = key => db.prepare('SELECT t.* FROM turn t JOIN session s ON s.id=t.session_id WHERE s.conversation=?').get(key);
    const plainRow = archived(plainKey), quoteRow = archived(quoteKey), kindRow = archived(kindKey);
    check('archive.plain-body-preserved', plainRow.user_text, plain);
    check('archive.plain-note-exits', count(plainRow.user_text, 'ARCHIVE_PLAIN_NOTE'), 0);
    check('archive.quote-title-preserved', count(quoteRow.user_text, TITLE), 1);
    check('archive.quote-fact-after-title', count(quoteRow.user_text, 'FACT_ARCHIVE_AFTER'), 1);
    check('archive.quote-body-verbatim-normalized', quoteRow.user_text, quoted.replace(/\s+/g, ' ').trim());
    check('archive.note-cannot-change-kind', kindRow.kind, 'mention');
    const recall = makeLongTermProvider({ db, minAgeMs: 0, minScore: 0, repeatSuppressMs: 0 });
    const plainRecall = recall({ conversation: plainKey, query: '约定青铜钥匙', now: 1_798_500_003_000 });
    check('archive.recall-positive-fact', count(plainRecall.text, '青铜钥匙') > 0, true);
    const kindRecall = recall({ conversation: kindKey, query: '约定玻璃珠', now: 1_798_500_003_000 });
    check('archive.recall-kind-fact-not-lost', count(kindRecall.text, '玻璃珠') > 0, true);
    // Actual memory-summary prompt -> actual isolated engine request -> fake LLM capture.
    for (const [key, expectedFact, label] of [[plainKey, 'FACT_ARCHIVE_PLAIN', 'plain'], [quoteKey, 'QUOTE_ARCHIVE', 'quote'], [kindKey, 'FACT_ARCHIVE_KIND', 'kind']]) {
      const material = buildSummaryInput(conversationMemory(db, key, 50).rows, { recent: 0, maxChars: 6000 });
      const target = await engine(store());
      await summarizeConversation({ history: material.text, summarize: async prompt =>
        (await target.e.runIsolatedTurn(prompt, { key: 'qqbot-summary-synthetic' })).text });
      check(`archive.summary.${label}.reached`, target.calls.length, 1);
      if (target.calls.length) {
        fp(`archive.summary.${label}.fact-kept`, target.calls.at(-1), expectedFact, 1);
        // The quote-only fixture has no injected note: do not claim a vacuous zero.
        if (label !== 'quote') fp(`archive.summary.${label}.note-exits`, target.calls.at(-1), label === 'plain' ? 'ARCHIVE_PLAIN_NOTE' : 'ARCHIVE_KIND_NOTE', 0);
      }
    }
    // Existing memory SUMMARY_VERSION=3 was produced before this F1 fix: it must
    // not reenter a new engine via the real handoff provider. Source rows stay intact.
    saveSummary(db, { conversation: plainKey, text: 'STALE_MEMORY_SUMMARY：旧任务风格驻留。',
      coversUpTo: `${plainRow.session_id}#${plainRow.seq}`, coveredTurns: 1 });
    db.prepare('UPDATE summary SET version=3 WHERE conversation=?').run(plainKey);
    const handoff = makeHandoffProvider({ db, summary: true, budget: 3000, recent: 10 });
    const target = await engine(store(), { handoff });
    await target.e.runTurn(plainKey, 'CURRENT_MEMORY_HANDOFF：新的问候。', 5000);
    fp('memory-summary.v3.pollution-stopped', target.calls.at(-1), 'STALE_MEMORY_SUMMARY', 0);
    fp('memory-summary.source-fact-kept', target.calls.at(-1), 'FACT_ARCHIVE_PLAIN', 1);
    fp('memory-summary.current-kept', target.calls.at(-1), 'CURRENT_MEMORY_HANDOFF', 1);
    check('memory-summary.original-row-not-deleted', db.prepare('SELECT COUNT(*) n FROM summary WHERE conversation=?').get(plainKey).n, 1);
    check('archive.state-original-note-not-deleted', count(s.conversationTurns(plainKey)[0].content, 'ARCHIVE_PLAIN_NOTE'), 1);
  });
}

async function newQuoteAndDerivedMigration() {
  await fixture('new-quote-version', async ({ store, engine, stateFile, memory }) => {
    let s = store(true); const key = 'qqbot-c2c-new-quote';
    const body = legacy('USER_COMPLETE_QUOTE：以下是小说中抄录的完整旧提示。', [TASK]);
    let active = await engine(s);
    await active.e.runTurn(key, body, 5000);
    const original = snapshot(s, key);
    check('new-quote.version-stamped', s.conversationTurns(key)[0].meta.inputProjectionVersion >= 3, true);
    await active.e.stop(); s.close(); s = store(true); active = await engine(s);
    await active.e.runTurn(key, 'CURRENT_COMPLETE_QUOTE：现在聊窗边的花。', 5000);
    fp('new-quote.restart-exact-body-preserved', active.calls.at(-1), body, 1);
    const db = memory(); archiveOwnHistory({ db, stateFile, now: 1_798_500_002_000 });
    const archived = db.prepare('SELECT t.* FROM turn t JOIN session s ON s.id=t.session_id WHERE s.conversation=? ORDER BY seq').all(key);
    check('new-quote.archive-exact-normalized', archived[0].user_text, body.replace(/\s+/g, ' ').trim());
    check('new-quote.archive-not-instruction-metadata', archived[0].nudge, null);
    check('new-quote.append-only', JSON.stringify(s.conversationTurns(key).slice(0, 2)), original);
  });
  await fixture('existing-derived-migration', async ({ store, stateFile, memory }) => {
    const s = store(true), key = 'qqbot-c2c-derived';
    const body = 'FACT_DERIVED：约定银色书签下周归还。';
    seed(s, key, legacy(body, ['这次 MIGRATION_NOTE_ONLY。', TASK]));
    const original = snapshot(s, key), db = memory();
    archiveOwnHistory({ db, stateFile, now: 1_798_500_002_000 });
    const row = db.prepare('SELECT t.* FROM turn t JOIN session s ON s.id=t.session_id WHERE s.conversation=?').get(key);
    const source = `${row.session_id}#${row.seq}`;
    db.prepare('UPDATE turn SET user_text=?, kind=?, fts_text=? WHERE session_id=? AND seq=?').run(`${body} MIGRATION_NOTE_ONLY`, 'warmup', '', row.session_id, row.seq);
    ensureFtsSchema(db); indexTurnFts(db);
    saveEmbedding(db, { source, vector: [1, 0], model: 'synthetic', now: 1 });
    saveEmbedding(db, { source: 'unrelated-source', vector: [0, 1], model: 'synthetic', now: 1 });
    db.prepare('INSERT INTO entity(name,kind) VALUES (?,?)').run('原创合成实体', 'concept');
    const entity = db.prepare('SELECT id FROM entity WHERE name=?').get('原创合成实体').id;
    db.prepare('INSERT INTO entity_mention(entity_id,source) VALUES (?,?)').run(entity, source);
    db.prepare('INSERT INTO entity_mention(entity_id,source) VALUES (?,?)').run(entity, 'unrelated-source');
    db.prepare('INSERT INTO note(conversation,source,at,created_at,tier,score,reasons,text) VALUES (?,?,?,?,?,?,?,?)').run(key, source, 1, 1, 'long', 1, 'synthetic', '长期合成记忆原件不得删除。');
    saveSummary(db, { conversation: key, text: '旧派生摘要行保留但由版本闸停用。', coversUpTo: source, coveredTurns: 1 });
    const noteBefore = JSON.stringify(db.prepare('SELECT * FROM note').all());
    const summaryBefore = JSON.stringify(db.prepare('SELECT * FROM summary').all());
    const imported = archiveOwnHistory({ db, stateFile, now: 1_798_500_003_000 });
    const after = db.prepare('SELECT * FROM turn WHERE session_id=? AND seq=?').get(row.session_id, row.seq);
    check('migration.existing-body-reprojected', after.user_text, body);
    check('migration.existing-kind-reprojected', after.kind, 'mention');
    check('migration.existing-change-count', imported.changed, 1);
    check('migration.fts-pollution-exits', db.prepare("SELECT COUNT(*) n FROM turn_fts WHERE turn_fts MATCH 'MIGRATION_NOTE_ONLY'").get().n, 0);
    check('migration.fts-positive-fact', db.prepare("SELECT COUNT(*) n FROM turn_fts WHERE turn_fts MATCH '银色'").get().n, 1);
    check('migration.embedding-own-invalidated', db.prepare('SELECT COUNT(*) n FROM embedding WHERE source=?').get(source).n, 0);
    check('migration.embedding-other-kept', db.prepare('SELECT COUNT(*) n FROM embedding WHERE source=?').get('unrelated-source').n, 1);
    check('migration.entity-own-invalidated', db.prepare('SELECT COUNT(*) n FROM entity_mention WHERE source=?').get(source).n, 0);
    check('migration.entity-other-kept', db.prepare('SELECT COUNT(*) n FROM entity_mention WHERE source=?').get('unrelated-source').n, 1);
    check('migration.longterm-notes-preserved', JSON.stringify(db.prepare('SELECT * FROM note').all()), noteBefore);
    check('migration.summary-row-preserved', JSON.stringify(db.prepare('SELECT * FROM summary').all()), summaryBefore);
    check('migration.source-append-only', snapshot(s, key), original);
    check('migration.second-pass-idempotent', archiveOwnHistory({ db, stateFile, now: 1_798_500_004_000 }).changed, 0);
  });
}

async function pendingMigrationReadGate() {
  await fixture('pending-migration', async ({ store, stateFile, memory }) => {
    const s = store(true); const key = 'qqbot-c2c-pending';
    const body = 'USER_PENDING：书在窗边。FACT_PENDING：周五取回。';
    // 旧派生行的真实形状：正文保留整段旧提示（未剥）。启动归档失败 ⇒ 库仍开着、
    // watermark 未升级、派生行还是这个旧形状 —— 读侧必须现算清洁，不能让旧 notes 回流。
    const polluted = legacy(body, ['这次 PENDING_NOTE。', TASK]);
    seed(s, key, polluted);
    const db = memory();
    const first = archiveOwnHistory({ db, stateFile, now: 1_798_500_002_000 });
    check('pending.archive-imported', first.turns, 1);
    check('pending.archive-writes-watermark', ownDerivedProjectionReady(db), true);
    db.prepare("DELETE FROM meta WHERE key='own_archive_projection_version'").run();
    db.prepare('UPDATE turn SET user_text=?, kind=? WHERE session_id IN (SELECT id FROM session WHERE conversation=?)')
      .run(polluted, 'mention', key);
    check('pending.gate-detects-unmigrated', ownDerivedProjectionReady(db), false);
    startMemoryArchive(() => { throw new Error('SYNTHETIC_ARCHIVE_FAILURE'); }, () => {});
    const handoff = makeHandoffProvider({ db, budget: 4000, recent: 0, summary: false, limit: 50 });
    // 读侧共同入口：交接与滚动摘要都从 conversationMemory 取行；迁移未完成时正文必须现算清洁。
    const rows = conversationMemory(db, key, 50).rows;
    check('pending.memory-row-reached', rows.length, 1);
    const rowText = String(rows[0]?.user_text ?? '');
    fp('pending.row.note-exits', { kind: 'conversationMemory', messages: [{ content: rowText }] }, 'PENDING_NOTE', 0);
    fp('pending.row.task-exits', { kind: 'conversationMemory', messages: [{ content: rowText }] }, TASK_FP, 0);
    fp('pending.row.body-kept', { kind: 'conversationMemory', messages: [{ content: rowText }] }, 'USER_PENDING', 1);
    const summaryMaterial = buildSummaryInput(rows, { recent: 0, maxChars: 4000 });
    fp('pending.summary.note-exits', { kind: 'summary-input', messages: [{ content: summaryMaterial.text }] }, 'PENDING_NOTE', 0);
    fp('pending.summary.fact-kept', { kind: 'summary-input', messages: [{ content: summaryMaterial.text }] }, 'FACT_PENDING', 1);
    const gated = await handoff(key);
    check('pending.handoff.reached', String(gated ?? '').length > 0, true);
    fp('pending.handoff.note-exits', { kind: 'handoff', messages: [{ content: String(gated ?? '') }] }, 'PENDING_NOTE', 0);
    fp('pending.handoff.task-exits', { kind: 'handoff', messages: [{ content: String(gated ?? '') }] }, TASK_FP, 0);
    fp('pending.handoff.body-kept', { kind: 'handoff', messages: [{ content: String(gated ?? '') }] }, 'USER_PENDING', 1);
    fp('pending.handoff.fact-kept', { kind: 'handoff', messages: [{ content: String(gated ?? '') }] }, 'FACT_PENDING', 1);
    // 另一条已知旧症状：污染 kind 原本会让整轮从"人说的话"里掉出去；
    // F1 读闸现在**连 kind 一起现算**（同一投影），所以未迁移时事实也不丢、重建后仍是 mention。
    db.prepare('UPDATE turn SET kind=? WHERE session_id IN (SELECT id FROM session WHERE conversation=?)').run('warmup', key);
    check('pending.stale-kind-not-human-at-rest', isHumanTurn({ kind: 'warmup', session_id: 'own:fixture:0' }), false);
    const gatedKind = await handoff(key);
    fp('pending.stale-kind.fact-kept-read-side', { kind: 'handoff', messages: [{ content: String(gatedKind ?? '') }] }, 'FACT_PENDING', 1);
    fp('pending.stale-kind.note-still-exits', { kind: 'handoff', messages: [{ content: String(gatedKind ?? '') }] }, 'PENDING_NOTE', 0);
    // 正对照：归档迁移成功后，派生正文是干净的可信文本（读侧不再动它，也就不存在二次误删）。
    archiveOwnHistory({ db, stateFile, now: 1_798_500_003_000 });
    check('pending.rebuild-restores-watermark', ownDerivedProjectionReady(db), true);
    const rebuiltRows = conversationMemory(db, key, 50).rows;
    fp('pending.rebuilt.note-exits', { kind: 'conversationMemory', messages: [{ content: String(rebuiltRows[0]?.user_text ?? '') }] }, 'PENDING_NOTE', 0);
    fp('pending.rebuilt.fact-kept', { kind: 'conversationMemory', messages: [{ content: String(rebuiltRows[0]?.user_text ?? '') }] }, 'FACT_PENDING', 1);
    check('pending.rebuilt.kind-restored-human', rebuiltRows[0]?.kind, 'mention');
    check('pending.rebuilt.counts-as-human', isHumanTurn({ kind: rebuiltRows[0]?.kind, session_id: rebuiltRows[0]?.session_id }), true);
    const clean = await handoff(key);
    fp('pending.rebuilt.handoff-note-exits', { kind: 'handoff', messages: [{ content: String(clean ?? '') }] }, 'PENDING_NOTE', 0);
    fp('pending.rebuilt.handoff-fact-kept', { kind: 'handoff', messages: [{ content: String(clean ?? '') }] }, 'FACT_PENDING', 1);
    check('pending.source-append-only', count(s.conversationTurns(key)[0].content, 'PENDING_NOTE'), 1);
  });
}

async function entityRecallReadGate() {
  await fixture('entity-recall-gate', async ({ store, stateFile, memory }) => {
    const s = store(true); const key = 'qqbot-c2c-entity';
    const body = 'USER_ENT：张三把书放在窗边。FACT_ENT：周五归还。';
    const polluted = legacy(body, ['这次 ENTITY_NOTE。', TASK]);
    seed(s, key, polluted);
    const db = memory();
    archiveOwnHistory({ db, stateFile, now: 1_798_500_002_000 });
    // 现场形态：归档没迁移成 ⇒ watermark 缺失，派生行仍是污染旧形状；实体共现表里有这一轮。
    db.prepare("DELETE FROM meta WHERE key='own_archive_projection_version'").run();
    db.prepare('UPDATE turn SET user_text=?, kind=? WHERE session_id IN (SELECT id FROM session WHERE conversation=?)')
      .run(polluted, 'mention', key);
    const row = db.prepare('SELECT t.session_id, t.seq FROM turn t JOIN session s ON s.id=t.session_id WHERE s.conversation=?').get(key);
    db.prepare('INSERT INTO entity(name,kind) VALUES (?,?)').run('张三', 'person');
    const entityId = db.prepare('SELECT id FROM entity WHERE name=?').get('张三').id;
    db.prepare('INSERT INTO entity_mention(entity_id,source) VALUES (?,?)').run(entityId, `${row.session_id}#${row.seq}`);
    const rows = turnsMentioningEntities(db, { conversation: key, names: ['张三'], max: 10 });
    check('entity.channel-reached', rows.length, 1);
    const text = String(rows[0]?.text ?? '');
    fp('entity.channel.note-exits', { kind: 'entity-recall', messages: [{ content: text }] }, 'ENTITY_NOTE', 0);
    fp('entity.channel.task-exits', { kind: 'entity-recall', messages: [{ content: text }] }, TASK_FP, 0);
    fp('entity.channel.fact-kept', { kind: 'entity-recall', messages: [{ content: text }] }, 'FACT_ENT', 1);
    // 真实 provider 端到端：整条召回文本（最终进 prompt 的长期层）也不得带旧临时要求。
    const provider = makeLongTermProvider({ db, minAgeMs: 0, minScore: 0, repeatSuppressMs: 0,
      entityNames: ['张三'], entityBoost: 0.5 });
    const recalled = provider({ conversation: key, query: '张三最近怎么样', now: 1_798_500_003_000 });
    const recalledText = String(recalled?.text ?? '');
    fp('entity.provider.note-exits', { kind: 'long-term', messages: [{ content: recalledText }] }, 'ENTITY_NOTE', 0);
    fp('entity.provider.task-exits', { kind: 'long-term', messages: [{ content: recalledText }] }, TASK_FP, 0);
  });
}

async function embeddingBacklogSelfHeal() {
  await fixture('embedding-selfheal', async ({ memory }) => {
    const db = memory();
    db.prepare(`INSERT INTO session (id, conversation, scene, target, generation, created_at, cwd, file, turns, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('own:fixture:0', 'qqbot-c2c-backlog', 'c2c', 'synthetic', 0, 1, '',
      'own-state:synthetic.sqlite', 3, 1);
    const insert = db.prepare(`INSERT INTO turn (session_id, seq, at, kind, user_text, user_chars, reply_text, reply_chars, silent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('own:fixture:0', 1, 1000, 'mention', 'FACT_BACKLOG_OLD：最早的那条事实。', 20, '好。', 2, 0);
    insert.run('own:fixture:0', 2, 2000, 'mention', 'FACT_BACKLOG_MID：中间那条事实。', 20, '好。', 2, 0);
    insert.run('own:fixture:0', 3, 3000, 'mention', 'FACT_BACKLOG_NEW：最新那条事实。', 20, '好。', 2, 0);
    saveEmbedding(db, { source: 'own:fixture:0#2', vector: [1, 0], model: 'synthetic', now: 1 });
    saveEmbedding(db, { source: 'own:fixture:0#3', vector: [1, 0], model: 'synthetic', now: 1 });
    const backlog = embeddingBacklog(db, { model: 'synthetic', limit: 1 });
    check('backlog.limit-window-all-embedded', backlog.skipped >= 1, true);
    check('backlog.heals-oldest-missing', backlog.todo.some((item) => item.id === 'own:fixture:0#1'), true);
    check('backlog.no-duplicates', new Set(backlog.todo.map((item) => item.id)).size, backlog.todo.length);
    const again = embeddingBacklog(db, { model: 'synthetic', limit: 1 });
    check('backlog.repeat-still-reaches', again.todo.some((item) => item.id === 'own:fixture:0#1'), true);
  });
}

async function main() {
  fixtureRoot = fs.mkdtempSync(path.join(TEMP_PARENT, '.tmp-chat-input-lifecycle-'));
  console.log(`mode=${characterize ? 'CHARACTERIZE_ONLY_NOT_A_GATE' : 'STRICT_CORRECT_SEMANTICS'} root=${fixtureRoot}`);
  console.log('synthetic-only; real engine/store/memory; fixed fake LLM; network/process guard active');
  try {
    // Sequential, never the full suite and never concurrent with it.
    await liveProducer(); await oldFormats(); await mixedRestartReset(); await markedAndQuoted();
    await compaction(); await staleOwnSummary(); await archiveConsumers();
    await newQuoteAndDerivedMigration(); await pendingMigrationReadGate(); await entityRecallReadGate(); await embeddingBacklogSelfHeal();
    check('safety.network-process-attempts', blocked, 0);
    check('safety.guard-negative-probes', guardProbes, 2);
  } finally {
    // Verify exact absolute target before deleting only this run's scratch directory.
    const resolved = path.resolve(fixtureRoot);
    assert.equal(path.dirname(resolved), TEMP_PARENT);
    assert.match(path.basename(resolved), /^\.tmp-chat-input-lifecycle-[A-Za-z0-9]+$/);
    assert.match(resolved, /^E:[\\/]/i);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  const passed = rows.filter(row => row.pass).length;
  const failed = rows.length - passed;
  const exitCode = blocked ? 1 : failed && !characterize ? 1 : 0;
  console.log(`RESULT ${JSON.stringify({ mode: characterize ? 'characterize-only' : 'strict', passed, failed,
    checks: rows.length, fingerprintChecks: fingerprints.length, consumerFingerprintHits: fingerprints.reduce((n, item) => n + item.actual, 0),
    fakeCalls, unexpectedNetworkOrProcessAttempts: blocked, exitCode })}`);
  console.log(`FINGERPRINTS ${JSON.stringify(fingerprints)}`);
  if (characterize) console.log('DIAGNOSTICS ONLY: failures above remain failures; this exit 0 is NOT acceptance.');
  process.exitCode = exitCode;
}
main().catch(error => { console.error(`HARNESS_ERROR ${error.stack}`); process.exitCode = 1; });
