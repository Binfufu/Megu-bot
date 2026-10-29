/**
 * 美图展览处**数据层**的判据(2026-10-23,展览处刀 1)。
 *
 * 跑法:
 *
 *     node scripts\selftest-meitu-gallery.js
 *
 * 全部**真跑临时 SQLite 库**(父仓同卷 mkdtemp,不碰运行期数据),不联网。钉:
 *   ① DDL 幂等 + schema 列与 `docs\32` §4.1 逐列一致(UNIQUE 冲突真会炸);
 *   ② 北京时间自然窗:日/周/月/年,**种子钉时刻**对拍(防"按钟绿":期望值写死自种子,
 *      并且换一个种子窗口必须跟着走);
 *   ③ 权限档位钳制三红线(g 公开 / s,q 需 member+withq / '' 与 blacklisted 任何档都不可见);
 *   ④ 重扫真咬:塞命中词 → rescan → `blacklisted=1` 且查询**立刻**查不到(元判据);
 *   ⑤ upsert 幂等与 UNIQUE 冲突(同路径/同身份);
 *   ⑥ 行数 = 目录数口径(扫目录 → 落行);
 *   ⑦ 排序三级(sent_count→last_sent_at→fetched_at)、窗口过滤、分页、facets;
 *   ⑧ 回填报告 ok / fail / blacklisted 三数可见,fail>0 有告警,另出 rating 分布行;
 *   ⑨ 按群发送账(meitu_seen):记账幂等/群隔离/md5 缺失退 source:id/只读可读不可写;
 *   ⑩ md5 身份进主表(D312,2026-10-28):旧库 ALTER 迁移幂等、findByMd5/knownMd5s、
 *      同 md5 不同身份不插第二行(部分唯一索引兜底)、重/upsert 回填老行。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  MEITU_GALLERY_DDL,
  RANKS,
  beijingWindow,
  initMeituGallery,
  meituDbPathFromStateDb,
  normalizeRating,
  openMeituGallery,
  orderBySql,
  parseImageFileName,
  scanMeituRoot,
  shiftWindow,
  visibilityWhere,
} from '../src/meitu-gallery.js';
import { MINOR_TAGS } from '../src/meitu-search.js';
import { handleMeituCommand } from '../src/meitu-service.js';
import { formatBackfillReport, repairMetaPaths, runBackfill } from './meitu-backfill.mjs';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 临时目录 + 临时库;SQLite(WAL)关掉后 Windows 上偶尔还占一秒,cleanup 给重试。 */
async function withTemp(run, prefix = 'qqbot-meitu-gallery-') {
  const dir = fs.mkdtempSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), prefix));
  fs.writeFileSync(path.join(dir, 'missing-alias.json'), JSON.stringify({ 合成角色甲: 'fixture_character_a' }));
  try {
    return await run(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上 SQLite 文件偶尔还占一小会儿:清理失败不许冒充判据失败(别把红/绿说错)。
    }
  }
}

function openTemp(dir, name = 'meitu.db', now) {
  const gallery = openMeituGallery({ dbPath: path.join(dir, name), now });
  return gallery;
}

/** 最小的合法文件行。 */
function row(overrides = {}) {
  return {
    source: 'danbooru',
    sourceId: '1',
    filePath: 'E:\\fixture-gallery\\合成角色甲\\danbooru_1.jpg',
    fetchedAt: SEED_MS - 60_000,
    ...overrides,
  };
}

/**
 * 种子时刻 = 北京时间 2026-10-23(周五)13:40:39(UTC 2026-10-23T05:40:39Z)。
 * 期望窗口值由它**现算写死**在这里(不是 `Date.now()`)—— 换机器/换钟点都同一个结果。
 */
const SEED_MS = Date.parse('2026-10-23T05:40:39Z');
const DAY_START = Date.parse('2026-10-22T16:00:00Z'); // 北京 10-23 00:00
const DAY_END = Date.parse('2026-10-23T16:00:00Z');
const WEEK_START = Date.parse('2026-10-18T16:00:00Z'); // 北京 10-19(周一)00:00
const WEEK_END = Date.parse('2026-10-25T16:00:00Z');
const MONTH_START = Date.parse('2026-09-30T16:00:00Z'); // 北京 10-01 00:00
const MONTH_END = Date.parse('2026-10-31T16:00:00Z');
const YEAR_START = Date.parse('2025-12-31T16:00:00Z'); // 北京 2026-01-01 00:00
const YEAR_END = Date.parse('2026-12-31T16:00:00Z');

// ---------------------------------------------------------------------------
// ① DDL 幂等 + schema 原样
// ---------------------------------------------------------------------------

test('meitu-gallery:DDL 幂等 —— 重复 open/init 不改 schema,列与 idx_meitu_rank 与 docs\\32 §4.1 一致', async () => {
  await withTemp(async (dir) => {
    const dbPath = path.join(dir, 'meitu.db');
    const first = openMeituGallery({ dbPath, now: () => SEED_MS });
    first.close();
    // 第二次 open 会再跑一遍 CREATE TABLE IF NOT EXISTS / 部分索引:不许炸、不许加列。
    const second = openMeituGallery({ dbPath, now: () => SEED_MS });
    initMeituGallery(second.db);
    const names = second.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all()
      .map((item) => item.name);
    assert.ok(names.includes('meitu_meta'), 'meitu_meta 表要在');
    assert.ok(names.includes('idx_meitu_rank'), 'idx_meitu_rank 索引要在');
    const columns = second.db.prepare("SELECT name FROM pragma_table_info('meitu_meta')").all().map((item) => item.name);
    assert.deepEqual(columns, [
      'id', 'source', 'source_id', 'file_path', 'rating', 'characters', 'copyright',
      'general_tags', 'fetched_at', 'sent_count', 'last_sent_at', 'blocked',
      'blacklisted', 'width', 'height', 'created_at', 'md5',
    ], 'schema 必须与 docs\\32 §4.1 逐列一致(不加减列;md5 在末尾,与旧库 ALTER 迁移后的列序一致)');
    // UNIQUE(file_path) 与 UNIQUE(source,source_id) 都真的存在(靠 upsert 兜住冲突,但底表得先拦)。
    second.db.prepare("INSERT INTO meitu_meta (source, source_id, file_path, fetched_at, created_at) VALUES ('danbooru','1','D:\\x.jpg',1,1)").run();
    assert.throws(
      () => second.db.prepare("INSERT INTO meitu_meta (source, source_id, file_path, fetched_at, created_at) VALUES ('danbooru','1','D:\\y.jpg',1,1)").run(),
      /UNIQUE/u,
      '同 (source,source_id) 的裸 INSERT 必须被底表拦下',
    );
    assert.ok(MEITU_GALLERY_DDL.includes('UNIQUE(source, source_id)'));
    assert.ok(MEITU_GALLERY_DDL.includes('CREATE INDEX IF NOT EXISTS idx_meitu_rank'));
    // 按群发送账(2026-10-28):表 + 两个部分唯一索引都要在,meitu_seen 列与 docs\32 §4.1 一致。
    assert.ok(names.includes('meitu_seen'), 'meitu_seen 表要在');
    assert.ok(names.includes('idx_meitu_seen_group_md5'), '按 (群,md5) 的部分唯一索引要在');
    assert.ok(names.includes('idx_meitu_seen_group_source'), '按 (群,source,id) 的部分唯一索引要在');
    assert.ok(names.includes('idx_meitu_md5'), 'meitu_meta 的 md5 部分唯一索引要在(D312)');
    assert.deepEqual(
      second.db.prepare("SELECT name FROM pragma_table_info('meitu_seen')").all().map((item) => item.name),
      ['id', 'group_id', 'md5', 'source', 'source_id', 'at', 'created_at'],
      'meitu_seen 列必须与 docs\\32 §4.1 一致',
    );
    second.close();
  });
});

