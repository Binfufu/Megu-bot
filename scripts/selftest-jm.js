/**
 * JM 搜本/下本子系统的判据（2026-11-12）。
 *
 * 跑法:
 *
 *     node scripts\selftest-jm.js
 *
 * 全部合成、零网络：
 *   · 解析器用例是纯函数表；
 *   · `jm-fetch-one.mjs` 的用例注入**假 fetch**（假边车响应，不联网、不起边车）；
 *   · 服务层用例注入**假 runFetch / 假上传发送**（不 spawn、不碰真 QQ、不写真 data/）；
 *   · 图片落盘只用独立临时目录，结束即删。
 *
 * 钉：
 *   ① 解析：搜本/找本/下载别名、末尾数量 1..5（中文也认）、@残留、格式/数量/关键词失败；
 *   ② 网络边界：health/search/download 的成功形状、服务不可用、坏 JSON、HTTP 错误、
 *      超时、单图大小上限（超限不落盘）、下载任务轮询到完成；
 *   ③ 服务层：群白名单 fail closed（空名单 = 一次都不 spawn）、按群串行、冷却只拦搜本且
 *      只记成功、边车不可用/坏输出/超时只回固定话术、结果图超限不发图但文本照发、
 *      搜本成功先图后文、下本按 id 与按序号的参数形状、没有 viewer_url 不假装成功；
 *   ④ 接线哨兵：`src/index.js` 真的在配置开启时接上、命令表与生成文档、`.env.example` 有键。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_JM_MAX, looksLikeJmAttempt, parseJmCommand } from '../src/jm-command.js';
import {
  DEFAULT_JM_LINES,
  buildSearchListText,
  handleJmCommand,
} from '../src/jm-service.js';
import { parseJmArgs, runJmFetch } from './jm-fetch-one.mjs';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };
const noopLog = () => {};

/** 依赖自包含的临时目录（系统 temp，不是仓库 data/）。 */
async function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-jm-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** 假 JSON 响应（jm-fetch-one 只用到 ok/status/headers/text）。 */
function jsonRes(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    async text() { return JSON.stringify(data); },
  };
}

/** 假图片响应；`declared` 用来模拟"声明长度就超上限"的现场。 */
function binRes(buffer, declared = undefined) {
  const bytes = Buffer.from(buffer);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(declared ?? bytes.length) }),
    body: (async function* chunks() { yield bytes; })(),
    async text() { return ''; },
  };
}

function httpRes(status) {
  return {
    ok: false, status, headers: new Headers(), body: null,
    async text() { return ''; },
  };
}

const TIMEOUT_ERROR = Object.assign(new Error('timed out'), { name: 'TimeoutError' });

// ---------------------------------------------------------------------------
// ① 解析器（纯函数）
// ---------------------------------------------------------------------------

test('jm-command:搜本/找本 认关键词,没写数量用上限', () => {
  const base = parseJmCommand('搜本 全彩');
  assert.equal(base.ok, true);
  assert.deepEqual(base, {
    ok: true, action: 'search', keyword: '全彩', count: DEFAULT_JM_MAX, countGiven: false,
  });
  assert.deepEqual(parseJmCommand('找本 全彩'), base);
  assert.equal(parseJmCommand('搜本 全彩', { max: 3 }).count, 3);
});

test('jm-command:末尾数量 1..5 阿拉伯/中文都认,写多了夹到上限', () => {
  assert.equal(parseJmCommand('搜本 全彩 3').count, 3);
  assert.equal(parseJmCommand('搜本 全彩 三').count, 3);
  assert.equal(parseJmCommand('搜本 全彩 两').count, 2);
  assert.equal(parseJmCommand('搜本 全彩 9').count, 5);
  assert.equal(parseJmCommand('搜本 全彩 9').countGiven, true);
  // 数量必须与关键词之间有空白：「全彩3」是整个关键词（宁窄勿宽）。
  const glued = parseJmCommand('搜本 全彩3');
  assert.equal(glued.keyword, '全彩3');
  assert.equal(glued.countGiven, false);
});

