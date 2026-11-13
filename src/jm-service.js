/**
 * 「搜本/下本」的**服务层**（2026-11-12；1.210.3 加编号精确解析与单元本清单）。
 *
 * 形态（主人 2026-11-12 拍板 + 当晚现场修正）：
 *
 *   · 搜本 <关键词>  → 边车搜索：
 *       - 恰好 1 本（站点 total=1、没显式写数量、且这本只有 1 个单元）→ 下载 + 整本 PDF 发群；
 *       - 多本 → 回**文字清单**（序号 + JM 编号 + 作品标题）；
 *       - 0 本 → 固定话术。
 *   · 搜本 <纯数字编号> → **不走站内关键词搜索**，先按编号精确解析（`/resolve`）：
 *       - 解析成作品、只有 1 个单元 → 下载发 PDF；
 *       - 解析成作品、有多个单元本 → 回**单元清单**问下载哪一条（不整本下载）；
 *       - 解析成单元（章节）→ 回所属作品的单元清单，并标出「你要的是第 N 个」；
 *       - 查不到 → 固定话术（不拿搜索兜底）。
 *   · 下本 <编号> → 同上精确解析；解析成单元就直接只下该单元；解析成多单元作品就先列清单。
 *   · 下本 <序号> → 取本群**最近一次清单**：有单元清单先按单元清单，否则按上次搜索结果。
 *   · 多单元作品默认**先清单、后下载**，不无提示自动整本。
 *   · 整本打包 / 打包1 3 5 7 → 显式选择本群最近单元清单全部/部分，逐单元下载后只发一个合并 PDF。
 *
 * 为什么 1.210.3 要改（2026-11-12 现场）：
 *   1.210.2 把「纯数字」当关键词丢给站内搜索，JM 对某些编号会回一个**无关作品**（搜 1205081
 *   出来 1195659），单命中又直接整本下载 → 39MB 错本、还超过 120s 超时。编号必须走精确解析，
 *   不能拿搜索兜底；一个作品有多个单元本时必须让用户显式选，不能自动整本打包。
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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_SCRIPT = path.join(ROOT_DIR, 'scripts', 'jm-fetch-one.mjs');

/** 一条入站消息的**被动回复上限**（msg_seq 1..5）。与搬图同一口径，见 `src\meitu-service.js`。 */
const PASSIVE_SEQ_MAX = 5;

/** 默认的搜索数量上限与冷却（配置缺省时的兜底；真实值来自 `config.jm`）。 */
const DEFAULT_MAX = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** QQ 群文件（file_type=4）硬限 200MB；边车自己的 PDF 目标体积更小，这里只做最后一道闸。 */
const JM_PDF_HARD_MAX = 200 * 1024 * 1024;

/** 多本清单里标题最多保留多少字（再长会撑爆消息，也不方便看）。 */
const SEARCH_LIST_TITLE_CHARS = 60;

/** 单元清单一次最多列多少条；旧下本序号只到 9，打包序号不受此限制。 */
const UNIT_LIST_LIMIT = 15;
const UNIT_LIST_TITLE_CHARS = 20;

/** 纯数字关键词 = 编号（作品 id 或单元 id），走精确解析而不是站内搜索。 */
const NUMERIC_ID_RE = /^\d{1,12}$/u;

/**
 * 固定回话的默认句库。**失败路径只从这里挑句子**（不调模型、不临时编）：
 * 句子里不提内部路径/API，只说用户能采取的动作。
 */
export const DEFAULT_JM_LINES = Object.freeze({
  /** 群不在白名单（含空名单）。 */
  groupDisabled: ['这个群没开 JM 搜本。'],
  /** 格式提示：解析失败但确实像在写这条指令。 */
  format: ['格式：搜本 <关键词或编号>；下本 <编号或序号>；整本打包；打包1 3 5 7。'],
  /** 打包只能针对本群最近展示的单元清单，不能借用别群或搜索结果。 */
  noUnits: ['先搜本或下本查看单元清单，再发「整本打包」或「打包1 3 5 7」。'],
  packInvalid: ['打包序号不对：请只填当前单元清单内的正整数序号，用空格分隔。'],
  /** 边车未声明 units 能力：旧边车会把 ?units= 静默当整本，不能冒险下载。 */
  packUnsupported: ['JM 边车还是旧版，暂时不能合并打包；先让管理员升级边车。'],
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
  ordinalMissing: ['这个序号不对：先看清单，或直接发「下本 <编号>」。'],
  /** 编号在 JM 里解析不出来（不存在/不是作品或单元编号）。 */
  noSuchId: ['没有这个编号：JM 里找不到这本。'],
  /** PDF 没拿到 / 上传或发送失败（含平台内容审核拦下）。 */
  pdfFailed: ['文件没发出去，稍后再试。'],
  /** PDF 超过平台上限。 */
  pdfTooLarge: ['整本文件太大，发不了。'],
  /** 兜底异常。 */
  internal: ['JM 处理出错了，稍后再试。'],
});

