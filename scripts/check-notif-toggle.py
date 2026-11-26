# -*- coding: utf-8 -*-
"""check-notif-toggle.py — 无 GUI 验「折叠气泡」开关。

不创建 Tk 窗口：用 `object.__new__(LiveGlass)` 造一个没有 `__init__` 的壳
（和 `scripts/check-quote.py` 同一做法），塞假配置路径 / 假 canvas，直接调真实方法。
验四条契约：

  1. 默认开；只有真正的布尔 `false` 才关（字符串 `"false"` 是真值，不能反着来）；
  2. 关掉时 `_maybe_notify` 不弹气泡，开着时照常；只挑 assistant；
  3. 设置页那一行点一下 = 写 `see-now.json` + 立即翻面；
  4. 关掉时顺手把正在飘的气泡收回折叠条（窗高回到 `collapsed_height()`）。

不碰 Tk、不碰鼠标，也不读写 `~/.dsh`：配置落在临时目录。

跑法：python scripts/check-notif-toggle.py   （exit 0 = 全过）
"""
import json
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))

from window import (  # noqa: E402
    LiveGlass as Window, collapsed_height, notify_bubble_enabled,
)

KEY = "collapsedBubble"


class FakeCanvas:
    def itemconfigure(self, *_a, **_k):
        pass


class FakeFont:
    def measure(self, s):
        return len(str(s)) * 7


class FakeFonts:
    def get(self, *_a, **_k):
        return FakeFont()


def make_window(path):
    """只装开关路径真正用到的那几件东西；其余方法被替身挡住。"""
    w = object.__new__(Window)
    w._settings_path = lambda: Path(path)
    w.fonts = FakeFonts()
    w._settings = None
    w._collapsed = True
    w._notif = None
    w._notif_msg = None
    w._shown = []
    w._hidden = 0
    w._rebuilds = 0
    w._show_notification = lambda msg=None: w._shown.append(msg)
    w._hide_notification = lambda: setattr(w, "_hidden", w._hidden + 1)
    w._settings_rebuild = lambda: setattr(w, "_rebuilds", w._rebuilds + 1)
    return w


def read_cfg(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def setting_row(key):
    for row in Window.SETTINGS_ROWS:
        if row[0] == key:
            return row
    raise AssertionError("设置页里没有 %r 这一行" % key)


def test_pure_gate():
    # 只认真正的布尔：字符串 "false" / 数字 0 / null 一律回默认（开）
    assert notify_bubble_enabled({}) is True
    assert notify_bubble_enabled({"collapsedBubble": True}) is True
    assert notify_bubble_enabled({"collapsedBubble": False}) is False
    assert notify_bubble_enabled({"collapsedBubble": "false"}) is True
    assert notify_bubble_enabled({"collapsedBubble": 0}) is True
    assert notify_bubble_enabled({"collapsedBubble": None}) is True


def test_row_shape():
    row = setting_row(KEY)
    assert row[1] == "折叠气泡", row[1]
    assert row[2] == (True, False), row[2]
    assert row[3] == {True: "开", False: "关"}, row[3]
    assert row[4] is True, "默认必须是开（不改变加开关之前的行为）"
    assert set(row[3]) == set(row[2]), "显示名和可选值对不上（画的时候会 KeyError）"
    assert set(row[5]) == {True, False}, row[5]


def test_maybe_notify(tmp):
    cfg = Path(tmp) / "see-now.json"
    msg = {"role": "assistant", "text": "来了"}
    w = make_window(cfg)

    # 没配过 = 开
    w._maybe_notify([msg])
    assert w._shown == [msg], w._shown

    # 关掉 = 一条都不弹
    w._shown = []
    cfg.write_text(json.dumps({KEY: False}), encoding="utf-8")
    w._maybe_notify([msg])
    assert w._shown == [], w._shown

    # 开着时也只挑 assistant；user 消息本来就不弹
    cfg.write_text(json.dumps({KEY: True}), encoding="utf-8")
    w._maybe_notify([{"role": "user", "text": "我说的"}])
    assert w._shown == [], w._shown
    w._maybe_notify([msg])
    assert w._shown == [msg], w._shown

    # 展开态本来就不弹（这条不受开关影响）
    w._shown = []
    w._collapsed = False
    w._maybe_notify([msg])
    assert w._shown == [], w._shown
    w._collapsed = True

    # 写错的类型不能把气泡静默关掉
    w._shown = []
    cfg.write_text(json.dumps({KEY: "false"}), encoding="utf-8")
    w._maybe_notify([msg])
    assert w._shown == [msg], w._shown


def test_click(tmp):
    cfg = Path(tmp) / "see-now.json"
    cfg.write_text(json.dumps({}), encoding="utf-8")
    w = make_window(cfg)
    # 设置页画出来的命中行：{"kind": "setting", "row": …, "value": 当前值}
    row = {"kind": "setting", "row": setting_row(KEY), "value": True}
    w._settings = {"head": 68, "cw": 420, "canvas": FakeCanvas(),
                   "hits": [(68, 136, row)], "rows": [], "win": None}

    # 点一下：写盘、翻面、并且收回正在飘的气泡
    w._notif_msg = {"role": "assistant", "text": "旧气泡"}
    w._settings_click(types.SimpleNamespace(x=200, y=100, x_root=0, y_root=0))
    assert read_cfg(cfg)[KEY] is False, read_cfg(cfg)
    assert row["value"] is False
    assert w._hidden == 1, "关掉时没有收回正在显示的气泡"
    assert w._rebuilds == 1, "带小字的行改完要就地重画"

    # 再点一下：回到开，不用收回动作（本来也没气泡）
    w._hidden = 0
    w._settings_click(types.SimpleNamespace(x=200, y=100, x_root=0, y_root=0))
    assert read_cfg(cfg)[KEY] is True, read_cfg(cfg)
    assert row["value"] is True
    assert w._hidden == 0, "打开时不该调收回"


def test_hide_restores_bar():
    """`_hide_notification` 要真的把窗缩回折叠条高度，不能只清状态。"""
    w = object.__new__(Window)
    w._collapsed = True
    w._notif = {"bubble": (20, 86, 460, 300)}
    w._notif_msg = {"role": "assistant", "text": "旧气泡"}
    w._notif_scroll = 12
    w._notif_img_hits = []
    w._geo = types.SimpleNamespace(width=480, height=900)
    w._x, w._y = 30, 40
    w._sync_pos = lambda: None
    w._grab_collapsed_bg = lambda: None
    w._layout = lambda seed=False: None
    geometry = []

    def set_geometry(geo):
        geometry.append(geo)
    w._set_geometry = set_geometry
    w.root = types.SimpleNamespace(
        geometry=lambda s: geometry.append(("root", s)))

    Window._hide_notification(w)
    assert w._notif is None and w._notif_msg is None, "没清气泡状态"
    assert geometry[0].height == collapsed_height(), geometry[0].height
    assert geometry[1] == ("root", "480x%d+30+40" % collapsed_height()), geometry[1]

    # 没有气泡时是空操作（设置页连点两下不该重排）
    w._notif = None
    w._notif_msg = None
    geometry.clear()
    Window._hide_notification(w)
    assert geometry == [], geometry


def main():
    test_pure_gate()
    test_row_shape()
    with tempfile.TemporaryDirectory(prefix="seenow-notif-") as tmp:
        test_maybe_notify(tmp)
        test_click(tmp)
    test_hide_restores_bar()
    print("check-notif-toggle: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
