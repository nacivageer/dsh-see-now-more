#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pointer.py — 在屏幕上圈一个位置，然后**停住等一个信号**，stdout 吐一行 JSON。

只干一件事：画 + 等。不读文字、不截图给人看、不判「你做对了没有」。

参数从环境变量 `DSH_POINTER_ARGS`（JSON）来，不走命令行：
Windows 的命令行引号能把一个中文 label 折腾掉半条命，env 里传原样字符串。

退出码：0 = 有信号（click / change / timeout / none）；2 = 用户取消（Esc / 右键）；3 = 参数或环境错。

信号语义（重要，别读成结论）：
- `click`  = 左键按下瞬间，光标落在圈里（inside=true）还是圈外（false）
- `change` = **那个坐标上换了个窗口**（`WindowFromPoint` 的句柄变了，比如菜单/对话框/新窗口
             在那儿开出来）。它只说明「那儿出现了别的窗口」，不说明「你做对了」；
             内容变了但窗口没变（翻页、滚动、视频）不会触发。
- `timeout`= 到点没信号
"""

import ctypes
import json
import os
import sys
import time

KEY_COLOR = '#010203'          # 要被 transparentcolor 吃掉的底色（选一个几乎不会出现在画面里的颜色）
RING = '#FF3B30'
TEXT_BG = '#1A1A1A'
TEXT_FG = '#FFFFFF'

# 排查用：DSH_POINTER_DEBUG=1 时把每次采样的变化比例打到 stderr（不影响 stdout 的 JSON）
DEBUG = os.environ.get('DSH_POINTER_DEBUG') == '1'


def dbg(msg):
    if DEBUG:
        sys.stderr.write('[pointer] %s\n' % msg)
        sys.stderr.flush()


class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]

# 变化判定的三个常数：阈值 3%、采样间隔 200ms、连续命中 2 次才算数
# （连续命中而不是「变了又稳住」：菜单一开就一直开着，等它稳住等于永远等不到；
#   代价是动画/加载圈也会触发，所以在文档里写明「这只说明那块画面确实变了」）
# `change` 的判定在 tick 里：每 200ms 问一次 WindowFromPoint(x,y)，句柄变了就算。
# 不走像素比对的原因写在 base_hwnd 那段注释里（2026-11-20 实测）。


def fail(reason, detail=''):
    sys.stdout.write(json.dumps({'event': 'error', 'reason': reason, 'detail': str(detail)[:400]},
                                ensure_ascii=False) + '\n')
    sys.stdout.flush()
    sys.exit(3)


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def load_args():
    raw = os.environ.get('DSH_POINTER_ARGS') or ''
    try:
        a = json.loads(raw) if raw else {}
    except Exception as e:  # noqa: BLE001
        fail('bad-args', 'DSH_POINTER_ARGS 不是 JSON：%s' % e)
        return {}
    if not isinstance(a, dict):
        fail('bad-args', 'DSH_POINTER_ARGS 不是对象')
    return a


def dpi_aware():
    """先声明 DPI aware 再建窗：不然 125% 缩放下 Tk 的坐标是逻辑像素，圈会画偏。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except Exception:  # noqa: BLE001
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass


def screen_size():
    u = ctypes.windll.user32
    return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))


def click_through(root):
    """整窗鼠标穿透：我们靠全局轮询拿点击，不靠窗口收消息。"""
    GWL_EXSTYLE = -20
    WS_EX_LAYERED = 0x00080000
    WS_EX_TRANSPARENT = 0x00000020
    u = ctypes.windll.user32
    hwnd = u.GetParent(root.winfo_id()) or root.winfo_id()
    ex = u.GetWindowLongW(hwnd, GWL_EXSTYLE)
    u.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED | WS_EX_TRANSPARENT)


def draw(canvas, x, y, r, shape, label):
    if shape == 'arrow':
        canvas.create_line(x - r, y + r, x, y, fill=RING, width=5, arrow='last', arrowshape=(18, 22, 8))
    elif shape == 'box':
        canvas.create_rectangle(x - r, y - r, x + r, y + r, outline=RING, width=4)
    else:
        canvas.create_oval(x - r, y - r, x + r, y + r, outline=RING, width=4)
    if label:
        tx, ty = x + r + 12, y - 12
        tid = canvas.create_text(tx + 6, ty, text=label, fill=TEXT_FG, anchor='w',
                                 font=('Microsoft YaHei UI', 14))
        bb = canvas.bbox(tid)
        if bb:
            canvas.create_rectangle(bb[0] - 6, bb[1] - 4, bb[2] + 6, bb[3] + 4,
                                    fill=TEXT_BG, outline='', width=0)
            canvas.tag_raise(tid)


