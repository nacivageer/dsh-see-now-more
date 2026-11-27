"""window_math.py — 悬浮窗里那些能离开 Tk 算的数：落位与滚轮位移。

为什么单独一个文件（2026-11-27）：这两件事原来都长在 `window.py` 的 `LiveGlass` 里 ——
「对话框水平居中 + 竖向偏上 1/3 + 夹进虚拟桌面」那三行一字不差抄了四遍（清理确认卡、
删除会话、重命名、隐藏气泡各一份），设置卡的夹取是第五份（边距 4 而不是 8）、
看图窗是第六份（边距 0、竖向 //2），滚轮换算再一份。
它们不碰 Tk、不碰 Win32，只做整数运算，却只能在「建一个 withdrawn 的 Tk 根 +
`object.__new__(LiveGlass)` 塞假字段」的环境里验；没有桌面 / 没有 tkinter 的机器上，
那条检查只能 SKIP。

搬出来之后是纯函数：`scripts/check-window-math.py` 用旧公式当参照逐组对比，
证明抽取没改行为（等价性测试，不是重写一遍断言）。

**别往这里加需要 self / Tk / Win32 / 文件系统的东西** —— 加了就回到「只能开窗验」的老路。
"""

from __future__ import annotations


def clamp_into(x, y, w: int, h: int, bounds, margin: int = 4) -> tuple:
    """把矩形左上角 `(x, y)` 夹进虚拟桌面，四周留 `margin`。

    `bounds` = `(vx, vy, vw, vh)`；第二块屏在主屏左边时 `vx` 是负数，照常成立。
    顶 / 左边优先：矩形比桌面还大时停在左上角，右边溢出（和以前一致）。
    """
    vx, vy, vw, vh = bounds
    x = int(max(vx + margin, min(int(x), vx + vw - w - margin)))
    y = int(max(vy + margin, min(int(y), vy + vh - h - margin)))
    return x, y


def place_dialog(win_x, win_y, win_w: int, win_h: int,
                 w: int, h: int, bounds, margin: int = 8,
                 y_div: int = 3) -> tuple:
    """对话框摆在主窗里：水平居中、竖向偏上，再夹进虚拟桌面。

    `y_div=3`（默认）给卡片类弹窗：竖向只到三分之一处 —— 这类卡片底下常接着输入框 /
    列表，偏上更不容易被自己的主窗边角压住（2026-11-27 之前几份手抄的公式都是 `// 3`）。
    `y_div=2` 是真居中，给看图窗那种「整块画面」用的。
    """
    x = int(win_x) + (int(win_w) - int(w)) // 2
    y = int(win_y) + (int(win_h) - int(h)) // int(y_div)
    return clamp_into(x, y, w, h, bounds, margin)


def wheel_scroll(delta, acc, scroll, max_scroll: int,
                 step: int = 70, notch: int = 120) -> tuple:
    """滚轮 → `(新偏移, 新余量, 是否走了一格)`。

    `delta` 是 Tk 的 `e.delta`：普通滚轮一格 ±120，精密触控板会给 15 / 30 这种小值。
    按 `delta / notch × step` 换成浮点位移，余量积在 `acc` 里，攒够 1px 才动 ——
    只判方向的旧写法会把触控板的小 delta 也当成一整格，一划就冲过头。

    撞到 0 / `max_scroll` 时**丢余量**：否则往回滚要先空走「撞墙」那几格才动。

    第三个返回值是「这一次换算要不要了一格位移」，调用方拿它决定要不要排重画 ——
    注意余量在没走格的时候也**已经变了**，返回前就要写回，不能等走了才写。
    """
    acc = float(acc or 0.0) - float(delta) / float(notch) * float(step)
    whole = int(acc)                     # 向零取整：上下滚的余量各记各的
    rest = acc - whole
    if not whole:
        return scroll, rest, False
    before = int(scroll)
    scroll = max(0, min(int(max_scroll), before + whole))
    if scroll == before:
        rest = 0.0                       # 撞到头：余量清零
    return scroll, rest, True
