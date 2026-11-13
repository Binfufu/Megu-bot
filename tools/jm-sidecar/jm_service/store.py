"""SQLite 缓存：搜索缓存 / 详情缓存 / 已下载漫画库。

线程安全策略：每个线程一条 sqlite 连接（WAL），写操作加进程内锁；
Flask 多线程与下载 worker 可并发读写。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS search_cache (
    cache_key  TEXT PRIMARY KEY,
    query      TEXT NOT NULL,
    page       INTEGER NOT NULL,
    limit_n    INTEGER NOT NULL,
    payload    TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_cache_created ON search_cache(created_at);

CREATE TABLE IF NOT EXISTS detail_cache (
    album_id   TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    fetched_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
    album_id      TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    dir           TEXT NOT NULL,
    viewer_url    TEXT,
    page_count    INTEGER,
    authors       TEXT,
    tags          TEXT,
    cover_url     TEXT,
    downloaded_at TEXT,
    updated_at    REAL NOT NULL,
    pdf_path      TEXT,
    pdf_size      INTEGER,
    pdf_updated_at REAL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS units (
    album_id TEXT NOT NULL,
    unit_id  TEXT NOT NULL,
    title    TEXT NOT NULL,
    dir      TEXT NOT NULL,
    page_count INTEGER,
    pdf_path TEXT,
    pdf_size INTEGER,
    updated_at REAL NOT NULL,
    PRIMARY KEY (album_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_units_album ON units(album_id);
"""

# 旧库增量迁移：表已存在时 CREATE TABLE IF NOT EXISTS 不会加列
_ALBUM_MIGRATION_COLUMNS = {
    "pdf_path": "TEXT",
    "pdf_size": "INTEGER",
    "pdf_updated_at": "REAL",
}


