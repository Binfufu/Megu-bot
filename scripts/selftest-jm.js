/**
 * JM 搜本/下本子系统的判据（2026-11-12；1.210.3 加编号解析与单元本）。
 *
 * 跑法:
 *
 *     node scripts\selftest-jm.js
 *
 * 全部合成、零生产/外站联网（只允许一个本地合成 HTTP 服务器）：
 *   · 解析器用例是纯函数表；
 *   · `jm-fetch-one.mjs` 注入**假 fetch**；另用真实 CLI 访问 127.0.0.1 随机端口合成 HTTP（不起边车）；
 *   · 服务层用例注入**假 runFetch / 假上传发送**（不 spawn、不碰真 QQ、不写真 data/）；
 *   · PDF 落盘只用独立临时目录，结束即删。
 *
 * 钉：
 *   ① 解析：搜本/找本/下载别名、末尾数量 1..5（中文也认）、序号 1..9、@残留、失败分支；
 *   ② 网络边界：health/search（images=0）/resolve/download（带 unit）/pdf（带 unit）的形状、
 *      服务不可用、坏 JSON、HTTP 错误、not_found、超时、下载任务轮询；
 *   ③ 服务层：群白名单 fail closed、编号不走搜索、解析不到不下载、多单元先清单后下载、
 *      单本自动下载三条同时成立才做、total=0 有结果按 0 本、冷却只拦搜本、失败固定话术；
 *   ④ 接线哨兵：`src/index.js` 真的接上、命令表与生成文档、`.env.example` 有键。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DEFAULT_JM_MAX, looksLikeJmAttempt, parseJmCommand } from '../src/jm-command.js';
import {
  DEFAULT_JM_LINES,
  buildDownloadAck,
  buildSearchListText,
  buildUnitListText,
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

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');

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

/** 假二进制响应（PDF/图片都走这条）。 */
function binRes(buffer) {
  const bytes = Buffer.from(buffer);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    body: (async function* chunks() { yield bytes; })(),
    async text() { return ''; },
  };
}

