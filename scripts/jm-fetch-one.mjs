#!/usr/bin/env node
/**
 * JM 搜本/下本的**网络边界**（2026-11-12，独立 CLI）。
 *
 * 与 `scripts\meitu-fetch-one.mjs` 同构：bot 把它当子进程 spawn（`src\jm-service.js`），
 * 它只做三件事：
 *   ① 用 Node 内置 `fetch` 调**本机 JM 边车服务**（HTTP，默认 `http://127.0.0.1:8790`）；
 *   ② 把搜索结果里的**拼图/封面图**下载到调用方给的临时目录（QQ 上传只认本地文件路径）；
 *   ③ 把结果写成 stdout **最后一行** JSON，日志一律走 stderr。
 *
 * 边车是唯一碰 JM/网络/漫画库的进程（部署与 API 契约见 `docs\45-JM搜本.md`）。
 * 本文件**不 import 任何 src/ 模块**：它保持"可单独跑、只依赖 Node 内置模块"的形状，
 * 方便部署者用 `node scripts\jm-fetch-one.mjs --op health` 自查。
 *
 * 用法：
 *
 *     node scripts\jm-fetch-one.mjs --op health --api http://127.0.0.1:8790
 *     node scripts\jm-fetch-one.mjs --op search --q 全彩 --limit 3 \
 *       --api http://127.0.0.1:8790 --out-dir %TEMP%\jm-search --timeout 120000
 *     node scripts\jm-fetch-one.mjs --op download --id 1490076 \
 *       --api http://127.0.0.1:8790 --timeout 120000
 *     node scripts\jm-fetch-one.mjs --op pdf --id 1490076 \
 *       --api http://127.0.0.1:8790 --out-dir %TEMP%\jm-pdf --timeout 180000
 *
 * 参数：
 *   --op search|download|pdf|health  必填（分别对应边车的 /search、/download+/jobs、/pdf、/health）
 *   --q <关键词>                 search 必填，1..60 字符
 *   --limit N                    search 用，1..5（默认 5；边车契约允许到 10，QQ 侧只给 5）
 *   --id <编号>                  download 必填，纯数字（JM 作品 id）
 *   --api <base>                 边车地址，默认 http://127.0.0.1:8790
 *   --out-dir <dir>              search 必填：图片落到这里（调用方负责清理）
 *   --timeout <ms>               整个操作的**总预算**，默认 120000
 *   --max-bytes N                单张图片上限，默认 10485760（边车默认图也不大，防意外）
 *
 * 成功/失败都输出 JSON（退出码恒 0，调用方只认那条 JSON；可读的失败比"崩了"好排查）：
 *
 *   health   → {"ok":true,"op":"health","service":"jm-service","version":"1.0.0",
 *               "viewerBase":"http://127.0.0.1:8088","downloadedAlbums":12}
 *   search   → {"ok":true,"op":"search","query":"全彩","total":10000,"cached":false,
 *               "text":"1.…","results":[{rank,id,title,authors,tags,pageCount}],
 *               "previewPath":"…\\preview.jpg","previewUrl":"…","covers":[{rank,id,path}]}
 *   download → {"ok":true,"op":"download","id":"1490076","status":"done",
 *               "title":"…","viewerUrl":"http://…/jm_view?path=…","dir":"…"}
 *   pdf      → {"ok":true,"op":"pdf","id":"1490076","path":"…\\JM1490076.pdf","bytes":123456}
 *              （先 POST /download 等到 done 再调；边车按需生成并缓存整本 PDF）
 *   失败     → {"ok":false,"op":"…","reason":"service_down|timeout|bad_json|…",
 *               "detail":"人话"}
 *
 * 失败码：`bad_args`（参数不合法）/ `service_down`（连不上边车）/ `timeout`（整体超时）/
 * `bad_json`（响应不是约定形状）/ `http_error`（边车回 4xx/5xx）/ `api_error`（边车 ok=false）/
 * `download_failed`（下载任务失败）/ `too_large`（图片超上限）/ `bad_image`（不是 JPEG/PNG）/
 * `io_error`（写不进临时目录）/ `internal`（兜底）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'http://127.0.0.1:8790'; // 边车默认端口；部署可改 --api / QQBOT_JM_API
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_PDF_MAX_BYTES = 200 * 1024 * 1024; // QQ file_type=4 的硬限就是 200MB
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 5; // QQ 侧一次最多看 5 本（边车契约允许 10，这里按群聊阅读量收紧）
const MAX_LIMIT_SERVER = 10;
const REQUEST_TIMEOUT_MS = 15_000; // 单次请求上限（整体预算另算）
const POLL_MS = 1_500; // 下载任务轮询间隔
const MAX_KEYWORD_CHARS = 60;

/** 日志一律走 stderr：stdout 只留最后那一行 JSON。 */
const log = (...parts) => {
  try {
    process.stderr.write(`[jm] ${parts.join(' ')}\n`);
  } catch {
    // stderr 写不进去也不影响结果。
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 统一失败体：reason 机器可读，detail 给人看。 */
function fail(reason, detail) {
  return { ok: false, reason: String(reason ?? 'internal'), detail: String(detail ?? '') };
}

/** 边车 base 与相对路径拼绝对 URL（边车回包里的 `cover_http` 是站内绝对路径）。 */
function apiUrl(apiBase, pathname) {
  const base = String(apiBase ?? DEFAULT_API).trim().replace(/\/+$/u, '');
  const suffix = String(pathname ?? '');
  if (/^https?:\/\//iu.test(suffix)) return suffix;
  return `${base}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
}

/** URL/路径里的文件名（去掉查询串/路径分隔符）；拿不到返回空串。 */
function fileNameOf(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const pathname = new URL(raw).pathname;
    return path.posix.basename(decodeURIComponent(pathname));
  } catch {
    // 不是合法 URL（例如边车公式里给的是服务器本机绝对路径 `C:\...\p_1.jpg`）——
    // 按 Windows/POSIX 两种分隔符各取一次 basename，供 `/preview/<文件名>` 兜底。
    const trimmed = raw.split(/[?#]/u)[0];
    const base = path.win32.basename(trimmed) || path.posix.basename(trimmed);
    return base.includes('.') ? base : '';
  }
}

/** 解析 CLI 参数。**不抛**：坏值就地修正并记 stderr（同 meitu 抓取器的口径）。 */
export function parseJmArgs(argv) {
  const options = {
    op: '',
    q: '',
    id: '',
    limit: DEFAULT_LIMIT,
    api: DEFAULT_API,
    outDir: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    pdfMaxBytes: DEFAULT_PDF_MAX_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    const next = () => {
      i += 1;
      return String(argv[i] ?? '');
    };
    switch (arg) {
      case '--op': options.op = next().trim().toLowerCase(); break;
      case '--q': case '--query': options.q = next().trim(); break;
      case '--id': options.id = next().trim(); break;
      case '--limit': options.limit = Number.parseInt(next(), 10); break;
      case '--api': options.api = next().trim(); break;
      case '--out-dir': case '--out': options.outDir = next().trim(); break;
      case '--timeout': options.timeoutMs = Number.parseInt(next(), 10); break;
      case '--max-bytes': options.maxBytes = Number.parseInt(next(), 10); break;
      case '--pdf-max-bytes': options.pdfMaxBytes = Number.parseInt(next(), 10); break;
      default:
        log(`忽略不认识的参数:${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) options.limit = DEFAULT_LIMIT;
  options.limit = Math.min(options.limit, MAX_LIMIT, MAX_LIMIT_SERVER);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) options.maxBytes = DEFAULT_MAX_BYTES;
  return options;
}

/** 带超时的 `fetch`；把超时/网络错误都翻译成稳定 reason。 */
async function fetchWithTimeout(url, init, timeoutMs, fetchImpl) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
  } catch (err) {
    const name = String(err?.name ?? '');
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`timeout:${url}`);
    throw new Error(`service_down:${err?.message ?? err}`);
  }
}

