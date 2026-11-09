#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""给老的 `chat.jsonl` 补 `sid`（一次性迁移，2026-11-06）。

背景：`chat.jsonl` 从 2026-11-05 起只写了 `(role, text, at)`，没有会话 ID，
所有会话的正文混在一条流水里。按会话分组要先知道"这句是哪个会话说的"。

匹配顺序（越靠前越可信）：

1. **正文完全相同**：会话日志里 `assistant/message` / `user/message` 的 text
   与条目一模一样，且时间差 ≤ TOL；
2. **前缀包含**：用户消息在会话里常被追加 `<system-reminder>` 之类，取"以它开头"；
3. **relay.log**：窗里打的字投给谁，relay 是直接记账的（`ok(chat) -> session-x: 文本`）；
4. **唯一活动会话**：那一刻前后 TOL 内只有这一个会话有动静；
5. 以上都不中 → `sid` 留空（界面显示「未归属」）。

最后再做一次**邻接补位**：窗里 `say` 的话不进会话日志，夹在两条同一会话的消息中间
（10 分钟内）就归给那个会话；夹在两段不同会话中间则不猜。

输出：原文件备份成 `chat.jsonl.bak-<时间>`，原地重写成带 `sid` 的版本；
另写 `session-groups.json`（每组首末时间，历史列表排序用）。

用法：
    python migrate-chat-sids.py --dry-run [--report out.txt]
    python migrate-chat-sids.py
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

TOL = 240_000        # 240 秒：窗与会话日志的时间差；再大就可能跨到别的会话
NEIGHBOR_GAP = 600_000   # 邻接补位只认 10 分钟内


def dsh_home() -> Path:
    return Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh")


def load_sessions():
    """{sid: [(time, text), ...]} —— 只留用户/助手正文。"""
    try:
        import zstandard
    except Exception:
        print("需要 python 包 zstandard", file=sys.stderr)
        raise
    out = {}
    root = dsh_home() / "sessions"
    for prof in root.iterdir():
        if not prof.is_dir():
            continue
        for sdir in prof.iterdir():
            if not sdir.name.startswith("session-"):
                continue
            f = sdir / "session.v4.jsonl.zstd"
            if not f.exists():
                continue
            try:
                raw = zstandard.ZstdDecompressor().stream_reader(
                    open(f, "rb")).read().decode("utf-8", "replace")
            except Exception as exc:
                print(f"  ⚠ 读不了 {sdir.name}: {exc}", file=sys.stderr)
                continue
            rows = out.setdefault(sdir.name, [])
            for line in raw.splitlines():
                if not line.strip():
                    continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("type") not in ("user/message", "assistant/message"):
                    continue
                d = e.get("data") or {}
                msg = d.get("message") or d
                content = msg.get("content")
                if isinstance(content, str):
                    parts = [content]
                elif isinstance(content, list):
                    parts = [c.get("text") for c in content
                             if isinstance(c, dict) and c.get("type") == "text"]
                else:
                    parts = []
                text = "\n".join(p for p in parts if p)
                if text.strip():
                    rows.append((e.get("time"), text))
    return out


def build_index(sessions):
    idx = {}
    for sid, rows in sessions.items():
        for t, text in rows:
            if t is None:
                continue
            idx.setdefault(text.strip(), []).append((int(t), sid))
    for v in idx.values():
        v.sort()
    return idx


def load_relay():
    p = dsh_home() / "see-now" / "relay.log"
    out = {}
    if not p.exists():
        return out
    pat = re.compile(r"^(\S+Z) ok\(chat\) -> (session-[\w-]+): (.*)$")
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        m = pat.match(line.strip())
        if not m:
            continue
        try:
            ts = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
        out.setdefault(m.group(3).strip(), []).append((int(ts * 1000), m.group(2)))
    for v in out.values():
        v.sort()
    return out


def pick(text, at, idx, spans, sessions, relay):
    text = text.strip()

    def nearest(cands):
        if not cands:
            return None
        best = min(cands, key=lambda c: abs(c[0] - at))
        return best if abs(best[0] - at) <= TOL else None

    cand = nearest(idx.get(text, []))
    if cand:
        return cand[1], "text"

    head = text[:80]
    best = None
    if head:
        for sid, rows in sessions.items():
            for t, s in rows:
                if t is None:
                    continue
                if s.startswith(head) or (len(head) >= 12 and head in s[:400]):
                    d = abs(int(t) - at)
                    if d <= TOL and (best is None or d < best[0]):
                        best = (d, sid)
    if best:
        return best[1], "prefix"

    cand = nearest(relay.get(text, []))
    if cand:
        return cand[1], "relay"

    near = [sid for sid, (lo, hi) in spans.items() if lo - TOL <= at <= hi + TOL]
    if len(near) == 1:
        return near[0], "window"
    return "", "none"


