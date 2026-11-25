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
 *      结构化条件 作者/原作(IP)/角色/标签/标题/页码、条件 AND、原作+角色/多值拒绝；
 *   ② 网络边界：health/search（images=0，结构化时 mode/page/details=1）/resolve/download（带 unit）/
 *      pdf（带 unit）的形状、服务不可用、坏 JSON、HTTP 错误、not_found、超时、下载任务轮询；
 *   ③ 服务层：群白名单 fail closed、编号不走搜索、解析不到不下载、多单元先清单后下载、
 *      单本自动下载三条同时成立才做、结构化检索只清单不自动下载/单页边界、total=0 有结果按 0 本、
 *      冷却只拦搜本、失败固定话术；
 *   ④ 接线哨兵：`src/index.js` 真的接上、命令表与生成文档、`.env.example` 有键。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DEFAULT_JM_MAX, looksLikeJmAttempt, parseJmCommand, parseJmFuzzyCommand, suggestJmSyntax } from '../src/jm-command.js';
import {
  DEFAULT_JM_LINES,
  buildDownloadAck,
  buildJmFormatHint,
  buildJmParseFailureReply,
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
  assert.equal(parseJmCommand('搜本子').reason, 'format', '不能把“子”当关键词搜出去');
  assert.equal(parseJmCommand('').reason, 'format');
  assert.equal(parseJmCommand(`搜本 ${'字'.repeat(61)}`).reason, 'keyword');
});

test('jm-command:下本认编号与序号(1..9),下载本子是别名', () => {
  assert.deepEqual(parseJmCommand('下本 1490076'), {
    ok: true, action: 'download', targets: [{ kind: 'id', target: '1490076' }], raw: '1490076',
  });
  assert.deepEqual(parseJmCommand('下本 3'), {
    ok: true, action: 'download', targets: [{ kind: 'ordinal', ordinal: 3 }], raw: '3',
  });
  // 1.210.3：一位数序号放宽到 1..9（单元本清单可能超过 5 条）。
  assert.equal(parseJmCommand('下本 9').targets[0].ordinal, 9);
  assert.equal(parseJmCommand('下本 10').targets[0].target, '10', '两位及以上一律当编号');
  assert.equal(parseJmCommand('下载本子 1490076').targets[0].target, '1490076');
  assert.equal(parseJmCommand('下本 #1490076').targets[0].target, '1490076');
  assert.equal(parseJmCommand('下本 1490076号').targets[0].target, '1490076');
});

test('jm-command:下本可一次选多个(2026-11-17 现场原文),分隔符与JM前缀都认', () => {
  // 现场：清单之后回「下本1489725 1488143」「下本1 2」都被旧解析器判成 format。
  assert.deepEqual(parseJmCommand('下本1489725 1488143').targets, [
    { kind: 'id', target: '1489725' }, { kind: 'id', target: '1488143' },
  ]);
  assert.deepEqual(parseJmCommand('下本1 2').targets, [
    { kind: 'ordinal', ordinal: 1 }, { kind: 'ordinal', ordinal: 2 },
  ]);
  for (const text of ['下本 1、2', '下本 1，2', '下本 1,2', '下本 1;2', '下本 1/2', '下本 1和2',
    '下本 第1 第2', '下本 1号 2号', '下本 １ ２']) {
    assert.deepEqual(parseJmCommand(text).targets, [
      { kind: 'ordinal', ordinal: 1 }, { kind: 'ordinal', ordinal: 2 },
    ], text);
  }
  assert.deepEqual(parseJmCommand('下本 JM1489725 1488143').targets, [
    { kind: 'id', target: '1489725' }, { kind: 'id', target: '1488143' },
  ], '清单里显示的 JM 前缀可直接带上');
  assert.deepEqual(parseJmCommand('下本 1 1').targets, [{ kind: 'ordinal', ordinal: 1 }], '同一目标重复写只算一次');
  assert.equal(parseJmCommand('下本 1 2 3 4 5 6').reason, 'tooMany', '超过 5 个明确拒绝，不静默截断');
});

test('jm-command:搜本纯多编号只引导下本，不能被模糊入口重新吃掉', () => {
  for (const text of ['搜本\n900001\n900002', '搜本 900001 900002', '搜本 900001、900002本']) {
    assert.equal(parseJmCommand(text).reason, 'useDownload', text);
    assert.equal(parseJmFuzzyCommand(text), null, text);
  }
  assert.deepEqual(parseJmCommand('搜本 900001 2'), {
    ok: true, action: 'search', keyword: '900001', count: 2, countGiven: true,
  });
});

test('jm-command:多行搜本一体解析 CRLF 关键词、数量与结构化条件', () => {
  assert.deepEqual(parseJmCommand('搜本\r\n合成\n关键词\r\n3'), {
    ok: true, action: 'search', keyword: '合成 关键词', count: 3, countGiven: true,
  });
  const structured = parseJmCommand('搜本\r\n作者:甲\n标签:乙\r\n页码:2');
  assert.equal(structured.ok, true);
  assert.deepEqual(structured.conditions, { creator: ['甲'], tag: ['乙'] });
  assert.equal(structured.page, 2);
});

test('jm-command:多行下本支持 CRLF、混排分隔与去重，六项明确拒绝', () => {
  const parsed = parseJmCommand('下载本子\r\nＪＭ９００００１、#900002号\n第3本 / 900001');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.targets, [
    { kind: 'id', target: '900001' }, { kind: 'id', target: '900002' }, { kind: 'ordinal', ordinal: 3 },
  ]);
  assert.deepEqual(parseJmCommand('下本\r\n900001、900002\n900003 900004／900005；900006'), {
    ok: false, reason: 'tooMany', count: 6, max: 5,
  });
});

test('jm-command:下本非法输入不认(不猜)', () => {
  for (const text of ['下本', '下本 abc', '下本 0', '下本 12a', '下本 1 abc', '下本 10a 2']) {
    assert.equal(parseJmCommand(text).ok, false, text);
    assert.equal(parseJmCommand(text).reason, 'format', text);
  }
});

test('jm-command:作者/原作(IP)/角色/标签/标题/页码结构化条件可解析,普通关键词语义不变', () => {
  assert.deepEqual(parseJmCommand('搜本 作者:甲'), {
    ok: true, action: 'search', mode: 'structured',
    conditions: { creator: ['甲'] }, page: 1, sort: null, keyword: null, countGiven: false,
  });
  assert.deepEqual(parseJmCommand('搜本 原作:乙').conditions, { original: ['乙'] });
  assert.deepEqual(parseJmCommand('搜本 IP:丙').conditions, { original: ['丙'] });
  assert.deepEqual(parseJmCommand('搜本 角色:丁').conditions, { character: ['丁'] });
  assert.deepEqual(parseJmCommand('搜本 标签:戊').conditions, { tag: ['戊'] });
  assert.deepEqual(parseJmCommand('搜本 标题:己').conditions, { title: ['己'] });
  const combo = parseJmCommand('搜本 作者:甲 标签:乙 2');
  assert.deepEqual(combo.conditions, { creator: ['甲'], tag: ['乙'] });
  assert.equal(combo.page, 2);
  assert.equal(parseJmCommand('搜本 作者:甲 全彩').conditions.title[0], '全彩');
  assert.equal(parseJmCommand('搜本 作者:甲 页码:3').page, 3);
  assert.equal(parseJmCommand('搜本 原作:甲 角色:乙').reason, 'unsupported');
  assert.equal(parseJmCommand('搜本 原作:甲 原作:乙').reason, 'unsupported', '多值原作不能静默只查第一个');
  assert.equal(parseJmCommand('搜本 年份:2024').reason, 'unsupported');
  assert.equal(parseJmCommand('搜本 全彩 3').keyword, '全彩');
  assert.equal(parseJmCommand('搜本 全彩 3').count, 3);
});

test('jm-command:字段别名与「键 值」空格写法(2026-11-20 现场:搜本 tag 齁)', () => {
  const structured = (conditions, page = 1) => ({
    ok: true, action: 'search', mode: 'structured', conditions, page, sort: null, keyword: null, countGiven: false,
  });
  assert.deepEqual(parseJmCommand('搜本 tag 齁'), structured({ tag: ['齁'] }));
  assert.deepEqual(parseJmCommand('搜本 标签 齁'), structured({ tag: ['齁'] }));
  assert.deepEqual(parseJmCommand('搜本 tag:齁'), structured({ tag: ['齁'] }));
  assert.deepEqual(parseJmCommand('搜本 tags：齁'), structured({ tag: ['齁'] }), '全角冒号与英文复数');
  assert.deepEqual(parseJmCommand('搜本 作者 张三'), structured({ creator: ['张三'] }));
  assert.deepEqual(parseJmCommand('搜本 author 张三'), structured({ creator: ['张三'] }));
  assert.deepEqual(parseJmCommand('搜本 作者 张三 标签 齁'), structured({ creator: ['张三'], tag: ['齁'] }));
  assert.deepEqual(parseJmCommand('搜本 标题 全彩'), structured({ title: ['全彩'] }));
  assert.deepEqual(parseJmCommand('搜本 标签 齁 2'), structured({ tag: ['齁'] }, 2));
  assert.deepEqual(parseJmCommand('搜本 标签:齁 页码 2'), structured({ tag: ['齁'] }, 2));
  // 写了条件键却没有值 → 明确回格式错误，不能静默降级成关键词（旧行为会拿「标签」去搜）。
  for (const text of ['搜本 标签', '搜本 作者', '搜本 标题']) {
    assert.equal(parseJmCommand(text).reason, 'format', text);
  }
  // 只有页码没有条件键，不是一次有意义的检索。
  assert.equal(parseJmCommand('搜本 页码 2').reason, 'format');
  // 未知键仍然拒绝，不静默当关键词。
  assert.equal(parseJmCommand('搜本 年份:2024').reason, 'unsupported');
  // 普通关键词语义不变。
  assert.equal(parseJmCommand('搜本 全彩').keyword, '全彩');
  assert.equal(parseJmCommand('搜本 全彩 3').count, 3);
});

