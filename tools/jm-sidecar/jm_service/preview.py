"""Pillow 封面拼图：每行 1 本，左侧序号+ID，右侧封面缩略图，整体高度自适应。"""
from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 版式
PREVIEW_WIDTH = 460
PADDING = 14
LEFT_WIDTH = 150          # 序号 + ID 列
GAP = 12
IMAGE_BOX_WIDTH = PREVIEW_WIDTH - PADDING * 2 - LEFT_WIDTH - GAP
IMAGE_BOX_HEIGHT = 230
MIN_ROW_HEIGHT = 72
BACKGROUND = (255, 255, 255)
BORDER = (226, 230, 236)
TEXT_COLOR = (28, 32, 38)
MUTED_COLOR = (122, 130, 142)
PLACEHOLDER_BG = (238, 240, 244)
PLACEHOLDER_TEXT = (150, 158, 170)

_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
)


def _load_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    """优先中文字体；缺失时回退拉丁/默认字体（拼图不含中文也能正常出图）。"""
    names = _FONT_CANDIDATES if not bold else (
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\arialbd.ttf",
    ) + _FONT_CANDIDATES
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size)  # Pillow >= 10.1
    except TypeError:  # pragma: no cover - 旧 Pillow
        return ImageFont.load_default()


def preview_name(query: str, page: int, limit: int, album_ids) -> str:
    """拼图文件名：p_<指纹6位>_<limit>.jpg（同一查询+结果复用）。"""
    raw = "|".join([str(query), str(page), str(limit)] + [str(a) for a in album_ids])
    digest = hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:6]
    return f"p_{digest}_{int(limit)}.jpg"


def _measure(draw: ImageDraw.ImageDraw, text: str, font) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def _placeholder(width: int, height: int, label: str = "NO COVER") -> Image.Image:
    image = Image.new("RGB", (max(width, 1), max(height, 1)), PLACEHOLDER_BG)
    draw = ImageDraw.Draw(image)
    font = _load_font(max(12, min(18, height // 4)))
    text_width, text_height = _measure(draw, label, font)
    draw.text(((image.width - text_width) // 2, (image.height - text_height) // 2),
              label, fill=PLACEHOLDER_TEXT, font=font)
    return image


def _load_thumb(cover_file: str | None) -> Image.Image | None:
    if not cover_file:
        return None
    path = Path(str(cover_file))
    try:
        if not path.exists() or path.stat().st_size <= 0:
            return None
        with Image.open(path) as source:
            source.load()
            image = source.convert("RGB")
    except Exception:  # noqa: BLE001 - 坏图降级占位
        return None
    image.thumbnail((IMAGE_BOX_WIDTH, IMAGE_BOX_HEIGHT), Image.Resampling.LANCZOS)
    return image


def build_preview(results, out_path: str | Path) -> Path:
    """生成拼图并保存到 out_path（JPEG），返回路径。results 元素需有 id/rank/cover_file。"""
    results = list(results)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    rank_font = _load_font(22, bold=True)
    id_font = _load_font(19)
    sub_font = _load_font(13)

    rows = []
    probe = Image.new("RGB", (10, 10))
    probe_draw = ImageDraw.Draw(probe)
    for index, item in enumerate(results, start=1):
        rank = str(item.get("rank") or index)
        album_id = str(item.get("id") or "")
        cover = _load_thumb(item.get("cover_file"))
        if cover is None:
            cover = _placeholder(IMAGE_BOX_WIDTH, min(IMAGE_BOX_HEIGHT, 160))
        rows.append((rank, album_id, cover))

    total_height = PADDING * 2 + sum(max(MIN_ROW_HEIGHT, cover.height + 16) for _, _, cover in rows)
    canvas = Image.new("RGB", (PREVIEW_WIDTH, max(total_height, 60)), BACKGROUND)
    draw = ImageDraw.Draw(canvas)

    y = PADDING
    for rank, album_id, cover in rows:
        row_height = max(MIN_ROW_HEIGHT, cover.height + 16)
        # 外框
        draw.rounded_rectangle(
            (PADDING - 4, y, PREVIEW_WIDTH - PADDING + 4, y + row_height + 12),
            radius=10, outline=BORDER, width=1,
        )
        # 左侧：序号 + ID
        rank_text = f"{rank}."
        rank_w, rank_h = _measure(probe_draw, rank_text, rank_font)
        draw.text((PADDING + 4, y + 8), rank_text, fill=MUTED_COLOR, font=rank_font)
        draw.text((PADDING + 4 + rank_w + 6, y + 8), album_id, fill=TEXT_COLOR, font=id_font)
        # 右侧：封面缩略图（垂直居中）
        image_x = PADDING + LEFT_WIDTH
        image_y = y + 4 + max(0, (row_height - cover.height) // 2)
        # 图片低于文字区时仍保持行高
        if cover.height < MIN_ROW_HEIGHT - 16:
            image_y = y + 4
        canvas.paste(cover, (image_x, image_y))
        y += row_height + 12

    canvas.save(out_path, "JPEG", quality=88, optimize=True)
    return out_path
