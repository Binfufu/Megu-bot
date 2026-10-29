/**
 * 图源查询的**纯函数**层(2026-10-23,代码层发图)。
 *
 * 只做"拼 URL / 归一化 / 过滤 / 挑图 / rung 构造"——**不发网络请求**,所以单测不用碰网。
 * 真正抓取在 `scripts\meitu-fetch-one.mjs`(独立 CLI,被 bot 子进程 spawn)。
 *
 * 口径(需求定义,不是额外审查;2026-10-23 主人拍板的**两条检索路径**):
 *   · **美图档**(`tier='meitu'`)= 正常的 r13 偏全年龄唯美:
 *     Danbooru rating ∈ {general, sensitive};Safebooru = safe。
 *   · **涩图档**(`tier='seitu'`,默认)= 现在的擦边:Danbooru ∈ {sensitive, questionable};
 *     Safebooru = questionable。
 *   · 两个图源、两个档都**不抓 explicit**。
 *   · **疑似未成年外观标签黑名单 fail-closed**(`MINOR_TAGS` / `isBlockedPost`):
 *     命中即整张跳过(不下载不发送)。判定 = post 全部标签 token 化(下划线也算分隔),
 *     任一 token 命中黑名单词、或以它开头/结尾(`lolicon` / `oppai_loli` 都算)。
 *   · 除以上两条**不加任何内容限制**:不搬旧工具的 mature 白名单、不搬人外过滤。
 */

/** 能下载/发送的扩展名(不带点)。只认这三种:手机与 QQ 最稳。 */
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png'];

/**
 * 疑似未成年外观的标签黑名单。**fail-closed**:命中一个就跳过整张。
 *
 * ⚠️ 这张表只增不减要主人点头;匹配是"前缀/后缀"级的(见 `isBlockedPost`),
 *    所以宁可多拦(`babysitter` 会被 `baby` 拦下),也不放过。
 */
export const MINOR_TAGS = [
  'loli',
  'shota',
  'child',
  'children',
  'toddler',
  'infant',
  'baby',
  'kids',
  'kid',
  'aged_down',
  'child_on_child',
  'underage',
  'cub',
];

/** 把 ext 统一成"不带点的小写"(`JPG` / `.jpeg` 都归一)。 */
function normalizeExt(ext) {
  return String(ext ?? '').replace(/^\./, '').trim().toLowerCase();
}

/** 一枚合法 md5 = 32 位十六进制(大小写不敏感)。 */
const MD5_RE = /^[0-9a-f]{32}$/u;

/**
 * 归一化一枚 md5:去空白 + 小写;不是 32 位十六进制就返回空串。
 *
 * **形状判据只有这一份**(D159):下载前去重与旁挂索引(`src\meitu-index.js`)共用它。
 * 返回空串的语义 = "这张图没有可用的 md5",调用方一律**放过**(靠文件名兜底,别误删)。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMd5(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return MD5_RE.test(text) ? text : '';
}

/**
 * Danbooru 的 `rating` 是**单个字母**(g/s/q/e),而 Safebooru 是整词。
 * 归一化层统一成整词 —— 否则"只收 sensitive/questionable"那条过滤会永远空。
 */
const DANBOORU_RATINGS = { g: 'general', s: 'sensitive', q: 'questionable', e: 'explicit' };

function normalizeDanbooruRating(value) {
  const rating = String(value ?? '').toLowerCase();
  return DANBOORU_RATINGS[rating] ?? rating;
}

/**
 * 从文件 URL 里取扩展名(**不带点**);不是 jpg/jpeg/png 就返回空串。
 *
 * 为什么只认这三种:扩展名是"发不发得出去"的一部分,webp/gif 在这条链路上没验过。
 * @param {string} url
 */