/** 没注入 log 时的静默实现（单测可以完全不传）。 */
const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

/** 每个群一条串行队列（同一个人连发两条时，后一条等前一条结束）+ 最近一次清单/搜索结果。 */
const GROUP_QUEUES = new Map();

function queueStateFor(groupId) {
  let state = GROUP_QUEUES.get(groupId);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      /** 上次**成功搜本**的时间（冷却口径；null = 还没成功过）。 */
      lastSearchAt: null,
      /** 最近一次成功的**多本搜索结果**（rank 顺序）：`[{rank, id, title}]`。 */
      lastResults: [],
      /** 最近一次展示给用户的**单元清单**：`{kind:'units', albumId, albumTitle, units:[{index, unitId, title}]}`。 */
      lastChoices: null,
    };
    GROUP_QUEUES.set(groupId, state);
  }
  return state;
}

/**
 * 群白名单判定。**空名单 = 谁都不给（fail closed）**，这是默认且不变的口径。
 *
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

/** 截断动态标题（QQ 文本要短；标题本身可能很长）。 */
function shortTitle(title, max = 20) {
  const text = String(title ?? '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/**
 * 多本搜索结果 → 群里的文字清单：序号 + JM 编号 + 作品标题。
 *
 * @param {Array<{id:string|number, title?:string}>} results
 * @param {{total?: number}} [extra] 站点总命中数（比列表多时在开头写「共 N 本」）
 * @returns {string}
 */
export function buildSearchListText(results, { total = 0 } = {}) {
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
  const siteTotal = Number(total);
  const head = Number.isFinite(siteTotal) && siteTotal > list.length
    ? `搜到${list.length}本（共${siteTotal}本），回复 下本 <编号或序号> 打包整本 PDF：`
    : `搜到${list.length}本，回复 下本 <编号或序号> 打包整本 PDF：`;
  return `${head}\n${lines.join('\n')}`;
}

/**
 * 多单元本清单：序号 + 单元编号(JM<unit_id>) + 单元标题；标明「你要的是第几个」。
 *
 * @param {{albumId:string, albumTitle?:string, units:Array<{index:number,unitId:string,title:string}>,
 *          matchedUnitId?:string|null}} input
 * @returns {string}
 */
export function buildUnitListText({ albumId, albumTitle = '', units, matchedUnitId = null }) {
  const list = Array.isArray(units) ? units : [];
  const shown = list.slice(0, UNIT_LIST_LIMIT);
  const albumName = shortTitle(albumTitle, 30);
  const head = `JM${albumId}${albumName ? `《${albumName}》` : ''}有 ${list.length} 个单元本：`;
  const lines = shown.map((unit, index) => {
    const id = String(unit?.unitId ?? '').trim();
    const title = shortTitle(unit?.title, UNIT_LIST_TITLE_CHARS);
    return `${index + 1}. JM${id}${title ? ` ${title}` : ''}`;
  });
  const matchedIndex = matchedUnitId
    ? list.findIndex((unit) => String(unit?.unitId ?? '') === String(matchedUnitId))
    : -1;
  const matched = matchedIndex >= 0 ? [`你要的是第 ${matchedIndex + 1} 个单元。`] : [];
  const more = list.length > shown.length
    ? [`…还有 ${list.length - shown.length} 个，发单元编号选择`]
    : [];
  const ordinalMax = Math.min(9, list.length);
  const tail = `回复 下本 <序号1-${ordinalMax}> 或 下本 <单元编号>`;
  return [head, ...matched, ...lines, ...more, tail,
    '整本打包（#全部单元）',
    '打包1 3 5 7（#选择单元打包）',
  ].join('\n');
}

/** 下载前的进度回执（带标题与编号；让「编号解析到别的作品」在下载前就暴露）。 */
export function buildDownloadAck(title, id) {
  const name = shortTitle(title, 20);
  const tag = id ? `（JM${id}）` : '';
  return name ? `《${name}》${tag}正在下载打包…` : `${tag || 'JM'}正在下载打包…`;
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
  const maxCount = Number.isFinite(Number(jm.max)) && Number(jm.max) > 0
    ? Math.floor(Number(jm.max)) : DEFAULT_MAX;

  const state = queueStateFor(groupId);
  const job = state.tail.then(async () => {
    /** 本次命令一个临时目录（整本/单元 PDF 都只活这一次）；无论成败都清掉。 */
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
        // 没有可读 JSON 时区分两种现场：子进程根本没输出（多半没起来/被杀）vs 输出坏了。
        const fallbackReason = fetched?.timedOut
          ? 'timeout'
          : (String(fetched?.stdout ?? '').trim() ? 'bad_payload' : 'service_down');
        const reason = String(payload?.reason ?? fallbackReason);
        const detail = payload?.detail ?? (fetched?.code ? `抓取器退出码 ${fetched.code}` : '没有可读的抓取结果');
        log.warn(`JM：${download ? '下载' : '搜索'}失败（${reason}）：${detail}`);
        if (reason === 'not_found') await reply(pickLine('noSuchId'));
        else if (reason === 'timeout') await reply(pickLine('timeout'));
        else if (reason === 'service_down' || reason === 'http_error') await reply(pickLine('serviceDown'));
        else if (download) await reply(pickLine('downloadFailed'));
        else await reply(pickLine('searchFailed'));
        return { ok: false, reason, action: download ? 'download' : 'search' };
      };

      /** 按编号精确解析（作品或单元）；**绝不**走站内搜索。 */
      const resolveNumber = async (number) => callFetch([
        '--op', 'resolve',
        '--id', String(number),
        '--api', apiBase,
        '--timeout', String(timeoutMs),
      ]);

      /** 展示单元清单 + 记住选择状态（后续「下本 <序号/单元编号>」用）。 */
      const showUnitList = async ({ albumId, albumTitle = '', units, matchedUnitId = null, action = 'search' }) => {
        const list = (Array.isArray(units) ? units : [])
          .map((unit, index) => ({
            index: Number(unit?.index) || index + 1,
            unitId: String(unit?.unitId ?? ''),
            title: String(unit?.title ?? ''),
          }))
          .filter((unit) => unit.unitId !== '');
        state.lastChoices = {
          kind: 'units',
          albumId: String(albumId ?? ''),
          albumTitle: String(albumTitle ?? ''),
          units: list,
        };
        state.lastResults = [];
        await reply(buildUnitListText({ albumId, albumTitle, units: list, matchedUnitId }));
        return { ok: true, reason: 'choose_unit', sent: 0, action };
      };

      /**
       * 下载一本（或其中一个单元）→ 边车生成/缓存 PDF → 上传成 QQ 群文件 → 发文件。
       * 返回 {ok:true, title, bytes} 或 {ok:false, reason}（失败时固定话术已经回过）。
       */
      const sendAlbumPdf = async (albumId, { unitId = null, unitIds = null, titleHint = '', idForName = '' } = {}) => {
        if (!uploadFile || !sendMedia) {
          log.error('JM：uploadFile/sendMedia 没有注入（src/index.js 应传入 api 的出口）');
          await reply(pickLine('internal'));
          return { ok: false, reason: 'no_sender' };
        }
        // 选集严格逐单元复用既有 download API；全部成功后才请求一次合并 PDF。
        // 不能先取 PDF 再补下载，也不能某单元失败后发残缺选集。
        let title = String(titleHint ?? '');
        let unitKey = String(unitId ?? '').trim();
        for (const selectedId of unitIds ?? [unitId]) {
          const downloadArgs = [
            '--op', 'download',
            '--id', String(albumId),
            '--api', apiBase,
            '--timeout', String(timeoutMs),
          ];
          if (selectedId) downloadArgs.push('--unit', String(selectedId));
          const download = await callFetch(downloadArgs);
          if (!download.payload || download.payload.ok !== true) {
            return await replyFetchFailure(download.payload, download.fetched, { download: true });
          }
          if (!unitIds) {
            title = String(download.payload.title ?? titleHint ?? '');
            unitKey = String(download.payload.unit ?? unitId ?? '').trim();
          }
        }

        const pdfArgs = [
          '--op', 'pdf',
          '--id', String(albumId),
          '--api', apiBase,
          '--out-dir', tempDir,
          '--timeout', String(timeoutMs),
        ];
        if (unitIds) pdfArgs.push('--units', unitIds.join(','));
        else if (unitId) pdfArgs.push('--unit', String(unitId));
        const pdf = await callFetch(pdfArgs);
        if (!pdf.payload || pdf.payload.ok !== true) {
          log.warn(`JM：PDF 没拿到（id=${albumId}${unitId ? ` unit=${unitId}` : ''}）：${pdf.payload?.reason ?? 'unknown'} ${pdf.payload?.detail ?? ''}`);
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

        // 选集使用独立命名空间：即使只选一单元或显式全选，也不撞单元/旧整本文件。
        const fileKey = unitIds
          ? `${albumId}-pack-${createHash('sha256').update(unitIds.join(',')).digest('hex').slice(0, 16)}`
          : unitKey || String(idForName || albumId);
        try {
          const fileInfo = await uploadFile({
            scene: 'group',
            openid: groupId,
            // 通用文件名：不带作品标题（平台审出站内容，标题不必进文件名）。
            fileName: `JM${fileKey}.pdf`,
            buffer,
            fileType: 4,
          });
          seq += 1;
          const usePassive = passiveId !== null && seq <= PASSIVE_SEQ_MAX;
          await sendMedia(usePassive
            ? { scene: 'group', openid: groupId, fileInfo, msgId: passiveId, msgSeq: seq }
            : { scene: 'group', openid: groupId, fileInfo });
          log.info(`JM：已发${unitIds ? '选集' : unitKey ? '单元' : '整本'} PDF（JM${fileKey}.pdf，${Math.round(buffer.length / 1024)}KB）`);
        } catch (err) {
          // 含平台内容审核（40034006）与按天容量上限（40093002）等 —— 都收口成固定话术。
          log.warn(`JM：PDF 没发出去（id=${albumId}${unitId ? ` unit=${unitId}` : ''}）：${err?.message ?? err}`);
          await reply(pickLine('pdfFailed'));
          return { ok: false, reason: 'pdf_send_failed' };
        }

        // 成功时不补任何说明：结果就是文件本身；只有失败才回固定话术。
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

        const keyword = String(parsed.keyword ?? '').trim();
        // ③ 纯数字 = 编号：精确解析，不走站内关键词搜索（1.210.2 的错本就出在这）。
        if (NUMERIC_ID_RE.test(keyword)) {
          const { fetched, payload } = await resolveNumber(keyword);
          if (!payload || payload.ok !== true) return await replyFetchFailure(payload, fetched);
          const album = payload.album && typeof payload.album === 'object' ? payload.album : {};
          const units = Array.isArray(album.units) ? album.units : [];
          const matched = payload.matchedUnit && typeof payload.matchedUnit === 'object' ? payload.matchedUnit : null;
          if (units.length > 1) {
            state.lastSearchAt = startedAt;
            return await showUnitList({
              albumId: album.id || keyword,
              albumTitle: album.title || '',
              units,
              matchedUnitId: matched?.unitId ?? null,
              action: 'search',
            });
          }
          const title = String(matched?.title || album.title || '');
          const downloadUnit = matched?.unitId ? String(matched.unitId) : null;
          const targetId = String(album.id || keyword);
          await reply(buildDownloadAck(title, downloadUnit || targetId));
          const sent = await sendAlbumPdf(targetId, {
            unitId: downloadUnit,
            titleHint: title,
            idForName: downloadUnit || targetId,
          });
          if (sent.ok !== true) return { ok: false, reason: sent.reason ?? 'download_failed', action: 'search' };
          state.lastSearchAt = startedAt;
          return { ok: true, reason: 'ok', sent: 1, action: 'search' };
        }

        // ④ 关键词搜索：不再要图（--images 0），也不发拼图/封面。
        const count = Math.min(Number.isSafeInteger(parsed.count) && parsed.count > 0 ? parsed.count : maxCount, maxCount);
        const { fetched, payload } = await callFetch([
          '--op', 'search',
          '--q', keyword,
          '--limit', String(count),
          '--api', apiBase,
          '--images', '0',
          '--timeout', String(timeoutMs),
        ]);
        if (!payload || payload.ok !== true) return await replyFetchFailure(payload, fetched);

        const results = Array.isArray(payload.results)
          ? payload.results.filter((item) => item && String(item.id ?? '').trim() !== '')
          : [];
        const siteTotal = Number.isFinite(Number(payload.total)) ? Number(payload.total) : 0;
        // total=0 却有结果：多半是边车把「0 结果页」的推荐位当成了结果（1.210.2 现场同类），按 0 本收口。
        if (results.length === 0 || siteTotal === 0) {
          if (results.length > 0) {
            log.warn(`JM：搜索 total=0 但有 ${results.length} 条结果，按 0 本处理（疑似推荐位冒充）`);
          }
          state.lastResults = [];
          state.lastChoices = null;
          log.info('JM：搜索成功但 0 本');
          await reply(pickLine('noResult'));
          return { ok: false, reason: 'no_result', action: 'search' };
        }

        const autoSingle = results.length === 1 && siteTotal === 1 && !parsed.countGiven;
        if (autoSingle) {
          const hit = results[0];
          // 单本也要先解析单元：多单元作品不能整本下。
          const resolved = await resolveNumber(hit.id);
          if (!resolved.payload || resolved.payload.ok !== true) {
            return await replyFetchFailure(resolved.payload, resolved.fetched);
          }
          const album = resolved.payload.album && typeof resolved.payload.album === 'object' ? resolved.payload.album : {};
          const units = Array.isArray(album.units) ? album.units : [];
          if (units.length > 1) {
            state.lastSearchAt = startedAt;
            return await showUnitList({
              albumId: album.id || hit.id,
              albumTitle: album.title || hit.title || '',
              units,
              matchedUnitId: null,
              action: 'search',
            });
          }
          const title = String(album.title || hit.title || '');
          const targetId = String(album.id || hit.id);
          await reply(buildDownloadAck(title, targetId));
          const sent = await sendAlbumPdf(targetId, { unitId: null, titleHint: title, idForName: targetId });
          if (sent.ok !== true) return { ok: false, reason: sent.reason ?? 'download_failed', action: 'search' };
          state.lastSearchAt = startedAt;
          return { ok: true, reason: 'ok', sent: 1, action: 'search' };
        }

        // ⑤ 多本（或「单本但不是唯一命中」）→ 只回文字清单，记住选择状态。
        state.lastResults = results.map((item, index) => ({
          rank: Number(item.rank) || index + 1,
          id: String(item.id),
          title: String(item.title ?? ''),
        }));
        state.lastChoices = null;
        await reply(buildSearchListText(results, { total: siteTotal }));
        state.lastSearchAt = startedAt;
        return { ok: true, reason: 'ok', sent: 0, action: 'search' };
      }

      if (parsed.action === 'pack') {
        const choice = state.lastChoices;
        if (!choice || choice.kind !== 'units' || !choice.units.length) {
          await reply(pickLine('noUnits'));
          return { ok: false, reason: 'no_units', action: 'pack' };
        }
        // 全量校验必须发生在进度回执和任何下载前；不容许只校验到第一个合法项就开下。
        const ranks = parsed.ordinals;
        const valid = typeof parsed.all === 'boolean' && Array.isArray(ranks)
          && (parsed.all ? ranks.length === 0 : ranks.length > 0)
          && Array.from(ranks).every((rank) => Number.isSafeInteger(rank) && rank >= 1 && rank <= choice.units.length);
        if (!valid) {
          await reply(pickLine('packInvalid'));
          return { ok: false, reason: 'ordinal_missing', action: 'pack' };
        }
        const wanted = new Set(ranks);
        // 按清单顺序选，不按用户输入顺序；按 ID 去重，不推断/补选生肉熟肉。
        const unitIds = [...new Set(choice.units
          .filter((_, index) => parsed.all || wanted.has(index + 1))
          .map((unit) => String(unit.unitId ?? '')))];
        const albumId = String(choice.albumId ?? '');
        if (!/^[1-9]\d{0,11}$/u.test(albumId)
          || unitIds.length === 0 || unitIds.some((id) => !/^[1-9]\d{0,11}$/u.test(id))) {
          await reply(pickLine('packInvalid'));
          return { ok: false, reason: 'invalid_units', action: 'pack' };
        }
        // 边车能力闸（2026-11-13 部署时加）：旧边车不认 ?units=，会静默回整本/404，
        // 必须先在读任何单元、发任何进度前拒绝，绝不把"所选生肉"变成整本混排。
        const health = await callFetch(['--op', 'health', '--api', apiBase, '--timeout', String(timeoutMs)]);
        const caps = Array.isArray(health.payload?.capabilities) ? health.payload.capabilities : [];
        if (!health.payload || health.payload.ok !== true || !caps.includes('units')) {
          log.warn(`JM：边车不支持 units 合并（capabilities=${JSON.stringify(caps)}），拒绝打包`);
          await reply(pickLine('packUnsupported'));
          return { ok: false, reason: 'pack_unsupported', action: 'pack' };
        }
        await reply(buildDownloadAck(`${choice.albumTitle || '所选单元'}（${unitIds.length}个单元）`, albumId));
        const sent = await sendAlbumPdf(albumId, { unitIds, titleHint: choice.albumTitle });
        if (!sent.ok) return { ok: false, reason: sent.reason ?? 'download_failed', action: 'pack' };
        return { ok: true, reason: 'ok', sent: 1, action: 'pack' };
      }

      // —— 下本 ——
      let albumId = '';
      let unitId = null;
      let titleHint = '';
      let ackId = '';
      const directId = String(parsed.target ?? '').trim();
      if (directId) {
        const { fetched, payload } = await resolveNumber(directId);
        if (!payload || payload.ok !== true) return await replyFetchFailure(payload, fetched, { download: true });
        const album = payload.album && typeof payload.album === 'object' ? payload.album : {};
        const units = Array.isArray(album.units) ? album.units : [];
        const matched = payload.matchedUnit && typeof payload.matchedUnit === 'object' ? payload.matchedUnit : null;
        if (payload.kind === 'photo' && matched?.unitId) {
          // 给的本身就是单元编号：只下这一单元，不需要再问。
          albumId = String(album.id || '');
          unitId = String(matched.unitId);
          titleHint = String(matched.title || album.title || '');
          ackId = unitId;
        } else if (units.length > 1) {
          return await showUnitList({
            albumId: album.id || directId,
            albumTitle: album.title || '',
            units,
            matchedUnitId: null,
            action: 'download',
          });
        } else {
          albumId = String(album.id || directId);
          unitId = null;
          titleHint = String(album.title || '');
          ackId = albumId;
        }
      } else {
        const ordinal = Number(parsed.ordinal);
        const choice = state.lastChoices;
        if (choice && choice.kind === 'units') {
          const unit = Number.isSafeInteger(ordinal) ? choice.units[ordinal - 1] : null;
          if (!unit) {
            log.info(`JM：下本序号 ${ordinal} 不在最近一次单元清单里`);
            await reply(pickLine('ordinalMissing'));
            return { ok: false, reason: 'ordinal_missing', action: 'download' };
          }
          albumId = String(choice.albumId || '');
          unitId = String(unit.unitId);
          titleHint = String(unit.title || choice.albumTitle || '');
          ackId = unitId;
        } else {
          const entry = Number.isSafeInteger(ordinal) ? state.lastResults[ordinal - 1] : null;
          if (!entry) {
            log.info(`JM：下本序号 ${ordinal} 没有对应的搜索结果`);
            await reply(state.lastResults.length === 0 ? pickLine('noSearch') : pickLine('ordinalMissing'));
            return { ok: false, reason: 'ordinal_missing', action: 'download' };
          }
          // 清单里的编号可能是多单元作品：先解析，多单元就先列清单再让用户选。
          const { fetched, payload } = await resolveNumber(entry.id);
          if (!payload || payload.ok !== true) return await replyFetchFailure(payload, fetched, { download: true });
          const album = payload.album && typeof payload.album === 'object' ? payload.album : {};
          const units = Array.isArray(album.units) ? album.units : [];
          if (units.length > 1) {
            return await showUnitList({
              albumId: album.id || entry.id,
              albumTitle: album.title || entry.title || '',
              units,
              matchedUnitId: null,
              action: 'download',
            });
          }
          albumId = String(album.id || entry.id);
          unitId = null;
          titleHint = String(album.title || entry.title || '');
          ackId = albumId;
        }
      }

      if (!albumId) {
        log.error('JM：下本没有解析出作品编号');
        await reply(pickLine('internal'));
        return { ok: false, reason: 'no_album', action: 'download' };
      }

      await reply(buildDownloadAck(titleHint, ackId));
      const sent = await sendAlbumPdf(albumId, {
        unitId,
        titleHint,
        idForName: unitId || albumId,
      });
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
