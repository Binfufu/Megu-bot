import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isProcessAlive, readLock, runningPid } from './lock.js';
import { sessionDirName } from './memory-archive.js';
import { DEFAULT_RETENTION_DAYS, formatBytes, sweepWorkspace } from './session-retention.js';

/**
 * 守护进程:把机器人当子进程看着,崩了自己拉起来(TODO「★★☆ 守护」)。
 *
 * ### 为什么不是"再写一个 run.cmd"
 *
 * `bots\<bot>\run.cmd` 已经有一层自愈(退出码 7 / 标记文件 → 在同一个窗口里重开),
 * 但它有两个天花板:
 *
 *   1. **它自己会死**。窗口一关、`cmd.exe` 一退,那条自愈链就没了 —— 而
 *      `docs\05` 记的那次"死了 1 小时 43 分没人知道",根因正是"没有任何东西在盯着进程"。
 *   2. **它开不了新窗口**。在 agent 会话里 `Start-Process` / `start` 起新窗口会拿到
 *      `0xc0000142`(`STATUS_DLL_INIT_FAILED`,TODO ★★★ 那条)。
 *
 * 所以这一层**不碰窗口**:它由计划任务在登录时隐藏启动,自己用
 * `spawn(process.execPath, …, windowsHide: true)` 直接起 `scripts/launch.js`。
 * 没有 `cmd.exe`、没有控制台、没有 `0xc0000142` 那条路。
 * `run.cmd` 那层自愈保留不动 —— 它是**手动**启动时的体验,两层互不冲突(见下)。
 *
 * ### 与手动启动共存(单实例保护在这里是多出来的好处)
 *
 * 每只机器人有 `QQBOT_LOCK_FILE`(内含 PID)。守护**每拍都先读锁**:
 *
 *   · 锁活着、持有者不是我起的子进程 → `external`(有人手工双击了 run.cmd)
 *     → **不 spawn**,只观察。手工那次照常工作,日志不会被"已有实例"刷屏。
 *   · 锁活着、持有者是我的子进程      → `running`,正常。
 *   · 锁不在或持有者已死              → 该我起了。
 *
 * 换句话说:**守护和 run.cmd 谁先起来谁赢,输的那个安静退让**,不会抢网关。
 *
 * ⚠️ 一个踩过的边界:**PID 会复用**。子进程刚退、锁文件还没被它的 exit 处理器清掉时,
 * 锁里那个 PID 看起来"还活着" —— 若那个号又被系统分给了别的进程,就会把
 * "我自己刚死的孩子"误判成"外部实例",于是白白等一轮(默认 2 分钟)。
 * 所以下面记着 `seenPids`,凡是我起过的 PID 都不当外部实例看。
 *
 * ⚠️⚠️ **同一个坑的"外部实例"形状**(2026-10-17 现场,1.150.91):seenPids 只护**我起过的**
 *    PID;一把**手工 run.cmd 的锁**在进程被终止后残留,锁里的 PID 又被系统分给了
 *    一个无关进程(现场:winrtutil32),于是 `botStatus` 永远判 `external`、seenPids
 *    永远不含它 ⇒ 守护**永远不收养**,机器人躺到那个无关进程退出为止(现场 12 分钟)。
 *    修法 = **锁的身份不只认 PID,还认"进程创建时刻 ≈ 锁里的 startedAt"**
 *    (`ghostLockHeld`,启动时刻对不上 = 幽灵锁 = 残锁,清掉按"没在跑"走)。
 *    探测失败(没有 powershell 之类)一律**当真锁**处理 —— 修复只许收紧,不许放开。
 *
 * ### "不能静默重试"(TODO 的原话)
 *
 * 起不来时必须**报告**。这里做三件事:
 *   ① 每次退出都往 `data\supervisor\supervisor.log` 写一行:谁、什么时候、退出码/信号、活了多久;
 *   ② 连续快速失败到阈值 → **熔断**,进入 15 分钟一轮的慢探,并且日志升级成 error,
 *      而不是每 5 秒重试一次把日志刷烂;
 *   ③ 把当前状态原子写进 `data\supervisor\status.json`,`--status` 随时能读。
 */

