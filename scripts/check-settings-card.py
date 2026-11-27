# -*- coding: utf-8 -*-
"""check-settings-card.py — 离屏画一遍设置卡，拦「新加一行把文字挤到框外」。

为什么要有它：设置卡是 380–560px 宽的自绘 Canvas，**文字没有折行、没有省略号**，
越过右边界就直接被截断。2026-11-26 格在实机上看到过一次，2026-11-27 加「折叠气泡」
时又差点重犯（拼回一行会超宽）；同一天加「保持置顶」时顺手量出另外两行本来就
已经超了（卡片最窄 456px 时 `模型能看屏幕（watch / peek / region 都可用）`
右缘 467、重启提示右缘 517）。

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
    w._settings = {'win': fake_win, 'canvas': c, 'cw': 0, 'head': 68,
                   'rows': [], 'hits': [], 'mode': None, 'drag': None}

    LiveGlass._settings_paint(w)
    return root, c, w._settings, fake_win.calls


def check_state(tmp, label, value):
    root, c, st, geo = paint(tmp, value)
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
    except Exception as exc:  # noqa: BLE001
        if 'Tcl' in repr(exc) or 'display' in repr(exc):
            print(astr('SKIP no display: %r' % (exc,)))
            return 2
        raise
    print('check-settings-card: all passed (overflow none at %dpx card)' % CARD_MIN)
    return 0


if __name__ == '__main__':
    sys.exit(main())
