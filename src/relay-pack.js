/**
 * 把「聊天记录」打包成**一个手机端易读的文件**(D60)。
 *
 * 用户实测拍板(2026-09-28):
 *   · **PDF 胜** ——「html 手机打开会比 pdf 慢很多」,而且「没有弹其他应用打开,就是要下载再看」;
 *   · 体积也是 PDF 小 25%(19 张图:PDF 4.86MB vs HTML 6.48MB —— HTML 的 base64 必然 +33%);
 *   · **纯图 PDF 的开销只有 0.2%**,因为 JPEG 用 `DCTDecode` 直嵌:`不重新编码、不需要字体`。
 *
 * ⚠️ PDF 画不出中文(base-14 标准字体没有 CJK;嵌中文字体要 20MB 字体文件 + 子集化,
 * 零依赖做不到)。所以文字走**渲染成图**再嵌页;渲染失败就返回空数组 ——
 * 调用方必须**退回"PDF(图)+ 一条文字消息"**,绝不静默丢文字。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { log } from './log.js';

/**
 * SOF 标记 → 基线/渐进(`SOF2` 是渐进式)。返回 null = 没找到 SOF。
 */
function jpegFrame(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { marker, height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), components: bytes[i + 9] };
    }
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * 从 JPEG 的 SOF 段读宽高与分量数(不依赖图像库)。
 *
 * ⚠️ **认不出格式时返回的兜底值是个陷阱**(2026-09-29 真踩了):`buildPdf()` 会拿它去写
 * `/Width` `/Height` 并把整张图声明成 `/Filter /DCTDecode`(JPEG)。传入 PNG/WebP 时,
 * 产出的 PDF **声称有一张 1280×1707 的 JPEG**、里面却是别的格式 —— 阅读器解不出来,
 * 于是"PDF 打开了、页数也对、**里面的图不见了**"。
 * 所以**嵌入 PDF 之前必须先用 `scanImage()` 判格式 + `isPdfSafeJpeg()` 判基线**,
 * 不要把这里当校验用。
 */
export function jpegInfo(buffer) {
  const frame = jpegFrame(buffer) ?? { width: 1280, height: 1707, components: 3 };
  return { width: frame.width, height: frame.height, components: frame.components };
}