/** 默认值。都能从 CLI 覆盖,这里是"没人管时也合理"的那一档。 */
export const SUPERVISOR_DEFAULTS = {
  /** 子进程活不过这个时长,算"快速失败"(启动就崩)。 */
  fastExitMs: 120_000,
  /** 主循环节拍:锁观察、退避计时都按它推进。 */
  tickMs: 2_000,
  /** 检测到"别人在跑"时多久回来看一眼。 */
  externalProbeMs: 120_000,
  /**
   * **幽灵锁判定的容差**(2026-10-17 / 1.150.91,【暂定】)。
   * 锁里的 `startedAt` 是桥进程自己写的启动时刻,OS 的进程创建时刻只会**早于**它
   * (创建 → node 启动 → 写锁),正常差距是秒级;超过这个容差 = "PID 被复用,锁是幽灵"。
   * 给 2 分钟是给"冷启动慢"留的余量 —— 幽灵现场的差距是**小时级**,容差不差这几分钟。
   */
  ghostToleranceMs: 120_000,
  /** 正常退出(0)后的重启延迟 —— 不给它立刻反复重启的机会。 */
  normalBackoffMs: 10_000,
  /** 连续快速失败的重启延迟:第 1 次立刻,之后逐级拉开(索引 = 失败次数 - 2)。 */
  backoffMs: [0, 5_000, 15_000, 60_000, 300_000],
  /** 熔断后多久试一次。 */
  cooldownProbeMs: 900_000,
  /** 连续快速失败到这次数 → 熔断。 */
  maxConsecutiveFastFailures: 5,
  /** 会话保留清理:间隔 + 保留天数。 */
  sweepIntervalMs: 6 * 60 * 60 * 1000,
  retentionDays: DEFAULT_RETENTION_DAYS,
  /** status.json 心跳间隔。 */
  heartbeatMs: 30_000,
};

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function bridgeRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** 守护自己的目录(和每只机器人的 `data\<bot>\` 平级)。 */
export function supervisorPaths(rootDir = bridgeRoot()) {
  const dir = path.join(rootDir, 'data', 'supervisor');
  return {
    dir,
    lock: path.join(dir, 'supervisor.lock'),
    state: path.join(dir, 'status.json'),
    log: path.join(dir, 'supervisor.log'),
    stop: path.join(dir, 'stop.requested'),
  };
}

// ---------------------------------------------------------------------------
// 一个小而够用的文件日志(独立于 src/log.js:这里的行必须在崩溃后仍然读得到)
// ---------------------------------------------------------------------------

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function openSupervisorLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 5_000_000) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* best effort */
  }
  return (level, message, extra) => {
    const suffix = extra === undefined || extra === '' ? '' : ` ${typeof extra === 'string' ? extra : safeJson(extra)}`;
    const line = `${new Date().toISOString()} [${level}] ${message}${suffix}\n`;
    // 同时进 stderr:计划任务隐藏运行时看不到,但手动跑 `node scripts\supervisor.js`
    // 时这一行就是唯一的实时反馈。
    process.stderr.write(line);
    try {
      fs.appendFileSync(file, line);
    } catch {
      /* 磁盘满了也不该把守护带崩 */
    }
  };
}

/** 原子写:先写临时文件再 rename,免得读到半截 JSON。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 每只机器人的静态信息 + 动态状态
// ---------------------------------------------------------------------------

function readEnvValue(envFile, key) {
  try {
    const text = fs.readFileSync(envFile, 'utf8');
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function dshHome() {
  return process.env.QQBOT_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
}

/**
 * 这只机器人自己的 Harness home：`.env` 里的 `QQBOT_HOME` 优先（隔离，见 `src/bot-home.js`），
 * 没写就跟随进程的 `QQBOT_HOME`。
 *
 * 为什么守护也要认这一行：会话保留（sweep）清的目录必须和机器人**实际写日志的地方**一致。
 * 隔离之后如果还按进程的 `~/.dsh` 去算，那个目录已经不存在了 —— 保留会静默变成空转。
 */
function botDshHome(envFile) {
  return readEnvValue(envFile, 'QQBOT_HOME') || dshHome();
}

/**
 * 一只机器人的启动信息。**全部从它的 `.env` 读**(D36 那条规矩:不写死布局)。
 *
 * @param {string} name `bots\<name>\.env`
 * @param {string} rootDir
 */
export function describeBot(name, rootDir = bridgeRoot()) {
  const envFile = path.join(rootDir, 'bots', name, '.env');
  const workspace = readEnvValue(envFile, 'QQBOT_WORKSPACE') || path.resolve(rootDir, '..', 'qqbot-workspace');
  const cwd = path.isAbsolute(workspace) ? workspace : path.resolve(rootDir, workspace);
  return {
    name,
    envFile,
    exists: fs.existsSync(envFile),
    cwd,
    lockFile: path.resolve(rootDir, readEnvValue(envFile, 'QQBOT_LOCK_FILE') || path.join('data', name, 'bot.lock')),
    logFile: readEnvValue(envFile, 'QQBOT_LOG_FILE') || '',
    dshHome: botDshHome(envFile),
    sessionsDir: path.join(botDshHome(envFile), 'sessions', sessionDirName(cwd)),
  };
}

/** `bots\` 下所有带 `.env` 的目录 —— 不写死"两只"。 */
export function listBots(rootDir = bridgeRoot()) {
  let names = [];
  try {
    names = fs
      .readdirSync(path.join(rootDir, 'bots'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(rootDir, 'bots', name, '.env')));
  } catch {
    names = [];
  }
  return names.sort();
}

/** 把 `--bot a --bot b` / `--both` 归一化成实际存在的机器人名单。 */
export function selectBots(requested, rootDir = bridgeRoot()) {
  const available = listBots(rootDir);
  if (!requested || requested.length === 0 || requested.includes('both')) return available;
  return requested.filter((name) => available.includes(name));
}

/**
 * 这只机器人现在归谁:
 *
 *   `stopped`  没在跑
 *   `running`  在跑,而且是我的子进程
 *   `external` 在跑,但不是我起的(手工 run.cmd / 上一个守护留下的)
 */
export function botStatus(bot, state) {
  const pid = runningPid(bot.lockFile);
  const mine = state?.child?.pid ?? null;
  if (!pid) return { state: 'stopped', pid: null, mine: false };
  if (mine && pid === mine) return { state: 'running', pid, mine: true };
  return { state: 'external', pid, mine: false };
}

/**
 * **问 OS 要一个进程的创建时刻**(epoch ms;2026-10-17 / 1.150.91)。
 *
 * 为什么需要:Node 的 `process.kill(pid, 0)` 只能答"这个号上**有没有**进程",
 * 答不了"是不是**原来那个**进程" —— 而 Windows 的 PID 是复用的,锁因此可能被
 * 一个无关进程"顶活"(现场:旧桥的 11244 被 winrtutil32 顶了)。
 *
 * 用 `Get-Process -Id X).StartTime` 对拍锁里的 `startedAt`(都是本机时钟,可直接比)。
 * @param {number} pid
 * @param {{run?: typeof spawnSync, now?: () => number}} [deps] 测试注入
 * @returns {number|null} 创建时刻;**拿不到一律 `null`**(调用方必须把 null 当"当真锁"处理)
 */
export function probeProcessStartMs(pid, { run = spawnSync } = {}) {
  // `StartTime.ToFileTime()` = 100ns 自 1601-01-01;减 FILETIME 偏移折回 epoch ms。
  const probed = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToFileTime().ToString()`,
  ], { timeout: 5_000, encoding: 'utf8', windowsHide: true });
  if (probed.status !== 0 || probed.error) return null;
  const text = String(probed.stdout ?? '').trim();
  if (!/^\d{15,}$/.test(text)) return null;   // FILETIME 至少 15 位(2026 年);别把报错文案当数字
  return Number((BigInt(text) / 10_000n) - 11_644_473_600_000n);
}

