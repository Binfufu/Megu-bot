/**
 * 本地目录收藏的**服务层**（2026-11-17）。
 *
 * 与 `src/jm-service.js` 同构：解析器只解析（`catalog-command.js`），本文件负责
 * 把"收藏 / 取消收藏 / 收藏夹"落到数据层（`catalog-store.js`），并回固定格式的文字。
 * **不联网、不下载、不读文件**；需要来源元数据时只通过注入的 provider 接口拿，
 * provider 自己决定网络边界。
 *
 * 关键边界：
 *   · 收藏 ≠ 下载：这里没有任何 download / pdf / 图片调用路径；
 *   · 取消收藏 ≠ 删除条目/文件：只删收藏关系；
 *   · 序号只绑定"当前库 + 当前作用域（群+人）最近一次清单"，落库前换算成稳定条目 ID；
 *   · 多候选只回清单让用户选，不自动挑；
 *   · 重复收藏幂等，回执仍以「已收藏」开头；
 *   · 缺元数据（未知）与确认没有（空）在展示与筛选里分开。
 */
import { CatalogQueryError } from './catalog-store.js';

/** 默认每页条数；真实值来自配置 `QQBOT_CATALOG_PAGE_SIZE`（【暂定】8）。 */
export const DEFAULT_CATALOG_PAGE_SIZE = 8;

/** 清单里标题/作者/标签的最大展示宽度；超出用省略号，避免一条撑爆一页。 */
const DISPLAY_TITLE_CHARS = 42;
const DISPLAY_CREATOR_CHARS = 28;
const DISPLAY_TAGS_CHARS = 36;

const SILENT_LOG = { info() {}, warn() {}, debug() {}, error() {} };

export const DEFAULT_CATALOG_LINES = Object.freeze({
  format: '格式：收藏 <条目ID>；取消收藏 <条目ID>；收藏夹 [页码]；收藏夹 作者:xxx / 标签:xxx / 原作:xxx。',
  targetFormat: '格式：收藏 <条目ID>（可加 标签:xxx）；取消收藏 <条目ID>。',
  tagFormat: '标签最多 5 个、每个 30 字以内。',
  pageFormat: '页码要是 1..9999 的整数。',
  unsupported: '这个条件不支持。',
  noStore: '收藏功能暂时不可用。',
  internal: '收藏操作出错了，稍后再试。',
  notFound: '没有这个条目：本地收藏和来源里都找不到。',
  unavailable: '暂时查不到这个条目，稍后再试。',
  unsupportedSource: '这个来源暂时不支持收藏。',
  noList: '先看收藏夹，再用「收藏 #序号」。',
  ordinalMissing: '这个序号不在最近一次收藏夹清单里。',
  alreadyEmpty: '没收藏过：找不到这条收藏。',
  emptyPage: '这一页没有条目。',
});

