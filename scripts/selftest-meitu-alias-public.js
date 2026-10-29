/** Offline, synthetic-only alias checks; copy the actual module into a same-volume pruned tree. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const parent = path.dirname(root);
const prefix = path.join(parent, '.meitu-alias-public-');
const temp = fs.mkdtempSync(prefix);
const modulePath = path.join(temp, 'src', 'meitu-alias.js');
const contentPath = path.join(temp, 'content', 'local', 'meitu-alias-defaults.json');
const decoy = path.join(temp, 'unrelated-cwd');
const defaults = { '测试世界的示例甲': 'demo_a_(sample_world)', '示例乙': 'demo_b' };
let passed = 0;

function childChecks() {
  // This function is serialized into a fresh process, never imported against the private tree.
  return `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    let count = 0;
    function check(fn) { fn(); count += 1; }
    const options = OPTIONS;
    if (options.fault) {
      const original = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        if (file instanceof URL && file.href === options.contentURL) {
          const error = new Error('SENSITIVE_CONTENT_SENTINEL E:/private-alias-location');
          error.code = options.fault;
          throw error;
        }
        return original.call(this, file, ...args);
      };
    }
    let api;
    try { api = await import(options.moduleURL); }
    catch (error) {
      if (!options.error) throw error;
      check(() => assert.equal(error.message, options.error));
      check(() => assert.equal(error.cause, undefined));
      check(() => assert.ok(!String(error.stack).includes('SENSITIVE_CONTENT_SENTINEL')));
      check(() => assert.ok(!String(error.stack).includes('private-alias-location')));
      check(() => assert.ok(!String(error.stack).includes(options.contentPath)));
      check(() => assert.ok(!String(error.stack).includes(options.contentURL)));
      console.log(JSON.stringify({ count }));
      process.exit(0);
    }
    assert.ok(!options.error, 'invalid local content must fail module startup');
    const { DEFAULT_ALIASES, loadMeituAliases, stripJsonComments, resolveCharacterTag } = api;
    const expected = options.defaults;
    check(() => assert.deepEqual(DEFAULT_ALIASES, expected));
    const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; };
    const load = (text) => loadMeituAliases('synthetic-runtime', { readFileSync: () => text });
    const absent = loadMeituAliases('synthetic-runtime', { readFileSync: missing });
    check(() => assert.deepEqual(absent, { aliases: expected }));
    check(() => assert.notEqual(absent.aliases, DEFAULT_ALIASES));
    absent.aliases.changed = 'synthetic_changed';
    check(() => assert.deepEqual(DEFAULT_ALIASES, expected));
    const denied = loadMeituAliases('synthetic-runtime', { readFileSync: () => {
      const error = new Error('synthetic-denied'); error.code = 'EACCES'; throw error;
    } });
    check(() => assert.deepEqual(denied.aliases, expected));
    check(() => assert.equal(denied.error, '别名表读不出来: synthetic-denied'));
    for (const text of ['{', '[]', 'null', '42', '"text"', '{"a":"b",}', "{'a':'b'}"]) {
      const loaded = load(text);
      check(() => assert.deepEqual(loaded.aliases, expected));
      check(() => assert.equal(typeof loaded.error, 'string'));
    }
    check(() => assert.deepEqual(load('{}'), { aliases: {} }));
    check(() => assert.deepEqual(load('{"runtime":"runtime_tag"}'), { aliases: { runtime: 'runtime_tag' } }));
    check(() => assert.deepEqual(load('{" keep ":" demo_tag ","bad":5,"blank":" ","": "skip_tag"}'), { aliases: { keep: 'demo_tag' } }));
    const jsonc = '\\uFEFF{ // line\\n"测试世界的示例甲":"demo_a_(sample_world)",/* block\\ncomment */"link":"https://demo.invalid/a//b", "quoted":"a\\\\\\"//b"}';
    check(() => assert.deepEqual(load(jsonc), { aliases: {
      '测试世界的示例甲': 'demo_a_(sample_world)', link: 'https://demo.invalid/a//b', quoted: 'a"//b',
    } }));
    check(() => assert.equal(stripJsonComments('/*a\\nb*/{}').split('\\n').length, 2));
    const aliases = { '测试世界的示例甲': 'demo_a_(sample_world)', '示例甲': 'demo_plain' };
    for (const name of ['测试世界的示例甲', '测试 世界 的 示 例甲', '测试世界示例甲', '测试世界 示例甲', '示例甲(测试世界)', '示例甲（测试世界）', ' 示例甲 （ 测试 世界 ） ']) {
      check(() => assert.deepEqual(resolveCharacterTag(name, aliases), { ok: true, tag: 'demo_a_(sample_world)' }));
    }
    check(() => assert.deepEqual(resolveCharacterTag('示例甲', aliases), { ok: true, tag: 'demo_plain' }));
    const collisions = { '测试世界示例甲': 'demo_loose', '测试世界的示例甲': 'demo_exact' };
    check(() => assert.deepEqual(resolveCharacterTag('测试世界的示例甲', collisions), { ok: true, tag: 'demo_exact' }));
    check(() => assert.deepEqual(resolveCharacterTag('示例甲(测试世界)', { ...aliases, '示例甲(测试世界)': 'demo_exact_paren' }), { ok: true, tag: 'demo_exact_paren' }));
    check(() => assert.deepEqual(resolveCharacterTag('demo_a_(sample_world)', {}), { ok: true, tag: 'demo_a_(sample_world)' }));
    for (const name of ['未知示例', '', 'hello', 'bad-tag', '示例甲']) {
      check(() => assert.deepEqual(resolveCharacterTag(name, {}), { ok: false, reason: 'unregistered' }));
    }
    check(() => assert.deepEqual(resolveCharacterTag('未知示例', aliases), { ok: false, reason: 'unregistered' }));
    console.log(JSON.stringify({ count }));
  `;
}

function run(name, options = {}) {
  const settings = {
    moduleURL: pathToFileURL(modulePath).href,
    contentURL: pathToFileURL(contentPath).href,
    contentPath,
    defaults: {},
    ...options,
  };
  const source = childChecks().replace('OPTIONS', JSON.stringify(settings));
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: decoy, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${name}: child failed\n${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout.trim());
  assert.ok(Number.isSafeInteger(output.count) && output.count > 0);
  passed += output.count;
  console.log(`PASS ${name}: ${output.count} checks`);
}

try {
  assert.equal(path.parse(temp).root.toLowerCase(), path.parse(root).root.toLowerCase());
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, fs.readFileSync(new URL('../src/meitu-alias.js', import.meta.url)));
  fs.mkdirSync(path.join(decoy, 'content', 'local'), { recursive: true });
  fs.writeFileSync(path.join(decoy, 'content', 'local', 'meitu-alias-defaults.json'), '{"诱饵":"decoy_tag"}');
  for (const entry of ['.env', 'data', 'resources', 'content']) assert.equal(fs.existsSync(path.join(temp, entry)), false);
  run('real pruned module without C (different cwd contains decoy C)');

  fs.mkdirSync(path.dirname(contentPath), { recursive: true });
  fs.writeFileSync(contentPath, JSON.stringify(defaults));
  run('synthetic C; runtime defaults and independent matching', { defaults });
  fs.writeFileSync(contentPath, '{}');
  run('explicit empty C', { defaults: {} });

  for (const text of ['{SENSITIVE_CONTENT_SENTINEL', '\uFEFF{}', '//SENSITIVE_CONTENT_SENTINEL\n{}']) {
    fs.writeFileSync(contentPath, text);
    run('bad strict C JSON is loud and sanitized', { error: '默认别名内容不是合法 JSON' });
  }
  for (const value of [null, [], 42, 'SENSITIVE_CONTENT_SENTINEL', { invalid: 42 }, { invalid: '' }, { ' ': 'demo_tag' }]) {
    fs.writeFileSync(contentPath, JSON.stringify(value));
    run('bad C shape is loud and sanitized', { error: '默认别名内容结构无效' });
  }
  for (const fault of ['EACCES', 'EIO', 'EISDIR']) {
    run(`non-ENOENT ${fault} is loud and sanitized`, { fault, error: '默认别名内容读取失败（非缺失错误）' });
  }
  run('injected ENOENT remains normal missing C', { fault: 'ENOENT' });
  console.log(`meitu-alias-public: ${passed} passed / 0 failed; synthetic-only, same-volume pruned fresh processes`);
} finally {
  // Verify the exact absolute generated target before recursive cleanup.
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(parent));
  assert.ok(path.basename(resolved).startsWith(path.basename(prefix)));
  fs.rmSync(resolved, { recursive: true, force: true });
}