/**
 * 请求一个 JSON 接口。**不抛**（除把失败归好类）：
 * @returns {Promise<{ok: true, data: any} | {ok: false, reason: string, detail: string}>}
 */
async function fetchJson({ url, init, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs, fetchImpl);
  } catch (err) {
    const [reason, detail] = String(err?.message ?? err).split(/:(.*)/s);
    return fail(reason === 'timeout' ? 'timeout' : 'service_down', detail ?? String(err));
  }
  if (!response.ok) {
    return fail('http_error', `HTTP ${response.status} ${url}`);
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    return fail('service_down', `读响应失败:${err?.message ?? err}`);
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return fail('bad_json', '边车响应不是 JSON');
  }
}

/** 文件头校验：只认 JPEG(FFD8) 与 PNG(89504E47)。 */
function imageExtOf(buffer) {
  const jpeg = buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const png = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50
    && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (jpeg) return 'jpg';
  if (png) return 'png';
  return '';
}

/**
 * 下载一张图到 `targetBase`（不含扩展名）。先写 `.part` 再 rename，
 * 中断不会留下"看起来完整"的半张图；超上限的图**不落盘**。
 *
 * @returns {Promise<{ok: true, path: string, bytes: number} | {ok: false, reason: string, detail: string}>}
 */
