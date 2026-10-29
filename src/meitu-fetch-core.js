/**
 * 美图抓取的**检索编排**层(2026-10-27,从 `scripts\meitu-fetch-one.mjs` 挪出来 —— D159:
 * 「提前停止」这一段出过真 bug,不提取就没法写不联网的判据,bug 就只能等群里再咬一次)。
 *
 * 只做「按 rung 依次查询 → 过筛 → 收集」,**自己不发网络请求**:
 * `fetchJson` / `rungUrl` 由调用方注入(CLI 传真 fetch,判据传假 fetch)。
 *
 * ⚠️ 提前停止的计数口径(2026-10-27 修「假没图」,本文件存在的理由):
 *   必须数**真正可用的新图**,不是"文件名没见过的条数"。旧口径在 md5 去重/历史过滤
 *   发生**之前**数 `!exists(文件名)`,于是:
 *   · 历史图换个图源(文件名不同)被当新图,把预算(2×count)吃满 → 提前停止;
 *   · 随后 md5/历史过滤把候选删空 → 回 no_result,后面的 rung/页**从未被查询**;
 *   · 不支持的扩展名(gif/webp)同样虚增预算。
 *   新口径 `newCount()` = 批内跨源 md5 去重 → 历史 md5 过滤 → pickNewPosts
 *   (同源同 id / 扩展名 / url / 已存在)之后的条数 —— 与 main 里最终挑选**同一个判据**。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  dedupeByMd5,
  filterPosts,
  normalizeDanbooruPost,
  normalizeMd5,
  normalizeSafebooruPost,
  pickNewPosts,
} from './meitu-search.js';
import { filterUnseen } from './meitu-index.js';
import { imageFileName } from './meitu-store.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一个 rung 的**游标键**。同一源在同一档里可能有多个查询(角色+修饰 / 纯 rating / 兜底),
 * 它们的分页空间互相独立 —— 游标必须按 rung 记,不能按源共用(唯一实现,D159)。
 * @param {{source: string, tags: string[]}} rung
 * @returns {string}
 */
export function rungCursorKey(rung) {
  return `${String(rung?.source ?? '')}:${(rung?.tags ?? []).join(' ')}`;
}

/**
 * 这张帖子这个看客**已经看过没有**(2026-10-28「按群去重」的唯一判据实现)。
 * 有 md5 按内容身份;没 md5 退回 `source:source_id`。`seen.md5s` / `seen.ids` 由
 * 调用方从发送账(`gallery.seenForGroup(group)`)取来 —— 本函数不做任何 IO。
 * @param {{source: string|number, id: string|number, md5?: string}} post
 * @param {{md5s?: Set<string>, ids?: Set<string>}} seen
 * @returns {boolean}
 */
export function isSeenPost(post, seen) {
  const md5s = seen?.md5s instanceof Set ? seen.md5s : new Set();
  const ids = seen?.ids instanceof Set ? seen.ids : new Set();
  const md5 = normalizeMd5(post?.md5);
  if (md5 && md5s.has(md5)) return true;
  return ids.has(`${String(post?.source ?? '')}:${String(post?.id ?? '')}`);
}

/**
 * 按群去重时,这张帖子在角色目录里**有没有可直接复用的文件**(2026-10-28):
 * ① 同源同 id 的标准文件名;② 旁挂 md5 索引指到的另一个文件名(同一内容换图源收录过的)。
 * 都没有 = `null`(要走下载)。只读 fs,不下载、不写盘。
 * @param {{source: string, id: string|number, ext?: string, md5?: string}} post
 * @param {string} outDir 角色目录
 * @param {Map<string, string>} md5Entries 旁挂 md5 索引(`loadMd5Index().entries`)
 * @returns {{path: string, via: 'filename'|'md5-index'} | null}
 */
export function reuseTargetFor(post, outDir, md5Entries = new Map()) {
  if (!outDir || !post?.source || post?.id === undefined || post?.id === null) return null;
  const ext = String(post.ext ?? '').replace(/^\./, '');
  const target = path.join(outDir, imageFileName(post.source, post.id, ext));
  if (fs.existsSync(target)) return { path: target, via: 'filename' };
  const md5 = normalizeMd5(post.md5);
  if (md5) {
    const known = md5Entries instanceof Map ? md5Entries.get(md5) : undefined;
    if (typeof known === 'string' && known) {
      const alt = path.join(outDir, known);
      if (fs.existsSync(alt)) return { path: alt, via: 'md5-index' };
    }
  }
  return null;
}

