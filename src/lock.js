import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance guard.
 *
 * Two bridges connected to the same bot is never correct: the gateway shard is
 * fixed at `[0,1]`, so both instances receive the same events and every QQ
 * message gets answered twice. QQ also caps concurrent gateway sessions, so the
 * second instance tends to fail in confusing ways instead of saying why. A PID
 * lock turns that into one clear refusal at startup.
 */

/** Whether a process id currently exists. */
export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user; anything else (ESRCH)
    // means the pid is gone.
    return err?.code === 'EPERM';
  }
}

/** Read the lock file, returning null when it is missing, unreadable, or malformed. */
export function readLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) return parsed;
  } catch {
    /* missing or malformed — treated as no lock */
  }
  return null;
}

/**
 * 「请重启」标记:一键重启靠它跨进程传递意图(D45)。
 *
 * 为什么需要一个文件、而不是一个信号:Windows 上**没有干净的跨控制台信号**。
 * 那个窗口里的 node 是 cmd.exe 的子进程,外部 `Stop-Process` 只能硬杀 ——
 * 而硬杀会让 `run.cmd` 末尾的 `pause` 留下一个同名空窗口(项目里踩过好几次)。
 *
 * 所以做法是:**先把意图写下来,再让进程自己退**。
 *   `run.cmd` 退出 node 之后会再查一次这个标记;有 → 立刻在同一个窗口里重新起来。
 *
 * 标记在**启动时先清掉**(见 `launch.js`),只对"这一次退出"有效 ——
 * 否则它就变成一个"每次启动都自动重启"的开关,那是灾难。
 */

/** 标记文件的路径。**按机器人分目录**,两只互不干扰。 */
export function restartMarkerPath(rootDir, botDir) {
  return path.join(rootDir, 'data', botDir, 'restart.requested');
}

/** 请求重启:写下标记(幂等)。 */
export function requestRestart(file, reason = 'unspecified') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ requestedAt: Date.now(), reason }, null, 2), 'utf8');
  return file;
}

/**
 * 取走标记:有就返回它的内容并**删掉**,没有返回 null。
 *
 * "取走"这个语义是刻意的:读和清必须是一次动作,否则两次读取会各自以为该重启一次。
 */
export function consumeRestartRequest(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8');
    fs.rmSync(file, { force: true });
    try {
      return JSON.parse(content);
    } catch {
      return { requestedAt: null, reason: 'unreadable' };
    }
  } catch {
    return null;
  }
}

/** 丢弃标记(启动时用:它只对"上一次退出"有效)。 */
export function clearRestartRequest(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 没有就算了 */
  }
}

/**
 * 标记写下去多久**还没被消费** = 那个窗口不在循环里了(2026-10-02,受控实验的产物)。
 *
 * 为什么需要这个数:2026-09-27 21:09 那起事故的判据就是"`restart.requested` 在她死后
 * **72 秒还在**" —— 说明 `run.cmd` 那段"node 退出 → 有标记就删并重开"根本没走到。
 * 实测(受控实验,`data\index\exp-launcher\`)窗口消费一个标记只要**几十毫秒**,
 * 所以 10 秒是一条宽到不会再误报的线。
 *
 * ⚠️ 它读的是**标记里的 `requestedAt`**(写标记的那一刻),文件 mtime 只作兜底 ——
 * 用 mtime 会被"随手碰一下文件"骗过。
 */
export const MARKER_STALE_MS = 10_000;

/**
 * 现算一个重启标记的状态(给 `restart.js --status` 与"停完之后到底谁接手了"用)。
 *
 * @param {string} file
 * @param {{now?: number, staleMs?: number}} [options]
 * @returns {{exists: boolean, ageMs: number|null, stale: boolean, requestedAt: number|null, reason: string|null}}
 */
export function restartMarkerState(file, { now = Date.now(), staleMs = MARKER_STALE_MS } = {}) {
  try {
    if (!fs.existsSync(file)) return { exists: false, ageMs: null, stale: false, requestedAt: null, reason: null };
    const raw = fs.readFileSync(file, 'utf8');
    let requestedAt = null;
    let reason = null;
    try {
      const parsed = JSON.parse(raw);
      requestedAt = Number(parsed?.requestedAt) || null;
      reason = parsed?.reason ?? null;
    } catch {
      /* 坏 JSON 也算"存在":消费判据不该因为内容坏了就说没有 */
    }
    const since = requestedAt ?? fs.statSync(file).mtimeMs;
    const ageMs = Math.max(0, now - since);
    return { exists: true, ageMs, stale: ageMs > staleMs, requestedAt, reason };
  } catch {
    return { exists: false, ageMs: null, stale: false, requestedAt: null, reason: null };
  }
}