async function downloadImage({ url, targetBase, maxBytes, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchWithTimeout(url, {}, timeoutMs, fetchImpl);
  } catch (err) {
    const [reason, detail] = String(err?.message ?? err).split(/:(.*)/s);
    return fail(reason === 'timeout' ? 'timeout' : 'service_down', detail ?? String(err));
  }
  if (!response.ok) return fail('http_error', `HTTP ${response.status} ${url}`);

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    return fail('too_large', `图片 ${declared} 字节 > 上限 ${maxBytes}`);
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) return fail('too_large', `图片超过上限 ${maxBytes} 字节`);
      chunks.push(chunk);
    }
  } catch (err) {
    return fail('service_down', `读图片流失败:${err?.message ?? err}`);
  }

  const buffer = Buffer.concat(chunks);
  const ext = imageExtOf(buffer);
  if (!ext) return fail('bad_image', '下载到的不是 JPEG/PNG(可能被拦截或边车返回了错误页)');
  const target = `${targetBase}.${ext}`;
  const part = `${target}.part`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(part, buffer);
    fs.renameSync(part, target);
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch { /* 清理失败不改变结果 */ }
    return fail('io_error', `写图片失败:${err?.message ?? err}`);
  }
  log(`已下载:${target}(${Math.round(buffer.length / 1024)}KB)`);
  return { ok: true, path: target, bytes: buffer.length };
}

/**
 * 拉整本 PDF 到本地文件（`GET /pdf/<id>`）。先写 `.part` 再 rename；
 * 边车按需生成/缓存 PDF，所以这里用**整体预算**而不是 15s 的单请求上限。
 *
 * @returns {Promise<{ok:true, path:string, bytes:number} | {ok:false, reason:string, detail:string}>}
 */
