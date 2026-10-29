/**
 * A1 定向入口判据：只跑公开子集/临时导出树，不启动真实私库全量。
 * node scripts/selftest-public-entry.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectSelftestRunner } from './selftest.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const fixtureParent = path.resolve(ROOT, '..');
const temp = fs.mkdtempSync(path.join(fixtureParent, 'qqbot-public-entry-'));
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
let passed = 0;
let failed = 0;

function put(relative, text) {
  const target = path.join(temp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}
function copy(relative) {
  const target = path.join(temp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ROOT, relative), target);
}
function run(args = [], extraEnv = {}) {
  const env = { ...process.env };
  delete env.QQBOT_SELFTEST_SKIP;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, ['scripts/selftest.js', ...args], {
    cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 30_000, env,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

try {
  // 夹具只写临时根，不移动/删除真实 private，也不导入它。
  put('package.json', '{"type":"module"}\n');
  copy('scripts/selftest.js');
  put('scripts/selftest-public.js', 'export function runPublicSelftest() { console.log("PUBLIC_STUB"); }\n');
  put('scripts/selftest-private.js', 'console.log("FULL_STUB", JSON.stringify(process.argv.slice(2)), process.env.QQBOT_SELFTEST_SKIP);\n');

  test('完整私库默认与 --full 都选私 runner；原参数与 skip 环境不改', () => {
    for (const args of [[], ['--full', '--out', 'unchanged.log']]) {
      const result = run(args, { QQBOT_SELFTEST_SKIP: 'sentinel' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /FULL_STUB/);
      assert.ok(result.stdout.includes(JSON.stringify(args)));
      assert.match(result.stdout, /sentinel/);
      assert.doesNotMatch(result.stdout, /PUBLIC_STUB/);
    }
  });
  test('--public 明确绕开存在的私 runner', () => {
    const result = run(['--public'], { QQBOT_SELFTEST_SKIP: 'sentinel' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PUBLIC_STUB/);
    assert.doesNotMatch(result.stdout, /FULL_STUB/);
  });
  test('--full 与 --public 冲突为红；--out 值不误识别为模式', () => {
    assert.equal(run(['--full', '--public']).status, 1);
    assert.equal(selectSelftestRunner({ argv: ['--out', '--public'], hasPrivate: true, env: {} }), 'full');
  });
  test('私 runner 依赖损坏不能回退公开', () => {
    put('scripts/selftest-private.js', 'import "./missing-private-dependency.js";\n');
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing-private-dependency/);
    assert.doesNotMatch(result.stdout, /PUBLIC_STUB/);
  });
  test('公开导出缺 private 默认与 --full 均红；只有显式 --public 跑公开', () => {
    const privateFixture = path.resolve(temp, 'scripts/selftest-private.js');
    assert.equal(privateFixture, path.join(temp, 'scripts', 'selftest-private.js'));
    fs.unlinkSync(privateFixture);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /拒绝以公开子集代替全量/);
    assert.doesNotMatch(result.stdout, /PUBLIC_STUB/);
    const explicitPublic = run(['--public']);
    assert.equal(explicitPublic.status, 0, explicitPublic.stderr);
    assert.match(explicitPublic.stdout, /PUBLIC_STUB/);
    const full = run(['--full']);
    assert.equal(full.status, 1);
    assert.match(full.stderr, /selftest-private\.js/);
    assert.doesNotMatch(full.stdout, /PUBLIC_STUB/);
  });
  test('旧 deploy gate 的默认调用缺 private 必红，包括空 skip 值', () => {
    for (const skip of ['', '站长控制台 GUI 探针,站长 GUI 探针']) {
      const result = run([], { QQBOT_SELFTEST_SKIP: skip });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /拒绝以公开子集代替全量/);
      assert.doesNotMatch(result.stdout, /PUBLIC_STUB/);
    }
  });
  test('隔离最小公开树运行真实既有 suite，不带 resources/data/私模块/工具', () => {
    for (const relative of [
      'scripts/selftest-public.js', 'scripts/selftest-meitu-fetch.js', 'scripts/selftest-meitu-lines.js',
      'scripts/selftest-engine-tools.js', 'scripts/selftest-meitu-service.js',
      'scripts/selftest-pack.js',
      'src/meitu-search.js', 'src/meitu-index.js', 'src/meitu-fetch-core.js',
      'src/meitu-cursor.js', 'src/meitu-store.js', 'src/meitu-lines.js', 'src/local-turn-content.js',
      // play（玩法内核/模拟器）及其闭包
      'scripts/selftest-play.js', 'src/play/action.js', 'src/play/fishing.js', 'src/play/index.js',
      'src/play/quest.js', 'src/company.js', 'src/local-infra-content.js',
      // 以下为 engine-tools / meitu-service 两个公开套件的仓内相对 import 闭包（只含 P 区文件）
      'src/action-log.js', 'src/body-rules.js', 'src/body-theme.js', 'src/capabilities.js',
      'src/condition.js', 'src/context-budget.js', 'src/control-markup.js', 'src/dream-cards.js',
      'src/engine.js', 'src/group-context.js', 'src/growth.js', 'src/inject-mark.js', 'src/llm.js',
      'src/local-gameplay-content.js', 'src/local-mood-body-content.js', 'src/log.js',
      'src/meitu-alias.js', 'src/meitu-command.js', 'src/meitu-interpret.js', 'src/meitu-service.js',
      'src/qq.js', 'src/runner-contract.js', 'src/sqlite-store.js', 'src/stat-binding.js',
      'src/stats.js', 'src/tool-loop.js',
      // 源码扫描判据要读这些文件（只作为文本比对，不在夹具里 import）
      'src/index.js', 'src/config.js', 'src/llm-settings.js',
      // 阶段 2：本地内容读取器现在依赖内容包加载器（无 content/packs 目录时走旧回退）
      'src/content-pack.js',
    ]) copy(relative);
    assert.equal(fs.existsSync(path.join(temp, 'resources')), false);
    assert.equal(fs.existsSync(path.join(temp, 'data')), false);
    const result = run(['--public']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PUBLIC SUBSET ONLY/);
    assert.match(result.stdout, /6 suites，\d+ registered cases/);
    assert.match(result.stdout, /\d+ passed, 0 failed/);
  });
  test('公开 --out 以仓库根解析相对路径，skip 单独计数不冒充 passed', () => {
    // 覆盖全部公开套件名称前缀：新增套件也必须让本用例保持"全部跳过"的前提。
    const result = run(['--public', '--out', 'entry-output.log'], { QQBOT_SELFTEST_SKIP: 'meitu-,engine-tools,content-pack' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summary = result.stdout.match(/(\d+) passed, (\d+) failed, (\d+) skipped/);
    assert.ok(summary, result.stdout);
    assert.equal(Number(summary[2]), 0, '被跳过的不许算失败');
    assert.ok(Number(summary[3]) >= 50, `skip 要有单独计数(实际 ${summary[3]})`);
    assert.equal(Number(summary[1]) + Number(summary[3]), 158, 'passed + skipped 必须等于注册总数(skip 不能冒充 passed)');
    const output = fs.readFileSync(path.join(temp, 'entry-output.log'), 'utf8');
    assert.match(output, /PUBLIC SUBSET ONLY/);
    assert.match(output, (/(\d+) passed, (\d+) failed, (\d+) skipped/));
    assert.equal(fs.existsSync(path.join(temp, 'scripts/entry-output.log')), false);
  });
  test('公开断言失败保留 FAIL 计数与非零退出码，不放宽断言', () => {
    const suite = 'scripts/selftest-meitu-lines.js';
    const source = fs.readFileSync(path.join(temp, suite), 'utf8');
    try {
      put(suite, source.replace("DEFAULT_LINES.blocked_apology.length >= 4", "DEFAULT_LINES.blocked_apology.length >= 999999"));
      const result = run(['--public']);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /FAIL/);
      assert.match(result.stdout, /1 failed/);
    } finally { copy(suite); }
  });
  test('缺失公开必需 suite 必红，不能静默跳过', () => {
    const suite = path.resolve(temp, 'scripts/selftest-meitu-lines.js');
    assert.equal(suite, path.join(temp, 'scripts', 'selftest-meitu-lines.js'));
    fs.unlinkSync(suite);
    const result = run(['--public']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /selftest-meitu-lines\.js/);
    assert.doesNotMatch(result.stdout, /passed, 0 failed/);
  });
  test('分流入口自身无私套件静态导入，导入入口也不执行任何 runner', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/selftest.js'), 'utf8');
    const staticSources = [...source.matchAll(/^import[\s\S]*?from\s*['"]([^'"]+)['"];?/gm)].map((match) => match[1]);
    assert.ok(staticSources.length >= 3);
    assert.ok(staticSources.every((specifier) => specifier.startsWith('node:')), staticSources.join(','));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import(new URL('./scripts/selftest.js', import.meta.url)); console.log('ENTRY_IMPORTED');"], {
      cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ENTRY_IMPORTED');
  });

  for (const [name, fn] of cases) {
    try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
    catch (err) { failed += 1; console.error(`  FAIL ${name}\n       ${err.stack ?? err}`); }
  }
} finally {
  // 只删除本次 mkdtemp 返回且回核了前缀的临时夹具根。
  assert.equal(path.dirname(temp), fixtureParent);
  assert.ok(path.basename(temp).startsWith('qqbot-public-entry-'));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log(`${passed} passed, ${failed} failed (A1 entry checks; no real full run)`);
process.exitCode = failed === 0 ? 0 : 1;
