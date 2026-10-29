/**
 * **记忆检修台**(W4 / P2-C,2026-10-22)—— 网页面板里的记忆查看与检修那一层。
 *
 * ## 它是什么(与不是什么)
 *
 *   · **是**:staff 专用的维护视图 —— 按会话 / 关键词 / 状态(有效 / 失效 / 被合并)浏览
 *     note 与 fact,只读看 insight 与 memory_block;**软操作**只有两个:
 *     标失效(写 `invalid_at`)与恢复(清 `invalid_at`),每次写都落**一行审计日志**。
 *   · **不是**:物理删除不存在 —— note / fact 的行**一个都不许少**(ADD-only 是记忆线的
 *     铁律;`scripts\selftest-memory-console.js` 里有"扫代码 + 数行数"两道判据钉着)。
 *     insight **只增不改**(P2-A 的设计纪律),memory_block 有自己的生成器 —— 这一版对它们
 *     **只读**,不加任何写操作。
 *
 * ## 复用清单(D159:不许写第二份必须一致的实现)
 *
 *   · note 统计 → `memory-store.js` 的 `noteStats()`(启动横幅同一份口径);
 *   · note 被想起过几次 → `memory-store.js` 的 `accessMap()`(打分那层同一份账);
 *   · fact 读取 → `SqliteStateStore.facts()`(注入层同一份形状,`latestOnly:false` = 审计口径);
 *   · fact 统计 → `SqliteStateStore.factStats()`;
 *   · insight 读取 → `memory-insights.js` 的 `latestInsights()`(注入层同一份);
 *   · memory_block 读取 → `memory-store.js` 的 `getMemoryBlocks()`。
 *
 *   ⚠️ 标失效 / 恢复这三条 UPDATE 在存储层没有"按 id 手工软失效"的公开方法
 *   (`touchFact` 的复活/退役绑在完整 upsert 语义里,顺手会改 seen_count/last_seen ——
 *   检修不该碰那些账),所以这里按 `reconcileFacts` / `consolidate` / `touchFact` 的
 *   **同一句 WHERE 谓词**写最小的一条 UPDATE:状态不符就一个字节不写。
 *
 * ## 为什么面板这一层要存在(给未来读代码的人)
 *
 * 软失效之后"行还在库里"是刻意的(审计 / 恢复都要它),但读路径默认不再端出来 ——
 * 于是"库里到底有什么、哪条为什么不见了"在正常界面上看不见。这张检修台就是那本
 * 账的窗口:**看得见 + 能手工救**,但救的方式仍然只有软操作。
 */

import { createHash } from 'node:crypto';
import {
  accessMap,
  getMemoryBlocks,
  noteStats,
} from './memory-store.js';
import { latestInsights } from './memory-insights.js';

/** 一条清单最多端多少行(检修页不是导出工具,够人翻就行)。 */
export const MEMORY_CONSOLE_ROW_CAP = 200;

/** 状态筛选的合法取值(默认 = 读路径同一口径:只见有效)。 */
export const MEMORY_CONSOLE_STATUSES = Object.freeze(['valid', 'invalid', 'merged', 'all']);

