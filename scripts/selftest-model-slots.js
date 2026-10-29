/**
 * **模型接入两套配置判据**(2026-10-18 / 1.153.0)。
 *
 * 用户拍板:Bot 只有一套配置(所有前端共用),梦境另一套;key 输入即锁定、只能覆盖;
 * 保存后热替换、不重启;换模型不碰 Bot 记忆/身份。
 *
 * 这个 suite 盯的就是这几条**消费端**:
 *  · bot 和 dream 各用各的 client,不串;
 *  · 保存后 `scoped()` 下一次调用真的换人;已发出的调用不回头改;
 *  · 盘上没有明文 key,info 接口只出 mask;
 *  · 测试失败不覆盖旧配置;reset 回环境变量;
 *  · **网页 admin 已删(2026-10-18)**:这个 suite 不再渲染 `/admin/models` 页、不再断言
 *    `/api/admin/llm*` 路由表(删改见 panel 那一侧;本文件只盯模型 registry 本身);
 *  · **文件热加载(2026-10-18)**:改 `model-slots.json` 下一轮生效、不重启;
 *    坏 JSON/坏形状/解封失败/建 client 抛错**保留旧配置、绝不回退 env**;
 *    watch 只认主文件名、防抖 200ms、close 后不再触发、日志不带 key 明文。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultsFromEnv,
  mergeSlot,
  normalizeBaseUrl,
  normalizeModel,
  normalizeApiKey,
  normalizeReasoning,
  providerById,
  providerForBaseUrl,
  validateSlotInput,
  maskKey,
  keyFingerprint,
} from '../src/model-slots.js';
import { createLlmSettings, MODEL_SLOTS_FILE } from '../src/llm-settings.js';

function fakeBox({ failOn = null } = {}) {
  return {
    available: true,
    seal: (plain) => 'enc:' + Buffer.from(String(plain), 'utf8').toString('base64'),
    unseal: (sealed) => {
      // 热加载判据:让某个特征密文"解不开",模拟换 Windows 用户/换机器。
      if (failOn && String(sealed).includes(failOn)) throw new Error('DPAPI 解封失败(换用户/换机器?)');
      return Buffer.from(String(sealed).slice(4), 'base64').toString('utf8');
    },
  };
}

function fakeFactory(calls, { fail = false } = {}) {
  return ({ model, apiKey, baseUrl }) => ({
    async chat(messages, options = {}) {
      calls.push({ baseUrl, model, apiKey, options, messages });
      if (fail) {
        const err = new Error('upstream 401 bad key');
        err.status = 401;
        throw err;
      }
      return { model, text: 'ok', usage: { completionTokens: 1 } };
    },
    async chatStream() { return { model, text: 'ok', usage: null }; },
  });
}

/** 收集 log.info/warn 的一行行文本(热加载判据要断言"没有 key 明文")。 */
function collectLog(lines) {
  return {
    info: (line) => lines.push({ level: 'info', line: String(line) }),
    warn: (line) => lines.push({ level: 'warn', line: String(line) }),
    debug: () => {},
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待(10ms 步进、最多 2s)—— 不用固定 sleep,避免慢机器上 flaky。 */
async function waitFor(predicate, timeoutMs = 2000, stepMs = 10) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

/** 等"重建次数"停止增长(防抖/重复事件都落定),再开始下一步的计数断言。 */
async function settle(built, quietMs = 150, maxMs = 1500) {
  const startedAt = Date.now();
  let last = built.length;
  let quietSince = Date.now();
  while (Date.now() - startedAt < maxMs) {
    await sleep(50);
    if (built.length !== last) {
      last = built.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
}

export function registerModelSlotTests({ test, assert }) {
  test('模型接入:env 默认值 —— bot 可回退梦境 key(如实标来源),梦境不反向借 bot', () => {
    const onlyDream = defaultsFromEnv({
      QQBOT_LLM_DREAM_KEY: 'sk-dream',
      QQBOT_LLM_DREAM_BASEURL: 'https://api.deepseek.com/v1',
      QQBOT_LLM_DREAM_MODEL: 'deepseek-chat',
    });
    assert.equal(onlyDream.bot.apiKey, 'sk-dream');
    assert.equal(onlyDream.bot.source, 'env:QQBOT_LLM_DREAM_KEY(回退)');
    assert.equal(onlyDream.dream.source, 'env:QQBOT_LLM_DREAM_KEY');
    assert.equal(onlyDream.dream.configured, true);

    const noKeys = defaultsFromEnv({});
    assert.equal(noKeys.bot.configured, false);
    assert.equal(noKeys.dream.configured, false);
    assert.equal(noKeys.dream.apiKey, '', '梦境不许偷偷借 bot 的 key');
  });

  test('模型接入:URL/模型/key 校验 —— http 只许回环,元数据地址拒绝,query 不带', () => {
    assert.deepEqual(normalizeBaseUrl('https://api.x.ai/v1/'), { ok: true, value: 'https://api.x.ai/v1' });
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/v1').ok, true);
    assert.equal(normalizeBaseUrl('http://localhost:8080/v1').ok, true);
    assert.equal(normalizeBaseUrl('http://api.x.ai/v1').error, 'http_not_allowed');
    assert.equal(normalizeBaseUrl('https://user:pass@api.x.ai/v1').error, 'credentials_in_url');
    assert.equal(normalizeBaseUrl('https://api.x.ai/v1?x=1').error, 'query_not_allowed');
    assert.equal(normalizeBaseUrl('http://169.254.169.254/latest').error, 'http_not_allowed');
    assert.equal(normalizeBaseUrl('https://169.254.169.254/latest').error, 'metadata_host');
    assert.equal(normalizeModel('grok-4.7').ok, true);
    assert.equal(normalizeModel('bad model').error, 'bad_model');
    assert.equal(normalizeApiKey('sk-abc').ok, true);
    assert.equal(normalizeApiKey('sk abc').error, 'bad_key_chars');
    assert.equal(validateSlotInput({ slot: 'world', provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7' }).error, 'bad_slot');
    assert.equal(maskKey('sk-1234567890'), 'sk-…7890');
    assert.equal(keyFingerprint('sk-1234567890').length, 8);
  });

  test('模型接入:思考档位校验 —— 空/auto 归一,非法值拒绝,保存字段带 reasoning', () => {
    assert.equal(normalizeReasoning('').value, 'auto');
    assert.equal(normalizeReasoning('auto').value, 'auto');
    assert.equal(normalizeReasoning('LOW').value, 'low');
    assert.equal(normalizeReasoning('bad').error, 'bad_reasoning');
    const checked = validateSlotInput({
      slot: 'dream', provider: 'longapi', baseUrl: 'https://newapi.example/v1',
      model: 'grok-4.7', apiKey: 'sk-test', reasoning: 'low',
    });
    assert.equal(checked.ok, true);
    assert.equal(checked.value.reasoning, 'low');
    const merged = mergeSlot({ slot: 'dream', reasoning: 'off' }, { model: 'grok-4.7' });
    assert.equal(merged.reasoning, 'off', '覆盖没写 reasoning 时保留默认档');
  });

  test('模型接入:Agent Plan 预置 —— /api/plan/v3 自动认 provider,模型不带日期后缀', () => {
    assert.equal(providerForBaseUrl('https://ark.cn-beijing.volces.com/api/plan/v3'), 'volcengine-agent-plan');
    const provider = providerById('volcengine-agent-plan');
    assert.equal(provider.baseUrl, 'https://ark.cn-beijing.volces.com/api/plan/v3');
    assert.equal(provider.models.includes('doubao-seed-2.1-turbo'), true);
    assert.equal(provider.models.includes('doubao-seed-2.1-turbo-260628'), false, 'Plan 模型名不带日期后缀');
    assert.equal(validateSlotInput({
      slot: 'dream',
      provider: 'volcengine-agent-plan',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      model: 'doubao-seed-2.1-turbo',
      apiKey: 'ark-test',
    }).ok, true);
  });

  test('模型接入:mergeSlot —— 覆盖有 key 用覆盖,覆盖没 key 保留默认', () => {
    const base = { slot: 'bot', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-env', source: 'env:QQBOT_LLM_KEY' };
    const withKey = mergeSlot(base, { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: 'xai-new' });
    assert.equal(withKey.apiKey, 'xai-new');
    assert.equal(withKey.source, 'panel');
    const noKey = mergeSlot(base, { model: 'deepseek-v4-pro' });
    assert.equal(noKey.apiKey, 'sk-env', '留空 = 不换 key');
    assert.equal(noKey.model, 'deepseek-v4-pro');
  });

  test('模型接入:保存 → 盘上无明文 key,info 只出 mask;重启后能解封', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-slots-'));
    const file = path.join(dir, 'model-slots.json');
    const calls = [];
    const env = {
      QQBOT_LLM_KEY: 'sk-bot', QQBOT_LLM_BASEURL: 'https://api.deepseek.com/v1', QQBOT_LLM_MODEL: 'deepseek-chat',
    };
    const settings = createLlmSettings({
      file, env, secretBox: fakeBox(), createClient: fakeFactory(calls), now: () => 1000,
    });
    try {
      settings.load();
      const saved = await settings.save('dream', {
        provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: 'xai-secret',
      }, { by: 'tester', testFirst: false });
      assert.equal(saved.ok, true);
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(!raw.includes('xai-secret'), '盘上不许有明文 key');
      assert.ok(raw.includes('apiKeyEnc'), '盘上必须有 DPAPI 密文');
      const info = settings.info();
      assert.equal(info.slots.dream.keyMasked, 'xai…cret');
      assert.ok(!JSON.stringify(info).includes('xai-secret'), '信息接口不许带原 key');
      assert.ok(info.audit.some((row) => row.action === 'save' && row.keyFingerprint), '审计只记指纹');

      // 重启:同一个 secretBox 能解封,client 用回保存的模型
      const calls2 = [];
      const again = createLlmSettings({ file, env, secretBox: fakeBox(), createClient: fakeFactory(calls2) });
      again.load();
      assert.equal(again.isConfigured('dream'), true);
      assert.equal(again.get('dream').model, 'grok-4.7');
      assert.equal(again.get('dream').apiKey, 'xai-secret');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('模型接入:可复用模型档案 —— 保存/重启可读/只出 mask/删除;key 不写明文', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-profile-'));
    const file = path.join(dir, MODEL_SLOTS_FILE);
    const make = () => createLlmSettings({
      file, env: {}, secretBox: fakeBox(),
      createClient: () => ({ chat: async () => ({ model: 'grok-4.7', text: 'ok', usage: null }), chatStream: async () => ({}) }),
      log: { info() {}, warn() {}, error() {} },
    });
    try {
      const settings = make();
      settings.load();
      const saved = await settings.saveProfile({
        label: 'Grok 中转', provider: 'longapi', baseUrl: 'https://newapi.example/v1',
        model: 'grok-4.7', reasoning: 'low', apiKey: 'sk-profile-secret',
      }, { testFirst: false });
      assert.equal(saved.ok, true);
      assert.equal(saved.profile.reasoning, 'low');
      const raw = fs.readFileSync(file, 'utf8');
      assert.equal(raw.includes('sk-profile-secret'), false, '盘上不许有明文 key');
      const again = make();
      again.load();
      assert.equal(again.info().profiles.length, 1, '重启后档案可读');
      assert.equal(again.info().profiles[0].keyMasked.includes('secret'), false);
      assert.ok(again.clientForProfile(again.info().profiles[0].id), '档案 client 可取出');
      const deleted = again.deleteProfile(again.info().profiles[0].id);
      assert.equal(deleted.ok, true);
      assert.equal(again.info().profiles.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('模型接入:热替换 —— 保存后下一次调用换 client;测试失败不覆盖旧配置', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-hot-'));
    const file = path.join(dir, 'model-slots.json');
    const calls = [];
    const settings = createLlmSettings({
      file,
      env: { QQBOT_LLM_KEY: 'sk-bot', QQBOT_LLM_BASEURL: 'https://api.deepseek.com/v1', QQBOT_LLM_MODEL: 'deepseek-chat' },
      secretBox: fakeBox(),
      createClient: fakeFactory(calls),
    });
    try {
      settings.load();
      const dream = settings.scoped('dream');
      assert.throws(() => dream.chat([{ role: 'user', content: 'x' }]), /还没配好/);

      await settings.save('dream', {
        provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: 'xai-one',
      }, { testFirst: false });
      await dream.chat([{ role: 'user', content: 'x' }]);
      assert.equal(calls.at(-1).model, 'grok-4.7');
      assert.equal(calls.at(-1).apiKey, 'xai-one');

      // 换模型但不填 key:沿用旧 key;新 client 下一次生效
      const saved2 = await settings.save('dream', {
        provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', apiKey: '',
      }, { testFirst: false });
      assert.equal(saved2.ok, true);
      await dream.chat([{ role: 'user', content: 'x' }]);
      assert.equal(calls.at(-1).model, 'grok-4.6');
      assert.equal(calls.at(-1).apiKey, 'xai-one');

      // 测试失败:旧配置仍是 grok-4.6
      const failSettings = createLlmSettings({
        file, env: {}, secretBox: fakeBox(), createClient: fakeFactory([], { fail: true }),
      });
      failSettings.load();
      const bad = await failSettings.save('dream', {
        provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: 'xai-bad',
      }, { testFirst: true });
      assert.equal(bad.ok, false);
      assert.equal(bad.error, 'test_failed');
      assert.equal(failSettings.get('dream').model, 'grok-4.6', '测试失败不许覆盖旧配置');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('模型接入:reset 回环境变量;info 只出 mask,不出现原 key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-reset-'));
    const file = path.join(dir, 'model-slots.json');
    const settings = createLlmSettings({
      file,
      env: { QQBOT_LLM_KEY: 'sk-bot', QQBOT_LLM_BASEURL: 'https://api.deepseek.com/v1', QQBOT_LLM_MODEL: 'deepseek-chat' },
      secretBox: fakeBox(),
      createClient: fakeFactory([]),
    });
    try {
      settings.load();
      await settings.save('dream', {
        provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: 'xai-secret',
      }, { testFirst: false });
      // 网页 admin 已删(2026-10-18):不再渲染 /admin/models 页,直接盯 info 接口的脱敏。
      const info = settings.info();
      assert.ok(info.slots.dream.keyMasked.includes('…'), `info 只出掩码:${info.slots.dream.keyMasked}`);
      assert.ok(info.slots.dream.keyMasked.endsWith('cret'), `掩码只露尾号:${info.slots.dream.keyMasked}`);
      assert.ok(!JSON.stringify(info).includes('xai-secret'), 'info 接口绝不许出现原 key');
      const reset = await settings.reset('dream', { by: 'tester' });
      assert.equal(reset.ok, true);
      assert.equal(settings.info().slots.dream.configured, false, '梦境没有 env 默认,reset 后未配置');
      assert.ok(!JSON.stringify(settings.info()).includes('xai-secret'), 'reset 后也不许残留原 key');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('模型接入:热加载 reload —— 好配置下一轮生效;坏 JSON/坏形状/解封失败/建 client 抛错保留旧配置且不回退 env', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-reload-'));
    const file = path.join(dir, MODEL_SLOTS_FILE);
    const lines = [];
    const calls = [];
    const env = {
      QQBOT_LLM_KEY: 'sk-env-feature', QQBOT_LLM_BASEURL: 'https://api.deepseek.com/v1', QQBOT_LLM_MODEL: 'deepseek-chat',
    };
    const settings = createLlmSettings({
      file, env, secretBox: fakeBox({ failOn: 'boom' }), createClient: fakeFactory(calls), log: collectLog(lines),
    });
    const write = (value) => fs.writeFileSync(
      file,
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
    const featureKey = 'sk-feature-RELOAD-9f3a2b';
    try {
      // 起点:盘上一份好配置(旧),load 后正在跑的就是它。
      write({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', apiKey: 'xai-old-key' } } });
      settings.load();
      assert.equal(settings.get('bot').model, 'grok-4.6');
      await settings.scoped('bot').chat([{ role: 'user', content: 'x' }]);
      assert.equal(calls.at(-1).baseUrl, 'https://api.x.ai/v1');
      assert.equal(calls.at(-1).apiKey, 'xai-old-key');

      // 1) 好配置:reload 后 changed,scoped() 下一轮就换新 client,旧的不再被用。
      write({ version: 1, slots: { bot: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: featureKey } } });
      assert.deepEqual(settings.reload(), { ok: true, changed: true });
      assert.equal(settings.get('bot').model, 'deepseek-flash');
      assert.equal(settings.get('bot').apiKey, featureKey);
      await settings.scoped('bot').chat([{ role: 'user', content: 'x' }]);
      assert.equal(calls.at(-1).baseUrl, 'https://api.deepseek.com/v1', '下一轮必须用新 client');
      assert.equal(calls.at(-1).model, 'deepseek-flash');
      assert.equal(calls.at(-1).apiKey, featureKey);
      // 同一份内容再 reload:不报 changed(避免 watcher 每存一次都刷一行"生效")。
      assert.deepEqual(settings.reload(), { ok: true, changed: false });
      // 成功日志只报 provider/model/source,不带 key。
      const okLine = lines.find((one) => one.level === 'info' && one.line.includes('[模型] 热加载生效'));
      assert.ok(okLine, '成功要留一行 [模型] 热加载生效');
      assert.match(okLine.line, /bot=deepseek\/deepseek-flash source=panel/);
      assert.ok(!okLine.line.includes(featureKey), '成功日志不许出现 key');

      // 2) 坏 JSON:保留旧 client(仍是 panel 的 deepseek),**绝不回退 env**(env 是 deepseek-chat)。
      write('{ this is not json');
      const badJson = settings.reload();
      assert.equal(badJson.ok, false);
      assert.equal(badJson.error, 'bad_json');
      assert.equal(settings.get('bot').baseUrl, 'https://api.deepseek.com/v1', '坏 JSON 不许回退 env');
      assert.equal(settings.get('bot').model, 'deepseek-flash');
      assert.equal(settings.get('bot').source, 'panel');
      assert.equal(settings.problem('bot'), null);
      await settings.scoped('bot').chat([{ role: 'user', content: 'x' }]);
      assert.equal(calls.at(-1).model, 'deepseek-flash', '旧 client 仍可用');

      // 3) 坏形状:有 JSON 但缺 slots / slots 不是对象。
      write([1, 2, 3]);
      assert.deepEqual(settings.reload(), { ok: false, error: 'bad_shape' });
      write({ version: 1 });
      assert.equal(settings.reload().error, 'bad_shape');
      assert.equal(settings.get('bot').model, 'deepseek-flash');

      // 4) 解封失败:密文解不开(模拟换 Windows 用户/换机器)。
      write({
        version: 1,
        slots: {
          bot: {
            provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7',
            apiKeyEnc: `enc:boom-${Buffer.from('xai-panel-key', 'utf8').toString('base64')}`,
          },
        },
      });
      const unseal = settings.reload();
      assert.equal(unseal.ok, false);
      assert.ok(String(unseal.error).startsWith('unseal_failed'), `错误码要能看出是解封失败:${unseal.error}`);
      assert.equal(settings.get('bot').model, 'deepseek-flash', '解封失败保留旧配置');
      assert.equal(settings.get('bot').apiKey, featureKey);
      await settings.scoped('bot').chat([{ role: 'user', content: 'x' }]);
      assert.equal(calls.at(-1).model, 'deepseek-flash');

      // 5) 校验失败:模型名非法(形状是 JSON,但内容不合法)。
      write({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'bad model', apiKey: 'sk-x-bad' } } });
      assert.deepEqual(settings.reload(), { ok: false, error: 'invalid:bad_model' });
      assert.equal(settings.get('bot').model, 'deepseek-flash');

      // 6) 文件被外部删掉:保留旧配置,不偷偷回退 env。
      fs.rmSync(file);
      assert.deepEqual(settings.reload(), { ok: false, error: 'file_missing' });
      assert.equal(settings.get('bot').model, 'deepseek-flash');

      // 7) createClient 抛错:另起一个"第二次建 client 就炸"的实例,必须保留旧配置。
      write({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', apiKey: 'xai-old-key' } } });
      let made = 0;
      const throwingCalls = [];
      const throwing = createLlmSettings({
        file, env, secretBox: fakeBox(), log: collectLog(lines),
        createClient: (cfg) => {
          made += 1;
          if (made >= 2) throw new Error('factory boom');
          return fakeFactory(throwingCalls)(cfg);
        },
      });
      throwing.load();
      assert.equal(throwing.get('bot').model, 'grok-4.6');
      write({ version: 1, slots: { bot: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-new-key' } } });
      const clientFailed = throwing.reload();
      assert.equal(clientFailed.ok, false);
      assert.ok(String(clientFailed.error).startsWith('client_failed'), `错误码要能看出是建 client 失败:${clientFailed.error}`);
      assert.equal(throwing.get('bot').baseUrl, 'https://api.x.ai/v1', 'createClient 抛错保留旧配置');
      assert.equal(throwing.get('bot').model, 'grok-4.6');
      await throwing.scoped('bot').chat([{ role: 'user', content: 'x' }]);
      assert.equal(throwingCalls.at(-1).model, 'grok-4.6');

      // 8) 判据:所有失败都留了一行 warn 带错误码,整个日志里没有 key 明文。
      const text = lines.map((one) => one.line).join('\n');
      assert.ok(!text.includes(featureKey), '日志不许出现 key 明文');
      assert.ok(!text.includes('xai-old-key'), '日志不许出现 key 明文');
      assert.ok(!text.includes('sk-new-key'), '日志不许出现 key 明文');
      for (const code of ['bad_json', 'bad_shape', 'unseal_failed', 'invalid:bad_model', 'client_failed']) {
        assert.ok(
          lines.some((one) => one.level === 'warn' && one.line.includes(`[模型] 热加载失败(${code}`)),
          `失败要留一行 warn 带错误码 ${code}`,
        );
      }
    } finally {
      settings.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('模型接入:热加载 watch —— 主文件改动下一轮生效;.bak/.tmp-*/.audit.log 不触发;防抖合并;close 后不再触发', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-watch-'));
    const file = path.join(dir, MODEL_SLOTS_FILE);
    const lines = [];
    const built = [];
    const env = {
      QQBOT_LLM_KEY: 'sk-env-watch', QQBOT_LLM_BASEURL: 'https://api.deepseek.com/v1', QQBOT_LLM_MODEL: 'deepseek-chat',
    };
    const settings = createLlmSettings({
      file,
      env,
      secretBox: fakeBox(),
      log: collectLog(lines),
      createClient: (cfg) => {
        built.push({ baseUrl: cfg.baseUrl, model: cfg.model });
        return fakeFactory([])(cfg);
      },
    });
    const write = (value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    // 生产里 CLI/面板走的是 atomicWriteJson:写 `.tmp-*` → 复制 `.bak` → rename 覆盖主文件。
    // 本机实测目录 watcher 对 rename 报的是 `rename:model-slots.json`(主文件名),
    // 这条判据把"真原子写能不能触发"钉下来(不只是直接 writeFileSync)。
    const atomicWrite = (value) => {
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.copyFileSync(file, `${file}.bak`);
      fs.renameSync(tmp, file);
      fs.appendFileSync(`${file}.audit.log`, '{"action":"save"}\n', 'utf8');
    };
    try {
      write({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', apiKey: 'xai-watch-1' } } });
      settings.load();
      assert.equal(settings.get('bot').model, 'grok-4.6');
      assert.equal(built.length, 1);
      const closer = settings.watch();
      assert.equal(typeof closer, 'function');
      assert.equal(settings.watch(), closer, '重复 watch 要幂等(同一个 close)');

      // 1) 原子写主文件(同 atomicWriteJson 的形状)→ ≤2s 内触发一次 reload,
      //    下一轮生效、changed(只有 changed 才打"生效"那行)。
      atomicWrite({ version: 1, slots: { bot: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-watch-2' } } });
      assert.equal(await waitFor(() => built.length >= 2), true, '主文件改动必须触发 reload');
      assert.equal(settings.get('bot').model, 'deepseek-flash');
      assert.equal(built.at(-1).baseUrl, 'https://api.deepseek.com/v1');
      assert.ok(
        lines.some((one) => one.level === 'info' && one.line.includes('[模型] 热加载生效')),
        'watch 触发的 changed 要留一行 [模型] 热加载生效',
      );
      await settle(built);

      // 2) 只认主文件名:同目录的 .bak / .tmp-* / .audit.log 写新内容也不许触发。
      const beforeNoise = built.length;
      fs.writeFileSync(`${file}.bak`, JSON.stringify({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: 'xai-bak' } } }), 'utf8');
      fs.writeFileSync(`${file}.tmp-1-2`, '{"version":1,"slots":{}}', 'utf8');
      fs.appendFileSync(`${file}.audit.log`, '{"action":"save"}\n', 'utf8');
      assert.equal(
        await waitFor(() => built.length !== beforeNoise, 600),
        false,
        '.bak / .tmp-* / .audit.log 不许触发 reload',
      );

      // 3) 防抖:快速连写两次合并成一次 reload,最终用的是最后一份内容。
      const beforeBurst = built.length;
      write({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.5', apiKey: 'xai-burst' } } });
      await sleep(20);
      write({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', apiKey: 'xai-burst' } } });
      assert.equal(await waitFor(() => built.length > beforeBurst), true, '连写之后要至少触发一次');
      assert.equal(await waitFor(() => built.length > beforeBurst + 1, 500), false, '快速连写要合并成一次 reload');
      assert.equal(settings.get('bot').model, 'grok-4.6', '防抖后用的是最后一份内容');
      await settle(built);

      // 4) 日志不带 key 明文(特征串一个都不许出现)。
      const text = lines.map((one) => one.line).join('\n');
      for (const secret of ['xai-watch-1', 'sk-watch-2', 'xai-burst', 'xai-bak']) {
        assert.ok(!text.includes(secret), `日志不许出现 key 明文:${secret}`);
      }

      // 5) close() 之后写主文件不再触发(退出路径靠这条)。
      closer();
      const beforeClosed = built.length;
      write({ version: 1, slots: { bot: { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: 'xai-closed' } } });
      assert.equal(
        await waitFor(() => built.length !== beforeClosed, 600),
        false,
        'close 后不许再触发 reload',
      );
      assert.equal(settings.get('bot').model, 'grok-4.6', 'close 后文件再变,配置不动');
    } finally {
      settings.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
