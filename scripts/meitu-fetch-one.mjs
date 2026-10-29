#!/usr/bin/env node
/**
 * 「发N张<角色>美图」的**抓取器**(2026-10-23,代码层发图;独立 CLI)。
 *
 * bot 以子进程 spawn 它(`src\meitu-service.js`),它只做三件事:
 *   ① 按 rung 依次查图源 → ② 过滤(rating / 黑名单 fail-closed / 已存在) → ③ 下载落盘。
 * stdout **最后一行**是 JSON(成功/失败都是单条),日志一律走 stderr —— 所以退出码恒 0,
 * 调用方只认那条 JSON(可读的失败比"崩了"好排查)。
 *
 * 用法:
 *
 *     node scripts\meitu-fetch-one.mjs --char demo_a --tags feet --count 1 \
 *       --out %TEMP%\meitu-probe --source auto --proxy http://127.0.0.1:7890 --dry
 *
 * 参数:
 *   --char <tag>          角色 tag(必填;中文名由别名表在上层翻好)
 *   --tags <t1,t2>        修饰 tag(最多取前 2 个,实际查询按 rung 只带第一个)
 *   --count N             要几张(默认 1)
 *   --out <dir>           落盘目录(下载必填;`--dry` 可不填)
 *   --source auto|danbooru|safebooru  (默认 auto)
 *   --proxy <url>         **仅日志/自检**:真正的代理由父进程环境注入
 *                         (`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY/HTTP_PROXY`,本机实测可行)
 *   --max-bytes N         单张上限(默认 10MB【暂定】)
 *   --rating-allow <list> 逗号分隔的**档位覆盖**(如 `general`)—— 所有 rung 换成它,
 *                         且 rung tags 里的 rating:* 剔除(safebooru 的 general 映射 safe)。
 *                         服务层「被内容审核拦 → 降档补发 general 档」靠它;不给 = 按 --tier 默认口径。
 *   --tier meitu|seitu    检索档位(2026-10-23 主人拍板的两条检索路径,默认 seitu 保持旧行为):
 *                         meitu = 美图(g/s 偏全年龄唯美;safebooru=safe);
 *                         seitu = 涩图/擦边(sensitive/questionable;safebooru=questionable)。
 *   --db <path>           **元数据落库**(展览处刀 1):落盘成功后按现返回形状 upsert 一行 meitu_meta。
 *                         不给 = 按 env 推:`QQBOT_MEITU_DB`,否则状态库同级 `meitu.db`
 *                         (`QQBOT_STATE_DB=data\demo\state.db` → `data\demo\meitu.db`)。
 *                         推不出路径 = 跳过(绝不猜一个库去写,静默写错库比不写更糟)。
 *   --dry                 只搜索不下载
 *
 * 图源口径(需求定义):
 *   · 美图档:Danbooru 只收 general/sensitive,Safebooru 只收 safe;
 *   · 涩图档:Danbooru 前三个 rung 只收 sensitive/questionable,最后一个 rung 兜底 general;
 *     Safebooru 前两个 rung 只收 questionable,最后一个 rung 兜底 safe;
 *   · 两个图源、两个档都**不收 explicit**;疑似未成年外观标签一律整张跳过(`src\meitu-search.js`)。
 *   · Danbooru 只在"可走代理"或用户显式 `--source danbooru` 时进入候选;
 *     Safebooru 直连兜底(auto 模式下永远在)。
 *
 * 去重(2026-10-23 第二刀):
 *   · **下载前跨源 md5 合并**(`dedupeByMd5`):同一张图 danbooru / safebooru 各一条时
 *     只留一条(danbooru 优先,同源内 score 高者,再 id 小者);
 *   · **角色目录旁挂索引**(`<outDir>\.md5-index.json`,实现见 `src\meitu-index.js`):
 *     历史上下过的 md5 直接跳过 —— 文件名不同(跨源)也挡得住;索引落后于目录实际图片数时
 *     **重扫目录重建**;
 *   · 最后照旧用文件名 `${source}_${id}` 兜底(`pickNewPosts` 的 fileExists);
 *   · `--dry` 只读索引**不写**(探针不污染角色目录),stderr 日志带
 *     `跨源去重:N 张` / `索引里已有:N 张` / `索引重建:N 条`(只在 N>0 时打)。
 *
 * 历史目录(1.184.3 起,`--extra-dir`,可重复):
 *   · 分档落库后 `<outDir>` 是 `<根>\<r13|r18>\<角色>`;存量图还在旧结构 `<根>\<角色>`、
 *     另一档的同角色目录也可能有同一张图(美图/涩图在 sensitive 档口径重叠)——
 *     这些目录的 md5 并入本档索引重建结果,历史图不会被重复下载。
 *     目录不存在/读不了 = 跳过(旧结构可能从没建过,不是错误)。
 *
 * 翻页游标(2026-10-28「热门续查」):
 *   · `<outDir>\.fetch-cursor.json` 记住每个查询(按 `源:tag` 分键,分页空间互相独立)上次翻到哪;
 *   · 每条指令从**没翻过的页**接着扫(`--pages` 控制每查询最多几页,默认 2【暂定】),
 *     翻到底自动回卷 —— 图量大的角色不再每条指令都撞同一批头部图然后回「没有新的」;
 *   · 删掉游标文件 = 从头再扫;md5 去重兜底,重复扫页不会重复下载。
 *
 * 复用 `src\meitu-search.js` / `src\meitu-store.js` 的纯函数(URL 构造、归一化、过滤、
 * 文件名规则只有一份实现 —— 别在这里抄第二份)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDanbooruUrl,
  buildRungs,
  buildSafebooruUrl,
  dedupeByMd5,
  isBlockedPost,
  normalizeMd5,
  pickNewPosts,
} from '../src/meitu-search.js';
import { isSeenPost, reuseTargetFor, searchRungs } from '../src/meitu-fetch-core.js';
import { loadCursor, updateCursor } from '../src/meitu-cursor.js';
import { imageFileName } from '../src/meitu-store.js';
import { loadMeituAliases } from '../src/meitu-alias.js';
import { addMd5Entries, filterUnseen, loadMd5Index } from '../src/meitu-index.js';
import { meituDbPathFromStateDb, openMeituGallery } from '../src/meitu-gallery.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 图源要求的 UA(礼貌一点,别把自己伪装成浏览器)。 */
const USER_AGENT = 'qqbot-meitu/1.0 (personal use)';
const REQUEST_TIMEOUT_MS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 100;
const PAGES_PER_RUNG = 2;
const REQUEST_GAP_MS = 1000; // 【暂定】请求间隔
const DOWNLOAD_GAP_MS = 1000; // 【暂定】下载间隔
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 【暂定】10MB
const DEFAULT_COUNT = 1;

