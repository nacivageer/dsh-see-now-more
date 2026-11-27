#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""selftest-ui.py - 悬浮窗的 Win32 不变量自检，不碰光标。

为什么要有它：改完 window.py 想验「窗还在不在、置顶有没有丢、弹窗是不是又被主窗
盖住、点击穿透有没有误开」，过去只能真去点一遍。这些性质都能从窗口状态读出来，
读一次几十毫秒，不占鼠标。真正需要光标的（hover / 拖拽 / 端到端穿透 / IME）在
末尾列出来，不需要谁记着。

**WDA 只作信息，不判 PASS/FAIL**（2026-11-27）：收起态常开 `WDA_EXCLUDEFROMCAPTURE`，
窗在截图 / 录屏里整窗消失；默认配置下展开态也会被排除。一跑就 WARN 只是噪音 ——
但它是「截图里为什么没有这扇窗」的第一个答案，所以打在头行；`wda=excluded` 时多一行说明。

顶置位的期望值跟着 `~/.dsh/see-now.json` 的 `keepOnTop` 走：开着（默认）窗口必须在
topmost 带里，关着就不能在（设置页「保持置顶」）。关着时被别的窗口压住是正常的，
所以「遮挡」那条从 WARN 降成 PASS、命中测试降成 WARN。

**主窗靠属主认，不靠面积、也不靠标题**（2026-11-27）：弹窗都是 owned window
（`GW_OWNER` = 主窗），于是「没有属主的 Tk 顶层窗」就是主窗。两个反例都实测到了 ——
设置卡能比主窗还高（560x1374 vs 590x935），按面积会挑错；Tk 给所有 Toplevel 用同一个
WM_NAME（`overrideredirect` 下看不见，但都是 'DSH'），按标题数实例会把弹窗数成第二个主窗。

输出一律 ASCII：本机 python 的 stdout 是 cp936，中文过管道会变乱码。

退出码：0 = 全部通过（允许 WARN）；1 = 有 FAIL；2 = 找不到悬浮窗（大概是没开）。
用法：
  python scripts/selftest-ui.py            # 自动找 python 进程里的 Tk 顶层窗
  python scripts/selftest-ui.py --list     # 只列候选窗，不检查
  python scripts/selftest-ui.py --hwnd 0x59206c
  python scripts/selftest-ui.py --title 回顾