/** 锁文件里的 PID 还在不在 —— 给一键重启判断"要不要先停"。 */
export function runningPid(lockFile) {
  const lock = readLock(lockFile);
  if (!lock || !isProcessAlive(lock.pid)) return null;
  return lock.pid;
}

/**
 * 取"这台机器人自己的目录名"(`data\<name>\`),给诊断脚本与启动器用。
 *
 * 第三处用同一个标识符的地方:`bots\<name>\`(配置)、`data\<name>\`(数据)、
 * 以及 `QQBOT_MOOD_THEME`(情绪谱)。D37/D39 已经定了这个约定,这里只是复用它。
 */
export function botDirFromEnvFile(envFile) {
  // ⚠️ 两个坑都在测试里现了形,记下来免得再犯:
  //   ① 开头的分隔符必须是**可选**的 —— `run.cmd` 设的是相对路径 `bots\demo\.env`,
  //      没有前导斜杠;写成 `[\\/]bots[\\/]…` 时**一条都匹配不上**,于是两只机器人
  //      都会退回 'megumin' —— 也就是**重启错的那只**,而且不报错。
  //   ② 结尾那个可选组件要写成 `[\\/][^\\/]*`(斜杠 + 非斜杠),不能用 `[^\\/]*`
  //      (它会在回溯时把 `aris` 也吃掉)。
  const match = /(?:^|[\\/])bots[\\/]([^\\/]+)(?:[\\/][^\\/]*)?$/.exec(String(envFile ?? ''));
  return match ? match[1] : 'megumin';
}
/**
 * 取单实例锁。
 *
 * ⚠️ **2026-10-11 现场(线上真的瘫了 ~15 分钟,D191)**:锁里那两个分支只处理了
 *    "持有者还活着"(`throw`)与"没有锁" —— **"锁还在、进程已经死了"这一档**当时只是
 *    "悄悄覆盖"。看起来没问题,但它和**守护的熔断**凑在一起就出事:
 *      ① 硬杀 / 崩溃退出不会跑 `release()`,锁文件留着;
 *      ② 守护立刻拉新实例 —— 那一刻旧进程可能**还活着**(taskkill 到真正退出有几百毫秒),
 *         于是新实例正确地把锁判成"有人在跑"、退出码 1;
 *      ③ 守护把连续 5 次"快速失败"当成**熔断**(代码写坏了那种),退避 **15 分钟**;
 *      ④ 那 15 分钟里旧进程已经死了、锁也变成了死的 —— 但**没有任何人会去清它**,
 *         面板(8799)整段时间不存在 → 网站 502(见 D191 的完整复盘)。
 *
 * 所以这里补一件事:**拿到锁之前先说清"这个锁是死的、我接管了"**,并把上面那句
 * 让人以为"要人工删文件"的提示换掉 —— 死锁**不该**需要人去删。
 *
 * @param {string} file
 * @param {{log?: (line: string) => void}} [options] 接管死锁时记一行(装配层传 log.warn)
 */
export function acquireLock(file, { log = null } = {}) {
  const existing = readLock(file);
  if (existing && isProcessAlive(existing.pid)) {
    const since = existing.startedAt ? new Date(existing.startedAt).toLocaleString() : '未知时间';
    throw new Error(
      [
        `已经有一个 bridge 在运行（PID ${existing.pid}，启动于 ${since}）。`,
        '',
        '  同一个机器人不能被两个 bridge 同时连接：网关分片固定为 [0,1]，',
        '  两个实例会重复消费同一条消息，QQ 也会限制并发会话。',
        '',
        `  要接管，请先停掉那个进程（scripts\\restart.cmd 会温和地结束它）；`,
        '  如果那个 PID 其实已经不在了，直接再启动一次即可 —— 死锁会被自动接管。',
        `      ${file}`,
      ].join('\n'),
    );
  }
  // ⚠️ "锁在、进程死了" = **残锁**:不用人管,接管并记一行(见上面那段现场)。
  if (existing) {
    const age = Number.isFinite(Number(existing.startedAt)) ? Math.round((Date.now() - Number(existing.startedAt)) / 1000) : null;
    if (typeof log === 'function') {
      log(`发现**残锁**:PID ${existing.pid}(启动于 ${age === null ? '未知' : age + ' 秒前'})已经不在,接管它`
        + `（硬杀/崩溃不会清锁 —— 这就是 D191 那次"面板整段时间起不来"的原因之一）`);
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2)}\n`, 'utf8');

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      // Only remove the lock if we still own it — never delete a successor's.
      const current = readLock(file);
      if (current && current.pid !== process.pid) return;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