test('jm-command:模糊搜本的裸“本”接受单字关键词(2026-11-20 现场:搜齁的本)', () => {
  const expected = (keyword) => ({
    ok: true, action: 'search', keyword, count: DEFAULT_JM_MAX, countGiven: false, fuzzy: true,
  });
  for (const [text, keyword] of [
    ['搜齁的本', '齁'], ['来个齁的本', '齁'], ['求齁的本', '齁'], ['搜龘的本', '龘'],
  ]) {
    assert.deepEqual(parseJmFuzzyCommand(text), expected(keyword), text);
  }
  // 单字也不能放过复合词：成本/日本/基本/剧本…
  for (const text of ['来个日本', '来个成本', '来个基本', '来个剧本', '搜日本']) {
    assert.equal(parseJmFuzzyCommand(text), null, text);
  }
});

test('jm-command:近失提示只指出最可能写歪的字段键,不猜也不自动执行', () => {
  assert.deepEqual(suggestJmSyntax('搜本 作都:甲'), { kind: 'field', field: 'creator', alias: '作者', value: '甲' });
  assert.deepEqual(suggestJmSyntax('搜本 tga:齁'), { kind: 'field', field: 'tag', alias: 'tag', value: '齁' });
  assert.equal(suggestJmSyntax('搜本 年份:2024'), null, '离得太远的不猜');
  assert.equal(suggestJmSyntax('搜本 标签 齁'), null, '已经能解析的不用提示');
});

