/**
 * **刀三A `src\engine.js` 的判据**(2026-10-14,`docs\21` §十二)。
 *
 * 全部走**注入的假 llm 客户端** —— 不碰网,判行为不判运气:
 * 契约形状、全路径落库(含 usage)、前缀逐字节稳定(engine 层)、空响应→[跳过](g8)、
 * 注入自报家门(不许裸注入)、人设 g7 热更语义(换代才重读)、压缩触发走同一 llm、
 * images 透传、同会话串行。
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { registerDshInboxTests } from './selftest-dsh-inbox.js';
import { createOwnEngine } from '../src/engine.js';
import { createLlmClient, IMAGE_GROUNDING_NOTE } from '../src/llm.js';
import { archiveOwnHistory } from '../src/own-memory-archive.js';
import { createMemoryArchiveTick, startMemoryArchive } from '../src/memory-archive-tick.js';
import { openMemory, makeLongTermProvider } from '../src/memory-store.js';
import { opaqueRedPng } from './image-probe-fixture.mjs';
import { inflateSync, crc32 } from 'node:zlib';
import { selftest as replaySelftest } from './replay-engine.mjs';
import { probeIntegrity, diagnose } from './simulate-engine.mjs';
import { probeRecovery } from './probe-engine-recovery.mjs';
import { probeArchiveWallclock } from './probe-archive-wallclock.mjs';
import { probeOwnMain } from './probe-own-main.mjs';
import { SqliteStateStore } from '../src/sqlite-store.js';
import { SILENT_TOKEN } from '../src/group-context.js';
import { hasInjectMarks, injectOpen, wrapInject } from '../src/inject-mark.js';
import { PRICES, compareVerdict, costPerCall, estimateCost, sumSessionUsage, sumTurnUsage, sumOwnCallUsage, sumOwnAttemptUsage, usageOfRecord } from '../src/usage-account.js';
import { buildEngineConfig } from '../src/config.js';
import * as runnerContract from '../src/runner-contract.js';
import { collectDshUsageDiagnostic, diagnosticComparisonText } from './dsh-usage-diagnostic.js';

/** 假 llm:按脚本出结果,记下每次收到的 messages/callOptions,顺带量并发峰值。 */
function fakeLlm(script = []) {
  const calls = [];
  let i = 0;
  const concurrency = { now: 0, max: 0 };
  const chat = async (messages, callOptions = {}) => {
    concurrency.now += 1;
    concurrency.max = Math.max(concurrency.max, concurrency.now);
    calls.push({ messages: messages.map((m) => ({ ...m })), callOptions: { ...callOptions } });
    const step = script[Math.min(i, script.length - 1)] ?? {};
    i += 1;
    try {
      if (step.throw) throw step.throw;
      return { text: step.text ?? '', usage: step.usage ?? null, raw: {} };
    } finally {
      concurrency.now -= 1;
    }
  };
  return { chat, calls, concurrency };
}

/** 临时现场:库 + 人设文件(用完删)。 */
function tempFixture(persona = '你是惠惠,红族的爆裂魔法使。') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  const personaPath = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(personaPath, persona, 'utf8');
  return { store: new SqliteStateStore(path.join(dir, 'state.db')), personaPath, dir };
}

const USAGE = { promptTokens: 6300, completionTokens: 412, cacheHitTokens: 1152, cacheMissTokens: 5148 };

