/**
 * 通用本地目录收藏的 **SQLite 数据层**（2026-11-17）。
 *
 * 这个文件只做"条目 / 收藏 / 收藏夹 / 最近清单"的持久化与查询，不知道任何 bot 角色、
 * 群号、QQ 消息形状或 JM 边车。JM 搬本只是它的第一个接入者（见 `src/jm-service.js`）。
 *
 * 设计口径（与任务书一致）：
 *   · 独立数据库文件，**不与聊天/记忆库混用**；表名按通用目录语义命名。
 *   · `PRAGMA user_version` 管 schema 版本；`CREATE TABLE IF NOT EXISTS` + 迁移函数都幂等。
 *   · 打开时 `foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=3000`。
 *   · 唯一键只用非空字段：
 *       条目  = (source, entity_type, source_id)
 *       收藏  = (library_id, item_id)
 *       成员  = (collection_id, favorite_id)
 *   · 重复收藏用明确目标的 `ON CONFLICT ... DO NOTHING`，不用 `INSERT OR REPLACE`
 *     （REPLACE 会先删旧行，可能连带断掉收藏夹成员/用户标签）。
 *   · 所有用户值走参数绑定；SQL 里只拼接本文件写死的列名/条件。
 *   · 条目入库 + 收藏 + 默认收藏夹成员关系在**同一个短事务**里。
 *   · 元数据刷新只改标题/来源标签/页数等来源字段；用户标签、备注、首次收藏时间分表存。
 *
 * 未知 ≠ 空：
 *   `creators_known` / `roles_known` / `tags_known` 明确记录"这次元数据到底有没有拿到
 *   作者名 / 角色（原作/角色）/ 来源标签"。0 = 未知（不要显示成"没有"），1 = 已取得
 *   （空列表才是真的"无"）。展示与筛选都必须看旗标，不能只 `creators.length === 0`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 当前 schema 版本；写进 `PRAGMA user_version` 与 `meta.schema_version`。 */
export const CATALOG_SCHEMA_VERSION = 1;

/** 默认收藏夹名（第一版只有一个收藏夹；表结构允许将来多个）。 */
export const DEFAULT_COLLECTION_NAME = '默认收藏夹';

/** 没注入 log 时的静默实现（纯数据层测试可以完全不传）。 */
const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

/** 允许的创作者角色；未知角色归入 other，避免把站点脏数据当筛选条件。 */
export const CREATOR_ROLES = Object.freeze(['author', 'artist', 'original', 'character', 'other']);

/** 允许的排序键；排序只影响列表展示，不改变收藏事实。 */
const SORT_SQL = Object.freeze({
  recent: 'f.favorited_at DESC, f.id DESC',
  title: "COALESCE(i.title, '') COLLATE NOCASE ASC, f.id DESC",
  source_id: 'i.source_id ASC, f.id DESC',
});

/** 允许的条件字段；出现别的键一律报"不支持"，绝不静默丢掉。 */
const FILTER_FIELDS = Object.freeze({
  creator: { roles: ['author', 'artist'], knownColumn: 'creators_known' },
  original: { roles: ['original'], knownColumn: 'roles_known' },
  character: { roles: ['character'], knownColumn: 'roles_known' },
  tag: { roles: null, knownColumn: 'tags_known' },
});

/** 查询/命令层共用：把展示值归一成可比较的键（NFKC、小写、去空白与标点符号）。 */
export function normalizeCatalogText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

/** 标题/作者/标签的硬长度闸（防脏数据撑爆消息；数值不是业务策略，只是输入边界）。 */
const LIMITS = Object.freeze({
  source: 32,
  entityType: 32,
  sourceId: 64,
  title: 300,
  creator: 120,
  tag: 80,
  note: 500,
  actor: 128,
});

/** 查询层错误：调用方据此回固定话术，而不是把内部 SQL 错误暴露给群。 */
export class CatalogQueryError extends Error {
  constructor(reason, detail = '') {
    super(detail || reason);
    this.name = 'CatalogQueryError';
    this.reason = reason;
  }
}

/** schema 版本/迁移错误：**不许**当成坏库改名重建（那会丢掉更新的数据）。 */
export class CatalogSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogSchemaError';
  }
}

const assertText = (value, field, max) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogQueryError('invalid', `${field} 不能为空`);
  }
  const text = value.trim();
  if (Array.from(text).length > max) throw new CatalogQueryError('invalid', `${field} 太长`);
  return text;
};

const asIntOrNull = (value, min = 0) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) return null;
  return number;
};

/** 把 `[{name,role,seq}]`、`['名字']` 或 `'名字'` 统一成创作者数组。 */
function normalizeCreators(raw) {
  const list = Array.isArray(raw) ? raw : (raw === null || raw === undefined ? [] : [raw]);
  const out = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || name.trim() === '') continue;
    const roleRaw = typeof entry === 'object' && entry ? String(entry.role ?? 'author').toLowerCase() : 'author';
    const role = CREATOR_ROLES.includes(roleRaw) ? roleRaw : 'other';
    const seq = Number.isSafeInteger(Number(entry?.seq)) ? Number(entry.seq) : out.length;
    out.push({
      name: name.normalize('NFKC').trim().slice(0, LIMITS.creator),
      role,
      seq,
    });
  }
  return out;
}

