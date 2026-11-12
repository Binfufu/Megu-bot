/**
 * 「搜本/下本」的**服务层**（2026-11-12，代码层 JM 搜本 —— 整条链路不经过模型）。
 *
 * 分工（与搬图子系统同构）：
 *   · `src\jm-command.js` 纯解析群消息；
 *   · `scripts\jm-fetch-one.mjs` 子进程里调**本机 JM 边车服务**并下载拼图/封面（网络只在它里面）；
 *   · **本文件**串起来：群白名单 → 按群串行 → 冷却 → spawn 抓取器 → 上传/发送。
 *
 * 三条刻意的设计：
 *   ① **默认关闭、群白名单 fail closed**：没开 `QQBOT_JM` 时连解析都不进（`src\index.js` 的闸）；
 *      开了但群不在 `QQBOT_JM_GROUPS` 里（含空名单）→ 一句固定回话，**不 spawn 子进程**；
 *   ② **冷却只拦搜本、只记成功**（`QQBOT_JM_COOLDOWN_MS`，按群）：搜本要打边车和 JM 搜索，
 *      冷却防刷屏；**下本是用户看完编号后的下一步**，冷却拦它会把主流程掐死，所以下载只按群串行、
 *      不吃冷却。失败（服务没起/超时/没结果）不占冷却 —— 失败者再试一次是合法的；
 *   ③ **失败一律回固定话术、绝不调模型**：边车不在、超时、坏 JSON、下载失败都由 `DEFAULT_JM_LINES`
 *      兜住；只有成功时才有动态文案（多少本 / 阅读链接）。依赖全部可注入（`deps`），
 *      单测用假 `runFetch` / 假上传，不碰网络、不碰真 QQ、不写真实数据目录。
 *
 * 图片走**被动回复**（带 `msg_id` + `msg_seq`，回复用户那条指令消息）—— 与搬图同一条规则：
 * 不带 msg_id 的图是主动消息、吃逐群配额。文本回话接着图片的 seq 往下数。
 *
 * ⚠️ 边车地址、超时、单图大小上限都来自配置（`QQBOT_JM_*`）；下面的 `DEFAULT_*` 只是
 *    配置缺省时的兜底，不是第二份配置来源（唯一来源仍是 `src\config.js` 的 `jm` 段）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_SCRIPT = path.join(ROOT_DIR, 'scripts', 'jm-fetch-one.mjs');

/** 一条入站消息的**被动回复上限**（msg_seq 1..5）。与搬图同一口径，见 `src\meitu-service.js`。 */
const PASSIVE_SEQ_MAX = 5;

/** 默认的搜索数量上限与冷却（配置缺省时的兜底；真实值来自 `config.jm`）。 */
const DEFAULT_MAX = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 固定回话的默认句库。**失败路径只从这里挑句子**（不调模型、不临时编）：
 * 句子里不提内部路径/API，只说用户能采取的动作。数组是为了以后能加变体，
 * 也方便测试钉"回话 ∈ 该 key 的成员"而不是钉死某一串字。
 */
export const DEFAULT_JM_LINES = Object.freeze({
  /** 群不在白名单（含空名单）。 */
  groupDisabled: ['这个群没开 JM 搜本。'],
  /** 格式提示：解析失败但确实像在写这条指令。 */
  format: ['格式：搜本 <关键词> [1-5]；下本 <编号>。'],
  /** 搜本冷却中（只拦搜本；下本不吃冷却）。 */
  cooldown: ['刚搜过，等一会再搜。'],
  /** 边车连不上 / 回 4xx/5xx。 */
  serviceDown: ['JM 服务没启动，先启动 JM 边车服务。'],
  /** 整体超时。 */
  timeout: ['JM 服务响应太慢，稍后再试。'],
  /** 搜到 0 本。 */
  noResult: ['没搜到符合条件的本子。'],
  /** 搜索失败（坏 JSON / 边车报错 / 下载失败）。 */
  searchFailed: ['搜本没成功，稍后再试。'],
  /** 下载任务失败。 */
  downloadFailed: ['下载没完成，稍后再试或换一本。'],
  /** 序号之前没有可用的搜索结果。 */
  noSearch: ['先搜本，再用「下本 序号」；也可以直接发「下本 <编号>」。'],
  /** 序号越界。 */
  ordinalMissing: ['这个序号不对：先搜本看编号，或直接发「下本 <编号>」。'],
  /** 上传/发送图片失败（文本结果仍可能发出去）。 */
  uploadFailed: ['结果有了，但图没发出去，稍后再试。'],
  /** 兜底异常。 */
  internal: ['JM 处理出错了，稍后再试。'],
});