/** 认格式:JPEG / PNG / GIF / WebP / HEIC(只按魔数,不依赖图像库)。 */
export function scanImage(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  if (bytes.length < 12) return { format: 'unknown' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { format: 'jpeg' };
  if (bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return { format: 'png' };
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { format: 'gif' };
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return { format: 'webp', ...webpSize(bytes) };
  }
  if (bytes.toString('latin1', 4, 8) === 'ftyp') return { format: 'heic' };
  return { format: 'unknown' };
}

/** WebP 的宽高:三种码流各记各的(VP8X / VP8 有损 / VP8L 无损)。 */
function webpSize(bytes) {
  const kind = bytes.toString('latin1', 12, 16);
  if (kind === 'VP8X') {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (kind === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return {};
}

/**
 * 这张 JPEG 能**安全直嵌**吗 —— 必须是**基线** JPEG。
 *
 * 渐进式(`SOF2`)虽然也是真 JPEG,但 PDF 的 `/DCTDecode` 要求基线编码,
 * 而**部分阅读器会静默丢掉渐进式图**:症状和"格式不对"一模一样(图不见了)。
 * 所以只要不是基线,就送去 GDI+ 重编码成基线 —— 这一步不省。
 */
export function isPdfSafeJpeg(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  const frame = jpegFrame(bytes);
  if (!frame) return false;
  if (frame.marker === 0xc2) return false; // 渐进式
  if (frame.width <= 0 || frame.height <= 0) return false;
  // ⚠️ 分量数决定 /ColorSpace:/DeviceCMYK 在 PDF 里要配 `/Decode [1 0 …]` 才显示正常,
  //    我们不猜 —— 4 分量的也送去重编码(顺带避免反色)。
  return frame.components === 1 || frame.components === 3;
}

/** 一张图为什么需要重编码(给人看的一行话;不需要时返回 null)。 */
export function describeJpegProblem(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  const scan = scanImage(bytes);
  if (scan.format !== 'jpeg') return `不是 JPEG（是 ${scan.format}）`;
  const frame = jpegFrame(bytes);
  if (!frame) return 'JPEG 里找不到 SOF 段（文件可能截断了）';
  if (frame.marker === 0xc2) return '渐进式 JPEG（PDF 的 /DCTDecode 要基线编码）';
  if (frame.components === 4) return '4 分量 JPEG（CMYK，色彩空间要另外声明）';
  return null;
}

/** 用 GDI+ 把一张**非基线 JPEG/非 JPEG 的图**重编码成基线 JPEG。 */
async function encodeJpeg(buffer, index) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-relay-img-'));
  const src = path.join(dir, `src-${index}`);
  const script = path.join(dir, 'tojpeg.ps1');
  fs.writeFileSync(src, buffer);
  fs.writeFileSync(script, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = '${src.replace(/'/g, "''")}'
$dst = '${src.replace(/'/g, "''")}.jpg'
$fs = [System.IO.File]::OpenRead($src)
$img = [System.Drawing.Image]::FromStream($fs)
$img.Save($dst, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$img.Dispose(); $fs.Dispose()
Write-Output $dst
`, 'utf8');
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        timeout: 60_000,
      }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))));
    });
    const file = out.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size > 0);
    if (!file) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉不影响主流程 */ }
  }
}

/**
 * 把一批下载回来的图**归一化成"能直嵌 PDF 的基线 JPEG"**。
 *
 * 真实规则(2026-09-29,这条是踩出来的):
 *   · 本来就是基线 JPEG → **原样返回**(D60 的 0.2% 开销就是靠这条);
 *   · 其余(PNG / WebP / GIF / HEIC / 渐进式 JPEG / CMYK JPEG)→ 走 GDI+ 重编码;
 *   · 重编码失败 → `failed` 里带**一行原因**,调用方必须**拒绝整条搬运**并说明 ——
 *     绝不能把一张解不出来的图塞进 PDF:那会让操作者看到"发成功了",群里点开却没有图。
 *
 * @param {Buffer[]} buffers
 * @returns {Promise<{buffers: Buffer[], tags: string[], failed: Array<{index: number, reason: string}>}>}
 */
export async function normalizeImages(buffers) {
  const out = [];
  const tags = [];
  const failed = [];
  let converted = 0;
  for (let i = 0; i < buffers.length; i += 1) {
    const buffer = buffers[i];
    const scan = scanImage(buffer);
    if (isPdfSafeJpeg(buffer)) {
      out.push(buffer);
      tags.push('jpeg');
      continue;
    }
    const reason = describeJpegProblem(buffer) ?? (scan.format === 'jpeg' ? '格式检查没过' : `不认识的格式（${scan.format}）`);
    const encoded = await encodeJpeg(buffer, i);
    if (!encoded) {
      failed.push({ index: i + 1, reason });
      continue;
    }
    converted += 1;
    out.push(encoded);
    tags.push(scan.format === 'jpeg' ? 'jpeg→重编码' : `${scan.format}→jpg`);
  }
  if (converted > 0) log.info(`搬运：${converted} 张图**重编码**成基线 JPEG 后才进 PDF（原格式不能直嵌）`);
  return { buffers: out, tags, failed };
}

/**
 * 组一个最小 PDF:每个"页"内容是一张 JPEG(A4 内等比居中)。
 *
 * ⚠️ `pages` 里的每一张**必须是基线 JPEG** —— 这里不做格式检查,检查在
 * `normalizeImages()` 里(嵌入之后才发现解不出来,就晚了:操作者已经看到"发成功了")。
 *
 * @param {Array<{buffer: Buffer}>} pages
 * @returns {Buffer}
 */
export function buildPdf(pages) {
  const pageW = 595.28, pageH = 841.89, margin = 21;
  const items = pages.map((page) => {
    const info = jpegInfo(page.buffer);
    const scale = Math.min((pageW - margin * 2) / info.width, (pageH - margin * 2) / info.height);
    return {
      buffer: page.buffer,
      width: info.width,
      height: info.height,
      colorSpace: info.components === 1 ? '/DeviceGray' : '/DeviceRGB',
      w: info.width * scale,
      h: info.height * scale,
      x: (pageW - info.width * scale) / 2,
      y: (pageH - info.height * scale) / 2,
    };
  });

  const pageNums = items.map((_, i) => 3 + i * 3);
  const objects = [];
  objects.push({ head: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({ head: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${items.length} >>` });
  items.forEach((item, i) => {
    objects.push({
      head: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${pageNums[i] + 1} 0 R >> >> /Contents ${pageNums[i] + 2} 0 R >>`,
    });
    objects.push({
      head: `<< /Type /XObject /Subtype /Image /Width ${item.width} /Height ${item.height} /ColorSpace ${item.colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${item.buffer.length} >>`,
      stream: item.buffer,
    });
    const content = Buffer.from(
      `q\n${item.w.toFixed(2)} 0 0 ${item.h.toFixed(2)} ${item.x.toFixed(2)} ${item.y.toFixed(2)} cm\n/Im0 Do\nQ\n`,
      'latin1',
    );
    objects.push({ head: `<< /Length ${content.length} >>`, stream: content });
  });

  const chunks = [];
  let length = 0;
  const push = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    chunks.push(buffer);
    length += buffer.length;
  };
  push('%PDF-1.4\n');
  const offsets = [];
  objects.forEach((object, index) => {
    offsets[index] = length;
    push(`${index + 1} 0 obj\n${object.head}\n`);
    if (object.stream) { push('stream\n'); push(object.stream); push('\nendstream\n'); }
    push('endobj\n');
  });
  const xrefAt = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/**
 * 把文字渲染成 JPEG 页(用 Windows 自带 GDI+,所以能画中文)。
 *
 * 这是"文字进 PDF"的唯一零依赖办法(见文件头)。**失败一律返回空数组** ——
 * 调用方必须退回"文字另发一条消息",不许静默丢。
 *
 * @param {string[]} lines 要渲染的文字行
 * @param {{fileName?: string}} [options]
 * @returns {Promise<Buffer[]>} 每页一个 JPEG;失败时为空
 */
export async function renderTextPages(lines, { fileName = 'relay-text' } = {}) {
  const text = (lines ?? []).filter((line) => String(line).trim() !== '');
  if (text.length === 0 || process.platform !== 'win32') return [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-relay-'));
  const input = path.join(dir, 'text.txt');
  const script = path.join(dir, 'render.ps1');
  fs.writeFileSync(input, text.join('\r\n'), 'utf8');
  fs.writeFileSync(script, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$text = Get-Content -LiteralPath '${input.replace(/'/g, "''")}' -Encoding UTF8
$font = New-Object System.Drawing.Font('Microsoft YaHei', 15)
$meas = New-Object System.Drawing.Bitmap 1,1
$g0 = [System.Drawing.Graphics]::FromImage($meas)
$wrap = 44
$rendered = New-Object System.Collections.ArrayList
foreach ($line in $text) {
  if ($line.Length -le $wrap) { [void]$rendered.Add($line); continue }
  for ($i = 0; $i -lt $line.Length; $i += $wrap) {
    [void]$rendered.Add($line.Substring($i, [Math]::Min($wrap, $line.Length - $i)))
  }
}
$perPage = 34
$lineH = 26
$pageCount = [Math]::Ceiling($rendered.Count / $perPage)
for ($p = 0; $p -lt $pageCount; $p++) {
  $bmp = New-Object System.Drawing.Bitmap 760, ($perPage * $lineH + 40)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $g.TextRenderingHint = 'ClearTypeGridFit'
  $brush = [System.Drawing.Brushes]::Black
  for ($l = 0; $l -lt $perPage; $l++) {
    $index = $p * $perPage + $l
    if ($index -ge $rendered.Count) { break }
    $g.DrawString($rendered[$index], $font, $brush, 16, 16 + $l * $lineH)
  }
  $g.Dispose()
  $out = Join-Path '${dir.replace(/'/g, "''")}' ('page-' + $p + '.jpg')
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bmp.Dispose()
  Write-Output $out
}
$g0.Dispose(); $meas.Dispose(); $font.Dispose()
`, 'utf8');

  try {
    const files = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        timeout: 60_000,
      }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).split(/\r?\n/).filter(Boolean))));
    });
    return files.filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file));
  } catch {
    return [];
  } finally {
    // 临时目录里只有我们生成的 txt/ps1/jpg,渲染完就删(失败也不留垃圾)
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉不影响主流程 */ }
  }
}
