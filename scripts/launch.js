/**
 * Friendly launcher behind `start.cmd`.
 *
 * `start.cmd` stays pure ASCII because cmd.exe parses batch files in the console
 * OEM codepage and mangles embedded UTF-8. Everything user-facing and every
 * preflight check therefore lives here, where Node owns the encoding.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIMARY_BOT, resolveEnvFile } from '../src/config.js';
import { botDirFromEnvFile, clearRestartRequest, consumeRestartRequest, restartMarkerPath } from '../src/lock.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (line = '') => process.stdout.write(`${line}\n`);

function bail(title, hints) {
  out();
  out(`  ✗ ${title}`);
  out();
  for (const hint of hints) out(`      ${hint}`);
  out();
  process.exit(1);
}

const [major] = process.versions.node.split('.').map(Number);
if (!Number.isSafeInteger(major) || major < 22) {
  bail(`Node.js 版本过低：${process.versions.node}`, [
    '本 bridge 需要 Node.js 22 或更高版本（用到内置的 fetch 与 WebSocket）。',
    '下载：https://nodejs.org/',
  ]);
}

// 用哪份配置:QQBOT_ENV_FILE(启动器会设)→ 旧布局 .env → bots\<PRIMARY_BOT>\.env。
// 这里必须和 `src/config.js` 的 `resolveEnvFile` 是同一套规则,否则会出现
// "启动器检查了 A、bridge 实际读的是 B"这种最难查的分叉。
const envFile = resolveEnvFile(ROOT_DIR);
if (!fs.existsSync(envFile)) {
  bail(`找不到配置文件 ${envFile}`, [
    `请先复制模板：copy .env.example bots\\${PRIMARY_BOT}\\.env`,
    '然后用记事本打开它，填入 QQ_APP_ID 与 QQ_CLIENT_SECRET。',
    '（多实例：用 QQBOT_ENV_FILE 指定别的配置文件，例如 bots\\demo\\.env。）',
  ]);
}

// ⚠️ 隔离（2026-10-08）：把这只机器人的 Harness home 指到**自己的 home** —— `sessions` 是
//    私有真实目录，`profiles` / `storages` / 缓存 / 凭据全部用链接共享（原理与理由见
//    `src\bot-home.js` 顶部那一大段：桌面版会遍历 `$QQBOT_HOME\sessions` 做身份校验，
//    机器人那边一条脏日志就能把桌面版的 workspaceRegistry 整链拖停）。
//
//    为什么必须在这里**显式赋值**：`process.loadEnvFile` 不覆盖已经存在的环境变量（实测），
//    所以"从某个 DSH 会话里启动"时，`.env` 里那行 `QQBOT_HOME` 会失效。
//    这一步也必须早于 `../src/index.js` 的导入 —— 那边算会话目录时读的就是 process.env.QQBOT_HOME。
const { prepareBotHome } = await import('../src/bot-home.js');
const botHome = prepareBotHome({ envFile, rootDir: ROOT_DIR });
if (botHome.home) {
  const inheritedHome = process.env.QQBOT_HOME;
  process.env.QQBOT_HOME = botHome.home;
  process.env.QQBOT_QQBOT_HOME = botHome.home;
  if (botHome.problems.length) {
    out(`  ⚠ 私有 home 有 ${botHome.problems.length} 个问题（启动继续，但会话可能又落回共享根）`);
    for (const item of botHome.problems) out(`      · ${item}`);
    out('      排查：node scripts\\console.js --check');
  }
  out(`    QQBOT_HOME  : ${botHome.home}`
    + `${inheritedHome && inheritedHome !== botHome.home ? `　（进程原值 ${inheritedHome}，已覆盖）` : '　（机器人私有：会话日志与桌面版隔离）'}`);
}

out();
out('  ============================================================');
out('    DSH QQ Bot Bridge');
out('  ============================================================');
out();
out(`    Node 版本 : ${process.versions.node}`);
out(`    运行目录  : ${ROOT_DIR}`);
out();
out('    正在启动，日志输出如下。');
out();
out('    停止 : 在本窗口按 Ctrl+C');
out('    注意 : 关闭本窗口会同时停止 QQ 机器人');
out('    重启 : 双击 scripts\\restart.cmd（或用 /restart），本窗口会自己重开');
out();
out('  ------------------------------------------------------------');
out();

// ⚠️ 启动时**先清掉**「请重启」标记。
// 那个标记只对"上一次退出"有效 —— 留着它会让下一次启动莫名其妙又重启一次。
const markerFile = restartMarkerPath(ROOT_DIR, botDirFromEnvFile(envFile));
clearRestartRequest(markerFile);

try {
  const { main } = await import('../src/index.js');
  await main();
} catch (err) {
  // Full cause chain: an undici network failure reports only "fetch failed",
  // with the real reason (DNS, TLS, refused) on `cause`.
  //
  // Emitted twice on purpose. `out()` is for the person watching the console;
  // `log.error` is for the log file, which is the only thing anyone can read
  // afterwards — autostart runs this window hidden, and a start that failed
  // before the gateway came up otherwise leaves a log that ends mid-banner and
  // looks like a silent death (§6.5 of the handoff notes).
  const { describeError, log } = await import('../src/log.js');
  out();
  out('  ------------------------------------------------------------');
  out(`  ✗ 启动失败：${describeError(err)}`);
  // ⚠️ 有些启动失败是**瞬时**的(刚开机那几秒网络/证书栈还没就绪)。
  //    只印一行 `EE certificate key too weak` 的话,看的人会以为机器坏了或平台封了 ——
  //    所以在这里补判据与出路(纯函数,有测试)。**不改行为**:进程级重拉还是原来那套。
  const { describeTransientStartupError } = await import('../src/startup-errors.js');
  const transient = describeTransientStartupError(err);
  if (transient) out(transient);
  out();
  log.error('bridge 启动失败', err);
  if (transient) log.error(`（启动失败的判据）${transient.split('\n').join(' ')}`);
  process.exit(1);
}

// ⚠️⚠️ **`main()` 返回 ≠ bridge 结束。**
//
// `main()` 把网关挂上去就返回了,进程是靠**网关那条 WebSocket 的保活**继续跑的
// (`qq.js` 的 `start()` 里 `void this.#connect()`,此时正有一发 fetch 在飞)。
// 所以这里**只能什么都不做** —— 一旦"顺手"补一句 `process.exit(0)`:
//
//   2026-09-27 实测:两只机器人每次启动都在 `DSH 运行时已就绪` 之后**几毫秒**静默死掉,
//   现象是"窗口开着、进程没了、锁没了、日志里一个 error 都没有"。三个原因叠在一起:
//     ① 退出码 **0** → `run.cmd` 那条"非 0 才报错"不响,窗口就停在 `pause` 上(看着像没事);
//     ② 日志文件的 sink 是 `fs.createWriteStream`(带缓冲)→ `process.exit` 不刷缓冲,
//        最后那行 `bridge 已启动，等待 QQ 消息…` **根本没落盘**,日志于是停在"运行时已就绪";
//     ③ `process.on('exit')` 照常执行(`index.js` 里那句 `lock.release()`)→ 锁文件被清掉,
//        于是"锁还在 = 进程还在"这条排查线索也一起消失了(硬杀反而会留下锁)。
//
// 撤掉那句之后,进程由网关保活,退出只走下面两条明确的路:重启请求,或异常(启动器自己 exit 1)。
//
// ⚠️ 退出码**必须 ≤255**:实测 `process.exit(3010)` 到了 cmd 那边会变成 **0** ——
// cmd.exe 的 ERRORLEVEL 是字节,3010 被截断,于是"用一个大码表示重启"这套根本不成立
// (第一版就是这么写的,循环一次都没进)。现在用一个小而少见的码 7。
//
// 更结实的是那个标记文件本身:`run.cmd` 除了看 7,还会看**标记还在不在** —— 于是
// 即使进程是被硬杀的(走不到这里),只要标记还在,窗口也会重开。
const RESTART_EXIT_CODE = 7;
if (consumeRestartRequest(markerFile)) {
  out();
  out('  ------------------------------------------------------------');
  out('  ↻ 收到重启请求，本窗口马上重新启动…');
  out();
  process.exit(RESTART_EXIT_CODE);
}

// 兜底:事件循环空了 = 没有任何东西还在保活,而 bridge 本该一直活着。
//
// 这条路**只在出事时**才走到(正常情况下网关的 socket 一直在,`beforeExit` 不会触发;
// 网关掉线会自己排重连的定时器)。把它变成一句响亮的错误 + 非 0 退出码,
// 是为了让"静默死掉"这个形状**再也无法静默** —— 上面那次就是这么丢掉 26 分钟的。
// (重启与启动失败两条路都是 `process.exit()`,而 `beforeExit` 在那种情况下**不触发**,
//  所以这里不需要额外的开关:能走到这儿就是真的没人保活了。)
//
// 两个细节:
//   · 先设 `exitCode` 再打印 —— `out()` 会往 stdout 排一次异步写,而"排了新工作"会让
//     `beforeExit` **再来一次**,所以消息要靠 `silentStopReported` 只打一遍。
//   · 同时写进日志文件:窗口里的字关掉就没了,而日志是事后唯一读得到的东西
//     (启动失败那段注释里的同一句话)。写日志的那一发异步 I/O 恰好会让这一轮多活一会儿,
//     所以它来得及落盘 —— 这也正是 `process.exit()` 会丢掉最后几行的原因。
let silentStopReported = false;
const SILENT_STOP_LINE = 'bridge 意外停止:事件循环已空,没有任何连接/定时器在保活(网关掉线?)';
process.on('beforeExit', () => {
  process.exitCode = 1;
  if (silentStopReported) return;
  silentStopReported = true;
  out();
  out('  ------------------------------------------------------------');
  out(`  ✗ ${SILENT_STOP_LINE}`);
  out('    请把上面最后几行日志留给我，并检查网络。');
  out();
  void import('../src/log.js')
    .then(({ log }) => log.error(SILENT_STOP_LINE))
    .catch(() => {});
});
