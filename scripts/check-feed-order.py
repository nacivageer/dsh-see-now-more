# -*- coding: utf-8 -*-
"""check-feed-order.py — 无 GUI 验 ChatFeed 的「按 at 排序 / mid 去重 / 截断不挤掉最近」。

为什么需要它：浮窗镜像把**旧**用户消息追加在 `chat.jsonl` 文件尾，而 ChatFeed
原来是「按写入顺序追加、超 200 条截尾」。回填一多，最后 200 条全是旧消息，
最近的被挤掉 —— 表现是"浮窗里的对话停在很久以前"。

跑法：python scripts/check-feed-order.py   （exit 0 = 三条都过）
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))

from window_widgets import ChatFeed  # noqa: E402


def write_rows(path: Path, rows: list) -> None:
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    sid = "session-test"
    now = 1_800_000_000_000

    # ① 回填的旧条目追加在文件尾：按 at 排序后，最近的 200 条要留下
    path = Path(tempfile.mkdtemp()) / "chat.jsonl"
    rows = [
        {"role": "user", "text": f"第{i}条", "at": now + i, "sid": sid, "mid": f"{sid}:{i}"}
        for i in range(1, 206)
    ]
    for i in range(5):
        rows.append({"role": "user", "text": f"旧{i}", "at": now - 1000 + i,
                     "sid": sid, "mid": f"{sid}:{9000 + i}"})
    write_rows(path, rows)
    feed = ChatFeed(path, sid)
    feed.reload()
    texts = [m["text"] for m in feed.messages]
    assert len(texts) == ChatFeed.KEEP, f"应留 {ChatFeed.KEEP} 条，实际 {len(texts)}"
    assert texts[0] == "第6条", f"最早的 5 条该被挤掉，首条是 {texts[0]!r}"
    assert texts[-1] == "第205条", f"最新一条该在最后，实际 {texts[-1]!r}"
    assert all(not t.startswith("旧") for t in texts), "回填的旧消息不许顶掉最近的消息"

    # ② 同文同毫秒的消息靠 mid 区分：两条都要在
    path2 = Path(tempfile.mkdtemp()) / "chat.jsonl"
    write_rows(path2, [
        {"role": "user", "text": "同样的话", "at": now, "sid": sid, "mid": f"{sid}:1"},
        {"role": "user", "text": "同样的话", "at": now, "sid": sid, "mid": f"{sid}:2"},
    ])
    feed2 = ChatFeed(path2, sid)
    feed2.reload()
    assert len(feed2.messages) == 2, f"同文同毫秒被吞成 {len(feed2.messages)} 条"

    # ③ 没有 mid 的老条目行为不变（同一个键第二次仍然算重复）
    path3 = Path(tempfile.mkdtemp()) / "chat.jsonl"
    row = {"role": "user", "text": "老话", "at": now, "sid": sid}
    write_rows(path3, [row, row])
    feed3 = ChatFeed(path3, sid)
    feed3.reload()
    assert len(feed3.messages) == 1, "没有 mid 的老条目仍按 (role,text,at,sid) 去重"

    print("ok: ChatFeed 按 at 排序、mid 去重、截断保留最近")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
