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
from jm_service.jm_api import JmError, JmGateway  # noqa: E402
from jm_service.pdf import (build_album_pdf, ensure_album_pdf, ensure_unit_pdf,  # noqa: E402
                            list_album_images, pdf_path_for, pdf_path_for_unit, pdf_status)
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
    centers = []
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
                centers.append(image.convert("RGB").getpixel((image.width // 2, image.height // 2)))
        except Exception:  # noqa: BLE001
            continue
    result["jpeg_decoded"] = decoded
    result["jpeg_centers"] = centers
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


# ---------------------------------------------------------------------- #
# 合成对象（不联网、不 import jmcomic）：模拟真实 JmPhotoDetail / JmAlbumDetail
# ---------------------------------------------------------------------- #
class FakeChapter:
    """合成章节；只给传入的字段，方便测防御式 getattr。"""

    def __init__(self, photo_id=None, name="", index=None, album_id=None, **extra):
        if photo_id is not None:
            self.photo_id = photo_id
        if name:
            self.name = name
        if index is not None:
            self.index = index
        if album_id is not None:
            self.album_id = album_id
        for key, value in extra.items():
            setattr(self, key, value)


class FakeAlbum:
    """合成本子：可 len()、可迭代，每次迭代产出一个章节实体。"""

    def __init__(self, album_id: str, name: str, chapters, page_count: int = 0,
                 authors=None, tags=None):
        self.album_id = album_id
        self.name = name
        self._chapters = list(chapters)
        self.page_count = page_count
        self.authors = authors or []
        self.tags = tags or []

    def __len__(self):
        return len(self._chapters)

    def __iter__(self):
        return iter(self._chapters)


def _units_two():
    return [
        {"index": 1, "unit_id": "9001", "title": "第1话", "page_count": 2},
        {"index": 2, "unit_id": "9002", "title": "第2话", "page_count": 3},
    ]


def _album_detail(album_id: str = "900", title: str = "合成作品", units=None) -> dict:
    """与 JmGateway.album_detail 返回形状一致的合成详情（含 units）。"""
    units = _units_two() if units is None else list(units)
    return {
        "id": str(album_id),
        "title": title,
        "authors": [],
        "tags": [],
        "page_count": sum(int(u.get("page_count") or 0) for u in units),
        "chapter_count": len(units),
        "unit_count": len(units),
        "units": units,
        "cover_url": "",
        "jm_url": f"https://18comic.vip/album/{album_id}",
    }


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


class TestJmUnits(TempDirTest):
    """判据 1/3/4：_build_album 的 units 与 resolve_number 的解析顺序（全程离线）。"""

    def setUp(self):
        super().setUp()
        self.cfg = _make_config(self.tmp)
        self.gateway = JmGateway(self.cfg, logging.getLogger("test-jm-units"))
        self.addCleanup(self.gateway.shutdown)

    def test_build_album_units(self):
        album = FakeAlbum("1205081", "合成作品", [
            FakeChapter(photo_id="212214", name="第1话 …", index=1),
            FakeChapter(photo_id="212215", name="第2话 …", index=2, page_count=12),
        ])
        detail = self.gateway._build_album(album)
        self.assertEqual(detail["unit_count"], 2)
        self.assertEqual(detail["chapter_count"], 2)  # 老字段与 unit_count 同值
        self.assertEqual([u["index"] for u in detail["units"]], [1, 2])
        self.assertEqual([u["unit_id"] for u in detail["units"]], ["212214", "212215"])
        self.assertEqual(detail["units"][0]["title"], "第1话 …")
        self.assertIsNone(detail["units"][0]["page_count"])  # 取不到给 null
        self.assertEqual(detail["units"][1]["page_count"], 12)

    def test_build_album_units_defensive_aliases(self):
        class WeirdChapter:
            def __init__(self):
                self.photo_id = 777
                self.title = "别名字段"
                self.sort = "3"

        class WeirdAlbum:
            album_id = "555"
            name = "别名作品"
            authors = []
            tags = []
            page_count = 10

            def __len__(self):
                return 1

            def __iter__(self):
                return iter([WeirdChapter()])

        detail = self.gateway._build_album(WeirdAlbum())
        self.assertEqual(detail["units"], [{"index": 3, "unit_id": "777",
                                            "title": "别名字段", "page_count": None}])
        self.assertEqual(detail["unit_count"], 1)

    def test_build_album_single_chapter_has_one_unit(self):
        album = FakeAlbum("42", "单章作品", [FakeChapter(photo_id="4201", name="唯一章", index=1)])
        detail = self.gateway._build_album(album)
        self.assertEqual(detail["unit_count"], 1)
        self.assertEqual(len(detail["units"]), 1)
        self.assertEqual(detail["units"][0]["unit_id"], "4201")

    def test_resolve_number_album_first_and_never_search(self):
        album = _album_detail("1205081")
        with patch.object(self.gateway, "search",
                          side_effect=AssertionError("resolve 不能调用站内搜索")), \
             patch.object(self.gateway, "album_detail", return_value=album) as album_mock, \
             patch.object(self.gateway, "photo_detail",
                          side_effect=AssertionError("album 命中不应再查章节")):
            resolved = self.gateway.resolve_number("1205081")
        self.assertEqual(resolved["kind"], "album")
        self.assertEqual(resolved["album"]["unit_count"], 2)
        self.assertIsNone(resolved["matched_unit"])
        album_mock.assert_called_once_with("1205081")

    def test_resolve_number_photo_to_parent(self):
        parent = _album_detail("900")
        with patch.object(self.gateway, "search",
                          side_effect=AssertionError("resolve 不能调用站内搜索")), \
             patch.object(self.gateway, "album_detail",
                          side_effect=[JmError("jm_detail_failed", "不是作品号"), parent]), \
             patch.object(self.gateway, "photo_detail",
                          return_value={"id": "9002", "title": "第2话", "album_id": "900"}) as photo_mock:
            resolved = self.gateway.resolve_number("9002")
        self.assertEqual(resolved["kind"], "photo")
        self.assertEqual(resolved["album"]["id"], "900")
        self.assertEqual(resolved["matched_unit"]["unit_id"], "9002")
        self.assertEqual(resolved["matched_unit"]["index"], 2)
        self.assertEqual(resolved["matched_unit"]["title"], "第2话")
        photo_mock.assert_called_once_with("9002")

    def test_resolve_number_not_found(self):
        with patch.object(self.gateway, "search",
                          side_effect=AssertionError("resolve 不能调用站内搜索")), \
             patch.object(self.gateway, "album_detail",
                          side_effect=JmError("jm_detail_failed", "没有")), \
             patch.object(self.gateway, "photo_detail",
                          side_effect=JmError("jm_detail_failed", "没有")):
            with self.assertRaises(JmError) as ctx:
                self.gateway.resolve_number("999999")
        self.assertEqual(ctx.exception.code, "not_found")

    def test_photo_album_id_defensive_aliases(self):
        from types import SimpleNamespace
        self.assertEqual(self.gateway._photo_album_id(SimpleNamespace(album_id=900)), "900")
        self.assertEqual(self.gateway._photo_album_id(SimpleNamespace(series_id="901")), "901")
        self.assertEqual(
            self.gateway._photo_album_id(SimpleNamespace(album=SimpleNamespace(album_id="902"))),
            "902")
        self.assertIsNone(self.gateway._photo_album_id(SimpleNamespace()))

    def test_download_photo_prefers_option_method(self):
        calls = []

        class FakeOption:
            def download_photo(self, photo_id):
                calls.append(photo_id)

        with patch.object(self.gateway, "_download_option", return_value=FakeOption()):
            self.gateway.download_photo("9002", self.tmp / "staging-option")
        self.assertEqual(calls, [9002])

    def test_download_photo_falls_back_to_module_function(self):
        import types

        calls = []

        class BrokenOption:
            def download_photo(self, photo_id):
                raise AttributeError("老版本 JmOption 没有 download_photo")

        fake_jmcomic = types.ModuleType("jmcomic")
        fake_jmcomic.download_photo = lambda photo_id, option: calls.append(photo_id)
        with patch.dict(sys.modules, {"jmcomic": fake_jmcomic}), \
             patch.object(self.gateway, "_download_option", return_value=BrokenOption()):
            self.gateway.download_photo("9002", self.tmp / "staging-fallback")
        # 注入的是假模块，不会碰到真实 jmcomic 包
        self.assertEqual(calls, [9002])


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


class TestStoreUnits(TempDirTest):
    """units 表：upsert/get/set_pdf，以及老库幂等迁移（不动 albums 语义）。"""

    def test_upsert_get_and_set_pdf(self):
        store = Store(self.tmp / "cache" / "units.sqlite3")
        self.addCleanup(store.close)
        store.upsert_unit({
            "album_id": "900", "unit_id": "9001", "title": "第1话",
            "dir": str(self.tmp / "JM900-u9001-第1话"), "page_count": 2,
        })
        record = store.get_unit("900", "9001")
        self.assertEqual(record["title"], "第1话")
        self.assertEqual(record["page_count"], 2)
        self.assertIsNone(record["pdf_path"])
        store.set_unit_pdf("900", "9001", "C:/pdfs/JM900-u9001.pdf", 4321)
        record = store.get_unit("900", "9001")
        self.assertEqual(record["pdf_path"], "C:/pdfs/JM900-u9001.pdf")
        self.assertEqual(record["pdf_size"], 4321)
        # 再次 upsert 只更新元数据，不覆盖已记录的 PDF
        store.upsert_unit({
            "album_id": "900", "unit_id": "9001", "title": "第1话-改",
            "dir": str(self.tmp / "changed"), "page_count": 3,
        })
        record = store.get_unit("900", "9001")
        self.assertEqual(record["title"], "第1话-改")
        self.assertEqual(record["pdf_path"], "C:/pdfs/JM900-u9001.pdf")
        self.assertEqual([u["unit_id"] for u in store.list_units("900")], ["9001"])
        self.assertIsNone(store.get_unit("900", "nope"))

    def test_old_db_gets_units_table_idempotently(self):
        db_path = self.tmp / "oldunits" / "old.sqlite3"
        db_path.parent.mkdir(parents=True)
        conn = sqlite3.connect(str(db_path))
        conn.executescript("""
            CREATE TABLE albums (
                album_id TEXT PRIMARY KEY, title TEXT NOT NULL, dir TEXT NOT NULL,
                viewer_url TEXT, page_count INTEGER, authors TEXT, tags TEXT,
                cover_url TEXT, downloaded_at TEXT, updated_at REAL NOT NULL
            );
        """)
        conn.commit()
        conn.close()

        store = Store(db_path)
        self.addCleanup(store.close)
        tables = {row["name"] for row in
                  store._get_conn().execute(
                      "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        self.assertIn("units", tables)
        # albums 语义不动：老库没有 pdf 列时会被补上
        album_columns = {row["name"] for row in
                         store._get_conn().execute("PRAGMA table_info(albums)").fetchall()}
        self.assertIn("pdf_path", album_columns)
        store.upsert_unit({"album_id": "1", "unit_id": "2", "title": "t",
                           "dir": "d", "page_count": 1})
        self.assertIsNotNone(store.get_unit("1", "2"))
        # 二次打开同一个库应幂等：不报错且数据还在
        store2 = Store(db_path)
        self.addCleanup(store2.close)
        self.assertIsNotNone(store2.get_unit("1", "2"))


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

    def test_mobile_media_boxes_and_long_image_pagination(self):
        album = self.tmp / "mixed"
        album.mkdir()
        # 三段色带验证长图没有丢底部；再混入横图和小尺寸图。
        image = Image.new("RGB", (200, 850), "red")
        ImageDraw.Draw(image).rectangle((0, 283, 199, 565), fill="green")
        ImageDraw.Draw(image).rectangle((0, 566, 199, 849), fill="blue")
        image.save(album / "1.png")
        Image.new("RGB", (300, 150), "yellow").save(album / "2.png")
        Image.new("RGB", (80, 110), "purple").save(album / "3.png")
        for width in (1000, 640):
            out = self.tmp / f"mobile-{width}.pdf"
            stats = build_album_pdf(album, out, attempts=[(width, 80)])
            self.assertEqual(stats["pages"], 6)
            boxes = re.findall(rb"/MediaBox\s*\[([^\]]+)\]", out.read_bytes())
            self.assertEqual(len(boxes), 6)
            for box in boxes:
                x, y, w, h = map(float, box.split())
                self.assertEqual((x, y), (0, 0))
                self.assertAlmostEqual(w, 595.276, delta=0.1)
                self.assertAlmostEqual(h, 841.89, delta=0.5)
            structure = parse_pdf_structure(out)
            self.assertEqual(structure["jpeg_decoded"], 6)
            self.assertTrue(structure["xref_ok"])
        # 真实页面像素消费端验证：顶部与底部颜色都在，短图保持比例而非拉伸。
        pages = list(pdf_mod._a4_pages(pdf_mod._load_page(album / "1.png", 200), 200))
        self.assertEqual(len(pages), 4)
        self.assertEqual(pages[0].getpixel((100, 100)), (255, 0, 0))
        self.assertEqual(pages[-1].getpixel((100, 141)), (0, 0, 255))
        for page in pages:
            page.close()

    def test_old_layout_cache_rebuilt_and_config_changes_invalidate(self):
        cfg = self._config()
        album = self._make_album(count=1)
        out = pdf_path_for(cfg, "42", "旧版")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"%PDF-old-layout")
        first = ensure_album_pdf(cfg, "42", album, "旧版")
        self.assertFalse(first.get("cached"))
        self.assertTrue(ensure_album_pdf(cfg, "42", album, "旧版").get("cached"))
        cfg.pdf_width = 640
        self.assertFalse(ensure_album_pdf(cfg, "42", album, "旧版").get("cached"))

    def test_malformed_cache_stats_rebuilds(self):
        import json
        cfg = self._config()
        album = self._make_album(count=1)
        first = ensure_album_pdf(cfg, "42", album, "cache")
        stamp_path = Path(first["path"]).with_suffix(".pdf.json")
        for value in (None, [], "bad"):
            stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
            stamp["stats"] = value
            stamp_path.write_text(json.dumps(stamp), encoding="utf-8")
            self.assertFalse(ensure_album_pdf(cfg, "42", album, "cache").get("cached"))

    def test_normal_portrait_fits_one_page_without_cutting(self):
        image = Image.new("RGB", (400, 600), "red")
        ImageDraw.Draw(image).rectangle((0, 500, 399, 599), fill="blue")
        pages = list(pdf_mod._a4_pages(image, 400))
        self.assertEqual(len(pages), 1)
        self.assertEqual(pdf_mod._page_count(image, 400), 1)
        self.assertEqual(pages[0].getpixel((200, 50)), (255, 0, 0))
        self.assertEqual(pages[0].getpixel((200, 550)), (0, 0, 255))
        pages[0].close()
        image.close()

    def test_long_image_no_tiny_tail_page(self):
        image = Image.new("RGB", (400, 1700), "red")
        pages = list(pdf_mod._a4_pages(image, 400))
        self.assertEqual(len(pages), 4)
        for page in pages:
            # 所有页面都有均分内容，而不是末页只有几像素色带。
            self.assertEqual(page.getpixel((200, 100)), (255, 0, 0))
            page.close()
        image.close()

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


class TestUnitPdf(TempDirTest):
    """pdf_path_for_unit / ensure_unit_pdf：单单元落盘名与新鲜度复用。"""

    def _config(self):
        cfg = _make_config(self.tmp)
        cfg.ensure_dirs()
        return cfg

    def _unit_dir(self, count=2):
        directory = self.tmp / "unit-dir"
        directory.mkdir(parents=True, exist_ok=True)
        for index in range(count):
            Image.new("RGB", (140, 180), (index * 50, 20, 30)).save(
                directory / f"{index + 1:03}.jpg")
        return directory

    def test_pdf_path_for_unit_name(self):
        cfg = self._config()
        path = pdf_path_for_unit(cfg, "900", "9001", "很长的标题" * 20)
        self.assertTrue(path.name.startswith("JM900-u9001-"))
        self.assertLessEqual(len(path.stem), len("JM900-u9001-") + 40)
        self.assertFalse(re.search(r'[<>:"/\\|?*]', path.name))

    def test_ensure_unit_pdf_reuse(self):
        cfg = self._config()
        unit_dir = self._unit_dir(count=2)
        first = ensure_unit_pdf(cfg, "900", "9001", unit_dir, "第1话")
        out = pdf_path_for_unit(cfg, "900", "9001", "第1话")
        self.assertFalse(first.get("cached"))
        self.assertTrue(out.is_file())
        self.assertEqual(first["pages"], 2)
        self.assertEqual(parse_pdf_structure(out)["pages"], 2)
        second = ensure_unit_pdf(cfg, "900", "9001", unit_dir, "第1话")
        self.assertTrue(second.get("cached"))
        self.assertEqual(second["elapsed_ms"], 0)
        self.assertEqual(second["size"], first["size"])


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


class TestUnitFlow(TempDirTest):
    """判据 5/6/7：/download 的 409 与 unit 任务（_process 同步跑，不启后台线程）。"""

    def setUp(self):
        super().setUp()
        self.cfg = _make_config(self.tmp)
        self.service = Service(self.cfg)
        self.addCleanup(self.service.store.close)
        self.client = self.service.app.test_client()
        self.gw = self.service.gateway

    def _get(self, path):
        response = self.client.get(path)
        return response.status_code, response.get_json()

    def _download(self, body):
        return self.client.post("/download", json=body)

    def _run_job(self, job_id):
        job = self.service.worker._jobs[job_id]
        self.service.worker._process(job)
        return self.service.worker.get_job(job_id)

    def test_download_multiple_units_without_unit_409_and_no_job(self):
        with patch.object(self.gw, "album_detail", return_value=_album_detail("900")):
            response = self._download({"id": "900"})
        self.assertEqual(response.status_code, 409)
        payload = response.get_json()
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "multiple_units")
        self.assertIn("2", payload["message"])
        self.assertEqual([u["unit_id"] for u in payload["units"]], ["9001", "9002"])
        # 关键：409 不建 job
        self.assertEqual(self.service.worker._jobs, {})
        self.assertEqual(self.service.worker._active_by_key, {})

    def test_download_unit_queued_and_jobs_unit_id(self):
        with patch.object(self.gw, "album_detail", return_value=_album_detail("900")):
            response = self._download({"id": "900", "unit": "9002"})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "queued")
        self.assertEqual(payload["unit"], "9002")
        status, job = self._get(f"/jobs/{payload['job_id']}")
        self.assertEqual(status, 200)
        self.assertEqual(job["unit_id"], "9002")
        self.assertEqual(job["album_id"], "900")
        self.assertEqual(job["title"], "第2话")  # unit job 标题用单元标题
        self.assertEqual(job["total_pages"], 3)
        # 同单元再提交 → 复用进行中 job
        with patch.object(self.gw, "album_detail", return_value=_album_detail("900")):
            again = self._download({"id": "900", "unit": "9002"})
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.get_json()["job_id"], payload["job_id"])

    def test_download_invalid_unit_400(self):
        with patch.object(self.gw, "album_detail", return_value=_album_detail("900")):
            response = self._download({"id": "900", "unit": "123"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "invalid_unit")
        self.assertEqual(self.service.worker._jobs, {})

    def test_unit_job_process_only_that_unit_and_pdf(self):
        detail = _album_detail("900")
        downloaded = []

        def fake_download_photo(photo_id, staging_dir, rule="Bd"):
            self.assertEqual(str(photo_id), "9002")
            self.assertEqual(rule, "Bd")
            downloaded.append(str(photo_id))
            staging = Path(staging_dir)
            staging.mkdir(parents=True, exist_ok=True)
            for index in range(2):
                Image.new("RGB", (200, 280), (index * 50, 20, 30)).save(
                    staging / f"{index + 1:03}.jpg")

        with patch.object(self.gw, "album_detail", return_value=detail), \
             patch.object(self.gw, "download_photo", side_effect=fake_download_photo), \
             patch.object(self.gw, "download_album",
                          side_effect=AssertionError("unit 任务不应下载整本")):
            queued = self._download({"id": "900", "unit": "9002"})
            self.assertEqual(queued.status_code, 200)
            job_id = queued.get_json()["job_id"]
            job = self._run_job(job_id)

        self.assertEqual(job["status"], "done", job)
        self.assertEqual(job["unit_id"], "9002")
        self.assertEqual(job["total_pages"], 2)
        self.assertEqual(downloaded, ["9002"])  # 只下该单元

        record = self.service.store.get_unit("900", "9002")
        self.assertIsNotNone(record)
        self.assertTrue(Path(record["dir"]).name.startswith("JM900-u9002-"))
        self.assertEqual(record["page_count"], 2)
        # 记录/PDF 只针对该单元，不写整本记录
        self.assertIsNone(self.service.store.get_album("900"))
        self.assertEqual([u["unit_id"] for u in self.service.store.list_units("900")], ["9002"])

        pdf_path = Path(record["pdf_path"])
        self.assertTrue(pdf_path.is_file(), pdf_path)
        self.assertTrue(pdf_path.name.startswith("JM900-u9002-"))
        self.assertEqual(parse_pdf_structure(pdf_path)["pages"], 2)

        response = self.client.get("/pdf/900?unit=9002")
        try:
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.data.startswith(b"%PDF-1."))
            self.assertIn("JM900-9002.pdf", response.headers.get("Content-Disposition", ""))
        finally:
            response.close()

        # 未下载单元 → 404 unit_not_downloaded；整本仍 404 album_not_downloaded
        status, payload = self._get("/pdf/900?unit=9001")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "unit_not_downloaded")
        status, payload = self._get("/pdf/900")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "album_not_downloaded")

        # 已下载单元再 POST → done（不新建 job）
        with patch.object(self.gw, "album_detail", return_value=detail):
            done = self._download({"id": "900", "unit": "9002"})
        self.assertEqual(done.status_code, 200)
        done_payload = done.get_json()
        self.assertEqual(done_payload["status"], "done")
        self.assertEqual(done_payload["unit"], "9002")
        self.assertIn("/jm_view?path=", done_payload["viewer_url"])

    def test_whole_album_job_unchanged_for_single_unit(self):
        detail = _album_detail("77", title="整本作品", units=[
            {"index": 1, "unit_id": "7701", "title": "唯一章", "page_count": 2}])
        album_downloads = []

        def fake_download_album(album_id, staging_dir, rule="Bd"):
            album_downloads.append(str(album_id))
            staging = Path(staging_dir)
            staging.mkdir(parents=True, exist_ok=True)
            for index in range(2):
                Image.new("RGB", (120, 160)).save(staging / f"{index + 1:03}.jpg")

        with patch.object(self.gw, "album_detail", return_value=detail), \
             patch.object(self.gw, "download_album", side_effect=fake_download_album), \
             patch.object(self.gw, "download_photo",
                          side_effect=AssertionError("整本任务不应调章节下载")):
            response = self._download({"id": "77"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["status"], "queued")
            job = self._run_job(response.get_json()["job_id"])

        self.assertEqual(job["status"], "done", job)
        self.assertIsNone(job["unit_id"])
        self.assertEqual(album_downloads, ["77"])
        record = self.service.store.get_album("77")
        self.assertIsNotNone(record)
        self.assertTrue(Path(record["dir"]).name.startswith("JM77-"))
        self.assertEqual(record["page_count"], 2)
        self.assertTrue(Path(record["pdf_path"]).is_file())
        response = self.client.get("/pdf/77")
        try:
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.data.startswith(b"%PDF-1."))
            self.assertIn("JM77.pdf", response.headers.get("Content-Disposition", ""))
        finally:
            response.close()


