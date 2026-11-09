"""glass_geometry.py — 悬浮窗玻璃的全部尺寸相关贴图，纯计算、无 Tk。

原来的 `window.py` 把 `W/H/SHAPES/MASK/OVERLAY/WARP_X/BOX_MAPS/...` 十几个量
挂成模块全局，靠 `global` 语句在 `rebuild_geometry()` 里一次性改写。副作用是：

- 任何模块都能读写它们，改一个尺寸要先数清楚谁在被引用；
- `import` 的那一刻就按默认尺寸建好一整套图，缩放/折叠都要再跑一遍；
- GPU 伴生文件只能 `import window as G` 去读全局，拿到的可能是「上一帧的尺寸」。

这里改成不可变值对象：`Geometry.for_size(w, h)` 给出完整一套；
气泡宽度变了就 `geo.with_shapes(shapes)` —— 尺寸相关的遮罩/折射图直接复用，
不需要重建。谁要什么就传 `geo` 进去，不再有隐式共享状态。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw

# ---- 布局常量（改这些等于改外观，改完必须截图对比） ----
DEFAULT_W, DEFAULT_H = 760, 560
MIN_W, MIN_H = 480, 420
CORNER_R = 58
BAR_FRAC = 0.55
BAR_Y = 20
BAR_THICK = 4
# 抠色键：窗口背景色 = 这个值的地方被 Tk 的 -transparentcolor 抠成透明。
KEY = "#010203"

MESSAGE_SLOTS = 4
SLAB_OUT, SLAB_TOP_H, SLAB_BOT_H = 12, 54, 118
# 底部「历史记录」那一栏（2026-11-06）：输入栏上方多一行，底块 70 → 118。
# 窗口默认跟着长高 48px（见 window._initial_geometry），消息区面积不变。
HISTORY_ROW_H = 48
SLAB_GAP = 10
SLAB_RADIUS = 22

# 气泡底板：文字底下是实时视频，对比度每秒都在变；给每块气泡铺一层深色，
# 文字的对比度就只由这层决定，不再跟着画面走。alpha 0.50（128/255）——
# 白字压在纯白画面上也能到 4.2:1，达到正文可读的下限；再低（0.40）只有 2.9:1。
# `DSH_GLASS_PLATE=0` 关掉（只用于新旧对比截图，正常别用）。
PLATE = os.environ.get("DSH_GLASS_PLATE", "1") != "0"
BUBBLE_PLATE = (7, 17, 29, 128) if PLATE else (0, 0, 0, 0)

# 抓屏时向外扩一圈，边缘透镜才有「框外」的像素可采
PAD = 40
BAND = 64          # 全分辨率下的透镜带宽度
AMP = 30           # 全分辨率下的最大采样偏移
LPF = 4            # 透镜/模糊在 1/4 分辨率上算

BOX_BAND = 7       # 1/4 分辨率下的折射带
BOX_AMP = 8        # 1/4 分辨率下的最大采样偏移

MIC_SIZE = 28
MIC_MARGIN = (53, 67)   # 距左下角

Box = tuple[int, int, int, int, int]   # x0, y0, x1, y1, radius


def slabs_for(w: int, h: int, pad: int = 0) -> tuple[Box, ...]:
    """三块独立的玻璃：标题栏 / 主体 / 输入栏，中间留透明缝透出桌面。

    折叠态（高度只有标题栏）只返回那一块 —— 否则主体/输入栏会算出 y1 < y0
    的负高度矩形，PIL 直接抛 `y1 must be greater than or equal to y0`。

    `pad`：顶上多留一条（「关联变更」输入行）。窗口向上长高 `pad`、底边不动，
    所以**所有内容的 y 都要 +pad**，只有这样屏幕上的位置才不变。
    """
    o = SLAB_OUT
    top = (o, o + pad, w - o, o + pad + SLAB_TOP_H)
    # 主体块要求 bot[1] - GAP >= top[3] + GAP：窗口比这更矮时只画标题栏。
    # 收起态 78 走这条；【新消息】气泡出现时窗高约 200~500，矮气泡（~200）也会落到这里，
    # 不这样判就会算出负高度的 body，PIL 抛 `y1 must be greater than or equal to y0`（2026-11-06 实报）。
    if h < 2 * o + pad + SLAB_TOP_H + SLAB_BOT_H + 2 * SLAB_GAP:
        return (top,)
    bot = (o, h - o - SLAB_BOT_H, w - o, h - o)
    body = (o, top[3] + SLAB_GAP, w - o, bot[1] - SLAB_GAP)
    return (top, body, bot)


def chat_layout(h: int, pad: int = 0) -> tuple[list[int], int]:
    """四条消息槽位的 y 起点与高度；输入框始终贴底。

    2026-11-05 改：以前 h≥560 时写死 `[104,198,292,386]` + 每格 88px，窗口拖高槽位也不变，
    于是气泡永远只装得下 5 行、长回复只能截断。现在槽位高度**跟着窗口走**：
    拖高窗口每一格就变高，气泡能装的行数随之增加。

    2026-11-06 改：底部多了一行「历史记录」，消息区的下边界从「输入栏顶」抬到
    「输入栏顶 - HISTORY_ROW_H」——否则气泡会画到那一栏上。输入框本身不动。
    """
    feed_bottom = h - 80 - HISTORY_ROW_H
    top0 = 104 + pad
    if h >= 560 + pad:
        gap = 8
        avail = max(4 * 40, (feed_bottom - 8) - top0 - gap * 3)
        bh = max(40, avail // 4)
        return [top0 + i * (bh + gap) for i in range(4)], bh
    avail = max(0, feed_bottom - (124 + pad) - 8)
    bh = min(60, max(36, (avail - 24) // 4))
    gap = max(8, (avail - 4 * bh) // 3)
    return [top0 + i * (bh + gap) for i in range(4)], bh


def shapes_for(w: int, h: int, pad: int = 0) -> tuple[Box, ...]:
    """内部框的纵向槽位；气泡的最终宽高由文字测量决定（见 window._message_shapes）。

    折叠态（h=78）没有消息区和输入区，返回全零占位：`_box_maps`/`_overlay` 会跳过
    空框，不会在负坐标上算出畸形折射图。
    """
    input_top = h - 80
    if input_top - 40 < SLAB_OUT + SLAB_TOP_H + pad:
        return tuple((0, 0, 0, 0, 0) for _ in range(MESSAGE_SLOTS + 2))
    ys, bh = chat_layout(h, pad)
    boxes = [(38, y, w - 38, y + bh, 30) for y in ys]
    boxes.append((36, input_top, w - 146, input_top + 54, 27))
    boxes.append((w - 134, input_top, w - 36, input_top + 54, 27))
    return tuple(boxes)


def _rounded_mask(w: int, h: int, boxes: Iterable[Box]) -> Image.Image:
    ss = 4
    m = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(m)
    for x0, y0, x1, y1 in boxes:
        d.rounded_rectangle((x0 * ss, y0 * ss, x1 * ss, y1 * ss),
                            radius=SLAB_RADIUS * ss, fill=255)
    return m.resize((w, h), Image.Resampling.LANCZOS)


def _overlay(w: int, h: int, shapes: tuple[Box, ...], plate: bool = True) -> Image.Image:
    """内部框的染色。气泡铺底板（文字靠它稳住对比度），其余仍是极淡的冷色。

    `plate=False` 用于没有消息的空态：那四个槽位只是占位，铺深色反而像四个空洞。
    """
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    tints = ((235, 242, 255, 5), (110, 175, 255, 14), (235, 242, 255, 4),
             (235, 242, 255, 4), (235, 242, 255, 5), (110, 175, 255, 12))
    for i, ((x0, y0, x1, y1, r), fill) in enumerate(zip(shapes, tints)):
        if x1 > x0 and y1 > y0:
            if plate and PLATE and i < MESSAGE_SLOTS:
                # 向外 1px：内框边缘有折射带，底板正好压在它上面，否则那圈
                # 折射出来的背景色会变成一条彩色描边（亮背景上特别明显）
                d.rounded_rectangle((x0 - 1, y0 - 1, x1 + 1, y1 + 1), radius=r + 1,
                                    fill=BUBBLE_PLATE)
            else:
                d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=fill)
    return layer


def _warp_maps(w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    """1/4 分辨率的边缘位移图：真正采样「边界外」的背景，不是描边。

    半径方向向外取样本，越靠边偏移越大，到 BAND 内归零。
    """
    hw, hh = w // LPF, h // LPF
    yy, xx = np.mgrid[0:hh, 0:hw].astype(np.float32)
    r = CORNER_R / LPF
    qx = np.abs(xx - hw / 2) - (hw / 2 - r)
    qy = np.abs(yy - hh / 2) - (hh / 2 - r)
    sdf = (np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
           + np.minimum(np.maximum(qx, qy), 0) - r)
    gy, gx = np.gradient(sdf)
    n = np.maximum(np.hypot(gx, gy), 1e-6)
    d = -sdf
    t = np.clip(1.0 - d / (BAND / LPF), 0.0, 1.0)
    mag = (AMP / LPF) * t * t
    return (xx + gx / n * mag).astype(np.float32), (yy + gy / n * mag).astype(np.float32)


def _box_maps(shapes: tuple[Box, ...], w: int, h: int) -> tuple[tuple, ...]:
    """每个内部框的 alpha / 边缘权重 / 采样坐标，全部在 1/4 分辨率。"""
    out = []
    for x0, y0, x1, y1, r in shapes:
        if x1 <= x0 or y1 <= y0:
            continue
        qx0, qy0 = x0 // LPF, y0 // LPF
        qw, qh = max(2, (x1 - x0) // LPF), max(2, (y1 - y0) // LPF)
        xx, yy = np.meshgrid(np.arange(qw, dtype=np.float32),
                             np.arange(qh, dtype=np.float32))
        rr = r / LPF
        cx, cy = qw / 2.0, qh / 2.0
        qx = np.abs(xx - cx) - (cx - rr)
        qy = np.abs(yy - cy) - (cy - rr)
        sdf = (np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
               + np.minimum(np.maximum(qx, qy), 0) - rr)
        gy, gx = np.gradient(sdf)
        n = np.maximum(np.hypot(gx, gy), 1e-6)
        d = -sdf
        alpha = np.clip((d + 0.6) / 1.2, 0.0, 1.0).astype(np.float32)
        t = np.clip(1.0 - d / BOX_BAND, 0.0, 1.0)
        mag = BOX_AMP * t * t
        sx = np.rint(qx0 + xx + gx / n * mag).astype(np.int32)
        sy = np.rint(qy0 + yy + gy / n * mag).astype(np.int32)
        np.clip(sx, 0, w // LPF - 1, out=sx)
        np.clip(sy, 0, h // LPF - 1, out=sy)
        # 边缘→中心用 smoothstep 过渡，二值硬切会看到一圈割裂
        weight = np.clip(d / BOX_BAND, 0.0, 1.0).astype(np.float32)
        weight = (weight * weight * (3.0 - 2.0 * weight)).astype(np.float32)
        out.append((qx0, qy0, qw, qh, alpha, weight, sx, sy))
    return tuple(out)


def _box_union(w: int, h: int, ow: int, oh: int, shapes: tuple[Box, ...]) -> Image.Image:
    """目标分辨率下的圆角联合遮罩，4x 超采样后缩小，边界平滑。"""
    ss = 4
    fx, fy = ow / w, oh / h
    m = Image.new("L", (ow * ss, oh * ss), 0)
    d = ImageDraw.Draw(m)
    for x0, y0, x1, y1, r in shapes:
        if x1 <= x0 or y1 <= y0:
            continue
        d.rounded_rectangle((x0 * fx * ss, y0 * fy * ss,
                             x1 * fx * ss, y1 * fy * ss),
                            radius=r * min(fx, fy) * ss, fill=255)
    return m.resize((ow, oh), Image.Resampling.LANCZOS)


@dataclass(frozen=True)
class Geometry:
    """一套尺寸下的全部贴图。不可变：改形状请用 `with_shapes()`。

    `version` 每次变更 +1，GPU 侧靠它判断要不要重建坐标纹理
    （对应旧代码里那个模块级的 `SHAPES_VERSION`）。
    """

    width: int
    height: int
    version: int = 0
    slabs: tuple[Box, ...] = ()
    mask_hard: Image.Image | None = None
    warp_x: np.ndarray | None = None
    warp_y: np.ndarray | None = None
    shapes: tuple[Box, ...] = ()
    overlay: Image.Image | None = None
    overlay_half: Image.Image | None = None
    plate: bool = False          # 当前 overlay 有没有气泡底板（空态为 False）
    box_maps: tuple[tuple, ...] = ()
    box_union_half: Image.Image | None = None
    _mic_pos: tuple[int, int] = field(default=(0, 0), repr=False)

    # ---- 构造 ----

    @classmethod
    def for_size(cls, w: int, h: int, version: int = 0, pad: int = 0) -> "Geometry":
        shapes = shapes_for(w, h, pad)
        mask = _rounded_mask(w, h, slabs_for(w, h, pad))
        # color-key 透明不能用半透明边缘：半透明像素会和 KEY 混合成黑边，
        # 所以遮罩二值硬切。
        mask_hard = mask.point(lambda v: 255 if v >= 128 else 0)
        warp_x, warp_y = _warp_maps(w, h)
        base = cls(width=w, height=h, version=version,
                   slabs=slabs_for(w, h, pad), mask_hard=mask_hard,
                   warp_x=warp_x, warp_y=warp_y,
                   _mic_pos=(MIC_MARGIN[0], h - MIC_MARGIN[1]))
        return base.with_shapes(shapes, version=version, plate=False)

    def with_shapes(self, shapes: Iterable[Box], version: int | None = None,
                    plate: bool = True) -> "Geometry":
        shapes = tuple(shapes)
        overlay = _overlay(self.width, self.height, shapes, plate=plate)
        hw, hh = max(1, self.width // 2), max(1, self.height // 2)
        # GPU 只按 (尺寸, version) 决定要不要重传纹理：形状没变、只多了底板时
        # 也得换 version，否则会一直显示空态那张 overlay。
        bump = version is None or plate != self.plate
        return replace(
            self,
            version=(self.version + 1) if bump else self.version,
            shapes=shapes,
            overlay=overlay,
            overlay_half=overlay.resize((hw, hh), Image.Resampling.BILINEAR),
            plate=plate,
            box_maps=_box_maps(shapes, self.width, self.height),
            box_union_half=_box_union(self.width, self.height, hw, hh, shapes),
        )

    # ---- 派生量 ----

    @property
    def mic_pos(self) -> tuple[int, int]:
        return self._mic_pos

    @property
    def input_shape(self) -> Box:
        return self.shapes[MESSAGE_SLOTS]

    @property
    def send_shape(self) -> Box:
        return self.shapes[MESSAGE_SLOTS + 1]

    @property
    def half_size(self) -> tuple[int, int]:
        return max(1, self.width // 2), max(1, self.height // 2)

    @property
    def input_top(self) -> int:
        return self.height - 80

    def collapsed_frame(self, frame: Image.Image | None) -> Image.Image | None:
        """折叠态：只保留标题栏那一块玻璃，按 78px 重新贴圆角。

        直接裁上一帧会让底部变成硬切边（遮罩还是整窗高度），看起来像渲染坏了。
        """
        if frame is None:
            return None
        try:
            w, h = self.width, self.height
            crop = frame.convert("RGB").crop((0, 0, w, h))
            mask = Image.new("L", (w, h), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                (SLAB_OUT, SLAB_OUT, w - SLAB_OUT, SLAB_OUT + SLAB_TOP_H),
                radius=SLAB_RADIUS, fill=255)
            out = Image.new("RGB", (w, h), KEY)
            out.paste(crop, (0, 0), mask)
            return out
        except Exception:
            return None


def collapsed_height() -> int:
    return 2 * SLAB_OUT + SLAB_TOP_H


__all__ = [
    "AMP", "BAND", "BAR_FRAC", "BAR_THICK", "BOX_AMP", "BOX_BAND", "Box",
    "CORNER_R", "DEFAULT_H", "DEFAULT_W", "Geometry", "HISTORY_ROW_H", "KEY",
    "LPF", "MESSAGE_SLOTS", "MIC_MARGIN", "MIC_SIZE", "MIN_H", "MIN_W", "PAD",
    "SLAB_RADIUS", "chat_layout", "collapsed_height", "shapes_for", "slabs_for",
]