// ---------------------------------------------------------------------------
// ② 北京自然窗:种子钉时刻
// ---------------------------------------------------------------------------

test('meitu-gallery:北京自然窗 —— 种子钉时刻的日/周/月/年边界(不是按钟绿)', () => {
  assert.deepEqual(beijingWindow('latest', SEED_MS), { kind: 'latest', startMs: null, endMs: null });
  assert.deepEqual(beijingWindow('day', SEED_MS), { kind: 'day', startMs: DAY_START, endMs: DAY_END });
  assert.deepEqual(beijingWindow('week', SEED_MS), { kind: 'week', startMs: WEEK_START, endMs: WEEK_END });
  assert.deepEqual(beijingWindow('month', SEED_MS), { kind: 'month', startMs: MONTH_START, endMs: MONTH_END });
  assert.deepEqual(beijingWindow('year', SEED_MS), { kind: 'year', startMs: YEAR_START, endMs: YEAR_END });
  // 每个窗口左闭右开、包含种子时刻。
  for (const rank of RANKS) {
    const win = beijingWindow(rank, SEED_MS);
    if (win.startMs === null) continue;
    assert.ok(win.startMs <= SEED_MS && SEED_MS < win.endMs, `${rank} 窗口要包含种子时刻`);
  }
  // 换一个种子(北京 10-24 01:00,UTC 日期与北京日期不同的一天):日窗必须跟着走一格。
  const crossMidnight = Date.parse('2026-10-23T17:00:00Z');
  assert.deepEqual(beijingWindow('day', crossMidnight), { kind: 'day', startMs: DAY_END, endMs: DAY_END + 86_400_000 });
  // 年窗跨北京时区:北京 2026-01-01 00:00 = UTC 2025-12-31 16:00(不是 UTC 年初)。
  assert.notEqual(beijingWindow('year', SEED_MS).startMs, Date.UTC(2026, 0, 1));
});

test('meitu-gallery:窗口前/后移一格 —— 日/周/月/年各自走日历(月不是固定 30 天)', () => {
  const day = beijingWindow('day', SEED_MS);
  assert.deepEqual(shiftWindow('day', day, 1), { kind: 'day', startMs: DAY_END, endMs: DAY_END + 86_400_000 });
  assert.deepEqual(shiftWindow('day', day, -1), { kind: 'day', startMs: DAY_START - 86_400_000, endMs: DAY_START });
  const week = beijingWindow('week', SEED_MS);
  assert.deepEqual(shiftWindow('week', week, 1), { kind: 'week', startMs: WEEK_END, endMs: WEEK_END + 7 * 86_400_000 });
  const month = beijingWindow('month', SEED_MS);
  // 10 月下一窗 = 11 月 1 日(北京)= UTC 10-31T16:00Z;上一窗 = 9 月(30 天,不是 31)。
  assert.deepEqual(shiftWindow('month', month, 1), {
    kind: 'month',
    startMs: Date.parse('2026-10-31T16:00:00Z'),
    endMs: Date.parse('2026-11-30T16:00:00Z'),
  });
  assert.deepEqual(shiftWindow('month', month, -1), {
    kind: 'month',
    startMs: Date.parse('2026-08-31T16:00:00Z'),
    endMs: MONTH_START,
  });
  const year = beijingWindow('year', SEED_MS);
  assert.deepEqual(shiftWindow('year', year, 1), {
    kind: 'year',
    startMs: YEAR_END,
    endMs: Date.parse('2027-12-31T16:00:00Z'),
  });
});

// ---------------------------------------------------------------------------
// ③ 权限钳制三红线
// ---------------------------------------------------------------------------

test('meitu-gallery:权限钳制 —— g 公开;s,q 仅 member/staff 且 withq;readonly 带 withq=1 仍 safe', () => {
  assert.deepEqual(visibilityWhere({ tier: 'readonly' }).ratings, ['g']);
  assert.deepEqual(visibilityWhere({ tier: 'guest' }).ratings, ['g']);
  assert.deepEqual(visibilityWhere({}).ratings, ['g'], '没有档位信息 = safe(fail-closed)');
  assert.deepEqual(visibilityWhere({ tier: '只读' }).ratings, ['g'], '认不出的档位 = safe');
  assert.deepEqual(visibilityWhere({ tier: 'member' }).ratings, ['g'], 'member 没显式开口 = safe');
  assert.deepEqual(visibilityWhere({ tier: 'member', withq: 1 }).ratings, ['g', 's', 'q']);
  assert.deepEqual(visibilityWhere({ tier: 'staff', withq: true }).ratings, ['g', 's', 'q']);
  // 服务端钳制:readonly/staff 的档位写死在这里,前端参数怎么带都改不了 —— 纯函数没有"读请求"的口子。
  assert.deepEqual(visibilityWhere({ tier: 'readonly', withq: 1 }).ratings, ['g']);
  const sql = visibilityWhere({ tier: 'readonly' }).sql;
  assert.ok(sql.startsWith('blacklisted = 0 AND rating <> \'\''), `WHERE 前缀必须是常量 fail-closed(现在:${sql})`);
  assert.ok(!/withq|tier/iu.test(sql), 'SQL 里不许出现前端参数名(钳制在拼 SQL 之前完成)');
});

