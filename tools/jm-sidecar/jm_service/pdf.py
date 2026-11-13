"""PDF 生成：Pillow 零新增依赖（JPEG/DCTDecode 嵌入），供 QQ 直接发文件。

- 自然排序取图，最多 max_pages 页（默认 300）
- 标准 A4 页幅，图像保比例；长图从上到下分页，栅格宽度 width（默认 1000px）与 point 尺度解耦
- 版式/源图/参数签名决定缓存有效性；选集禁止截断、跳坏图或发送缺页
- 目标 max_bytes（默认 20MB）；超限依次降级 (850, 75) → (720, 65) → (640, 60)
- 输出 data/pdfs/JM<id>-<安全标题≤40>.pdf；原子替换，避免读到半成品
- 生成期间按 album_id 加线程锁，重复请求不重复生成
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import threading
import time
from pathlib import Path

from PIL import Image, ImageOps

from .util import album_folder_name, unit_folder_name

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff"}

# ISO 216 A4（210×297mm），PDF 使用 1/72 英寸的 point；与 JPEG 压缩宽度解耦。
# 旧版把原图像素直接当页面，长条图/混合尺寸会生成极高、尺度不一的 MediaBox。
PDF_LAYOUT_VERSION = "a4-paged-v1"
A4_WIDTH_PT = 210 / 25.4 * 72
A4_RATIO = 297 / 210

_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}

_DIGITS = re.compile(r"(\d+)")


class PdfError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def natural_key(name: str):
    return [int(part) if part.isdigit() else part.lower() for part in _DIGITS.split(str(name))]


def _is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES


def list_album_images(album_dir: str | Path) -> list[Path]:
    """按自然顺序列出专辑图片；多章节（子目录 1/2/...）也按章节顺序合并。"""
    root = Path(album_dir)
    try:
        entries = list(root.iterdir())
    except OSError:
        return []
    root_images = sorted([p for p in entries if _is_image(p)], key=lambda p: natural_key(p.name))
    if root_images:
        return root_images
    images: list[Path] = []
    for subdir in sorted([p for p in entries if p.is_dir()], key=lambda p: natural_key(p.name)):
        try:
            files = sorted([p for p in subdir.iterdir() if _is_image(p)], key=lambda p: natural_key(p.name))
        except OSError:
            continue
        images.extend(files)
    return images


def _lock_for(album_id: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(album_id)
        if lock is None:
            lock = threading.Lock()
            _locks[album_id] = lock
        return lock


def pdf_path_for(config, album_id: str, title: str) -> Path:
    folder = album_folder_name(str(album_id), title or "", max_len=40)
    return Path(config.pdfs_dir) / f"{folder}.pdf"


def pdf_path_for_unit(config, album_id: str, unit_id: str, title: str) -> Path:
    """单单元 PDF 落盘：data/pdfs/JM<album>-u<unit>-<安全标题≤40>.pdf。"""
    folder = unit_folder_name(str(album_id), str(unit_id), title or "", max_len=40)
    return Path(config.pdfs_dir) / f"{folder}.pdf"


def _newest_image_mtime(images: list[Path]) -> float:
    newest = 0.0
    for image in images:
        try:
            newest = max(newest, image.stat().st_mtime)
        except OSError:
            continue
    return newest


def is_pdf_fresh(pdf_path: Path, images: list[Path]) -> bool:
    try:
        if not pdf_path.is_file() or pdf_path.stat().st_size <= 0:
            return False
    except OSError:
        return False
    newest = _newest_image_mtime(images)
    try:
        return pdf_path.stat().st_mtime >= newest - 1.0
    except OSError:
        return False


def _load_page(path: Path, width: int) -> Image.Image:
    with Image.open(path) as source:
        source.load()
        source = ImageOps.exif_transpose(source)
        if source.mode in ("RGBA", "LA") or (source.mode == "P" and "transparency" in source.info):
            rgba = source.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.split()[-1])
            image = background
        else:
            image = source.convert("RGB")
    if image.width != width:
        height = max(1, round(image.height * width / image.width))
        resized = image.resize((width, height), Image.Resampling.LANCZOS)
        image.close()
        image = resized
    return image


def _page_count(image: Image.Image, width: int) -> int:
    height = round(width * A4_RATIO)
    # 普通竖页即使略高于 A4 也整页适配；只有超过两页高的长条图才拆页。
    return 1 if image.height <= 2 * height else math.ceil(image.height / height)


def _a4_pages(image: Image.Image, width: int):
    """普通图整页适配，超长图从上到下切页；保持比例，不挤扁或裁掉内容。"""
    height = round(width * A4_RATIO)
    count = _page_count(image, width)
    if count == 1:
        fitted = ImageOps.contain(image, (width, height), Image.Resampling.LANCZOS)
        page = Image.new("RGB", (width, height), "white")
        try:
            page.paste(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))
        finally:
            fitted.close()
        yield page
        return
    # 均分长图，避免最后只剩数像素而产生一整张近空白页。
    strip_height = math.ceil(image.height / count)
    for top in range(0, image.height, strip_height):
        bottom = min(top + strip_height, image.height)
        page = Image.new("RGB", (width, height), "white")
        strip = image.crop((0, top, image.width, bottom))
        try:
            page.paste(strip, (0, (height - strip.height) // 2))
        finally:
            strip.close()
        yield page


def default_attempts(width: int, quality: int) -> list[tuple[int, int]]:
    """起步 (width, quality)，超限后按 850/75 → 720/65 → 640/60 依次降级。"""
    attempts = [(int(width), int(quality))]
    for fallback_width, fallback_quality in ((850, 75), (720, 65), (640, 60)):
        if fallback_width < int(width):
            attempts.append((fallback_width, fallback_quality))
    return attempts


def _attempts(config) -> list[tuple[int, int]]:
    return default_attempts(int(getattr(config, "pdf_width", 1000)),
                            int(getattr(config, "pdf_quality", 80)))


def _width_for_page_count(config, page_count: int) -> int:
    """页数多时把起步宽度降一档：16GB 内存机器上，1000 页 × 1000px 会吃掉几个 GB。

    质量优先的顺序不变（仍会在超过 max_bytes 时按 850/75 → 720/65 → 640/60 降级）；
    这里只是在"页数很多"的现场先把峰值内存压下来，避免整本打包失败。
    """
    width = int(getattr(config, "pdf_width", 1000))
    if page_count > 800:
        return min(width, 640)
    if page_count > 500:
        return min(width, 800)
    if page_count > 300:
        return min(width, 850)
    return width


def build_album_pdf(album_dir: str | Path, out_path: str | Path, *, title: str = "jm-service",
                    width: int = 1000, quality: int = 80, max_pages: int = 300,
                    max_bytes: int = 20 * 1024 * 1024, logger: logging.Logger | None = None,
                    attempts: list[tuple[int, int]] | None = None,
                    image_paths: list[Path] | None = None, strict_complete: bool = False) -> dict:
    """把有序图片合成标准 A4 PDF；选集 strict_complete 禁止截断/跳过坏图。"""
    log = logger or logging.getLogger("jm-service")
    album_dir = Path(album_dir)
    out_path = Path(out_path)
    images = list(image_paths) if image_paths is not None else list_album_images(album_dir)
    if not images:
        raise PdfError("pdf_no_images", "漫画目录中没有可用的图片")
    if len(images) > max_pages:
        if strict_complete:
            raise PdfError("pdf_too_many_pages", "所选单元超过 PDF 页数上限，请减少单元")
        log.info("PDF 页数 %d 超过上限 %d，只取前 %d 页", len(images), max_pages, max_pages)
        images = images[:max_pages]

    attempts = attempts or default_attempts(width, quality)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = out_path.with_name(out_path.name + ".tmp")
    started = time.time()
    stats = {}
    try:
        for attempt_index, (page_width, jpeg_quality) in enumerate(attempts):
            is_last = attempt_index == len(attempts) - 1
            pages: list[Image.Image] = []
            try:
                for image_path in images:
                    try:
                        image = _load_page(image_path, page_width)
                    except Exception as exc:  # noqa: BLE001
                        if strict_complete:
                            raise PdfError("pdf_bad_image", "所选单元含无法读取的图片，未生成残缺 PDF") from exc
                        log.warning("PDF 跳过坏图 %s：%s", image_path.name, exc)
                        continue
                    try:
                        page_count = _page_count(image, page_width)
                        if strict_complete and len(pages) + page_count > max_pages:
                            raise PdfError("pdf_too_many_pages", "所选单元分页后超过 PDF 页数上限，请减少单元")
                        for page in _a4_pages(image, page_width):
                            if len(pages) >= max_pages:
                                page.close()
                                break
                            pages.append(page)
                    finally:
                        image.close()
                    if len(pages) >= max_pages and not strict_complete:
                        break
                if not pages:
                    raise PdfError("pdf_no_images", "所有图片都读取失败，无法生成 PDF")
                pages[0].save(
                    temp_path, "PDF", save_all=True, append_images=pages[1:],
                    quality=jpeg_quality,
                    # 页面 point 尺寸固定，降 JPEG 宽度不会改变手机阅读器的页面尺度。
                    resolution=page_width * 72 / A4_WIDTH_PT,
                    title=str(title or "jm-service")[:120],
                )
                size = temp_path.stat().st_size
                stats = {
                    "path": str(out_path), "size": size, "pages": len(pages),
                    "width": page_width, "quality": jpeg_quality,
                    "elapsed_ms": int((time.time() - started) * 1000),
                }
                if size <= max_bytes or is_last:
                    if strict_complete and size > max_bytes:
                        raise PdfError("pdf_too_large", "所选单元超过 PDF 体积上限，请减少单元")
                    break
                log.info("PDF %.1fMB 超过目标 %.1fMB，降级重试 width=%s quality=%s",
                         size / 1048576, max_bytes / 1048576, page_width, jpeg_quality)
            finally:
                # 每轮及异常路径都释放，不把上一轮页面留到下一轮导致内存翻倍。
                for page in pages:
                    page.close()
        os.replace(temp_path, out_path)
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass
    stats["path"] = str(out_path)
    stats["elapsed_ms"] = int((time.time() - started) * 1000)
    log.info("PDF 生成完成 %s：%d 页，%.2fMB，width=%s q=%s，%.0fms",
             out_path.name, stats["pages"], stats["size"] / 1048576,
             stats["width"], stats["quality"], stats["elapsed_ms"])
    return stats


def _cache_signature(config, images: list[Path], strict_complete: bool) -> str:
    """绑定有序源文件与生成参数；旧 PDF 没有新签名时必须重建，不能复用坏版式。"""
    inputs = [(str(p.resolve()), p.stat().st_size, p.stat().st_mtime_ns) for p in images]
    spec = [PDF_LAYOUT_VERSION, inputs, strict_complete,
            config.pdf_width, config.pdf_quality, config.pdf_max_pages, config.pdf_max_bytes]
    return hashlib.sha256(json.dumps(spec, ensure_ascii=True).encode("utf-8")).hexdigest()


def _ensure_pdf(config, lock_key: str, out_path: Path, album_dir, pdf_title: str,
                force: bool, logger: logging.Logger | None,
                image_paths: list[Path] | None = None, strict_complete: bool = False) -> dict:
    """整本/单元/选集共用：有匹配版式/输入签名的新鲜 PDF 才复用。"""
    images = list(image_paths) if image_paths is not None else list_album_images(album_dir)
    if not images:
        raise PdfError("pdf_no_images", "漫画目录中没有可用的图片")
    width = _width_for_page_count(config, len(images))
    quality = int(getattr(config, "pdf_quality", 80))
    if logger is not None and width != int(getattr(config, "pdf_width", 1000)):
        logger.info("PDF 页数 %d，起步宽度自适应为 %d（原 %s）",
                    len(images), width, getattr(config, "pdf_width", 1000))
    lock = _lock_for(lock_key)
    with lock:
        signature = _cache_signature(config, images, strict_complete)
        stamp_path = out_path.with_suffix(".pdf.json")
        try:
            stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            stamp = {}
        cached_stats = stamp.get("stats") if isinstance(stamp, dict) else None
        if (not force and is_pdf_fresh(out_path, images)
                and isinstance(stamp, dict) and stamp.get("signature") == signature
                and isinstance(cached_stats, dict)
                and cached_stats.get("size") == out_path.stat().st_size):
            return {**cached_stats, "path": str(out_path), "elapsed_ms": 0, "cached": True}
        stats = build_album_pdf(
            album_dir,
            out_path,
            title=pdf_title,
            width=width,
            quality=quality,
            max_pages=int(getattr(config, "pdf_max_pages", 300)),
            max_bytes=int(getattr(config, "pdf_max_bytes", 20 * 1024 * 1024)),
            logger=logger,
            attempts=default_attempts(width, quality),
            image_paths=images,
            strict_complete=strict_complete,
        )
        stamp_temp = stamp_path.with_name(stamp_path.name + ".tmp")
        try:
            stamp_temp.write_text(json.dumps({"signature": signature, "stats": stats}), encoding="utf-8")
            os.replace(stamp_temp, stamp_path)
        finally:
            stamp_temp.unlink(missing_ok=True)
        return stats


def ensure_album_pdf(config, album_id: str, album_dir: str | Path, title: str,
                     force: bool = False, logger: logging.Logger | None = None) -> dict:
    """供 API/下载 worker 调用：有新鲜 PDF 直接复用，否则加锁生成。"""
    album_id = str(album_id)
    out_path = pdf_path_for(config, album_id, title)
    return _ensure_pdf(config, album_id, out_path, album_dir,
                       f"JM{album_id}", force, logger)


def ensure_unit_pdf(config, album_id: str, unit_id: str, unit_dir: str | Path, title: str,
                    force: bool = False, logger: logging.Logger | None = None) -> dict:
    """单单元 PDF：落盘/复用规则与整本一致，只是文件名/锁/页数都是该单元自己的。"""
    album_id = str(album_id)
    unit_id = str(unit_id)
    out_path = pdf_path_for_unit(config, album_id, unit_id, title)
    return _ensure_pdf(config, f"{album_id}|u{unit_id}", out_path, unit_dir,
                       f"JM{album_id}-u{unit_id}", force, logger)


def ensure_units_pdf(config, album_id: str, records: list[dict],
                     force: bool = False, logger: logging.Logger | None = None) -> dict:
    """只合并已校验的有序单元目录；不拷图、不拼已有 PDF、不写整本/单元下载记录。"""
    unit_ids = [str(record["unit_id"]) for record in records]
    if not unit_ids or len(set(unit_ids)) != len(unit_ids):
        raise PdfError("invalid_unit", "选集不能为空或含重复单元")
    images: list[Path] = []
    for record in records:
        unit_images = list_album_images(record["dir"])
        if not unit_images:
            raise PdfError("pdf_no_images", "所选单元没有可用图片，未生成残缺 PDF")
        if int(record.get("page_count") or 0) != len(unit_images):
            raise PdfError("pdf_incomplete_unit", "所选单元图片与下载记录不符，请重新下载该单元")
        images.extend(unit_images)
    key = hashlib.sha256(",".join(unit_ids).encode("ascii")).hexdigest()[:16]
    out_path = Path(config.pdfs_dir) / f"JM{album_id}-pack-{key}.pdf"
    return _ensure_pdf(config, f"{album_id}|pack|{key}", out_path, Path(config.comics_dir),
                       f"JM{album_id}-pack", force, logger, image_paths=images,
                       strict_complete=True)


def pdf_status(config, album_id: str, title: str, stored_path: str | None = None) -> tuple[bool, int | None, str]:
    """返回 (pdf_ready, pdf_size, pdf_path)：只看文件是否存在且非空。"""
    path = Path(stored_path) if stored_path else pdf_path_for(config, album_id, title)
    try:
        if path.is_file() and path.stat().st_size > 0:
            return True, path.stat().st_size, str(path)
    except OSError:
        pass
    return False, None, str(path)