test('jm-command:数量 0 明确拒绝,空关键词/超长关键词是格式错误', () => {
  assert.equal(parseJmCommand('搜本 全彩 0').reason, 'count');
  assert.equal(parseJmCommand('搜本').reason, 'format');
  assert.equal(parseJmCommand('').reason, 'format');
  assert.equal(parseJmCommand(`搜本 ${'字'.repeat(61)}`).reason, 'keyword');
});

test('jm-command:下本认编号与序号,下载本子是别名', () => {
  assert.deepEqual(parseJmCommand('下本 1490076'), {
    ok: true, action: 'download', target: '1490076', ordinal: null, raw: '1490076',
  });
  assert.deepEqual(parseJmCommand('下本 3'), {
    ok: true, action: 'download', target: null, ordinal: 3, raw: '3',
  });
  assert.equal(parseJmCommand('下载本子 1490076').target, '1490076');
  assert.equal(parseJmCommand('下本 #1490076').target, '1490076');
  assert.equal(parseJmCommand('下本 1490076号').target, '1490076');
});

test('jm-command:下本非法输入不认(不猜)', () => {
  for (const text of ['下本', '下本 abc', '下本 0', '下本 6', '下本 12a']) {
    assert.equal(parseJmCommand(text).ok, false, text);
    assert.equal(parseJmCommand(text).reason, 'format', text);
  }
});

test('jm-command:@残留要剥,普通闲聊不能误判成尝试', () => {
  assert.equal(parseJmCommand('@副实例 搜本 全彩 2').keyword, '全彩');
  assert.equal(parseJmCommand('@副实例 搜本 全彩 2').count, 2);
  assert.equal(parseJmCommand('搜本 全彩 @副实例').keyword, '全彩');
  for (const text of ['搜本', '找本', '下本 abc', '下载本子 随便']) {
    assert.equal(looksLikeJmAttempt(text), true, text);
  }
  for (const text of ['今天搜本了吗', '发1张示例甲美图', '来3张美图', '你好呀']) {
    assert.equal(looksLikeJmAttempt(text), false, text);
    assert.equal(parseJmCommand(text).ok, false, text);
  }
});

// ---------------------------------------------------------------------------
// ② 网络边界：scripts/jm-fetch-one.mjs（注入假 fetch，零网络）
// ---------------------------------------------------------------------------

test('jm-fetch:参数默认值与越界夹取', () => {
  const defaults = parseJmArgs([]);
  assert.equal(defaults.api, 'http://127.0.0.1:8790');
  assert.equal(defaults.timeoutMs, 120_000);
  assert.equal(defaults.limit, 5);
  const clamped = parseJmArgs(['--op', 'search', '--limit', '99', '--timeout', 'bad', '--q', '全彩']);
  assert.equal(clamped.op, 'search');
  assert.equal(clamped.limit, 5);
  assert.equal(clamped.timeoutMs, 120_000);
  assert.equal(clamped.q, '全彩');
});

test('jm-fetch:health 成功带出边车信息,坏 JSON 收敛成 bad_json', async () => {
  const urls = [];
  const payload = await runJmFetch(
    { op: 'health', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonRes({ ok: true, service: 'jm-service', version: '1.0.0', viewer_base: 'http://127.0.0.1:8088', downloaded_albums: 3 });
      },
    },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.viewerBase, 'http://127.0.0.1:8088');
  assert.deepEqual(urls, ['http://127.0.0.1:8790/health']);

  const bad = await runJmFetch(
    { op: 'health', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: null, async text() { return 'oops'; } }),
    },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_json');
});

