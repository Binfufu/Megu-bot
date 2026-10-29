/**
 * **小图放大**(2026-10-16,1.150.82,阶段3 识图收口——docs\29 §三十八)。
 *
 * ## 为什么要有它
 *
 * 主人发图(红方块,64×64)后追问颜色,她答"白的"。裁决实验四发切开:
 * 图**到达了**模型(不带图它老实说"没有图片")、请求形状也对、接地指令也上了——
 * 但 64×64 的图在视觉编码器里只有**零星几个 patch**,信号被 ~3k 字记忆上下文碾压,
 * 模型顺着记忆里的旧图(白的)作答。**同一份毒上下文,把图放大到 512×512 后立即答对"红色"**。
 *
 * ## 规则
 *
 * 1. **只对小 JPEG 动手**:`< 2KB` 且短边 `< 128px` 才放大(目标短边 512、长边 ≤1024)。
 *    正常尺寸的照片一律原样(不冒 token 爆炸的风险);
 * 2. **最近邻采样**:颜色零失真(纯色测试图与像素图无损,照片会糊但布局/主色仍在);
 * 3. **解码失败不致命**:坏 JPEG 照旧回原块(宁可小图不可无图,与 fetchImageBlocks 同纪律);
 * 4. 放大后转 **PNG**(无损;编码用 `pixel-plan.js` 的手写 PNG,纯 zlib)。
 *
 * 解码器 = `vendor/jpeg-decoder.js`(jpeg-js@0.4.4 逐字摘取,来源与校验见文件头声明)。
 */
import decodeJpegRaw from './vendor/jpeg-decoder.js';
import { encodePng } from './pixel-plan.js';

/** 小于这个字节数的 JPEG 视为"可疑小图"(纯色方块/缩略实体)。 */
export const SMALL_JPEG_BYTES = 2048;
/** 短边低于此值才放大。 */
export const MIN_SHORT_SIDE = 128;
/** 放大后的短边目标。 */
export const UPSCALE_SHORT_SIDE = 512;
/** 放大后长边上限(防爆)。 */
export const UPSCALE_MAX_LONG_SIDE = 1024;

/** JPEG 字节 → {width, height, data:RGBA}。坏字节会抛(调用方负责回退)。 */
export function decodeJpeg(bytes) {
  return decodeJpegRaw(bytes, { useTArray: true, formatAsRGBA: true });
}

/** 最近邻放大(RGBA)。颜色零失真;目标短边 = target,长边按比例、封顶 maxLongSide。 */
export function upscaleNearest({ width, height, data }, target, maxLongSide = UPSCALE_MAX_LONG_SIDE) {
  const factor = target / Math.min(width, height);
  let outW = Math.min(maxLongSide, Math.max(target, Math.round(width * factor)));
  let outH = Math.min(maxLongSide, Math.max(target, Math.round(height * factor)));
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.min(height - 1, Math.floor(y * height / outH));
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x * width / outW));
      const si = (sy * width + sx) * 4;
      const di = (y * outW + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3] ?? 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * **只对小 JPEG**:解码 → 短边 < 128 才放大 → PNG 块;其余原样返回。
 * 任何失败都回退原块(宁可小图不可无图),但失败要被 `onUpscaleSkip` 看见。
 */
export function maybeUpscaleJpegBytes(bytes, mimeType, block, { onSkip } = {}) {
  if (mimeType !== 'image/jpeg') return block;
  if (bytes.length >= SMALL_JPEG_BYTES) return block;
  try {
    const { width, height, data } = decodeJpeg(bytes);
    if (Math.min(width, height) >= MIN_SHORT_SIDE) return { ...block };
    const upscaled = upscaleNearest({ width, height, data }, UPSCALE_SHORT_SIDE, UPSCALE_MAX_LONG_SIDE);
    const png = encodePng(upscaled);
    return { ...block, data: png.toString('base64'), mimeType: 'image/png',
      upscaled: { from: `${width}x${height}`, to: `${upscaled.width}x${upscaled.height}` } };
  } catch (err) {
    onSkip?.(err);
    return block;
  }
}