test('meitu-gallery:rating=\'\' 与未知 rating 任何档都查不到(fail-closed)', async () => {
  await withTemp(async (dir) => {
    const gallery = openTemp(dir, 'meitu.db', () => SEED_MS);
    gallery.upsertFile(row({ sourceId: '10', filePath: 'D:\\x\\danbooru_10.jpg', rating: 'g' }));
    // rating='' 是常态(回填没拿到);'e' 是 explicit(爬虫不收,但旧数据/手改可能有)—— 一律不上架。
    gallery.db.prepare("UPDATE meitu_meta SET rating = 'g' WHERE source_id = '10'").run();
    gallery.upsertFile(row({ sourceId: '11', filePath: 'D:\\x\\danbooru_11.jpg' }));
    gallery.db.prepare("UPDATE meitu_meta SET rating = 'e' WHERE source_id = '11'").run();
    for (const params of [
      { tier: 'readonly' },
      { tier: 'member' },
      { tier: 'member', withq: 1 },
      { tier: 'staff', withq: 1 },
    ]) {
      const list = gallery.queryList({ rank: 'latest', pageSize: 42, ...params });
      assert.equal(list.total, 1, `档位 ${JSON.stringify(params)} 只能看到那张 g:${JSON.stringify(list.items.map((item) => item.rating))}`);
      assert.deepEqual(list.items.map((item) => item.sourceId), ['10']);
    }
    gallery.close();
  });
});

test('meitu-gallery:blacklisted fail-closed —— 任何档、任何 withq 都查不到', async () => {
  await withTemp(async (dir) => {
    const gallery = openTemp(dir, 'meitu.db', () => SEED_MS);
    gallery.upsertFromFetch(row({ sourceId: '20', filePath: 'D:\\x\\danbooru_20.jpg', rating: 'g', characters: ['fixture_character_a'] }));
    gallery.upsertFromFetch({
      ...row({ sourceId: '21', filePath: 'D:\\x\\danbooru_21.jpg', rating: 'g' }),
      generalTags: ['1girl', MINOR_TAGS[0]],
      blacklisted: 1,
    });
    for (const params of [{ tier: 'readonly' }, { tier: 'member' }, { tier: 'member', withq: 1 }, { tier: 'staff', withq: 1 }]) {
      const list = gallery.queryList({ rank: 'latest', ...params });
      assert.deepEqual(list.items.map((item) => item.sourceId), ['20'], `blacklisted 行在 ${JSON.stringify(params)} 下也不行`);
    }
    assert.equal(gallery.queryItem({ id: gallery.getMeta({ source: 'danbooru', sourceId: '21' }).id, tier: 'staff', withq: 1 }), null);
    // facets / counts 同一个闸:blacklisted 行的角色 tag 不许漏进 chips。
    gallery.close();
  });
});

test('meitu-gallery:重扫真咬 —— 塞命中词 → rescan → blacklisted=1 且 API 立刻查不到(元判据)', async () => {
  await withTemp(async (dir) => {
    const gallery = openTemp(dir, 'meitu.db', () => SEED_MS);
    const hitWord = MINOR_TAGS[0];
    gallery.upsertFromFetch(row({ sourceId: '30', filePath: 'D:\\x\\danbooru_30.jpg', rating: 'g', characters: ['fixture_character_a'] }));
    gallery.upsertFromFetch({
      ...row({ sourceId: '31', filePath: 'D:\\x\\danbooru_31.jpg', rating: 'g', characters: ['fixture_character_a'] }),
      // 黑名单列是"回填时刻的快照":这里模拟清单更新前入库的行(blacklisted=0)——
      // 重扫要把它咬出来,否则网页永远看得见。
      generalTags: ['1girl', hitWord],
      blacklisted: 0,
    });
    assert.equal(gallery.queryList({ rank: 'latest', tier: 'readonly' }).total, 2, '重扫前两张都看得见');
    const result = gallery.rescanBlacklist();
    assert.equal(result.scanned, 2);
    assert.equal(result.blocked, 1, '只有命中词那行被拦');
    assert.equal(result.changed, 1);
    const after = gallery.queryList({ rank: 'latest', tier: 'readonly' });
    assert.deepEqual(after.items.map((item) => item.sourceId), ['30'], '重扫后 API 立刻查不到(消费端取证)');
    // 元判据:把命中词从标签里拿掉再重扫,它必须回来(证明 rescan 真按标签算,不是只会置 1)。
    gallery.applySourceMeta({ source: 'danbooru', sourceId: '31', generalTags: ['1girl'] });
    const restore = gallery.rescanBlacklist();
    assert.equal(restore.blocked, 0);
    assert.equal(restore.changed, 1);
    assert.equal(gallery.queryList({ rank: 'latest', tier: 'readonly' }).total, 2);
    gallery.close();
  });
});

// ---------------------------------------------------------------------------
// ④ upsert 幂等 / UNIQUE 冲突
// ---------------------------------------------------------------------------

test('meitu-gallery:upsert 幂等与 UNIQUE 冲突 —— 同路径两次 1 行;同身份换路径不乱;同路径换身份不乱', async () => {
  await withTemp(async (dir) => {
    const gallery = openTemp(dir, 'meitu.db', () => SEED_MS);
    const base = row({ sourceId: '40', filePath: 'D:\\x\\danbooru_40.jpg', fetchedAt: SEED_MS - 10 });
    assert.equal(gallery.upsertFile(base).inserted, true);
    const second = gallery.upsertFile({ ...base, fetchedAt: SEED_MS - 10 });
    assert.deepEqual({ inserted: second.inserted }, { inserted: false });
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_meta').get().n, 1, '重复扫同一文件只能一行');
    // 同一帖子被搬到别的角色目录(身份优先,保留先入库的路径,不炸 UNIQUE、不多行)。
    const moved = gallery.upsertFile({ ...base, filePath: 'D:\\x\\other\\danbooru_40.jpg', fetchedAt: SEED_MS - 5 });
    assert.equal(moved.inserted, false);
    assert.ok(moved.warning, '同身份换路径要返回提示(不安静吞掉)');
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_meta').get().n, 1);
    assert.equal(gallery.db.prepare('SELECT file_path FROM meitu_meta').get().file_path, 'D:\\x\\other\\danbooru_40.jpg', '路径以最新扫描为准');
    // 同一路径换了帖子身份:仍是一行(按 file_path 更新身份),不抛 UNIQUE。
    const replaced = gallery.upsertFile({ ...base, filePath: 'D:\\x\\other\\danbooru_40.jpg', sourceId: '41', fetchedAt: SEED_MS - 1 });
    assert.equal(replaced.inserted, false);
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_meta').get().n, 1);
    assert.equal(gallery.db.prepare('SELECT source_id FROM meitu_meta').get().source_id, '41');
    gallery.close();
  });
});