/** 没注入 log 时的静默实现（单测可以完全不传）。 */
const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

/** 每个群一条串行队列（同一个人连发两条时，后一条等前一条结束）+ 最近一次搜索结果。 */
const GROUP_QUEUES = new Map();

function queueStateFor(groupId) {
  let state = GROUP_QUEUES.get(groupId);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      /** 上次**成功搜本**的时间（冷却口径；null = 还没成功过）。 */
      lastSearchAt: null,
      /** 最近一次成功的搜索结果（rank 顺序）：`[{rank, id, title}]`，供「下本 序号」用。 */
      lastResults: [],
    };
    GROUP_QUEUES.set(groupId, state);
  }
  return state;
}

/** 群白名单：数组/Set 都认；空名单 = 谁都不给（fail closed）。 */
function allowGroup(groups, groupId) {
  if (groups instanceof Set) return groups.has(groupId);
  if (Array.isArray(groups)) return groups.includes(groupId);
  return false;
}

/** 从子进程 stdout 里取**最后一条能解析的** JSON（日志在 stderr，理论上只有一条）。 */
function lastJsonLine(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 不是 JSON 就继续往前找。
    }
  }
  return null;
}

/**
 * 默认 `runFetch`：spawn `scripts\jm-fetch-one.mjs`，收 stdout/stderr，硬超时。
 * 形状与 `src\meitu-service.js` 的 `spawnMeituFetch` 保持一致（父进程只认 stdout 最后一行 JSON）。
 *
 * @param {{args: string[], env: Record<string,string>, timeoutMs?: number, cwd?: string}} options
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function spawnJmFetch({ args, env, timeoutMs = DEFAULT_TIMEOUT_MS, cwd = ROOT_DIR }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: `spawn 失败:${err?.message ?? err}`, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      // 抓取器只输出一行 JSON；真出意外时别把内存吃光。
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on('error', (err) => {
      stderr = `${stderr}\n${err?.message ?? err}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

/** 截断动态标题（QQ 文本要短；标题本身可能很长）。 */
function shortTitle(title, max = 12) {
  const text = String(title ?? '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/**
 * 搜本成功后的动态文案（≤50 字为主，编号供「下本 序号」用）。
 * @returns {string}
 */
export function buildSearchText(count) {
  const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
  if (n === 1) return '搜到1本，编号看图；回复 下本1';
  return `搜到${n}本，编号看图；回复 下本1~${n}`;
}

/**
 * 下本成功后的动态文案：短句 + 网页阅读链接（链接由边车生成，长度不受控）。
 * @returns {string}
 */
export function buildDownloadText(title, viewerUrl) {
  const name = shortTitle(title);
  const url = String(viewerUrl ?? '').trim();
  return name ? `已下好《${name}》\n${url}` : `已下好，网页看图\n${url}`;
}

/**
 * 处理一条「搜本/下本」。**不抛**：任何意外都以固定回话收场并记日志。
 *
 * deps 可覆盖：
 *   config / log / runFetch / uploadFile / sendMedia / now / rng / lines
 *   （`reply` 是发固定回话的口子，`src\index.js` 传 `sendChunked`）
 *
 * @param {{message: object, parsed: object, deps?: object}} input
 * @returns {Promise<{ok: boolean, reason?: string, sent?: number, action?: string}>}
 */
export async function handleJmCommand({ message, parsed, deps = {} }) {
  const config = deps.config ?? {};
  const log = deps.log ?? SILENT_LOG;
  const jm = config.jm ?? {};
  const lines = { ...DEFAULT_JM_LINES, ...(deps.lines && typeof deps.lines === 'object' ? deps.lines : {}) };
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const rng = typeof deps.rng === 'function' ? deps.rng : Math.random;
  /** 从句库挑一句（同 key 的变体随机；单测断言"回话 ∈ 该 key 的成员"）。 */
  const pickLine = (key) => {
    const variants = Array.isArray(lines[key]) && lines[key].length > 0 ? lines[key] : DEFAULT_JM_LINES[key];
    return variants[Math.min(variants.length - 1, Math.floor(rng() * variants.length))];
  };

  const rawReply = typeof deps.reply === 'function'
    ? deps.reply
    : async (text) => { log.warn(`JM：没有注入 reply，这句回话被丢弃：${text}`); };
  /** 被动槽位记账：文本回话接着图片的 msg_seq 往下数（与搬图同一口径）。 */
  const passiveId = message?.messageId ?? null;
  let seq = 0;
  const reply = async (text) => {
    const startSeq = seq;
    const active = passiveId !== null && startSeq >= PASSIVE_SEQ_MAX;
    try {
      const used = Number(await rawReply(text, { startSeq, active }));
      if (!active && Number.isFinite(used) && used > 0) seq += used;
    } catch (err) {
      log.warn(`JM：回话没发出去（${text}）：${err?.message ?? err}`);
    }
  };

  const uploadFile = typeof deps.uploadFile === 'function' ? deps.uploadFile : null;
  const sendMedia = typeof deps.sendMedia === 'function' ? deps.sendMedia : null;
  const runFetch = typeof deps.runFetch === 'function' ? deps.runFetch : spawnJmFetch;

  if (!message || message.scene !== 'group') {
    log.warn('JM：不是群消息，忽略');
    return { ok: false, reason: 'not_group' };
  }
  const groupId = String(message.targetId ?? '');
  if (!groupId) {
    log.warn('JM：群消息没有 targetId，忽略');
    return { ok: false, reason: 'no_target' };
  }

  // ① 群白名单（fail closed：空名单 / 不在名单 → 都不发，且**一次都不 spawn**）。
  if (!allowGroup(jm.groups, groupId)) {
    log.warn(`JM：群 ${groupId.slice(0, 8)}… 没开这个指令（QQBOT_JM_GROUPS）`);
    await reply(pickLine('groupDisabled'));
    return { ok: false, reason: 'group_disabled' };
  }

  if (!parsed?.ok) {
    log.warn('JM：服务层收到没解析成功的命令（不应发生）');
    return { ok: false, reason: 'parse' };
  }

  const apiBase = String(jm.api ?? '').trim().replace(/\/+$/u, '') || 'http://127.0.0.1:8790';
  const timeoutMs = Number.isFinite(Number(jm.timeoutMs)) && Number(jm.timeoutMs) > 0
    ? Number(jm.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(Number(jm.maxBytes)) && Number(jm.maxBytes) > 0
    ? Number(jm.maxBytes) : DEFAULT_MAX_BYTES;
  const maxCount = Number.isFinite(Number(jm.max)) && Number(jm.max) > 0
    ? Math.floor(Number(jm.max)) : DEFAULT_MAX;

  const state = queueStateFor(groupId);
  const job = state.tail.then(async () => {
    try {
      // ② 冷却只在**搜本**上拦、只在**成功**时记（见文件头 ②）。
      const cooldownMs = Number.isFinite(Number(jm.cooldownMs)) ? Math.max(0, Number(jm.cooldownMs)) : DEFAULT_COOLDOWN_MS;
      const startedAt = Number(now());
      if (parsed.action === 'search' && state.lastSearchAt !== null
        && startedAt - state.lastSearchAt < cooldownMs) {
        const wait = Math.ceil((cooldownMs - (startedAt - state.lastSearchAt)) / 1000);
        log.info(`JM：群 ${groupId.slice(0, 8)}… 冷却中（还要 ${wait}s）`);
        await reply(pickLine('cooldown'));
        return { ok: false, reason: 'cooldown' };
      }

      /** spawn 一次抓取器并解析最后一行 JSON。 */
      const callFetch = async (args) => {
        const env = { ...process.env };
        const fetched = await runFetch({
          args: [FETCH_SCRIPT, ...args],
          env,
          // 子进程硬超时比 CLI 自己的预算多给 15s：让 CLI 有机会把超时写成 JSON 再退出。
          timeoutMs: timeoutMs + 15_000,
          cwd: ROOT_DIR,
        });
        if (fetched?.timedOut) log.warn('JM：抓取器超时被杀');
        if (fetched?.stderr) {
          const tail = String(fetched.stderr).trim().split(/\r?\n/u).slice(-3).join(' / ');
          if (tail) log.debug(`JM抓取日志：${tail}`);
        }
        return { fetched, payload: lastJsonLine(fetched?.stdout) };
      };

      /** 抓取失败 → 按 reason 挑固定话术（边车不可用/超时/子进程输出坏了/其它）。 */
      const replyFetchFailure = async (payload, fetched, { download = false } = {}) => {
        // 没有可读 JSON 时区分两种现场：子进程根本没输出（多半没起来/被杀）vs 输出坏了。
        const fallbackReason = fetched?.timedOut
          ? 'timeout'
          : (String(fetched?.stdout ?? '').trim() ? 'bad_payload' : 'service_down');
        const reason = String(payload?.reason ?? fallbackReason);
        const detail = payload?.detail ?? (fetched?.code ? `抓取器退出码 ${fetched.code}` : '没有可读的抓取结果');
        log.warn(`JM：${download ? '下载' : '搜索'}失败（${reason}）：${detail}`);
        if (reason === 'timeout') await reply(pickLine('timeout'));
        else if (reason === 'service_down' || reason === 'http_error') await reply(pickLine('serviceDown'));
        else if (download) await reply(pickLine('downloadFailed'));
        else await reply(pickLine('searchFailed'));
        return { ok: false, reason, action: download ? 'download' : 'search' };
      };

      if (parsed.action === 'search') {
        const count = Math.min(Number.isSafeInteger(parsed.count) && parsed.count > 0 ? parsed.count : maxCount, maxCount);
        // 每次搜索一个临时目录（拼图/封面只能从本地文件上传）；无论成败都清掉。
        const root = String(jm.root ?? '').trim();
        let tempDir = '';
        try {
          if (!root) throw new Error('没有配置 QQBOT_JM_ROOT，无法落临时图片');
          fs.mkdirSync(path.resolve(root), { recursive: true });
          tempDir = fs.mkdtempSync(path.join(path.resolve(root), 'search-'));
        } catch (err) {
          log.error(`JM：建临时目录失败：${err?.message ?? err}`);
          await reply(pickLine('internal'));
          return { ok: false, reason: 'no_root', action: 'search' };
        }
        try {
          const { fetched, payload } = await callFetch([
            '--op', 'search',
            '--q', parsed.keyword,
            '--limit', String(count),
            '--api', apiBase,
            '--out-dir', tempDir,
            '--timeout', String(timeoutMs),
            '--max-bytes', String(maxBytes),
          ]);
          if (!payload || payload.ok !== true) return await replyFetchFailure(payload, fetched);

          const results = Array.isArray(payload.results)
            ? payload.results.filter((item) => item && String(item.id ?? '').trim() !== '')
            : [];
          // 记住最近一次搜索的 rank→id 映射（「下本 序号」用）；失败/空结果不覆盖上一次。
          if (results.length > 0) {
            state.lastResults = results.map((item, index) => ({
              rank: Number(item.rank) || index + 1,
              id: String(item.id),
              title: String(item.title ?? ''),
            }));
          }
          if (results.length === 0) {
            log.info('JM：搜索成功但 0 本');
            await reply(pickLine('noResult'));
            return { ok: false, reason: 'no_result', action: 'search' };
          }

          // ③ 先发图（拼图优先，退到第一张封面），再发短文本。
          const imagePath = String(payload.previewPath || payload.covers?.[0]?.path || '').trim();
          let sent = 0;
          if (imagePath) {
            try {
              const stat = await fs.promises.stat(imagePath);
              if (stat.size > maxBytes) {
                log.warn(`JM：结果图 ${stat.size} 字节超过上限 ${maxBytes}，不发图`);
              } else if (!uploadFile || !sendMedia) {
                log.error('JM：uploadFile/sendMedia 没有注入（src/index.js 应传入 api 的出口）');
              } else {
                const buffer = await fs.promises.readFile(imagePath);
                const fileInfo = await uploadFile({
                  scene: 'group',
                  openid: groupId,
                  fileName: path.basename(imagePath),
                  buffer,
                  fileType: 1,
                });
                seq += 1;
                const usePassive = passiveId !== null && seq <= PASSIVE_SEQ_MAX;
                await sendMedia(usePassive
                  ? { scene: 'group', openid: groupId, fileInfo, msgId: passiveId, msgSeq: seq }
                  : { scene: 'group', openid: groupId, fileInfo });
                sent += 1;
                log.info(`JM：已发结果图（${Math.round(buffer.length / 1024)}KB，${path.basename(imagePath)}）`);
              }
            } catch (err) {
              // 图发不出去不算搜本失败：文本结果仍要送到（用户至少知道编号）。
              log.warn(`JM：结果图没发出去（${imagePath}）：${err?.message ?? err}`);
            }
          }
          if (!imagePath && sent === 0) log.warn('JM：边车没给可用的结果图，只发文本');
          await reply(buildSearchText(results.length));
          state.lastSearchAt = startedAt;
          return { ok: true, reason: 'ok', sent, action: 'search' };
        } finally {
          // 临时图片只服务这一次发送；发完/失败都清掉（删不掉只 warn）。
          if (tempDir) {
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (err) {
              log.warn(`JM：临时目录没删掉（${tempDir}）：${err?.message ?? err}`);
            }
          }
        }
      }

      // —— 下本 ——
      let id = String(parsed.target ?? '').trim();
      if (!id) {
        const ordinal = Number(parsed.ordinal);
        const entry = Number.isSafeInteger(ordinal) ? state.lastResults[ordinal - 1] : null;
        if (!entry) {
          log.info(`JM：下本序号 ${ordinal} 没有对应的搜索结果`);
          await reply(state.lastResults.length === 0 ? pickLine('noSearch') : pickLine('ordinalMissing'));
          return { ok: false, reason: 'ordinal_missing', action: 'download' };
        }
        id = entry.id;
        log.info(`JM：序号 ${ordinal} → 编号 ${id}（${entry.title || '无标题'}）`);
      }

      const { fetched, payload } = await callFetch([
        '--op', 'download',
        '--id', id,
        '--api', apiBase,
        '--timeout', String(timeoutMs),
      ]);
      if (!payload || payload.ok !== true) return await replyFetchFailure(payload, fetched, { download: true });

      const viewerUrl = String(payload.viewerUrl ?? '').trim();
      if (!viewerUrl) {
        // 契约要求 done 时带 viewer_url；没有就**不假装成功**（用户要的是能看的链接）。
        log.warn(`JM：下载完成但没有 viewer_url（id=${id}）`);
        await reply(pickLine('downloadFailed'));
        return { ok: false, reason: 'no_viewer_url', action: 'download' };
      }
      // 序号映射保留：同一批可以接着下别的（再下一次要等边车队列，不吃冷却）。
      await reply(buildDownloadText(payload.title, viewerUrl));
      return { ok: true, reason: 'ok', sent: 0, action: 'download' };
    } catch (err) {
      log.error('JM：处理失败', err);
      await reply(pickLine('internal'));
      return { ok: false, reason: 'internal', action: parsed?.action };
    }
  });

  // 队列尾巴只用来衔接，失败不能把后一条堵死。
  state.tail = job.then(() => {}, () => {});
  return job;
}