test('jm-command:模糊搜本只认“请求动词 + 句尾 本子/本”,复合词与闲聊不命中', () => {
  const expected = (keyword) => ({
    ok: true, action: 'search', keyword, count: DEFAULT_JM_MAX, countGiven: false, fuzzy: true,
  });
  for (const [text, keyword] of [
    ['搜原神的本子', '原神'],
    ['来个莉音的本', '莉音'],
    ['来点原神的本子', '原神'],
    ['我想看原神的本子', '原神'],
    ['有没有原神的本子', '原神'],
    ['搜原神本', '原神'],
    ['来一本原神的本', '原神'],
    ['来个莉音的本子', '莉音'],
    ['我想看看原神的本子', '原神'],
    ['搜索原神的本子', '原神'],
    ['搜索一下原神的本子', '原神'],
  ]) {
    assert.deepEqual(parseJmFuzzyCommand(text), expected(keyword), text);
  }
  for (const text of [
    '这个本子不错', '我本来想找原神的本子', '老板本来就很忙', '我看完了原神的本子',
    '来个本子', '来个本', '来个日本', '来个成本', '来个笔记本', '搜原神的本子很好看',
    '搜日本', '有没有人看过原神的本子', '有没有人知道原神的本子', '来人帮我看本子',
    '有没有人买过这个本子', '有没有人喜欢这个本子', '来个画本子',
  ]) {
    assert.equal(parseJmFuzzyCommand(text), null, text);
  }
  // 病态输入必须线性返回：旧版嵌套量词正则在这里会指数回溯、卡死事件循环。
  const started = Date.now();
  assert.equal(parseJmFuzzyCommand(`${'我想'.repeat(300)}吃饭`), null);
  assert.ok(Date.now() - started < 1000, '模糊解析对长输入必须毫秒级返回');
  // “我”是允许的前缀；这一条应能进模糊搜索。
  assert.equal(parseJmFuzzyCommand('我来点原神的本子').keyword, '原神');
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
  assert.equal(parseJmCommand('下本 12').targets[0].target, '12', '旧下本编号语义不变');
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
  assert.equal(defaults.requestTimeoutMs, 45_000, '单次请求默认 45s（旧版硬编码 15s，比边车 30s 还短）');
  assert.equal(defaults.limit, 5);
  assert.equal(defaults.images, true);
  assert.equal(defaults.unit, '');
  assert.equal(defaults.pdfMaxBytes, 200 * 1024 * 1024);
  const clamped = parseJmArgs(['--op', 'search', '--limit', '99', '--timeout', 'bad', '--q', '全彩', '--images', '0']);
  assert.equal(clamped.op, 'search');
  assert.equal(clamped.limit, 5);
  assert.equal(clamped.timeoutMs, 120_000);
  assert.equal(clamped.requestTimeoutMs, 45_000, '坏值回落默认');
  assert.equal(parseJmArgs(['--request-timeout', '60000']).requestTimeoutMs, 60_000);
  assert.equal(parseJmArgs(['--request-timeout', 'bad']).requestTimeoutMs, 45_000);
  assert.equal(parseJmArgs(['--timeout', '10000', '--request-timeout', '60000']).requestTimeoutMs, 10_000, '单次请求不能超出总预算');
  assert.equal(clamped.q, '全彩');
  assert.equal(clamped.images, false);
  assert.equal(parseJmArgs(['--unit', '1205081']).unit, '1205081');
  const structured = parseJmArgs([
    '--op', 'search', '--q', '龙', '--mode', 'author', '--page', '2',
    '--details', '1', '--limit', '99',
  ]);
  assert.equal(structured.mode, 'author');
  assert.equal(structured.page, 2);
  assert.equal(structured.details, true);
  assert.equal(structured.limit, 10, '结构化检索最多取 10 个候选做复核');
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
  // 边车自己的超时（jm_search_timeout → 504）必须翻成 timeout，不能报成"服务没启动"。
  assert.equal(
    (await run(async () => jsonRes({ ok: false, error: 'jm_search_timeout', message: 'JM 搜索超时，请稍后重试' }, 504))).reason,
    'timeout',
  );
  assert.equal(
    (await run(async () => jsonRes({ ok: false, error: 'jm_search_failed', message: 'JM 搜索失败' }, 502))).reason,
    'http_error',
    '非超时的上游失败仍是 http_error（由服务层回"没成功"而不是"服务没启动"）',
  );
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

test('jm-fetch:结构化 search 传 mode/page/details 并解析文字详情;坏 mode/page 不联网', async () => {
  const urls = [];
  const payload = await runJmFetch(
    {
      op: 'search', q: '龙', mode: 'author', page: 2, details: true,
      limit: 10, images: false, api: 'http://127.0.0.1:8790', timeoutMs: 5000,
    },
    {
      log: noopLog,
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonRes({
          ok: true, total: 1, results: [{
            rank: 1, id: '101', title: '合成作品', authors: ['作者甲'], tags: ['全彩'],
            page_count: 20, detail_ok: true,
          }],
        });
      },
    },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'author');
  assert.equal(payload.page, 2);
  assert.equal(payload.details, true);
  assert.match(urls[0], /q=.+&limit=10&page=2&mode=author/u);
  assert.match(urls[0], /images=0/u);
  assert.match(urls[0], /details=1/u);
  assert.deepEqual(payload.results[0], {
    rank: 1, id: '101', title: '合成作品', authors: ['作者甲'], tags: ['全彩'],
    pageCount: 20, detailOk: true,
  });

  for (const bad of [
    { op: 'search', q: '龙', mode: 'bogus', api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    { op: 'search', q: '龙', page: 0, api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
    { op: 'search', q: '龙', page: 100001, api: 'http://127.0.0.1:8790', timeoutMs: 5000 },
  ]) {
    let called = false;
    const result = await runJmFetch(bad, {
      log: noopLog,
      fetchImpl: async () => { called = true; return jsonRes({ ok: true, results: [] }); },
    });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.reason, 'bad_args', JSON.stringify(bad));
    assert.equal(called, false, '坏参数必须在任何 HTTP 前失败');
  }
});

test('jm-fetch:resolve 作品/单元两种形状都归一;404 翻成 not_found', async () => {
  const album = {
    ok: true, kind: 'album', requested: '1195659',
    album: {
      id: '1195659', title: '合成作品', authors: ['合成作者'], tags: ['全彩'],
      page_count: 120, unit_count: 2,
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
  // 2026-11-17：resolve 回包把 authors/tags 透传给目录收藏；缺字段 = null（未知）。
  assert.deepEqual(byAlbum.album.authors, ['合成作者']);
  assert.deepEqual(byAlbum.album.tags, ['全彩']);
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

/** 结构化检索夹具：只允许 health/search，记录参数；任何 download/pdf 直接判红。 */
function makeStructuredFixture(dir, group, { results = [], healthCaps = ['units', 'details'] } = {}) {
  const calls = { fetch: [] };
  const runFetch = async ({ args }) => {
    calls.fetch.push(args);
    const op = args[args.indexOf('--op') + 1];
    if (op === 'health') {
      return {
        code: 0, stderr: '', timedOut: false,
        stdout: JSON.stringify({ ok: true, service: 'jm-service', capabilities: healthCaps }),
      };
    }
    if (op === 'search') {
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(searchPayload({ results })) };
    }
    throw new Error(`结构化检索不允许操作 ${op}`);
  };
  const made = makeDeps({ dir, groups: [group], runFetch });
  const run = (text) => handleJmCommand({
    message: message(group),
    parsed: parseJmCommand(text),
    deps: made.deps,
  });
  const operations = () => calls.fetch.map((args) => args[args.indexOf('--op') + 1]);
  const searchArgs = () => calls.fetch.filter((args) => args.includes('search')).at(-1) ?? [];
  return { ...made, run, operations, searchArgs, calls: { ...made.calls, fetch: calls.fetch } };
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
  requestTimeoutMs = 45_000,
  payloads = [searchPayload()],
  now,
  lines,
  runFetch,
  uploadFile,
  sendMedia,
  reply,
  workingAckMs,
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
        requestTimeoutMs,
      },
    },
    log: SILENT_LOG,
    now: typeof now === 'function' ? now : () => 1_700_000_000_000,
    rng: () => 0,
    ...(typeof workingAckMs === 'number' ? { workingAckMs } : {}),
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

test('jm-service:结构化检索按作者/标签/标题/原作/角色选 mode，AND 过滤且不自动下载', async () => {
  await withTemp(async (dir) => {
    const results = [
      { id: '101', title: '全彩甲', authors: ['作者甲'], tags: ['全彩'], detailOk: true },
      { id: '102', title: '黑白乙', authors: ['作者甲'], tags: ['黑白'], detailOk: true },
      { id: '103', title: '全彩丙', authors: ['作者乙'], tags: ['全彩'], detailOk: false },
      { id: '104', title: '全彩丁', authors: ['作者乙'], tags: ['黑白'], detailOk: true },
    ];
    const fixture = makeStructuredFixture(dir, 'g-jm-structured', { results });

    const byAuthor = await fixture.run('搜本 作者:作者甲');
    assert.equal(byAuthor.ok, true);
    assert.equal(byAuthor.sent, 0, '结构化检索只给清单，不自动下载');
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--mode') + 1], 'author');
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--page') + 1], '1');
    assert.ok(fixture.searchArgs().includes('--details'));
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--details') + 1], '1');
    assert.ok(fixture.searchArgs().includes('--images'));
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--images') + 1], '0');
    assert.match(fixture.calls.reply.at(-1), /本次检查范围内找到 2 本/u);
    assert.deepEqual(fixture.calls.reply.at(-1).split('\n').slice(1), [
      '1. JM101 全彩甲', '2. JM102 黑白乙',
    ], '结构化命中行仅序号、JM 编号和标题；作者/标签仅用于匹配');
    assert.equal(fixture.calls.upload.length, 0);
    assert.equal(fixture.calls.send.length, 0);

    const byTag = await fixture.run('搜本 标签:全彩');
    assert.equal(byTag.ok, true);
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--mode') + 1], 'tag');
    assert.match(fixture.calls.reply.at(-1), /本次检查范围内找到 1 本/u);
    assert.match(fixture.calls.reply.at(-1), /JM101/u);
    assert.doesNotMatch(fixture.calls.reply.at(-1), /JM103/u, '缺文字详情不能当成匹配');
    assert.match(fixture.calls.reply.at(-1), /其中 1 本缺文字详情/u);

    const andFiltered = await fixture.run('搜本 作者:作者甲 标签:全彩');
    assert.equal(andFiltered.ok, true);
    assert.match(fixture.calls.reply.at(-1), /找到 1 本/u);
    assert.match(fixture.calls.reply.at(-1), /JM101/u);
    assert.doesNotMatch(fixture.calls.reply.at(-1), /JM102/u);

    const byTitle = await fixture.run('搜本 标题:全彩');
    assert.equal(byTitle.ok, true);
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--mode') + 1], 'site');
    assert.match(fixture.calls.reply.at(-1), /找到 3 本/u);
    assert.match(fixture.calls.reply.at(-1), /JM101/u);
    assert.match(fixture.calls.reply.at(-1), /JM103/u);
    assert.match(fixture.calls.reply.at(-1), /JM104/u);

    const byWork = await fixture.run('搜本 原作:原作甲');
    assert.equal(byWork.ok, true);
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--mode') + 1], 'work');

    const byActor = await fixture.run('搜本 角色:角色甲');
    assert.equal(byActor.ok, true);
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--mode') + 1], 'actor');

    const page2 = await fixture.run('搜本 作者:作者甲 页码:2');
    assert.equal(page2.ok, true);
    assert.equal(fixture.searchArgs()[fixture.searchArgs().indexOf('--page') + 1], '2');

    // 单命中也不自动下载；只给清单。
    const unique = await fixture.run('搜本 标题:黑白乙');
    assert.equal(unique.ok, true);
    assert.equal(unique.sent, 0);
    assert.match(fixture.calls.reply.at(-1), /JM102/u);
    assert.equal(fixture.calls.upload.length, 0);
    assert.equal(fixture.calls.send.length, 0);
    assert.deepEqual(fixture.operations().filter((op) => op !== 'health' && op !== 'search'), []);
  });
});

const BLOCKED_LIST_NOTICE = '抱歉，这份清单没法发。如果你知道编号，可以直接用「下本 <编号>」。';
const listModerationError = (code = 40034006) => Object.assign(new Error('QQ 拒绝发送'), { code });

test('jm-service:结构化清单遇 40034006 仅发送固定提示，回话串行且不复用已送达分片的 seq', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-structured-blocked';
    const events = [];
    const delivered = [];
    const errors = [];
    let inFlight = 0;
    let peak = 0;
    const payload = searchPayload({ results: [
      { id: '18472', title: '合成清单标题', authors: ['合成作者'], tags: ['合成标签'], detailOk: true },
    ] });
    const { deps, calls } = makeDeps({
      dir, groups: [group], workingAckMs: 0, cooldownMs: 5000,
      runFetch: async ({ args }) => {
        const op = args[args.indexOf('--op') + 1];
        if (op === 'search') await new Promise((resolve) => setTimeout(resolve, 5));
        const data = op === 'health' ? { ok: true, capabilities: ['details'] } : payload;
        return { code: 0, stdout: JSON.stringify(data), stderr: '', timedOut: false };
      },
      reply: async (text, { startSeq, active, onPassiveSent }) => {
        events.push({ text, startSeq, active });
        peak = Math.max(peak, ++inFlight);
        try {
          if (text === DEFAULT_JM_LINES.working[0]) {
            // 抓取已返回时此回执仍在发；下一条得等它完成并消耗 msg_seq=1。
            await new Promise((resolve) => setTimeout(resolve, 20));
            delivered.push(text);
            return 1; // 现有 reply 注入的数字返回接口继续可用。
          }
          if (text.startsWith('本次检查范围内找到')) {
            onPassiveSent?.(startSeq + 1); // 模拟首块送达、下一块被拒绝。
            throw listModerationError();
          }
          delivered.push(text);
          onPassiveSent?.(startSeq + 1);
          return { sent: 1 };
        } finally {
          inFlight -= 1;
        }
      },
    });
    deps.log = { ...SILENT_LOG, error: (...parts) => errors.push(parts.join(' ')) };
    const run = (text) => handleJmCommand({ message: message(group), parsed: parseJmCommand(text), deps });
    const rejected = await run('搜本 标签:合成标签');
    assert.deepEqual(delivered, [DEFAULT_JM_LINES.working[0], BLOCKED_LIST_NOTICE], '假 reply 确认实际接收的只有回执和固定提示');
    assert.deepEqual(events.map(({ startSeq, active }) => ({ startSeq, active })), [
      { startSeq: 0, active: false }, { startSeq: 1, active: false }, { startSeq: 2, active: false },
    ], '兜底占下一可用槽位，不覆盖首个成功分片');
    assert.equal(peak, 1, '回执、清单和兜底不能并发发送');
    assert.match(events[1].text, /JM18472 合成清单标题/u);
    assert.doesNotMatch(errors.join('\n'), /合成清单标题|合成作者|合成标签|18472/u, '被拒内容不写进发送失败日志');
    assert.deepEqual(rejected, { ok: false, reason: 'list_blocked', sent: 0, action: 'search' });
    assert.equal((await run('下本 1')).reason, 'ordinal_missing', '部分发送的清单也不可按序号选择');
    assert.equal(calls.upload.length, 0);
    assert.equal((await run('搜本 标签:合成标签')).reason, 'list_blocked', '未送达不占搜索冷却');
  });
});

test('jm-service:普通/模糊搜本和单元清单共用出站判据，其他错误不兜底、兜底失败只试一次', async () => {
  await withTemp(async (dir) => {
    const list = searchPayload({ results: [{ id: '201', title: '合成甲' }, { id: '202', title: '合成乙' }] });
    const units = resolvePayload({ album: albumPayload({ id: '700', units: [
      { index: 1, unitId: '711', title: '合成单元甲' }, { index: 2, unitId: '722', title: '合成单元乙' },
    ] }) });
    const cases = [
      { text: '搜本 合成 2', payload: list, error: Object.assign(new Error('上下文提及 40034006'), { code: 40034105 }), attempts: 1 },
      { text: '搜合成的本子', payload: list, error: listModerationError(), fallbackError: listModerationError(), attempts: 2 },
      { text: '搜本 700', payload: units, error: listModerationError('40034006'), attempts: 2, delivered: true },
      { text: '下本 700', payload: units, error: new Error('消息内容违规'), attempts: 1, action: 'download' },
      { text: '搜本 合成 2', payload: list, attempts: 1 }, // reply 返回 undefined（未发）也不能当成功。
      { text: '搜本 合成 2', payload: list, error: listModerationError(), attempts: 2 }, // 兜底无输出不是成功。
    ];
    for (const [i, { text, payload, error, fallbackError, attempts, action = 'search', delivered = false }] of cases.entries()) {
      const group = `g-jm-list-send-${i}`;
      const prepared = makeDeps({ dir, groups: [group], payloads: [list] });
      const run = (parsed, deps) => handleJmCommand({ message: message(group), parsed, deps });
      assert.equal((await run(parseJmCommand('搜本 合成 2'), prepared.deps)).ok, true, '预先建立一份可见清单');
      const tried = [];
      const seen = [];
      const { deps, calls } = makeDeps({
        dir, groups: [group], payloads: [payload],
        reply: async (out, { startSeq, active }) => {
          tried.push({ out, startSeq, active });
          if (tried.length === 1 && error) throw error;
          if (tried.length === 2 && fallbackError) throw fallbackError;
          if (tried.length === 2 && delivered) { seen.push(out); return 1; }
          return undefined;
        },
      });
      const result = await run(parseJmFuzzyCommand(text) ?? parseJmCommand(text), deps);
      assert.equal(tried.length, attempts, text);
      if (attempts === 2) assert.deepEqual(tried[1], { out: BLOCKED_LIST_NOTICE, startSeq: 0, active: false });
      assert.deepEqual(seen, delivered ? [BLOCKED_LIST_NOTICE] : []);
      assert.deepEqual(result, { ok: false, reason: delivered ? 'list_blocked' : 'list_send_failed', sent: 0, action });
      assert.equal((await run(parseJmCommand('下本 1'), prepared.deps)).reason, 'ordinal_missing');
      assert.equal((await run(parseJmCommand('整本打包'), prepared.deps)).reason, 'no_units');
      assert.equal(prepared.calls.fetch.length, 1, '失败清单不能触发任何序号下载或打包，也不能落回旧清单');
      assert.equal(calls.fetch.length, 1);
      assert.equal(calls.send.length, 0);
    }
  });
});

test('jm-service:结构化检索旧边车无 details 能力→拒绝；0 命中说明检查范围', async () => {
  await withTemp(async (dir) => {
    const old = makeStructuredFixture(dir, 'g-jm-structured-old', {
      results: [{ id: '101', title: '甲', authors: [], tags: [], detailOk: false }],
      healthCaps: ['units'],
    });
    const rejected = await old.run('搜本 作者:作者甲');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'details_unsupported');
    assert.deepEqual(old.operations(), ['health'], '旧边车不得进入搜索');
    assert.match(old.calls.reply[0], /旧版/u);

    const empty = makeStructuredFixture(dir, 'g-jm-structured-empty', {
      results: [{ id: '101', title: '甲', authors: [], tags: [], detailOk: false }],
    });
    const noHit = await empty.run('搜本 标签:全彩');
    assert.equal(noHit.ok, false);
    assert.equal(noHit.reason, 'no_result');
    assert.match(empty.calls.reply.at(-1), /本次检查范围内没找到/u);
    assert.match(empty.calls.reply.at(-1), /缺文字详情/u);
    assert.equal(empty.calls.upload.length, 0);
    assert.equal(empty.calls.send.length, 0);
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

test('jm-service:listOnly(模型工具)唯一命中 → 只回清单，不自动下载(审查 P1-2)', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-listonly';
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        searchPayload({ results: [{ id: '101', title: '合成本甲' }] }),
        // 后面这些如果被调用就说明"只给清单"没守住。
        resolvePayload({ album: albumPayload({ id: '101', title: '合成本甲' }) }),
        downloadPayload({ id: '101', title: '合成本甲' }),
      ],
    });
    const parsed = { ...parseJmCommand('搜本 全彩'), listOnly: true };
    const result = await handleJmCommand({ message: message(group), parsed, deps });
    assert.equal(result.ok, true);
    assert.ok(!result.sent, '只给清单，不该有文件数');
    assert.equal(calls.fetch.length, 1, '只发 search，不进 resolve/download/pdf');
    assert.ok(calls.fetch[0].args.includes('search'));
    assert.equal(calls.upload.length, 0);
    assert.equal(calls.send.length, 0);
    assert.match(calls.reply.at(-1), /JM101|合成本甲/u, '清单里要有候选');
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

test('jm-service:下本1 2 一次下两本(现场原文) → 两本各下一次、各发一个 PDF', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-dl-many';
    const pdfA = makePdfFile(dir, '1489725');
    const pdfB = makePdfFile(dir, '1488143');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        searchPayload({
          results: [
            { id: '1489725', title: '合成甲' },
            { id: '1488143', title: '合成乙' },
          ],
        }),
        resolvePayload({ album: albumPayload({ id: '1489725', title: '合成甲' }) }),
        downloadPayload({ id: '1489725', title: '合成甲' }),
        pdfPayload({ id: '1489725', file: pdfA }),
        resolvePayload({ album: albumPayload({ id: '1488143', title: '合成乙' }) }),
        downloadPayload({ id: '1488143', title: '合成乙' }),
        pdfPayload({ id: '1488143', file: pdfB }),
      ],
    });
    const listed = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(listed.sent, 0, '多本只给清单');

    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本1 2'), deps });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 2, '两本都真的下了');
    assert.deepEqual(calls.upload.map((one) => one.fileName), ['JM1489725.pdf', 'JM1488143.pdf']);
    assert.equal(calls.send.length, 2);
    assert.equal(calls.reply.length, 3, '清单一条 + 每本一条下载回执');
    assert.deepEqual(calls.send.map((one) => one.msgSeq), [2, 4], '回执/文件交替占用被动槽位');
  });
});