test('meitu-gallery:无尺寸的兜底 upsert 不许清空已有宽高(2026-10-27 修服务层覆盖)', async () => {
  await withTemp(async (dir) => {
    const gallery = openTemp(dir, 'meitu.db', () => SEED_MS);
    gallery.upsertFile(row({ sourceId: '42', filePath: 'D:\\x\\danbooru_42.jpg', width: 100, height: 200 }));
    // 服务层发图后的幂等兜底 upsert 不带尺寸:touchBase 必须 COALESCE 保留 fetch-one 先写的值。
    gallery.upsertFile(row({ sourceId: '42', filePath: 'D:\\x\\danbooru_42.jpg' }));
    const after = gallery.db.prepare("SELECT width, height FROM meitu_meta WHERE source_id = '42'").get();
    assert.deepEqual({ width: after.width, height: after.height }, { width: 100, height: 200 }, '宽高不许被兜底 upsert 抹成 NULL');
    // 真带了新尺寸照常更新(scanMeituRoot 重扫的口径)。
    gallery.upsertFile(row({ sourceId: '42', filePath: 'D:\\x\\danbooru_42.jpg', width: 300, height: 400 }));
    const updated = gallery.db.prepare("SELECT width, height FROM meitu_meta WHERE source_id = '42'").get();
    assert.deepEqual({ width: updated.width, height: updated.height }, { width: 300, height: 400 });
    gallery.close();
  });
});

// ---------------------------------------------------------------------------
// ⑤ 行数 = 目录数口径 / 文件名解析
// ---------------------------------------------------------------------------

test('meitu-gallery:行数=目录数口径 —— 扫目录 N 张图就落 N 行(非图片与 thumbs 目录不计)', async () => {
  await withTemp(async (dir) => {
    const root = path.join(dir, 'bot自动搬运仓库');
    const files = [
      ['合成角色甲', 'danbooru_101.jpg'],
      ['合成角色甲', 'danbooru_102.png'],
      ['合成名乙', 'danbooru_103.jpeg'],
      ['合成名丙', 'danbooru_104.jpg'],
    ];
    for (const [char, name] of files) {
      fs.mkdirSync(path.join(root, char), { recursive: true });
      fs.writeFileSync(path.join(root, char, name), 'x');
    }
    // 干扰项:非图片、派生缩略图目录、别的形状文件名 —— 都不许进库。
    fs.writeFileSync(path.join(root, '合成角色甲', 'danbooru_105.txt'), 'x');
    fs.mkdirSync(path.join(root, 'thumbs'));
    fs.writeFileSync(path.join(root, 'thumbs', 'danbooru_999.jpg'), 'x');

    const scanned = scanMeituRoot(root);
    assert.equal(scanned.length, 4, '只认 <角色>\\<source>_<id>.<jpg|png>');
    assert.deepEqual(parseImageFileName('danbooru_12402881.jpg'), { source: 'danbooru', sourceId: '12402881', ext: 'jpg' });
    assert.equal(parseImageFileName('thumb_danbooru_1.jpg'), null);
    assert.equal(parseImageFileName('danbooru_abc.jpg'), null);
    const report = await runBackfill({
      rootDir: root,
      dbPath: path.join(dir, 'meitu.db'),
      fetch: false, // 只验证目录口径,不联网
      version: 'test',
    });
    assert.equal(report.scanned, 4);
    assert.equal(report.inserted, 4);
    const gallery = openGallery(path.join(dir, 'meitu.db'));
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_meta').get().n, 4, '行数 = 目录图数');
    gallery.close();
  });
});

test('meitu-gallery:路径修复 —— 图被手动分档挪走后,旧路径按 (source,id) 更新到新位置;幂等', async () => {
  await withTemp(async (dir) => {
    const root = path.join(dir, 'bot自动搬运仓库');
    const dbPath = path.join(dir, 'meitu.db');
    const stalePath = path.join(root, '合成角色甲', 'danbooru_901.jpg'); // 旧位置(手动分类前)
    const newPath = path.join(root, 'r13', '合成角色甲', 'danbooru_901.jpg'); // 新位置
    // 库里先有旧路径的行(upsert 身份 = source+source_id,搬图后不会自动改 file_path)。
    const gallery = openMeituGallery({ dbPath });
    gallery.upsertFromFetch({ source: 'danbooru', sourceId: '901', filePath: stalePath, fetchedAt: 1, rating: 'g' });
    gallery.upsertFromFetch({ source: 'danbooru', sourceId: '902', filePath: path.join(root, 'r13', '合成名乙', 'danbooru_902.jpg'), fetchedAt: 1, rating: 'g' });
    gallery.close();
    // 图真的在 r13\合成角色甲 下,合成名乙那张在库里但文件不在(不修它,missing 只数"目录有库里没有")。
    fs.mkdirSync(path.join(root, 'r13', '合成角色甲'), { recursive: true });
    fs.writeFileSync(newPath, 'x');

    const first = repairMetaPaths({ rootDir: root, dbPath });
    assert.equal(first.scanned, 1, '只扫描目录里真实存在的图');
    assert.equal(first.updated, 1, '旧路径那一行要更新');
    assert.equal(first.missing, 0, '命中的行都在库里');
    const g2 = openMeituGallery({ dbPath });
    const row = g2.db.prepare('SELECT file_path FROM meitu_meta WHERE source = ? AND source_id = ?').get('danbooru', '901');
    assert.equal(path.resolve(row.file_path), path.resolve(newPath), 'file_path 要指向新位置');
    g2.close();

    const second = repairMetaPaths({ rootDir: root, dbPath });
    assert.equal(second.updated, 0, '第二次幂等(没有变化)');
    assert.equal(second.unchanged, 1);
  });
});

/** 只开库(不传 now 也行;openMeituGallery 要求有 dbPath)。 */
function openGallery(dbPath) {
  return openMeituGallery({ dbPath });
}

