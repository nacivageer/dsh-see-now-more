"""wgc_capture.py — 按窗口抓画面，输出 BGRA rawvideo 到 stdout。

为什么不用 ffmpeg：ffmpeg 的 ddagrab/gdigrab 抓的是**屏幕**，窗口被挡住就只剩挡住它的东西。
Windows Graphics Capture 抓的是**窗口自己的表面**，被遮挡照样有，且不注入游戏进程。

用法（由 `src/capture-window.js` 拉起，不给人直接用）：

    python.exe py/wgc_capture.py --title "云·鸣潮" --fps 1 --region 2261,1525,421,16

参数：
  --title     窗口标题子串（EnumWindows 匹配，取第一个可见的）
  --hwnd      直接给窗口句柄（优先于 --title）
  --fps       输出帧率上限（WGC 按窗口刷新率给帧，这里丢帧到 fps）
  --region    `x,y,w,h`，**屏幕物理像素**；给了就只输出这一块
  --size      强制输出尺寸 `WxH`（给了就缩放到这个尺寸；不传则 region/整窗原尺寸）

输出：每帧 `width*height*4` 字节、通道序 BGRA（与 gdigrab 的 bgr0 一致），
      尺寸由第一行 JSON 头给一次：`{"w":…,"h":…}`。
      **读的一方必须先读这一行**，否则会把头当成像素。

约束：
  - 只认**非最小化**的窗口。最小化后窗口停止渲染，WGC 拿不到帧（会超时）。
  - D3D 独占全屏抓不到，要无边框窗口；独占全屏时改用 ddagrab 全屏抓。
  - 窗口被移动/缩放时按当前 rect 重算裁剪，不需要重启。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import sys
import time
import types

import numpy

# windows_capture 的 __init__ 会 import cv2（只为 imwrite），这里塞一个 stub，
# 免得为一个编码器拖 40 MB 的 opencv 进来。
_stub = types.ModuleType("cv2")
_stub.imwrite = lambda *a, **k: False
sys.modules.setdefault("cv2", _stub)

from windows_capture import WindowsCapture  # noqa: E402

user32 = ctypes.windll.user32


def _enum_windows(substr: str):
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if substr in buf.value:
            found.append((int(hwnd), buf.value))
            return False
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else (None, None)


def window_rect(hwnd: int):
    """窗口的屏幕矩形（x, y, w, h）。用 DWM 的扩展边框更贴合实际可见范围。"""
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    r = RECT()
    try:
        # DWMWA_EXTENDED_FRAME_BOUNDS = 9：去掉投影/透明边
        dwm = ctypes.windll.dwmapi
        hr = dwm.DwmGetWindowAttribute(ctypes.c_void_p(hwnd), 9, ctypes.byref(r), ctypes.sizeof(r))
        if hr != 0:
            raise OSError(hr)
    except Exception:  # noqa: BLE001
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(r)):
            return None
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def parse_region(text: str):
    parts = [int(p) for p in text.replace(" ", "").split(",")]
    if len(parts) != 4 or parts[2] <= 0 or parts[3] <= 0:
        raise ValueError(f"region 要 x,y,w,h：{text}")
    return parts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", default=None)
    ap.add_argument("--hwnd", type=int, default=0)
    ap.add_argument("--fps", type=float, default=1.0)
    ap.add_argument("--region", default=None)
    ap.add_argument("--size", default=None)
    args = ap.parse_args()

    hwnd = args.hwnd
    if not hwnd:
        if not args.title:
            print("ERR 需要 --title 或 --hwnd", file=sys.stderr)
            return 2
        hwnd, title = _enum_windows(args.title)
        if not hwnd:
            print(f"ERR 找不到窗口：{args.title}", file=sys.stderr)
            return 3
        print(f"window hwnd={hwnd} title={title}", file=sys.stderr)
    else:
        title = None

    region = parse_region(args.region) if args.region else None
    out_size = None
    if args.size:
        w, h = args.size.lower().split("x")
        out_size = (int(w), int(h))

    interval = 1.0 / max(0.1, args.fps)
    state = {"last": 0.0, "sent": 0, "t0": time.time(), "header": False}

    def emit(arr: numpy.ndarray) -> None:
        sys.stdout.buffer.write(numpy.ascontiguousarray(arr).tobytes())
        sys.stdout.buffer.flush()
        state["sent"] += 1

    def header(w: int, h: int) -> None:
        if state["header"]:
            return
        state["header"] = True
        # 给了 --region / --size 时输出尺寸是可预测的（调用方自己知道），不写头，
        # 免得每个读帧的人都得先解析一行 JSON；只有整窗且没指定尺寸时才必须写。
        if region or out_size:
            return
        sys.stdout.write(json.dumps({"w": w, "h": h}) + "\n")
        sys.stdout.flush()

    def on_frame_arrived(frame, control):
        now = time.monotonic()
        if now - state["last"] < interval:
            return
        state["last"] = now
        buf = frame.frame_buffer            # (h, w, 4) BGRA
        fh, fw = buf.shape[0], buf.shape[1]

        if region:
            rect = window_rect(hwnd)
            if not rect:
                return
            wx, wy, ww, wh = rect
            x, y, w, h = region
            # 屏幕坐标 → 窗口内坐标；窗口动了也跟着动
            x0, y0 = x - wx, y - wy
            x1, y1 = x0 + w, y0 + h
            # 越界部分裁掉（窗口挪出屏幕时不要造黑帧，直接不输出）
            cx0, cy0 = max(0, x0), max(0, y0)
            cx1, cy1 = min(fw, x1), min(fh, y1)
            if cx1 - cx0 < w * 0.5 or cy1 - cy0 < h * 0.5:
                return
            crop = buf[cy0:cy1, cx0:cx1, :]
            if (cx1 - cx0, cy1 - cy0) != (w, h):
                # 贴边裁掉了一部分：补黑到 region 大小，保持帧尺寸恒定
                canvas = numpy.zeros((h, w, 4), dtype=numpy.uint8)
                canvas[: cy1 - cy0, : cx1 - cx0, :] = crop
                crop = canvas
            buf = crop

        if out_size and (buf.shape[1], buf.shape[0]) != out_size:
            # 最近邻缩放就够：血条那种小块不需要插值，watch 那条路不走这里
            ow, oh = out_size
            ys = (numpy.arange(oh) * buf.shape[0] // oh).clip(0, buf.shape[0] - 1)
            xs = (numpy.arange(ow) * buf.shape[1] // ow).clip(0, buf.shape[1] - 1)
            buf = buf[ys][:, xs]

        header(buf.shape[1], buf.shape[0])
        emit(buf)

    def on_closed():
        print("closed", file=sys.stderr)
        sys.stdout.buffer.flush()

    cap = WindowsCapture(window_hwnd=hwnd)
    cap.event(on_frame_arrived)
    cap.event(on_closed)
    try:
        cap.start()
    except Exception as e:  # noqa: BLE001
        print(f"ERR {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(f"done sent={state['sent']} in {time.time() - state['t0']:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
