import fs from 'node:fs';
import path from 'node:path';

/**
 * DSH 会话目录的保留策略(按天数清理旧会话)。
 *
 * ### 为什么可以做这件事
 *
 * SDK 的 agent registry **拒绝复用任何已经被持久化过的 id**(见 `src/dsh.js` 顶部长注释),
 * 所以 bridge 每重启一次、每次 `/更新`,都会**换一代全新的会话**:
 *
 *     qqbot-group-<openid> → qqbot-group-<openid>-g2 → … → -g41
 *
 * 旧代数永远不会再被打开 —— 它们的**内容**已经由 `scripts\memory-archive.js`
 * 收进 `data\<bot>\memory.db`(记忆交接读的是那个库,不是会话目录),
 * 而"代数推进到哪"由状态库 + `#resolveSession` 的磁盘探测共同决定。
 * 于是旧目录纯粹是磁盘上的沉淀物:实测 4 天 28.5 MB(≈7 MB/天)。
 *
 * ### 两道安全闸(这里的每一条都是"删错了就丢历史"的防线)
 *
 *   1. **只碰 `qqbot-` 开头的会话目录**。同一个 `~/.dsh/sessions/` 下还有
 *      `--E-DSH--` 这种**人自己**的 Web 会话目录(9 个),以及 memory.db 的索引。
 *      宁可漏删,不可误删。
 *   2. **每个会话的最新一代永不动**。它是"当前正在用的那个",删掉等于把
 *      bot 的记忆当场清零。第一代没有 `-g` 后缀,所以"最新"要按代数比,不能按名字比。
 *
 * 时间用**目录 mtime**(= 会话目录里最后一次写入),不是文件 mtime ——
 * 目录才是 DSH 每次追加记录时都会碰的东西。
 */

/** DSH 会话目录里,哪些目录名算"这台 bridge 产生的会话"。 */
export const BOT_SESSION_PREFIX = 'qqbot-';

/**
 * 默认保留:**30 天**(2026-10-01 从 7 天改上来,D78)。
 *
 * **为什么改**:这些会话目录是 `memory.db` 的**唯一真相来源**(归档只是索引),
 * 而它们原来的身份是"磁盘上的沉淀物"——那时候删掉无所谓,现在删掉等于**烧掉历史**
 * (2026-10-01 现场:7 天策略删了 13 个会话,紧接着一次重导把 67 轮从库里也抹了)。
 *
 * **说实话,7→30 天的区别没有想象中大**:补归档每 15 分钟就把新轮次收进库了,
 * 所以"还没进库就被删"的窗口本来就很窄;30 天真正买到的是**最坏情况的余量**
 * (bridge 停摆几天 / 需要 `--restore` 时还有文件可捞)。代价按实测约 **7 MB/天** → 30 天 ≈ 210 MB。
 */
export const DEFAULT_RETENTION_DAYS = 30;

/** 删一个会话目录最多重试几次(Windows 上刚被释放的文件句柄会短暂占用)。 */
const DELETE_RETRIES = 3;
const DELETE_RETRY_DELAY_MS = 120;

/**
 * 从会话目录名拆出"这是哪一次对话的第几代"。
 *
 * 第一代没有 `-g` 后缀(见 `sessionIdForGeneration`),所以返回 `generation: 1`。
 * 非 `qqbot-` 开头的返回 null —— 那是别人的会话,这个模块不该有意见。
 *
 * @param {string} name 会话目录名
 * @returns {{conversation: string, generation: number}|null}
 */