test('meitu-gallery:新结构 r13/r18 —— 分档目录扫得到、旧结构存量仍兼容、行数=目录数', async () => {
  await withTemp(async (dir) => {
    const root = path.join(dir, 'bot自动搬运仓库');
    const put = (rel, name) => {
      const d = path.join(root, rel);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, name), 'x');
    };
    put(path.join('r13', '合成角色甲'), 'danbooru_201.jpg');
    put(path.join('r13', '合成名乙'), 'danbooru_202.png');
    put(path.join('r18', '合成角色甲'), 'safebooru_301.jpg');
    put('合成名丙', 'danbooru_203.jpg'); // 1.184.2 之前的旧结构存量

    const scanned = scanMeituRoot(root);
    assert.equal(scanned.length, 4, '两档角色 + 旧结构存量都要扫到');
    const byName = new Map(scanned.map((f) => [f.fileName, f]));
    assert.equal(byName.get('danbooru_201.jpg').charFolder, '合成角色甲', 'charFolder 仍是角色名(不含档位)');
    assert.equal(byName.get('danbooru_201.jpg').tierDir, 'r13');
    assert.equal(byName.get('safebooru_301.jpg').charFolder, '合成角色甲');
    assert.equal(byName.get('safebooru_301.jpg').tierDir, 'r18');
    assert.equal(byName.get('danbooru_203.jpg').tierDir, '', '旧结构 tierDir 为空');
    assert.ok(
      byName.get('danbooru_201.jpg').filePath !== byName.get('safebooru_301.jpg').filePath,
      '两档同角色的文件路径必须不同',
    );

    // 回填(不联网)行数 = 目录图数:同一个角色在两档各一张也各占一行。
    const report = await runBackfill({
      rootDir: root,
      dbPath: path.join(dir, 'meitu.db'),
      fetch: false,
      version: 'test',
    });
    assert.equal(report.scanned, 4);
    assert.equal(report.inserted, 4);
    const gallery = openGallery(path.join(dir, 'meitu.db'));
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_meta').get().n, 4);
    gallery.close();
  });
});

// ---------------------------------------------------------------------------
// ⑥ 排序三级 / 窗口过滤 / 分页 / facets
// ---------------------------------------------------------------------------

test('meitu-gallery:排序三级(sent_count→last_sent_at→fetched_at)+ 窗口过滤 + 分页 + facets', async () => {
  await withTemp(async (dir) => {
    const gallery = openTemp(dir, 'meitu.db', () => SEED_MS);
    const make = (sourceId, { sentCount = 0, lastSentAt = null, fetchedAt = DAY_START + 1000, characters = ['fixture_character_a'], rating = 'g' } = {}) => {
      const filePath = `D:\\x\\danbooru_${sourceId}.jpg`;
      gallery.upsertFromFetch({ source: 'danbooru', sourceId, filePath, fetchedAt, rating, characters });
      gallery.db.prepare('UPDATE meitu_meta SET sent_count = ?, last_sent_at = ? WHERE source_id = ?')
        .run(sentCount, lastSentAt, String(sourceId));
    };
    make('50', { sentCount: 5, lastSentAt: 100, fetchedAt: DAY_START + 1000 });
    make('51', { sentCount: 5, lastSentAt: 200, fetchedAt: DAY_START + 500 });
    make('52', { sentCount: 0, lastSentAt: null, fetchedAt: DAY_START + 3000 });
    make('53', { sentCount: 5, lastSentAt: 200, fetchedAt: DAY_START + 900 });
    make('54', { sentCount: 99, lastSentAt: 999, fetchedAt: DAY_START - 3 * 86_400_000 }); // 窗口外

    const dayPage1 = gallery.queryList({ rank: 'day', atMs: SEED_MS, tier: 'readonly', pageSize: 2, page: 1 });
    assert.equal(dayPage1.total, 4, '窗口外那行不许进日榜');
    assert.deepEqual(dayPage1.items.map((item) => item.sourceId), ['53', '51'], 'sent 相同 → last_sent_at 新的先 → fetched_at 新的先');
    assert.equal(dayPage1.totalPages, 2);
    const dayPage2 = gallery.queryList({ rank: 'day', atMs: SEED_MS, tier: 'readonly', pageSize: 2, page: 2 });
    assert.deepEqual(dayPage2.items.map((item) => item.sourceId), ['50', '52']);
    const latest = gallery.queryList({ rank: 'latest', tier: 'readonly', pageSize: 10 });
    assert.deepEqual(latest.items.map((item) => item.sourceId), ['52', '50', '53', '51', '54'], '最新 = fetched_at 倒序(窗口外也在这)');
    assert.equal(orderBySql('latest'), 'fetched_at DESC, id DESC');
    assert.match(orderBySql('week'), /^sent_count DESC, last_sent_at DESC, fetched_at DESC/u);
    // facets 同一个权限闸(blacklisted/'' 不参与聚合);角色 tag 按图数倒序。
    gallery.upsertFromFetch({ source: 'danbooru', sourceId: '55', filePath: 'D:\\x\\danbooru_55.jpg', fetchedAt: SEED_MS - 1000, rating: 's', characters: ['fixture_character_a', 'fixture_name_b_(fixture_work_b)'] });
    const safeFacets = gallery.facets({ tier: 'readonly' });
    assert.deepEqual(safeFacets, [{ tag: 'fixture_character_a', count: 5 }], 'readonly 的 chips 只数 g 行');
    const memberFacets = gallery.facets({ tier: 'member', withq: 1 });
    assert.deepEqual(memberFacets, [
      { tag: 'fixture_character_a', count: 6 },
      { tag: 'fixture_name_b_(fixture_work_b)', count: 1 },
    ]);
    gallery.close();
  });
});

// ---------------------------------------------------------------------------
// ⑦ 回填报告三数 + 分布行 + 告警
// ---------------------------------------------------------------------------

test('meitu-gallery:回填报告 —— ok/fail/blacklisted 三数同现;fail>0 告警;另出 rating 分布行', async () => {
  await withTemp(async (dir) => {
    const root = path.join(dir, 'bot自动搬运仓库');
    for (const [char, id] of [['合成角色甲', '60'], ['合成角色甲', '61'], ['合成名乙', '62']]) {
      fs.mkdirSync(path.join(root, char), { recursive: true });
      fs.writeFileSync(path.join(root, char, `danbooru_${id}.jpg`), 'x');
    }
    const hitWord = MINOR_TAGS[0];
    const fakeFetch = async ({ source, sourceId }) => {
      if (sourceId === '62') return { ok: false, error: 'HTTP 500' };
      return {
        ok: true,
        rating: sourceId === '61' ? 's' : 'g',
        characters: ['fixture_character_a'],
        copyright: 'fixture_work_b',
        generalTags: sourceId === '61' ? ['1girl', hitWord] : ['1girl'],
        allTags: sourceId === '61' ? ['1girl', hitWord] : ['1girl'],
        width: 100,
        height: 200,
      };
    };
    const report = await runBackfill({
      rootDir: root,
      dbPath: path.join(dir, 'meitu.db'),
      fetchPost: fakeFetch,
      version: '9.9.9-test',
    });
    assert.equal(report.ok, 2);
    assert.equal(report.fail, 1);
    assert.equal(report.blacklisted, 1);
    const lines = formatBackfillReport(report);
    const text = lines.join('\n');
    assert.match(text, /ok=2 fail=1 blacklisted=1/u, '三个数必须在同一行被看见');
    assert.match(text, /!! WARN !! fail=1/u, 'fail 非零必须告警式打印');
    assert.match(text, /rating 分布:g=1 s=1 q=0 e=0 ''=1/u, 'rating 分布要出一行');
    assert.match(text, /公开档\(rating=g\)现在有 1 张/u, '公开档的 g 数量要用报告说话');
    assert.match(text, /FAIL danbooru:62 HTTP 500/u, '失败的帖子要逐条列出');
    // normalizeRating:认不出 = ''(不是"当成 g")。
    assert.equal(normalizeRating('general'), 'g');
    assert.equal(normalizeRating('questionable'), 'q');
    assert.equal(normalizeRating('xxx'), '');
    // 库路径派生:data\aris\state.db → data\aris\meitu.db(生产归属 aris 单实例)。
    assert.equal(
      meituDbPathFromStateDb(path.join('data', 'aris', 'state.db')),
      path.join(path.resolve('data', 'aris'), 'meitu.db'),
    );
  });
});