test('jm-service:下本<编号A 编号B>(现场原文,没有清单也能下) → 按编号逐个解析下载', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-dl-two-ids';
    const pdfA = makePdfFile(dir, '1489725');
    const pdfB = makePdfFile(dir, '1488143');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        resolvePayload({ album: albumPayload({ id: '1489725', title: '合成甲' }) }),
        downloadPayload({ id: '1489725', title: '合成甲' }),
        pdfPayload({ id: '1489725', file: pdfA }),
        resolvePayload({ album: albumPayload({ id: '1488143', title: '合成乙' }) }),
        downloadPayload({ id: '1488143', title: '合成乙' }),
        pdfPayload({ id: '1488143', file: pdfB }),
      ],
    });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本1489725 1488143'), deps });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 2);
    assert.deepEqual(calls.fetch.map((one) => one.args[one.args.indexOf('--op') + 1]),
      ['resolve', 'download', 'pdf', 'resolve', 'download', 'pdf']);
    assert.deepEqual(calls.upload.map((one) => one.fileName), ['JM1489725.pdf', 'JM1488143.pdf']);
  });
});

test('jm-service:多选里有一个卡住就当场收口,不假装后面的也下了', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-dl-stop';
    const pdfA = makePdfFile(dir, '1489725');
    const { deps, calls } = makeDeps({
      dir,
      groups: [group],
      payloads: [
        searchPayload({
          results: [
            { id: '1489725', title: '合成甲' },
            { id: '1488143', title: '合成乙' },
          ],
        }),
        resolvePayload({ album: albumPayload({ id: '1489725', title: '合成甲' }) }),
        downloadPayload({ id: '1489725', title: '合成甲' }),
        pdfPayload({ id: '1489725', file: pdfA }),
      ],
    });
    await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    // 清单只有 2 本：第 3 个序号越界 → 第 1 本已下，第 2 个不再猜。
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('下本 1 3'), deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ordinal_missing');
    assert.equal(calls.upload.length, 1, '前一个已下发的照发，不补第二个');
    assertReplyIn(calls, 'ordinalMissing');
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

test('jm-service:模糊搜本唯一命中只给清单，不沿用自动下载', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({
      dir,
      payloads: [searchPayload({ results: [{ id: '101', title: '合成原神本' }], total: 1 })],
    });
    const result = await handleJmCommand({
      message: message('g-jm'),
      parsed: parseJmFuzzyCommand('搜原神的本子'),
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 0, '模糊入口只给清单');
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0].args[calls.fetch[0].args.indexOf('--q') + 1], '原神');
    assert.match(calls.reply.at(-1), /搜到1本/u);
    assert.equal(calls.upload.length, 0);
    assert.equal(calls.send.length, 0);
  });
});

