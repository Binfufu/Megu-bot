/** Isolated historical replay. Never imports main(), sends QQ, or opens production DBs.
 * node scripts/replay-engine.mjs --selftest
 * node scripts/replay-engine.mjs --run --session-root <directory> [--bot demo] [--session NAME]
 * node scripts/replay-engine.mjs --batch <n> --session-root <directory> [--bot demo] [--lane private|group]
 * Set QQBOT_WORKSPACE in bots/<bot>/.env or pass --workspace <directory>.
 * Historical persona extraction requires an explicit --persona-marker <literal>.
 * Real API calls require --run/--batch. Outputs are private, under ignored data/replay/.
 * Historical answers are references, not byte-exact expected outputs.
 *
 * `--batch`(2026-10-16,1.150.83):在 20+ 天真实历史里**按时间分层抽 n 个 case**,每个冷回放一次
 * (全新库、老师强制历史=当时真实材料),逐案对比两侧:
 *   · 旧架构(legacy)该轮的真实 usage(记录里 inputTokens=未命中输入、cacheReadTokens=命中、outputTokens)
 *   · 新架构(own)同一位置装配后的 prompt/completion/命中
 * 两侧用**同一张官方价目卡 + 各自调用时刻**折 ¥(峰谷按时刻派生),并汇总中位数/p90/合计。
 * ⚠️ 能说与不能说:同位置材料下"装配规模与花费"可比;回复只有参照意义(人设/框架/模型版本差异);
 *    legacy 的摘要花费在**独立子会话**里,不在这份逐轮 usage 中(摘要侧的对账见 cost-split.js)。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readSessionRecords } from './session-log.js';
import { readEnvFileValue } from '../src/bot-home.js';
import { extractAssistantText } from '../src/runner-contract.js';
import { createOwnEngine } from '../src/engine.js';
import { createLlmClient } from '../src/llm.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { estimateCostCny, rateCardFor } from '../src/usage-account.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textOf = (blocks) => (blocks ?? []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n');
const runtimeOnly = text => /^\s*(?:<system-reminder>|Current runtime context\.)/.test(text);

export function replayCases(records, { personaMarker = '' } = {}) {
  const history = [];
  const cases = [];
  let pending = null;
  let historicalPersona = null;
  let system = '';
  function finish() {
    if (!pending) return;
    if (pending.reply) cases.push({ ...pending, historicalPersona, historicalSystem: system });
    history.push({ role: 'user', content: pending.prompt });
    if (pending.reply) history.push({ role: 'assistant', content: pending.reply });
    pending = null;
  }
  for (const record of records) {
    if (record.type === 'system/message') system = textOf(record.data?.content ?? record.data?.message?.content);
    if (record.type === 'user/message') {
      const blocks = record.data?.content ?? [];
      const text = textOf(blocks);
      if (runtimeOnly(text)) {
        const match = text.match(/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/);
        // A caller-supplied literal distinguishes persona text from runtime notices.
        // No built-in character names and no automatic promotion of arbitrary reminders.
        if (match && personaMarker && match[1].includes(personaMarker)) historicalPersona = match[1];
        continue;
      }
      finish();
      pending = { prompt: text, history: history.map(x => ({ ...x })), reply: '', usage: [], at: record.time,
        unsupportedImages: blocks.some(b => b.type !== 'text') };
    }
    if (record.type === 'assistant/message' && pending) {
      const reply = extractAssistantText(record);
      if (reply) pending.reply = reply;
      if (record.data?.usage) pending.usage.push(record.data.usage);
      pending.model = record.data?.message?.source?.model ?? null;
    }
    if (record.type === 'turn/end') finish();
  }
  finish();
  return cases.filter(c => c.prompt.trim() && !c.unsupportedImages);
}

/**
 * 分批抽样:按时间排序后**等距取样**(确定性,同输入同输出),保证跨天/跨会话分布。
 * 纯函数 —— 判据在 selftest 里钉住(确定性、覆盖两端、不超量)。
 */
