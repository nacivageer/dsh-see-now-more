# -*- coding: utf-8 -*-
"""check-history-scroll.py — 回顾列表滚动的三条契约（2026-11-27，`.45` 待发）。

为什么要有它：格报「列表内容多了，滚动卡手」。量出来两件事：
  ① 每滚一格整页重画，而重画前要同时问 `_history_sessions()` 和 `_chat_sessions()`，
     两个函数各自把 `chat.jsonl`（真机 1.7 MB / 2236 行）整份 `json.loads` 一遍 ——
     各 47 ms，一滚近百毫秒；
  ② 滚轮只看 `e.delta` 的方向、固定走 70px，精密触控板发的小 delta 也被当成一整格。

验三条（都靠计数，不靠计时 —— 计时在别人的机器上没有判据力）：
  1. 解析只做一次：同一个文件，连问三次 `_history_sessions()`，`chat.jsonl` 只许被读一次；
  2. 缓存会失效：文件追加新会话后，新 sid 得出现（按 mtime + size 判变更）；
  3. 滚轮按 delta 大小走、余量累加、撞到边界丢余量；连发多次只排一次重画。

计时只作为输出信息（冷 / 热各一次），不做断言。

不读写 `~/.dsh`（`DSH_VIDEO_CACHE_DIR` 指临时目录、`chat.jsonl` 自己造），不建 Tk 窗口。

跑法：python scripts/check-history-scroll.py   （exit 0 = 全过）
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def build_chat(path, groups=120, per_group=30):
    rows = []
    for i in range(groups):
        sid = "session-%08d-0000-0000-000000000000" % i
        for j in range(per_group):
            rows.append(json.dumps({"sid": sid, "at": 1700000000000 + i * 10_000 + j,
                                    "role": "user", "text": "x" * 300},
                                   ensure_ascii=False))
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")


class CountingPath:
    """包一层 `CHAT_FILE`：数它被 `read_text()` 读了几次。"""

    def __init__(self, real):
        self._real = real
        self.reads = 0

    def stat(self):
        return self._real.stat()

    def read_text(self, *a, **k):
        self.reads += 1
        return self._real.read_text(*a, **k)


def make_glass():
    from window import LiveGlass
    w = object.__new__(LiveGlass)
    w._bound_full = "session-0000000000000000-nope"
    w._hidden = set()
    return w


def test_parse_only_once(tmp):
    import window as W

    real = W.CHAT_FILE
    counter = CountingPath(real)
    W.CHAT_FILE = counter
    try:
        w = make_glass()
        t0 = time.perf_counter()
        cold = w._history_sessions()
        cold_ms = (time.perf_counter() - t0) * 1000.0

        warm_ms = []
        again = cold
        for _ in range(3):
            t0 = time.perf_counter()
            again = w._history_sessions()
            warm_ms.append((time.perf_counter() - t0) * 1000.0)

        assert len(cold) == 120, "合成数据应有 120 组，实际 %d" % len(cold)
        assert again == cold, "缓存命中的结果和第一次不一致（缓存存错了东西）"
        assert counter.reads == 1, (
            "连问 4 次 `_history_sessions()` 把 chat.jsonl 读了 %d 次；"
            "第二次起必须走缓存（真机 1.7 MB，每次约 47 ms）" % counter.reads)
        return cold_ms, min(warm_ms)
    finally:
        W.CHAT_FILE = real


def test_cache_invalidates(tmp):
    """文件变了（新消息 / 新会话）必须重新解析，否则列表会永远停在旧内容。"""
    w = make_glass()
    before = {g["sid"] for g in w._history_sessions()}
    chat = tmp / "chat.jsonl"
    with chat.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"sid": "session-newone-0000-0000-000000000000",
                            "at": 1800000000000, "role": "user", "text": "hi"},
                           ensure_ascii=False) + "\n")
    after = {g["sid"] for g in w._history_sessions()}
    assert "session-newone-0000-0000-000000000000" in after, (
        "追加新会话后列表没变（缓存没失效）：%r" % (after - before,))


class FakeCanvas:
    def __init__(self):
        self.afters = []

    def after(self, ms, fn):
        self.afters.append((ms, fn))


def test_wheel_math():
    """120 = 一格 70px；小 delta 按比例并累加余量；顶到头时丢余量、不回弹。"""
    w = make_glass()
    w._hist_redraw = lambda: None
    c = FakeCanvas()
    w._hist = {"max": 1000, "scroll": 500, "canvas": c}

    def wheel(delta):
        w._hist_wheel(SimpleNamespace(delta=delta))

    wheel(120)                                  # 往上一格（delta > 0 → scroll 减小）
    assert w._hist["scroll"] == 430, w._hist["scroll"]
    wheel(-120)
    assert w._hist["scroll"] == 500, w._hist["scroll"]
    # 两次共用一个待执行的重画（合并），跑完那一拍 pending 才清掉
    assert len(c.afters) == 1, c.afters
    c.afters[0][1]()
    assert w._hist["wheel_pending"] is False

    # 精密触控板：30 的小 delta，两次合起来走 35px（不是两次 70）
    base = w._hist["scroll"]
    wheel(30)
    wheel(30)
    assert w._hist["scroll"] == base - 35, (
        "小 delta 应累加（-17.5 × 2），实际 %d（base %d）" % (w._hist["scroll"], base))

    # 顶到头：留在 0，并把余量清掉，往回滚立刻动
    w._hist["scroll"] = 10
    wheel(120)
    assert w._hist["scroll"] == 0, w._hist["scroll"]
    assert not w._hist.get("wheel_acc"), "撞边界后余量没清（往回滚会先空走几格）"
    wheel(-120)
    assert w._hist["scroll"] == 70, w._hist["scroll"]


def test_wheel_coalesces():
    """连发多个滚轮事件只排一次重画（偏移照样逐个累加，画面停在最终位置）。"""
    w = make_glass()
    redraws = []
    w._hist_redraw = lambda: redraws.append(1)
    c = FakeCanvas()
    w._hist = {"max": 5000, "scroll": 1000, "canvas": c}

    for _ in range(5):
        w._hist_wheel(SimpleNamespace(delta=-120))    # 往下五格
    assert w._hist["scroll"] == 1350, w._hist["scroll"]
    assert len(c.afters) == 1, "五连滚排了 %d 次重画（应该合并成 1 次）" % len(c.afters)
    assert w._hist["wheel_pending"] is True
    _ms, fn = c.afters[0]
    fn()
    assert redraws == [1], redraws
    assert w._hist["wheel_pending"] is False
    # 合并的那一拍之后再滚，能重新排下一拍
    w._hist_wheel(SimpleNamespace(delta=-120))
    assert len(c.afters) == 2, c.afters


def main():
    with tempfile.TemporaryDirectory(prefix="seenow-histscroll-") as td:
        tmp = Path(td)
        os.environ["DSH_VIDEO_CACHE_DIR"] = str(tmp)
        # `window.py` 的 CHAT_FILE 在 import 时就定了，所以 env 必须先设
        sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))
        build_chat(tmp / "chat.jsonl")
        cold_ms, warm_ms = test_parse_only_once(tmp)
        test_cache_invalidates(tmp)
        test_wheel_math()
        test_wheel_coalesces()
    print("check-history-scroll: all passed (chat.jsonl 只读 1 次；冷 %.1f ms → 热 %.1f ms)"
          % (cold_ms, warm_ms))
    return 0


if __name__ == "__main__":
    sys.exit(main())
