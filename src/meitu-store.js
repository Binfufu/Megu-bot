/**
 * 美图落盘的**目录与文件名**规则(2026-10-23,代码层发图)。
 *
 * 目标根目录由部署者指定(`QQBOT_MEITU_ROOT`,可配),下面**先分档**
 * (`r13\` 美图 / `r18\` 涩图),档内再按**角色名**建子目录、文件名 `${source}_${id}.${ext}`
 * —— 这样同一张图重复搜到就能直接跳过;分档让"美图/涩图"两类的库各管各的。
 *
 * ⚠️ 角色名来自群消息(**不可信输入**),要进文件路径,所以 `sanitizeCharFolder`
 *    必须挡住 Windows 非法字符、控制字符、路径穿越(`..\..\`)、保留设备名,并限长。
 *    **保留中文**是刻意的:目录名给人看,不是给 URL 用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXTS } from './meitu-search.js';

export { extFromUrl } from './meitu-search.js';

/** Windows 保留设备名(不区分大小写),当目录名会打不开。 */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** 文件夹名最长 60 字(整个路径还要留给文件名的)。 */
const MAX_FOLDER_CHARS = 60;

/**
 * 角色名 → 安全的 Windows 文件夹名。
 *
 * 规则:
 *   ① `< > : " / \ | ? *` 与控制字符(`\x00-\x1f`)→ `_`;
 *   ② trim,去首尾的点和空格(Windows 不允许结尾点/空格);
 *   ③ 保留中文等合法字符;
 *   ④ 最多 60 字;
 *   ⑤ `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` → 前面加 `_`;
 *   ⑥ 全空 → `_`(宁可一个下划线目录,也不要写到根上去)。
 *
 * @param {string} name
 */
export function sanitizeCharFolder(name) {
  let folder = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, '')
    .slice(0, MAX_FOLDER_CHARS);

  if (folder === '') return '_';
  // 名字里带点也可能是设备名(`CON.txt` 在 Windows 上同样打不开),取第一段判断。
  const stem = folder.split('.')[0].toUpperCase();
  if (RESERVED_NAMES.has(folder.toUpperCase()) || RESERVED_NAMES.has(stem)) folder = `_${folder}`;
  return folder;
}

/**
 * 档位 → 根目录下的**分类子目录**(2026-10-23 主人拍板):
 *   · 美图档(全年龄唯美,g/s)→ `r13`;
 *   · 涩图档(擦边,s/q)→ `r18`;
 *   两类下**依旧按角色名**细分。旧结构(`根\<角色>\`)只留给 1.184.2 之前的存量,
 *   新图一律落到这两类下。
 */
export const TIER_DIRS = { meitu: 'r13', seitu: 'r18' };

/** tier → 分类子目录名;不认识/未给 = 空串(不分子目录,保持旧行为)。 */
export function tierDirName(tier) {
  return TIER_DIRS[String(tier ?? '').trim().toLowerCase()] ?? '';
}

/**
 * 确保角色目录存在。**大小写不敏感地复用**同名目录:
 * Windows 会把 `Megumin` 与 `megumin` 当成同一个,但 `readdir` 里只有一个 ——
 * 直接用传入的名字 `mkdir` 会让日志/文件名与实际目录大小写对不上。
 *
 * @param {string} root 根目录(主人指定的搬运仓库)
 * @param {string} name 角色名(原样,内部负责消毒)
 * @param {{tier?: 'meitu'|'seitu'}} [options] 给了 tier 就落在 `<根>\<r13|r18>\<角色>`;
 *   不给 = 旧结构 `<根>\<角色>`(兼容旧调用与旧测试)
 * @returns {Promise<{dir: string, folder: string, tierDir: string}>}
 */
export async function ensureCharDir(root, name, { tier } = {}) {
  const folder = sanitizeCharFolder(name);
  const base = path.resolve(String(root ?? ''));
  const tierDir = tierDirName(tier);
  const scope = tierDir ? path.join(base, tierDir) : base;
  await fs.promises.mkdir(scope, { recursive: true });

  let actual = null;
  try {
    const entries = await fs.promises.readdir(scope, { withFileTypes: true });
    const hit = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === folder.toLowerCase());
    if (hit) actual = hit.name;
  } catch {
    // 读目录失败(权限/竞态)就按原名建,后面 mkdir 会给出真正的错误。
  }

  const dir = path.join(scope, actual ?? folder);
  await fs.promises.mkdir(dir, { recursive: true });
  return { dir, folder: actual ?? folder, tierDir };
}

/**
 * 落盘文件名:`${source}_${id}.${ext}`(ext 带不带点都认)。
 * @param {string} source
 * @param {string|number} id
 * @param {string} ext 例如 `jpg` 或 `.jpg`
 */
export function imageFileName(source, id, ext) {
  const cleanExt = String(ext ?? '').replace(/^\./, '').trim().toLowerCase();
  const suffix = IMAGE_EXTS.includes(cleanExt) ? `.${cleanExt}` : '';
  return `${String(source ?? '').trim()}_${String(id ?? '').trim()}${suffix}`;
}