function httpRes(status, body = '') {
  return {
    ok: false, status, headers: new Headers(), body: null,
    async text() { return body; },
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

test('jm-command:下本认编号与序号(1..9),下载本子是别名', () => {
  assert.deepEqual(parseJmCommand('下本 1490076'), {
    ok: true, action: 'download', target: '1490076', ordinal: null, raw: '1490076',
  });
  assert.deepEqual(parseJmCommand('下本 3'), {
    ok: true, action: 'download', target: null, ordinal: 3, raw: '3',
  });
  // 1.210.3：一位数序号放宽到 1..9（单元本清单可能超过 5 条）。
  assert.equal(parseJmCommand('下本 9').ordinal, 9);
  assert.equal(parseJmCommand('下本 10').target, '10', '两位及以上一律当编号');
  assert.equal(parseJmCommand('下载本子 1490076').target, '1490076');
  assert.equal(parseJmCommand('下本 #1490076').target, '1490076');
  assert.equal(parseJmCommand('下本 1490076号').target, '1490076');
});

test('jm-command:下本非法输入不认(不猜)', () => {
  for (const text of ['下本', '下本 abc', '下本 0', '下本 12a']) {
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

test('jm-command:整本打包和清单括号说明均可解析,不需要#说明', () => {
  const expected = { ok: true, action: 'pack', all: true, ordinals: [] };
  for (const text of ['整本打包', '整本打包（#全部单元）', '整本打包 (#全部单元)', '@副实例 整本打包 @副实例']) {
    assert.deepEqual(parseJmCommand(text), expected, text);
    assert.equal(looksLikeJmAttempt(text), true, '必须命中 index.js 已有接线');
  }
});

test('jm-command:打包紧贴/空格均可,序号超过9仍是单元序号', () => {
  for (const text of ['打包1 3 5 7', '打包 1  3\t5 7', '打包1 3 5 7（#选择单元打包）', '打包 1 3 5 7 (#选择单元打包)']) {
    assert.deepEqual(parseJmCommand(text), { ok: true, action: 'pack', all: false, ordinals: [1, 3, 5, 7] }, text);
    assert.equal(looksLikeJmAttempt(text), true, text);
  }
  assert.deepEqual(parseJmCommand('打包12 10 12').ordinals, [12, 10, 12]);
  assert.equal(parseJmCommand('下本 12').target, '12', '旧下本编号语义不变');
});

test('jm-command:打包严格拒空/0/非数字/非法分隔和尾巴,仍识别为命令尝试', () => {
  for (const text of ['打包', '打包 ', '打包（#选择单元打包）', '打包0', '打包1 0 3', '打包01', '打包-1',
    '打包1.5', '打包1,3', '打包1、3', '打包一 三', '打包1 x', '打包1e2', '打包+1', '打包１',
    '打包9007199254740992', '整本打包1', '整本打包 随便', '打包1（#全部单元）', '整本打包（#选择单元打包）']) {
    assert.equal(parseJmCommand(text).ok, false, text);
    assert.equal(looksLikeJmAttempt(text), true, text);
  }
  assert.equal(looksLikeJmAttempt('今天整本打包吗'), false);
});

// ---------------------------------------------------------------------------
// ② 网络边界：scripts/jm-fetch-one.mjs（注入假 fetch，零外网）
// ---------------------------------------------------------------------------

test('jm-fetch:参数默认值与越界夹取(含 unit/images)', () => {
  const defaults = parseJmArgs([]);
  assert.equal(defaults.api, 'http://127.0.0.1:8790');
  assert.equal(defaults.timeoutMs, 120_000);
  assert.equal(defaults.limit, 5);
  assert.equal(defaults.images, true);
  assert.equal(defaults.unit, '');
  assert.equal(defaults.pdfMaxBytes, 200 * 1024 * 1024);
  const clamped = parseJmArgs(['--op', 'search', '--limit', '99', '--timeout', 'bad', '--q', '全彩', '--images', '0']);
  assert.equal(clamped.op, 'search');
  assert.equal(clamped.limit, 5);
  assert.equal(clamped.timeoutMs, 120_000);
  assert.equal(clamped.q, '全彩');
  assert.equal(clamped.images, false);
  assert.equal(parseJmArgs(['--unit', '1205081']).unit, '1205081');
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
  // 旧边车没有 capabilities 时给空数组：Node 据此拒绝合并打包，不猜成支持。
  assert.deepEqual(payload.capabilities, []);
  assert.deepEqual(urls, ['http://127.0.0.1:8790/health']);

  const withCaps = await runJmFetch(
    { op: 'health', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      fetchImpl: async () => jsonRes({ ok: true, service: 'jm-service', version: '1.0.0', capabilities: ['units', 7] }),
    },
  );
  assert.deepEqual(withCaps.capabilities, ['units'], '只保留字符串能力项');

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

test('jm-fetch:search 带 images=0 并返回约定形状(不再下载拼图/封面)', async () => {
  const urls = [];
  const payload = await runJmFetch(
    { op: 'search', q: '全彩', limit: 2, images: false, api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonRes({
          ok: true, query: '全彩', total: 2, cached: false, elapsed_ms: 12, text: '1.101 甲\n2.102 乙',
          results: [
            { rank: 1, id: '101', title: '合成本甲', authors: ['作者甲'], tags: ['全彩'], page_count: 18, cover_http: '/cover/101.jpg', detail_ok: true },
            { rank: 2, id: '102', title: '合成本乙', authors: [], tags: [], page_count: 10, cover_http: '/cover/102.jpg', detail_ok: false },
          ],
        });
      },
    },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.query, '全彩');
  assert.equal(payload.total, 2);
  assert.equal(payload.results.length, 2);
  assert.deepEqual(payload.results[0], {
    rank: 1, id: '101', title: '合成本甲', authors: ['作者甲'], tags: ['全彩'], pageCount: 18, detailOk: true,
  });
  assert.equal(payload.results[1].detailOk, false);
  assert.equal(payload.text, '1.101 甲\n2.102 乙');
  assert.equal(urls.length, 1, 'images=0 时只发一次 /search，不再拉图');
  assert.match(urls[0], /\/search\?q=.+&images=0/u);
  assert.equal(payload.previewPath, undefined, '1.210.3 起 CLI 不再返回预览图字段');
});

test('jm-fetch:resolve 作品/单元两种形状都归一;404 翻成 not_found', async () => {
  const album = {
    ok: true, kind: 'album', requested: '1195659',
    album: {
      id: '1195659', title: '合成作品', page_count: 120, unit_count: 2,
      units: [
        { index: 1, unit_id: '1205081', title: '第1话', page_count: 10 },
        { index: 2, unit_id: '1205082', title: '第2话', page_count: null },
      ],
    },
    matched_unit: null,
  };
  const byAlbum = await runJmFetch(
    { op: 'resolve', id: '1195659', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    { log: noopLog, fetchImpl: async () => jsonRes(album) },
  );
  assert.equal(byAlbum.ok, true);
  assert.equal(byAlbum.kind, 'album');
  assert.equal(byAlbum.album.id, '1195659');
  assert.equal(byAlbum.album.unitCount, 2);
  assert.deepEqual(byAlbum.album.units[0], { index: 1, unitId: '1205081', title: '第1话', pageCount: 10 });
  assert.equal(byAlbum.album.units[1].pageCount, null);
  assert.equal(byAlbum.matchedUnit, null);

  const byPhoto = await runJmFetch(
    { op: 'resolve', id: '1205082', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      fetchImpl: async () => jsonRes({
        ok: true, kind: 'photo', requested: '1205082',
        album: album.album,
        matched_unit: { index: 2, unit_id: '1205082', title: '第2话' },
      }),
    },
  );
  assert.equal(byPhoto.kind, 'photo');
  assert.equal(byPhoto.matchedUnit.unitId, '1205082');

  const missing = await runJmFetch(
    { op: 'resolve', id: '9999999', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    { log: noopLog, fetchImpl: async () => httpRes(404, '{"ok":false,"error":"not_found","message":"没有这个编号"}') },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not_found');
});

test('jm-fetch:download 带 unit 排队后轮询到 done,POST 体带 unit', async () => {
  let polls = 0;
  let posted = null;
  const payload = await runJmFetch(
    { op: 'download', id: '1195659', unit: '1205082', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    {
      log: noopLog,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        if (url.endsWith('/download')) {
          posted = JSON.parse(init.body);
          return jsonRes({ ok: true, status: 'queued', job_id: 'job-1', unit: '1205082' });
        }
        if (url.includes('/jobs/job-1')) {
          polls += 1;
          return jsonRes(polls === 1
            ? { ok: true, status: 'running', phase: 'download', unit_id: '1205082' }
            : { ok: true, status: 'done', unit_id: '1205082', title: '第2话', viewer_url: 'http://127.0.0.1:8088/jm_view?path=x' });
        }
        throw new Error(`unexpected ${url}`);
      },
    },
  );
  assert.deepEqual(posted, { id: '1195659', unit: '1205082' });
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'done');
  assert.equal(payload.unit, '1205082');
  assert.equal(payload.viewerUrl, 'http://127.0.0.1:8088/jm_view?path=x');
  assert.equal(payload.title, '第2话');
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

test('jm-fetch:pdf 带 unit 只落该单元文件(GET /pdf/<id>?unit=)', async () => {
  await withTemp(async (dir) => {
    const urls = [];
    const result = await runJmFetch(
      { op: 'pdf', id: '1195659', unit: '1205082', api: 'http://127.0.0.1:8790', outDir: dir, timeoutMs: 5000 },
      {
        log: noopLog,
        fetchImpl: async (url) => { urls.push(url); return binRes(PDF_BYTES); },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.op, 'pdf');
    assert.equal(result.id, '1195659');
    assert.equal(result.unit, '1205082');
    assert.equal(result.bytes, PDF_BYTES.length);
    assert.equal(path.basename(result.path), 'JM1205082.pdf');
    assert.match(urls[0], /\/pdf\/1195659\?unit=1205082$/u);
    assert.equal(fs.readFileSync(result.path).subarray(0, 5).toString('latin1'), '%PDF-');

    const bad = await runJmFetch(
      { op: 'pdf', id: '101', api: 'http://127.0.0.1:8790', outDir: dir, timeoutMs: 5000 },
      { log: noopLog, fetchImpl: async () => binRes(Buffer.from('not a pdf')) },
    );
    assert.equal(bad.reason, 'bad_pdf');

    const http = await runJmFetch(
      { op: 'pdf', id: '101', api: 'http://127.0.0.1:8790', outDir: dir, timeoutMs: 5000 },
      { log: noopLog, fetchImpl: async () => httpRes(404) },
    );
    assert.equal(http.reason, 'http_error');
  });
});

test('jm-fetch:选集pdf只发units查询一次,去重且命名不撞整本/单单元', async () => {
  await withTemp(async (dir) => {
    const urls = [];
    const result = await runJmFetch(
      parseJmArgs(['--op', 'pdf', '--id', '700', '--units', '111,333,111', '--out-dir', dir]),
      { log: noopLog, fetchImpl: async (url) => { urls.push(url); return binRes(PDF_BYTES); } },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.units, ['111', '333']);
    assert.deepEqual(urls, ['http://127.0.0.1:8790/pdf/700?units=111,333']);
    assert.match(path.basename(result.path), /^JM700-pack-[a-f0-9]{16}\.pdf$/u);
    assert.equal(fs.readFileSync(result.path).equals(PDF_BYTES), true);
    const single = await runJmFetch(
      { op: 'pdf', id: '700', units: '111', outDir: dir },
      { log: noopLog, fetchImpl: async () => binRes(PDF_BYTES) },
    );
    assert.match(path.basename(single.path), /^JM700-pack-/u);
    assert.notEqual(path.basename(single.path), 'JM111.pdf');
    assert.notEqual(path.basename(single.path), 'JM700.pdf');
    assert.notEqual(single.path, result.path, '不同选集命名不同');
  });
});

test('jm-fetch:units只用于pdf且与unit互斥,空/0/非法id在任何HTTP前失败', async () => {
  let fetched = 0;
  const deps = { log: noopLog, fetchImpl: async () => { fetched += 1; throw new Error('不应访问'); } };
  const cases = [
    ['--op', 'download', '--id', '700', '--units', '111'],
    ['--op', 'search', '--q', '合成', '--units', '111'],
    ['--op', 'health', '--units', '111'],
    ['--op', 'resolve', '--id', '700', '--units', '111'],
    ['--op', 'pdf', '--id', '700', '--unit', '111', '--units', '222'],
    ['--op', 'pdf', '--id', '700', '--unit', '', '--units', '222'],
    ...['', '0', '00', '111,0', '111,,222', ',111', '111,', '111,abc', '111,-2', '111,2.5',
      '111, 222', '111,1e2', '111,1234567890123', '111,01'].map((value) => ['--op', 'pdf', '--id', '700', '--units', value]),
  ];
  for (const args of cases) {
    const result = await runJmFetch(parseJmArgs([...args, '--out-dir', 'unused-synthetic-dir']), deps);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.reason, 'bad_args', JSON.stringify(args));
  }
  assert.equal(fetched, 0);
});

test('jm-fetch:真实CLI到本地合成HTTP仅GET选集查询,无download/整本回退', async () => {
  await withTemp(async (dir) => {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const api = `http://127.0.0.1:${server.address().port}`;
      const script = fileURLToPath(new URL('./jm-fetch-one.mjs', import.meta.url));
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, '--op', 'pdf', '--id', '700', '--units', '111,333,555,777',
          '--api', api, '--out-dir', dir, '--timeout', '5000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => {
          try {
            assert.equal(code, 0, stderr);
            resolve(JSON.parse(stdout.trim()));
          } catch (error) { reject(error); }
        });
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.units, ['111', '333', '555', '777']);
      assert.deepEqual(requests, [{ method: 'GET', url: '/pdf/700?units=111,333,555,777' }]);
      assert.equal(fs.readFileSync(result.path).equals(PDF_BYTES), true);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// ③ 服务层：src/jm-service.js（注入假 runFetch / 假上传发送）
// ---------------------------------------------------------------------------

const message = (targetId, extra = {}) => ({
  scene: 'group', targetId, isMention: true, messageId: `m-${targetId}`, content: 'x', ...extra,
});

/** 搜本成功时抓取器该吐的 JSON。 */
function searchPayload({ results = [], total = results.length } = {}) {
  return {
    ok: true,
    op: 'search',
    query: '全彩',
    total,
    cached: false,
    elapsedMs: 10,
    text: '',
    results: results.map((item, index) => ({ rank: index + 1, ...item })),
  };
}

/** 编号解析成功时抓取器该吐的 JSON（camelCase，与 CLI 归一后的形状一致）。 */
function albumPayload({ id = '101', title = '合成本甲', units = null } = {}) {
  const list = units ?? [{ index: 1, unitId: id, title }];
  return {
    id,
    title,
    pageCount: 20,
    unitCount: list.length,
    units: list,
  };
}

function resolvePayload({ kind = 'album', album = albumPayload(), matchedUnit = null } = {}) {
  return { ok: true, op: 'resolve', requested: String(album.id), kind, album, matchedUnit };
}

/** 下本成功时抓取器该吐的 JSON。 */
function downloadPayload({ id = '101', unit = null, title = '合成本甲' } = {}) {
  return {
    ok: true, op: 'download', id, unit, status: 'done', title,
    viewerUrl: 'http://127.0.0.1:8088/jm_view?path=x',
    dir: 'data/comics/JM101-合成本甲',
  };
}

/** PDF 拉取成功时抓取器该吐的 JSON（path 指向用例里真实写的临时 PDF）。 */
function pdfPayload({ id = '101', unit = null, file = '' } = {}) {
  return { ok: true, op: 'pdf', id, unit, path: file, bytes: 1024 };
}

/** 写一个最小 PDF 文件（服务层只负责上传；PDF 头校验在抓取器里）。 */
function makePdfFile(dir, key = '101') {
  const file = path.join(dir, `JM${key}.pdf`);
  fs.writeFileSync(file, PDF_BYTES);
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
    // 子进程参数形状：search 带关键词/数量/边车地址，且 images=0。
    const args = calls.fetch[0].args;
    assert.ok(args.includes('search'));
    assert.equal(args[args.indexOf('--q') + 1], '全彩');
    assert.equal(args[args.indexOf('--limit') + 1], '3');
    assert.equal(args[args.indexOf('--images') + 1], '0');
    assert.equal(args[args.indexOf('--api') + 1], 'http://127.0.0.1:8790');
  });
});

test('jm-service:搜本 0 本 / total=0 但有结果 → 都按 0 本回固定话术', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-empty-result';
    const { deps, calls } = makeDeps({ dir, groups: [group], payloads: [searchPayload({ results: [] })] });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_result');
    assertReplyIn(calls, 'noResult');
    assert.equal(calls.upload.length, 0);

    // 1.210.2 现场：0 结果页的推荐位混成 1 条结果 —— 不能当"单命中"下载。
    const group2 = 'g-jm-zero-total';
    const { deps: deps2, calls: calls2 } = makeDeps({
      dir,
      groups: [group2],
      payloads: [searchPayload({ results: [{ id: '1195659', title: '无关推荐' }], total: 0 })],
    });
    const zero = await handleJmCommand({ message: message(group2), parsed: parseJmCommand('搜本 全彩'), deps: deps2 });
    assert.equal(zero.ok, false);
    assert.equal(zero.reason, 'no_result');
    assertReplyIn(calls2, 'noResult');
    assert.equal(calls2.fetch.length, 1, '不因推荐位再去下载');
  });
});

test('jm-service:关键词单命中(total=1) → 先解析单单元,再下载+PDF+群文件', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-single';
    const pdfFile = makePdfFile(dir, '101');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        searchPayload({ results: [{ id: '101', title: '合成本甲' }] }),
        resolvePayload({ album: albumPayload({ id: '101', title: '合成本甲' }) }),
        downloadPayload({ id: '101', title: '合成本甲' }),
        pdfPayload({ id: '101', file: pdfFile }),
      ],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.equal(calls.fetch.length, 4, 'search → resolve → download → pdf');
    assert.ok(calls.fetch[0].args.includes('search'));
    assert.ok(calls.fetch[1].args.includes('resolve'), '单命中也要解析单元');
    assert.equal(calls.fetch[1].args[calls.fetch[1].args.indexOf('--id') + 1], '101');
    assert.ok(calls.fetch[2].args.includes('download'));
    assert.equal(calls.fetch[2].args[calls.fetch[2].args.indexOf('--id') + 1], '101');
    assert.ok(!calls.fetch[2].args.includes('--unit'), '单单元作品下整本');
    assert.ok(calls.fetch[3].args.includes('pdf'));
    assert.ok(calls.fetch[3].args.includes('--out-dir'));
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.upload[0].fileType, 4, 'PDF 走 QQ 文件类型 file_type=4');
    assert.equal(calls.upload[0].fileName, 'JM101.pdf', '文件名用通用 JM<id>.pdf，不带标题');
    assert.equal(calls.upload[0].scene, 'group');
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].msgId, 'm-g-jm-single');
    assert.equal(calls.send[0].msgSeq, 2, '文件接着进度文本的被动序号');
    assert.equal(calls.reply.length, 1, '成功时只有下载进度那一句；发出文件后不再补文案');
    assert.match(calls.reply[0], /正在下载打包/u);
    assert.ok(calls.reply[0].includes('合成本甲'), calls.reply[0]);
    assert.ok(calls.reply[0].includes('JM101'), calls.reply[0]);
    assert.deepEqual(calls.order, ['reply', 'upload', 'send']);
  });
});