export function extFromUrl(url) {
  const text = String(url ?? '');
  if (!text) return '';
  let pathname = text;
  try {
    pathname = new URL(text).pathname;
  } catch {
    pathname = text.split(/[?#]/)[0];
  }
  const match = /\.([a-z0-9]+)$/i.exec(pathname);
  const ext = match ? match[1].toLowerCase() : '';
  return IMAGE_EXTS.includes(ext) ? ext : '';
}

/**
 * Danbooru 的查询 URL。
 *
 * tag 总数 ≤2:角色 + **第一个**修饰;没有修饰就用 `rating:questionable`
 * (这条默认口径等价于"擦边")。
 *
 * ⚠️ `tags` **不传**(undefined)才默认追加 `rating:questionable`;
 *    显式传空数组 = "只要角色本身"—— 抓取器的 general 兜底 rung 靠这个。
 *    (真跑 dry 探针时发现:若空数组也追加 rating:questionable,那个兜底 rung
 *     会先被 rating:questionable 限定、再被 ratingAllow=['general'] 全滤掉 = 永远空。)
 *
 * @param {{charTag: string, tags?: string[], page?: number}} params
 */
export function buildDanbooruUrl({ charTag, tags, page = 1 }) {
  const list = [String(charTag ?? '').trim()];
  if (tags === undefined) {
    list.push('rating:questionable');
  } else {
    const extra = (tags ?? []).map((tag) => String(tag ?? '').trim()).filter(Boolean)[0];
    if (extra) list.push(extra);
  }
  const query = list.filter(Boolean).join(' ');
  const pageNo = Number.isSafeInteger(page) && page > 0 ? page : 1;
  return `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(query)}&limit=100&page=${pageNo}`;
}

/**
 * Safebooru 的查询 URL。
 *
 * 它走老式 `dapi`:排序也是 tag(`sort:score`),所以这里统一追加。
 * @param {{charTag: string, tags?: string[], pid?: number}} params `pid` 从 0 开始
 */
export function buildSafebooruUrl({ charTag, tags = [], pid = 0 }) {
  const list = [String(charTag ?? '').trim(), ...(tags ?? []).map((tag) => String(tag ?? '').trim()), 'sort:score']
    .filter(Boolean);
  const page = Number.isSafeInteger(pid) && pid >= 0 ? pid : 0;
  return 'https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=100'
    + `&pid=${page}&tags=${encodeURIComponent(list.join(' '))}`;
}

/**
 * Danbooru `posts.json` 的一条 post → 统一形状。
 * @param {object} post
 */
export function normalizeDanbooruPost(post) {
  const p = post ?? {};
  return {
    source: 'danbooru',
    id: Number.isSafeInteger(Number(p.id)) ? Number(p.id) : p.id,
    rating: normalizeDanbooruRating(p.rating),
    tags: typeof p.tag_string === 'string' ? p.tag_string : '',
    url: p.file_url ?? p.large_file_url ?? '',
    ext: normalizeExt(p.file_ext) || extFromUrl(p.file_url ?? p.large_file_url),
    // md5 字段 = 原图内容的 md5(实测 3/3 与下载到盘上的文件一致);去重就靠它。
    md5: typeof p.md5 === 'string' ? p.md5.toLowerCase() : '',
    score: Number(p.score) || 0,
    width: Number(p.image_width) || 0,
    height: Number(p.image_height) || 0,
  };
}

/**
 * Safebooru `dapi` 的一条 post → 统一形状。
 * @param {object} post
 */
export function normalizeSafebooruPost(post) {
  const p = post ?? {};
  const url = p.file_url
    ?? (p.directory && p.image ? `https://safebooru.org/images/${p.directory}/${p.image}` : '');
  return {
    source: 'safebooru',
    id: Number.isSafeInteger(Number(p.id)) ? Number(p.id) : p.id,
    rating: String(p.rating ?? '').toLowerCase(),
    tags: typeof p.tags === 'string' ? p.tags : '',
    url,
    ext: extFromUrl(url) || normalizeExt(p.image ? String(p.image).split('.').pop() : ''),
    // ⚠️ Safebooru dapi 的字段名叫 `hash`(不是 md5),同为 32 位小写 md5。
    md5: typeof p.hash === 'string' ? p.hash.toLowerCase() : '',
    score: Number(p.score) || 0,
    width: Number(p.width) || 0,
    height: Number(p.height) || 0,
  };
}

// ---------------------------------------------------------------------------
// 跨源 md5 去重(2026-10-23,主人拍板:索引放旁挂文件、不动文件名规则)
// ---------------------------------------------------------------------------

/** 图源优先级:同 md5 留哪张。danbooru 优先(主人拍板);不认识的图源排最后。 */
const SOURCE_RANK = { danbooru: 0, safebooru: 1 };

function sourceRank(source) {
  return SOURCE_RANK[String(source ?? '').toLowerCase()] ?? 2;
}

/** id 比较:能当数字比就数字比(1 < 2 < 10),否则按字符串。 */
function comparePostId(a, b) {
  const na = Number(a?.id);
  const nb = Number(b?.id);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''), 'en', { numeric: true });
}

