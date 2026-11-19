"""session_hint.py — 从 DSH 桌面版的 Local Storage 里读「主窗当前会话」(2026-11-20)。

为什么单独一个模块：悬浮窗的【关联变更】预填应该对齐 DSH 主窗**当前打开**的会话，
而宿主没有给插件读这个状态的 API。渲染层把它存在 Electron 的 Local Storage 里
（key `dsh.sessions.current`，值 `{"sessionId":"session-…"}`），这里只读那一个键。

leveldb 的结构：`.log` 是追加写的明文 WAL，`.ldb` 是压缩块（键还会做前缀压缩）。
所以只扫最新几个文件的明文；读不到/解析不出就返回空串 —— 调用方退回旧判据，
**不拿猜的值去填输入框**。只读，不写、不加锁（Chromium 正开着也能读）。
"""
from __future__ import annotations

import os
import re
from pathlib import Path

_KEY = b"dsh.sessions.current"
# 会话 id 是 UUID；认整串，别把前缀相同的别的东西吸进来
_VALUE = re.compile(
    rb'\{"sessionId":"(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\}'
)

MAX_FILES = 8
MAX_BYTES = 8 << 20       # 单个文件最多读 8MB（.log 通常几 KB，.ldb 也没多大）
WINDOW = 400              # 键后面这么多字节内找值


def short_id(full: str) -> str:
    """`session-xxxxxxxx-…` → 前 8 位（输入框只显示这么多，`_resolve_session` 认前缀）。"""
    s = str(full or "").strip()
    return s[len("session-"):][:8] if s.startswith("session-") else s[:8]


def prefill(focused_full: str, fallback_short: str = "") -> str:
    """【关联变更】输入框该预填什么；空串 = 留空（只显示占位文案）。

    - 拿得到主窗当前会话：就填它（即使它就是已绑定的那个 —— 用户点开是为了
      「对齐当前窗」，填一样的才是对得上；点确定是无操作）。
    - 拿不到（DSH 没开 / Local Storage 里没有该键）→ 用调用方给的兜底短 ID。
    """
    focused = str(focused_full or "").strip()
    if focused:
        return short_id(focused)
    return str(fallback_short or "").strip()


def leveldb_dir(appdata: str | None = None) -> Path:
    base = (appdata or os.environ.get("APPDATA")
            or str(Path.home() / "AppData" / "Roaming"))
    return Path(base) / "@deepseek-ai" / "dsh-desktop" / "Local Storage" / "leveldb"


def current_session(leveldb: Path | str | None = None) -> str:
    """DSH 主窗当前选中的会话全 ID；读不到就返回空串。"""
    d = Path(leveldb) if leveldb else leveldb_dir()
    try:
        files = [p for p in d.iterdir() if p.suffix in (".log", ".ldb")]
    except OSError:
        return ""
    try:
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return ""
    for p in files[:MAX_FILES]:
        try:
            with open(p, "rb") as fh:
                blob = fh.read(MAX_BYTES)
        except OSError:
            continue
        # 同一个 .log 里后写的在更后面：从末尾往回找，命中就是最新一次切换
        pos = blob.rfind(_KEY)
        while pos != -1:
            m = _VALUE.search(blob, pos, min(len(blob), pos + WINDOW))
            if m:
                return m.group(1).decode("ascii")
            pos = blob.rfind(_KEY, 0, pos)
    return ""