// ---------------------------------------------------------------------------
// ⑧ 服务层埋点钩子(deps.gallery:未注入 = 跳过;注入 = upsert + recordSent;埋点炸了不影响发图)
// ---------------------------------------------------------------------------

/** 服务层单测的静默日志(不往 stdout 打印,免得干扰 selftest 汇总行)。 */
const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

const SERVICE_PARSED = {
  ok: true,
  count: 1,
  character: '合成角色甲',
  tags: [],
  ratingWanted: true,
  tier: 'meitu',
  random: false,
  ignored: [],
};

test('meitu-gallery:服务层埋点 —— 注入 deps.gallery 时 upsert+recordSent;未注入/炸了都不影响发图', async () => {
  await withTemp(async (dir) => {
    const img = path.join(dir, 'danbooru_1234.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const makeDeps = (gallery) => ({
      config: {
        meitu: {
          enabled: true,
          groups: ['g1'],
          max: 5,
          cooldownMs: 0,
          source: 'auto',
          root: dir,
          alias: path.join(dir, 'missing-alias.json'),
          lines: path.join(dir, 'missing-lines.json'),
          maxBytes: 10_485_760,
          timeoutMs: 90_000,
          proxy: '',
        },
      },
      log: SILENT_LOG,
      now: () => SEED_MS,
      runFetch: async () => ({
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          files: [{ path: img, source: 'danbooru', id: 1234, rating: 'questionable', url: 'https://example.invalid/x.jpg', md5: 'b'.repeat(32) }],
          rungs: [],
        }),
        stderr: '',
      }),
      uploadFile: async () => 'file_info_1',
      sendMedia: async () => ({ id: 1 }),
      reply: async () => {},
      ...(gallery ? { gallery } : {}),
    });
    const message = { scene: 'group', targetId: 'g1', isMention: true, content: 'x' };

    // ① 没注入 = 全程跳过(旧行为;未接线的实例一笔都不多写)。
    const bare = await handleMeituCommand({ message, parsed: SERVICE_PARSED, deps: makeDeps(null) });
    assert.equal(bare.ok, true);
    assert.equal(bare.sent, 1);

    // ② 注入了 = 抓取后 upsert 元数据 + 发成功 recordSent(同一张图发一次恰好记一次)。
    const calls = [];
    const spyGallery = {
      async upsertFromFetch(input) { calls.push(['upsert', input]); },
      async recordSent(input) { calls.push(['sent', input]); },
      async recordBlocked(input) { calls.push(['blocked', input]); },
    };
    const hooked = await handleMeituCommand({ message, parsed: SERVICE_PARSED, deps: makeDeps(spyGallery) });
    assert.equal(hooked.ok, true);
    assert.equal(hooked.sent, 1);
    const upsert = calls.find(([kind]) => kind === 'upsert')?.[1];
    assert.deepEqual(
      { source: upsert?.source, sourceId: upsert?.sourceId, filePath: upsert?.filePath, rating: upsert?.rating },
      { source: 'danbooru', sourceId: 1234, filePath: img, rating: 'questionable' },
    );
    const sent = calls.find(([kind]) => kind === 'sent')?.[1];
    assert.deepEqual({ source: sent?.source, sourceId: sent?.sourceId, atMs: sent?.atMs }, { source: 'danbooru', sourceId: 1234, atMs: SEED_MS });
    // 按群去重(2026-10-28):服务层记账要带上群 id 与内容 md5(抓取器 files[] 现在带 md5)。
    assert.equal(sent?.group, 'g1', 'recordSent 要带群 id(发送账按群记)');
    assert.equal(sent?.md5, 'b'.repeat(32), 'recordSent 要带候选的 md5(内容身份)');

    // ③ 埋点自己炸了也不许影响"把图发出去"(只 warn)。
    const brokenGallery = {
      async upsertFromFetch() { throw new Error('DB 炸了'); },
      async recordSent() { throw new Error('DB 炸了'); },
    };
    const survived = await handleMeituCommand({ message, parsed: SERVICE_PARSED, deps: makeDeps(brokenGallery) });
    assert.equal(survived.ok, true);
    assert.equal(survived.sent, 1);
  });
});

test('meitu-gallery:被内容审核拦 → deps.gallery.recordBlocked 真被调用(刀 7 打点不回归)', async () => {
  await withTemp(async (dir) => {
    const img = path.join(dir, 'danbooru_2001.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]));
    const fetchFile = (id, rating) => ({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        files: [{ path: img, source: 'danbooru', id, rating, url: 'https://example.invalid/y.jpg' }],
        rungs: [],
      }),
      stderr: '',
    });
    let fetches = 0;
    let sends = 0;
    const calls = [];
    const gallery = {
      async upsertFromFetch() {},
      async recordSent() {},
      async recordBlocked(input) { calls.push(input); },
    };
    const deps = {
      config: {
        meitu: {
          enabled: true, groups: ['g1'], max: 5, cooldownMs: 0, source: 'auto', root: dir,
          alias: path.join(dir, 'missing-alias.json'), lines: path.join(dir, 'missing-lines.json'),
          maxBytes: 10_485_760, timeoutMs: 90_000, proxy: '',
        },
      },
      log: SILENT_LOG,
      now: () => SEED_MS,
      runFetch: async () => {
        fetches += 1;
        return fetchFile(fetches === 1 ? 2001 : 2002, fetches === 1 ? 'questionable' : 'general');
      },
      uploadFile: async () => 'file_info_1',
      sendMedia: async () => {
        sends += 1;
        // QQ 侧内容审核拦:命中 BLOCKED_RE 的那条错误文案(与真实现场同一形状)
        if (sends === 1) throw new Error('HTTP 400 code=40034006 消息内容违规');
        return { id: 1 };
      },
      reply: async () => {},
      gallery,
    };
    const result = await handleMeituCommand({
      message: { scene: 'group', targetId: 'g1', isMention: true, content: 'x' },
      parsed: SERVICE_PARSED,
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1, '被拦的那一张要打 recordBlocked,**恰好一次**');
    assert.deepEqual({ source: calls[0].source, sourceId: calls[0].sourceId }, { source: 'danbooru', sourceId: 2001 },
      '打点写的是**被拦的那张图**的 (source, sourceId)—— 不是降档补发的那张');
  });
});