test('jm-fetch:连不上=service_down、超时=timeout、HTTP 非 2xx=http_error', async () => {
  const run = (fetchImpl) => runJmFetch(
    { op: 'health', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    { log: noopLog, fetchImpl },
  );
  assert.equal((await run(async () => { throw new TypeError('fetch failed'); })).reason, 'service_down');
  assert.equal((await run(async () => { throw TIMEOUT_ERROR; })).reason, 'timeout');
  assert.equal((await run(async () => httpRes(503))).reason, 'http_error');
});

test('jm-fetch:search 成功返回约定形状并把拼图下载到临时目录', async () => {
  await withTemp(async (dir) => {
    const outDir = path.join(dir, 'out');
    const payload = await runJmFetch(
      { op: 'search', q: '全彩', limit: 2, api: 'http://127.0.0.1:8790', outDir, timeoutMs: 5000 },
      {
        log: noopLog,
        fetchImpl: async (url) => {
          if (url.includes('/search?')) {
            return jsonRes({
              ok: true, query: '全彩', total: 2, cached: false, elapsed_ms: 12, text: '1.101 甲\n2.102 乙',
              results: [
                { rank: 1, id: '101', title: '合成本甲', authors: ['作者甲'], tags: ['全彩'], page_count: 18, cover_http: '/cover/101.jpg', detail_ok: true },
                { rank: 2, id: '102', title: '合成本乙', authors: [], tags: [], page_count: 10, cover_http: '/cover/102.jpg', detail_ok: false },
              ],
              preview_url: 'http://127.0.0.1:8790/preview/p_ab12_2.jpg',
            });
          }
          if (url.includes('/preview/')) return binRes(JPEG_BYTES);
          throw new Error(`unexpected ${url}`);
        },
      },
    );
    assert.equal(payload.ok, true);
    assert.equal(payload.query, '全彩');
    assert.equal(payload.results.length, 2);
    assert.deepEqual(payload.results[0], {
      rank: 1, id: '101', title: '合成本甲', authors: ['作者甲'], tags: ['全彩'], pageCount: 18, detailOk: true,
    });
    assert.equal(payload.results[1].detailOk, false);
    assert.equal(payload.text, '1.101 甲\n2.102 乙');
    assert.ok(payload.previewPath, '拼图应当落盘');
    assert.ok(fs.existsSync(payload.previewPath));
    assert.match(payload.previewPath, /preview\.jpg$/u);
  });
});

test('jm-fetch:结果图超过大小上限时不落盘,文本结果照常返回', async () => {
  await withTemp(async (dir) => {
    const outDir = path.join(dir, 'out');
    const payload = await runJmFetch(
      { op: 'search', q: '全彩', limit: 1, api: 'http://127.0.0.1:8790', outDir, timeoutMs: 5000, maxBytes: 16 },
      {
        log: noopLog,
        fetchImpl: async (url) => {
          if (url.includes('/search?')) {
            return jsonRes({
              ok: true, query: '全彩', total: 1, cached: false, elapsed_ms: 5, text: '1.101 甲',
              results: [{ rank: 1, id: '101', title: '合成本甲' }],
              preview_url: 'http://127.0.0.1:8790/preview/p_big.jpg',
            });
          }
          return binRes(JPEG_BYTES, 1024);
        },
      },
    );
    assert.equal(payload.ok, true);
    assert.equal(payload.previewPath, '');
    assert.equal(payload.results.length, 1);
    const leftovers = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((name) => name.endsWith('.part')) : [];
    assert.deepEqual(leftovers, [], '超限不留 .part');
  });
});

test('jm-fetch:download 排队后轮询到 done,带出 viewer_url', async () => {
  let polls = 0;
  let posted = null;
  const payload = await runJmFetch(
    { op: 'download', id: '1490076', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        if (url.endsWith('/download')) {
          posted = JSON.parse(init.body);
          return jsonRes({ ok: true, status: 'queued', job_id: 'job-1' });
        }
        if (url.includes('/jobs/job-1')) {
          polls += 1;
          return jsonRes(polls === 1
            ? { ok: true, status: 'running', phase: 'download' }
            : { ok: true, status: 'done', title: '合成本', viewer_url: 'http://127.0.0.1:8088/jm_view?path=x' });
        }
        throw new Error(`unexpected ${url}`);
      },
    },
  );
  assert.deepEqual(posted, { id: '1490076' });
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'done');
  assert.equal(payload.viewerUrl, 'http://127.0.0.1:8088/jm_view?path=x');
  assert.equal(payload.title, '合成本');
  assert.equal(polls, 2);
});

