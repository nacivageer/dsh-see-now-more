"""wgc_capture.py — 按窗口抓画面，输出 BGRA rawvideo 到 stdout。

为什么不用 ffmpeg：ffmpeg 的 ddagrab/gdigrab 抓的是**屏幕**，窗口被挡住就只剩挡住它的东西。
Windows Graphics Capture 抓的是**窗口自己的表面**，被遮挡照样有，且不注入游戏进程。

用法（由 `src/capture-window.js` 拉起，不给人直接用）：

    python.exe py/wgc_capture.py --title "<窗口标题里的一段>" --fps 1 --region 2261,1525,421,16

参数：
  --title     窗口标题子串（EnumWindows 匹配，取第一个可见的）
  --hwnd      直接给窗口句柄（优先于 --title）
  --fps       输出帧率上限（WGC 按窗口刷新率给帧，这里丢帧到 fps）
  --region    `x,y,w,h`，**屏幕物理像素**；给了就只输出这一块
  --size      强制输出尺寸 `WxH`（给了就缩放到这个尺寸；不传则 region/整窗原尺寸）
  --check     只探一次：打印一行 JSON（hwnd / title / minimized / rect）就退出，不建会话

输出：每帧 `width*height*4` 字节、通道序 BGRA（与 gdigrab 的 bgr0 一致），
      尺寸由第一行 JSON 头给一次：`{"w":…,"h":…}`。
      **读的一方必须先读这一行**，否则会把头当成像素。

退出码：0 正常；1 采集中出错；2 参数错；3 找不到窗口；4 窗口最小化（没有可抓的帧）；
      5 `--check` 成功但窗口不可抓（最小化）。

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
import threading
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


def is_minimized(hwnd: int) -> bool:
    """最小化 = 窗口停止渲染 → WGC 拿不到帧。**先说清楚，不要去等超时。**"""
    return bool(user32.IsIconic(ctypes.c_void_p(hwnd)))


def resize_box(buf: numpy.ndarray, ow: int, oh: int) -> numpy.ndarray:
    """
    缩放到 `ow×oh`，优先用 PIL（C 实现）：**面积平均（BOX）保灰度，最近邻只做前置降倍**。

    两处实测（2026-11-17，4K 源 3840×2160 → 798×450）：
      - `frombytes` 每帧 130ms，`frombuffer` 65ms —— 前者多一次整帧拷贝，换成 frombuffer；
      - 直接 BOX 到目标 181ms（源像素越多越贵），**先最近邻到 2× 目标再 BOX** 只要 95ms，
        亮度均值几乎一样（69.9 vs 70.3），所以大倍率（≥3×）走两步。

    这两条把 4K 源的吐帧能力从 ~5fps 拉回 ~10fps（1922×1126 那种 2.4× 仍是一步 BOX）。
    没装 Pillow 时退回 `resize_area`（正确但慢）。
    """
    if (buf.shape[1], buf.shape[0]) == (ow, oh):
        return buf
    try:
        from PIL import Image
    except Exception:  # noqa: BLE001 —— 没装 Pillow 不是错误，只是慢
        return resize_area(buf, ow, oh)
    src = numpy.ascontiguousarray(buf)
    img = Image.frombuffer("RGBA", (buf.shape[1], buf.shape[0]), src, "raw", "BGRA", 0, 1)
    if buf.shape[1] >= ow * 3 or buf.shape[0] >= oh * 3:
        # 大倍率：先最近邻压到 2× 目标，把 BOX 的输入像素数降到 1/4 以下
        img = img.resize((ow * 2, oh * 2), Image.NEAREST)
    out = numpy.asarray(img.resize((ow, oh), Image.BOX))
    # PIL 给的是 RGBA，下游要 BGRA（与 gdigrab 的 bgr0 一致）
    return numpy.ascontiguousarray(out[:, :, [2, 1, 0, 3]])


def resize_area(buf: numpy.ndarray, ow: int, oh: int) -> numpy.ndarray:
    """
    面积平均缩小（box filter），**不用最近邻**。

    最近邻在 3 倍缩小时会把字幕/文件名这类细笔画整段丢掉一列两列，读起来像换了个字体；
    面积平均至少保留了灰度。放大（目标比源大）没有面积可平均，退回最近邻。

    BGRA 四个通道一视同仁 —— alpha 本来是 255，平均之后还是 255。
    """
    h, w = buf.shape[0], buf.shape[1]
    if (w, h) == (ow, oh):
        return buf
    if ow >= w or oh >= h:
        ys = (numpy.arange(oh) * h // oh).clip(0, h - 1)
        xs = (numpy.arange(ow) * w // ow).clip(0, w - 1)
        return buf[ys][:, xs]
    iy = (numpy.arange(oh + 1) * h) // oh
    ix = (numpy.arange(ow + 1) * w) // ow
    work = buf.astype(numpy.float32)
    work = numpy.add.reduceat(work, iy[:-1], axis=0) / numpy.diff(iy)[:, None, None]
    work = numpy.add.reduceat(work, ix[:-1], axis=1) / numpy.diff(ix)[None, :, None]
    return work.astype(numpy.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", default=None)
    ap.add_argument("--hwnd", type=int, default=0)
    ap.add_argument("--fps", type=float, default=1.0)
    ap.add_argument("--region", default=None)
    ap.add_argument("--size", default=None)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--stats", action="store_true")
    # 测试钩子：建会话、正常跑，但**一帧都不吐**。用来验 runner 的「首帧超时 → 改抓屏幕」，
    # 不需要真独占全屏的 GPU 行为（那种窗口我们这儿没有）。
    ap.add_argument("--drop-frames", action="store_true")
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

    if args.check:
        rect = window_rect(hwnd)
        mini = is_minimized(hwnd)
        print(json.dumps({
            "ok": not mini,
            "hwnd": hwnd,
            "title": title,
            "minimized": mini,
            "rect": None if not rect else {"x": rect[0], "y": rect[1], "w": rect[2], "h": rect[3]},
        }), flush=True)
        return 5 if mini else 0

    # 最小化：窗口停止渲染，起会话也是等到超时 —— 直接说清楚，别让调用方去猜
    if is_minimized(hwnd):
        print("ERR minimized", file=sys.stderr)
        return 4

    interval = 1.0 / max(0.1, args.fps)
    state = {"sent": 0, "t0": time.time(), "header": False, "stop": False, "calls": 0}
    latest = {"out": None, "at": 0.0}

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
        # **在回调里就把这一帧处理完**（裁剪 + 缩放），只留缩好的小图给发射线程。
        #
        # 以前是把整帧 copy 一份交给发射线程 —— 4K 源一帧 33MB，10 次/秒就是 330MB/s 的
        # memcpy，还是拿着 GIL 的；实测把吐帧能力从 ~10fps 压到 ~7fps。现在不在回调里
        # 留缓冲引用（`frame_buffer` 会被复用），但也不复制整帧：PIL 直接读它。
        now = time.monotonic()
        state["calls"] += 1
        if now - latest["at"] < interval * 0.9:
            return
        latest["at"] = now
        try:
            out = prepare(numpy.asarray(frame.frame_buffer))
        except Exception as e:  # noqa: BLE001
            print(f"ERR prepare: {type(e).__name__}: {e}", file=sys.stderr)
            return
        if out is not None:
            latest["out"] = out

    def prepare(buf):
        """裁剪 + 缩放到输出尺寸。返回 None = 这一拍不该输出任何东西。"""
        fh, fw = buf.shape[0], buf.shape[1]
        if region:
            rect = window_rect(hwnd)
            if not rect:
                return None
            wx, wy, ww, wh = rect
            x, y, w, h = region
            # 屏幕坐标 → 窗口内坐标；窗口动了也跟着动
            x0, y0 = x - wx, y - wy
            x1, y1 = x0 + w, y0 + h
            # 越界部分裁掉（窗口挪出屏幕时不要造黑帧，直接不输出）
            cx0, cy0 = max(0, x0), max(0, y0)
            cx1, cy1 = min(fw, x1), min(fh, y1)
            if cx1 - cx0 < w * 0.5 or cy1 - cy0 < h * 0.5:
                return None
            crop = buf[cy0:cy1, cx0:cx1, :]
            if (cx1 - cx0, cy1 - cy0) != (w, h):
                # 贴边裁掉了一部分：补黑到 region 大小，保持帧尺寸恒定
                canvas = numpy.zeros((h, w, 4), dtype=numpy.uint8)
                canvas[: cy1 - cy0, : cx1 - cx0, :] = crop
                crop = canvas
            buf = crop

        if out_size and (buf.shape[1], buf.shape[0]) != out_size:
            # watch 那条路用面积平均（PIL 的 BOX）：细笔画缩小后还得认得出字
            buf = resize_box(buf, out_size[0], out_size[1])
        return buf

    def emit_loop() -> None:
        """
        定频发射：每 `interval` 秒输出一帧（窗口没更新就重复上一帧）。

        为什么必须这样：管线的背压和时间轴都按 `t = i / fps` 算，输出频率必须等于 fps。
        画面没变时重复的是同一张图，变化分算下来接近 0 —— 正好是"没变"该有的样子。
        """
        next_at = time.monotonic()
        while not state["stop"]:
            # **按截止时间排，不是"干完再睡 interval"**：
            # 缩放本身要几十毫秒，睡满 interval 再加干活 = 实际帧率掉一档（实测 12 → 4）。
            next_at += interval
            delay = next_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                next_at = time.monotonic()
            out = latest["out"]
            if out is None:
                continue
            if args.drop_frames:
                continue
            header(out.shape[1], out.shape[0])
            emit(out)
            if args.stats and state["sent"] % max(1, int(args.fps)) == 0:
                # **两个数要分开看**：emitted 是侧车吐帧的频率（含重复帧），
                # calls 才是窗口自己更新了几次 —— 测"游戏卡不卡"只看后者。
                print(f"stats emitted={state['sent']} calls={state['calls']} "
                      f"t={time.time() - state['t0']:.1f}", file=sys.stderr, flush=True)

    def on_closed():
        state["stop"] = True
        print("closed", file=sys.stderr)
        sys.stdout.buffer.flush()

    cap = WindowsCapture(window_hwnd=hwnd)
    cap.event(on_frame_arrived)
    cap.event(on_closed)
    threading.Thread(target=emit_loop, daemon=True).start()
    try:
        cap.start()
    except Exception as e:  # noqa: BLE001
        state["stop"] = True
        print(f"ERR {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    state["stop"] = True
    print(f"done sent={state['sent']} in {time.time() - state['t0']:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
