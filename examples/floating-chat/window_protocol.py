"""window_protocol.py — 悬浮窗与插件之间的 JSONL 接口。

Node 侧只看 src/window-protocol.js；Python 侧只看这个文件。两边都不 import
对方的实现，只共享这份很小的线格式：

    window-events.jsonl   插件 -> 窗口
    window-outbox.jsonl   窗口 -> 插件

消息事件沿用 chat.jsonl 的 role/text/at 字段，所以旧窗口/浏览器仍可读 chat.jsonl；
窗口按 (role, text, at) 去重，迁移期间不会出现两遍。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

WINDOW_PROTOCOL_VERSION = 1
WINDOW_EVENT_FILE = "window-events.jsonl"
WINDOW_OUTBOX_FILE = "window-outbox.jsonl"


def cache_dir() -> Path:
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return Path(d)
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return Path(local) / "dsh-video-storyboard" / "cache"
    return Path(os.environ.get("XDG_CACHE_HOME") or "~/.cache").expanduser() / "dsh-video-storyboard"


def event_file() -> Path:
    return cache_dir() / WINDOW_EVENT_FILE


def outbox_file() -> Path:
    return cache_dir() / WINDOW_OUTBOX_FILE


class WindowProtocol:
    """增量读取事件；所有解析错误都静默跳过（窗口不能因为一行坏 JSON 不动）。"""

    def __init__(self) -> None:
        self._event_offset = 0
        self._event_carry = ""
        self._event_size = -1
        self._outbox_offset = 0
        self._outbox_carry = ""
        self._outbox_size = -1

    # ---- 插件 -> 窗口 ----
    def reset_events(self, replay: int = 60) -> list[dict]:
        """开场：只回放最后 replay 条，但不和 chat.jsonl 的历史重复。"""
        path = event_file()
        try:
            size = path.stat().st_size
        except OSError:
            self._event_offset, self._event_carry, self._event_size = 0, "", 0
            return []
        self._event_offset = size
        self._event_carry = ""
        self._event_size = size
        if replay <= 0 or size == 0:
            return []
        try:
            with path.open("rb") as f:
                f.seek(max(0, size - 96 * 1024))
                chunk = f.read()
        except OSError:
            return []
        lines = [ln for ln in chunk.decode("utf-8", "replace").split("\n") if ln.strip()]
        if size > 96 * 1024 and lines:
            lines = lines[1:]
        out = []
        for line in lines[-replay:]:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                out.append(obj)
        return out

    def read_events(self) -> list[dict]:
        path = event_file()
        try:
            size = path.stat().st_size
        except OSError:
            return []
        if size < self._event_offset:
            self._event_offset, self._event_carry = 0, ""
        if size == self._event_size:
            return []
        self._event_size = size
        try:
            with path.open("rb") as f:
                f.seek(self._event_offset)
                chunk = f.read(size - self._event_offset)
        except OSError:
            return []
        self._event_offset = size
        text = self._event_carry + chunk.decode("utf-8", "replace")
        parts = text.split("\n")
        self._event_carry = parts.pop()
        out = []
        for line in parts:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                out.append(obj)
        return out

    # ---- 窗口 -> 插件 ----
    def action(self, action_type: str, **fields) -> dict:
        item = {
            "v": WINDOW_PROTOCOL_VERSION,
            "type": str(action_type),
            "at": int(time.time() * 1000),
        }
        item.update({k: v for k, v in fields.items() if v is not None})
        path = outbox_file()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return item

    def read_actions(self) -> list[dict]:
        path = outbox_file()
        try:
            size = path.stat().st_size
        except OSError:
            return []
        if size < self._outbox_offset:
            self._outbox_offset, self._outbox_carry = 0, ""
        if size == self._outbox_size:
            return []
        self._outbox_size = size
        try:
            with path.open("rb") as f:
                f.seek(self._outbox_offset)
                chunk = f.read(size - self._outbox_offset)
        except OSError:
            return []
        self._outbox_offset = size
        text = self._outbox_carry + chunk.decode("utf-8", "replace")
        parts = text.split("\n")
        self._outbox_carry = parts.pop()
        out = []
        for line in parts:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                out.append(obj)
        return out