test('jm-service:数字搜本=编号精确解析,不走站内搜索;单单元直接下', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-num-single';
    const pdfFile = makePdfFile(dir, '1490076');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        resolvePayload({ album: albumPayload({ id: '1490076', title: '合成本乙' }) }),
        downloadPayload({ id: '1490076', title: '合成本乙' }),
        pdfPayload({ id: '1490076', file: pdfFile }),
      ],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本1490076'), deps });
    assert.equal(result.ok, true);
    assert.equal(calls.fetch.length, 3, 'resolve → download → pdf，一次搜索都不发');
    assert.equal(calls.fetch[0].args[0]?.endsWith('jm-fetch-one.mjs'), true);
    assert.ok(calls.fetch[0].args.includes('resolve'));
    assert.equal(calls.fetch[0].args[calls.fetch[0].args.indexOf('--id') + 1], '1490076');
    assert.ok(!calls.fetch[0].args.includes('--q'), '编号路径不带关键词');
    assert.ok(calls.reply[0].includes('合成本乙'), calls.reply[0]);
    assert.equal(calls.upload[0].fileName, 'JM1490076.pdf');
  });
});

test('jm-service:数字搜本命中多单元作品 → 先清单不下载;下本序号只下所选单元', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-multi';
    const units = [
      { index: 1, unitId: '1205081', title: '第1话' },
      { index: 2, unitId: '1205082', title: '第2话' },
    ];
    const album = albumPayload({ id: '1195659', title: '合成作品', units });
    const pdfFile = makePdfFile(dir, '1205082');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        resolvePayload({ album }),
        downloadPayload({ id: '1195659', unit: '1205082', title: '第2话' }),
        pdfPayload({ id: '1195659', unit: '1205082', file: pdfFile }),
      ],
    });
    const first = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本1195659'), deps });
    assert.equal(first.ok, true);
    assert.equal(first.reason, 'choose_unit');
    assert.equal(calls.fetch.length, 1, '多单元只解析，不下载');
    assert.equal(calls.upload.length, 0);
    assert.equal(calls.reply.length, 1);
    const listText = calls.reply[0];
    assert.ok(listText.includes('JM1195659'), listText);
    assert.ok(listText.includes('有 2 个单元本'), listText);
    assert.ok(listText.includes('1. JM1205081 第1话'), listText);
    assert.ok(listText.includes('2. JM1205082 第2话'), listText);
    assert.ok(listText.includes('回复 下本 <序号1-2>'), listText);

    const second = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 2'), deps });
    assert.equal(second.ok, true);
    assert.equal(calls.fetch.length, 3, '选单元后只 download + pdf，不再整本');
    const downloadArgs = calls.fetch[1].args;
    assert.equal(downloadArgs[downloadArgs.indexOf('--unit') + 1], '1205082');
    const pdfArgs = calls.fetch[2].args;
    assert.equal(pdfArgs[pdfArgs.indexOf('--unit') + 1], '1205082');
    assert.equal(calls.upload[0].fileName, 'JM1205082.pdf', '文件按单元编号命名');
    assert.ok(calls.reply.at(-1).includes('第2话'), calls.reply.at(-1));
    assert.equal(calls.send[0].msgSeq, 2);
  });
});