test('jm-service:模糊入口的纯数字仍按关键词搜索，不按编号解析/下载', async () => {
  await withTemp(async (dir) => {
    const { deps, calls } = makeDeps({
      dir,
      payloads: [searchPayload({ results: [{ id: '101', title: '合成数字本' }], total: 2 })],
    });
    const result = await handleJmCommand({
      message: message('g-jm'),
      parsed: parseJmFuzzyCommand('搜123的本子'),
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0].args[calls.fetch[0].args.indexOf('--op') + 1], 'search', '模糊入口不能转成编号解析');
    assert.equal(calls.fetch[0].args[calls.fetch[0].args.indexOf('--q') + 1], '123');
    assert.equal(calls.upload.length, 0);
    assert.equal(calls.send.length, 0);
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
      // 边车活着但回了 4xx/5xx（JM 上游失败）：说"没成功"，不能说"服务没启动"。
      { stdout: JSON.stringify({ ok: false, reason: 'http_error', detail: 'HTTP 502' }), timedOut: false, key: 'searchFailed' },
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
  assert.match(text, /^搜到2本（共9本），回复 下本 <编号或序号> 打包整本 PDF（可一次多个，空格隔开）：/u);
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

test('jm-service:抓取器带 --request-timeout(默认 45s,可配),不再硬编码 15s', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-reqtimeout';
    const results = [{ id: '101', title: '合成本甲' }, { id: '102', title: '合成本乙' }];
    const def = makeDeps({ dir, groups: [group], payloads: [searchPayload({ results })] });
    await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps: def.deps });
    const args = def.calls.fetch[0].args;
    assert.equal(args[args.indexOf('--request-timeout') + 1], '45000');

    const custom = makeDeps({ dir, groups: [group], payloads: [searchPayload({ results })], requestTimeoutMs: 60_000 });
    await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps: custom.deps });
    const customArgs = custom.calls.fetch[0].args;
    assert.equal(customArgs[customArgs.indexOf('--request-timeout') + 1], '60000');
  });
});

test('jm-service:近失提示只说一句能照抄的话(不再甩整面格式墙)', () => {
  assert.equal(
    buildJmFormatHint('搜本 作都:甲'),
    '想按作者搜？发「搜本 作者:甲」。只写「搜本 甲」是按关键词搜。',
  );
  assert.equal(buildJmFormatHint('搜本 标签'), DEFAULT_JM_LINES.formatShort[0]);
  assert.ok(buildJmFormatHint('搜本 标签').length <= Array.from(DEFAULT_JM_LINES.formatShort[0]).length);
  assert.ok(DEFAULT_JM_LINES.formatShort[0].length < DEFAULT_JM_LINES.format[0].length, '短提示必须真的比旧格式墙短');
});

test('jm-service:解析失败分流保留页码/超量/格式，近失才提示纠正，多编号引导下本', () => {
  for (const [text, reason, expected] of [
    ['搜本 作都:甲', 'unsupported', '想按作者搜？发「搜本 作者:甲」。只写「搜本 甲」是按关键词搜。'],
    ['搜本 年份:2024', 'unsupported', DEFAULT_JM_LINES.unsupportedCondition[0]],
    ['搜本 原作:甲 角色:乙', 'unsupported', DEFAULT_JM_LINES.unsupportedCondition[0]],
    ['搜本 标签:甲 页码:0', 'page', DEFAULT_JM_LINES.pageFormat[0]],
    ['下本 1 2 3 4 5 6', 'tooMany', DEFAULT_JM_LINES.tooMany[0]],
    ['搜本 标签', 'format', DEFAULT_JM_LINES.formatShort[0]],
    ['搜本 123456 234567', 'useDownload', '要下多个编号，请用「下本 <编号1> <编号2>」，每次最多 5 个。'],
  ]) {
    assert.equal(parseJmCommand(text).reason, reason);
    assert.equal(buildJmParseFailureReply(text, reason), expected, text);
  }
});

test('jm-service:同群前一条没跑完 → 后一条先回「排队中」(不再无声等待)', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-queue';
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let first = true;
    const runFetch = async () => {
      if (first) { first = false; await gate; }
      return {
        code: 0, stderr: '', timedOut: false,
        stdout: JSON.stringify(searchPayload({ results: [{ id: '101', title: '合成本甲' }, { id: '102', title: '合成本乙' }] })),
      };
    };
    const { deps, calls } = makeDeps({ dir, groups: [group], runFetch });
    const a = handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    // 第一条已经同步入队（pending=1）；等一拍再发第二条，确保它看到排队现场。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const b = handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.reply.includes(DEFAULT_JM_LINES.queued[0]), '后一条应先收到排队提示');
    release();
    await Promise.all([a, b]);
  });
});

test('jm-service:搜索超过等待线先回「在搜了」,最终结果按序到', async () => {
  await withTemp(async (dir) => {
    const group = 'g-jm-slow';
    const runFetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        code: 0, stderr: '', timedOut: false,
        stdout: JSON.stringify(searchPayload({ results: [{ id: '101', title: '合成本甲' }, { id: '102', title: '合成本乙' }] })),
      };
    };
    const { deps, calls } = makeDeps({ dir, groups: [group], runFetch, workingAckMs: 5 });
    const result = await handleJmCommand({ message: message(group), parsed: parseJmCommand('搜本 全彩'), deps });
    assert.equal(result.ok, true);
    const at = calls.reply.indexOf(DEFAULT_JM_LINES.working[0]);
    assert.ok(at >= 0, '慢搜索要先回「在搜了」');
    assert.ok(at < calls.reply.length - 1, '最终结果必须在提示之后（回话串行链）');
  });
});

// ---------------------------------------------------------------------------
// ③-b 排序 + 翻页（2026-11-25 主人拍板：最新+热门、每页 5、下一页/上一页、
//     全局连续序号、仅第 1 页自动下载、排序两种检索都要）
// ---------------------------------------------------------------------------

test('jm-command:排序键 —— 冒号/空格/粘连写法,最新/热门,非法值明确拒绝', () => {
  for (const text of ['搜本 全彩 排序:热门', '搜本 全彩 排序 热门', '搜本 全彩 排序热门', '搜本 全彩 order:mv']) {
    const parsed = parseJmCommand(text);
    assert.equal(parsed.ok, true, text);
    assert.equal(parsed.keyword, '全彩', text);
    assert.equal(parsed.sort, 'mv', text);
    assert.equal(parsed.page, 1, text);
  }
  assert.equal(parseJmCommand('搜本 全彩 排序:最新').sort, 'mr');
  assert.equal(parseJmCommand('搜本 全彩').sort, undefined, '不写排序 = 不带 sort 字段（旧形状不变）');
  // 结构化也要排序（主人拍板）。
  const structured = parseJmCommand('搜本 作者:甲 排序:热门');
  assert.equal(structured.ok, true);
  assert.equal(structured.mode, 'structured');
  assert.equal(structured.sort, 'mv');
  assert.deepEqual(structured.conditions, { creator: ['甲'] });
  assert.equal(parseJmCommand('搜本 标签:全彩 排序 热门 页码:2').sort, 'mv');
  // 非法/重复/缺值明确拒绝，不静默按默认排序。
  assert.equal(parseJmCommand('搜本 全彩 排序:年份').reason, 'sort');
  assert.equal(parseJmCommand('搜本 全彩 排序:热门 排序:最新').reason, 'sort');
  assert.equal(parseJmCommand('搜本 全彩 排序').reason, 'sort');
  assert.equal(parseJmCommand('搜本 排序:热门').reason, 'format', '只有排序没有关键词不是检索');
  assert.equal(parseJmCommand('搜本 作者:甲 排序:tf').reason, 'sort', '上游未开放的值不收');
});

