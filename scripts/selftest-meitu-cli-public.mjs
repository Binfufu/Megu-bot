#!/usr/bin/env node
/**
 * 公开 fetch-one 定向判据：裁剪真实源码闭包，在独立 Node 进程跑参数错误和 --dry。
 * node scripts/selftest-meitu-cli-public.mjs
 *
 * 仅复制本 CLI 所需的 8 个源码文件；不复制仓库 package、.env、data、resources、
 * 内容 C、网页或历史。临时 package.json 只声明 ESM。--import 的临时 fixture 无条件
 * 替换 globalThis.fetch，只回合成 JSON，不保留/调用原 fetch，不添加源 CLI 测试后门。
 * 临时根默认位于仓库父目录（本机 E 盘），可用 QQBOT_MEITU_CLI_TEST_TMP 指定已有目录；
 * Windows 拒绝 C 盘。子进程只继承必要系统变量，不继承代理/QQBOT/NODE_OPTIONS。
 * 不覆盖实际下载、图片字节校验、图库写入、真实图源/代理/模型或真 QQ。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'scripts/meitu-fetch-one.mjs';
const EXPECTED_CLOSURE = [
  ENTRY,
  'src/meitu-alias.js',
  'src/meitu-cursor.js',
  'src/meitu-fetch-core.js',
  'src/meitu-gallery.js',
  'src/meitu-index.js',
  'src/meitu-search.js',
  'src/meitu-store.js',
].sort();
const tempBase = fs.realpathSync(path.resolve(process.env.QQBOT_MEITU_CLI_TEST_TMP || path.join(ROOT, '..')));
if (process.platform === 'win32') {
  assert.notEqual(path.parse(tempBase).root.toLowerCase(), 'c:\\', '临时裁剪根不得写 C 盘');
}
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'qqbot-meitu-cli-public-'));
const exported = path.join(tempRoot, 'public');
const runtime = path.join(tempRoot, 'fixture-runtime');
fs.mkdirSync(exported);
fs.mkdirSync(runtime);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// 只跟随源码中实际的静态 import/export；未知新增依赖必须显式复核，不能带入整棵 src。
function copyClosure(relative, visited = new Set()) {
  if (visited.has(relative)) return visited;
  assert.ok(EXPECTED_CLOSURE.includes(relative), `闭包出现未经审核的源码:${relative}`);
  visited.add(relative);
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  // JSDoc 的 import('node:sqlite') 是类型说明，不是运行期动态依赖。
  // 只剥 JSDoc 块，动态 import 的拒绝断言仍检查余下源码，不放行实际动态依赖。
  const source = bytes.toString('utf8').replace(/^\uFEFF/u, '').replace(/\/\*\*[\s\S]*?\*\//gu, '');
  const dest = path.join(exported, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  sourceHashes[relative] = sha256(bytes);
  const imports = /(?:^|\n)\s*(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:\*|\{[\s\S]*?\})\s+from\s+)['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(imports)) {
    const specifier = match[1];
    if (specifier.startsWith('node:')) continue;
    assert.ok(specifier.startsWith('.'), `非内置依赖不得隐式混入:${specifier}`);
    const dependency = path.relative(ROOT, path.resolve(ROOT, path.dirname(relative), specifier)).replaceAll('\\', '/');
    copyClosure(dependency, visited);
  }
  assert.ok(!/\bimport\s*\(/u.test(source), `动态 import 需要另行复核:${relative}`);
  return visited;
}

function snapshot(dir) {
  const result = {};
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(dir, absolute).replaceAll('\\', '/');
      assert.equal(entry.isSymbolicLink(), false, `临时根不应含链接:${relative}`);
      if (entry.isDirectory()) {
        result[`${relative}/`] = 'directory';
        visit(absolute);
      } else {
        result[relative] = sha256(fs.readFileSync(absolute));
      }
    }
  }
  visit(dir);
  return result;
}

// 这个模块只存在于临时根；图片 URL 是 .invalid，任何下载调用都会被拒绝并记账。
const FIXTURE_SOURCE = `
import fs from 'node:fs';
const calls = [];
const trace = process.env.MEITU_PUBLIC_FIXTURE_TRACE;
process.on('exit', () => fs.writeFileSync(trace, JSON.stringify(calls)));
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  calls.push(url.href);
  const dan = url.origin === 'https://danbooru.donmai.us' && url.pathname === '/posts.json';
  const safe = url.origin === 'https://safebooru.org' && url.pathname === '/index.php'
    && url.searchParams.get('page') === 'dapi' && url.searchParams.get('s') === 'post'
    && url.searchParams.get('q') === 'index' && url.searchParams.get('json') === '1';
  if (!dan && !safe) throw new Error('offline fixture forbids non-search/download URL');
  const tags = (url.searchParams.get('tags') || '').split(/\\s+/u);
  const char = tags[0];
  if (!['demo_a', 'demo_unknown_8246'].includes(char)) throw new Error('unexpected synthetic character');
  const rating = dan ? (tags.includes('rating:general') ? 'g' : 's')
    : (tags.includes('rating:questionable') ? 'questionable' : 'safe');
  const posts = char === 'demo_unknown_8246' ? [] : [701, 702].map((id, i) => ({
    id, rating, tag_string: 'demo_a landscape blue solo', tags: 'demo_a landscape blue solo',
    file_url: 'https://synthetic.invalid/' + id + '.jpg', file_ext: 'jpg',
    md5: i ? '900150983cd24fb0d6963f7d28e17f72' : '5d41402abc4b2a76b9719d911017c592',
    hash: i ? '900150983cd24fb0d6963f7d28e17f72' : '5d41402abc4b2a76b9719d911017c592',
    score: i ? 10 : 20, image_width: 640, image_height: 800, width: 640, height: 800,
  }));
  return { ok: true, status: 200, text: async () => JSON.stringify(posts) };
};
`;
const fixture = path.join(runtime, 'offline-fetch.mjs');
fs.writeFileSync(fixture, FIXTURE_SOURCE);
const baselineEnv = {};
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'LANG', 'LC_ALL']) {
  if (process.env[key] !== undefined) baselineEnv[key] = process.env[key];
}
Object.assign(baselineEnv, { TEMP: runtime, TMP: runtime, TMPDIR: runtime });
let sequence = 0;
let childRuns = 0;
let fetchCalls = 0;
function runNode(args) {
  const trace = path.join(runtime, `trace-${sequence += 1}.json`);
  const before = snapshot(exported);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(fixture).href, ...args], {
    cwd: exported,
    env: { ...baselineEnv, MEITU_PUBLIC_FIXTURE_TRACE: trace },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  // 调用方协议是 stdout 末行 JSON；当前 CLI 更严格为唯一一行，日志不得混到 stdout。
  const lines = child.stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1, `stdout 不得混入日志:${child.stdout}`);
  const json = JSON.parse(lines.at(-1));
  assert.deepEqual(snapshot(exported), before, '参数错误/--dry 不得修改源码根、图库、索引、游标或 SQLite');
  const calls = JSON.parse(fs.readFileSync(trace, 'utf8'));
  childRuns += 1;
  fetchCalls += calls.length;
  return { json, calls, stderr: child.stderr };
}
const runCli = (...args) => runNode([ENTRY, ...args]);
function assertDry(result, source, rating) {
  assert.equal(result.json.ok, true);
  assert.equal(result.json.dry, true);
  assert.deepEqual(result.json.files, []);
  assert.deepEqual(result.json.candidates.map((post) => post.id), [701, 702]);
  assert.ok(result.json.candidates.every((post) => post.source === source && post.rating === rating));
  assert.ok(result.json.candidates.every((post) => post.url.startsWith('https://synthetic.invalid/')));
  assert.equal(result.calls.length, 1, '两张合成候选应满足默认 count=1 的两倍检索预算');
  assert.equal(result.json.rungs.length, 1);
}

test('裁剪闭包逐字节复制，仅 8 个真实源码 + 合成 ESM 声明，无私有/网页/历史目录', () => {
  const copied = [...copyClosure(ENTRY)].sort();
  assert.deepEqual(copied, EXPECTED_CLOSURE);
  fs.writeFileSync(path.join(exported, 'package.json'), '{"type":"module"}\n');
  const tree = snapshot(exported);
  assert.deepEqual(Object.keys(tree).filter((name) => !name.endsWith('/')).sort(), [...EXPECTED_CLOSURE, 'package.json'].sort());
  for (const relative of copied) assert.equal(tree[relative], sourceHashes[relative]);
  for (const forbidden of ['.env', 'data', 'resources', 'content', 'C', 'history', 'src/panel.js', '.git']) {
    assert.equal(fs.existsSync(path.join(exported, forbidden)), false, forbidden);
  }
});

test('缺 C 与运行期表时真实公开 alias 默认空表，未知名称不借用真实别名', () => {
  const probe = runNode(['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const { DEFAULT_ALIASES, loadMeituAliases, resolveCharacterTag } = await import(new URL('./src/meitu-alias.js', import.meta.url));
    const loaded = loadMeituAliases('./absent-alias.json');
    assert.deepEqual(DEFAULT_ALIASES, {});
    assert.deepEqual(loaded, { aliases: {} });
    assert.deepEqual(resolveCharacterTag('示例未知', loaded.aliases), { ok: false, reason: 'unregistered' });
    assert.deepEqual(resolveCharacterTag('demo_unknown_8246', loaded.aliases), { ok: true, tag: 'demo_unknown_8246' });
    console.log(JSON.stringify({ ok: true, aliases: loaded.aliases }));
  `]);
  assert.deepEqual(probe.json, { ok: true, aliases: {} });
  assert.deepEqual(probe.calls, []);
});

test('真实 CLI 缺 --char：末行 no_character JSON、退出 0、零 fetch', () => {
  const result = runCli('--dry');
  assert.deepEqual(result.json, { ok: false, reason: 'no_character', detail: '缺少 --char', rungs: [] });
  assert.deepEqual(result.calls, []);
});

test('真实 CLI 下载模式缺 --out：download_failed JSON、退出 0、零 fetch', () => {
  const result = runCli('--char', 'demo_a');
  assert.deepEqual(result.json, { ok: false, reason: 'download_failed', detail: '缺少 --out', rungs: [] });
  assert.deepEqual(result.calls, []);
});

test('真实 --dry 默认 auto 无代理：仅 Safebooru、seitu questionable、默认 count 不变', () => {
  const result = runCli('--char', 'demo_a', '--dry');
  assertDry(result, 'safebooru', 'questionable');
  const url = new URL(result.calls[0]);
  assert.equal(url.origin, 'https://safebooru.org');
  assert.equal(url.searchParams.get('tags'), 'demo_a rating:questionable sort:score');
  assert.equal(url.searchParams.get('pid'), '0');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.match(result.stderr, /count=1 source=auto tier=seitu dry=yes .*proxyReady=no/u);
});

test('真实 --dry 显式 Danbooru 无代理仍查，归一化 sensitive，页号从 1 起', () => {
  const result = runCli('--char', 'demo_a', '--source', 'danbooru', '--dry');
  assertDry(result, 'danbooru', 'sensitive');
  const url = new URL(result.calls[0]);
  assert.equal(url.origin, 'https://danbooru.donmai.us');
  assert.equal(url.searchParams.get('tags'), 'demo_a rating:questionable');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.match(result.stderr, /proxyReady=no/u);
});

test('真实 --dry meitu + general override：保留首修饰、剔除 rating 查询、Safebooru safe', () => {
  const result = runCli('--char', 'demo_a', '--source', 'safebooru', '--tier', 'meitu',
    '--tags', 'landscape,blue', '--rating-allow', 'general', '--pages', '1', '--dry');
  assertDry(result, 'safebooru', 'safe');
  assert.equal(new URL(result.calls[0]).searchParams.get('tags'), 'demo_a landscape sort:score');
  assert.deepEqual(result.json.rungs[0].ratingAllow, ['safe']);
});

test('真实 --dry 未注册合成英文 tag 原样查询，无结果 JSON，不依赖真实 alias', () => {
  const result = runCli('--char', 'demo_unknown_8246', '--dry');
  assert.equal(result.json.ok, false);
  assert.equal(result.json.reason, 'no_result');
  assert.equal(result.json.rungs.length, 2);
  assert.equal(result.calls.length, 2);
  for (const call of result.calls) {
    const url = new URL(call);
    assert.equal(url.origin, 'https://safebooru.org');
    assert.equal(url.searchParams.get('tags').split(' ')[0], 'demo_unknown_8246');
  }
});

test('真实 --dry 带不存在 --out/--db/--group：可检索，不创建图库或数据库', () => {
  const out = path.join(exported, 'demo-gallery-absent');
  const db = path.join(exported, 'demo-gallery-absent.db');
  const result = runCli('--char', 'demo_a', '--out', out, '--db', db, '--group', 'demo_group', '--dry');
  assertDry(result, 'safebooru', 'questionable');
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(db), false);
  assert.equal(fs.existsSync(`${db}-wal`), false);
  assert.equal(fs.existsSync(`${db}-shm`), false);
});

test('真实 --dry 已有合成目录：重建索引只读，历史 md5 过滤，无图片/索引/游标写入', () => {
  const out = path.join(exported, 'demo-gallery-existing');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'demo_fixture.jpg'), 'hello');
  const result = runCli('--char', 'demo_a', '--out', out, '--dry');
  assert.equal(result.json.ok, true);
  assert.equal(result.json.dry, true);
  assert.deepEqual(result.json.files, []);
  assert.deepEqual(result.json.candidates.map((post) => post.id), [702]);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(fs.readdirSync(out), ['demo_fixture.jpg']);
  assert.equal(fs.readFileSync(path.join(out, 'demo_fixture.jpg'), 'utf8'), 'hello');
});

test('真实 CLI 非法 source/tier/count/pages/max-bytes 仍走原回退策略，不改默认', () => {
  const result = runCli('--char', 'demo_a', '--source', 'demo-invalid', '--tier', 'demo-invalid',
    '--count', '0', '--pages', '0', '--max-bytes', '0', '--dry');
  assertDry(result, 'safebooru', 'questionable');
  assert.match(result.stderr, /--source 只能是 auto \/ danbooru \/ safebooru/u);
  assert.match(result.stderr, /--tier 只能是 meitu \/ seitu/u);
  assert.match(result.stderr, /count=1 source=auto tier=seitu/u);
});

let passed = 0;
try {
  console.log(`temporary root: ${tempRoot}`);
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }
  console.log(`${passed}/${cases.length} passed; child processes=${childRuns}; synthetic fetch calls=${fetchCalls}; real network=0; actual downloads=NOT COVERED`);
  console.log(`source sha256: ${JSON.stringify(sourceHashes)}`);
} finally {
  // mkdtemp 的实际绝对路径必须仍是指定父目录下本次前缀，才能删除。
  assert.equal(path.dirname(tempRoot), tempBase);
  assert.ok(path.basename(tempRoot).startsWith('qqbot-meitu-cli-public-'));
  assert.equal(fs.realpathSync(tempRoot), tempRoot);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