test('jm-service:数字搜本命中单元编号 → 清单标出"你要的是第 N 个",仍先问', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-photo-search';
    const units = [
      { index: 1, unitId: '1205081', title: '第1话' },
      { index: 2, unitId: '1205082', title: '第2话' },
    ];
    const album = albumPayload({ id: '1195659', title: '合成作品', units });
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [resolvePayload({ kind: 'photo', album, matchedUnit: units[1] })],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本1205082'), deps });
    assert.equal(result.reason, 'choose_unit');
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.upload.length, 0);
    assert.ok(calls.reply[0].includes('你要的是第 2 个单元'), calls.reply[0]);
    assert.ok(calls.reply[0].includes('2. JM1205082 第2话'), calls.reply[0]);
  });
});

test('jm-service:下本 <多单元作品编号> → 清单;下本 <单元编号> → 直接只下该单元', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-download-multi';
    const units = [
      { index: 1, unitId: '1205081', title: '第1话' },
      { index: 2, unitId: '1205082', title: '第2话' },
    ];
    const album = albumPayload({ id: '1195659', title: '合成作品', units });
    const pdfFile = makePdfFile(dir, '1205081');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        resolvePayload({ album }),
        resolvePayload({ kind: 'photo', album, matchedUnit: units[0] }),
        downloadPayload({ id: '1195659', unit: '1205081', title: '第1话' }),
        pdfPayload({ id: '1195659', unit: '1205081', file: pdfFile }),
      ],
    });
    const listed = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 1195659'), deps });
    assert.equal(listed.reason, 'choose_unit');
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.upload.length, 0);

    const direct = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 1205081'), deps });
    assert.equal(direct.ok, true);
    assert.equal(calls.fetch.length, 4, '既有解析，再 download + pdf');
    assert.ok(calls.fetch[1].args.includes('resolve'));
    assert.equal(calls.fetch[2].args[calls.fetch[2].args.indexOf('--unit') + 1], '1205081');
    assert.equal(calls.upload[0].fileName, 'JM1205081.pdf');
  });
});

