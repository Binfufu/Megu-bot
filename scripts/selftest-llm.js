/**
 * **刀一 `src\llm.js` 的判据**(2026-10-13,`docs\21` §三)。
 *
 * 全部走**注入的假 fetch** —— 不碰网,判的是行为不是运气:
 * 成功带 usage、坏 key 不重试、429/5xx 退避重试、超时归网络类、
 * 并发上限真的排队、tools 门透传但不造机器。
 */
import * as assert from 'node:assert/strict';
import http from 'node:http';
import { listenLoopback } from './test-local-port.mjs';
import {
  classifyLlmError,
  createLlmClient,
  createLlmQueue,
  createReasoningTagFilter,
  extractLlmChoice,
  extractResponsesChoice,
  isResponsesApi,
  normalizeLlmUsage,
  normalizeResponsesUsage,
  stripReasoningTags,
  LLM_MAX_CONCURRENT,
} from '../src/llm.js';

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };
const BASE = { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'deepseek-chat', log: SILENT };

/** 造一个"第 n 次返回什么"的假 fetch。 */
function fetchScript(script) {
  let call = 0;
  const seen = [];
  const impl = async (_url, init) => {
    call += 1;
    seen.push({ url: _url, body: JSON.parse(init.body), headers: init.headers });
    const step = script[Math.min(call - 1, script.length - 1)];
    if (step.throw) throw step.throw;
    if (step.abort) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: !step.status || (step.status >= 200 && step.status < 300),
      status: step.status || 200,
      text: async () => step.text || '',
      json: async () => step.json,
    };
  };
  return { impl, seen, count: () => call };
}

const OK_JSON = {
  model: 'deepseek-chat',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '你好呀' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 4 },
};