async function fetchPdfToFile({ url, dir, id, maxBytes, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
  } catch (err) {
    const name = String(err?.name ?? '');
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', `PDF 请求超时:${url}`);
    return fail('service_down', `PDF 请求失败:${err?.message ?? err}`);
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status} ${url}`;
    try {
      const text = await response.text();
      const data = JSON.parse(text);
      if (data?.message) detail = `${data.error ?? 'http_error'}: ${data.message}`;
    } catch { /* 非 JSON 错误体就用 HTTP 状态 */ }
    return fail('http_error', detail);
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) return fail('too_large', `PDF 超过上限 ${maxBytes} 字节`);
      chunks.push(chunk);
    }
  } catch (err) {
    return fail('service_down', `读 PDF 流失败:${err?.message ?? err}`);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return fail('bad_pdf', '边车返回的不是 PDF（可能被拦截或返回了错误页）');
  }
  const target = path.join(dir, `JM${id}.pdf`);
  const part = `${target}.part`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(part, buffer);
    fs.renameSync(part, target);
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch { /* 清理失败不改变结果 */ }
    return fail('io_error', `写 PDF 失败:${err?.message ?? err}`);
  }
  log(`PDF 已落盘:${target}(${Math.round(buffer.length / 1024)}KB)`);
  return { ok: true, path: target, bytes: buffer.length };
}

/** 从搜索结果里挑出可下载的图片 URL（优先拼图，其次各封面；边车站内路径补成绝对地址）。 */
function imageCandidates(data, apiBase) {
  const out = [];
  const previewPath = String(data?.preview_url ?? data?.preview_http ?? data?.preview_file ?? '').trim();
  if (previewPath) {
    if (/^https?:\/\//iu.test(previewPath)) {
      out.push({ kind: 'preview', url: previewPath, name: 'preview' });
    }
    // 也接受「服务器本机绝对路径」或站内路径：按 `/preview/<文件名>` 再拼一次（契约里的站内路径）。
    const base = fileNameOf(previewPath);
    if (base) out.push({ kind: 'preview', url: apiUrl(apiBase, `/preview/${encodeURIComponent(base)}`), name: 'preview' });
  }
  for (const [index, item] of (Array.isArray(data?.results) ? data.results : []).entries()) {
    const pathname = String(item?.cover_http ?? '').trim();
    if (!pathname) continue;
    const rank = Number(item?.rank ?? index + 1);
    const id = String(item?.id ?? `r${rank}`);
    out.push({ kind: 'cover', url: apiUrl(apiBase, pathname), name: `cover-${rank}-${id.replace(/[^\w-]/gu, '')}`, rank });
  }
  return out;
}

/**
 * 执行一次边车操作。**不抛**：所有失败都收口成 `{ok:false, reason, detail}`。
 *
 * @param {ReturnType<typeof parseJmArgs>} options
 * @param {{fetchImpl?: Function, log?: Function, sleep?: Function, now?: Function}} [deps]
 *   `fetchImpl`/`sleep`/`now` 可注入 —— selftest 用假网络与假时钟，不联网、不等待。
 * @returns {Promise<object>} 见文件头"成功/失败 JSON"。
 */
export async function runJmFetch(options, deps = {}) {
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const emit = typeof deps.log === 'function' ? deps.log : log;
  const wait = typeof deps.sleep === 'function' ? deps.sleep : sleep;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const apiBase = String(options?.api ?? DEFAULT_API).trim().replace(/\/+$/u, '') || DEFAULT_API;
  const timeoutMs = Number.isSafeInteger(options?.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isSafeInteger(options?.maxBytes) && options.maxBytes > 0
    ? options.maxBytes : DEFAULT_MAX_BYTES;
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now()));

  const op = String(options?.op ?? '').trim().toLowerCase();
  emit(`op=${op || '(空)'} api=${apiBase} timeout=${timeoutMs}`);

  if (op === 'health') {
    const result = await fetchJson({ url: apiUrl(apiBase, '/health'), timeoutMs: remaining(), fetchImpl });
    if (!result.ok) return { ...result, op };
    const data = result.data;
    if (data?.ok !== true) return { ...fail('api_error', data?.message ?? '边车 /health 未就绪'), op };
    emit(`边车健康:${data.service ?? 'jm-service'} ${data.version ?? ''}`);
    return {
      ok: true,
      op,
      service: String(data.service ?? 'jm-service'),
      version: String(data.version ?? ''),
      viewerBase: String(data.viewer_base ?? ''),
      downloadedAlbums: Number(data.downloaded_albums ?? 0),
    };
  }

  if (op === 'search') {
    const query = String(options?.q ?? '').trim();
    if (!query) return { ...fail('bad_args', 'search 缺少 --q'), op };
    if (Array.from(query).length > MAX_KEYWORD_CHARS) return { ...fail('bad_args', `关键词超过 ${MAX_KEYWORD_CHARS} 字`), op };
    const limit = Number.isSafeInteger(options?.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;
    const outDir = String(options?.outDir ?? '').trim();
    if (!outDir) return { ...fail('bad_args', 'search 缺少 --out-dir'), op };
    const dir = path.resolve(outDir);

    const url = apiUrl(apiBase, `/search?q=${encodeURIComponent(query)}&limit=${limit}&page=1`);
    const result = await fetchJson({ url, timeoutMs: remaining(), fetchImpl });
    if (!result.ok) return { ...result, op };
    const data = result.data;
    if (data?.ok !== true) return { ...fail(String(data?.error ?? 'api_error'), data?.message ?? '搜索失败'), op };
    if (!Array.isArray(data.results)) return { ...fail('bad_json', '/search 响应缺少 results 数组'), op };

    const results = data.results.slice(0, limit).map((item, index) => ({
      rank: Number(item?.rank) || index + 1,
      id: String(item?.id ?? ''),
      title: String(item?.title ?? ''),
      authors: Array.isArray(item?.authors) ? item.authors.map(String) : [],
      tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
      pageCount: Number(item?.page_count ?? 0),
      detailOk: item?.detail_ok !== false,
    })).filter((item) => item.id !== '');

    // 图片下载：拼图优先；拼图拿不到再退到封面。任何一张都失败不影响文本结果。
    const covers = [];
    let previewPath = '';
    let previewUrl = '';
    for (const candidate of imageCandidates({ ...data, results }, apiBase)) {
      if (previewPath && candidate.kind === 'preview') continue;
      if (covers.length >= limit) break;
      const saved = await downloadImage({
        url: candidate.url,
        targetBase: path.join(dir, candidate.name),
        maxBytes,
        timeoutMs: remaining(),
        fetchImpl,
      });
      if (!saved.ok) {
        emit(`图片没下载成(${candidate.url}):${saved.reason} ${saved.detail}`);
        continue;
      }
      if (candidate.kind === 'preview') {
        previewPath = saved.path;
        previewUrl = candidate.url;
      } else {
        covers.push({ rank: candidate.rank, id: results.find((item) => item.rank === candidate.rank)?.id ?? '', path: saved.path });
      }
      if (candidate.kind === 'preview') break;
    }

    const text = String(data.text ?? '').trim();
    emit(`搜索结果:${results.length} 本(拼图=${previewPath ? '有' : '无'},封面=${covers.length} 张)`);
    return {
      ok: true,
      op,
      query,
      total: Number(data.total ?? 0),
      cached: data.cached === true,
      elapsedMs: Number(data.elapsed_ms ?? 0),
      results,
      text,
      previewPath,
      previewUrl,
      covers,
    };
  }

  if (op === 'pdf') {
    const id = String(options?.id ?? '').trim();
    if (!/^\d{1,12}$/u.test(id)) return { ...fail('bad_args', 'pdf 缺少合法的 --id'), op };
    const outDir = String(options?.outDir ?? '').trim();
    if (!outDir) return { ...fail('bad_args', 'pdf 缺少 --out-dir'), op };
    const dir = path.resolve(outDir);
    const maxBytes = Number.isSafeInteger(options?.pdfMaxBytes) && options.pdfMaxBytes > 0
      ? options.pdfMaxBytes : DEFAULT_PDF_MAX_BYTES;
    // PDF 可能当场生成（几秒到几十秒），不吃 15s 的单请求上限，只受整体预算约束。
    const pdfTimeout = Math.max(1, Math.min(timeoutMs, deadline - now()));
    const saved = await fetchPdfToFile({
      url: apiUrl(apiBase, `/pdf/${encodeURIComponent(id)}`),
      dir,
      id,
      maxBytes,
      timeoutMs: pdfTimeout,
      fetchImpl,
    });
    if (!saved.ok) return { ...saved, op };
    emit(`PDF 就绪:${saved.path}(${Math.round(saved.bytes / 1024)}KB)`);
    return { ok: true, op, id, path: saved.path, bytes: saved.bytes };
  }

  if (op === 'download') {
    const id = String(options?.id ?? '').trim();
    if (!/^\d{1,12}$/u.test(id)) return { ...fail('bad_args', 'download 缺少合法的 --id'), op };

    /** 下载完成后拿网页阅读链接：优先任务/开始回包里的 viewer_url，缺了再查 /album/<id>。 */
    const viewerOf = async (candidate) => {
      const direct = String(candidate?.viewer_url ?? '').trim();
      if (direct) return direct;
      const album = await fetchJson({ url: apiUrl(apiBase, `/album/${encodeURIComponent(id)}`), timeoutMs: remaining(), fetchImpl });
      return album.ok && album.data?.ok === true ? String(album.data.viewer_url ?? '').trim() : '';
    };
    const doneOf = async (candidate) => {
      const viewerUrl = await viewerOf(candidate);
      return {
        ok: true,
        op,
        id,
        status: 'done',
        title: String(candidate?.album?.title ?? candidate?.title ?? ''),
        viewerUrl,
        dir: String(candidate?.dir ?? ''),
      };
    };

    const start = await fetchJson({
      url: apiUrl(apiBase, '/download'),
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) },
      timeoutMs: remaining(),
      fetchImpl,
    });
    if (!start.ok) return { ...start, op };
    const started = start.data;
    if (started?.ok !== true) return { ...fail(String(started?.error ?? 'api_error'), started?.message ?? '下载请求失败'), op };
    if (started.status === 'done') {
      emit(`已下载,直接取阅读链接:${id}`);
      return doneOf(started);
    }
    const jobId = String(started.job_id ?? '').trim();
    if (!jobId) return { ...fail('bad_json', '/download 既不是 done 也没给 job_id'), op };
    emit(`下载任务已排队:${jobId}`);

    while (now() < deadline) {
      await wait(POLL_MS);
      const job = await fetchJson({ url: apiUrl(apiBase, `/jobs/${encodeURIComponent(jobId)}`), timeoutMs: remaining(), fetchImpl });
      if (!job.ok) return { ...job, op };
      if (job.data?.ok !== true) {
        return { ...fail(String(job.data?.error ?? 'api_error'), job.data?.message ?? '/jobs 未就绪'), op };
      }
      const status = String(job.data?.status ?? '');
      if (status === 'done') {
        emit(`下载完成:${id}`);
        return doneOf({ ...job.data, album: job.data?.album ?? { title: job.data?.title ?? '' } });
      }
      if (status === 'failed') {
        const detail = String(job.data?.error ?? job.data?.message ?? '下载任务失败');
        emit(`下载失败:${detail}`);
        return { ...fail('download_failed', detail), op };
      }
      emit(`下载中:${status || 'unknown'} ${job.data?.phase ?? ''}`.trim());
    }
    return { ...fail('timeout', '等待下载完成超时'), op };
  }

  return { ...fail('bad_args', `--op 只能是 search / download / health,收到 ${JSON.stringify(options?.op ?? '')}`), op };
}

/** CLI 入口：先跑操作，再只写一行 JSON 到 stdout（失败也由 JSON 表达，退出码恒 0）。 */
async function main() {
  const options = parseJmArgs(process.argv.slice(2));
  let result;
  try {
    result = await runJmFetch(options);
  } catch (err) {
    result = { ...fail('internal', `抓取器异常:${err?.message ?? err}`), op: options.op };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  await main();
}