test('jm-service:编号解析不到 → 「没有这个编号」,不下载、不拿搜索兜底', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-bad-id';
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [{ ok: false, op: 'resolve', reason: 'not_found', detail: 'not_found: 没有这个编号' }],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本1205081'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
    assertReplyIn(calls, 'noSuchId');
    assert.equal(calls.fetch.length, 1, '只解析一次，不退回搜索、不下载');
    assert.equal(calls.upload.length, 0);
  });
});

test('jm-service:单命中但站点 total>1(或写了数量) → 只给清单,不自动下载', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-not-only';
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [searchPayload({ results: [{ id: '101', title: '合成本甲' }], total: 5 })],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 0);
    assert.equal(calls.fetch.length, 1, '不因单条结果就下载');
    assert.ok(calls.reply[0].includes('搜到1本（共5本）'), calls.reply[0]);
  });
});

test('jm-service:PDF 上传/发送失败 → 固定话术,不假装成功', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-pdf-blocked';
    const pdfFile = makePdfFile(dir, '101');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        resolvePayload({ album: albumPayload({ id: '101', title: '合成本甲' }) }),
        downloadPayload({ id: '101' }),
        pdfPayload({ id: '101', file: pdfFile }),
      ],
      uploadFile: async () => { throw new Error('HTTP 400 code=40034006 消息内容违规'); },
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本101'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pdf_send_failed');
    assertReplyIn(calls, 'pdfFailed');
    assert.equal(calls.send.length, 0);
  });
});

