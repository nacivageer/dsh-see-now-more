#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""selftest-ui.py - 悬浮窗的 Win32 不变量自检，不碰光标。

为什么要有它：改完 window.py 想验「窗还在不在、置顶有没有丢、弹窗是不是又被主窗
盖住、点击穿透有没有误开」，过去只能真去点一遍。这些性质都能从窗口状态读出来，
读一次几十毫秒，不占鼠标。真正需要光标的（hover / 拖拽 / 端到端穿透 / IME）在
末尾列出来，不需要谁记着。

输出一律 ASCII：本机 python 的 stdout 是 cp936，中文过管道会变乱码。

退出码：0 = 全部通过（允许 WARN）；1 = 有 FAIL；2 = 找不到悬浮窗（大概是没开）。
用法：
  python scripts/selftest-ui.py            # 自动找 python 进程里的 Tk 顶层窗
  python scripts/selftest-ui.py --list     # 只列候选窗，不检查
  python scripts/selftest-ui.py --hwnd 0x59206c
  python scripts/selftest-ui.py --title 回顾
"""

import ctypes
import json
import os
import sys
from ctypes import wintypes

GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_POPUP = 0x80000000
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_EX_TOPMOST = 0x00000008
WS_EX_TRANSPARENT = 0x00000020
GA_ROOT = 2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79


class RECT(ctypes.Structure):
    _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long),
                ('right', ctypes.c_long), ('bottom', ctypes.c_long)]


class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]


u32 = ctypes.WinDLL('user32', use_last_error=True)
k32 = ctypes.WinDLL('kernel32', use_last_error=True)

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

u32.EnumWindows.argtypes = (WNDENUMPROC, wintypes.LPARAM)
u32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
u32.GetWindowLongPtrW.argtypes = (wintypes.HWND, ctypes.c_int)
u32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(RECT))
# 64 位下不声明 argtypes 的 user32 函数会把 HWND 当 C int 截断、把 buffer 当 int：
# 拿一个外来的 hwnd 跑就当场崩（2026-11-27 踩过）。用到的全部显式声明。
u32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
u32.GetWindowTextLengthW.restype = ctypes.c_int
u32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
u32.GetWindowTextW.restype = ctypes.c_int
u32.GetClassNameW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
u32.GetClassNameW.restype = ctypes.c_int
u32.IsWindowVisible.argtypes = (wintypes.HWND,)
u32.IsWindowVisible.restype = wintypes.BOOL
u32.IsIconic.argtypes = (wintypes.HWND,)
u32.IsIconic.restype = wintypes.BOOL
u32.GetSystemMetrics.argtypes = (ctypes.c_int,)
u32.GetSystemMetrics.restype = ctypes.c_int
u32.SetProcessDPIAware.restype = wintypes.BOOL
u32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
u32.WindowFromPoint.restype = wintypes.HWND
u32.WindowFromPoint.argtypes = (POINT,)
u32.GetAncestor.restype = wintypes.HWND
u32.GetAncestor.argtypes = (wintypes.HWND, wintypes.UINT)
u32.GetDpiForWindow.restype = wintypes.UINT
u32.GetDpiForWindow.argtypes = (wintypes.HWND,)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
k32.QueryFullProcessImageNameW.argtypes = (wintypes.HANDLE, wintypes.DWORD,
                                           wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
k32.CloseHandle.argtypes = (wintypes.HANDLE,)


def dpi_aware():
    """先声明 per-monitor DPI 感知：否则 GetWindowRect 给的是虚拟化坐标，
    WindowFromPoint 要的是物理坐标，两边对不上，命中检查会假失败。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            u32.SetProcessDPIAware()
        except Exception:
            pass


def enum_windows(visible_only=True):
    out = []

    def cb(hwnd, _lparam):
        if not visible_only or u32.IsWindowVisible(hwnd):
            out.append(hwnd)
        return True

    fn = WNDENUMPROC(cb)
    u32.EnumWindows(fn, 0)
    return out


def class_of(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title_of(hwnd):
    n = u32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ''
    buf = ctypes.create_unicode_buffer(n + 1)
    u32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def pid_of(hwnd):
    p = wintypes.DWORD()
    u32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
    return int(p.value)


def exe_of(pid):
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ''
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return ''
    finally:
        k32.CloseHandle(h)


def rect_of(hwnd):
    r = RECT()
    if not u32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return r


def style_of(hwnd):
    return int(u32.GetWindowLongPtrW(hwnd, GWL_STYLE))


def exstyle_of(hwnd):
    return int(u32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))


def describe(hwnd):
    r = rect_of(hwnd)
    return {
        'hwnd': int(hwnd),
        'title': title_of(hwnd),
        'cls': class_of(hwnd),
        'pid': pid_of(hwnd),
        'style': style_of(hwnd),
        'ex': exstyle_of(hwnd),
        'rect': (r.left, r.top, r.right - r.left, r.bottom - r.top) if r else None,
    }


def area(d):
    return max(0, d['rect'][2]) * max(0, d['rect'][3]) if d['rect'] else 0