/** 文本片段:压掉换行、截断到 max 字(给审计日志与页面 meta 用,不参与判断)。 */
function clip(text, max = 40) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/** 把 id 钉成正整数(不合法 = null,调用方按 400 回)。 */
function idOf(value) {
  const id = Math.trunc(Number(value));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** note 行的状态:失效 > 被合并 > 有效(与读路径的过滤顺序一致)。 */
function noteStatusOf(row) {
  if (row.invalid_at != null) return 'invalid';
  if (row.merged_into != null) return 'merged';
  return 'valid';
}

/** fact 行的状态(同上;fact 表同样有 merged_into 预留列)。 */
function factStatusOf(row) {
  if (row.invalidAt != null) return 'invalid';
  if (row.mergedInto != null) return 'merged';
  return 'valid';
}

/** 状态筛选的 SQL 片段(note 表用列名直写;`all` = 不加条件)。 */
function noteStatusClause(status) {
  if (status === 'valid') return ' AND invalid_at IS NULL AND merged_into IS NULL';
  if (status === 'invalid') return ' AND invalid_at IS NOT NULL';
  if (status === 'merged') return ' AND merged_into IS NOT NULL';
  return '';
}

/** LIKE 的转义:关键词里的 % _ \ 按字面匹配,不当通配符(检修查的是原文)。 */
function likePattern(query) {
  return `%${String(query ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * 会话 / 作用域的**筛选键**(openid 不出网:会话名里带着 QQ 的 openid,
 * 面板与 API 一律只发这个短键,服务端在这里换回原名再查 —— 键 = 名字的 SHA-256 前 12 位,
 * 只用于在自己刚查出来的清单里对号,不承担任何安全职责)。
 */
function convKeyOf(name) {
  return createHash('sha256').update(String(name ?? '')).digest('hex').slice(0, 12);
}

/** 筛选下拉的**人话标签**:只出尾巴(与前四位掩码同一思路),不出原名。 */
function convTailOf(name) {
  return String(name ?? '').slice(-6);
}

/**
 * 造一个记忆检修台服务。
 *
 * @param {{memoryDb: object|null, store: object|null, log?: Function, now?: Function}} deps
 *   · `memoryDb` — `openMemory()` 造的那份连接(装配层注入;null = 检修台整体关闭);
 *   · `store` — `SqliteStateStore`(fact 表在那里;null = 同上);
 *   · `log` — 审计日志的出口(装配层接启动日志;每次写操作一行)。
 * @returns {object} 服务句柄(全部方法内部不抛 —— 记忆层坏了只降级,不把面板带崩)。
 */
export function createMemoryConsole({ memoryDb = null, store = null, log = () => {}, now = Date.now } = {}) {
  /** 检修台可不可用:两个库都要在(fact 在 state.db,note/insight/block 在 memory.db)。 */
  const available = () => Boolean(memoryDb) && Boolean(store) && typeof store.facts === 'function';

  /** 记一行审计日志(每次写操作**恰好一行**,给操作者与以后复盘的人)。 */
  const audit = (line) => {
    try {
      log(`[记忆检修] ${line}`);
    } catch {
      /* 日志出口坏了不许影响检修本身 */
    }
  };

  /** 操作者是谁(面板层传 player.account;长票进来的没有账号,如实记)。 */
  const whoOf = (operator) => clip(operator ?? 'unknown', 60);

  const handle = () => store.handle ?? null;

  /**
   * note 会话清单的**内部形状**(带原名):`conversations()` 的公开面只出键与尾巴,
   * 但"键换回原名"的解析必须在这里做 —— 原名不出这个闭包。
   */
  function conversationRows(limit = 50) {
    if (!available()) return [];
    try {
      const cap = Math.max(1, Math.min(200, Number(limit) || 50));
      return memoryDb.prepare(
        'SELECT conversation AS name, COUNT(*) AS rows, MAX(at) AS lastAt FROM note GROUP BY conversation ORDER BY lastAt DESC LIMIT ?',
      ).all(cap).map((row) => ({
        name: String(row.name),
        rows: Number(row.rows) || 0,
        lastAt: Number(row.lastAt) || 0,
      }));
    } catch {
      return [];
    }
  }

  /** fact scope 清单的内部形状(同上)。 */
  function scopeRows(limit = 50) {
    const db = handle();
    if (!available() || !db) return [];
    try {
      const cap = Math.max(1, Math.min(200, Number(limit) || 50));
      return db.prepare(
        'SELECT scope AS name, COUNT(*) AS rows, MAX(last_seen) AS lastAt FROM fact GROUP BY scope ORDER BY lastAt DESC LIMIT ?',
      ).all(cap).map((row) => ({
        name: String(row.name),
        rows: Number(row.rows) || 0,
        lastAt: Number(row.lastAt) || 0,
      }));
    } catch {
      return [];
    }
  }

  /** 短键 → 原名(在内部清单上**现算键**对号;换不中 = 没筛,不是错误)。 */
  const nameByKey = (rows, key) => rows.find((row) => convKeyOf(row.name) === String(key ?? ''))?.name ?? null;
  const withKey = (rows) => rows.map((row) => ({ key: convKeyOf(row.name), tail: convTailOf(row.name), rows: row.rows, lastAt: row.lastAt }));

  return {
    available,

    /**
     * **一次取全**(页面与 GET /api/memory 共用的那份视图):统计 + 两个筛选清单 +
     * 当前清单 + 只读两区(insight / memory_block)。库坏 → `{ok:false}`(不抛)。
     *
     * ⚠️ `conversationKey` / `scopeKey` = `conversations()` / `factScopes()` 发出去的
     * 短键(**不是**原文):在这里换回原名再查,换不中就当没筛。
     */
    view({
      kind = 'note',
      conversation = null,
      scope = null,
      conversationKey = '',
      scopeKey = '',
      query = '',
      status = 'valid',
      limit = 100,
    } = {}) {
      if (!available()) return { ok: false, error: 'unavailable' };
      const which = kind === 'fact' ? 'fact' : 'note';
      // 短键在这里换回原名(原名不出闭包);直接给 `conversation`/`scope` 原名也认
      // (服务内部/测试用),两条入口走的同一份查询。
      const convName = conversationKey ? nameByKey(conversationRows(200), conversationKey) : conversation;
      const scopeName = scopeKey ? nameByKey(scopeRows(200), scopeKey) : scope;
      const list = which === 'fact'
        ? this.listFacts({ scope: scopeName, query, status, limit })
        : this.listNotes({ conversation: convName, query, status, limit });
      return {
        ok: Boolean(list.ok),
        kind: which,
        status: list.status ?? 'valid',
        overview: this.overview(),
        conversations: which === 'note' ? this.conversations(50) : [],
        scopes: which === 'fact' ? this.factScopes(50) : [],
        list,
        insights: this.insights(12),
        blocks: this.blocks(),
      };
    },

    /**
     * 顶部那一行统计(pill 用的数字)。库坏 → null(页面按"不可用"渲染,不抛)。
     * note 侧复用 `noteStats`(启动横幅同一份);fact 侧复用 `factStats`。
     */
    overview() {
      if (!available()) return null;
      try {
        const notes = noteStats(memoryDb, now());
        const facts = store.factStats();
        let insights = 0;
        try {
          insights = memoryDb.prepare('SELECT COUNT(*) AS n FROM insight').get()?.n ?? 0;
        } catch {
          insights = 0;   // 老库没这张表:如实按 0,不装死
        }
        const blocks = getMemoryBlocks(memoryDb).length;
        return {
          notes: { valid: (notes.long ?? 0) + (notes.midAll ?? 0), invalid: notes.invalid ?? 0, merged: notes.merged ?? 0 },
          facts: { valid: facts.total ?? 0, invalid: facts.invalid ?? 0 },
          insights: Number(insights) || 0,
          blocks,
        };
      } catch {
        return null;
      }
    },

    /**
     * note 的会话清单(筛选下拉用):按最近活跃排,带上行数。
     * 只列还**物理存在**的行 —— 失效/被合并的也在(检修台正是要看它们的入口)。
     * ⚠️ 只出 `key` 与 `tail`(openid 不出网,见 `convKeyOf`);原名不离开服务端。
     */
    conversations(limit = 50) {
      return withKey(conversationRows(limit));
    },

    /** fact 的 scope 清单(同上;fact 表在 state.db,走 store 的句柄)。 */
    factScopes(limit = 50) {
      return withKey(scopeRows(limit));
    },

    /**
     * 列 note(检修口径:**带 id 与软失效三列**,这是 `notesOf` 那个注入形状不带的 ——
     * 那份是"她还记着什么",这份是"账本上有什么"。判据共用靠 `noteStats`/读路径,不在这里)。
     *
     * @param {{conversation?: string|null, query?: string, status?: string, limit?: number}} options
     *   `status` 默认 `'valid'` —— 与读路径同一口径(默认只见有效);审计视图传 `'all'`。
     */
    listNotes({ conversation = null, query = '', status = 'valid', limit = 100 } = {}) {
      if (!available()) return { ok: false, error: 'unavailable', items: [], total: 0 };
      const want = MEMORY_CONSOLE_STATUSES.includes(status) ? status : 'valid';
      try {
        const where = ['1=1'];
        const args = [];
        const conv = String(conversation ?? '').trim();
        if (conv) {
          where.push('conversation = ?');
          args.push(conv);
        }
        const keyword = String(query ?? '').trim();
        let pattern = null;
        if (keyword) {
          where.push("text LIKE ? ESCAPE '\\'");
          pattern = likePattern(keyword);
          args.push(pattern);
        }
        const statusClause = noteStatusClause(want).replace(/^ AND /, '');
        if (statusClause) where.push(statusClause);
        const cap = Math.max(1, Math.min(MEMORY_CONSOLE_ROW_CAP, Number(limit) || 100));
        // ⚠️ 总数按**同一组条件**另数一遍(不带 LIMIT)—— 页面上"命中 N 条"要说实话。
        const total = memoryDb.prepare(
          `SELECT COUNT(*) AS n FROM note WHERE ${where.join(' AND ')}`,
        ).get(...args)?.n ?? 0;
        const rows = memoryDb.prepare(
          `SELECT id, conversation, source, at, tier, score, text, invalid_at, superseded_by, merged_into
             FROM note WHERE ${where.join(' AND ')}
            ORDER BY at DESC LIMIT ?`,
        ).all(...args, cap);
        let uses = new Map();
        try {
          uses = accessMap(memoryDb, { conversation: conv || null });
        } catch {
          uses = new Map();   // access 表不在(老库):引用数如实留空
        }
        const items = rows.map((row) => ({
          id: Number(row.id),
          conversation: String(row.conversation ?? ''),
          source: String(row.source ?? ''),
          at: Number(row.at) || 0,
          tier: String(row.tier ?? ''),
          text: String(row.text ?? ''),
          useCount: uses.get(String(row.source))?.useCount ?? 0,
          invalidAt: row.invalid_at == null ? null : Number(row.invalid_at),
          supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
          mergedInto: row.merged_into == null ? null : Number(row.merged_into),
          status: noteStatusOf(row),
        }));
        return { ok: true, items, total: Number(total) || 0, status: want };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error), items: [], total: 0 };
      }
    },

    /**
     * 列 fact —— 直接复用 `store.facts()`(`latestOnly:false` = 审计口径),
     * 状态与关键词在内存里过滤(facts 本来就限 500 行内,不值得另写一条 SQL)。
     */
    listFacts({ scope = null, subject = null, query = '', status = 'valid', limit = 100 } = {}) {
      if (!available()) return { ok: false, error: 'unavailable', items: [], total: 0 };
      const want = MEMORY_CONSOLE_STATUSES.includes(status) ? status : 'valid';
      try {
        const keyword = String(query ?? '').trim().toLowerCase();
        const scopeKey = String(scope ?? '').trim();
        const subjectKey = String(subject ?? '').trim();
        const rows = store.facts({
          scope: scopeKey || null,
          subject: subjectKey || null,
          limit: 500,
          latestOnly: false,
        });
        const filtered = rows.filter((row) => {
          const state = factStatusOf(row);
          if (want !== 'all' && state !== want) return false;
          if (!keyword) return true;
          return `${row.value ?? ''} ${row.detail ?? ''} ${row.kind ?? ''} ${row.subject ?? ''}`
            .toLowerCase()
            .includes(keyword);
        });
        const cap = Math.max(1, Math.min(MEMORY_CONSOLE_ROW_CAP, Number(limit) || 100));
        const items = filtered.slice(0, cap).map((row) => ({
          id: Number(row.id),
          scope: String(row.scope ?? ''),
          subject: String(row.subject ?? ''),
          kind: String(row.kind ?? ''),
          value: String(row.value ?? ''),
          detail: row.detail == null ? null : String(row.detail),
          source: String(row.source ?? ''),
          lastSeen: Number(row.lastSeen) || 0,
          seenCount: Number(row.seenCount) || 0,
          invalidAt: row.invalidAt == null ? null : Number(row.invalidAt),
          supersededBy: row.supersededBy == null ? null : Number(row.supersededBy),
          mergedInto: row.mergedInto == null ? null : Number(row.mergedInto),
          status: factStatusOf(row),
        }));
        return { ok: true, items, total: filtered.length, status: want };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error), items: [], total: 0 };
      }
    },

    /** 只读:最新几条洞察(注入层同一份函数;表不在 → 空数组)。 */
    insights(limit = 20) {
      if (!available()) return [];
      try {
        return latestInsights(memoryDb, { limit: Math.max(1, Math.min(50, Number(limit) || 20)) });
      } catch {
        return [];
      }
    },

    /** 只读:记忆块现状(生成器的产物;这一层不给它们加写操作)。 */
    blocks() {
      if (!available()) return [];
      try {
        return getMemoryBlocks(memoryDb);
      } catch {
        return [];
      }
    },

    /**
     * 标失效:note 写 `invalid_at`(**不物理删**;行还在,审计视图与恢复都靠它)。
     * ⚠️ 与 `consolidate` 的退役同一句 WHERE 谓词(`invalid_at IS NULL`)——
     * 已经失效的行再打一次 = 没有变化,如实报 `already`,不重复记审计。
     */
    invalidateNote(id, { operator = null } = {}) {
      const rowId = idOf(id);
      if (!available()) return { ok: false, error: 'unavailable' };
      if (rowId === null) return { ok: false, error: 'bad_id' };
      try {
        const row = memoryDb.prepare('SELECT id, conversation, text, invalid_at FROM note WHERE id = ?').get(rowId);
        if (!row) return { ok: false, error: 'not_found' };
        if (row.invalid_at != null) return { ok: false, error: 'already' };
        const at = now();
        memoryDb.prepare('UPDATE note SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL').run(at, rowId);
        audit(`note #${rowId} 标失效 by=${whoOf(operator)} 会话=${clip(row.conversation, 30)} 「${clip(row.text)}」`);
        return { ok: true, id: rowId, invalidAt: at };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },

    /**
     * 恢复:清 `invalid_at`。⚠️ `superseded_by` **保留不清** —— 它是"谁取代过它"的
     * 审计指针,清掉就断账;读路径只看 `invalid_at`,恢复后照常回到注入池
     * (若它曾被新说法取代,下一次改口时 consolidate 会按同一套判据重新收敛)。
     */
    restoreNote(id, { operator = null } = {}) {
      const rowId = idOf(id);
      if (!available()) return { ok: false, error: 'unavailable' };
      if (rowId === null) return { ok: false, error: 'bad_id' };
      try {
        const row = memoryDb.prepare('SELECT id, conversation, text, invalid_at FROM note WHERE id = ?').get(rowId);
        if (!row) return { ok: false, error: 'not_found' };
        if (row.invalid_at == null) return { ok: false, error: 'already' };
        memoryDb.prepare('UPDATE note SET invalid_at = NULL WHERE id = ? AND invalid_at IS NOT NULL').run(rowId);
        audit(`note #${rowId} 恢复 by=${whoOf(operator)} 会话=${clip(row.conversation, 30)} 「${clip(row.text)}」`);
        return { ok: true, id: rowId };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },

    /**
     * 标失效:fact 写 `invalid_at`(与 `reconcileFacts` 同一句谓词;**不物理删**)。
     * 与写时退役不同的只有一点:手工检修没有"取代它的新行",所以 `superseded_by` 不填。
     */
    invalidateFact(id, { operator = null } = {}) {
      const rowId = idOf(id);
      if (!available()) return { ok: false, error: 'unavailable' };
      const db = handle();
      if (!db) return { ok: false, error: 'unavailable' };
      if (rowId === null) return { ok: false, error: 'bad_id' };
      try {
        const row = db.prepare('SELECT id, scope, subject, kind, value, invalid_at FROM fact WHERE id = ?').get(rowId);
        if (!row) return { ok: false, error: 'not_found' };
        if (row.invalid_at != null) return { ok: false, error: 'already' };
        const at = now();
        db.prepare('UPDATE fact SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL').run(at, rowId);
        audit(`fact #${rowId} 标失效 by=${whoOf(operator)} ${clip(row.scope, 24)}/${clip(row.subject, 20)}/${row.kind} = ${clip(row.value)}`);
        return { ok: true, id: rowId, invalidAt: at };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },

    /**
     * 恢复:清 `invalid_at`(与 `touchFact` 的精确行复活同一句口径:
     * `invalid_at` 与 `superseded_by` 一起清空 —— 那条路本来就是"这一行重新成立")。
     */
    restoreFact(id, { operator = null } = {}) {
      const rowId = idOf(id);
      if (!available()) return { ok: false, error: 'unavailable' };
      const db = handle();
      if (!db) return { ok: false, error: 'unavailable' };
      if (rowId === null) return { ok: false, error: 'bad_id' };
      try {
        const row = db.prepare('SELECT id, scope, subject, kind, value, invalid_at FROM fact WHERE id = ?').get(rowId);
        if (!row) return { ok: false, error: 'not_found' };
        if (row.invalid_at == null) return { ok: false, error: 'already' };
        db.prepare('UPDATE fact SET invalid_at = NULL, superseded_by = NULL WHERE id = ? AND invalid_at IS NOT NULL').run(rowId);
        audit(`fact #${rowId} 恢复 by=${whoOf(operator)} ${clip(row.scope, 24)}/${clip(row.subject, 20)}/${row.kind} = ${clip(row.value)}`);
        return { ok: true, id: rowId };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  };
}