/** 把 `['全彩']`、`[{name:'全彩'}]` 或 `'全彩'` 统一成去重后的标签名数组。 */
function normalizeTagNames(raw) {
  const list = Array.isArray(raw) ? raw : (raw === null || raw === undefined ? [] : [raw]);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || name.trim() === '') continue;
    const text = name.normalize('NFKC').trim().slice(0, LIMITS.tag);
    const key = normalizeCatalogText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function normalizeAliases(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const type = String(entry?.type ?? entry?.kind ?? '').trim().toLowerCase();
    const id = String(entry?.id ?? entry?.aliasId ?? '').trim();
    if (!/^[a-z0-9_-]{1,32}$/u.test(type)) continue;
    if (!id || Array.from(id).length > LIMITS.sourceId) continue;
    const key = `${type}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
  }
  return out;
}

/** 把标签/作者查询条件里的值归一；空值直接拒绝（"写了条件"必须真的应用）。 */
function normalizeFilterValues(values, field) {
  const list = Array.isArray(values) ? values : (values === undefined ? [] : [values]);
  const out = [];
  for (const value of list) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new CatalogQueryError('invalid', `${field} 条件不能为空`);
    }
    const text = value.normalize('NFKC').trim().slice(0, LIMITS.tag);
    if (normalizeCatalogText(text) === '') {
      throw new CatalogQueryError('invalid', `${field} 条件没有可比较的文字`);
    }
    out.push(text);
  }
  return out;
}

/** 标题里的 LIKE 元字符要转义，否则用户输入 `%` 会扩大结果（静默改变条件）。 */
function escapeLike(text) {
  return String(text).replace(/[\\%_]/gu, (char) => `\\${char}`);
}

/**
 * 打开数据库。文件损坏时挪到一边重开（与 `src/sqlite-store.js` 同一口径）：
 * 收藏库坏了不应该让 bot 起不来；但必须留日志，不能静默丢数据。
 */
function openWithSchema(file, log) {
  const apply = (db) => {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, log);
    return db;
  };

  let handle = null;
  try {
    handle = new DatabaseSync(file);
    return apply(handle);
  } catch (err) {
    if (file === ':memory:') throw err;
    try {
      handle?.close();
    } catch {
      /* 关不掉也继续判断 */
    }
    // 新版本库 / 迁移错误不能当成"坏文件"改名重建：那会把更新版本的数据挪走，
    // 甚至悄悄建一个空库。只有明确的"不是数据库/文件损坏"才走隔离重建。
    if (err?.name === 'CatalogSchemaError') throw err;
    const corrupt = /not a database|malformed|file is encrypted|database disk image is malformed/iu
      .test(String(err?.message ?? err));
    if (!corrupt) throw err;
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      log.warn(`目录收藏库损坏，已改名为 ${backup} 后重建：${err?.message ?? err}`);
    } catch (renameErr) {
      log.warn(`目录收藏库损坏且无法改名（${renameErr?.message ?? renameErr}），尝试直接重建：${err?.message ?? err}`);
    }
    return apply(new DatabaseSync(file));
  }
}

/**
 * 建表 + 幂等迁移。
 *
 * 第一版只有 v1；后续加版本时在 schema 之后按 `user_version` 追加幂等迁移步骤，
 * 每次只从旧版本往后跑，重复执行无副作用。
 */
function migrate(db, log) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (current > CATALOG_SCHEMA_VERSION) {
    throw new CatalogSchemaError(
      `目录收藏库 schema 版本 ${current} 高于本程序支持的 ${CATALOG_SCHEMA_VERSION}，拒绝降级打开`,
    );
  }

  // v0 → v1：建全部表。`IF NOT EXISTS` 使"文件已有表但 user_version 丢了"也能恢复。
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,
      owner_id   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(kind, owner_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_item (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source              TEXT NOT NULL,
      entity_type         TEXT NOT NULL,
      source_id           TEXT NOT NULL,
      title               TEXT,
      title_norm          TEXT,
      page_count          INTEGER,
      unit_count          INTEGER,
      metadata_fetched_at INTEGER,
      metadata_status     TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (metadata_status IN ('unknown', 'partial', 'complete')),
      creators_known      INTEGER NOT NULL DEFAULT 0 CHECK (creators_known IN (0, 1)),
      -- 创作者名字拿到了（creators_known）不等于知道每个人的角色（原作/角色可能未知）。
      roles_known         INTEGER NOT NULL DEFAULT 0 CHECK (roles_known IN (0, 1)),
      tags_known          INTEGER NOT NULL DEFAULT 0 CHECK (tags_known IN (0, 1)),
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      UNIQUE(source, entity_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_item_source ON catalog_item(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_item_title ON catalog_item(title_norm);

    CREATE TABLE IF NOT EXISTS creator (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      UNIQUE(name)
    );
    CREATE INDEX IF NOT EXISTS idx_creator_name_norm ON creator(name_norm);

    CREATE TABLE IF NOT EXISTS item_creator (
      item_id    INTEGER NOT NULL REFERENCES catalog_item(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'author',
      seq        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, creator_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_item_creator_creator ON item_creator(creator_id);

    CREATE TABLE IF NOT EXISTS tag (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      source    TEXT NOT NULL,
      name      TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      UNIQUE(source, name)
    );
    CREATE INDEX IF NOT EXISTS idx_tag_name_norm ON tag(name_norm);

    CREATE TABLE IF NOT EXISTS item_tag (
      item_id INTEGER NOT NULL REFERENCES catalog_item(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_tag_tag ON item_tag(tag_id);

    CREATE TABLE IF NOT EXISTS item_alias (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL REFERENCES catalog_item(id) ON DELETE CASCADE,
      source     TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      alias_id   TEXT NOT NULL,
      UNIQUE(source, alias_type, alias_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_alias_item ON item_alias(item_id);

    CREATE TABLE IF NOT EXISTS favorite (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id   INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
      item_id      INTEGER NOT NULL REFERENCES catalog_item(id) ON DELETE CASCADE,
      favorited_at INTEGER NOT NULL,
      actor_id     TEXT,
      note         TEXT,
      UNIQUE(library_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_favorite_library_time ON favorite(library_id, favorited_at DESC);

    -- 用户自定义标签：归属**收藏关系**，不与来源标签（tag/item_tag）混表。
    CREATE TABLE IF NOT EXISTS favorite_tag (
      favorite_id INTEGER NOT NULL REFERENCES favorite(id) ON DELETE CASCADE,
      tag         TEXT NOT NULL,
      tag_norm    TEXT NOT NULL,
      PRIMARY KEY (favorite_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_favorite_tag_norm ON favorite_tag(tag_norm);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_favorite_tag_unique ON favorite_tag(favorite_id, tag_norm);

    CREATE TABLE IF NOT EXISTS collection (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      UNIQUE(library_id, name)
    );

    CREATE TABLE IF NOT EXISTS collection_member (
      collection_id INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
      favorite_id   INTEGER NOT NULL REFERENCES favorite(id) ON DELETE CASCADE,
      added_at      INTEGER NOT NULL,
      PRIMARY KEY (collection_id, favorite_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collection_member_favorite ON collection_member(favorite_id);

    -- 最近一次清单：与永久收藏分开，按 (库, 作用域类型, 作用域 id) 隔离。
    -- scope_kind 由调用方定（例如 group_user）；库里不猜、不跨群/跨人复用。
    CREATE TABLE IF NOT EXISTS last_list (
      library_id   INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
      scope_kind   TEXT NOT NULL,
      scope_id     TEXT NOT NULL,
      query_json   TEXT NOT NULL,
      item_ids_json TEXT NOT NULL,
      page         INTEGER NOT NULL DEFAULT 1,
      total        INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (library_id, scope_kind, scope_id)
    );
  `);

  // v1 开发期补列：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列。
  // 重复执行无副作用；老行 roles_known=0 按"角色未知"读，不会冒充"确认没有原作"。
  const columns = db.prepare('PRAGMA table_info(catalog_item)').all().map((row) => row.name);
  if (!columns.includes('roles_known')) {
    db.exec('ALTER TABLE catalog_item ADD COLUMN roles_known INTEGER NOT NULL DEFAULT 0');
    log.info('目录收藏库迁移：catalog_item 补上 roles_known（老行 = 角色未知）');
  }

  db.prepare(`INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(String(CATALOG_SCHEMA_VERSION), Date.now());
  db.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
  if (current !== CATALOG_SCHEMA_VERSION) {
    log.info(`目录收藏库 schema：${current} → ${CATALOG_SCHEMA_VERSION}`);
  }
}

export class CatalogStore {
  #db;
  #libraryId;
  #now;
  #revision = 0;

  /**
   * @param {string} file 独立数据库文件；`:memory:` 可用于测试
   * @param {{library?: {kind?: string, ownerId?: string}, now?: Function, log?: object}} [options]
   */
  constructor(file, { library = {}, now = Date.now, log = SILENT_LOG } = {}) {
    if (typeof file !== 'string' || file.trim() === '') throw new Error('目录收藏库路径不能为空');
    this.#now = typeof now === 'function' ? now : Date.now;
    if (file !== ':memory:') {
      const dir = path.dirname(path.resolve(file));
      fs.mkdirSync(dir, { recursive: true });
    }
    this.#db = openWithSchema(file, log);

    const kind = String(library.kind ?? 'instance').trim() || 'instance';
    const ownerId = String(library.ownerId ?? 'local').trim() || 'local';
    this.#libraryId = this.#ensureLibrary(kind, ownerId);
  }

  get libraryId() {
    return this.#libraryId;
  }

  /** 每次写操作 +1；查询缓存用它做失效键（缓存失效不影响已经落库的收藏）。 */
  get revision() {
    return this.#revision;
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* 已经关了 */
    }
  }

  /** 只读句柄，给排查/测试用；正常业务走方法。 */
  get handle() {
    return this.#db;
  }

  #ensureLibrary(kind, ownerId) {
    const found = this.#db.prepare('SELECT id FROM library WHERE kind = ? AND owner_id = ?').get(kind, ownerId);
    if (found) return Number(found.id);
    this.#db.prepare(`INSERT INTO library (kind, owner_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT(kind, owner_id) DO NOTHING`).run(kind, ownerId, this.#now());
    const row = this.#db.prepare('SELECT id FROM library WHERE kind = ? AND owner_id = ?').get(kind, ownerId);
    return Number(row.id);
  }

  /** 一个短事务；失败回滚。所有写路径都经过它，避免"条目进了、收藏没进"的半截状态。 */
  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      this.#revision += 1;
      return result;
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* 回滚失败让原错误冒出去 */
      }
      throw err;
    }
  }

  #itemRowToItem(row, { withRelations = true } = {}) {
    if (!row) return null;
    const item = {
      id: Number(row.id),
      source: row.source,
      entityType: row.entity_type,
      sourceId: row.source_id,
      title: row.title ?? null,
      titleNorm: row.title_norm ?? null,
      pageCount: row.page_count ?? null,
      unitCount: row.unit_count ?? null,
      metadataFetchedAt: row.metadata_fetched_at ?? null,
      metadataStatus: row.metadata_status ?? 'unknown',
      creatorsKnown: row.creators_known === 1,
      rolesKnown: row.roles_known === 1,
      tagsKnown: row.tags_known === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (withRelations) {
      item.creators = this.#db.prepare(`
        SELECT c.name AS name, ic.role AS role, ic.seq AS seq
        FROM item_creator ic JOIN creator c ON c.id = ic.creator_id
        WHERE ic.item_id = ?
        ORDER BY ic.seq ASC, c.name ASC
      `).all(item.id).map((entry) => ({ name: entry.name, role: entry.role, seq: entry.seq }));
      item.tags = this.#db.prepare(`
        SELECT t.name AS name FROM item_tag it JOIN tag t ON t.id = it.tag_id
        WHERE it.item_id = ? ORDER BY t.name ASC
      `).all(item.id).map((entry) => entry.name);
      item.aliases = this.#db.prepare(`
        SELECT alias_type AS type, alias_id AS id FROM item_alias WHERE item_id = ?
      `).all(item.id).map((entry) => ({ type: entry.type, id: entry.id }));
      const favorite = this.#db.prepare(`
        SELECT id, favorited_at, actor_id, note FROM favorite WHERE library_id = ? AND item_id = ?
      `).get(this.#libraryId, item.id);
      item.favorite = favorite ? {
        id: Number(favorite.id),
        favoritedAt: favorite.favorited_at,
        actorId: favorite.actor_id ?? null,
        note: favorite.note ?? null,
        userTags: this.#db.prepare('SELECT tag FROM favorite_tag WHERE favorite_id = ? ORDER BY tag ASC')
          .all(favorite.id).map((entry) => entry.tag),
      } : null;
      if (!favorite) item.userTags = [];
      else item.userTags = item.favorite.userTags;
    }
    return item;
  }

  #findItemRow({ source, entityType, sourceId }) {
    return this.#db.prepare(`
      SELECT * FROM catalog_item WHERE source = ? AND entity_type = ? AND source_id = ?
    `).get(
      assertText(source, 'source', LIMITS.source),
      assertText(entityType, 'entityType', LIMITS.entityType),
      assertText(sourceId, 'sourceId', LIMITS.sourceId),
    );
  }

  /**
   * 按稳定来源键找条目（含创作者/标签/收藏关系）。
   * 返回 null = 本地没有；不是"没有作者"。
   */
  findItem({ source, entityType, sourceId }) {
    const row = this.#findItemRow({ source, entityType, sourceId });
    return row ? this.#itemRowToItem(row) : null;
  }

  getItem(itemId) {
    const id = asIntOrNull(itemId, 1);
    if (!id) return null;
    const row = this.#db.prepare('SELECT * FROM catalog_item WHERE id = ?').get(id);
    return row ? this.#itemRowToItem(row) : null;
  }

  /** 按别名找父条目（例如 JM 单元编号 → 所属作品）。 */
  findItemByAlias({ source, aliasType, aliasId }) {
    const row = this.#db.prepare(`
      SELECT i.* FROM item_alias a JOIN catalog_item i ON i.id = a.item_id
      WHERE a.source = ? AND a.alias_type = ? AND a.alias_id = ?
    `).get(
      assertText(source, 'source', LIMITS.source),
      assertText(aliasType, 'aliasType', LIMITS.entityType),
      assertText(aliasId, 'aliasId', LIMITS.sourceId),
    );
    return row ? this.#itemRowToItem(row) : null;
  }

  /**
   * 条目入库/刷新（单事务）。只更新来源元数据；用户标签、备注、收藏时间在别的表，
   * 这段 SQL **一个字段都不碰**。
   *
   * `creatorsKnown=false` / `tagsKnown=false` 时不动已有的作者/标签行 ——
   * "这次没拿到"不等于"确认没有"。
   */
  upsertItem(item) {
    if (!item || typeof item !== 'object') throw new CatalogQueryError('invalid', '条目不能为空');
    return this.#tx(() => this.#saveItemRow(item));
  }

  #saveItemRow(item) {
    const now = Number.isFinite(Number(item.metadataFetchedAt)) ? Number(item.metadataFetchedAt) : this.#now();
    const source = assertText(String(item.source ?? ''), 'source', LIMITS.source);
    const entityType = assertText(String(item.entityType ?? ''), 'entityType', LIMITS.entityType);
    const sourceId = assertText(String(item.sourceId ?? ''), 'sourceId', LIMITS.sourceId);
    const title = typeof item.title === 'string' && item.title.trim() !== ''
      ? item.title.normalize('NFKC').trim().slice(0, LIMITS.title)
      : null;
    const titleNorm = title ? normalizeCatalogText(title) : null;
    const pageCount = asIntOrNull(item.pageCount, 0);
    const unitCount = asIntOrNull(item.unitCount, 0);
    const creatorsKnown = item.creatorsKnown === true ? 1 : 0;
    // 没显式给 rolesKnown 时，按"创作者列表已知 = 角色也已知"的旧口径；
    // JM 适配器会显式传 false（站点只给作者名，不保证角色）。
    const rolesKnown = item.rolesKnown === true ? 1
      : (item.rolesKnown === false ? 0 : creatorsKnown);
    const tagsKnown = item.tagsKnown === true ? 1 : 0;
    const statusRaw = String(item.metadataStatus ?? '').toLowerCase();
    const metadataStatus = ['unknown', 'partial', 'complete'].includes(statusRaw)
      ? statusRaw
      : (creatorsKnown && tagsKnown ? 'complete' : (creatorsKnown || tagsKnown ? 'partial' : 'unknown'));

    this.#db.prepare(`
      INSERT INTO catalog_item
        (source, entity_type, source_id, title, title_norm, page_count, unit_count,
         metadata_fetched_at, metadata_status, creators_known, roles_known, tags_known, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, entity_type, source_id) DO UPDATE SET
        title = COALESCE(excluded.title, catalog_item.title),
        title_norm = COALESCE(excluded.title_norm, catalog_item.title_norm),
        page_count = COALESCE(excluded.page_count, catalog_item.page_count),
        unit_count = COALESCE(excluded.unit_count, catalog_item.unit_count),
        metadata_fetched_at = COALESCE(excluded.metadata_fetched_at, catalog_item.metadata_fetched_at),
        metadata_status = CASE
          WHEN excluded.metadata_status = 'unknown' THEN catalog_item.metadata_status
          WHEN catalog_item.metadata_status = 'complete' THEN catalog_item.metadata_status
          ELSE excluded.metadata_status END,
        creators_known = MAX(catalog_item.creators_known, excluded.creators_known),
        roles_known = MAX(catalog_item.roles_known, excluded.roles_known),
        tags_known = MAX(catalog_item.tags_known, excluded.tags_known),
        updated_at = excluded.updated_at
    `).run(
      source, entityType, sourceId, title, titleNorm, pageCount, unitCount,
      Number.isFinite(now) ? now : this.#now(), metadataStatus,
      creatorsKnown, rolesKnown, tagsKnown, this.#now(), this.#now(),
    );

    const row = this.#db.prepare(`
      SELECT * FROM catalog_item WHERE source = ? AND entity_type = ? AND source_id = ?
    `).get(source, entityType, sourceId);
    const itemId = Number(row.id);

    // 作者：只有明确知道时才替换；未知时保留旧数据。
    if (creatorsKnown) {
      this.#db.prepare('DELETE FROM item_creator WHERE item_id = ?').run(itemId);
      const creators = normalizeCreators(item.creators ?? item.authors ?? []);
      for (const creator of creators) {
        this.#db.prepare(`INSERT INTO creator (name, name_norm) VALUES (?, ?)
          ON CONFLICT(name) DO NOTHING`).run(creator.name, normalizeCatalogText(creator.name));
        const found = this.#db.prepare('SELECT id FROM creator WHERE name = ?').get(creator.name);
        this.#db.prepare(`INSERT INTO item_creator (item_id, creator_id, role, seq) VALUES (?, ?, ?, ?)
          ON CONFLICT(item_id, creator_id, role) DO NOTHING`).run(itemId, found.id, creator.role, creator.seq);
      }
    }

    // 来源标签：同上；用户标签在 favorite_tag，不在这里。
    if (tagsKnown) {
      this.#db.prepare('DELETE FROM item_tag WHERE item_id = ?').run(itemId);
      const tags = normalizeTagNames(item.tags ?? item.sourceTags ?? []);
      for (const tag of tags) {
        this.#db.prepare(`INSERT INTO tag (source, name, name_norm) VALUES (?, ?, ?)
          ON CONFLICT(source, name) DO NOTHING`).run(source, tag, normalizeCatalogText(tag));
        const found = this.#db.prepare('SELECT id FROM tag WHERE source = ? AND name = ?').get(source, tag);
        this.#db.prepare(`INSERT INTO item_tag (item_id, tag_id) VALUES (?, ?)
          ON CONFLICT(item_id, tag_id) DO NOTHING`).run(itemId, found.id);
      }
    }

    // 别名（单元编号 → 父条目）：已存在指向别的条目时 DO NOTHING，不静默改写。
    for (const alias of normalizeAliases(item.aliases ?? [])) {
      this.#db.prepare(`
        INSERT INTO item_alias (item_id, source, alias_type, alias_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(source, alias_type, alias_id) DO NOTHING
      `).run(itemId, source, alias.type, alias.id);
    }

    return this.#itemRowToItem(row);
  }

  /** 元数据刷新入口：语义与 upsertItem 相同，但名字强调"只动来源字段"。 */
  refreshItemMetadata(item) {
    return this.upsertItem(item);
  }

  /** 收藏（幂等）。条目入库、收藏、默认收藏夹成员关系在同一个短事务内。 */
  addFavorite({ item, tags = [], actorId = null, note = null, collectionName = DEFAULT_COLLECTION_NAME } = {}) {
    if (!item) throw new CatalogQueryError('invalid', '缺少条目');
    const userTags = normalizeTagNames(tags);
    const actor = actorId === null || actorId === undefined ? null : String(actorId).slice(0, LIMITS.actor);
    const trimmedNote = typeof note === 'string' && note.trim() !== ''
      ? note.normalize('NFKC').trim().slice(0, LIMITS.note)
      : null;
    const name = assertText(String(collectionName || DEFAULT_COLLECTION_NAME), 'collectionName', LIMITS.tag);

    return this.#tx(() => {
      const saved = this.#saveItemRow(item);
      const itemId = saved.id;
      const insert = this.#db.prepare(`
        INSERT INTO favorite (library_id, item_id, favorited_at, actor_id, note)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(library_id, item_id) DO NOTHING
      `).run(this.#libraryId, itemId, this.#now(), actor, trimmedNote);
      const favorite = this.#db.prepare(`
        SELECT id, favorited_at, actor_id, note FROM favorite WHERE library_id = ? AND item_id = ?
      `).get(this.#libraryId, itemId);

      const collection = this.#ensureCollectionRow(name, true);
      this.#db.prepare(`
        INSERT INTO collection_member (collection_id, favorite_id, added_at) VALUES (?, ?, ?)
        ON CONFLICT(collection_id, favorite_id) DO NOTHING
      `).run(collection.id, favorite.id, this.#now());

      for (const tag of userTags) {
        this.#db.prepare(`INSERT INTO favorite_tag (favorite_id, tag, tag_norm) VALUES (?, ?, ?)
          ON CONFLICT(favorite_id, tag_norm) DO NOTHING`).run(favorite.id, tag, normalizeCatalogText(tag));
      }

      return {
        itemId,
        favoriteId: Number(favorite.id),
        collectionId: Number(collection.id),
        created: Number(insert.changes) > 0,
        favoritedAt: favorite.favorited_at,
        item: this.#itemRowToItem(this.#db.prepare('SELECT * FROM catalog_item WHERE id = ?').get(itemId)),
      };
    });
  }

  /** 取消收藏：只删收藏关系（连带成员/用户标签），**不删条目、不碰任何文件**。 */
  removeFavorite({ source, entityType, sourceId }) {
    const row = this.#findItemRow({ source, entityType, sourceId });
    if (!row) return { removed: false, item: null };
    const item = this.#itemRowToItem(row);
    const favorite = this.#db.prepare(
      'SELECT id FROM favorite WHERE library_id = ? AND item_id = ?',
    ).get(this.#libraryId, item.id);
    if (!favorite) return { removed: false, item };
    return this.#tx(() => {
      this.#db.prepare('DELETE FROM favorite WHERE id = ?').run(favorite.id);
      return { removed: true, item };
    });
  }

  /** 加用户标签（归属收藏关系；不碰来源标签）。 */
  addFavoriteTags({ favoriteId, tags = [] }) {
    const id = asIntOrNull(favoriteId, 1);
    if (!id) throw new CatalogQueryError('invalid', 'favoriteId 不合法');
    const owner = this.#db.prepare('SELECT id FROM favorite WHERE id = ? AND library_id = ?')
      .get(id, this.#libraryId);
    if (!owner) throw new CatalogQueryError('not_found', '没有这条收藏');
    const list = normalizeTagNames(tags);
    return this.#tx(() => {
      for (const tag of list) {
        this.#db.prepare(`INSERT INTO favorite_tag (favorite_id, tag, tag_norm) VALUES (?, ?, ?)
          ON CONFLICT(favorite_id, tag_norm) DO NOTHING`).run(id, tag, normalizeCatalogText(tag));
      }
      return this.#db.prepare('SELECT tag FROM favorite_tag WHERE favorite_id = ? ORDER BY tag ASC')
        .all(id).map((entry) => entry.tag);
    });
  }

  #ensureCollectionRow(name, isDefault) {
    this.#db.prepare(`
      INSERT INTO collection (library_id, name, created_at, is_default) VALUES (?, ?, ?, ?)
      ON CONFLICT(library_id, name) DO NOTHING
    `).run(this.#libraryId, name, this.#now(), isDefault ? 1 : 0);
    return this.#db.prepare('SELECT id, name FROM collection WHERE library_id = ? AND name = ?')
      .get(this.#libraryId, name);
  }

  ensureCollection(name) {
    const text = assertText(String(name ?? ''), 'collectionName', LIMITS.tag);
    return this.#tx(() => {
      const row = this.#ensureCollectionRow(text, false);
      return { id: Number(row.id), name: row.name };
    });
  }

  /** 同一收藏进多个收藏夹：只加成员关系，不复制条目。 */
  addToCollection({ favoriteId, collectionId }) {
    const fid = asIntOrNull(favoriteId, 1);
    const cid = asIntOrNull(collectionId, 1);
    if (!fid || !cid) throw new CatalogQueryError('invalid', '收藏夹/收藏 id 不合法');
    const favorite = this.#db.prepare('SELECT id FROM favorite WHERE id = ? AND library_id = ?')
      .get(fid, this.#libraryId);
    if (!favorite) throw new CatalogQueryError('not_found', '没有这条收藏');
    const collection = this.#db.prepare('SELECT id FROM collection WHERE id = ? AND library_id = ?')
      .get(cid, this.#libraryId);
    if (!collection) throw new CatalogQueryError('not_found', '没有这个收藏夹');
    return this.#tx(() => {
      const result = this.#db.prepare(`
        INSERT INTO collection_member (collection_id, favorite_id, added_at) VALUES (?, ?, ?)
        ON CONFLICT(collection_id, favorite_id) DO NOTHING
      `).run(cid, fid, this.#now());
      return { added: Number(result.changes) > 0 };
    });
  }

  /** 移出收藏夹：只删成员关系；收藏与条目都保留。 */
  removeFromCollection({ favoriteId, collectionId }) {
    const fid = asIntOrNull(favoriteId, 1);
    const cid = asIntOrNull(collectionId, 1);
    if (!fid || !cid) throw new CatalogQueryError('invalid', '收藏夹/收藏 id 不合法');
    // 作用域校验：不能借另一个 library 的 id 删到别人的成员关系。
    const favorite = this.#db.prepare('SELECT id FROM favorite WHERE id = ? AND library_id = ?')
      .get(fid, this.#libraryId);
    const collection = this.#db.prepare('SELECT id FROM collection WHERE id = ? AND library_id = ?')
      .get(cid, this.#libraryId);
    if (!favorite || !collection) return { removed: false };
    return this.#tx(() => {
      const result = this.#db.prepare('DELETE FROM collection_member WHERE collection_id = ? AND favorite_id = ?')
        .run(cid, fid);
      return { removed: Number(result.changes) > 0 };
    });
  }

  /** 列出某个收藏夹里的收藏 id（测试/排查用）。 */
  listCollectionFavoriteIds(collectionId) {
    const cid = asIntOrNull(collectionId, 1);
    if (!cid) return [];
    return this.#db.prepare(`
      SELECT m.favorite_id AS id FROM collection_member m
      JOIN collection c ON c.id = m.collection_id
      WHERE c.id = ? AND c.library_id = ?
      ORDER BY m.added_at ASC, m.favorite_id ASC
    `).all(cid, this.#libraryId).map((row) => Number(row.id));
  }

  /**
   * 本地收藏检索。所有条件都是 AND；不认识的键/排序/页码直接抛
   * `CatalogQueryError`，**不静默丢弃条件**。
   *
   * @param {{text?: string|null, filters?: object, sort?: string, page?: number, pageSize?: number}} query
   * @returns {{items: object[], total: number, page: number, pageSize: number, revision: number}}
   */
  listFavorites(query = {}) {
    const filters = query.filters && typeof query.filters === 'object' ? query.filters : {};
    for (const key of Object.keys(filters)) {
      if (!Object.hasOwn(FILTER_FIELDS, key)) {
        throw new CatalogQueryError('unsupported', `不支持的筛选条件：${key}`);
      }
    }
    const sort = String(query.sort ?? 'recent');
    if (!Object.hasOwn(SORT_SQL, sort)) throw new CatalogQueryError('unsupported', `不支持的排序：${sort}`);
    const pageRaw = Number(query.page ?? 1);
    const pageSizeRaw = Number(query.pageSize ?? 8);
    if (!Number.isSafeInteger(pageRaw) || pageRaw < 1) throw new CatalogQueryError('invalid', '页码不合法');
    if (!Number.isSafeInteger(pageSizeRaw) || pageSizeRaw < 1 || pageSizeRaw > 50) {
      throw new CatalogQueryError('invalid', '每页数量不合法');
    }
    const page = pageRaw;
    const pageSize = pageSizeRaw;
    const text = typeof query.text === 'string' ? query.text.trim() : '';

    const where = ['f.library_id = ?'];
    const params = [this.#libraryId];

    if (text !== '') {
      const normalizedText = normalizeCatalogText(text);
      if (normalizedText === '') throw new CatalogQueryError('invalid', '文本条件没有可比较的文字');
      where.push("i.title_norm LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(normalizedText)}%`);
    }

    for (const [field, values] of Object.entries(filters)) {
      const list = normalizeFilterValues(values, field);
      const config = FILTER_FIELDS[field];
      for (const value of list) {
        const norm = normalizeCatalogText(value);
        if (norm === '未知') {
          // 明确查"未知"：只看旗标，不看空关系表 —— 空关系表在 unknown 时也可能是没同步。
          where.push(`i.${config.knownColumn} = 0`);
          continue;
        }
        if (field === 'tag') {
          where.push(`(
            EXISTS (SELECT 1 FROM item_tag it JOIN tag t ON t.id = it.tag_id
                    WHERE it.item_id = i.id AND t.name_norm = ?)
            OR EXISTS (SELECT 1 FROM favorite_tag ft
                       WHERE ft.favorite_id = f.id AND ft.tag_norm = ?)
          )`);
          params.push(norm, norm);
        } else {
          const roles = config.roles.map(() => '?').join(', ');
          where.push(`EXISTS (
            SELECT 1 FROM item_creator ic JOIN creator c ON c.id = ic.creator_id
            WHERE ic.item_id = i.id AND ic.role IN (${roles}) AND c.name_norm = ?
          )`);
          params.push(...config.roles, norm);
        }
      }
    }

    const whereSql = where.join(' AND ');
    const totalRow = this.#db.prepare(`
      SELECT COUNT(*) AS n FROM favorite f JOIN catalog_item i ON i.id = f.item_id WHERE ${whereSql}
    `).get(...params);
    const total = Number(totalRow?.n ?? 0);
    const offset = (page - 1) * pageSize;
    const rows = this.#db.prepare(`
      SELECT f.id AS favorite_id, f.favorited_at, f.actor_id, f.note,
             i.*
      FROM favorite f JOIN catalog_item i ON i.id = f.item_id
      WHERE ${whereSql}
      ORDER BY ${SORT_SQL[sort]}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const items = rows.map((row, index) => {
      const item = this.#itemRowToItem(row);
      item.rank = offset + index + 1;
      item.favoriteId = Number(row.favorite_id);
      item.favoritedAt = row.favorited_at;
      item.actorId = row.actor_id ?? null;
      item.note = row.note ?? null;
      item.userTags = this.#db.prepare('SELECT tag FROM favorite_tag WHERE favorite_id = ? ORDER BY tag ASC')
        .all(row.favorite_id).map((entry) => entry.tag);
      return item;
    });

    return { items, total, page, pageSize, revision: this.#revision };
  }

  /** 最近一次清单（永久收藏之外的会话状态；按库+作用域隔离）。 */
  saveLastList({ scopeKind, scopeId, query = {}, itemIds = [], page = 1, total = 0 } = {}) {
    const kind = assertText(String(scopeKind ?? ''), 'scopeKind', LIMITS.entityType);
    const id = assertText(String(scopeId ?? ''), 'scopeId', LIMITS.actor);
    const ids = (Array.isArray(itemIds) ? itemIds : [])
      .map((value) => asIntOrNull(value, 1))
      .filter((value) => value !== null);
    return this.#tx(() => {
      this.#db.prepare(`
        INSERT INTO last_list (library_id, scope_kind, scope_id, query_json, item_ids_json, page, total, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(library_id, scope_kind, scope_id) DO UPDATE SET
          query_json = excluded.query_json, item_ids_json = excluded.item_ids_json,
          page = excluded.page, total = excluded.total, updated_at = excluded.updated_at
      `).run(
        this.#libraryId, kind, id, JSON.stringify(query ?? {}), JSON.stringify(ids),
        Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1,
        Number.isFinite(Number(total)) ? Number(total) : ids.length,
        this.#now(),
      );
      return { itemIds: ids };
    });
  }

  getLastList({ scopeKind, scopeId } = {}) {
    const kind = String(scopeKind ?? '');
    const id = String(scopeId ?? '');
    if (!kind || !id) return null;
    const row = this.#db.prepare(`
      SELECT query_json, item_ids_json, page, total, updated_at FROM last_list
      WHERE library_id = ? AND scope_kind = ? AND scope_id = ?
    `).get(this.#libraryId, kind, id);
    if (!row) return null;
    const safeParse = (text, fallback) => {
      try { return JSON.parse(text); } catch { return fallback; }
    };
    const itemIds = safeParse(row.item_ids_json, []);
    return {
      query: safeParse(row.query_json, {}),
      itemIds: Array.isArray(itemIds) ? itemIds.filter((value) => Number.isSafeInteger(value) && value > 0) : [],
      page: Number(row.page) || 1,
      total: Number(row.total) || 0,
      updatedAt: row.updated_at,
    };
  }

  clearLastList({ scopeKind, scopeId } = {}) {
    const kind = String(scopeKind ?? '');
    const id = String(scopeId ?? '');
    if (!kind || !id) return { removed: false };
    return this.#tx(() => {
      const result = this.#db.prepare('DELETE FROM last_list WHERE library_id = ? AND scope_kind = ? AND scope_id = ?')
        .run(this.#libraryId, kind, id);
      return { removed: Number(result.changes) > 0 };
    });
  }

  /**
   * 疑似重复：归一化标题相同，或至少一个作者名字相同。
   * **只返回候选**；调用方只能提示，不能合并、不能自动挑一个。
   */
  findSuspectedDuplicates({ title = null, creators = [], excludeItemId = null, limit = 3 } = {}) {
    const titleNorm = title ? normalizeCatalogText(title) : '';
    const creatorNorms = [...new Set(normalizeCreators(creators).map((entry) => normalizeCatalogText(entry.name)))]
      .filter(Boolean);
    if (!titleNorm && creatorNorms.length === 0) return [];
    const clampedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 10) : 3;
    const clauses = [];
    const params = [];
    if (titleNorm) {
      clauses.push('(i.title_norm IS NOT NULL AND i.title_norm = ?)');
      params.push(titleNorm);
    }
    if (creatorNorms.length > 0) {
      clauses.push(`EXISTS (
        SELECT 1 FROM item_creator ic JOIN creator c ON c.id = ic.creator_id
        WHERE ic.item_id = i.id AND c.name_norm IN (${creatorNorms.map(() => '?').join(', ')})
      )`);
      params.push(...creatorNorms);
    }
    const exclude = asIntOrNull(excludeItemId, 1);
    const excludeSql = exclude ? ' AND i.id <> ?' : '';
    if (exclude) params.push(exclude);
    // 只在本 library 已收藏的条目里提示重复：不把别的实例/库的标题漏出来。
    const rows = this.#db.prepare(`
      SELECT i.* FROM catalog_item i
      JOIN favorite f ON f.item_id = i.id AND f.library_id = ?
      WHERE (${clauses.join(' OR ')})${excludeSql}
      ORDER BY i.updated_at DESC, i.id DESC LIMIT ?
    `).all(this.#libraryId, ...params, clampedLimit);
    return rows.map((row) => this.#itemRowToItem(row));
  }

  /** 测试/审计用计数：收藏条目数（不是文件数，也不是来源条目总数）。 */
  countFavorites() {
    return Number(this.#db.prepare('SELECT COUNT(*) AS n FROM favorite WHERE library_id = ?')
      .get(this.#libraryId)?.n ?? 0);
  }

  countItems() {
    return Number(this.#db.prepare('SELECT COUNT(*) AS n FROM catalog_item').get()?.n ?? 0);
  }
}
