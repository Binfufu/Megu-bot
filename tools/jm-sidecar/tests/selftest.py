"""合成自测（不联网）：Python 标准库 unittest。

用法（venv python，无需环境变量）：
    .venv\\Scripts\\python.exe jm-service\\tests\\selftest.py -v

覆盖：文件名安全化、拼图、SQLite 缓存/漫画库、下载 job 去重与目录拍平、
配置加载、Flask 契约错误分支（test_client，不触发网络）。
真实联网验证见 smoke_live.py（需先 start.ps1）。
"""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

TESTS_DIR = Path(__file__).resolve().parent
SERVICE_DIR = TESTS_DIR.parent
ROOT_DIR = SERVICE_DIR.parent
for extra in (SERVICE_DIR, ROOT_DIR / "JMComic-Crawler-Python" / "src", ROOT_DIR / "jm-view-server" / "src"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from PIL import Image, ImageDraw  # noqa: E402

from jm_service import pdf as pdf_mod  # noqa: E402
from jm_service import util  # noqa: E402
from jm_service.app import Service  # noqa: E402
from jm_service.config import Config, DEFAULT_CONFIG, deep_merge  # noqa: E402
from jm_service.pdf import (build_album_pdf, ensure_album_pdf,  # noqa: E402
                            list_album_images, pdf_path_for, pdf_status)
from jm_service.preview import PREVIEW_WIDTH, build_preview, preview_name  # noqa: E402
from jm_service.store import Store  # noqa: E402
from jm_service.util import viewer_url_for_dir  # noqa: E402
from jm_service.worker import DownloadWorker, flatten_single_chapter  # noqa: E402


def parse_pdf_structure(path: str | Path) -> dict:
    """纯标准库解析 PDF 结构：%PDF 头/xref 偏移/页数/DCTDecode 且 JPEG 可解码。"""
    import io

    data = Path(path).read_bytes()
    result = {
        "header": data.startswith(b"%PDF-1."),
        "eof": data.rstrip().endswith(b"%%EOF"),
        "size": len(data),
    }
    match = re.search(rb"startxref\s+(\d+)", data)
    result["xref_ok"] = False
    if match:
        offset = int(match.group(1))
        result["xref_ok"] = data[offset:offset + 4] == b"xref"
        lines = data[offset:].split(b"\n")
        count = int(lines[1].split()[1])
        offsets = []
        for line in lines[2:2 + count]:
            parts = line.split()
            if len(parts) == 3 and parts[2] != b"f":
                offsets.append(int(parts[0]))
        result["offsets_ok"] = all(re.match(rb"\d+\s+\d+\s+obj", data[o:o + 20]) for o in offsets)
    result["pages"] = len(re.findall(rb"/Type\s*/Page(?!s)", data))
    result["dct_pages"] = data.count(b"/DCTDecode")
    decoded = 0
    for match_obj in re.finditer(rb"(\d+)\s+\d+\s+obj", data):
        obj_end = data.find(b"endobj", match_obj.end())
        chunk = data[match_obj.end():obj_end + 6] if obj_end > 0 else b""
        if b"/DCTDecode" not in chunk or b"stream" not in chunk:
            continue
        length_match = re.search(rb"/Length\s+(\d+)", chunk)
        if not length_match:
            continue
        stream_pos = chunk.find(b"stream") + len(b"stream")
        start = match_obj.end() + stream_pos
        while data[start:start + 1] in (b"\r", b"\n"):
            start += 1
        jpeg = data[start:start + int(length_match.group(1))]
        if not jpeg.startswith(b"\xff\xd8"):
            continue
        try:
            with Image.open(io.BytesIO(jpeg)) as image:
                image.load()
                decoded += 1
        except Exception:  # noqa: BLE001
            continue
    result["jpeg_decoded"] = decoded
    return result



def _make_config(tmp_root: Path, **overrides) -> Config:
    raw = deep_merge(DEFAULT_CONFIG, {
        "host": "127.0.0.1",
        "port": 18790,
        "viewer": {"enabled": False, "auto_spawn": False, "port": 18088},
        "paths": {"data_dir": "data"},
    })
    raw = deep_merge(raw, overrides)
    return Config(raw, root=tmp_root)


class TempDirTest(unittest.TestCase):
    def setUp(self):
        # 临时目录固定放在 jm-service/.test-tmp，避免污染工作区根目录
        self._test_tmp_dir = TESTS_DIR / ".test-tmp"
        self._test_tmp_dir.mkdir(exist_ok=True)
        self._tmp = tempfile.TemporaryDirectory(prefix="jm-service-test-", dir=str(self._test_tmp_dir))
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

        # 全局 logger 会被多个用例复用，先清理其文件句柄，否则 Windows 下临时目录删不掉
        logger = logging.getLogger("jm-service")
        def _clear_handlers():
            for handler in list(logger.handlers):
                try:
                    handler.close()
                except Exception:
                    pass
                logger.removeHandler(handler)
        self.addCleanup(_clear_handlers)


class TestUtil(TempDirTest):
    def test_sanitize_illegal_chars(self):
        name = util.sanitize_win_name(r'a<b>c:d"e/f\g|h?i*j')
        self.assertFalse(re.search(r'[<>:"/\\|?*]', name), name)
        self.assertTrue(name)

    def test_sanitize_truncate_40(self):
        name = util.sanitize_win_name("长" * 80)
        self.assertEqual(len(name), 40)

    def test_sanitize_trailing_dots_and_reserved(self):
        self.assertEqual(util.sanitize_win_name("abc... "), "abc")
        self.assertTrue(util.sanitize_win_name("CON").startswith("_"))
        self.assertEqual(util.sanitize_win_name(""), "untitled")

    def test_album_folder_name(self):
        folder = util.album_folder_name("1490076", "标题" * 30)
        self.assertTrue(folder.startswith("JM1490076-"))
        self.assertLessEqual(len(folder), len("JM1490076-") + 40)

    def test_truncate_text(self):
        self.assertEqual(util.truncate_text("abcdef", 3), "abc")
        self.assertEqual(util.truncate_text("ab", 3), "ab")

    def test_normalize_id(self):
        self.assertEqual(util.normalize_album_id("01490076"), "1490076")
        self.assertEqual(util.normalize_album_id(" 123 "), "123")
        self.assertEqual(util.normalize_album_id("abc"), "")
        self.assertEqual(util.normalize_album_id(""), "")

    def test_pick_viewer_dir(self):
        flat = self.tmp / "flat"
        flat.mkdir()
        for i in range(2):
            Image.new("RGB", (10, 10), (i * 40, 0, 0)).save(flat / f"{i + 1:05}.webp")
        self.assertEqual(util.pick_viewer_dir(flat), flat)

        nested = self.tmp / "nested"
        (nested / "第1话").mkdir(parents=True)
        Image.new("RGB", (10, 10)).save(nested / "第1话" / "00001.jpg")
        self.assertEqual(util.pick_viewer_dir(nested), nested / "第1话")

    def test_viewer_url_for_dir(self):
        cfg = _make_config(self.tmp)
        directory = self.tmp / "data" / "comics" / "JM1-x y"
        directory.mkdir(parents=True)
        Image.new("RGB", (10, 10)).save(directory / "00001.jpg")
        url = viewer_url_for_dir(cfg, directory)
        self.assertIn("/jm_view?path=", url)
        self.assertNotIn(" ", url)
        self.assertTrue(url.startswith("http://"))
        self.assertIn(":18088/jm_view?path=", url)


class TestPreview(TempDirTest):
    def _covers(self, count=3):
        results = []
        for index in range(count):
            path = self.tmp / f"cover_{index}.jpg"
            Image.new("RGB", (200 + index * 30, 300), (30 * index, 80, 120)).save(path)
            results.append({"rank": index + 1, "id": f"1000{index}", "title": f"t{index}",
                            "cover_file": str(path)})
        return results

    def test_preview_name_pattern(self):
        name = preview_name("全彩", 1, 5, ["1", "2", "3"])
        self.assertRegex(name, r"^p_[0-9a-f]{6}_5\.jpg$")
        self.assertEqual(name, preview_name("全彩", 1, 5, ["1", "2", "3"]))

    def test_build_preview_with_covers(self):
        out = self.tmp / "previews" / "p_abcdef_3.jpg"
        build_preview(self._covers(3), out)
        self.assertTrue(out.exists())
        with Image.open(out) as image:
            self.assertEqual(image.width, PREVIEW_WIDTH)
            self.assertGreater(image.height, 100)

    def test_build_preview_placeholder(self):
        results = [{"rank": 1, "id": "1", "title": "no cover", "cover_file": None}]
        out = self.tmp / "previews" / "p_000000_1.jpg"
        build_preview(results, out)
        self.assertTrue(out.exists() and out.stat().st_size > 0)


class TestStore(TempDirTest):
    def setUp(self):
        super().setUp()
        self.store = Store(self.tmp / "cache" / "test.sqlite3")
        self.addCleanup(self.store.close)

    def test_search_cache_roundtrip_and_ttl(self):
        payload = {"query": "全彩", "results": [{"id": "1"}], "text": "1.1 标题"}
        self.store.put_search("k1", "全彩", 1, 5, payload)
        self.assertEqual(self.store.get_search("k1", 3600)["query"], "全彩")
        self.assertEqual(self.store.count_search(), 1)
        # TTL 极短 → 过期（Windows 时钟粒度约 15ms，睡 0.1s 保证稳定）
        time.sleep(0.1)
        self.assertIsNone(self.store.get_search("k1", 0.05))
        self.assertEqual(self.store.purge_search(0), 1)

    def test_detail_cache(self):
        self.store.put_detail("1490076", {"id": "1490076", "title": "本子"})
        self.assertEqual(self.store.get_detail("1490076", 3600)["title"], "本子")
        time.sleep(0.1)
        self.assertIsNone(self.store.get_detail("1490076", 0.05))

    def test_albums(self):
        self.store.upsert_album({
            "id": "1490076", "title": "中文标题", "dir": str(self.tmp / "JM1490076-x"),
            "viewer_url": "http://x/jm_view?path=a", "page_count": 18,
            "authors": ["作者"], "tags": ["扶他"], "cover_url": "http://c/1.jpg",
            "downloaded_at": "2026-01-01T00:00:00+08:00",
        })
        record = self.store.get_album("1490076")
        self.assertEqual(record["title"], "中文标题")
        self.assertEqual(record["page_count"], 18)
        self.assertEqual(record["authors"], ["作者"])
        self.assertEqual(self.store.count_albums(), 1)
        items = self.store.list_albums(limit=10, offset=0)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "1490076")

    def test_thread_concurrency(self):
        import threading

        def worker(index):
            self.store.put_search(f"k{index}", f"q{index}", 1, 5, {"index": index})
            self.assertIsNotNone(self.store.get_search(f"k{index}", 3600))
            self.store.close()  # 关闭该线程的连接，避免 Windows 临时目录被占用

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(self.store.count_search(), 8)


