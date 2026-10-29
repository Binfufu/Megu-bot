/**
 * 美图展览处的**数据层**(2026-10-23,展览处刀 1;施工图 = `项目\方案-美图展览处-UI与任务路径-2026-10-23.md`)。
 *
 * 只做四件事,**不接 HTTP**(路由/权限注入归刀 2):
 *   ① `meitu_meta` 建表(DDL 与 `docs\32` §4.1 原样,不加减列) + 独立库打开;
 *   ② **窗口**纯函数:北京时间自然窗(最新/日/周/月/年),时刻由参数传入 —— 可种子钉时刻单测,
 *      绝不读 `Date.now()`(工作区坑 ⑬「时间敏感测试按钟绿」);
 *   ③ **权限档位钳制**纯函数:三红线(`g` 公开 / `s,q` 仅 member+withq / `''` 与 `blacklisted`
 *      任何档不可见)写进 SQL WHERE **前缀**,不是应用层 if(漏一个分支=静默失效);
 *   ④ 落库与查询出口:upsert(幂等)/ recordSent / queryList / queryItem / facets / counts /
 *      rescanBlacklist,以及回填脚本用的目录扫描与文件名解析(一份实现,D159)。
 *
 * 独立库(`data\<bot>\meitu.db`)的三个理由(施工图 §二.2):
 *   ① 全是**可再生派生数据**(源=图源 API + 图片目录),可删库重灌,不碰玩家账本;
 *   ② `state.db` 里是"事实"(位置/账本/会话),混进可重灌数据违背"库里存事实"的形状;
 *   ③ 爆炸半径:回填脚本写坏只烂美图。
 * 归属:跟配置了美图线的 bot 实例走,双进程不写同一个 SQLite。
 *
 * ⚠️ 黑名单清单**只有一份**:`src\meitu-search.js` 的 `MINOR_TAGS`/`isBlockedPost`。
 *    这里不抄第二份;网页查询闸**不重算**黑名单(不在 SQL 里扫 JSON 列),信任 `blacklisted` 列,
 *    改动清单后必须跑一次 `rescanBlacklist`(回填脚本 `--rescan-blacklist`)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IMAGE_EXTS, isBlockedPost, normalizeMd5 } from './meitu-search.js';

/** 北京时间 = UTC+8(无夏令时,固定偏移;别引入时区库)。 */
const BEIJING_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** 榜单窗口种类(UI tab 的五格;`latest` = 无窗口的"最新上传流")。 */
export const RANKS = ['latest', 'day', 'week', 'month', 'year'];

/** 每页张数【暂定·数字他定】——照抄 Safebooru/Gelbooru 的 42,零学习成本(docs\32 §1.2)。 */
export const DEFAULT_PAGE_SIZE = 42;

/** 能进库的扩展名(与 `src\meitu-search.js` 的 IMAGE_EXTS 同一份)。 */
const IMAGE_EXT_SET = new Set(IMAGE_EXTS);

/**
 * `meitu_meta` + `meitu_seen` 的建表 DDL —— **逐字照抄** `docs\32` §4.1(不加减列)。
 * 改 schema 要先改那份文档再改这里;`selftest-meitu-gallery` 会真开临时库跑一遍。
 * `meitu_seen` = 按群发送账(2026-10-28 主人拍板「按群去重」):库 = 共享缓存
 * (同一张图只存一份),"看没看过"按群记 —— 同群不重发,不同群可复用同一份文件。
 */
export const MEITU_GALLERY_DDL = `CREATE TABLE IF NOT EXISTS meitu_meta (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT    NOT NULL,             -- 'danbooru' | 'safebooru'
  source_id    TEXT    NOT NULL,             -- 图源帖子 id(文件名里现成)
  file_path    TEXT    NOT NULL UNIQUE,      -- <图库根>\\<角色目录>\\danbooru_<id>.jpg
  rating       TEXT    NOT NULL DEFAULT '',  -- g/s/q/e(图源口径;''=没回填到,fail-closed 不上架)
  characters   TEXT    NOT NULL DEFAULT '[]',-- JSON:角色 tags
  copyright    TEXT    NOT NULL DEFAULT '',  -- 作品名(由内容或图源元数据提供)
  general_tags TEXT    NOT NULL DEFAULT '[]',-- JSON:通用 tags(黑名单扫描的对象)
  fetched_at   INTEGER NOT NULL,             -- 抓取落盘时间 ms(唯一现成的时间轴)
  sent_count   INTEGER NOT NULL DEFAULT 0,   -- 发群次数(替代站点半分的候选口径,§5)
  last_sent_at INTEGER,
  blocked      INTEGER NOT NULL DEFAULT 0,   -- 被平台拦过(QQ 侧发不出去)
  blacklisted  INTEGER NOT NULL DEFAULT 0,   -- 未成年外观黑名单命中:任何档都不可见(fail-closed)
  width        INTEGER, height INTEGER,
  created_at   INTEGER NOT NULL,
  md5          TEXT    NOT NULL DEFAULT '',
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_meitu_rank ON meitu_meta(blacklisted, rating, fetched_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meitu_md5 ON meitu_meta(md5) WHERE md5 <> '';
CREATE TABLE IF NOT EXISTS meitu_seen (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   TEXT    NOT NULL,
  md5        TEXT    NOT NULL DEFAULT '',
  source     TEXT    NOT NULL DEFAULT '',
  source_id  TEXT    NOT NULL DEFAULT '',
  at         INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meitu_seen_group_md5 ON meitu_seen(group_id, md5) WHERE md5 <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_meitu_seen_group_source ON meitu_seen(group_id, source, source_id) WHERE md5 = '';`;