test('jm-command:关键词页码与翻页独立词、显式序号 序号N', () => {
  const p2 = parseJmCommand('搜本 全彩 页码:2');
  assert.equal(p2.ok, true);
  assert.equal(p2.keyword, '全彩');
  assert.equal(p2.page, 2);
  assert.equal(p2.countGiven, false);
  const p2c3 = parseJmCommand('搜本 全彩 3 页码:2');
  assert.equal(p2c3.count, 3, '裸数字仍是数量词');
  assert.equal(p2c3.page, 2);
  assert.equal(parseJmCommand('搜本 全彩 页码 2').page, 2, '空格写法');
  assert.equal(parseJmCommand('搜本 页码:2').reason, 'format', '只有页码没有关键词');
  assert.equal(parseJmCommand('搜本 全彩 页码:0').reason, 'page');
  assert.equal(parseJmCommand('搜本 全彩 页码:10000').reason, 'page');
  // 翻页独立词。
  assert.deepEqual(parseJmCommand('下一页'), { ok: true, action: 'page', delta: 1 });
  assert.deepEqual(parseJmCommand('上一页'), { ok: true, action: 'page', delta: -1 });
  assert.deepEqual(parseJmCommand('@爱丽丝 下一页'), { ok: true, action: 'page', delta: 1 });
  assert.equal(parseJmCommand('下一页啊').ok, false, '带尾巴不算独立词');
  // 显式序号（全局序号可超 9）；# / 第 / 裸两位数字的旧语义不破坏。
  assert.deepEqual(parseJmCommand('下本 序号12').targets, [{ kind: 'ordinal', ordinal: 12 }]);
  assert.deepEqual(parseJmCommand('下本 序号12 序号13').targets, [
    { kind: 'ordinal', ordinal: 12 }, { kind: 'ordinal', ordinal: 13 },
  ]);
  assert.equal(parseJmCommand('下本 序号0').ok, false);
  assert.equal(parseJmCommand('下本 #1490076').targets[0].target, '1490076', '# 仍是编号前缀');
  assert.equal(parseJmCommand('下本 10').targets[0].target, '10', '裸两位数字仍是编号');
});

test('jm-fetch:--order 校验与传参,缺省不发 order（旧边车兼容）', async () => {
  assert.equal(parseJmArgs(['--order', 'mv']).order, 'mv');
  assert.equal(parseJmArgs(['--order', 'MR']).order, 'mr', '大小写归一');
  assert.equal(parseJmArgs([]).order, '');
  const urls = [];
  const run = (options) => runJmFetch(
    { op: 'search', q: '全彩', api: 'http://127.0.0.1:8790', timeoutMs: 5000, ...options },
    {
      log: noopLog,
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonRes({ ok: true, total: 0, results: [], order: options.order || 'mr' });
      },
    },
  );
  const hot = await run({ order: 'mv', page: 2 });
  assert.equal(hot.ok, true);
  assert.equal(hot.order, 'mv');
  assert.ok(urls.at(-1).includes('order=mv'), urls.at(-1));
  assert.ok(urls.at(-1).includes('page=2'), urls.at(-1));
  const plain = await run({});
  assert.equal(plain.order, 'mr');
  assert.ok(!urls.at(-1).includes('order='), '缺省不发 order，旧边车按最新回');
  const bad = await run({ order: 'tf' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_args');
});

test('jm-fetch:--window 逻辑翻页参数,缺省不发 window（旧边车兼容）', async () => {
  assert.equal(parseJmArgs(['--window', '1']).window, true);
  assert.equal(parseJmArgs(['--window', 'true']).window, true);
  assert.equal(parseJmArgs(['--window', '0']).window, false);
  assert.equal(parseJmArgs([]).window, false);
  const urls = [];
  const run = (options) => runJmFetch(
    { op: 'search', q: '全彩', api: 'http://127.0.0.1:8790', timeoutMs: 5000, ...options },
    {
      log: noopLog,
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonRes({ ok: true, total: 12, results: [{ id: '106', title: '己' }] });
      },
    },
  );
  const paged = await run({ page: 2, limit: 5, window: true, images: false });
  assert.equal(paged.ok, true);
  assert.equal(paged.window, true);
  assert.ok(urls.at(-1).includes('window=1'), urls.at(-1));
  assert.ok(urls.at(-1).includes('page=2'), urls.at(-1));
  assert.ok(urls.at(-1).includes('images=0'), 'window 只回文字清单，不取图');
  const plain = await run({ page: 1, limit: 5, images: false });
  assert.equal(plain.window, false);
  assert.ok(!urls.at(-1).includes('window='), '缺省不发 window，旧边车按上游页回');
});

/** 翻页夹具：search 按 --page 回不同结果；翻页窗口（--window 1）按逻辑页切片。 */
function makePagingFixture(dir, group, { pages, total, healthCaps = ['units', 'details', 'sort', 'paging'], cooldownMs = 0, now, groups } = {}) {
  const calls = { fetch: [] };
  const flatPages = () => Object.keys(pages).map(Number).sort((a, b) => a - b)
    .flatMap((page) => pages[page] ?? []);
  const runFetch = async ({ args }) => {
    calls.fetch.push(args);
    const op = args[args.indexOf('--op') + 1];
    if (op === 'health') {
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ ok: true, capabilities: healthCaps }) };
    }
    if (op === 'search') {
      const page = Number(args[args.indexOf('--page') + 1] ?? 1);
      const limit = Number(args[args.indexOf('--limit') + 1] ?? 5);
      // window=1 是逻辑翻页：第 page 页 = 扁平结果流里第 (page-1)*limit 起的 limit 条。
      const results = args.includes('--window')
        ? flatPages().slice((page - 1) * limit, page * limit)
        : (pages[page] ?? []);
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(searchPayload({ results, total })) };
    }
    if (op === 'resolve') {
      const id = args[args.indexOf('--id') + 1];
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(resolvePayload({ album: albumPayload({ id, title: `合成本${id}` }) })) };
    }
    if (op === 'download') {
      const id = args[args.indexOf('--id') + 1];
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(downloadPayload({ id, title: `合成本${id}` })) };
    }
    if (op === 'pdf') {
      const id = args[args.indexOf('--id') + 1];
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(pdfPayload({ id, file: makePdfFile(dir, id) })) };
    }
    throw new Error(`翻页夹具不允许操作 ${op}`);
  };
  const made = makeDeps({ dir, groups: groups ?? [group], runFetch, cooldownMs, ...(now ? { now } : {}) });
  const run = (text, target = group) => handleJmCommand({
    message: message(target),
    parsed: parseJmCommand(text),
    deps: made.deps,
  });
  const searchArgsList = () => calls.fetch.filter((args) => args.includes('search'));
  return { ...made, run, calls: { ...made.calls, fetch: calls.fetch }, searchArgsList };
}

const PAGING_PAGES = {
  1: [{ id: '101', title: '甲' }, { id: '102', title: '乙' }, { id: '103', title: '丙' }, { id: '104', title: '丁' }, { id: '105', title: '戊' }],
  2: [{ id: '201', title: '己' }, { id: '202', title: '庚' }, { id: '203', title: '辛' }, { id: '204', title: '壬' }, { id: '205', title: '癸' }],
  3: [{ id: '301', title: '子' }, { id: '302', title: '丑' }],
};

test('jm-service:排序参数传递 —— 默认热门带 --order mv,显式最新带 mr;旧边车只在显式热门时报旧版', async () => {
  await withTemp(async (dir) => {
    const results = PAGING_PAGES[1];
    const hot = makePagingFixture(dir, 'g-sort', { pages: { 1: results }, total: 5 });
    const ok = await hot.run('搜本 全彩 排序:热门');
    assert.equal(ok.ok, true);
    const args = hot.searchArgsList().at(-1);
    assert.equal(args[args.indexOf('--order') + 1], 'mv');
    assert.equal(args[args.indexOf('--page') + 1], '1');
    // 缺省 = 热门（2026-11-25 主人拍板【暂定】）：显式发 mv，不再依赖边车缺省。
    const plain = makePagingFixture(dir, 'g-sort-plain', { pages: { 1: results }, total: 5 });
    await plain.run('搜本 全彩');
    assert.equal(plain.searchArgsList().at(-1)[plain.searchArgsList().at(-1).indexOf('--order') + 1], 'mv', '默认排序=热门');
    // 显式「排序:最新」换回最新。
    const latest = makePagingFixture(dir, 'g-sort-latest', { pages: { 1: results }, total: 5 });
    await latest.run('搜本 全彩 排序:最新');
    assert.equal(latest.searchArgsList().at(-1)[latest.searchArgsList().at(-1).indexOf('--order') + 1], 'mr');
    // 旧边车（无 sort 能力）+ 显式热门 → 固定话术，且不发起搜索。
    const old = makePagingFixture(dir, 'g-sort-old', { pages: { 1: results }, total: 5, healthCaps: ['units', 'details'] });
    const denied = await old.run('搜本 全彩 排序:热门');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'sort_unsupported');
    assertReplyIn(old.calls, 'sortUnsupported');
    assert.equal(old.searchArgsList().length, 0, '能力闸在搜索之前');
    // 旧边车 + 缺省热门（第 1 页）：照常搜索，不报旧版（order 被旧边车忽略 → 最新）。
    const oldPlain = await old.run('搜本 全彩');
    assert.equal(oldPlain.ok, true, '缺省热门不因旧边车被拦');
    // 旧边车（无 paging 能力）：第 2 页起必须明确报旧版，
    // 不能把「每页 5 条」的逻辑页当上游页翻错（契约 v5 之前 page 是上游站内页）。
    const oldPaging = makePagingFixture(dir, 'g-sort-old-page', {
      pages: PAGING_PAGES, total: 12, healthCaps: ['units', 'details'],
    });
    const oldPagingPlain = await oldPaging.run('搜本 全彩');
    assert.equal(oldPagingPlain.ok, true);
    const searchedBefore = oldPaging.searchArgsList().length;
    const oldPage = await oldPaging.run('下一页');
    assert.equal(oldPage.ok, false);
    assert.equal(oldPage.reason, 'paging_unsupported');
    assertReplyIn(oldPaging.calls, 'pagingUnsupported');
    assert.equal(oldPaging.searchArgsList().length, searchedBefore, '翻页能力闸在搜索之前');
    const oldJump = await oldPaging.run('搜本 全彩 页码:2');
    assert.equal(oldJump.reason, 'paging_unsupported', '显式跳页同样要能力闸');
  });
});