export function registerEngineTests({ test, assert: rawAssert }) {
  const a = rawAssert || assert;
  registerDshInboxTests({ test, assert: a });
  test('own真实HTTP200体挂起:stop关连接、调用尝试结案未知、不落助手且重开可读', async () => {
    const fx = tempFixture();
    let headersRead, disconnected;
    const ready = new Promise(resolve => { headersRead = resolve; });
    const closed = new Promise(resolve => { disconnected = resolve; });
    let count = 0;
    const server = http.createServer((req, res) => {
      count++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":['); res.on('close', disconnected);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const llm = createLlmClient({ baseUrl: 'http://127.0.0.1:' + server.address().port,
      apiKey: 'isolated', model: 'isolated', retryDelayMs: 1, log: {},
      fetchImpl: async (...args) => { const response = await fetch(...args); headersRead(); return response; } });
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, budget: null });
    try {
      await engine.initialize();
      const call = engine.runTurn('qqbot-c2c-body-stall', '完整响应未到不能写助手');
      const rejected = a.rejects(call, /engine stopped/);
      await ready; await engine.stop(); await rejected;
      const guard = setTimeout(() => disconnected('timeout'), 2000);
      try { a.notEqual(await closed, 'timeout'); } finally { clearTimeout(guard); }
      a.equal(count, 1);
      fx.store.close();
      fx.store = new SqliteStateStore(path.join(fx.dir, 'state.db'));
      a.deepEqual(fx.store.conversationTurns('qqbot-c2c-body-stall').map(row => row.role), ['user']);
      const calls = fx.store.ownLlmCalls();
      const attempts = fx.store.ownLlmAttempts();
      a.equal(calls.length, 1); a.equal(calls[0].status, 'cancelled'); a.equal(calls[0].usage, null);
      a.equal(attempts.length, 1); a.equal(attempts[0].status, 'cancelled'); a.equal(attempts[0].usage, null);
      const accounting = sumOwnAttemptUsage(calls, attempts);
      a.equal(accounting.pendingCalls, 0); a.equal(accounting.pendingAttempts, 0);
      a.equal(accounting.accountingComplete, false); a.equal(accounting.unknownCalls, 1);
    } finally {
      await engine.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('own真实HTTP200体挂起:总期限断连接不重试，重开同会话恢复且未知成本仍挡验收', async () => {
    const fx = tempFixture();
    let disconnected;
    const closed = new Promise(resolve => { disconnected = resolve; });
    let count = 0;
    const bodies = [];
    const server = http.createServer((req, res) => {
      count++;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        if (count === 1) { res.write('{"choices":['); res.on('close', disconnected); }
        else res.end(JSON.stringify({ choices: [{ message: { content: '恢复成功指纹' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
            prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let headers = 0;
    const llm = createLlmClient({ baseUrl: 'http://127.0.0.1:' + server.address().port,
      apiKey: 'isolated', model: 'isolated', retryDelayMs: 1, log: {},
      fetchImpl: async (...args) => { const response = await fetch(...args); headers++; return response; } });
    let engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, budget: null });
    const key = 'qqbot-c2c-body-timeout';
    try {
      await engine.initialize();
      const result = await engine.runTurn(key, '响应体挂起用户指纹', 500);
      a.equal(result.timedOut, true); a.equal(headers, 1, 'actual 200 headers reached client before deadline');
      const guard = setTimeout(() => disconnected('timeout'), 2000);
      try { a.notEqual(await closed, 'timeout'); } finally { clearTimeout(guard); }
      a.equal(count, 1, 'engine total deadline prevents HTTP retry'); a.equal(engine.isBusy(key), false);
      await engine.stop(); fx.store.close();
      fx.store = new SqliteStateStore(path.join(fx.dir, 'state.db'));
      a.deepEqual(fx.store.conversationTurns(key).map(row => row.role), ['user']);
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, budget: null });
      await engine.initialize();
      const recovered = await engine.runTurn(key, '下一轮恢复用户指纹', 5000);
      a.equal(recovered.timedOut, false); a.equal(count, 2);
      a.ok(bodies[1].messages.some(row => String(row.content).includes('响应体挂起用户指纹')));
      a.deepEqual(fx.store.conversationTurns(key).map(row => row.role), ['user', 'user', 'assistant']);
      const calls = fx.store.ownLlmCalls(), attempts = fx.store.ownLlmAttempts();
      a.deepEqual(calls.map(row => row.status), ['cancelled', 'completed']);
      a.deepEqual(attempts.map(row => row.status), ['cancelled', 'completed']);
      a.equal(attempts[0].usage, null); a.equal(calls[0].usage, null);
      const accounting = sumOwnAttemptUsage(calls, attempts);
      a.equal(accounting.pendingCalls, 0); a.equal(accounting.pendingAttempts, 0);
      a.equal(accounting.unknownCalls, 1); a.equal(accounting.accountingComplete, false);
      a.equal(accounting.totals.promptTokens, 10); a.equal(accounting.totals.completionTokens, 2);
    } finally {
      await engine.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });


  test('runner契约:纯函数是唯一一份实现，own/转录依赖图不再加载任何 DSH 模块(6B)', async () => {
    // 6B 去 DSH 化(1.150.84):旧 `src\dsh.js` 已退役 ⇒ 不再有"与旧导出同一实现"可比;
    // 改成两条更强的判据:① 全仓库没有文件再 import DSH 连接段;② 依赖图里也不许出现(防间接回流)。
    const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      ? (e.name === 'node_modules' || e.name === 'data' ? [] : walk(path.join(dir, e.name)))
      : (/\.(?:js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : [])));
    const offenders = walk(BRIDGE_ROOT).filter((f) => /from\s*['"][^'"]*(?:\/|\.)(dsh|dsh-service|dsh-turn-waiter|shadow-runner|shadow-llm)\.js['"]/.test(fs.readFileSync(f, 'utf8')));
    a.deepEqual(offenders.map((f) => path.relative(BRIDGE_ROOT, f)), [], '还有文件在 import 已退役的 DSH 连接段');
    a.equal(runnerContract.sanitizeSessionId('qqbot-c2c-a/b 中文'), 'qqbot-c2c-a_b___');
    a.equal(runnerContract.sanitizeSessionId('a'.repeat(200)), 'a'.repeat(120));
    a.equal(runnerContract.describeTurnEnd({ kind: 'completed' }), null);
    a.equal(runnerContract.describeTurnEnd({ kind: 'error', error: { code: 'TEST' } }), '（本轮出错：TEST）');
    a.equal(runnerContract.extractAssistantText({ type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '不能出现' }, { type: 'text', text: '可见' }, { type: 'text', text: '回复' },
    ] } } }), '可见回复');
    a.equal(runnerContract.extractAssistantText({ type: 'assistant/message', data: { message: { content: [] } } }), null);
    const visited = new Set();
    function inspect(url) {
      if (visited.has(url.href)) return; visited.add(url.href);
      a.ok(!/(?:dsh|dsh-service|jsonrpc|supervisor)\.js$/.test(url.pathname), 'own/history graph must not import runtime adapter: ' + url.pathname);
      const source = fs.readFileSync(url, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) inspect(new URL(match[1], url));
    }
    inspect(new URL('../src/engine.js', import.meta.url));
    inspect(new URL('../src/transcript.js', import.meta.url));
    a.ok(visited.size > 2, '实际检查传递依赖而非只检查入口文本');
    a.ok(!/\bimport\b/.test(fs.readFileSync(new URL('../src/runner-contract.js', import.meta.url), 'utf8')), '契约模块零import');
  });
  test('engine:历史回放隔离、无未来答案泄漏、非文本轮跳过', replaySelftest);
  test('engine:生命周期诊断夹具不泄漏答案（非迁移验收）', probeIntegrity);
  test('engine:七项消费端生命周期验收（上下文覆盖/恢复/reset/cap）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-lifecycle-'));
    try {
      const results = await diagnose(dir);
      a.equal(results.length, 7);
      a.deepEqual(results.filter(row => !row.passed).map(row => row.id), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('engine:独立进程非正常退出恢复摘要和reset边界，不重新摘要', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-process-'));
    try { a.equal(probeRecovery(dir).length, 4); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });



  test('engine:总期限覆盖摘要、迟到响应不落库、stop取消在途和排队', async () => {
    const fx = tempFixture();
    let engine;
    let late;
    const signals = [];
    try {
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
        llm: { chat(messages, opts) { signals.push(opts.signal); return new Promise(resolve => { late = resolve; }); } } });
      await engine.initialize();
      const expired = await engine.runTurn('k', 'deadline-user', 10);
      a.equal(expired.timedOut, true);
      a.equal(signals[0].aborted, true);
      late({ text: '迟到不应提交' });
      await Promise.resolve();
      a.deepEqual(fx.store.conversationTurns('k').map(row => row.role), ['user']);
      const live = engine.runTurn('k', 'live');
      const queued = engine.runTurn('k', 'queued');
      const settled = Promise.allSettled([live, queued]);
      await new Promise(resolve => setImmediate(resolve));
      a.equal(engine.isBusy('k'), true);
      const stopping = engine.stop();
      a.equal(engine.stop(), stopping);
      await stopping;
      const results = await settled;
      a.ok(results.every(row => row.status === 'rejected' && /stopped/.test(row.reason.message)));
      a.equal(signals.length, 2, '排队轮在stop后不再请求模型');
      a.equal(engine.isBusy(), false);
      a.ok(!fx.store.conversationTurns('k').some(row => row.content === 'queued'));
      await a.rejects(engine.runTurn('k', 'after'), /stopped/);
      // Deadline while summarizing must not be swallowed as ordinary summary failure.
      fx.store.appendConversationTurn({ key: 'summary', role: 'user', content: '压缩对照'.repeat(300) });
      fx.store.appendConversationTurn({ key: 'summary', role: 'assistant', content: '最近原文对照' });
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath,
        budget: { triggerTokens: 100, keepRecentTokens: 1, summaryCapTokens: 50, hysteresisMarginTokens: 10 },
        llm: { chat() { return new Promise(() => {}); } } });
      await engine.initialize();
      a.equal((await engine.runTurn('summary', 'new', 10)).timedOut, true);
      a.equal(fx.store.conversationTurns('summary').length, 2, '摘要取消不进入主轮或裁剪原文');
      a.equal(JSON.parse(fx.store.getMeta('own-engine:v1:summary')).armed, true,
        '摘要取消恢复武装，下一轮不能永久卡在迟滞状态');
    } finally {
      if (engine) await engine.stop();
      fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('own账本生命周期:成功/失败/关停后迟到start/end不得写入或访问已关闭库', async () => {
    for (const mode of ['completed', 'failed', 'cancelled']) {
      const fx = tempFixture();
      let options, attemptId, engine;
      try {
        engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
          llm: { chat(messages, opts) {
            options = opts; attemptId = opts.onAttemptStart();
            if (mode === 'cancelled') return new Promise(() => {});
            if (mode === 'failed') throw new Error('isolated lifecycle failure');
            opts.onAttemptEnd(attemptId, { status: 'completed', usage: null, httpStatus: 200 });
            return { text: '正常回复' };
          } } });
        await engine.initialize();
        const turn = engine.runTurn('lifecycle', mode);
        // Attach rejection handler before stop/fixture rejection can settle.
        const outcome = Promise.allSettled([turn]);
        await new Promise(resolve => setImmediate(resolve));
        await engine.stop();
        const [result] = await outcome;
        a.equal(result.status, mode === 'completed' ? 'fulfilled' : 'rejected');
        a.deepEqual(fx.store.ownLlmCalls().map(row => row.status), [mode]);
        a.deepEqual(fx.store.ownLlmAttempts().map(row => row.status), [mode]);
        a.throws(() => options.onAttemptStart(), /closed|stopped/, '迟到start必须在访问store前拒绝');
        a.doesNotThrow(() => options.onAttemptEnd(attemptId, { status: 'completed', usage: {} }));
        a.equal(fx.store.ownLlmAttempts().length, 1, '迟到start不新增孤儿账');
        a.equal(fx.store.ownLlmAttempts()[0].status, mode, '迟到end不覆盖结案状态');
        fx.store.close();
        a.throws(() => options.onAttemptStart(), /closed|stopped/, '关闭库后仍应报生命周期原因而非数据库错误');
        a.doesNotThrow(() => options.onAttemptEnd(attemptId, { status: 'completed', usage: {} }));
      } finally { if (engine) await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
    }
  });

  test('own容量配置:正整数或留空，真实engine消费配置且主入口接线存在', async () => {
    const saved = process.env.QQBOT_OWN_INPUT_TOKEN_LIMIT;
    const fx = tempFixture(); let engine; let calls = 0;
    try {
      delete process.env.QQBOT_OWN_INPUT_TOKEN_LIMIT;
      a.equal(buildEngineConfig().inputTokenLimit, null);
      for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992', '01']) {
        process.env.QQBOT_OWN_INPUT_TOKEN_LIMIT = value;
        a.throws(() => buildEngineConfig(), /QQBOT_OWN_INPUT_TOKEN_LIMIT/);
      }
      process.env.QQBOT_OWN_INPUT_TOKEN_LIMIT = '1'; // Test-only rejection threshold, never a production proposal.
      const cfg = buildEngineConfig(); a.equal(cfg.inputTokenLimit, 1);
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
        inputTokenLimit: cfg.inputTokenLimit, llm: { async chat() { calls++; return { text: '不应请求' }; } } });
      await engine.initialize();
      await a.rejects(engine.runTurn('cap-config', '超过测试专用上限的输入'), /input capacity exceeded/);
      a.equal(calls, 0); a.equal(fx.store.ownLlmCalls().length, 0);
      const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
      a.match(source, /createOwnEngine\(\{[\s\S]*?inputTokenLimit: config\.engine\.inputTokenLimit/);
    } finally {
      if (saved === undefined) delete process.env.QQBOT_OWN_INPUT_TOKEN_LIMIT; else process.env.QQBOT_OWN_INPUT_TOKEN_LIMIT = saved;
      if (engine) await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('own容量:显式上限拒绝摘要失败后的超限主轮，图片未知不当零token', async () => {
    const fx = tempFixture('测试');
    let engine;
    let requests = 0;
    try {
      fx.store.appendConversationTurn({ key: 'full', role: 'user', content: '事实蓝钥匙'.repeat(500) });
      fx.store.appendConversationTurn({ key: 'full', role: 'assistant', content: '最近原文' });
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, inputTokenLimit: 100,
        budget: { triggerTokens: 80, keepRecentTokens: 10, summaryCapTokens: 30, hysteresisMarginTokens: 10 },
        log: { warn() {} }, llm: { async chat() { requests++; throw new Error('summary failed'); } } });
      await engine.initialize();
      await a.rejects(engine.runTurn('full', 'new'), error => error.code === 'OWN_INPUT_CAPACITY');
      a.equal(requests, 0, '摘要本身超限也不发，主轮不绕过');
      a.equal(fx.store.conversationTurns('full').length, 2);
      a.equal(JSON.parse(fx.store.getMeta('own-engine:v1:full')).coveredId, 0);
      await engine.stop();
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, inputTokenLimit: 100,
        estimateInputTokens: messages => messages[0].role === 'user' ? 50 : 101,
        budget: { triggerTokens: 80, keepRecentTokens: 10, summaryCapTokens: 30, hysteresisMarginTokens: 10 },
        log: { warn() {} }, llm: { async chat() { requests++; throw new Error('summary failed'); } } });
      await engine.initialize();
      await a.rejects(engine.runTurn('full', 'new'), error => error.code === 'OWN_INPUT_CAPACITY');
      // ⚠️ 2026-10-15(F1 退避)语义更新:上一次"摘要被容量拦下"的失败现场**已经落盘**,
      //    而这个新实例面对的**水位没变** ⇒ 按新规则**不许再花一次**(旧行为是每轮重试)。
      //    "退避不是永远不试":水位实质增长后仍会再试 —— 那条判据在新suite
      //    `selftest-compaction-backoff.js` 里钉着。
      a.equal(requests, 0, '水位没变就不重复付费(退避);主轮照样被容量拒绝');
      a.equal(fx.store.conversationTurns('full').length, 2);
      await engine.stop();
      const beforeSmall = requests;
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null, inputTokenLimit: 100,
        llm: { async chat() { requests++; return { text: '正常小轮' }; } } });
      await engine.initialize();
      await engine.runTurn('small', '小轮');
      a.equal(requests, beforeSmall + 1, '闸门不拒绝合规文本');
      await a.rejects(engine.runTurn('imagecap', 'image', 5000, ['data:image/png;base64,QUJD']), /capacity unknown/);
      a.equal(fx.store.conversationTurns('imagecap').length, 0);
      await engine.stop();
      const beforeImage = requests;
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
        inputTokenLimit: 100, estimateInputTokens: messages => {
          a.ok(messages.at(-1).content.some(block => block.type === 'image_url'), '容量器实际收到本轮图'); return 101;
        }, llm: { async chat() { requests++; } } });
      await engine.initialize();
      await a.rejects(engine.runTurn('imagecap', 'image', 5000, ['data:image/png;base64,QUJD']), /capacity exceeded/);
      a.equal(requests, beforeImage, '图片超限不新增模型调用');
    } finally { if (engine) await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('own成本账:HTTP重试逐发记账，最终成功不掩盖无usage失败成本', async () => {
    const fx = tempFixture();
    let count = 0;
    const client = createLlmClient({ baseUrl: 'https://invalid.test', apiKey: 'test', sleep: async () => {},
      log: { warn() {} }, fetchImpl: async () => {
        count++;
        if (count === 1) return { ok: false, status: 503, text: async () => 'test' };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }],
          usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 90 } }) };
      } });
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm: client, budget: null });
    try {
      await engine.initialize(); await engine.runTurn('retrycost', 'retry');
      const attempts = fx.store.ownLlmAttempts();
      a.equal(count, 2); a.equal(attempts.length, count, '下游实际fetch次数等于持久账条数');
      a.deepEqual(attempts.map(row => row.status), ['failed', 'completed']);
      a.deepEqual(attempts.map(row => row.http_status), [503, 200]);
      const ledger = sumOwnAttemptUsage(fx.store.ownLlmCalls(), attempts);
      a.equal(ledger.logicalCalls, 1); a.equal(ledger.httpAttempts, 2); a.equal(ledger.calls, 1);
      a.equal(ledger.unknownCalls, 1); a.equal(ledger.accountingComplete, false);
      a.equal(compareVerdict({ own: ledger, dsh: { calls: 1, totals: {} } }).verdict, 'insufficient');
      a.equal(sumOwnAttemptUsage(fx.store.ownLlmCalls(), []).missingCalls, 1, '旧客户端不支持回调不能冒充全覆盖');
    } finally { await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('own成本账:不完整usage/非法计数/未闭合覆盖不能被零值默认判赢', () => {
    const usage = { promptTokens: 100, completionTokens: 2, cacheHitTokens: 90, cacheMissTokens: 10 };
    const calls = [{ id: 1, kind: 'main', status: 'completed' }];
    const attempt = { call_id: 1, status: 'completed', usage };
    const partials = [
      { ...usage, completionTokens: null }, { ...usage, cacheHitTokens: null },
      { ...usage, cacheMissTokens: 11 }, { ...usage, cacheHitTokens: 101 },
      { ...usage, promptTokens: -1 }, { ...usage, completionTokens: NaN },
      { ...usage, completionTokens: 0.5 }, { ...usage, promptTokens: Infinity },
    ];
    for (const partial of partials) {
      const ledger = sumOwnAttemptUsage(calls, [{ ...attempt, usage: partial }]);
      a.equal(ledger.unknownCalls, 1); a.equal(ledger.calls, 0);
      a.equal(ledger.totals.completionTokens, 0, 'partial row excluded, not partially priced');
      a.equal(compareVerdict({ own: ledger, dsh: { calls: 1, totals: { inputTokens: 999999 } } }).verdict, 'insufficient');
    }
    for (const [cs, ats] of [
      [[{ ...calls[0], status: 'pending' }], [attempt]],
      [calls, [{ ...attempt, status: 'pending' }]],
      [calls, [{ ...attempt, call_id: 999 }]],
    ]) {
      const ledger = sumOwnAttemptUsage(cs, ats);
      a.equal(ledger.accountingComplete, false); a.equal(ledger.retryAccountingComplete, false);
    }
    const complete = sumOwnAttemptUsage(calls, [attempt]);
    a.equal(complete.accountingComplete, true); a.equal(complete.calls, 1);
    a.equal(complete.totals.cacheMissTokens, 10);
    const zero = sumOwnAttemptUsage(calls, [{ ...attempt, usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 } }]);
    a.equal(zero.accountingComplete, true, 'explicit zero is known');
  });

  test('own真实HTTP摘要成本:摘要及主轮逐发入账，恢复后实际请求消费摘要且总量不漏算', async () => {
    const fx = tempFixture();
    const bodies = [];
    const summary = 'HTTP摘要指纹：蓝色钥匙在旧钟楼。';
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        const n = bodies.length;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: n === 1 ? summary : '主轮成功' } }],
          usage: { prompt_tokens: n * 10, completion_tokens: n,
            prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: n * 10 } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const llm = createLlmClient({ baseUrl: 'http://127.0.0.1:' + server.address().port,
      apiKey: 'isolated', model: 'isolated', attempts: 1, log: {} });
    const key = 'qqbot-c2c-http-summary-cost';
    fx.store.appendConversationTurn({ key, role: 'user', content: '蓝色钥匙在旧钟楼。' + '归档历史。'.repeat(400) });
    fx.store.appendConversationTurn({ key, role: 'assistant', content: '收到。' });
    let engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm,
      budget: { triggerTokens: 900, keepRecentTokens: 10, summaryCapTokens: 180, hysteresisMarginTokens: 100 } });
    try {
      await engine.initialize(); await engine.runTurn(key, '第一主轮', 5000);
      a.equal(bodies.length, 2, 'real HTTP summary then main');
      a.ok(bodies[0].messages[0].content.includes('蓝色钥匙在旧钟楼'));
      a.ok(bodies[1].messages.some(row => row.role === 'system' && row.content.includes(summary)));
      await engine.stop(); fx.store.close(); fx.store = new SqliteStateStore(path.join(fx.dir, 'state.db'));
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, budget: null });
      await engine.initialize(); await engine.runTurn(key, '重开主轮', 5000);
      a.equal(bodies.length, 3);
      a.ok(bodies[2].messages.some(row => row.role === 'system' && row.content.includes(summary)));
      a.ok(!bodies[2].messages.some(row => row.content.includes('归档历史。'.repeat(10))), 'covered raw text excluded from request');
      a.equal(fx.store.conversationTurns(key).length, 6, 'original history remains append-only');
      const calls = fx.store.ownLlmCalls(), attempts = fx.store.ownLlmAttempts();
      a.deepEqual(calls.map(row => row.kind), ['summary', 'main', 'main']);
      a.ok(calls.every(row => row.status === 'completed')); a.equal(attempts.length, 3);
      for (let i = 0; i < 3; i++) {
        a.equal(attempts[i].call_id, calls[i].id); a.equal(attempts[i].http_status, 200);
        a.deepEqual(attempts[i].usage, calls[i].usage);
      }
      const account = sumOwnAttemptUsage(calls, attempts);
      a.equal(account.accountingComplete, true); a.equal(account.unknownCalls, 0);
      a.equal(account.logicalCalls, 3); a.equal(account.httpAttempts, 3);
      a.equal(account.totals.promptTokens, 60); a.equal(account.totals.completionTokens, 6);
    } finally {
      await engine.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('own成本账:空回复/摘要/失败/取消不遗漏，未知不判赢', async () => {
    const fx = tempFixture();
    let engine;
    try {
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
        llm: fakeLlm([{ text: '', usage: USAGE }, { throw: new Error('network test') }]) });
      await engine.initialize();
      await engine.runTurn('cost', '空回复对照');
      await a.rejects(engine.runTurn('cost', '失败对照'), /network test/);
      await engine.stop();
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
        llm: { chat: () => new Promise(() => {}) } });
      await engine.initialize();
      await engine.runTurn('cancel', '取消对照', 10);
      const calls = fx.store.ownLlmCalls();
      a.deepEqual(calls.map(row => row.status), ['completed', 'failed', 'cancelled']);
      a.equal(fx.store.conversationTurns('cost').filter(row => row.role === 'assistant').length, 0);
      const account = sumOwnCallUsage(calls);
      a.equal(account.calls, 1); a.equal(account.logicalCalls, 3); a.equal(account.unknownCalls, 2);
      a.equal(compareVerdict({ own: account, dsh: { calls: 1, totals: { inputTokens: 999999 } } }).verdict, 'insufficient');
      await engine.stop();
      fx.store.appendConversationTurn({ key: 'summarycost', role: 'user', content: '历史'.repeat(1000) });
      fx.store.appendConversationTurn({ key: 'summarycost', role: 'assistant', content: '最近对照' });
      engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath,
        budget: { triggerTokens: 900, keepRecentTokens: 10, summaryCapTokens: 180, hysteresisMarginTokens: 100 },
        llm: fakeLlm([{ text: '摘要对照', usage: USAGE }, { text: '', usage: USAGE }]) });
      await engine.initialize(); await engine.runTurn('summarycost', '主轮对照');
      a.deepEqual(fx.store.ownLlmCalls().slice(-2).map(row => row.kind), ['summary', 'main']);
      a.equal(sumOwnCallUsage(fx.store.ownLlmCalls()).calls, 3, '摘要与空主轮真实usage均进入账');
    } finally { if (engine) await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('成本CLI诊断:旧mtime不漏扫，读取错误显式暴露，未知不输出贵便宜', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
    try {
      for (const name of ['qqbot-old', 'qqbot-aris-broken', 'other']) {
        const folder = path.join(dir, name); fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, 'session.v4.jsonl.zstd'), 'fixture');
        fs.utimesSync(folder, new Date(0), new Date(0));
      }
      const report = collectDshUsageDiagnostic(dir, { readRecords: file => {
        if (file.includes('broken')) throw new Error('broken fingerprint');
        return [{ data: { usage: { inputTokens: 17, outputTokens: 3 } } }];
      } });
      a.equal(report.calls, 1); a.equal(report.totals.inputTokens, 17);
      a.equal(report.files, 2); a.equal(report.readFiles, 1);
      a.equal(report.errors[0].error, 'broken fingerprint'); a.equal(report.readComplete, false);
      a.equal(report.botMatched, false); a.equal(report.timeWindowMatched, false);
      const missing = collectDshUsageDiagnostic(path.join(dir, 'missing'));
      a.equal(missing.errors.length, 1); a.equal(missing.readComplete, false);
      const text = diagnosticComparisonText({ verdict: 'insufficient', weightedOk: null, warmOk: null,
        ownPerCall: 2, dshPerCall: 1, coldPerCall: 3 }).join('\n');
      a.ok(text.includes('未建立匹配基线')); a.ok(!text.includes('→ 贵了')); a.ok(!text.includes('已知比现状贵'));
      const cli = fs.readFileSync(new URL('./usage-compare.js', import.meta.url), 'utf8');
      a.ok(cli.includes('collectDshUsageDiagnostic(sessionsRoot)'));
      a.ok(cli.includes('diagnosticComparisonText(verdict)'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('own完整入口容量:显式env经main拦截QQ入站，无HTTP/账本/被拒轮次', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-cap-main-'));
    try {
      const report = probeOwnMain(dir, { capacityReject: true });
      a.equal(report.capacityRejected, true); a.equal(report.rejectedTurnNotPersisted, true);
      a.equal(report.modelRequests, 0); a.equal(report.logicalCalls, 0); a.equal(report.httpAttempts, 0);
      a.equal(report.gatewayStopped, true); a.equal(report.exitCode, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('own完整入口:隔离main模拟QQ入站到出站、真实一分钟归档与SIGTERM关停', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-main-'));
    try {
      const report = probeOwnMain(dir);
      a.equal(report.modelRequests, 3); a.equal(report.outboundMatched, true);
      a.equal(report.cancellation.requestAborted, true); a.equal(report.cancellation.noCancelledAssistant, true);
      a.equal(report.cancellation.finalUnknownAttempts, 2); a.equal(report.cancellation.finalPendingCalls, 0);
      a.equal(report.cancellation.finalPendingAttempts, 0);
      a.equal(report.accounting.logicalCalls, 1); a.equal(report.accounting.httpAttempts, 2);
      a.equal(report.accounting.unknownAttempts, 1); a.equal(report.accounting.accountingComplete, false);
      a.equal(report.accounting.normalizedUsageMatched, true); a.equal(report.accounting.failedUsageNotZero, true);
      a.equal(report.archivedReplyMatched, true); a.equal(report.ownSourceMatched, true);
      // ⚠️ 2026-10-16(1.150.80):私聊追问轮也"窗内补图"(carry 群私同构)——上一轮的图在追问轮
      //    会**重取一次**;但本场景 msg2 后 50ms 就 SIGTERM,取消可能抢在取图前 ⇒ 竞态有界断言:
      //    downloads ∈ {1(未及重取), 2(已重取)},其余三格语义不变。
      a.ok(report.image.downloads === 1 || report.image.downloads === 2,
        `downloads ∈ {1,2}(触发1次+追问轮至多1次carry重取),实际 ${report.image.downloads}`);
      a.deepEqual({ modelBodyMatched: report.image.modelBodyMatched,
        persistedSourceMatched: report.image.persistedSourceMatched,
        nextTurnRetained: report.image.nextTurnRetained },
        { modelBodyMatched: true, persistedSourceMatched: true, nextTurnRetained: true });
      a.equal(report.gatewayStopped, true); a.equal(report.exitCode, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('own归档来源:缺失/伪类型reset及用户链接、未来引用拒绝且目标无部分写入', () => {
    for (const bad of ['missing-reset', 'string-reset', 'negative-reset', 'string-user', 'future-user', 'unknown-role']) {
      const fx = tempFixture();
      const db = openMemory(path.join(fx.dir, 'memory.db'));
      try {
        const userId = fx.store.appendConversationTurn({ key: 'qqbot-c2c-valid', role: 'user', content: '合法控制用户',
          meta: { source: 'own-engine', resetId: 0 } });
        fx.store.appendConversationTurn({ key: 'qqbot-c2c-valid', role: 'assistant', content: '合法控制回复',
          meta: { source: 'own-engine', resetId: 0, userTurnId: userId } });
        const meta = { source: 'own-engine', resetId: 0 };
        if (bad === 'missing-reset') delete meta.resetId;
        if (bad === 'string-reset') meta.resetId = '0';
        if (bad === 'negative-reset') meta.resetId = -1;
        if (bad === 'string-user') meta.userTurnId = String(userId);
        if (bad === 'future-user') meta.userTurnId = 4;
        fx.store.appendConversationTurn({ key: 'qqbot-c2c-valid',
          role: bad.includes('user') ? 'assistant' : bad === 'unknown-role' ? 'system' : 'user', content: '坏记录', meta });
        if (bad === 'future-user') fx.store.appendConversationTurn({ key: 'qqbot-c2c-valid', role: 'user', content: '未来用户',
          meta: { source: 'own-engine', resetId: 0 } });
        a.throws(() => archiveOwnHistory({ db, stateFile: path.join(fx.dir, 'state.db') }), /invalid (provenance|assistant linkage)/, bad);
        a.equal(db.prepare('SELECT COUNT(*) n FROM turn').get().n, 0, bad + '不部分导入合法控制轮');
        a.equal(db.prepare('SELECT COUNT(*) n FROM session').get().n, 0);
        a.equal(db.prepare("SELECT value FROM meta WHERE key='own_archive_at'").get(), undefined, '失败不推进水位');
      } finally { db.close(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
    }
  });

  test('own归档墙钟:独立进程真实timer缺源失败恢复、摘要消费与关闭闸门', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-wallclock-'));
    try {
      const report = probeArchiveWallclock(dir);
      a.equal(report.sourceMissingAtStartup, true); a.ok(report.archiveErrors >= 2);
      a.equal(report.archivedReplyMatched, true); a.equal(report.summaryCalls, 1);
      a.equal(report.disabledTicks, 2); a.ok(report.statuses.includes('completed'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('own启动归档:源库不可读不禁用记忆，源恢复后实际tick自动补入', async () => {
    const fx = tempFixture();
    const db = openMemory(path.join(fx.dir, 'memory.db'));
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
      llm: fakeLlm([{ text: '启动恢复蓝色钥匙', usage: USAGE }]) });
    let sourceFile = path.join(fx.dir, 'missing.db'), clock = 1000;
    const failures = [], flags = [];
    const scan = quiet => { flags.push(quiet); return archiveOwnHistory({ db, stateFile: sourceFile }); };
    try {
      await engine.initialize(); await engine.runTurn('qqbot-c2c-startup', '启动恢复事实');
      const runner = startMemoryArchive(scan, error => failures.push(error.message));
      a.equal(runner, scan); a.equal(failures.length, 1);
      a.equal(fs.existsSync(sourceFile), false, '只读扫描不创建缺失源库');
      a.equal(db.prepare('SELECT COUNT(*) n FROM turn').get().n, 0, '目标库仍可读');
      const tick = createMemoryArchiveTick({ getRunner: () => runner, everyMs: 100,
        now: () => clock, afterArchive: () => {}, onArchiveError: error => failures.push(error.message),
        onSummaryError: error => { throw error; } });
      sourceFile = path.join(fx.dir, 'state.db'); clock = 1100;
      a.equal(tick().status, 'completed');
      a.ok(db.prepare('SELECT reply_text FROM turn').get().reply_text.includes('启动恢复蓝色钥匙'));
      a.deepEqual(flags, [false, true], '首次扫描与周期扫描走同一runner');
      const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
      a.ok(source.includes('archiveRunner = startMemoryArchive(runArchive,'), '启动失败不会绕过runner安装');
    } finally { await engine.stop(); db.close(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('own归档定时:实际调度器落库、失败重试、摘要消费顺序与关闭闸门', async () => {
    const fx = tempFixture();
    const db = openMemory(path.join(fx.dir, 'memory.db'));
    const key = 'qqbot-c2c-tick';
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
      llm: fakeLlm([{ text: '定时归档的蓝色钥匙。', usage: USAGE }]) });
    let clock = 1000, fail = true, enabled = true, summaryCalls = 0;
    const failures = [], summaryErrors = [], quietFlags = [];
    const runner = quiet => {
      quietFlags.push(quiet);
      if (fail) throw new Error('scan failed control');
      return archiveOwnHistory({ db, stateFile: path.join(fx.dir, 'state.db'), now: clock });
    };
    const tick = createMemoryArchiveTick({ now: () => clock, everyMs: 100,
      getRunner: () => enabled ? runner : null,
      onArchiveError: error => failures.push(error.message),
      onSummaryError: error => summaryErrors.push(error.message),
      afterArchive: () => {
        summaryCalls++;
        const turn = db.prepare('SELECT reply_text FROM turn').get();
        a.ok(turn.reply_text.includes('蓝色钥匙'), '摘要回调消费端已经看见归档回复');
        if (summaryCalls === 1) throw new Error('summary failed control');
      },
    });
    try {
      await engine.initialize(); await engine.runTurn(key, '请记住定时归档蓝色钥匙。');
      a.equal(tick().status, 'not_due');
      a.equal(db.prepare('SELECT COUNT(*) n FROM turn').get().n, 0);
      clock = 1100;
      a.equal(tick().status, 'failed'); a.deepEqual(failures, ['scan failed control']);
      a.equal(summaryCalls, 0); a.equal(db.prepare('SELECT COUNT(*) n FROM turn').get().n, 0);
      fail = false; clock = 1101;
      const retry = tick();
      a.equal(retry.status, 'completed', '失败未推进水位，下一拍即重试');
      a.equal(retry.result.changed, 1);
      await new Promise(resolve => setImmediate(resolve));
      a.deepEqual(summaryErrors, ['summary failed control']);
      a.equal(summaryCalls, 1); a.equal(tick().status, 'not_due', '摘要失败不重复已成功归档');
      clock = 1201;
      a.equal(tick().result.changed, 0);
      await new Promise(resolve => setImmediate(resolve));
      a.equal(summaryCalls, 2); a.ok(quietFlags.every(value => value === true));
      enabled = false; clock = 1400;
      a.equal(tick().status, 'disabled'); a.equal(summaryCalls, 2);
      const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
      a.ok(indexSource.includes('const memoryArchiveTick = createMemoryArchiveTick({'), '生产路径使用被验调度器');
      a.ok(indexSource.includes('getRunner: () => archiveRunner'));
      a.ok(indexSource.includes('memoryArchiveTick();'), '实际主循环调用该回调');
    } finally { await engine.stop(); db.close(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('own归档:真实engine写入、未完成补全、幂等、检索消费端和来源隔离', async () => {
    const fx = tempFixture();
    let db = openMemory(path.join(fx.dir, 'memory.db'));
    const key = 'qqbot-c2c-archive';
    let finish;
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null,
      turnContributors: [{ kind: 'facts', render: () => '注入污染对照不能入记忆' }],
      llm: { chat: () => new Promise(resolve => { finish = resolve; }) } });
    const archive = () => archiveOwnHistory({ db, stateFile: path.join(fx.dir, 'state.db'), now: 2000000 });
    try {
      await engine.initialize();
      fx.store.appendConversationTurn({ key, role: 'user', content: '旧影子污染对照' });
      const turn = engine.runTurn(key, '第一次钓鱼时，我们在旧钟楼约好归还蓝色钥匙。');
      await new Promise(resolve => setImmediate(resolve));
      a.equal(archive().changed, 1);
      const pending = db.prepare('SELECT * FROM turn').get();
      a.equal(pending.reply_text, null);
      a.ok(!pending.user_text.includes('注入污染对照'));
      finish({ text: '我记得第一次钓鱼和蓝色钥匙。', usage: USAGE }); await turn;
      a.equal(archive().changed, 1, '补全先前未完成轮');
      db.prepare('UPDATE memory_tag SET created_at=123').run();
      const unchangedTags = db.prepare('SELECT * FROM memory_tag ORDER BY session_id,seq,tag').all();
      a.ok(unchangedTags.length > 0, '存在实际消费标签，不空集自证');
      const unchanged = archive();
      a.equal(unchanged.changed, 0, '重复归档不写重复轮');
      a.equal(unchanged.retagged, false, '空跑不重建全库标签');
      a.deepEqual(db.prepare('SELECT * FROM memory_tag ORDER BY session_id,seq,tag').all(), unchangedTags,
        '标签消费端时间指纹保持，证明没有删除重插');
      const renamed = archiveOwnHistory({ db, stateFile: path.join(fx.dir, 'state.db'), now: 3000000,
        peopleNames: ['蓝色钥匙', '旧钟楼'] });
      a.equal(renamed.changed, 0); a.equal(renamed.retagged, true, '仅规则输入变化仍重建');
      a.ok(db.prepare('SELECT * FROM memory_tag').all().every(row => row.created_at === 3000000));
      const reordered = archiveOwnHistory({ db, stateFile: path.join(fx.dir, 'state.db'), now: 4000000,
        peopleNames: ['旧钟楼', '蓝色钥匙', '旧钟楼'] });
      a.equal(reordered.retagged, false, '相同名字换序/重复不引发重建');
      const recall = makeLongTermProvider({ db, minAgeMs: 0, minScore: 0, repeatSuppressMs: 0 });
      const result = recall({ conversation: key, query: '第一次钓鱼', now: Date.now() + 1000 });
      a.ok(result.text.includes('蓝色钥匙'), '实际长期检索成品含own事实指纹');
      a.ok(!result.text.includes('污染对照'));
      a.equal(recall({ conversation: 'qqbot-c2c-other', query: '第一次钓鱼', now: Date.now() + 1000 }).text, '', '会话隔离');
      engine.resetConversation(key);
      const next = engine.runTurn(key, '新代对照');
      await new Promise(resolve => setImmediate(resolve)); finish({ text: '新代助手对照' }); await next;
      archive();
      a.equal(db.prepare('SELECT COUNT(*) n FROM session').get().n, 2, 'reset分开own会话段');
      a.equal(db.prepare('SELECT COUNT(*) n FROM turn').get().n, 2);
      a.equal(archive().skipped, 1, '旧无来源行不自动导入');
      db.close(); db = openMemory(path.join(fx.dir, 'memory.db'));
      a.equal(archive().changed, 0, '关库重开仍幂等');
      a.ok(makeLongTermProvider({ db, minAgeMs: 0, minScore: 0 })({ conversation: key,
        query: '第一次钓鱼', now: Date.now() + 1000 }).text.includes('蓝色钥匙'), '重开后检索事实保留');
      fx.store.appendConversationTurn({ key: 'qqbot-c2c-other', role: 'assistant', content: '错误配对对照',
        meta: { source: 'own-engine', userTurnId: fx.store.conversationTurns(key).find(row => row.meta?.source === 'own-engine').id, resetId: 0 } });
      a.throws(archive, /invalid assistant linkage/, '跨会话坏配对明确失败');
      a.equal(db.prepare('SELECT COUNT(*) n FROM turn').get().n, 2, '坏配对未部分写入记忆库');
      const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
      a.ok(indexSource.includes("if (config.engine?.mode === 'own')"));
      a.ok(indexSource.includes('stateFile: config.policy.stats.dbFile'));
    } finally { await engine.stop(); db.close(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('engine:视觉探针PNG的CRC、尺寸和逐像素不透明红色有独立判据', () => {
    const png = opaqueRedPng();
    a.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    let pixels;
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + length);
      a.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length));
      if (type === 'IHDR') {
        a.equal(data.readUInt32BE(0), 64); a.equal(data.readUInt32BE(4), 64);
        a.equal(data[8], 8); a.equal(data[9], 6);
      }
      if (type === 'IDAT') pixels = inflateSync(data);
      offset += length + 12;
    }
    a.equal(pixels.length, 64 * 257);
    for (let y = 0; y < 64; y++) {
      a.equal(pixels[y * 257], 0, '每行无filter');
      for (let x = 0; x < 64; x++) a.deepEqual([...pixels.subarray(y * 257 + 1 + x * 4, y * 257 + 5 + x * 4)], [255, 0, 0, 255]);
    }
  });

  test('engine:QQ图片到HTTP、追问不自动回放、旧图可摘要且原档保留、reset隔离', async () => {
    const fx = tempFixture();
    let engine;
    let db = fx.store;
    const requests = [];
    const sdk = { type: 'image', mimeType: 'image/png', data: 'QUJD' };
    const client = createLlmClient({ baseUrl: 'https://invalid.test/v1', apiKey: 'test', attempts: 1,
      fetchImpl: async (_, init) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ choices: [{ message: { content: '图片对照回复' } }] }) };
      } });
    try {
      engine = createOwnEngine({ store: db, personaPath: fx.personaPath, budget: null, llm: client });
      await engine.initialize();
      await engine.runTurn('image', '图片文本对照', 5000, [sdk]);
      // ⚠️ 1.150.81:图块后跟**接地指令**(模块级同一份常量,防记忆旧图带偏)。
      a.deepEqual(requests[0].messages.at(-1).content, [
        { type: 'text', text: '图片文本对照' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'text', text: IMAGE_GROUNDING_NOTE }]);
      a.deepEqual(db.conversationTurns('image')[0].meta.images, ['data:image/png;base64,QUJD']);
      await engine.stop(); db.close();
      db = new SqliteStateStore(path.join(fx.dir, 'state.db'));
      engine = createOwnEngine({ store: db, personaPath: fx.personaPath, llm: client,
        budget: { triggerTokens: 100, keepRecentTokens: 20, summaryCapTokens: 50, hysteresisMarginTokens: 10 } });
      await engine.initialize();
      await engine.runTurn('image', '刚才图是什么');
      // T4(2026-10-29):追问不再自动回放像素 —— 连续性由桥层显式来源供给(3min补图窗/引用绑定);
      // 历史文字提示保留(有几张图、本次未附带),模型不凭记忆猜细节。
      a.ok(!requests.at(-1).messages.some(m => Array.isArray(m.content) && m.content.some(c => c.image_url)),
        'T4:重新开库后的追问不再自动回放像素');
      a.ok(requests.at(-1).messages.some(m => typeof m.content === 'string' && m.content.includes('本次未附带')),
        '历史提示保留:有几张图、本次未附带');
      db.appendConversationTurn({ key: 'image', role: 'user', content: '长历史对照'.repeat(200) });
      await engine.runTurn('image', '继续说');
      a.ok(!requests.at(-1).messages.some(m => Array.isArray(m.content)), '超出近期窗的旧图不无限回放');
      a.ok(JSON.parse(db.getMeta('own-engine:v1:image')).coveredId > 0, '旧图不再钉死摘要游标');
      a.deepEqual(db.conversationTurns('image')[0].meta.images, ['data:image/png;base64,QUJD'], '摘要后原图存档不删');
      engine.resetConversation('image');
      await engine.runTurn('image', '新代对照');
      a.ok(!requests.at(-1).messages.some(m => Array.isArray(m.content)), 'reset不混入旧图');
      await a.rejects(engine.runTurn('bad', 'bad', 5000, [{ ...sdk, mimeType: 'text/plain' }]), /invalid encoded/);
      a.equal(db.conversationTurns('bad').length, 0, '坏图在入库/请求之前明确失败');
    } finally {
      if (engine) await engine.stop();
      db.close(); fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:多图历史不回放,本轮新图唯一且失败轮不累积请求', async () => {
    const fx = tempFixture();
    const requests = [];
    const client = createLlmClient({ baseUrl: 'https://invalid.test/v1', apiKey: 'test', attempts: 1,
      fetchImpl: async (_, init) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ choices: [{ message: { content: '收到' } }] }) };
      } });
    const urls = ['QUJD', 'REVG', 'R0hJ'].map(s => 'data:image/png;base64,' + s);
    for (const url of urls.slice(0, 2)) fx.store.appendConversationTurn({ key: 'bounded', role: 'user', content: '旧图', meta: { images: [url] } });
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, budget: null, llm: client });
    const received = () => requests.at(-1).messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'image_url').map(b => b.image_url.url) : []);
    try {
      await engine.initialize();
      await engine.runTurn('bounded', '刚才图呢');
      a.deepEqual(received(), [], 'T4:文字追问不再回放任何历史图');
      a.ok(JSON.stringify(requests.at(-1)).includes('本次未附带'), '旧图缺席明确标注,不冒充看过');
      await engine.runTurn('bounded', '看新图', 5000, [urls[2]]);
      a.deepEqual(received(), [urls[2]], '本轮图到HTTP且历史图全部退场');
      await engine.runTurn('bounded', '追问');
      a.deepEqual(received(), [], '追问不再回放(像素由显式来源供给)');
      a.equal(fx.store.conversationTurns('bounded').filter(r => r.meta?.images?.length).length, 3, '旧图原档全部保留');
    } finally { await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('engine:旧保图卡死状态升级一次恢复摘要,不永久取消失败退避', async () => {
    const fx = tempFixture('助手');
    const oldId = fx.store.appendConversationTurn({ key: 'stuck', role: 'user', content: '历史事实'.repeat(200), meta: { images: ['data:image/png;base64,QUJD'] } });
    fx.store.appendConversationTurn({ key: 'stuck', role: 'assistant', content: '近期'.repeat(80) });
    fx.store.setMeta('own-engine:v1:stuck', JSON.stringify({ version: 1, summary: '', coveredId: 0, resetId: 0, lastAt: null, armed: false,
      compactFailAt: { level: 10000, removedTokens: 0, at: 1 } }));
    const calls = [];
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath,
      budget: { triggerTokens: 100, keepRecentTokens: 1, summaryCapTokens: 50, hysteresisMarginTokens: 10 },
      llm: { async chat(messages) { calls.push(messages); return { text: messages.length === 1 ? '历史事实摘要' : '收到' }; } }, log: {} });
    try {
      await engine.initialize(); await engine.runTurn('stuck', '继续');
      const state = JSON.parse(fx.store.getMeta('own-engine:v1:stuck'));
      a.ok(state.coveredId >= oldId, '旧失败水位不阻止修复后的压缩');
      a.equal(state.imageHistoryVersion, 1);
      a.ok(calls[0][0].content.includes('本次未附带'), '摘要消费端明确知道图未附带');
      a.deepEqual(fx.store.conversationTurns('stuck')[0].meta.images, ['data:image/png;base64,QUJD']);
    } finally { await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('engine:连续增长多次压缩，旧摘要接力、覆盖递增、原文不删', async () => {
    const fx = tempFixture('测试助手');
    let compressions = 0;
    const summaries = [];
    const calls = [];
    const fact = '连续压缩事实指纹：澄月七号';
    const llm = { async chat(messages) {
      calls.push(structuredClone(messages));
      if (messages.length === 1) {
        compressions++;
        if (compressions > 1) a.ok(messages[0].content.includes('【旧摘要】\n' + fact), '下一次摘要收到旧事实');
        summaries.push(messages[0].content);
        return { text: fact, usage: USAGE };
      }
      return { text: '收到' };
    } };
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm,
      budget: { triggerTokens: 900, keepRecentTokens: 100, summaryCapTokens: 200, hysteresisMarginTokens: 100 } });
    try {
      await engine.initialize();
      await engine.runTurn('growth', fact);
      let covered = 0;
      for (let n = 0; n < 24; n++) {
        await engine.runTurn('growth', '增长对照' + n + '无关闲聊'.repeat(70));
        const saved = JSON.parse(fx.store.getMeta('own-engine:v1:growth'));
        a.ok(saved.coveredId >= covered); covered = saved.coveredId;
        a.ok(JSON.stringify(calls.at(-1)).includes('澄月七号'), '每次主轮消费端有事实');
      }
      a.ok(compressions >= 3, '长时间增长必须再次压缩而非永远迟滞');
      a.equal(fx.store.conversationTurns('growth').length, 50, '旧原文append-only不删除');
      a.equal(JSON.parse(fx.store.getMeta('own-engine:v1:growth')).compactionCalls.length, compressions);
    } finally { await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('engine:契约形状 + initialize 读人设(人设进桥,缺口三)', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: '呜哇!' }]);
    try {
      const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath });
      for (const method of ['initialize', 'runTurn', 'isBusy', 'sessionIdFor', 'resetConversation', 'stop', 'on']) {
        a.equal(typeof engine[method], 'function', `契约成员 ${method}`);
      }
      const info = await engine.initialize();
      a.equal(info.name, 'own-engine');
      a.equal(engine.sessionIdFor('qqbot-c2c-abc/路径'), 'qqbot-c2c-abc___', 'sessionIdFor 复用 sanitize 口径(/ 与每个非安全字符各换一个 _)');
      await engine.runTurn('k1', '你好');
      a.ok(llm.calls[0].messages[0].content.includes('红族的爆裂魔法使'), '稳定块 = 人设文件正文');
      a.equal(llm.calls[0].messages[0].role, 'system', '人设是最前的 system(稳定块前置)');
      a.equal(typeof engine.stop().then, 'function', 'stop 可 await');
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:全路径一轮 —— 落库含 usage(g1)、组装顺序、user 轮先落', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: '今天想去哪里玩?', usage: USAGE }]);
    try {
      const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath });
      await engine.initialize();
      const result = await engine.runTurn('k', '早上好');
      a.equal(result.text, '今天想去哪里玩?');
      a.equal(result.reason.kind, 'completed');
      a.equal(result.timedOut, false);
      const turns = fx.store.conversationTurns('k');
      a.equal(turns.length, 2, 'user + assistant 两轮');
      a.deepEqual(turns[1].meta.usage, USAGE, '真 usage 完整落库');
      const messages = llm.calls[0].messages;
      a.equal(messages[messages.length - 1].role, 'user', '最后一条 = 本轮 user');
      a.ok(messages[messages.length - 1].content.includes('早上好'), '用户这句在本轮');
      a.ok(!hasInjectMarks(messages[0].content), '稳定块不带注入标记(它不是注入,是前缀根)');
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:前缀逐字节稳定(engine 层)—— 第二轮的前缀 = 第一轮全部 + 她的回复', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: '第一答' }, { text: '第二答' }]);
    try {
      const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath });
      await engine.initialize();
      await engine.runTurn('k', '第一句');
      await engine.runTurn('k', '第二句');
      const first = llm.calls[0].messages;
      const second = llm.calls[1].messages;
      a.equal(second[0].content, first[0].content, 'system 稳定块两轮逐字一致');
      const expectedPrefix = [...first, { role: 'assistant', content: '第一答' }];
      a.deepEqual(second.slice(0, expectedPrefix.length), expectedPrefix, '旧前缀原样保留(append-only)');
      a.equal(second[second.length - 1].content, '第二句');
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:空响应 → [跳过](g8),assistant 轮不落', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: '   ' }]);
    try {
      const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath });
      await engine.initialize();
      const result = await engine.runTurn('k', '在吗');
      a.equal(result.text, SILENT_TOKEN, '空响应走 [跳过] 同一条路径');
      const turns = fx.store.conversationTurns('k');
      a.equal(turns.length, 1, '只落了 user 轮');
      a.equal(turns[0].role, 'user');
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:贡献者注入自报家门(不许裸注入)+ images 透传', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: '好哦' }]);
    try {
      const engine = createOwnEngine({
        llm, store: fx.store, personaPath: fx.personaPath,
        turnContributors: [{ kind: 'facts', render: () => '主人昨天钓到一条大鱼。' }],
      });
      await engine.initialize();
      await engine.runTurn('k', '记得昨天吗', 5000, ['data:image/png;base64,QUJD']);
      const last = llm.calls[0].messages.at(-1);
      a.ok(last.content.startsWith(injectOpen('facts')), '注入块在本轮最前且带标记');
      a.ok(last.content.includes('[[/bridge-inject]]'), '注入块闭合');
      a.ok(last.content.includes('记得昨天吗'), '用户这句保留在注入块之后');
      a.deepEqual(llm.calls[0].callOptions.images, ['data:image/png;base64,QUJD'], 'images 原样透传给 llm.chat');
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:人设 g7 热更语义 —— 换代才重读,平时进程内一份', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    try {
      const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath });
      await engine.initialize();
      await engine.runTurn('k', '1');
      fs.writeFileSync(fx.personaPath, '你是天童爱丽丝,机械少女。', 'utf8');
      await engine.runTurn('k', '2');
      a.ok(llm.calls[1].messages[0].content.includes('惠惠'), '不换代不重读(与 DSH 语义一致)');
      engine.resetConversation('k');
      await engine.runTurn('k', '3');
      a.ok(llm.calls[2].messages[0].content.includes('爱丽丝'), '换代重读人设(换卡不改代码)');
      a.ok(!llm.calls[2].messages[0].content.includes('惠惠'), '新人设顶掉旧的');
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:压缩触发 —— 摘要走同一 llm、摘要区自报家门、历史按保留段裁', async () => {
    const fx = tempFixture();
    // 小预算(测试覆盖用,数值与生产档无关):触发 300/保留 60/迟滞余量 60 → 重武装线 180
    const budget = { triggerTokens: 300, keepRecentTokens: 60, summaryCapTokens: 400, hysteresisMarginTokens: 60, coldGapMs: 3_600_000, coldKeepTokens: 60 };
    // 预置一大段历史(直接走表,append-only)
    for (let i = 1; i <= 20; i += 1) {
      fx.store.appendConversationTurn({ key: 'k', role: i % 2 ? 'user' : 'assistant', content: `历史第${i}轮`.padEnd(60, '.'), at: i });
    }
    const llm = fakeLlm([{ text: '这是压缩后的摘要。' }, { text: '新回复' }, { text: '再回复' }]);
    try {
      const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath, budget });
      await engine.initialize();
      await engine.runTurn('k', '新的一句');
      a.equal(llm.calls.length, 2, '第一轮 = 摘要调用 + 主调用');
      a.ok(llm.calls[0].messages[0].content.includes('压缩'), '摘要调用用 SUMMARY_PROMPT');
      const main = llm.calls[1].messages;
      const summaryMsg = main[1];
      a.equal(summaryMsg.role, 'system');
      a.ok(summaryMsg.content.startsWith(injectOpen('summary')), '摘要区在稳定块后、自报家门');
      a.ok(main.some((m) => m.content.includes('历史第20轮')), '保留段含最近的轮');
      a.ok(!main.some((m) => m.content.includes('历史第1轮')), '更旧的轮被裁出前缀(表里原文仍在)');
      a.equal(fx.store.conversationTurns('k').length, 22, '表里历史一行没少(20 预置 + 本轮 user/assistant)');
      // 第二轮:迟滞未落回重武装线前不再压 → 只有主调用,摘要区复用
      await engine.runTurn('k', '又一一句');
      a.equal(llm.calls.length, 3, '迟滞期内不再触发摘要');
      a.ok(llm.calls[2].messages[1].content.includes('压缩后的摘要'), '摘要区复用上一轮的');
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('engine:同会话串行 —— 排队等,不并发打模型', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: 'x' }, { text: 'y' }]);
    try {
      const engine = createOwnEngine({ llm, store: fx.store, personaPath: fx.personaPath });
      await engine.initialize();
      await Promise.all([engine.runTurn('k', '并发1'), engine.runTurn('k', '并发2')]);
      a.equal(llm.concurrency.max, 1, '同会话两轮串行(与 DshRunner 同语义)');
      a.equal(fx.store.conversationTurns('k').length, 4);
    } finally {
      fx.store.close?.();
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });


  test('engine:usage 记账与对账判据(刀四观察期仪器)', () => {
    // DSH 侧:认不出 usage 的记录不算,字段缺的按 0 不硬造
    const dsh = sumSessionUsage([
      { data: { usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 400, reasoningTokens: 100 } } },
      { data: {} },
      { data: { usage: { inputTokens: 500 } } },
    ]);
    a.equal(dsh.calls, 2, '只有两条带 usage');
    a.equal(dsh.totals.inputTokens, 1500);
    a.equal(dsh.totals.cacheReadTokens, 9000);
    a.equal(usageOfRecord({ data: { usage: {} } }), null, '字段全缺 = 认不出,返回 null');
    // 自有侧:暖/冷分组(判据②量的是暖轮那一组)
    const own = sumTurnUsage([
      { meta: { usage: { promptTokens: 1000, completionTokens: 100, cacheHitTokens: 900, cacheMissTokens: 100 } } },
      { meta: { usage: { promptTokens: 2000, completionTokens: 200, cacheHitTokens: 0, cacheMissTokens: 2000 } } },
      { meta: {} },
      { meta: { usage: { promptTokens: 500, completionTokens: 50, cacheHitTokens: 400 } } }, // 没有 cacheMiss → 按 prompt-hit 现算
    ]);
    a.equal(own.calls, 3, '没有 usage 的轮不算');
    a.equal(own.warmTurns, 2);
    a.equal(own.coldTurns, 1);
    a.equal(own.totals.cacheMissTokens, 100 + 2000 + 100, '缺 cacheMiss 的行按 prompt−hit 现算');
    a.equal(own.warm.cacheHit, 900 + 400, '暖轮分组只装暖轮');
    a.equal(own.cold.cacheMiss, 2000, '冷轮分组只装冷轮');
    // 钱:命中价是未命中的 1/50(官方现价);错峰 = 一半
    a.ok(estimateCost({ cacheHitTokens: 1_000_000 }) < estimateCost({ cacheMissTokens: 1_000_000 }) / 40, '命中远便宜');
    a.equal(
      Number(estimateCost({ cacheMissTokens: 1_000_000, prices: PRICES.offPeak }).toFixed(4)),
      Number((estimateCost({ cacheMissTokens: 1_000_000 }) / 2).toFixed(4)),
      '错峰 = 峰时一半',
    );
    a.equal(costPerCall(1, 0), null, '0 次调用不硬造 0(0 会被读成"便宜")');
    // 判据:数据不足不下结论
    a.equal(compareVerdict({ own, dsh: { calls: 0, totals: {} } }).verdict, 'insufficient');
    // 判据:暖轮省一半 → win;冷轮贵也不影响(加权看全局)
    const cheapWarm = { calls: 10, warmTurns: 10, coldTurns: 0, totals: { promptTokens: 300000, completionTokens: 2000, cacheHitTokens: 295000, cacheMissTokens: 5000 }, warm: { cacheMiss: 5000, cacheHit: 295000, output: 2000 }, cold: {} };
    const dshSide = { calls: 10, totals: { inputTokens: 63000, cacheReadTokens: 12000, outputTokens: 4000, reasoningTokens: 0 } };
    const win = compareVerdict({ own: cheapWarm, dsh: dshSide });
    a.equal(win.weightedOk, true);
    a.equal(win.warmOk, true);
    a.equal(win.verdict, 'win');
    // 反例:暖轮也贵 → not_yet(判据真的会红)
    const priceyWarm = { ...cheapWarm, warm: { cacheMiss: 200000, cacheHit: 0, output: 2000 }, totals: { promptTokens: 300000, completionTokens: 2000, cacheHitTokens: 0, cacheMissTokens: 300000 } };
    a.equal(compareVerdict({ own: priceyWarm, dsh: dshSide }).verdict, 'not_yet', '暖轮不省 → 不成立');
  });

  test('engine:开关与 key 回落(buildEngineConfig,刀三B)', () => {
    const names = ['QQBOT_ENGINE', 'QQBOT_OWN_INPUT_TOKEN_LIMIT', 'QQBOT_LLM_KEY', 'QQBOT_LLM_BASEURL', 'QQBOT_LLM_MODEL',
      'QQBOT_LLM_DREAM_KEY', 'QQBOT_LLM_DREAM_BASEURL', 'QQBOT_LLM_DREAM_MODEL',
      // 2026-10-15(F5):采样参数也进了 buildEngineConfig 的形状 —— 不一起清,这条会随环境漂。
      'QQBOT_LLM_REASONING_EFFORT', 'QQBOT_LLM_MAX_TOKENS',
      'QQBOT_LLM_DREAM_REASONING_EFFORT', 'QQBOT_LLM_DREAM_MAX_TOKENS',
      'QQBOT_DSH_REASONING_EFFORT', 'QQBOT_DSH_MAX_TOKENS'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    const restore = () => { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } };
    try {
      // 默认 own(2026-10-17 / D236):"空 = 用唯一那个引擎",不再默认成已退役的 dsh
      names.forEach((n) => delete process.env[n]);
      a.deepEqual(buildEngineConfig(), { mode: 'own', inputTokenLimit: null, requestOptions: {}, dshOnlyRequestOptions: [],
        llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' } });
      // 非法值大声失败
      process.env.QQBOT_ENGINE = 'yolo';
      a.throws(() => buildEngineConfig(), /只能是 dsh \/ own \/ shadow/);
      // 世界档 key 优先;没配回落梦境 key(分 key 那天配 QQBOT_LLM_KEY 即分)
      process.env.QQBOT_ENGINE = 'own';
      process.env.QQBOT_LLM_DREAM_KEY = 'dream-key';
      process.env.QQBOT_LLM_DREAM_MODEL = 'deepseek-flash';
      let cfg = buildEngineConfig();
      a.equal(cfg.mode, 'own');
      a.equal(cfg.llm.apiKey, 'dream-key', '回落梦境 key');
      a.equal(cfg.llm.model, 'deepseek-flash');
      process.env.QQBOT_LLM_KEY = 'world-key';
      process.env.QQBOT_LLM_MODEL = 'deepseek-chat';
      cfg = buildEngineConfig();
      a.equal(cfg.llm.apiKey, 'world-key', '世界档 key 优先于回落');
      a.equal(cfg.llm.model, 'deepseek-chat');
      process.env.QQBOT_ENGINE = 'SHADOW';
      a.equal(buildEngineConfig().mode, 'shadow', '大小写不敏感');
      // 2026-10-15(F5):采样参数走**真环境变量**这一遍(配置→引擎那半截在 selftest-own-request-options.js)。
      process.env.QQBOT_LLM_REASONING_EFFORT = 'high';
      process.env.QQBOT_LLM_MAX_TOKENS = '256000';
      const sampled = buildEngineConfig();
      a.deepEqual(sampled.requestOptions, { reasoningEffort: 'high', maxTokens: 256000 });
      a.deepEqual(sampled.dshOnlyRequestOptions, [], 'own/shadow 路自己配齐了就不该报"DSH 那两项没用"');
      delete process.env.QQBOT_LLM_REASONING_EFFORT; delete process.env.QQBOT_LLM_MAX_TOKENS;
      // DSH 专用项在直连路**不被继承**,但会被报出来(装配段据此 warn)。
      process.env.QQBOT_DSH_REASONING_EFFORT = 'high';
      const dshOnly = buildEngineConfig();
      a.deepEqual(dshOnly.requestOptions, {}, 'QQBOT_DSH_* 绝不被 own/shadow 偷偷继承');
      a.deepEqual(dshOnly.dshOnlyRequestOptions, ['QQBOT_DSH_REASONING_EFFORT'],
        '配了却不生效的项要报出名字(配置静默丢弃族)');
    } finally {
      restore();
    }
  });

  // ---- T1(2026-10-29):上下文生命周期(临时注入投影/无状态任务轮/epoch/旧摘要读闸) ----

  test('engine:历史投影剥离临时注入;用户原话逐字保留;档案行原样', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: '好笑' }, { text: '三点' }]);
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, log: {} });
    try {
      await engine.initialize();
      const key = 'qqbot-group-project';
      await engine.runTurn(key, `${wrapInject('recall', 'RECALL_T1_CANARY')}\n用户原话真身`, 5000);
      await engine.runTurn(key, '完全换个话题：现在几点了？', 5000);
      const requestText = JSON.stringify(llm.calls.at(-1).messages);
      a.ok(!requestText.includes('RECALL_T1_CANARY'), '临时注入不随历史重发');
      a.ok(requestText.includes('用户原话真身'), '用户原话逐字保留');
      a.ok(fx.store.conversationTurns(key)[0].content.includes('RECALL_T1_CANARY'),
        '档案行原样保留(投影只动模型输入,不动存储)');
    } finally { await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('engine:runIsolatedTurn无状态、不带历史、不写会话、入调用账本', async () => {
    const fx = tempFixture();
    const llm = fakeLlm([{ text: 'A摘要' }, { text: 'B摘要' }]);
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, log: {} });
    try {
      await engine.initialize();
      await engine.runIsolatedTurn('任务A：GROUP_A_T1材料', { key: 'qqbot-summary' });
      const second = await engine.runIsolatedTurn('任务B：B_T1材料', { key: 'qqbot-summary' });
      a.equal(second.text, 'B摘要');
      a.equal(llm.calls.length, 2);
      a.ok(!JSON.stringify(llm.calls.at(-1).messages).includes('GROUP_A_T1材料'),
        '后一请求不含前一任务材料(跨来源隔离)');
      a.equal(llm.calls.at(-1).messages.length, 1, '无状态:每次只有本轮一条');
      a.equal(fx.store.conversationTurns('qqbot-summary').length, 0, '不写会话历史');
      const calls = fx.store.ownLlmCalls().filter((c) => c.kind === 'summary');
      a.equal(calls.length, 2, '调用账本仍记(kind=summary,成本报表口径不变)');
    } finally { await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });

  test('engine:reset换代(epoch重复reset也+1);旧规则持久摘要读时停用且游标退回reset边界', async () => {
    const fx = tempFixture();
    // 直造一份"旧规则"持久状态:有摘要、无 summaryPolicyV 字段(升级前写出的形状)。
    fx.store.setMeta('own-engine:v1:stale-key', JSON.stringify({ version: 1,
      imageHistoryVersion: 1, summary: '旧摘要T1', coveredId: 5, resetId: 0,
      lastAt: null, armed: true, compactionCalls: [], compactFailAt: null }));
    const llm = fakeLlm([{ text: '新话' }]);
    const engine = createOwnEngine({ store: fx.store, personaPath: fx.personaPath, llm, log: {} });
    try {
      await engine.initialize();
      a.equal(engine.epochFor('qqbot-group-e1'), 0);
      engine.resetConversation('qqbot-group-e1');
      const first = engine.epochFor('qqbot-group-e1');
      engine.resetConversation('qqbot-group-e1');
      a.equal(engine.epochFor('qqbot-group-e1'), first + 1, '重复reset也必须换代');
      await engine.runTurn('stale-key', '来了', 5000);
      const requestText = JSON.stringify(llm.calls.at(-1).messages);
      a.ok(!requestText.includes('旧摘要T1'), '旧规则摘要不入口(读时版本闸)');
      a.ok(requestText.includes('来了'), '本轮正常');
      const saved = JSON.parse(fx.store.getMeta('own-engine:v1:stale-key'));
      a.equal(saved.summary, '', '旧摘要从活状态停用');
      a.equal(saved.coveredId, 0, '游标退回reset边界(0),原档轮次可被干净投影重建');
      a.equal(saved.summaryPolicyV, 2, '升级只做一次,落盘');
    } finally { await engine.stop(); fx.store.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });
}