// ---------------------------------------------------------------------------
// ⑧ 只读连接(面板那只 bot 用:双进程一写多读,写者仍只有一只)
// ---------------------------------------------------------------------------

test('meitu-gallery:只读连接 —— 读得到、写方法大声抛错、fileMustExist 生效(不静默建空库)', async () => {
  await withTemp(async (dir) => {
    const dbPath = path.join(dir, 'meitu.db');
    const writer = openMeituGallery({ dbPath, now: () => SEED_MS });
    writer.upsertFromFetch(row({
      sourceId: '70',
      filePath: 'D:\\x\\danbooru_70.jpg',
      rating: 'g',
      characters: ['fixture_character_a'],
      generalTags: ['1girl'],
    }));
    writer.close();

    const reader = openMeituGallery({ dbPath, readOnly: true });
    assert.equal(reader.readOnly, true);
    assert.equal(reader.dbPath, path.resolve(dbPath));
    const list = reader.queryList({ rank: 'latest', tier: 'readonly' });
    assert.equal(list.total, 1, '只读连接照样能查(面板展览靠它)');
    assert.equal(reader.facets({ tier: 'readonly' }).length, 1);
    // 写方法必须**大声**失败 —— 静默不生效是最难查的那种接线错误。
    assert.throws(() => reader.recordSent({ source: 'danbooru', sourceId: '70', atMs: SEED_MS }), /只读/u);
    assert.throws(() => reader.recordBlocked({ source: 'danbooru', sourceId: '70' }), /只读/u);
    assert.throws(() => reader.upsertFile(row({ sourceId: '71', filePath: 'D:\\x\\danbooru_71.jpg' })), /只读/u);
    assert.throws(() => reader.rescanBlacklist(), /只读/u);
    reader.close();
    // 库不存在 = fileMustExist 当场抛(不静默建一个空库,也不替写者建表)。
    assert.throws(() => openMeituGallery({ dbPath: path.join(dir, 'missing.db'), readOnly: true }));
    assert.equal(fs.existsSync(path.join(dir, 'missing.db')), false, '只读打开不许在盘上造文件');
  });
});

// ---------------------------------------------------------------------------
// ⑨ 按群发送账(2026-10-28 主人拍板「按群去重」):同群不重发、跨群复用、md5 缺失退 source:id
// ---------------------------------------------------------------------------

test('meitu-gallery:按群发送账 —— recordSent 记账幂等、群隔离、md5 缺失退 source:id;只读连接可读不可写', async () => {
  await withTemp(async (dir) => {
    const gallery = openMeituGallery({ dbPath: path.join(dir, 'meitu.db'), now: () => SEED_MS });
    // gA 看过 danbooru:30(md5=M);gA 的账里两个身份都要能对上。
    gallery.recordSent({ source: 'danbooru', sourceId: '30', atMs: SEED_MS, group: 'gA', md5: 'c'.repeat(32) });
    const seenA = gallery.seenForGroup('gA');
    assert.deepEqual([...seenA.md5s], ['c'.repeat(32)], '有 md5 的按内容身份记账');
    assert.ok(seenA.ids.has('danbooru:30'), '账里同时留 source:id(同帖换内容也按 id 挡,宁严勿重)');
    // 重复记账(重发同图/重复回调)= 幂等,不许记两行。
    gallery.recordSent({ source: 'danbooru', sourceId: '30', atMs: SEED_MS + 1, group: 'gA', md5: 'c'.repeat(32) });
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_seen').get().n, 1, '同群同图只记一行');
    // 群隔离:gB 什么都没看过。
    assert.equal(gallery.seenForGroup('gB').md5s.size, 0, '别的群不许被 gA 的账挡住');
    assert.equal(gallery.seenForGroup('').md5s.size, 0, '空群号 = 不查(调用方没传群就不记账也不排除)');
    // md5 缺失(帖子没给):退回按 (source,id) 记,也能挡住。
    gallery.recordSent({ source: 'safebooru', sourceId: '9', atMs: SEED_MS, group: 'gB' });
    const seenB = gallery.seenForGroup('gB');
    assert.equal(seenB.md5s.size, 0);
    assert.ok(seenB.ids.has('safebooru:9'), '没 md5 的按 source:id 记账');
    // 不带 group 的 recordSent = 旧口径(只加 sent_count,不进发送账)。
    gallery.recordSent({ source: 'danbooru', sourceId: '31', atMs: SEED_MS });
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_seen').get().n, 2);
    // 只读连接:账可读,写大声抛(与其它写方法同一条纪律)。
    gallery.close();
    const reader = openMeituGallery({ dbPath: path.join(dir, 'meitu.db'), readOnly: true });
    assert.equal(reader.seenForGroup('gA').md5s.size, 1, '只读连接读得到账(抓取器 --dry 预览靠它)');
    assert.throws(() => reader.recordSent({ source: 'danbooru', sourceId: '30', atMs: SEED_MS, group: 'gC' }), /只读/u);
    reader.close();
  });
});

// ---------------------------------------------------------------------------
// ⑩ md5 身份进主表(D312,2026-10-28)
// ---------------------------------------------------------------------------