/**
 * **这把锁是不是"幽灵锁"**(pid 活着,但那个号上现在是**别的进程**)。
 *
 * 判据(三条全过才算幽灵,缺一条都当真锁 —— 只许漏判成"不插手",不许误删活锁):
 *   ① 锁在、pid 活着(这是调用方 `botStatus === 'external'` 的前提);
 *   ② 锁里带 `startedAt`(老格式没有就当真锁);
 *   ③ OS 报的进程创建时刻与 `startedAt` 差过 `toleranceMs`。
 * @param {string} lockFile
 * @param {number} pid `botStatus` 给的那个外部 pid
 * @param {{toleranceMs?: number, probe?: (pid: number) => number|null, read?: typeof readLock}} [deps] 测试注入
 */
export function ghostLockHeld(lockFile, pid, { toleranceMs = SUPERVISOR_DEFAULTS.ghostToleranceMs, probe = probeProcessStartMs, read = readLock } = {}) {
  const held = read(lockFile);
  if (!held) return false;
  if (!isProcessAlive(pid)) return false;
  const startedAt = Number(held.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  const creation = probe(pid);
  if (creation == null) return false;
  return Math.abs(creation - startedAt) > toleranceMs;
}

/** 温和地结束一个 PID:先 taskkill(不带 /F),不行再 /F(与 scripts\restart.js 同一套)。 */
function stopPid(pid) {
  const graceful = spawnSync('taskkill', ['/PID', String(pid)], { encoding: 'utf8', windowsHide: true });
  if (graceful.status === 0) return 'graceful';
  const forced = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true });
  return forced.status === 0 ? 'forced' : 'failed';
}