class Store:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._write_lock = threading.RLock()
        with self._write_lock:
            conn = self._get_conn()
            conn.executescript(_SCHEMA)
            self._migrate_albums(conn)
            conn.commit()

    @staticmethod
    def _migrate_albums(conn: sqlite3.Connection) -> None:
        """给旧库 albums 表补 PDF 相关列（幂等）。"""
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(albums)").fetchall()}
        for column, column_type in _ALBUM_MIGRATION_COLUMNS.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE albums ADD COLUMN {column} {column_type}")

    # ------------------------------------------------------------------ #
    def _get_conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.db_path, timeout=10.0, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=8000")
            self._local.conn = conn
        return conn

    def _write(self, sql: str, params=()):
        with self._write_lock:
            conn = self._get_conn()
            try:
                cur = conn.execute(sql, params)
                conn.commit()
                return cur
            except sqlite3.OperationalError:
                # 极端锁竞争下重试一次
                time.sleep(0.1)
                conn = self._get_conn()
                cur = conn.execute(sql, params)
                conn.commit()
                return cur

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            finally:
                self._local.conn = None

    # ------------------------------------------------------------------ #
    # 搜索缓存
    # ------------------------------------------------------------------ #
    def get_search(self, cache_key: str, ttl_sec: float) -> dict | None:
        row = self._get_conn().execute(
            "SELECT payload, created_at FROM search_cache WHERE cache_key = ?", (cache_key,)
        ).fetchone()
        if row is None:
            return None
        if ttl_sec > 0 and (time.time() - float(row["created_at"])) > ttl_sec:
            return None
        try:
            return json.loads(row["payload"])
        except (TypeError, ValueError):
            return None

    def put_search(self, cache_key: str, query: str, page: int, limit_n: int, payload: dict) -> None:
        self._write(
            "INSERT OR REPLACE INTO search_cache(cache_key, query, page, limit_n, payload, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (cache_key, query, int(page), int(limit_n), json.dumps(payload, ensure_ascii=False), time.time()),
        )

    def count_search(self) -> int:
        row = self._get_conn().execute("SELECT COUNT(*) AS n FROM search_cache").fetchone()
        return int(row["n"]) if row else 0

    def purge_search(self, ttl_sec: float) -> int:
        cur = self._write("DELETE FROM search_cache WHERE created_at < ?",
                          (time.time() - max(ttl_sec, 0),))
        return cur.rowcount or 0

    # ------------------------------------------------------------------ #
    # 详情缓存
    # ------------------------------------------------------------------ #
    def get_detail(self, album_id: str, ttl_sec: float) -> dict | None:
        row = self._get_conn().execute(
            "SELECT payload, fetched_at FROM detail_cache WHERE album_id = ?", (str(album_id),)
        ).fetchone()
        if row is None:
            return None
        if ttl_sec > 0 and (time.time() - float(row["fetched_at"])) > ttl_sec:
            return None
        try:
            return json.loads(row["payload"])
        except (TypeError, ValueError):
            return None

    def put_detail(self, album_id: str, payload: dict) -> None:
        self._write(
            "INSERT OR REPLACE INTO detail_cache(album_id, payload, fetched_at) VALUES (?, ?, ?)",
            (str(album_id), json.dumps(payload, ensure_ascii=False), time.time()),
        )

    # ------------------------------------------------------------------ #
    # 漫画库
    # ------------------------------------------------------------------ #
    def upsert_album(self, record: dict) -> None:
        self._write(
            """INSERT OR REPLACE INTO albums(
                   album_id, title, dir, viewer_url, page_count, authors, tags, cover_url,
                   downloaded_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                str(record.get("id") or record.get("album_id")),
                str(record.get("title") or ""),
                str(record.get("dir") or ""),
                record.get("viewer_url"),
                int(record.get("page_count") or 0),
                json.dumps(record.get("authors") or [], ensure_ascii=False),
                json.dumps(record.get("tags") or [], ensure_ascii=False),
                record.get("cover_url"),
                record.get("downloaded_at"),
                time.time(),
            ),
        )

    def set_album_pdf(self, album_id: str, pdf_path: str, pdf_size: int) -> None:
        self._write(
            "UPDATE albums SET pdf_path = ?, pdf_size = ?, pdf_updated_at = ? WHERE album_id = ?",
            (str(pdf_path), int(pdf_size), time.time(), str(album_id)),
        )

    def get_album(self, album_id: str) -> dict | None:
        row = self._get_conn().execute(
            "SELECT * FROM albums WHERE album_id = ?", (str(album_id),)
        ).fetchone()
        return self._album_row_to_dict(row) if row else None

    def list_albums(self, limit: int = 50, offset: int = 0) -> list[dict]:
        rows = self._get_conn().execute(
            "SELECT * FROM albums ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            (max(1, int(limit)), max(0, int(offset))),
        ).fetchall()
        return [self._album_row_to_dict(row) for row in rows]

    def count_albums(self) -> int:
        row = self._get_conn().execute("SELECT COUNT(*) AS n FROM albums").fetchone()
        return int(row["n"]) if row else 0

    @staticmethod
    def _album_row_to_dict(row: sqlite3.Row) -> dict:
        def _loads(value, default):
            try:
                return json.loads(value) if value else default
            except (TypeError, ValueError):
                return default

        return {
            "id": row["album_id"],
            "title": row["title"],
            "dir": row["dir"],
            "viewer_url": row["viewer_url"],
            "page_count": row["page_count"],
            "authors": _loads(row["authors"], []),
            "tags": _loads(row["tags"], []),
            "cover_url": row["cover_url"],
            "downloaded_at": row["downloaded_at"],
            "pdf_path": row["pdf_path"] if "pdf_path" in row.keys() else None,
            "pdf_size": row["pdf_size"] if "pdf_size" in row.keys() else None,
        }

    # ------------------------------------------------------------------ #
    # 单元（章节）下载记录；老库靠 CREATE TABLE IF NOT EXISTS 幂等迁移
    # ------------------------------------------------------------------ #
    def upsert_unit(self, record: dict) -> None:
        """写入/更新单元下载记录；不覆盖已有的 PDF 字段（PDF 由 set_unit_pdf 单独写）。"""
        self._write(
            """INSERT INTO units(album_id, unit_id, title, dir, page_count, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(album_id, unit_id) DO UPDATE SET
                   title = excluded.title,
                   dir = excluded.dir,
                   page_count = excluded.page_count,
                   updated_at = excluded.updated_at""",
            (
                str(record.get("album_id") or record.get("id") or ""),
                str(record.get("unit_id") or ""),
                str(record.get("title") or ""),
                str(record.get("dir") or ""),
                int(record.get("page_count") or 0),
                time.time(),
            ),
        )

    def set_unit_pdf(self, album_id: str, unit_id: str, pdf_path: str, pdf_size: int) -> None:
        self._write(
            "UPDATE units SET pdf_path = ?, pdf_size = ?, updated_at = ? "
            "WHERE album_id = ? AND unit_id = ?",
            (str(pdf_path), int(pdf_size), time.time(), str(album_id), str(unit_id)),
        )

    def get_unit(self, album_id: str, unit_id: str) -> dict | None:
        row = self._get_conn().execute(
            "SELECT * FROM units WHERE album_id = ? AND unit_id = ?",
            (str(album_id), str(unit_id)),
        ).fetchone()
        return self._unit_row_to_dict(row) if row else None

    def list_units(self, album_id: str) -> list[dict]:
        rows = self._get_conn().execute(
            "SELECT * FROM units WHERE album_id = ? ORDER BY updated_at DESC", (str(album_id),)
        ).fetchall()
        return [self._unit_row_to_dict(row) for row in rows]

    @staticmethod
    def _unit_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "album_id": row["album_id"],
            "unit_id": row["unit_id"],
            "title": row["title"],
            "dir": row["dir"],
            "page_count": row["page_count"],
            "pdf_path": row["pdf_path"],
            "pdf_size": row["pdf_size"],
            "updated_at": row["updated_at"],
        }

