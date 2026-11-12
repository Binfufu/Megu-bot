"""Flask 边车服务：实现 docs/design-jm-feature.md 第 4 节 API 契约。"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_file

from .config import Config
from .jm_api import SEARCH_MODES, JmError, JmGateway
from .pdf import PdfError, ensure_album_pdf, pdf_status
from .preview import build_preview, preview_name
from .store import Store
from .util import (album_folder_name, is_album_id, jm_album_url, normalize_album_id, now_iso,
                   quote_abs_path, service_public_base, setup_logging,
                   truncate_text, viewer_public_base, viewer_url_for_dir)
from .viewer import ViewerManager
from .worker import DownloadWorker

VERSION = "1.0.0"
SERVICE_NAME = "jm-service"

_PREVIEW_RE = re.compile(r"^(p_[0-9a-f]{6}_\d+)\.jpg$")


def _json_error(code: str, message: str, status: int = 400):
    return jsonify({"ok": False, "error": code, "message": message}), status


def _error_status(code: str) -> int:
    if "timeout" in code:
        return 504
    if code in ("bad_request", "invalid_query", "invalid_param", "invalid_id", "invalid_json"):
        return 400
    if code in ("cover_not_found", "preview_not_found", "job_not_found", "not_found"):
        return 404
    return 502


def _int_param(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    value = int(raw)
    if value < minimum or value > maximum:
        raise ValueError(f"{name} 需在 {minimum}~{maximum} 之间")
    return value


class Service:
    def __init__(self, config: Config):
        self.cfg = config
        self.cfg.ensure_dirs()
        self.log = setup_logging(self.cfg.log_path)
        self.store = Store(self.cfg.db_path)
        self.gateway = JmGateway(self.cfg, self.log)
        self.worker = DownloadWorker(self.gateway, self.store, self.cfg, self.log)
        self.viewer = ViewerManager(self.cfg, self.log)
        self.app = self._create_app()
        self._shutdown_done = False

    # ------------------------------------------------------------------ #
    # 生命周期
    # ------------------------------------------------------------------ #
    def start_background(self) -> None:
        self.log.info("===== %s v%s 启动 =====", SERVICE_NAME, VERSION)
        self.log.info("配置：service=%s:%s viewer=%s:%s data_dir=%s config=%s",
                      self.cfg.host, self.cfg.port, self.cfg.viewer_host, self.cfg.viewer_port,
                      self.cfg.data_dir, self.cfg.config_path)
        try:
            purged = self.store.purge_search(self.cfg.search_ttl_sec)
            if purged:
                self.log.info("清理过期搜索缓存 %d 条", purged)
        except Exception as exc:  # noqa: BLE001
            self.log.warning("清理搜索缓存失败：%s", exc)
        self.gateway.warmup()
        self.worker.start()
        threading.Thread(target=self._start_viewer, name="viewer-bootstrap", daemon=True).start()

    def _start_viewer(self) -> None:
        try:
            self.viewer.start()
        except Exception as exc:  # noqa: BLE001
            self.log.exception("启动 jm-view-server 失败：%s", exc)

    def shutdown(self) -> None:
        if self._shutdown_done:
            return
        self._shutdown_done = True
        self.log.info("===== %s 停止 =====", SERVICE_NAME)
        try:
            self.viewer.stop()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.worker.stop()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.gateway.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.store.close()
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------------ #
    # Flask 应用
    # ------------------------------------------------------------------ #
    def _create_app(self) -> Flask:
        app = Flask(__name__)
        try:
            app.json.ensure_ascii = False
        except AttributeError:  # pragma: no cover - 旧 Flask
            app.config["JSON_AS_ASCII"] = False

        self._register_routes(app)
        app.register_error_handler(Exception, self._handle_exception)
        app.register_error_handler(404, lambda _e: _json_error("not_found", "接口不存在", 404))
        app.register_error_handler(405, lambda _e: _json_error("method_not_allowed", "请求方法不支持", 405))
        return app

    def _handle_exception(self, exc: Exception):
        self.log.exception("请求处理异常：%s", exc)
        return _json_error("internal_error", "服务内部错误", 500)

    def _register_routes(self, app: Flask) -> None:
        @app.get("/health")
        def health():
            return jsonify({
                "ok": True,
                "version": VERSION,
                "service": SERVICE_NAME,
                "viewer_base": viewer_public_base(self.cfg),
                "comics_dir": str(self.cfg.comics_dir),
                "downloaded_albums": self.store.count_albums(),
                "search_cache_entries": self.store.count_search(),
                "jm_domain": self.gateway.jm_domain,
            })

        @app.get("/search")
        def search():
            return self._handle_search()

        @app.get("/cover/<album_id>.jpg")
        def cover(album_id: str):
            return self._handle_cover(album_id)

        @app.get("/preview/<filename>")
        def preview(filename: str):
            return self._handle_preview(filename)

        @app.get("/album/<album_id>")
        def album(album_id: str):
            return self._handle_album(album_id)

        @app.post("/download")
        def download():
            return self._handle_download()

        @app.get("/jobs/<job_id>")
        def jobs(job_id: str):
            return self._handle_job(job_id)

        @app.get("/library")
        def library():
            return self._handle_library()

        @app.get("/pdf/<album_id>")
        def pdf(album_id: str):
            return self._handle_pdf(album_id)

    # ------------------------------------------------------------------ #
    # /search
    # ------------------------------------------------------------------ #
    def _handle_search(self):
        started = time.time()
        query = (request.args.get("q") or "").strip()
        if not query or len(query) > 60:
            return _json_error("invalid_query", "关键词长度需在 1~60 字符之间", 400)
        try:
            limit = _int_param("limit", 5, 1, 10)
            page = _int_param("page", 1, 1, 100000)
        except ValueError as exc:
            return _json_error("invalid_param", str(exc), 400)
        mode = (request.args.get("mode") or "site").strip().lower()
        if mode not in SEARCH_MODES:
            return _json_error("invalid_mode", f"mode 仅支持 {'/'.join(SEARCH_MODES)}", 400)
        refresh = request.args.get("refresh", "0") in ("1", "true", "yes")

        cache_key = self._search_cache_key(query, page, limit, mode)
        if not refresh:
            cached_payload = self.store.get_search(cache_key, self.cfg.search_ttl_sec)
            if cached_payload and self._preview_exists(cached_payload.get("preview_file")):
                cached_payload = dict(cached_payload)
                cached_payload["elapsed_ms"] = int((time.time() - started) * 1000)
                return jsonify({"ok": True, "cached": True, **cached_payload})

        try:
            search_result = self.gateway.search(query, page=page, mode=mode)
        except JmError as exc:
            self.log.warning("搜索失败 q=%r：%s", query, exc.message)
            return _json_error(exc.code, exc.message, _error_status(exc.code))

        items = search_result["items"][:limit]
        album_ids = [item["id"] for item in items]
        details = self.gateway.fetch_details(album_ids, timeout_each=4.0) if album_ids else {}
        covers = self.gateway.fetch_covers(album_ids, timeout=10.0) if album_ids else {}

        results = []
        for rank, item in enumerate(items, start=1):
            detail = details.get(item["id"]) or {}
            detail_ok = bool(detail)
            title = detail.get("title") or item.get("title") or ""
            results.append({
                "rank": rank,
                "id": item["id"],
                "title": title,
                "authors": detail.get("authors") or ([item["author"]] if item.get("author") else []),
                "tags": detail.get("tags") or item.get("tags") or [],
                "page_count": detail.get("page_count") if detail_ok else None,
                "cover_url": detail.get("cover_url") or item.get("image") or "",
                "cover_file": covers.get(item["id"]),
                "cover_http": f"/cover/{item['id']}.jpg",
                "detail_ok": detail_ok,
            })

        preview_file = self._ensure_preview(query, page, limit, results)
        preview_name_value = Path(preview_file).name if preview_file else None
        payload = {
            "query": query,
            "page": page,
            "limit": limit,
            "total": search_result["total"],
            "results": results,
            "preview_file": preview_file,
            "preview_url": (f"{service_public_base(self.cfg.host, self.cfg.port)}/preview/"
                            f"{preview_name_value}") if preview_name_value else None,
            "text": self._build_text(results),
        }
        if preview_name_value:
            try:
                self.store.put_search(cache_key, query, page, limit, payload)
            except Exception as exc:  # noqa: BLE001 - 缓存失败不影响响应
                self.log.warning("写搜索缓存失败：%s", exc)
        response = {"ok": True, "cached": False, **payload,
                    "elapsed_ms": int((time.time() - started) * 1000)}
        self.log.info("搜索完成 q=%r mode=%s page=%s limit=%s 命中%s本 %dms cached=false",
                      query, mode, page, limit, len(results), response["elapsed_ms"])
        return jsonify(response)

    @staticmethod
    def _search_cache_key(query: str, page: int, limit: int, mode: str = "site") -> str:
        raw = f"{mode}\x1f{query}\x1f{page}\x1f{limit}".encode("utf-8")
        return hashlib.sha1(raw).hexdigest()

    def _preview_exists(self, preview_file) -> bool:
        if not preview_file:
            return False
        try:
            return Path(preview_file).is_file() and Path(preview_file).stat().st_size > 0
        except OSError:
            return False

    def _ensure_preview(self, query: str, page: int, limit: int, results) -> str | None:
        name = preview_name(query, page, limit, [item["id"] for item in results])
        path = Path(self.cfg.previews_dir) / name
        if self._preview_exists(str(path)):
            return str(path)
        try:
            build_preview(results, path)
            self.log.info("生成拼图 %s（%d 本）", name, len(results))
            return str(path)
        except Exception as exc:  # noqa: BLE001 - 拼图失败不阻塞搜索
            self.log.exception("生成拼图失败：%s", exc)
            return None

    @staticmethod
    def _build_text(results) -> str:
        lines = []
        for item in results:
            lines.append(f"{item['rank']}.{item['id']} {truncate_text(item['title'], 40)}")
        return "\n".join(lines)

    # ------------------------------------------------------------------ #
    # /cover /preview
    # ------------------------------------------------------------------ #
    def _handle_cover(self, album_id: str):
        album_id = normalize_album_id(album_id)
        if not album_id:
            return _json_error("invalid_id", "编号需为数字", 400)
        path = self.gateway.cover_path(album_id)
        if not (path.exists() and path.stat().st_size > 0):
            try:
                cover_file = self.gateway.ensure_cover(album_id, timeout=10.0)
            except JmError as exc:
                return _json_error(exc.code, exc.message, _error_status(exc.code))
            if not cover_file:
                return _json_error("cover_not_found", "该本子暂无封面", 404)
            path = Path(cover_file)
        return send_file(str(path), mimetype="image/jpeg", conditional=True, max_age=86400)

    def _handle_preview(self, filename: str):
        match = _PREVIEW_RE.match(filename or "")
        if not match:
            return _json_error("preview_not_found", "拼图不存在", 404)
        path = Path(self.cfg.previews_dir) / f"{match.group(1)}.jpg"
        if not (path.exists() and path.stat().st_size > 0):
            return _json_error("preview_not_found", "拼图不存在", 404)
        return send_file(str(path), mimetype="image/jpeg", conditional=True, max_age=86400)

    # ------------------------------------------------------------------ #
    # /pdf
    # ------------------------------------------------------------------ #
    def _record_pdf_status(self, record: dict | None) -> tuple[bool, int | None]:
        if not record:
            return False, None
        ready, size, _path = pdf_status(
            self.cfg, record["id"], record.get("title") or "", record.get("pdf_path"))
        return ready, size

    def _handle_pdf(self, album_id: str):
        album_id = normalize_album_id(album_id)
        if not album_id:
            return _json_error("invalid_id", "编号需为数字", 400)
        record = self.store.get_album(album_id)
        if not record or not record.get("dir") or not Path(record["dir"]).is_dir():
            return _json_error("album_not_downloaded", "该本子还没下载，请先 POST /download", 404)
        force = request.args.get("refresh", "0") in ("1", "true", "yes")
        started = time.time()
        try:
            stats = ensure_album_pdf(
                self.cfg, album_id, record["dir"], record.get("title") or "",
                force=force, logger=self.log)
        except PdfError as exc:
            self.log.warning("PDF 生成失败 id=%s：%s", album_id, exc.message)
            return _json_error(exc.code, exc.message, 404 if exc.code == "pdf_no_images" else 500)
        except Exception as exc:  # noqa: BLE001
            self.log.exception("PDF 生成异常 id=%s：%s", album_id, exc)
            return _json_error("pdf_generate_failed", "PDF 生成失败，请稍后重试", 500)
        try:
            self.store.set_album_pdf(album_id, stats["path"], stats["size"])
        except Exception as exc:  # noqa: BLE001
            self.log.warning("写入 PDF 记录失败 id=%s：%s", album_id, exc)
        path = Path(stats["path"])
        self.log.info("GET /pdf/%s → %s（%d 页，%.2fMB，%dms%s）",
                      album_id, path.name, stats.get("pages") or 0, stats["size"] / 1048576,
                      int((time.time() - started) * 1000), "，缓存复用" if stats.get("cached") else "")
        # 注意：QQ 群有 R-18 内容审核，HTTP 下载名用通用名 JM<id>.pdf（磁盘文件名可含标题）
        return send_file(
            str(path),
            mimetype="application/pdf",
            as_attachment=True,
            download_name=f"JM{album_id}.pdf",
            conditional=True,
            max_age=0,
        )

    # ------------------------------------------------------------------ #
    # /album
    # ------------------------------------------------------------------ #
    def _detail_with_cache(self, album_id: str) -> dict:
        cached = self.store.get_detail(album_id, self.cfg.detail_ttl_sec)
        if cached:
            return cached
        detail = self.gateway.album_detail(album_id)
        try:
            self.store.put_detail(album_id, detail)
        except Exception as exc:  # noqa: BLE001
            self.log.warning("写详情缓存失败 id=%s：%s", album_id, exc)
        return detail

    def _album_payload(self, album_id: str, detail: dict | None = None,
                       record: dict | None = None) -> dict:
        detail = detail or {}
        record = record or {}
        title = detail.get("title") or record.get("title") or ""
        return {
            "id": album_id,
            "title": title,
            "authors": detail.get("authors") or record.get("authors") or [],
            "tags": detail.get("tags") or record.get("tags") or [],
            "page_count": detail.get("page_count") if detail else record.get("page_count"),
            "cover_url": detail.get("cover_url") or record.get("cover_url") or "",
            "cover_http": f"/cover/{album_id}.jpg",
            "jm_url": detail.get("jm_url") or jm_album_url(album_id),
        }

    def _handle_album(self, album_id: str):
        album_id = normalize_album_id(album_id)
        if not album_id:
            return _json_error("invalid_id", "编号需为数字", 400)
        try:
            detail = self._detail_with_cache(album_id)
        except JmError as exc:
            return _json_error(exc.code, exc.message, _error_status(exc.code))
        record = self.store.get_album(album_id)
        downloaded = bool(record and record.get("dir") and Path(record["dir"]).is_dir())
        viewer_url = self._record_viewer_url(record) if downloaded else None
        pdf_ready, pdf_size = self._record_pdf_status(record) if downloaded else (False, None)
        return jsonify({
            "ok": True,
            "album": self._album_payload(album_id, detail=detail, record=record),
            "downloaded": downloaded,
            "viewer_url": viewer_url,
            "dir": record.get("dir") if downloaded and record else None,
            "downloaded_at": record.get("downloaded_at") if downloaded and record else None,
            "pdf_ready": pdf_ready,
            "pdf_size": pdf_size,
        })

    def _record_viewer_url(self, record: dict | None) -> str | None:
        if not record or not record.get("dir"):
            return None
        directory = Path(record["dir"])
        if not directory.is_dir():
            return record.get("viewer_url")
        try:
            return viewer_url_for_dir(self.cfg, directory)
        except Exception:  # noqa: BLE001
            return record.get("viewer_url")

    # ------------------------------------------------------------------ #
    # /download /jobs
    # ------------------------------------------------------------------ #
    def _handle_download(self):
        body = request.get_json(silent=True)
        if body is None and request.form:
            body = request.form.to_dict()
        if not isinstance(body, dict):
            return _json_error("invalid_json", "请求体需为 JSON：{\"id\": \"<编号>\"}", 400)
        album_id = normalize_album_id(body.get("id"))
        if not album_id:
            return _json_error("invalid_id", "编号需为数字", 400)

        record = self.store.get_album(album_id)
        if record and record.get("dir") and Path(record["dir"]).is_dir():
            detail = self._detail_best_effort(album_id)
            return jsonify({
                "ok": True,
                "status": "done",
                "album": self._album_payload(album_id, detail=detail, record=record),
                "viewer_url": self._record_viewer_url(record),
            })

        active = self.worker.active_job_for_album(album_id)
        if active:
            detail = self._detail_best_effort(album_id)
            return jsonify({
                "ok": True,
                "status": "queued",
                "job_id": active["job_id"],
                "album": self._album_payload(album_id, detail=detail),
            })

        try:
            detail = self._detail_with_cache(album_id)
        except JmError as exc:
            return _json_error(exc.code, exc.message, _error_status(exc.code))

        job, created = self.worker.submit(album_id, detail)
        self.log.info("POST /download id=%s → job=%s（新建=%s）", album_id, job["job_id"], created)
        return jsonify({
            "ok": True,
            "status": "queued",
            "job_id": job["job_id"],
            "album": self._album_payload(album_id, detail=detail),
        })

    def _detail_best_effort(self, album_id: str) -> dict | None:
        cached = self.store.get_detail(album_id, self.cfg.detail_ttl_sec)
        if cached:
            return cached
        try:
            return self._detail_with_cache(album_id)
        except JmError:
            return None

    def _handle_job(self, job_id: str):
        job = self.worker.get_job(job_id)
        if not job:
            return _json_error("job_not_found", "任务不存在（服务重启后历史任务会丢失）", 404)
        return jsonify({
            "ok": True,
            "job_id": job["job_id"],
            "album_id": job["album_id"],
            "status": job["status"],
            "phase": job["phase"],
            "elapsed_ms": job["elapsed_ms"],
            "total_pages": job["total_pages"],
            "title": job["title"],
            "viewer_url": job["viewer_url"],
            "dir": job["dir"],
            "error": job["error"],
            "pdf_ready": bool(job.get("pdf_ready")),
            "pdf_size": job.get("pdf_size"),
        })

    # ------------------------------------------------------------------ #
    # /library
    # ------------------------------------------------------------------ #
    def _handle_library(self):
        try:
            limit = _int_param("limit", 50, 1, 200)
            offset_raw = request.args.get("offset", "0")
            offset = int(offset_raw or 0)
            if offset < 0:
                raise ValueError("offset 不能为负数")
        except ValueError as exc:
            return _json_error("invalid_param", str(exc), 400)
        items = []
        for record in self.store.list_albums(limit=limit, offset=offset):
            items.append({
                "id": record["id"],
                "title": record["title"],
                "dir": record["dir"],
                "viewer_url": self._record_viewer_url(record),
                "downloaded_at": record["downloaded_at"],
                "page_count": record["page_count"],
            })
        return jsonify({"ok": True, "items": items})
