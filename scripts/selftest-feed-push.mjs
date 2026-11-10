import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openFeedStore } from '../src/feed.js';
import { parseFeedSource } from '../src/feed-sources.js';
import {
  parsePricingFromSummary,
  priceChangePct,
  createFeedPushReader,
  selectPushable,
  formatFeedPush,
  discoverC2cTarget,
} from '../src/feed-push.js';

// 夹具与其它 feed 套件一致：data/index/ 下 mkdtemp，finally 删；Windows 路径全程 path.join。
const DATA_INDEX = fileURLToPath(new URL('../data/index/', import.meta.url));
mkdirSync(DATA_INDEX, { recursive: true });
const FIXTURE_PREFIX = 'qqbot-feed-push-selftest-';

function withFixture(fn) {
  const directory = mkdtempSync(join(DATA_INDEX, FIXTURE_PREFIX));
  const dbPath = join(directory, 'feed.db');
  let store = openFeedStore(dbPath);
  const fixture = {
    directory,
    dbPath,
    get store() { return store; },
    closeStore() { if (store) { store.close(); store = null; } },
  };
  try { return fn(fixture); }
  finally {
    if (store) { try { store.close(); } catch { /* 测试已关闭 */ } }
    // 只删本夹具自己创建且在 data/index 下的目录，删前核对绝对路径。
    assert.equal(resolve(directory), directory);
    assert.ok(directory.startsWith(join(DATA_INDEX, FIXTURE_PREFIX)));
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---- 真实来源形状（不走网络）：OpenRouter 用 parseFeedSource 生成含 pricing=JSON 的 summary ----
const OR_SOURCE = Object.freeze({ id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', url: 'https://openrouter.ai/api/v1/models' });
const DS_SOURCE = Object.freeze({ id: 'deepseek', name: 'DeepSeek', kind: 'deepseek', url: 'https://api-docs.deepseek.com/updates/' });
const GLM_SOURCE = Object.freeze({ id: 'glm', name: 'GLM', kind: 'glm', url: 'https://docs.bigmodel.cn/cn/update/new-releases.md' });

const MODEL_A = Object.freeze({
  id: 'vendor/model-a',
  name: 'Vendor: Model A',
  created: 1_700_000_000,
  description: 'Model A is the priced baseline model used by the feed push self test.',
  pricing: Object.freeze({
    prompt: '0.0000001',
    completion: '0.000001',
    input_cache_read: '0.00000005',
    overrides: Object.freeze([{ min_prompt_tokens: 272000, prompt: '0.0000002', completion: '0.000002' }]),
  }),
});
const A_KEY = MODEL_A.id;
const BAD_KEY = 'vendor/bad-model';

const TIMES = Object.freeze({
  baseline: 1_000,
  firstUpdated: 2_000,
  dsBaseline: 2_500,
  glmBaseline: 2_600,
  badUpdated: 2_700,
  plus100: 3_000,
  plus10: 4_000,
  dsNew: 5_000,
  glmNew: 6_000,
  glmUpdated: 6_500,
});

function orEntry({ prompt = MODEL_A.pricing.prompt, completion = MODEL_A.pricing.completion } = {}) {
  const model = {
    id: MODEL_A.id,
    name: MODEL_A.name,
    created: MODEL_A.created,
    description: MODEL_A.description,
    pricing: { ...structuredClone(MODEL_A.pricing), prompt, completion },
  };
  const [entry] = parseFeedSource(OR_SOURCE, JSON.stringify({ data: [model] }));
  return entry;
}

function badItem(summary) {
  return { key: BAD_KEY, title: 'Vendor: Bad Model', url: `https://openrouter.ai/${BAD_KEY}`, summary, publishedAt: null };
}

// DeepSeek：真实 Docusaurus 结构（main/article/div.theme-doc-markdown/h2 date/h3 标题）。
function dsDoc(date, id, title, paragraph) {
  return `<html><body><main><article><div class="theme-doc-markdown"><h2 id="date-${date}">Date: ${date}</h2><h3 id="${id}">${title}</h3><p>${paragraph}</p></div></article></main></body></html>`;
}
const dsEntries = text => parseFeedSource(DS_SOURCE, text);

// GLM：真实 Mintlify Markdown 形状（summary = `标题 正文`，正好覆盖「去掉首行标题重复」）。
function glmDoc(date, title, body) {
  return `# 模型与产品发布记录\n\n**${date}**\n\n${title}\n\n* ${body}\n`;
}
const glmEntries = text => parseFeedSource(GLM_SOURCE, text);

const DS_V4 = dsDoc('2026-11-04', 'deepseek-v4', 'DeepSeek-V4 发布', 'DeepSeek V4 上线。');
const DS_V5 = dsDoc('2026-11-09', 'deepseek-v5', 'DeepSeek-V5 发布', 'DeepSeek V5 上线，价格不变。');
const DS_V6 = dsDoc('2026-11-10', 'deepseek-v6', 'DeepSeek-V6 发布', 'DeepSeek V6 上线（并发读取用）。');
const GLM_53 = glmDoc('2026-11-04', 'GLM-5.3 上线', 'GLM-5.3 发布。');
const GLM_54 = glmDoc('2026-11-09', 'GLM-5.4 上线', 'GLM-5.4 发布，推理更强。');
const GLM_54_UPDATED = glmDoc('2026-11-09', 'GLM-5.4 上线', 'GLM-5.4 发布，推理更强，价格不变。');

// 一个综合场景：基线 → 首次 updated（无前一条 inbox）→ 坏 summary updated → +100% → +10%，
// 加上 DeepSeek/GLM 的新条目与 GLM 的普通正文更新（updated 保守口径）。
function seedScenario(store) {
  store.applySnapshot(OR_SOURCE, [orEntry(), badItem('broken summary without pricing')], { now: TIMES.baseline });
  store.applySnapshot(DS_SOURCE, dsEntries(DS_V4), { now: TIMES.dsBaseline });
  store.applySnapshot(GLM_SOURCE, glmEntries(GLM_53), { now: TIMES.glmBaseline });
  store.applySnapshot(OR_SOURCE, [orEntry({ prompt: '0.00000011' })], { now: TIMES.firstUpdated });
  store.applySnapshot(OR_SOURCE, [badItem('garbled pricing=not-json; 币种 USD。 no description')], { now: TIMES.badUpdated });
  store.applySnapshot(OR_SOURCE, [orEntry({ prompt: '0.00000022' })], { now: TIMES.plus100 });
  store.applySnapshot(OR_SOURCE, [orEntry({ prompt: '0.000000242' })], { now: TIMES.plus10 });
  store.applySnapshot(DS_SOURCE, [...dsEntries(DS_V4), ...dsEntries(DS_V5)], { now: TIMES.dsNew });
  store.applySnapshot(GLM_SOURCE, [...glmEntries(GLM_53), ...glmEntries(GLM_54)], { now: TIMES.glmNew });
  store.applySnapshot(GLM_SOURCE, [...glmEntries(GLM_53), ...glmEntries(GLM_54_UPDATED)], { now: TIMES.glmUpdated });
}

function withSeeded(fn) {
  return withFixture(fixture => {
    seedScenario(fixture.store);
    return fn(fixture);
  });
}

/** 夹具里的写入者先关掉，再由推送侧以只读方式打开（生产是跨进程/跨轮次读）。 */
function openReader(fixture, logs = []) {
  fixture.closeStore();
  return createFeedPushReader({ dbPath: fixture.dbPath, log: message => logs.push(message) });
}

// ---- pricing 解析：只认 summary 里那段 API 原始 JSON ----

test('parsePricingFromSummary：真实 OpenRouter summary、嵌套 overrides、数字字符串', () => {
  const pricing = parsePricingFromSummary(orEntry().summary);
  assert.ok(pricing);
  assert.equal(pricing.prompt, 1e-7);
  assert.equal(pricing.completion, 1e-6);
  assert.equal(pricing.input_cache_read, 5e-8);
  assert.equal(pricing.overrides.length, 1); // overrides 原样保留，不展开
  assert.deepEqual(pricing.overrides[0], { min_prompt_tokens: 272000, prompt: '0.0000002', completion: '0.000002' });

  // 嵌套对象/数组、字符串里的分号、描述里后续的 { } 都不能切坏括号配对。
  const nested = parsePricingFromSummary('X; OpenRouter API 原始 pricing={"prompt":"1e-7","completion":0.000002,"note":"a;b","unknown":{"a":[1,2]}}; 币种 USD。 描述 {not json}');
  assert.deepEqual(nested, { prompt: 1e-7, completion: 0.000002 });

  // 非法数字字段忽略；一个可用数字都没有 → null。
  assert.deepEqual(parsePricingFromSummary('pricing={"prompt":"abc","completion":2,"unknown":"x"}'), { completion: 2 });
  assert.equal(parsePricingFromSummary('pricing={"prompt":"abc","completion":null,"overrides":[]}'), null);
  assert.equal(parsePricingFromSummary('pricing={"prompt":Infinity}'), null); // 非标准 JSON → 解析失败

  // 不存在/不是对象/坏 JSON/非字符串 → null。
  assert.equal(parsePricingFromSummary('no price here'), null);
  assert.equal(parsePricingFromSummary('pricing=null; 币种 USD。 x'), null);
  assert.equal(parsePricingFromSummary('pricing=[1,2]; 币种 USD。'), null);
  assert.equal(parsePricingFromSummary('pricing={oops}; 币种 USD。 x'), null);
  assert.equal(parsePricingFromSummary(null), null);
  assert.equal(parsePricingFromSummary(''), null);
});

test('priceChangePct：核心字段取最大相对变化，涨跌同向，prev=0/缺失跳过', () => {
  // 百分比是浮点结果，按 1e-9 精度比较（不把 50.000000000000014 当实现错误）。
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !≈ ${expected}`);
  close(priceChangePct({ prompt: 1e-7, completion: 1e-6 }, { prompt: 2e-7, completion: 1.5e-6 }), 100); // max(100%, 50%)
  close(priceChangePct({ prompt: 1e-7, completion: 1e-6 }, { prompt: 5e-8, completion: 5e-7 }), 50); // 降价也算 50%
  close(priceChangePct({ prompt: 0, completion: 1e-6 }, { prompt: 2, completion: 1.5e-6 }), 50); // prompt prev=0 跳过
  close(priceChangePct({ prompt: 1e-7 }, { prompt: 2e-7, completion: 1 }), 100); // completion 缺失跳过
  close(priceChangePct({ prompt: '1e-7', input_cache_read: 1e-8 }, { prompt: '2e-7', input_cache_read: 2e-8 }), 100);
  // 缓存价两版都有时参与，并与核心字段一起取最大值（10% vs 100% → 100%）。
  close(priceChangePct({ prompt: 1, input_cache_read: 1e-8 }, { prompt: 1.1, input_cache_read: 2e-8 }), 100);
  // 缓存价只有一边有 → 跳过；核心价没变 → 0%。
  assert.equal(priceChangePct({ prompt: 1e-7, input_cache_read: 1e-8 }, { prompt: 1e-7 }), 0);
  assert.equal(priceChangePct({}, {}), null);
  assert.equal(priceChangePct(null, { prompt: 1 }), null);
});

// ---- reader：只读取增序 inbox ----

test('reader：pending 升序/cursor/limit、latestDetectedAt、previousFor 时间顺序', () => withSeeded(fixture => {
  const reader = openReader(fixture);
  try {
    assert.equal(reader.latestDetectedAt(), TIMES.glmUpdated);
    const rows = reader.pending({ cursor: 0 });
    assert.deepEqual(rows.map(row => row.detectedAt), [2000, 2700, 3000, 4000, 5000, 6000, 6500]);
    assert.ok(rows.every(row => !('fingerprint' in row)));
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ['detectedAt', 'id', 'key', 'publishedAt', 'sourceId', 'sourceName', 'summary', 'title', 'type', 'url'],
    );
    assert.deepEqual(reader.pending().map(row => row.detectedAt), rows.map(row => row.detectedAt)); // 默认 cursor=0/limit=20
    assert.deepEqual(reader.pending({ cursor: TIMES.plus10 }).map(row => row.detectedAt), [5000, 6000, 6500]);
    assert.deepEqual(reader.pending({ cursor: TIMES.glmUpdated }), []); // cursor=最后一条 → 空
    assert.deepEqual(reader.pending({ cursor: 0, limit: 2 }).map(row => row.detectedAt), [2000, 2700]);
    assert.throws(() => reader.pending({ cursor: -1 }), TypeError);
    assert.throws(() => reader.pending({ cursor: 1.5 }), TypeError);
    assert.throws(() => reader.pending({ limit: 0 }), TypeError);
    assert.throws(() => reader.pending({ limit: 201 }), TypeError);

    // 基线不进行：首次 updated 之前没有 inbox 行 → previousFor = null。
    assert.equal(reader.previousFor({ sourceId: 'openrouter', key: A_KEY, detectedAt: TIMES.firstUpdated }), null);
    const beforePrice = reader.previousFor({ sourceId: 'openrouter', key: A_KEY, detectedAt: TIMES.plus100 });
    assert.equal(beforePrice.detectedAt, TIMES.firstUpdated); // 取到的是更早那条，不是自己
    assert.equal(parsePricingFromSummary(beforePrice.summary).prompt, 0.00000011);
    const before10 = reader.previousFor({ sourceId: 'openrouter', key: A_KEY, detectedAt: TIMES.plus10 });
    assert.equal(before10.detectedAt, TIMES.plus100);
    assert.equal(reader.previousFor({ sourceId: 'openrouter', key: 'no-such-key', detectedAt: TIMES.plus10 }), null);
  } finally {
    reader.close();
    // 关闭后所有读方法仍是兜底值，不抛（调用方可能在定时器尾声误调）。
    assert.equal(reader.latestDetectedAt(), null);
    assert.deepEqual(reader.pending(), []);
    reader.close(); // 重复 close 也安全
  }
}));

test('reader 只读但可读：写入连接仍打开时能读已提交数据，并看到后续提交（WAL 并发）', () => withSeeded(fixture => {
  const reader = createFeedPushReader({ dbPath: fixture.dbPath });
  try {
    assert.equal(reader.latestDetectedAt(), TIMES.glmUpdated);
    assert.equal(reader.pending().length, 7); // 写入者未关闭也能读到
    // 写入者在 reader 打开期间再提交一条 → 下一次查询应能看到（不缓存旧快照）。
    fixture.store.applySnapshot(
      DS_SOURCE,
      [...dsEntries(DS_V4), ...dsEntries(DS_V5), ...dsEntries(DS_V6)],
      { now: TIMES.glmUpdated + 500 },
    );
    assert.equal(reader.latestDetectedAt(), TIMES.glmUpdated + 500);
    assert.equal(reader.pending().length, 8);
  } finally { reader.close(); }
}));

test('reader disabled：缺库/非绝对/空文件/非 feed 库 → null/[]、不抛、只 log 一次；空表正常', () => withFixture(fixture => {
  const { directory, dbPath } = fixture;
  fixture.closeStore();

  // 合法 feed 库但空表：不是 disabled，只是没有数据。
  const emptyTableReader = createFeedPushReader({ dbPath });
  try {
    assert.equal(emptyTableReader.latestDetectedAt(), null);
    assert.deepEqual(emptyTableReader.pending(), []);
    assert.equal(emptyTableReader.previousFor({ sourceId: 'openrouter', key: 'k', detectedAt: 1 }), null);
  } finally { emptyTableReader.close(); }

  // 不存在的路径。
  const missingLogs = [];
  const missing = createFeedPushReader({ dbPath: join(directory, 'missing.db'), log: message => missingLogs.push(message) });
  assert.equal(missing.latestDetectedAt(), null);
  assert.deepEqual(missing.pending({ cursor: 0, limit: 5 }), []);
  assert.deepEqual(missing.pending({ cursor: -1 }), []); // disabled 时参数校验也不抛
  assert.equal(missing.previousFor({ sourceId: 'openrouter', key: 'k', detectedAt: 1 }), null);
  for (let i = 0; i < 5; i++) missing.pending();
  assert.equal(missingLogs.length, 1); // 只 log 一次
  missing.close();
  missing.close();

  // 非绝对路径 → 直接 disabled（不做任何文件访问）。
  const relativeLogs = [];
  const relative = createFeedPushReader({ dbPath: 'feed.db', log: message => relativeLogs.push(message) });
  assert.equal(relative.latestDetectedAt(), null);
  assert.deepEqual(relative.pending(), []);
  relative.close();
  assert.equal(relativeLogs.length, 1);

  // 空文件：SQLite 能打开成空库，但没有 feed_inbox 表 → disabled。
  const emptyPath = join(directory, 'empty.sqlite');
  writeFileSync(emptyPath, '');
  const emptyFileLogs = [];
  const emptyFile = createFeedPushReader({ dbPath: emptyPath, log: message => emptyFileLogs.push(message) });
  assert.equal(emptyFile.latestDetectedAt(), null);
  assert.deepEqual(emptyFile.pending(), []);
  emptyFile.close();
  assert.equal(emptyFileLogs.length, 1);

  // 合法 SQLite 但不是 feed 库（无 feed_inbox 表）→ disabled。
  const otherPath = join(directory, 'other.sqlite');
  const other = new DatabaseSync(otherPath);
  other.exec('CREATE TABLE t(x)');
  other.close();
  const otherLogs = [];
  const notFeed = createFeedPushReader({ dbPath: otherPath, log: message => otherLogs.push(message) });
  assert.equal(notFeed.latestDetectedAt(), null);
  assert.deepEqual(notFeed.pending(), []);
  notFeed.close();
  assert.equal(otherLogs.length, 1);

  // 完全没有 dbPath → disabled。
  const noPathLogs = [];
  const noPath = createFeedPushReader({ log: message => noPathLogs.push(message) });
  assert.equal(noPath.latestDetectedAt(), null);
  assert.deepEqual(noPath.pending(), []);
  noPath.close();
  assert.equal(noPathLogs.length, 1);
}));

// ---- 选择：阈值 + 保守口径 + 顺序 ----

test('selectPushable：new 全推、OpenRouter 价格达阈值才推、坏 summary/其它 updated 不推、顺序保持', () => withSeeded(fixture => {
  const reader = openReader(fixture);
  const previousFor = options => reader.previousFor(options);
  try {
    const rows = reader.pending();
    assert.ok(rows.some(row => row.detectedAt === TIMES.badUpdated && row.type === 'updated' && row.sourceId === 'openrouter'));
    assert.ok(rows.some(row => row.detectedAt === TIMES.glmUpdated && row.type === 'updated' && row.sourceId === 'glm'));

    const selected = selectPushable(rows, { pricePct: 50, previousFor });
    assert.deepEqual(selected.map(item => [item.reason, item.row.detectedAt]), [
      ['price', TIMES.plus100],
      ['new', TIMES.dsNew],
      ['new', TIMES.glmNew],
    ]); // 2000 首次 updated 无 previous、2700 坏 summary、4000 +10%、6500 非价格 updated 全部不推
    assert.equal(Math.round(selected[0].changePct), 100);
    assert.equal(selected[0].row.sourceId, 'openrouter');
    assert.equal(selected[1].row.sourceId, 'deepseek');
    assert.equal(selected[2].row.sourceId, 'glm');
    const previousRow = rows.find(row => row.detectedAt === TIMES.firstUpdated);
    const currentRow = rows.find(row => row.detectedAt === TIMES.plus100);
    assert.equal(
      selected[0].changePct,
      priceChangePct(parsePricingFromSummary(previousRow.summary), parsePricingFromSummary(currentRow.summary)),
    );

    // 反证：阈值 50 → 60 时 +100% 仍推；提到 150 时 +100% 不再推；+10% 在任何阈值都不推。
    assert.deepEqual(selectPushable(rows, { pricePct: 60, previousFor }).map(item => item.row.detectedAt), [TIMES.plus100, TIMES.dsNew, TIMES.glmNew]);
    assert.deepEqual(selectPushable(rows, { pricePct: 150, previousFor }).map(item => item.row.detectedAt), [TIMES.dsNew, TIMES.glmNew]);
    assert.ok(selectPushable(rows, { pricePct: 100, previousFor }).some(item => item.row.detectedAt === TIMES.plus100)); // 达阈值边界（>=）
    assert.ok(selectPushable(rows, { pricePct: 99.9, previousFor }).some(item => item.row.detectedAt === TIMES.plus100)); // 非整数也接受
    // +10% 只在阈值 ≤10 时推；50/60/150 都不推（默认阈值 50 的实际意义）。
    assert.ok(selectPushable(rows, { pricePct: 1, previousFor }).some(item => item.row.detectedAt === TIMES.plus10));
    for (const pricePct of [50, 60, 150]) {
      assert.ok(!selectPushable(rows, { pricePct, previousFor }).some(item => item.row.detectedAt === TIMES.plus10));
    }

    // 不传 previousFor → updated 一律不推（保守）。
    assert.deepEqual(selectPushable(rows).map(item => item.reason), ['new', 'new']);

    // 参数校验。
    assert.throws(() => selectPushable(rows, { pricePct: 0 }), TypeError);
    assert.throws(() => selectPushable(rows, { pricePct: 10_001 }), TypeError);
    assert.throws(() => selectPushable(rows, { pricePct: '50' }), TypeError);
    assert.throws(() => selectPushable(rows, { pricePct: 50, previousFor: 'nope' }), TypeError);
    assert.throws(() => selectPushable(null), TypeError);
  } finally { reader.close(); }
}));

// ---- 只读反证（二选一：写操作必须失败） ----

test('reader 只读反证：reader 打开期间，另一条 readOnly 连接的写操作必须失败', () => withSeeded(fixture => {
  const reader = openReader(fixture);
  try {
    assert.equal(reader.pending().length, 7);
    const probe = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.throws(
        () => probe.exec(`INSERT INTO feed_inbox (id,sourceId,sourceName,key,fingerprint,type,title,url,summary,publishedAt,detectedAt)
          VALUES ('probe','openrouter','OpenRouter','probe','fp','new','t','https://example.org/probe','s',NULL,1)`),
        error => error?.code === 'ERR_SQLITE_ERROR' || /readonly|read-only|attempts? to write/i.test(error?.message ?? ''),
      );
    } finally { probe.close(); }
    // 写失败后 reader 仍能正常读，说明只读通道未受影响。
    assert.equal(reader.pending().length, 7);
    assert.equal(reader.latestDetectedAt(), TIMES.glmUpdated);
  } finally { reader.close(); }
}));

// ---- 排版 ----

test('formatFeedPush：三行形状、价格变体 +100%、长度上限、无控制字符、URL 末尾、幂等', () => withSeeded(fixture => {
  const reader = openReader(fixture);
  try {
    const rows = reader.pending();
    const selected = selectPushable(rows, { previousFor: options => reader.previousFor(options) });
    const price = selected.find(item => item.reason === 'price');
    const priceText = formatFeedPush(price);
    const priceLines = priceText.split('\n');
    assert.equal(priceLines.length, 3);
    assert.ok(priceLines[0].startsWith('【异界新闻·价格】OpenRouter · '));
    assert.match(priceLines[0], /（约 \+100%）$/);
    assert.equal(priceLines[2], price.row.url);
    assert.ok(priceText.endsWith('\n' + price.row.url));
    assert.ok(priceText.length <= 300);
    assert.ok(priceLines[1].length > 10 && priceLines[1].length <= 120);
    assert.ok(!priceLines[1].includes('pricing='));
    assert.ok(!priceLines[1].includes('币种'));
    assert.ok(!priceLines[1].includes('OpenRouter API'));
    assert.doesNotMatch(priceText.replace(/\n/g, ''), /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    assert.equal(formatFeedPush(price), priceText); // 重复调用完全一致

    // new 变体。
    const deepseek = selected.find(item => item.row.sourceId === 'deepseek');
    const deepseekText = formatFeedPush(deepseek);
    assert.ok(deepseekText.split('\n')[0].startsWith('【异界新闻】DeepSeek · '));
    assert.ok(deepseekText.endsWith('\n' + deepseek.row.url));

    // GLM summary 开头重复标题 → 正文行不重复标题。
    const glm = selected.find(item => item.row.sourceId === 'glm');
    const glmLines = formatFeedPush(glm).split('\n');
    assert.equal(glmLines.length, 3);
    assert.ok(!glmLines[1].startsWith(glm.row.title));
    assert.equal(glmLines[2], glm.row.url);

    // price 但 changePct=null → 不展示百分比。
    const bare = formatFeedPush({ row: price.row, reason: 'price', changePct: null });
    assert.ok(bare.startsWith('【异界新闻·价格】'));
    assert.ok(!bare.includes('（约'));

    // 长标题 + 长正文 + 小 maxChars：总长 ≤ 上限、URL 完整在末尾、截断补 …。
    const longUrl = 'https://example.org/news/feed-push/very-long-item-12345';
    const long = formatFeedPush({ row: { sourceId: 'deepseek', sourceName: 'DeepSeek', title: '超长标题'.repeat(40), url: longUrl, summary: '正文'.repeat(300) } }, { maxChars: 80 });
    assert.ok(long.length <= 80, `length=${long.length}`);
    assert.ok(long.endsWith('\n' + longUrl));
    assert.ok(long.includes('…'));
    assert.doesNotMatch(long.replace(/\n/g, ''), /[\u0000-\u001f\u007f-\u009f]/u);

    // 默认 maxChars=300 时正文仍 ≤120。
    const long300 = formatFeedPush({ row: { sourceId: 'deepseek', sourceName: 'DeepSeek', title: '标题', url: longUrl, summary: '正文'.repeat(300) } });
    const lines300 = long300.split('\n');
    assert.equal(lines300.length, 3);
    assert.ok(lines300[1].length <= 120);
    assert.ok(long300.length <= 300);
    assert.ok(long300.endsWith('\n' + longUrl));
  } finally { reader.close(); }
}));

// ---- 私聊目标发现 ----

test('discoverC2cTarget：首个私聊、-gN 后缀、群/空/selfId 排除、最新优先', () => {
  assert.equal(discoverC2cTarget(['qqbot-c2c-ABC123']), 'ABC123');
  assert.equal(discoverC2cTarget(['qqbot-group-GROUP', 'qqbot-c2c-ABC-g3']), 'ABC');
  assert.equal(discoverC2cTarget(['qqbot-c2c-FIRST-g2', 'qqbot-c2c-SECOND']), 'FIRST');
  assert.equal(discoverC2cTarget(['qqbot-c2c-SELF', 'qqbot-c2c-OTHER'], { selfId: 'SELF' }), 'OTHER');
  assert.equal(discoverC2cTarget(['qqbot-c2c-SELF-g7'], { selfId: 'SELF' }), null);
  assert.equal(discoverC2cTarget(['qqbot-group-GROUP']), null);
  assert.equal(discoverC2cTarget([]), null);
  assert.equal(discoverC2cTarget(['', null, 'qqbot-c2c-', 'qqbot-web-W', 'qqbot-group-']), null);
  assert.equal(discoverC2cTarget(null), null);
});
