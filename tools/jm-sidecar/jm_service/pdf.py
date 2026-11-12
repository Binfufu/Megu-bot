"""PDF 生成：Pillow 零新增依赖（JPEG/DCTDecode 嵌入），供 QQ 直接发文件。

- 自然排序取图，最多 max_pages 页（默认 300）
- 页面宽度缩到 width（默认 1000px），JPEG quality 80 起
- 目标 max_bytes（默认 20MB）；超限依次降级 (850, 75) → (720, 65) → (640, 60)
- 输出 data/pdfs/JM<id>-<安全标题≤40>.pdf；原子替换，避免读到半成品
- 生成期间按 album_id 加线程锁，重复请求不重复生成
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from pathlib import Path

from PIL import Image

from .util import album_folder_name

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff"}

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
        if source.mode in ("RGBA", "LA") or (source.mode == "P" and "transparency" in source.info):
            rgba = source.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.split()[-1])
            image = background
        else:
            image = source.convert("RGB")
    if image.width > width:
        height = max(1, round(image.height * width / image.width))
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    return image


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


def build_album_pdf(album_dir: str | Path, out_path: str | Path, *, title: str = "jm-service",
                    width: int = 1000, quality: int = 80, max_pages: int = 300,
                    max_bytes: int = 20 * 1024 * 1024, logger: logging.Logger | None = None,
                    attempts: list[tuple[int, int]] | None = None) -> dict:
    """把专辑图片合成 PDF；返回 {path,size,pages,width,quality,elapsed_ms}。"""
    log = logger or logging.getLogger("jm-service")
    album_dir = Path(album_dir)
    out_path = Path(out_path)
    images = list_album_images(album_dir)
    if not images:
        raise PdfError("pdf_no_images", "漫画目录中没有可用的图片")
    if len(images) > max_pages:
        log.info("PDF 页数 %d 超过上限 %d，只取前 %d 页", len(images), max_pages, max_pages)
        images = images[:max_pages]

    attempts = attempts or default_attempts(width, quality)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = out_path.with_name(out_path.name + ".tmp")
    started = time.time()
    stats = {}
    loaded_pages: list[Image.Image] = []
    try:
        for attempt_index, (page_width, jpeg_quality) in enumerate(attempts):
            is_last = attempt_index == len(attempts) - 1
            pages: list[Image.Image] = []
            for image_path in images:
                try:
                    pages.append(_load_page(image_path, page_width))
                except Exception as exc:  # noqa: BLE001 - 坏图跳过，不整本失败
                    log.warning("PDF 跳过坏图 %s：%s", image_path.name, exc)
            if not pages:
                raise PdfError("pdf_no_images", "所有图片都读取失败，无法生成 PDF")
            pages[0].save(
                temp_path,
                "PDF",
                save_all=True,
                append_images=pages[1:],
                quality=jpeg_quality,
                resolution=120,
                title=str(title or "jm-service")[:120],
            )
            size = temp_path.stat().st_size
            stats = {
                "path": str(out_path),
                "size": size,
                "pages": len(pages),
                "width": page_width,
                "quality": jpeg_quality,
                "elapsed_ms": int((time.time() - started) * 1000),
            }
            loaded_pages = pages
            if size <= max_bytes or is_last:
                break
            log.info("PDF %.1fMB 超过目标 %.1fMB，降级重试 width=%s quality=%s",
                     size / 1048576, max_bytes / 1048576, page_width, jpeg_quality)
        os.replace(temp_path, out_path)
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass
        for page in loaded_pages:
            try:
                page.close()
            except Exception:  # noqa: BLE001
                pass
    stats["path"] = str(out_path)
    stats["elapsed_ms"] = int((time.time() - started) * 1000)
    log.info("PDF 生成完成 %s：%d 页，%.2fMB，width=%s q=%s，%.0fms",
             out_path.name, stats["pages"], stats["size"] / 1048576,
             stats["width"], stats["quality"], stats["elapsed_ms"])
    return stats


def ensure_album_pdf(config, album_id: str, album_dir: str | Path, title: str,
                     force: bool = False, logger: logging.Logger | None = None) -> dict:
    """供 API/下载 worker 调用：有新鲜 PDF 直接复用，否则加锁生成。"""
    album_id = str(album_id)
    out_path = pdf_path_for(config, album_id, title)
    images = list_album_images(album_dir)
    if not images:
        raise PdfError("pdf_no_images", "漫画目录中没有可用的图片")
    lock = _lock_for(album_id)
    with lock:
        if not force and is_pdf_fresh(out_path, images):
            size = out_path.stat().st_size
            return {
                "path": str(out_path),
                "size": size,
                "pages": min(len(images), int(getattr(config, "pdf_max_pages", 300))),
                "width": None,
                "quality": None,
                "elapsed_ms": 0,
                "cached": True,
            }
        return build_album_pdf(
            album_dir,
            out_path,
            title=f"JM{album_id}",
            width=int(getattr(config, "pdf_width", 1000)),
            quality=int(getattr(config, "pdf_quality", 80)),
            max_pages=int(getattr(config, "pdf_max_pages", 300)),
            max_bytes=int(getattr(config, "pdf_max_bytes", 20 * 1024 * 1024)),
            logger=logger,
            attempts=_attempts(config),
        )


def pdf_status(config, album_id: str, title: str, stored_path: str | None = None) -> tuple[bool, int | None, str]:
    """返回 (pdf_ready, pdf_size, pdf_path)：只看文件是否存在且非空。"""
    path = Path(stored_path) if stored_path else pdf_path_for(config, album_id, title)
    try:
        if path.is_file() and path.stat().st_size > 0:
            return True, path.stat().st_size, str(path)
    except OSError:
        pass
    return False, None, str(path)
