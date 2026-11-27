# -*- coding: utf-8 -*-
"""check-topmost-toggle.py — 无 GUI 验「保持置顶」开关（2026-11-27）。

不创建 Tk 窗口：用 `object.__new__(LiveGlass)` 造一个没有 `__init__` 的壳
（和 `scripts/check-notif-toggle.py` 同一做法），塞假配置路径 / 假 root，直接调真实方法。
验七条契约：

  1. 默认开；只有真正的布尔 `false` 才关（字符串 `"false"` / `0` / `null` 回默认）；
  2. 关掉时看门狗**一次**撤掉 topmost，之后不再反复翻转属性；
  3. 打开时看门狗照旧每 800ms 顶一次（属性 + lift + 重排下一拍）；
  4. 折叠 / 藏起来时看门狗不抢 z 序（原有守卫不能被这次改动破坏）；
  5. 设置页那一行点一下 = 写 `see-now.json` + **当场** `_apply_topmost` + 就地重画；
  6. 重新显示 / 引用后回主窗走 `_raise_window`：关着置顶时只 lift、不再焊回最前；
     源码里也不许再出现第二处硬写的 `self.root.attributes("-topmost", True)`；
  7. 设置卡（主窗的 owned window）跟着开关走：关掉时它也退出 topmost 带，但会被 lift
     在自己主窗上面（点主窗不能把卡压住）。
  8. **已经开着**的弹窗跟着翻面（2026-11-27 补的漏）：关掉时当场退出 topmost 带，
     打开时补一条 pin 链 —— 而且只能有一条（重复翻面不许叠出第二条 400ms 链）。

不碰 Tk、不碰鼠标，也不读写 `~/.dsh`：配置落在临时目录。

跑法：python scripts/check-topmost-toggle.py   （exit 0 = 全过）
"""
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))

from window import (  # noqa: E402
    LiveGlass as Window, keep_on_top_enabled,
)

KEY = "keepOnTop"


class FakeRoot:
    """只记 Tk 调用，不建真窗口。`after` 不执行回调（由测试自己再调一次）。"""

    def __init__(self):
        self.attrs = []
        self.lifts = 0
        self.afters = []

    def attributes(self, *a):
        self.attrs.append(a)

    def lift(self):
        self.lifts += 1

    def after(self, ms, fn):
        self.afters.append((ms, fn))


def make_window(path):
    """只装开关路径真正用到的那几件东西；句柄给 0，绕开真 Win32 调用。"""
    w = object.__new__(Window)
    w._settings_path = lambda: Path(path)
    w.root = FakeRoot()
    w._hidden = False
    w._collapsed = False
    w._img_menu = None
    w._settings = None
    w._topmost_on = True
    w._hwnd = 0
    w._viewer_alive = lambda: False
    w._dialog_alive = lambda: False
    w._hwnd_root = lambda: 0
    return w


class FakeDialog:
    """假弹窗：只记 Tk 调用。`winfo_id()` 给 0，`_force_topmost` 就跳过真 Win32。"""

    def __init__(self):
        self.attrs = []
        self.afters = []
        self.lifts = 0
        self.alive = True

    def attributes(self, *a):
        self.attrs.append(a)

    def after(self, ms, fn):
        self.afters.append((ms, fn))

    def lift(self):
        self.lifts += 1

    def winfo_exists(self):
        return self.alive

    def winfo_id(self):
        return 0


def pin_chains(dlg):
    """这个弹窗身上有几条 400ms 的 pin 链（叠了就会一条变两条、再变四条）。"""
    return [a for a in dlg.afters if a[0] == 400]