class TestFlatten(TempDirTest):
    def test_flatten_single_chapter(self):
        staging = self.tmp / "staging" / "JM1"
        subdir = staging / "album-title" / "第1话"
        subdir.mkdir(parents=True)
        for index in range(3):
            Image.new("RGB", (8, 8)).save(subdir / f"{index + 1:05}.webp")
        log = logging.getLogger("test-flatten")
        flatten_single_chapter(staging, log)
        self.assertEqual(len(list(staging.glob("*.webp"))), 3)
        self.assertFalse(subdir.exists())

    def test_flatten_keeps_multi_chapters(self):
        staging = self.tmp / "staging" / "JM2"
        for chapter in ("1", "2"):
            subdir = staging / chapter
            subdir.mkdir(parents=True)
            Image.new("RGB", (8, 8)).save(subdir / "00001.webp")
        flatten_single_chapter(staging, logging.getLogger("test-flatten"))
        self.assertEqual(len(list(staging.glob("*/00001.webp"))), 2)


class TestPdf(TempDirTest):
    def _make_album(self, name="album", count=4, width=1400, height=1900, suffix=".webp"):
        directory = self.tmp / name
        directory.mkdir(parents=True)
        for index in range(count):
            image = Image.new("RGB", (width + index * 40, height), ((index * 60) % 255, 90, 160))
            draw = ImageDraw.Draw(image)
            for y in range(0, height, 90):
                draw.line([(0, y), (width, (y * 3) % height)], fill=(255, 255, 255), width=6)
            image.save(directory / f"{index + 1:05}{suffix}")
        return directory

    def _config(self):
        cfg = _make_config(self.tmp)
        cfg.ensure_dirs()
        return cfg

    def test_list_album_images_natural_order(self):
        album = self._make_album()
        # 重命名出乱序文件名，验证自然排序
        for old, new in ((album / "00001.webp", album / "1.webp"),
                         (album / "00002.webp", album / "2.webp"),
                         (album / "00003.webp", album / "10.webp"),
                         (album / "00004.webp", album / "20.webp")):
            old.rename(new)
        names = [path.name for path in list_album_images(album)]
        self.assertEqual(names, ["1.webp", "2.webp", "10.webp", "20.webp"])

    def test_list_album_images_chapters(self):
        album = self.tmp / "chapters"
        for chapter in ("2", "1"):
            chapter_dir = album / chapter
            chapter_dir.mkdir(parents=True)
            for index in range(2):
                Image.new("RGB", (300, 400)).save(chapter_dir / f"{index + 1:05}.jpg")
        names = [path.parent.name + "/" + path.name for path in list_album_images(album)]
        self.assertEqual(names, ["1/00001.jpg", "1/00002.jpg", "2/00001.jpg", "2/00002.jpg"])

    def test_build_pdf_structure(self):
        album = self._make_album(count=4)
        # 混入一张 RGBA png，验证透明背景转 RGB
        Image.new("RGBA", (900, 1200), (255, 0, 0, 120)).save(album / "00005.png")
        out = self.tmp / "pdfs" / "JM1-test.pdf"
        stats = build_album_pdf(album, out)
        self.assertTrue(out.is_file())
        self.assertEqual(stats["pages"], 5)
        self.assertEqual(stats["width"], 1000)
        structure = parse_pdf_structure(out)
        self.assertTrue(structure["header"], structure)
        self.assertTrue(structure["eof"], structure)
        self.assertTrue(structure["xref_ok"], structure)
        self.assertTrue(structure["offsets_ok"], structure)
        self.assertEqual(structure["pages"], 5)
        self.assertGreaterEqual(structure["dct_pages"], 5)
        self.assertGreaterEqual(structure["jpeg_decoded"], 5)

    def test_max_pages_cap(self):
        album = self._make_album(count=6)
        out = self.tmp / "pdfs" / "cap.pdf"
        stats = build_album_pdf(album, out, max_pages=3)
        self.assertEqual(stats["pages"], 3)
        self.assertEqual(parse_pdf_structure(out)["pages"], 3)

    def test_over_limit_falls_back(self):
        album = self._make_album(count=2)
        out = self.tmp / "pdfs" / "small.pdf"
        stats = build_album_pdf(album, out, max_bytes=1)
        self.assertEqual((stats["width"], stats["quality"]), (640, 60))
        self.assertGreater(stats["size"], 0)
        self.assertEqual(parse_pdf_structure(out)["pages"], 2)

    def test_ensure_album_pdf_reuse_and_status(self):
        cfg = self._config()
        album = self._make_album(count=3)
        out = pdf_path_for(cfg, "42", "标题")
        self.assertTrue(out.name.startswith("JM42-"))
        self.assertTrue(out.name.endswith(".pdf"))
        first = ensure_album_pdf(cfg, "42", album, "标题")
        self.assertFalse(first.get("cached"))
        self.assertTrue(out.is_file())
        second = ensure_album_pdf(cfg, "42", album, "标题")
        self.assertTrue(second.get("cached"))
        self.assertEqual(second["elapsed_ms"], 0)
        self.assertEqual(second["size"], first["size"])
        ready, size, path = pdf_status(cfg, "42", "标题")
        self.assertTrue(ready)
        self.assertEqual(size, first["size"])
        self.assertEqual(Path(path), out)

    def test_default_attempts_chain(self):
        self.assertEqual(pdf_mod.default_attempts(1000, 80),
                         [(1000, 80), (850, 75), (720, 65), (640, 60)])
        self.assertEqual(pdf_mod.default_attempts(640, 60), [(640, 60)])

    def test_build_pdf_default_limits(self):
        import inspect
        params = inspect.signature(pdf_mod.build_album_pdf).parameters
        self.assertEqual(params["max_pages"].default, 300)
        self.assertEqual(params["max_bytes"].default, 20 * 1024 * 1024)

    def test_pdf_path_name_truncated(self):
        cfg = self._config()
        path = pdf_path_for(cfg, "1490076", "很长的标题" * 30)
        self.assertTrue(path.name.startswith("JM1490076-"))
        self.assertLessEqual(len(path.stem), len("JM1490076-") + 40)
        self.assertFalse(re.search(r'[<>:"/\\|?*]', path.name))


