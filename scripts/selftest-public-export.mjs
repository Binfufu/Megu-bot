#!/usr/bin/env node
/**
 * 定向 fixture 自测；只创建父仓同卷临时根和本地 Git，绝不使用 os.tmpdir()/C 盘。
 * node scripts/selftest-public-export.mjs [--temp-root <同卷且非 C 盘的既有父目录>]
 * 不启动 bot、不访问网络、不跑私库全量；所有反例必须真实拒绝且不产生成功 receipt。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildExportPlan, exportPathProblem, exportPlanExitCode } from './export-dry-run.mjs';
import { exportPublic } from './export-public.mjs';
import { listTracked } from './zone-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--temp-root')) throw new Error('仅支持 --temp-root <同卷父目录>');
const parent = path.resolve(argv[1] ?? path.join(workspace, '..'));
const volume = (p) => path.parse(p).root.toLowerCase();
if (volume(parent) !== volume(workspace) || /^c:[\\/]/i.test(parent)) throw new Error('fixture 必须在父仓同卷且不得写 C 盘');
if (!fs.statSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) throw new Error('临时父目录必须是既有非链接目录');
const root = fs.mkdtempSync(path.join(parent, 'public-export-selftest-'));
const resolvedRoot = fs.realpathSync.native(root);
if (volume(resolvedRoot) !== volume(workspace) || /^c:[\\/]/i.test(resolvedRoot)) throw new Error('临时根真实路径越出允许卷');
let passed = 0;
let failed = 0;
console.log(`[public-export] fixture: ${root}`);
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
}
// ⚠️ 2026-10-29 实伤：调用者环境里若带 GIT_DIR/GIT_WORK_TREE，fixture 的 git init 之后
//    所有提交会**写进调用者的真实仓库**（本机把 7 条 fixture 提交落到 main 工作树）。
//    必须剥掉 Git 拓扑类环境变量，fixture 只认 cwd。
const GIT_TOPOLOGY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];
function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of GIT_TOPOLOGY_ENV) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', ...extra };
}
function git(repo, args) {
  const run = spawnSync('git', args, {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    env: gitEnv(),
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const required = ['package.json', 'LICENSE', 'NOTICE', '.env.example', 'CHANGELOG.md', '.gitignore', '.gitattributes', 'README.md'];
const baseManifest = {
  schemaVersion: 1,
  rules: [
    { zone: 'P', match: ['src/**', 'tools/**'] },
    { zone: 'D', match: ['private/**', 'policy.json'] },
    { zone: 'C', match: ['content/**'] },
  ],
  overrides: [
    ...required.map((p) => ({ path: p, zone: 'P' })),
    { path: 'tools/secret-panel.js', zone: 'P', noPublish: true, contentDebt: true },
  ],
};
const baseFiles = {
  'package.json': '{"name":"fixture","private":true}\n',
  LICENSE: 'fixture license\n', NOTICE: 'fixture notice\n',
  '.env.example': 'TEST_ONLY_NOT_A_REAL_CREDENTIAL=PRIVATE_TEST_MARKER_NOT_REAL\r\n',
  'CHANGELOG.md': 'fixture changes\n', '.gitignore': 'ignored/\n', '.gitattributes': '* -text\n',
  'README.md': '\uFEFF# fixture\r\n原字节\r\n',
  'src/a.js': 'export const value = 1;\r\n',
  'src/secret-box.js': '// PRIVATE_TEST_MARKER_NOT_REAL; name allowlist is NOT content approval\n',
  'src/blob.bin': Buffer.from([0, 255, 13, 10, 128, 0]),
  'src/中文.md': '中文路径\n',
  'private/private-note.txt': 'DO_NOT_PUBLISH_PRIVATE_NOTE\n',
  'content/role.txt': 'DO_NOT_PUBLISH_CONTENT\n',
  'tools/secret-panel.js': '// excluded even with contentDebt and sensitive name\n',
};
const expectedPublish = [...required, 'src/a.js', 'src/secret-box.js', 'src/blob.bin', 'src/中文.md'].sort();
const clone = (value) => JSON.parse(JSON.stringify(value));
function writeFiles(repo, files) {
  for (const [rel, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), bytes);
  }
}
function commit(repo) {
  git(repo, ['add', '--all']);
  git(repo, ['-c', 'user.name=Public export fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local fixture']);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}
function fixture(name, { manifest = clone(baseManifest), additions = {}, omit = [] } = {}) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  // 硬防护：fixture 必须是自己的仓库，且不在任何既有工作树内。否则拒绝继续提交。
  assert.equal(fs.existsSync(path.join(repo, '.git')), true, `${name}: fixture 必须自带 .git`);
  const top = fs.realpathSync.native(git(repo, ['rev-parse', '--show-toplevel']).trim());
  assert.equal(top.toLowerCase(), fs.realpathSync.native(repo).toLowerCase(),
    `${name}: fixture 的 Git 顶层必须是自身目录，不能落到调用者仓库`);
  const outer = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true, env: gitEnv() });
  assert.notEqual(outer.status, 0, '临时根必须不在任何 Git 工作树内，否则 fixture 可能污染真实仓库');
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.hooksPath', path.join(root, 'empty-hooks')]);
  git(repo, ['config', 'core.fsmonitor', 'false']);
  const files = { ...baseFiles, ...additions, 'policy.json': `${JSON.stringify(manifest, null, 2)}\n` };
  for (const p of omit) delete files[p];
  writeFiles(repo, files);
  const expectedCommit = commit(repo);
  return { repo, manifest: path.join(repo, 'policy.json'), out: path.join(root, `${name}-out`), expectedCommit };
}
function plan(f) {
  return buildExportPlan({ manifest: JSON.parse(fs.readFileSync(f.manifest, 'utf8')), trackedFiles: listTracked(f.repo) });
}
function expectFailure(f, code, change = {}) {
  assert.throws(() => exportPublic({ ...f, ...change }), (error) => error.code === code, `必须由 ${code} 拒绝，不可被无关异常喂绿`);
  const target = change.out ?? f.out;
  if (code !== 'TARGET_EXISTS') assert.equal(fs.existsSync(target), false, '前置拒绝不得创建目标');
}
function cli(script, args) {
  const result = spawnSync(process.execPath, [path.join(here, script), ...args], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, env: gitEnv(),
  });
  assert.ifError(result.error);
  return result;
}
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  }).sort();
}

try {
  const good = fixture('good');
  test('纯计划精确候选、不修改输入、noPublish 本身绝非硬闸', () => {
    const manifest = clone(baseManifest);
    const trackedFiles = listTracked(good.repo);
    const before = JSON.stringify({ manifest, trackedFiles });
    const p = buildExportPlan({ manifest, trackedFiles });
    assert.equal(JSON.stringify({ manifest, trackedFiles }), before);
    assert.deepEqual(p.publish.slice().sort(), expectedPublish);
    assert.deepEqual(p.debt, []);
    assert.deepEqual(p.safety, []);
    assert.deepEqual(p.missing, []);
    assert.equal(p.excluded.length, 4);
    assert(p.excluded.some((e) => e.path === 'tools/secret-panel.js' && e.reason.startsWith('noPublish')));
    assert.equal(exportPlanExitCode(p, true), 0);
    assert.deepEqual(p, buildExportPlan({ manifest, trackedFiles }));
  });
  test('字面安全白名单严格两条、大小写/目录/后缀马甲不放行', () => {
    const denied = ['.env', '.env.prod', '.ENV.EXAMPLE', 'nested/.env.example', '.env.example.bak',
      'src/Secret-box.js', 'src/secret-box.js.bak', 'nested/src/secret-box.js',
      'credential.txt', 'secrets.txt', 'data/file.json', 'key.pem', 'id_rsa'];
    const p = buildExportPlan({ manifest: { schemaVersion: 1, rules: [{ zone: 'P', match: ['**'] }] },
      trackedFiles: [...required, 'src/secret-box.js', ...denied] });
    // 与合法名同时出现的大小写马甲先由路径碰撞闸拦截，其余必须是 safety。
    assert.deepEqual(p.invalidPaths.map((e) => e.path).sort(), ['.ENV.EXAMPLE', 'src/Secret-box.js']);
    assert.deepEqual([...p.safety, ...p.invalidPaths.map((e) => e.path)].sort(), denied.slice().sort());
    for (const name of denied) assert(!p.publish.includes(name), `马甲不得进 publish: ${name}`);
    for (const name of ['.ENV.EXAMPLE', 'src/Secret-box.js']) {
      const isolated = buildExportPlan({ manifest: { schemaVersion: 1, rules: [{ zone: 'P', match: ['**'] }] }, trackedFiles: [name] });
      assert.deepEqual(isolated.safety, [name], '单独出现仍不是白名单');
    }
    assert(p.publish.includes('.env.example') && p.publish.includes('src/secret-box.js'));
    assert.equal(exportPlanExitCode(p), 1);
    assert.equal(exportPlanExitCode(p, true), 1);
  });
  test('名字白名单不抹 debt，也不冒称内容扫描完成', () => {
    const manifest = clone(baseManifest);
    manifest.overrides.push({ path: 'src/secret-box.js', zone: 'P', contentDebt: true });
    manifest.overrides.find((e) => e.path === '.env.example').contentDebt = true;
    const p = buildExportPlan({ manifest, trackedFiles: listTracked(good.repo) });
    assert.deepEqual(p.debt.slice().sort(), ['.env.example', 'src/secret-box.js']);
    assert.equal(p.safety.length, 0);
    assert.equal(exportPlanExitCode(p), 0);
    assert.equal(exportPlanExitCode(p, true), 1);
  });
  test('真实导出精确集合、BOM/CRLF/二进制不转换、逐文件 bytes/hash 回读', () => {
    const receipt = exportPublic(good);
    assert.deepEqual(walk(good.out), expectedPublish);
    assert.deepEqual(receipt.files.map((e) => e.path).sort(), expectedPublish);
    assert.equal(receipt.sourceCommit, good.expectedCommit);
    assert.equal(receipt.expectedCommit, good.expectedCommit);
    assert.equal(receipt.manifestSha256, hash(fs.readFileSync(good.manifest)));
    assert.equal(receipt.dirty, false);
    assert.equal(receipt.commitTreeExact, false);
    assert.equal(receipt.sourceKind, 'clean-worktree-candidate');
    assert.equal(receipt.contentScanPerformed, false);
    assert.equal(receipt.published, false);
    for (const item of receipt.files) {
      const source = fs.readFileSync(path.join(good.repo, item.path));
      const dest = fs.readFileSync(path.join(good.out, item.path));
      assert(source.equals(dest));
      assert.equal(item.bytes, source.length);
      assert.equal(item.sha256, hash(dest));
    }
    const text = JSON.stringify(receipt);
    for (const privatePath of ['private/private-note.txt', 'content/role.txt', 'tools/secret-panel.js', 'policy.json', good.repo]) assert(!text.includes(privatePath));
    assert(!fs.existsSync(path.join(good.out, '.git')));
    assert(fs.readFileSync(path.join(good.out, '.env.example'), 'utf8').includes('PRIVATE_TEST_MARKER_NOT_REAL'));
  });
  test('--json 完整数组非截断、默认人读首行与退出码兼容', () => {
    const additions = Object.fromEntries(Array.from({ length: 95 }, (_, i) => [`src/many-${i}.js`, `${i}\n`]));
    const f = fixture('json', { additions });
    const args = ['--manifest', f.manifest, '--repo', f.repo];
    const json = cli('export-dry-run.mjs', [...args, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    const p = plan(f);
    for (const key of ['publish', 'debt', 'excluded', 'safety', 'missing', 'unowned', 'invalidPaths']) assert.deepEqual(parsed[key], p[key]);
    assert(parsed.publish.length > 80);
    const human = cli('export-dry-run.mjs', args);
    assert.equal(human.status, 0);
    const summary = JSON.parse(human.stdout.split(/\r?\n/)[0]);
    assert.equal(summary.publish, p.publish.length);
    assert.equal(summary.safetyHits, 0);
    assert(human.stdout.includes('== 将公开 ==') && human.stdout.includes('--verbose'));
  });
  test('debt 红：默认 dry-run 仍 0、strict/真实导出均拒绝', () => {
    const manifest = clone(baseManifest);
    manifest.overrides.push({ path: 'src/a.js', zone: 'P', contentDebt: true });
    const f = fixture('debt', { manifest });
    const args = ['--manifest', f.manifest, '--repo', f.repo];
    assert.equal(cli('export-dry-run.mjs', args).status, 0);
    assert.equal(cli('export-dry-run.mjs', [...args, '--strict']).status, 1);
    assert.equal(cli('export-dry-run.mjs', [...args, '--strict', '--json']).status, 1);
    expectFailure(f, 'PLAN_BLOCKED');
  });
  test('missing required 红：缺 README 与 required noPublish 均真实拒绝', () => {
    const absent = fixture('missing', { omit: ['README.md'] });
    assert.deepEqual(plan(absent).missing, ['README.md']);
    assert.equal(exportPlanExitCode(plan(absent)), 0);
    expectFailure(absent, 'PLAN_BLOCKED');
    const manifest = clone(baseManifest);
    manifest.overrides.find((e) => e.path === 'README.md').noPublish = true;
    const hidden = fixture('hidden-required', { manifest });
    assert.deepEqual(plan(hidden).missing, ['README.md']);
    expectFailure(hidden, 'PLAN_BLOCKED');
  });
  test('safety 红：真实候选敏感名失败，不读/复制它', () => {
    const f = fixture('safety', { additions: { 'src/credential.txt': 'NOT_A_REAL_SECRET\n' } });
    assert.deepEqual(plan(f).safety, ['src/credential.txt']);
    expectFailure(f, 'PLAN_BLOCKED');
    const run = cli('export-dry-run.mjs', ['--manifest', f.manifest, '--repo', f.repo, '--json']);
    assert.equal(run.status, 1);
    assert.deepEqual(JSON.parse(run.stdout).safety, ['src/credential.txt']);
  });
  test('未知归属红：不能靠排除或默认允许把未知文件放行', () => {
    const f = fixture('unowned', { additions: { 'unknown.txt': 'unknown\n' } });
    assert.deepEqual(plan(f).unowned, ['unknown.txt']);
    assert.equal(exportPlanExitCode(plan(f), true), 1);
    expectFailure(f, 'PLAN_BLOCKED');
  });
  test('畸形路径/越界/.git/设备名/大小写冲突都红', () => {
    const bad = ['../escape', 'src/../../escape', '/absolute', 'E:/escape', 'src\\escape',
      'src//file', './file', 'src/./file', '.git/config', 'src/.GIT/config', 'src/file:ads', 'src/NUL.txt', 'src/end.'];
    for (const p of bad) assert(exportPathProblem(p), p);
    const p = buildExportPlan({ manifest: baseManifest, trackedFiles: [...listTracked(good.repo), ...bad, 'SRC/a.js'] });
    assert.equal(p.invalidPaths.length, bad.length + 1);
    assert.equal(exportPlanExitCode(p, true), 1);
  });
  test('已有目标拒绝且保留原文件；仓内目标/另一仓内目标拒绝', () => {
    const f = fixture('targets');
    fs.mkdirSync(f.out);
    fs.writeFileSync(path.join(f.out, 'keep'), 'unchanged');
    expectFailure(f, 'TARGET_EXISTS');
    assert.equal(fs.readFileSync(path.join(f.out, 'keep'), 'utf8'), 'unchanged');
    expectFailure(f, 'TARGET_IN_REPO', { out: path.join(f.repo, 'export') });
    const other = fixture('other');
    expectFailure(f, 'TARGET_IN_REPO', { out: path.join(other.repo, 'export') });
    const bare = path.join(root, 'bare.git');
    fs.mkdirSync(bare); git(bare, ['init', '--bare', '-q']);
    expectFailure(f, 'TARGET_IN_REPO', { out: path.join(bare, 'export') });
  });
  test('commit 必须完整且绑定 HEAD，拒 dirty tracked/staged/untracked', () => {
    const f = fixture('binding');
    expectFailure(f, 'USAGE', { expectedCommit: f.expectedCommit.slice(0, 8) });
    expectFailure(f, 'COMMIT_MISMATCH', { expectedCommit: '0'.repeat(40) });
    fs.writeFileSync(path.join(f.repo, 'src/a.js'), 'changed\n');
    expectFailure(f, 'DIRTY_TREE');
    git(f.repo, ['add', 'src/a.js']);
    expectFailure(f, 'DIRTY_TREE');
    f.expectedCommit = commit(f.repo);
    fs.writeFileSync(path.join(f.repo, 'untracked'), 'untracked');
    expectFailure(f, 'DIRTY_TREE');
  });
  test('assume-unchanged/skip-worktree 隐藏修改也拒绝，不能伪装 dirty=false', () => {
    const f = fixture('hidden-index');
    git(f.repo, ['update-index', '--assume-unchanged', 'src/a.js']);
    fs.writeFileSync(path.join(f.repo, 'src/a.js'), 'hidden change\n');
    assert.equal(git(f.repo, ['status', '--porcelain']), '');
    expectFailure(f, 'INDEX_HIDDEN');
    git(f.repo, ['update-index', '--no-assume-unchanged', 'src/a.js']);
    f.expectedCommit = commit(f.repo);
    git(f.repo, ['update-index', '--skip-worktree', 'src/a.js']);
    fs.writeFileSync(path.join(f.repo, 'src/a.js'), 'hidden again\n');
    assert.equal(git(f.repo, ['status', '--porcelain']), '');
    expectFailure(f, 'INDEX_HIDDEN');
  });
  test('manifest 必须受跟踪且在仓内；缺失实际源文件不能借旧跟踪表导出', () => {
    const f = fixture('manifest-binding');
    expectFailure(f, 'MANIFEST_OUTSIDE', { manifest: path.join(root, 'outside-policy.json') });
    expectFailure(f, 'MANIFEST_UNTRACKED', { manifest: path.join(f.repo, 'not-tracked.json') });
    const movingSource = path.resolve(f.repo, 'README.md');
    const movedTarget = path.resolve(root, 'missing-actual-readme');
    assert.equal(movingSource, path.join(root, 'manifest-binding', 'README.md'));
    assert.equal(movedTarget, path.join(root, 'missing-actual-readme'));
    fs.renameSync(movingSource, movedTarget);
    expectFailure(f, 'DIRTY_TREE');
  });
  test('目标祖先 junction 链接拒绝；链接源目录与硬链接文件拒绝', () => {
    const f = fixture('links');
    const external = path.join(root, 'link-external');
    fs.mkdirSync(external);
    const parentLink = path.join(root, 'parent-link');
    fs.symlinkSync(external, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
    expectFailure(f, 'LINK_OR_SPECIAL', { out: path.join(parentLink, 'candidate') });
    // 用包含完全相同字节的 junction 替换 src，保证不是 dirty 闸门提前挡住。
    const sourceDir = path.join(root, 'source-external');
    const movingSource = path.resolve(f.repo, 'src');
    assert.equal(movingSource, path.join(root, 'links', 'src'));
    assert.equal(path.resolve(sourceDir), path.join(root, 'source-external'));
    fs.renameSync(movingSource, sourceDir);
    fs.symlinkSync(sourceDir, path.join(f.repo, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(git(f.repo, ['status', '--porcelain']), '');
    expectFailure(f, 'LINK_OR_SPECIAL');
    const hard = fixture('hardlink');
    fs.linkSync(path.join(hard.repo, 'src/a.js'), path.join(root, 'hardlink-alias'));
    assert.equal(git(hard.repo, ['status', '--porcelain']), '');
    expectFailure(hard, 'LINK_OR_SPECIAL');
  });
  test('Git symlink mode 即使工作树为普通字节文件也拒绝；不需 Windows symlink 特权', () => {
    const f = fixture('git-link-mode');
    git(f.repo, ['config', 'core.symlinks', 'false']);
    const object = git(f.repo, ['hash-object', '-w', '--stdin']); // 空 symlink blob 不会被导出
    git(f.repo, ['update-index', '--add', '--cacheinfo', `120000,${object.trim()},src/link.js`]);
    fs.writeFileSync(path.join(f.repo, 'src/link.js'), '');
    git(f.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local symlink fixture']);
    f.expectedCommit = git(f.repo, ['rev-parse', 'HEAD']).trim();
    assert.equal(git(f.repo, ['status', '--porcelain']), '');
    expectFailure(f, 'LINK_OR_SPECIAL');
  });
  test('真实 CLI 成功只有 receipt JSON，无额外 receipt 文件/私有路径', () => {
    const f = fixture('cli');
    const run = cli('export-public.mjs', ['--repo', f.repo, '--manifest', f.manifest, '--out', f.out, '--expected-commit', f.expectedCommit]);
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.sourceCommit, f.expectedCommit);
    assert.deepEqual(walk(f.out), expectedPublish);
    assert(!run.stdout.includes('private/private-note.txt') && !run.stdout.includes(f.repo));
    const rejected = cli('export-public.mjs', ['--repo', f.repo, '--manifest', f.manifest, '--out', f.out, '--expected-commit', f.expectedCommit]);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert(rejected.stderr.includes('TARGET_EXISTS'));
  });
} finally {
  // 删除前验证确实是本次独占创建的临时根；不用计算得到的宽路径清理父仓。
  assert.equal(path.dirname(root), parent);
  assert(path.basename(root).startsWith('public-export-selftest-'));
  assert.equal(fs.realpathSync.native(root), resolvedRoot);
  assert.equal(volume(root), volume(workspace));
  console.log(`[public-export] cleanup verified fixture: ${root}`);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`[public-export] ${passed} passed / ${failed} failed`);
process.exitCode = failed ? 1 : 0;
