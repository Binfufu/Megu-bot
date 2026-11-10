/**
 * **异界新闻只读投影**(2026-11-10)。
 *
 * 用途:网站「世界地图」页新增一块「异界新闻」板块 —— 每次盯梢收件箱有新消息,就挂一条
 * 长横条在板上(最新在前)。数据源是盯梢实验区的权威 SQLite(`feed.db`)的 `feed_inbox` 表,
 * 但这里**只读**:
 *   · `new DatabaseSync(dbPath, { readOnly: true })` —— 连写权限都不拿;
 *   · 只 SELECT `feed_inbox` 的公开字段(标题/网址/梗概/时间),不读任何配置或凭据;
 *   · 库不存在 / 不是 feed 库 / 打开失败 → 整体 disabled(返回 null),页面整块不显示 ——
 *     **fail closed**,不拿空板冒充"没有新闻"。
 *
 * ⚠️ 为什么不在面板里直接读库:面板这一层不该认识盯梢(它连"盯梢进程"是什么都不知道);
 *    这条投影只做"把公开字段变成页面能画的形状"。
 * ⚠️ 快照每 5 秒拉一次,所以 `summary` 只给**截断后的一句话**(默认 180 字),不是 2400 字原文 ——
 *    20 条 × 2400 字会让每次轮询多背 50KB。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** 板块默认最多挂多少条(页面也是这个上限)。 */
export const FEED_NEWS_LIMIT = 20;
/** 每条的梗概最多给多少字(页面只用一行;原文仍在 feed.db)。 */
export const FEED_NEWS_SNIPPET = 180;
/** 只读打开 + 只查这一张表。 */
const COLUMNS = 'id, sourceId, sourceName, type, title, url, summary, publishedAt, detectedAt';

/** 压平空白并截断成一句话(纯函数;不做 HTML、不加省略号以外的装饰)。 */
export function feedNewsSnippet(summary, limit = FEED_NEWS_SNIPPET) {
  const flat = String(summary ?? '').replace(/[\s\u200b\ufeff]+/gu, ' ').trim();
  if (!flat) return '';
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : FEED_NEWS_SNIPPET;
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * DB 行 → 页面卡片行(纯函数)。坏行**跳过**,不猜:
 * id/sourceId/title 必须是字符串,url 必须是公开 http(s),detectedAt 必须是安全整数。
 * @returns {Array<{id:string, source:string, sourceName:string, type:string, title:string,
 *   url:string, summary:string, publishedAt:string|null, detectedAt:number}>}
 */
export function mapFeedNewsRows(rows, { limit = FEED_NEWS_LIMIT } = {}) {
  if (!Array.isArray(rows)) return [];
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : FEED_NEWS_LIMIT;
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id : '';
    const source = typeof row.sourceId === 'string' ? row.sourceId : '';
    const sourceName = typeof row.sourceName === 'string' && row.sourceName.trim() ? row.sourceName : source;
    const title = typeof row.title === 'string' ? row.title : '';
    const url = typeof row.url === 'string' ? row.url : '';
    const detectedAt = Number(row.detectedAt);
    if (!id || !source || !title || !Number.isSafeInteger(detectedAt)) continue;
    // 公开链接 only(与 feed 存储同一口径;这里再挡一次,防旧库/坏数据)。
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
    items.push({
      id,
      source,
      sourceName,
      type: row.type === 'updated' ? 'updated' : 'new',
      title,
      url,
      summary: feedNewsSnippet(row.summary),
      publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : null,
      detectedAt,
    });
    if (items.length >= cap) break;
  }
  return items;
}

/**
 * **只读**的异界新闻读取器(装配层注入;null = 功能关)。
 *
 * @param {{dbPath?: string|null, limit?: number, log?: (line:string)=>void, now?: () => number}} options
 */
export function createFeedNews({ dbPath = null, limit = FEED_NEWS_LIMIT, log = () => {}, now = () => Date.now() } = {}) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 50) : FEED_NEWS_LIMIT;
  const path = typeof dbPath === 'string' && dbPath.trim() ? dbPath.trim() : null;
  let db = null;
  let unavailable = !path;
  let lastWarnAt = 0;

  function warnOnce(reason) {
    const at = Date.now();
    // 每 10 分钟最多一条:板子读不到不该把进程日志刷穿。
    if (at - lastWarnAt < 600_000) return;
    lastWarnAt = at;
    log(`异界新闻不可用（${reason}）—— 板块隐藏，QQ 与其它功能不受影响`);
  }

  function open() {
    if (db || unavailable) return db;
    try {
      if (!isAbsolute(path) || !existsSync(path)) throw new Error('feed_db_missing');
      db = new DatabaseSync(path, { readOnly: true });
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feed_inbox'").get();
      if (!table) throw new Error('feed_inbox_missing');
      return db;
    } catch {
      unavailable = true;
      try { db?.close(); } catch { /* already gone */ }
      db = null;
      warnOnce('feed_db_unreadable');
      return null;
    }
  }

  return {
    /** 是否配置了库(不代表现在读得到;读得到与否看 latest())。 */
    get configured() { return !unavailable; },
    /** 最新 N 条(最新在前);读不到 → null。 */
    latest() {
      const handle = open();
      if (!handle) return null;
      try {
        const rows = handle.prepare(`SELECT ${COLUMNS} FROM feed_inbox
          ORDER BY detectedAt DESC, id DESC LIMIT ?`).all(cap);
        return { items: mapFeedNewsRows(rows, { limit: cap }), updatedAt: now() };
      } catch {
        warnOnce('feed_inbox_query_failed');
        return null;
      }
    },
    close() {
      try { db?.close(); } catch { /* already closed */ }
      db = null;
      unavailable = true;
    },
  };
}
