"""session_hint.py — 「DSH 主窗当前选中哪个会话」的两个来源。

悬浮窗的【关联变更】预填应该对齐 DSH 主窗**当前打开**的会话，但窗口是另一个进程，
宿主也没给插件读这个状态的 API。按可靠性排两个来源：

1. **插件推过来的文件**（首选，2026-11-27）
   `~/.dsh/see-now/current-session.json`，值是 `{"sessionId":"session-…"}`。
   插件的 Client 半侧在渲染层读 `localStorage`（内存态）再 POST 给 Host ——
   `setItem` 同步写内存，所以切完会话立刻开输入行也拿得到当前那个。
2. **Electron 的 Local Storage**（兜底，2026-11-20）
   渲染层把选中状态持久化在 `dsh.sessions.current`（`{"sessionId":"session-…"}`）。
   只有第 1 条读不到时才走这里。它有两个已知缺口，也正是「有时候填不上/填成上一个」
   的原因：
   - **落盘是异步的**：`setItem` 之后 Chromium 才写 leveldb，刚切会话马上读磁盘
     可能还是上一个；
   - **压缩后键不再是明文**：leveldb 把 `.log` 并成 `.ldb` 时键做前缀压缩，
     `dsh.sessions.current` 可能只剩 `s.current`（本机 000515/000517.ldb 实测），
     按完整键名扫描会直接返回空。

leveldb 的结构：`.log` 是追加写的明文 WAL，`.ldb` 是压缩块（键还会做前缀压缩）。
所以这里只扫最新几个文件的明文；读不到/解析不出就返回空串 —— 调用方退回旧判据，
**不拿猜的值去填输入框**。只读，不写、不加锁（Chromium 正开着也能读）。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

_KEY = b"dsh.sessions.current"
# 会话 id 是 UUID；认整串，别把前缀相同的别的东西吸进来
_VALUE = re.compile(
    rb'\{"sessionId":"(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\}'
)
_FULL_ID = re.compile(
    r"^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

MAX_FILES = 20
MAX_BYTES = 8 << 20       # 单个文件最多读 8MB（.log 通常几 KB，.ldb 也没多大）
WINDOW = 400              # 键后面这么多字节内找值
CURRENT_FILE = "current-session.json"


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


def cache_dir() -> Path:
    """插件和窗口共用的运行时目录（窗口由插件以 `DSH_VIDEO_CACHE_DIR` 指定）。"""
    base = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if base:
        return Path(base)
    home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    return Path(home) / "see-now"


def reported_session() -> str:
    """插件从渲染层推来的「主窗当前会话」；没有 / 坏了都返回空串。"""
    try:
        raw = Path(cache_dir(), CURRENT_FILE).read_text(encoding="utf-8-sig")
        sid = str(json.loads(raw).get("sessionId") or "").strip()
    except Exception:
        return ""
    return sid if _FULL_ID.match(sid) else ""


def current_session(leveldb: Path | str | None = None) -> str:
    """DSH 主窗当前选中的会话全 ID；读不到就返回空串。

    先看插件推来的文件（即时、可靠），没有才读 Electron 的 Local Storage。
    """
    sid = reported_session()
    if sid:
        return sid
    return _from_local_storage(leveldb)


def _from_local_storage(leveldb: Path | str | None = None) -> str:
    """兜底：扫 Electron Local Storage 的明文文件。"""
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
        # 同一个 .log 里后写的在更后面：从末尾往回找，命中就是最新一次切换。
        # **键的最新一条是权威**：值不是完整会话 id（比如主窗清空了选择、写成 `{}`）
        # 就返回空串，不能继续往前翻旧记录 —— 那会把一个已经取消选中的会话填进来。
        pos = blob.rfind(_KEY)
        if pos == -1:
            continue
        m = _VALUE.search(blob, pos, min(len(blob), pos + WINDOW))
        return m.group(1).decode("ascii") if m else ""
    return ""