test('jm-fetch:download 任务失败与整体超时各有稳定 reason', async () => {
  const failed = await runJmFetch(
    { op: 'download', id: '1', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      sleep: async () => {},
      fetchImpl: async (url) => (url.endsWith('/download')
        ? jsonRes({ ok: true, status: 'queued', job_id: 'job-x' })
        : jsonRes({ ok: true, status: 'failed', error: '边车说下载失败' })),
    },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'download_failed');
  assert.match(failed.detail, /下载失败/u);

  let tick = 0;
  const timedOut = await runJmFetch(
    { op: 'download', id: '1', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      sleep: async () => {},
      now: () => tick,
      fetchImpl: async (url) => {
        tick += 2000;
        return url.endsWith('/download')
          ? jsonRes({ ok: true, status: 'queued', job_id: 'job-y' })
          : jsonRes({ ok: true, status: 'running' });
      },
    },
  );
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout');
});

// ②b 整本 PDF 拉取（GET /pdf/<id>）—— 只注入假 fetch，不联网、不起边车。
test('jm-fetch:pdf 成功把整本 PDF 落到 out-dir', async () => {
  await withTemp(async (dir) => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF\n', 'latin1');
    const result = await runJmFetch(
      { op: 'pdf', id: '101', api: 'http://127.0.0.1:8790', outDir: dir, timeoutMs: 5000 },
      { log: noopLog, fetchImpl: async () => binRes(pdf) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.op, 'pdf');
    assert.equal(result.id, '101');
    assert.equal(result.bytes, pdf.length);
    assert.equal(fs.readFileSync(result.path).subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(path.basename(result.path), 'JM101.pdf');
  });
});

test('jm-fetch:pdf 非 PDF 响应 / HTTP 错误各有稳定 reason', async () => {
  await withTemp(async (dir) => {
    const bad = await runJmFetch(
      { op: 'pdf', id: '101', api: 'http://127.0.0.1:8790', outDir: dir, timeoutMs: 5000 },
      { log: noopLog, fetchImpl: async () => binRes(Buffer.from('not a pdf')) },
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'bad_pdf');

    const http = await runJmFetch(
      { op: 'pdf', id: '101', api: 'http://127.0.0.1:8790', outDir: dir, timeoutMs: 5000 },
      { log: noopLog, fetchImpl: async () => httpRes(404) },
    );
    assert.equal(http.ok, false);
    assert.equal(http.reason, 'http_error');
  });
});

// ---------------------------------------------------------------------------
// ③ 服务层：src/jm-service.js（注入假 runFetch / 假上传发送）
// ---------------------------------------------------------------------------

const message = (targetId, extra = {}) => ({
  scene: 'group', targetId, isMention: true, messageId: `m-${targetId}`, content: 'x', ...extra,
});

/** 搜本成功时抓取器该吐的 JSON。 */
function searchPayload({ results = [] } = {}) {
  return {
    ok: true,
    op: 'search',
    query: '全彩',
    total: results.length,
    cached: false,
    elapsedMs: 10,
    text: '',
    results: results.map((item, index) => ({ rank: index + 1, ...item })),
    previewPath: '',
    covers: [],
  };
}

/** 下本成功时抓取器该吐的 JSON（viewer_url 仍由边车给，但 Node 侧不再发给群）。 */
function downloadPayload({ id = '101', title = '合成本甲' } = {}) {
  return {
    ok: true, op: 'download', id, status: 'done', title,
    viewerUrl: 'http://127.0.0.1:8088/jm_view?path=x',
    dir: 'data/comics/JM101-合成本甲',
  };
}

/** 整本 PDF 拉取成功时抓取器该吐的 JSON（path 指向用例里真实写的临时 PDF）。 */
function pdfPayload({ id = '101', file = '' } = {}) {
  return { ok: true, op: 'pdf', id, path: file, bytes: 1024 };
}

/** 写一个最小 PDF 文件（服务层只负责上传；PDF 头校验在抓取器里）。 */
function makePdfFile(dir, id = '101') {
  const file = path.join(dir, `JM${id}.pdf`);
  fs.writeFileSync(file, Buffer.from('%PDF-1.4\n%fake\n%%EOF\n', 'latin1'));
  return file;
}

/**
 * 假依赖工厂。`payloads` 是 runFetch 依次返回的 JSON 对象（用完取最后一个）；
 * 也可以在用例里直接传 `runFetch` 接管。
 */
function makeDeps({
  dir,
  groups = ['g-jm'],
  cooldownMs = 0,
  max = 5,
  maxBytes = 10_485_760,
  payloads = [searchPayload()],
  now,
  lines,
  runFetch,
  uploadFile,
  sendMedia,
  reply,
} = {}) {
  const calls = { fetch: [], upload: [], send: [], reply: [], replyOpts: [], order: [] };
  let index = 0;
  const deps = {
    config: {
      jm: {
        enabled: true,
        groups,
        api: 'http://127.0.0.1:8790',
        max,
        cooldownMs,
        root: path.join(dir, 'jm-images'),
        maxBytes,
        timeoutMs: 120_000,
      },
    },
    log: SILENT_LOG,
    now: typeof now === 'function' ? now : () => 1_700_000_000_000,
    rng: () => 0,
    runFetch: runFetch ?? (async (input) => {
      calls.fetch.push(input);
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      return { code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false };
    }),
    uploadFile: uploadFile ?? (async (args) => {
      calls.order.push('upload');
      calls.upload.push(args);
      return `file_info_${calls.upload.length}`;
    }),
    sendMedia: sendMedia ?? (async (args) => {
      calls.order.push('send');
      calls.send.push(args);
      return { id: calls.send.length };
    }),
    reply: reply ?? (async (text, opts) => {
      calls.order.push('reply');
      calls.reply.push(text);
      calls.replyOpts.push(opts);
      return 1;
    }),
    ...(lines ? { lines } : {}),
  };
  return { deps, calls };
}

/** 回话 ∈ 句库该 key 的成员（句库支持变体，判据钉成员关系，不钉死单串）。 */
const assertReplyIn = (calls, key) => {
  assert.ok(calls.reply.length >= 1, '应该至少回一句');
  const variants = DEFAULT_JM_LINES[key];
  assert.ok(variants.includes(calls.reply.at(-1)), `回话要在 ${key} 的变体里：${JSON.stringify(calls.reply.at(-1))}`);
};

test('jm-service:群白名单空 = 谁都不给(fail closed),一次都不 spawn', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, groups: [] });
    const result = await handleJmCommand({ message: message('g-jm-empty'), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'group_disabled');
    assertReplyIn(calls, 'groupDisabled');
    assert.equal(calls.fetch.length, 0);
  });
});

