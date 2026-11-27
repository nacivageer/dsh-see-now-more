"""chat_log.py — `chat.jsonl` 的尾部缓存：整份读一次，之后只读追加的那一截。

为什么单独一个文件（2026-11-27）：`_chat_entries()` 原来是「文件一变就整份
`read_text` + 解析」—— 真机 1.8 MB，默认清理关掉、文件只增不减，于是每来一条消息就
重付一次全量解析。`chat_index.py` 只做纯变换；这一层管 I/O、失效和增量。
**验收靠它自己的读数**（`bytes_read` / `full_reads` / `lines_parsed`），不靠计时 ——
计时在别人的机器上没有判据力。

口径和旧实现一致：

- 只看**最后 `limit` 行**（默认 4000，`chat_index.MAX_ENTRIES`）；
- 坏行 / 非对象行跳过，不废掉整份索引；
- 只认完整行：末尾的半行留给下一次。**不按字节位置硬切** —— `ChatFeed.poll()` 在
  2026-11-27 就吃过这个亏（旧字节位置落进多字节字符中间，`UnicodeDecodeError` 之后
  每次轮询撞同一颗地雷）。
"""

from __future__ import annotations

import os
from collections import deque

from chat_index import MAX_ENTRIES, parse_line


class ChatLog:
    """跟随一个 JSONL 的增量视图；`refresh()` 之后 `entries()` 就是当前内容。

    变更判据（三条，任何一条命中就整份重来）：

    1. 文件索引 `(st_dev, st_ino)` 变了 —— 删除 / 重命名会话、自动清理都走 `os.replace`，
       整份换文件；
    2. 文件比已消费的位置短 —— 截断 / 清空；
    3. 大小没变但 mtime 变了 —— 原地重写（少见，但静默给旧结果更坏）。

    否则只读 `pos` 之后、最后一个换行之前的字节。
    """

    def __init__(self, path, limit: int = MAX_ENTRIES):
        self.path = path
        self.limit = int(limit)
        self._key = None            # (st_dev, st_ino)
        self._mtime = 0
        self._pos = 0               # 已消费的字节数（永远停在换行边界）
        self._nlines = 0            # 见过多少行（含已经被裁掉的老行）
        self._items = deque()       # [(行号, 条目或 None), ...]，最多 limit 条
        self._entries = []
        self._dirty = True
        self.version = 0            # 内容变一次 +1；调用方拿它当缓存签名
        # 验收读数（只增）
        self.full_reads = 0         # 整份重读了几次
        self.append_reads = 0       # 从 pos 往后增量读了几次
        self.bytes_read = 0         # 一共从文件读了多少字节
        self.lines_parsed = 0       # 一共解析了多少行

    # ---- 读 ----

    def entries(self) -> list:
        """最近 `limit` 行的解析结果。**别原地改**：这是内部列表，改了缓存就脏了。"""
        if self._dirty:
            self._entries = [e for _, e in self._items if e is not None]
            self._dirty = False
        return self._entries

    def refresh(self) -> bool:
        """跟着文件走；返回内容有没有变。"""
        try:
            st = os.stat(self.path)
        except OSError:
            return self._reset()
        key = (st.st_dev, st.st_ino)
        if key != self._key or st.st_size < self._pos:
            return self._reload()
        if st.st_size > self._pos:
            return self._append()
        if st.st_mtime_ns != self._mtime:
            # 大小没变但改过（原地重写）：已消费的位置不再可信
            return self._reload()
        return False

    # ---- 三条路径 ----

    def _reload(self) -> bool:
        self.full_reads += 1
        try:
            with open(self.path, "rb") as f:
                chunk = f.read()
            st = os.stat(self.path)
        except OSError:
            return self._reset()
        self.bytes_read += len(chunk)
        self._key = (st.st_dev, st.st_ino)
        self._mtime = st.st_mtime_ns
        # 只认完整行：末尾那半行可能正被写、也可能断在多字节字符中间
        cut = chunk.rfind(b"\n")
        head = chunk[:cut + 1] if cut >= 0 else b""
        self._pos = len(head)
        try:
            text = head.decode("utf-8")
        except UnicodeDecodeError:
            # 整份都解不开：位置不可信，清空等下一次（和 `ChatFeed.reload()` 一致）
            self._items.clear()
            self._nlines = 0
            self._pos = 0
            self._dirty = True
            self.version += 1
            return True
        lines = text.splitlines()
        total = len(lines)
        keep_from = max(0, total - self.limit)
        self._items.clear()
        self._nlines = total
        for i in range(keep_from, total):
            self._items.append((i, parse_line(lines[i])))
        self.lines_parsed += len(self._items)
        self._dirty = True
        self.version += 1
        return True

    def _append(self) -> bool:
        self.append_reads += 1
        try:
            st = os.stat(self.path)
            with open(self.path, "rb") as f:
                f.seek(self._pos)
                chunk = f.read()
        except OSError:
            return False
        self.bytes_read += len(chunk)
        self._mtime = st.st_mtime_ns
        cut = chunk.rfind(b"\n")
        if cut < 0:
            return False                    # 只有半行：位置不动，等它写完
        chunk = chunk[:cut + 1]
        try:
            data = chunk.decode("utf-8")
        except UnicodeDecodeError:
            return self._reload()           # 位置已经不可信，整份重来
        self._pos += len(chunk)
        added = 0
        for line in data.splitlines():
            self._items.append((self._nlines, parse_line(line)))
            self._nlines += 1
            added += 1
            while len(self._items) > self.limit:
                self._items.popleft()
        self.lines_parsed += added
        if not added:
            return False
        self._dirty = True
        self.version += 1
        return True

    def _reset(self) -> bool:
        """文件没了 / 读不动：清空。只在该清的时候动版本号。"""
        changed = bool(self._items) or self._key is not None
        self._items.clear()
        self._entries = []
        self._dirty = False
        self._nlines = 0
        self._pos = 0
        self._key = None
        self._mtime = 0
        if changed:
            self.version += 1
        return changed
