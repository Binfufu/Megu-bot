// 供应链零依赖复核(2026-10-18 安全审计批次3 / D248)。
//
// **背景**:《待办-安全措施-未完成.md》§2 原计划是「npm audit + lockfile 锁死」,
// 2026-10-18 重审核实本项目 **package.json 零依赖**(没有 dependencies,也没有 lockfile),
// npm audit 无对象 ⇒ 这条原待办改写成一条**回归判据**:
//   ① package.json 不许出现任何依赖字段(有人顺手 `npm install --save` 当场红);
//   ② `src\` 与 `scripts\` 的每一个 import 来源必须是 `node:` 内置或相对路径 ——
//      哪怕不写进 package.json 的裸包名(手动改 import)也当场红。
//
// **反证自证**(判据不许自己喂饱自己,AGENTS 教训⑤/⑨):判定逻辑抽成纯函数,
// 测试里对**合成内容**真跑反例 —— 裸包名必须被抓出、node:/相对路径必须放行、
// 带 dependencies 的假 package.json 必须抛。逻辑咬不动 = 这条测试自己先红。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 从一段 JS 源码里提取所有模块来源(static import / export-from /
 * dynamic `import('…')` / `require('…')`)。
 * ⚠️ 已知盲区(如实记):`import(变量)` 这类动态拼包名抓不到 —— 本仓库没有这种写法,
 *    真要引入时这条判据也拦不住它,那是评审的活。
 */
export function extractSpecifiers(code) {
  const specs = [];
  const push = (re, group) => { for (const m of code.matchAll(re)) specs.push(m[group]); };
  push(/\bfrom\s*(['"])([^'"\n]+)\1/g, 2);          // import x from 'y' / export {z} from 'y'
  push(/(^|[\s;])import\s*(['"])([^'"\n]+)\2/g, 3); // import 'y'(副作用导入)
  push(/\bimport\s*\(\s*(['"])([^'"\n]+)\1/g, 2);   // await import('y')
  push(/\brequire\s*\(\s*(['"])([^'"\n]+)\1/g, 2);  // require('y')(零依赖口径下也不该有)
  return specs;
}

/** 判定:零依赖口径下合法的来源只有 `node:` 内置与相对路径(`./`、`../`)。 */
export function isBuiltinOrRelative(spec) {
  return spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
}

/**
 * 这个命中算不算"真 import"?
 * ⚠️ 以 `\` 开头的一律不算:真实模块说明符不可能以反斜杠开头,那种命中是**源码里的
 *    正则字面量碎片**(别的判据里写着 `from '\.\/llm\.js'` 这类匹配模式,2026-10-18 实测
 *    selftest-own-request-options / selftest-summary-session 各有一处)——跳过它们,
 *    真实 import 仍然照扫。
 */
export function looksLikeRealImport(spec) {
  return !spec.startsWith('\\');
}

/** 对一份 {相对路径: 源码} 的合成集跑判定 —— 违规就抛(测试反证用它)。 */
export function assertAllBuiltinOrRelative(files) {
  const bad = [];
  for (const [file, code] of Object.entries(files)) {
    for (const spec of extractSpecifiers(code)) {
      if (!isBuiltinOrRelative(spec)) bad.push(`${file}: ${spec}`);
    }
  }
  if (bad.length > 0) throw new Error(`发现非零依赖 import:\n${bad.join('\n')}`);
}

/** 递归收集一个目录下的 .js / .mjs 文件(绝对路径)。 */
function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

export function registerSupplyChainTests({ test, assert }) {
  test('供应链(批次3):package.json 零依赖 —— 不许出现任何依赖字段', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const banned = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'];
    const present = banned.filter((key) => Object.prototype.hasOwnProperty.call(pkg, key));
    assert.deepEqual(present, [], `package.json 出现了依赖字段 ${JSON.stringify(present)} —— 有人装包了?零依赖口径要么收回、要么过 docs\\03 拍板`);
  });

  test('供应链(批次3):src 与 scripts 的每个 import 都只认 node: 内置或相对路径', () => {
    const selfPath = fileURLToPath(import.meta.url);
    // ⚠️ 排除判据文件自身:它源码里全是**故意写**的反例字符串与注释示例('left-pad'、'y'、'…'),
    //    让扫描扫到它 = 判据自己咬自己(2026-10-18 全量实测 3 failed 的教训);其余文件一个不豁免。
    const files = [...collectJsFiles(path.join(ROOT, 'src')), ...collectJsFiles(path.join(ROOT, 'scripts'))]
      .filter((file) => file !== selfPath);
    const bad = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replaceAll('\\', '/');
      const code = fs.readFileSync(file, 'utf8');
      for (const spec of extractSpecifiers(code)) {
        if (!looksLikeRealImport(spec)) continue;
        if (!isBuiltinOrRelative(spec)) bad.push(`${rel}: ${spec}`);
      }
    }
    assert.deepEqual(bad, [], `发现裸包名 import(共 ${bad.length} 处):\n${bad.join('\n')}\n—— 本项目零依赖,外来能力一律自己写或走 node: 内置`);
    // 顺带把"扫到了多少文件"钉个下限,防止目录改位后扫了个空集还绿着(判据自证的另一张马甲)。
    assert.ok(files.length >= 100, `src+scripts 至少该扫到 100 个 js 文件,现在只有 ${files.length} —— 扫描范围是不是失效了`);
  });

  test('供应链(批次3):反证 —— 判定逻辑对合成反例真的会咬', () => {
    // 裸包名必须被抓出
    assert.throws(() => assertAllBuiltinOrRelative({ 'a.js': 'import x from "left-pad";\n' }), /left-pad/);
    assert.throws(() => assertAllBuiltinOrRelative({ 'a.js': 'const { z } = require("some-pkg");\n' }), /some-pkg/);
    // node: 内置与相对路径必须放行
    assert.doesNotThrow(() => assertAllBuiltinOrRelative({
      'a.js': 'import fs from "node:fs";\nimport { y } from "./y.js";\nimport("../z.mjs").then(() => {});\n',
    }));
    // 正则字面量碎片(源码里的匹配模式)不算真 import;同形的真实相对导入照算
    assert.equal(looksLikeRealImport('\\.\\/llm\\.js'), false, '反斜杠开头 = 正则碎片,跳过');
    assert.equal(looksLikeRealImport('./llm.js'), true, '真实相对导入照算');
    // 带 dependencies 的假 package.json 必须抛(用同一条禁令口径)
    const banned = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'];
    const present = banned.filter((key) => Object.prototype.hasOwnProperty.call({ dependencies: {} }, key));
    assert.deepEqual(present, ['dependencies'], '反证:带 dependencies 的假包必须被判出来');
  });
}
