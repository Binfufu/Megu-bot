/**
 * 角色别名 + 作品判据的判据(2026-10-23 / 代码层发图)。
 *
 * 跑法:
 *
 *     node scripts\selftest-meitu-alias.js
 *
 * 钉:
 *   ① 标准写法「作品名的角色名」精确命中;
 *   ② 空格不敏感 / 省略「的」/ 括号换位都等价(作品判据的三条等价写法);
 *   ③ 基础名不会被带作品的 key 吞掉;同一张表里精确优先于宽松;
 *   ④ 英文 tag 形状直接写(要求含下划线,普通词不认);
 *   ⑤ load:缺失用默认表(不算错)/ 坏 JSON 回默认并带 error / 空对象 = 主人清空;
 *   ⑥ 默认表包含「合成作品甲的合成名甲」非空合成项(无真实角色/运行表依赖);
 *   ⑦ JSONC 备注(D319):`//` 与块注释可读、字符串里的 `//` 不算注释、剥完仍坏照样回退。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEMP_PARENT = fileURLToPath(new URL('../../', import.meta.url));
const SYNTHETIC_DEFAULTS = {
  '合成作品甲的合成名甲': 'fixture_name_a_(fixture_work_a)',
  合成角色甲: 'fixture_character_a', 合成角色乙: 'fixture_character_b', 合成角色丙: 'fixture_character_c',
};
// Load the real module against an isolated, present, nonempty synthetic local C.
// This proves the default-content read, without depending on private names or an empty fallback.
const moduleRoot = fs.mkdtempSync(path.join(TEMP_PARENT, 'qqbot-alias-default-fixture-'));
let aliasModule;
try {
  fs.mkdirSync(path.join(moduleRoot, 'src'));
  fs.mkdirSync(path.join(moduleRoot, 'content', 'local'), { recursive: true });
  fs.copyFileSync(new URL('../src/meitu-alias.js', import.meta.url), path.join(moduleRoot, 'src', 'meitu-alias.js'));
  fs.writeFileSync(path.join(moduleRoot, 'content', 'local', 'meitu-alias-defaults.json'), JSON.stringify(SYNTHETIC_DEFAULTS));
  aliasModule = await import(pathToFileURL(path.join(moduleRoot, 'src', 'meitu-alias.js')));
} finally {
  assert.equal(path.dirname(moduleRoot), path.resolve(TEMP_PARENT));
  fs.rmSync(moduleRoot, { recursive: true, force: true });
}
const { DEFAULT_ALIASES, loadMeituAliases, resolveCharacterTag, stripJsonComments } = aliasModule;

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const QUALIFIED = { '合成作品甲的合成名甲': 'fixture_name_a_(fixture_work_a)' };

test('meitu-alias:标准写法「作品名的角色名」精确命中', () => {
  assert.deepEqual(resolveCharacterTag('合成作品甲的合成名甲', QUALIFIED), { ok: true, tag: 'fixture_name_a_(fixture_work_a)' });
});

test('meitu-alias:空格不敏感(「合成作品甲 的 合成名甲」「合成作品甲 合成名甲」)', () => {
  for (const name of ['合成作品甲 的 合成名甲', '合成作品甲 合成名甲', ' 合成作品甲的合成名甲 ', '合成作品甲的合成名甲\n']) {
    assert.deepEqual(resolveCharacterTag(name, QUALIFIED), { ok: true, tag: 'fixture_name_a_(fixture_work_a)' }, name);
  }
});

test('meitu-alias:省略「的」与括号换位等价', () => {
  for (const name of ['合成作品甲合成名甲', '合成名甲(合成作品甲)', '合成名甲（合成作品甲）', '合成名甲 ( 合成作品甲 )']) {
    assert.deepEqual(resolveCharacterTag(name, QUALIFIED), { ok: true, tag: 'fixture_name_a_(fixture_work_a)' }, name);
  }
});

test('meitu-alias:基础名不会被带作品的 key 吞掉(合成名甲 → 未登记)', () => {
  assert.deepEqual(resolveCharacterTag('合成名甲', QUALIFIED), { ok: false, reason: 'unregistered' });
});

test('meitu-alias:同表同时有基础名与作品名 —— 各自精确命中', () => {
  const both = { 合成名甲: 'fixture_name_base', '合成作品甲的合成名甲': 'fixture_name_a_(fixture_work_a)' };
  assert.deepEqual(resolveCharacterTag('合成名甲', both), { ok: true, tag: 'fixture_name_base' });
  assert.deepEqual(resolveCharacterTag('合成作品甲的合成名甲', both), { ok: true, tag: 'fixture_name_a_(fixture_work_a)' });
  assert.deepEqual(resolveCharacterTag('合成名甲(合成作品甲)', both), { ok: true, tag: 'fixture_name_a_(fixture_work_a)' });
});

test('meitu-alias:英文 tag 形状直接写(要求含下划线)', () => {
  assert.deepEqual(resolveCharacterTag('fixture_character_a', {}), { ok: true, tag: 'fixture_character_a' });
  assert.deepEqual(resolveCharacterTag('hello', {}), { ok: false, reason: 'unregistered' });
  assert.deepEqual(resolveCharacterTag('fixture character', {}), { ok: false, reason: 'unregistered' });
});

test('meitu-alias:默认表包含「合成作品甲的合成名甲」与三条合成项', () => {
  assert.equal(DEFAULT_ALIASES['合成作品甲的合成名甲'], 'fixture_name_a_(fixture_work_a)');
  for (const key of ['合成角色甲', '合成角色乙', '合成角色丙']) assert.ok(DEFAULT_ALIASES[key], key);
});

// load:用注入的 readFileSync,不碰真盘。
test('meitu-alias:load —— 文件缺失用默认表,不算错', () => {
  const missing = () => {
    const err = new Error('nope');
    err.code = 'ENOENT';
    throw err;
  };
  const { aliases, error } = loadMeituAliases('x', { readFileSync: missing });
  assert.equal(error, undefined);
  assert.deepEqual(aliases, DEFAULT_ALIASES);
});

test('meitu-alias:load —— 坏 JSON 用默认表并带 error', () => {
  const { aliases, error } = loadMeituAliases('x', { readFileSync: () => '{bad' });
  assert.ok(error && String(error).length > 0);
  assert.deepEqual(aliases, DEFAULT_ALIASES);
});

test('meitu-alias:load —— 空对象 = 主人清空,尊重它(不回退默认)', () => {
  const { aliases, error } = loadMeituAliases('x', { readFileSync: () => '{}' });
  assert.equal(error, undefined);
  assert.deepEqual(aliases, {});
});

test('meitu-alias:load —— 正常表原样读入,坏行被忽略', () => {
  const { aliases, error } = loadMeituAliases('x', { readFileSync: () => '{"a":"b","c":3,"d":"  "}' });
  assert.equal(error, undefined);
  assert.deepEqual(aliases, { a: 'b' });
});

// ===== JSONC 备注(D319,2026-10-24):主人按作品/体型分区要写注释 =====
test('meitu-alias:JSONC —— 行注释(独占行/行尾)与块注释都能剥,键值不受影响', () => {
  const text = [
    '{',
    '  // ===== 分区:合成作品丁 =====',
    '  "合成角色甲": "fixture_character_a", // 行尾备注',
    '  /* 块注释',
    '     跨行,里面有 {"假的": "值"} */',
    '  "合成角色乙": "fixture_character_b"',
    '}',
  ].join('\n');
  const { aliases, error } = loadMeituAliases('x', { readFileSync: () => text });
  assert.equal(error, undefined);
  assert.deepEqual(aliases, { 合成角色甲: 'fixture_character_a', 合成角色乙: 'fixture_character_b' });
});