// ---------------------------------------------------------------------------
// 状态文件:给 --status 读的现场
// ---------------------------------------------------------------------------

function readStatusFile(rootDir = bridgeRoot()) {
  const { state } = supervisorPaths(rootDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* 没有 / 坏了 —— 返回 null,调用方按"守护没在跑"处理 */
  }
  return null;
}

/**
 * 给人和 CLI 看的完整状态:守护是否活着 + 每只机器人归谁。
 * 读的是**磁盘上的现场**(锁 + 状态文件),守护没在跑时也能回答。
 */
export function supervisorStatus({ rootDir = bridgeRoot(), bots } = {}) {
  const paths = supervisorPaths(rootDir);
  const lock = readLock(paths.lock);
  const alive = Boolean(lock && isProcessAlive(lock.pid));
  const file = readStatusFile(rootDir);
  const names = bots && bots.length ? bots : listBots(rootDir);

  const perBot = names.map((name) => {
    const bot = describeBot(name, rootDir);
    const child = file?.children?.[name] ?? null;
    return { bot, child, status: botStatus(bot, child ? { child } : null) };
  });

  return {
    paths,
    supervisor: {
      alive,
      pid: lock?.pid ?? null,
      startedAt: lock?.startedAt ?? null,
      heartbeatAt: file?.updatedAt ?? null,
      stopRequested: fs.existsSync(paths.stop),
      meltdown: file?.meltdown ?? {},
      lastSweep: file?.lastSweep ?? null,
    },
    bots: perBot,
  };
}

// ---------------------------------------------------------------------------
// 会话保留清理
// ---------------------------------------------------------------------------

/**
 * 扫所有机器人工作区的会话目录(这是"按天数清理"真正被执行的地方)。
 * 由守护**启动时跑一次 + 之后每 `sweepIntervalMs` 一次** —— 所以不需要第二个计划任务。
 */
