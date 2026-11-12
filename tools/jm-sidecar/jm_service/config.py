"""配置加载：config/jm-service.json（可选，缺省即内置默认）。

契约见 docs/design-jm-feature.md 第 4 节。
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path

# tools/jm-sidecar/jm_service/config.py -> tools/jm-sidecar/
# 本目录是自包含的部署单元：config/、data/、logs/ 都放在 tools/jm-sidecar/ 下。
PACKAGE_DIR = Path(__file__).resolve().parent
SERVICE_DIR = PACKAGE_DIR.parent
ROOT_DIR = SERVICE_DIR

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8790,
    "viewer": {
        "enabled": True,
        "host": "0.0.0.0",
        "port": 8088,
        "auto_spawn": True,
        "public_base": "",
        "password": "",
    },
    "cache": {"search_ttl_sec": 21600, "detail_ttl_sec": 86400},
    "jm": {"proxy": "", "domain": "", "threads": 16, "timeout_sec": 30},
    "pdf": {"width": 1000, "quality": 80, "max_pages": 300, "max_bytes": 20 * 1024 * 1024},
    "paths": {"data_dir": "data"},
}


def deep_merge(base: dict, override: dict) -> dict:
    """把 override 深度合并进 base 的副本并返回。"""
    result = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _env_int(name: str):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


class Config:
    """jm-service 运行配置。所有相对路径按工作区根目录解析。"""

    def __init__(self, raw: dict, root: Path = ROOT_DIR, config_path: Path | None = None):
        self.root = Path(root).resolve()
        self.config_path = Path(config_path) if config_path else None
        self.raw = deep_merge(DEFAULT_CONFIG, raw or {})

        viewer = self.raw.setdefault("viewer", {})
        cache = self.raw.setdefault("cache", {})
        jm = self.raw.setdefault("jm", {})
        paths = self.raw.setdefault("paths", {})

        self.host = str(self.raw.get("host") or DEFAULT_CONFIG["host"])
        self.port = int(self.raw.get("port") or DEFAULT_CONFIG["port"])
        self.search_ttl_sec = int(cache.get("search_ttl_sec") or 21600)
        self.detail_ttl_sec = int(cache.get("detail_ttl_sec") or 86400)
        self.jm_proxy = str(jm.get("proxy") or "").strip()
        self.jm_domain = str(jm.get("domain") or "").strip()
        self.jm_threads = max(1, min(32, int(jm.get("threads") or 16)))
        self.jm_timeout_sec = max(3, min(120, int(jm.get("timeout_sec") or 30)))

        pdf = self.raw.setdefault("pdf", {})
        self.pdf_width = max(200, min(3000, int(pdf.get("width") or 1000)))
        self.pdf_quality = max(20, min(95, int(pdf.get("quality") or 80)))
        self.pdf_max_pages = max(1, min(1000, int(pdf.get("max_pages") or 100)))
        self.pdf_max_bytes = max(256 * 1024, int(pdf.get("max_bytes") or 15 * 1024 * 1024))

        self.viewer_enabled = bool(viewer.get("enabled", True))
        self.viewer_host = str(viewer.get("host") or "0.0.0.0")
        self.viewer_port = int(viewer.get("port") or 8088)
        self.viewer_auto_spawn = bool(viewer.get("auto_spawn", True))
        self.viewer_public_base = str(viewer.get("public_base") or "").strip().rstrip("/")
        self.viewer_password = str(viewer.get("password") or "")

        data_dir = Path(str(paths.get("data_dir") or "data"))
        if not data_dir.is_absolute():
            data_dir = self.root / data_dir
        self.data_dir = data_dir.resolve()
        self.comics_dir = self.data_dir / "comics"
        self.covers_dir = self.data_dir / "covers"
        self.previews_dir = self.data_dir / "previews"
        self.pdfs_dir = self.data_dir / "pdfs"
        self.staging_dir = self.data_dir / "staging"
        self.cache_dir = self.data_dir / "cache"
        self.logs_dir = self.root / "logs"

        self.db_path = self.cache_dir / "jm-service.sqlite3"
        self.log_path = self.logs_dir / "jm-service.log"
        self.viewer_pid_path = self.logs_dir / "jm-view-server.pid"
        self.service_pid_path = self.logs_dir / "jm-service.pid"

    # ------------------------------------------------------------------ #
    @classmethod
    def load(cls, config_path: str | os.PathLike | None = None) -> "Config":
        """读取配置；文件不存在时使用内置默认（契约允许）。

        环境变量覆盖（便于测试/联调，不改变契约）：
        JM_SERVICE_CONFIG / JM_SERVICE_HOST / JM_SERVICE_PORT / JM_VIEWER_PORT /
        JM_VIEWER_HOST / JM_DATA_DIR
        """
        config_path = config_path or os.environ.get("JM_SERVICE_CONFIG") or (ROOT_DIR / "config" / "jm-service.json")
        path = Path(config_path)
        raw: dict = {}
        if path.exists():
            with open(path, "r", encoding="utf-8") as fh:
                raw = json.load(fh) or {}
        if _env_int("JM_VIEWER_PORT") is not None:
            raw = deep_merge(raw, {"viewer": {"port": _env_int("JM_VIEWER_PORT")}})
        if os.environ.get("JM_VIEWER_HOST"):
            raw = deep_merge(raw, {"viewer": {"host": os.environ["JM_VIEWER_HOST"]}})
        if _env_int("JM_SERVICE_PORT") is not None:
            raw["port"] = _env_int("JM_SERVICE_PORT")
        if os.environ.get("JM_SERVICE_HOST"):
            raw["host"] = os.environ["JM_SERVICE_HOST"]
        if os.environ.get("JM_DATA_DIR"):
            raw = deep_merge(raw, {"paths": {"data_dir": os.environ["JM_DATA_DIR"]}})
        return cls(raw, config_path=path if path.exists() else None)

    # ------------------------------------------------------------------ #
    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.comics_dir, self.covers_dir, self.previews_dir,
                     self.pdfs_dir, self.staging_dir, self.cache_dir, self.logs_dir):
            Path(path).mkdir(parents=True, exist_ok=True)

    def jm_client_list(self):
        """解析 jm.domain（逗号分隔）为域名列表。"""
        if not self.jm_domain:
            return []
        return [item.strip() for item in self.jm_domain.replace(";", ",").split(",") if item.strip()]

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return (f"Config(host={self.host}:{self.port}, viewer={self.viewer_host}:{self.viewer_port}, "
                f"data_dir={self.data_dir}, config={self.config_path})")
