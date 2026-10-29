/**
 * 角色目录的**旁挂 md5 索引**(2026-10-23,美图抓取去重第二刀)。
 *
 * 为什么要有它:下载前的 `dedupeByMd5` 只能管**同一批**查询结果里的跨源重复;
 * 上次抓过的图这次换个图源又排在前面,下载前的去重是**看不见历史**的 —— 所以要在
 * 角色目录里"记住下过哪些图的 md5"。
 *
 * 口径(主人拍板):
 *   · 索引放**旁挂文件** `INDEX_FILE`,**不动文件名规则**(仍是 `${source}_${id}.${ext}`,
 *     见 `src\meitu-store.js` `imageFileName`);
 *   · 文件名跟 md5 一一对应:`{ version: 1, entries: { "<md5>": "<fileName>" }, updatedAt }`;
 *   · 同 md5 优先留 danbooru 是**下载前**的事(`dedupeByMd5`),这里只负责"见过没有"。
 *
 * 永不抛(与 `meitu-alias` / `meitu-lines` 同口径):坏 JSON / 形状不对 / 目录读不了
 * 一律当空索引 —— 一个坏文件绝不能让整条发图指令静默消失。
 *
 * 索引是**唯一实现**(D159):抓取器与服务层都从这里拿,别在别处抄第二份。
 * @module meitu-index
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { IMAGE_EXTS, normalizeMd5 } from './meitu-search.js';

/** 旁挂索引文件名(放在**角色目录**里,不进版本库、不进图源查询)。 */
export const INDEX_FILE = '.md5-index.json';

/** 索引文件版本。版本不认识 → 当空索引(宁可重扫目录,也不猜旧格式)。 */
const INDEX_VERSION = 1;