test('jm-service:PDF 没拿到 → 固定话术,不假装成功', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-pdf-missing';
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        resolvePayload({ album: albumPayload({ id: '101', title: '合成本甲' }) }),
        downloadPayload({ id: '101' }),
        { ok: false, op: 'pdf', reason: 'http_error', detail: '404 album_not_downloaded' },
      ],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 101'), deps });
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
      payloads: [
        searchPayload({ results }),
        resolvePayload({ album: albumPayload({ id: '102', title: '合成本乙' }) }),
        downloadPayload({ id: '102', title: '合成本乙' }),
        pdfPayload({ id: '102', file: pdfFile }),
      ],
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

    // 同一时刻下本 → 不归冷却管：序号 2 → 先解析（单单元）→ 下载 + PDF。
    clock = 1600;
    const third = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 2'), deps });
    assert.equal(third.ok, true);
    assert.equal(calls.fetch.length, 4);
    const resolveArgs = calls.fetch[1].args;
    assert.ok(resolveArgs.includes('resolve'));
    assert.equal(resolveArgs[resolveArgs.indexOf('--id') + 1], '102');
    assert.equal(calls.fetch[2].args[calls.fetch[2].args.indexOf('--id') + 1], '102');
    assert.equal(calls.upload.at(-1).fileName, 'JM102.pdf');
    assert.match(calls.reply.at(-1), /正在下载打包/u);
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
      payloads: [{ ok: false, op: 'search', reason: 'service_down', detail: '连不上' }, searchPayload({ results: [], total: 0 })],
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
    const scenarios = [
      { stdout: '', timedOut: false, key: 'serviceDown' },
      { stdout: 'not-json-at-all\n', timedOut: false, key: 'searchFailed' },
      { stdout: '', timedOut: true, key: 'timeout' },
    ];
    for (const [index, item] of scenarios.entries()) {
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

test('jm-service:下本序号没有记录时回提示;直接发编号先解析再下', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-dl-empty';
    const pdfFile = makePdfFile(dir, '1490076');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        resolvePayload({ album: albumPayload({ id: '1490076', title: '合成本丙' }) }),
        downloadPayload({ id: '1490076', title: '合成本丙' }),
        pdfPayload({ id: '1490076', file: pdfFile }),
      ],
    });
    const noSearch = await handleJmCommand({
      message: message(group),
      parsed: parseJmCommand('下本 1'),
      deps,
    });
    assert.equal(noSearch.ok, false);
    assert.equal(noSearch.reason, 'ordinal_missing');
    assertReplyIn(calls, 'noSearch');
    assert.equal(calls.fetch.length, 0, '没有清单时一次都不 spawn');

    const direct = await handleJmCommand({
      message: message(group),
      parsed: parseJmCommand('下本 1490076'),
      deps,
    });
    assert.equal(direct.ok, true);
    assert.equal(calls.fetch.length, 3, 'resolve → download → pdf');
    assert.ok(calls.fetch[0].args.includes('resolve'));
    assert.equal(calls.fetch[1].args[calls.fetch[1].args.indexOf('--id') + 1], '1490076');
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.upload[0].fileName, 'JM1490076.pdf');
    assert.equal(calls.upload[0].fileType, 4);
  });
});

test('jm-service:下本失败 → 固定话术,不假装成功', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-dlfail';
    const first = makeDeps({
      dir,
      groups: [group],
      payloads: [{ ok: false, op: 'resolve', reason: 'download_failed', detail: '断了' }],
    });
    const r1 = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 1490076'), deps: first.deps });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'download_failed');
    assertReplyIn(first.calls, 'downloadFailed');
  });
});