export function selectBatchCases(all, n) {
  const list = Array.isArray(all) ? all : [];
  const size = Math.max(0, Math.floor(Number(n) || 0));
  if (!size || !list.length) return [];
  const sorted = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (sorted.length <= size) return sorted;
  const step = sorted.length / size;
  const picked = [];
  for (let i = 0; i < size; i += 1) picked.push(sorted[Math.min(sorted.length - 1, Math.floor(i * step + step / 2))]);
  return picked;
}

/** 汇总两侧用量/花费。缺失记缺失(不进分母、不当 0);比率只用两侧都有效的 case。 */
export function summarizeBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ok = list.filter(r => r?.ok);
  const nums = arr => arr.filter(Number.isFinite).sort((a, b) => a - b);
  const median = arr => { const s = nums(arr); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pct = (arr, p) => { const s = nums(arr); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
  const sum = arr => arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const inputRatios = ok.filter(r => Number.isFinite(r.newPrompt) && (r.oldMiss + r.oldHit) > 0).map(r => r.newPrompt / (r.oldMiss + r.oldHit));
  const costRatios = ok.filter(r => Number.isFinite(r.newCny) && Number.isFinite(r.oldCny) && r.oldCny > 0).map(r => r.newCny / r.oldCny);
  return {
    cases: list.length, ok: ok.length, failed: list.length - ok.length,
    oldInputTokens: sum(ok.map(r => r.oldMiss + r.oldHit)), oldOutputTokens: sum(ok.map(r => r.oldOut)),
    newPromptTokens: sum(ok.map(r => r.newPrompt)), newCompletionTokens: sum(ok.map(r => r.newOut)), newCacheHitTokens: sum(ok.map(r => r.newHit)),
    oldCny: sum(ok.map(r => r.oldCny)), newCny: sum(ok.map(r => r.newCny)),
    medianOldInput: median(ok.map(r => r.oldMiss + r.oldHit)), medianNewPrompt: median(ok.map(r => r.newPrompt)),
    p90OldInput: pct(ok.map(r => r.oldMiss + r.oldHit), 0.9), p90NewPrompt: pct(ok.map(r => r.newPrompt), 0.9),
    medianInputRatio: median(inputRatios), p90InputRatio: pct(inputRatios, 0.9), ratioCases: inputRatios.length,
    medianCostRatio: median(costRatios), p90CostRatio: pct(costRatios, 0.9), costRatioCases: costRatios.length,
    extraCalls: sum(ok.map(r => r.extraCalls)), historyRowsTotal: sum(ok.map(r => r.historyRows)),
  };
}

export function selftest() {  const user = text => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });
  const answer = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text }] }, usage: { inputTokens: 10 } } });
  const cases = replayCases([user('first'), answer('old1'), { type: 'turn/end' }, user('target'), answer('future secret'), { type: 'turn/end' }]);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases[1].history, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'old1' }]);
  assert.ok(!JSON.stringify(cases[1].history).includes('future secret'));
  assert.equal(cases[1].reply, 'future secret');
  assert.equal(replayCases([user('unanswered')]).length, 0);
  const image = user('image'); image.data.content.push({ type: 'image', url: 'private' });
  assert.equal(replayCases([image, answer('saw image')]).length, 0);
  assert.equal(replayCases([user('Current runtime context. test'), user('question'), answer('answer')])[0].history.length, 0);
  const reminder = '<system-reminder>示例助手 persona fixture</system-reminder>';
  const tagged = [user(reminder), user('question'), answer('answer')];
  assert.equal(replayCases(tagged)[0].historicalPersona, null, 'no implicit character/persona detection');
  assert.equal(replayCases(tagged, { personaMarker: '示例助手' })[0].historicalPersona, '示例助手 persona fixture');
  assert.equal(replayCases(tagged, { personaMarker: 'different marker' })[0].historicalPersona, null);
  assert.equal(replayCases(tagged, { personaMarker: '示例助手' })[0].history.length, 0, 'reminder is not user history');
  // 分批抽样:确定性、等距覆盖两端、不超量、空输入安全
  const pool = Array.from({ length: 100 }, (_, i) => ({ at: 1000 + i, id: i }));
  const picked = selectBatchCases(pool, 10);
  assert.equal(picked.length, 10);
  assert.deepEqual(picked.map(p => p.id), selectBatchCases(pool, 10).map(p => p.id), '同输入同输出');
  assert.ok(picked[0].id < 10 && picked.at(-1).id > 89, '等距取样要覆盖时间轴两端');
  assert.equal(selectBatchCases(pool.slice(0, 3), 10).length, 3, '样本少于请求量时全给');
  assert.deepEqual(selectBatchCases([], 5), []);
  assert.deepEqual(selectBatchCases(pool, 0), []);
  // 汇总:缺失不许当 0 参与比率;分母为 0 的 case 不进比率
  const summary = summarizeBatch([
    { ok: true, oldMiss: 100, oldHit: 0, oldOut: 10, newPrompt: 50, newOut: 5, newHit: 0, newCny: 0.01, oldCny: 0.02, extraCalls: 0, historyRows: 1 },
    { ok: true, oldMiss: 200, oldHit: 100, oldOut: 20, newPrompt: 150, newOut: 8, newHit: 100, newCny: 0.02, oldCny: 0.04, extraCalls: 1, historyRows: 2 },
    { ok: true, oldMiss: 0, oldHit: 0, oldOut: 0, newPrompt: 999, newOut: 1, newHit: 0, newCny: 0.005, oldCny: 0, extraCalls: 0, historyRows: 0 },
    { ok: false, error: 'boom', oldMiss: 0, oldHit: 0, oldOut: 0 },
  ]);
  assert.equal(summary.cases, 4);
  assert.equal(summary.ok, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.oldInputTokens, 400, '缺失/失败不进合计');
  assert.equal(summary.ratioCases, 2, '零分母不进比率(不是 0,是不算)');
  assert.equal(summary.medianInputRatio, 0.5, '(50/100 + 150/300)/2 = 0.5');
  assert.equal(summary.costRatioCases, 2, 'oldCny=0 不进成本比率');
  console.log('replay-engine: 6 isolation/extraction + 4 explicit-persona + 8 batch checks passed');
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1]; };
  if (args.includes('--selftest')) return selftest();
  if (!args.includes('--run') && !args.includes('--batch')) { console.log('Use --selftest (no API), --run (single-lane replay) or --batch <n> (sampled batch).'); return; }
  const bot = arg('bot', 'demo');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(bot)) throw new Error('Bot name must be an ASCII directory identifier');
  const sessionRootArg = arg('session-root', '');
  if (!sessionRootArg || sessionRootArg.startsWith('--')) throw new Error('Replay requires --session-root <directory>; no private session location is guessed');
  const envFile = path.resolve(ROOT, process.env.QQBOT_ENV_FILE || path.join('bots', bot, '.env'));
  const env = key => readEnvFileValue(envFile, key);
  const workspaceArg = arg('workspace', '') || env('QQBOT_WORKSPACE');
  if (!workspaceArg || workspaceArg.startsWith('--')) throw new Error('Replay requires --workspace <directory> or QQBOT_WORKSPACE in the selected env file');
  const workspace = path.resolve(ROOT, workspaceArg);
  const sessionRoot = path.resolve(ROOT, sessionRootArg);
  const personaMarker = arg('persona-marker', '');
  const sessionName = arg('session', null);
  const candidates = fs.readdirSync(sessionRoot).filter(n => /^qqbot-(c2c|group)-/.test(n) && (!sessionName || n === sessionName))
    .flatMap(n => ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'].map(v => ({ name: n, file: path.join(sessionRoot, n, v) })))
    .filter(x => fs.existsSync(x.file)).sort((a,b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
  const selected = [];
  if (args.includes('--batch')) {
    const lane = arg('lane', null);
    const pool = [];
    for (const candidate of candidates) {
      const caseLane = candidate.name.includes('-c2c-') ? 'private' : 'group';
      if (lane && caseLane !== lane) continue;
      for (const c of replayCases(readSessionRecords(candidate.file), { personaMarker })) {
        if (c.reply && c.usage.length) pool.push({ ...c, session: candidate.name, lane: caseLane });
      }
    }
    const picked = selectBatchCases(pool, Number(arg('batch', '50')));
    const apiKey = env('QQBOT_LLM_KEY') || env('QQBOT_LLM_DREAM_KEY');
    if (!apiKey) throw new Error('Missing replay API key');
    const llm = createLlmClient({ apiKey, baseUrl: env('QQBOT_LLM_BASEURL') || env('QQBOT_LLM_DREAM_BASEURL') || 'https://api.deepseek.com/v1',
      model: env('QQBOT_LLM_MODEL') || env('QQBOT_LLM_DREAM_MODEL') || 'deepseek-chat', timeoutMs: 60000 });
    const outDir = path.join(ROOT, 'data', 'replay', `batch-${bot}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(outDir, { recursive: true });
    const personaPath = path.join(outDir, 'persona.txt');
    fs.writeFileSync(personaPath, fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'));
    console.log(`batch: 候选 ${pool.length} → 抽 ${picked.length}（bot=${bot} lane=${lane ?? 'both'}）输出 ${outDir}`);
    const card = rateCardFor(env('QQBOT_LLM_MODEL') || env('QQBOT_LLM_DREAM_MODEL') || 'deepseek-chat');
    const rows = [];
    const details = [];
    const reportFile = path.join(outDir, 'report-batch.json');
    const writeReport = () => fs.writeFileSync(reportFile, JSON.stringify({ bot, lane, generatedAt: new Date().toISOString(),
      scope: '同位置材料对照:旧架构该轮真实 usage vs 新架构同位置装配;两侧同一价目卡+各自调用时刻折¥;回复仅参照。legacy 摘要花费在独立子会话,不在此逐轮 usage。',
      cardId: card?.id ?? null, summary: summarizeBatch(rows), rows, details }, null, 2));
    for (const [i, c] of picked.entries()) {
      const store = new SqliteStateStore(path.join(outDir, `case-${i}.db`));
      const calls = [];
      const probe = { chat: async (messages, options) => {
        const captured = { startedAt: Date.now(), messageCount: messages.length };
        calls.push(captured);
        const start = Date.now(); const result = await llm.chat(messages, options);
        captured.ms = Date.now() - start; captured.usage = result.usage; return result;
      } };
      const engine = createOwnEngine({ llm: probe, store, personaPath });
      let row = { i, lane: c.lane, session: c.session, at: c.at, historyRows: c.history.length,
        oldMiss: c.usage.reduce((a, x) => a + (x.inputTokens ?? 0), 0), oldHit: c.usage.reduce((a, x) => a + (x.cacheReadTokens ?? 0), 0),
        oldOut: c.usage.reduce((a, x) => a + (x.outputTokens ?? 0), 0), oldCalls: c.usage.length };
      let callLog = calls;
      try {
        await engine.initialize();
        const result = await engine.runTurn('replay', c.prompt, 60000);
        const main = calls.at(-1) ?? {};
        const u = main.usage ?? {};
        row = { ...row, ok: true, ms: main.ms ?? null, callCount: calls.length, extraCalls: Math.max(0, calls.length - 1),
          newPrompt: u.promptTokens ?? null, newHit: u.cacheHitTokens ?? null, newMiss: u.cacheMissTokens ?? u.promptTokens ?? null,
          newOut: u.completionTokens ?? null };
        const oldCost = estimateCostCny({ card, at: c.at ?? Date.now(), inputTokens: row.oldMiss, cacheReadTokens: row.oldHit, outputTokens: row.oldOut });
        const newCost = estimateCostCny({ card, at: main.startedAt ?? Date.now(), cacheMissTokens: row.newMiss, cacheHitTokens: row.newHit, outputTokens: row.newOut });
        row.oldCny = oldCost?.cny ?? null; row.newCny = newCost?.cny ?? null; row.oldTier = oldCost?.tier ?? null; row.newTier = newCost?.tier ?? null;
        console.log(`[${i + 1}/${picked.length}] ${c.lane} hist=${c.history.length} 旧=${row.oldMiss}+${row.oldHit}/${row.oldOut} 新=${row.newPrompt}(${row.newHit ?? 0}命中)/${row.newOut} ¥${row.oldCny?.toFixed(5) ?? '?'}→¥${row.newCny?.toFixed(5) ?? '?'} ${main.ms}ms${row.extraCalls ? ` 额外调用${row.extraCalls}` : ''}`);
        details.push({ ...row, prompt: c.prompt.slice(0, 300), oldReply: c.reply.slice(0, 600), newReply: (result.text ?? '').slice(0, 600), calls: callLog.map(x => ({ ms: x.ms, messageCount: x.messageCount, usage: x.usage })) });
      } catch (err) {
        row = { ...row, ok: false, error: err.message };
        details.push({ ...row, prompt: c.prompt.slice(0, 300), oldReply: c.reply.slice(0, 600), calls: callLog.map(x => ({ ms: x.ms, messageCount: x.messageCount, usage: x.usage })) });
        console.error(`[${i + 1}/${picked.length}] ${c.lane} 失败: ${err.message}`);
      } finally { await engine.stop(); store.close(); }
      rows.push(row);
      writeReport();
    }
    const summary = summarizeBatch(rows);
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    const md = ['# 新架构 × 旧架构 同位置材料对照（分批抽样）', '', `bot=${bot} lane=${lane ?? 'both'} case=${picked.length}`, '',
      '两侧同一价目卡 + 各自调用时刻折 ¥；旧=legacy 该轮真实 usage（inputTokens=未命中、cacheReadTokens=命中）；新=own 同位置装配。',
      '回复仅参照（人设/框架/模型版本差异）；legacy 摘要花费在独立子会话，不在此表。', '', '## 汇总', '', '```json', JSON.stringify(summary, null, 2), '```', '',
      '| # | lane | 历史行 | 旧输入(含命中) | 旧输出 | 新prompt(命中) | 新输出 | 旧¥ | 新¥ | 比值 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
    for (const r of rows) {
      const ratio = r.ok && (r.oldMiss + r.oldHit) > 0 && Number.isFinite(r.newPrompt) ? (r.newPrompt / (r.oldMiss + r.oldHit)).toFixed(2) : '—';
      md.push(`| ${r.i} | ${r.lane} | ${r.historyRows} | ${r.oldMiss + r.oldHit} | ${r.oldOut} | ${r.newPrompt ?? '—'}(${r.newHit ?? 0}) | ${r.newOut ?? '—'} | ${r.oldCny?.toFixed(5) ?? '—'} | ${r.newCny?.toFixed(5) ?? '—'} | ${ratio}${r.ok ? '' : ' ✗'} |`);
    }
    fs.writeFileSync(path.join(outDir, 'report-batch.md'), md.join('\n'));
    console.log(JSON.stringify(summary, null, 2));
    if (rows.some(r => !r.ok)) process.exitCode = 1;
    return;
  }
  const lanes = new Set();
  for (const candidate of candidates) {
    const lane = candidate.name.includes('-c2c-') ? 'private' : 'group';
    if (lanes.has(lane)) continue;
    const cases = replayCases(readSessionRecords(candidate.file), { personaMarker });
    if (!cases.length) continue;
    selected.push({ ...candidate, lane, sample: cases.at(-1) }); lanes.add(lane);
    if (sessionName || lanes.size === 2) break;
  }
  if (!selected.length) throw new Error('No complete text-only historical turns found');
  if (args.includes('--simulate')) selected.push({ lane: 'simulation', name: 'synthetic-memory-continuity', sample: {
    prompt: '我刚才说的代号是什么？明早去哪儿、做什么？只按我说过的回答，不知道就说不知道。',
    history: [{ role: 'user', content: '记住：这次行动代号是青石。明早去公会还书，不是去钓鱼场。' },
      { role: 'assistant', content: '记住了，代号青石，明早去公会还书。' }],
    reply: '(模拟事实判据：青石、公会、还书；不能说去钓鱼场。)', usage: [], model: null,
  } });
  const apiKey = env('QQBOT_LLM_KEY') || env('QQBOT_LLM_DREAM_KEY');
  if (!apiKey) throw new Error('Missing replay API key');
  const llm = createLlmClient({ apiKey, baseUrl: env('QQBOT_LLM_BASEURL') || env('QQBOT_LLM_DREAM_BASEURL') || 'https://api.deepseek.com/v1',
    model: env('QQBOT_LLM_MODEL') || env('QQBOT_LLM_DREAM_MODEL') || 'deepseek-chat', timeoutMs: 60000 });
  const outDir = path.join(ROOT, 'data', 'replay', `${bot}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const report = { bot, generatedAt: new Date().toISOString(), scope: 'Historical teacher-forced single-turn replay, twice from identical snapshot. No QQ or production database writes. Cache warming is best-effort, not TTL proof.', samples: [] };
  for (const selectedCase of selected) {
    const c = selectedCase.sample;
    const personaFile = path.join(outDir, selectedCase.lane + '-persona.txt');
    fs.writeFileSync(personaFile, c.historicalPersona || fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'));
    const entry = { lane: selectedCase.lane, session: selectedCase.name, at: c.at, historyRows: c.history.length,
      personaSource: c.historicalPersona ? 'historical reminder (may include historical framework text)' : 'current persona (not exact historical A/B)',
      historicalSystemPresent: !!c.historicalSystem, oldModel: c.model, prompt: c.prompt, oldReply: c.reply, oldUsage: c.usage, runs: [] };
    report.samples.push(entry);
    for (let repeat = 1; repeat <= 2; repeat++) {
      const store = new SqliteStateStore(path.join(outDir, `${selectedCase.lane}-${repeat}.db`));
      for (const row of c.history) store.appendConversationTurn({ key: 'replay', ...row });
      const calls = [];
      const probe = { chat: async (messages, options) => {
        const captured = { messages: structuredClone(messages), startedAt: new Date().toISOString() }; calls.push(captured);
        const start = Date.now(); const result = await llm.chat(messages, options);
        captured.ms = Date.now() - start; captured.usage = result.usage; captured.model = result.model;
        return result;
      } };
      const engine = createOwnEngine({ llm: probe, store, personaPath: personaFile });
      try {
        await engine.initialize();
        const result = await engine.runTurn('replay', c.prompt, 60000);
        const factCheck = selectedCase.lane === 'simulation'
          ? { passed: ['青石', '公会', '还书'].every(word => result.text.includes(word)) && !result.text.includes('钓鱼场'),
            expected: ['青石', '公会', '还书'], forbiddenDestination: '钓鱼场' }
          : null;
        entry.runs.push({ repeat, reply: result.text, factCheck, calls });
        console.log(`${selectedCase.lane} replay=${repeat} history=${c.history.length} usage=${JSON.stringify(calls.at(-1)?.usage)} reply=${JSON.stringify(result.text)}`);
      } catch (err) { entry.runs.push({ repeat, error: err.message, calls }); console.error(`${selectedCase.lane}: ${err.message}`); }
      finally { await engine.stop(); store.close(); fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)); }
    }
  }
  const md = ['# 新引擎隔离历史回放', '', report.scope, '', '注意：旧回复是参照，不要求逐字一致；模型、历史人设和框架提示差异均需人工核对。缓存第二次命中不等于证明小时级 TTL。', ''];
  for (const entry of report.samples) {
    md.push(`## ${entry.lane} / ${entry.session}`, `历史行数：${entry.historyRows}；人设来源：${entry.personaSource}；旧模型：${entry.oldModel}`, '', '### 当轮完整输入', entry.prompt, '', '### 旧架构回复', entry.oldReply, `旧 usage：${JSON.stringify(entry.oldUsage)}`, '');
    for (const run of entry.runs) md.push(`### 新架构第 ${run.repeat} 次`, run.reply || run.error, `调用账单（含摘要调用）：${JSON.stringify(run.calls.map(({ messages, ...rest }) => rest))}`, '');
  }
  fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n'));
  console.log(`Report: ${path.join(outDir, 'report.md')}`);
  if (report.samples.some(s => s.runs.some(r => r.error || r.factCheck?.passed === false))) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(err => { console.error(err.message); process.exitCode = 1; });