def run():
    dpi_aware()
    a = load_args()

    try:
        x = int(a['x'])
        y = int(a['y'])
    except Exception:  # noqa: BLE001
        fail('bad-args', 'x / y 必填且要是整数')
        return 3

    shape = str(a.get('shape') or 'circle').lower()
    if shape not in ('circle', 'arrow', 'box'):
        fail('bad-args', 'shape 只能是 circle / arrow / box')
    label = str(a.get('label') or '')
    if not label.strip():
        fail('bad-args', 'label 必填（不许画空白圈）')
    truncated = len(label) > 40
    if truncated:
        label = label[:40]

    wait = str(a.get('wait') or 'click').lower()
    if wait not in ('click', 'change', 'none'):
        fail('bad-args', 'wait 只能是 click / change / none')
    try:
        wait_ms = int(a.get('waitMs') or 20000)
    except Exception:  # noqa: BLE001
        fail('bad-args', 'waitMs 要是整数')
        return 3
    wait_ms = max(1000, min(120000, wait_ms))
    try:
        radius = int(a.get('radius') or 60)
    except Exception:  # noqa: BLE001
        fail('bad-args', 'radius 要是整数')
        return 3
    radius = max(20, min(400, radius))

    sw, sh = screen_size()
    if not (0 <= x < sw and 0 <= y < sh):
        fail('out-of-screen', '坐标 (%d,%d) 不在主屏 %dx%d 里' % (x, y, sw, sh))
        return 3

    import tkinter as tk
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes('-topmost', True)
    try:
        root.attributes('-transparentcolor', KEY_COLOR)
    except Exception:  # noqa: BLE001
        pass
    root.configure(bg=KEY_COLOR)
    root.geometry('%dx%d+0+0' % (sw, sh))
    canvas = tk.Canvas(root, width=sw, height=sh, bg=KEY_COLOR, highlightthickness=0)
    canvas.pack()
    draw(canvas, x, y, radius, shape, label)
    root.update_idletasks()
    try:
        click_through(root)
    except Exception:  # noqa: BLE001
        pass

    u = ctypes.windll.user32

    def cursor():
        p = POINT()
        u.GetCursorPos(ctypes.byref(p))
        return p.x, p.y

    def down(vk):
        return bool(u.GetAsyncKeyState(vk) & 0x8000)

    VK_LBUTTON, VK_RBUTTON, VK_ESCAPE = 0x01, 0x02, 0x1B

    base_hwnd = [None]
    last_check = [0.0]
    if wait == 'change':
        # **不用像素差**：覆盖层自己全屏铺在最上层时，抓屏拿回来的是冻结画面
        # （2026-11-20 实测：同进程 diff 恒 0；换进程也一样，因为被抓的那块被我们自己
        # 这层盖着）。改成问系统「这个坐标上是哪个窗口」——菜单/对话框/新窗口出现在
        # 那儿时句柄会变，不抓屏、不受覆盖层影响，而且这个信号说得清自己是什么。
        base_hwnd[0] = u.WindowFromPoint(POINT(x, y))

    t0 = time.monotonic()
    was_down = down(VK_LBUTTON)

    def finish(signal, inside=None, ratio=None, hwnd=None):
        emit({'event': 'signal', 'signal': signal, 'inside': inside,
              'changedRatio': ratio, 'hwnd': hwnd, 'hwndBase': base_hwnd[0],
              'elapsedMs': int((time.monotonic() - t0) * 1000),
              'truncated': truncated})
        try:
            root.destroy()
        except Exception:  # noqa: BLE001
            pass
        return 0

    state = {'code': None}

    def tick():
        # 用 try/finally 续拍：这条链一旦断，mainloop 会永远转下去（2026-11-20 踩过：
        # 定基线那一帧提前 return，把 after() 漏了，窗口挂在屏幕上不下来了）。
        try:
            if state['code'] is not None:
                return
            now = time.monotonic()
            if down(VK_ESCAPE) or down(VK_RBUTTON):
                state['code'] = finish('cancelled')
                return
            if now - t0 >= wait_ms / 1000.0:
                state['code'] = finish('timeout')
                return
            if wait == 'click':
                nonlocal was_down
                d = down(VK_LBUTTON)
                if d and not was_down:
                    cx, cy = cursor()
                    inside = (cx - x) ** 2 + (cy - y) ** 2 <= radius * radius
                    state['code'] = finish('click', inside=inside)
                    return
                was_down = d
            elif wait == 'change':
                if (now - last_check[0]) >= 0.2:
                    last_check[0] = now
                    hw = u.WindowFromPoint(POINT(x, y))
                    if hw != base_hwnd[0]:
                        state['code'] = finish('change', hwnd=hw)
                        return
        finally:
            if state['code'] is None:
                root.after(50, tick)

    if wait == 'none':
        state['code'] = finish('none')

    root.after(50, tick)
    root.mainloop()
    return state['code'] if state['code'] is not None else 0


if __name__ == '__main__':
    try:
        sys.exit(run())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        fail('failed', e)