/** 图源 → 数据库里的 rating 口径(g/s/q/e 单字母)。Safebooru 用整词。 */
const SOURCE_RATING_MAP = {
  safe: 'g',
  general: 'g',
  sensitive: 's',
  questionable: 'q',
  explicit: 'e',
  g: 'g',
  s: 's',
  q: 'q',
  e: 'e',
};

/**
 * 图源给来的 rating 归一成库里的单字母口径。
 * 认不出的值返回 `''`(fail-closed:没回填到 = 不上架,不是"当成 g")。
 * @param {string} value
 */
export function normalizeRating(value) {
  return SOURCE_RATING_MAP[String(value ?? '').trim().toLowerCase()] ?? '';
}

/**
 * 文件名 → `{source, sourceId, ext}`;不是本项目的落盘形状就返回 `null`。
 *
 * 形状来自 `src\meitu-store.js` 的 `imageFileName`:`<source>_<id>.<ext>`。
 * 回填脚本、缩略图脚本、selftest 共用这一份解析(别抄第二份)。
 * @param {string} fileName
 */
export function parseImageFileName(fileName) {
  const match = /^(danbooru|safebooru)_([0-9]+)\.(jpg|jpeg|png)$/i.exec(String(fileName ?? '').trim());
  if (!match) return null;
  return {
    source: match[1].toLowerCase(),
    sourceId: match[2],
    ext: match[3].toLowerCase(),
  };
}

/**
 * 扫一遍美图根目录。**两种结构都认**(1.184.3 起新图分档落库):
 *   · 新结构 `<根>\<r13|r18>\<角色名>\<source>_<id>.<ext>`(tierDir = 'r13'/'r18');
 *   · 旧结构 `<根>\<角色名>\<source>_<id>.<ext>`(1.184.2 之前的存量,tierDir = '');
 * 跳过 `thumbs/` 这类派生目录。
 *
 * 返回按路径字典序排好(确定性,重扫幂等);目录不存在 = 空数组,不抛。
 * @param {string} rootDir
 * @returns {Array<{filePath: string, charFolder: string, tierDir: string, fileName: string,
 *                  source: string, sourceId: string, ext: string, bytes: number, fetchedAt: number}>}
 */
export function scanMeituRoot(rootDir) {
  const root = path.resolve(String(rootDir ?? ''));
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  /** 分类目录名(`r13`/`r18` 这类);认不出 = 空串(旧结构)。 */
  const TIER_DIR_RE = /^r\d+$/i;
  const found = [];

  /** 扫一个角色目录里的图片文件,结果推进 `found`。 */
  const collectCharDir = (dir, charFolder, tierDir) => {
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.isFile()) continue;
      const parsed = parseImageFileName(file.name);
      if (!parsed) continue;
      if (!IMAGE_EXT_SET.has(parsed.ext)) continue;
      const filePath = path.join(dir, file.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      found.push({
        filePath,
        charFolder,
        tierDir,
        fileName: file.name,
        source: parsed.source,
        sourceId: parsed.sourceId,
        ext: parsed.ext,
        bytes: stat.size,
        fetchedAt: Math.round(stat.mtimeMs),
      });
    }
  };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 派生缩略图目录与源同级,扫描时要跳过,否则会把自己扫进来。
    if (/^thumbs(-|$)/i.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (TIER_DIR_RE.test(entry.name)) {
      // 新结构:再下一层才是角色目录。
      let charDirs = [];
      try {
        charDirs = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const charEntry of charDirs) {
        if (!charEntry.isDirectory()) continue;
        collectCharDir(path.join(dir, charEntry.name), charEntry.name, entry.name.toLowerCase());
      }
      continue;
    }
    // 旧结构:entry 本身就是角色目录。
    collectCharDir(dir, entry.name, '');
  }
  found.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return found;
}

/**
 * 文件名 → HTTP Content-Type(只认本项目落盘/派生的三种;认不出按二进制流)。
 * @param {string} filePath
 */
export function mimeForImagePath(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

/**
 * **两档缩略图 + 原图**的选取(纯函数,不碰 HTTP):三级回落 小(128)→ 大(512)→ 原图。
 *
 * 文件形状与 `scripts\meitu-thumbs.py` 一致:`<thumbsRoot>\thumbs-128\<source>_<id>.webp`
 * 与 `<thumbsRoot>\thumbs\<source>_<id>.webp`。请求路径**零解码零缩放**(web-panel-ui ⑧),
 * 文件不在就回落下一级;三级都没有返回 `null`(调用方回 404,不猜路径)。
 *
 * @param {{original: string, source: string, sourceId: string|number, thumbsRoot: string, small?: boolean}} input
 * @returns {{path: string, mime: string, tier: 'small'|'big'|'original'}|null}
 */
export function pickMeituFile({ original, source, sourceId, thumbsRoot, small = false } = {}) {
  const originalPath = String(original ?? '').trim();
  const key = `${String(source ?? '').trim()}_${String(sourceId ?? '').trim()}`;
  const root = String(thumbsRoot ?? '').trim();
  const tiers = small
    ? [['small', 'thumbs-128'], ['big', 'thumbs'], ['original', '']]
    : [['big', 'thumbs'], ['original', '']];
  for (const [tier, dir] of tiers) {
    const candidate = dir
      ? (root ? path.join(root, dir, `${key}.webp`) : '')
      : originalPath;
    if (!candidate) continue;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size <= 0) continue;
      return { path: candidate, mime: mimeForImagePath(candidate), tier };
    } catch {
      // 这一级没有:回落下一级。
    }
  }
  return null;
}

