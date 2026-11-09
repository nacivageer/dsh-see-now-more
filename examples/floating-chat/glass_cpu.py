"""glass_cpu.py — CPU 玻璃合成：抓屏 → 模糊 → 边缘折射 → 内框透镜 → 染色 → 色散。

这就是原来 `window.LiveGlass._capture()` 那 130 行，拆成一条显式的管线：

    grab → 缩小 → observe(moved/stale) → 模糊 → 折射 → 内框
         → 2x 合成 → 染色 → 色散(仅静止帧) → 放大 → 残影(仅移动帧) → 麦克风 → 圆角

渲染器不再知道 Tk、配置、聊天流的存在：给一张背景，还一张玻璃。
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

from glass_capture import CaptureSource, MotionTracker, finish, paste_mic, resample
from glass_geometry import LPF, Geometry

try:
    import cv2 as _cv2
except Exception:
    _cv2 = None

BLUR_EDGE = 1.45      # 1/4 分辨率上，边缘取这一档
BLUR_CENTER = 2.6     # 内框中心再叠一档（叠在已模糊图上，等效更厚）
CHROMA = 1.7          # 2x 图上的 R/B 错位像素


def _blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    if _cv2 is not None:
        return _cv2.GaussianBlur(arr, (0, 0), sigmaX=sigma, sigmaY=sigma,
                                 borderType=_cv2.BORDER_REFLECT)
    return np.asarray(Image.fromarray(arr).filter(ImageFilter.GaussianBlur(sigma)))


def _smoothstep(a: float, b: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


class CpuRenderer:
    """把背景图变成玻璃帧。一个实例对应一套 `Geometry`。"""

    def __init__(self, geo: Geometry, tracker: MotionTracker | None = None):
        self.geo = geo
        self.tracker = tracker or MotionTracker()
        self._prev: Image.Image | None = None
        self._chroma: dict = {}

    # ---- 生命周期 ----

    def set_geometry(self, geo: Geometry) -> None:
        self.geo = geo
        self._chroma.clear()      # 旧尺寸的索引图不再用，别每缩放一次攒一份
        self.invalidate()

    def invalidate(self) -> None:
        """形状变了：旧签名和上一帧都不能再参与合成。"""
        self.tracker.invalidate()
        self._prev = None

    # ---- 主入口 ----

    def render(self, source: CaptureSource, sct, bbox) -> Image.Image | None:
        """返回一张 `geo.width × geo.height` 的 RGB 图；`None` = 本帧不必更新。"""
        geo = self.geo
        shot = source.grab(sct, bbox)
        if shot is None:
            return None
        im = source.to_image(shot, bbox)

        gw, gh = shot.shot.size
        sw4, sh4 = max(2, gw // LPF), max(2, gh // LPF)
        raw = resample(np.asarray(im), (sw4, sh4))
        moved, stale = self.tracker.observe(raw, shot.box)
        if stale:
            # 静态跳帧：连模糊都不做。上一帧若带运动残影，绝不能留到下次移动。
            self._prev = None
            return None

        small = _blur(raw, BLUR_EDGE)
        strong = _blur(small, BLUR_CENTER)

        warped, out_panel = self._lens(small, strong, raw, shot.offset)
        panel = self._compose(warped, out_panel, moved)
        out = resample(np.asarray(panel), (geo.width, geo.height))
        out = Image.fromarray(out.astype(np.uint8))

        if moved and self._prev is not None and self._prev.size == out.size:
            blend = self.tracker.blend
            if blend > 0.01:
                out = Image.blend(self._prev, out, blend)
        self._prev = out.copy()
        # 先混再贴麦克风，避免把上一帧的麦克风位置糊到这一帧
        return finish(geo, paste_mic(geo, out))

    # ---- 步骤 ----

    def _lens(self, small: np.ndarray, strong: np.ndarray, raw: np.ndarray, offset):
        """边缘折射 + 内框透镜，全在 1/4 分辨率完成。

        `warped` 是整窗背景按圆角边缘位移后的结果；`out_panel` 在它的基础上
        把每个内框区域换成「边缘折射 → 中心强模糊」的过渡。
        """
        geo = self.geo
        px, py = offset
        h, w = small.shape[:2]
        sx = np.clip(np.rint(geo.warp_x + px).astype(np.int32), 0, w - 1)
        sy = np.clip(np.rint(geo.warp_y + py).astype(np.int32), 0, h - 1)
        warped = small[sy, sx]
        strong_panel = strong[sy, sx]
        out_panel = warped.copy()
        for qx0, qy0, qw, qh, alpha, weight, bsx, bsy in geo.box_maps:
            base_patch = warped[qy0:qy0 + qh, qx0:qx0 + qw]
            if base_patch.size == 0:
                continue
            edge_patch = raw[np.clip(bsy + py, 0, h - 1), np.clip(bsx + px, 0, w - 1)]
            strong_patch = strong_panel[qy0:qy0 + qh, qx0:qx0 + qw]
            patch = edge_patch * (1.0 - weight[..., None]) + strong_patch * weight[..., None]
            a = alpha[..., None]
            out_panel[qy0:qy0 + qh, qx0:qx0 + qw] = base_patch * (1.0 - a) + patch * a
        return warped, out_panel

    def _compose(self, warped: np.ndarray, out_panel: np.ndarray, moved: bool) -> Image.Image:
        """1/4 → 1/2 合成：框内用透镜、框外用底图，再叠染色与色散。

        在 2x 上做而不是全分辨率：全分辨率逐像素色散会把这条 60fps 管线拖慢。
        移动帧跳过色散（约 3.5ms/帧），优先保证拖动/滚动响应，停下后静止帧补上。
        """
        geo = self.geo
        hw, hh = geo.half_size
        base_2x = Image.fromarray(resample(warped, (hw, hh)))
        lens_2x = Image.fromarray(resample(out_panel, (hw, hh)))
        panel = Image.composite(lens_2x, base_2x, geo.box_union_half)
        panel = Image.alpha_composite(panel.convert("RGBA"), geo.overlay_half).convert("RGB")
        if not moved:
            panel = self._chroma_shift(panel, CHROMA)
        return panel

    def _chroma_maps(self, w: int, h: int, strength: float):
        key = (w, h, round(float(strength), 2))
        hit = self._chroma.get(key)
        if hit is not None:
            return hit
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        dx = (xx + 0.5) / w - 0.5
        dy = (yy + 0.5) / h - 0.5
        r = np.hypot(dx, dy) + 1e-6
        edge = _smoothstep(0.38, 0.48, r) * (1.0 - _smoothstep(0.52, 0.585, r))
        k = strength * edge
        ox = np.rint(dx / r * k).astype(np.int32)
        oy = np.rint(dy / r * k).astype(np.int32)
        xi, yi = xx.astype(np.int32), yy.astype(np.int32)
        hit = (edge.astype(np.float32),
               np.clip(xi + ox, 0, w - 1), np.clip(yi + oy, 0, h - 1),
               np.clip(xi - ox, 0, w - 1), np.clip(yi - oy, 0, h - 1))
        if len(self._chroma) > 4:
            self._chroma.clear()
        self._chroma[key] = hit
        return hit

    def _chroma_shift(self, im: Image.Image, strength: float) -> Image.Image:
        """外框径向色散：R 向外、B 向内错一位，只在圆角外缘的窄带里做。"""
        arr = np.asarray(im.convert("RGB"), dtype=np.float32)
        h, w = arr.shape[:2]
        edge, xr, yr, xb, yb = self._chroma_maps(w, h, strength)
        if not np.any(edge > 0.001):
            return im
        out = arr.copy()
        out[:, :, 0] = arr[:, :, 0] * (1.0 - edge) + arr[yr, xr, 0] * edge
        out[:, :, 2] = arr[:, :, 2] * (1.0 - edge) + arr[yb, xb, 2] * edge
        return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


__all__ = ["CpuRenderer"]
