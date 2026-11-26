"""ocr_sidecar.py — 血条数字识别（Windows.Media.Ocr），一次一帧，JSON 一行回。

## 为什么单独一个 sidecar

`wgc_capture.py` 的职责是把**像素**送到 Node（比例在 Node 里算，纯函数好测）。
数字识别要在 Python 里跑，因为 WinRT 只有 Python / .NET 有绑定；把它塞进采集进程会让
「采集挂了」和「OCR 挂了」分不开。所以：采集照旧，OCR 另起一条，帧从 Node 转过来。

## 协议（stdin/stdout，二进制 + JSON 行）

- 启动参数把帧尺寸定死：`--w 421 --h 16`（region 变了一起重起）。
- Node 每写 `w*h*4` 字节（**BGRA**，与采集链路同一种字节序），这里回**一行 JSON**：
  `{"text":"2798 / 17638","cur":2798,"max":17638,"ms":52}`；
  读不出数字时 `cur`/`max` 为 null，`text` 仍然是认出来的原文（便于判断是"没数字"还是"没识别"）。
- 任何一帧失败都回一行 `{"error":"…"}`，进程不退（一帧糊了不该让整条路停）。
- 启动失败（缺 winrt / 没有中文识别器）直接 stderr 打原因 + 退出码 2。

## 预处理（2026-11-16 实测出来的，别改回去）

16px 高的血条条带**直接放大 2/4/6/8 倍都是 0 行**；关键是**画布高度**：
4× Lanczos 放大后贴进高 ≥240px 的黑底画布，Windows OCR 才稳定出字。
3× 会丢一位数，6× 带噪声。数字是白字压在暗底上，所以**不用反色**。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time

import numpy
from PIL import Image, ImageFilter

# 数字对：允许空格、全角斜杠、千分位逗号 —— OCR 的原文长这样：「2798 / 17638」
_PAIR = re.compile(r"(\d[\d,]*)\s*[/\uFF0F|]\s*(\d[\d,]*)")
_DIGITS = re.compile(r"^\d[\d,]*$")


def parse_hp(text: str):
    """从 OCR 原文里挑出 (当前, 最大)；挑不出返回 (None, None)。

    多个候选时取**第一个合法的**（当前 ≤ 最大、都 > 0）：血条的数字总是成对出现，
    而 `Lv.90`、装饰环之类的碎字不会凑成一对。
    """
    if not text:
        return None, None
    for m in _PAIR.finditer(text):
        try:
            cur = int(m.group(1).replace(",", ""))
            mx = int(m.group(2).replace(",", ""))
        except ValueError:
            continue
        if cur > 0 and mx > 0 and cur <= mx:
            return cur, mx
    return None, None


def _to_bgra(rgb: numpy.ndarray, scale: int, canvas_h: int, pad: int = 60,
             sharp: tuple[float, int] | None = None) -> numpy.ndarray:
    """**RGB**（不是 BGRA）→ 放大的画布 → BGRA（给 SoftwareBitmap）。

    **左右也要留白**（2026-11-16 真机踩到）：画布宽度原来正好等于条宽，数字紧贴
    crop 边界时 OCR 会吃掉首尾字符（`2798/17638` 读成 `98/1763`，于是被当成 6% 报出去）。
    上下留白是给行检测的，左右留白是给首尾字符的 —— 两者都别省。

    `sharp`：放大后做一次 UnsharpMask（`(radius, percent)`）。10px 高的字放大到 40px
    时边缘是软的，锐化能把"4"和"7"这种挤在一起的笔画分开 —— 实测能把 36% 那帧的
    `4177/16100` 救回来。
    """
    im = Image.fromarray(rgb, "RGB")
    big = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
    if sharp:
        big = big.filter(ImageFilter.UnsharpMask(radius=sharp[0], percent=sharp[1], threshold=2))
    ch = max(canvas_h, big.height + 40)
    canvas = Image.new("RGB", (big.width + pad * 2, ch), (0, 0, 0))
    canvas.paste(big, (pad, (ch - big.height) // 2))
    out = numpy.asarray(canvas)
    bgra = numpy.dstack([
        out[:, :, 2], out[:, :, 1], out[:, :, 0],
        numpy.full(out.shape[:2], 255, dtype=numpy.uint8),
    ])
    return numpy.ascontiguousarray(bgra, dtype=numpy.uint8)


def candidates(arr_bgra: numpy.ndarray):
    """同一帧的几种极性，按**先便宜后贵**的顺序给。

    为什么需要：血条数字的极性会随血量翻转（2026-11-16 实测）——
    数字压在暗底上时是**白字**（原图就认得出）；压在亮条上时是**深色描边字**（要反色）；
    挤在一起时锐化能分开笔画。用一种极性必然丢掉另一种。

    `plain` 命中率最高（低血那段），只有它没认出数字时才轮到后面的。
    每多试一种约多 15–80ms，1 fps 下无所谓 —— 比认错数字便宜。
    """
    small = numpy.ascontiguousarray(arr_bgra[:, :, [2, 1, 0]])          # BGRA→RGB
    yield "plain", small, None
    yield "sharp", small, (2, 150)                                       # 笔画挤在一起
    yield "invert", 255 - small, None                                    # 深字压亮条


class Ocr:
    """懒加载 WinRT：没装 winrt 时给一句人话，而不是 ImportError 堆栈。"""

    def __init__(self, lang: str):
        self.lang = lang
        self.engine = None

    def ready(self) -> None:
        if self.engine is not None:
            return
        from winrt.windows.globalization import Language  # noqa: PLC0415
        from winrt.windows.media.ocr import OcrEngine  # noqa: PLC0415

        eng = OcrEngine.try_create_from_language(Language(self.lang))
        if eng is None:
            langs = [str(x.language_tag) for x in (OcrEngine.available_recognizer_languages or [])]
            raise SystemExit(f"OCR: 没有 {self.lang} 识别器（已装：{', '.join(langs) or '无'}）")
        self.engine = eng
        print(f"ocr ready lang={self.lang}", file=sys.stderr, flush=True)

    async def recognize(self, bgra: numpy.ndarray) -> dict:
        from winrt.windows.graphics.imaging import (  # noqa: PLC0415
            BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap,
        )
        from winrt.windows.storage.streams import Buffer  # noqa: PLC0415

        self.ready()
        h, w = bgra.shape[0], bgra.shape[1]
        t0 = time.perf_counter()
        buf = Buffer(w * h * 4)
        buf.length = w * h * 4
        memoryview(buf)[:] = bgra.tobytes()
        sb = SoftwareBitmap.create_copy_from_buffer(
            buf, BitmapPixelFormat.BGRA8, w, h, BitmapAlphaMode.IGNORE,
        )
        res = await self.engine.recognize_async(sb)
        text = " ".join(str(line.text) for line in res.lines)
        cur, mx = parse_hp(text)
        return {
            "text": text,
            # 逐行原文：`text` 把行拼成一行了，字幕要的是**一行一个事件**。
            # 血条那条链不读它（多一个字段不影响），条带那一边按行入闸门。
            "lines": [str(line.text) for line in res.lines],
            "cur": cur,
            "max": mx,
            "ms": int((time.perf_counter() - t0) * 1000),
        }

    async def recognize_any(
        self, arr_bgra: numpy.ndarray, scale: int, canvas_h: int, pad: int = 60,
    ) -> dict:
        """同一帧试几种极性，**认出数字就停**；全都不行就把最后一次的原文交出去。

        返回里带 `pre`（哪种极性认出来的）：排障时一眼能看出"这次是反色救的"
        还是"一直没认出来"。全失败时 `cur/max` 是 None —— 调用方退回比例，不编。
        """
        first = None
        t_all = time.perf_counter()
        for name, rgb, sharp in candidates(arr_bgra):
            try:
                out = await self.recognize(_to_bgra(rgb, scale, canvas_h, pad, sharp))
            except Exception as e:  # noqa: BLE001
                out = {"text": "", "cur": None, "max": None, "ms": 0, "error": f"{type(e).__name__}: {e}"}
            out["pre"] = name
            out["total_ms"] = int((time.perf_counter() - t_all) * 1000)
            if first is None:
                first = out
            if out.get("cur") and out.get("max"):
                return out
        return first or {"text": "", "cur": None, "max": None, "ms": 0, "pre": None}


def _read_exact(stream, n: int) -> bytes | None:
    """读满 n 字节；EOF 时返回 None（别把半帧当帧）。"""
    chunks = []
    got = 0
    while got < n:
        chunk = stream.read(n - got)
        if not chunk:
            return None
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def main() -> int:
    # 重定向到管道时 Windows 的 stdout/stderr 会按 locale（cp936）编码，
    # Node 那头按 utf8 解就会乱码。这里钉死 utf8：JSON 里的中文原文才不被打碎。
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--w", type=int, required=True)
    ap.add_argument("--h", type=int, required=True)
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("--canvas-h", type=int, default=240)
    ap.add_argument("--lang", default="zh-Hans-CN")
    # bars = 血条数字（多极性试到认出数字为止，默认）；text = 字幕条带（只跑一遍 plain，
    # 按行返回）。**默认值不变**，血条那条链一行不改。
    ap.add_argument("--mode", choices=("bars", "text"), default="bars")
    args = ap.parse_args()

    if args.w <= 0 or args.h <= 0:
        print("ERR w/h 必须是正数", file=sys.stderr)
        return 2
    if args.scale < 2:
        print("ERR scale 至少 2（1 时 Windows OCR 读不出 16px 的字）", file=sys.stderr)
        return 2

    ocr = Ocr(args.lang)
    try:
        ocr.ready()
    except Exception as e:  # noqa: BLE001
        print(f"ERR OCR 起不来：{type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return 2

    stdin = sys.stdin.buffer
    frame_bytes = args.w * args.h * 4
    while True:
        raw = _read_exact(stdin, frame_bytes)
        if raw is None:
            print("done", file=sys.stderr, flush=True)
            return 0
        arr = numpy.frombuffer(raw, dtype=numpy.uint8).reshape(args.h, args.w, 4)
        try:
            if args.mode == "text":
                # 字幕只跑一遍 plain：反色那几种是给"深字压亮条"的数字准备的，
                # 字幕带上试反色只会把黑底白字变成白底黑字再认一遍（白付 15–80ms）。
                rgb = numpy.ascontiguousarray(arr[:, :, [2, 1, 0]])
                pad = max(16, min(60, round(args.scale * 8)))
                out = asyncio.run(ocr.recognize(_to_bgra(rgb, args.scale, args.canvas_h, pad)))
            else:
                out = asyncio.run(ocr.recognize_any(arr, args.scale, args.canvas_h))
        except Exception as e:  # noqa: BLE001
            out = {"error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