/** 只认 `IMAGE_EXTS` 里的图片(与下载/发送口径同一份,见 `meitu-search.js`)。 */
function isImageFileName(name) {
  const ext = path.extname(String(name ?? '')).replace(/^\./, '').toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

/**
 * 列目录里的图片文件名(只认 `Dirent.isFile()`,排掉同名目录)。
 * 读不了目录会抛 —— 由 `loadMd5Index` 兜成空索引。
 * @param {string} dir
 * @returns {string[]}
 */
function listImageFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isImageFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 盘上一个文件的 md5(小写 32 位十六进制)。 */
function fileMd5(filePath) {
  return createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 任意"Map 或普通对象"→ 干净的 `Map<md5, fileName>`。
 * 只收**合法 md5 键 + 非空字符串值**,坏项逐个丢(别让一行坏数据废掉整份索引)。
 * @param {Map<string, string>|Record<string, string>|null|undefined} value
 * @returns {Map<string, string>}
 */
function toEntryMap(value) {
  const entries = new Map();
  let pairs;
  if (value instanceof Map) pairs = [...value.entries()];
  else if (value && typeof value === 'object' && !Array.isArray(value)) pairs = Object.entries(value);
  else return entries;
  for (const [key, val] of pairs) {
    const md5 = normalizeMd5(key);
    const fileName = typeof val === 'string' ? val.trim() : '';
    if (md5 && fileName) entries.set(md5, fileName);
  }
  return entries;
}

/**
 * 读索引文件 → `Map<md5, fileName>`。**永不抛**:缺失 / 坏 JSON / 形状不对都回空索引。
 * @param {string} dir 角色目录
 */
function readIndex(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8');
  } catch {
    return new Map(); // 缺失 = 正常(第一次抓这个角色还没建索引)。
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map(); // 坏 JSON = 当空索引,不拖垮抓取(下一次重建会写回好的)。
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
  if (parsed.version !== INDEX_VERSION) return new Map();
  return toEntryMap(parsed.entries);
}

/**
 * 原子写索引(`.tmp` → rename;中断不会留下"看起来完整"的半份索引)。
 * **永不抛**:写失败只 `log` 或静默(索引丢了顶多下次多扫一遍目录)。
 * @param {string} dir
 * @param {Map<string, string>} entries
 * @param {(message: string) => void} [log]
 * @returns {boolean} 是否写成功
 */
function writeIndex(dir, entries, log) {
  const target = path.join(dir, INDEX_FILE);
  const tmp = `${target}.tmp`;
  try {
    const payload = {
      version: INDEX_VERSION,
      entries: Object.fromEntries(entries),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也不影响结果 */ }
    if (typeof log === 'function') log(`md5 索引写盘失败(${target}):${err?.message ?? err}`);
    return false;
  }
}

/**
 * 目录里所有图片的 md5(排序后写索引,保证同一目录两次重建结果逐字节一致)。
 * 单张读不出来就跳过 —— 它下一轮还会被当成"没进索引"再试一次。
 * @param {string} dir
 * @param {string[]} [imageNames]
 */
function computeFileMd5s(dir, imageNames) {
  const names = imageNames ?? listImageFiles(dir);
  const entries = new Map();
  for (const name of names) {
    try {
      entries.set(fileMd5(path.join(dir, name)), name);
    } catch {
      // 读失败(被占用/删了)跳过;宁可少一条索引,也别抛。
    }
  }
  return entries;
}

/**
 * 读角色目录的 md5 索引;**条目落后于目录实际图片数**就重扫目录算文件 md5 重建。
 *
 * 重建触发(条件都来自实测口径):
 *   · 索引不存在 / 坏掉 / 版本不对 → 空索引,目录有图就算落后;
 *   · **索引条目数 < 目录图片数**(典型:上一版没索引,已经下过一批图);
 *   · 或目录里有图**没被任何条目指到**(条数够但换了文件:删一张又下一张)。
 *
 * **历史目录**(`extraDirs`,1.184.3 起):重建时把它们的图片 md5 也并进来 ——
 *   · 旧结构 `根\<角色>\`(1.184.2 之前的存量图);
 *   · 另一档的同角色目录(美图/涩图在 sensitive 档口径重叠,同一张图别两档各存一份)。
 * 合并后的条目写进本档索引;`rebuilt` 判定只看**主目录**,历史目录变化不会引起反复重建。
 *
 * 写盘仅在 `write === true`(抓取器 `--dry` 传 false:**只读不写**,探针不污染目录)。
 *
 * @param {string} dir 角色目录(不存在也安全:当空索引)
 * @param {{write?: boolean, log?: (message: string) => void, extraDirs?: string[]}} [options]
 * @returns {{entries: Map<string, string>, rebuilt: boolean}}
 */
export function loadMd5Index(dir, { write = true, log, extraDirs = [] } = {}) {
  const dirPath = String(dir ?? '').trim();
  if (!dirPath) return { entries: new Map(), rebuilt: false };
  try {
    const entries = readIndex(dirPath);
    // 主目录还不存在(新档目录首次抓 / dry 探针)= 空图片列表,继续往下走 ——
    // 不能因为主目录没建就把历史目录的并入也一起吞掉。
    let images = [];
    try {
      images = listImageFiles(dirPath);
    } catch {
      images = [];
    }
    const indexedNames = new Set(entries.values());
    const complete = entries.size >= images.length
      && images.every((name) => indexedNames.has(name));
    if (complete) {
      // 历史目录并入**内存**(索引文件里已有的跳过);有新条目就顺手写盘,
      // 否则只读返回(不为了"什么都没变"每轮重写索引)。
      let extraAdded = 0;
      for (const extra of extraDirs ?? []) {
        const extraPath = String(extra ?? '').trim();
        if (!extraPath) continue;
        try {
          for (const [md5, name] of computeFileMd5s(extraPath)) {
            if (entries.has(md5)) continue;
            entries.set(md5, name);
            extraAdded += 1;
          }
        } catch {
          // 历史目录不存在/读不了:跳过(旧结构可能从没建过,不是错误)。
        }
      }
      if (extraAdded > 0 && write) writeIndex(dirPath, entries, log);
      return { entries, rebuilt: extraAdded > 0 };
    }

    // 主目录落后:从零重建主目录部分(删/换文件能自愈),再并入历史目录。
    const rebuiltEntries = computeFileMd5s(dirPath, images);
    for (const extra of extraDirs ?? []) {
      const extraPath = String(extra ?? '').trim();
      if (!extraPath) continue;
      try {
        for (const [md5, name] of computeFileMd5s(extraPath)) {
          if (!rebuiltEntries.has(md5)) rebuiltEntries.set(md5, name);
        }
      } catch {
        // 同上:历史目录读不了不影响本档索引。
      }
    }
    if (write) writeIndex(dirPath, rebuiltEntries, log);
    return { entries: rebuiltEntries, rebuilt: true };
  } catch (err) {
    // 极端情况(读索引时出别的事):空索引,永不抛。
    if (typeof log === 'function') log(`md5 索引读取失败(${dirPath}):${err?.message ?? err}`);
    return { entries: new Map(), rebuilt: false };
  }
}

/**
 * 把新下载的条目**合并**进索引(读现有 → 覆盖同 md5 → 原子写)。
 * 合并而不是覆盖:并发/多次调用不会把别人刚记的条目冲掉。
 * 写失败只 `log`(**不抛**)—— 图已经在盘上了,索引下一轮重建能补。
 *
 * @param {string} dir 角色目录
 * @param {Map<string, string>|Record<string, string>} newEntries `{md5: fileName}`
 * @param {{log?: (message: string) => void}} [options]
 * @returns {{ok: boolean, added: number, count: number}}
 */
export function addMd5Entries(dir, newEntries, { log } = {}) {
  const dirPath = String(dir ?? '').trim();
  const additions = toEntryMap(newEntries);
  if (!dirPath || additions.size === 0) return { ok: false, added: 0, count: 0 };

  const entries = readIndex(dirPath);
  let added = 0;
  for (const [md5, fileName] of additions) {
    if (entries.get(md5) === fileName) continue;
    entries.set(md5, fileName);
    added += 1;
  }
  if (added === 0) return { ok: true, added: 0, count: entries.size };
  const ok = writeIndex(dirPath, entries, log);
  return { ok, added, count: entries.size };
}

/**
 * 按索引过滤:**md5 已经见过的帖子**去掉(历史跨源重复靠这一刀挡)。
 * 无/非法 md5 的帖子一律**保留** —— 它们靠文件名兜底。
 *
 * @param {Array<object>} posts 归一化后的帖子(要带 `md5`)
 * @param {Map<string, string>|Record<string, string>} entries `loadMd5Index` 的 entries
 * @returns {{kept: Array<object>, dropped: Array<object>}} `dropped` 给日志用
 */
export function filterUnseen(posts, entries) {
  const known = entries instanceof Map ? entries : toEntryMap(entries);
  const kept = [];
  const dropped = [];
  for (const post of (posts ?? []).filter(Boolean)) {
    const md5 = normalizeMd5(post?.md5);
    if (md5 && known.has(md5)) dropped.push(post);
    else kept.push(post);
  }
  return { kept, dropped };
}