def overlap_ratio(a, b):
    if not a['rect'] or not b['rect'] or a['hwnd'] == b['hwnd']:
        return 0.0
    ax, ay, aw, ah = a['rect']
    bx, by, bw, bh = b['rect']
    w = min(ax + aw, bx + bw) - max(ax, bx)
    h = min(ay + ah, by + bh) - max(ay, by)
    if w <= 0 or h <= 0 or aw * ah == 0:
        return 0.0
    return (w * h) / float(aw * ah)


def astr(s):
    """输出一律 ASCII：本机 stdout 是 cp936，中文过管道再按 UTF-8 解码就是乱码，
    而窗口标题偏偏是中文。非 ASCII 转成 \\uXXXX，至少还认得出是哪个窗口。"""
    return str(s).encode('ascii', 'backslashreplace').decode('ascii')


def p(line=''):
    print(astr(line))


def find_candidates():
    """python 进程里的 Tk 顶层窗。不按标题挑：标题是可以改的（_commit_title）。"""
    out = []
    for h in enum_windows():
        if class_of(h) != 'TkTopLevel':
            continue
        exe = os.path.basename(exe_of(pid_of(h))).lower()
        if exe in ('python.exe', 'pythonw.exe'):
            out.append(h)
    return out


MODE_OK = {'both', 'vision', 'audio', 'none', ''}
PACE_OK = {'calm', 'normal', 'dense', 'game-economic', ''}


def check_state_file():
    path = os.path.join(os.path.expanduser('~'), '.dsh', 'see-now.json')
    if not os.path.exists(path):
        return 'WARN', 'no ~/.dsh/see-now.json (defaults apply)'
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except Exception as e:  # noqa: BLE001
        return 'FAIL', 'unparsable: %s' % e
    if not isinstance(raw, dict):
        return 'FAIL', 'not a JSON object'
    mode = str(raw.get('mode', ''))
    pace = str(raw.get('defaultPace', ''))
    bad = []
    if mode not in MODE_OK:
        bad.append('mode=%r' % mode)
    if pace not in PACE_OK:
        bad.append('defaultPace=%r' % pace)
    if bad:
        return 'FAIL', 'bad values: ' + ', '.join(bad)
    return 'PASS', 'mode=%s defaultPace=%s' % (mode or '-', pace or '-')