"""

import ctypes
import glob
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
GW_OWNER = 4
WDA_MONITOR = 0x1
WDA_EXCLUDEFROMCAPTURE = 0x11
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
u32.GetWindow.restype = ctypes.c_void_p
u32.GetWindow.argtypes = (ctypes.c_void_p, ctypes.c_uint)
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


def owner_of(hwnd):
    """属主窗口句柄，0 = 没有属主。

    **主窗和弹窗就靠这个分**（2026-11-27 实测）：主窗 `GW_OWNER` 是 0，设置卡 / 删除确认卡 /
    回顾窗都是 `GW_OWNER = 主窗`（`_dialogs_topmost` 建的就是 owned window）。按标题分不出
    来 —— Tk 的 Toplevel 一律沿用 app 名，overrideredirect 下看不见但 WM_NAME 都叫 'DSH'；
    按面积也分不出来，设置卡能比主窗还高（实测 560x1374 vs 590x935）。
    """
    return int(u32.GetWindow(ctypes.c_void_p(int(hwnd)), GW_OWNER) or 0)


def wda_of(hwnd):
    """显示亲和性：0 = 没有，1 = WDA_MONITOR，0x11 = WDA_EXCLUDEFROMCAPTURE。

    读不到返回 -1（老系统 / 权限）。**这一项只作信息**：默认配置下窗就是 excluded，
    判成 WARN 每跑一次都响一次，没人会看。它的用处是回答「截图里为什么没有这扇窗」。
    """
    v = wintypes.DWORD(0)
    fn = u32.GetWindowDisplayAffinity
    fn.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    fn.restype = wintypes.BOOL
    if not fn(hwnd, ctypes.byref(v)):
        return -1
    return int(v.value)


def wda_name(v):
    return {0: 'none', WDA_MONITOR: 'monitor',
            WDA_EXCLUDEFROMCAPTURE: 'excluded'}.get(v, '0x%X' % v if v >= 0 else 'unknown')


def describe(hwnd):
    r = rect_of(hwnd)
    return {
        'hwnd': int(hwnd),
        'owner': owner_of(hwnd),
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


def read_state_file():
    path = os.path.join(os.path.expanduser('~'), '.dsh', 'see-now.json')
    if not os.path.exists(path):
        return 'WARN', 'no ~/.dsh/see-now.json (defaults apply)', None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except Exception as e:  # noqa: BLE001
        return 'FAIL', 'unparsable: %s' % e, None
    if not isinstance(raw, dict):
        return 'FAIL', 'not a JSON object', None
    bad = []
    mode = str(raw.get('mode', ''))
    pace = str(raw.get('defaultPace', ''))
    if mode not in MODE_OK:
        bad.append('mode=%r' % mode)
    if pace not in PACE_OK:
        bad.append('defaultPace=%r' % pace)
    # 折叠气泡只认真正的布尔：写成字符串 "false" 是真值，窗会当成开（2026-11-27）
    bubble = raw.get('collapsedBubble', True)
    if not isinstance(bubble, bool):
        bad.append('collapsedBubble=%r (want true/false)' % (bubble,))
    # 保持置顶同理（2026-11-27）：窗只看真正的布尔
    keep_top = raw.get('keepOnTop', True)
    if not isinstance(keep_top, bool):
        bad.append('keepOnTop=%r (want true/false)' % (keep_top,))
    if bad:
        return 'FAIL', 'bad values: ' + ', '.join(bad), raw
    return 'PASS', 'mode=%s defaultPace=%s collapsedBubble=%s keepOnTop=%s' % (
        mode or '-', pace or '-', 'on' if bubble else 'off',
        ('on' if keep_top else 'off') if isinstance(keep_top, bool) else '-'), raw


def check_bound_session(raw):
    """窗口绑定到哪个会话，写在 see-now.json 的 session 里。
    绑到一个已经不存在的会话时症状很哑：打得进去，没有人接。
    会话库按工作区分目录：~/.dsh/sessions/<workspace>/session-<uuid>/。"""
    if not isinstance(raw, dict):
        return 'WARN', 'no parsable state file'
    sid = str(raw.get('session') or '').strip()
    if not sid:
        return 'WARN', 'unbound (no session key)'
    name = sid if sid.startswith('session-') else 'session-' + sid
    pattern = os.path.join(os.path.expanduser('~'), '.dsh', 'sessions', '*', name)
    hits = glob.glob(pattern)
    if hits:
        return 'PASS', name
    return 'FAIL', name + ' not found under ~/.dsh/sessions/*/'


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

    # 回顾窗 / 设置卡 / 确认卡也是 TkTopLevel，而且可能比主窗还大（实测设置卡 560x1374、
    # 主窗 590x935），所以**不能按面积挑**。主窗 = 没有属主的那个（同 `owner_of`）。
    cands = sorted((describe(h) for h in find_candidates()), key=area, reverse=True)
    if list_only:
        p('candidates: %d' % len(cands))
        for d in cands:
            p('  hwnd=0x%X pid=%d owner=0x%X class=%s title=%r rect=%s area=%d'
              % (d['hwnd'], d['pid'], d['owner'], d['cls'], d['title'], d['rect'], area(d)))
        return 0

    mains = [d for d in cands if not d['owner']]

    target = None
    if want_hwnd:
        # 传 int，不传 wintypes.HWND(...)：那个包装在 int() 里会变成字节串
        target = describe(want_hwnd)
    elif want_title:
        hits = [d for d in cands if want_title.lower() in (d['title'] or '').lower()]
        target = hits[0] if hits else None
    else:
        # 没有属主的那个才是主窗；一个都没有（比如已经被别的进程接管）才退回最大的
        target = mains[0] if mains else (cands[0] if cands else None)

    if not target:
        p('NOT-OPEN  no floating window found (TkTopLevel in a python process)')
        p('          open it first (title bar button, or run the plugin), then rerun.')
        p('          candidates listed by: python scripts/selftest-ui.py --list')
        return 2

    hwnd = target['hwnd']
    results = []
    target_pid = target['pid']
    same_pid = [describe(h) for h in enum_windows() if pid_of(h) == target_pid]
    # 单飞只看**主窗**：弹窗都带属主，而且 Tk 给所有 Toplevel 都用同一个 WM_NAME，
    # 按标题数会把「开着设置卡 + 一张确认卡」数成 3 个实例（2026-11-27 实测的假红）。
    main_count = len([d for d in same_pid
                      if (d['cls'] or '').startswith('Tk') and not d['owner']])

    # 0. 配置先读：顶置位的期望值由 keepOnTop 决定（关掉时窗口就不该在 topmost 带）
    state_verdict, state_detail, raw = read_state_file()
    keep_top = True
    if isinstance(raw, dict) and isinstance(raw.get('keepOnTop'), bool):
        keep_top = raw['keepOnTop']

    # 1. 顶置位：开着 = 窗口在 topmost 带里（不靠"看起来在上面"）；关掉 = 必须不在
    in_band = bool(target['ex'] & WS_EX_TOPMOST)
    if keep_top:
        results.append(('topmost-bit', 'PASS' if in_band else 'FAIL',
                        'ex=0x%08X' % target['ex']))
    else:
        results.append(('topmost-bit', 'PASS' if not in_band else 'FAIL',
                        'keepOnTop=false, ex=0x%08X (want NOT topmost)' % target['ex']))

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
    if transparent:
        verdict = 'FAIL'
        detail = 'ex_transparent=1 first=0x%X root=0x%X' % (hits[0][0], hits[0][1])
    elif self_hits:
        verdict = 'PASS'
        detail = ('ex_transparent=0 self_hits=%d/5 first=0x%X root=0x%X'
                  % (len(self_hits), hits[0][0], hits[0][1]))
    elif not keep_top:
        # 关掉置顶时被别的窗口盖住是预期行为，这条此刻验不了（不是失败）
        verdict = 'WARN'
        detail = ('covered by another window (keepOnTop=false); '
                  'hit-test not verifiable, ex_transparent=0')
    else:
        verdict = 'FAIL'
        detail = ('no sampled point hits it, first=0x%X root=0x%X'
                  % (hits[0][0], hits[0][1]))
    results.append(('not-click-through', verdict, detail))

    # 4. 弹窗的 topmost 位要跟 keepOnTop 一致：开着 = 在内（弹窗被主窗盖住是踩过的坑），
    #    关掉 = 也在外（`.44` 起弹窗跟随开关；2026-11-27 修「已开弹窗跟着翻面」之后，
    #    关着时还留在带里才是 bug）。主窗自己不算「弹窗」：它归第 1 条。
    #    原来这里一律要求「全在 topmost 带」，于是开着回顾窗 + 关掉置顶时假红
    #    （2026-11-27 发 `.45` 时撞上：2 个可见窗、1 个"not topmost"）。
    #    只数**我们自己的**窗口（Tk 类）：输入法会在前台进程里注入它自己的窗口
    #    （实测 `SoPY_Status`，搜狗的，永远 topmost、我们管不着），按 pid 数就会假红。
    ours = [d for d in same_pid if (d['cls'] or '').startswith('Tk')]
    broken = [d for d in ours if d['hwnd'] != target['hwnd']
              and bool(d['ex'] & WS_EX_TOPMOST) != keep_top and d['rect'] and area(d) > 0]
    results.append(('dialogs-topmost', 'PASS' if not broken else 'FAIL',
                    'keepOnTop=%s: %d tk window(s) in pid %d, %d %s%s'
                    % ('on' if keep_top else 'off', len(ours), target_pid, len(broken),
                       'missing topmost' if keep_top else 'still topmost',
                       (' (' + ', '.join('%r' % (d['title'] or d['cls']) for d in broken) + ')')
                       if broken else '')))

    # 5. 单飞：一个进程里只该有一个**主窗**（无属主的 Tk 顶层窗）。弹窗自己带属主，
    #    不该算进来 —— 按标题数的时候「开着设置卡」会被数成 3 个实例（False red）。
    results.append(('single-instance', 'PASS' if main_count == 1 else 'FAIL',
                    '%d main window(s) (no GW_OWNER) in pid %d' % (main_count, target_pid)))

    # 6. 位置：在虚拟桌面里，且不是个残废尺寸
    x, y, w, h = target['rect']
    vx, vy = u32.GetSystemMetrics(SM_XVIRTUALSCREEN), u32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    vw, vh = u32.GetSystemMetrics(SM_CXVIRTUALSCREEN), u32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    on_screen = w >= 100 and h >= 80 and x + w > vx and y + h > vy and x < vx + vw and y < vy + vh
    results.append(('on-screen', 'PASS' if on_screen else 'FAIL',
                    '%dx%d at (%d,%d) in virtual screen %dx%d at (%d,%d)'
                    % (w, h, x, y, vw, vh, vx, vy)))

    # 7. 遮挡：z 序在它上面的可见窗，如果压了它 20% 以上，报警（WARN，不判死——
    #    游戏、截图工具的 topmost 窗本来就会压过来，看门狗 800ms 才顶一次）。
    #    关掉置顶时被压住是预期行为，不报。
    if not keep_top:
        results.append(('z-order', 'PASS', 'keepOnTop=false: coverage is expected'))
    else:
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
    results.append(('state-file', state_verdict, state_detail))
    results.append(('bound-session',) + check_bound_session(raw))

    # 输出
    p('see-now-more ui selftest')
    wda = wda_of(hwnd)
    p('target hwnd=0x%X pid=%d class=%s title=%r rect=%dx%d at (%d,%d) dpi=%d wda=%s'
      % (target['hwnd'], target_pid, target['cls'], target['title'], w, h, x, y,
         u32.GetDpiForWindow(hwnd), wda_name(wda)))
    if wda == WDA_EXCLUDEFROMCAPTURE:
        p('note: wda=excluded - screenshots / recording will not show this window')
        p('      (collapsed state always sets it; expanded follows capturable in watch-window.json)')
    if len(cands) > 1:
        p('note: %d tk windows in python processes, picked the one with no owner '
          '(the main window); --hwnd to pick another' % len(cands))
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
