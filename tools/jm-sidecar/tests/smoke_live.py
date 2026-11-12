"""联网集成冒烟测试（真实 JM 网络 + 真实下载，需先用 start.ps1 拉起服务）。

用法（venv python）：
    .venv\\Scripts\\python.exe jm-service\\tests\\smoke_live.py
    .venv\\Scripts\\python.exe jm-service\\tests\\smoke_live.py --base http://127.0.0.1:8790 --download-id 1490076

覆盖：/health、/search 冷/热、/cover、/preview、/album、POST /download + /jobs、
viewer_url 可访问、/library、错误分支。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = os.environ.get("JM_SERVICE_BASE", "http://127.0.0.1:8790")


def http_json(url: str, method: str = "GET", body: dict | None = None, timeout: float = 30.0):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else {}, response.headers
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"raw": raw[:200].decode("utf-8", "replace")}
        return exc.code, payload, exc.headers


def http_status(url: str, timeout: float = 20.0):
    request = urllib.request.Request(url, headers={"User-Agent": "jm-service-smoke"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read(64)
            return response.status, response.headers.get("Content-Type", ""), len(payload)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", "") if exc.headers else "", 0


class Checker:
    def __init__(self):
        self.failures: list[str] = []
        self.metrics: dict = {}

    def check(self, name: str, condition: bool, detail: str = "") -> bool:
        status = "PASS" if condition else "FAIL"
        print(f"[{status}] {name}{(' — ' + detail) if detail else ''}")
        if not condition:
            self.failures.append(f"{name}: {detail}")
        return condition


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--query", default="全彩")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--download-id", default="1490076", help="已下载则验证 done，否则走 queue")
    parser.add_argument("--job-timeout", type=float, default=180.0)
    args = parser.parse_args()

    base = args.base.rstrip("/")
    checker = Checker()

    # 1. /health
    status, health, _ = http_json(f"{base}/health")
    checker.check("/health 200", status == 200 and health.get("ok"), f"status={status}")
    checker.check("/health 契约字段", all(k in health for k in (
        "ok", "version", "service", "viewer_base", "comics_dir", "downloaded_albums",
        "search_cache_entries", "jm_domain")), json.dumps(health, ensure_ascii=False))
    checker.metrics["health"] = health

    # 2. /search 冷（refresh=1 绕过缓存）
    query_enc = urllib.parse.quote(args.query)
    cold_url = f"{base}/search?q={query_enc}&limit={args.limit}&page=1&refresh=1"
    started = time.time()
    status, cold, _ = http_json(cold_url)
    cold_wall = (time.time() - started) * 1000
    checker.check("/search 冷 200", status == 200 and cold.get("ok"), f"status={status}")
    results = cold.get("results") or []
    checker.check("/search 冷 results 数量", len(results) == args.limit, f"{len(results)}")
    checker.check("/search 冷 耗时 ≤5000ms", cold_wall <= 5000, f"wall={cold_wall:.0f}ms service={cold.get('elapsed_ms')}ms")
    checker.check("/search 冷 cached=false", cold.get("cached") is False, str(cold.get("cached")))
    checker.check("/search 冷 text 行数", len((cold.get("text") or "").splitlines()) == len(results))
    if results:
        first = results[0]
        checker.check("/search 结果字段", all(k in first for k in (
            "rank", "id", "title", "authors", "tags", "page_count", "cover_url",
            "cover_file", "cover_http", "detail_ok")), json.dumps(first, ensure_ascii=False)[:300])
        checker.check("/search 封面文件存在", bool(first.get("cover_file")) and os.path.isfile(first["cover_file"]),
                      str(first.get("cover_file")))
    checker.metrics["search_cold_ms"] = round(cold_wall, 1)

    # 2.5 /search mode=author（按作者找 id 用）
    author_name = (results[0].get("authors") or [None])[0] if results else None
    if author_name:
        author_q = urllib.parse.quote(author_name)
        started = time.time()
        status, author_resp, _ = http_json(
            f"{base}/search?q={author_q}&mode=author&limit=5&page=1&refresh=1")
        author_wall = (time.time() - started) * 1000
        author_results = author_resp.get("results") or []
        checker.check("/search mode=author 200", status == 200 and author_resp.get("ok"),
                      f"status={status}")
        checker.check("/search mode=author 有结果", len(author_results) > 0,
                      f"query={author_name} count={len(author_results)}")
        checker.check("/search mode=author 结构不变", all(
            all(k in item for k in ("id", "title", "authors")) for item in author_results))
        checker.check("/search mode=author 冷 ≤5000ms", author_wall <= 5000,
                      f"wall={author_wall:.0f}ms")
        checker.metrics["search_author"] = {
            "query": author_name,
            "elapsed_ms": author_resp.get("elapsed_ms"),
            "results": [{"id": item["id"], "title": item["title"][:60],
                         "authors": item["authors"]} for item in author_results[:3]],
        }
    status, bad_mode, _ = http_json(f"{base}/search?q=abc&mode=bogus")
    checker.check("/search 非法 mode → 400 invalid_mode",
                  status == 400 and bad_mode.get("error") == "invalid_mode", f"status={status}")

    # 3. /search 热
    started = time.time()
    status, hot, _ = http_json(f"{base}/search?q={query_enc}&limit={args.limit}&page=1")
    hot_wall = (time.time() - started) * 1000
    checker.check("/search 热 200", status == 200 and hot.get("ok"))
    checker.check("/search 热 cached=true", hot.get("cached") is True, str(hot.get("cached")))
    checker.check("/search 热 耗时 <300ms", hot_wall < 300, f"wall={hot_wall:.0f}ms")
    checker.metrics["search_hot_ms"] = round(hot_wall, 1)

    # 4. /preview、/cover
    preview_url = (hot.get("preview_url") or "").replace("http://10.", "http://127.0.0.1:8088#")  # 仅展示
    preview_file = hot.get("preview_file")
    checker.check("/search preview_file 存在", bool(preview_file) and os.path.isfile(preview_file), str(preview_file))
    if preview_file:
        name = os.path.basename(preview_file)
        status, content_type, size = http_status(f"{base}/preview/{name}")
        checker.check("/preview HTTP 200 jpeg", status == 200 and "jpeg" in content_type and size > 0,
                      f"status={status} type={content_type} bytes>{size}")
    if results:
        cover_http = results[0].get("cover_http") or ""
        status, content_type, size = http_status(f"{base}{cover_http}")
        checker.check("/cover HTTP 200 jpeg", status == 200 and "jpeg" in content_type and size > 0,
                      f"status={status} type={content_type}")

    # 5. /album/<id>
    album_id = (results[0].get("id") if results else args.download_id)
    status, album_resp, _ = http_json(f"{base}/album/{album_id}")
    checker.check(f"/album/{album_id} 200", status == 200 and album_resp.get("ok"), f"status={status}")
    album = album_resp.get("album") or {}
    checker.check("/album 契约字段", all(k in album for k in (
        "id", "title", "authors", "tags", "page_count", "cover_url", "cover_http", "jm_url")),
        json.dumps(album, ensure_ascii=False)[:300])
    checker.metrics["album"] = album

    # 6. POST /download + /jobs
    status, download_resp, _ = http_json(f"{base}/download", method="POST", body={"id": args.download_id})
    checker.check("POST /download 200", status == 200 and download_resp.get("ok"),
                  f"status={status} body={json.dumps(download_resp, ensure_ascii=False)[:200]}")
    job = None
    if download_resp.get("status") == "queued":
        job_id = download_resp.get("job_id")
        checker.check("POST /download 返回 job_id", bool(job_id), str(job_id))
        deadline = time.time() + args.job_timeout
        last = {}
        while time.time() < deadline:
            status, last, _ = http_json(f"{base}/jobs/{job_id}")
            if last.get("status") in ("done", "failed"):
                break
            time.sleep(0.5)
        job = last
        checker.check("/jobs 最终 done", job.get("status") == "done",
                      json.dumps(job, ensure_ascii=False)[:300])
        checker.check("/jobs 契约字段", all(k in job for k in (
            "ok", "job_id", "album_id", "status", "phase", "elapsed_ms", "total_pages",
            "title", "viewer_url", "dir", "error")), "")
    elif download_resp.get("status") == "done":
        job = download_resp
        checker.check("POST /download 已下载返回 done", True)
    else:
        checker.check("POST /download status", False, str(download_resp.get("status")))

    viewer_url = (job or {}).get("viewer_url")
    checker.check("下载后返回 viewer_url", bool(viewer_url), str(viewer_url))
    if viewer_url:
        status, content_type, size = http_status(viewer_url, timeout=20)
        checker.check("viewer_url HTTP 200", status == 200, f"status={status} type={content_type}")
    downloaded_dir = (job or {}).get("dir") or album_resp.get("dir")
    checker.check("下载目录存在", bool(downloaded_dir) and os.path.isdir(downloaded_dir), str(downloaded_dir))
    checker.metrics["download"] = {
        "status": (job or {}).get("status"), "viewer_url": viewer_url,
        "dir": downloaded_dir, "elapsed_ms": (job or {}).get("elapsed_ms"),
        "total_pages": (job or {}).get("total_pages"),
    }

    # 6.5 GET /pdf/<id>（PDF 直发）
    pdf_url = f"{base}/pdf/{args.download_id}"
    pdf_started = time.time()
    pdf_result: dict = {"status": None, "bytes": 0}
    try:
        with urllib.request.urlopen(pdf_url, timeout=180) as resp:
            pdf_bytes = resp.read()
            pdf_result = {
                "status": resp.status,
                "content_type": resp.headers.get("Content-Type") or "",
                "content_length": resp.headers.get("Content-Length"),
                "disposition": resp.headers.get("Content-Disposition") or "",
                "bytes": len(pdf_bytes),
                "header": pdf_bytes[:5].decode("latin-1"),
                "eof": pdf_bytes.rstrip().endswith(b"%%EOF"),
                "pages": len(re.findall(rb"/Type\s*/Page(?!s)", pdf_bytes)),
            }
    except urllib.error.HTTPError as exc:
        pdf_result = {"status": exc.code, "error": exc.read()[:300].decode("utf-8", "replace")}
    pdf_result["wall_ms"] = round((time.time() - pdf_started) * 1000, 1)
    checker.metrics["pdf"] = pdf_result
    checker.check("/pdf 200 application/pdf", pdf_result["status"] == 200 and "application/pdf" in pdf_result.get("content_type", ""),
                  f'status={pdf_result["status"]} type={pdf_result.get("content_type")}')
    checker.check("/pdf %PDF 头 + %%EOF", pdf_result.get("header") == "%PDF-" and bool(pdf_result.get("eof")),
                  f'{pdf_result.get("header")} eof={pdf_result.get("eof")}')
    checker.check("/pdf Content-Length 与字节数一致", str(pdf_result.get("bytes")) == str(pdf_result.get("content_length")),
                  f'{pdf_result.get("content_length")} vs {pdf_result.get("bytes")}')
    checker.check(f"/pdf 下载名脱敏 JM{args.download_id}.pdf",
                  f"JM{args.download_id}.pdf" in pdf_result.get("disposition", ""),
                  pdf_result.get("disposition", ""))
    expected_pages = album.get("page_count") or (job or {}).get("total_pages")
    if expected_pages:
        checker.check("/pdf 页数 = album.page_count", pdf_result.get("pages") == expected_pages,
                      f'{pdf_result.get("pages")} vs {expected_pages}')
    checker.check("/pdf 大小 ≤20MB", pdf_result.get("bytes", 0) <= 20 * 1024 * 1024,
                  f'{pdf_result.get("bytes")} bytes')

    status, album_after_pdf, _ = http_json(f"{base}/album/{args.download_id}")
    checker.check("/album 带 pdf_ready/pdf_size",
                  album_after_pdf.get("pdf_ready") is True
                  and album_after_pdf.get("pdf_size") == pdf_result.get("bytes"),
                  f'pdf_ready={album_after_pdf.get("pdf_ready")} pdf_size={album_after_pdf.get("pdf_size")}')
    if job and job.get("job_id"):
        checker.check("/jobs 带 pdf_ready/pdf_size", "pdf_ready" in job and "pdf_size" in job, "")

    status, not_downloaded, _ = http_json(f"{base}/pdf/999999999")
    checker.check("/pdf 未下载 → 404 album_not_downloaded",
                  status == 404 and not_downloaded.get("error") == "album_not_downloaded",
                  f'status={status} body={json.dumps(not_downloaded, ensure_ascii=False)[:120]}')

    # 7. /library
    status, library, _ = http_json(f"{base}/library?limit=50&offset=0")
    checker.check("/library 200", status == 200 and library.get("ok"), f"status={status}")
    items = library.get("items") or []
    checker.check("/library 契约字段", all(all(k in item for k in (
        "id", "title", "dir", "viewer_url", "downloaded_at", "page_count")) for item in items), "")
    checker.check("/library 含目标 id", any(str(item["id"]) == args.download_id for item in items),
                  ",".join(str(item["id"]) for item in items))
    checker.metrics["library_count"] = len(items)

    # 8. 错误分支
    status, bad, _ = http_json(f"{base}/search?q=")
    checker.check("空 q → 400 ok=false", status == 400 and bad.get("ok") is False and bad.get("error"), f"status={status}")
    status, bad, _ = http_json(f"{base}/album/abc")
    checker.check("非法 id → 400 ok=false", status == 400 and bad.get("ok") is False, f"status={status}")
    status, bad, _ = http_json(f"{base}/jobs/not-exist")
    checker.check("未知 job → 404 ok=false", status == 404 and bad.get("ok") is False, f"status={status}")

    print("\n===== 实测数据 =====")
    print(json.dumps(checker.metrics, ensure_ascii=False, indent=2))
    if checker.failures:
        print(f"\nFAILED {len(checker.failures)} 项：")
        for failure in checker.failures:
            print("  -", failure)
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