class TestStoreMigration(TempDirTest):
    def test_old_db_gets_pdf_columns(self):
        db_path = self.tmp / "old" / "old.sqlite3"
        db_path.parent.mkdir(parents=True)
        conn = sqlite3.connect(str(db_path))
        conn.executescript("""
            CREATE TABLE albums (
                album_id TEXT PRIMARY KEY, title TEXT NOT NULL, dir TEXT NOT NULL,
                viewer_url TEXT, page_count INTEGER, authors TEXT, tags TEXT,
                cover_url TEXT, downloaded_at TEXT, updated_at REAL NOT NULL
            );
        """)
        conn.execute(
            "INSERT INTO albums VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("1490076", "旧记录", "C:/old", None, 18, "[]", "[]", None,
             "2026-01-01T00:00:00+08:00", 0.0),
        )
        conn.commit()
        conn.close()

        store = Store(db_path)
        self.addCleanup(store.close)
        columns = {row["name"] for row in store._get_conn().execute("PRAGMA table_info(albums)").fetchall()}
        for column in ("pdf_path", "pdf_size", "pdf_updated_at"):
            self.assertIn(column, columns)
        record = store.get_album("1490076")
        self.assertEqual(record["title"], "旧记录")
        self.assertIsNone(record["pdf_path"])
        store.set_album_pdf("1490076", "C:/pdfs/JM1490076.pdf", 12345)
        record = store.get_album("1490076")
        self.assertEqual(record["pdf_path"], "C:/pdfs/JM1490076.pdf")
        self.assertEqual(record["pdf_size"], 12345)


