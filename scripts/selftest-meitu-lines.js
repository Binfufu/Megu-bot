/**
 * 美图固定句库的判据(2026-10-23 / 被拦降档配套)。
 *
 * 跑法:
 *
 *     node scripts\selftest-meitu-lines.js
 *
 * 不联网、不写仓库文件(覆盖文件用 %TEMP%)。钉:
 *   ① 默认表健全:每条 key = 非空字符串数组;**blocked 系变体数**(blocked_apology ≥4、
 *      blocked_empty ≥2)与口径(每条都说出「被拦/被留下」这件事);
 *   ② pickLine 返回**成员**(rng 注入钉首/尾;默认表每个 key 都抽得到);
 *   ③ 未知 key / 空数组 = **抛 TypeError**(程序员错误,要大声);
 *   ④ loadMeituLines:缺失=默认且无 error;覆盖按 key 合并(数组/单串都认);
 *      坏 JSON=默认+error;坏 key 只忽略那一个;**永不抛**;DEFAULT_LINES 不被写脏。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LINES, MEITU_LINES_PATH, loadMeituLines, pickLine } from '../src/meitu-lines.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

async function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-meitu-lines-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ① 默认表健全
// ---------------------------------------------------------------------------

test('meitu-lines:默认表每条 key 都是非空字符串数组,blocked_apology ≥4 条、blocked_empty ≥2 条', () => {
  for (const [key, variants] of Object.entries(DEFAULT_LINES)) {
    assert.ok(Array.isArray(variants) && variants.length > 0, `${key} 要是非空数组`);
    for (const variant of variants) {
      assert.equal(typeof variant, 'string');
      assert.ok(variant.trim().length > 0, `${key} 里有空白变体`);
    }
  }
  assert.ok(DEFAULT_LINES.blocked_apology.length >= 4, `委屈道歉要 ≥4 条变体,现在 ${DEFAULT_LINES.blocked_apology.length}`);
  assert.ok(DEFAULT_LINES.blocked_empty.length >= 2, `降档落空道歉要 ≥2 条变体,现在 ${DEFAULT_LINES.blocked_empty.length}`);
});

test('meitu-lines:blocked 系口径 —— apology 说明被拦，empty 说明未能发送；角色措辞由本地内容决定', () => {
  for (const variant of DEFAULT_LINES.blocked_apology) {
    assert.ok(/拦|留下|过审/u.test(variant), `「${variant}」没讲出被拦这件事`);
  }
  for (const variant of DEFAULT_LINES.blocked_empty) {
    assert.ok(/没能|没有|没发|发不出/u.test(variant), `「${variant}」没讲出一张都没发出去`);
  }
});

test('meitu-lines:旧 MEITU_REPLIES 语义的原句仍在默认表里(群里已认熟,别丢)', () => {
  assert.ok(DEFAULT_LINES.groupDisabled.includes('这个群没有开美图指令'));
  assert.ok(DEFAULT_LINES.cooldown.includes('刚发过，等一会儿再要'));
  assert.ok(DEFAULT_LINES.uploadFailed.includes('图下好了但发不出去'));
  assert.ok(DEFAULT_LINES.internal.includes('（美图指令出错了，看日志）'));
});

// ---------------------------------------------------------------------------
// ② pickLine 返回成员
// ---------------------------------------------------------------------------

test('meitu-lines:pickLine 返回该 key 的成员;rng 钉首/尾', () => {
  for (const [key, variants] of Object.entries(DEFAULT_LINES)) {
    assert.ok(variants.includes(pickLine(key, DEFAULT_LINES)), `${key} 抽到的必须是成员`);
  }
  const table = { key: ['第一句', '第二句', '第三句'] };
  assert.equal(pickLine('key', table, () => 0), '第一句');
  assert.equal(pickLine('key', table, () => 0.99), '第三句', 'rng 打满要夹在最后一格');
});

test('meitu-lines:pickLine 未知 key / 空数组 → 抛 TypeError(程序员错误要大声)', () => {
  assert.throws(() => pickLine('没有这个key', DEFAULT_LINES), TypeError);
  assert.throws(() => pickLine('key', { key: [] }), TypeError);
  assert.throws(() => pickLine('key', undefined), TypeError);
});

// ---------------------------------------------------------------------------
// ③ loadMeituLines
// ---------------------------------------------------------------------------

test('meitu-lines:load 缺失文件 = 纯默认表,不算错', async () => {
  await withTemp(async (dir) => {
    const { lines, error } = loadMeituLines(path.join(dir, 'meitu-lines.json'));
    assert.equal(error, undefined);
    assert.deepEqual(lines, DEFAULT_LINES);
    // 与默认表是拷贝不是引用(合并/调用方改写不许写脏模块级单例)。
    lines.cooldown.push('脏数据');
    assert.equal(DEFAULT_LINES.cooldown.length, 2);
  });
});

test('meitu-lines:load 覆盖按 key 合并 —— 数组与单串都认,坏 key 只忽略它自己', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'meitu-lines.json');
    fs.writeFileSync(file, JSON.stringify({
      cooldown: '只回这一句',
      blocked_apology: ['甲', '乙'],
      bad_key: 42,
      empty_key: [],
      blank_key: ['   '],
    }), 'utf8');
    const defaultsBefore = JSON.parse(JSON.stringify(DEFAULT_LINES));
    const { lines, error } = loadMeituLines(file);
    assert.equal(error, undefined);
    assert.deepEqual(lines.cooldown, ['只回这一句'], '单串要统一成数组');
    assert.deepEqual(lines.blocked_apology, ['甲', '乙'], '数组整个替换该 key(主人有权删默认句)');
    assert.deepEqual(lines.bad_key, undefined, '非字符串/数组形状 = 忽略');
    assert.deepEqual(lines.empty_key, undefined, '空数组 = 忽略');
    assert.deepEqual(lines.blank_key, undefined, '剔完空白 = 忽略');
    assert.deepEqual(lines.groupDisabled, DEFAULT_LINES.groupDisabled, '没覆盖的 key 保持默认');
    // 合并不许写脏默认表。
    assert.deepEqual(DEFAULT_LINES, defaultsBefore);
  });
});

test('meitu-lines:load 坏 JSON / 非 JSON 对象 = 默认表 + error 字段', async () => {
  await withTemp(async (dir) => {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ 不是 JSON', 'utf8');
    const badResult = loadMeituLines(bad);
    assert.ok(badResult.error, '要有 error');
    assert.ok(/JSON/u.test(badResult.error));
    assert.deepEqual(badResult.lines, DEFAULT_LINES);

    const notObject = path.join(dir, 'array.json');
    fs.writeFileSync(notObject, '["一个数组"]', 'utf8');
    const arrResult = loadMeituLines(notObject);
    assert.ok(arrResult.error && /对象/u.test(arrResult.error));
    assert.deepEqual(arrResult.lines, DEFAULT_LINES);
  });
});

test('meitu-lines:load 永不抛 —— 不存在的目录、读不出来、deps 注入都接得住', async () => {
  await withTemp(async (dir) => {
    // 不存在的深层目录 = ENOENT = 纯默认,不算错。
    const missing = loadMeituLines(path.join(dir, 'no', 'such', 'dir', 'lines.json'));
    assert.equal(missing.error, undefined);
    assert.deepEqual(missing.lines, DEFAULT_LINES);

    // 权限类读错误 = 默认 + error。
    const denied = loadMeituLines(path.join(dir, 'x.json'), {
      readFileSync: () => { const err = new Error('EACCES'); err.code = 'EACCES'; throw err; },
    });
    assert.ok(denied.error && denied.lines);

    // deps 注入的 readFileSync 生效(不落盘也能测覆盖)。
    const injected = loadMeituLines('D:\\不存在的路径\\lines.json', {
      readFileSync: () => '{"internal": "注入覆盖"}',
    });
    assert.deepEqual(injected.lines.internal, ['注入覆盖']);
  });
});

test('meitu-lines:MEITU_LINES_PATH = data/meitu-lines.json', () => {
  assert.equal(MEITU_LINES_PATH, 'data/meitu-lines.json');
});

export function registerMeituLinesTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerMeituLinesTests 需要 test');
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