class TestSelectedUnitsPdf(TempDirTest):
    """API 到真实 PDF：颜色指纹证明只合并所选单元，且按系列次序。"""
    def setUp(self):
        super().setUp()
        self.cfg = _make_config(self.tmp)
        self.service = Service(self.cfg)
        self.addCleanup(self.service.store.close)
        self.client = self.service.app.test_client()
        units = [{"index": i, "unit_id": str(9000 + i), "title": f"单元{i}"}
                 for i in range(1, 4)]
        self.service.store.put_detail("900", _album_detail("900", units=units))
        for i, color in enumerate(("red", "green", "blue"), start=1):
            directory = self.tmp / f"unit{i}"
            directory.mkdir()
            Image.new("RGB", (120, 160), color).save(directory / "1.png")
            self.service.store.upsert_unit({"album_id": "900", "unit_id": str(9000 + i),
                                            "title": f"单元{i}", "dir": str(directory), "page_count": 1})

    def _save_response(self, query):
        response = self.client.get("/pdf/900?" + query)
        self.assertEqual(response.status_code, 200, response.get_json(silent=True))
        try:
            path = self.tmp / "received.pdf"
            path.write_bytes(response.data)
            return parse_pdf_structure(path), response.headers["Content-Disposition"]
        finally:
            response.close()

    def test_selection_order_no_unselected_pages_and_cache(self):
        structure, name = self._save_response("units=9003,9001,9003")
        self.assertEqual(structure["pages"], 2)
        red, blue = structure["jpeg_centers"]
        self.assertGreater(red[0], 240)
        self.assertLess(red[1], 10)
        self.assertGreater(blue[2], 240)
        self.assertLess(blue[1], 10)
        self.assertIn("JM900-pack-", name)
        # 与整本和单元不混用缓存/记录；同一集合乱序与重复可复用。
        with patch("jm_service.pdf.build_album_pdf", side_effect=AssertionError("应复用缓存")):
            again, again_name = self._save_response("units=9001,9003")
        self.assertEqual(name, again_name)
        self.assertEqual(again["pages"], 2)
        self.assertIsNone(self.service.store.get_album("900"))
        self.assertIsNone(self.service.store.get_unit("900", "9001")["pdf_path"])
        whole, whole_name = self._save_response("units=9001,9002,9003")
        self.assertEqual(whole["pages"], 3)
        self.assertNotEqual(name, whole_name)

    def test_invalid_selection_rejected_before_generation(self):
        for query in ("units=", "units=9001,", "units=9001,,9002", "units=../9001",
                      "units=9001,9999", "units=9001&unit=9002", "units=9001&units=9002"):
            with self.subTest(query=query), patch("jm_service.app.ensure_units_pdf") as build:
                response = self.client.get("/pdf/900?" + query)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["error"], "invalid_unit")
                build.assert_not_called()

    def test_zero_and_leading_zero_rejected_before_details(self):
        with patch.object(self.service, "_detail_with_cache", side_effect=AssertionError("不应查详情")):
            for ids in ("0", "00", "0009001", "9001,0"):
                response = self.client.get("/pdf/900?units=" + ids)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["error"], "invalid_unit")

    def test_partially_missing_unit_fails_instead_of_sending_remaining_pages(self):
        self.service.store.upsert_unit({"album_id": "900", "unit_id": "9001", "title": "missing",
                                       "dir": str(self.tmp / "unit1"), "page_count": 2})
        response = self.client.get("/pdf/900?units=9001,9003")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error"], "pdf_incomplete_unit")
        self.assertEqual(list(self.cfg.pdfs_dir.glob("*.pdf")), [])

    def test_missing_download_never_returns_partial_pdf(self):
        import shutil
        shutil.rmtree(self.tmp / "unit3")
        with patch("jm_service.app.ensure_units_pdf") as build:
            response = self.client.get("/pdf/900?units=9001,9003")
            self.assertEqual(response.status_code, 404)
            self.assertEqual(response.get_json()["error"], "unit_not_downloaded")
            build.assert_not_called()

    def test_over_page_limit_rejected_not_truncated(self):
        self.cfg.pdf_max_pages = 1
        response = self.client.get("/pdf/900?units=9001,9003")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["error"], "pdf_too_many_pages")
        self.assertEqual(list(self.cfg.pdfs_dir.glob("*.pdf")), [])

    def test_long_image_pagination_limit_rejected(self):
        self.cfg.pdf_max_pages = 2
        Image.new("RGB", (100, 800), "red").save(self.tmp / "unit1" / "1.png")
        response = self.client.get("/pdf/900?units=9001")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["error"], "pdf_too_many_pages")

    def test_bad_image_does_not_skip_selected_content(self):
        (self.tmp / "unit3" / "1.png").write_bytes(b"broken")
        response = self.client.get("/pdf/900?units=9001,9003")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error"], "pdf_bad_image")
        self.assertEqual(list(self.cfg.pdfs_dir.glob("*.pdf")), [])
        self.assertEqual(list(self.cfg.pdfs_dir.glob("*.tmp")), [])

    def test_size_limit_fails_not_partial(self):
        self.cfg.pdf_max_bytes = 1
        response = self.client.get("/pdf/900?units=9001,9003")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["error"], "pdf_too_large")
        self.assertEqual(list(self.cfg.pdfs_dir.glob("*.pdf")), [])


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
                    "downloaded_albums", "search_cache_entries", "jm_domain",
                    "capabilities"):
            self.assertIn(key, payload)
        self.assertEqual(payload["service"], "jm-service")
        # Node 合并打包靠这条能力声明 fail closed：旧边车不认 ?units=，绝不能猜成支持。
        self.assertEqual(payload["capabilities"], ["units"])
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

    def test_resolve_route_album(self):
        album = _album_detail("1205081")
        gw = self.service.gateway
        with patch.object(gw, "search",
                          side_effect=AssertionError("resolve 不能调用站内搜索")), \
             patch.object(gw, "album_detail", return_value=album), \
             patch.object(gw, "photo_detail",
                          side_effect=AssertionError("album 命中不应再查章节")):
            status, payload = self._get("/resolve/1205081")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["requested"], "1205081")
        self.assertEqual(payload["kind"], "album")
        self.assertEqual(payload["album"]["unit_count"], 2)
        self.assertEqual([u["unit_id"] for u in payload["album"]["units"]], ["9001", "9002"])
        self.assertIsNone(payload["matched_unit"])

    def test_resolve_route_photo_and_errors(self):
        parent = _album_detail("900")
        gw = self.service.gateway
        with patch.object(gw, "search",
                          side_effect=AssertionError("resolve 不能调用站内搜索")), \
             patch.object(gw, "album_detail",
                          side_effect=[JmError("jm_detail_failed", "不是作品号"), parent]), \
             patch.object(gw, "photo_detail",
                          return_value={"id": "9002", "title": "第2话", "album_id": "900"}):
            status, payload = self._get("/resolve/9002")
        self.assertEqual(status, 200)
        self.assertEqual(payload["kind"], "photo")
        self.assertEqual(payload["album"]["id"], "900")
        self.assertEqual(payload["matched_unit"]["unit_id"], "9002")
        self.assertEqual(payload["matched_unit"]["index"], 2)

        status, payload = self._get("/resolve/abc")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_id")

        with patch.object(gw, "album_detail",
                          side_effect=JmError("jm_detail_failed", "没有")), \
             patch.object(gw, "photo_detail",
                          side_effect=JmError("jm_detail_failed", "没有")):
            status, payload = self._get("/resolve/999999")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "not_found")

    def test_search_images0_skips_details_covers_preview(self):
        fake = {"total": 2, "items": [
            {"id": "1001", "title": "标题一", "tags": ["x"], "author": "a",
             "image": "http://img/1.jpg"},
            {"id": "1002", "title": "标题二", "tags": [], "author": "", "image": ""},
        ]}
        gw = self.service.gateway
        with patch.object(gw, "search", return_value=fake), \
             patch.object(gw, "fetch_details",
                          side_effect=AssertionError("images=0 不应抓详情")) as details_mock, \
             patch.object(gw, "fetch_covers",
                          side_effect=AssertionError("images=0 不应抓封面")) as covers_mock, \
             patch.object(self.service, "_ensure_preview",
                          side_effect=AssertionError("images=0 不应做拼图")) as preview_mock:
            status, payload = self._get("/search?q=龙&images=0")
        self.assertEqual(status, 200)
        self.assertFalse(payload["cached"])
        self.assertIsNone(payload["preview_file"])
        self.assertIsNone(payload["preview_url"])
        self.assertEqual([r["id"] for r in payload["results"]], ["1001", "1002"])
        self.assertEqual([r["rank"] for r in payload["results"]], [1, 2])
        self.assertEqual(payload["results"][0]["title"], "标题一")
        for result in payload["results"]:
            self.assertEqual(result["authors"], [])
            self.assertEqual(result["tags"], [])
            self.assertIsNone(result["page_count"])
            self.assertEqual(result["cover_url"], "")
            self.assertIsNone(result["cover_file"])
            self.assertEqual(result["cover_http"], f"/cover/{result['id']}.jpg")
            self.assertFalse(result["detail_ok"])
        self.assertIn("1.1001", payload["text"])
        self.assertEqual(details_mock.call_count, 0)
        self.assertEqual(covers_mock.call_count, 0)
        self.assertEqual(preview_mock.call_count, 0)

        # images=0 的缓存 key 独立，同参数再查命中缓存且仍不抓图
        with patch.object(gw, "search", return_value=fake):
            status, hot = self._get("/search?q=龙&images=0")
        self.assertEqual(status, 200)
        self.assertTrue(hot["cached"])
        self.assertIsNone(hot["preview_file"])

    def test_search_images0_cache_key_separate_from_default(self):
        fake = {"total": 1, "items": [
            {"id": "1001", "title": "标题一", "tags": [], "author": "", "image": ""}]}
        gw = self.service.gateway
        with patch.object(gw, "search", return_value=fake) as search_mock, \
             patch.object(gw, "fetch_details", return_value={}) as details_mock, \
             patch.object(gw, "fetch_covers", return_value={}) as covers_mock, \
             patch.object(self.service, "_ensure_preview", return_value=None):
            status0, payload0 = self._get("/search?q=龙&images=0")
            self.assertEqual(status0, 200)
            self.assertFalse(payload0["cached"])
            self.assertEqual(details_mock.call_count, 0)
            self.assertEqual(covers_mock.call_count, 0)
            # 默认路径不能复用 images=0 的缓存，也不能反过来被污染
            status1, payload1 = self._get("/search?q=龙")
            self.assertEqual(status1, 200)
            self.assertFalse(payload1["cached"])
            self.assertEqual(details_mock.call_count, 1)
            self.assertEqual(covers_mock.call_count, 1)
            self.assertEqual(search_mock.call_count, 2)

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
