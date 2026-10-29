import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planAliasMerge, parseAliasObject, main } from './meitu-alias-merge.mjs';
const tests = [
  ['保留JSONC注释和旧项', () => {
    const base = '{\n // 合成作品丁\n "合成重名":"fixture_other_name" // 不能覆盖\n}\n';
    const result = planAliasMerge(base, '{"合成作品丙的合成重名":"fixture_shared_(fixture_work_c)"}');
    assert.equal(result.conflicts.length, 0);
    assert.ok(result.text.includes('// 合成作品丁'));
    assert.ok(result.text.includes('// 不能覆盖'));
    assert.equal(parseAliasObject(result.text)['合成重名'], 'fixture_other_name');
    assert.equal(parseAliasObject(result.text)['合成作品丙的合成重名'], 'fixture_shared_(fixture_work_c)');
  }],
  ['BOM和尾注释保留', () => {
    const result = planAliasMerge('\uFEFF{ /* 空表 */ } // 尾部\n', '{"合成名庚":"fixture_name_g_(fixture_work_c)"}');
    assert.equal(parseAliasObject(result.text)['合成名庚'], 'fixture_name_g_(fixture_work_c)');
    assert.ok(result.text.startsWith('\uFEFF'));
    assert.ok(result.text.endsWith('// 尾部\n'));
  }],
  ['宽松同名冲突不产出', () => {
    const result = planAliasMerge('{"合成作品丙的合成重名":"fixture_shared_(fixture_work_c)"}', '{"合成重名（合成作品丙）":"wrong_tag"}');
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.text, null);
  }],
  ['重复执行字节幂等', () => {
    const result = planAliasMerge('{"合成名庚":"fixture_name_g_(fixture_work_c)"}', '{"合成名庚":"fixture_name_g_(fixture_work_c)"}');
    assert.equal(result.added.length, 0);
    assert.equal(result.text, '{"合成名庚":"fixture_name_g_(fixture_work_c)"}');
  }],
  ['CLI新文件输出、拒绝覆盖与冲突零写', () => {
    const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'alias-merge-'));
    try {
    const base = path.join(root, 'base.json');
    const additions = path.join(root, 'add.json');
    const out = path.join(root, 'out.json');
    fs.writeFileSync(base, '{"合成重名":"fixture_old_name"}');
    fs.writeFileSync(additions, '{"合成重名":"fixture_shared_(fixture_work_c)"}');
    const args = ['--base', base, '--additions', additions, '--out', out];
    assert.equal(main(args), 2);
    assert.equal(fs.existsSync(out), false);
    fs.writeFileSync(additions, '{"合成作品丙的合成重名":"fixture_shared_(fixture_work_c)"}');
    assert.equal(main(args), 0);
    const bytes = fs.readFileSync(out, 'utf8');
    assert.throws(() => main(args), /不覆盖/);
    assert.equal(fs.readFileSync(out, 'utf8'), bytes);
    assert.equal(fs.readFileSync(base, 'utf8'), '{"合成重名":"fixture_old_name"}');
    } finally {
      assert.equal(path.dirname(root), path.resolve(fileURLToPath(new URL('../../', import.meta.url))));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }],
  ['坏表与查询表达式拒绝', () => {
    for (const base of ['{bad}', '[]', '{"a":3}', '{"a":""}']) assert.throws(() => planAliasMerge(base, '{}'));
    assert.throws(() => planAliasMerge('{}', '{"合成名庚":"fixture_name_g_(fixture_work_c) rating:s"}'));
  }],
];
let passed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('PASS '+name); } catch (error) { console.error('FAIL '+name, error); process.exitCode=1; }
}
console.log(`${passed}/${tests.length} passed`);
