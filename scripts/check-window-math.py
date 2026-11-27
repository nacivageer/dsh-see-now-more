# -*- coding: utf-8 -*-
"""check-window-math.py — 窗口落位与滚轮的纯算术，不开窗、不碰鼠标、不用 Tk。

为什么要有它：`window_math.py` 是从 `window.py` 里抽出来的（2026-11-27）。抽取唯一
的风险是"顺手把行为改了"，所以这里**不重写一遍断言** —— 把抽取前的旧公式原样抄成
参照实现，再用一组输入（含第二块屏在左边的负坐标）逐点对比。参照实现改了就等于
给新的让路，所以它是逐字的、不许"顺手优化"。

三组：
  1. `clamp_into`    vs 旧 `_settings_clamp_pos`（边距 4）
  2. `place_dialog`  vs 旧的四份手抄（边距 8 / 竖向 //3）与看图窗（边距 0 / //2）
  3. `wheel_scroll`  一格 = 70px、触控板小 delta 累积、撞边界丢余量

外加一条静态守卫：那几行公式不许再抄回 `window.py`（抄回来就红）。

跑法：python scripts/check-window-math.py   （exit 0 = 全过；2 = 找不到模块）
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'examples' / 'floating-chat'))

try:
    from window_math import clamp_into, place_dialog, wheel_scroll  # noqa: E402
except Exception as exc:          # noqa: BLE001
    print('SKIP  cannot import window_math: %r' % (exc,))
    sys.exit(2)

FAILED = []


def check(cond, what):
    if cond:
        print('ok    %s' % what)
    else:
        print('FAIL  %s' % what)
        FAILED.append(what)


# ---------------------------------------------------------------- 参照实现
# 见文件头：逐字取自抽取前的 window.py，**不许改**（改了就不再是等价性验收）。
# `_settings_clamp_pos`：
def ref_clamp(x, y, cw, ch, vx, vy, vw, vh, margin=4):
    x = int(max(vx + margin, min(int(x), vx + vw - cw - margin)))
    y = int(max(vy + margin, min(int(y), vy + vh - ch - margin)))
    return x, y


# 四份对话框手抄 + 看图窗：
def ref_dialog(win_x, win_y, win_w, win_h, w, h, vx, vy, vw, vh, margin=8, y_div=3):
    x = max(vx + margin, min(win_x + (win_w - w) // 2, vx + vw - w - margin))
    y = max(vy + margin, min(win_y + (win_h - h) // y_div, vy + vh - h - margin))
    return x, y


# 滚轮（抽取前是 `_hist_wheel` 里连着写的五行）：
def ref_wheel(delta, acc, scroll, max_scroll, step=70, notch=120):
    acc = float(acc or 0.0) - float(delta) / notch * step
    whole = int(acc)
    rest = acc - whole
    if not whole:
        return scroll, rest, False
    before = scroll
    scroll = max(0, min(max_scroll, before + whole))
    if scroll == before:
        rest = 0.0
    return scroll, rest, True


# ---------------------------------------------------------------- 1. 夹取
DESKTOPS = [
    (0, 0, 1920, 1080),            # 单屏
    (-1920, 0, 3840, 1080),        # 副屏在左（vx 为负）
    (0, -200, 2560, 1440),         # 上边负
    (1920, 0, 1920, 1080),         # 主屏右边第二块
]
CARDS = [(0, 0, 460, 210), (1919, 1079, 460, 210), (-3000, -3000, 500, 250),
         (100, 100, 380, 160), (960, 540, 1200, 900)]
clamp_bad = 0
for bx, by, bw, bh in DESKTOPS:
    for cx, cy, cw, ch in CARDS:
        got = clamp_into(cx, cy, cw, ch, (bx, by, bw, bh), margin=4)
        want = ref_clamp(cx, cy, cw, ch, bx, by, bw, bh, 4)
        if got != want:
            clamp_bad += 1
            print('  mismatch clamp (%r,%r,%rx%r) desk=%r: got %r want %r'
                  % (cx, cy, cw, ch, (bx, by, bw, bh), got, want))
check(clamp_bad == 0, 'clamp_into == 旧 _settings_clamp_pos（%d 组用例）'
      % (len(DESKTOPS) * len(CARDS)))

# 边界单独钉一条：比桌面还大的卡片停在左上角（右边溢出，和以前一致）
big = clamp_into(500, 500, 4000, 3000, (0, 0, 1920, 1080), margin=4)
check(big == (4, 4), 'oversized card pinned to top-left, got %r' % (big,))

# ---------------------------------------------------------------- 2. 落位
WINDOWS = [(100, 120, 760, 608), (-1200, 40, 760, 560), (1500, 800, 900, 700)]
DIALOGS = [(460, 210), (500, 250), (1200, 900)]
dialog_bad = 0
for wx, wy, ww, wh in WINDOWS:
    for dx, dy, dw, dh in DESKTOPS:
        for cw, ch in DIALOGS:
            got = place_dialog(wx, wy, ww, wh, cw, ch, (dx, dy, dw, dh))
            want = ref_dialog(wx, wy, ww, wh, cw, ch, dx, dy, dw, dh, 8, 3)
            if got != want:
                dialog_bad += 1
                print('  mismatch dialog win=%r card=%r: got %r want %r'
                      % ((wx, wy, ww, wh), (cw, ch), got, want))
check(dialog_bad == 0, 'place_dialog == 旧手抄公式（边距 8 / 竖向 //3，%d 组）'
      % (len(WINDOWS) * len(DESKTOPS) * len(DIALOGS)))

# 看图窗那一套（边距 0 / 竖向 //2）
view_bad = 0
for wx, wy, ww, wh in WINDOWS:
    for cw, ch in [(400, 300), (1400, 1000), (1920, 1080)]:
        got = place_dialog(wx, wy, ww, wh, cw, ch, (0, 0, 1920, 1080), margin=0, y_div=2)
        want = ref_dialog(wx, wy, ww, wh, cw, ch, 0, 0, 1920, 1080, 0, 2)
        if got != want:
            view_bad += 1
            print('  mismatch viewer card=%r: got %r want %r' % ((cw, ch), got, want))
check(view_bad == 0, 'place_dialog(margin=0,y_div=2) == 旧看图窗公式（%d 组）'
      % (len(WINDOWS) * 3))

# ---------------------------------------------------------------- 3. 滚轮
s, a, moved = wheel_scroll(120, 0, 100, 1000)
check((s, a, moved) == (30, 0.0, True), 'one notch up = -70px, got %r' % ((s, a, moved),))
s, a, moved = wheel_scroll(-120, 0, 100, 1000)
check((s, a, moved) == (170, 0.0, True), 'one notch down = +70px, got %r' % ((s, a, moved),))

# 触控板一次 15：只走 8px（不是一整格 70），剩下的 -0.75 攒着
s, a, moved = wheel_scroll(15, 0, 100, 1000)
check((s, moved) == (92, True) and abs(a + 0.75) < 1e-9,
      'trackpad 15 moves 8px only (not a whole notch), got %r' % ((s, a, moved),))
scroll, acc = 100, 0.0
for _ in range(8):
    scroll, acc, _m = wheel_scroll(15, acc, scroll, 1000)
check(scroll == 30, '8 x 15 (=120) accumulates to exactly one notch, got scroll=%r acc=%r'
      % (scroll, acc))

# 撞到下界：丢余量
s, a, moved = wheel_scroll(120, 0, 0, 1000)
check((s, a, moved) == (0, 0.0, True), 'at top edge: acc dropped, got %r' % ((s, a, moved),))
s, a, _m = wheel_scroll(15, 0, 0, 1000)                 # 先攒一点负余量
s, a, moved = wheel_scroll(120, a, s, 1000)             # 再撞墙
check((s, a) == (0, 0.0), 'clamped wheel drops the carried remainder, got %r' % ((s, a),))
# 撞到下界之后往回滚，立即就动（没留"欠账"要先空走几格）
s, a, moved = wheel_scroll(-15, a, s, 1000)
check((s, moved) == (8, True), 'after clamping, reverse moves immediately, got %r'
      % ((s, a, moved),))

# 上界
s, a, moved = wheel_scroll(-120, 0, 990, 1000)
check((s, a, moved) == (1000, 0.0, True), 'at bottom edge clamps to max, got %r'
      % ((s, a, moved),))

# ---------------------------------------------------------------- 4. 静态守卫
src = (ROOT / 'examples' / 'floating-chat' / 'window.py').read_text(encoding='utf-8')
for snippet, why in [
    ('(self._geo.width - w) // 2', 'dialog/viewer centering formula'),
    ('self._vw - cw - 4', '_settings_clamp_pos arithmetic'),
    ('/ 120.0 * 70.0', 'wheel conversion'),
]:
    check(snippet not in src, 'window.py no longer inlines the %s' % why)

print()
if FAILED:
    print('check-window-math: %d FAILED' % len(FAILED))
    sys.exit(1)
print('check-window-math: all passed')