const log = (...parts) => {
  try {
    process.stderr.write(`[meitu] ${parts.join(' ')}\n`);
  } catch {
    // stderr 写不进去也不影响结果。
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = {
    char: '',
    tags: '',
    count: DEFAULT_COUNT,
    out: '',
    source: 'auto',
    proxy: '',
    maxBytes: DEFAULT_MAX_BYTES,
    ratingAllow: [],
    tier: 'seitu',
    db: '',
    extraDirs: [],
    pages: PAGES_PER_RUNG,
    group: '',
    dry: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    const next = () => {
      i += 1;
      return String(argv[i] ?? '');
    };
    switch (arg) {
      case '--char': options.char = next().trim(); break;
      case '--tags': options.tags = next().trim(); break;
      case '--count': options.count = Number.parseInt(next(), 10); break;
      case '--out': options.out = next().trim(); break;
      case '--source': options.source = next().trim().toLowerCase(); break;
      case '--proxy': options.proxy = next().trim(); break;
      case '--max-bytes': options.maxBytes = Number.parseInt(next(), 10); break;
      case '--rating-allow':
        options.ratingAllow = next().split(',').map((word) => word.trim()).filter(Boolean);
        break;
      case '--tier': options.tier = next().trim().toLowerCase(); break;
      case '--db': options.db = next().trim(); break;
      case '--extra-dir': options.extraDirs.push(next().trim()); break;
      case '--pages': options.pages = Number.parseInt(next(), 10); break;
      case '--group': options.group = next().trim(); break;
      case '--dry': options.dry = true; break;
      default:
        log(`忽略不认识的参数:${arg}`);
    }
  }
  if (!['auto', 'danbooru', 'safebooru'].includes(options.source)) {
    log(`--source 只能是 auto / danbooru / safebooru,收到 ${JSON.stringify(options.source)},按 auto 走`);
    options.source = 'auto';
  }
  if (!['meitu', 'seitu'].includes(options.tier)) {
    log(`--tier 只能是 meitu / seitu,收到 ${JSON.stringify(options.tier)},按 seitu 走`);
    options.tier = 'seitu';
  }
  if (!Number.isSafeInteger(options.count) || options.count <= 0) options.count = DEFAULT_COUNT;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) options.maxBytes = DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(options.pages) || options.pages <= 0) options.pages = PAGES_PER_RUNG;
  return options;
}