class TestConfig(TempDirTest):
    def test_defaults(self):
        cfg = Config({}, root=self.tmp)
        self.assertEqual(cfg.port, 8790)
        self.assertEqual(cfg.viewer_port, 8088)
        self.assertTrue(cfg.viewer_enabled)
        self.assertEqual(cfg.search_ttl_sec, 21600)
        self.assertEqual(cfg.detail_ttl_sec, 86400)
        self.assertEqual(cfg.pdf_width, 1000)
        self.assertEqual(cfg.pdf_quality, 80)
        self.assertEqual(cfg.pdf_max_pages, 300)
        self.assertEqual(cfg.pdf_max_bytes, 20 * 1024 * 1024)
        self.assertEqual(cfg.pdfs_dir.name, "pdfs")

    def test_load_file_and_dirs(self):
        config_dir = self.tmp / "config"
        config_dir.mkdir()
        config_path = config_dir / "jm-service.json"
        config_path.write_text('{"port": 9900, "viewer": {"port": 9901}, '
                               '"paths": {"data_dir": "mydata"}}', encoding="utf-8")
        cfg = Config.load(config_path)
        self.assertEqual(cfg.port, 9900)
        self.assertEqual(cfg.viewer_port, 9901)

        # 验证 ensure_dirs 时把 root 指向临时目录，避免在真实工作区建目录
        tmp_cfg = Config({"paths": {"data_dir": "mydata"}}, root=self.tmp)
        tmp_cfg.ensure_dirs()
        self.assertTrue(tmp_cfg.comics_dir.is_dir())
        self.assertTrue(tmp_cfg.covers_dir.is_dir())
        self.assertTrue(tmp_cfg.previews_dir.is_dir())
        self.assertTrue(tmp_cfg.staging_dir.is_dir())
        self.assertTrue(tmp_cfg.logs_dir.is_dir())

    def test_deep_merge(self):
        merged = deep_merge({"a": {"b": 1, "c": 2}}, {"a": {"c": 3}})
        self.assertEqual(merged, {"a": {"b": 1, "c": 3}})

    def test_env_override(self):
        old = os.environ.get("JM_SERVICE_PORT")
        os.environ["JM_SERVICE_PORT"] = "9191"
        try:
            cfg = Config.load(self.tmp / "not-exists.json")
            self.assertEqual(cfg.port, 9191)
        finally:
            if old is None:
                os.environ.pop("JM_SERVICE_PORT", None)
            else:
                os.environ["JM_SERVICE_PORT"] = old