/**
 * 按 md5 **跨源去重**(下载前)。同一张图在两个图源各有一条时只留一条:
 *   ① 图源 `danbooru` > `safebooru`(同一张图优先留 danbooru —— 主人拍板);
 *   ② 同图源内 **score 高者**;
 *   ③ 再 **id 小者**。
 *
 * ⚠️ **无 md5(或 md5 非法)的帖子原样保留、不参与去重** —— 它们靠文件名
 * `${source}_${id}` 兜底(少删一张总比删错强)。
 *
 * 返回的 `kept` **保持入参顺序**(只把输家拿掉);`dropped` 是输家数组,给日志用。
 * @param {Array<object>} posts
 * @returns {{kept: Array<object>, dropped: Array<object>}}
 */
export function dedupeByMd5(posts) {
  const list = (posts ?? []).filter(Boolean);
  const winnerIndex = new Map(); // md5 -> 入参下标(用下标而不是对象:同一对象出现两次也能判)
  const dropped = [];

  const isBetter = (candidate, current) => {
    const sourceDiff = sourceRank(candidate.source) - sourceRank(current.source);
    if (sourceDiff !== 0) return sourceDiff < 0;
    const scoreDiff = (Number(candidate.score) || 0) - (Number(current.score) || 0);
    if (scoreDiff !== 0) return scoreDiff > 0;
    return comparePostId(candidate, current) < 0;
  };

  for (let i = 0; i < list.length; i += 1) {
    const post = list[i];
    const md5 = normalizeMd5(post.md5);
    if (!md5) continue;
    const current = winnerIndex.get(md5);
    if (current === undefined) {
      winnerIndex.set(md5, i);
      continue;
    }
    if (isBetter(post, list[current])) {
      winnerIndex.set(md5, i);
      dropped.push(list[current]);
    } else {
      dropped.push(post);
    }
  }

  const kept = [];
  for (let i = 0; i < list.length; i += 1) {
    const md5 = normalizeMd5(list[i].md5);
    if (md5 && winnerIndex.get(md5) !== i) continue;
    kept.push(list[i]);
  }
  return { kept, dropped };
}

/**
 * 这张图带不带"疑似未成年外观"的标签。**fail-closed**:
 * 标签缺失/读不出来也算拦(没法核对,就不发)。
 *
 * 匹配粒度:整个标签(小写)+ 它按下划线/非字母数字切出来的每个 token;
 * 任一段**等于**黑名单词、或以它**开头/结尾**都算命中 ——
 * `oppai_loli`、`lolicon`、`child_on_child`、`aged_down` 因此都会命中。
 *
 * @param {{tags?: string|string[]}} post
 */
export function isBlockedPost(post) {
  const raw = Array.isArray(post?.tags) ? post.tags.join(' ') : String(post?.tags ?? '');
  const text = raw.trim().toLowerCase();
  if (!text) return true;
  const candidates = new Set();
  for (const chunk of text.split(/\s+/u)) {
    if (!chunk) continue;
    candidates.add(chunk);
    for (const token of chunk.split(/[^a-z0-9]+/u)) {
      if (token) candidates.add(token);
    }
  }
  for (const candidate of candidates) {
    for (const word of MINOR_TAGS) {
      if (candidate === word || candidate.startsWith(word) || candidate.endsWith(word)) return true;
    }
  }
  return false;
}