/**
 * 按 rung 顺序检索,攒够 `count * 2` 张**去重后可用**的新图就停(2 倍是下载失败的缓冲,
 * 数字沿用 2026-10-23 的口径【暂定】)。
 *
 * @param {object} options
 * @param {Array<{source: string, tags: string[], ratingAllow: string[]}>} options.rungs
 *   `buildRungs` 的产物。
 * @param {string} options.charTag 角色 tag(过筛 `requireTags` 用)。
 * @param {number} options.count 本轮要的张数(预算 = count×2)。
 * @param {string} [options.outDir] 落盘目录(`exists` 判已存在;dry/空 = 全当新图)。
 * @param {boolean} [options.dry] 探针模式:不判已存在。
 * @param {Map<string,string>} [options.md5Known] 要从"可用新图"里排除的 md5 集
 *   (`Map<md5, 任意值>`;2026-10-28 起语义由调用方定:按群去重时传**该群已看过**的,
 *   旧的全库口径才传旁挂 md5 索引 —— "库里有"不再等于"不能发")。
 * @param {(rung: object, charTag: string, page: number) => string} options.rungUrl
 *   URL 构造(实现只有 `meitu-search.js` 那一份,CLI 包一层页码口径)。
 * @param {(url: string) => Promise<object[]>} options.fetchJson 注入的查询口(CLI 传真 fetch)。
 * @param {number} [options.gapMs] 页间间隔(CLI 传 REQUEST_GAP_MS;判据传 0)。
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.pagesPerRung] 每 rung 最多几页。
 * @param {number} [options.pageLimit] 单页条数(不足 = 图源翻到底了)。
 * @param {Map<string, number>} [options.cursor] 翻页游标(`loadCursor()` 的产物,
 *   键 = `rungCursorKey(rung)`,值 = 下一次起始页索引(0 起)。缺页 = 从 0 扫)。
 *   2026-10-28「热门续查」:没有游标时每条指令都从第 1 页撞同一批头部图;
 *   有了它,每轮从**没翻过的页**接着扫,翻到底自动回卷(新上传会回到头部被扫到)。
 *   游标是**效率优化不是正确性机制** —— 重复扫页由 md5 去重兜底,不会重复下载。
 * @param {boolean} [options.reuseOnDisk] 盘上已有的文件**算可用新图**(按群去重:
 *   复用发送,不重复下载)。默认 false = 旧全库口径(盘上已有的直接排除)。
 * @returns {Promise<{collected: object[], rungLog: object[], anyHttpOk: boolean,
 *   exists: (post: object) => boolean,
 *   cursorUpdates: Array<{key: string, value: number}>}>}
 *   `cursorUpdates` = 本轮要写回的游标增量(调用方负责持久化;dry/写失败顶多下轮多扫几页):
 *   `value = 起始页 + 实际翻过的页数`;最后翻的一页不满页 = 图源见底 → `value = 0`(回卷);
 *   一页都没翻成(查询失败/预算满直接跳过)的 rung **不产生**增量(失败页下轮重试)。
 */
export async function searchRungs({
  rungs,
  charTag,
  count,
  outDir = '',
  dry = false,
  md5Known = new Map(),
  rungUrl,
  fetchJson,
  gapMs = 0,
  log = () => {},
  pagesPerRung = 2,
  pageLimit = 100,
  cursor = new Map(),
  reuseOnDisk = false,
}) {
  if (typeof fetchJson !== 'function') throw new TypeError('searchRungs 需要注入 fetchJson(网络只许在调用方)');
  if (typeof rungUrl !== 'function') throw new TypeError('searchRungs 需要注入 rungUrl(URL 构造只有 meitu-search 一份)');

  const collected = [];
  const rungLog = [];
  const cursorUpdates = [];
  let anyHttpOk = false;
  const exists = (post) => {
    if (dry || !outDir) return false;
    const ext = String(post.ext ?? '').replace(/^\./, '');
    return fs.existsSync(path.join(outDir, imageFileName(post.source, post.id, ext)));
  };
  /**
   * **去重之后**还剩几张真正可用的新图 —— 提前停止只认这个数。
   * `md5Known` 的语义由调用方定(2026-10-28 起是"这个看客已看过的 md5",不再默认全库索引);
   * `reuseOnDisk`(按群去重)= 盘上已有的文件**算可用**(复用发送,不重复下载),
   * 旧的全库口径(false)= 盘上已有的直接排除。
   */
  const newCount = () => {
    const unseen = filterUnseen(dedupeByMd5(collected).kept, md5Known);
    return pickNewPosts(unseen.kept, { count: Number.MAX_SAFE_INTEGER, fileExists: reuseOnDisk ? () => false : exists }).length;
  };

  for (const rung of rungs) {
    if (newCount() >= count * 2) break;
    const startPage = cursor.get(rungCursorKey(rung)) ?? 0;
    const entry = {
      source: rung.source,
      query: rungUrl(rung, charTag, startPage).split('tags=')[1]?.split('&')[0] ?? '',
      tags: rung.tags.join(' '),
      ratingAllow: rung.ratingAllow,
      startPage,
      pages: 0,
      posts: 0,
      error: null,
    };
    for (let offset = 0; offset < pagesPerRung; offset += 1) {
      const page = startPage + offset;
      const url = rungUrl(rung, charTag, page);
      let raw;
      try {
        raw = await fetchJson(url);
        anyHttpOk = true;
      } catch (err) {
        entry.error = err?.message ?? String(err);
        log(`${rung.source} 查询失败(${rung.tags.join(' ') || '无修饰'} / 第 ${page + 1} 页):${entry.error}`);
        break;
      }
      entry.pages += 1;
      const posts = raw
        .map((item) => (rung.source === 'danbooru' ? normalizeDanbooruPost(item) : normalizeSafebooruPost(item)))
        .filter((post) => post.url);
      entry.posts += posts.length;
      const passed = filterPosts(posts, { ratingAllow: rung.ratingAllow, requireTags: [charTag] });
      collected.push(...passed);
      log(`${rung.source} 第 ${page + 1} 页:${posts.length} 条,过筛 ${passed.length} 条`);
      await wait(gapMs);
      if (posts.length < pageLimit) {
        // 图源见底:回卷到 0(新上传会回到头部,下一轮自然被扫到)。
        cursorUpdates.push({ key: rungCursorKey(rung), value: 0 });
        break;
      }
      if (newCount() >= count * 2) break;
    }
    if (entry.pages > 0 && entry.error === null) {
      const next = startPage + entry.pages;
      // 没因"见底"回卷才向前推进(见底已在循环里写了回卷增量)。
      if (!cursorUpdates.some((item) => item.key === rungCursorKey(rung))) {
        cursorUpdates.push({ key: rungCursorKey(rung), value: next });
      }
    }
    rungLog.push(entry);
    if (newCount() >= count * 2) break;
  }

  return { collected, rungLog, anyHttpOk, exists, cursorUpdates };
}
