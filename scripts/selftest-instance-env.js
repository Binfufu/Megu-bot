import fs from 'node:fs';
import path from 'node:path';
import assertStrict from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CONFIG_PARAM_DEFINITIONS } from '../src/config.js';
import {
  INSTANCE_OVERRIDE_PATH,
  InstanceOverrideError,
  applyInstanceOverrides,
  botIdFromEnvFile,
} from '../src/instance-env.js';

// 判据只读仓库自身与注入面：不写临时文件、不起进程、不碰生产 .env。
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LAUNCH_FILE = path.join(ROOT, 'scripts', 'launch.js');
const MANIFEST_FILE = path.join(ROOT, 'scripts', 'zone-manifest.json');
const REAL_OVERRIDE_FILE = path.join(ROOT, INSTANCE_OVERRIDE_PATH);
// 这两个路径只用来让模块取 botId，文件本身不需要存在。
const MEGUMIN_ENV = path.join(ROOT, 'bots', 'megumin', '.env');
const ARIS_ENV = path.join(ROOT, 'bots', 'aris', '.env');
// 确认不存在的路径：验证"缺文件 = 无覆盖"且不创建任何东西。
const MISSING_FILE = path.join(ROOT, 'content', 'local', '.instance-env-selftest-missing.json');

const doc = (bots, schemaVersion = 1) => JSON.stringify({ schemaVersion, bots });

function apply(text, { envFile = MEGUMIN_ENV, env = {}, read } = {}) {
  const lines = [];
  const result = applyInstanceOverrides({
    file: 'fixture-instance.json',
    envFile,
    env,
    read: read ?? (() => text),
    log: (line) => lines.push(line),
  });
  return { result, env, lines };
}

function enoent() {
  const error = new Error('fixture: no such file');
  error.code = 'ENOENT';
  return error;
}

