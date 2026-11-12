/**
 * 「搜本/下本」的**服务层**（2026-11-12）。
 *
 * 2026-11-12 主人拍板的形态：**搜本/下本单本合并，搜到即下载；搜多本给清单**。
 *
 *   · 搜本 <关键词> [数量] → 边车搜索：
 *       - 恰好 1 本：立刻「下载 → 生成整本 PDF → 把 PDF 文件发到群」（搜本+下本合并）；
 *       - 多本：只回**文字清单**（序号 + JM 编号 + 作品标题），提示用「下本 <编号或序号>」；
 *       - 0 本：固定话术。
 *   · 下本 <编号> / 下本 <序号> → 下载该本 → 生成整本 PDF → 发 PDF 文件。
 *   · 整条链路不经过模型；失败一律固定话术。
 *
 * 为什么不再发拼图/阅读链接：
 *   · 2026-11-12 实测：QQ 把搜本结果拼图按 `40034006 消息内容违规` 拦了（图片出口有内容审核）；
 *   · 阅读链接指向本机 `127.0.0.1:8088`，群友设备打不开；把阅读器挂公网又有泄露面；
 *   · PDF 走 `file_type=4`（群文件，平台软/硬限 200MB），bot 的「聊天记录搬运」已经用同一套
 *     `uploadFile` + `sendMedia` 发过 PDF；文件名用通用 `JM<id>.pdf`，不带作品标题。
 *
 * 分工（与搬图子系统同构）：
 *   · `src\jm-command.js` 纯解析群消息；
 *   · `scripts\jm-fetch-one.mjs` 子进程里调**本机 JM 边车服务**（网络只在它里面发生）；
 *   · **本文件**串起来：群白名单 → 按群串行 → 冷却 → spawn 抓取器 → 上传/发送。
 *
 * 刻意的边界：
 *   ① 默认关闭、群白名单 fail closed（空名单 = 谁都不给，一次都不 spawn）；
 *   ② 冷却只拦搜本、只记成功；下本是用户看完清单后的下一步，不拦；
 *   ③ 失败只从固定句库挑话（含 PDF 没拿到/没发出去）；上传发送失败不假装成功；
 *   ④ 依赖全部可注入（deps），单测用假 runFetch / 假上传，不碰网络、不碰真 QQ、不写真 data/。
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

/** QQ 群文件（file_type=4）硬限 200MB；边车自己的 PDF 目标体积更小，这里只做最后一道闸。 */
const JM_PDF_HARD_MAX = 200 * 1024 * 1024;

/** 多本清单里标题最多保留多少字（再长会撑爆消息，也不方便看）。 */
const SEARCH_LIST_TITLE_CHARS = 60;

/**
 * 固定回话的默认句库。**失败路径只从这里挑句子**（不调模型、不临时编）：
 * 句子里不提内部路径/API，只说用户能采取的动作。
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
  /** PDF 没拿到 / 上传或发送失败（含平台内容审核拦下）。 */
  pdfFailed: ['文件没发出去，稍后再试。'],
  /** PDF 超过平台上限。 */
  pdfTooLarge: ['整本文件太大，发不了。'],
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

/**
 * 群白名单判定。**空名单 = 谁都不给（fail closed）**，这是默认且不变的口径。
 * 显式「全部群」只有一种写法：名单里含 `*`。
 */
