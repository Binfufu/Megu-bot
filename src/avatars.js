/**
 * **头像**(2026-10-13 / D228):bot 与用户各一种,全部是**一个文件一件事** ——
 *
 *   · bot  头像 = `<avatarDir>/bot.<ext>`        —— 操作者直接换文件就生效(网页不提供改动);
 *   · 用户头像 = `<avatarDir>/user/<id>.<ext>`   —— 登录账号自己在页面上传(只许传自己的)。
 *
 * ⚠️ **群头像(`room/<房id>`)已随「群组」那一栏删除**(2026-10-14 / D229)——
 *    它只服务于网页群聊房卡,那一栏下线后这条口子一并关掉(见 docs\03 D229)。
 *
 * 照成熟网站(Discord/QQ)的形状:**头像 = 独立的 URL 资源**,页面拿地址画 <img>,
 * 拿不到(文件不在)就回落字母头像 —— 页面**不编**第二种头像画法。
 *
 * ⚠️ 三条纪律:
 *   ① **id 一律先过白名单再拼路径**(目录穿越的老坑):user 只认数字;
 *      扩展名只认表里那四种,**绝不来者不拒**。
 *   ② **同一人的头像只留一份**:换格式 = 删旧的再写新的(user/<id>.* 只剩一个)。
 *   ③ 这个模块**只认文件**,不认识库 / QQ / 面板 —— 判身份是调用方的事。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 扩展名 → MIME(**写死的一张表**,不在表里的上传直接拒)。 */
export const AVATAR_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const MIME_TO_EXT = Object.fromEntries(Object.entries(AVATAR_MIME).map(([ext, mime]) => [mime, ext]));
/** 顺手收 gif?不收 —— 动图头像在列表里闪,先不给这个口子。 */

/** user 的 id 只认数字(账号表的主键)。 */
export function validUserId(id) {
  return /^[1-9][0-9]{0,8}$/.test(String(id ?? ''));
}

/**
 * 找某一种头像现在的文件(**只有一份**,找到就回绝对路径;没有回 null)。
 * bot 没有 id;user 的 id 先过白名单 —— 不过就是 null,不碰文件系统。
 */
export function findAvatarFile(dir, kind, id = null) {
  if (kind === 'bot') {
    return firstExisting(dir, ['bot']);
  }
  if (kind === 'user') {
    if (!validUserId(id)) return null;
    return firstExisting(path.join(dir, 'user'), [String(id)]);
  }
  return null;
}

/** 在目录里找 `<stem>.<认识的扩展名>`,按固定顺序(png → jpg → jpeg → webp)。 */
function firstExisting(dir, stems) {
  try {
    for (const ext of Object.keys(AVATAR_MIME)) {
      const file = path.join(dir, ...stems) + ext;
      if (existsSync(file)) return file;
    }
  } catch { /* 目录不存在等 —— 与"没有头像"同一个说法 */ }
  return null;
}

/** 内容指纹(ETag / `?v=` 共用这一份):sha256 前 10 位 —— 够防碰,短得能进 URL。 */
export function avatarTag(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 10);
}

/**
 * **图片魔数嗅探**(2026-10-18 / D250,批次2 发现②的修复):看文件开头是不是真图片。
 * 只认扩展名表里那三种实际会存的格式(png / jpeg / webp;gif 本来就不收)。
 * @returns {'.png'|'.jpg'|'.webp'|null} 认不出 = null(不是"猜一个最像的")
 */
export function sniffImageExt(bytes) {
  // 最短是 JPEG 的 3 字节头;PNG 要 8、WebP 的格式字在 8..11 —— 各自检查前再验各自的下限,
  // 别在这里一刀切 12(4 字节的短 JPEG 会被挡在 JPEG 检查之前 —— 首跑咬中过一次)。
  if (!Buffer.isBuffer(bytes) || bytes.length < 3) return null;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

/**
 * 保存**用户自己的**头像(先写临时文件再改名,半张图不会出现在网上)。
 * @returns {{ok:true, file:string, ext:string}|{ok:false, error:string}}
 */
export function saveUserAvatar(dir, playerId, bytes, mime) {
  const ext = MIME_TO_EXT[String(mime ?? '').toLowerCase()];
  if (!ext) return { ok: false, error: 'bad_type' };
  // ⚠️ **魔数必须与声明的扩展名一致**(2026-10-18 / D250):MIME 头是**客户端自报的**,
  //    光看头 = 把 "this is definitely not a png" 原样落盘(批次2 发现②)。
  //    现在文件开头必须真的是那张扩展名对应的图片格式,否则拒(bad_magic → 415)。
  //    ⚠️ .jpg 与 .jpeg 是同一个格式族(MIME_TO_EXT 里 image/jpeg 两个扩展名都在表里),
  //    比较前先归一到 .jpg,不然"真 JPEG + 声明 image/jpeg"会被自己误拒。
  const sniffed = sniffImageExt(bytes);
  const canon = (e) => (e === '.jpeg' ? '.jpg' : e);
  if (!sniffed || canon(sniffed) !== canon(ext)) return { ok: false, error: 'bad_magic', note: '文件内容与声明的图片格式对不上。' };
  if (!validUserId(playerId)) return { ok: false, error: 'bad_id' };
  const target = path.join(dir, 'user');
  try { mkdirSync(target, { recursive: true }); } catch (err) {
    return { ok: false, error: 'mkdir_failed:' + (err?.code ?? '?') };
  }
  const finalPath = path.join(target, String(playerId) + ext);
  const tmpPath = path.join(target, String(playerId) + '.tmp');
  try {
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* 尽力 */ }
    return { ok: false, error: 'write_failed:' + (err?.code ?? '?') };
  }
  // 换了格式就把旧格式的删掉 —— 同一个人永远只有一份,findAvatarFile 才不用猜先后。
  for (const other of Object.keys(AVATAR_MIME)) {
    if (other === ext) continue;
    try { rmSync(path.join(target, String(playerId) + other), { force: true }); } catch { /* 尽力 */ }
  }
  return { ok: true, file: finalPath, ext };
}

/** 读一个头像文件的字节(没有 / 读不动都回 null —— 调用方回 404)。 */
export function readAvatarBytes(dir, kind, id = null) {
  const file = findAvatarFile(dir, kind, id);
  if (!file) return null;
  try { return { bytes: readFileSync(file), file }; } catch { return null; }
}