test('jm-service:不在白名单的群拒绝;非群消息/缺 targetId 直接忽略', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({ dir, groups: ['g-jm-allowed'] });
    const denied = await handleJmCommand({ message: message('g-jm-other'), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(denied.reason, 'group_disabled');
    assert.equal(calls.fetch.length, 0);

    const c2c = await handleJmCommand({ message: { ...message('g-jm-x'), scene: 'c2c' }, parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(c2c.reason, 'not_group');
    const noTarget = await handleJmCommand({ message: message(''), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(noTarget.reason, 'no_target');
    assert.equal(calls.fetch.length, 0);
  });
});

test('jm-service:白名单显式 * = 全部群放行,空名单仍全拒(安全默认不变)', async () => {
  await withTemp(async (dir) => {
    // 两条结果 → 走"多本清单"分支，避免触发下载（下载路径另有专门用例）。
    const results = [{ id: '101', title: '合成本甲' }, { id: '102', title: '合成本乙' }];
    const group = 'g-jm-anyone';
    const all = makeDeps({ dir, groups: ['*'], payloads: [searchPayload({ results })] });
    const allowed = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps: all.deps });
    assert.equal(allowed.ok, true, '名单含 * 时任意群都放行');
    assert.equal(all.calls.fetch.length, 1, '* 要真的走到抓取');

    const mixed = makeDeps({ dir, groups: ['*', 'g-jm-somewhere'], payloads: [searchPayload({ results })] });
    const mixedResult = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps: mixed.deps });
    assert.equal(mixedResult.ok, true, '*,某群 也覆盖未列出的群');
    assert.equal(mixed.calls.fetch.length, 1);

    const empty = makeDeps({ dir, groups: [] });
    const denied = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps: empty.deps });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'group_disabled');
    assert.equal(empty.calls.fetch.length, 0, '空名单一次都不 spawn');
  });
});