def read_cfg(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_cfg(path, obj):
    # 每次写都隔一点时间：`_settings_cached` 按 (mtime_ns, size) 认变更，
    # 同尺寸的两次写在极快的测试里可能撞上同一个时间戳。
    time.sleep(0.01)
    Path(path).write_text(json.dumps(obj), encoding="utf-8")


def setting_row(key):
    for row in Window.SETTINGS_ROWS:
        if row[0] == key:
            return row
    raise AssertionError("设置页里没有 %r 这一行" % key)


def test_pure_gate():
    # 只认真正的布尔：字符串 "false" / 数字 0 / null 一律回默认（开）
    assert keep_on_top_enabled({}) is True
    assert keep_on_top_enabled({"keepOnTop": True}) is True
    assert keep_on_top_enabled({"keepOnTop": False}) is False
    assert keep_on_top_enabled({"keepOnTop": "false"}) is True
    assert keep_on_top_enabled({"keepOnTop": 0}) is True
    assert keep_on_top_enabled({"keepOnTop": None}) is True
    assert keep_on_top_enabled(None) is True


def test_row_shape():
    row = setting_row(KEY)
    assert row[1] == "保持置顶", row[1]
    assert row[2] == (True, False), row[2]
    assert row[3] == {True: "开", False: "关"}, row[3]
    assert row[4] is True, "默认必须是开（不改变加开关之前的行为）"
    assert set(row[3]) == set(row[2]), "显示名和可选值对不上（画的时候会 KeyError）"
    assert set(row[5]) == {True, False}, row[5]
    assert all(str(v).strip() for v in row[5].values()), row[5]
    # 它必须排在「即时生效」那组里：设置卡把这段提示放在 `SETTINGS_ROWS` 之前，
    # 行序就是「屏幕读取 / 关窗后 / 折叠气泡 / 保持置顶」——行跑出这组就说明放错位置了。
    keys = [r[0] for r in Window.SETTINGS_ROWS]
    assert keys.index(KEY) == keys.index("collapsedBubble") + 1, keys


def test_watchdog(tmp):
    cfg = Path(tmp) / "see-now.json"
    write_cfg(cfg, {})
    w = make_window(cfg)

    # 默认开：照旧顶一次（属性 + lift + 重排 800ms 后的下一拍）
    w._keep_on_top()
    assert w._topmost_on is True
    assert w.root.attrs == [("-topmost", True)], w.root.attrs
    assert w.root.lifts == 1, w.root.lifts
    assert w.root.afters and w.root.afters[0][0] == 800, w.root.afters

    # 关掉：下一拍撤 topmost，且只撤一次（每 800ms 重复翻转会让窗闪、也多一次系统调用）
    write_cfg(cfg, {KEY: False})
    w._keep_on_top()
    assert w._topmost_on is False, w._topmost_on
    assert w.root.attrs[-1] == ("-topmost", False), w.root.attrs
    n_attrs = len(w.root.attrs)
    w._keep_on_top()
    assert len(w.root.attrs) == n_attrs, "关着时不该反复翻转属性: %r" % (w.root.attrs,)
    assert w.root.afters[-1][0] == 800, "看门狗自己还要接着排下一拍（配置可能改回来）"

    # 打开：恢复顶
    write_cfg(cfg, {KEY: True})
    w.root.lifts = 0
    w._keep_on_top()
    assert w.root.attrs[-1] == ("-topmost", True), w.root.attrs
    assert w._topmost_on is True
    assert w.root.lifts == 1, "重新打开时要把窗叫回前面"

    # 原有守卫：折叠 / 藏起来时不抢 z 序（这条和开关无关）
    n_attrs = len(w.root.attrs)
    w._collapsed = True
    w._keep_on_top()
    assert len(w.root.attrs) == n_attrs, w.root.attrs
    w._collapsed = False
    w._hidden = True
    w._keep_on_top()
    assert len(w.root.attrs) == n_attrs, w.root.attrs


def test_card_follows_toggle(tmp):
    """设置卡（主窗的 owned window）也得跟着开关 —— 2026-11-27 格问的。

    关掉置顶后卡片也应退出 topmost 带（别的应用能盖住），但仍要 lift 在自己主窗上面，
    不能点一下主窗就把设置卡压住。
    """
    cfg = Path(tmp) / "see-now.json"
    write_cfg(cfg, {})
    w = make_window(cfg)
    card = FakeRoot()
    w._settings = {"win": card}

    w._apply_topmost(False)
    assert w.root.attrs[-1] == ("-topmost", False), w.root.attrs
    assert card.attrs and card.attrs[-1] == ("-topmost", False), card.attrs
    assert card.lifts == 1, "卡片要重新 lift，别被自己的主窗压住"

    w._apply_topmost(True)
    assert w.root.attrs[-1] == ("-topmost", True), w.root.attrs
    assert card.attrs[-1] == ("-topmost", True), card.attrs
    assert card.lifts == 2, card.lifts


def test_raise_window(tmp):
    cfg = Path(tmp) / "see-now.json"
    write_cfg(cfg, {KEY: False})
    w = make_window(cfg)
    # 关着置顶：显示回来只 lift，不许再焊回 topmost（否则关掉一被"显示"就失效）
    w._raise_window()
    assert w.root.attrs == [], w.root.attrs
    assert w.root.lifts == 1, w.root.lifts

    write_cfg(cfg, {KEY: True})
    w._raise_window()
    assert w.root.attrs[-1] == ("-topmost", True), w.root.attrs
    assert w._topmost_on is True
    assert w.root.lifts == 2, "开着时 lift 一次（_apply_topmost 里那次）"

    # 手改坏类型：按默认（开）处理，不能静默变成不置顶
    write_cfg(cfg, {KEY: "false"})
    w2 = make_window(cfg)
    w2._raise_window()
    assert w2.root.attrs[-1] == ("-topmost", True), w2.root.attrs


def test_click(tmp):
    cfg = Path(tmp) / "see-now.json"
    write_cfg(cfg, {"session": "session-x"})
    w = make_window(cfg)
    applied = []
    rebuilt = []

    def fake_apply(on):
        applied.append(on)
        w._topmost_on = on

    w._apply_topmost = fake_apply
    w._settings_rebuild = lambda: rebuilt.append(True)
    w._settings = {"win": None}
    row = {"kind": "setting", "row": setting_row(KEY), "value": True}

    # 点一下：写盘（整份合并，不抹掉别的键）、当场生效、就地重画
    w._settings_cycle(row)
    data = read_cfg(cfg)
    assert data[KEY] is False, data
    assert data.get("session") == "session-x", data
    assert row["value"] is False
    assert applied == [False], applied
    assert len(rebuilt) == 1, rebuilt

    # 再点一下：回到开
    w._settings_cycle(row)
    assert read_cfg(cfg)[KEY] is True, read_cfg(cfg)
    assert row["value"] is True
    assert applied == [False, True], applied
    assert len(rebuilt) == 2, rebuilt


def test_open_dialogs_follow(tmp):
    """已经开着的弹窗也要跟着翻面 —— 2026-11-27 交接文里的「已知边界」。

    以前弹窗的 topmost 位只在创建那一刻定一次：先开确认框、再去设置页关掉置顶，
    那张确认框会留在 topmost 带里，而且再没有代码去撤它（`_pin_topmost` 关着时
    只是不再排下一拍）。补的时候有两个坑：重复翻面不许叠第二条链、窗口销毁后
    不许再碰（TclError 会把整条看门狗带下去）。
    """
    cfg = Path(tmp) / "see-now.json"
    write_cfg(cfg, {})
    w = make_window(cfg)
    dlg = FakeDialog()
    w._dialogs_topmost(dlg)                     # 创建即登记 + 按当前配置定档
    assert dlg.attrs[-1] == ("-topmost", True), dlg.attrs

    # 关掉：开着的弹窗当场退出 topmost 带
    w._apply_topmost(False)
    assert dlg.attrs[-1] == ("-topmost", False), dlg.attrs

    # 打开：回到带上，并且只补一条链
    w._apply_topmost(True)
    assert dlg.attrs[-1] == ("-topmost", True), dlg.attrs
    assert len(pin_chains(dlg)) == 1, pin_chains(dlg)
    w._apply_topmost(True)
    w._apply_topmost(True)
    assert len(pin_chains(dlg)) == 1, "重复翻面叠出了第二条 400ms 链: %r" % (pin_chains(dlg),)

    # 手改配置（不走设置页）：看门狗翻面时也要跟上
    write_cfg(cfg, {KEY: False})
    w._keep_on_top()
    assert dlg.attrs[-1] == ("-topmost", False), dlg.attrs
    # 关着的时候不补链
    n = len(pin_chains(dlg))
    w._follow_dialogs_topmost(False)
    assert len(pin_chains(dlg)) == n, "关着置顶时还在补链: %r" % (pin_chains(dlg),)

    # 窗口销毁：登记表要自己收干净，不能对死窗口调 Tk
    dlg.alive = False
    write_cfg(cfg, {KEY: True})
    w._keep_on_top()
    assert w._dlgs == [], "销毁的弹窗还留在登记表里: %r" % (w._dlgs,)


def test_source_guard():
    """源码守卫：主窗只允许看门狗那一处硬写 topmost=True。

    以后新增「把窗叫到前面」的入口（`_sync_visible` / 协议 show / 引用回主窗等）
    必须走 `_raise_window()`，否则关掉置顶后会被重新焊回最前面 —— 那是个只在
    关掉开关后才出现的 bug，很难靠随手点一遍发现。
    """
    src = (ROOT / "examples" / "floating-chat" / "window.py").read_text(encoding="utf-8")
    hard = src.count('self.root.attributes("-topmost", True)')
    assert hard == 1, (
        '硬写 self.root.attributes("-topmost", True) 的地方有 %d 处（只允许 _keep_on_top 里那一处）；'
        "要抬主窗请用 _raise_window() / _apply_topmost()" % hard)
    assert src.count("_raise_window()") >= 3, "显示 / 引用回主窗那几个入口没走 _raise_window()"
    # 弹窗（设置卡 / 回顾窗 / 图查看器 / 确认框 / 菜单）一律走 _dialogs_topmost：
    # 它负责「跟随 keepOnTop + 设 Win32 owner」。别再出现硬写弹窗 topmost 的地方。
    assert 'win.attributes("-topmost", True)' not in src, (
        "有弹窗硬写 topmost=True；改走 _dialogs_topmost(win)，否则关掉置顶后它还压着所有应用")
    assert src.count("_dialogs_topmost(") >= 9, (
        "_dialogs_topmost 的调用点少了：现在窗口 + 8 个弹窗都应该走它")
    # 开关翻面要能改**已经开着**的弹窗：设置页那条路（_apply_topmost）和手改配置
    # 后的看门狗（_keep_on_top）都得调它。只留一条 = 换个入口翻面就漏一半。
    assert src.count("_follow_dialogs_topmost(") >= 3, (
        "_follow_dialogs_topmost 只在定义处出现：_apply_topmost / _keep_on_top 都要调，"
        "否则「弹窗开着时切开关」还是旧的半套")
    assert "_see_now_pin" in src, (
        "pin 链没有去重标记：补链会叠出第二条 400ms 链（_pin_topmost 自己 after 自己）")


def main():
    test_pure_gate()
    test_row_shape()
    test_source_guard()
    with tempfile.TemporaryDirectory(prefix="seenow-topmost-") as tmp:
        test_watchdog(tmp)
        test_card_follows_toggle(tmp)
        test_open_dialogs_follow(tmp)
        test_raise_window(tmp)
        test_click(tmp)
    print("check-topmost-toggle: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