export function sweepAll({ rootDir = bridgeRoot(), bots, days = SUPERVISOR_DEFAULTS.retentionDays, dryRun = false, log = () => {} } = {}) {
  const names = bots && bots.length ? bots : listBots(rootDir);
  const results = [];
  for (const name of names) {
    const bot = describeBot(name, rootDir);
    const result = sweepWorkspace({ dir: bot.sessionsDir, days, dryRun });
    const removed = result.removed.length;
    const freed = formatBytes(result.freedBytes);
    const missing = result.plan.reason === 'no-such-dir';
    // ⚠️ dryRun 下说"删除"就是撒谎(dryRun 一个都不会删) —— 措辞跟着模式走(2026-10-16,1.150.85)。
    const prefix = dryRun ? '会话保留(试算,不删)' : '会话保留';
    log(
      removed > 0 ? 'info' : 'debug',
      `${prefix}:${name} ${missing ? '(还没有会话目录)' : `${dryRun ? '过期' : '删除'} ${removed} 个 / 释放 ${freed}(保留 ${result.plan.keep.length} 个,最近 ${days} 天)`}`,
      result.failed.length ? `失败 ${result.failed.length}: ${safeJson(result.failed)}` : '',
    );
    results.push({ name, ...result, removedCount: removed, freed: result.freedBytes });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * 跑守护,直到收到停止请求 / 信号 / 没有可守护的机器人。
 *
 * @param {object} [options]
 * @param {string[]} [options.bots] 只守护这几只;默认 `bots\` 下全部
 * @param {number} [options.retentionDays]
 * @param {boolean} [options.once] 只写一次状态就退出(不起任何子进程)
 * @param {number} [options.maxSeconds] 跑这么多秒后自己收尾退出(给隔离验证用;0/undefined = 一直跑)
 * @param {boolean} [options.spawn] 是否允许起子进程(false = 只观察,不接管)
 * @param {string} [options.rootDir]
 */
export async function runSupervisor({
  bots,
  retentionDays = SUPERVISOR_DEFAULTS.retentionDays,
  once = false,
  maxSeconds = 0,
  spawn: allowSpawn = true,
  rootDir = bridgeRoot(),
} = {}) {
  const paths = supervisorPaths(rootDir);
  const log = openSupervisorLog(paths.log);
  const requested = bots && bots.length ? bots : listBots(rootDir);
  if (requested.length === 0) {
    log('error', '没有可守护的机器人(bots\\ 下找不到任何 .env)');
    return 1;
  }

  // ---- 单实例:守护自己也只能有一个 --------------------------------------
  const existing = readLock(paths.lock);
  if (existing && isProcessAlive(existing.pid)) {
    log('error', `已经有一个守护在运行(PID ${existing.pid})—— 本进程退出,不去抢`);
    return 2;
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.lock, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2)}\n`, 'utf8');
  // 上一轮留下的停止请求:启动时先清掉(和 launch.js 清 restart.requested 同一个道理)
  fs.rmSync(paths.stop, { force: true });

  const specs = requested.map((name) => describeBot(name, rootDir));
  const active = specs.filter((spec) => spec.exists);
  const missing = specs.filter((spec) => !spec.exists);
  if (missing.length) log('error', `缺少 .env、被跳过的机器人:${missing.map((spec) => spec.name).join('、')}`);
  if (active.length === 0) {
    log('error', '没有任何一只有 .env 的机器人 —— 守护无事可做,退出');
    try {
      fs.rmSync(paths.lock, { force: true });
    } catch {
      /* ignore */
    }
    return 1;
  }

  const startedAtMs = Date.now();
  log('info', `守护已启动(PID ${process.pid}):${active.map((spec) => spec.name).join('、')}`
    + `;会话保留 ${retentionDays} 天;每 ${Math.round(SUPERVISOR_DEFAULTS.sweepIntervalMs / 3600000)} 小时清理一次`);

  /** @type {Map<string, any>} */
  const states = new Map();
  for (const spec of active) {
    states.set(spec.name, {
      spec,
      child: null,
      seenPids: new Set(),
      consecutiveFastFailures: 0,
      meltdown: false,
      nextAttemptAt: 0,
      lastExit: null,
      note: '启动中',
    });
  }

  let lastSweepAt = 0;
  let lastSweepSummary = null;
  let lastWriteAt = 0;
  let stopping = false;
  let stoppingReason = '';

  const snapshot = () => ({
    pid: process.pid,
    startedAt: startedAtMs,
    updatedAt: Date.now(),
    rootDir,
    retentionDays,
    meltdown: Object.fromEntries([...states].map(([name, st]) => [name, {
      consecutiveFastFailures: st.consecutiveFastFailures,
      meltdown: st.meltdown,
      nextAttemptAt: st.nextAttemptAt,
      note: st.note,
      lastExit: st.lastExit,
    }])),
    children: Object.fromEntries([...states].map(([name, st]) => [name, st.child
      ? { pid: st.child.pid, startedAt: st.child.startedAt, restarts: st.child.restarts }
      : null])),
    lastSweep: lastSweepSummary,
  });

  const writeState = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWriteAt < SUPERVISOR_DEFAULTS.heartbeatMs) return;
    lastWriteAt = now;
    writeJsonAtomic(paths.state, snapshot());
  };

  const requestStop = (reason) => {
    if (stopping) return;
    stopping = true;
    stoppingReason = reason;
    log('info', `收到停止请求(${reason}),正在收尾…`);
  };

  /** 退出后定下一次尝试时刻;连续快速失败到阈值就熔断。 */
  const scheduleRetry = (st, { fast }) => {
    if (fast) st.consecutiveFastFailures += 1;
    else st.consecutiveFastFailures = 0;

    /**
     * ⚠️ **2026-10-11 现场(D191):熔断之前先看一眼"是不是残锁把新实例挡在门外"**。
     *
     * 那次的形状:旧进程被硬杀 → 锁文件留着 → 守护拉新实例时旧进程还剩几百毫秒没退干净
     * → `acquireLock` **正确地**判"有人在跑" → 退出码 1 → 连续 5 次"快速失败" → 熔断 15 分钟。
     * 而那 15 分钟里旧进程早没了、锁也死了,却**没人会去清**:面板(8799)整段不存在,
     * 网站 502(云隧道本身是好的 —— 它只是没有回源)。
     *
     * 判据很硬:锁里的 PID **不在了** = 新实例现在就能起来 = 不该退避。
     * 这不是"放宽熔断",是"熔断的理由不成立"(真正的坏代码不会因为锁没了就好)。
     */
    const staleLockTakeover = () => {
      try {
        const held = readLock(st.spec.lockFile);
        return Boolean(held) && !isProcessAlive(held.pid);
      } catch {
        return false;
      }
    };
    if (fast && staleLockTakeover()) {
      st.consecutiveFastFailures = 0;
      st.meltdown = false;
      st.note = '发现残锁(持有者已不在)——立刻重试';
      st.nextAttemptAt = Date.now() + 2000;
      log('warn', `${st.spec.name} 上一次是"残锁"挡住的(持有者已不在)——不熔断,2 秒后重试`);
      return;
    }

    if (st.consecutiveFastFailures >= SUPERVISOR_DEFAULTS.maxConsecutiveFastFailures) {
      if (!st.meltdown) {
        st.meltdown = true;
        log('error',
          `${st.spec.name} 连续 ${st.consecutiveFastFailures} 次快速失败 —— 熔断:`
          + `改为每 ${Math.round(SUPERVISOR_DEFAULTS.cooldownProbeMs / 60000)} 分钟慢探一次。`
          + `请读 data\\${st.spec.name}\\bridge.log 找原因(凭据?网关?0xc0000142?)。`);
      }
      st.note = `熔断中(连续 ${st.consecutiveFastFailures} 次快速失败)`;
      st.nextAttemptAt = Date.now() + SUPERVISOR_DEFAULTS.cooldownProbeMs;
      return;
    }

    if (!fast) {
      st.note = '正常退出,稍后重试';
      st.nextAttemptAt = Date.now() + SUPERVISOR_DEFAULTS.normalBackoffMs;
      return;
    }
    const index = Math.min(st.consecutiveFastFailures - 1, SUPERVISOR_DEFAULTS.backoffMs.length - 1);
    const delay = SUPERVISOR_DEFAULTS.backoffMs[index];
    st.note = `异常退出,${Math.round(delay / 1000)}s 后重试`;
    st.nextAttemptAt = Date.now() + delay;
  };

  const spawnBot = (st) => {
    const { spec } = st;
    // ⚠️ spawn 失败必须**当成一次快速失败**来处理,绝不能让异常冲出主循环:
    //    在 0xc0000142 那类环境里(见 TODO ★★★ 那条)起进程会直接抛 ——
    //    守护自己崩掉的话,就再也没有人来报告"为什么起不来"了。
    //    实测也踩过:受限环境里 `spawn` 抛 `EPERM (errno -4048)`,把守护整个带崩。
    let child;
    try {
      child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'launch.js')], {
        cwd: rootDir,
        env: {
          ...process.env,
          QQBOT_ENV_FILE: spec.envFile,
          // 隔离（2026-10-08）：显式把机器人私有 home 传下去。launch.js 自己还会再同步一次
          // （它会读 .env），这里是双保险 —— 万一 launch 那步没生效，也不会又写回共享根。
          ...(spec.dshHome ? { QQBOT_HOME: spec.dshHome } : {}),
          // 失败时干净退出,别在无人值守的窗口里停在"按任意键"
          QQBOT_NO_PAUSE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      const message = err?.code ? `${err.code} (${err.errno ?? ''})` : String(err?.message ?? err);
      st.lastExit = { at: Date.now(), code: null, signal: null, livedMs: 0, fast: true, spawnError: message };
      log('error', `${spec.name} 起不来(spawn 抛错):${message} —— 本次算快速失败`, String(err?.message ?? ''));
      scheduleRetry(st, { fast: true });
      writeState(true);
      return;
    }
    const restarts = (st.child?.restarts ?? st.restarts ?? 0) + 1;
    st.restarts = restarts;
    st.child = { pid: child.pid, startedAt: Date.now(), restarts, proc: child };
    st.seenPids.add(child.pid);
    st.note = '运行中';
    log('info', `启动 ${spec.name}(PID ${child.pid},第 ${restarts} 次)`);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // launch.js 的横幅走 stdout;转进守护日志(debug 级),现场不必只靠 --status。
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) log('debug', `[${spec.name}:out] ${line}`);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // bridge 自己的日志已落 data\<bot>\bridge.log,这里只留尾部用于诊断,
      // 所以不重复写全量 —— 细节去看那份日志。
      const text = String(chunk).trim();
      if (text) log('debug', `[${spec.name}:err] ${text.slice(0, 2000)}`);
    });

    child.on('error', (err) => {
      log('error', `${spec.name} 子进程启动失败`, String(err?.message ?? err));
    });
    child.on('exit', (code, signal) => {
      const livedMs = Date.now() - (st.child?.startedAt ?? Date.now());
      const fast = livedMs < SUPERVISOR_DEFAULTS.fastExitMs;
      st.lastExit = { at: Date.now(), code, signal, livedMs, fast };
      st.child = null;
      log(code === 0 && !signal ? 'warn' : 'error',
        `${spec.name} 退出:code=${code ?? 'null'} signal=${signal ?? 'null'} 存活=${Math.round(livedMs / 1000)}s`,
        fast ? '(快速失败)' : '');
      scheduleRetry(st, { fast });
      writeState(true);
    });
  };

  // ---- 启动时先清理一次会话(顺带证明保留逻辑在无人值守时也真的跑) ----------
  // ⚠️ 2026-10-16(1.150.85,6B 配套,主人定:"不影响 bot 记忆的话,每隔一段合适的时间就压缩留档到废弃仓库"):
  //    守护这边**改成只报告不删除**（dryRun）。真正清理的唯一入口 =
  //      node scripts\archive-sessions.js --apply   ← 它**先整目录复制到 D:\废弃仓库、逐文件 sha256 校验通过，才删原件**；
  //    任何一步不过就保留原件。会话目录里是 DSH 时代的**原始聊天记录**（历史证据 + 只读分析仪器的输入），
  //    不是 bot 记忆（记忆在 data\<bot>\state.db 与 memory.db，本清扫从不碰它们）。
  const runSweep = () => {
    try {
      const results = sweepAll({ rootDir, bots: active.map((spec) => spec.name), days: retentionDays, dryRun: true, log });
      lastSweepSummary = {
        at: Date.now(),
        removed: 0,
        expiredReported: results.reduce((sum, item) => sum + item.removedCount, 0),
        freedBytes: results.reduce((sum, item) => sum + item.freed, 0),
        failed: results.reduce((sum, item) => sum + item.failed.length, 0),
      };
      log('info', `会话保留(只报告):过期 ${lastSweepSummary.expiredReported} 个 / ${formatBytes(lastSweepSummary.freedBytes)}`
        + ' —— 清理请走 node scripts\\archive-sessions.js --apply（先归档校验再删）');
    } catch (err) {
      // 清理是加分项:它失败绝不能影响"盯着机器人"这件正事。
      log('error', '会话保留清理失败(不影响守护)', String(err?.message ?? err));
      lastSweepSummary = { at: Date.now(), error: String(err?.message ?? err) };
    }
    lastSweepAt = Date.now();
    writeState(true);
  };
  runSweep();

  // ---- 收尾:把自己起的子进程都收回 -------------------------------------
  const cleanup = () => {
    for (const st of states.values()) {
      const pid = st.child?.pid;
      if (!pid) continue;
      // 复核一次"这个 PID 还是不是我那个孩子":子进程可能已经退场、PID 被系统
      // 分给了别人 —— 那种情况下 taskkill 会去打一个无关的进程(见 `#seenPids` 那段)。
      if (!isProcessAlive(pid)) {
        st.child = null;
        continue;
      }
      const how = stopPid(pid);
      log('info', `收尾:结束 ${st.spec.name}(PID ${pid})→ ${how}`);
      st.child = null;
    }
    // ⚠️ **必须**把 watchFile 摘掉,否则进程永远不退出。
    //    实测踩过:收尾日志写完了、子进程也收走了,可守护一直挂着不结束 ——
    //    `fs.watchFile` 是 libuv 的轮询句柄,它自己会把事件循环撑住;
    //    在真机上这意味着 `supervise.cmd` 永远阻塞、任务计划程序里永远显示"正在运行"。
    try {
      fs.unwatchFile(paths.stop);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(paths.stop, { force: true });
    } catch {
      /* ignore */
    }
    // 锁只在自己还持有时删(和 lock.js 的 release 同一个道理)
    const lock = readLock(paths.lock);
    if (lock && lock.pid === process.pid) {
      try {
        fs.rmSync(paths.lock, { force: true });
      } catch {
        /* ignore */
      }
    }
  };

  // ---- 主循环 ------------------------------------------------------------
  const tick = () => {
    const now = Date.now();
    for (const st of states.values()) {
      if (st.child) continue; // 我的孩子在跑,不用管
      const status = botStatus(st.spec, st.child);
      if (status.state === 'external' && !st.seenPids.has(status.pid)) {
        // ⚠️ 先验"是不是幽灵锁"(2026-10-17 / 1.150.91):pid 活着 ≠ 原来的进程还活着 ——
        //    PID 被系统复用给无关进程时,这把锁永远等不来它的持有者退场,机器人就永远等下去。
        if (ghostLockHeld(st.spec.lockFile, status.pid)) {
          try { fs.rmSync(st.spec.lockFile, { force: true }); } catch { /* 删不掉下拍再来 */ }
          st.note = '残锁已清(锁里的 PID 是被系统复用的无关进程)';
          st.nextAttemptAt = now;   // 按"没在跑"处理:别再吃一轮 2 分钟退避
          log('warn', `${st.spec.name} 锁里的 PID ${status.pid} 已被系统复用给别的进程(创建时刻对不上锁里的 startedAt)—— 清残锁,当"没在跑"`);
        } else {
          // 别人在跑(手工 run.cmd,或上一轮守护的残留)。不插手,只观察。
          const wasExternal = st.note === '外部实例';
          st.note = '外部实例';
          st.nextAttemptAt = now + SUPERVISOR_DEFAULTS.externalProbeMs;
          if (!wasExternal) {
            log('info', `${st.spec.name} 已被别的进程跑着(PID ${status.pid},手工 run.cmd?)—— 守护不插手,只观察`);
          }
          continue;
        }
      }
      if (now < st.nextAttemptAt) continue;
      if (!allowSpawn) {
        st.note = '只观察(未接管)';
        continue;
      }
      spawnBot(st);
    }

    if (now - lastSweepAt >= SUPERVISOR_DEFAULTS.sweepIntervalMs) runSweep();
    writeState();
  };

  // 信号路线:任务计划程序结束任务、或人在控制台按 Ctrl+C。
  const onSignal = (signal) => requestStop(`信号 ${signal}`);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // 兜底:标记文件路线(给 `--stop` 用 —— Windows 上没有可靠的跨控制台信号)
  fs.watchFile(paths.stop, { interval: 1_000 }, () => {
    if (fs.existsSync(paths.stop)) requestStop('stop.requested');
  });

  // 第一拍立刻跑,让"谁在跑"马上落进状态文件
  tick();
  writeState(true);

  if (once) {
    // `--once` 刻意**不起任何子进程**:它只是"读一遍现场、写一次状态"。
    // (早先的写法会先 spawn 再立刻 cleanup,等于起了就杀 —— 那既没用又危险,
    //  因为父子进程的 PID 生命周期完全来不及对齐。)
    log('info', '--once:只写一次状态就退出,不起任何子进程');
    cleanup();
    return 0;
  }

  await new Promise((resolve) => {
    const startedLoopAt = Date.now();
    const timer = setInterval(() => {
      if (stopping) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (maxSeconds > 0 && Date.now() - startedLoopAt >= maxSeconds * 1000) {
        clearInterval(timer);
        requestStop(`已跑满 ${maxSeconds}s(--max-seconds)`);
        resolve();
        return;
      }
      try {
        tick();
      } catch (err) {
        log('error', '守护主循环出错(继续跑)', String(err?.message ?? err));
      }
    }, SUPERVISOR_DEFAULTS.tickMs);
  });

  log('info', `守护停止(${stoppingReason || '正常退出'})`);
  cleanup();
  writeJsonAtomic(paths.state, { ...snapshot(), stoppedAt: Date.now(), stoppedReason: stoppingReason || 'normal' });
  return 0;
}
