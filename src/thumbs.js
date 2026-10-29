/**
 * **图片缩略图:派生 + 取用**(2026-10-13,D227 追加四)。
 *
 * ## 为什么要这一层(用户现场)
 *
 * 卡库里的角色卡 PNG 单个 **0.7~5 MB**(实测第一屏 6 张 = 0.7/1.8/3.2/2.9/5.0/3.0 MB),
 * 面板第一层一次要画几十张 = 几十 MB;头像也一样(群头像单张 135~467 KB)。
 * 用户原话:「有些角色卡头像图片过大导致加载非常慢,要加上一次缩略图处理
 * (不能过于模糊,选一个成熟方案实现),所有角色图像都要处理(惠惠的头像也会卡)」。
 *
 * ## 成熟方案(照成熟网站的做法,不手搓解码器)
 *
 *  · **离线派生 + 磁盘缓存**:`scripts\gen-thumbs.py`(Pillow,LANCZOS)把每张图的
 *    长边压到 `THUMB_MAX_PX`,写进 `<目录>\thumbs\<key>.webp`——**进程外一次算好**,
 *    请求路径**零解码零缩放**(成熟站点都这么干:派生资产与请求路径分开)。
 *  · **增量**:缩略图比源文件新就跳过(改卡 = 源 mtime 变 = 下次跑脚本自动重做)。
 *  · **取用**:`pickThumb()` 有缩略图就发缩略图,没有就**如实回落原图**
 *    (新卡还没跑到 = 慢一点但看得见,不装死);ETag/304 由路由那头照 D228 协商缓存办。
 *  · **不模糊**:LANCZOS(高质量重采样)+ 长边 512(卡片圆形头像与详情预览都远超需求);
 *    质量 82 的 WebP 在 512px 上肉眼无损。
 *
 * ⚠️ 缩略图是**派生数据**(`data\` 下,gitignore;可随时重跑重建)——
 *    与 D218「内容会换的文件 URL 要自带版本号」同一条纪律:路由按**实际发的那个文件**
 *    算 ETag,换卡 → 换 ETag → 全网刷新。
 */

/** 缩略图长边上限(px)。【暂定】512 —— 够卡片头像/详情预览,再大就回到慢的老路。 */
export const THUMB_MAX_PX = 512;
/** WebP 质量。【暂定】82 —— 512px 上肉眼无损。 */
export const THUMB_QUALITY = 82;
/**
 * **列表小图**长边上限(px)。【暂定】128(2026-10-14 / D227 追加十八,用户:
 * 「首次使用的时候角色卡头像要加载很久……以后做头像都要这样处理」)。
 *
 * 为什么还要再小一档:选卡列表一行一张卡、圆头像只有 40~56px,而 512 的图平均 **25 KB** ——
 * 同人子树一次 340 行就是 8 MB+。128px(2 倍屏够用)平均 5 KB 左右,同样一屏少一个数量级。
 * 详情/房卡/气泡那些 88~96px 的地方照旧用 512 那一档。
 */
export const THUMB_SMALL_PX = 128;
/** 列表小图的 WebP 质量。【暂定】80。 */
export const THUMB_SMALL_QUALITY = 80;

/** 缩略图缓存目录名(与源文件同级的 `thumbs\`)。 */
export const THUMB_DIR_NAME = 'thumbs';
/** 列表小图的缓存目录名。 */
export const THUMB_SMALL_DIR_NAME = 'thumbs-128';

/**
 * 小图目录 = 把大图目录最后一段换成 `thumbs-128`(纯字符串,不碰盘)。
 * ⚠️ 与 `scripts\gen-thumbs.py` 同一套命名(改一边必须改另一边)。
 */
export function smallThumbDir(cacheDir) {
  const text = String(cacheDir ?? '').replace(/[\\/]+$/, '');
  if (text === '') return THUMB_SMALL_DIR_NAME;
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  const sep = cut === -1 ? '' : text.slice(0, cut + 1);
  return sep + THUMB_SMALL_DIR_NAME;
}

/** key 只留安全字符(卡 id 是 8 位 hex;头像 key 是相对名) —— 拼路径前必须过这一关。 */
export function sanitizeThumbKey(key) {
  return String(key ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 120);
}

/**
 * 缩略图落到哪(纯函数,不碰盘 —— 便于判据)。
 * @param {string} cacheDir 例如 `<assetsDir>\cards\thumbs`
 * @param {string} key 卡 id / 头像相对名
 */
export function thumbPathFor(cacheDir, key) {
  return `${String(cacheDir).replace(/[\\/]+$/, '')}\\${sanitizeThumbKey(key)}.webp`;
}

/**
 * 头像/卡图在缓存里的 key:**相对名 → 摘扩展名 → 分隔符压成 `__`**。
 *
 * ⚠️ 这两步**必须与 `scripts\gen-thumbs.py` 的 key 口径逐字一致**(脚本那侧:
 * `rel.replace('/','__').rsplit('.',1)[0]`),而**口径只有这一处**(D159:不许两处实现
 * 同一件"必须一致"的事 —— 第一版摘扩展名写在调用点,两条路各写一遍,当场被判据抓住)。
 */
export function thumbKeyForAvatar(relPath) {
  return String(relPath ?? '')
    .replace(/\\/g, '/')
    .replace(/\.[^./]+$/, '')
    .split('/')
    .filter(Boolean)
    .join('__');
}

/**
 * 该发哪个文件:**小图 → 大图 → 原图**三级回落(1.140.x 起;`small` 只在列表那种小尺寸处开)。
 *
 * 为什么是三级而不是两级:小图可能还没派生(刚扫进库的新卡),这时**退到大图**仍然远好过发原图
 * —— "如实回落原图"只留给"这一档也没有"的情况。
 * @param {{original: string, cacheDir: string, key: string, exists?: (p: string) => boolean, small?: boolean}} input
 * @returns {{path: string, mime: string, thumb: boolean}}
 */
export function pickThumb({ original, cacheDir, key, exists, small = false }) {
  const isFile = exists || (() => false);
  if (cacheDir && key) {
    if (small) {
      const tiny = thumbPathFor(smallThumbDir(cacheDir), key);
      if (isFile(tiny)) return { path: tiny, mime: 'image/webp', thumb: true };
    }
    const thumb = thumbPathFor(cacheDir, key);
    if (isFile(thumb)) return { path: thumb, mime: 'image/webp', thumb: true };
  }
  const ext = String(original ?? '').toLowerCase();
  const mime = ext.endsWith('.png') ? 'image/png'
    : (ext.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
  return { path: original, mime, thumb: false };
}