def run(argv):
    dpi_aware()
    want_hwnd = 0
    want_title = ''
    list_only = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--list':
            list_only = True
        elif a == '--hwnd' and i + 1 < len(argv):
            i += 1
            want_hwnd = int(argv[i], 0)
        elif a == '--title' and i + 1 < len(argv):
            i += 1
            want_title = argv[i]
        else:
            sys.stderr.write('bad arg: %s\n' % a)
            return 2
        i += 1

    # 回顾窗也是 TkTopLevel：候选按面积降序，主窗通常最大；多个时提示用 --hwnd 指定
    cands = sorted((describe(h) for h in find_candidates()), key=area, reverse=True)
    if list_only:
        p('candidates: %d' % len(cands))
        for d in cands:
            p('  hwnd=0x%X pid=%d class=%s title=%r rect=%s area=%d'
              % (d['hwnd'], d['pid'], d['cls'], d['title'], d['rect'], area(d)))
        return 0

    target = None
    if want_hwnd:
        # 传 int，不传 wintypes.HWND(...)：那个包装在 int() 里会变成字节串
        target = describe(want_hwnd)
    elif want_title:
        hits = [d for d in cands if want_title.lower() in (d['title'] or '').lower()]
        target = hits[0] if hits else None
    else:
        target = cands[0] if cands else None

    if not target:
        p('NOT-OPEN  no floating window found (TkTopLevel in a python process)')
        p('          open it first (title bar button, or run the plugin), then rerun.')
        p('          candidates listed by: python scripts/selftest-ui.py --list')
        return 2

    hwnd = target['hwnd']
    results = []
    target_pid = target['pid']
    same_pid = [describe(h) for h in enum_windows() if pid_of(h) == target_pid]
    main_count = len([d for d in cands if d['title'] == target['title']])

    # 1. 顶置位：窗口在 topmost 带里（不靠"看起来在上面"）
    results.append(('topmost-bit', 'PASS' if target['ex'] & WS_EX_TOPMOST else 'FAIL',
                    'ex=0x%08X' % target['ex']))

    # 2. 无边框弹窗：overrideredirect(True) 的形态
    st = target['style']
    borderless = (st & WS_CAPTION) == 0 and (st & WS_THICKFRAME) == 0 and (st & WS_POPUP) != 0
    results.append(('borderless', 'PASS' if borderless else 'FAIL',
                    'style=0x%08X caption=%d thick=%d popup=%d'
                    % (st, bool(st & WS_CAPTION), bool(st & WS_THICKFRAME), bool(st & WS_POPUP))))

    # 3. 整窗不穿透：聊天窗要是被 WS_EX_TRANSPARENT 焊住，输入框就点不着了。
    #    采五个点：被别的 topmost 窗压住一角时不至于假失败；任一点命中就算路由正常。
    x0, y0, w0, h0 = target['rect']
    pts = [(x0 + w0 // 2, y0 + h0 // 2),
           (x0 + w0 // 4, y0 + h0 // 4), (x0 + 3 * w0 // 4, y0 + h0 // 4),
           (x0 + w0 // 4, y0 + 3 * h0 // 4), (x0 + 3 * w0 // 4, y0 + 3 * h0 // 4)]
    hits = []
    for px, py in pts:
        hh = u32.WindowFromPoint(POINT(px, py))
        hits.append((int(hh or 0), int(u32.GetAncestor(hh, GA_ROOT) or 0)))
    self_hits = [h for h in hits if h[1] == target['hwnd']]
    transparent = bool(target['ex'] & WS_EX_TRANSPARENT)
    results.append(('not-click-through', 'PASS' if (not transparent and self_hits) else 'FAIL',
                    'ex_transparent=%d self_hits=%d/5 first=0x%X root=0x%X'
                    % (transparent, len(self_hits), hits[0][0], hits[0][1])))

    # 4. 同进程的可见窗全在 topmost 带：弹窗被主窗盖住是踩过的坑（_pin_topmost）
    broken = [d for d in same_pid if not (d['ex'] & WS_EX_TOPMOST) and d['rect'] and area(d) > 0]
    results.append(('dialogs-topmost', 'PASS' if not broken else 'FAIL',
                    '%d visible window(s) in pid %d, %d not topmost%s'
                    % (len(same_pid), target_pid, len(broken),
                       (' (' + ', '.join('%r' % d['title'] for d in broken) + ')') if broken else '')))

    # 5. 单飞：同标题的主窗只该有一个
    results.append(('single-instance', 'PASS' if main_count == 1 else 'FAIL',
                    '%d window(s) titled %r' % (main_count, target['title'])))

    # 6. 位置：在虚拟桌面里，且不是个残废尺寸
    x, y, w, h = target['rect']
    vx, vy = u32.GetSystemMetrics(SM_XVIRTUALSCREEN), u32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    vw, vh = u32.GetSystemMetrics(SM_CXVIRTUALSCREEN), u32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    on_screen = w >= 100 and h >= 80 and x + w > vx and y + h > vy and x < vx + vw and y < vy + vh
    results.append(('on-screen', 'PASS' if on_screen else 'FAIL',
                    '%dx%d at (%d,%d) in virtual screen %dx%d at (%d,%d)'
                    % (w, h, x, y, vw, vh, vx, vy)))

    # 7. 遮挡：z 序在它上面的可见窗，如果压了它 20% 以上，报警（WARN，不判死——
    #    游戏、截图工具的 topmost 窗本来就会压过来，看门狗 800ms 才顶一次）
    above = []
    for d in [describe(h) for h in enum_windows()]:
        if d['hwnd'] == target['hwnd']:
            break
        if d['cls'] in ('Progman', 'WorkerW', 'Shell_TrayWnd') or d['pid'] == target_pid:
            continue
        if overlap_ratio(d, target) >= 0.2:
            above.append(d)
    if above:
        top = above[-1]
        results.append(('z-order', 'WARN', 'covered >=20%% by %r (%s)'
                        % (top['title'] or top['cls'], top['cls'])))
    else:
        results.append(('z-order', 'PASS', 'nothing above it overlaps >=20%'))

    # 8. 配置：形状对不对（窗口与宿主都靠这份文件，写坏了症状很玄）
    results.append(('state-file',) + check_state_file())

    # 输出
    p('see-now-more ui selftest')
    p('target hwnd=0x%X pid=%d class=%s title=%r rect=%dx%d at (%d,%d) dpi=%d'
      % (target['hwnd'], target_pid, target['cls'], target['title'], w, h, x, y,
         u32.GetDpiForWindow(hwnd)))
    if len(cands) > 1:
        p('note: %d tk windows in python processes, picked the largest; --hwnd to pick another'
          % len(cands))
    p('')
    counts = {'PASS': 0, 'FAIL': 0, 'WARN': 0}
    for name, verdict, detail in results:
        counts[verdict] = counts.get(verdict, 0) + 1
        p('%-4s  %-18s %s' % (verdict, name, detail))

    p('')
    p('SKIP  click-through-e2e   real click must land on the window below')
    p('SKIP  hover               cursor enter/leave, cursor shape')
    p('SKIP  drag                press-move-release, live resize')
    p('SKIP  ime-input           typing + candidate window in the input box')
    p('SKIP  pointer-wait        pointer overlay click/change/timeout signals')
    p('')
    p('result: %d passed, %d failed, %d warn, 5 skipped'
      % (counts['PASS'], counts['FAIL'], counts['WARN']))
    p('the 5 skipped ones are the only checks that need the real cursor;')
    p('batch them in one sitting instead of clicking after every edit.')
    return 0 if counts['FAIL'] == 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(run(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        if os.environ.get('DSH_SELFTEST_DEBUG') == '1':
            import traceback
            traceback.print_exc()
        sys.stderr.write('selftest crashed: %s\n' % e)
        sys.exit(3)