test('jm-service:清单文案 = 序号 + JM编号 + 标题(截断);单元清单带"你要的是第N个"', () => {
  const text = buildSearchListText([
    { id: '101', title: '标题甲' },
    { id: '102', title: '长'.repeat(80) },
  ], { total: 9 });
  assert.match(text, /^搜到2本（共9本），回复 下本 <编号或序号> 打包整本 PDF：/u);
  assert.ok(text.includes('1. JM101 标题甲'), text);
  assert.ok(text.includes('2. JM102 长'), text);
  assert.ok(text.includes('…'), '超长标题要截断');
  assert.ok(!/https?:\/\//u.test(text), '清单里不放阅读链接');

  const units = buildUnitListText({
    albumId: '1195659',
    albumTitle: '合成作品',
    units: [
      { index: 1, unitId: '1205081', title: '第1话' },
      { index: 2, unitId: '1205082', title: '第2话' },
      { index: 3, unitId: '1205083', title: '第3话' },
    ],
    matchedUnitId: '1205081',
  });
  assert.ok(units.includes('JM1195659《合成作品》有 3 个单元本：'), units);
  assert.ok(units.includes('你要的是第 1 个单元。'), units);
  assert.ok(units.includes('2. JM1205082 第2话'), units);
  assert.ok(units.includes('回复 下本 <序号1-3> 或 下本 <单元编号>'), units);
  assert.equal(buildDownloadAck('合成本甲', '101'), '《合成本甲》（JM101）正在下载打包…');
});

/** 选集服务合成夹具：假下载、假PDF落盘、假上传；不碰边车和真实群。 */
function makePackFixture(dir, group, { count = 12, units = null, failAt = null, pdfFail = false, albumId = '700', unitsCapability = true } = {}) {
  const list = units ?? Array.from({ length: count }, (_, index) => ({
    index: index + 1, unitId: String((index + 1) * 111), title: `第${index + 1}话 ${index % 2 ? '熟肉' : '生肉'}`,
  }));
  const fixture = makeDeps({ dir, groups: [group] });
  const { deps, calls } = fixture;
  let downloading = 0;
  deps.runFetch = async (input) => {
    calls.fetch.push(input);
    const arg = (key) => input.args[input.args.indexOf(key) + 1];
    const op = arg('--op');
    let payload;
    if (op === 'health') {
      payload = { ok: true, op: 'health', service: 'jm-service', version: '1.0.0', capabilities: unitsCapability ? ['units'] : [] };
    } else if (op === 'resolve') {
      payload = resolvePayload({ album: albumPayload({ id: albumId, title: '合成系列', units: list }) });
    } else if (op === 'download') {
      assert.equal(arg('--id'), albumId);
      assert.ok(input.args.includes('--unit'), '选集绝不能无unit调用download');
      assert.ok(!input.args.includes('--units'), 'download API不新增units');
      downloading += 1;
      assert.equal(downloading, 1, '单元必须串行下载');
      await Promise.resolve();
      downloading -= 1;
      payload = arg('--unit') === failAt
        ? { ok: false, reason: 'download_failed', detail: '合成单元失败' }
        : downloadPayload({ id: albumId, unit: arg('--unit') });
    } else if (op === 'pdf') {
      assert.equal(arg('--id'), albumId);
      assert.ok(input.args.includes('--units'), '包括全选在内必须显式传全集units');
      assert.ok(!input.args.includes('--unit'));
      payload = pdfFail
        ? { ok: false, reason: 'http_error', detail: '合成合并失败' }
        : pdfPayload({ id: albumId, file: makePdfFile(arg('--out-dir'), 'synthetic-pack') });
    } else throw new Error(`不允许的合成操作 ${op}`);
    return { code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false };
  };
  const run = (text) => handleJmCommand({ message: message(group), parsed: parseJmCommand(text), deps });
  // health 只是能力探测，单独数；其它断言看解析/下载/合并序列。
  const operations = () => calls.fetch.map(({ args }) => args[args.indexOf('--op') + 1]).filter((op) => op !== 'health');
  const healthOps = () => calls.fetch.filter(({ args }) => args[args.indexOf('--op') + 1] === 'health');
  const downloads = () => calls.fetch.filter(({ args }) => args.includes('download')).map(({ args }) => args[args.indexOf('--unit') + 1]);
  const pdfUnits = () => {
    const args = calls.fetch.find(({ args }) => args.includes('pdf'))?.args;
    return args?.[args.indexOf('--units') + 1];
  };
  return { ...fixture, run, operations, healthOps, downloads, pdfUnits, units: list };
}

test('jm-service:显式整本打包依清单逐单元下载,仅一次全集units PDF和一次文件发送', async () => {
  await withTemp(async (dir) => {
    const fixture = makePackFixture(dir, 'g-jm-pack-all', { count: 4 });
    const listed = await fixture.run('搜本700');
    assert.equal(listed.reason, 'choose_unit');
    assert.deepEqual(fixture.operations(), ['resolve'], '多单元不无提示自动整本');
    assert.deepEqual(fixture.calls.reply[0].split('\n').slice(-2), ['整本打包（#全部单元）', '打包1 3 5 7（#选择单元打包）']);
    const result = await fixture.run('整本打包');
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.deepEqual(fixture.operations(), ['resolve', 'download', 'download', 'download', 'download', 'pdf']);
    assert.equal(fixture.healthOps().length, 1, '打包前恰好探测一次边车能力');
    assert.deepEqual(fixture.downloads(), ['111', '222', '333', '444']);
    assert.equal(fixture.pdfUnits(), '111,222,333,444');
    assert.equal(fixture.calls.upload.length, 1);
    assert.equal(fixture.calls.send.length, 1);
    assert.match(fixture.calls.upload[0].fileName, /^JM700-pack-[a-f0-9]{16}\.pdf$/u);
    assert.equal(fixture.calls.send[0].msgSeq, 2, '只一条进度加一个文件');
  });
});

test('jm-service:打包1 3 5 7仅含选中生肉,不自动把配对熟肉混入', async () => {
  await withTemp(async (dir) => {
    const fixture = makePackFixture(dir, 'g-jm-pack-odd');
    await fixture.run('下本700');
    const result = await fixture.run('打包 1 3 5 7（#选择单元打包）');
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.downloads(), ['111', '333', '555', '777']);
    assert.equal(fixture.pdfUnits(), '111,333,555,777');
    assert.deepEqual(fixture.operations(), ['resolve', 'download', 'download', 'download', 'download', 'pdf']);
    assert.equal(fixture.calls.upload.length, 1);
    assert.equal(fixture.calls.send.length, 1);
  });
});

test('jm-service:序号>9按清单顺序合并,重复序号与重复单元id均去重', async () => {
  await withTemp(async (dir) => {
    const units = Array.from({ length: 12 }, (_, index) => ({ index: index + 1, unitId: String((index + 1) * 111), title: '合成单元' }));
    units[11].unitId = units[9].unitId;
    const fixture = makePackFixture(dir, 'g-jm-pack-order', { units });
    await fixture.run('搜本700');
    assert.equal((await fixture.run('打包12 3 10 1 3 12')).ok, true);
    assert.deepEqual(fixture.downloads(), ['111', '333', '1110']);
    assert.equal(fixture.pdfUnits(), '111,333,1110');
    assert.equal(fixture.calls.send.length, 1);
    // 明确只选一个单元仍走选集合并，文件命名不冒充旧单单元。
    const single = makePackFixture(dir, 'g-jm-pack-single');
    await single.run('搜本700');
    assert.equal((await single.run('打包10')).ok, true);
    assert.equal(single.pdfUnits(), '1110');
    assert.match(single.calls.upload[0].fileName, /^JM700-pack-/u);
    assert.notEqual(single.calls.upload[0].fileName, 'JM1110.pdf');
  });
});