test('jm-service:结构化检索排序 —— 默认热门带 --order mv,显式最新带 mr;旧边车闸与 details 闸并列', async () => {
  await withTemp(async (dir) => {
    const results = [{ id: '101', title: '全彩甲', authors: ['作者甲'], tags: ['全彩'], detailOk: true }];
    const plain = makeStructuredFixture(dir, 'g-struct-default', { results, healthCaps: ['units', 'details', 'sort'] });
    const ok = await plain.run('搜本 作者:作者甲');
    assert.equal(ok.ok, true);
    assert.equal(plain.searchArgs()[plain.searchArgs().indexOf('--order') + 1], 'mv', '默认排序=热门');
    assert.match(plain.calls.reply.at(-1), /按热门排序/u);
    const latest = makeStructuredFixture(dir, 'g-struct-latest', { results, healthCaps: ['units', 'details', 'sort'] });
    const okLatest = await latest.run('搜本 作者:作者甲 排序:最新');
    assert.equal(okLatest.ok, true);
    assert.equal(latest.searchArgs()[latest.searchArgs().indexOf('--order') + 1], 'mr');
    assert.match(latest.calls.reply.at(-1), /按最新排序/u);
    const old = makeStructuredFixture(dir, 'g-struct-sort-old', { results, healthCaps: ['units', 'details'] });
    const denied = await old.run('搜本 作者:作者甲 排序:热门');
    assert.equal(denied.reason, 'sort_unsupported');
    assertReplyIn(old.calls, 'sortUnsupported');
    assert.equal(old.operations().filter((op) => op === 'search').length, 0);
    // 旧边车 + 缺省热门：退回边车缺省（最新），不传 order、也不在清单上标「按热门」。
    const oldDefault = makeStructuredFixture(dir, 'g-struct-default-old', { results, healthCaps: ['units', 'details'] });
    const okOld = await oldDefault.run('搜本 作者:作者甲');
    assert.equal(okOld.ok, true);
    assert.ok(!oldDefault.searchArgs().includes('--order'), '旧边车不传 order');
    assert.doesNotMatch(oldDefault.calls.reply.at(-1), /按热门排序/u, '不冒充热门');
  });
});

test('jm-service:翻页全流程 —— 全局序号、首页/末页边界、序号映射、翻页不自动下载', async () => {
  await withTemp(async (dir) => {
    const fixture = makePagingFixture(dir, 'g-page', { pages: PAGING_PAGES, total: 12 });
    const first = await fixture.run('搜本 全彩');
    assert.equal(first.ok, true);
    assert.ok(fixture.calls.reply.at(-1).includes('1. JM101'), '第 1 页从 1 起');
    assert.ok(fixture.calls.reply.at(-1).includes('下一页'), '多页清单要给翻页提示');

    const second = await fixture.run('下一页');
    assert.equal(second.ok, true);
    const text2 = fixture.calls.reply.at(-1);
    assert.ok(text2.includes('第2页'), text2);
    assert.ok(text2.includes('6. JM201'), '全局序号：第 2 页从 6 起');
    assert.ok(text2.includes('10. JM205'), text2);
    assert.equal(fixture.searchArgsList().at(-1)[fixture.searchArgsList().at(-1).indexOf('--page') + 1], '2');

    // 序号映射：下本 6 = 第 2 页第 1 条；下本 序号10 = 第 2 页第 5 条。
    const byRank = await fixture.run('下本 6');
    assert.equal(byRank.ok, true);
    assert.equal(fixture.calls.upload.length, 1);
    assert.ok(fixture.calls.upload[0].fileName.includes('JM201'), fixture.calls.upload[0].fileName);
    const byExplicit = await fixture.run('下本 序号10');
    assert.equal(byExplicit.ok, true);
    assert.ok(fixture.calls.upload[1].fileName.includes('JM205'), fixture.calls.upload[1].fileName);
    // 第 2 页时「下本 3」（第 1 页的序号）不在当前清单 → 明确拒绝。
    const stale = await fixture.run('下本 3');
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'ordinal_missing');
    assertReplyIn(fixture.calls, 'ordinalMissing');

    // 末页：第 3 页只有 2 条（11/12）；再下一页 → 固定话术，不发起搜索。
    await fixture.run('下一页');
    assert.ok(fixture.calls.reply.at(-1).includes('11. JM301'), fixture.calls.reply.at(-1));
    const fetchCountBefore = fixture.calls.fetch.length;
    const beyond = await fixture.run('下一页');
    assert.equal(beyond.ok, false);
    assert.equal(beyond.reason, 'last_page');
    assertReplyIn(fixture.calls, 'lastPage');
    assert.equal(fixture.calls.fetch.length, fetchCountBefore, '越界翻页不发起搜索');

    // 上一页回第 2 页、再回第 1 页；第一页再上一页 → 固定话术。
    await fixture.run('上一页');
    assert.ok(fixture.calls.reply.at(-1).includes('6. JM201'));
    await fixture.run('上一页');
    assert.ok(fixture.calls.reply.at(-1).includes('1. JM101'));
    const beforeFirst = fixture.calls.fetch.length;
    const beforeFirstResult = await fixture.run('上一页');
    assert.equal(beforeFirstResult.reason, 'first_page');
    assertReplyIn(fixture.calls, 'firstPage');
    assert.equal(fixture.calls.fetch.length, beforeFirst);
    // 翻页全程没有自动下载（只有上面两次显式下本）。
    assert.equal(fixture.calls.upload.length, 2);
  });
});

test('jm-service:翻页状态只认本群 —— 别群/没搜过/单元清单/清单被拒都不能翻', async () => {
  await withTemp(async (dir) => {
    const fixture = makePagingFixture(dir, 'g-page-iso', { pages: PAGING_PAGES, total: 12, groups: ['g-page-iso', 'g-page-other'] });
    // 没搜过直接翻页。
    const fresh = await fixture.run('下一页');
    assert.equal(fresh.reason, 'no_search');
    assertReplyIn(fixture.calls, 'noSearchPage');
    // A 群搜了，B 群翻页拿不到 A 的清单。
    await fixture.run('搜本 全彩', 'g-page-iso');
    const other = await fixture.run('下一页', 'g-page-other');
    assert.equal(other.reason, 'no_search');
    // 单元清单不可翻页（快照被清）：多单元作品先给单元清单。
    const multi = makeDeps({
      dir, groups: ['g-page-multi'],
      payloads: [resolvePayload({ album: albumPayload({ id: '900', units: [
        { index: 1, unitId: '9001', title: '第1话' }, { index: 2, unitId: '9002', title: '第2话' },
      ] }) })],
    });
    await handleJmCommand({ message: message('g-page-multi'), parsed: parseJmCommand('搜本 900'), deps: multi.deps });
    assert.ok(multi.calls.reply.at(-1).includes('单元本'), '应先给单元清单');
    const afterUnits = await handleJmCommand({ message: message('g-page-multi'), parsed: parseJmCommand('下一页'), deps: multi.deps });
    assert.equal(afterUnits.reason, 'no_search', '单元清单不是可翻页的搜索');
    // 清单被 QQ 拒绝（40034006）→ 快照清掉，不能按序号选也不能翻页。
    const blocked = makePagingFixture(dir, 'g-page-blocked', { pages: PAGING_PAGES, total: 12 });
    blocked.deps.reply = async (text) => {
      blocked.calls.reply.push(text);
      if (text.includes('搜到')) { const err = new Error('moderation'); err.code = 40034006; throw err; }
      return 1;
    };
    const blockedResult = await blocked.run('搜本 全彩');
    assert.equal(blockedResult.ok, false);
    const afterBlocked = await blocked.run('下一页');
    assert.equal(afterBlocked.reason, 'no_search');
  });
});

