import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile, CONFIG_PARAM_DEFINITIONS, DEFAULT_GROUP_KEYWORDS } from '../src/config.js';
import { CONFIG_DERIVED_DEFAULTS, CONFIG_KNOWN_ENV } from '../src/config-params.js';
import { resolveParams } from '../src/params.js';

// Same-volume synthetic files only. Never inspect the checkout's .env or any DB.
const TEMP_PARENT = fileURLToPath(new URL('../../', import.meta.url));
function isolated(run, env = {}) {
  const saved = { ...process.env };
  const rootDir = fs.mkdtempSync(path.join(TEMP_PARENT, '.params-config-test-'));
  const clear = () => {
    for (const name of Object.keys(process.env)) {
      if (/^(?:QQBOT_|QQ_APP_ID$|QQ_CLIENT_SECRET$|QQ_API_BASE$)/.test(name)) delete process.env[name];
    }
  };
  try {
    clear();
    Object.assign(process.env, { QQ_APP_ID: 'fixture-app', QQ_CLIENT_SECRET: 'fixture-secret', ...env });
    return run(rootDir);
  } finally {
    clear();
    for (const [name, value] of Object.entries(saved)) {
      if (/^(?:QQBOT_|QQ_APP_ID$|QQ_CLIENT_SECRET$|QQ_API_BASE$)/.test(name)) process.env[name] = value;
    }
    // Check the absolute target before removing the directory created above.
    if (path.dirname(rootDir) !== path.resolve(TEMP_PARENT)
      || !path.basename(rootDir).startsWith('.params-config-test-')) throw new Error('unsafe test cleanup');
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

const read = (id, input) => resolveParams(CONFIG_PARAM_DEFINITIONS, { env: { [id]: input } }).values[id];

export function registerConfigParamsTests({ test, assert }) {
  test('config params: complete typed catalogue and defaults are registered without secrets', () => {
    assert.equal(CONFIG_PARAM_DEFINITIONS.length, 215); // Original 214 + explicit opt-in JSON path.
    assert.equal(new Set(CONFIG_PARAM_DEFINITIONS.map((def) => def.id)).size, 215);
    assert.equal(CONFIG_PARAM_DEFINITIONS.some((def) => def.type === 'custom'), false);
    const typeCounts = {};
    for (const def of CONFIG_PARAM_DEFINITIONS) typeCounts[def.type] = (typeCounts[def.type] ?? 0) + 1;
    assert.deepEqual(typeCounts, { int: 83, boolean: 45, number: 10, string: 28, url: 6, path: 14, enum: 11, object: 4, array: 14 });
    const defaults = resolveParams(CONFIG_PARAM_DEFINITIONS);
    assert.deepEqual(defaults.inputs, {});
    assert.equal(defaults.values.QQBOT_MOOD_TTL_MS, 600000);
    assert.equal(defaults.values.QQBOT_POKE_REPLY_CHANCE, 1);
    assert.deepEqual(defaults.values.QQBOT_GROUP_KEYWORDS, DEFAULT_GROUP_KEYWORDS);
    assert.ok(CONFIG_DERIVED_DEFAULTS.QQBOT_MEITU_DB.includes('explicit QQBOT_STATE_DB'));
    assert.ok(CONFIG_DERIVED_DEFAULTS.QQBOT_MEMORY_DB.includes('QQBOT_MOOD_THEME'));
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.sensitive)) assert.equal(def.scope, 'deployment');
  });

  test('config params: every integer accepts its boundary and refuses truncation/overflow', () => {
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.type === 'int')) {
      assert.equal(read(def.id, String(def.min ?? 1)), def.min ?? 1, def.id);
      for (const invalid of ['1tail', '1.5', '9007199254740992', '-1']) {
        assert.throws(() => read(def.id, invalid), /PARAM_/, `${def.id}: invalid int`);
      }
      if (def.max !== undefined) {
        assert.equal(read(def.id, String(def.max)), def.max, def.id);
        assert.throws(() => read(def.id, String(def.max + 1)), /PARAM_/, `${def.id}: max`);
      }
    }
  });

  test('config params: unit conversion safety and explicit debounce/slot bounds cannot disappear', () => {
    const converted = {
      QQBOT_RECHECK_MINUTES: 60000, QQBOT_SEARCH_TIMEOUT_SECONDS: 1000,
      QQBOT_NARRATION_COOLDOWN_SECONDS: 1000, QQBOT_NARRATION_TIMEOUT_SECONDS: 1000,
      QQBOT_EXPLOSION_COOLDOWN_SECONDS: 1000, QQBOT_MEMORY_ARCHIVE_MINUTES: 60000,
      QQBOT_MEMORY_CONSOLIDATE_MINUTES: 60000, QQBOT_MEMORY_NOTE_TTL_DAYS: 86400000,
      QQBOT_MEMORY_CONSOLIDATE_WINDOW_DAYS: 86400000, QQBOT_MEMORY_BLOCKS_HOURS: 3600000,
      QQBOT_MEMORY_BLOCKS_TIMEOUT_SECONDS: 1000, QQBOT_MEMORY_INSIGHTS_EVERY_HOURS: 3600000,
      QQBOT_MEMORY_INSIGHTS_TIMEOUT_SECONDS: 1000, QQBOT_MEMORY_SUMMARY_TIMEOUT_SECONDS: 1000,
      QQBOT_MEMORY_SUMMARY_MIN_INTERVAL_MINUTES: 60000,
    };
    for (const [id, multiplier] of Object.entries(converted)) {
      const max = Math.floor(Number.MAX_SAFE_INTEGER / multiplier);
      assert.equal(CONFIG_PARAM_DEFINITIONS.find((def) => def.id === id).max, max, id);
      assert.equal(read(id, String(max)), max);
      assert.throws(() => read(id, String(max + 1)), /PARAM_/, id);
    }
    assert.equal(read('QQBOT_C2C_DEBOUNCE_MS', '30000'), 30000);
    assert.throws(() => read('QQBOT_C2C_DEBOUNCE_MS', '30001'), /PARAM_/);
    assert.equal(read('QQBOT_WARMUP_SLOT_MS', '300000'), 300000);
    assert.equal(read('QQBOT_WARMUP_SLOT_MS', '43200000'), 43200000);
    assert.throws(() => read('QQBOT_WARMUP_SLOT_MS', '299999'), /PARAM_/);
    assert.throws(() => read('QQBOT_WARMUP_SLOT_MS', '43200001'), /PARAM_/);
  });

  test('config params: boolean spelling is fail-closed for all ordinary switches', () => {
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.type === 'boolean' && entry.id !== 'QQBOT_MEITU_PER_GROUP')) {
      for (const value of ['1', 'TRUE', 'yes', 'on']) assert.equal(read(def.id, value), true, def.id);
      for (const value of ['0', 'FALSE', 'no', 'off']) assert.equal(read(def.id, value), false, def.id);
      for (const value of ['tru', ' false ', ' ', '2']) assert.throws(() => read(def.id, value), /PARAM_/, def.id);
    }
  });

  test('config params: number formats preserve ratio and LLM compatibility, not coercive object inputs', () => {
    assert.equal(read('QQBOT_LLM_MAX_TOKENS', '256000.0'), 256000);
    assert.equal(read('QQBOT_LLM_DREAM_MAX_TOKENS', '1e3'), 1000);
    assert.equal(read('QQBOT_WARMUP_CHANCE', ' '), 0);
    assert.equal(read('QQBOT_WARMUP_CHANCE', '0x0'), 0);
    assert.equal(read('QQBOT_WARMUP_CHANCE', '1e-1'), 0.1);
    for (const invalid of ['01', '+1', '1e3', ' 1 ', '1.0']) assert.throws(() => read('QQBOT_OWN_INPUT_TOKEN_LIMIT', invalid), /PARAM_/);
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => ['number', 'int'].includes(entry.type))) {
      for (const invalid of [true, null, [], {}]) assert.throws(() => read(def.id, invalid), /PARAM_/, def.id);
    }
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.type === 'number')) {
      assert.throws(() => read(def.id, 'Infinity'), /PARAM_/, def.id);
      assert.throws(() => read(def.id, 'NaN'), /PARAM_/, def.id);
    }
    const ratios = ['QQBOT_WARMUP_CHANCE', 'QQBOT_WARMUP_MIN_CHANCE', 'QQBOT_SELFCARE_LIFE_CHANCE',
      'QQBOT_MOOD_KAOMOJI_CHANCE', 'QQBOT_SPOKEN_EMOJI_CHANCE', 'QQBOT_POKE_REPLY_CHANCE',
      'QQBOT_FACE_REPLY_CHANCE', 'QQBOT_MEMORY_ENTITY_BOOST'];
    for (const id of ratios) {
      const def = CONFIG_PARAM_DEFINITIONS.find((entry) => entry.id === id);
      assert.equal(def.min, 0, `${id}: registered lower bound`);
      assert.equal(def.max, 1, `${id}: registered upper bound`);
      assert.equal(read(id, '0.5'), 0.5, id);
      for (const invalid of ['1.01', '-0.01']) assert.throws(() => read(id, invalid), /PARAM_/, id);
    }
    assert.equal(read('QQBOT_SEARCH_PER_CALL_CNY', '0.0054'), 0.0054);
    assert.throws(() => read('QQBOT_SEARCH_PER_CALL_CNY', '0'), /PARAM_/);
    assert.equal(read('QQBOT_INTERACTION_WINDOW_MULTIPLIER', '0'), 2);
    assert.equal(read('QQBOT_INTERACTION_WINDOW_MULTIPLIER', '-2'), -2);
  });

  test('config params: enums, URL, profile, arrays and jitter have green/red contracts', () => {
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.type === 'enum')) {
      assert.equal(read(def.id, def.values[0]), def.values[0], def.id);
      for (const invalid of [true, [], {}]) assert.throws(() => read(def.id, invalid), /PARAM_/, def.id);
      if (def.id !== 'QQBOT_SELFCARE_LIFE_TO') assert.throws(() => read(def.id, 'unregistered-value'), /PARAM_/, def.id);
    }
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.type === 'url')) {
      assert.equal(read(def.id, 'https://example.invalid/v1'), 'https://example.invalid/v1');
      for (const invalid of ['not-a-url', 'file:///secret', 'https://user:secret@example.invalid', true]) assert.throws(() => read(def.id, invalid), /PARAM_/, def.id);
    }
    assert.equal(read('QQBOT_DSH_PROFILE', 'fixture-1.ok'), 'fixture-1.ok');
    assert.throws(() => read('QQBOT_DSH_PROFILE', 'bad profile'), /PARAM_/);
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.type === 'array' && entry.id !== 'QQBOT_WARMUP_MEAL_HOURS')) {
      assert.deepEqual(read(def.id, ' a, b, '), ['a', 'b']);
      for (const invalid of [true, {}, [true], [{}]]) assert.throws(() => read(def.id, invalid), /PARAM_/, def.id);
    }
    assert.deepEqual(read('QQBOT_KEYWORD_JITTER_MS', '3-5'), { minMs: 3, maxMs: 5 });
    assert.deepEqual(read('QQBOT_REPLY_JITTER_MS', 'off'), { minMs: 0, maxMs: 0 });
    for (const invalid of ['5-3', 'secret-invalid', '9007199254740992', true, {}]) {
      assert.throws(() => read('QQBOT_REPLY_JITTER_MS', invalid), /PARAM_/);
    }
  });

  test('config params: model-slot validators reject bad explicit connection env before startup', () => isolated((rootDir) => {
    for (const prefix of ['QQBOT_LLM_', 'QQBOT_LLM_DREAM_']) {
      const examples = [
        ['KEY', 'fixture-valid-key', ['abc', 'bad key', 'x'.repeat(513)]],
        ['MODEL', 'provider/model-v1', ['bad model', 'x'.repeat(121), 'bad\u0001model']],
        ['BASEURL', 'https://example.invalid/v1', ['http://public.invalid/v1', 'https://metadata.google.internal', 'https://example.invalid/v1?key=fixture']],
      ];
      for (const [suffix, valid, invalid] of examples) {
        const id = `${prefix}${suffix}`;
        process.env[id] = valid;
        assert.doesNotThrow(() => loadConfig({ rootDir }), id);
        for (const bad of invalid) {
          process.env[id] = bad;
          assert.throws(() => loadConfig({ rootDir }), (error) => /^PARAM_/.test(error.message) && !error.message.includes(bad), id);
        }
        process.env[id] = '';
        assert.doesNotThrow(() => loadConfig({ rootDir }), `${id}: unset`);
        delete process.env[id];
      }
    }
    process.env.QQBOT_LLM_BASEURL = 'http://127.0.0.1:8765/v1';
    process.env.QQBOT_SEARCH_KEY = 'abc'; // Search is not a model slot; no model key-length policy.
    assert.doesNotThrow(() => loadConfig({ rootDir }));
  }));

  test('config params: path validation and injected-data accessors are fail-closed', () => isolated((rootDir) => {
    for (const def of CONFIG_PARAM_DEFINITIONS.filter((entry) => entry.type === 'path')) {
      assert.equal(read(def.id, 'relative/fixture'), 'relative/fixture');
      for (const invalid of ['bad\u0000path', true, [], {}]) assert.throws(() => read(def.id, invalid), /PARAM_/, def.id);
    }
    let invoked = false;
    const params = Object.defineProperty({}, 'QQBOT_MOOD_TTL_MS', { enumerable: true, get() { invoked = true; return 123; } });
    assert.throws(() => loadConfig({ rootDir, params }), /PARAM_UNSAFE/);
    assert.equal(invoked, false);
    assert.throws(() => loadConfig({ rootDir, params: null }), /PARAM_/);
    assert.throws(() => loadConfig({ rootDir, packParams: null }), /PARAM_/);
  }));

  test('config params: original runtime default shape and paths remain intact', () => isolated((rootDir) => {
    const config = loadConfig({ rootDir });
    assert.deepEqual(Object.keys(config), ['lockFile', 'legacyStateFile', 'qq', 'dsh', 'engine', 'meitu', 'policy', 'logLevel', 'logFile', 'envFile', 'loadedEnvFile']);
    assert.equal(config.loadedEnvFile, false);
    assert.equal(config.policy.stats.dbFile, path.join(rootDir, '.qqbot.db'));
    assert.equal(config.meitu.db, path.join(rootDir, 'data', 'meitu.db'));
    assert.equal(config.policy.memory.dbFile, path.join(rootDir, 'data', 'megumin', 'memory.db'));
    assert.deepEqual(config.engine.requestOptions, {});
    assert.equal(config.engine.inputTokenLimit, null);
    assert.equal(config.policy.announce.trigger, 'confirm');
    assert.equal(config.policy.group.ignoreBots, true);
    assert.equal(config.policy.tools.searchPerCallCny, 0.0054);
    for (const key of ['paramSources', 'paramWarnings', 'paramRegistry']) assert.equal(Object.getOwnPropertyDescriptor(config, key).enumerable, false);
    assert.equal(JSON.stringify(config).includes('paramSources'), false);
    assert.equal(config.paramSources.QQBOT_BODY_THEME.source, 'default');
    assert.ok(config.paramSources.QQBOT_BODY_THEME.derivedDefault.includes('QQBOT_MOOD_THEME'));
    assert.equal(fs.existsSync(path.join(rootDir, 'data')), false);
  }));

  test('config params: process > dotenv > params > pack > defaults with value-free sources', () => isolated((rootDir) => {
    fs.writeFileSync(path.join(rootDir, '.env'), 'QQBOT_MOOD_TTL_MS=333\nQQBOT_STYLE_NUDGES=2\n');
    process.env.QQBOT_MOOD_TTL_MS = '444';
    const config = loadConfig({ rootDir, params: { QQBOT_MOOD_TTL_MS: 222 }, packParams: { QQBOT_MOOD_TTL_MS: 111, QQBOT_SPOKEN_MAX_CHARS: 72 } });
    assert.equal(config.policy.mood.ttlMs, 444);
    assert.equal(config.policy.spoken.maxChars, 72);
    assert.equal(config.policy.style.nudgeCount, 2);
    assert.deepEqual(config.paramSources.QQBOT_MOOD_TTL_MS.chain.map((entry) => entry.source), ['default', 'content-pack', 'config-file', 'env-file', 'env']);
    assert.equal(config.paramSources.QQBOT_STYLE_NUDGES.source, 'env-file');
    assert.equal(config.paramSources.QQBOT_SPOKEN_MAX_CHARS.source, 'content-pack');
    const diagnostics = JSON.stringify([config.paramSources, config.paramRegistry, config.paramWarnings]);
    assert.equal(diagnostics.includes('fixture-secret'), false);
    assert.equal(diagnostics.includes(rootDir), false);
    assert.equal(diagnostics.includes('"value"'), false);
  }));

  test('config params: Node dotenv empty-process masking and prior preload provenance', () => isolated((rootDir) => {
    const file = path.join(rootDir, '.env');
    fs.writeFileSync(file, 'QQBOT_MOOD_TTL_MS=111\nQQBOT_STYLE_NUDGES=4\nQQBOT_LEGACY_STATE_FILE=\n');
    process.env.QQBOT_MOOD_TTL_MS = '';
    assert.equal(loadEnvFile(file), true);
    const first = loadConfig({ rootDir });
    assert.equal(first.policy.mood.ttlMs, 600000); // Existing empty process key blocks dotenv.
    assert.equal(first.policy.style.nudgeCount, 4);
    assert.equal(first.paramSources.QQBOT_STYLE_NUDGES.source, 'env-file');
    assert.equal(first.legacyStateFile, null);
    assert.equal(first.paramSources.QQBOT_LEGACY_STATE_FILE.source, 'env-file');
    assert.equal(loadConfig({ rootDir }).paramSources.QQBOT_STYLE_NUDGES.source, 'env-file');
    process.env.QQBOT_STYLE_NUDGES = '5';
    const changed = loadConfig({ rootDir });
    assert.equal(changed.policy.style.nudgeCount, 5);
    assert.equal(changed.paramSources.QQBOT_STYLE_NUDGES.source, 'env');
  }));

  test('config params: legacy allowlist, fallback credentials and explicit derived paths survive', () => isolated((rootDir) => {
    Object.assign(process.env, {
      QQBOT_ALLOWLIST: ' old-a,old-b ', QQBOT_LLM_DREAM_KEY: 'fixture-dream',
      QQBOT_LLM_DREAM_MODEL: 'dream-model', QQBOT_LLM_DREAM_MAX_TOKENS: '256000.0',
      QQBOT_STATE_DB: 'data/demo/state.db', QQBOT_MOOD_THEME: 'demo', QQBOT_BODY_THEME: '',
      QQBOT_MORNING_C2C: 'fixture-person', QQBOT_LEGACY_STATE_FILE: '',
    });
    const config = loadConfig({ rootDir });
    assert.deepEqual([...config.policy.access.ids], ['old-a', 'old-b']);
    assert.equal(config.engine.llm.apiKey, 'fixture-dream');
    assert.equal(config.engine.llm.model, 'dream-model');
    assert.deepEqual(config.engine.requestOptions, { maxTokens: 256000 });
    assert.equal(config.meitu.db, path.join(rootDir, 'data', 'demo', 'meitu.db'));
    assert.equal(config.policy.memory.dbFile, path.join(rootDir, 'data', 'demo', 'memory.db'));
    assert.equal(config.policy.selfcare.c2cTarget, 'fixture-person');
    assert.equal(config.legacyStateFile, null);
    for (const [id, upstream] of [
      ['QQBOT_BODY_THEME', 'QQBOT_MOOD_THEME'], ['QQBOT_MEMORY_DB', 'QQBOT_MOOD_THEME'],
      ['QQBOT_MEITU_DB', 'QQBOT_STATE_DB'], ['QQBOT_LLM_KEY', 'QQBOT_LLM_DREAM_KEY'],
      ['QQBOT_LLM_MODEL', 'QQBOT_LLM_DREAM_MODEL'], ['QQBOT_LLM_MAX_TOKENS', 'QQBOT_LLM_DREAM_MAX_TOKENS'],
      ['QQBOT_SELFCARE_C2C', 'QQBOT_MORNING_C2C'], ['QQBOT_IDS', 'QQBOT_ALLOWLIST'],
    ]) {
      assert.equal(config.paramSources[id].source, 'env', id);
      assert.equal(config.paramSources[id].derivedFrom, upstream, id);
      assert.equal(config.paramSources[id].chain.at(-1).source, 'derived', id);
    }
    process.env.QQBOT_ACCESS_MODE = 'blocklist'; process.env.QQBOT_IDS = '';
    const modern = loadConfig({ rootDir });
    assert.equal(modern.policy.access.ids, null);
    assert.equal(modern.paramSources.QQBOT_IDS.derivedFrom, undefined);
    process.env.QQBOT_LLM_KEY = 'fixture-explicit';
    process.env.QQBOT_MEMORY_DB = 'explicit-memory.db';
    const explicit = loadConfig({ rootDir });
    assert.equal(explicit.paramSources.QQBOT_LLM_KEY.derivedFrom, undefined);
    assert.equal(explicit.paramSources.QQBOT_MEMORY_DB.derivedFrom, undefined);
  }));

  test('config params: special empty strings and MEITU literal-zero behavior do not drift', () => isolated((rootDir) => {
    for (const value of ['false', 'off', ' 0 ', '1', '']) {
      process.env.QQBOT_MEITU_PER_GROUP = value;
      assert.equal(loadConfig({ rootDir }).meitu.perGroup, true, value);
    }
    process.env.QQBOT_MEITU_PER_GROUP = '0';
    assert.equal(loadConfig({ rootDir }).meitu.perGroup, false);
    process.env.QQBOT_GROUP_KEYWORDS = '';
    assert.deepEqual(loadConfig({ rootDir }).policy.group.keywords, DEFAULT_GROUP_KEYWORDS);
    process.env.QQBOT_GROUP_KEYWORDS = ' ';
    assert.deepEqual(loadConfig({ rootDir }).policy.group.keywords, []);
    process.env.QQBOT_REPLY_JITTER_MS = '';
    assert.deepEqual(loadConfig({ rootDir }).policy.replyJitterMs, { minMs: 2000, maxMs: 6000 });
    process.env.QQBOT_REPLY_JITTER_MS = ' ';
    assert.deepEqual(loadConfig({ rootDir }).policy.replyJitterMs, { minMs: 0, maxMs: 0 });
    process.env.QQBOT_WARMUP_MEAL_HOURS = ' ';
    assert.deepEqual(loadConfig({ rootDir }).policy.warmup.mealWindows, []);
  }));

  test('config params: explicit JSON is opt-in and unknown/scope/lower-layer errors are red', () => isolated((rootDir) => {
    fs.writeFileSync(path.join(rootDir, 'params.json'), '{"QQBOT_MOOD_TTL_MS":222}');
    assert.equal(loadConfig({ rootDir }).policy.mood.ttlMs, 600000);
    process.env.QQBOT_PARAMS_FILE = 'params.json';
    assert.equal(loadConfig({ rootDir }).policy.mood.ttlMs, 222);
    assert.equal(loadConfig({ rootDir, params: { QQBOT_MOOD_TTL_MS: 333 } }).policy.mood.ttlMs, 333);
    assert.throws(() => loadConfig({ rootDir, params: { QQBOT_PARAM_TYPO: 1 } }), /PARAM_UNKNOWN/);
    assert.throws(() => loadConfig({ rootDir, packParams: { QQBOT_PARAM_TYPO: 1 } }), /PARAM_UNKNOWN/);
    for (const id of ['QQ_APP_ID', 'QQ_CLIENT_SECRET', 'QQBOT_STATE_DB', 'QQBOT_ACCOUNTS_OPEN']) {
      assert.throws(() => loadConfig({ rootDir, params: { [id]: 'fixture' } }), /PARAM_SCOPE/);
    }
    process.env.QQBOT_MOOD_TTL_MS = '444';
    assert.throws(() => loadConfig({ rootDir, params: { QQBOT_MOOD_TTL_MS: 'bad' } }), /PARAM_/);
    assert.throws(() => loadConfig({ rootDir, packParams: { QQBOT_MOOD_TTL_MS: 'bad' } }), /PARAM_/);
    fs.writeFileSync(path.join(rootDir, '.env'), 'QQBOT_MOOD_TTL_MS=bad\n');
    assert.throws(() => loadConfig({ rootDir }), /PARAM_/); // Valid process env cannot hide bad dotenv.
    fs.writeFileSync(path.join(rootDir, '.env'), '');
    for (const invalid of ['not json', '[]', 'null', '{"QQBOT_MOOD_TTL_MS":"bad"}']) {
      fs.writeFileSync(path.join(rootDir, 'params.json'), invalid);
      assert.throws(() => loadConfig({ rootDir }), /PARAM_|配置数据读取失败/);
    }
  }));

  test('config params: cross-theme and error diagnostics redact old raw parser messages', () => isolated((rootDir) => {
    process.env.QQBOT_MOOD_THEME = 'demo'; process.env.QQBOT_BODY_THEME = 'megumin';
    assert.throws(() => loadConfig({ rootDir }), /QQBOT_BODY_THEME.*QQBOT_MOOD_THEME/);
    delete process.env.QQBOT_BODY_THEME;
    const marker = `fixture-secret-${rootDir}`;
    for (const id of ['QQBOT_REPLY_JITTER_MS', 'QQBOT_MOOD_TTL_MS', 'QQBOT_PANEL_TOKEN']) {
      if (id === 'QQBOT_PANEL_TOKEN') continue;
      process.env[id] = marker;
      assert.throws(() => loadConfig({ rootDir }), (error) => !error.message.includes(marker) && !error.message.includes(rootDir) && !error.cause);
      delete process.env[id];
    }
    process.env.QQBOT_PARAMS_FILE = path.join(rootDir, 'missing.json');
    assert.throws(() => loadConfig({ rootDir }), (error) => !error.message.includes(rootDir) && !error.message.includes('ENOENT'));
  }));

  test('config params: other-module env names are known, truly unknown names only warn', () => isolated((rootDir) => {
    for (const name of CONFIG_KNOWN_ENV) process.env[name] = 'fixture';
    const clean = loadConfig({ rootDir });
    assert.deepEqual(clean.paramWarnings, []);
    process.env.QQBOT_UNREGISTERED_FIXTURE = 'fixture-secret';
    const warned = loadConfig({ rootDir });
    assert.equal(warned.paramWarnings.length, 1);
    assert.equal(warned.paramWarnings[0].source, 'env');
    assert.equal(JSON.stringify(warned.paramWarnings).includes('QQBOT_UNREGISTERED_FIXTURE'), false);
    assert.equal(JSON.stringify(warned.paramWarnings).includes('fixture-secret'), false);
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assert = await import('node:assert/strict');
  let passed = 0;
  let failed = 0;
  registerConfigParamsTests({ assert: assert.default, test(name, run) {
    try { run(); passed += 1; console.log(`ok ${name}`); }
    catch (error) { failed += 1; console.error(`not ok ${name}`); console.error(error); }
  } });
  console.log(`config params: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
