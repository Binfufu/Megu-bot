"""下载任务队列：单 worker 串行执行（staging → 拍平/保留章节 → 移动进漫画库 → 写库）。"""
from __future__ import annotations

import logging
import queue
import shutil
import threading
import time
import uuid
from pathlib import Path

from .jm_api import JmError
from .pdf import ensure_album_pdf, ensure_unit_pdf
from .util import (album_folder_name, find_first_image_dir, now_iso,
                   unit_folder_name, viewer_url_for_dir)

_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff"}


def _is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in _IMAGE_SUFFIXES


def _count_images(root: Path) -> int:
    try:
        return sum(1 for _ in root.rglob("*") if _is_image(_))
    except OSError:
        return 0


def flatten_single_chapter(staging: Path, log: logging.Logger) -> None:
    """若 staging 下只有一个章节子目录（且根目录无图），把图片拍平到根目录。"""
    staging = Path(staging)
    root_images = [p for p in staging.iterdir() if _is_image(p)] if staging.exists() else []
    if root_images:
        return
    subdirs = [p for p in staging.iterdir() if p.is_dir()] if staging.exists() else []
    if len(subdirs) != 1:
        return
    subdir = subdirs[0]
    source = find_first_image_dir(subdir) or subdir
    moved = 0
    for entry in sorted(source.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_file() or not _is_image(entry):
            continue
        target = staging / entry.name
        suffix_index = 1
        while target.exists():
            target = staging / f"{entry.stem}_{suffix_index}{entry.suffix}"
            suffix_index += 1
        shutil.move(str(entry), str(target))
        moved += 1
    # 清理空目录
    shutil.rmtree(subdir, ignore_errors=True)
    log.info("拍平单章节：%s（%d 张图）", subdir.name, moved)


class DownloadWorker:
    def __init__(self, gateway, store, config, logger: logging.Logger):
        self.gateway = gateway
        self.store = store
        self.cfg = config
        self.log = logger
        self._queue: queue.Queue = queue.Queue()
        self._jobs: dict[str, dict] = {}
        self._active_by_key: dict[str, str] = {}
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="jm-download-worker", daemon=True)
        self._thread.start()
        self.log.info("下载 worker 已启动（单 worker 串行）")

    def stop(self) -> None:
        self._stop_event.set()
        self._queue.put(None)
        if self._thread:
            self._thread.join(timeout=5)

    # ------------------------------------------------------------------ #
    @staticmethod
    def _job_key(album_id: str, unit_id: str | None = None) -> str:
        """去重 key：整本任务用 album_id，单元任务用 album_id|unit_id。"""
        album_id = str(album_id)
        return album_id if not unit_id else f"{album_id}|{unit_id}"

    def submit(self, album_id: str, album: dict, unit: dict | None = None) -> tuple[dict, bool]:
        """提交下载任务；同一 key（整本或某单元）进行中返回已有 job。返回 (job 快照, 是否新建)。"""
        album_id = str(album_id)
        unit_id = str(unit.get("unit_id")) if unit and unit.get("unit_id") else None
        unit = unit or {}
        key = self._job_key(album_id, unit_id)
        with self._lock:
            existing_id = self._active_by_key.get(key)
            if existing_id:
                job = self._jobs.get(existing_id)
                if job and job["status"] in ("queued", "running"):
                    return dict(job), False
            if unit_id:
                title = unit.get("title") or ""
                total_pages = int(unit.get("page_count") or 0)
            else:
                title = album.get("title") if album else None
                total_pages = int(album.get("page_count") or 0) if album else 0
            job_id = uuid.uuid4().hex
            job = {
                "job_id": job_id,
                "album_id": album_id,
                "unit_id": unit_id,
                "unit_title": unit.get("title") if unit_id else None,
                "unit_index": unit.get("index") if unit_id else None,
                "status": "queued",
                "phase": "detail",
                "title": title,
                "total_pages": total_pages,
                "elapsed_ms": 0,
                "viewer_url": None,
                "dir": None,
                "error": None,
                "pdf_ready": False,
                "pdf_size": None,
                "created_at": time.time(),
            }
            self._jobs[job_id] = job
            self._active_by_key[key] = job_id
            self._queue.put(job_id)
        self.log.info("下载任务入队 job=%s album=%s unit=%s", job_id, album_id, unit_id or "-")
        return dict(job), True

    def get_job(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return self._snapshot(job) if job else None

    def active_job_for_album(self, album_id: str, unit_id: str | None = None) -> dict | None:
        with self._lock:
            job_id = self._active_by_key.get(self._job_key(album_id, unit_id))
            job = self._jobs.get(job_id) if job_id else None
            if job and job["status"] in ("queued", "running"):
                return self._snapshot(job)
            return None

    @staticmethod
    def _snapshot(job: dict) -> dict:
        snapshot = dict(job)
        snapshot["elapsed_ms"] = int((time.time() - job["created_at"]) * 1000)
        return snapshot

    def _update(self, job: dict, **fields) -> None:
        with self._lock:
            job.update(fields)

    # ------------------------------------------------------------------ #
    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                job_id = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if job_id is None:
                break
            with self._lock:
                job = self._jobs.get(job_id)
            if not job or job["status"] != "queued":
                continue
            try:
                self._process(job)
            except Exception as exc:  # noqa: BLE001 - 兜底，不让 worker 线程死掉
                self.log.exception("下载任务异常 job=%s", job_id)
                self._fail(job, f"内部错误：{exc}")
            finally:
                with self._lock:
                    self._active_by_key.pop(
                        self._job_key(job["album_id"], job.get("unit_id")), None)
                    if job["status"] not in ("done", "failed"):
                        job["status"] = "failed"
                        job["error"] = job.get("error") or "任务中断"

    # ------------------------------------------------------------------ #
    def _process(self, job: dict) -> None:
        album_id = job["album_id"]
        unit_id = job.get("unit_id")
        started = time.time()
        self._update(job, status="running", phase="detail")
        self.log.info("开始处理下载任务 job=%s album=%s unit=%s",
                      job["job_id"], album_id, unit_id or "-")

        album = None
        try:
            album = self.gateway.album_detail(album_id)
            if unit_id:
                # 单元任务的标题/页数以单元为准，不被整本详情覆盖
                self._update(job, phase="download")
            else:
                self._update(job, phase="download", title=album.get("title"),
                             total_pages=int(album.get("page_count") or 0))
        except JmError as exc:
            self._fail(job, exc.message)
            return

        if unit_id:
            self._process_unit(job, album, started)
            return

        staging_root = Path(self.cfg.staging_dir)
        staging = staging_root / f"JM{album_id}"
        try:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True, exist_ok=True)
            chapter_count = int(album.get("chapter_count") or 0)
            rule = "Bd" if chapter_count <= 1 else "Bd/{Pindex}"
            file_count_before = _count_images(staging)
            self.gateway.download_album(album_id, staging, rule=rule)
            self._update(job, phase="finalize")
            flatten_single_chapter(staging, self.log)
            image_count = _count_images(staging)
            if image_count <= 0:
                raise JmError("download_empty", "下载完成但没有得到任何图片")
            final_dir = self._finalize_dir(album_id, album, staging)
            viewer_url = viewer_url_for_dir(self.cfg, final_dir)
            record = {
                "id": album_id,
                "title": album.get("title") or "",
                "dir": str(final_dir),
                "viewer_url": viewer_url,
                "page_count": image_count or int(album.get("page_count") or 0),
                "authors": album.get("authors") or [],
                "tags": album.get("tags") or [],
                "cover_url": album.get("cover_url") or "",
                "downloaded_at": now_iso(),
            }
            self.store.upsert_album(record)
            # finalize 后生成 PDF（调用方 POST /download 早已返回，不阻塞）
            pdf_ready, pdf_size = self._generate_pdf(album_id, final_dir, album)
            self._update(job, status="done", phase="finalize", viewer_url=viewer_url,
                         dir=str(final_dir), total_pages=record["page_count"], error=None,
                         pdf_ready=pdf_ready, pdf_size=pdf_size)
            self.log.info("下载任务完成 job=%s album=%s，%d 张图，%.1fs → %s（PDF=%s）",
                          job["job_id"], album_id, image_count, time.time() - started, final_dir,
                          f"{pdf_size} bytes" if pdf_ready else "未生成")
        except JmError as exc:
            self._fail(job, exc.message)
            self._cleanup_staging(staging)
        except Exception as exc:  # noqa: BLE001
            self.log.exception("下载失败 job=%s", job["job_id"])
            self._fail(job, f"下载失败：{exc}")
            self._cleanup_staging(staging)
        finally:
            with self._lock:
                self._active_by_key.pop(album_id, None)

    def _process_unit(self, job: dict, album: dict, started: float) -> None:
        """单单元下载：只下一章 → 目录/记录/PDF 都只针对该单元。"""
        album_id = job["album_id"]
        unit_id = str(job["unit_id"])
        unit_title = job.get("unit_title") or ""
        staging_root = Path(self.cfg.staging_dir)
        staging = staging_root / f"JM{album_id}-u{unit_id}"
        try:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True, exist_ok=True)
            self.gateway.download_photo(unit_id, staging, rule="Bd")
            self._update(job, phase="finalize")
            flatten_single_chapter(staging, self.log)
            image_count = _count_images(staging)
            if image_count <= 0:
                raise JmError("download_empty", "下载完成但没有得到任何图片")
            final_dir = self._finalize_unit_dir(album_id, unit_id, unit_title, staging)
            viewer_url = viewer_url_for_dir(self.cfg, final_dir)
            self.store.upsert_unit({
                "album_id": album_id,
                "unit_id": unit_id,
                "title": unit_title,
                "dir": str(final_dir),
                "page_count": image_count,
            })
            pdf_ready, pdf_size = self._generate_unit_pdf(
                album_id, unit_id, final_dir, unit_title)
            self._update(job, status="done", phase="finalize", viewer_url=viewer_url,
                         dir=str(final_dir), total_pages=image_count, error=None,
                         pdf_ready=pdf_ready, pdf_size=pdf_size)
            self.log.info("单元下载任务完成 job=%s album=%s unit=%s，%d 张图，%.1fs → %s（PDF=%s）",
                          job["job_id"], album_id, unit_id, image_count,
                          time.time() - started, final_dir,
                          f"{pdf_size} bytes" if pdf_ready else "未生成")
        except JmError as exc:
            self._fail(job, exc.message)
            self._cleanup_staging(staging)
        except Exception as exc:  # noqa: BLE001
            self.log.exception("单元下载失败 job=%s", job["job_id"])
            self._fail(job, f"下载失败：{exc}")
            self._cleanup_staging(staging)
        finally:
            with self._lock:
                self._active_by_key.pop(self._job_key(album_id, unit_id), None)

    def _generate_pdf(self, album_id: str, final_dir: Path, album: dict) -> tuple[bool, int | None]:
        """finalize 后同步生成 PDF；失败不影响下载结果（GET /pdf/<id> 仍可重试生成）。"""
        try:
            stats = ensure_album_pdf(
                self.cfg, album_id, final_dir, album.get("title") or "", logger=self.log)
            self.store.set_album_pdf(album_id, stats["path"], stats["size"])
            return True, int(stats["size"])
        except Exception as exc:  # noqa: BLE001 - PDF 失败不阻塞下载
            self.log.warning("下载后生成 PDF 失败 album=%s（可稍后 GET /pdf/%s 重试）：%s",
                             album_id, album_id, exc)
            return False, None

    def _generate_unit_pdf(self, album_id: str, unit_id: str, final_dir: Path,
                           unit_title: str) -> tuple[bool, int | None]:
        """单元任务 finalize 后生成该单元 PDF；失败不影响下载结果。"""
        try:
            stats = ensure_unit_pdf(self.cfg, album_id, unit_id, final_dir,
                                    unit_title or "", logger=self.log)
            self.store.set_unit_pdf(album_id, unit_id, stats["path"], stats["size"])
            return True, int(stats["size"])
        except Exception as exc:  # noqa: BLE001 - PDF 失败不阻塞下载
            self.log.warning(
                "下载后生成单元 PDF 失败 album=%s unit=%s（可稍后 GET /pdf/%s?unit=%s 重试）：%s",
                album_id, unit_id, album_id, unit_id, exc)
            return False, None

    def _finalize_dir(self, album_id: str, album: dict, staging: Path) -> Path:
        """把 staging 目录移动到 data/comics/JM<id>-<安全标题40字>/。"""
        comics_dir = Path(self.cfg.comics_dir)
        comics_dir.mkdir(parents=True, exist_ok=True)
        folder = album_folder_name(album_id, album.get("title") or "", max_len=40)
        final_dir = comics_dir / folder
        if final_dir.exists():
            self.log.warning("目标目录已存在，先清理：%s", final_dir)
            shutil.rmtree(final_dir, ignore_errors=True)
        shutil.move(str(staging), str(final_dir))
        return final_dir

    def _finalize_unit_dir(self, album_id: str, unit_id: str, unit_title: str,
                           staging: Path) -> Path:
        """把 staging 目录移动到 data/comics/JM<album>-u<unit>-<安全标题30字>/。"""
        comics_dir = Path(self.cfg.comics_dir)
        comics_dir.mkdir(parents=True, exist_ok=True)
        folder = unit_folder_name(album_id, unit_id, unit_title or "", max_len=30)
        final_dir = comics_dir / folder
        if final_dir.exists():
            self.log.warning("目标目录已存在，先清理：%s", final_dir)
            shutil.rmtree(final_dir, ignore_errors=True)
        shutil.move(str(staging), str(final_dir))
        return final_dir

    def _cleanup_staging(self, staging: Path) -> None:
        try:
            if staging and staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        except OSError:
            pass

    def _fail(self, job: dict, message: str) -> None:
        self._update(job, status="failed", error=message)
        self.log.warning("下载任务失败 job=%s album=%s：%s",
                         job.get("job_id"), job.get("album_id"), message)