test('jm-service:新搜索失败/0 命中清掉旧清单快照 —— 下一页不能翻到上一条搜索', async () => {
  await withTemp(async (dir) => {
    const calls = { fetch: [] };
    // failMode: '' 正常；'fetch' 抓取器失败；'empty' 边车回 0 结果。
    let failMode = '';
    const flat = () => [...PAGING_PAGES[1], ...PAGING_PAGES[2], ...PAGING_PAGES[3]];
    const runFetch = async ({ args }) => {
      calls.fetch.push(args);
      const op = args[args.indexOf('--op') + 1];
      if (op === 'health') {
        return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ ok: true, capabilities: ['units', 'details', 'sort', 'paging'] }) };
      }
      if (op !== 'search') throw new Error(`失败清快照夹具不允许操作 ${op}`);
      if (failMode === 'fetch') {
        failMode = '';
        return { code: 1, stderr: 'boom', timedOut: false, stdout: '' };
      }
      const page = Number(args[args.indexOf('--page') + 1] ?? 1);
      const limit = Number(args[args.indexOf('--limit') + 1] ?? 5);
      if (failMode === 'empty') {
        failMode = '';
        return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(searchPayload({ results: [], total: 0 })) };
      }
      const results = args.includes('--window') ? flat().slice((page - 1) * limit, page * limit) : (PAGING_PAGES[page] ?? []);
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(searchPayload({ results, total: 12 })) };
    };
    const made = makeDeps({ dir, groups: ['g-page-stale'], runFetch });
    const run = (text) => handleJmCommand({ message: message('g-page-stale'), parsed: parseJmCommand(text), deps: made.deps });
    await run('搜本 全彩');
    assert.ok(made.calls.reply.at(-1).includes('1. JM101'), '先有一份可用清单');
    // 新搜索抓取失败 → 快照清掉，下一页回「先搜本」而不是翻旧清单。
    failMode = 'fetch';
    const failed = await run('搜本 别的');
    assert.equal(failed.ok, false);
    const afterFail = await run('下一页');
    assert.equal(afterFail.reason, 'no_search');
    // 再建一份快照，然后新搜索 0 命中 → 同样清掉。
    await run('搜本 全彩');
    failMode = 'empty';
    const empty = await run('搜本 别的');
    assert.equal(empty.reason, 'no_result');
    const afterEmpty = await run('下一页');
    assert.equal(afterEmpty.reason, 'no_search');
  });
});

test('jm-service:翻页不吃冷却【暂定】;新搜本仍吃冷却;仅第 1 页自动下载', async () => {
  await withTemp(async (dir) => {
    let clock = 1_700_000_000_000;
    const fixture = makePagingFixture(dir, 'g-page-cd', {
      pages: PAGING_PAGES, total: 12, cooldownMs: 30_000, now: () => clock,
    });
    await fixture.run('搜本 全彩');
    clock += 1_000; // 1 秒后翻页：冷却 30s 内，但翻页不拦。
    const paged = await fixture.run('下一页');
    assert.equal(paged.ok, true, `翻页不吃搜本冷却（${JSON.stringify(paged)}）`);
    clock += 1_000;
    const fresh = await fixture.run('搜本 别的');
    assert.equal(fresh.reason, 'cooldown', '新搜本仍吃冷却（翻页不刷新冷却时间）');
    // 仅第 1 页自动下载：显式 页码:1 + total=1 仍自动下载；翻到第 2 页只剩 1 条也不自动下载。
    const single = makePagingFixture(dir, 'g-page-single', {
      pages: { 1: [{ id: '101', title: '独苗' }] }, total: 1,
    });
    const auto = await single.run('搜本 独苗 页码:1');
    assert.equal(auto.ok, true);
    assert.equal(single.calls.upload.length, 1, '第 1 页唯一命中仍自动下载');
    const afterAuto = await single.run('下一页');
    assert.equal(afterAuto.reason, 'no_search', '自动下载的新搜索没有清单，旧快照不能再翻');
    const single2 = makePagingFixture(dir, 'g-page-single2', {
      pages: {
        1: [{ id: '101', title: '甲' }, { id: '102', title: '乙' }, { id: '103', title: '丙' },
          { id: '104', title: '丁' }, { id: '105', title: '戊' }],
        2: [{ id: '106', title: '己' }],
      },
      total: 6,
    });
    const noAuto = await single2.run('搜本 独苗 页码:2');
    assert.equal(noAuto.ok, true);
    assert.equal(single2.calls.upload.length, 0, '第 2 页即使只回 1 条也不自动下载');
    assert.ok(single2.calls.reply.at(-1).includes('6. JM106'), '只给清单且序号全局连续');
  });
});

test('jm-service:结构化翻页 —— 下一页推进扫描页,空页保留快照可上一页', async () => {
  await withTemp(async (dir) => {
    const page1 = [{ id: '101', title: '全彩甲', authors: ['作者甲'], tags: ['全彩'], detailOk: true }];
    const calls = { fetch: [] };
    const runFetch = async ({ args }) => {
      calls.fetch.push(args);
      const op = args[args.indexOf('--op') + 1];
      if (op === 'health') {
        return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ ok: true, capabilities: ['units', 'details', 'sort'] }) };
      }
      const page = Number(args[args.indexOf('--page') + 1] ?? 1);
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(searchPayload({ results: page === 1 ? page1 : [], total: 1 })) };
    };
    const made = makeDeps({ dir, groups: ['g-struct-page'], runFetch });
    const run = (text) => handleJmCommand({ message: message('g-struct-page'), parsed: parseJmCommand(text), deps: made.deps });
    const first = await run('搜本 作者:作者甲');
    assert.equal(first.ok, true);
    const next = await run('下一页');
    assert.equal(next.ok, false);
    assert.equal(next.reason, 'no_result');
    assert.match(made.calls.reply.at(-1), /本次检查范围内没找到/u);
    const searches = calls.fetch.filter((args) => args.includes('search'));
    assert.equal(searches.at(-1)[searches.at(-1).indexOf('--page') + 1], '2');
    // 空页后快照仍在 → 上一页回第 1 页。
    const back = await run('上一页');
    assert.equal(back.ok, true);
    assert.match(made.calls.reply.at(-1), /本次检查范围内找到 1 本/u);
  });
});

// ---------------------------------------------------------------------------
// ④ 接线哨兵（只读源码/生成物，证明"真的接上了"而不是只有模块）
// ---------------------------------------------------------------------------

test('jm-service 接线哨兵:index.js 按配置开启接入、命令表与生成文档同步、示例 env 有键', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const indexSource = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  assert.ok(indexSource.includes('config.jm?.enabled'), 'index.js 必须按 QQBOT_JM 总开关接入');
  // 2026-11-24：搜本/搜图的「该谁处理」收口到 command-router；index 只做入口接线。
  // 纯解析器改由 router 调用（一份实现），这里钉住"链路上真的还在用纯解析器"。
  assert.ok(indexSource.includes('routeSearchCommand('), 'index.js 必须接统一路由');
  assert.ok(indexSource.includes('tryHandleSearchCommand'), 'index.js 必须有唯一的搜本/搜图入口');
  const routerSource = fs.readFileSync(path.join(root, 'src', 'command-router.js'), 'utf8');
  assert.ok(routerSource.includes('parseJmCommand('), '路由必须调 JM 纯解析器');
  assert.ok(routerSource.includes('parseJmFuzzyCommand('), '路由必须接模糊搜本兜底');
  assert.ok(routerSource.includes('looksLikeJmAttempt('), '路由必须保留格式提示判定');
  assert.ok(indexSource.includes('handleJmCommand({'), 'index.js 必须调服务层');
  assert.ok(indexSource.includes('buildJmParseFailureReply(content, route.reason)'),
    'index.js 必须将真实解析的失败原因交给近失/格式提示函数');
  assert.ok(indexSource.includes('JM：收到 ${parsed.action}'), 'index.js 必须有入口审计日志');

  const configSource = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
  assert.ok(configSource.includes("QQBOT_JM_REQUEST_TIMEOUT_MS"), 'config.js 必须登记单次请求上限');
  const configParamsSource = fs.readFileSync(path.join(root, 'src', 'config-params.js'), 'utf8');
  assert.ok(configParamsSource.includes("'QQBOT_JM_REQUEST_TIMEOUT_MS'"), 'config-params.js 必须登记新 env 键');
  const fetchSource = fs.readFileSync(path.join(root, 'scripts', 'jm-fetch-one.mjs'), 'utf8');
  assert.ok(fetchSource.includes("'--request-timeout'"), '抓取器必须接受 --request-timeout');

  const commandsSource = fs.readFileSync(path.join(root, 'src', 'commands.js'), 'utf8');
  assert.ok(commandsSource.includes('parseJmCommand'), '命令表必须登记 JM 指令');
  const doc = fs.readFileSync(path.join(root, 'docs', '命令与关键字.md'), 'utf8');
  assert.ok(doc.includes('搜本 <关键词>'), '生成的命令文档必须含 JM 行（改了要重跑 command-index --write）');

  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const key of ['QQBOT_JM=false', 'QQBOT_JM_GROUPS=', 'QQBOT_JM_API=http://127.0.0.1:8790', 'QQBOT_JM_MAX=5',
    'QQBOT_JM_COOLDOWN_MS=30000', 'QQBOT_JM_ROOT=data/demo/jm-images',
    'QQBOT_JM_MAX_BYTES=10485760', 'QQBOT_JM_TIMEOUT_MS=120000', 'QQBOT_JM_REQUEST_TIMEOUT_MS=45000']) {
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
