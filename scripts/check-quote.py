# -*- coding: utf-8 -*-
"""check-quote.py — 无 GUI 验「引用选中文字」的编码 / chip 几何 / 发送拼装。

不创建 Tk 窗口：用 `object.__new__(Window)` 造一个没有 `__init__` 的壳，
塞假字体和假 Entry，直接调真实方法（和 watch-together 的 check-input-select.py 同一做法）。

跑法：python scripts/check-quote.py   （exit 0 = 全过）
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))

from quote_text import (  # noqa: E402
    format_quote_text, quote_preview, split_quote_blocks,
)
from window import LiveGlass as Window  # noqa: E402


class FakeFont:
    """每个字符 7px、行高 15px —— 只验几何关系，不验真实字宽。"""

    def measure(self, s):
        return len(str(s)) * 7

    def metrics(self, key):
        return 15 if key == "linespace" else 15


class FakeFonts:
    def get(self, size, bold=False):
        return FakeFont()


class FakeEntry:
    def __init__(self, text="", insert=0, selected=False):
        self.text = text
        self.insert = insert
        self.selected = selected

    def get(self):
        return self.text

    def index(self, which):
        return self.insert

    def selection_present(self):
        return self.selected

    def icursor(self, idx):
        self.insert = idx

    def selection_clear(self):
        pass


def test_format():
    assert format_quote_text("你好\n世界") == "> 你好\n> 世界"
    assert format_quote_text("  你好\r\n世界  ") == "> 你好\n> 世界"
    # 空行也照 DSH 的规则写成 "> "
    assert format_quote_text("a\n\nb") == "> a\n> \n> b"
    assert format_quote_text("") == ""
    # 引用文本里本来就有的 > 再套一层
    assert format_quote_text("> x") == "> > x"


def test_split():
    assert split_quote_blocks("> a\n> b\n\n正文") == [
        ("q", "a\nb"), ("text", "\n正文")]
    # 最多 3 个前导空格；4 个空格就不是引用行了
    assert split_quote_blocks("  > a\n    > b") == [
        ("q", "a"), ("text", "    > b")]
    # 空引用块丢弃
    assert split_quote_blocks("> \n>   \n正文") == [("text", "正文")]
    # 行内 > 不算
    assert split_quote_blocks("a > b") == [("text", "a > b")]
    # 引用中间夹着正文：两段都保留，顺序不变
    assert split_quote_blocks("> a\n正文\n> b") == [
        ("q", "a"), ("text", "正文"), ("q", "b")]


def test_preview():
    assert quote_preview("a\nb  c") == "a b c"
    long = "字" * 200
    got = quote_preview(long, limit=10)
    assert got == "字" * 10 + "…"


def test_chip_layout():
    w = object.__new__(Window)
    w.fonts = FakeFonts()
    w._draft_quote = {"text": "你好\n世界", "at": 0}
    chip = Window._quote_chip_layout(w, 100, 40, 500)
    x0, y0, x1, y1 = chip["rect"]
    assert x0 == 100 and y1 - y0 == Window.CHIP_H
    assert chip["text_x"] == x1 + 8, "正文从 chip 右边 8px 开始"
    assert chip["preview"] == "你好 世界", "预览把换行压成空格"
    assert x0 <= chip["close"][0] < chip["close"][1] <= x1, "× 的命中区间在 chip 内"
    assert chip["preview_x"] < chip["close"][0]

    # 窄窗：chip 至少 60px 宽，不能把正文挤没
    narrow = Window._quote_chip_layout(w, 100, 40, 60)
    assert 40 <= narrow["rect"][2] - narrow["rect"][0] <= 60.5
    assert narrow["text_x"] > narrow["rect"][2]

    # 超长引用：预览按像素截断，以 … 结尾
    w._draft_quote = {"text": "很长" * 2000, "at": 0}
    longchip = Window._quote_chip_layout(w, 100, 40, 500)
    assert longchip["preview"].endswith("…")
    assert longchip["rect"][2] - longchip["rect"][0] <= 260.5


def test_compose():
    w = object.__new__(Window)
    w._img_refs = {"[图片1]": "![图片](C:/tmp/1.png)"}
    w._draft_quote = {"text": "你好\n世界", "at": 0}
    assert Window._compose_send_text(w, "这句什么意思") == (
        "> 你好\n> 世界\n\n这句什么意思")
    # 只引用不打字
    assert Window._compose_send_text(w, "   ") == "> 你好\n> 世界"
    # 正文里的图片标记照常展开，引用原文不展开
    w._draft_quote = {"text": "[图片1]", "at": 0}
    assert Window._compose_send_text(w, "看[图片1]") == (
        "> [图片1]\n\n看![图片](C:/tmp/1.png)")
    # 没有引用：逐字不变
    w._draft_quote = None
    assert Window._compose_send_text(w, " 普通 ") == "普通"
    assert Window._compose_send_text(w, "[图片1]") == "![图片](C:/tmp/1.png)"


def test_parse_and_backspace():
    w = object.__new__(Window)
    blocks = Window._parse_blocks(w, "> 引文\n\n正文", quote_blocks=True)
    assert blocks[0] == ("q", "引文")
    assert ("text", "\n正文") in blocks
    # assistant 的 > 不动
    assert Window._parse_blocks(w, "> 引文", quote_blocks=False) == [("text", "> 引文")]

    w._draft_quote = {"text": "引文", "at": 0}
    w._entry = FakeEntry("正文", insert=0)
    w._render_input = lambda: None          # 不碰画布
    assert Window._input_backspace(w) == "break"
    assert w._draft_quote is None
    # 光标不在开头：交回 Entry 默认删除
    w._draft_quote = {"text": "引文", "at": 0}
    w._entry = FakeEntry("正文", insert=1)
    assert Window._input_backspace(w) is None
    assert w._draft_quote is not None
    # 有选区时也不抢
    w._entry = FakeEntry("正文", insert=0, selected=True)
    assert Window._input_backspace(w) is None


def test_quote_from_review():
    """P2：回顾窗点「引用选中文字」→ 关回顾窗、主窗前置、焦点进输入框。

    前置那一步走 `_raise_window()`（2026-11-27 加「保持置顶」后收敛到一处）：
    替掉 `_settings_cached`，两种档都验 —— 开着才进 topmost 带。
    """
    w = object.__new__(Window)
    calls = []

    class FakeRoot:
        def lift(self):
            calls.append("lift")

        def attributes(self, *a):
            calls.append(("attributes",) + a)

    w.root = FakeRoot()
    w._set_draft_quote = lambda text: calls.append(("quote", text))
    w._close_history = lambda: calls.append("close")
    w._focus_input = lambda _e=None: calls.append("focus")
    w._settings_cached = lambda: {"keepOnTop": True}

    Window._quote_choice(w, "回顾里选的", from_review=True)
    assert calls == [("quote", "回顾里选的"), "close",
                     ("attributes", "-topmost", True), "lift", "focus"]

    # 关掉保持置顶：只 lift，不许再焊回 topmost（否则开关一碰就失效）
    calls.clear()
    w._settings_cached = lambda: {"keepOnTop": False}
    Window._quote_choice(w, "回顾里选的", from_review=True)
    assert calls == [("quote", "回顾里选的"), "close", "lift", "focus"]

    # 主窗引用：只设 chip，不关窗、不动窗口
    calls.clear()
    Window._quote_choice(w, "主窗选的")
    assert calls == [("quote", "主窗选的")]


def main() -> int:
    for fn in (test_format, test_split, test_preview, test_chip_layout,
               test_compose, test_parse_and_backspace, test_quote_from_review):
        fn()
    print("ok: 引用编码 / chip 几何 / 发送拼装 / 退格删引用 / 回顾窗引用 全过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
