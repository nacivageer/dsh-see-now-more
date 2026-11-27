# -*- coding: utf-8 -*-
"""check-cleanup-tiers.py — 无 GUI 验「自动清理 3 / 7 / 14 / 30 分档」。

不创建 Tk 窗口：用 `object.__new__(LiveGlass)` 造一个没有 `__init__` 的壳
（和 `scripts/check-notif-toggle.py` 同一做法），塞假配置路径 / 假 canvas，直接调真实方法。
验六条契约：

  1. 分档就是 3 / 7 / 14 / 30，**30 必须在**（不常用的人几周才翻一次），默认 30；
  2. `_cleanup_count` 与 `_run_cleanup` 同口径：坏行、没有 `at` 的行都不算「会删」；
  3. 从长改到短、开着开关、真会删 → 先弹确认，**确认前配置一个字节都不动**；
  4. 改长 / 关闭状态下改短 / 删不到东西 → 不弹确认，直接生效；
  5. 选的是当前档 / 不在分档里的值 → 什么都不做；
  6. 列表底部那行拆成两个热区：「超过 N 天」开菜单，其余部分还是开关（天数区先判，
     否则永远被整行开关吃掉）。

不碰 Tk、不碰鼠标，也不读写 `~/.dsh`：配置与 chat.jsonl 都在临时目录。

跑法：python scripts/check-cleanup-tiers.py   （exit 0 = 全过）
"""
import json
import sys
import tempfile
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))

import window  # noqa: E402
from window import LiveGlass as Window  # noqa: E402


class FakeFont:
    def measure(self, s):
        return len(str(s)) * 7

    def metrics(self, *_a, **_k):
        return {"linespace": 14}


class FakeFonts:
    def get(self, *_a, **_k):
        return FakeFont()

    def spec(self, *_a, **_k):
        return FakeFont()


class FakeCanvas:
    """只记 create_text / create_line 的坐标（行布局断言要它）。"""

    def __init__(self):
        self.texts = []
        self.lines = []

    def create_text(self, x, y, text="", **_k):
        self.texts.append((x, y, text))
        return len(self.texts)

    def create_line(self, *args, **_k):
        self.lines.append(args)
        return len(self.lines)

    def create_rectangle(self, *args, **_k):
        return 0


def make_window(tmp):
    """装成 `_cleanup_*` 那几个方法要用的最小壳。"""
    w = object.__new__(Window)
    w.fonts = FakeFonts()
    w._settings = None
    w._cleanup_cache = None
    # 配置与 chat.jsonl 都落在临时目录（`_cleanup_file` 跟着 CHAT_FILE 走）
    window.CHAT_FILE = Path(tmp) / "chat.jsonl"
    window.CHAT_FILE.write_text("", encoding="utf-8")
    w.saved = []
    w.ran = []
    w.confirms = []
    w.redraws = 0
    w._cleanup_save = lambda cfg: (w.saved.append(dict(cfg)), window.LiveGlass._cleanup_save(w, cfg))
    w._run_cleanup = lambda days: w.ran.append(int(days))
    w._hist_redraw = lambda: setattr(w, "redraws", w.redraws + 1)
    w._show_cleanup_confirm = lambda days, old, gone: w.confirms.append((days, old, gone))
    return w


def bust(w):
    """`_cleanup_cfg` 有 2 秒缓存：改盘之后要清掉，否则读到旧值。"""
    w._cleanup_cache = None


def seed(w, cfg):
    """直接写盘准备前置状态（不走 `w._cleanup_save` 那个记账壳，免得污染「谁写了盘」）。"""
    window.LiveGlass._cleanup_save(w, dict(cfg))
    bust(w)


def lines_at(ages_days):
    base = int(time.time() * 1000)
    return [json.dumps({"role": "user", "text": f"m{i}", "at": base - int(d * 86400 * 1000)})
            for i, d in enumerate(ages_days)]


def test_shape():
    assert Window.CLEANUP_DEFAULT == 30, Window.CLEANUP_DEFAULT
    assert tuple(Window.CLEANUP_TIERS) == (3, 7, 14, 30), Window.CLEANUP_TIERS
    assert 30 in Window.CLEANUP_TIERS, "30 天必须留着"


def test_count_matches_cleanup(tmp):
    w = make_window(tmp)
    rows = lines_at([4, 5, 1])
    # 坏行 / 没有 at 的行：都不该算进「会删」
    window.CHAT_FILE.write_text(
        "\n".join(rows + ["{不是 json", json.dumps({"role": "user", "text": "没有 at"})]) + "\n",
        encoding="utf-8")
    assert w._cleanup_count(3) == 2, w._cleanup_count(3)
    assert w._cleanup_count(7) == 0, w._cleanup_count(7)


