/** 阶段3模型参数：全部使用合成 env/文件/密封器/client，不联网、不读生产配置。 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nodeAssert from 'node:assert/strict';
import {
  MODEL_PARAM_DEFS, MODEL_SLOT_PARAM_DEFS, defaultsFromEnv, mergeSlot,
  resolveModelSlotParams, modelParamSources, validateSlotInput,
} from '../src/model-slots.js';
import { createLlmSettings } from '../src/llm-settings.js';

const envFixture = () => ({
  QQBOT_LLM_KEY: 'sk-fixture-bot', QQBOT_LLM_BASEURL: 'https://api.deepseek.com/v1',
  QQBOT_LLM_MODEL: 'deepseek-chat',
  QQBOT_LLM_DREAM_KEY: 'sk-fixture-dream', QQBOT_LLM_DREAM_BASEURL: 'https://dream.example/v1',
  QQBOT_LLM_DREAM_MODEL: 'dream-model',
});
const inputFixture = () => ({
  provider: 'custom', baseUrl: 'https://saved.example/v1', model: 'saved-model',
  apiKey: 'sk-fixture-saved', reasoning: 'low',
});
const boxFixture = () => ({
  available: true,
  seal: (value) => `fixture-sealed:${Buffer.from(value).toString('base64')}`,
  unseal: (value) => Buffer.from(value.slice('fixture-sealed:'.length), 'base64').toString(),
});
function fixture({ env = envFixture(), createClient, secretBox = boxFixture(), clientOptions } = {}) {
  // Fixture 始终在工作区 E 盘，不碰 C/生产 .env/真实 DPAPI。
  const fixtureParent = path.resolve(import.meta.dirname, '../..');
  const dir = fs.mkdtempSync(path.join(fixtureParent, '.tmp-model-params-'));
  const file = path.join(dir, 'model-slots.json');
  const built = [];
  const logs = [];
  const settings = createLlmSettings({ file, env, secretBox, clientOptions,
    log: { warn: (line) => logs.push(String(line)), info: (line) => logs.push(String(line)) },
    createClient: createClient ?? ((config) => {
      built.push(config);
      return { chat: async () => ({ model: config.model }), chatStream: async () => ({ model: config.model }) };
    }),
  });
  return { settings, built, logs, file,
    write: (slots, profiles = []) => fs.writeFileSync(file, JSON.stringify({ version: 1, slots, profiles })),
    close() {
      settings.close();
      nodeAssert.equal(path.dirname(dir), fixtureParent);
      nodeAssert.ok(path.basename(dir).startsWith('.tmp-model-params-'));
      nodeAssert.equal(path.dirname(file), dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const isParamError = (error) => /^PARAM_/.test(error?.code ?? '');

export function registerModelParamsTests(register, positionalAssert = nodeAssert) {
  const test = typeof register === 'function' ? register : register.test;
  const assert = typeof register === 'function' ? positionalAssert : (register.assert ?? nodeAssert);
  test('模型参数:五字段注册及默认可枚举输出完全兼容', () => {
    assert.deepEqual(MODEL_PARAM_DEFS.map((one) => one.id), ['provider', 'baseUrl', 'model', 'apiKey', 'reasoning']);
    assert.equal(MODEL_PARAM_DEFS.find((one) => one.id === 'apiKey').sensitive, true);
    assert.equal(MODEL_SLOT_PARAM_DEFS.bot.length, 5);
    const defaults = defaultsFromEnv({});
    assert.deepEqual(defaults, {
      bot: { slot: 'bot', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
        apiKey: '', reasoning: 'auto', source: 'none', configured: false },
      dream: { slot: 'dream', provider: 'custom', baseUrl: '', model: '', apiKey: '', reasoning: 'auto',
        source: 'none', configured: false },
    });
    assert.equal(Object.keys(defaults.bot).includes('paramSources'), false);
    assert.equal(JSON.stringify(defaults).includes('paramSources'), false);
    assert.equal(modelParamSources(defaults.dream).baseUrl.source, 'default');
    assert.equal(Object.isFrozen(defaults.bot.paramSources), true);
    const rawUrl = defaultsFromEnv({ QQBOT_LLM_BASEURL: '  https://api.deepseek.com/v1/  ' }).bot;
    assert.equal(rawUrl.baseUrl, 'https://api.deepseek.com/v1/', '正常导出保留原有尾斜杠');
    const blank = defaultsFromEnv({ QQBOT_LLM_KEY: '   ', QQBOT_LLM_MODEL: null,
      QQBOT_LLM_DREAM_KEY: 'sk-trimmed', QQBOT_LLM_DREAM_MODEL: 'fallback-model' }).bot;
    assert.equal(blank.apiKey, 'sk-trimmed');
    assert.equal(blank.model, 'fallback-model');
    assert.equal(blank.paramSources.apiKey.chain.at(-1).env, 'QQBOT_LLM_DREAM_KEY');
    assert.equal(blank.paramSources.model.chain.at(-1).env, 'QQBOT_LLM_DREAM_MODEL');
  });

  test('模型参数:merge/env只读取一次data descriptor，校验与输出共用同一快照', () => {
    const wrap = (target) => {
      const descriptors = new Map();
      const proxy = new Proxy(target, {
        get() { throw new Error('raw-property-get-must-not-run'); },
        getOwnPropertyDescriptor(object, key) {
          descriptors.set(key, (descriptors.get(key) ?? 0) + 1);
          return Object.getOwnPropertyDescriptor(object, key);
        },
      });
      return { proxy, descriptors };
    };
    const env = wrap(envFixture());
    const defaults = defaultsFromEnv(env.proxy).bot;
    for (const key of Object.keys(envFixture())) assert.equal(env.descriptors.get(key), 1);
    const input = { ...inputFixture(), updatedAt: 123, updatedBy: 'fixture-user', label: 'UI-compatible' };
    const saved = wrap(input);
    const merged = mergeSlot(defaults, saved.proxy);
    assert.equal(merged.model, 'saved-model');
    assert.equal(merged.updatedAt, 123);
    assert.equal(merged.updatedBy, 'fixture-user');
    assert.equal(merged.paramSources.model.source, 'saved-file');
    for (const key of Object.keys(input)) assert.equal(saved.descriptors.get(key), 1);
    const invalid = wrap({ model: 'bad model' });
    assert.throws(() => mergeSlot(defaults, invalid.proxy), isParamError);
    assert.equal(invalid.descriptors.get('model'), 1);
    let reads = 0;
    const changing = new Proxy({ model: 'initial-model' }, {
      getOwnPropertyDescriptor(object, key) {
        if (key !== 'model') return Object.getOwnPropertyDescriptor(object, key);
        reads += 1;
        return { value: reads === 1 ? 'bad model' : 'later-legal-model', enumerable: true, configurable: true };
      },
    });
    assert.throws(() => mergeSlot(defaults, changing), isParamError, '首次非法值不得被第二次读取的合法值洗白');
    assert.equal(reads, 1);
  });

  test('模型参数:accessor/继承/符号/非枚举及自定义转换拒绝，getter执行零次且错误脱敏', () => {
    const defaults = defaultsFromEnv(envFixture()).bot;
    let getterRuns = 0;
    let coercions = 0;
    const marker = 'raw-private-getter-error-marker';
    const accessor = Object.defineProperty({}, 'model', { enumerable: true, get() {
      getterRuns += 1;
      throw new Error(marker);
    } });
    const badSaved = [accessor, Object.create({ model: 'inherited-model' }),
      { model: 'legal-model', [Symbol('private-marker')]: true },
      Object.defineProperty({}, 'model', { value: 'hidden-model', enumerable: false }),
      { model: { toString() { coercions += 1; throw new Error(marker); } } },
      new Proxy({}, { ownKeys() { throw new Error(marker); } }),
    ];
    for (const input of badSaved) {
      assert.throws(() => mergeSlot(defaults, input), (error) => {
        assert.equal(String(error).includes(marker), false);
        return isParamError(error);
      });
      assert.throws(() => resolveModelSlotParams(defaults, input), isParamError);
    }
    const envAccessor = Object.defineProperty({}, 'QQBOT_LLM_MODEL', { enumerable: true, get() {
      getterRuns += 1;
      throw new Error(marker);
    } });
    for (const env of [envAccessor, Object.create({ QQBOT_LLM_MODEL: 'inherited-model' }),
      { [Symbol('private-marker')]: true },
      new Proxy({}, { getPrototypeOf() { throw new Error(marker); } }),
    ]) assert.throws(() => defaultsFromEnv(env), (error) => {
      assert.equal(String(error).includes(marker), false);
      return isParamError(error);
    });
    assert.throws(() => mergeSlot(accessor, {}), isParamError);
    assert.equal(getterRuns, 0, '拒绝accessor而非先调用getter后再校验');
    assert.equal(coercions, 0);
    const plainNull = Object.assign(Object.create(null), envFixture());
    assert.equal(defaultsFromEnv(plainNull).bot.model, 'deepseek-chat');
    assert.equal(mergeSlot(defaults, Object.assign(Object.create(null), { model: 'own-model' })).model, 'own-model');
  });

  const fieldCases = [
    ['provider', 'custom.Mixed-1', 'bad provider'],
    ['provider', 'x'.repeat(40), 'x'.repeat(41)],
    ['baseUrl', 'http://localhost:1234/v1', 'http://remote.example/v1'],
    ['baseUrl', 'https://safe.example/v1/', 'not-a-url'],
    ['baseUrl', 'https://safe.example/v1', 'ftp://safe.example/v1'],
    ['baseUrl', 'https://safe.example/v1', 'https://u:p@safe.example/v1'],
    ['baseUrl', 'https://safe.example/v1', 'https://safe.example/v1?key=private'],
    ['baseUrl', 'https://safe.example/v1', 'https://safe.example/v1#fragment'],
    ['baseUrl', 'https://safe.example/v1', 'https://169.254.169.254/latest'],
    ['baseUrl', 'https://safe.example/v1', 'https://metadata.google.internal/v1'],
    ['model', 'model._:/@-1', 'bad model'],
    ['model', 'm'.repeat(120), 'm'.repeat(121)],
    ['apiKey', 'key1', 'abc'],
    ['apiKey', 'k'.repeat(512), 'k'.repeat(513)],
    ['apiKey', 'sk-safe', 'sk bad'],
    ['apiKey', 'sk-safe', 'sk\u0001bad'],
    ['reasoning', 'LOW', 'unknown-level'],
  ];
  for (const [index, [field, good, bad]] of fieldCases.entries()) {
    test(`模型参数:注册校验绿红 ${field}/${index}`, () => {
      const defaults = defaultsFromEnv(envFixture()).bot;
      assert.doesNotThrow(() => mergeSlot(defaults, { [field]: good }));
      assert.throws(() => mergeSlot(defaults, { [field]: bad }), isParamError);
    });
  }

  test('模型参数:来源链保留bot借dream与saved-file覆盖，dream不借bot', () => {
    const env = {
      QQBOT_LLM_DREAM_KEY: 'sk-fallback', QQBOT_LLM_DREAM_BASEURL: 'https://fallback.example/v1',
      QQBOT_LLM_DREAM_MODEL: 'fallback-model', QQBOT_LLM_MODEL: 'own-model',
    };
    const defaults = defaultsFromEnv(env);
    assert.equal(defaults.bot.source, 'env:QQBOT_LLM_DREAM_KEY(回退)');
    assert.equal(defaults.bot.apiKey, 'sk-fallback');
    const source = modelParamSources(defaults.bot);
    assert.equal(source.apiKey.chain.at(-1).env, 'QQBOT_LLM_DREAM_KEY');
    assert.equal(source.model.chain.at(-1).env, 'QQBOT_LLM_MODEL');
    assert.ok(source.model.chain.some((one) => one.env === 'QQBOT_LLM_DREAM_MODEL'));
    assert.equal(source.provider.derivedFrom, 'baseUrl');
    const merged = mergeSlot(defaults.bot, { model: 'saved-model', apiKey: '', label: 'UI compatibility' });
    assert.equal(merged.apiKey, 'sk-fallback');
    assert.equal(merged.model, 'saved-model');
    assert.equal(merged.paramSources.model.chain.at(-1).source, 'saved-file');
    assert.equal(merged.paramSources.apiKey.chain.at(-1).env, 'QQBOT_LLM_DREAM_KEY');
    const onlyBot = defaultsFromEnv({ QQBOT_LLM_KEY: 'sk-bot-only', QQBOT_LLM_MODEL: 'bot-only' });
    assert.equal(onlyBot.dream.apiKey, '');
    assert.equal(onlyBot.dream.model, '');
    assert.equal(onlyBot.dream.configured, false);
    assert.equal(Object.keys(resolveModelSlotParams(defaults.bot, {})).includes('inputs'), false);
    assert.equal(JSON.stringify(source).includes('sk-fallback'), false);
  });

  test('模型参数:非法低层不能被合法saved-file或env别名掩盖，错误无秘密', () => {
    const secret = 'sk bad-secret-marker';
    assert.throws(() => defaultsFromEnv({ ...envFixture(), QQBOT_LLM_DREAM_KEY: secret }), (error) => {
      assert.equal(String(error).includes(secret), false);
      return isParamError(error);
    });
    assert.throws(() => resolveModelSlotParams({ ...defaultsFromEnv({}).bot, model: 'bad lower model' },
      { model: 'legal-higher-model' }), isParamError);
  });

  for (const [name, bad] of [
    ['QQBOT_LLM_BASEURL', 'http://remote.example/v1'], ['QQBOT_LLM_MODEL', 'bad model'],
    ['QQBOT_LLM_KEY', 'sk bad-secret-marker'], ['QQBOT_LLM_DREAM_BASEURL', 'javascript:bad'],
    ['QQBOT_LLM_DREAM_MODEL', 'bad dream model'], ['QQBOT_LLM_DREAM_KEY', 'bad key'],
  ]) {
    test(`模型参数:显式非法env fail-closed ${name}`, () => {
      const fx = fixture({ env: { ...envFixture(), [name]: bad } });
      try {
        fx.write({ bot: inputFixture(), dream: inputFixture() });
        fx.settings.load();
        assert.equal(fx.settings.isConfigured('bot'), false);
        assert.equal(fx.settings.isConfigured('dream'), false);
        assert.equal(fx.built.length, 0, '不得回落未经校验env或偷偷使用合法保存覆盖');
        assert.equal(fx.settings.problem('bot'), 'invalid_env');
        assert.equal(fx.settings.get('bot').paramSources.baseUrl.source, 'default');
        assert.equal(JSON.stringify(fx.settings.info()).includes(bad), false);
        assert.equal(fx.logs.join('\n').includes(bad), false);
      } finally { fx.close(); }
    });
  }

  test('模型参数:无key也不能忽略非法env，运行中非法env拒绝reload/save/test并保旧', async () => {
    const unconfigured = fixture({ env: { QQBOT_LLM_MODEL: 'bad model' } });
    try {
      unconfigured.settings.load();
      assert.equal(unconfigured.settings.problem('bot'), 'invalid_env');
      assert.equal(unconfigured.built.length, 0);
    } finally { unconfigured.close(); }
    const env = envFixture();
    const fx = fixture({ env });
    try {
      fx.settings.load();
      const prior = fx.settings.get('bot');
      const snapshot = fx.settings.scoped('bot').snapshot();
      env.QQBOT_LLM_MODEL = 'bad model';
      fx.write({ bot: inputFixture() });
      const beforeFile = fs.readFileSync(fx.file, 'utf8');
      assert.deepEqual(fx.settings.reload(), { ok: false, error: 'invalid_env' });
      assert.equal(fx.settings.get('bot'), prior);
      assert.equal((await snapshot.chat([])).model, 'deepseek-chat');
      assert.equal((await fx.settings.save('bot', inputFixture(), { testFirst: false })).error, 'invalid_env');
      assert.equal((await fx.settings.test('bot', inputFixture())).error, 'invalid_env');
      assert.equal(fs.readFileSync(fx.file, 'utf8'), beforeFile);
    } finally { fx.close(); }
  });

  test('模型参数:空env/未配置不启动client；坏文件load仍仅回落已验证env', () => {
    const empty = fixture({ env: {} });
    try {
      empty.settings.load();
      assert.equal(empty.built.length, 0);
      assert.equal(empty.settings.problem('bot'), 'not_configured');
      empty.write({});
      assert.equal(empty.settings.reload().ok, true);
      assert.equal(empty.built.length, 0);
    } finally { empty.close(); }
    const valid = fixture();
    try {
      fs.writeFileSync(valid.file, '{broken-json');
      valid.settings.load();
      assert.equal(valid.settings.isConfigured('bot'), true);
      assert.equal(valid.settings.info().loadError, 'bad_json');
      valid.write({ bot: { model: 'bad model' } });
      valid.settings.load();
      assert.equal(valid.settings.get('bot').model, 'deepseek-chat');
      assert.equal(valid.settings.get('bot').paramSources.model.chain.at(-1).env, 'QQBOT_LLM_MODEL');
    } finally { valid.close(); }
  });

  test('模型参数:save忽略UI附属输入；实际client等于来源且clientOptions不得偷换连接', async () => {
    const fx = fixture({ clientOptions: {
      baseUrl: 'https://bypass.example', apiKey: 'sk-bypass', model: 'bypass-model', reasoning: 'max',
      timeoutMs: 3210, attempts: 2,
    } });
    try {
      fx.settings.load();
      const checkedClient = (config) => {
        const actual = fx.built.at(-1);
        for (const id of ['baseUrl', 'apiKey', 'model', 'reasoning']) assert.equal(actual[id], config[id]);
        assert.equal(actual.timeoutMs, 3210);
        assert.equal(actual.attempts, 2);
      };
      // load按bot/dream顺序建client，此刻最后一份为dream。
      checkedClient(fx.settings.get('dream'));
      const saved = await fx.settings.save('bot', { ...inputFixture(), label: 'UI label', futureUiFlag: true }, { testFirst: false });
      assert.equal(saved.ok, true);
      checkedClient(fx.settings.get('bot'));
      assert.equal(fx.settings.get('bot').paramSources.apiKey.source, 'saved-file');
      assert.equal(fx.settings.get('bot').paramSources.model.source, 'saved-file');
      assert.equal(JSON.stringify(fx.settings.info()).includes('sk-fixture-saved'), false);
      assert.equal(JSON.stringify(fx.settings.info()).includes('fixture-sealed:'), false);
      assert.equal(JSON.stringify(fx.settings.info()).includes('paramSources'), false);
      assert.equal(fs.readFileSync(fx.file, 'utf8').includes('sk-fixture-saved'), false);
      const tested = await fx.settings.test('bot', inputFixture());
      assert.equal(tested.ok, true);
      assert.equal(fx.built.at(-1).model, 'saved-model');
      assert.equal(fx.built.at(-1).timeoutMs, 3210);
      assert.equal(fx.built.at(-1).attempts, 1);
      fx.write({ bot: inputFixture() });
      assert.equal(fx.settings.reload().ok, true);
      assert.equal(fx.built.at(-2).model, 'saved-model');
      const profile = await fx.settings.saveProfile({ ...inputFixture(), label: 'profile' }, { testFirst: false });
      assert.equal(profile.ok, true);
      assert.equal(fx.built.at(-1).model, 'saved-model');
      assert.equal(fx.built.at(-1).baseUrl, 'https://saved.example/v1');
    } finally { fx.close(); }
  });

  test('模型参数:reload拒绝坏槽值/非数组profiles，整份client/profile/来源保旧且不changed', async () => {
    const fx = fixture();
    try {
      fx.settings.load();
      assert.equal((await fx.settings.save('bot', inputFixture(), { testFirst: false })).ok, true);
      const savedProfile = await fx.settings.saveProfile({ ...inputFixture(), label: 'retained-profile' }, { testFirst: false });
      assert.equal(savedProfile.ok, true);
      const id = savedProfile.profile.id;
      const previousBot = fx.settings.get('bot');
      const previousDream = fx.settings.get('dream');
      const previousProfile = fx.settings.profileConfig(id);
      const previousProfileClient = fx.settings.clientForProfile(id);
      const raw = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
      const built = fx.built.length;
      const malformed = [
        { slots: { bot: 42 }, profiles: { invalid: true } },
        ...[42, true, false, '', 'invalid', []].map((value) => ({ slots: { bot: value }, profiles: raw.profiles })),
        { slots: { dream: 42 }, profiles: raw.profiles },
        { slots: { extraSlot: 42 }, profiles: raw.profiles },
        { slots: null, profiles: raw.profiles },
        { slots: [], profiles: raw.profiles },
        ...[{}, null, 42, 'invalid', false].map((profiles) => ({ slots: raw.slots, profiles })),
      ];
      for (const value of malformed) {
        fs.writeFileSync(fx.file, JSON.stringify({ version: 1, ...value }));
        const result = fx.settings.reload();
        assert.deepEqual(result, { ok: false, error: 'bad_shape' });
        assert.equal(Object.hasOwn(result, 'changed'), false);
        assert.equal(fx.settings.get('bot'), previousBot);
        assert.equal(fx.settings.get('dream'), previousDream);
        assert.equal(fx.settings.profileConfig(id), previousProfile);
        assert.equal(fx.settings.clientForProfile(id), previousProfileClient);
        assert.equal(fx.built.length, built, '结构校验必须早于任何暂存client构建');
        assert.equal((await fx.settings.scoped('bot').chat([])).model, 'saved-model');
      }
      fx.write({ bot: null, dream: null }, raw.profiles);
      assert.equal(fx.settings.reload().ok, true, 'null槽值合法');
      assert.equal(fx.settings.get('bot').model, 'deepseek-chat');
      assert.equal(fx.settings.get('bot').paramSources.model.chain.at(-1).env, 'QQBOT_LLM_MODEL');
      fs.writeFileSync(fx.file, JSON.stringify({ version: 1, slots: {} }));
      assert.equal(fx.settings.reload().ok, true, '缺省槽值/profiles保持兼容');
      assert.equal(fx.settings.profiles().length, 0);
    } finally { fx.close(); }
  });

  test('模型参数:reload结构闸不扩改load既有回落语义', () => {
    const fx = fixture();
    try {
      fx.write({ bot: 42 }, { invalid: true });
      assert.doesNotThrow(() => fx.settings.load());
      assert.equal(fx.settings.get('bot').model, 'deepseek-chat');
      assert.equal(fx.settings.isConfigured('bot'), true);
      assert.deepEqual(fx.settings.profiles(), []);
      fx.write(null, []);
      assert.doesNotThrow(() => fx.settings.load());
      assert.equal(fx.settings.info().loadError, 'bad_shape');
      assert.equal(fx.settings.get('bot').model, 'deepseek-chat');
    } finally { fx.close(); }
  });

  test('模型参数:坏reload整份保旧client，snapshot整轮固定，合法reload下一轮生效', async () => {
    const fx = fixture();
    try {
      fx.settings.load();
      const bot = fx.settings.scoped('bot');
      const dream = fx.settings.scoped('dream');
      const snapshot = bot.snapshot();
      const priorBot = fx.settings.get('bot');
      const priorDream = fx.settings.get('dream');
      fx.write({ bot: { ...inputFixture(), model: 'next-model' }, dream: { model: 'bad model' } });
      assert.deepEqual(fx.settings.reload(), { ok: false, error: 'invalid:bad_model' });
      assert.equal(fx.settings.get('bot'), priorBot);
      assert.equal(fx.settings.get('dream'), priorDream);
      assert.equal((await bot.chat([])).model, 'deepseek-chat');
      assert.equal((await dream.chat([])).model, 'dream-model');
      fx.write({ bot: { ...inputFixture(), model: 'next-model' } });
      assert.equal(fx.settings.reload().ok, true);
      assert.equal((await snapshot.chat([])).model, 'deepseek-chat');
      assert.equal((await bot.chat([])).model, 'next-model');
      assert.equal(fx.settings.get('bot').paramSources.model.source, 'saved-file');
    } finally { fx.close(); }
  });

  test('模型参数:解封/建client/请求/封存错误只出稳定错误码，不出原始error/秘密/blob', async () => {
    const marker = 'raw-private-error-marker';
    const blob = 'fixture-secret-DPAPI-blob';
    const fx = fixture({ secretBox: { available: true, unseal() { throw new Error(`${marker}:${blob}`); } } });
    try {
      fx.settings.load();
      fx.write({ bot: { ...inputFixture(), apiKeyEnc: blob } });
      assert.deepEqual(fx.settings.reload(), { ok: false, error: 'unseal_failed' });
      fx.settings.load();
      assert.equal(fx.settings.isConfigured('bot'), false, '解封失败不许改花env key');
      assert.equal(fx.settings.get('bot').paramSources.apiKey.source, 'unavailable-secret');
      assert.equal(fx.settings.get('bot').paramSources.apiKey.chain.at(-1).source, 'unavailable-secret');
      assert.equal(JSON.stringify(fx.settings.info()).includes(marker), false);
      assert.equal(fx.logs.join('\n').includes(marker), false);
      assert.equal(fx.logs.join('\n').includes(blob), false);
    } finally { fx.close(); }
    const badClient = fixture({ createClient() { throw new Error(`${marker}:sk-fixture-bot`); } });
    try {
      badClient.settings.load();
      assert.equal(badClient.settings.problem('bot'), 'client_failed');
      assert.equal(JSON.stringify(badClient.settings.info()).includes(marker), false);
      assert.equal(badClient.logs.join('\n').includes(marker), false);
      assert.equal((await badClient.settings.test('bot')).error, 'client_failed');
      assert.equal((await badClient.settings.save('bot', inputFixture(), { testFirst: false })).error, 'client_failed');
    } finally { badClient.close(); }
    const badRequest = fixture({ createClient: () => ({ chat() { throw new Error(marker); } }) });
    try {
      badRequest.settings.load();
      assert.equal((await badRequest.settings.test('bot')).error, 'request_failed');
    } finally { badRequest.close(); }
    const badSeal = fixture({ secretBox: { available: true, seal() { throw new Error(marker); } } });
    try {
      badSeal.settings.load();
      assert.equal((await badSeal.settings.save('bot', inputFixture(), { testFirst: false })).error, 'secret_failed');
    } finally { badSeal.close(); }
    assert.equal(validateSlotInput({ slot: 'bot', ...inputFixture(), oldUiOnly: true }).ok, true);
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const cases = [];
  registerModelParamsTests({ test: (name, run) => cases.push([name, run]), assert: nodeAssert });
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`ok ${name}`); }
    catch (error) { failed += 1; console.error(`not ok ${name}`, error); }
  }
  console.log(`model-params: ${cases.length - failed} passed / ${failed} failed`);
  if (failed) process.exitCode = 1;
}
