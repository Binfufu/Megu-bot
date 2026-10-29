/**
 * Turn QQ image attachments into SDK prompt content blocks.
 *
 * The DeepSeek adapter does not accept external URLs ("direct external URLs and
 * assistant image output are not supported"), so the bytes are fetched here and
 * handed over as base64. The runtime then admits them into its durable
 * attachment store and the provider receives the normalized result.
 *
 * Failures are per-image and non-fatal: a message whose photo cannot be fetched
 * should still reach the model as text rather than disappearing entirely.
 */
import { readFileSync } from 'node:fs';
import { maybeUpscaleJpegBytes } from './image-scale.js';

/** Bounds copied from what the SDK accepts and what the provider tolerates. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_IMAGES = 3;

/** MIME types the SDK's inline image block accepts. */
const ACCEPTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Download one image into an `SdkEncodedImageBlock`.
 *
 * @returns {Promise<{type: 'image', data: string, mimeType: string}>}
 */
export async function fetchImageBlock(image, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!ACCEPTED_MIME_TYPES.has(image.mimeType)) {
    throw new Error(`不支持的图片类型 ${image.mimeType}`);
  }
  // Trust the declared size as a cheap early reject before spending the download.
  if (typeof image.size === 'number' && image.size > maxBytes) {
    throw new Error(`图片 ${Math.round(image.size / 1024)}KB 超过上限 ${Math.round(maxBytes / 1024)}KB`);
  }

  // ⚠️ 2026-10-12(D201):这条路的 URL 是**平台事件**给的(不是用户文本),所以**不套**
  //    搬运那条 CDN 白名单 —— 给这里加白名单会在平台换 CDN 时**静默丢图**
  //    ("她几乎从来看不到图"正是踩过的坑)。用户可控 URL 的那条路(搬运)才走 safe-download。
  const response = await fetch(image.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`下载后 ${Math.round(bytes.length / 1024)}KB 超过上限 ${Math.round(maxBytes / 1024)}KB`);
  }
  if (bytes.length === 0) throw new Error('下载到 0 字节');

  // ⚠️ 2026-10-16(1.150.82,阶段3 识图收口):可疑小图(<2KB 的 JPEG)放大后再进模型 ——
  //    64×64 缩略图的视觉 token 太少,被记忆上下文带偏(现场:"红图追问颜色答白",
  //    docs\29 §三十八:放大到 512 后同一份毒上下文立即答对)。失败照旧回原块。
  const block = { type: 'image', data: bytes.toString('base64'), mimeType: image.mimeType };
  return maybeUpscaleJpegBytes(bytes, image.mimeType, block, {
    onSkip: (err) => options.onUpscaleSkip?.(err),
  });
}

/**
 * Download up to `maxImages` images, skipping any that fail.
 *
 * @param {object[]} images normalized attachments from `normalizeDispatch`.
 * @param {(image: object, error: Error) => void} [onSkip] called for each failure.
 */
export async function fetchImageBlocks(images, options = {}) {
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  if (!Array.isArray(images) || images.length === 0) return [];

  const selected = images.slice(0, maxImages);
  if (images.length > selected.length) {
    options.onSkip?.(
      { filename: `${images.length - selected.length} 张` },
      new Error(`单条消息最多处理 ${maxImages} 张图片，其余已忽略`),
    );
  }

  const blocks = [];
  for (const image of selected) {
    try {
      blocks.push(await fetchImageBlock(image, options));
    } catch (err) {
      options.onSkip?.(image, err);
    }
  }
  return blocks;
}

/**
 * **本机的一张图 → SDK 图片块**(纯函数,2026-10-09)。
 *
 * 为什么需要它:入站那一路(`fetchImageBlocks`)是从 QQ 的 URL 下载;
 * 而"**她自己画出来/准备发出去的图**"就在本机,没得下载 —— 但她也该看得到自己发的东西
 * (不然她发了张图却不知道自己发了什么,接不上话)。
 *
 * @param {{path: string, mimeType?: string}} input
 * @returns {{type: 'image', data: string, mimeType: string}}
 */
export function localImageBlock({ path, mimeType = 'image/png' }, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!ACCEPTED_MIME_TYPES.has(mimeType)) throw new Error(`不支持的图片类型 ${mimeType}`);
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error('图片是 0 字节');
  if (bytes.length > maxBytes) throw new Error(`图片 ${Math.round(bytes.length / 1024)}KB 超过上限 ${Math.round(maxBytes / 1024)}KB`);
  return { type: 'image', data: bytes.toString('base64'), mimeType };
}
