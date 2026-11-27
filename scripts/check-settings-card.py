# -*- coding: utf-8 -*-
"""check-settings-card.py — 离屏画设置卡：拦「文字挤出框」和「拖走了又弹回原位」。

为什么要有它：设置卡是 380–560px 宽的自绘 Canvas，**文字没有折行、没有省略号**，
越过右边界就直接被截断。2026-11-26 格在实机上看到过一次，2026-11-27 加「折叠气泡」
时又差点重犯（拼回一行会超宽）；同一天加「保持置顶」时顺手量出另外两行本来就
已经超了（卡片最窄 456px 时 `模型能看屏幕（watch / peek / region 都可用）`
右缘 467、重启提示右缘 517）。

另一条同一天格报的：卡片能拖，但**每改一个选项就跳回默认位置** —— `_settings_paint`
原来每次都按主窗位置重算 x/y。现在位置记在 `st["pos"]`，重画 / 展开菜单都按它放；
这条也在这里验（拖动 → 重画 → 位置不动 → 拖出屏幕松手被夹回来）。

做法：**不显示窗口** —— 建一个 withdrawn 的 Tk 根 + withdrawn 的 Toplevel 画布，
直接调真实的 `LiveGlass._settings_paint`，再量每个 text item 的 bbox。窗口按最窄
（`MIN_W=480` → 卡片 456px）算：最窄放得下，宽了自然更放得下。

不读写 `~/.dsh`（DSH_VIDEO_CACHE_DIR 指到临时目录）；不碰鼠标、不弹窗。

跑法：python scripts/check-settings-card.py   （exit 0 = 全过；2 = 没有 Tk）
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
MIN_WIN_W = 480          # glass_geometry.MIN_W
CARD_PAD = 14            # 文字右缘至少留这么多空
CARD_MIN = min(560, MIN_WIN_W - 24)

try:
    import tkinter as tk
except Exception:        # noqa: BLE001 —— 没 Tk 就 SKIP，别把无桌面环境判红
    tk = None


def astr(s):
    """输出一律 ASCII：本机 stdout 是 cp936，中文过管道再按 UTF-8 解就是乱码。"""
    return str(s).encode('ascii', 'backslashreplace').decode('ascii')


class FakeMainCanvas:
    def itemconfigure(self, *_a, **_k):
        pass


class FakeSettingsWin:
    def __init__(self):
        self.calls = []

    def geometry(self, s):
        self.calls.append(s)

    def lift(self):
        pass

    def update_idletasks(self):
        pass


def paint(tmp, cfg_value):
    """按给定 keepOnTop 值画一遍卡，返回 (root, canvas, settings, 卡片几何)。"""
    (tmp / 'see-now').mkdir(parents=True, exist_ok=True)
    (tmp / 'see-now.json').write_text(
        json.dumps({} if cfg_value is None else {'keepOnTop': cfg_value}), encoding='utf-8')
    os.environ['DSH_VIDEO_CACHE_DIR'] = str(tmp / 'see-now')

    sys.path.insert(0, str(ROOT / 'examples' / 'floating-chat'))
    from window import Fonts, LiveGlass

    root = tk.Tk()
    root.withdraw()
    win = tk.Toplevel(root)
    win.withdraw()
    c = tk.Canvas(win, bg='#000000', highlightthickness=0, bd=0, width=10, height=10)
    c.pack()
    fake_win = FakeSettingsWin()

    w = object.__new__(LiveGlass)
    w._settings_path = lambda: tmp / 'see-now.json'
    w._vx, w._vy, w._vw, w._vh = 0, 0, 3840, 2160
    w._x, w._y = 300, 200
    w._geo = SimpleNamespace(width=MIN_WIN_W, height=935)
    w.fonts = Fonts(root)
    w.canvas = FakeMainCanvas()
    w._voice_menu = False
    w._scope_menu = False
    w._settings = {'win': fake_win, 'canvas': c, 'cw': 0, 'ch': 0, 'head': 68,
                   'pos': None, 'rows': [], 'hits': [], 'mode': None, 'drag': None}

    LiveGlass._settings_paint(w)
    return root, c, w, w._settings, fake_win.calls


def check_state(tmp, label, value):
    root, c, _w, st, geo = paint(tmp, value)
    try:
        cw = st['cw']
        assert cw == CARD_MIN, 'card width %r (want %r)' % (cw, CARD_MIN)
        assert geo, 'paint 没有设置卡片几何'
        keep = [r for r in st['rows']
                if r.get('kind') == 'setting' and r['row'][0] == 'keepOnTop']
        assert len(keep) == 1, '%s: 设置卡里没有 keepOnTop 行' % label
        want = True if value is None else value
        assert keep[0]['value'] == want, '%s: keepOnTop 行显示 %r' % (label, keep[0]['value'])
        assert any(h[2] is keep[0] for h in st['hits']), '%s: keepOnTop 行点不到' % label
        bad = []
        for item in c.find_all():
            if c.type(item) != 'text':
                continue
            bb = c.bbox(item)
            if bb and bb[2] > cw - CARD_PAD:
                bad.append((c.itemcget(item, 'text'), bb[2]))
        assert not bad, '%s: %d 处文字越过右边界 (card=%d): %s' % (
            label, len(bad), cw, bad)
    finally:
        root.destroy()


def parse_xy(geo):
    """从 Tk 的 `456x1374+312+280` / `+900+400` 里取 (x, y)。"""
    import re
    m = re.search(r'\+(-?\d+)\+(-?\d+)$', str(geo))
    assert m, 'bad geometry: %r' % (geo,)
    return int(m.group(1)), int(m.group(2))


def test_drag_and_repaint(tmp):
    """拖走卡片之后改选项（= 重画）**不许弹回默认位置** —— 2026-11-27 格报的。

    以前 `_settings_paint` 每次都按主窗位置重算 x/y，所以拖动只在下一次点击之前有效。
    现在位置记在 `st["pos"]`，重画 / 展开菜单都按它放；拖出屏幕时松手夹回桌面。
    """
    root, _c, w, st, calls = paint(tmp, None)
    try:
        before = parse_xy(calls[-1])
        assert st['pos'] == before, (st['pos'], before)
        assert st['ch'] > 0, st['ch']

        # 拖到 (900, 400)：几何只带位置，pos 跟着记
        st['drag'] = (0, 0)
        w.__class__._settings_drag(w, SimpleNamespace(x_root=900, y_root=400))
        assert parse_xy(calls[-1]) == (900, 400), calls[-1]
        assert st['pos'] == (900, 400), st['pos']

        # 改一个选项 = 重画：位置不变
        w.__class__._settings_paint(w)
        assert parse_xy(calls[-1]) == (900, 400), calls[-1]

        # 展开「声音」（多几行、卡片变高）：左上角仍然不动
        h0 = st['ch']
        w._voice_menu = True
        w.__class__._settings_paint(w)
        assert st['ch'] > h0, (h0, st['ch'])
        assert parse_xy(calls[-1]) == (900, 400), calls[-1]

        # 拖出屏幕：松手夹回虚拟桌面（3840x2160，卡 456 宽）
        st['drag'] = (0, 0)
        w.__class__._settings_drag(w, SimpleNamespace(x_root=5000, y_root=5000))
        w.__class__._settings_drag_end(w)
        x, y = parse_xy(calls[-1])
        assert (x, y) == st['pos'], (x, y, st['pos'])
        assert x >= 4 and y >= 4, (x, y)
        assert x + st['cw'] <= 3840 - 4, (x, st['cw'])
        assert y + st['ch'] <= 2160 - 4, (y, st['ch'])

        # 再画一遍：停在夹好的位置，不会又飘走
        w.__class__._settings_paint(w)
        assert parse_xy(calls[-1]) == (x, y), calls[-1]
    finally:
        root.destroy()


def test_dialog_owner(tmp):
    """弹窗的 Win32 owner 必须真的设到主窗上 —— 统一「弹窗跟随保持置顶」的前提。

    2026-11-27 踩出来的：Tk 只给**非 override** 的窗设 owner，`overrideredirect(True)`
    的窗 `transient` 是空操作（实测 `GetWindow(GW_OWNER)=0`）。不补 `GWLP_HWNDPARENT`，
    关掉置顶后弹窗会被自己的主窗盖住。这里用真 Win32 验：
    owner == 主窗顶层 HWND；`keepOnTop=false` 时弹窗没有 WS_EX_TOPMOST，`true` 时有。
    """
    import ctypes
    from ctypes import wintypes

    u = ctypes.windll.user32
    u.GetAncestor.argtypes = (wintypes.HWND, wintypes.UINT)
    u.GetAncestor.restype = wintypes.HWND
    u.GetWindow.argtypes = (wintypes.HWND, wintypes.UINT)
    u.GetWindow.restype = wintypes.HWND
    u.GetWindowLongPtrW.argtypes = (wintypes.HWND, ctypes.c_int)
    u.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    WS_EX_TOPMOST = 0x8
    GA_ROOT, GW_OWNER, GWL_EXSTYLE = 2, 4, -20

    sys.path.insert(0, str(ROOT / 'examples' / 'floating-chat'))
    from window import LiveGlass

    os.environ['DSH_VIDEO_CACHE_DIR'] = str(tmp / 'see-now')
    root = tk.Tk()
    root.withdraw()                  # 主窗不显示；弹窗摆屏幕外（+5000），不闪
    w = object.__new__(LiveGlass)
    w.root = root
    w._hwnd = None
    w._settings = None
    w._settings_path = lambda: tmp / 'see-now.json'

    def open_dialog():
        win = tk.Toplevel(root)
        win.overrideredirect(True)
        win.geometry('200x100+5000+5000')
        w.__class__._dialogs_topmost(w, win)
        win.deiconify()
        root.update()
        time.sleep(0.15)             # 让 after(60) 的 _own_dialog 跑掉
        root.update()
        top = int(u.GetAncestor(wintypes.HWND(win.winfo_id()), GA_ROOT) or 0)
        owner = int(u.GetWindow(wintypes.HWND(top), GW_OWNER) or 0)
        ex = int(u.GetWindowLongPtrW(wintypes.HWND(top), GWL_EXSTYLE) or 0)
        return win, owner, ex

    try:
        (tmp / 'see-now.json').write_text(json.dumps({'keepOnTop': False}), encoding='utf-8')
        win, owner, ex = open_dialog()
        want_owner = int(w._hwnd_root() or 0)
        assert owner == want_owner, 'owner=0x%X want=0x%X（override 窗的 transient 是空操作）' % (
            owner, want_owner)
        assert not (ex & WS_EX_TOPMOST), 'keepOnTop=false 时弹窗还带 topmost: ex=0x%X' % ex
        assert not bool(win.attributes('-topmost')), win.attributes('-topmost')
        win.destroy()

        (tmp / 'see-now.json').write_text(json.dumps({'keepOnTop': True}), encoding='utf-8')
        win, owner, ex = open_dialog()
        assert owner == int(w._hwnd_root() or 0), 'owner=0x%X' % owner
        assert ex & WS_EX_TOPMOST, 'keepOnTop=true 时弹窗没有 topmost: ex=0x%X' % ex
        assert bool(win.attributes('-topmost')), win.attributes('-topmost')
        win.destroy()
    finally:
        root.destroy()


def main():
    if tk is None:
        print('SKIP no tkinter')
        return 2
    try:
        with tempfile.TemporaryDirectory(prefix='seenow-card-') as td:
            tmp = Path(td)
            check_state(tmp, 'keepOnTop=默认', None)
            check_state(tmp, 'keepOnTop=true', True)
            check_state(tmp, 'keepOnTop=false', False)
            test_drag_and_repaint(tmp)
            test_dialog_owner(tmp)
    except Exception as exc:  # noqa: BLE001
        if 'Tcl' in repr(exc) or 'display' in repr(exc):
            print(astr('SKIP no display: %r' % (exc,)))
            return 2
        raise
    print('check-settings-card: all passed (no overflow at %dpx card; drag stays put)' % CARD_MIN)
    return 0


if __name__ == '__main__':
    sys.exit(main())
