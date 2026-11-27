"""chat_index.py — `chat.jsonl` 的「行 → 条目 → 会话索引」两跳，纯数据、无 Tk、无 I/O。

为什么单独一个文件（2026-11-27）：这两跳原来内联在 `LiveGlass._chat_entries()` /
`_chat_sessions()` 里，而它们是**回顾列表每滚一格都要跑**的热路径（真机 1.7 MB /
2236 行，2026-11-27 实测整份解析 47 ms）。内联在 1.1 万行的窗口类里，想验一次就得
开 Tk 壳；搬出来之后 `scripts/check-chat-index.py` 用假数据直接跑。

**这里只做纯变换**：不读文件、不碰 `CHAT_FILE`、不认识缓存。读多少字节、什么时候失效
是 `chat_log.py` 的事（那部分和 `chat.jsonl` 只增不减的增长曲线绑在一起）。
"""

from __future__ import annotations

import json

#: 最近多少行参与索引。真机 2236 行 / 1.7 MB，4000 行留了余量；
#: 再大就变成「为了翻一页解析一份日志」。
MAX_ENTRIES = 4000


def tail_lines(text: str, limit: int = MAX_ENTRIES) -> list:
    """只要最后 `limit` 行（等价于旧实现里的 `read_text().splitlines()[-4000:]`）。"""
    return text.splitlines()[-limit:]


def parse_line(line: str):
    """单行 → 条目；坏行 / 非对象行 → None（`parse_lines` 的单行版）。"""
    try:
        e = json.loads(line)
    except Exception:
        return None
    return e if isinstance(e, dict) else None


def parse_lines(lines) -> list:
    """逐行 `json.loads`，坏行 / 非对象行跳过。

    一条脏数据（半行、被别的进程写坏、历史遗留的非 JSON）不能废掉整份索引 ——
    旧实现就是这样用 `continue` 兜的，别改成整体失败。
    """
    out = []
    for line in lines:
        e = parse_line(line)
        if e is not None:
            out.append(e)
    return out


def aggregate_sessions(entries) -> dict:
    """`{sid: {sid, firstAt, lastAt}}` —— 「有哪些会话」和「谁最新」都从这里来。

    口径照旧：`role == "meta"` 的记录不算会话消息；没有 `sid` 的跳过；
    `at` 缺失算 0，`at` 不是整数（字符串、None、浮点串）跳过整条 ——
    以前是 `int(e.get("at") or 0)` 外面套 try，这里保持同一行为。
    """
    out = {}
    for e in entries:
        if e.get("role") == "meta":
            continue
        sid = str(e.get("sid") or "")
        if not sid:
            continue
        try:
            at = int(e.get("at") or 0)
        except Exception:
            continue
        g = out.get(sid)
        if g is None:
            out[sid] = {"sid": sid, "firstAt": at, "lastAt": at}
        else:
            g["firstAt"] = min(g["firstAt"], at)
            g["lastAt"] = max(g["lastAt"], at)
    return out