test('meitu-gallery:旧库迁移 —— 没有 md5 列的库打开时自动补列+补唯一索引,老行 md5=\'\' 原样保留', async () => {
  await withTemp(async (dir) => {
    const dbPath = path.join(dir, 'meitu.db');
    // 手工造一个 1.200.x 形状的库(没有 md5 列、没有 md5 唯一索引),塞一行老数据。
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE meitu_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, source_id TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE,
      rating TEXT NOT NULL DEFAULT '', characters TEXT NOT NULL DEFAULT '[]',
      copyright TEXT NOT NULL DEFAULT '', general_tags TEXT NOT NULL DEFAULT '[]',
      fetched_at INTEGER NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0, last_sent_at INTEGER,
      blocked INTEGER NOT NULL DEFAULT 0, blacklisted INTEGER NOT NULL DEFAULT 0,
      width INTEGER, height INTEGER, created_at INTEGER NOT NULL,
      UNIQUE(source, source_id)
    )`);
    raw.prepare("INSERT INTO meitu_meta (source, source_id, file_path, fetched_at, created_at) VALUES ('danbooru', '80', 'D:\\\\x\\\\danbooru_80.jpg', 1, 1)").run();
    raw.close();

    const gallery = openMeituGallery({ dbPath: dbPath, now: () => SEED_MS });
    const columns = gallery.db.prepare("SELECT name FROM pragma_table_info('meitu_meta')").all().map((item) => item.name);
    assert.equal(columns.at(-1), 'md5', '迁移列必须加在**末尾**(与新建库列序一致)');
    const old = gallery.findByMd5 === undefined ? null : gallery.db.prepare("SELECT md5 FROM meitu_meta WHERE source_id = '80'").get();
    assert.equal(old.md5, '', '老行 md5 留空(逐轮回填),不许编一个值');
    // 迁移后再打开一次:幂等,不许炸、不许加第二列。
    const again = openMeituGallery({ dbPath: dbPath, now: () => SEED_MS });
    assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('meitu_meta') WHERE name = 'md5'").get().n, 1);
    // 老行照常被增量回填(touchBase COALESCE):带上 md5 再扫到就补上,不另起一行。
    const backfill = gallery.upsertFile(row({ sourceId: '80', filePath: 'D:\\x\\danbooru_80.jpg', md5: 'c'.repeat(32) }));
    assert.equal(backfill.inserted, false);
    assert.equal(gallery.db.prepare("SELECT md5 FROM meitu_meta WHERE source_id = '80'").get().md5, 'c'.repeat(32), '老行 md5 回填');
    assert.equal(gallery.knownMd5s().has('c'.repeat(32)), true, 'knownMd5s 是全库口径排除集的真相');
    gallery.close();
    again.close();
  });
});

test('meitu-gallery:md5 身份进主表 —— findByMd5 命中、同 md5 不同身份不插第二行、裸 INSERT 被 unique 索引拦', async () => {
  await withTemp(async (dir) => {
    const gallery = openMeituGallery({ dbPath: path.join(dir, 'meitu.db'), now: () => SEED_MS });
    const inserted = gallery.upsertFile(row({ sourceId: '50', filePath: 'D:\\x\\danbooru_50.jpg', md5: 'e'.repeat(32) }));
    assert.equal(inserted.inserted, true);
    assert.equal(gallery.findByMd5('e'.repeat(32)).sourceId, '50', 'findByMd5 按内容身份命中');
    assert.equal(gallery.findByMd5('not-an-md5'), null, '非法 md5 = 查不到(不猜)');

    const rowCount = () => gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_meta').get().n;
    // 同一内容从另一个图源再来:不插第二行,返回可读 warning(复用发送由抓取器按 md5 走)。
    const dup = gallery.upsertFile(row({ source: 'safebooru', sourceId: '51', filePath: 'D:\\x\\safebooru_51.jpg', md5: 'e'.repeat(32) }));
    assert.equal(dup.inserted, false);
    assert.ok(/同一内容/.test(dup.warning ?? ''), `warning 要说清"同内容已在库":${dup.warning}`);
    assert.equal(rowCount(), 1, '库内一行 = 一份内容');

    // 同一身份重新 upsert(回填形状):幂等,不许炸、不许多行。
    const again = gallery.upsertFile(row({ sourceId: '50', filePath: 'D:\\x\\danbooru_50.jpg', md5: 'e'.repeat(32) }));
    assert.equal(again.inserted, false);
    assert.equal(rowCount(), 1);

    // 裸 INSERT 撞部分唯一索引必须被底表拦下(应用层前查只是友好化,闸在库里)。
    const dupMd5 = 'e'.repeat(32);
    assert.throws(
      () => gallery.db.prepare('INSERT INTO meitu_meta (source, source_id, file_path, fetched_at, created_at, md5) VALUES (?, ?, ?, 1, 1, ?)')
        .run('danbooru', '52', 'D:\\x\\danbooru_52.jpg', dupMd5),
      /UNIQUE/u,
      '同 md5 的裸 INSERT 必须被部分唯一索引拦下',
    );
    // md5='' 不进唯一索引(老行/没拿到 md5 的行可以并存多行)。
    gallery.upsertFile(row({ sourceId: '53', filePath: 'D:\\x\\danbooru_53.jpg' }));
    gallery.upsertFile(row({ sourceId: '54', filePath: 'D:\\x\\danbooru_54.jpg' }));
    assert.equal(gallery.db.prepare('SELECT COUNT(*) AS n FROM meitu_meta WHERE md5 = \'\'').get().n >= 2, true, '空 md5 行不受唯一索引限制');
    gallery.close();
  });
});

test('meitu-gallery:只读连接打开旧库自动补 schema(旧库结构回归)', async () => {
  await withTemp(async (dir) => {
    const dbPath = path.join(dir, 'meitu.db');
    // 真实 1.200.x 形状:除 md5/width/height 外其余列都在(别拿"最小可错"当历史形状)。
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE meitu_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, source_id TEXT NOT NULL, file_path TEXT NOT NULL,
      rating TEXT NOT NULL DEFAULT '', characters TEXT NOT NULL DEFAULT '[]',
      copyright TEXT NOT NULL DEFAULT '', general_tags TEXT NOT NULL DEFAULT '[]',
      fetched_at INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER,
      blocked INTEGER NOT NULL DEFAULT 0, blacklisted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source, source_id)
    )`);
    raw.exec("INSERT INTO meitu_meta (source, source_id, file_path) VALUES ('danbooru', '1', '/x.jpg')");
    raw.close();

    // 只读打开:不能抛,且 schema 必须被一次性写连接补齐(旧库回归)。
    const reader = openMeituGallery({ dbPath, readOnly: true });
    const cols = reader.db.prepare("SELECT name FROM pragma_table_info('meitu_meta')").all().map((r) => String(r.name));
    assert.ok(cols.includes('md5'), '只读打开旧库必须补上 md5 列');
    assert.ok(cols.includes('width') && cols.includes('height'), 'width/height 也要补');
    assert.deepEqual([...reader.knownMd5s()], [], '老行 md5=\'\' 原样保留(不回填)');
    assert.equal(reader.findByMd5('0'.repeat(32)), null, '查不到就是 null(纯读)');
    assert.throws(() => reader.recordSent({ source: 'danbooru', sourceId: '1', atMs: 1, group: 'g' }), /只读/u);
    reader.close();
    assert.ok(fs.existsSync(dbPath), '库文件不能被只读打开顺手建坏');
  });
});

export function registerMeituGalleryTests(register) {
  const testFn = typeof register === 'function' ? register : register?.test;
  if (typeof testFn !== 'function') throw new TypeError('registerMeituGalleryTests 需要 test');
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
      console.log(`ok   ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${cases.length} 通过`);
}