def test_defaults_and_real_cleanup(tmp):
    w = make_window(tmp)
    cfg = w._cleanup_cfg()
    assert cfg["days"] == 30 and cfg["enabled"] is False, cfg

    window.CHAT_FILE.write_text("\n".join(lines_at([4, 5, 1])) + "\n", encoding="utf-8")
    w._run_cleanup = lambda days: None
    w._backup_chat = lambda tag="del": None
    w._write_chat_lines = lambda rows: window.CHAT_FILE.write_text(
        "\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
    w.feed = types.SimpleNamespace(reload=lambda: None)
    w._refresh_feed = lambda: None
    w._hist = None
    w._refresh_history_btn = lambda: None
    Window._run_cleanup(w, 3)
    left = window.CHAT_FILE.read_text(encoding="utf-8").strip().splitlines()
    assert len(left) == 1, f"3 天档应该只留 1 条，实际 {len(left)}"


def test_set_days(tmp):
    w = make_window(tmp)
    window.CHAT_FILE.write_text("\n".join(lines_at([4, 5, 1])) + "\n", encoding="utf-8")

    # 1）开启 + 30→3，真会删两条 → 弹确认，配置不动
    seed(w, {"enabled": True, "days": 30})
    w.saved.clear()
    w._set_cleanup_days(3)
    assert w.confirms == [(3, 30, 2)], w.confirms
    assert w.saved == [], f"确认前不该写盘：{w.saved}"
    assert w._cleanup_cfg()["days"] == 30

    # 2）取消 = 什么都不发生（壳里没有回调，靠没写盘证明）
    w.confirms.clear()
    w._set_cleanup_days(30)
    assert w.confirms == [] and w.saved == [], (w.confirms, w.saved)

    # 3）关闭状态下改短：不弹确认，直接生效、也不删
    seed(w, {"enabled": False, "days": 30})
    w.saved.clear()
    w.ran.clear()
    w._set_cleanup_days(7)
    assert w.confirms == [], "关着的时候不该弹"
    assert w._cleanup_cfg()["days"] == 7, w._cleanup_cfg()
    assert w.ran == [], "关着的时候不该删"
    assert w.redraws >= 1, "改完要重画那一行"

    # 4）从短改长（7→30）：不弹、直接写
    seed(w, {"enabled": True, "days": 7})
    w.confirms.clear()
    w._set_cleanup_days(30)
    assert w.confirms == [], "改长不弹"
    assert w._cleanup_cfg()["days"] == 30

    # 5）删不到东西（30→3，但最老的只有 1 天）：不弹，直接写
    window.CHAT_FILE.write_text("\n".join(lines_at([1, 0.5])) + "\n", encoding="utf-8")
    seed(w, {"enabled": True, "days": 30})
    w.confirms.clear()
    w.ran.clear()
    w._set_cleanup_days(3)
    assert w.confirms == [], "删不到东西不该弹"
    assert w._cleanup_cfg()["days"] == 3
    assert w.ran == [3], f"开着就要立刻按新档跑一次：{w.ran}"

    # 6）同一档 / 不在分档里的值：什么都不做（菜单只给 3/7/14/30，其它值一律忽略）
    w.saved.clear()
    w._set_cleanup_days(3)
    w._set_cleanup_days(5)
    w._set_cleanup_days(0)
    assert w.saved == [], w.saved
    assert w._cleanup_cfg()["days"] == 3


def test_row_hit_regions(tmp):
    """行布局：两个热区都在，且天数区落在整行开关区里面（所以点击必须先判它）。"""
    w = make_window(tmp)
    c = FakeCanvas()
    st = {"canvas": c, "h": 600}
    w._hist = st
    Window._hist_draw_cleanup_row(w)
    days_rect = st.get("cleanup_days_rect")
    row_rect = st.get("cleanup_rect")
    assert days_rect and row_rect, (days_rect, row_rect)
    assert row_rect[0] <= days_rect[0] and days_rect[2] <= row_rect[2], (row_rect, days_rect)
    assert row_rect[1] <= days_rect[1] and days_rect[3] <= row_rect[3], (row_rect, days_rect)
    labels = "".join(t[2] for t in c.texts)
    assert "自动清理" in labels and f"超过 {w._cleanup_cfg()['days']} 天" in labels, labels
    assert "的记录" in labels, labels

    # 点击路由：天数区开菜单、勾选框那侧还是开关
    opened, toggled = [], []
    w._show_cleanup_tiers = lambda x, y: opened.append((x, y))
    w._toggle_cleanup = lambda: toggled.append(True)
    w._hist_edge_at = lambda x, y: None
    st.update({"page": "list", "close": None, "chip": None, "track": None, "thumb": None,
               "fav_hit": None, "latest": None})
    cx = (days_rect[0] + days_rect[2]) / 2
    cy = (days_rect[1] + days_rect[3]) / 2
    w._hist_press(types.SimpleNamespace(x=cx, y=cy, x_root=10, y_root=20, state=0))
    assert opened == [(10, 20)], opened
    assert toggled == [], "点天数那截不该顺手开关"

    w._hist_press(types.SimpleNamespace(x=row_rect[0] + 4, y=cy, x_root=10, y_root=20, state=0))
    assert toggled == [True], toggled


def test_menu_items(tmp):
    w = make_window(tmp)
    seed(w, {"enabled": False, "days": 7})
    got = {}
    w._menu_popup = lambda x, y, items, on_pick: got.update(items=items, on_pick=on_pick)
    w._show_cleanup_tiers(100, 200)
    items = got.get("items") or []
    assert [it[1] for it in items] == [3, 7, 14, 30], items
    assert any("（当前）" in it[0] for it in items), items
    assert sum("（当前）" in it[0] for it in items) == 1, items


def main():
    test_shape()
    with tempfile.TemporaryDirectory(prefix="seenow-cleanup-") as tmp:
        test_count_matches_cleanup(tmp)
        test_defaults_and_real_cleanup(tmp)
        test_set_days(tmp)
        test_row_hit_regions(tmp)
        test_menu_items(tmp)
    print("check-cleanup-tiers: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