/** 去掉会破坏"｜"分列的字符，并把超长文本截断。 */
function oneLine(value, max) {
  const text = String(value ?? '').replace(/[\r\n｜|]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** 条目在清单里的稳定显示 ID（JM 沿用 JM<编号>）。 */
export function displayItemId(item) {
  if (!item) return '';
  const source = String(item.source ?? '').toLowerCase();
  const id = String(item.sourceId ?? '');
  if (!id) return '';
  return source === 'jm' ? `JM${id}` : `${source || '条目'}:${id}`;
}

/** 作者列：`未知`（没取到）/ `无`（确认没有）/ 名字串。 */
export function describeCreators(item) {
  if (!item) return '未知';
  if (item.creatorsKnown !== true) return '未知';
  const names = (Array.isArray(item.creators) ? item.creators : [])
    .filter((entry) => entry && ['author', 'artist'].includes(String(entry.role ?? 'author')))
    .map((entry) => String(entry.name ?? '').trim())
    .filter(Boolean);
  return names.length > 0 ? oneLine([...new Set(names)].join('、'), DISPLAY_CREATOR_CHARS) : '无';
}

/** 标签列：用户标签加 `#` 前缀；来源标签原样；未知与空分开。 */
export function describeTags(item) {
  if (!item) return '未知';
  const userTags = (Array.isArray(item.userTags) ? item.userTags : [])
    .map((tag) => `#${String(tag ?? '').trim()}`)
    .filter((tag) => tag !== '#');
  const sourceTags = (Array.isArray(item.tags) ? item.tags : [])
    .map((tag) => String(tag ?? '').trim())
    .filter(Boolean);
  if (item.tagsKnown !== true) {
    // 来源标签未知时，用户标签仍是确定的；两者不能混成一句"无"。
    if (userTags.length > 0) return oneLine(`${userTags.join('、')}（来源:未知）`, DISPLAY_TAGS_CHARS);
    return '未知';
  }
  const all = [...new Set([...userTags, ...sourceTags])];
  return all.length > 0 ? oneLine(all.join('、'), DISPLAY_TAGS_CHARS) : '无';
}

function titleOf(item) {
  if (!item) return '（标题未知）';
  const title = String(item.title ?? '').trim();
  return title ? oneLine(`《${title}》`, DISPLAY_TITLE_CHARS) : '（标题未知）';
}

/** 单行清单：序号｜条目ID｜标题｜作者｜标签。 */
export function formatCatalogRow(item, rank) {
  return [
    String(rank ?? item?.rank ?? ''),
    displayItemId(item),
    titleOf(item),
    describeCreators(item),
    describeTags(item),
  ].join('｜');
}

function filterSummary(filters = {}) {
  const labels = { creator: '作者', original: '原作', character: '角色', tag: '标签' };
  const parts = [];
  for (const [field, values] of Object.entries(filters)) {
    for (const value of Array.isArray(values) ? values : []) parts.push(`${labels[field] ?? field}:${value}`);
  }
  return parts.join('、');
}

/**
 * 清单正文。分页时表头写"第 p/m 页"，有下一页给一行短提示（可执行，不教操作）。
 */
export function formatCatalogList({ items = [], page = 1, total = 0, pageSize = DEFAULT_CATALOG_PAGE_SIZE, filters = {}, text = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (list.length === 0) {
    const conditionText = filterSummary(filters);
    if (Number(total) <= 0 && !conditionText && !text) {
      return '收藏夹还是空的。看到条目后发「收藏 <条目ID>」。';
    }
    if (Number(total) > 0 && page > pages) {
      return `${DEFAULT_CATALOG_LINES.emptyPage}（共 ${total} 条、${pages} 页）。回到第 1 页：收藏夹`;
    }
    if (conditionText || text) {
      const condition = [conditionText, text ? `文本:${text}` : ''].filter(Boolean).join('、');
      return `本次检查范围内没有符合条件的收藏${condition ? `（条件：${condition}）` : ''}。`;
    }
    return '收藏夹还是空的。看到条目后发「收藏 <条目ID>」。';
  }
  const head = pages > 1 ? `收藏夹（第 ${page}/${pages} 页，共 ${total} 条）` : `收藏夹（共 ${total} 条）`;
  // 序号按**当前页清单**从 1 开始：`收藏 #N` 与用户刚看到的这一页一一对应。
  const rows = list.map((item, index) => formatCatalogRow(item, index + 1));
  const tail = page < pages ? [`下一页：收藏夹 ${page + 1}`] : [];
  return [head, ...rows, ...tail].join('\n');
}

/** 多候选时的清单（只让用户选，不自动挑）。 */
export function formatCandidateList(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  const rows = list.map((item, index) => formatCatalogRow(item, index + 1));
  return ['找到多个条目，请用条目 ID 再发一次收藏：', ...rows].join('\n');
}

/** 收藏成功/重复收藏的回执。 */
export function formatFavoriteAck({ item, created, requestedId = '', requestedDisplay = '', tags = [], suspects = [] } = {}) {
  const id = displayItemId(item);
  const title = titleOf(item);
  const prefix = created ? '已收藏' : '已收藏（之前已在收藏夹）';
  const customTags = (Array.isArray(tags) ? tags : []).filter(Boolean);
  const tagPart = customTags.length > 0 ? `（标签：${customTags.join('、')}）` : '';
  const unitPart = requestedId && item && String(item.sourceId) !== String(requestedId)
    ? `（你给的 ${requestedDisplay || requestedId} 是单元，已归到作品）`
    : '';
  const lines = [`${prefix}：${id}${title}${tagPart}${unitPart}`];
  if (Array.isArray(suspects) && suspects.length > 0) {
    const detail = suspects.slice(0, 3).map((entry) => `${displayItemId(entry)}${titleOf(entry)}`).join('、');
    lines.push(`疑似重复：${detail}（未合并）`);
  }
  return lines.join('\n');
}

/** 本地 provider：完全离线，只查收藏库；能力声明里条件全支持。 */
export function createLocalCatalogProvider(store, { id = 'local', version = '1' } = {}) {
  if (!store) throw new Error('本地目录 provider 需要 store');
  return {
    id,
    version,
    scope: 'local',
    libraryId: store.libraryId,
    get revision() {
      return store.revision;
    },
    capabilities: Object.freeze({
      text: true,
      filters: Object.freeze({ creator: true, original: true, character: true, tag: true }),
      sorts: Object.freeze(['recent', 'title', 'source_id']),
      pagination: true,
      period: false,
      offline: true,
    }),
    async search(query) {
      try {
        const result = store.listFavorites(query);
        return { ok: true, ...result, scope: 'local', provider: id, limited: false };
      } catch (err) {
        if (err instanceof CatalogQueryError) return { ok: false, reason: err.reason, detail: err.message };
        throw err;
      }
    },
  };
}

/**
 * 在线 provider：显式声明能力；不支持的条件必须返回明确错误，不能假装支持。
 * 搜索结果**不写收藏**（这个函数只读 provider 的回包，不碰 store）。
 */
export function createOnlineCatalogProvider({
  id = 'online',
  version = '1',
  capabilities = {},
  search,
} = {}) {
  if (typeof search !== 'function') throw new Error('在线目录 provider 需要 search');
  const caps = {
    text: capabilities.text === true,
    filters: {
      creator: capabilities.filters?.creator === true,
      original: capabilities.filters?.original === true,
      character: capabilities.filters?.character === true,
      tag: capabilities.filters?.tag === true,
    },
    sorts: Array.isArray(capabilities.sorts) ? [...capabilities.sorts] : ['relevance'],
    pagination: capabilities.pagination !== false,
    period: capabilities.period === true,
    offline: false,
  };
  return {
    id,
    version,
    scope: 'online',
    capabilities: Object.freeze({
      ...caps,
      filters: Object.freeze(caps.filters),
      sorts: Object.freeze(caps.sorts),
    }),
    async search(query) {
      const unsupported = findUnsupported(query, caps);
      if (unsupported) return unsupported;
      const result = await search(query);
      if (!result || result.ok !== true) return { ok: false, reason: result?.reason ?? 'unavailable' };
      return {
        ok: true,
        items: Array.isArray(result.items) ? result.items : [],
        total: Number.isFinite(Number(result.total)) ? Number(result.total) : 0,
        page: query.page,
        pageSize: query.pageSize,
        scope: 'online',
        provider: id,
        limited: result.limited !== false,
        examined: Number.isFinite(Number(result.examined)) ? Number(result.examined) : undefined,
      };
    },
  };
}

/** 检查 provider 是否声明支持查询里的每个条件；不支持就明确报，不静默丢。 */
function findUnsupported(query, capabilities) {
  if (query.text && capabilities.text !== true) {
    return { ok: false, reason: 'unsupported', detail: '这个来源不支持文本检索' };
  }
  for (const [field, values] of Object.entries(query.filters ?? {})) {
    if (!Array.isArray(values) || values.length === 0) continue;
    if (capabilities.filters?.[field] !== true) {
      return { ok: false, reason: 'unsupported', detail: `这个来源不支持 ${field} 条件` };
    }
  }
  if (!Array.isArray(capabilities.sorts) || !capabilities.sorts.includes(query.sort)) {
    return { ok: false, reason: 'unsupported', detail: `这个来源不支持排序 ${query.sort}` };
  }
  if (Number(query.page) > 1 && capabilities.pagination !== true) {
    return { ok: false, reason: 'unsupported', detail: '这个来源不支持翻页' };
  }
  if (query.period && capabilities.period !== true) {
    return { ok: false, reason: 'unsupported', detail: '这个来源不支持时间范围' };
  }
  return null;
}

/** 查询对象归一：固定字段、排序值数组、页码；未知字段不参与（但外层可拒绝）。 */
export function normalizeCatalogQuery(query = {}) {
  const scope = String(query.scope ?? 'local').toLowerCase();
  const filters = {};
  for (const field of ['creator', 'original', 'character', 'tag']) {
    const values = query.filters?.[field];
    if (values === undefined) continue;
    const list = (Array.isArray(values) ? values : [values])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    if (list.length > 0) filters[field] = [...new Set(list)];
  }
  const sort = String(query.sort ?? (scope === 'online' ? 'relevance' : 'recent'));
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? DEFAULT_CATALOG_PAGE_SIZE);
  return {
    scope,
    text: typeof query.text === 'string' && query.text.trim() !== '' ? query.text.trim() : null,
    filters,
    sort,
    page: Number.isSafeInteger(page) && page >= 1 ? page : NaN,
    pageSize: Number.isSafeInteger(pageSize) && pageSize >= 1 ? pageSize : NaN,
    period: query.period ?? null,
  };
}

/**
 * 缓存键必须包含**全部**会改变结果的输入：scope、文本、每个条件、排序、周期、分页、
 * provider 身份/版本、本地库 id；本地查询还要带 store revision（收藏变化后旧结果失效）。
 */
export function catalogCacheKey(query, provider) {
  const normalized = normalizeCatalogQuery(query);
  const filters = {};
  for (const key of Object.keys(normalized.filters).sort()) {
    filters[key] = [...normalized.filters[key]].sort();
  }
  return JSON.stringify({
    scope: normalized.scope,
    text: normalized.text,
    filters,
    sort: normalized.sort,
    period: normalized.period,
    page: normalized.page,
    pageSize: normalized.pageSize,
    provider: provider?.id ?? null,
    providerVersion: provider?.version ?? null,
    library: provider?.libraryId ?? null,
    revision: provider?.scope === 'local' ? (provider.revision ?? null) : null,
  });
}

/** 有上限的小缓存：键已含全部条件；不同条件不会复用同一项。 */
export function createCatalogQueryCache({ max = 200 } = {}) {
  const map = new Map();
  return {
    get size() { return map.size; },
    has(key) { return map.has(key); },
    get(key) { return map.get(key); },
    set(key, value) {
      if (map.size >= max && !map.has(key)) {
        const first = map.keys().next();
        if (!first.done) map.delete(first.value);
      }
      map.set(key, value);
      return value;
    },
    clear() { map.clear(); },
  };
}

/**
 * 本地/在线统一查询入口。provider 必须声明能力；不支持的条件返回 `{ok:false,
 * reason:'unsupported'}`，**不静默丢弃条件**。
 */
export async function searchCatalog({ query, provider, cache = null } = {}) {
  if (!provider || typeof provider.search !== 'function') {
    return { ok: false, reason: 'unsupported', detail: '没有可用的检索来源' };
  }
  // 未知条件键必须在入口就拒绝：normalize 只认识固定字段，不能把它悄悄吞掉。
  if (query?.filters && typeof query.filters === 'object') {
    for (const field of Object.keys(query.filters)) {
      if (!['creator', 'original', 'character', 'tag'].includes(field)) {
        return { ok: false, reason: 'unsupported', detail: `不支持的条件：${field}` };
      }
    }
  }
  const normalized = normalizeCatalogQuery(query);
  if (!Number.isFinite(normalized.page) || !Number.isFinite(normalized.pageSize)) {
    return { ok: false, reason: 'invalid', detail: '页码或每页数量不合法' };
  }
  if (normalized.scope !== provider.scope) {
    return { ok: false, reason: 'unsupported', detail: `来源 ${provider.id} 不支持 ${normalized.scope} 范围` };
  }
  const unsupported = findUnsupported(normalized, provider.capabilities ?? {});
  if (unsupported) return unsupported;
  const key = catalogCacheKey(normalized, provider);
  if (cache?.has?.(key)) return { ...cache.get(key), cached: true };
  const result = await provider.search(normalized);
  if (result?.ok === true && cache?.set) cache.set(key, result);
  return result;
}

/** 当前群+人的清单作用域；group/user 两个维度都进键，绝不跨群/跨人。 */
export function catalogScopeFor(message) {
  const groupId = String(message?.targetId ?? '').trim();
  const actorId = String(message?.senderId ?? '').trim() || 'anonymous';
  return { scopeKind: 'group_user', scopeId: `${groupId}:${actorId}`, groupId, actorId };
}

function lineForReason(reason) {
  switch (reason) {
    case 'format': return DEFAULT_CATALOG_LINES.format;
    case 'target': return DEFAULT_CATALOG_LINES.targetFormat;
    case 'tag': return DEFAULT_CATALOG_LINES.tagFormat;
    case 'page': return DEFAULT_CATALOG_LINES.pageFormat;
    case 'unsupported': return DEFAULT_CATALOG_LINES.unsupported;
    case 'not_found': return DEFAULT_CATALOG_LINES.notFound;
    case 'unavailable': return DEFAULT_CATALOG_LINES.unavailable;
    case 'unsupported_source': return DEFAULT_CATALOG_LINES.unsupportedSource;
    case 'no_list': return DEFAULT_CATALOG_LINES.noList;
    case 'ordinal_missing': return DEFAULT_CATALOG_LINES.ordinalMissing;
    default: return DEFAULT_CATALOG_LINES.internal;
  }
}

/** 只有本地已存在/别名命中才用；不存在时返回 null（由 provider 决定是否联网）。 */
function findLocalItem(store, target) {
  if (!target) return null;
  const key = {
    source: String(target.source ?? ''),
    entityType: 'work',
    sourceId: String(target.id ?? ''),
  };
  if (!key.source || !key.sourceId) return null;
  const direct = store.findItem(key);
  if (direct) return { ok: true, item: direct, resolvedFrom: 'local' };
  const alias = store.findItemByAlias({ source: key.source, aliasType: 'unit', aliasId: key.sourceId });
  if (alias) return { ok: true, item: alias, resolvedFrom: 'unit' };
  return null;
}

/** 序号 → 最近清单里的稳定条目 ID；找不到就返回固定原因，不猜。 */
function itemFromOrdinal(store, scope, ordinal) {
  const list = store.getLastList(scope);
  if (!list || !Array.isArray(list.itemIds) || list.itemIds.length === 0) {
    return { ok: false, reason: 'no_list' };
  }
  const itemId = list.itemIds[Number(ordinal) - 1];
  if (!Number.isSafeInteger(itemId)) return { ok: false, reason: 'ordinal_missing' };
  const item = store.getItem(itemId);
  if (!item) return { ok: false, reason: 'ordinal_missing' };
  return { ok: true, item, resolvedFrom: 'list' };
}

async function resolveFavoriteTarget({ store, provider, target, ordinal, scope, log }) {
  if (ordinal) return itemFromOrdinal(store, scope, ordinal);

  const local = findLocalItem(store, target);
  if (local) return { ok: true, ...local };

  if (!provider || typeof provider.resolveItem !== 'function') {
    return { ok: false, reason: 'unsupported_source' };
  }
  const source = String(target?.source ?? provider.defaultSource ?? '');
  const id = String(target?.id ?? '');
  if (!source || !id) return { ok: false, reason: 'target' };
  let resolved;
  try {
    resolved = await provider.resolveItem({ source, id });
  } catch (err) {
    log.warn(`收藏：解析条目失败（${source}:${id}）：${err?.message ?? err}`);
    return { ok: false, reason: 'unavailable' };
  }
  if (Array.isArray(resolved?.candidates) && resolved.candidates.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: resolved.candidates };
  }
  if (!resolved || resolved.ok !== true) {
    return { ok: false, reason: String(resolved?.reason ?? 'not_found') };
  }
  const item = resolved.item ?? (Array.isArray(resolved.candidates) ? resolved.candidates[0] : null);
  if (!item) return { ok: false, reason: 'not_found' };
  return { ok: true, item, resolvedFrom: resolved.resolvedFrom ?? 'provider', requestedId: id };
}

/**
 * 处理一条收藏指令。**不抛**：所有意外收口成固定话术并记日志。
 *
 * deps:
 *   store（必需）/ provider（可选，收藏新条目时需要）/ reply（必需）/
 *   log / now / pageSize / lines
 *
 * @returns {Promise<{ok: boolean, reason?: string, action?: string, sent?: number}>}
 */
export async function handleCatalogCommand({ message, parsed, deps = {} } = {}) {
  const log = deps.log ?? SILENT_LOG;
  const store = deps.store;
  const provider = deps.provider ?? null;
  const pageSizeRaw = Number(deps.pageSize ?? DEFAULT_CATALOG_PAGE_SIZE);
  const pageSize = Number.isSafeInteger(pageSizeRaw) && pageSizeRaw > 0 && pageSizeRaw <= 50
    ? pageSizeRaw
    : DEFAULT_CATALOG_PAGE_SIZE;
  const reply = typeof deps.reply === 'function'
    ? deps.reply
    : async (text) => { log.warn(`收藏：没有注入 reply，这句回话被丢弃：${text}`); };

  if (!store) {
    await reply(DEFAULT_CATALOG_LINES.noStore);
    return { ok: false, reason: 'no_store' };
  }
  if (!parsed?.ok) {
    await reply(lineForReason(parsed?.reason ?? 'format'));
    return { ok: false, reason: String(parsed?.reason ?? 'format'), action: parsed?.action };
  }

  if (!message || message.scene !== 'group') {
    log.warn('收藏：不是群消息，忽略');
    return { ok: false, reason: 'not_group', action: parsed.action };
  }
  if (!String(message.targetId ?? '').trim()) {
    log.warn('收藏：群消息没有 targetId，忽略');
    return { ok: false, reason: 'no_target', action: parsed.action };
  }

  const scope = catalogScopeFor(message);
  try {
    if (parsed.action === 'list') {
      const query = {
        text: parsed.text ?? null,
        filters: parsed.filters ?? {},
        sort: parsed.sort ?? 'recent',
        page: parsed.page ?? 1,
        pageSize,
      };
      let result;
      try {
        result = store.listFavorites(query);
      } catch (err) {
        if (err instanceof CatalogQueryError) {
          log.info(`收藏夹：查询被拒绝（${err.reason}）：${err.message}`);
          await reply(err.reason === 'unsupported' ? DEFAULT_CATALOG_LINES.unsupported : DEFAULT_CATALOG_LINES.format);
          return { ok: false, reason: err.reason, action: 'list' };
        }
        throw err;
      }

      // 最近清单只记**当前群+人**这一次的稳定条目 ID；空清单也覆盖，避免旧序号还可用。
      store.saveLastList({
        ...scope,
        query,
        itemIds: result.items.map((item) => item.id),
        page: result.page,
        total: result.total,
      });
      await reply(formatCatalogList({
        items: result.items,
        page: result.page,
        total: result.total,
        pageSize,
        filters: query.filters,
        text: query.text,
      }));
      return { ok: true, reason: 'ok', action: 'list', sent: 1 };
    }

    if (parsed.action === 'unfavorite') {
      let resolved;
      if (parsed.ordinal) {
        resolved = itemFromOrdinal(store, scope, parsed.ordinal);
      } else {
        resolved = findLocalItem(store, parsed.target);
        if (!resolved) resolved = { ok: false, reason: 'not_found' };
      }
      if (!resolved.ok) {
        // 不认识这个条目 = 本来就没收藏；不需要联网确认。
        if (resolved.reason === 'no_list' || resolved.reason === 'ordinal_missing') {
          await reply(lineForReason(resolved.reason));
          return { ok: false, reason: resolved.reason, action: 'unfavorite' };
        }
        await reply(DEFAULT_CATALOG_LINES.alreadyEmpty);
        return { ok: false, reason: 'not_favorite', action: 'unfavorite' };
      }
      const removed = store.removeFavorite({
        source: resolved.item.source,
        entityType: resolved.item.entityType,
        sourceId: resolved.item.sourceId,
      });
      if (!removed.removed) {
        await reply(`没收藏过：${displayItemId(resolved.item)}${titleOf(resolved.item)}`);
        return { ok: false, reason: 'not_favorite', action: 'unfavorite' };
      }
      await reply(`已取消收藏：${displayItemId(resolved.item)}${titleOf(resolved.item)}`);
      return { ok: true, reason: 'ok', action: 'unfavorite', sent: 1 };
    }

    if (parsed.action === 'favorite') {
      const resolved = await resolveFavoriteTarget({
        store, provider, target: parsed.target, ordinal: parsed.ordinal, scope, log,
      });
      if (!resolved.ok) {
        if (resolved.reason === 'ambiguous' && Array.isArray(resolved.candidates)) {
          await reply(formatCandidateList(resolved.candidates));
          return { ok: false, reason: 'ambiguous', action: 'favorite' };
        }
        await reply(lineForReason(resolved.reason));
        return { ok: false, reason: String(resolved.reason), action: 'favorite' };
      }

      const added = store.addFavorite({
        item: resolved.item,
        tags: parsed.tags ?? [],
        actorId: scope.actorId,
      });
      const suspects = added.created
        ? store.findSuspectedDuplicates({
          title: added.item.title,
          creators: added.item.creators ?? [],
          excludeItemId: added.itemId,
        })
        : [];
      const requestedDisplay = resolved.resolvedFrom === 'unit'
        ? displayItemId({ source: resolved.item.source, sourceId: String(parsed.target?.id ?? '') })
        : '';
      await reply(formatFavoriteAck({
        item: added.item,
        created: added.created,
        requestedId: resolved.resolvedFrom === 'unit' ? String(parsed.target?.id ?? '') : '',
        requestedDisplay,
        tags: added.item.userTags ?? [],
        suspects,
      }));
      return {
        ok: true,
        reason: added.created ? 'ok' : 'already',
        action: 'favorite',
        sent: 1,
        created: added.created,
      };
    }

    await reply(DEFAULT_CATALOG_LINES.format);
    return { ok: false, reason: 'unknown_action' };
  } catch (err) {
    log.error('收藏：处理失败', err);
    try {
      await reply(DEFAULT_CATALOG_LINES.internal);
    } catch (replyErr) {
      log.warn(`收藏：失败回话也没发出去：${replyErr?.message ?? replyErr}`);
    }
    return { ok: false, reason: 'internal', action: parsed.action };
  }
}
