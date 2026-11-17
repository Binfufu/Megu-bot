/**
 * 通用目录收藏的 **JM 适配器**（2026-11-17）。
 *
 * 这一层只做两件事：
 *   ① 把 JM 边车 `/resolve` 的合成形状映射成通用 `catalog_item`（作品级）；
 *   ② 把 JM `/search` 映射成在线 provider（只读，不写收藏）。
 *
 * 网络仍然只在 `scripts/jm-fetch-one.mjs` 子进程里发生；本文件不 import `fetch`，
 * 也不碰下载/PDF/图片。`resolveItem` 只调 `--op resolve`，**绝不调 download/pdf**。
 */
import { createOnlineCatalogProvider } from './catalog-service.js';

const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

/** 边车 resolve 回包 → 通用条目。 */
export function itemFromJmResolve(payload, {
  requestedId = '',
  now = Date.now,
} = {}) {
  const album = payload?.album && typeof payload.album === 'object' ? payload.album : null;
  if (!album || !String(album.id ?? '').trim()) return null;
  const units = Array.isArray(album.units)
    ? album.units
      .map((unit) => ({
        unitId: String(unit?.unitId ?? unit?.unit_id ?? '').trim(),
        index: Number(unit?.index) || 0,
        title: String(unit?.title ?? ''),
      }))
      .filter((unit) => unit.unitId !== '')
    : [];
  const matched = payload?.matchedUnit && typeof payload.matchedUnit === 'object'
    ? String(payload.matchedUnit.unitId ?? '').trim()
    : '';
  const aliases = units.map((unit) => ({ type: 'unit', id: unit.unitId }));
  if (matched && !aliases.some((alias) => alias.id === matched)) aliases.push({ type: 'unit', id: matched });

  const authors = Array.isArray(album.authors)
    ? album.authors.map((name) => String(name ?? '').trim()).filter(Boolean)
    : null;
  const tags = Array.isArray(album.tags)
    ? album.tags.map((name) => String(name ?? '').trim()).filter(Boolean)
    : null;
  const creatorsKnown = authors !== null;
  const tagsKnown = tags !== null;
  // 角色（原作/角色）在 JM 回包里不可得，所以整体最多是 partial，不冒充 complete。
  const metadataStatus = creatorsKnown || tagsKnown ? 'partial' : 'unknown';
  const unitCount = Number(album.unitCount);
  const pageCount = Number(album.pageCount);

  return {
    source: 'jm',
    entityType: 'work',
    sourceId: String(album.id),
    title: String(album.title ?? '').trim() || null,
    pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null,
    unitCount: Number.isFinite(unitCount) && unitCount > 0 ? unitCount : (units.length || null),
    metadataFetchedAt: now(),
    metadataStatus,
    creators: (authors ?? []).map((name, index) => ({ name, role: 'author', seq: index })),
    creatorsKnown,
    // 边车只给作者名，不给"谁是原作/角色"；不要把这些归到"确认没有原作"。
    rolesKnown: false,
    tags: tags ?? [],
    tagsKnown,
    aliases,
  };
}

/** 解析结果的来源：给的编号是单元（或与作品 id 不同）时回执要说明"已归到作品"。 */
export function jmResolvedFrom(payload, requestedId = '') {
  const albumId = String(payload?.album?.id ?? '');
  return payload?.kind === 'photo' || (albumId && albumId !== String(requestedId)) ? 'unit' : 'album';
}

/** JM 搜索结果 → 通用条目（只读候选；不自动收藏）。 */
export function itemsFromJmSearch(payload, { now = Date.now } = {}) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results
    .map((entry) => {
      const id = String(entry?.id ?? '').trim();
      if (!id) return null;
      const detailOk = entry?.detailOk !== false;
      const authors = Array.isArray(entry?.authors) ? entry.authors.map(String).filter(Boolean) : [];
      const tags = Array.isArray(entry?.tags) ? entry.tags.map(String).filter(Boolean) : [];
      const creatorsKnown = detailOk || authors.length > 0;
      const tagsKnown = detailOk || tags.length > 0;
      return {
        source: 'jm',
        entityType: 'work',
        sourceId: id,
        title: String(entry?.title ?? '').trim() || null,
        pageCount: Number(entry?.pageCount) > 0 ? Number(entry.pageCount) : null,
        unitCount: null,
        metadataFetchedAt: now(),
        metadataStatus: creatorsKnown || tagsKnown ? 'partial' : 'unknown',
        creators: authors.map((name, index) => ({ name, role: 'author', seq: index })),
        creatorsKnown,
        rolesKnown: false,
        tags,
        tagsKnown,
        aliases: [],
      };
    })
    .filter(Boolean);
}

/**
 * 创建 JM 目录 provider。
 *
 * @param {object} options
 * @param {(id: string) => Promise<object>} options.resolve 调 `--op resolve`，返回边车 payload
 * @param {(query: {text:string,page:number,pageSize:number}) => Promise<object>} [options.search]
 *   调 `--op search --images 0`，返回边车 payload
 * @param {object} [options.log]
 * @param {Function} [options.now]
 */
export function createJmCatalogProvider({ resolve, search, log = SILENT_LOG, now = Date.now } = {}) {
  if (typeof resolve !== 'function') throw new Error('JM 目录 provider 需要 resolve');

  const online = createOnlineCatalogProvider({
    id: 'jm-online',
    version: '1',
    capabilities: {
      text: true,
      filters: { creator: false, original: false, character: false, tag: false },
      sorts: ['relevance'],
      // 当前 CLI 的 /search 固定 page=1；不假装支持翻页，page>1 由统一入口报不支持。
      pagination: false,
      period: false,
    },
    search: async ({ text, page, pageSize }) => {
      if (typeof search !== 'function') return { ok: false, reason: 'unsupported', detail: 'JM 在线检索未接入' };
      if (!text) return { ok: false, reason: 'unsupported', detail: 'JM 在线检索需要关键词' };
      const payload = await search({ text, page, pageSize });
      if (!payload || payload.ok !== true) {
        return { ok: false, reason: payload?.reason ?? 'unavailable' };
      }
      const items = itemsFromJmSearch(payload, { now });
      return {
        ok: true,
        items,
        total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : items.length,
        limited: true,
        examined: items.length,
      };
    },
  });

  return {
    ...online,
    defaultSource: 'jm',
    /**
     * 只按编号精确解析；不搜索、不下载、不碰图片。
     * 返回 `{ok:true,item,resolvedFrom}` 或 `{ok:false,reason}`。
     */
    async resolveItem({ source, id } = {}) {
      if (String(source ?? '').toLowerCase() !== 'jm') {
        return { ok: false, reason: 'unsupported_source' };
      }
      const number = String(id ?? '').trim();
      if (!/^\d{1,12}$/u.test(number)) return { ok: false, reason: 'not_found' };
      let payload;
      try {
        payload = await resolve(number);
      } catch (err) {
        log.warn(`JM 目录：解析 ${number} 失败：${err?.message ?? err}`);
        return { ok: false, reason: 'unavailable' };
      }
      if (!payload || payload.ok !== true) {
        const reason = String(payload?.reason ?? 'unavailable');
        if (reason === 'not_found') return { ok: false, reason: 'not_found' };
        if (reason === 'unsupported' || reason === 'bad_args') return { ok: false, reason: 'unsupported_source' };
        return { ok: false, reason: 'unavailable' };
      }
      const item = itemFromJmResolve(payload, { requestedId: number, now });
      if (!item) return { ok: false, reason: 'not_found' };
      return { ok: true, item, resolvedFrom: jmResolvedFrom(payload, number) };
    },
  };
}
