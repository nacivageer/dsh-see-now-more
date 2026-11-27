# -*- coding: utf-8 -*-
"""check-feed-poll.py — ChatFeed 的增量读：半行不许丢、整份重写后不许卡死。

为什么要有它（2026-11-27）：`see-now-window.log` 里 20:47 附近连着五条
`chat poll error: 'utf-8' codec can't decode byte 0x8b in position 0`。读代码后确认
那不是「跳过一次轮询」，而是**卡死到窗重启**：

`poll()` 拿字节位置（`stat().st_size` / `tell()`）去文本模式 `seek`。删除 / 重命名会话、
自动清理都会 `_write_chat_lines` → `os.replace` 整份重写 chat.jsonl；旧字节位置落到新文件里
可能正好是一个多字节字符的中间，于是 `UnicodeDecodeError`（`0x8b` 是 UTF-8 续字节）——
而异常发生在 `_pos` 赋值之前，**之后的每一次轮询都撞同一颗地雷**，直到窗重启。用户看到
的现象是「浮窗不再显示新消息」，不报错。

验五条（不开窗、不碰真 chat.jsonl，全在临时目录里）：
  1. 正常追加：poll 拿到新消息
  2. 写到一半的多字节字符：poll 不抛，位置不动
  3. 补完之后：那条消息出现，且只出现一次
  4. 整份重写（os.replace，新文件更大）：poll 不抛，拿到新内容
  5. 重写之后还能继续收新消息 —— 老实现就是卡死在这一步

跑法：python scripts/check-feed-poll.py   （exit 0 = 全过）
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))

from window_widgets import ChatFeed  # noqa: E402

FAILED = []


def check(cond, what):
    if cond:
        print("ok    %s" % what)
    else:
        print("FAIL  %s" % what)
        FAILED.append(what)


def line(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


def row(text, at, sid="session-poll"):
    return {"role": "user", "text": text, "at": at, "sid": sid, "mid": "%s:%s" % (sid, at)}


def texts(feed):
    return [m["text"] for m in feed.messages]


def main() -> int:
    base = Path(tempfile.mkdtemp())
    path = base / "chat.jsonl"
    sid = "session-poll"

    # ── 1. 正常追加 ────────────────────────────────────────────────
    path.write_bytes(line(row("第一条", 1)))
    feed = ChatFeed(path, sid)
    feed.reload()
    check(texts(feed) == ["第一条"], "reload 读到首条，got %r" % (texts(feed),))
    check(feed.poll() is False, "没变化时 poll 返回 False")

    with open(path, "ab") as f:
        f.write(line(row("第二条", 2)))
    check(feed.poll() is True, "追加一行后 poll 返回 True")
    check(texts(feed) == ["第一条", "第二条"], "追加的消息进来了，got %r" % (texts(feed),))

    # ── 2. 写到一半：多字节字符断开 ────────────────────────────────
    full = line(row("中文半个", 3))
    # 找一个「切在多字节字符中间」的位置
    cut = None
    for i in range(1, len(full)):
        if full[i] & 0xC0 == 0x80:      # 0b10xxxxxx：UTF-8 续字节
            cut = i
            break
    check(cut is not None, "找到切在字符中间的位置（cut=%r）" % (cut,))
    with open(path, "ab") as f:
        f.write(full[:cut])
    before_pos = feed._pos
    got = feed.poll()
    check(got is False, "半行时 poll 返回 False（不抛异常），got %r" % (got,))
    check(feed._pos == before_pos, "半行时读位置不推进（%r == %r）" % (feed._pos, before_pos))

    # ── 3. 补完：那条消息只能出现一次 ──────────────────────────────
    with open(path, "ab") as f:
        f.write(full[cut:])
    check(feed.poll() is True, "补完之后 poll 返回 True")
    check(texts(feed).count("中文半个") == 1,
          "补完的消息恰好一条，got %r" % (texts(feed).count("中文半个"),))
    check(texts(feed) == ["第一条", "第二条", "中文半个"], "顺序正确，got %r" % (texts(feed),))

    # ── 4. 整份重写（os.replace，新文件更大）───────────────────────
    old_key = feed._key
    tmp = base / "chat.jsonl.tmp"
    rows_v2 = [row("重写后 甲", 10), row("重写后 乙", 11), row("重写后 丙", 12)]
    tmp.write_bytes(b"".join(line(r) for r in rows_v2))
    os.replace(tmp, path)               # 和 window._write_chat_lines 一模一样
    got = feed.poll()                   # 老实现：可能在这里 UnicodeDecodeError
    check(got is True, "整份重写后 poll 返回 True（不抛），got %r" % (got,))
    check(feed._key != old_key, "重写后认得是新文件（索引变了）")
    check(texts(feed) == ["重写后 甲", "重写后 乙", "重写后 丙"],
          "重写后的内容整份读进来，got %r" % (texts(feed),))

    # ── 5. 重写之后还能继续收 ──────────────────────────────────────
    with open(path, "ab") as f:
        f.write(line(row("重写后 丁", 13)))
    got = feed.poll()
    check(got is True, "重写之后追加的行还能被 poll 到（老实现永久卡死）")
    check(texts(feed)[-1] == "重写后 丁", "新消息进来了，got %r" % (texts(feed)[-1:],))

    # ── 补充：文件被清短 → 整份重读 ────────────────────────────────
    path.write_bytes(line(row("清短后唯一一条", 20)))
    check(feed.poll() is True, "文件变短时 poll 返回 True（重读）")
    check(texts(feed) == ["清短后唯一一条"], "清短后只剩一条，got %r" % (texts(feed),))

    print()
    if FAILED:
        print("check-feed-poll: %d FAILED" % len(FAILED))
        return 1
    print("check-feed-poll: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