test('jm-service:后置越界/非法序号全量校验,在任何下载和进度前拒绝', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-pack-invalid';
    const fixture = makePackFixture(dir, group, { count: 7 });
    await fixture.run('搜本700');
    for (const parsed of [
      parseJmCommand('打包1 3 5 8'),
      { ok: true, action: 'pack', all: false, ordinals: [1, 0] },
      { ok: true, action: 'pack', all: false, ordinals: [1, -1] },
      { ok: true, action: 'pack', all: false, ordinals: [1, 1.5] },
      { ok: true, action: 'pack', all: false, ordinals: [1, '3'] },
      { ok: true, action: 'pack', all: false, ordinals: [1, , 3] },
      { ok: true, action: 'pack', all: false, ordinals: [] },
      { ok: true, action: 'pack', all: false, ordinals: null },
      { ok: true, action: 'pack', all: true, ordinals: [1] },
    ]) {
      const before = fixture.calls.reply.length;
      const result = await handleJmCommand({ message: message(group), parsed, deps: fixture.deps });
      assert.equal(result.ok, false);
      assert.equal(fixture.calls.reply.length, before + 1, '只回失败提示，不回正在下载');
      assertReplyIn(fixture.calls, 'packInvalid');
      assert.deepEqual(fixture.operations(), ['resolve'], '所有合法与非法序号先一起校验完才可能下载');
    }
    assert.equal(fixture.calls.send.length, 0);
    const corrupt = makePackFixture(dir, 'g-jm-pack-bad-unit', { units: [
      { index: 1, unitId: '111', title: '合成甲' }, { index: 2, unitId: 'not-id', title: '合成乙' },
    ] });
    await corrupt.run('搜本700');
    assert.equal((await corrupt.run('整本打包')).reason, 'invalid_units');
    assert.deepEqual(corrupt.operations(), ['resolve']);
  });
});

test('jm-service:边车未声明units能力→打包在读任何单元前拒绝,不静默回整本', async () => {
  await withTemp(async (dir) => {
    const fixture = makePackFixture(dir, 'g-jm-pack-old-sidecar', { count: 2, unitsCapability: false });
    await fixture.run('搜本700');
    const before = fixture.calls.reply.length;
    const result = await fixture.run('整本打包');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pack_unsupported');
    assert.equal(fixture.calls.reply.length, before + 1, '只回能力不足，不回正在下载');
    assertReplyIn(fixture.calls, 'packUnsupported');
    assert.deepEqual(fixture.healthOps().length, 1);
    assert.equal(fixture.downloads().length, 0, '旧边车绝不能进入任何单元下载');
    assert.equal(fixture.operations().includes('pdf'), false);
    assert.equal(fixture.calls.upload.length, 0);
    assert.equal(fixture.calls.send.length, 0);
  });
});

test('jm-service:打包只能用本群当前单元清单,不借用别群/搜索结果/旧清单', async () => {
  await withTemp(async (dir) => {
    const first = makePackFixture(dir, 'g-jm-pack-isolated-a', { count: 2 });
    await first.run('搜本700');
    const second = makePackFixture(dir, 'g-jm-pack-isolated-b', { count: 2 });
    assert.equal((await second.run('整本打包')).reason, 'no_units');
    assert.equal((await second.run('打包1')).reason, 'no_units');
    assert.deepEqual(second.operations(), []);
    assertReplyIn(second.calls, 'noUnits');
    const group = 'g-jm-pack-isolated-a';
    const list = makeDeps({ dir, groups: [group], payloads: [searchPayload({ results: [
      { id: '801', title: '合成作品甲' }, { id: '802', title: '合成作品乙' },
    ] })] });
    await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 合成 2'), deps: list.deps });
    assert.equal((await first.run('整本打包')).reason, 'no_units', '新的搜索清单必须清掉之前单元清单');
    assert.deepEqual(first.operations(), ['resolve']);
    assert.equal(first.calls.send.length, 0);
  });
});

test('jm-service:任一单元下载失败就停止,不请求PDF/不上传/不发残缺合并', async () => {
  await withTemp(async (dir) => {
    const fixture = makePackFixture(dir, 'g-jm-pack-fail-unit', { failAt: '555' });
    await fixture.run('搜本700');
    const result = await fixture.run('打包1 3 5 7');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'download_failed');
    assert.deepEqual(fixture.operations(), ['resolve', 'download', 'download', 'download']);
    assert.deepEqual(fixture.downloads(), ['111', '333', '555']);
    assertReplyIn(fixture.calls, 'downloadFailed');
    assert.equal(fixture.calls.upload.length, 0);
    assert.equal(fixture.calls.send.length, 0);
  });
});

test('jm-service:合并PDF失败不发送已下载单元的替代文件', async () => {
  await withTemp(async (dir) => {
    const fixture = makePackFixture(dir, 'g-jm-pack-fail-pdf', { count: 2, pdfFail: true });
    await fixture.run('搜本700');
    const result = await fixture.run('整本打包');
    assert.equal(result.reason, 'pdf_failed');
    assert.deepEqual(fixture.operations(), ['resolve', 'download', 'download', 'pdf']);
    assertReplyIn(fixture.calls, 'pdfFailed');
    assert.equal(fixture.calls.upload.length, 0);
    assert.equal(fixture.calls.send.length, 0);
  });
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
