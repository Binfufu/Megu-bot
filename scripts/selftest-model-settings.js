/**
 * **模型配置命令行判据**(桌面控制台要调用的 `scripts\model-settings.js`)。
 *
 * 为什么钉得这么死:那个 CLI 是 GUI 与配置服务之间**唯一的进程边界** ——
 * GUI 只认 `stdout` 的 JSON 和退出码,不会读源码。所以这里**真的 spawn node 子进程**,
 * 一条命令一条命令地钉:
 *
 *  · 用法错误一律退出码 2(未知命令 / 缺 --bot / 非法 slot / 非法 bot / 未知参数);
 *  · `info --json` 在空临时根上可 `JSON.parse`,只出 mask、绝不带 key 明文;
 *  · `test` 未配置 → 4;`save` 无 key 且无已保存 key → 4;
 *  · 用 `node:http` 起一个本机 OpenAI 兼容 mock(127.0.0.1 随机端口)真跑主链路:
 *    save --key-stdin → 0;盘上是 `apiKeyEnc`(DPAPI 密文)且不含明文 key;
 *    `info --json` 的 keyMasked 只露尾号;`reset` 回 env/未配置;
 *  · save 默认先测:mock 回 500 时退出 3,且**旧配置文件逐字节不变**;
 *    `--force` 跳过测试时成功(哪怕上游是坏的);
 *  · 不带 `--key-stdin` 时沿用已保存的 key(再触发一次 ping,鉴权头还是旧 key);
 *  · 损坏的 `apiKeyEnc`(换机器/换 Windows 用户的现场)→ test 退出 5,info 仍 0 并带出问题;
 *  · 坏 Base URL(http 非回环 / 带 query)→ 2(参数错,在 save 这条路上)。
 *
 * ⚠️ 全部在 `fs.mkdtempSync` 的临时根里跑(`--root`),**不碰真实 data/ 与真实配置**;
 *    子进程的 env 里剔掉了所有 `QQBOT_LLM_*`,免得跑测试的那台 shell 把值漏进来。
 *
 * 独立运行:`node scripts\selftest-model-settings.js`(在 selftest 里由
 * `scripts\selftest.js` 的 `registerModelSettingsTests({ test, assert })` 注册)。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./model-settings.js', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(CLI), '..');

// ---------------------------------------------------------------------------
// 小工具:临时根 / 子进程 / mock 服务
// ---------------------------------------------------------------------------

function tempRoot() {
  return fs.mkdtempSync(path.join(path.resolve(REPO_ROOT, '..'), 'model-settings-cli-'));
}

function slotFile(root, bot) {
  return path.join(root, 'data', bot, 'model-slots.json');
}

function envFile(root, bot) {
  return path.join(root, 'bots', bot, '.env');
}

/** 子进程 env:剔掉父进程的 QQBOT_LLM_*(CLI 只该看 bots\<bot>\.env)。 */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('QQBOT_LLM_')) delete env[name];
  }
  return env;
}

/**
 * 异步 spawn(⚠️ 不能用 spawnSync:mock 服务就跑在本进程里,spawnSync 会把事件循环锁死,
 * 子进程的请求永远等不到响应)。
 */
function runCli(args, { input = '', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...cleanEnv(), TEMP: args[args.indexOf('--root') + 1], TMP: args[args.indexOf('--root') + 1] },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // 子进程可能没读 stdin 就退了(用法错误),那时写完会 EPIPE —— 这不算错。
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.on('close', (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      /* stdin 已关:忽略 */
    }
  });
}