def neighbor_fill(entries):
    """把夹在同一会话两条已归属消息之间的条目补给它（10 分钟内）。"""
    n = len(entries)
    i = 0
    filled = 0
    while i < n:
        e = entries[i]
        if not isinstance(e, dict) or e.get("_sid"):
            i += 1
            continue
        j = i
        while j < n and (not isinstance(entries[j], dict) or not entries[j].get("_sid")):
            j += 1
        # [i, j) 是一段未归属；看两端
        prev = entries[i - 1] if i > 0 and isinstance(entries[i - 1], dict) else None
        nxt = entries[j] if j < n and isinstance(entries[j], dict) else None
        psid = prev.get("_sid") if prev else ""
        nsid = nxt.get("_sid") if nxt else ""
        pick_sid = ""
        if psid and nsid and psid == nsid:
            if all(abs(int(e2.get("at") or 0) - int((prev or {}).get("at") or 0)) <= NEIGHBOR_GAP
                   for e2 in entries[i:j]):
                pick_sid = psid
        elif psid and not nsid:
            if all(abs(int(e2.get("at") or 0) - int(prev.get("at") or 0)) <= NEIGHBOR_GAP
                   for e2 in entries[i:j]):
                pick_sid = psid
        elif nsid and not psid:
            if all(abs(int(e2.get("at") or 0) - int(nxt.get("at") or 0)) <= NEIGHBOR_GAP
                   for e2 in entries[i:j]):
                pick_sid = nsid
        if pick_sid:
            for e2 in entries[i:j]:
                e2["_sid"] = pick_sid
                e2["_how"] = "neighbor"
            filled += j - i
        i = j
    return filled


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--chat")
    ap.add_argument("--report", help="把明细写到这个文件（UTF-8）")
    a = ap.parse_args()

    home = dsh_home()
    chat = Path(a.chat) if a.chat else home / "see-now" / "chat.jsonl"
    if not chat.exists():
        print(f"没有 {chat}")
        return 1

    sessions = load_sessions()
    idx = build_index(sessions)
    relay = load_relay()
    spans = {}
    for sid, rows in sessions.items():
        ts = [t for t, _ in rows if t is not None]
        if ts:
            spans[sid] = (min(ts), max(ts))

    entries = []
    for line in chat.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            entries.append(None)

    stats = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        if e.get("sid"):
            stats["have"] = stats.get("have", 0) + 1
            e["_sid"] = e["sid"]
            continue
        sid, how = pick(e.get("text") or "", int(e.get("at") or 0),
                        idx, spans, sessions, relay)
        e["_sid"] = sid
        e["_how"] = how
        stats[how] = stats.get(how, 0) + 1

    filled = neighbor_fill(entries)
    if filled:
        stats["neighbor"] = stats.get("neighbor", 0) + filled

    report = [f"会话 {len(sessions)} 个 / 正文 {sum(len(v) for v in sessions.values())} 条",
              f"chat {len(entries)} 条 / relay 条目 {len(relay)} 种文本",
              f"匹配：{stats} / 邻接补位 {filled} 条"]
    for e in entries:
        if isinstance(e, dict):
            report.append(f"{e.get('at')} {e.get('role'):9s} "
                          f"{(e.get('_how') or 'have'):8s} "
                          f"{(e.get('_sid') or '-')[:20]:20s} "
                          f"{(e.get('text') or '')[:60]!r}")
    print("\n".join(report[:3]))
    if a.report:
        Path(a.report).write_text("\n".join(report), encoding="utf-8")
        print(f"明细：{a.report}")

    if a.dry_run:
        print("（dry-run：没有写盘）")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = chat.with_name(f"chat.jsonl.bak-{stamp}")
    shutil.copy2(chat, bak)

    groups = {}
    out_lines = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        sid = e.pop("_sid", "") or ""
        e.pop("_how", None)
        if sid:
            e["sid"] = sid
            g = groups.setdefault(sid, {"sid": sid, "count": 0})
            g["count"] += 1
            at = int(e.get("at") or 0)
            g["lastAt"] = max(g.get("lastAt", 0), at)
            g["firstAt"] = min(g.get("firstAt", at), at)
        out_lines.append(json.dumps(e, ensure_ascii=False))
    tmp = chat.with_name("chat.jsonl.tmp")
    tmp.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    os.replace(tmp, chat)

    gp = chat.with_name("session-groups.json")
    order = sorted(groups.values(), key=lambda g: g.get("lastAt", 0), reverse=True)
    gp.write_text(json.dumps({"order": order}, ensure_ascii=False, indent=2),
                  encoding="utf-8")
    print(f"备份：{bak}")
    print(f"会话组 {len(order)} 个 → {gp}")
    for g in order:
        print(f"  {g['sid'][:16]:18s} {g['count']:3d} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