test('jm-service:搜多本 → 只回 JM编号+作品标题清单,不下载也不发图', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-list';
    const results = [
      { id: '101', title: '合成本甲' },
      { id: '102', title: '合成本乙' },
      { id: '103', title: '合成本丙' },
    ];
    const { deps, calls } = makeDeps({ dir, groups: [group], payloads: [searchPayload({ results })] });
    const result = await handleJmCommand({
      message: message(group),
      parsed: parseJmCommand('搜本 全彩 3'),
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 0);
    assert.equal(calls.fetch.length, 1, '多本清单只搜索，不下载');
    assert.equal(calls.upload.length, 0, '不发图/不发文件');
    assert.equal(calls.send.length, 0);
    assert.equal(calls.reply.length, 1);
    const text = calls.reply[0];
    assert.match(text, /^搜到3本/u);
    assert.ok(text.includes('1. JM101 合成本甲'), text);
    assert.ok(text.includes('2. JM102 合成本乙'), text);
    assert.ok(text.includes('3. JM103 合成本丙'), text);
    assert.ok(text.includes('下本 <编号或序号>'), text);
    // 子进程参数形状：search 带关键词/数量/边车地址/临时目录。
    const args = calls.fetch[0].args;
    assert.ok(args.includes('search'));
    assert.equal(args[args.indexOf('--q') + 1], '全彩');
    assert.equal(args[args.indexOf('--limit') + 1], '3');
    assert.equal(args[args.indexOf('--api') + 1], 'http://127.0.0.1:8790');
    assert.ok(args.includes('--out-dir'));
  });
});

test('jm-service:搜本 0 本 → 固定话术,不发图也不下载', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-empty-result';
    const { deps, calls } = makeDeps({ dir, groups: [group], payloads: [searchPayload({ results: [] })] });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_result');
    assertReplyIn(calls, 'noResult');
    assert.equal(calls.upload.length, 0);
  });
});

test('jm-service:单本搜到即下载 → 下载+生成PDF+上传成群文件(搜本/下本合并)', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-single';
    const pdfFile = makePdfFile(dir, '101');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [searchPayload({ results: [{ id: '101', title: '合成本甲' }] }), downloadPayload(), pdfPayload({ file: pdfFile })],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.equal(calls.fetch.length, 3, 'search → download → pdf 三次抓取');
    assert.ok(calls.fetch[1].args.includes('download'));
    assert.equal(calls.fetch[1].args[calls.fetch[1].args.indexOf('--id') + 1], '101');
    assert.ok(calls.fetch[2].args.includes('pdf'));
    assert.equal(calls.fetch[2].args[calls.fetch[2].args.indexOf('--id') + 1], '101');
    assert.ok(calls.fetch[2].args.includes('--out-dir'));
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.upload[0].fileType, 4, 'PDF 走 QQ 文件类型 file_type=4');
    assert.equal(calls.upload[0].fileName, 'JM101.pdf', '文件名用通用 JM<id>.pdf，不带标题');
    assert.equal(calls.upload[0].scene, 'group');
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].msgId, 'm-g-jm-single');
    assert.equal(calls.send[0].msgSeq, 2, '文件接着进度文本的被动序号');
    assert.match(calls.reply[0], /正在下载打包/u);
    assert.equal(calls.reply.length, 1, '成功时只有下载进度那一句；发出文件后不再补文案');
    assert.deepEqual(calls.order, ['reply', 'upload', 'send']);
  });
});

test('jm-service:PDF 上传/发送失败 → 固定话术,不假装成功', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-pdf-blocked';
    const pdfFile = makePdfFile(dir, '101');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [searchPayload({ results: [{ id: '101', title: '合成本甲' }] }), downloadPayload(), pdfPayload({ file: pdfFile })],
      uploadFile: async () => { throw new Error('HTTP 400 code=40034006 消息内容违规'); },
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pdf_send_failed');
    assertReplyIn(calls, 'pdfFailed');
    assert.equal(calls.send.length, 0);
  });
});