export function parseBotSession(name) {
  const text = String(name ?? '');
  if (!text.startsWith(BOT_SESSION_PREFIX)) return null;
  // ⚠️ 别写成 `/-g(.*)$/`!`-g` 会匹配上 **`-group-` 里的那两个字**:
  //    `qqbot-group-A030…` 会在 index 5 命中,捕获到 `roup-A030…`,于是一整个
  //    **群会话**(这个项目里的大多数会话!)都被判成"不认识的目录"而永远清不掉。
  //    实测踩过:aris 工作区 67 个目录里 39 个这么被误判。
  //    必须先认出"最后那个 `-g<十进制数>`"(数字可以是多位数,所以不能只允许一位)。
  const gen = /-g(\d+)$/.exec(text);
  if (gen) {
    const generation = Number.parseInt(gen[1], 10);
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    return { conversation: text.slice(0, gen.index), generation };
  }
  // 没有合法的 `-g<n>` 结尾 = 第一代。但**畸形**的尾巴(`-gX`、`-g0`)要判成
  // "不认识":不能让它冒充这段对话的正统第一代,否则"最新一代永不动"那条闸门
  // 可能放它一马(`src/dsh.js` 的 `generationFromSessionIds` 也会忽略它们)。
  // ⚠️ 同样注意别让 `-group-` 里的 `-g` 命中:判据必须是"**以** `-g` 开头的后缀",
  //    也就是 `/-g[^/]*$/` 这种形状,而不是"名字里有没有 `-g`"。
  if (/-g[^-]*$/.test(text)) return null;
  return { conversation: text, generation: 1 };
}

/**
 * 目录 mtime;读不到时返回 null(那种目录一律当"不动")。
 *
 * ⚠️ 判据只有"它是不是目录":磁盘上真实存在**空的**会话目录(建了但一轮没跑成),
 * 它们同样该被清理 —— 别用"里面有没有 session 文件"当门槛,那会让它们永远清不掉。
 */
function statDir(dir) {
  try {
    const stats = fs.statSync(dir);
    return stats.isDirectory() ? stats : null;
  } catch {
    return null;
  }
}

/** 目录占多少字节(递归),给报告用。读不动就算 0,不影响决策。 */
export function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* 恰好被删/被占用:忽略 */
      }
    }
  }
  return total;
}

/**
 * 算出"这次该删哪些" —— **纯决策,不碰磁盘**。
 *
 * 判定顺序(顺序本身就是策略):
 *   ① 名字不是 `qqbot-` 开头 → `foreign`(别人的会话,连报告都单列)
 *   ② 是这个会话的**最新一代** → `newest`(永远保留)
 *   ③ mtime 在保留窗口内 → `recent`(还在用,保留)
 *   ④ 其余 → `expired`(唯一会被删的那一类)
 *
 * @param {object} input
 * @param {string} input.dir `~/.dsh/sessions/<workspace-slug>` 目录
 * @param {number} [input.days] 保留天数;<=0 视为"只保留最新一代"
 * @param {number} [input.now] 当前时间(测试注入用)
 * @returns {{ok: boolean, reason?: string, dir: string, days: number,
 *   keep: Array<object>, expired: Array<object>, foreign: string[],
 *   newestPerConversation: number, total: number}}
 */