export function registerInstanceEnvTests({ test, assert = assertStrict }) {
  const a = typeof assert.equal === 'function' ? assert : assertStrict;

  test('instance env: 固定路径不是 .env（deploy 硬拒）也不在 bots/ 下', () => {
    a.equal(INSTANCE_OVERRIDE_PATH, 'content/local/instance.json');
    a.equal(INSTANCE_OVERRIDE_PATH.endsWith('.env'), false);
    a.equal(INSTANCE_OVERRIDE_PATH.startsWith('bots/'), false);
  });

  test('instance env: envFile 严格取 /bots/<id>/，认不出就 null（绝不默认 megumin）', () => {
    a.equal(botIdFromEnvFile('bots\\megumin\\.env'), 'megumin');
    a.equal(botIdFromEnvFile('E:/repos/qqbot-main/bots/aris/.env'), 'aris');
    a.equal(botIdFromEnvFile('bots/demo/.env'), 'demo');
    for (const value of [
      '.env', 'bots/.env', 'bots/MEGUMIN/.env', 'bots/megumin/sub/.env',
      'somebots/megumin/.env', 'content/local/instance.json', '', undefined, null,
    ]) {
      a.equal(botIdFromEnvFile(value), null, `不应认出 botId：${String(value)}`);
    }
  });

  test('instance env: 合法文件只应用当前实例分区，另一只 bot 拿不到', () => {
    const megumin = {};
    const written = apply(doc({ megumin: { QQBOT_SELFCARE: '1' } }), { env: megumin });
    a.equal(written.result.reason, 'applied');
    a.equal(written.result.botId, 'megumin');
    a.deepEqual(written.result.applied, ['QQBOT_SELFCARE']);
    a.equal(megumin.QQBOT_SELFCARE, '1');

    // 同一个文件、aris 的 envFile：分区不匹配 → 什么都不写。
    const aris = {};
    const other = apply(doc({ megumin: { QQBOT_SELFCARE: '1' } }), { env: aris, envFile: ARIS_ENV });
    a.equal(other.result.reason, 'no-bot-section');
    a.deepEqual(aris, {});

    // 文件里只有 aris 分区时，惠惠也拿不到。
    const megumin2 = {};
    const arisOnly = apply(doc({ aris: { QQBOT_SELFCARE: '1' } }), { env: megumin2 });
    a.equal(arisOnly.result.reason, 'no-bot-section');
    a.deepEqual(megumin2, {});

    // 两只都在同一个文件里：各取各的，互不串味。
    const both = {};
    const shared = apply(doc({ aris: { QQBOT_SELFCARE: '0' }, megumin: { QQBOT_SELFCARE: '1' } }), { env: both });
    a.deepEqual(shared.result.applied, ['QQBOT_SELFCARE']);
    a.equal(both.QQBOT_SELFCARE, '1');
  });

  test('instance env: envFile 不在 bots/<id>/ 下直接跳过（公开/旧布局行为不变）', () => {
    for (const envFile of [path.join(ROOT, '.env'), 'bots/.env', 'content/local/instance.json', null]) {
      const env = {};
      const { result, lines } = apply(doc({ megumin: { QQBOT_SELFCARE: '1' } }), { env, envFile });
      a.equal(result.botId, null, String(envFile));
      a.equal(result.reason, 'no-bot-id');
      a.deepEqual(env, {});
      a.deepEqual(lines, []);
    }
  });

  test('instance env: 缺文件 = 无覆盖（注入 read 与真实默认 read 两条路）', () => {
    a.equal(fs.existsSync(MISSING_FILE), false);
    const env = {};
    const real = applyInstanceOverrides({ file: MISSING_FILE, envFile: MEGUMIN_ENV, env, log: () => {} });
    a.equal(real.reason, 'missing');
    a.deepEqual(env, {});
    a.equal(fs.existsSync(MISSING_FILE), false, '不得创建缺失的覆盖文件');

    const injected = applyInstanceOverrides({
      file: 'fixture-instance.json', envFile: MEGUMIN_ENV, env: {},
      read: () => { throw enoent(); }, log: () => {},
    });
    a.equal(injected.reason, 'missing');
    a.deepEqual(injected.applied, []);
  });

  test('instance env: 读取失败不是静默跳过（非 ENOENT 要响亮抛错且不带值）', () => {
    a.throws(() => applyInstanceOverrides({
      file: 'fixture-instance.json', envFile: MEGUMIN_ENV, env: {},
      read: () => { const error = new Error('EACCES fixture-secret-value'); error.code = 'EACCES'; throw error; },
      log: () => {},
    }), (error) => error instanceof InstanceOverrideError && !error.message.includes('fixture-secret-value'));
  });

  test('instance env: process.env 已有的键不覆盖（父进程/守护显式环境优先）', () => {
    const env = { QQBOT_SELFCARE: '0' };
    const { result, lines } = apply(doc({ megumin: { QQBOT_SELFCARE: '1' } }), { env });
    a.equal(env.QQBOT_SELFCARE, '0');
    a.deepEqual(result.applied, []);
    a.deepEqual(result.kept, ['QQBOT_SELFCARE']);
    a.equal(result.reason, 'kept');
    a.ok(lines.some((line) => line.includes('QQBOT_SELFCARE')), '保留原值时也要打键名');
  });

  test('instance env: 只接受 runtime 且非敏感参数；deployment/敏感/路径/身份键全拒', () => {
    const allowed = CONFIG_PARAM_DEFINITIONS.filter((def) => def.scope === 'runtime' && def.sensitive !== true);
    const forbidden = CONFIG_PARAM_DEFINITIONS.filter((def) => def.scope !== 'runtime' || def.sensitive === true);
    a.ok(allowed.length > 100, `runtime 参数太少？${allowed.length}`);
    a.ok(forbidden.length > 0, '必须存在 deployment/敏感参数（否则拒绝判据没有反证）');
    for (const id of ['QQ_APP_ID', 'QQ_CLIENT_SECRET', 'QQBOT_LLM_KEY', 'QQBOT_ENV_FILE', 'QQBOT_STATE_DB', 'QQBOT_ALLOWLIST']) {
      a.ok(forbidden.some((def) => def.id === id), `${id} 必须是 deployment/敏感参数`);
    }

    // 正向：全部 runtime 非敏感参数一次性都能写进去。
    const env = {};
    const all = apply(doc({ megumin: Object.fromEntries(allowed.map((def) => [def.id, '1'])) }), { env });
    a.equal(all.result.applied.length, allowed.length);
    for (const def of allowed) a.equal(env[def.id], '1', def.id);

    // 反向：逐个 forbidden 都必须整份拒绝，且 env 一点都不能被写。
    for (const def of forbidden) {
      const rejected = {};
      a.throws(() => apply(doc({ megumin: { [def.id]: 'fixture-value' } }), { env: rejected }),
        InstanceOverrideError, def.id);
      a.deepEqual(rejected, {}, `${def.id} 拒绝后不得写入任何键`);
    }
  });

  test('instance env: 未知键拒绝且整份 fail closed（不允许部分应用）', () => {
    const env = { FIXTURE_KEEP: '1' };
    a.throws(() => apply(doc({ megumin: { QQBOT_SELFCARE: '1', QQBOT_SYNTHETIC_UNKNOWN: 'fixture-value' } }), { env }),
      (error) => error instanceof InstanceOverrideError
        && error.message.includes('QQBOT_SYNTHETIC_UNKNOWN')
        && !error.message.includes('fixture-value'));
    a.deepEqual(env, { FIXTURE_KEEP: '1' }, '坏文件不得留下半套覆盖');
  });

  test('instance env: 坏 JSON / 坏 schema / 坏值类型全部拒绝（含另一个 bot 分区）', () => {
    const cases = [
      'not json',
      '[]',
      '"x"',
      'null',
      '{"schemaVersion":2,"bots":{}}',
      '{"schemaVersion":"1","bots":{}}',
      '{"schemaVersion":1}',
      '{"schemaVersion":1,"bots":[]}',
      '{"schemaVersion":1,"bots":{},"extra":1}',
      '{"schemaVersion":1,"bots":{"Megumin":{}}}',
      '{"schemaVersion":1,"bots":{"megumin":[]}}',
      '{"schemaVersion":1,"bots":{"megumin":{"QQBOT_SELFCARE":null}}}',
      '{"schemaVersion":1,"bots":{"megumin":{"QQBOT_SELFCARE":["1"]}}}',
      '{"schemaVersion":1,"bots":{"megumin":{"QQBOT_SELFCARE":{"v":"1"}}}}',
      '{"schemaVersion":1,"bots":{"megumin":{"QQBOT_SELFCARE":1e999}}}',
      // 整个文件都要校验：aris 分区写错，惠惠启动也不许放行（fail closed）。
      '{"schemaVersion":1,"bots":{"aris":{"QQBOT_NO_SUCH_KEY":"1"},"megumin":{"QQBOT_SELFCARE":"1"}}}',
    ];
    for (const text of cases) {
      const env = {};
      a.throws(() => apply(text, { env }), InstanceOverrideError, text);
      a.deepEqual(env, {}, text);
    }
  });

  test('instance env: 空分区 = 无覆盖，不报错', () => {
    const env = {};
    const { result } = apply(doc({ megumin: {} }), { env });
    a.equal(result.reason, 'empty');
    a.deepEqual(env, {});
  });

  test('instance env: 值只接受 string/number/boolean，布尔转 1/0、数字转字符串', () => {
    const env = {};
    apply(doc({ megumin: { QQBOT_SELFCARE: true, QQBOT_WARMUP: false, QQBOT_SELFCARE_QUIET_MS: 1234567 } }), { env });
    a.equal(env.QQBOT_SELFCARE, '1');
    a.equal(env.QQBOT_WARMUP, '0');
    a.equal(env.QQBOT_SELFCARE_QUIET_MS, '1234567');
  });

  test('instance env: 日志只打键名与数量，绝不打值', () => {
    const env = {};
    const { lines } = apply(doc({ megumin: { QQBOT_DSH_MODEL: 'fixture-model-value', QQBOT_SELFCARE: true } }), { env });
    a.equal(env.QQBOT_DSH_MODEL, 'fixture-model-value');
    const text = lines.join('\n');
    a.ok(text.includes('已应用 2 项'), text);
    a.ok(text.includes('QQBOT_DSH_MODEL') && text.includes('QQBOT_SELFCARE'), text);
    a.equal(text.includes('fixture-model-value'), false);
    a.equal(text.includes("'1'"), false);
    a.equal(text.includes('=1'), false);
  });

  test('instance env: 私库真实 content/local/instance.json = 惠惠自助进食 + 两实例盯梢库 + 爱丽丝 QQ 推送开关（公开缺文件跳过）', () => {
    if (!fs.existsSync(REAL_OVERRIDE_FILE)) {
      console.log('SKIP instance env: 公开集无 content/local/instance.json（无覆盖即行为不变）');
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(REAL_OVERRIDE_FILE, 'utf8'));
    a.equal(parsed.schemaVersion, 1);
    // 盯梢（2026-11-10）：网站那只（megumin）只读盯梢库显示「异界新闻」；
    // 爱丽丝额外开 QQ 私聊推送 —— 都是可部署的 runtime 覆盖，不动 .env。
    a.deepEqual(parsed.bots.megumin, {
      QQBOT_SELFCARE: '1',
      QQBOT_FEED_DB: 'E:/PersonalDSH/feed-lab/data/feed.db',
    });
    a.deepEqual(parsed.bots.aris, {
      QQBOT_FEED_DB: 'E:/PersonalDSH/feed-lab/data/feed.db',
      QQBOT_FEED_QQ: '1',
    });

    const env = {};
    // 走真实默认 read（不注入），证明真实文件也能被应用。
    const real = applyInstanceOverrides({
      file: REAL_OVERRIDE_FILE, envFile: MEGUMIN_ENV, env, log: () => {},
    });
    a.equal(real.reason, 'applied');
    a.deepEqual(real.applied, ['QQBOT_SELFCARE', 'QQBOT_FEED_DB']);
    a.equal(env.QQBOT_SELFCARE, '1');
    a.equal(env.QQBOT_FEED_DB, 'E:/PersonalDSH/feed-lab/data/feed.db');
    a.equal(Object.hasOwn(env, 'QQBOT_FEED_QQ'), false, '惠惠不投递盯梢私聊（那是爱丽丝的活）');

    const arisEnv = {};
    applyInstanceOverrides({ file: REAL_OVERRIDE_FILE, envFile: ARIS_ENV, env: arisEnv, log: () => {} });
    a.deepEqual(arisEnv, {
      QQBOT_FEED_DB: 'E:/PersonalDSH/feed-lab/data/feed.db',
      QQBOT_FEED_QQ: '1',
    }, '爱丽丝只拿到盯梢库与推送开关，不共享惠惠的开关');
  });

  test('instance env: zone-manifest 把覆盖文件登记为 C 区私有内容', () => {
    if (!fs.existsSync(MANIFEST_FILE)) {
      console.log('SKIP instance env: 无 scripts/zone-manifest.json');
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    const entry = manifest.overrides.find((item) => item.path === INSTANCE_OVERRIDE_PATH);
    a.ok(entry, `zone-manifest overrides 必须登记 ${INSTANCE_OVERRIDE_PATH}`);
    a.equal(entry.zone, 'C');
    a.equal(entry.contentDebt, false);
    a.equal(entry.noPublish, true);
  });

  test('instance env: launch.js 接线顺序 = 确认 envFile 存在之后、prepareBotHome/index 导入之前', () => {
    const source = fs.readFileSync(LAUNCH_FILE, 'utf8');
    const importAt = source.indexOf("await import('../src/instance-env.js')");
    const callAt = source.indexOf('applyInstanceOverrides({');
    const existsAt = source.indexOf('fs.existsSync(envFile)');
    const botHomeAt = source.indexOf("await import('../src/bot-home.js')");
    const indexAt = source.indexOf("await import('../src/index.js')");

    a.ok(importAt >= 0, 'launch.js 必须动态 import ../src/instance-env.js');
    a.ok(callAt > importAt, '先 import 再调用');
    a.ok(existsAt >= 0 && callAt > existsAt, '覆盖必须在“确认 envFile 存在”之后');
    a.ok(botHomeAt > callAt, '覆盖必须在 prepareBotHome 之前（home 也要看到 process.env）');
    a.ok(indexAt > callAt, '覆盖必须在 ../src/index.js 导入之前（loadConfig 读那一刻的 process.env）');

    // 路径固定：ROOT_DIR + 模块常量，不来自环境变量。
    a.ok(source.includes('path.join(ROOT_DIR, INSTANCE_OVERRIDE_PATH)'), '覆盖文件路径必须是固定的常量拼接');
    a.equal(/QQBOT_INSTANCE/i.test(source), false, '覆盖路径不许由环境变量改写');

    // 不是 readEnvFile/loadEnvFile 绕过：launch 自己不该真正加载 .env（注释里提到不算）。
    a.equal(/loadEnvFile\s*\(|readEnvFile\s*\(/.test(source), false, 'launch.js 不得自己加载 .env 来伪装覆盖');

    const call = source.slice(callAt, source.indexOf('});', callAt) + 3);
    a.ok(call.includes('envFile'), '调用必须把 envFile 传进去（用它认实例）');
    a.ok(call.includes('process.env'), '调用必须写 process.env');
    a.ok(call.includes('log:'), '调用必须接日志');
    a.ok(call.includes('instanceOverrideFile'), '调用必须用固定的绝对路径常量');

    const moduleSource = fs.readFileSync(path.join(ROOT, 'src', 'instance-env.js'), 'utf8');
    a.ok(moduleSource.includes('实例覆盖：已应用 ${applied.length} 项'), '成功时必须打“已应用 N 项（键名…）”');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let passed = 0;
  let failed = 0;
  registerInstanceEnvTests({
    test(name, run) {
      try {
        run();
        passed += 1;
        console.log(`PASS ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${name}`, error);
      }
    },
  });
  console.log(`instance env: ${passed} passed / ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