export function registerLlmTests({ test, assert: rawAssert }) {
  test('llm:真实HTTP取消关闭上游请求且不重试', async () => {
    let received;
    let disconnected;
    const requestReady = new Promise(resolve => { received = resolve; });
    const connectionClosed = new Promise(resolve => { disconnected = resolve; });
    let count = 0;
    const server = http.createServer((req, res) => {
      count++; req.resume(); received(); res.on('close', disconnected);
    });
    await listenLoopback(server);
    try {
      const controller = new AbortController();
      const client = createLlmClient({ ...BASE, baseUrl: 'http://127.0.0.1:' + server.address().port,
        retryDelayMs: 1 });
      const call = client.chat([{ role: 'user', content: 'HTTP取消对照' }], { signal: controller.signal });
      await requestReady;
      controller.abort(new Error('HTTP caller cancelled'));
      await assert.rejects(call, /HTTP caller cancelled/);
      const guard = setTimeout(() => disconnected('timeout'), 2000);
      try { assert.notEqual(await connectionClosed, 'timeout', '上游响应连接实际关闭'); }
      finally { clearTimeout(guard); }
      assert.equal(count, 1);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('llm:真实HTTP200响应体挂起，取消关闭连接且尝试usage未知不重试', async () => {
    let headersRead, disconnected;
    const ready = new Promise(resolve => { headersRead = resolve; });
    const closed = new Promise(resolve => { disconnected = resolve; });
    let count = 0;
    const events = [];
    const server = http.createServer((req, res) => {
      count++; req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":['); // Headers and partial JSON arrive; response never completes.
      res.on('close', disconnected);
    });
    await listenLoopback(server);
    const controller = new AbortController();
    try {
      const client = createLlmClient({ ...BASE, baseUrl: 'http://127.0.0.1:' + server.address().port,
        retryDelayMs: 1, fetchImpl: async (...args) => {
          const response = await fetch(...args);
          assert.equal(response.status, 200); headersRead(); return response;
        } });
      const call = client.chat([{ role: 'user', content: 'body stall control' }], {
        signal: controller.signal,
        onAttemptStart: () => { events.push('start'); return 7; },
        onAttemptEnd: (id, result) => events.push({ id, ...result }),
      });
      const rejected = assert.rejects(call, /body caller cancelled/);
      await ready;
      controller.abort(new Error('body caller cancelled'));
      await rejected;
      const guard = setTimeout(() => disconnected('timeout'), 2000);
      try { assert.notEqual(await closed, 'timeout', 'body stream connection actually closed'); }
      finally { clearTimeout(guard); }
      assert.equal(count, 1, 'no retry after caller cancellation');
      assert.deepEqual(events, ['start', { id: 7, status: 'cancelled', usage: null, httpStatus: 200 }]);
    } finally {
      controller.abort(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('llm:取消排队/退避/在途不重试，每次调用timeout覆盖生效', async () => {
    const queue = createLlmQueue({ max: 1 });
    let release;
    const first = queue.run(() => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const waiting = new AbortController();
    let ran = false;
    const second = queue.run(() => { ran = true; }, { signal: waiting.signal });
    waiting.abort(new Error('queued cancel'));
    await assert.rejects(second, /queued cancel/);
    assert.equal(queue.pending(), 0);
    release(); await first; assert.equal(ran, false);
    let attempts = 0;
    let enteredBackoff;
    const backoffReady = new Promise(resolve => { enteredBackoff = resolve; });
    const controller = new AbortController();
    const client = createLlmClient({ ...BASE,
      fetchImpl: async () => { attempts++; return { ok: false, status: 503, text: async () => '' }; },
      sleep: () => { enteredBackoff(); return new Promise(() => {}); } });
    const call = client.chat([{ role: 'user', content: 'cancel' }], { signal: controller.signal });
    await backoffReady; controller.abort(new Error('backoff cancel'));
    await assert.rejects(call, /backoff cancel/);
    assert.equal(attempts, 1);
    let observed;
    const timed = createLlmClient({ ...BASE, timeoutMs: 60000, attempts: 1,
      fetchImpl: async (_, opts) => new Promise((_, reject) => {
        observed = opts.signal;
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      }) });
    await assert.rejects(timed.chat([{ role: 'user', content: 'short' }], { timeoutMs: 10 }), /超时/);
    assert.equal(observed.aborted, true);
    const outer = new AbortController();
    let networkCalls = 0;
    const abortable = createLlmClient({ ...BASE, fetchImpl: async (_, opts) => {
      networkCalls++;
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    } });
    const active = abortable.chat([{ role: 'user', content: 'active' }], { signal: outer.signal });
    await new Promise(resolve => setImmediate(resolve)); outer.abort(new Error('active cancel'));
    await assert.rejects(active, /active cancel/);
    assert.equal(networkCalls, 1);
  });
  const a = rawAssert || assert;

  test('llm:错误分类 —— 401/403 与 4xx 不重试,429/5xx/网络重试', () => {
    assert.equal(classifyLlmError({ status: 401 }).retryable, false, '坏 key 不重试');
    assert.equal(classifyLlmError({ status: 403 }).retryable, false);
    assert.equal(classifyLlmError({ status: 400 }).retryable, false, '请求坏,重试也不会好');
    assert.equal(classifyLlmError({ status: 404 }).retryable, false);
    assert.equal(classifyLlmError({ status: 429 }).retryable, true);
    assert.equal(classifyLlmError({ status: 503 }).retryable, true);
    assert.equal(classifyLlmError({}).kind, 'network', '没有 status = 网络层');
    assert.equal(classifyLlmError({ name: 'FetchError' }).retryable, true);
  });

  test('llm:成功一轮 —— 正文/usage/缓存命中原样带出,端点与鉴权头正确', async () => {
    const fake = fetchScript([{ json: OK_JSON }]);
    const client = createLlmClient({ ...BASE, fetchImpl: fake.impl, sleep: async () => {} });
    const result = await client.chat([{ role: 'user', content: '嗨' }]);
    a.equal(result.text, '你好呀');
    a.equal(result.usage.promptTokens, 10);
    a.equal(result.usage.completionTokens, 5);
    a.equal(result.usage.cacheHitTokens, 4, 'DeepSeek 的缓存命名字段要归一出来');
    a.equal(fake.count(), 1, '成功不重试');
    a.ok(fake.seen[0].url.endsWith('/chat/completions'), 'OpenAI 兼容端点');
    a.equal(fake.seen[0].headers.authorization, 'Bearer sk-test');
    a.equal(fake.seen[0].body.model, 'deepseek-chat');
    a.equal(fake.seen[0].body.stream, false);
  });

  test('llm:每发耗时留痕(D240)—— ttft/total/chars 进日志,失败的一发也记', async () => {
    // 起因:备忘里"TTFT 300~800ms"从未被我们自己验证过 —— 没有留痕就没有数可对。
    // `stream:false` 下 ttft≈total(服务器生成完才回头),这正是"憋成一坨"的直接证据;
    // ③的流式上线后两数才会拉开。
    const lines = [];
    const capture = { warn: () => {}, error: () => {}, info: (line) => lines.push(String(line)) };
    const ok = fetchScript([{ json: OK_JSON }]);
    const okClient = createLlmClient({ ...BASE, log: capture, fetchImpl: ok.impl, sleep: async () => {} });
    await okClient.chat([{ role: 'user', content: '嗨' }]);
    a.equal(lines.length, 1, `成功一发正好一行耗时账(实际 ${lines.length})`);
    a.ok(/\bttft=\d+ms\b/.test(lines[0]), `要带 ttft:${lines[0]}`);
    a.ok(/\btotal=\d+ms\b/.test(lines[0]), `要带 total:${lines[0]}`);
    a.ok(/chars=3\b/.test(lines[0]), `要带正文字数:${lines[0]}`);
    a.ok(/completion=5tok/.test(lines[0]), `要带 completion tokens:${lines[0]}`);
    const bad = fetchScript([{ status: 500, json: {} }]);
    const before = lines.length;
    const badClient = createLlmClient({ ...BASE, log: capture, fetchImpl: bad.impl, attempts: 1, sleep: async () => {} });
    await a.rejects(() => badClient.chat([{ role: 'user', content: '嗨' }]));
    a.equal(lines.length, before + 1, '失败的一发也要记账');
    a.ok(/FAILED/.test(lines[lines.length - 1]), `失败行要标 FAILED:${lines[lines.length - 1]}`);
  });

  test('llm:chatStream(D241)—— SSE 增量回调、stream+include_usage 上网、401 不重试、**出过字不许再重试**', async () => {
    // ① 正常流:三个增量回调(full 递增)、请求体带 stream:true、usage 从尾 chunk 归一
    const sseBody = [
      'data: ' + JSON.stringify({ model: 'deepseek-chat', choices: [{ delta: { content: '你' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '呀' }, finish_reason: 'stop' }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) + '\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const seen = [];
    let served = false;
    const client = createLlmClient({
      ...BASE, log: SILENT, sleep: async () => {},
      fetchImpl: async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, body: { getReader: () => ({
          read: async () => {
            if (!served) { served = true; return { done: false, value: Buffer.from(sseBody) }; }
            return { done: true, value: undefined };
          },
        }) } };
      },
    });
    const pieces = [];
    const result = await client.chatStream([{ role: 'user', content: '嗨' }], {}, (delta, full) => pieces.push([delta, full]));
    a.deepEqual(pieces, [['你', '你'], ['好', '你好'], ['呀', '你好呀']], '增量与"至今全文"都要回调');
    a.equal(result.text, '你好呀');
    a.equal(result.usage.completionTokens, 3, '尾 chunk 的 usage 要归一出来');
    a.equal(result.model, 'deepseek-chat');
    a.equal(seen[0].body.stream, true, '请求体要 stream:true');
    a.deepEqual(seen[0].body.stream_options, { include_usage: true }, '要带 include_usage(流式也要记账)');
    a.ok(seen[0].url.endsWith('/chat/completions'), '同一端点');
    // ② 401:不重试,一次就停(与 chat 同一条护栏)
    let badCalls = 0;
    const bad = createLlmClient({
      ...BASE, log: SILENT, sleep: async () => {},
      fetchImpl: async () => {
        badCalls += 1;
        return { ok: false, status: 401, text: async () => 'bad key' };
      },
    });
    await a.rejects(() => bad.chatStream([{ role: 'user', content: '嗨' }], {}, () => {}));
    a.equal(badCalls, 1, '401 一次就停');
    // ③ 流到一半断:虽然属于网络类,**不许重试**(客户端已经看到半截话,重试 = 半截接半截)
    let midCalls = 0;
    let threw = false;
    const mid = createLlmClient({
      ...BASE, log: SILENT, sleep: async () => {}, attempts: 3,
      fetchImpl: async () => {
        midCalls += 1;
        return { ok: true, status: 200, body: { getReader: () => ({
          read: async () => {
            if (!threw) {
              threw = true;
              return { done: false, value: Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '半' } }] }) + '\n\n') };
            }
            const boom = new Error('terminated');
            throw boom;   // 网络层在字吐到一半时断掉
          },
        }) } };
      },
    });
    const got = [];
    await a.rejects(() => mid.chatStream([{ role: 'user', content: '嗨' }], {}, (delta) => got.push(delta)));
    a.deepEqual(got, ['半'], '断流前那个字回调过');
    a.equal(midCalls, 1, `出过字就一条命,不许拿重试糊弄(实际 ${midCalls} 发)`);
  });

  test('llm:401 一次就停 —— 绝不拿坏 key 打第二发(护栏①)', async () => {
    const fake = fetchScript([{ status: 401, text: '{"error":"bad key"}', json: {} }]);
    const client = createLlmClient({ ...BASE, fetchImpl: fake.impl, sleep: async () => {} });
    await a.rejects(() => client.chat([{ role: 'user', content: '嗨' }]), /401/);
    a.equal(fake.count(), 1, '401 一次就停');
    a.equal(fake.seen.length, 1);
  });

  test('llm:per-call maxAttempts只缩小配置预算，chat/stream同门且非法值发请求前拒绝', async () => {
    for (const method of ['chat', 'chatStream']) {
      for (const [configured, cap, expected] of [[3, 1, 1], [2, 99, 2], [3, 2, 2]]) {
        const fake = fetchScript([{ status: 503 }]);
        const sleeps = [];
        const events = [];
        const client = createLlmClient({ ...BASE, attempts: configured, fetchImpl: fake.impl,
          sleep: async ms => sleeps.push(ms) });
        await a.rejects(() => client[method]([{ role: 'user', content: 'cap' }], {
          maxAttempts: cap, onAttemptStart: () => { events.push('start'); return 17; },
          onAttemptEnd: (id, result) => events.push({ id, ...result }),
        }), /503/);
        a.equal(fake.count(), expected, `${method}: configured=${configured} cap=${cap}`);
        a.equal(sleeps.length, expected - 1);
        if (method === 'chat') {
          a.equal(events.length, expected * 2, 'one start/end pair per real fetch');
          a.deepEqual(events[1], { id: 17, status: 'failed', usage: null, httpStatus: 503 });
        }
        a.equal('maxAttempts' in fake.seen[0].body, false, 'local retry cap must not leak into provider body');
      }
    }
    for (const invalid of [0, -1, 1.5, '1', NaN, Infinity, null]) {
      const fake = fetchScript([{ json: OK_JSON }]);
      const client = createLlmClient({ ...BASE, fetchImpl: fake.impl });
      await a.rejects(() => client.chat([{ role: 'user', content: 'invalid cap' }], { maxAttempts: invalid }), /maxAttempts/);
      a.equal(fake.count(), 0);
    }
  });

  test('llm:429 退避重试后成功;间隔按次数递增', async () => {
    const fake = fetchScript([{ status: 429, json: {} }, { status: 429, json: {} }, { json: OK_JSON }]);
    const sleeps = [];
    const client = createLlmClient({
      ...BASE, fetchImpl: fake.impl, attempts: 3, retryDelayMs: 100,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const result = await client.chat([{ role: 'user', content: '嗨' }]);
    a.equal(result.text, '你好呀');
    a.equal(fake.count(), 3);
    a.deepEqual(sleeps, [100, 200], '退避递增');
  });

  test('llm:5xx 重试到头仍失败 —— 抛最后一次,带分类', async () => {
    const fake = fetchScript([{ status: 503, json: {} }]);
    const client = createLlmClient({ ...BASE, fetchImpl: fake.impl, attempts: 2, sleep: async () => {} });
    await a.rejects(
      () => client.chat([{ role: 'user', content: '嗨' }]).then((r) => { a.fail('不该成功'); return r; }),
      (err) => err.llmClass === 'server',
    );
    a.equal(fake.count(), 2);
  });

  test('llm:超时(AbortError)归网络类、可重试', async () => {
    const fake = fetchScript([{ abort: true }, { json: OK_JSON }]);
    const client = createLlmClient({ ...BASE, fetchImpl: fake.impl, attempts: 2, sleep: async () => {} });
    const result = await client.chat([{ role: 'user', content: '嗨' }]);
    a.equal(result.text, '你好呀', '第一次超时,第二次成');
    a.equal(fake.count(), 2);
  });

  test('llm:并发上限 —— 最多 max 个在飞,其余排队', async () => {
    let inFlight = 0;
    let peak = 0;
    const fake = async (_url, _init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => { setTimeout(r, 10); });
      inFlight -= 1;
      return { ok: true, status: 200, text: async () => '', json: async () => OK_JSON };
    };
    const client = createLlmClient({ ...BASE, fetchImpl: fake, maxConcurrent: 2, sleep: async () => {} });
    await Promise.all(Array.from({ length: 6 }, () => client.chat([{ role: 'user', content: 'x' }])));
    a.equal(peak, 2, `在飞峰值 = 上限(实际 ${peak})`);
    a.equal(LLM_MAX_CONCURRENT >= 1, true);
  });

  test('llm:tools 门 —— 透传 tools、原样带回 tool_calls,不发空字段', async () => {
    const toolJson = {
      model: 'm',
      choices: [{
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'roll', arguments: '{"n":6}' } }] },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const fake = fetchScript([{ json: toolJson }]);
    const client = createLlmClient({ ...BASE, fetchImpl: fake.impl, sleep: async () => {} });
    const withTools = await client.chat(
      [{ role: 'user', content: '掷个骰子' }],
      { tools: [{ type: 'function', function: { name: 'roll', parameters: {} } }] },
    );
    a.deepEqual(fake.seen[0].body.tools, [{ type: 'function', function: { name: 'roll', parameters: {} } }], 'tools 透传');
    a.equal(withTools.toolCalls.length, 1, 'tool_calls 原样带回');
    a.equal(withTools.toolCalls[0].function.name, 'roll');
    // 不带 tools 的调用不发 tools 字段。
    await client.chat([{ role: 'user', content: '嗨' }]);
    a.equal('tools' in fake.seen[1].body, false, '空 tools 不发');
  });

  test('llm:队列独立计数 —— pending/active 可观测;缺 baseUrl/key 当场炸', async () => {
    const queue = createLlmQueue({ max: 1 });
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = queue.run(() => gate);
    const second = queue.run(async () => 'b');
    await new Promise((r) => { setTimeout(r, 5); });
    a.equal(queue.active(), 1);
    a.equal(queue.pending(), 1, '第二个在排队');
    release();
    a.equal(await second, 'b');
    a.throws(() => createLlmClient({ baseUrl: '', apiKey: 'k' }), /baseUrl 与 apiKey 必填/);
    a.throws(() => createLlmClient({ baseUrl: 'https://x', apiKey: '' }), /必填/);
  });

  test('llm:助手函数 —— extractLlmChoice / normalizeLlmUsage 对畸形响应不炸', () => {
    a.deepEqual(extractLlmChoice(null), { text: '', toolCalls: null, finishReason: null });
    a.deepEqual(extractLlmChoice({ choices: [] }).text, '');
    a.equal(normalizeLlmUsage(null), null);
    const u = normalizeLlmUsage({ prompt_tokens: 1, completion_tokens: 2 });
    a.equal(u.promptTokens, 1);
    a.equal(u.cacheHitTokens, null, '没有缓存字段就是 null,不硬造 0');
    a.equal(u.cacheMissTokens, null);
    const split = normalizeLlmUsage({ prompt_tokens: 10, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 7 }, prompt_cache_miss_tokens: 3 });
    a.equal(split.cacheHitTokens, 7); a.equal(split.cacheMissTokens, 3);
  });

  test('llm:images 门(刀三A)—— 挂到最后一条 user 消息,多模态形状;没 images 不动 body', async () => {
    const fake = fetchScript([{ json: OK_JSON }]);
    const client = createLlmClient({ ...BASE, fetchImpl: fake.impl });
    const messages = [
      { role: 'system', content: 's' },
      { role: 'user', content: '看图' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '这张' },
    ];
    await client.chat(messages, { images: ['data:image/png;base64,QUJD', { url: 'https://x/y.png' }] });
    const sent = fake.seen[0].body.messages;
    a.equal(sent[1].content, '看图', '早的 user 消息不动');
    a.ok(Array.isArray(sent[3].content), '最后一条 user 变多模态数组');
    a.equal(sent[3].content[0].type, 'text');
    a.equal(sent[3].content[0].text, '这张');
    a.deepEqual(sent[3].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    a.deepEqual(sent[3].content[2], { type: 'image_url', image_url: { url: 'https://x/y.png' } });
    // ⚠️ 1.150.81:图后必须跟**接地指令**——"追问颜色答白"的现场,图附了也被记忆旧图带偏;
    //    这块是请求装配层的工程话术,把"以图为准"钉在图旁边(不进角色措辞、不进记忆)。
    a.equal(sent[3].content[3].type, 'text');
    a.match(sent[3].content[3].text, /以这些图片为准/, '图后要有接地指令(防记忆旧图带偏)');
    // 不带 images:body 原样
    const fake2 = fetchScript([{ json: OK_JSON }]);
    const client2 = createLlmClient({ ...BASE, fetchImpl: fake2.impl });
    await client2.chat([{ role: 'user', content: '纯文本' }]);
    a.equal(fake2.seen[0].body.messages[0].content, '纯文本');
    // 形状坏当场炸(不静默丢图)
    const fake3 = fetchScript([{ json: OK_JSON }]);
    const client3 = createLlmClient({ ...BASE, fetchImpl: fake3.impl });
    await assert.rejects(() => client3.chat([{ role: 'user', content: 'x' }], { images: [{}] }), /images 需是/);
    await assert.rejects(() => client3.chat([{ role: 'system', content: 'x' }], { images: ['u'] }), /没有 user 消息可挂/);
  });

  test('llm:responses(Agent Plan / D257)—— /responses 端点、input 形状、output_text 解析、SSE 增量', async () => {
    a.equal(isResponsesApi('https://ark.cn-beijing.volces.com/api/plan/v3'), true, 'Agent Plan 的 baseUrl 自动认 responses');
    a.equal(isResponsesApi('https://ark.cn-beijing.volces.com/api/v3'), false, '标准 Ark 仍是 chat');
    a.equal(extractResponsesChoice({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }, { type: 'output_text', text: '呀' }] }],
    }).text, '你好呀');
    const usage = normalizeResponsesUsage({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
    a.equal(usage.promptTokens, 10); a.equal(usage.completionTokens, 4); a.equal(usage.totalTokens, 14);

    // ① 非流式:URL / body 必须是 Responses 形状,不是 chat messages
    const seen = [];
    const fake = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true, status: 200,
        json: async () => ({
          model: 'doubao-seed-2.1-turbo',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '你好呀' }] }],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }),
      };
    };
    const client = createLlmClient({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', apiKey: 'ark-test',
      model: 'doubao-seed-2.1-turbo', fetchImpl: fake, sleep: async () => {}, log: SILENT,
    });
    const result = await client.chat(
      [{ role: 'system', content: 's' }, { role: 'user', content: '嗨' }],
      { maxTokens: 16, reasoningEffort: 'off' },
    );
    a.ok(seen[0].url.endsWith('/responses'), 'Agent Plan 打 /responses');
    a.deepEqual(seen[0].body.input, [
      { role: 'developer', content: 's' },
      { role: 'user', content: '嗨' },
    ], 'input 保留角色与纯文本;system → developer');
    a.equal(seen[0].body.max_output_tokens, 16, 'maxTokens 要映射成 max_output_tokens');
    a.deepEqual(seen[0].body.thinking, { type: 'disabled' }, 'Seed 2.1 Turbo 显式关思考');
    a.equal('messages' in seen[0].body, false, '不许混发 chat messages');
    a.equal(result.text, '你好呀');
    a.equal(result.usage.completionTokens, 4, 'usage 归一');
    // Seed 2.1 Turbo 不传 reasoningEffort 时默认关思考(否则一句 100 字能烧 2k+ reasoning token)
    await client.chat([{ role: 'user', content: '嗨' }], { maxTokens: 16 });
    a.deepEqual(seen[1].body.thinking, { type: 'disabled' }, 'Seed 2.1 Turbo 默认关思考');

    // ② 流式:认 response.output_text.delta + response.completed
    const sse = [
      'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '你' }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '好' }) + '\n\n',
      'data: ' + JSON.stringify({
        type: 'response.completed',
        response: { model: 'doubao-seed-2.1-turbo', status: 'completed',
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } },
      }) + '\n\n',
    ].join('');
    const streamSeen = [];
    const streamClient = createLlmClient({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', apiKey: 'ark-test',
      model: 'doubao-seed-2.1-turbo', fetchImpl: async (url, init) => {
        streamSeen.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, body: new Response(sse).body };
      }, sleep: async () => {}, log: SILENT,
    });
    const pieces = [];
    const streamed = await streamClient.chatStream(
      [{ role: 'user', content: '嗨' }], { maxTokens: 16 },
      (delta, full) => pieces.push([delta, full]),
    );
    a.deepEqual(pieces, [['你', '你'], ['好', '你好']], '增量与至今全文');
    a.equal(streamed.text, '你好');
    a.ok(streamSeen[0].url.endsWith('/responses'));
    a.equal(streamSeen[0].body.stream, true);
    a.equal('stream_options' in streamSeen[0].body, false, 'Responses 没有 chat 的 stream_options');
  });

  test('llm:Grok 4.7 推理 —— 默认 effort(中转 off/官方 low)、<think> 不显示、流式跨 chunk 也剥干净', async () => {
    a.equal(stripReasoningTags('<think>想</think>你好'), '你好');
    a.equal(stripReasoningTags('前<thinking>想</thinking>后'), '前后');
    a.equal(stripReasoningTags('正常 <文字> 不动'), '正常 <文字> 不动');
    const filter = createReasoningTagFilter();
    a.equal(filter.push('<thi'), '');
    a.equal(filter.push('nk>思考'), '');
    a.equal(filter.push('</think>'), '');
    a.equal(filter.push('你好'), '你好');

    // 中转:默认 reasoning_effort=off;非流式正文里的 <think> 也要剥
    const relayJson = {
      model: 'grok-4.7',
      choices: [{ message: { role: 'assistant', content: '<think>想</think>你好' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const relaySeen = [];
    const relay = createLlmClient({
      ...BASE, baseUrl: 'https://newapi.example/v1', model: 'grok-4.7',
      fetchImpl: async (url, init) => {
        relaySeen.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => relayJson };
      },
      sleep: async () => {}, log: SILENT,
    });
    const relayResult = await relay.chat([{ role: 'user', content: '嗨' }]);
    a.equal(relaySeen[0].body.reasoning_effort, 'off', '中转 Grok 4.7 默认 off(非标准但实测最快)');
    a.equal(relayResult.text, '你好', '非流式 <think> 不显示');

    // 官方 xAI:只能用 low(off 官方不支持)
    const officialSeen = [];
    const official = createLlmClient({
      ...BASE, baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7',
      fetchImpl: async (url, init) => {
        officialSeen.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => relayJson };
      },
      sleep: async () => {}, log: SILENT,
    });
    await official.chat([{ role: 'user', content: '嗨' }]);
    a.equal(officialSeen[0].body.reasoning_effort, 'low', '官方 xAI 用 low');

    // 流式:<think> 分片、正文分片;onDelta 只收到正文
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '<thi' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'nk>想' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '</think>你' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }) + '\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const streamClient = createLlmClient({
      ...BASE, baseUrl: 'https://newapi.example/v1', model: 'grok-4.7',
      fetchImpl: async () => ({ ok: true, status: 200, body: new Response(sse).body }),
      sleep: async () => {}, log: SILENT,
    });
    const pieces = [];
    const streamed = await streamClient.chatStream([{ role: 'user', content: '嗨' }], {}, (delta) => pieces.push(delta));
    a.deepEqual(pieces, ['你', '好'], '思考块一个字节都不给客户端');
    a.equal(streamed.text, '你好');
  });

  test('llm:思考档位适配 —— Grok/GLM-5.3/GLM-5.2/Seed 各按自己的合法字段降级', async () => {
    const one = { model: 'x', choices: [{ message: { role: 'assistant', content: '好' } }], usage: {} };
    async function bodyFor(options) {
      let body = null;
      const client = createLlmClient({
        ...BASE, ...options, fetchImpl: async (_url, init) => {
          body = JSON.parse(init.body);
          return { ok: true, status: 200, json: async () => one };
        }, sleep: async () => {}, log: SILENT,
      });
      await client.chat([{ role: 'user', content: '嗨' }], { maxTokens: 16 });
      return body;
    }
    const grokLow = await bodyFor({ baseUrl: 'https://newapi.example/v1', model: 'grok-4.7', reasoning: 'low' });
    a.equal(grokLow.reasoning_effort, 'low', 'Grok 中转支持 low');
    const glm53Off = await bodyFor({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', reasoning: 'off' });
    a.equal(glm53Off.reasoning_effort, 'low', 'GLM-5.3 不能 off,降到 low 而不是发非法值');
    const glm52Off = await bodyFor({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', reasoning: 'off' });
    a.deepEqual(glm52Off.thinking, { type: 'disabled' }, 'GLM-5.2 可以 thinking.disabled');
    const seedLow = await bodyFor({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', api: 'responses',
      model: 'doubao-seed-2.1-turbo', reasoning: 'low',
    });
    a.deepEqual(seedLow.thinking, { type: 'enabled' }, 'Seed 显式 low = 开思考');
    a.equal('reasoning' in seedLow, false, 'Seed 只有 thinking 开关,不发 effort');
    const seedOff = await bodyFor({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', api: 'responses',
      model: 'doubao-seed-2.1-turbo', reasoning: 'off',
    });
    a.deepEqual(seedOff.thinking, { type: 'disabled' }, 'Seed 显式 off');
  });
}