/** `--json` 的 stdout 必须**整段**就是一个 JSON 对象(多一行 `[llm] …` 日志都算违约)。 */
function parseJsonResult(result, label) {
  const text = String(result.stdout ?? '').trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label}:--json 的 stdout 必须只有一个 JSON 对象,实际内容:\n${text}\n--- stderr ---\n${result.stderr}`,
    );
  }
}

/**
 * 本机 OpenAI 兼容 mock:`POST /v1/chat/completions` 回 `{choices:[…'pong'],usage,model}`。
 * `state.status` 可在用例中间改(200 ↔ 500),用来造"保存前测试失败"的现场。
 */
async function startMock() {
  const state = { status: 200, requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      state.requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? '',
        body,
      });
      if (state.status !== 200) {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock upstream boom' } }));
        return;
      }
      const model = typeof body?.model === 'string' && body.model ? body.model : 'mock-model';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    port,
    close: () => new Promise((resolve) => {
      // fetch/undici 会留 keep-alive 连接;不主动断开会把 server.close() 吊住。
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** save 的公共参数(除 --key-stdin/--force 之外都一样)。 */
function saveArgs(root, baseUrl, model, extra = []) {
  return [
    'save',
    '--bot', 'megumin',
    '--slot', 'bot',
    '--provider', 'custom',
    '--base-url', baseUrl,
    '--model', model,
    '--json',
    '--root', root,
    ...extra,
  ];
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

export function registerModelSettingsTests({ test, assert }) {
  test('模型设置 CLI:用法错误一律退出码 2(未知命令/缺 --bot/非法 bot/非法 slot/未知参数/缺参数)', async () => {
    const root = tempRoot();
    try {
      const cases = [
        { label: '未知命令', args: ['frobnicate', '--bot', 'megumin', '--json', '--root', root], error: 'unknown_command' },
        { label: '缺 --bot', args: ['info', '--json', '--root', root], error: 'missing_arg' },
        { label: '非法 bot', args: ['info', '--bot', 'nobody', '--json', '--root', root], error: 'bad_bot' },
        { label: '非法 slot', args: ['test', '--bot', 'megumin', '--slot', 'world', '--json', '--root', root], error: 'bad_slot' },
        { label: '未知参数', args: ['info', '--bot', 'megumin', '--nope', 'x', '--json', '--root', root], error: 'unknown_arg' },
        { label: 'key 不许走 argv', args: ['save', '--bot', 'megumin', '--slot', 'bot', '--provider', 'custom', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'm', '--key', 'sk-not-via-argv', '--json', '--root', root], error: 'unknown_arg' },
        { label: 'save 缺参数', args: ['save', '--bot', 'megumin', '--slot', 'bot', '--json', '--root', root], error: 'missing_arg' },
      ];
      for (const one of cases) {
        const result = await runCli(one.args);
        assert.equal(result.status, 2, `${one.label}:要退出码 2,实际 ${result.status}\n${result.stderr || result.stdout}`);
        const json = parseJsonResult(result, one.label);
        assert.equal(json.ok, false, `${one.label}:失败也要输出 ok:false`);
        assert.equal(json.error, one.error, `${one.label}:error 要说清是哪类用法错误`);
        assert.equal(result.stderr.trim(), '', `${one.label}:--json 时 stderr 尽量空`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('模型设置 CLI:info --json 空根可解析且只出 mask;env 兜底只认 bots\\<bot>\\.env 的 QQBOT_LLM_*', async () => {
    const root = tempRoot();
    try {
      // ① 空临时根:没有覆盖文件、没有 .env → 两只都未配置,但 JSON 合法、形状齐全
      const empty = await runCli(['info', '--bot', 'megumin', '--json', '--root', root]);
      assert.equal(empty.status, 0, empty.stderr || empty.stdout);
      const emptyJson = parseJsonResult(empty, 'info(空根)');
      assert.equal(emptyJson.ok, true);
      assert.equal(emptyJson.bot, 'megumin');
      assert.equal(emptyJson.slots.bot.configured, false);
      assert.equal(emptyJson.slots.bot.source, 'none');
      assert.equal(emptyJson.slots.bot.keyMasked, '');
      assert.equal(emptyJson.file, slotFile(root, 'megumin'), '覆盖文件路径 = data/<bot>/model-slots.json');
      assert.equal(emptyJson.fileExists, false);
      assert.equal(emptyJson.envFile, envFile(root, 'megumin'));
      assert.equal(emptyJson.secretAvailable, true, '本机 Windows 上 DPAPI 应可用');
      const providerIds = emptyJson.providers.map((one) => one.id);
      for (const id of ['deepseek', 'xai', 'longapi', 'custom']) {
        assert.ok(providerIds.includes(id), `providers 里要有 ${id}(GUI 下拉用)`);
      }
      assert.ok(emptyJson.providers.every((one) => one.label && Array.isArray(one.models)), 'provider 带 label/models');
      assert.ok(!('apiKey' in emptyJson.slots.bot), 'publicSlotView 不许带 apiKey 字段');
      assert.equal(empty.stdout.includes('apiKey'), false, 'info 的 stdout 不许出现 apiKey 字样');

      // ② 只有 bots\<bot>\.env:env 兜底生效,输出只露 mask,明文 key 一个字都不许出现
      const botKey = 'sk-env-SENTINEL-9876';
      const dreamKey = 'sk-dream-SENTINEL-5432';
      fs.mkdirSync(path.join(root, 'bots', 'megumin'), { recursive: true });
      fs.writeFileSync(envFile(root, 'megumin'), [
        `QQBOT_LLM_KEY=${botKey}`,
        'QQBOT_LLM_BASEURL=https://api.deepseek.com/v1',
        'QQBOT_LLM_MODEL=deepseek-chat',
        `QQBOT_LLM_DREAM_KEY=${dreamKey}`,
        'QQBOT_LLM_DREAM_BASEURL=https://api.x.ai/v1',
        'QQBOT_LLM_DREAM_MODEL=grok-4.7',
        'QQBOT_UNRELATED=not-for-llm',
        '',
      ].join('\n'), 'utf8');
      const withEnv = await runCli(['info', '--bot', 'megumin', '--json', '--root', root]);
      assert.equal(withEnv.status, 0, withEnv.stderr || withEnv.stdout);
      const envJson = parseJsonResult(withEnv, 'info(env 兜底)');
      assert.equal(envJson.slots.bot.source, 'env:QQBOT_LLM_KEY', 'bot 的 key 来自 QQBOT_LLM_KEY');
      assert.equal(envJson.slots.bot.hasKey, true);
      assert.equal(envJson.slots.bot.keyMasked, 'sk-…9876', 'mask 只露尾号');
      assert.equal(envJson.slots.bot.model, 'deepseek-chat');
      assert.equal(envJson.slots.dream.source, 'env:QQBOT_LLM_DREAM_KEY', '梦境用自己的 env 前缀');
      assert.equal(envJson.slots.dream.keyMasked, 'sk-…5432');
      assert.equal(withEnv.stdout.includes(botKey), false, '**绝不许打印 bot key 明文**');
      assert.equal(withEnv.stdout.includes(dreamKey), false, '**绝不许打印梦境 key 明文**');
      assert.equal(withEnv.stdout.includes('not-for-llm'), false, '非 QQBOT_LLM_ 的键不该进模型配置');

      // ③ 人读模式:中文摘要 + 同样不许出现 key 明文
      const human = await runCli(['info', '--bot', 'megumin', '--root', root]);
      assert.equal(human.status, 0, human.stderr || human.stdout);
      assert.match(human.stdout, /模型配置/, '人读模式要有中文摘要');
      assert.equal(human.stdout.includes(botKey), false);
      assert.equal(human.stderr.trim(), '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('模型设置 CLI:未配置映射 —— test 退出 4;save 无 key 且无已保存 key 退出 4;坏 Base URL 退出 2', async () => {
    const root = tempRoot();
    try {
      // test 未配置:没有 key/baseUrl/model 就不该联网,直接 4
      const testUnconfigured = await runCli(['test', '--bot', 'megumin', '--slot', 'bot', '--json', '--root', root]);
      assert.equal(testUnconfigured.status, 4, testUnconfigured.stderr || testUnconfigured.stdout);
      const testJson = parseJsonResult(testUnconfigured, 'test(未配置)');
      assert.equal(testJson.ok, false);
      assert.equal(testJson.error, 'key_required');
      assert.equal(testJson.slot, 'bot');
      assert.equal(testUnconfigured.stderr.trim(), '');

      // save 无 key 且无已保存 key:沿用不了 ⇒ 4(这里 baseUrl 是回环,合法,所以卡在 key 上)
      const noKey = await runCli([
        'save', '--bot', 'megumin', '--slot', 'dream',
        '--provider', 'custom', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'mock-model',
        '--json', '--root', root,
      ]);
      assert.equal(noKey.status, 4, noKey.stderr || noKey.stdout);
      assert.equal(parseJsonResult(noKey, 'save(无 key)').error, 'key_required');

      // 坏 Base URL 的两条(都来自 --base-url 参数 ⇒ 参数错 = 2)
      const httpBad = await runCli([
        'save', '--bot', 'megumin', '--slot', 'bot',
        '--provider', 'custom', '--base-url', 'http://api.example.com/v1', '--model', 'mock-model',
        '--json', '--root', root,
      ]);
      assert.equal(httpBad.status, 2, httpBad.stderr || httpBad.stdout);
      assert.equal(parseJsonResult(httpBad, 'save(http 非回环)').error, 'http_not_allowed',
        'http 只许回环:这条在 model-slots.normalizeBaseUrl 里,不合法就算传参错(2)');

      const queryBad = await runCli([
        'save', '--bot', 'megumin', '--slot', 'bot',
        '--provider', 'custom', '--base-url', 'https://api.example.com/v1?x=1', '--model', 'mock-model',
        '--json', '--root', root,
      ]);
      assert.equal(queryBad.status, 2, queryBad.stderr || queryBad.stdout);
      assert.equal(parseJsonResult(queryBad, 'save(带 query)').error, 'query_not_allowed',
        'Base URL 带 query 会把参数混进拼出来的 endpoint,也算传参错(2)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('模型设置 CLI:save --key-stdin 真跑 mock —— 0;盘上只有 DPAPI 密文;info 只露尾号;reset 回未配置', async () => {
    const root = tempRoot();
    const mock = await startMock();
    try {
      const key = 'sk-cli-SECRET-abcd'; // 明显假的 key,只用来钉"不出明文"
      const save = await runCli(saveArgs(root, mock.baseUrl, 'mock-model', ['--key-stdin']), { input: `${key}\r\n` });
      assert.equal(save.status, 0, save.stderr || save.stdout);
      assert.equal(save.stderr.trim(), '', '--json 成功时 stderr 应为空');
      const saved = parseJsonResult(save, 'save');
      assert.equal(saved.ok, true);
      assert.equal(saved.bot, 'megumin');
      assert.equal(saved.slot, 'bot');
      assert.equal(saved.tested, true, '默认保存前先测');
      assert.equal(saved.view.keyMasked, 'sk-…abcd', '只露尾号');
      assert.equal(saved.view.configured, true);
      assert.equal(saved.view.source, 'panel');
      assert.equal(save.stdout.includes(key), false, 'stdout 不许出现 key 明文');
      assert.ok(!('apiKey' in saved.view), '返回的 view 不许带 apiKey 字段');

      // 保存前那发 ping 真的打了:messages=ping、16 token、鉴权头用的是 stdin 来的 key
      assert.equal(mock.state.requests.length, 1, '默认 testFirst 要真打一发 ping');
      const ping = mock.state.requests[0];
      assert.equal(ping.url, '/v1/chat/completions');
      assert.equal(ping.body.model, 'mock-model');
      assert.equal(ping.body.max_tokens, 16);
      assert.equal(ping.body.messages.at(-1).content, 'ping');
      assert.equal(ping.authorization, `Bearer ${key}`, 'ping 用的就是 stdin 里那把 key');

      // 落盘:apiKeyEnc 在,明文不在
      const file = slotFile(root, 'megumin');
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(raw.includes('apiKeyEnc'), '盘上要有 DPAPI 密文');
      assert.equal(raw.includes(key), false, '**盘上不许有明文 key**');
      assert.equal(raw.includes('SECRET'), false, '连 key 的中段也不该出现');
      const stored = JSON.parse(raw);
      assert.equal(stored.version, 1);
      assert.ok(String(stored.slots.bot.apiKeyEnc).length > 20, '密文长度正常(真走了 DPAPI)');

      // info:只露尾号,且明文不出现
      const info = await runCli(['info', '--bot', 'megumin', '--json', '--root', root]);
      assert.equal(info.status, 0, info.stderr || info.stdout);
      const infoJson = parseJsonResult(info, 'info(已保存)');
      assert.equal(infoJson.fileExists, true);
      assert.equal(infoJson.slots.bot.source, 'panel');
      assert.equal(infoJson.slots.bot.keyMasked, 'sk-…abcd');
      assert.equal(infoJson.slots.bot.model, 'mock-model');
      assert.equal(info.stdout.includes(key), false);
      assert.ok(Array.isArray(infoJson.audit), 'info 要带审计');
      assert.ok(infoJson.audit.some((row) => row.action === 'save' && row.keyFingerprint), '审计只记指纹');

      // reset:回到 env/未配置(这个临时根没有 .env ⇒ 未配置)
      const reset = await runCli(['reset', '--bot', 'megumin', '--slot', 'bot', '--json', '--root', root]);
      assert.equal(reset.status, 0, reset.stderr || reset.stdout);
      const resetJson = parseJsonResult(reset, 'reset');
      assert.equal(resetJson.ok, true);
      assert.equal(resetJson.view.configured, false, '没有 env 兜底 ⇒ reset 后未配置');
      assert.equal(resetJson.view.source, 'none');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).slots.bot, undefined, '覆盖文件里该槽位已删除');

      const afterReset = parseJsonResult(
        await runCli(['info', '--bot', 'megumin', '--json', '--root', root]),
        'info(reset 后)',
      );
      assert.equal(afterReset.slots.bot.configured, false);
      assert.equal(afterReset.slots.bot.hasKey, false);
    } finally {
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('模型设置 CLI:不带 --key-stdin 沿用旧 key;500 时 save 退出 3 且旧文件逐字节不变;--force 跳过测试', async () => {
    const root = tempRoot();
    const mock = await startMock();
    try {
      const file = slotFile(root, 'megumin');
      const key1 = 'sk-first-KEY-1111';
      const key2 = 'sk-second-KEY-2222';

      // 先存一份好的(默认先测 → 打一发 mock)
      const first = await runCli(saveArgs(root, mock.baseUrl, 'mock-model', ['--key-stdin']), { input: `${key1}\n` });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.equal(mock.state.requests.length, 1);
      assert.ok(fs.readFileSync(file, 'utf8').includes('apiKeyEnc'));

      // 再存一次:**GUI 的真实形状** —— 永远带 --key-stdin,key 留空 = stdin 里一个字节都没有
      // (带 --key-stdin 但 stdin 为空 ⇒ apiKey '' ⇒ 沿用旧 key),然后又打一发 ping(鉴权头是旧 key)
      const beforeSecond = mock.state.requests.length;
      const second = await runCli(saveArgs(root, mock.baseUrl, 'mock-model-two', ['--key-stdin']), { input: '' });
      assert.equal(second.status, 0, second.stderr || second.stdout);
      const secondJson = parseJsonResult(second, 'save(沿用旧 key)');
      assert.equal(secondJson.view.model, 'mock-model-two');
      assert.equal(secondJson.view.hasKey, true, '没给 key 也要保留已保存的 key');
      assert.equal(secondJson.view.keyMasked, 'sk-…1111');
      assert.equal(mock.state.requests.length, beforeSecond + 1, '沿用旧 key 也要先测一发');
      assert.equal(mock.state.requests.at(-1).authorization, `Bearer ${key1}`, 'ping 用的是旧 key');
      assert.equal(mock.state.requests.at(-1).body.model, 'mock-model-two');
      const goodBytes = fs.readFileSync(file);

      // 上游 500:默认先测 ⇒ 3,旧配置一个字节都不动
      mock.state.status = 500;
      const bad = await runCli(saveArgs(root, mock.baseUrl, 'mock-model-bad', ['--key-stdin']), { input: `${key2}\n` });
      assert.equal(bad.status, 3, bad.stderr || bad.stdout);
      const badJson = parseJsonResult(bad, 'save(上游 500)');
      assert.equal(badJson.ok, false);
      assert.equal(badJson.error, 'test_failed');
      assert.equal(badJson.slot, 'bot');
      assert.equal(badJson.test.status, 500, '要把上游状态码带出来给 GUI 看');
      assert.ok(goodBytes.equals(fs.readFileSync(file)), '**测试失败不许覆盖旧配置(逐字节一致)**');
      assert.equal(fs.readFileSync(file, 'utf8').includes(key2), false, '失败的 key 更不许落盘');
      assert.equal(bad.stdout.includes(key2), false);

      // test 命令:同一份坏上游也是 3,并带出 status
      const testBad = await runCli(['test', '--bot', 'megumin', '--slot', 'bot', '--json', '--root', root]);
      assert.equal(testBad.status, 3, testBad.stderr || testBad.stdout);
      const testBadJson = parseJsonResult(testBad, 'test(上游 500)');
      assert.equal(testBadJson.error, 'test_failed');
      assert.equal(testBadJson.test.status, 500);
      assert.equal(testBad.stdout.includes(key1), false);

      // --force:跳过保存前测试 ⇒ 上游还是 500 也成功,而且不再打 ping
      const beforeForce = mock.state.requests.length;
      const forced = await runCli(saveArgs(root, mock.baseUrl, 'mock-model-bad', ['--key-stdin', '--force']), { input: `${key2}\n` });
      assert.equal(forced.status, 0, forced.stderr || forced.stdout);
      const forcedJson = parseJsonResult(forced, 'save(--force)');
      assert.equal(forcedJson.ok, true);
      assert.equal(forcedJson.tested, false, '--force 要如实说明没测');
      assert.equal(forcedJson.view.model, 'mock-model-bad');
      assert.equal(mock.state.requests.length, beforeForce, '--force 不许偷偷再打 ping');
      const forcedRaw = fs.readFileSync(file, 'utf8');
      assert.ok(forcedRaw.includes('apiKeyEnc'));
      assert.equal(forcedRaw.includes(key2), false, '新 key 也只以密文落盘');
      assert.equal(forcedRaw.includes(key1), false);

      // 上游恢复 200:test 命令 0;info 读到新 key 的尾号
      mock.state.status = 200;
      const testOk = await runCli(['test', '--bot', 'megumin', '--slot', 'bot', '--json', '--root', root]);
      assert.equal(testOk.status, 0, testOk.stderr || testOk.stdout);
      const testOkJson = parseJsonResult(testOk, 'test(正常)');
      assert.equal(testOkJson.ok, true);
      assert.equal(testOkJson.slot, 'bot');
      assert.equal(testOkJson.model, 'mock-model-bad');
      assert.ok(Number.isFinite(testOkJson.latencyMs) && testOkJson.latencyMs >= 0);
      assert.equal(testOkJson.usage.completionTokens, 1);
      assert.equal(testOk.stdout.includes(key2), false);

      const infoJson = parseJsonResult(
        await runCli(['info', '--bot', 'megumin', '--json', '--root', root]),
        'info(force 后)',
      );
      assert.equal(infoJson.slots.bot.keyMasked, 'sk-…2222', '盘上的 key 已换成第二把');
      assert.equal(infoJson.slots.bot.model, 'mock-model-bad');
      assert.equal(infoJson.slots.bot.source, 'panel');
    } finally {
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('模型设置 CLI:DPAPI 解不开(换机器/换 Windows 用户的现场)—— test 退出 5,info 仍 0 并带出问题,reset 能救', async () => {
    const root = tempRoot();
    try {
      const file = slotFile(root, 'megumin');
      const blob = 'bogus-not-a-dpapi-blob';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        version: 1,
        slots: {
          bot: {
            provider: 'custom',
            baseUrl: 'http://127.0.0.1:9/v1',
            model: 'mock-model',
            apiKeyEnc: blob,
            updatedAt: 1,
            updatedBy: 'tester',
          },
        },
      }, null, 2)}\n`, 'utf8');

      // test:key 解不开 ⇒ 5(不是 4"未配置":配置在,是密钥在这台机器上解不开)
      const testResult = await runCli(['test', '--bot', 'megumin', '--slot', 'bot', '--json', '--root', root]);
      assert.equal(testResult.status, 5, testResult.stderr || testResult.stdout);
      const testJson = parseJsonResult(testResult, 'test(DPAPI 解不开)');
      assert.equal(testJson.ok, false);
      assert.equal(String(testJson.error).startsWith('unseal_failed'), true, 'error 要指出是解封失败');
      assert.equal(testResult.stdout.includes(blob), false, '密文本身也不该回显');

      // info 是状态报告:照样退出 0,把问题放在 problems 里
      const info = await runCli(['info', '--bot', 'megumin', '--json', '--root', root]);
      assert.equal(info.status, 0, info.stderr || info.stdout);
      const infoJson = parseJsonResult(info, 'info(DPAPI 解不开)');
      assert.equal(infoJson.ok, true);
      assert.equal(infoJson.slots.bot.configured, false, '解不开 = 这个 slot 当前不可用');
      assert.equal(String(infoJson.problems.bot).startsWith('unseal_failed'), true, 'problems 要如实带出');
      assert.equal(info.stdout.includes(blob), false);

      // reset 是逃生门:删掉这条解不开的配置,退出 0
      const reset = await runCli(['reset', '--bot', 'megumin', '--slot', 'bot', '--json', '--root', root]);
      assert.equal(reset.status, 0, reset.stderr || reset.stdout);
      assert.equal(parseJsonResult(reset, 'reset(逃生门)').ok, true);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).slots.bot, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 独立运行:`node scripts\selftest-model-settings.js`
// (被 scripts\selftest.js import 时 process.argv[1] 不是本文件,这段不跑)
// ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cases = [];
  const test = (name, fn) => cases.push([name, fn]);
  registerModelSettingsTests({ test, assert });
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      process.stdout.write(`  ok   ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`  FAIL ${name}\n       ${err?.message ?? err}\n`);
    }
  }
  process.stdout.write(`\n${cases.length - failed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