test('meitu-alias:JSONC —— 字符串里的 // 与 /* 不许被当成注释', () => {
  const text = '{"a":"http://example.com/x//y","b":"/* 不是注释 */","c":"say \\"//hi\\""}';
  const { aliases, error } = loadMeituAliases('x', { readFileSync: () => text });
  assert.equal(error, undefined);
  assert.deepEqual(aliases, {
    a: 'http://example.com/x//y',
    b: '/* 不是注释 */',
    c: 'say "//hi"',
  });
});

test('meitu-alias:JSONC —— 剥完注释仍然坏(尾逗号)照样回退默认表并带 error', () => {
  const text = '{\n  // 注释合法\n  "a": "b",\n}';
  const { aliases, error } = loadMeituAliases('x', { readFileSync: () => text });
  assert.ok(error && String(error).length > 0, '尾逗号不是 JSONC 能救的,必须回退并报错');
  assert.deepEqual(aliases, DEFAULT_ALIASES);
});

test('meitu-alias:JSONC —— 带 BOM 也能读(Windows 编辑器偶尔会加)', () => {
  const { aliases, error } = loadMeituAliases('x', { readFileSync: () => '\uFEFF{"a":"b"}' });
  assert.equal(error, undefined);
  assert.deepEqual(aliases, { a: 'b' });
});

