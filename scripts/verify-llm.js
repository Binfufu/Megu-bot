/** Isolated paid own-engine image/history diagnostic. Never submits QQ messages or edits production. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from '../src/llm.js';
import { createOwnEngine } from '../src/engine.js';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { readEnvFileValue } from '../src/bot-home.js';
import { OPAQUE_RED_URL, opaqueRedPng } from './image-probe-fixture.mjs';
import { parseProbeColor, probeImageCount, withoutProbeAnswers, withoutProbeImages } from './image-probe-check.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function arg(name, fallback) {
  const indices = process.argv.flatMap((value, index) => value === '--' + name ? [index] : []);
  if (indices.length > 1) throw new Error('duplicate --' + name);
  if (!indices.length) return fallback;
  const value = process.argv[indices[0] + 1];
  if (!value || value.startsWith('--')) throw new Error('--' + name + ' requires a value');
  return value;
}
const model = arg('model');
if (!model) throw new Error('--model requires an explicit API model id before paid calls');
const envFile = arg('env-file', path.join(ROOT, 'bots', 'megumin', '.env'));
const read = key => readEnvFileValue(envFile, key);
const apiKey = read('QQBOT_LLM_DREAM_KEY') || read('QQBOT_LLM_KEY');
assert.ok(apiKey, 'missing API key');
const dir = path.join(ROOT, 'data', 'index', 'verify-llm-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const isolatedPersona = path.join(dir, 'persona.txt');
fs.writeFileSync(isolatedPersona, '你是隔离视觉诊断助手。仅依据用户可见图片回答，不根据文字暗示猜测颜色。严格按要求输出JSON。');
const personaPath = arg('persona', isolatedPersona);
fs.writeFileSync(path.join(dir, 'qq-upload-red.png'), opaqueRedPng());
const captured = [], externalAttempts = [];
const report = { passed: false, model, maxAttemptsPerCall: 1,
  scope: 'isolated real API image recognition and persisted history; fixture is local, NOT a real QQ attachment or QQ delivery acceptance',
  externalAttempts, stages: [] };
const client = createLlmClient({ baseUrl: read('QQBOT_LLM_DREAM_BASEURL') || 'https://api.deepseek.com/v1', apiKey, model, attempts: 1, log: { warn() {} } });
const llmProbe = { async chat(messages, options) {
  const item = { messages: structuredClone(messages), images: structuredClone(options?.images || []) };
  captured.push(item);
  try { const result = await client.chat(messages, options); item.reply = result.text; item.usage = result.usage; item.finishReason = result.finishReason; return result; }
  catch (error) { item.error = { name: error.name, message: error.message, code: error.cause?.code }; throw error; }
} };
const stateFile = path.join(dir, 'state.db');
let store = new SqliteStateStore(stateFile), engine;
const key = 'isolated-vision-probe';
const question = '仅依据当前可见图片判断主要颜色，返回JSON对象，仅一个字段color，值为中文颜色名。没有可见图片则值为null，不猜测，不要代码围栏。';
function open() { engine = createOwnEngine({ llm: llmProbe, store, personaPath }); }
function externalOptions(kind) {
  return { timeoutMs: 120000, onAttemptStart() {
    externalAttempts.push({ kind, status: 'pending', usage: null, startedAt: Date.now() }); return externalAttempts.length - 1;
  }, onAttemptEnd(id, result) { Object.assign(externalAttempts[id], result, { endedAt: Date.now() }); } };
}
try {
  open(); await engine.initialize();
  const first = await engine.runTurn(key, question, 120000,
    [{ type: 'image', mimeType: 'image/png', data: OPAQUE_RED_URL.split(',')[1] }]);
  report.stages.push({ kind: 'first-image', reply: first.text, timedOut: first.timedOut });
  assert.equal(first.timedOut, false);
  assert.equal(parseProbeColor(first.text), '红色', 'opaque red must be recognized as red, not merely a non-empty reply');
  assert.ok(captured.at(-1).usage, 'real first-image usage required');
  await engine.stop(); store.close();
  store = new SqliteStateStore(stateFile); open(); await engine.initialize();
  const second = await engine.runTurn(key, question, 120000);
  const history = captured.at(-1).messages;
  report.stages.push({ kind: 'reopened-history', reply: second.text, imageCount: probeImageCount(history), timedOut: second.timedOut });
  assert.equal(second.timedOut, false);
  assert.equal(probeImageCount(history), 1, 'reopened actual messages must contain the old image without passing new images');
  assert.ok(history.some(message => Array.isArray(message.content) && message.content.some(block => block?.image_url?.url === OPAQUE_RED_URL)), 'persisted image bytes must equal the exact original fixture');
  assert.equal(parseProbeColor(second.text), '红色');
  assert.ok(captured.at(-1).usage, 'real history usage required');
  const answerFree = withoutProbeAnswers(history);
  assert.equal(probeImageCount(answerFree), 1);
  const noImage = withoutProbeImages(answerFree);
  assert.equal(probeImageCount(noImage), 0);
  const negative = await client.chat(noImage, externalOptions('without-image-and-answers'));
  report.negativeControl = { reply: negative.text, usage: negative.usage };
  assert.equal(parseProbeColor(negative.text), null, 'removing image and earlier assistant answers must remove color evidence');
  const restored = await client.chat(answerFree, externalOptions('restored-image-without-answers'));
  report.restoredControl = { reply: restored.text, usage: restored.usage };
  assert.equal(parseProbeColor(restored.text), '红色', 'restored actual image, not earlier answer text, must recover red');
  assert.ok(negative.usage && restored.usage, 'controls must retain real usage');
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, causeCode: error.cause?.code };
  process.exitCode = 1;
} finally {
  await engine?.stop();
  report.calls = store.ownLlmCalls(); report.attempts = store.ownLlmAttempts();
  store.close();
  fs.writeFileSync(path.join(dir, 'requests.json'), JSON.stringify(captured, null, 2));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, passed: report.passed, stages: report.stages, error: report.error }, null, 2));
}