/**
 * 某个状态库的同级美图库路径:`data\<bot>\state.db` → `data\<bot>\meitu.db`。
 * 按配置了美图线的实例派生(`data\<bot>\meitu.db`),不猜测其他实例的库。
 * @param {string} stateDbFile
 */
export function meituDbPathFromStateDb(stateDbFile) {
  const stateDb = String(stateDbFile ?? '').trim();
  if (!stateDb) return '';
  return path.join(path.dirname(path.resolve(stateDb)), 'meitu.db');
}

/** 校验 rank,认不出按 `latest`(fail-safe:最宽松的那个 tab 不会藏东西)。 */
function normalizeRank(rank) {
  const value = String(rank ?? '').trim().toLowerCase();
  return RANKS.includes(value) ? value : 'latest';
}

/**
 * 北京时间自然窗的**纯函数**。所有期望值由 `atMs` 派生 —— 生产调用传 `Date.now()`,
 * 单测传**钉死的种子时刻**(坑 ⑬:写死期望值会只在一部分钟点绿)。
 *
 * @param {'latest'|'day'|'week'|'month'|'year'} rank
 * @param {number} atMs 任意时刻(毫秒);窗口按"该时刻所在的北京自然窗"算
 * @returns {{kind: string, startMs: number|null, endMs: number|null}}
 *   `latest` 的 start/end 都是 `null`(=不加时间条件);其余是左闭右开 `[startMs, endMs)`。
 */