test('jm-service:整本 PDF 没拿到 → 固定话术,不假装成功', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-pdf-missing';
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        searchPayload({ results: [{ id: '101', title: '合成本甲' }] }),
        downloadPayload(),
        { ok: false, op: 'pdf', reason: 'http_error', detail: '404 album_not_downloaded' },
      ],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pdf_failed');
    assertReplyIn(calls, 'pdfFailed');
    assert.equal(calls.upload.length, 0);
  });
});

test('jm-service:冷却只拦搜本且只记成功 —— 下本不受冷却影响', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-cool';
    let clock = 1000;
    const results = [{ id: '101', title: '合成本甲' }, { id: '102', title: '合成本乙' }];
    const pdfFile = makePdfFile(dir, '102');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      cooldownMs: 1000,
      now: () => clock,
      payloads: [searchPayload({ results }), downloadPayload({ id: '102', title: '合成本乙' }), pdfPayload({ id: '102', file: pdfFile })],
    });
    const first = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩 2'), deps });
    assert.equal(first.ok, true);
    assert.equal(calls.fetch.length, 1);

    // 500ms 后第二次搜本 → 冷却拦住，不再 spawn。
    clock = 1500;
    const second = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩 2'), deps });
    assert.equal(second.reason, 'cooldown');
    assertReplyIn(calls, 'cooldown');
    assert.equal(calls.fetch.length, 1);

    // 同一时刻下本 → 不归冷却管，序号 2 解析到上次搜索的 102，下载后发 PDF。
    clock = 1600;
    const third = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 2'), deps });
    assert.equal(third.ok, true);
    assert.equal(calls.fetch.length, 3);
    const downloadArgs = calls.fetch[1].args;
    assert.ok(downloadArgs.includes('download'));
    assert.equal(downloadArgs[downloadArgs.indexOf('--id') + 1], '102');
    assert.equal(calls.fetch[2].args[calls.fetch[2].args.indexOf('--id') + 1], '102');
    assert.equal(calls.upload.at(-1).fileName, 'JM102.pdf');
    assert.match(calls.reply.at(-1), /正在下载打包 JM102/u);
  });
});

test('jm-service:失败的搜本不占冷却(失败者可以立刻再试)', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-cool-fail';
    let clock = 1000;
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      cooldownMs: 10_000,
      now: () => clock,
      payloads: [{ ok: false, op: 'search', reason: 'service_down', detail: '连不上' }, searchPayload({ results: [] })],
    });
    const first = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(first.ok, false);
    assertReplyIn(calls, 'serviceDown');
    clock = 1100;
    const second = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.notEqual(second.reason, 'cooldown');
    assert.equal(calls.fetch.length, 2);
  });
});

test('jm-service:边车不可用/子进程坏输出/超时 → fail closed 固定话术', async () => {
  await withTemp(async (dir) => {
    const cases = [
      { stdout: '', timedOut: false, key: 'serviceDown' },
      { stdout: 'not-json-at-all\n', timedOut: false, key: 'searchFailed' },
      { stdout: '', timedOut: true, key: 'timeout' },
    ];
    for (const [index, item] of cases.entries()) {
      const group = `g-jm-fail-${index}`;
      const { deps, calls } = makeDeps({
        dir,
        groups: [group],
        runFetch: async () => ({ code: item.timedOut ? null : 0, stdout: item.stdout, stderr: '', timedOut: item.timedOut }),
      });
      const result = await handleJmCommand({
        message: message(group),
        parsed: parseJmCommand('搜本 全彩'),
        deps,
      });
      assert.equal(result.ok, false, `case ${index}`);
      assertReplyIn(calls, item.key);
      assert.equal(calls.upload.length, 0);
    }
  });
});