function rungUrl(rung, charTag, page) {
  return rung.source === 'danbooru'
    ? buildDanbooruUrl({ charTag, tags: rung.tags, page: page + 1 })
    : buildSafebooruUrl({ charTag, tags: rung.tags, pid: page });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  // Safebooru 在"没有结果"时会回一个**空 body**(不是 `[]`)—— 200 + 空 = 没图,不是故障。
  if (text.trim() === '') return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('响应不是 JSON 数组(图源可能在维护)');
  return parsed;
}

/** 文件头校验:只认 JPEG(FFD8)与 PNG(89504E47),且要和扩展名对得上。 */
function checkImageHeader(buffer, ext) {
  const jpeg = buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const png = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50
    && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (ext === 'png' && !png) throw new Error('文件头不是 PNG(下载可能被拦截了)');
  if ((ext === 'jpg' || ext === 'jpeg') && !jpeg) throw new Error('文件头不是 JPEG(下载可能被拦截了)');
  if (!jpeg && !png) throw new Error('文件头既不是 JPEG 也不是 PNG');
}

/**
 * 下载一张。先写 `.part` 再 rename —— 中断不会留下"看起来完整"的半张图。
 * @returns {Promise<{path: string}>}
 */
async function downloadPost(post, outDir, maxBytes) {
  const ext = String(post.ext ?? '').replace(/^\./, '').toLowerCase();
  const target = path.join(outDir, imageFileName(post.source, post.id, ext));
  if (fs.existsSync(target)) {
    log(`已存在,跳过:${target}`);
    return { path: target };
  }
  const part = `${target}.part`;
  let written = false;
  try {
    const response = await fetch(post.url, {
      headers: {
        'user-agent': USER_AGENT,
        ...(post.source === 'safebooru' ? { referer: 'https://safebooru.org/' } : {}),
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared && declared > maxBytes) throw new Error(`文件太大(${declared} > ${maxBytes})`);

    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`文件超过上限(${maxBytes} 字节)`);
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    checkImageHeader(buffer, ext);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(part, buffer);
    written = true;
    fs.renameSync(part, target);
    written = false;
    log(`已下载:${target}(${Math.round(buffer.length / 1024)}KB)`);
    return { path: target };
  } finally {
    if (written) {
      try { fs.rmSync(part, { force: true }); } catch { /* 删不掉不影响结果 */ }
    }
  }
}

function fail(reason, detail, rungs) {
  return { ok: false, reason, detail: String(detail ?? ''), rungs: rungs ?? [] };
}

/**
 * 元数据落库路径:显式 `--db` 优先,其次 env,最后"状态库同级的 meitu.db"。
 * 推不出来返回空串(后面就跳过落库 —— 静默写错库比不写更糟)。
 * ⚠️ fetch-one 由 `src\meitu-service.js` spawn,子进程继承了 bot 的环境变量
 * (例如 `QQBOT_STATE_DB=data\demo\state.db`),则派生路径为 `data\demo\meitu.db`。
 */
function resolveMetaDbPath(explicit) {
  const value = String(explicit ?? '').trim();
  if (value) return path.resolve(value);
  const envDb = String(process.env.QQBOT_MEITU_DB ?? '').trim();
  if (envDb) return path.resolve(envDb);
  const stateDb = String(process.env.QQBOT_STATE_DB ?? '').trim();
  if (stateDb) return meituDbPathFromStateDb(path.resolve(stateDb));
  return '';
}

/**
 * 落盘成功后的元数据埋点(展览处刀 1):按**现返回形状**(`{path, source, id, rating, url}`)落一行
 * `meitu_meta`。`tags/rating` 是现场就有的(`normalizeDanbooruPost` 的 `tags` 字段 = 全量标签),
 * 所以**不改返回形状**也能写全;角色用别名表反查(同一份 `data\meitu-alias.json`)。
 *
 * `gallery`(2026-10-28 按群去重)= 调用方已开好的连接(读发送账用的那一个),**借用不关闭**;
 * 不给才自己开(所有权在自己,close 时关掉)。
 *
 * 打不开库/写失败都只 warn,绝不拖垮抓取(图已经在盘上了,元数据下一轮回填可以补)。
 */
function createMetaSink({ dbPath, log, gallery: borrowed } = {}) {
  let gallery = borrowed ?? null;
  let owned = false;
  if (!gallery) {
    if (!dbPath) {
      log('没有可用的美图库路径(QQBOT_MEITU_DB / QQBOT_STATE_DB 都没给),跳过元数据落库');
      return null;
    }
    try {
      gallery = openMeituGallery({ dbPath });
      owned = true;
    } catch (err) {
      log(`美图库打不开(${dbPath}),跳过元数据落库:${err?.message ?? err}`);
      return null;
    }
  }
  const aliasTags = new Set();
  try {
    const { aliases } = loadMeituAliases(path.join(ROOT_DIR, 'data', 'meitu-alias.json'));
    for (const tag of Object.values(aliases ?? {})) aliasTags.add(String(tag).toLowerCase());
  } catch {
    // 别名表坏了不影响抓取;角色 chips 少一条而已,回填脚本会补。
  }
  log(`元数据落库:${dbPath}`);
  return {
    record(post, filePath) {
      try {
        const tags = String(post?.tags ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
        const characters = tags.filter((tag) => aliasTags.has(tag));
        gallery.upsertFromFetch({
          source: post?.source,
          sourceId: post?.id,
          filePath,
          fetchedAt: Date.now(),
          rating: post?.rating,
          characters,
          generalTags: tags,
          blacklisted: isBlockedPost({ tags }) ? 1 : 0,
          width: post?.width,
          height: post?.height,
          md5: post?.md5, // D312:内容身份进主表(同内容第二行由部分唯一索引 + upsertFile 前查兜住)
        });
      } catch (err) {
        log(`元数据落库失败(${post?.source}:${post?.id}):${err?.message ?? err}`);
      }
    },
    close() {
      // 借来的连接归调用方管(按群口径在 main 的 finally 里关);只有自己开的才自己关。
      if (owned) gallery.close();
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tags = options.tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 2);
  const proxyReady = Boolean(
    options.proxy || process.env.NODE_USE_ENV_PROXY === '1'
    || process.env.HTTPS_PROXY || process.env.HTTP_PROXY,
  );
  log(
    `char=${options.char || '(空)'} tags=${tags.join(',') || '(无)'} count=${options.count}`
    + ` source=${options.source} tier=${options.tier} dry=${options.dry ? 'yes' : 'no'}`
    + ` proxy=${options.proxy || '(env)'} proxyReady=${proxyReady ? 'yes' : 'no'}`,
  );

  if (!options.char) return fail('no_character', '缺少 --char', []);
  if (!options.dry && !options.out) return fail('download_failed', '缺少 --out', []);

  const rungs = buildRungs({
    charTag: options.char,
    tags,
    source: options.source,
    proxyReady,
    ratingOverride: options.ratingAllow.length > 0 ? options.ratingAllow : undefined,
    tier: options.tier,
  });
  if (rungs.length === 0) return fail('source_down', '没有可用的图源', []);

  const outDir = options.out ? path.resolve(options.out) : '';
  if (!options.dry && outDir) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      return fail('download_failed', `建目录失败:${err?.message ?? err}`, []);
    }
  }

  // 旁挂 md5 索引(2026-10-23 第二刀):挡住"上次已经下过、这次换个图源又排前面"的
  // **历史跨源重复**。`--dry` 只读不写(探针不污染角色目录);坏索引/目录读不了在
  // `src\meitu-index.js` 里已兜成空索引,这里不用再 try。
  // `--extra-dir`(1.184.3):分档后的历史目录(旧结构 `<根>\<角色>`、另一档同角色),
  // 重建时把它们的 md5 并入 —— 存量图与跨档同图都不会被重复下载。
  const md5Index = outDir
    ? loadMd5Index(outDir, { write: !options.dry, log, extraDirs: options.extraDirs })
    : { entries: new Map(), rebuilt: false };
  if (md5Index.rebuilt && md5Index.entries.size > 0) {
    log(`索引重建:${md5Index.entries.size} 条`);
  }

  // 翻页游标(2026-10-28「热门续查」):记住每个 rung 上次翻到哪,这轮从没翻过的页接着扫,
  // 翻到底自动回卷 —— 图量大的角色不再每条指令都撞同一批头部图然后回「没有新的」。
  // `--dry` 只读不写;写失败只 warn(顶多下轮多扫几页)。删掉 `.fetch-cursor.json` = 从头再扫。
  const cursor = outDir ? loadCursor(outDir) : new Map();
  if (cursor.size > 0) log(`游标续查:${cursor.size} 个查询接着上次翻`);

  // 按群发送账(2026-10-28 主人拍板「按群去重」):带 `--group` 时,
  //   · 排除口径 = **这个群已经看过的**(meitu_seen),不再是"全库收过";
  //   · 库里已有文件(md5 主表 / 同文件名 / md5 索引指到)直接**复用**,不重复下载;
  //   · 旁挂 md5 索引退回"存储去重"角色(防同内容存两份),不再排除候选。
  // 发送账的**记账**在服务层(发送成功才记,deps.gallery → recordSent);这里只读。
  // 库打不开 / 没给 --db / 推不出路径 → 退回旧全库口径并 warn(宁可少给,不可重复发)。
  // 元数据库连接(2026-10-28 D312):全库口径也用它读 md5 主表(排除集的真相),
  // 打开失败 → 按群退回全库口径 / 全库退回旁挂索引,都 warn,绝不静默。
  let group = String(options.group ?? '').trim();
  let seen = { md5s: new Set(), ids: new Set() };
  let gallery = null;
  const metaDbPath = resolveMetaDbPath(options.db);
  if (group && !metaDbPath) {
    log('按群去重要读发送账,但推不出元数据库路径(--db / QQBOT_MEITU_DB / QQBOT_STATE_DB),退回全库去重口径');
    group = '';
  }
  if (metaDbPath) {
    try {
      gallery = openMeituGallery({ dbPath: metaDbPath, readOnly: options.dry });
    } catch (err) {
      if (group) {
        log(`发送账读不了(${metaDbPath}):${err?.message ?? err} —— 退回全库去重口径`);
        group = '';
      } else {
        log(`美图库打不开(${metaDbPath}),md5 排除退回旁挂索引:${err?.message ?? err}`);
      }
      gallery = null;
    }
  }
  const groupMode = Boolean(group);
  if (groupMode) {
    seen = gallery.seenForGroup(group);
    if (seen.md5s.size + seen.ids.size > 0) {
      log(`按群去重:${group.slice(0, 8)}… 已看过 ${seen.md5s.size + seen.ids.size} 张`);
    }
  }
  // D312:md5 身份进主表 —— 全库口径的排除集**优先主表**(真相),旁挂索引并入作无库兜底;
  // 按群口径 = 该群已看过的 md5(预算计数也要排除,不再空转多翻页)。
  const exclusionMd5 = (() => {
    if (groupMode) {
      const seenMap = new Map();
      for (const md5 of seen.md5s) seenMap.set(md5, '');
      return seenMap;
    }
    const merged = new Map(md5Index.entries);
    if (gallery) {
      for (const md5 of gallery.knownMd5s()) if (!merged.has(md5)) merged.set(md5, '');
    }
    return merged;
  })();

  // 检索编排挪进了 `src\meitu-fetch-core.js`(2026-10-27,D159):提前停止的计数口径
  // 改为「**md5 去重 + 历史过滤之后**真正可用的新图数」—— 旧口径数"文件名没见过",
  // 历史图换个图源就能把预算吃满,然后被 md5 过滤删空,回一句假的「没有新图」,
  // 后面的 rung/页根本没查。
  const { collected, rungLog, anyHttpOk, exists, cursorUpdates } = await searchRungs({
    rungs,
    charTag: options.char,
    tags,
    count: options.count,
    outDir,
    dry: options.dry,
    md5Known: exclusionMd5,
    rungUrl,
    fetchJson,
    gapMs: REQUEST_GAP_MS,
    log,
    pagesPerRung: options.pages,
    pageLimit: PAGE_LIMIT,
    cursor,
    reuseOnDisk: groupMode,
  });
  if (!options.dry && outDir && cursorUpdates.length > 0) {
    const saved = updateCursor(outDir, cursorUpdates, { log });
    if (saved.ok) log(`游标推进:${cursorUpdates.length} 个查询`);
  }

  // ① 下载前**跨源 md5 去重**:同一张图两个图源各有一条,只留一条(danbooru 优先);
  // ② 再过排除层:全库口径 = md5 主表 + 旁挂索引并集(D312 后主表是真相,索引是无库兜底);
  //    按群口径 = 这个群的发送账;③ 最后 pickNewPosts 排序去重(按群口径盘上已有的也算候选)。
  const deduped = dedupeByMd5(collected);
  if (deduped.dropped.length > 0) log(`跨源去重:${deduped.dropped.length} 张`);
  let candidates;
  if (groupMode) {
    candidates = deduped.kept.filter((post) => !isSeenPost(post, seen));
    const seenDropped = deduped.kept.length - candidates.length;
    if (seenDropped > 0) log(`这个群已看过,跳过:${seenDropped} 张`);
  } else {
    const unseen = filterUnseen(deduped.kept, exclusionMd5);
    if (unseen.dropped.length > 0) log(`库里已有:${unseen.dropped.length} 张`);
    candidates = unseen.kept;
  }

  if (collected.length === 0) {
    if (!anyHttpOk) return fail('source_down', '所有图源都连不上', rungLog);
    return fail('no_result', '图源有响应,但没有符合条件的新图', rungLog);
  }

  // **不按 count 截断**(2026-10-27):旧代码先截成 N 张,一张下载失败就把名额白白烧掉。
  // 现在保留全序(按 score),下载循环够 N 张就停 —— 失败自动落到下一张候选。
  const ordered = pickNewPosts(candidates, {
    count: Number.MAX_SAFE_INTEGER,
    fileExists: groupMode ? () => false : exists,
  });
  if (ordered.length === 0) {
    if (!anyHttpOk) return fail('source_down', '所有图源都连不上', rungLog);
    return fail('no_result', groupMode ? '这个群符合条件的图都已经看过了' : '符合条件的图都已经下过了', rungLog);
  }

  if (options.dry) {
    return {
      ok: true,
      dry: true,
      files: [],
      candidates: ordered.map((post) => ({
        source: post.source,
        id: post.id,
        rating: post.rating,
        score: post.score,
        ext: post.ext,
        url: post.url,
      })),
      rungs: rungLog,
    };
  }

  const files = [];
  const errors = [];
  // 落盘成功的新条目 → 一次合并写进旁挂索引(写失败只 warn,不拖垮抓取;无库实例的兜底)。
  // gallery 连接在上面已经开着(读发送账/md5 主表用),metaSink **借用**同一个,不再各开一个。
  const newMd5Entries = new Map();
  const metaSink = createMetaSink({ dbPath: metaDbPath, log, gallery });
  try {
    for (const post of ordered) {
      if (files.length >= options.count) break;
      // 按群口径:库里有现成文件 → 直接复用,不重复下载。查找顺序(D312):
      // ① md5 主表(真相,绝对路径,跨角色目录也认得)→ ② 同名文件/md5 索引别名 → ③ 下载。
      if (groupMode) {
        const md5 = normalizeMd5(post.md5);
        const dbRow = md5 ? gallery?.findByMd5(md5) : null;
        if (dbRow?.filePath && fs.existsSync(dbRow.filePath)) {
          log(`库里有(md5 主表),复用:${dbRow.filePath}`);
          files.push({
            path: dbRow.filePath,
            source: post.source,
            id: post.id,
            rating: post.rating,
            url: post.url,
            md5,
            reused: true,
          });
          continue;
        }
        const reused = reuseTargetFor(post, outDir, md5Index.entries);
        if (reused) {
          log(`库里有,复用(${reused.via}):${reused.path}`);
          files.push({
            path: reused.path,
            source: post.source,
            id: post.id,
            rating: post.rating,
            url: post.url,
            md5: normalizeMd5(post.md5) || String(post.md5 ?? ''),
            reused: true,
          });
          continue;
        }
      }
      try {
        const saved = await downloadPost(post, outDir, options.maxBytes);
        // 落盘成功处顺手落一行元数据(展览处刀 1;失败只 warn,不拖垮抓取)。
        // D312:md5 随行进主表(部分唯一索引兜住同内容第二行 —— 真撞上只 warn,不炸)。
        metaSink?.record(post, saved.path);
        if (post.md5) newMd5Entries.set(post.md5, path.basename(saved.path));
        files.push({
          path: saved.path,
          source: post.source,
          id: post.id,
          rating: post.rating,
          url: post.url,
          md5: normalizeMd5(post.md5) || String(post.md5 ?? ''),
        });
      } catch (err) {
        const detail = err?.message ?? String(err);
        errors.push(`${post.source}:${post.id} ${detail}`);
        log(`下载失败(${post.source}:${post.id}):${detail}`);
      }
      await sleep(DOWNLOAD_GAP_MS);
    }
  } finally {
    metaSink?.close();
    gallery?.close();
  }

  if (outDir && newMd5Entries.size > 0) {
    const saved = addMd5Entries(outDir, newMd5Entries, { log });
    if (!saved.ok) log(`md5 索引没写进去(${outDir}),下一轮会重扫目录补`);
  }

  if (files.length === 0) {
    return fail('download_failed', errors.join(' | ') || '一张都没下下来', rungLog);
  }
  return { ok: true, files, rungs: rungLog };
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
} catch (err) {
  // 任何没接住的意外都要以**可读的失败 JSON** 收场(调用方只认它)。
  process.stdout.write(`${JSON.stringify(fail('source_down', `抓取器异常:${err?.message ?? err}`, []))}\n`);
  process.exitCode = 0;
}