test('meitu-alias:JSONC —— 剥注释保留换行(坏 JSON 的报错行号不飘)', () => {
  const text = '{\n// 1\n/* 2\n3 */\n"a":\n}';
  const stripped = stripJsonComments(text);
  assert.equal(stripped.split('\n').length, text.split('\n').length);
});

// 合成运行期文件的**守护判据**(2026-10-23 现场):主人手改 `data\meitu-alias.json` 时少写一个
// 逗号 → JSON 整份不合法 → 服务层**静默回退内置 4 条默认表** → 群里表现成「角色没登记」,
// 而上面那些注入用例全绿(它们不碰真盘)。⇒ 文件存在时必须真读一遍:
//   ① 剥掉 JSONC 注释后必须是合法 JSON(这条就是抓"少个逗号";注释本身合法,D319);
//   ② 每一行都要活下来 —— 坏行(值不是非空字符串)会被 load 静默丢掉 = 那个角色默默没登记;
//   ③ 每一行都要能解析回 tag。
// 固定写入合成非空表；不以缺失文件跳过本用例。空表语义由前面的专门用例验证。
test('meitu-alias:运行期别名表存在时必须能解析(少个逗号就整表回退)', () => {
  const dir = fs.mkdtempSync(path.join(TEMP_PARENT, 'qqbot-alias-runtime-fixture-'));
  const file = path.join(dir, 'meitu-alias.json');
  fs.writeFileSync(file, '// 合成运行期 JSONC 表\n' + JSON.stringify(SYNTHETIC_DEFAULTS));
  try {
  let raw;
  try {
    // 注释是允许的(D319):这里跟 loader 走同一份剥注释实现,再验结构。
    raw = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    assert.fail(`别名表剥掉注释后仍不是合法 JSON(手改时多半少了个逗号):${err?.message ?? err}`);
  }
  const { aliases, error } = loadMeituAliases(file);
  assert.equal(error, undefined, `别名表坏了:${error}`);
  const rawKeys = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.keys(raw).map((name) => String(name ?? '').trim()).filter(Boolean)
    : [];
  const dropped = rawKeys.filter((name) => !(name in aliases));
  assert.deepEqual(dropped, [], `这些行被静默丢掉了(值不是非空字符串):${dropped.join('、')}`);
  for (const name of Object.keys(aliases)) {
    const resolved = resolveCharacterTag(name, aliases);
    assert.equal(resolved.ok, true, `${name} 解析不回 tag`);
  }
  } finally {
    assert.equal(path.dirname(dir), path.resolve(TEMP_PARENT));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function registerMeituAliasTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerMeituAliasTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