test('jm-service:下本按序号取最近一次搜索的 id;没有搜索记录时回提示', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-dl-empty';
    const { deps, calls } = makeDeps({ dir, groups: [group], payloads: [downloadPayload()] });
    const noSearch = await handleJmCommand({
      message: message(group),
      parsed: parseJmCommand('下本 1'),
      deps,
    });
    assert.equal(noSearch.ok, false);
    assert.equal(noSearch.reason, 'ordinal_missing');
    assertReplyIn(calls, 'noSearch');
    assert.equal(calls.fetch.length, 0);

    // 直接给 id 不依赖搜索记录；下载完成 → 取 PDF → 发文件。
    const group2 = 'g-jm-dl-direct';
    const pdfFile = makePdfFile(dir, '1490076');
    const { deps: deps2, calls: calls2 } = makeDeps({
      dir,
      groups: [group2],
      payloads: [downloadPayload({ id: '1490076' }), pdfPayload({ id: '1490076', file: pdfFile })],
    });
    const direct = await handleJmCommand({
      message: message(group2),
      parsed: parseJmCommand('下本 1490076'),
      deps: deps2,
    });
    assert.equal(direct.ok, true);
    const args = calls2.fetch[0].args;
    assert.equal(args[args.indexOf('--id') + 1], '1490076');
    assert.equal(calls2.fetch.length, 2);
    assert.equal(calls2.upload.length, 1);
    assert.equal(calls2.upload[0].fileName, 'JM1490076.pdf');
    assert.equal(calls2.upload[0].fileType, 4);
  });
});

test('jm-service:下本失败 → 固定话术,不假装成功', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-dlfail';
    const first = makeDeps({ dir, groups: [group], payloads: [{ ok: false, op: 'download', reason: 'download_failed', detail: '断了' }] });
    const r1 = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 1490076'), deps: first.deps });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'download_failed');
    assertReplyIn(first.calls, 'downloadFailed');
  });
});

test('jm-service:多本清单文案 = 序号 + JM编号 + 标题(带截断,不含链接)', () => {
  const text = buildSearchListText([
    { id: '101', title: '标题甲' },
    { id: '102', title: '长'.repeat(80) },
  ]);
  assert.match(text, /^搜到2本，回复 下本 <编号或序号> 打包整本 PDF：/u);
  assert.ok(text.includes('1. JM101 标题甲'), text);
  assert.ok(text.includes('2. JM102 长'), text);
  assert.ok(text.includes('…'), '超长标题要截断');
  assert.ok(!/https?:\/\//u.test(text), '清单里不放阅读链接');
});

// ---------------------------------------------------------------------------

// ④ 接线哨兵（只读源码/生成物，证明"真的接上了"而不是只有模块）
// ---------------------------------------------------------------------------

test('jm-service 接线哨兵:index.js 按配置开启接入、命令表与生成文档同步、示例 env 有键', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const indexSource = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  assert.ok(indexSource.includes('config.jm?.enabled'), 'index.js 必须按 QQBOT_JM 总开关接入');
  assert.ok(indexSource.includes('parseJmCommand(message.content, { max: config.jm.max })'), 'index.js 必须调纯解析器');
  assert.ok(indexSource.includes('handleJmCommand({'), 'index.js 必须调服务层');
  assert.ok(indexSource.includes('looksLikeJmAttempt(message.content)'), 'index.js 必须有格式提示分支');

  const commandsSource = fs.readFileSync(path.join(root, 'src', 'commands.js'), 'utf8');
  assert.ok(commandsSource.includes('parseJmCommand'), '命令表必须登记 JM 指令');
  const doc = fs.readFileSync(path.join(root, 'docs', '命令与关键字.md'), 'utf8');
  assert.ok(doc.includes('搜本 <关键词>'), '生成的命令文档必须含 JM 行（改了要重跑 command-index --write）');

  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const key of ['QQBOT_JM=false', 'QQBOT_JM_GROUPS=', 'QQBOT_JM_API=http://127.0.0.1:8790', 'QQBOT_JM_MAX=5',
    'QQBOT_JM_COOLDOWN_MS=30000', 'QQBOT_JM_ROOT=data/demo/jm-images',
    'QQBOT_JM_MAX_BYTES=10485760', 'QQBOT_JM_TIMEOUT_MS=120000']) {
    assert.ok(envExample.includes(key), `.env.example 缺 ${key}`);
  }
});

export function registerJmTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerJmTests 需要 test');
  for (const [name, fn] of cases) testFn(name, fn);
}

// 直接跑本文件时也能独立出结果。
const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