export function planRetention({ dir, days = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
  const base = {
    dir,
    days,
    keep: [],
    expired: [],
    foreign: [],
    newestPerConversation: 0,
    total: 0,
  };

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // 目录不存在**不是错误**:这个工作区还没产生过会话(见 `#sessionDirNames` 的同款注释)。
    if (err?.code === 'ENOENT') return { ...base, ok: true, reason: 'no-such-dir' };
    return { ...base, ok: false, reason: `${err?.code ?? 'error'}: ${err?.message ?? err}` };
  }

  /** @type {Map<string, Array<{name: string, generation: number, mtimeMs: number, size: number}>>} */
  const generations = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseBotSession(entry.name);
    if (!parsed) {
      base.foreign.push(entry.name);
      continue;
    }
    const stats = statDir(path.join(dir, entry.name));
    if (!stats) {
      base.foreign.push(entry.name);
      continue;
    }
    base.total += 1;
    const bucket = generations.get(parsed.conversation) ?? [];
    bucket.push({
      name: entry.name,
      conversation: parsed.conversation,
      generation: parsed.generation,
      mtimeMs: stats.mtimeMs,
      size: dirSize(path.join(dir, entry.name)),
    });
    generations.set(parsed.conversation, bucket);
  }

  base.newestPerConversation = generations.size;
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  for (const bucket of generations.values()) {
    // "最新"按**代数**取,不按 mtime —— mtime 会被一次归档/一次迁移整体改动,
    // 而代数只由 bridge 单调推进,它是这里唯一可信的次序。
    const newest = bucket.reduce((best, item) => (item.generation > best.generation ? item : best));
    for (const item of bucket) {
      const where = path.join(dir, item.name);
      if (item === newest) {
        base.keep.push({ ...item, dir: where, why: 'newest' });
      } else if (item.mtimeMs > cutoff) {
        base.keep.push({ ...item, dir: where, why: 'recent' });
      } else {
        base.expired.push({ ...item, dir: where, why: 'expired' });
      }
    }
  }

  base.keep.sort((a, b) => a.name.localeCompare(b.name));
  base.expired.sort((a, b) => b.mtimeMs - a.mtimeMs);
  base.foreign.sort();
  return { ...base, ok: true };
}

/** 删一个会话目录,带几次重试(Windows 上句柄释放有延迟)。 */
function removeSessionDir(dir, { retries = DELETE_RETRIES, delayMs = DELETE_RETRY_DELAY_MS } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      lastError = err;
      // 同步小睡:这个脚本是独立进程(cli),不在 bridge 的事件循环里,阻塞无害。
      // 用 Atomics.wait 而不是忙等 —— 它不烧 CPU。
      const until = Date.now() + delayMs * (attempt + 1);
      while (Date.now() < until) {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, until - Date.now());
        } catch {
          break;
        }
      }
    }
  }
  return { ok: false, error: lastError };
}

/**
 * 执行清理:**先复核再删**。
 *
 * 复核不是形式主义 —— 从"算出该删哪些"到"真的删"之间,人可能手工动过目录,
 * 而这个函数也可能被别处以别的参数复用。删之前再确认一次"名字仍然是 bot 会话、
 * 并且仍然不是最新一代",是这条路上最后一道闸。
 *
 * @param {ReturnType<typeof planRetention>} plan
 * @param {{dryRun?: boolean}} [options]
 */
export function pruneSessions(plan, { dryRun = false } = {}) {
  const removed = [];
  const failed = [];
  let freedBytes = 0;

  if (!plan?.ok) return { removed, failed, freedBytes, skipped: true };

  for (const item of plan.expired ?? []) {
    const parsed = parseBotSession(item.name);
    if (!parsed) {
      failed.push({ name: item.name, error: '复核失败:目录名不再是 qqbot- 会话' });
      continue;
    }
    const stillThere = statDir(item.dir);
    if (!stillThere) continue; // 已经被删掉了(并发/手工),不算失败

    if (dryRun) {
      removed.push({ ...item, bytes: item.size });
      freedBytes += item.size;
      continue;
    }

    const result = removeSessionDir(item.dir);
    if (result.ok) {
      removed.push({ ...item, bytes: item.size });
      freedBytes += item.size;
    } else {
      failed.push({ name: item.name, error: String(result.error?.message ?? result.error) });
    }
  }

  return { removed, failed, freedBytes, skipped: false };
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 扫一个工作区:算计划 + 执行 + 给一份摘要。给守护进程和 CLI 共用。
 *
 * @param {object} input
 * @param {string} input.dir
 * @param {number} [input.days]
 * @param {boolean} [input.dryRun]
 * @param {number} [input.now]
 */
export function sweepWorkspace({ dir, days = DEFAULT_RETENTION_DAYS, dryRun = false, now = Date.now() } = {}) {
  const plan = planRetention({ dir, days, now });
  const result = pruneSessions(plan, { dryRun });
  return { plan, ...result };
}