class TestWorkerSubmit(TempDirTest):
    def test_dedupe_same_album(self):
        cfg = _make_config(self.tmp)
        cfg.ensure_dirs()
        store = Store(self.tmp / "cache" / "w.sqlite3")
        self.addCleanup(store.close)
        worker = DownloadWorker(gateway=None, store=store, config=cfg, logger=logging.getLogger("test-worker"))
        album = {"title": "t", "page_count": 5}
        job1, created1 = worker.submit("123", album)
        job2, created2 = worker.submit("123", album)
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(job1["job_id"], job2["job_id"])
        snapshot = worker.get_job(job1["job_id"])
        self.assertEqual(snapshot["status"], "queued")
        self.assertEqual(snapshot["album_id"], "123")
        self.assertIn("elapsed_ms", snapshot)
        self.assertFalse(snapshot["pdf_ready"])
        self.assertIsNone(snapshot["pdf_size"])


class TestAppContract(TempDirTest):
    def setUp(self):
        super().setUp()
        self.cfg = _make_config(self.tmp)
        self.service = Service(self.cfg)
        self.addCleanup(self.service.store.close)
        self.client = self.service.app.test_client()

    def _get(self, path):
        response = self.client.get(path)
        return response.status_code, response.get_json()

    def test_health(self):
        status, payload = self._get("/health")
        self.assertEqual(status, 200)
        for key in ("ok", "version", "service", "viewer_base", "comics_dir",
                    "downloaded_albums", "search_cache_entries", "jm_domain"):
            self.assertIn(key, payload)
        self.assertEqual(payload["service"], "jm-service")
        self.assertEqual(payload["downloaded_albums"], 0)
        self.assertEqual(payload["search_cache_entries"], 0)

    def test_search_mode_validation(self):
        status, payload = self._get("/search?q=abc&mode=bogus")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_mode")

    def test_search_mode_cache_key_includes_mode(self):
        fake = {"total": 0, "items": []}
        with patch.object(self.service.gateway, "search", return_value=fake) as mocked:
            status_site, payload_site = self._get("/search?q=龙&mode=site")
            status_author, payload_author = self._get("/search?q=龙&mode=author")
            self.assertEqual((status_site, status_author), (200, 200))
            self.assertFalse(payload_site.get("cached"))
            self.assertFalse(payload_author.get("cached"))
            self.assertEqual(mocked.call_count, 2)
            self.assertEqual(mocked.call_args_list[0].kwargs.get("mode"), "site")
            self.assertEqual(mocked.call_args_list[1].kwargs.get("mode"), "author")
            # 同 mode 再查 → 命中缓存，不再调后端
            status_hot, payload_hot = self._get("/search?q=龙&mode=author")
            self.assertEqual(status_hot, 200)
            self.assertTrue(payload_hot.get("cached"))
            self.assertEqual(mocked.call_count, 2)

    def test_search_param_errors(self):
        status, payload = self._get("/search?q=")
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "invalid_query")

        status, payload = self._get("/search?q=abc&limit=99")
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "invalid_param")

        status, payload = self._get("/search?q=" + "长" * 61)
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_query")

    def test_album_and_cover_invalid(self):
        status, payload = self._get("/album/abc")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_id")

        status, payload = self._get("/cover/abc.jpg")
        self.assertEqual(status, 400)

        status, payload = self._get("/preview/nope.jpg")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "preview_not_found")

    def test_pdf_errors(self):
        status, payload = self._get("/pdf/abc")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_id")

        status, payload = self._get("/pdf/999999999")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "album_not_downloaded")

    def test_download_invalid(self):
        response = self.client.post("/download", json={"id": "abc"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "invalid_id")

        response = self.client.post("/download", data="not json", content_type="text/plain")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["ok"])

    def test_jobs_and_library(self):
        status, payload = self._get("/jobs/not-exist")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "job_not_found")

        status, payload = self._get("/library?limit=50&offset=0")
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"], [])

        status, payload = self._get("/library?limit=0")
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
