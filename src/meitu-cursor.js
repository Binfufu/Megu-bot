/**
 * 美图抓取的**翻页游标**(2026-10-28,「热门续查」刀)。
 *
 * 为什么要有它:每条指令只翻 `PAGES_PER_RUNG`(默认 2)页,而且旧版每次都从第 1 页开始 ——
 * 对图量大的角色(按 score/最新排序的头部几十上百页),群友每喊一次都撞同一批已收过的头部图,
 * 撞满两页就老实回「没有新的」。游标记住"每个查询上次翻到哪",下一条指令从**没翻过的页**接着扫;
 * 翻到底(< 单页条数)就回卷到 0 —— 新上传的图会回到头部,下一轮自然被扫到。
 *
 * 口径:
 *   · 游标按 **rung 身份**记(键 = `source:查询tag`,见 `searchRungs` 的 `rungCursorKey`)——
 *     同一个源在同档里可能有多个查询(角色+修饰 / 纯 rating / 兜底),它们的分页空间互相独立,
 *     **不能**按源共用一个游标;
 *   · 文件放**角色目录**里(`<outDir>\.fetch-cursor.json`),与 `.md5-index.json` 同一套旁挂纪律:
 *     不进版本库、可整体删除自愈(删了 = 从头再扫,只会多翻页,不会错删图);
 *   · **永不抛**(与 meitu-index / meitu-alias 同口径):缺失/坏 JSON/形状不对一律当空游标,
 *     一个坏文件绝不能让发图指令消失;
 *   · `--dry` 只读不写(探针不污染目录,与 md5 索引同规矩)。
 *
 * ⚠️ 游标是**效率优化,不是正确性机制**:排序会被新上传顶得漂移,跨源/跨档已收过的图
 *    由 md5 去重(下载前)兜底 —— 游标导致的重复扫页只是浪费,不会重复下载。
 * @module meitu-cursor
 */
import fs from 'node:fs';
import path from 'node:path';

/** 旁挂游标文件名(放在**角色目录**里)。 */
export const CURSOR_FILE = '.fetch-cursor.json';

/** 游标文件版本。版本不认识 → 当空游标(宁可从头扫,也不猜旧格式)。 */
const CURSOR_VERSION = 1;

/**
 * 读角色目录的翻页游标 → `Map<rungKey, 下一次起始页(0 起)>`。**永不抛**。
 * 非法键(空串)或负数/小数值逐个丢,不拖垮整份游标。
 * @param {string} dir 角色目录(不存在也安全:当空游标)
 * @returns {Map<string, number>}
 */
export function loadCursor(dir) {
  const dirPath = String(dir ?? '').trim();
  if (!dirPath) return new Map();
  let text;
  try {
    text = fs.readFileSync(path.join(dirPath, CURSOR_FILE), 'utf8');
  } catch {
    return new Map(); // 缺失 = 正常(第一次抓这个角色还没建游标)。
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map(); // 坏 JSON = 当空游标(下一次保存会写回好的)。
  }
  const cursor = new Map();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return cursor;
  if (parsed.version !== CURSOR_VERSION) return cursor;
  const entries = parsed.next ?? {};
  if (typeof entries !== 'object' || Array.isArray(entries)) return cursor;
  for (const [key, value] of Object.entries(entries)) {
    const cleanKey = String(key ?? '').trim();
    if (!cleanKey) continue;
    const page = Number(value);
    if (!Number.isSafeInteger(page) || page < 0) continue;
    cursor.set(cleanKey, page);
  }
  return cursor;
}

/**
 * 把本轮的游标增量**合并**进游标文件(读现有 → 覆盖同键 → 原子写)。**永不抛**:
 * 写失败只 `log`(顶多下一轮多扫几页)。`--dry` 由调用方负责不进来。
 *
 * @param {string} dir 角色目录
 * @param {Array<{key: string, value: number}>} updates 本轮要写的键
 *   (`value = 下一轮的起始页索引,0 起;翻到底回卷时 = 0`)
 * @param {{log?: (message: string) => void}} [options]
 * @returns {{ok: boolean, count: number}} count = 写完后游标里的总键数
 */
export function updateCursor(dir, updates, { log } = {}) {
  const dirPath = String(dir ?? '').trim();
  const cleanUpdates = (updates ?? []).filter(
    (item) => item && String(item.key ?? '').trim() !== ''
      && Number.isSafeInteger(Number(item.value)) && Number(item.value) >= 0,
  );
  if (!dirPath || cleanUpdates.length === 0) return { ok: false, count: 0 };

  const cursor = loadCursor(dirPath); // 读现有(坏文件已兜成空),合并而不是覆盖别人的键。
  for (const { key, value } of cleanUpdates) {
    cursor.set(String(key).trim(), Math.trunc(Number(value)));
  }

  const target = path.join(dirPath, CURSOR_FILE);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const payload = {
      version: CURSOR_VERSION,
      next: Object.fromEntries(cursor),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, count: cursor.size };
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也不影响结果 */ }
    if (typeof log === 'function') log(`翻页游标写盘失败(${target}):${err?.message ?? err}`);
    return { ok: false, count: cursor.size };
  }
}