/**
 * 过滤:rating 白名单 + 必须带的 tag + 黑名单 fail-closed。
 *
 * @param {Array<object>} posts
 * @param {{ratingAllow?: string[], requireTags?: string[]}} [options]
 *   `ratingAllow` 空/未给 = 不按 rating 过滤(调用方永远该给)。
 */
export function filterPosts(posts, { ratingAllow, requireTags = [] } = {}) {
  const allow = Array.isArray(ratingAllow) && ratingAllow.length > 0
    ? new Set(ratingAllow.map((rating) => String(rating).toLowerCase()))
    : null;
  const required = (requireTags ?? [])
    .map((tag) => String(tag ?? '').trim().toLowerCase())
    .filter(Boolean);
  return (posts ?? []).filter((post) => {
    if (!post) return false;
    if (allow) {
      const rating = String(post.rating ?? '').toLowerCase();
      if (!allow.has(rating)) return false;
    }
    if (required.length > 0) {
      const have = new Set(
        String(post.tags ?? '').toLowerCase().split(/\s+/u).filter(Boolean),
      );
      for (const tag of required) {
        if (!have.has(tag)) return false;
      }
    }
    return !isBlockedPost(post);
  });
}

/**
 * 挑新图:score 从高到低、去重(同图源同 id)、跳过已存在的文件、只留 jpg/jpeg/png。
 *
 * @param {Array<object>} posts
 * @param {{count?: number, fileExists?: (post: object) => boolean}} [options]
 *   `fileExists` 由调用方按自己的目录实现(CLI 里查 `${source}_${id}.${ext}`)
 */
