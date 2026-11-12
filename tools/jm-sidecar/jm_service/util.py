"""通用工具：局域网 IP、Windows 文件名安全化、路径 URL、日志。"""
from __future__ import annotations

import logging
import logging.handlers
import re
import socket
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

# Windows 文件名非法字符 + 控制字符
_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WHITESPACE = re.compile(r"\s+")
_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL"}
_RESERVED_NAMES |= {f"COM{i}" for i in range(1, 10)}
_RESERVED_NAMES |= {f"LPT{i}" for i in range(1, 10)}

_lan_ip_cache: str | None = None


def get_lan_ip(fallback: str = "127.0.0.1") -> str:
    """UDP connect 8.8.8.8:80 探测本机局域网 IP（不实际发包）。"""
    global _lan_ip_cache
    if _lan_ip_cache:
        return _lan_ip_cache
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.5)
        sock.connect(("8.8.8.8", 80))
        _lan_ip_cache = sock.getsockname()[0]
    except Exception:
        _lan_ip_cache = fallback
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
    return _lan_ip_cache


def sanitize_win_name(name: str, max_len: int = 40, default: str = "untitled") -> str:
    """把任意标题变成 Windows 合法文件名：替换非法字符、去尾点空格、限长、避开保留名。"""
    text = str(name or "").strip()
    if not text:
        return default
    text = _INVALID_CHARS.sub("_", text)
    text = _WHITESPACE.sub(" ", text).strip()
    text = text.rstrip(". ")
    # 按 unicode 字符截断（中文标题 40 字）
    if len(text) > max_len:
        text = text[:max_len].rstrip(". ")
    if not text:
        return default
    base = text.split(".")[0].upper()
    if text.upper() in _RESERVED_NAMES or base in _RESERVED_NAMES:
        text = "_" + text
    return text


def album_folder_name(album_id: str, title: str, max_len: int = 40) -> str:
    """漫画库目录名：JM<id>-<安全标题≤40字>。"""
    safe_title = sanitize_win_name(title, max_len=max_len, default="untitled")
    return f"JM{album_id}-{safe_title}"


def truncate_text(text: str, max_len: int) -> str:
    text = str(text or "").strip()
    return text if len(text) <= max_len else text[:max_len]


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def is_album_id(value) -> bool:
    return bool(re.fullmatch(r"\d{1,12}", str(value or "").strip()))


def normalize_album_id(value) -> str:
    """JM 车号：去空白、去前导零后返回字符串；非法返回空串。"""
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{1,12}", text):
        return ""
    return str(int(text))


def quote_abs_path(path: str | Path) -> str:
    return quote(str(Path(path).resolve()))


def jm_album_url(album_id: str) -> str:
    return f"https://18comic.vip/album/{album_id}"


def service_public_base(host: str, port: int) -> str:
    """边车对外可访问 base：绑定回环时用 127.0.0.1（本机 helper 可用），否则用局域网 IP。"""
    if host in ("127.0.0.1", "localhost", "::1"):
        return f"http://127.0.0.1:{port}"
    return f"http://{get_lan_ip()}:{port}"


def viewer_public_base(config) -> str:
    """jm-view-server 对外 base：优先配置 public_base，否则自动探测局域网 IP。"""
    if config.viewer_public_base:
        return config.viewer_public_base
    return f"http://{get_lan_ip()}:{config.viewer_port}"


def viewer_url_for_dir(config, directory: str | Path) -> str:
    """生成 jm-view-server 阅读链接；目录含章节子目录时取第一个子目录。"""
    target = pick_viewer_dir(Path(directory))
    return f"{viewer_public_base(config)}/jm_view?path={quote_abs_path(target)}"


_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff"}


def find_first_image_dir(root: Path) -> Path | None:
    """在 root 下寻找第一个包含图片的目录（广度优先，root 自己优先）。"""
    root = Path(root)
    queue = [root]
    while queue:
        current = queue.pop(0)
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            continue
        if any(entry.is_file() and entry.suffix.lower() in _IMAGE_SUFFIXES for entry in entries):
            return current
        for entry in entries:
            if entry.is_dir():
                queue.append(entry)
    return None


def pick_viewer_dir(root: Path) -> Path:
    """单章节拍平后通常就是 root；若存在章节子目录，取第一个含图片的子目录。"""
    root = Path(root)
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return root
    direct_images = [e for e in entries if e.is_file() and e.suffix.lower() in _IMAGE_SUFFIXES]
    if direct_images:
        return root
    subdirs = [e for e in entries if e.is_dir()]
    for subdir in subdirs:
        found = find_first_image_dir(subdir)
        if found is not None:
            return found
    return root


def setup_logging(log_path: str | Path, level: int = logging.INFO) -> logging.Logger:
    """服务日志：logs/jm-service.log（滚动）+ stdout。重复调用幂等。"""
    logger = logging.getLogger("jm-service")
    logger.setLevel(level)
    if logger.handlers:
        return logger

    fmt = logging.Formatter("%(asctime)s %(levelname)s [%(threadName)s] %(message)s",
                            datefmt="%Y-%m-%d %H:%M:%S")

    path = Path(log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=4 * 1024 * 1024, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)
    logger.propagate = False
    return logger