export function beijingWindow(rank, atMs) {
  const kind = normalizeRank(rank);
  // 只认参数;读时钟会让"按钟绿"(坑 ⑬)。
  const atNumber = Number.isFinite(Number(atMs)) ? Math.trunc(Number(atMs)) : 0;
  if (kind === 'latest') return { kind, startMs: null, endMs: null };

  // 把时刻平移到北京钟面,再用 UTC getter 读年月日(避开本机时区)。
  const local = new Date(atNumber + BEIJING_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const date = local.getUTCDate();
  const toMs = (y, m, d) => Date.UTC(y, m, d) - BEIJING_OFFSET_MS;

  let startMs;
  let endMs;
  if (kind === 'day') {
    startMs = toMs(year, month, date);
    endMs = startMs + DAY_MS;
  } else if (kind === 'week') {
    // 周 = 本周一 00:00 起(ISO 口径;周日 getUTCDay()=0 → 归到上一组的周一)。
    const daysSinceMonday = (local.getUTCDay() + 6) % 7;
    startMs = toMs(year, month, date - daysSinceMonday);
    endMs = startMs + 7 * DAY_MS;
  } else if (kind === 'month') {
    startMs = toMs(year, month, 1);
    endMs = toMs(year, month + 1, 1);
  } else {
    startMs = toMs(year, 0, 1);
    endMs = toMs(year + 1, 0, 1);
  }
  return { kind, startMs, endMs };
}

/**
 * 窗口前/后移一格(日期导航箭头用;刀 2/刀 6 接,刀 1 先做纯函数并单测)。
 * 北京时间没有夏令时,日/周直接加减毫秒安全;月/年走日历重算(1 月 31 日不加出 2 月 32 日)。
 *
 * @param {'day'|'week'|'month'|'year'} rank
 * @param {{startMs: number, endMs: number}} window  `beijingWindow()` 的返回值
 * @param {number} delta  -1 上一窗 / +1 下一窗
 * @returns {{kind: string, startMs: number, endMs: number}}
 */
export function shiftWindow(rank, window, delta) {
  const kind = normalizeRank(rank);
  const step = Number.isFinite(Number(delta)) ? Math.trunc(Number(delta)) : 0;
  if (kind === 'latest') return beijingWindow('latest', 0);
  const startMs = Number(window?.startMs);
  if (!Number.isFinite(startMs)) throw new TypeError('shiftWindow 需要 {startMs,endMs}');
  if (kind === 'day') return beijingWindow('day', startMs + step * DAY_MS);
  if (kind === 'week') return beijingWindow('week', startMs + step * 7 * DAY_MS);
  // 月/年:按日历加减后在新的 1 号上取窗口(`Date.UTC` 会把 13 月之类的溢出归一成下一年)。
  const local = new Date(startMs + BEIJING_OFFSET_MS);
  const year = local.getUTCFullYear() + (kind === 'year' ? step : 0);
  const month = kind === 'month' ? local.getUTCMonth() + step : 0;
  return beijingWindow(kind, Date.UTC(year, month, 1) - BEIJING_OFFSET_MS);
}

/**
 * 权限档位钳制(**纯函数**;三红线,`docs\32` §4.3 / 施工图 §三.1):
 *   ① `rating='g'` 公开 —— 未登录/readonly 也看得到;
 *   ② `rating='s'|'q'` 只有 member/staff **且显式 withq** 才下发(readonly 带 withq=1 仍 = safe 集);
 *   ③ `rating=''`(没回填到)与 `blacklisted=1` 的行**任何档、任何参数**都查不到。
 * 返回值是 SQL WHERE 的**常量前缀**,直接拼进每个查询入口 —— 不做应用层 if。
 *
 * @param {{tier?: string, withq?: boolean|number|string}} params
 * @returns {{safe: boolean, sql: string, params: string[], ratings: string[]}}
 */
export function visibilityWhere({ tier, withq } = {}) {
  const tierName = String(tier ?? '').trim().toLowerCase();
  const privileged = tierName === 'member' || tierName === 'staff';
  const wantQ = withq === true || withq === 1 || String(withq ?? '') === '1';
  const includeSensitive = privileged && wantQ;
  const ratings = includeSensitive ? ['g', 's', 'q'] : ['g'];
  return {
    safe: !includeSensitive,
    // `rating <> ''` 是 fail-closed 的那一半:没回填到的行连"未知"都不算,直接不上架。
    sql: `blacklisted = 0 AND rating <> '' AND rating IN (${ratings.map(() => '?').join(', ')})`,
    params: ratings,
    ratings,
  };
}

/**
 * 排序口径(`docs\32` §5;窗口 tab 用三级行为计数,最新 tab 就是上传时间倒序)。
 * @param {'latest'|'day'|'week'|'month'|'year'} rank
 */
export function orderBySql(rank) {
  return normalizeRank(rank) === 'latest'
    ? 'fetched_at DESC, id DESC'
    : 'sent_count DESC, last_sent_at DESC, fetched_at DESC, id DESC';
}

/** JSON 列安全解析:坏数据(手改/半写)当空数组,不让一行坏数据炸掉整页。 */
function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(String(text ?? '[]'));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function jsonOrEmpty(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  return JSON.stringify(clean);
}

/** 行 → 查询结果(给刀 2 的路由层用;`filePath` 只在服务端用,别直接丢给客户端)。 */
function rowToItem(row) {
  return {
    id: Number(row.id),
    source: row.source,
    sourceId: String(row.source_id),
    filePath: String(row.file_path),
    rating: row.rating,
    characters: parseJsonArray(row.characters),
    copyright: String(row.copyright ?? ''),
    generalTags: parseJsonArray(row.general_tags),
    fetchedAt: Number(row.fetched_at),
    sentCount: Number(row.sent_count ?? 0),
    lastSentAt: row.last_sent_at === null || row.last_sent_at === undefined ? null : Number(row.last_sent_at),
    blocked: Number(row.blocked ?? 0),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    createdAt: Number(row.created_at),
    md5: String(row.md5 ?? ''),
  };
}

/**
 * 建表(幂等)。**所有**打开美图库的入口都走这里:
 * `openMeituGallery`、回填脚本、selftest 的临时库。
 *
 * 旧库迁移(2026-10-28 / D312,幂等):1.200.x 及更早的库没有 `md5` 列 ——
 * CREATE TABLE IF NOT EXISTS 不会给老表加列,必须显式 ALTER(加在**末尾**,与新建库列序一致),
 * 再补部分唯一索引。老行 md5='' 由增量抓取逐轮回填(COALESCE),不阻塞、不回填脚本。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function initMeituGallery(db) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('initMeituGallery 需要 node:sqlite 连接');
  // 旧库迁移必须**先于 DDL**:老表缺 md5 列时,DDL 里的 CREATE UNIQUE INDEX ...(md5)
  // 会报 no such column。顺序 = ①老表存在且缺列 → ALTER 补列(加在末尾);②跑 DDL
  // (新库带 md5 建表,老库此刻已有列,唯一索引随之补齐)。两条都幂等。
  const tableExists = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meitu_meta'").get();
  if (Number(tableExists?.n)) {
    // 老库可能缺不止一列:1.200.x 及更早没有 md5;2026-10-27 之前的库还没有 width/height。
    // 缺哪列补哪列(加在末尾,与新建库列序一致),全部幂等。
    const cols = new Set(
      db.prepare("SELECT name FROM pragma_table_info('meitu_meta')").all().map((r) => String(r.name)),
    );
    const wanted = [
      ['md5', "TEXT NOT NULL DEFAULT ''"],
      ['width', 'INTEGER'],
      ['height', 'INTEGER'],
    ];
    for (const [name, type] of wanted) {
      if (!cols.has(name)) db.exec('ALTER TABLE meitu_meta ADD COLUMN ' + name + ' ' + type);
    }
  }
  db.exec(MEITU_GALLERY_DDL);
  return db;
}

/**
 * 打开(必要时创建)美图库。**幂等**:重复 open/init 不会改数据、不会加列。
 *
 * `readOnly: true` = **只读连接**(`fileMustExist`,不建库、不建表)—— 给"不配美图线
 * 但要在面板上展览"的那只 bot 用(读取方与元数据写入方可以是不同实例;
 * 双进程**只读**打开同一个 SQLite 是安全的,写者仍然只有一只,见 D306 的归属口径)。
 * 只读连接上任何写方法都会**大声抛错**(不静默不生效)。
 *
 * @param {{dbPath: string, now?: () => number, readOnly?: boolean}} options
 * @returns 返回对象的方法见下方 JSDoc;每个方法都只碰这个库,不碰网络、不碰 DOM。
 */
export function openMeituGallery({ dbPath, now, readOnly = false } = {}) {
  const file = String(dbPath ?? '').trim();
  if (!file) throw new TypeError('openMeituGallery 需要 dbPath');
  const target = path.resolve(file);
  const writable = readOnly !== true;
  const clock = typeof now === 'function' ? now : Date.now;
  if (writable) fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = writable
    ? new DatabaseSync(target)
    : new DatabaseSync(target, { readOnly: true, fileMustExist: true });
  // WAL + busy_timeout:回填脚本与 bot 进程可能是两个连接(写一个、读另一个)。
  try {
    // 只读连接不许改 journal_mode(那是一次写操作);busy_timeout 只是连接参数,可以设。
    if (writable) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
  } catch {
    // file::memory: 之类不支持 WAL 的临时库:不影响正确性,继续。
  }
  if (writable) initMeituGallery(db);
  else if (fs.existsSync(target)) {
    // **只读连接不会跑迁移**(initMeituGallery 只在写连接上调),而老库缺列/缺表时那些 SQL
    // 连 prepare 都会炸,展览处直接关掉 —— 曾发生过:读取实例只读打开旧 meitu.db →
    // no such column: md5。这里用**一次性写连接**补齐 schema(幂等,只补列/表/索引,不动数据),
    // 然后继续用只读连接。补不了(权限/锁)就按只读原样继续,后面 prepare 会**大声**失败。
    try {
      const w = new DatabaseSync(target);
      try { initMeituGallery(w); } finally { w.close(); }
    } catch { /* 降级:交给下面的 prepare 报错,不静默 */ }
  }

  /** 只读连接上的写操作要**大声**失败(静默不生效是这类接线最容易出的错)。 */
  const assertWritable = (what) => {
    if (!writable) throw new Error(`美图库是只读连接，不能${what}（写操作要接在写连接上）`);
  };

  const stmts = {
    byIdentity: db.prepare('SELECT id, file_path, rating, characters FROM meitu_meta WHERE source = ? AND source_id = ?'),
    byPath: db.prepare('SELECT id, source, source_id FROM meitu_meta WHERE file_path = ?'),
    byMd5: db.prepare('SELECT id, source, source_id, file_path FROM meitu_meta WHERE md5 = ? AND md5 <> \'\''),
    knownMd5s: db.prepare("SELECT DISTINCT md5 FROM meitu_meta WHERE md5 <> ''"),
    insertBase: db.prepare(`INSERT INTO meitu_meta
      (source, source_id, file_path, rating, characters, copyright, general_tags,
       fetched_at, sent_count, blocked, blacklisted, width, height, created_at, md5)
       VALUES (?, ?, ?, '', '[]', '', '[]', ?, 0, 0, 0, ?, ?, ?, ?)`),
    // 2026-10-27:width/height 必须 COALESCE —— 服务层的幂等兜底 upsert(发图后)不带尺寸,
    // 旧 SQL 会把 fetch-one 先写好的宽高**清成 NULL**(展览处图片质量 silently 变差)。
    // 2026-10-28:md5 同理 COALESCE —— 老行('')由增量抓取逐轮回填,没带就保持原值。
    touchBase: db.prepare('UPDATE meitu_meta SET file_path = ?, fetched_at = ?, width = COALESCE(?, width), height = COALESCE(?, height), md5 = COALESCE(?, md5) WHERE id = ?'),
    applyMeta: db.prepare(`UPDATE meitu_meta SET
      rating = COALESCE(?, rating),
      characters = COALESCE(?, characters),
      copyright = COALESCE(?, copyright),
      general_tags = COALESCE(?, general_tags),
      blacklisted = COALESCE(?, blacklisted),
      width = COALESCE(?, width),
      height = COALESCE(?, height)
      WHERE id = ?`),
    recordSent: db.prepare('UPDATE meitu_meta SET sent_count = sent_count + 1, last_sent_at = ? WHERE id = ?'),
    recordBlocked: db.prepare('UPDATE meitu_meta SET blocked = 1 WHERE id = ?'),
    byId: db.prepare('SELECT * FROM meitu_meta WHERE id = ?'),
    countAll: db.prepare('SELECT COUNT(*) AS n FROM meitu_meta'),
    // 按群发送账(2026-10-28「按群去重」):INSERT OR IGNORE —— 重复记账(重发同图/重复回调)
    // 静默去重,账里一行 = "这个群看过这张图一次"。
    seenInsert: db.prepare(`INSERT OR IGNORE INTO meitu_seen (group_id, md5, source, source_id, at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    seenSelect: db.prepare('SELECT md5, source, source_id FROM meitu_seen WHERE group_id = ?'),
  };

  function findRow({ source, sourceId, filePath }) {
    const identity = source && sourceId
      ? stmts.byIdentity.get(String(source), String(sourceId))
      : undefined;
    const byPath = filePath ? stmts.byPath.get(filePath) : undefined;
    return { identity, byPath };
  }

  /**
   * 落一行"文件已在盘上"的基础记录(**不动** rating/tags;那些归 `applySourceMeta`)。
   * 幂等:同 (source,source_id) 或同 file_path 都只留一行。
   * `md5`(2026-10-28 D312)= 内容身份进主表:同 md5 不同 (source,id) 的帖子**不再插第二行**
   * (部分唯一索引 `idx_meitu_md5` 兜底),返回 warning 让调用方看见 —— 库里一行 = 一份内容,
   * 复用发送由抓取器按 md5 找回文件。md5 缺省/非法 = ''(部分索引不拦),老行由增量抓取回填。
   * @returns {{id: number, inserted: boolean, warning: string|null}}
   */
  function upsertFile(row) {
    assertWritable('落库');
    const source = String(row?.source ?? '').trim();
    const sourceId = String(row?.sourceId ?? '').trim();
    const filePath = String(row?.filePath ?? '').trim();
    if (!source || !sourceId || !filePath) throw new TypeError('upsertFile 需要 source/sourceId/filePath');
    const fetchedAt = Number.isFinite(Number(row?.fetchedAt)) ? Math.trunc(Number(row.fetchedAt)) : Math.trunc(clock());
    const width = Number.isFinite(Number(row?.width)) && Number(row.width) > 0 ? Math.trunc(Number(row.width)) : null;
    const height = Number.isFinite(Number(row?.height)) && Number(row.height) > 0 ? Math.trunc(Number(row.height)) : null;
    const rowMd5 = normalizeMd5(row?.md5);
    const { identity, byPath } = findRow({ source, sourceId, filePath });
    const createdAt = Math.trunc(clock());

    if (identity && byPath && Number(identity.id) !== Number(byPath.id)) {
      // 同一张图被搬到了另一个角色目录:保留先入库的那一行(身份是 (source,source_id)),
      // 不删任何行 —— 删库是人的决定,不是脚本顺手干的。
      return { id: Number(identity.id), inserted: false, warning: `同一帖子(id=${sourceId})在库里已有另一条路径:${identity.file_path}` };
    }
    if (rowMd5) {
      // 内容身份已在库(且不是自己这一行):不插第二行 —— 业界口径(Danbooru/Moebooru)
      // 都是"哈希进主表 + 唯一索引"(D312);这里先查后插给出**可读的 warning**,
      // 底表部分唯一索引仍兜住并发窗口。
      const byMd5 = stmts.byMd5.get(rowMd5);
      if (byMd5 && !(identity && Number(byMd5.id) === Number(identity.id))) {
        return {
          id: Number(byMd5.id),
          inserted: false,
          warning: `同一内容(md5=${rowMd5.slice(0, 8)}…)已在库里:${byMd5.source}:${byMd5.source_id} → ${byMd5.file_path}`,
        };
      }
    }
    if (identity) {
      // 同一帖子在盘上换了位置:以最新扫描到的路径为准(网页要按路径取图),但**只有一行**。
      const moved = String(identity.file_path) !== filePath;
      stmts.touchBase.run(filePath, fetchedAt, width, height, rowMd5 || null, identity.id);
      return {
        id: Number(identity.id),
        inserted: false,
        warning: moved ? `同一帖子(${source}:${sourceId})的文件路径更新:${identity.file_path} → ${filePath}` : null,
      };
    }
    if (byPath) {
      // 旧路径的行换了帖子身份(理论上不该发生):按身份重写,保持一行。
      db.prepare('UPDATE meitu_meta SET source = ?, source_id = ?, fetched_at = ?, width = COALESCE(?, width), height = COALESCE(?, height), md5 = COALESCE(?, md5) WHERE id = ?')
        .run(source, sourceId, fetchedAt, width, height, rowMd5 || null, byPath.id);
      return { id: Number(byPath.id), inserted: false, warning: `文件路径换了帖子身份:${filePath}` };
    }
    const info = stmts.insertBase.run(source, sourceId, filePath, fetchedAt, width, height, createdAt, rowMd5);
    return { id: Number(info.lastInsertRowid), inserted: true, warning: null };
  }

  /**
   * 回填/增量抓取拿到的图源元数据 → 更新那一行。
   * `undefined` = 保持库里原值(增量抓取没有 tags 时不许把已有 tags 清空)。
   *
   * @param {{source: string, sourceId: string, rating?: string, characters?: string[],
   *          copyright?: string, generalTags?: string[], blacklisted?: number|boolean|null,
   *          width?: number, height?: number}} meta
   * @returns {boolean} 是否真更新到一行
   */
  function applySourceMeta(meta) {
    assertWritable('回填元数据');
    const { identity } = findRow({ source: meta?.source, sourceId: meta?.sourceId });
    if (!identity) return false;
    const rating = meta?.rating === undefined ? null : normalizeRating(meta.rating);
    const characters = meta?.characters === undefined ? null : jsonOrEmpty(meta.characters);
    const copyright = meta?.copyright === undefined ? null : String(meta.copyright ?? '');
    const generalTags = meta?.generalTags === undefined ? null : jsonOrEmpty(meta.generalTags);
    const blacklisted = meta?.blacklisted === undefined || meta?.blacklisted === null
      ? null
      : (meta.blacklisted ? 1 : 0);
    const width = Number.isFinite(Number(meta?.width)) && Number(meta.width) > 0 ? Math.trunc(Number(meta.width)) : null;
    const height = Number.isFinite(Number(meta?.height)) && Number(meta.height) > 0 ? Math.trunc(Number(meta.height)) : null;
    stmts.applyMeta.run(rating, characters, copyright, generalTags, blacklisted, width, height, identity.id);
    return true;
  }

  /**
   * 抓取器落盘成功时的**一步式**入口(埋点钩子用):upsert 基础行 + 有就带上元数据。
   * `md5`(2026-10-28 D312)= 内容身份进主表;同 md5 不同身份不插第二行(见 upsertFile)。
   * @param {{source: string, sourceId: string|number, filePath: string, fetchedAt?: number,
   *          rating?: string, characters?: string[], copyright?: string,
   *          generalTags?: string[], blacklisted?: number|boolean, width?: number, height?: number,
   *          md5?: string}} input
   */
  function upsertFromFetch(input) {
    const base = upsertFile({
      source: input?.source,
      sourceId: input?.sourceId,
      filePath: input?.filePath,
      fetchedAt: input?.fetchedAt,
      width: input?.width,
      height: input?.height,
      md5: input?.md5,
    });
    const hasMeta = ['rating', 'characters', 'copyright', 'generalTags', 'blacklisted']
      .some((key) => input?.[key] !== undefined);
    if (hasMeta) applySourceMeta({ ...input, source: input.source, sourceId: input.sourceId });
    return base;
  }

  /** 按内容 md5 取一行的元数据(D312:哈希进主表;查不到/空 md5 = null;纯读)。 */
  function findByMd5(md5) {
    const clean = normalizeMd5(md5);
    if (!clean) return null;
    const row = db.prepare('SELECT * FROM meitu_meta WHERE md5 = ? AND md5 <> \'\'').get(clean);
    return row ? rowToItem(row) : null;
  }

  /** 库里**已有内容**的全部 md5(旧全库口径的排除集;D312 后为主表真相,旁挂索引降级为无库兜底)。 */
  function knownMd5s() {
    return new Set(stmts.knownMd5s.all().map((row) => String(row.md5)));
  }

  /** 按图源身份取一行的元数据(回填脚本判断"要不要再抓一次"用;纯读)。 */
  function getMeta({ source, sourceId } = {}) {
    const { identity } = findRow({ source, sourceId });
    if (!identity) return null;
    const row = stmts.byId.get(identity.id);
    return row ? rowToItem(row) : null;
  }

  /**
   * 发群成功一次(+1),并记入**按群发送账**(2026-10-28「按群去重」)。
   * `group`/`md5` 可选:给了 group 就落一行 meitu_seen(同群同图幂等,重复回调不重复记);
   * md5 缺失(帖子没给)退回按 (source,source_id) 记账。埋点失败语义照旧:不存在行 = false。
   * @param {{source: string, sourceId: string|number, atMs?: number,
   *          group?: string, md5?: string}} input
   */
  function recordSent({ source, sourceId, atMs, group, md5 } = {}) {
    assertWritable('记发群次数');
    const { identity } = findRow({ source, sourceId });
    const at = Number.isFinite(Number(atMs)) ? Math.trunc(Number(atMs)) : Math.trunc(clock());
    let recorded = false;
    if (identity) {
      stmts.recordSent.run(at, identity.id);
      recorded = true;
    }
    const groupKey = String(group ?? '').trim();
    if (groupKey) {
      const cleanMd5 = normalizeMd5(md5);
      const src = String(source ?? '').trim();
      const sid = String(sourceId ?? '').trim();
      if (cleanMd5) {
        stmts.seenInsert.run(groupKey, cleanMd5, src, sid, at, Math.trunc(clock()));
      } else if (src && sid) {
        // 帖子没给 md5:退回按 (source,id) 记(部分唯一索引 WHERE md5='' 兜住)。
        stmts.seenInsert.run(groupKey, '', src, sid, at, Math.trunc(clock()));
      }
    }
    return recorded;
  }

  /**
   * 这个群**已经看过**哪些图(抓取器 `--group` 的排除集)。
   * `md5s` = 有 md5 的账(按内容身份);`ids` = **全部**账的 `source:source_id`
   * (md5 缺失的帖子按它排除;同一帖子在图源换过内容时也按 id 挡,宁严勿重)。
   * @param {string} group
   * @returns {{md5s: Set<string>, ids: Set<string>}}
   */
  function seenForGroup(group) {
    const groupKey = String(group ?? '').trim();
    const md5s = new Set();
    const ids = new Set();
    if (!groupKey) return { md5s, ids };
    for (const row of stmts.seenSelect.all(groupKey)) {
      if (row.md5) md5s.add(String(row.md5));
      ids.add(`${row.source}:${row.source_id}`);
    }
    return { md5s, ids };
  }

  /** QQ 侧被拦过一次(`blocked` 列只写不读,站长视图未拍板)。 */
  function recordBlocked({ source, sourceId } = {}) {
    assertWritable('记被拦次数');
    const { identity } = findRow({ source, sourceId });
    if (!identity) return false;
    stmts.recordBlocked.run(identity.id);
    return true;
  }

  /**
   * 列表查询:权限钳制 + 窗口 + 角色筛选 + 排序 + 分页。
   *
   * @param {{rank?: string, atMs?: number, tier?: string, withq?: boolean|number|string,
   *          character?: string, page?: number, pageSize?: number}} [params]
   */
  function queryList(params = {}) {
    const rank = normalizeRank(params?.rank);
    const atMs = Number.isFinite(Number(params?.atMs)) ? Number(params.atMs) : Number(clock());
    const visibility = visibilityWhere({ tier: params?.tier, withq: params?.withq });
    const window = beijingWindow(rank, atMs);
    const pageSize = Number.isSafeInteger(Number(params?.pageSize)) && Number(params.pageSize) > 0
      ? Math.min(Number(params.pageSize), 200)
      : DEFAULT_PAGE_SIZE;
    const page = Number.isSafeInteger(Number(params?.page)) && Number(params.page) >= 1
      ? Number(params.page)
      : 1;

    const where = [visibility.sql];
    const args = [...visibility.params];
    if (window.startMs !== null) {
      where.push('fetched_at >= ? AND fetched_at < ?');
      args.push(window.startMs, window.endMs);
    }
    const character = String(params?.character ?? '').trim();
    if (character) {
      // characters 存 JSON 数组;JSON1 在 node:sqlite 里现成(selftest 第一条就验它可用)。
      where.push('EXISTS (SELECT 1 FROM json_each(meitu_meta.characters) WHERE value = ?)');
      args.push(character);
    }
    const whereSql = where.join(' AND ');

    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM meitu_meta WHERE ${whereSql}`).get(...args);
    const total = Number(totalRow?.n ?? 0);
    const rows = db.prepare(
      `SELECT * FROM meitu_meta WHERE ${whereSql} ORDER BY ${orderBySql(rank)} LIMIT ? OFFSET ?`,
    ).all(...args, pageSize, (page - 1) * pageSize);
    return {
      rank,
      window,
      atMs,
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      items: rows.map(rowToItem),
    };
  }

  /** 详情:同一个权限闸 + id 形状闸(纯数字;`SELECT *` 用参数绑定,不拼串)。 */
  function queryItem({ id, tier, withq } = {}) {
    const numeric = Number(String(id ?? '').trim());
    if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
    const visibility = visibilityWhere({ tier, withq });
    const row = db.prepare(`SELECT * FROM meitu_meta WHERE id = ? AND ${visibility.sql}`)
      .get(numeric, ...visibility.params);
    return row ? rowToItem(row) : null;
  }

  /** 角色 chips 聚合(node:sqlite 自带 JSON1;不可用时会抛 —— 有单测钉着)。 */
  function facets({ tier, withq, limit = 30 } = {}) {
    const visibility = visibilityWhere({ tier, withq });
    const max = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 30;
    const rows = db.prepare(`SELECT value AS tag, COUNT(*) AS count
      FROM meitu_meta, json_each(meitu_meta.characters)
      WHERE ${visibility.sql}
      GROUP BY value
      ORDER BY count DESC, tag ASC
      LIMIT ?`).all(...visibility.params, max);
    return rows.map((row) => ({ tag: String(row.tag), count: Number(row.count) }));
  }

  /** 总览计数(pill 里的「在展 N 张」):按档位钳制后的 total + rating 分布。 */
  function counts({ tier, withq } = {}) {
    const visibility = visibilityWhere({ tier, withq });
    const rows = db.prepare(`SELECT rating, COUNT(*) AS n FROM meitu_meta
      WHERE ${visibility.sql} GROUP BY rating ORDER BY rating`).all(...visibility.params);
    const byRating = {};
    for (const row of rows) byRating[String(row.rating)] = Number(row.n);
    return {
      total: rows.reduce((sum, row) => sum + Number(row.n), 0),
      byRating,
    };
  }

  /**
   * 全库 rating 分布(回填报告用;**不**按权限钳制 —— 报告要说真话)。
   * 含 `''`(没回填到)与 `blacklisted` 的计数。
   */
  function ratingDistribution() {
    const rows = db.prepare('SELECT rating, COUNT(*) AS n FROM meitu_meta GROUP BY rating ORDER BY rating').all();
    const byRating = {};
    for (const row of rows) byRating[String(row.rating)] = Number(row.n);
    const blacklisted = Number(db.prepare('SELECT COUNT(*) AS n FROM meitu_meta WHERE blacklisted = 1').get()?.n ?? 0);
    return { total: Number(stmts.countAll.get()?.n ?? 0), byRating, blacklisted };
  }

  /**
   * 黑名单重扫(**不碰网**):把库里每一行的 tags 再过一遍 `isBlockedPost`,
   * 命中的 `blacklisted=1`、不再命中的归 0。
   *
   * 为什么要有它:黑名单清单只增不减(要主人点头),但 `blacklisted` 列是**回填时刻的快照** ——
   * 改了清单不重扫,旧行就不会变。判据(元判据要真咬):塞命中词 → 重扫 → API 立刻查不到。
   * 扫描对象 = general_tags + characters + copyright(整张图的标签;fail-closed 宁可多拦)。
   * @returns {{scanned: number, blocked: number, changed: number}}
   */
  function rescanBlacklist() {
    assertWritable('重扫黑名单');
    const rows = db.prepare('SELECT id, characters, copyright, general_tags, blacklisted FROM meitu_meta').all();
    const update = db.prepare('UPDATE meitu_meta SET blacklisted = ? WHERE id = ?');
    let blocked = 0;
    let changed = 0;
    for (const row of rows) {
      const tags = [
        ...parseJsonArray(row.characters),
        ...parseJsonArray(row.general_tags),
        String(row.copyright ?? ''),
      ].join(' ').trim();
      // 没标签的行走 `rating=''` 的 fail-closed(还没回填,任何档本来就不可见);
      // 这里不替它贴黑名单 —— 否则回填失败的行会被误标成"疑似未成年",报告也会说谎。
      if (!tags) continue;
      const hit = isBlockedPost({ tags });
      if (hit) blocked += 1;
      if (Number(row.blacklisted ?? 0) !== (hit ? 1 : 0)) {
        update.run(hit ? 1 : 0, row.id);
        changed += 1;
      }
    }
    return { scanned: rows.length, blocked, changed };
  }

  return {
    db,
    dbPath: target,
    readOnly: !writable,
    upsertFile,
    applySourceMeta,
    upsertFromFetch,
    getMeta,
    findByMd5,
    knownMd5s,
    recordSent,
    recordBlocked,
    seenForGroup,
    queryList,
    queryItem,
    facets,
    counts,
    ratingDistribution,
    rescanBlacklist,
    close() {
      try {
        db.close();
      } catch {
        // 已经关了/进程退出中:关不掉不影响结果。
      }
    },
  };
}
