"""glass_capture.py — 抓屏、运动判定、所有渲染路径共用的收尾。

CPU 与 GPU 两条管线以前各写一份「抓屏 → 算静态签名 → 判断要不要重合成 →
贴麦克风 → 贴圆角遮罩」，于是同一个 bug 要修两遍（#39、#48 都是这么来的：
CPU 修了，GPU 漏了）。这里把它们收成一套：

- `CaptureSource.grab()`：窗口矩形外扩 PAD、钳位、守卫零尺寸；
- `MotionTracker.observe()`：返回 `(moved, stale)`，**两个判断一次算完**，
  不会再出现「拖动窗口算不算动」这种两边理解不一致；
- `finish()` / `paste_mic()`：两条路径的最后两步。

渲染器只负责「一张图 → 一张图」，其余都在这里。
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from glass_geometry import KEY, LPF, MIC_SIZE, PAD, Geometry

try:
    import cv2 as _cv2
except Exception:      # OpenCV 只是加速，缺了仍走 PIL
    _cv2 = None

HERE = Path(__file__).resolve().parent

# 静态跳帧：像素差超过这个就算「动了」
SIG_STEP = 4                      # 采样步长（像素）
MOVE_MEAN = 0.01                  # 平均差阈值（0~255）
MOVE_MAX = 0.5                    # 单点最大差阈值
STALE_AFTER = 0.30                # 运动结束后多久允许跳帧

FORCE = os.environ.get("GLASS_FORCE") == "1"

# 抓屏连续失败时的替身底板颜色。取窗口本体那种深蓝黑：和气泡底板同一套色，
# 失败时看起来像"玻璃后面是暗背景"，而不是一块死黑。
SOLID_RGB = (18, 22, 30)
_solid_cache: dict[tuple[int, int], "_SolidShot"] = {}
_last_warn = [0.0]


class _SolidShot:
    """`mss` 截图的替身：只实现下游用到的 `.size` / `.rgb` / `.bgra`。

    下游两条路都在这儿取像素：CPU 走 `Image.frombytes("RGB", size, rgb)`，
    GPU 走 `np.frombuffer(shot.shot.bgra).reshape(h, w, 4)`。少给一个属性
    就是「失败时 CPU 能兜、GPU 每帧抛」—— 而 GPU 那条正好是有问题的那台机器
    更可能开的（`DSH_GLASS_GPU=1`）。
    """
    __slots__ = ("size", "rgb", "bgra")

    def __init__(self, w: int, h: int, color: tuple[int, int, int] = SOLID_RGB):
        self.size = (w, h)
        r, g, b = color
        self.rgb = bytes((r, g, b)) * (w * h)
        self.bgra = bytes((b, g, r, 255)) * (w * h)


def _solid_shot(w: int, h: int) -> "_SolidShot":
    """同尺寸复用一份（失败时每帧都要一张，别一直分配 1MB+）。"""
    key = (w, h)
    shot = _solid_cache.get(key)
    if shot is None:
        shot = _SolidShot(w, h)
        if len(_solid_cache) > 4:
            _solid_cache.clear()
        _solid_cache[key] = shot
    return shot


def _warn_grab(exc: Exception) -> None:
    """抓屏失败**只喊一次**（30 秒内不重复）。每帧刷屏等于没有日志。"""
    now = time.monotonic()
    if now - _last_warn[0] < 30:
        return
    _last_warn[0] = now
    print(f"capture failed, using solid plate: {type(exc).__name__}: {exc}", flush=True)


def _load_mic() -> tuple[Image.Image, Image.Image]:
    """麦克风图标：去背景得到 alpha，再做浅色/深色两版（按背后亮度挑）。"""
    try:
        mask = Image.open(HERE / "mic-dsh.png").convert("L")
        mask = mask.resize((MIC_SIZE, MIC_SIZE), Image.Resampling.LANCZOS)
    except Exception:
        mask = Image.new("L", (MIC_SIZE, MIC_SIZE), 200)
    light = Image.new("RGBA", mask.size, (235, 244, 255, 0))
    light.putalpha(mask)
    dark = Image.new("RGBA", mask.size, (24, 48, 72, 0))
    dark.putalpha(mask)
    return light, dark


MIC_LIGHT, MIC_DARK = _load_mic()


def resample(arr_or_im, size):
    """缩放一张图（两个方向都用）；有 OpenCV 走 OpenCV，比 PIL 快一个数量级。"""
    if _cv2 is not None:
        src = np.asarray(arr_or_im)
        return _cv2.resize(src, size, interpolation=_cv2.INTER_LINEAR)
    if isinstance(arr_or_im, Image.Image):
        im = arr_or_im
    else:
        # 模糊/合成链路会产出 float 数组，新 Pillow 的 fromarray 直接拒绝 3 通道 float
        # （`Cannot handle this data type: (1, 1, 3), <f4>`）。整条玻璃底板就因为这一句
        # 每帧抛错而画不出来 —— 表现为"窗口在、但屏幕上几乎什么都看不见"（2026-11-05 实报）。
        arr = np.asarray(arr_or_im)
        if arr.dtype != np.uint8:
            if arr.dtype.kind == "f":
                top = float(np.nanmax(arr)) if arr.size else 0.0
                if top <= 1.5:
                    arr = arr * 255.0
            arr = np.clip(arr, 0, 255).astype(np.uint8)
        im = Image.fromarray(arr)
    return np.asarray(im.resize(size, Image.Resampling.BILINEAR))


CORNER_PROBE = 56      # 角块边长：从这个方块里取中位色


def _median_color(arr: np.ndarray, y0: int, y1: int, x0: int, x1: int):
    """一块区域的三通道中位数（没有像素返回 None）。

    用中位数而不是均值：桌面图标、文字这类「少数像素」不会把整块颜色带跑，
    均值会被一个白色图标顶到发白。
    """
    h, w = arr.shape[:2]
    y0, y1 = max(0, min(h, y0)), max(0, min(h, y1))
    x0, x1 = max(0, min(w, x0)), max(0, min(w, x1))
    patch = arr[y0:y1, x0:x1]
    if patch.size == 0:
        return None
    return np.median(patch.reshape(-1, patch.shape[-1]), axis=0).astype(np.float32)


def _fill_patch(arr: np.ndarray, box, step: int = 8) -> None:
    """把窗口矩形填成「四周环境色」的二维渐变（原地）。

    **不要拿边缘像素插值**。窗口上下左右紧挨着的那一圈里如果正好有桌面图标或
    文字，插值会把它们沿某个方向整条抹开 —— 纵插值是竖条、横插值是横条，换哪种
    都难看（用户两次都撞上了）。

    现在只取窗口外**四个角块的中位色**，做双线性。角块完全在窗口外面，不含窗口
    自己的内容；中位数又抹掉了图标这类少数像素；四角双线性只有大尺度过渡，
    不存在任何「把东西拉长」的方向。

    渐变在 `step` 分之一的粗网格上算再放大：这块最后还要被高斯糊一遍，
    8px 的色阶看不出来。全分辨率算一次要 80ms，粗网格是 0.3ms。
    """
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = (int(v) for v in box)
    x0, x1 = max(0, min(w, x0)), max(0, min(w, x1))
    y0, y1 = max(0, min(h, y0)), max(0, min(h, y1))
    bw, bh = x1 - x0, y1 - y0
    if bw <= 0 or bh <= 0:
        return

    b = CORNER_PROBE
    tl = _median_color(arr, y0 - b, y0, x0 - b, x0)
    tr = _median_color(arr, y0 - b, y0, x1, x1 + b)
    bl = _median_color(arr, y1, y1 + b, x0 - b, x0)
    br = _median_color(arr, y1, y1 + b, x1, x1 + b)
    # 窗口贴在屏幕边上时角块会缺 —— 用整圈外框的中位色兜底；
    # 连外框都没有（窗口铺满屏幕）才退回窗口自己的中位色。
    ring = _median_color(arr, y0 - b, y1 + b, x0 - b, x0) if x0 > 0 else None
    if ring is None:
        ring = _median_color(arr, y0 - b, y1 + b, x1, x1 + b) if x1 < w else None
    if ring is None:
        ring = _median_color(arr, y0 - b, y0, x0, x1) if y0 > 0 else None
    if ring is None:
        ring = _median_color(arr, y1, y1 + b, x0, x1) if y1 < h else None
    if ring is None:
        ring = _median_color(arr, y0, y1, x0, x1) or np.zeros(3, np.float32)
    tl = ring if tl is None else tl
    tr = ring if tr is None else tr
    bl = ring if bl is None else bl
    br = ring if br is None else br

    gw, gh = max(2, bw // step), max(2, bh // step)
    ty = ((np.arange(gh, dtype=np.float32) + 0.5) / gh)[:, None, None]
    tx = ((np.arange(gw, dtype=np.float32) + 0.5) / gw)[None, :, None]
    out = (tl * (1 - tx) * (1 - ty) + tr * tx * (1 - ty)
           + bl * (1 - tx) * ty + br * tx * ty)
    out = np.clip(out, 0, 255)
    big = resample(out, (bw, bh)) if (gw, gh) != (bw, bh) else out
    arr[y0:y1, x0:x1] = big.astype(np.uint8)


def fill_own_rect(im: Image.Image, box) -> Image.Image:
    """录屏模式下把「窗口自己」在抓屏帧里占的那块填掉。

    `capturable: true` 会关掉 WDA，于是 mss 抓背景时把窗口也抓进来，玻璃拿它
    当背景就是「透过自己看自己」：背景里带着上一帧的字 → 亮度判据一直抖 →
    字色来回翻；背景一直在变 → `moved` 恒真 → 越滚越浓的假拖尾。

    窗口外 PAD 一圈仍是真背景，边缘透镜照常取料。
    """
    arr = np.array(im)
    _fill_patch(arr, box)
    return Image.fromarray(arr)


def fill_own_rect_array(arr: np.ndarray, box) -> None:
    """`fill_own_rect` 的原地版本，给直接吃 `shot.bgra` 的 GPU 路径用。

    GPU 不经过 PIL，如果漏了这一步，抓到的背景里永远有自己 —— 每帧都在变，
    静态跳帧一次都不会触发，还叠出自我反馈的拖尾。
    """
    _fill_patch(arr, box)


class MotionTracker:
    """静态跳帧 + 运动强度，两条渲染路径共用。

    语义（和 0.2.9 修过的 CPU 行为一致）：

    - **抓取区域变了就算动**。拖动窗口时 `box` 每帧都不同，旧区域的像素本来
      也不能直接做差；不标 `moved` 的话，拖动全程都走「没在动」分支 ——
      运动模糊一路衰减到 0、反而每帧去做静止才该做的色散。这就是 #48。
    - 静止超过 `STALE_AFTER` 就允许跳帧（`stale=True`），省掉整条合成；
    - `motion` 是 0~1 的平滑值，只有移动帧才拿它去混上一帧。
    """

    def __init__(self, force: bool = FORCE):
        self.force = force
        self.motion = 0.0
        self._sig: np.ndarray | None = None
        self._bbox = None
        self._last_motion = 0.0

    def invalidate(self) -> None:
        """形状/尺寸变了：旧签名和旧背景都不能再用。"""
        self._sig = None
        self._bbox = None
        self._last_motion = 0.0
        self.motion = 0.0

    def observe(self, small_rgb: np.ndarray, box, now: float | None = None):
        """`small_rgb` 是未模糊的 1/4 采样图。返回 `(moved, stale)`。"""
        now = time.perf_counter() if now is None else now
        sig = small_rgb[::SIG_STEP, ::SIG_STEP].astype(np.int16).mean(axis=2)
        moved = False
        if self._bbox is not None and box != self._bbox:
            moved = True
        elif self._sig is not None and sig.shape == self._sig.shape:
            d = np.abs(sig - self._sig)
            moved = bool(float(d.mean()) > MOVE_MEAN or float(d.max()) > MOVE_MAX)
        if moved:
            self._last_motion = now
            self.motion = min(1.0, self.motion * 0.50 + 0.50)
        else:
            self.motion *= 0.55
        stale = (not self.force and not moved and box == self._bbox
                 and now - self._last_motion > STALE_AFTER)
        self._sig = sig
        self._bbox = box
        return moved, stale

    @property
    def blend(self) -> float:
        """移动帧混上一帧的强度；停下后立刻归零，不留残影。"""
        return 0.35 * max(0.0, min(1.0, self.motion))


@dataclass(slots=True)
class Shot:
    """一次抓屏的结果。CPU 用 `rgb`，GPU 用 `bgra`，避免重复抓。"""

    shot: object            # mss 的 ScreenShot
    box: tuple              # 屏幕坐标 (gl, gt, gr, gb)
    offset: tuple           # 窗口左上角在抓屏图里的 1/4 分辨率坐标


class CaptureSource:
    """按窗口矩形抓背景，外扩 PAD 供边缘透镜取「框外」的像素。"""

    def __init__(self, screen: tuple[int, int], pad: int = PAD, cappable: bool = False,
                 solid: bool = False, bounds: tuple | None = None):
        self.screen = screen
        self.pad = pad
        self.cappable = cappable
        # solid：远程/录屏下 WDA 会让整窗在对面消失；不抓屏，用纯色底板
        # 仍然走同一条渲染管线，文字和气泡都还在，只是背后不透明。
        self.solid = solid
        # bounds = 虚拟桌面 (x, y, w, h)。第二块屏在主屏左边时坐标是负的，
        # 只拿主屏当边界会算出 gr <= gl，玻璃永远停在旧帧（#8）。
        self.bounds = bounds

    def _clamp_box(self, l: int, t: int, r: int, b: int) -> tuple[int, int, int, int]:
        """抓屏外扩 + 钳位。窗口整个在主屏里时仍按主屏钳（与旧行为逐像素一致）。"""
        sw, sh = self.screen
        if 0 <= l and 0 <= t and r <= sw and b <= sh:
            bl, bt, br, bb = 0, 0, sw, sh
        elif self.bounds and self.bounds[2] > 0 and self.bounds[3] > 0:
            bx, by, bw, bh = self.bounds
            bl, bt, br, bb = bx, by, bx + bw, by + bh
        else:
            bl, bt, br, bb = 0, 0, sw, sh
        return (max(bl, l - self.pad), max(bt, t - self.pad),
                min(br, r + self.pad), min(bb, b + self.pad))

    def grab(self, sct, bbox) -> Shot | None:
        l, t, r, b = (int(v) for v in bbox)
        if r <= l or b <= t:
            return None
        gl, gt, gr, gb = self._clamp_box(l, t, r, b)
        # 多显示器 / DPI 变化 / 被别的程序挪出屏幕时，钳位后宽高可能 <= 0；
        # mss 会抛 "Region has zero or negative size"，而 _work() 会每帧吞掉它
        # —— 表现就是日志刷屏、背景永久停在旧帧。没有可抓的区域就别抓。
        if gr - gl <= 0 or gb - gt <= 0:
            return None
        offset = (int(round((l - gl) / LPF)), int(round((t - gt) / LPF)))
        if self.solid:
            # 不碰 mss：远程桌面/锁屏/独占全屏下 BitBlt 也可能失败，
            # 而纯色底板在这些环境里都能正常显示（更不会触发 WDA 的问题）。
            return Shot(shot=_solid_shot(gr - gl, gb - gt), box=(gl, gt, gr, gb),
                        offset=offset)
        try:
            shot = sct.grab({"left": gl, "top": gt, "width": gr - gl, "height": gb - gt})
        except Exception as exc:
            # **抓不到就别把窗变成一块透明玻璃。**
            # BitBlt 会在几种场景下失败：桌面锁屏 / UAC 安全桌面 / 远程桌面 /
            # 某些 HDR 或全屏独占的机器。以前这里直接把异常抛给 `_work()`，
            # 于是每帧一条 "capture error"、一帧都画不出来 —— 用户看到的是
            # "背景变成透明的了，只剩字"（2026-11-03 社区反馈）。
            # 现在退成一块**纯色底板**：不好看，但字读得清、窗看得见。
            _warn_grab(exc)
            return Shot(shot=_solid_shot(gr - gl, gb - gt), box=(gl, gt, gr, gb),
                        offset=(int(round((l - gl) / LPF)), int(round((t - gt) / LPF))))
        return Shot(shot=shot, box=(gl, gt, gr, gb), offset=offset)

    def to_image(self, shot: Shot, bbox) -> Image.Image:
        """抓屏帧 → RGB 图；录屏模式下先把自己挖掉。"""
        im = Image.frombytes("RGB", shot.shot.size, shot.shot.rgb)
        if self.cappable and not self.solid:
            l, t, r, b = (int(v) for v in bbox)
            gl, gt = shot.box[0], shot.box[1]
            im = fill_own_rect(im, (l - gl, t - gt, r - gl, b - gt))
        return im

    def own_rect(self, shot: Shot, bbox) -> tuple[int, int, int, int]:
        gl, gt = shot.box[0], shot.box[1]
        l, t, r, b = bbox
        return (l - gl, t - gt, r - gl, b - gt)


def finish(geo: Geometry, panel: Image.Image) -> Image.Image:
    """贴二值圆角遮罩；缝隙/圆角外是 KEY，被 Tk 抠成透明。"""
    out = Image.new("RGB", (geo.width, geo.height), KEY)
    out.paste(panel.convert("RGB"), (0, 0), geo.mask_hard)
    return out


def paste_mic(geo: Geometry, im: Image.Image) -> Image.Image:
    """麦克风图标贴进玻璃帧，按背后亮度选浅/深两版（和仓库原做法一致）。"""
    x, y = geo.mic_pos
    box = im.crop((x, y, x + MIC_SIZE, y + MIC_SIZE)).convert("L")
    bg = float(np.median(np.asarray(box))) / 255.0
    out = im.convert("RGBA")
    icon = MIC_LIGHT if bg < 0.48 else MIC_DARK
    out.paste(icon, (x, y), icon)
    return out.convert("RGB")


__all__ = [
    "CaptureSource", "FORCE", "MIC_DARK", "MIC_LIGHT", "MotionTracker", "Shot",
    "fill_own_rect", "finish", "paste_mic", "resample",
]
