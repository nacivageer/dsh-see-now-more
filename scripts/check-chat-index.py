# -*- coding: utf-8 -*-
"""check-chat-index.py — `chat.jsonl` 的「行→条目→会话索引」两跳，不开窗、不读真文件。

为什么要有它：`chat_index.py` 是从 `window.py` 的 `_chat_entries()` / `_chat_sessions()`
里抽出来的（2026-11-27）。这两跳在**回顾列表每滚一格**的热路径上（真机 1.7 MB /
2236 行），以前只能建 Tk 壳去验，现在用假数据直接跑。

和 `check-window-math.py` 同一个办法：把抽取前的旧实现原样抄成参照，逐组对比，
证明搬动没改口径 —— 而不是把新实现的行为写成断言（那是自证）。

跑法：python scripts/check-chat-index.py   （exit 0 = 全过；2 = 找不到模块）
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'examples' / 'floating-chat'))

try:
    from chat_index import MAX_ENTRIES, aggregate_sessions, parse_lines, tail_lines  # noqa: E402
except Exception as exc:          # noqa: BLE001
    print('SKIP  cannot import chat_index: %r' % (exc,))
    sys.exit(2)

FAILED = []


def check(cond, what):
    if cond:
        print('ok    %s' % what)
    else:
        print('FAIL  %s' % what)
        FAILED.append(what)


# ---------------------------------------------------------------- 参照实现
# 逐字取自抽取前的 window.py，**不许改**（改了就不再是等价性验收）。
def ref_parse(text, limit=4000):
    entries = []
    for line in text.splitlines()[-limit:]:
        try:
            e = json.loads(line)
        except Exception:
            continue
        if isinstance(e, dict):
            entries.append(e)
    return entries


def ref_sessions(entries):
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


# ---------------------------------------------------------------- 1. 坏行
CASES = [
    '',
    '\n\n',
    '{"sid":"session-a","at":10,"role":"user","text":"hi"}',
    'not json at all',
    '[1,2,3]',                                  # 合法 JSON，但不是对象
    '"a string"',
    'null',
    '{"sid":"session-a","at":20,"role":"assistant","text":"yo"}',
    '{"sid":"session-b","at":5,"role":"meta"}',
    '{"sid":"","at":7}',
    '{"at":8}',                                 # 没有 sid
    '{"sid":"session-b","at":"oops"}',          # at 不是整数
    '{"sid":"session-b","at":null}',            # at=null → 0，算
    '{"sid":"session-b","at":30,"extra":{"k":[1,2]}}',   # 未知字段要留住
    '{"sid":"session-c","at":-5}',              # 负时间也照收（别替它判断）
]
text = '\n'.join(CASES) + '\n'
got = parse_lines(tail_lines(text))
want = ref_parse(text)
check(got == want, 'parse_lines == 旧实现（%d 行输入 / %d 条有效）' % (len(CASES), len(want)))
check([e.get('sid') for e in got] ==
      ['session-a', 'session-a', 'session-b', '', None,
       'session-b', 'session-b', 'session-b', 'session-c'],
      'order kept; only non-object lines dropped, got %r'
      % ([e.get('sid') for e in got],))
check(got[-2].get('extra') == {"k": [1, 2]}, 'unknown fields survive')

# ---------------------------------------------------------------- 2. tail_lines
many = '\n'.join('{"n":%d}' % i for i in range(5000))
check(len(tail_lines(many)) == MAX_ENTRIES, 'tail_lines keeps exactly %d lines' % MAX_ENTRIES)
check(tail_lines(many)[0].endswith('{"n":1000}'), 'tail_lines starts at the %d-th line' % 1000)
check(tail_lines('{"n":1}\n{"n":2}\n') == ['{"n":1}', '{"n":2}'], 'shorter file kept whole')
check(tail_lines('') == [], 'empty text -> no lines')

# ---------------------------------------------------------------- 3. 会话聚合
sess_text = '\n'.join([
    '{"sid":"session-a","at":30,"role":"assistant"}',
    '{"sid":"session-a","at":10,"role":"user"}',
    '{"sid":"session-a","at":20,"role":"user"}',
    '{"sid":"session-b","at":5,"role":"user"}',
    '{"sid":"session-b","at":99,"role":"meta"}',        # meta 不算
    '{"sid":"session-b","at":12,"role":"user"}',
    '{"sid":"","at":12,"role":"user"}',                 # 无 sid 不算
    '{"sid":"session-c"}',                              # 没有 at → 0，算
])
entries = ref_parse(sess_text)
check(aggregate_sessions(entries) == ref_sessions(entries),
      'aggregate_sessions == 旧实现')
got = aggregate_sessions(entries)
check(sorted(got) == ['session-a', 'session-b', 'session-c'], 'sessions: %r' % (sorted(got),))
check(got['session-a'] == {'sid': 'session-a', 'firstAt': 10, 'lastAt': 30},
      'firstAt/lastAt = min/max, got %r' % (got['session-a'],))
check(got['session-b'] == {'sid': 'session-b', 'firstAt': 5, 'lastAt': 12},
      'meta row ignored, got %r' % (got['session-b'],))
check(got['session-c'] == {'sid': 'session-c', 'firstAt': 0, 'lastAt': 0},
      'missing at counts as 0, got %r' % (got['session-c'],))
check(aggregate_sessions([]) == {}, 'empty entries -> empty index')

# ---------------------------------------------------------------- 4. 静态守卫
src = (ROOT / 'examples' / 'floating-chat' / 'window.py').read_text(encoding='utf-8')
for snippet, why in [
    ('for line in CHAT_FILE.read_text', 'chat.jsonl line loop'),
    ('CHAT_FILE.read_text(encoding="utf-8").splitlines()[-4000:]', 'inline 4000-line slice'),
    ('out[sid] = {"sid": sid, "firstAt": at, "lastAt": at}', 'inline session aggregation'),
]:
    check(snippet not in src, 'window.py no longer inlines the %s' % why)

print()
if FAILED:
    print('check-chat-index: %d FAILED' % len(FAILED))
    sys.exit(1)
print('check-chat-index: all passed')
