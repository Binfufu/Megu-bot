/**
 * 保守公开子集：注册既有、依赖自包含的搬图检索/落盘、句库、own 引擎工具循环、搬图服务层、内容包加载器、世界包加载器与玩法模拟器套件。
 * 保留断言语义，使用中性夹具；公开必需 suite 用静态 import，缺失必须报错。
 * 不读取 resources、真实别名或外部 D 盘资料，不 spawn noPublish 工具，不联网。
 * 这不是完整私库的全量替代品；覆盖与排除边界随每次运行输出。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerEngineToolTests } from './selftest-engine-tools.js';
import { registerMeituFetchTests } from './selftest-meitu-fetch.js';
import { registerMeituLinesTests } from './selftest-meitu-lines.js';
import { registerMeituServiceTests } from './selftest-meitu-service.js';
import { registerPackTests } from './selftest-pack.js';
import { registerWorldPackTests } from './selftest-world-pack.js';
import { registerPlayTests } from './selftest-play.js';
import { registerParamsTests } from './selftest-params.js';
import { registerConfigParamsTests } from './selftest-config-params.js';
import { registerModelParamsTests } from './selftest-model-params.js';
import { registerContractPublicTests } from './selftest-contract.js';
import { selftestPublicCommandDoc } from './command-index.js';

export async function runPublicSelftest() {
  const cases = [];
  const suites = [];
  const register = (name, fn) => {
    const before = cases.length;
    fn({ test: (title, run) => cases.push([title, run]), assert });
    const count = cases.length - before;
    assert.ok(count > 0, `公开必需 suite ${name} 没有注册用例`);
    suites.push({ name, count });
  };
  register('meitu-fetch（检索/去重/游标/临时落盘）', registerMeituFetchTests);
  register('meitu-lines（默认句库/临时覆盖/注入读取）', registerMeituLinesTests);
  register('engine-tools（own 引擎工具循环：两步闭环/预算/坏参数/快照）', registerEngineToolTests);
  register('meitu-service（发N张角色美图服务层：白名单/冷却/降档/结算）', registerMeituServiceTests);
  register('content-pack（内容包加载/校验/失败闭环/注入读取）', registerPackTests);
  register('world-pack（世界包加载/激活/聚合/失败闭环/示例包校验）', registerWorldPackTests);
  register('play（玩法内核/模拟器：钓鱼、委托三段闭环、纯函数状态机）', registerPlayTests);
  register('params（类型/覆盖/来源/安全错误/未知项）', ({ test, assert }) => registerParamsTests(test, assert));
  register('config-params（主配置兼容接线/文件/包/env 来源）', registerConfigParamsTests);
  register('model-params（模型字段来源/校验/热覆盖/秘密边界）', registerModelParamsTests);
  register('contract-public（边界契约公开视图：公开锚点/页面同步/无决策号）', registerContractPublicTests);
  register('command-doc-public（命令表公开视图：公开渲染/无决策号/生成页同步）', ({ test }) => {
    test('命令与关键字公开视图', async () => { await selftestPublicCommandDoc(); });
  });

  // 与原全量 runner 相同的名称子串显式跳过、计数及 --out 语义。
  const patterns = String(process.env.QQBOT_SELFTEST_SKIP ?? '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const captured = [];
  const say = (line) => {
    captured.push(`${line}\n`);
    process.stdout.write(`${line}\n`);
  };
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  say('[selftest-public] PUBLIC SUBSET ONLY — 非全量；不证明面板/酒馆/后台或部署就绪');
  say(`公开覆盖：${suites.length} suites，${cases.length} registered cases`);
  for (const { name, count } of suites) say(`  suite ${name}: ${count}`);
  say('刻意排除：meitu-command/alias（真实 data/meitu-alias.json 判据）；meitu-interpret（resources/D 资料）；alias-merge（noPublish 工具）');
  say('刻意排除：gallery（回填工具闭包）；api/面板/酒馆/后台及其余未审计私有套件');
  say('刻意排除：world-pack-parity/lifecycle 与 world-params（读 content/local 或私有配置接线，属私库判据）');
  say('边界：只用中性内联夹具、注入假 fetch 与临时目录；其余套件未接入前不计入通过数。');
  for (const [name, fn] of cases) {
    if (patterns.some((pat) => name.includes(pat))) {
      skipped += 1;
      say(`  skip ${name}`);
      continue;
    }
    try {
      await fn();
      passed += 1;
      say(`  ok   ${name}`);
    } catch (err) {
      failed += 1;
      say(`  FAIL ${name}`);
      say(`       ${err.message}`);
    }
  }
  say('');
  say(`${passed} passed, ${failed} failed` + (skipped > 0 ? `, ${skipped} skipped` : ''));
  const outIndex = process.argv.indexOf('--out');
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    const target = process.argv[outIndex + 1];
    const targetPath = path.isAbsolute(target)
      ? target
      : path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', target);
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, captured.join(''), 'utf8');
      process.stdout.write(`\n  完整输出已写入:${targetPath}\n`);
    } catch (err) {
      process.stdout.write(`\n  ✗ 写输出失败(${targetPath}):${err?.message ?? err}\n`);
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
  return { passed, failed, skipped, registered: cases.length, suites };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runPublicSelftest();
}