export function pickNewPosts(posts, { count = 1, fileExists } = {}) {
  const limit = Number.isSafeInteger(count) && count > 0 ? count : 1;
  const exists = typeof fileExists === 'function' ? fileExists : () => false;
  const seen = new Set();
  const sorted = [...(posts ?? [])]
    .filter(Boolean)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

  const picked = [];
  for (const post of sorted) {
    const key = `${post.source}:${post.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ext = normalizeExt(post.ext);
    if (!IMAGE_EXTS.includes(ext)) continue;
    if (!post.url) continue;
    if (exists(post)) continue;
    picked.push({ ...post, ext });
    if (picked.length >= limit) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// rung(查询批次)构造 —— 2026-10-23 从 `scripts\meitu-fetch-one.mjs` 挪进来:
// 一份实现(D159),CLI 与服务层(被拦降档)都从这里拿。
// ---------------------------------------------------------------------------

const RATING_TAG_RE = /^rating:/iu;

/** Safebooru 没有叫 `general` 的档,它的等价物叫 `safe`;其余词原样透传。 */
const SAFEBORU_RATING_ALIASES = { general: 'safe' };

/** 覆盖档:字符串或数组都收;剔完空白一个不剩 = 没给 override(返回 null)。 */
function normalizeRatingOverride(ratingOverride) {
  const list = Array.isArray(ratingOverride) ? ratingOverride : (ratingOverride ? [ratingOverride] : []);
  const words = list.map((word) => String(word ?? '').trim().toLowerCase()).filter(Boolean);
  return words.length > 0 ? words : null;
}

/**
 * 构造本次要依次尝试的 rung 列表。
 *
 * 一个 rung = 一次图源 + 一组查询 tag + 一组允许的 rating。
 * `charTag` 在签名里带着(调用方按角色传),但查询限定走 tags/rating —— 与旧 CLI 一致。
 *
 * @param {{charTag?: string, tags?: string[], source?: string, proxyReady?: boolean,
 *          ratingOverride?: string[]|string, tier?: 'meitu'|'seitu'}} params
 *   · `tags`      修饰 tag(实际查询每个 rung 只带第一个,与旧 CLI 一致);
 *   · `source`    auto / danbooru / safebooru;
 *   · `proxyReady` 代理是否可用(auto 时 Danbooru 只在可用时进候选);
 *   · `tier`      检索档位(2026-10-23 主人拍板的两条检索路径):
 *                   - `seitu`(**默认**,1.179.x 原行为)= 擦边图:Danbooru sensitive/questionable、
 *                     Safebooru questionable(兜底 safe);永不收 explicit;
 *                   - `meitu` = 美图:正常的 r13 偏全年龄唯美 —— Danbooru general+sensitive
 *                     (查询先 `rating:s` 收偏上的唯美,Safebooru 走 `safe`);不收 questionable。
 *   · `ratingOverride` **降档用**(如 `['general']`):给出时所有 rung 的 ratingAllow
 *     都换成它(danbooru 用原词,safebooru 的 `general` 映射 `safe`),**且 rung tags
 *     里的 `rating:*` 项剔除** —— 否则「查 questionable 再用 general 过滤」永远空
 *     (CLI 里那个 general 兜底 rung 的教训同理)。换档后塌成同一条的 rung 去重。
 *     不给 = 按 tier 的默认口径。
 * @returns {Array<{source: string, tags: string[], ratingAllow: string[]}>}
 */
export function buildRungs({ charTag, tags = [], source = 'auto', proxyReady = false, ratingOverride, tier = 'seitu' } = {}) {
  void charTag;
  const override = normalizeRatingOverride(ratingOverride);
  const rungs = [];
  const seen = new Set();
  const push = (rungSource, rungTags, ratingAllow) => {
    const cleanTags = override
      ? rungTags.filter((tag) => !RATING_TAG_RE.test(String(tag)))
      : [...rungTags];
    const allow = override
      ? (rungSource === 'safebooru'
        ? override.map((word) => SAFEBORU_RATING_ALIASES[word] ?? word)
        : [...override])
      : [...ratingAllow];
    // override 换档后,不同 rung 可能塌成同一条 —— 再查一遍只会白打两页请求,去重。
    const key = `${rungSource}|${cleanTags.join(' ')}|${allow.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    rungs.push({ source: rungSource, tags: cleanTags, ratingAllow: allow });
  };

  const wantDanbooru = source !== 'safebooru';
  // 「仅可走代理时」:显式 --source danbooru 时仍然试一次直连(可能本机可达)。
  const danbooruUsable = proxyReady || source === 'danbooru';

  if (wantDanbooru && danbooruUsable) {
    if (tier === 'meitu') {
      // 美图 = r13 偏全年龄唯美:g + s,不收 questionable/explicit。
      if (tags[0]) {
        push('danbooru', [tags[0]], ['general', 'sensitive']);
      }
      push('danbooru', ['rating:s'], ['general', 'sensitive']);
      // 兜底:纯全年龄。
      push('danbooru', [], ['general']);
    } else {
      if (tags[0]) {
        push('danbooru', [tags[0]], ['sensitive', 'questionable']);
      }
      push('danbooru', ['rating:questionable'], ['sensitive', 'questionable']);
      push('danbooru', ['rating:sensitive'], ['sensitive', 'questionable']);
      // 兜底:前三个 rung 都没图时才允许 general(仍然不收 explicit)。
      push('danbooru', [], ['general']);
    }
  }

  const wantSafebooru = source !== 'danbooru';
  if (wantSafebooru) {
    if (tier === 'meitu') {
      // Safebooru 的全年龄档叫 safe(g/s 的并集口径)。
      if (tags[0]) {
        push('safebooru', [tags[0], 'rating:safe'], ['safe']);
      }
      push('safebooru', ['rating:safe'], ['safe']);
    } else {
      if (tags[0]) {
        push('safebooru', [tags[0], 'rating:questionable'], ['questionable']);
      }
      push('safebooru', ['rating:questionable'], ['questionable']);
      // 兜底:questionable 没图时才允许 safe(仍然不收 explicit)。
      push('safebooru', [], ['safe']);
    }
  }
  return rungs;
}
