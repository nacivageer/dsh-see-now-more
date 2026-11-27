# -*- coding: utf-8 -*-
"""check-history-scroll.py — 回顾列表的读取契约（2026-11-27，`.46` 之后再做一版）。

为什么要有它：格报「列表内容多了，滚动卡手」。量出来两件事：
  ① 每滚一格整页重画，而重画前要同时问 `_history_sessions()` 和 `_chat_sessions()`，
     两个函数各自把 `chat.jsonl`（真机 1.7 MB / 2236 行）整份 `json.loads` 一遍 ——
     各 47 ms，一滚近百毫秒；`.45` 用 `(mtime, size)` 缓存整份解析结果挡掉「没变也读」，
     但文件一变（正常追加也算）还是整份重读；
  ② 滚轮只看 `e.delta` 的方向、固定走 70px，精密触控板发的小 delta 也被当成一整格。

验四条（都靠计数，不靠计时 —— 计时在别人的机器上没有判据力）：
  1. 没变就一次都不读：连问多次 `_history_sessions()`，只有第一次整份读；
  2. 追加只读尾巴：之后往文件尾追加 30 行，只许新增 30 行的字节与解析数 —— 这一条是
     `ChatLog` 的增量读，旧实现（按 `(mtime, size)` 缓存整份）在这里会整份重读；
  3. 换文件 / 截断 / 半行都认得出：`os.replace` 整份重写、原地写短、末尾半行；
     最后一行只有写完换行才纳入，且只出现一次；
  4. 滚轮按 delta 大小走、余量累加、撞到边界丢余量；连发多次只排一次重画。

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


def build_chat(path, groups=120, per_group=30, start=0):
    """造一份合成的 chat.jsonl；`i` 是全局行号，用来确认「裁到哪一行」。"""
    rows = []
    n = start
    for i in range(groups):
        sid = "session-%08d-0000-0000-000000000000" % i
        for j in range(per_group):
            rows.append(json.dumps({"i": n, "sid": sid, "at": 1700000000000 + i * 10_000 + j,
                                    "role": "user", "text": "x" * 300},
                                   ensure_ascii=False))
            n += 1
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return n


def append_rows(path, count, sid, start):
    """往文件尾追加 count 行完整记录，返回 (新的总行数, 追加的字节数)。"""
    before = path.stat().st_size
    rows = []
    n = start
    for j in range(count):
        rows.append(json.dumps({"i": n, "sid": sid, "at": 1800000000000 + j,
                                "role": "user", "text": "y" * 200},
                               ensure_ascii=False))
        n += 1
    with path.open("a", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    return n, path.stat().st_size - before


def fresh_glass(path):
    """把 `window.CHAT_FILE` 指到临时文件，再拿一个不建 Tk 的壳。"""
    import window as W
    W.CHAT_FILE = path
    from window import LiveGlass
    w = object.__new__(LiveGlass)
    w._bound_full = "session-0000000000000000-nope"
    w._hidden = set()
    return w


def log_of(w):
    return w._chat_log()


def test_read_once(tmp):
    """1. 文件没变：连问 4 次 `_history_sessions()` 只整份读一次。"""
    chat = tmp / "chat-once.jsonl"
    total = build_chat(chat)
    w = fresh_glass(chat)
    t0 = time.perf_counter()
    cold = w._history_sessions()
    cold_ms = (time.perf_counter() - t0) * 1000.0
    log = log_of(w)
    assert len(cold) == 120, "合成数据应有 120 组，实际 %d" % len(cold)
    size = chat.stat().st_size
    assert log.full_reads == 1, "第一次读就整份读了 %d 次" % log.full_reads
    assert log.bytes_read == size, (
        "第一次读了 %d 字节，文件只有 %d" % (log.bytes_read, size))
    assert len(log.entries()) == total, (
        "最近 4000 行应解析出 %d 条，实际 %d" % (total, len(log.entries())))

    warm_ms = []
    again = cold
    for _ in range(3):
        t0 = time.perf_counter()
        again = w._history_sessions()
        warm_ms.append((time.perf_counter() - t0) * 1000.0)
    assert again == cold, "缓存命中的结果和第一次不一致（缓存存错了东西）"
    assert log.full_reads == 1, (
        "连问 4 次把 chat.jsonl 整份读了 %d 次；第二次起必须走缓存" % log.full_reads)
    assert log.bytes_read == size, (
        "文件没变却又读了 %d 字节（应停在 %d）" % (log.bytes_read, size))
    return cold_ms, min(warm_ms)


def test_append_reads_tail_only(tmp):
    """2. 追加 30 行：只读追加的那截，解析数也只多 30。"""
    chat = tmp / "chat-append.jsonl"
    total = build_chat(chat)
    w = fresh_glass(chat)
    base = {g["sid"] for g in w._history_sessions()}
    log = log_of(w)
    assert log.full_reads == 1
    parsed_before = log.lines_parsed
    new_sid = "session-appended-0000-0000-000000000000"
    total, added_bytes = append_rows(chat, 30, new_sid, total)
    stats = w._chat_sessions()
    assert new_sid in stats, "追加新会话后统计里没出现它：%r" % (set(stats) - base,)
    assert log.full_reads == 1, (
        "追加不该整份重读：full_reads 从 1 变成 %d" % log.full_reads)
    assert log.append_reads == 1, "追加应走一次增量读，实际 %d" % log.append_reads
    assert log.bytes_read == chat.stat().st_size, (
        "追加后累计读了 %d 字节，文件 %d —— 追加段没有读全或读重了"
        % (log.bytes_read, chat.stat().st_size))
    assert log.bytes_read - (chat.stat().st_size - added_bytes) == added_bytes
    assert log.lines_parsed == parsed_before + 30, (
        "只该解析新增的 30 行，实际多了 %d 行" % (log.lines_parsed - parsed_before))
    assert len(log.entries()) == total, (
        "追 30 行后应有 %d 条，实际 %d" % (total, len(log.entries())))


def test_rewrite_by_replace(tmp):
    """3a. `os.replace` 整份换文件（索引变了）：整份重读，旧内容不许残留。"""
    chat = tmp / "chat-replace.jsonl"
    build_chat(chat, groups=20, per_group=10)
    w = fresh_glass(chat)
    w._chat_entries()
    log = log_of(w)
    full = log.full_reads
    new_sid = "session-replaced-0000-0000-000000000000"
    lines = [json.dumps({"i": i, "sid": new_sid, "at": 1900000000000 + i,
                         "role": "user", "text": "r" * 100}, ensure_ascii=False)
             for i in range(50)]
    stage = tmp / "chat-replace.new"
    stage.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(stage, chat)
    entries = w._chat_entries()
    assert log.full_reads == full + 1, "换文件应整份重读一次，实际多了 %d 次" % (
        log.full_reads - full)
    assert len(entries) == 50, "换文件后应有 50 条，实际 %d" % len(entries)
    assert {e.get("sid") for e in entries} == {new_sid}, "旧内容残留"


def test_truncate(tmp):
    """3b. 原地写短（size < pos）：整份重读，不许把旧尾巴接在新内容后面。"""
    chat = tmp / "chat-truncate.jsonl"
    build_chat(chat, groups=10, per_group=10)
    w = fresh_glass(chat)
    w._chat_entries()
    log = log_of(w)
    full = log.full_reads
    lines = [json.dumps({"i": i, "sid": "session-short-0000-0000-000000000000",
                         "at": 1950000000000 + i, "role": "user", "text": "s"},
                        ensure_ascii=False) for i in range(12)]
    chat.write_text("\n".join(lines) + "\n", encoding="utf-8")
    entries = w._chat_entries()
    assert log.full_reads == full + 1, "写短应整份重读一次"
    assert len(entries) == 12, "写短后应有 12 条，实际 %d" % len(entries)


def test_half_line(tmp):
    """3c. 末尾半行：先不纳入，补上换行后只出现一次。"""
    chat = tmp / "chat-half.jsonl"
    build_chat(chat, groups=5, per_group=10)
    w = fresh_glass(chat)
    w._chat_entries()
    log = log_of(w)
    before = len(log.entries())
    full = log.full_reads
    line = json.dumps({"i": 9999, "sid": "session-half-0000-0000-000000000000",
                       "at": 1990000000000, "role": "user", "text": "half"},
                      ensure_ascii=False)
    with chat.open("a", encoding="utf-8") as f:
        f.write(line)
    assert len(w._chat_entries()) == before, "半行不该被解析（写方可能还没写完）"
    with chat.open("a", encoding="utf-8") as f:
        f.write("\n")
    entries = w._chat_entries()
    assert len(entries) == before + 1, "补上换行后应多一条，实际 %d" % (
        len(entries) - before)
    assert sum(1 for e in entries if e.get("i") == 9999) == 1, (
        "半行出现了 %d 次（应恰好一次）" % sum(1 for e in entries if e.get("i") == 9999))
    assert log.full_reads == full, "半行不该触发整份重读（实际多读了 %d 次）" % (
        log.full_reads - full)


def test_tail_window(tmp):
    """4. 超过上限只留最后 4000 行：裁掉的是最老的，最新那条在。"""
    chat = tmp / "chat-window.jsonl"
    total = build_chat(chat)                 # 3600 行
    w = fresh_glass(chat)
    w._chat_entries()
    log = log_of(w)
    total, _ = append_rows(chat, 600, "session-window-0000-0000-000000000000", total)
    entries = w._chat_entries()
    assert total == 4200
    assert len(entries) == 4000, "应只留 4000 行，实际 %d" % len(entries)
    assert entries[0].get("i") == 200, (
        "裁窗口应从第 200 行开始（4200-4000），实际第一行 i=%r" % entries[0].get("i"))
    assert entries[-1].get("i") == total - 1, (
        "最新一条应留在尾部，实际 i=%r" % entries[-1].get("i"))


def test_history_entries_share_cache(tmp):
    """5. `_history_entries()` 走同一份缓存：不额外读文件，按 at 排序取最后 500。"""
    chat = tmp / "chat-history.jsonl"
    sid = "session-hist-0000-0000-000000000000"
    rows = []
    for i in range(600):
        rows.append(json.dumps({"i": i, "sid": sid, "at": 1700000000000 + (600 - i),
                                "role": "user", "text": "h"}, ensure_ascii=False))
    for i in range(40):
        rows.append(json.dumps({"i": 1000 + i, "sid": "session-other-0000-0000-000000000000",
                                "at": 1700000000000 + i, "role": "user", "text": "o"},
                               ensure_ascii=False))
    chat.write_text("\n".join(rows) + "\n", encoding="utf-8")
    w = fresh_glass(chat)
    w._chat_entries()
    log = log_of(w)
    full = log.full_reads
    got = w._history_entries(sid)
    again = w._history_entries(sid)
    assert len(got) == 500, "最近 500 条，实际 %d" % len(got)
    assert got == again, "两次结果不一致"
    assert log.full_reads == full, "`_history_entries()` 又整份读了一次"
    assert [e.get("at") for e in got] == sorted(e.get("at") for e in got), "没有按 at 排序"
    assert got[-1].get("i") == 0, (
        "at 最大的是 i=0（at = base+600），排序后应排最后，实际 %r" % (got[-1].get("i"),))


class FakeCanvas:
    def __init__(self):
        self.afters = []

    def after(self, ms, fn):
        self.afters.append((ms, fn))


def test_wheel_math(tmp):
    """120 = 一格 70px；小 delta 按比例并累加余量；顶到头时丢余量、不回弹。"""
    w = fresh_glass(tmp / "chat-once.jsonl")
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


def test_wheel_coalesces(tmp):
    """连发多个滚轮事件只排一次重画（偏移照样逐个累加，画面停在最终位置）。"""
    w = fresh_glass(tmp / "chat-once.jsonl")
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
        cold_ms, warm_ms = test_read_once(tmp)
        test_append_reads_tail_only(tmp)
        test_rewrite_by_replace(tmp)
        test_truncate(tmp)
        test_half_line(tmp)
        test_tail_window(tmp)
        test_history_entries_share_cache(tmp)
        test_wheel_math(tmp)
        test_wheel_coalesces(tmp)
    print("check-history-scroll: all passed "
          "（没变不读 / 追加只读尾巴 / 换文件·截断·半行都认得出 / 滚轮按 delta 走；"
          "冷 %.1f ms → 热 %.1f ms）" % (cold_ms, warm_ms))
    return 0


if __name__ == "__main__":
    sys.exit(main())