function allowGroup(groups, groupId) {
  if (groups instanceof Set) return groups.has('*') || groups.has(groupId);
  if (Array.isArray(groups)) return groups.includes('*') || groups.includes(groupId);
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

/**
 * 多本搜索结果 → 群里的文字清单：序号 + JM 编号 + 作品标题。
 * 清单就是「下本 <编号或序号>」的输入；不发图、不发链接。
 *
 * @param {Array<{id:string|number, title?:string}>} results
 * @returns {string}
 */
export function buildSearchListText(results) {
  const list = Array.isArray(results) ? results : [];
  const lines = list.map((item, index) => {
    const id = String(item?.id ?? '').trim();
    const rawTitle = String(item?.title ?? '').replace(/\s+/gu, ' ').trim();
    const chars = Array.from(rawTitle);
    const title = chars.length > SEARCH_LIST_TITLE_CHARS
      ? `${chars.slice(0, SEARCH_LIST_TITLE_CHARS).join('')}…`
      : rawTitle;
    return `${index + 1}. JM${id}${title ? ` ${title}` : ''}`;
  });
  const head = `搜到${list.length}本，回复 下本 <编号或序号> 打包整本 PDF：`;
  return `${head}\n${lines.join('\n')}`;
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
  /** 被动槽位记账：文本/文件回话接着彼此的 msg_seq 往下数（与搬图同一口径）。 */
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
    /** 本次命令一个临时目录（搜索结果图、整本 PDF 都只活这一次）；无论成败都清掉。 */
    let tempDir = '';
    try {
      try {
        const root = String(jm.root ?? '').trim();
        if (!root) throw new Error('没有配置 QQBOT_JM_ROOT，无法落临时文件');
        fs.mkdirSync(path.resolve(root), { recursive: true });
        tempDir = fs.mkdtempSync(path.join(path.resolve(root), 'jm-'));
      } catch (err) {
        log.error(`JM：建临时目录失败：${err?.message ?? err}`);
        await reply(pickLine('internal'));
        return { ok: false, reason: 'no_root', action: parsed.action };
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

      /**
       * 下载一本 → 边车生成/缓存整本 PDF → 上传成 QQ 群文件 → 发文件 + 一句短标题。
       * 返回 {ok:true, title, bytes} 或 {ok:false, reason}（失败时固定话术已经回过）。
       */
      const sendAlbumPdf = async (albumId, { titleHint = '' } = {}) => {
        if (!uploadFile || !sendMedia) {
          log.error('JM：uploadFile/sendMedia 没有注入（src/index.js 应传入 api 的出口）');
          await reply(pickLine('internal'));
          return { ok: false, reason: 'no_sender' };
        }
        const download = await callFetch([
          '--op', 'download',
          '--id', albumId,
          '--api', apiBase,
          '--timeout', String(timeoutMs),
        ]);
        if (!download.payload || download.payload.ok !== true) {
          return await replyFetchFailure(download.payload, download.fetched, { download: true });
        }
        const title = String(download.payload.title ?? titleHint ?? '');

        const pdf = await callFetch([
          '--op', 'pdf',
          '--id', albumId,
          '--api', apiBase,
          '--out-dir', tempDir,
          '--timeout', String(timeoutMs),
        ]);
        if (!pdf.payload || pdf.payload.ok !== true) {
          log.warn(`JM：整本 PDF 没拿到（id=${albumId}）：${pdf.payload?.reason ?? 'unknown'} ${pdf.payload?.detail ?? ''}`);
          await reply(pickLine('pdfFailed'));
          return { ok: false, reason: 'pdf_failed' };
        }
        const pdfPath = String(pdf.payload.path ?? '');
        let buffer;
        try {
          const stat = await fs.promises.stat(pdfPath);
          if (stat.size > JM_PDF_HARD_MAX) {
            log.warn(`JM：PDF ${stat.size} 字节超过平台上限 ${JM_PDF_HARD_MAX}`);
            await reply(pickLine('pdfTooLarge'));
            return { ok: false, reason: 'pdf_too_large' };
          }
          buffer = await fs.promises.readFile(pdfPath);
        } catch (err) {
          log.warn(`JM：读 PDF 失败（${pdfPath}）：${err?.message ?? err}`);
          await reply(pickLine('pdfFailed'));
          return { ok: false, reason: 'pdf_read_failed' };
        }

        try {
          const fileInfo = await uploadFile({
            scene: 'group',
            openid: groupId,
            // 通用文件名：不带作品标题（平台审出站内容，标题不必进文件名）。
            fileName: `JM${albumId}.pdf`,
            buffer,
            fileType: 4,
          });
          seq += 1;
          const usePassive = passiveId !== null && seq <= PASSIVE_SEQ_MAX;
          await sendMedia(usePassive
            ? { scene: 'group', openid: groupId, fileInfo, msgId: passiveId, msgSeq: seq }
            : { scene: 'group', openid: groupId, fileInfo });
          log.info(`JM：已发整本 PDF（JM${albumId}.pdf，${Math.round(buffer.length / 1024)}KB）`);
        } catch (err) {
          // 含平台内容审核（40034006）与按天容量上限（40093002）等 —— 都收口成固定话术。
          log.warn(`JM：PDF 没发出去（id=${albumId}）：${err?.message ?? err}`);
          await reply(pickLine('pdfFailed'));
          return { ok: false, reason: 'pdf_send_failed' };
        }

        // 成功时不补任何说明：结果就是文件本身；只有失败才回固定话术。
        // （主人 2026-11-12：「正常有结果的时候不用在给出结果之后接一句已打包…」）
        return { ok: true, title, bytes: buffer.length };
      };

      if (parsed.action === 'search') {
        // ② 冷却只在**搜本**上拦、只在**成功**时记（见文件头 ②）。
        const cooldownMs = Number.isFinite(Number(jm.cooldownMs)) ? Math.max(0, Number(jm.cooldownMs)) : DEFAULT_COOLDOWN_MS;
        const startedAt = Number(now());
        if (state.lastSearchAt !== null && startedAt - state.lastSearchAt < cooldownMs) {
          const wait = Math.ceil((cooldownMs - (startedAt - state.lastSearchAt)) / 1000);
          log.info(`JM：群 ${groupId.slice(0, 8)}… 冷却中（还要 ${wait}s）`);
          await reply(pickLine('cooldown'));
          return { ok: false, reason: 'cooldown' };
        }

        const count = Math.min(Number.isSafeInteger(parsed.count) && parsed.count > 0 ? parsed.count : maxCount, maxCount);
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

        // ③ 单本：搜本+下本合并 —— 立刻下载、打包 PDF、发文件。
        if (results.length === 1) {
          const only = state.lastResults[0];
          await reply('搜到1本，正在下载打包…');
          const sent = await sendAlbumPdf(only.id, { titleHint: only.title });
          if (sent.ok !== true) return { ok: false, reason: sent.reason ?? 'pdf_failed', action: 'search' };
          state.lastSearchAt = startedAt;
          return { ok: true, reason: 'ok', sent: 1, action: 'search' };
        }

        // ④ 多本：只回文字清单（JM 编号 + 作品标题 + 序号），不发图、不发链接。
        await reply(buildSearchListText(results));
        state.lastSearchAt = startedAt;
        return { ok: true, reason: 'ok', sent: 0, action: 'search' };
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

      await reply(`正在下载打包 JM${id}…`);
      const sent = await sendAlbumPdf(id);
      if (sent.ok !== true) return { ok: false, reason: sent.reason ?? 'download_failed', action: 'download' };
      return { ok: true, reason: 'ok', sent: 1, action: 'download' };
    } catch (err) {
      log.error('JM：处理失败', err);
      await reply(pickLine('internal'));
      return { ok: false, reason: 'internal', action: parsed?.action };
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (err) {
          log.warn(`JM：临时目录没删掉（${tempDir}）：${err?.message ?? err}`);
        }
      }
    }
  });

  // 队列尾巴只用来衔接，失败不能把后一条堵死。
  state.tail = job.then(() => {}, () => {});
  return job;
}
