#!/usr/bin/env python3
# ⚠️ 本文件由 dsh-see-now/scripts/sync-window.mjs 生成，请勿手改（要改请改上游 dsh-watch-together）
"""陪看悬浮窗：不铺全屏背景图，实时抓窗口背后的桌面并模糊成液态玻璃。

三层，各自不知道对方的实现：

    glass_geometry.py   一套尺寸的全部贴图（不可变，尺寸/形状变了换一个新对象）
    glass_cpu.py        CPU 合成：抓屏 → 模糊 → 边缘折射 → 内框透镜 → 染色 → 色散
    glass_gpu.py        同一件事搬到 GPU（moderngl / OpenGL 3.3+）
    window.py           这个文件：Tk 窗口、聊天流、文字层、拖动/缩放/折叠/改名

`glass_capture.py` 是两条渲染路径共用的抓屏与运动判定 —— 历史上同一条判断
在 CPU / GPU 各写一份，于是同一个 bug 也要修两遍（#39、#48）。

关键点：
- Windows 10 2004+ 的 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)：让本窗口
  从屏幕捕获里消失，于是抓自己所在区域时抓到的是「背后的桌面」，不会递归。
  代价是远程桌面/录屏/截图里整窗也看不见；用 `glass: solid` 切纯色底板，
  不抓屏、不设 WDA，任何捕获方式都能看到。
- 抓到的背景按需重合成（静止时跳帧），所以是实时模糊，不是静态截图。
- 这不是 DWM Acrylic；Acrylic 需要系统「透明效果」开启，这里是软件实时模糊。

渲染后端：默认 CPU。`DSH_GLASS_NATIVE=1` 或 `DSH_GLASS_GPU=1` 走 GPU。
"""
import ctypes
import json
import os
from datetime import datetime, timedelta, timezone
import queue
import subprocess
import threading
import time
from ctypes import wintypes
from pathlib import Path

# 必须在 import tkinter / 创建任何窗口之前声明 per-monitor v2 DPI 感知。
_u = ctypes.windll.user32
try:
    _u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    _u.SetProcessDpiAwarenessContext.restype = ctypes.c_bool
    _u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

try:
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

# ---------------------------------------------------------------- 依赖预检
#
# 必须在 import mss / numpy / PIL / glass_* **之前**：pythonw 没有控制台，
# 导入失败时 Python 直接退出，用户只看到"窗口没出来"，连一行提示都没有（#76）。
# 这里用 ctypes 弹 MessageBox（不依赖 tkinter —— 它也可能缺），并把原因落盘。

def _missing_deps() -> list:
    missing = []
    for module, package in (("tkinter", "tkinter（Python 安装时勾选 tcl/tk）"),
                            ("mss", "mss"), ("numpy", "numpy"), ("PIL", "pillow")):
        try:
            __import__(module)
        except Exception:
            missing.append(package)
    return missing


def _init_log() -> None:
    """自己开日志文件，别继承父进程的 stdout/stderr。

    实报（2026-11-06）：窗口由一次性 PowerShell 拉起，那个进程退出后继承来的
    stderr 句柄失效 —— 此后**任何 print() 都抛 OSError: [Errno 22]**。
    `_show_bind_bar` 末尾那条调试 print 正好在 SetWindowPos 之后：throw 被自己的
    except 再打一次，二次抛出 → 回调崩掉、窗停在"打开"态。日志必须由本进程持有。
    """
    target = None
    try:
        base = Path(os.environ.get("DSH_VIDEO_CACHE_DIR", "")).parent
        if not str(base) or str(base) == ".":
            base = Path.home() / ".dsh"
        target = base / "see-now-window.log"
        f = open(target, "a", encoding="utf-8", buffering=1)
    except Exception:
        try:
            f = open(os.devnull, "w", encoding="utf-8", buffering=1)
        except Exception:
            return
    import sys as _sys
    _sys.stdout = f
    _sys.stderr = f
    if target is not None:
        try:
            print(f"---- window start {time.strftime('%Y-%m-%d %H:%M:%S')} pid={os.getpid()}",
                  flush=True)
        except Exception:
            pass


def _die_missing(missing: list) -> None:
    log_path = Path.home() / ".dsh" / "watch-window-error.log"
    text = ("悬浮窗启动失败：缺少 " + "、".join(missing) + "\n\n"
            + "装一次就好：\n    pip install pillow numpy mss\n\n"
            + f"详情：{log_path}")
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(text + "\n", encoding="utf-8")
    except Exception:
        pass
    try:
        ctypes.windll.user32.MessageBoxW(None, text, "dsh-watch-together", 0x10)
    except Exception:
        print(text, flush=True)
    raise SystemExit(2)


if __name__ == "__main__":
    _missing = _missing_deps()
    if _missing:
        _die_missing(_missing)
    _init_log()

import io
import re
import tkinter as tk

import mss
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageTk

from glass_capture import CaptureSource, MotionTracker, paste_mic
from glass_cpu import CpuRenderer
from glass_geometry import (
    BAR_FRAC, BAR_THICK, BAR_Y, DEFAULT_H, DEFAULT_W, HISTORY_ROW_H, KEY,
    MESSAGE_SLOTS, MIC_SIZE, MIN_H, MIN_W, SLAB_RADIUS, Geometry, collapsed_height,
    shapes_for,
)
from window_widgets import ChatFeed, Fonts, TextLayer

try:  # 悬浮窗接口：插件写 window-events.jsonl，窗口回 window-outbox.jsonl
    from window_protocol import WindowProtocol
except Exception:
    WindowProtocol = None

INTERVAL_MS = 4
MAX_FPS = 120
# 静止画面下「有没有变」只能靠抓屏看，单次 grab ~7ms；空转按 60fps 就是 40% 单核。
# 降到 30fps 探针，有变化时 idle 立刻归零、下一拍恢复全速。
PROBE_FPS = 30

# 收起态标题栏：桌面背景 + 50% 黑（2026-11-06 用户要求）。
# 真透明做不到（整窗 -alpha 会把文字也一起变淡），所以照纯色模式的思路
# 「抓一次背后的桌面、预混成不透明色」；文字/按钮照旧画在帧上面，保持 100%。
# 抓屏期间临时开 WDA 排除自己：不排除就会把上一帧的半透明条再叠黑一层。
COLLAPSED_ALPHA = 0.5
# 秒；≈10fps。抓屏本身要 6~20ms（DWM 合成），再高频烧 CPU、截图也更容易拍到「条消失」。
# 调试：`DSH_SEE_REFRESH=99` 基本停掉定期重抓 —— 否则每 0.1 秒有 1/4 时间窗被 WDA 排除，
# 截图要重试好几次才拍得到（2026-11-07 实测：0x11 占比 10/40）。
COLLAPSED_REFRESH = float(os.environ.get("DSH_SEE_REFRESH") or 0.1)
COLL_PAD = 160                  # 抓背景时四周多抓一圈：拖动时从缓存里裁，位置不滞后

# 次级按钮的边框色（2026-11-06 用户要求）：关联变更/历史（未展开）、收回、返回用灰边；
# 展开或高亮态（关联变更栏打开、回顾窗开着、悬停）仍用白边，保住"当前可点/正在用"的醒目度。
BTN_EDGE = "#8a8a8a"
BTN_EDGE_ON = "#ffffff"

# 调试开关（2026-11-06 用户要求）：`DSH_SEE_WDA=0` 时收起态**不常开** WDA 排除自己 ——
# 条就能被截图/录屏拍到。代价是抓垫图退回 mss（dxcam 的常驻帧会带自己，出现"叠加"），
# 抓的那几毫秒仍然临时开 WDA，所以垫图本身干净，只有极小概率截图正好撞上抓屏瞬间。
# 调完不带这个环境变量重启，就恢复「收起态常开 WDA」（第 62 条）。
DEBUG_NO_WDA = os.environ.get("DSH_SEE_WDA") == "0"

# ---- 价格时段（口径与 plugins/dsh-price-period 一致，2026-11-06）----
# 北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余（含周末与法定节假日）半价。
# 中国没有夏令时，直接按 UTC+8 算，不依赖 tzdata。
_PEAK_WINDOWS = ((9 * 60, 12 * 60), (14 * 60, 18 * 60))
_PRICE_HOLIDAYS = {
    # 元旦
    "2026-01-01", "2026-01-02", "2026-01-03",
    # 春节
    "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
    "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
    # 清明
    "2026-04-04", "2026-04-05", "2026-04-06",
    # 劳动节
    "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
    # 端午
    "2026-06-19", "2026-06-20", "2026-06-21",
    # 中秋
    "2026-09-25", "2026-09-26", "2026-09-27",
    # 国庆
    "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    "2026-10-05", "2026-10-06", "2026-10-07",
}
_BJ_TZ = timezone(timedelta(hours=8))


def _price_next_switch(now_dt):
    """从 now_dt 起下一次状态切换（北京时间），返回 (datetime, 切换后是否高峰)。"""
    for offset in range(0, 10):
        day = now_dt.date() + timedelta(days=offset)
        key = day.strftime("%Y-%m-%d")
        if day.weekday() >= 5 or key in _PRICE_HOLIDAYS:
            continue
        for open_m, close_m in _PEAK_WINDOWS:
            for minutes, peak in ((open_m, True), (close_m, False)):
                t = datetime(day.year, day.month, day.day,
                             minutes // 60, minutes % 60, tzinfo=_BJ_TZ)
                if t > now_dt:
                    return t, peak
    return None, False


def price_period(now=None):
    """返回 (是否高峰, 距切换秒数 | None, 切换后是否高峰, 是否节假日)。"""
    now = now or datetime.now(_BJ_TZ)
    key = now.strftime("%Y-%m-%d")
    holiday = key in _PRICE_HOLIDAYS
    workday = now.weekday() < 5 and not holiday
    minutes = now.hour * 60 + now.minute
    peak = bool(workday and any(a <= minutes < b for a, b in _PEAK_WINDOWS))
    nxt, next_peak = _price_next_switch(now)
    remain = (nxt - now).total_seconds() if nxt else None
    return peak, remain, next_peak, holiday


def price_chip_enabled() -> bool:
    """底栏价格标签是否显示。

    默认显示；`~/.dsh/see-now.json` 写 `"showPriceChip": false` 可关，
    环境变量 `DSH_SEE_PRICE_CHIP=0` 只对这一次启动有效。
    这段价格逻辑是本文件自带的，不依赖 `dsh-price-period`（那个是 DSH 标题栏的可选插件）。
    """
    if os.environ.get("DSH_SEE_PRICE_CHIP") == "0":
        return False
    try:
        p = Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "see-now.json"
        cfg = json.loads(p.read_text(encoding="utf-8-sig"))
        return cfg.get("showPriceChip") is not False
    except Exception:
        return True


def _set_clipboard_image(img) -> bool:
    """把 PIL 图放进 Windows 剪贴板（CF_DIB）。返回是否成功。

    走 BMP 再砍掉 14 字节文件头 —— 剩下的就是 DIB；不依赖 pywin32。
    """
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "BMP")
    data = buf.getvalue()[14:]
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    k.GlobalAlloc.restype = ctypes.c_void_p
    k.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    k.GlobalLock.restype = ctypes.c_void_p
    k.GlobalLock.argtypes = [ctypes.c_void_p]
    k.GlobalUnlock.argtypes = [ctypes.c_void_p]
    u.SetClipboardData.restype = ctypes.c_void_p
    u.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    if not u.OpenClipboard(None):
        return False
    try:
        u.EmptyClipboard()
        handle = k.GlobalAlloc(0x0042, len(data))      # GMEM_MOVEABLE | GMEM_ZEROINIT
        if not handle:
            return False
        ptr = k.GlobalLock(handle)
        if not ptr:
            return False
        ctypes.memmove(ptr, data, len(data))
        k.GlobalUnlock(handle)
        if not u.SetClipboardData(8, ctypes.c_void_p(handle)):   # CF_DIB
            return False
        return True
    finally:
        u.CloseClipboard()


def msg_key(sid, at) -> str:
    """气泡的稳定键 `<sid>|<at>`。主窗 / 回顾 / 收藏三处共用同一份口径。"""
    return f"{sid or ''}|{'' if at is None else at}"


def _cfhtml(fragment: str) -> bytes:
    """按 CF_HTML（"HTML Format"）规范拼剪贴板载荷：头部偏移是**字节**偏移。"""
    head = ("Version:0.9\r\n"
            "StartHTML:{:010d}\r\n"
            "EndHTML:{:010d}\r\n"
            "StartFragment:{:010d}\r\n"
            "EndFragment:{:010d}\r\n")
    pre = "<html><body>\r\n<!--StartFragment-->"
    post = "<!--EndFragment-->\r\n</body></html>"
    n_head = len(head.format(0, 0, 0, 0).encode("utf-8"))
    start_frag = n_head + len(pre.encode("utf-8"))
    end_frag = start_frag + len(fragment.encode("utf-8"))
    end_html = end_frag + len(post.encode("utf-8"))
    body = (head.format(n_head, end_html, start_frag, end_frag) + pre
            + fragment + post)
    return body.encode("utf-8")


def _clip_put(fmt: int, data: bytes) -> bool:
    """把一段字节塞进剪贴板（GlobalAlloc + SetClipboardData）。"""
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    k.GlobalAlloc.restype = ctypes.c_void_p
    k.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    k.GlobalLock.restype = ctypes.c_void_p
    k.GlobalLock.argtypes = [ctypes.c_void_p]
    k.GlobalUnlock.argtypes = [ctypes.c_void_p]
    u.SetClipboardData.restype = ctypes.c_void_p
    u.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    handle = k.GlobalAlloc(0x0042, len(data))
    if not handle:
        return False
    ptr = k.GlobalLock(handle)
    if not ptr:
        return False
    ctypes.memmove(ptr, data, len(data))
    k.GlobalUnlock(handle)
    return bool(u.SetClipboardData(fmt, ctypes.c_void_p(handle)))


def _set_clipboard_rich(text: str, html: str) -> bool:
    """剪贴板双写：CF_UNICODETEXT + "HTML Format"（图以 file:// 内嵌）。

    粘进 Word / 微信时带图；粘进记事本退回纯文本。任一格式失败不算失败 ——
    只要纯文本进去了就算成功。
    """
    u = ctypes.windll.user32
    try:
        html_fmt = int(u.RegisterClipboardFormatW("HTML Format"))
    except Exception:
        html_fmt = 0
    ok_text = False
    if not u.OpenClipboard(None):
        return False
    try:
        u.EmptyClipboard()
        payload = (text + "\r\n").encode("utf-16-le") + b"\x00\x00"
        ok_text = _clip_put(13, payload)                 # CF_UNICODETEXT
        if html_fmt:
            _clip_put(html_fmt, _cfhtml(html))           # "HTML Format"
        return bool(ok_text)
    finally:
        u.CloseClipboard()

# 收起态「新消息」气泡（2026-11-06 用户要求）：主窗下方一条提示 —— 头像 +「新消息」+
# 深蓝 50% 的气泡（文字白 100%、图片 100%）。只在收起时出现，新消息顶掉旧的，
# 点标题栏展开就消失。
NOTIF_TOP = 86                  # 头像上沿（收起窗 78 高，再往下 8px）
NOTIF_GAP = 8                   # 头像行与气泡之间的距离
NOTIF_PAD_X = 16                # 气泡内左右留白
NOTIF_PAD_Y = 12                # 气泡内上下留白
NOTIF_MARGIN = 20               # 气泡离窗口左右边的距离
NOTIF_RADIUS = 22
NOTIF_BLUE = (26, 46, 84)       # 和主窗 DSH 气泡同色 #1a2e54
NOTIF_ALPHA = 0.5
NOTIF_IMG_H = 360               # 气泡里图片的最大高度
NOTIF_MIN_LINES = 3             # 视口至少留几行（展开态很矮时的保底）
NOTIF_SCROLL_STEP = 3           # 滚轮一格滚几行

# 仅用于文档截图/CI 视觉检查：暂停抓屏并把 WDA 关掉，窗口才会出现在截图里
PREVIEW = os.environ.get("DSH_GLASS_PREVIEW") == "1"
# 文档截图：正常抓屏 2.5 秒后暂停并取消 WDA，保留最后一帧玻璃
SNAPSHOT = os.environ.get("DSH_GLASS_SNAPSHOT") == "1"
# GPU：native 表示全分辨率采样（边缘透镜没有 1/4 放大的像素感）
NATIVE = os.environ.get("DSH_GLASS_NATIVE") == "1"
USE_GPU = NATIVE or os.environ.get("DSH_GLASS_GPU") == "1"
# 气泡底板（和 glass_geometry.BUBBLE_PLATE 同一个开关）：关掉 = 回到逐字翻色，
# 只用来拍新旧对比图，正常别动。
PLATE = os.environ.get("DSH_GLASS_PLATE", "1") != "0"
# 几何 trace：开/关「关联变更」输入行时，把「窗口尺寸 / canvas 尺寸 / 底图尺寸」
# 每拍都记一行。黑条的判据 = 某一拍 root 比 canvas 高（多出来的那条透出桌面）。
TRACE = os.environ.get("DSH_SEE_TRACE") == "1"
# 调试用协议动作（bindbar / resize）的开关：不开时这些事件一律忽略，
# 免得上次调试留在 window-events.jsonl 里的命令在下次重启时生效。
DEBUG_CTL = os.environ.get("DSH_SEE_DEBUG") == "1"

HERE = Path(__file__).resolve().parent
# 工作区根：DSH 写进 chat.jsonl 的**相对路径**（`.tmp2/x.png`）是相对工作区的，
# 而窗口进程的 cwd 不一定是工作区（插件拉起 / 手动 Start-Process 都可能不同）。
# 图片解析要以这里为锚点，不能只看 os.path.exists 的隐式 cwd（2026-11-05 实报：全变 [图片]）。
try:
    ROOT = HERE.parents[3]
except IndexError:
    ROOT = HERE


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


# ---------------------------------------------------------------- 路径与配置

def cache_dir() -> Path:
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return Path(d)
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return Path(local) / "dsh-video-storyboard" / "cache"
    return Path(os.environ.get("XDG_CACHE_HOME") or "~/.cache").expanduser() / "dsh-video-storyboard"


CHAT_FILE = cache_dir() / "chat.jsonl"
# 收藏 / 隐藏（2026-11-06 用户要求）：旁路清单，**不改写 chat.jsonl**。
# 收藏存快照（自动清理会把老记录从 chat.jsonl 删掉，只存引用会跟着消失）；
# 隐藏只记 key，窗口读取时过滤 —— 扣的是浮窗的显示，不是会话记录本身。
FAV_FILE = cache_dir() / "favorites.jsonl"
HID_FILE = cache_dir() / "hidden.jsonl"
HIDE_CFG = cache_dir() / "hide-confirm.json"
# 删除会话分组的确认弹窗配置（勾过「我已知晓，无需提醒」后不再弹）
DELETE_CFG = cache_dir() / "delete-confirm.json"
# 回顾列表里每组会话的自定义显示标题：{完整 sid: 标题}
TITLES_FILE = cache_dir() / "session-titles.json"
# DSH 侧标题镜像（插件按 `session/title` 事件写，窗口只读）与写回请求/回执。
# **分三个文件**：本地标题是窗口自己改的，插件整体重写镜像时不能互相覆盖。
TITLES_SYNC = cache_dir() / "title-sync.json"
TITLE_REQUEST = cache_dir() / "title-request.json"
TITLE_RESULT = cache_dir() / "title-request-result.json"
# 回合状态（插件按 turn/start、turn/end 写）与投递回执（relay/loop 写）
TURN_STATE_FILE = cache_dir() / "turn-state.json"
DELIVERED_FILE = cache_dir() / "delivered.jsonl"
# 感官状态（插件每拍写；窗口只读）：live / listen / off
FOCUS_FILE = cache_dir() / "focus.json"
CONFIG = Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "watch-window.json"
MIC_SCRIPT = HERE / "mic.py"

# **心跳**：插件侧靠它区分「进程还在」和「窗口真的在画」。只看 pid 不够 ——
# pid 会被复用，进程也可能活着但界面已经卡死，那样宿主会永远认为窗还开着，
# 于是再也不重开（see-now issue #2 第 3 条）。每秒最多写一次。
HEARTBEAT = cache_dir() / "window-heartbeat"
HEARTBEAT_EVERY = 1.0


class _PanelGeo:
    """缩放预览用的极简几何：只有面板真正会读的三个字段。

    走 `Geometry.for_size` 时要建 4x 超采样的圆角遮罩、warp 网格和 overlay，
    480 宽 27ms / 900 宽 77ms（2026-11-06 bench）—— 拖手期间 40ms 一拍，等它
    就是"掉帧"。预览只需要宽高和 blocks，用这个几十微秒就构造完。

    注意：**不要**把它塞回 `self._geo` —— 后面 `_tick`/`_rebuild` 依赖完整几何。
    """
    __slots__ = ("width", "height", "shapes")

    def __init__(self, w: int, h: int, shapes):
        self.width, self.height, self.shapes = int(w), int(h), tuple(shapes)


def read_config() -> dict:
    """读 `watch-window.json`。用 `utf-8-sig`：带 BOM 的 UTF-8 是 Windows 记事本 /
    PowerShell `Set-Content -Encoding UTF8` 的默认产物，读不动就会**静默**丢掉
    `capturable` 和 `geometry` —— 表现是窗跑到默认位置、还从截图里消失（2026-11-05 实踩）。
    """
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8-sig")) or {}
    except Exception:
        return {}


def write_config(patch: dict) -> None:
    cfg = read_config()
    cfg.update(patch or {})
    try:
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG)
    except Exception:
        pass


def capturable() -> bool:
    """录屏 / 截图能不能拍到窗口。

    默认**不能**：走 `WDA_EXCLUDEFROMCAPTURE`，窗口不会出现在截图、直播、共享屏幕里。
    要给别人看效果就在 `~/.dsh/watch-window.json` 写 `{ "capturable": true }`。
    环境变量 `DSH_GLASS_WDA=0` 只对这一次启动有效（插件拉起窗口时不传环境变量）。
    """
    if os.environ.get("DSH_GLASS_WDA") == "0":
        return True
    try:
        return read_config().get("capturable") is True
    except Exception:
        return False


# 远程控制软件不一定置 SM_REMOTESESSION；它们的窗口/类名是最稳的旁证。
# 命中任意一个就按 remote 处理，用 solid 底板，保证对面能看到整窗。
REMOTE_MARKS = (
    "gameviewer", "todesk", "sunlogin", "anydesk", "teamviewer",
    "rustdesk", "parsec", "uu远程", "向日葵",
)


def remote_capture_likely() -> bool:
    """当前是不是远程/捕获环境：RDP 标志位 + 常见远程软件窗口。"""
    try:
        if ctypes.windll.user32.GetSystemMetrics(0x1000):  # SM_REMOTESESSION
            return True
    except Exception:
        pass
    try:
        u = ctypes.windll.user32
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        u.GetWindowTextLengthW.restype = ctypes.c_int
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetWindowTextW.restype = ctypes.c_int
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetClassNameW.restype = ctypes.c_int
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsWindowVisible.restype = wintypes.BOOL
        hit = [False]

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _lparam):
            if not u.IsWindowVisible(hwnd):
                return True
            n = u.GetWindowTextLengthW(hwnd)
            title = ""
            if n > 0:
                buf = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, buf, n + 1)
                title = buf.value
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, cls, 256)
            hay = (title + " " + cls.value).lower()
            if any(mark in hay for mark in REMOTE_MARKS):
                hit[0] = True
                return False
            return True

        u.EnumWindows(visit, 0)
        return hit[0]
    except Exception:
        return False


def glass_mode() -> str:
    """玻璃背景模式：live（实时抓屏，默认）/ solid（纯色底板）。

    `WDA_EXCLUDEFROMCAPTURE` 会让窗口在远程桌面、OBS、截图工具里**整窗消失**
    （微软文档：“Everywhere else, the window does not appear at all”）。
    本机看起来正常，因为 mss 抓到的是窗口背后的像素；远程端却连文字都看不到。

    - `{ "glass": "solid" }`：不抓屏、不设 WDA，用纯色底板；任何捕获方式都能看到；
    - `{ "glass": "live" }`：原来的实时玻璃；
    - 不写 / `auto`：检测 `SM_REMOTESESSION` 和常见远程软件窗口，命中就用 solid。
    """
    if os.environ.get("DSH_GLASS_SOLID") == "1":
        return "solid"
    if os.environ.get("DSH_GLASS_LIVE") == "1":
        return "live"
    try:
        mode = str(read_config().get("glass") or "").strip().lower()
    except Exception:
        mode = ""
    if mode in ("solid", "live"):
        return mode
    # 空值 / auto：RDP 标志位或常见远程软件窗口任一命中，就用 solid。
    if remote_capture_likely():
        return "solid"
    return "live"


def _frost(img: Image.Image) -> Image.Image:
    """垫图磨砂：缩到 1/4 高斯模糊再放大 —— 玻璃感，同时把「旧照片的延迟」藏在模糊里。

    全分辨率高斯（840×820、radius≈9）要十几 ms；1/4 分辨率只要 ~1ms，视觉几乎一样
    （原版玻璃管线也是先在 1/4 分辨率上模糊的）。
    """
    try:
        w, h = img.size
        sw, sh = max(1, w // 4), max(1, h // 4)
        small = img.resize((sw, sh), Image.Resampling.BILINEAR)
        small = small.filter(ImageFilter.GaussianBlur(2.2))
        return small.resize((w, h), Image.Resampling.BILINEAR)
    except Exception:
        return img


_DXCAM = None
_DXCAM_FAILED = False


def _dxcam_grab(x0: int, y0: int, x1: int, y1: int):
    """GPU 抓屏（DXGI Desktop Duplication）：~0.3ms/帧；失败返回 None，调用方退回 mss。

    相机要常驻（内部有自己的采集线程），第一次调用时创建；颜色用 BGRA 交给 PIL 的
    BGRX 解包，不需要 cv2。WDA 排除自己仍然由调用方在抓之前设置。
    """
    global _DXCAM, _DXCAM_FAILED
    if _DXCAM_FAILED:
        return None
    try:
        if _DXCAM is None:
            import dxcam
            _DXCAM = dxcam.create(output_idx=0, output_color="BGRA")
        frame = None
        try:
            frame = _DXCAM.grab(region=(x0, y0, x1, y1), new_frame_only=False)
        except TypeError:
            frame = _DXCAM.grab(region=(x0, y0, x1, y1))
        if frame is None:
            frame = _DXCAM.get_latest_frame()
        if frame is None:
            return None
        h, w = frame.shape[:2]
        return Image.frombuffer("RGB", (w, h), frame, "raw", "BGRX", 0, 1)
    except Exception:
        _DXCAM_FAILED = True
        return None


def bound_sid_full() -> str:
    """`~/.dsh/see-now.json` 里绑定的**完整**会话 ID（没有就空串）。

    过滤聊天流要用整串：短 ID 只是显示用的前 8 位，拿来比较会和别的会话撞。
    """
    base = os.path.dirname(os.environ.get("DSH_VIDEO_CACHE_DIR", "."))
    try:
        cfg = json.loads(Path(base, "see-now.json").read_text(encoding="utf-8"))
        return str(cfg.get("session") or "").strip()
    except Exception:
        return ""


def append_user(text: str) -> None:
    CHAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    entry = {"role": "user", "text": text, "at": int(time.time() * 1000)}
    sid = bound_sid_full()
    if sid:
        entry["sid"] = sid
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def append_notice(text: str, sid: str = "") -> None:
    """往聊天流写一条居中「系统提示」气泡（绑定变更时用）。

    和 `append_user` 同一条流：窗口重开、滚动历史都还在；`sid` 显式带上，
    这样它只出现在被关联的那个会话里（缺省取当前绑定）。
    """
    text = (text or "").strip()
    if not text:
        return
    CHAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    entry = {"role": "notice", "text": text, "at": int(time.time() * 1000)}
    sid = sid or bound_sid_full()
    if sid:
        entry["sid"] = sid
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def session_title(sid: str) -> str:
    """读 DSH 会话日志里的**自定义标题**（`session/title` 记录的最后一条）。

    会话日志是 zstd 压缩的 JSONL；只解压一次、只认 `type=="session/title"`。
    拿不到（没装 zstandard / 文件不在 / 从没设过标题）就返回空串，调用方退回短 ID。
    """
    sid = (sid or "").strip()
    if not sid:
        return ""
    root = Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "sessions"
    try:
        workspaces = [d for d in root.iterdir() if d.is_dir()]
    except Exception:
        return ""
    for ws in workspaces:
        f = ws / sid / "session.v4.jsonl.zstd"
        if not f.is_file():
            continue
        try:
            import zstandard
            with open(f, "rb") as fh:
                raw = zstandard.ZstdDecompressor().stream_reader(fh).read()
        except Exception:
            return ""
        title = ""
        try:
            for line in raw.decode("utf-8", "replace").splitlines():
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("type") == "session/title":
                    t = (rec.get("data") or {}).get("title")
                    if isinstance(t, str) and t.strip():
                        title = t.strip()
        except Exception:
            return ""
        return title
    return ""


def _asr_config() -> dict:
    """`~/.dsh/asr.json` 的 `manage.start`：ASR 服务的解释器与模型目录。

    麦克风要跑 `mic.py`，它需要装有 sounddevice / sherpa_onnx 的解释器。
    这台机器上 PATH 里的 python 没有这些包，直接起会 ImportError 秒退
    （用户体感就是"点一下只响很短一下"）。
    """
    try:
        cfg = json.loads((Path.home() / ".dsh" / "asr.json").read_text(encoding="utf-8"))
        start = (cfg.get("manage") or {}).get("start") or []
        models = None
        if "--models" in start:
            i = start.index("--models")
            if i + 1 < len(start):
                models = start[i + 1]
        return {"python": start[0] if start else None, "models": models}
    except Exception:
        return {}


def asr_python() -> str:
    """麦克风用 ASR 的 Python，不是带 tkinter 的这个。"""
    for key in ("DSH_ASR_PYTHON", "DSH_FLOAT_PYTHON"):
        v = os.environ.get(key)
        if v:
            return v
    py = _asr_config().get("python")
    if py:
        # pythonw 没有 stderr，换成同目录的 python.exe（有输出，方便看 mic.log）
        if py.lower().endswith("pythonw.exe"):
            console = py[:-len("pythonw.exe")] + "python.exe"
            if Path(console).exists():
                return console
        if Path(py).exists():
            return py
    return "python.exe" if os.name == "nt" else "python3"


def display_hz() -> int:
    try:
        u = ctypes.windll.user32
        g = ctypes.windll.gdi32
        dc = u.GetDC(0)
        hz = int(g.GetDeviceCaps(dc, 116))
        u.ReleaseDC(0, dc)
        return hz if hz > 0 else 60
    except Exception:
        return 60


# ---------------------------------------------------------------- 窗口

# 虚拟桌面 = 所有显示器拼起来的物理像素范围。主屏固定从 (0,0) 起算，
# 第二块屏可能在它左边 / 上面，那时坐标本来就是负的 —— 只拿
# winfo_screenwidth()（= 主屏宽度）当边界，窗口就永远离不开主屏（#8）。
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79


def virtual_bounds(fallback_w=0, fallback_h=0):
    """(x, y, w, h)：虚拟桌面左上角与尺寸，物理像素。

    取不到（非 Windows / 远程会话偶尔返回 0）就退回主屏 (0, 0, w, h)。
    """
    try:
        u = ctypes.windll.user32
        vx = int(u.GetSystemMetrics(SM_XVIRTUALSCREEN))
        vy = int(u.GetSystemMetrics(SM_YVIRTUALSCREEN))
        vw = int(u.GetSystemMetrics(SM_CXVIRTUALSCREEN))
        vh = int(u.GetSystemMetrics(SM_CYVIRTUALSCREEN))
        if vw > 0 and vh > 0:
            return vx, vy, vw, vh
    except Exception:
        pass
    return 0, 0, int(fallback_w or 0), int(fallback_h or 0)


class LiveGlass:
    def __init__(self):
        cfg = read_config()
        raw_name = cfg.get("name")
        self.name = (raw_name.strip()[:24] if isinstance(raw_name, str) and raw_name.strip()
                     else "DSH")

        self._bound_full = bound_sid_full()
        self.feed = ChatFeed(CHAT_FILE, sid=self._bound_full)
        self._mic_proc = None
        self._protocol = WindowProtocol() if WindowProtocol is not None else None
        self._collapsed = False
        self._saved_h = DEFAULT_H
        self._snapshot_done = False
        self._title_entry = None
        self._title_item = None
        self._editing = False
        self._hidden = False
        self._cfg_key = None

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.title(self.name)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=KEY)
        self.root.attributes("-transparentcolor", KEY)
        # 半透明由"真实桌面背景 + 逐层 alpha"实现（见 _plain_frame），
        # 整窗 alpha 保持 1.0，否则文字也会跟着变淡。
        try:
            self.root.attributes("-alpha", 1.0)
        except Exception:
            pass
        self.fonts = Fonts(self.root)

        self._sw, self._sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        # 主屏尺寸只用来算默认位置；能拖到哪、抓屏能抓到哪，看虚拟桌面（多显示器）
        self._vx, self._vy, self._vw, self._vh = virtual_bounds(self._sw, self._sh)
        w, h, x, y = self._initial_geometry(cfg.get("geometry"),
                                            bump=not cfg.get("historyRow"))
        self._x, self._y = x, y
        # `_saved_h` = 用户态（展开态）高度，是写进配置的唯一来源。启动时就按恢复出来的
        # 高度初始化，否则「还没收起过就关窗」会把它记成 DEFAULT_H（2026-11-08 顺手修）。
        self._saved_h = max(MIN_H, h)
        if not cfg.get("historyRow"):
            # 底栏是新增的一行：位置不变、往下长，顺手把标记和几何一起落盘
            write_config({"historyRow": True, "geometry": f"{w}x{h}+{x}+{y}"})
        # 「关联变更」输入行的上边留白：0 = 收起，BAR_H = 打开（窗口向上长高、底边不动）
        self._pad = 0
        self._geo = Geometry.for_size(w, h, pad=self._pad)
        # 入场：从下方 22px 滑上来（不碰 -alpha，避免和抠色冲突）
        self._intro_target_y = y
        self._intro_y = y + 22
        self.root.geometry(f"{w}x{h}+{x}+{self._intro_y}")

        self.canvas = tk.Canvas(self.root, width=w, height=h, bg=KEY,
                                highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.text = TextLayer(self.root, self.canvas, self.fonts)

        # DSH 气泡左边的小头像（时间戳那一行）。加载失败不影响窗口，只留一行日志。
        self._avatar_img = None
        self._avatar_user_img = None
        try:
            _av = Image.open(Path(__file__).with_name("avatar.png")).convert("RGBA")
            _av = _av.resize((28, 28), Image.Resampling.LANCZOS)
            self._avatar_img = ImageTk.PhotoImage(_av, master=self.root)
        except Exception as _exc:
            print("avatar load failed:", repr(_exc), flush=True)
        try:
            _uv = Image.open(Path(__file__).with_name("avatar-user.png")).convert("RGBA")
            _uv = _uv.resize((28, 28), Image.Resampling.LANCZOS)
            self._avatar_user_img = ImageTk.PhotoImage(_uv, master=self.root)
        except Exception as _exc:
            print("user avatar load failed:", repr(_exc), flush=True)

        self._img = None
        self._last_frame = None
        self._collapsed_frame = None
        # 收起态半透明标题栏：抓屏对象、圆角遮罩、上一次背景（用来跳过没变化的重绘）
        self._sct = None
        self._coll_mask = None
        self._coll_mask_key = None
        self._coll_prev = None
        self._coll_at = 0.0
        self._coll_photo = None          # 复用 PhotoImage（paste 比每帧重建便宜 20 倍）
        self._coll_photo_size = None
        self._coll_bg = None             # 带留白的桌面缓存（拖动时按新位置裁）
        self._coll_bg_origin = (0, 0)
        self._coll_move_at = 0.0
        self._coll_need_grab = False
        self._grab_lock = threading.Lock()   # 主线程/拖动抓图线程不能同时改 WDA + 抓屏
        self._drag_worker_alive = False
        self._applied_x = 0
        self._applied_y = 0
        self._bd_sync_pending = False
        # 收起态「新消息」：当前消息 / 排好的气泡 / 图片点击区
        self._notif = None
        self._notif_msg = None
        self._notif_img_hits = []
        self._notif_scroll = 0           # 气泡内滚动量（px，恒为行高整数倍）
        self._notif_cap_override = None  # 收起态自己拖过高度时，用拖出来的值封顶
        self._bg = None
        self._entry = None
        self._entry_item = None
        self._bind_entry = None
        self._bind_entry_item = None
        self._bind_err = ""
        self._bind_ok_rect = None
        self._bind_input_rect = None
        self._bind_btn_rect = None
        # 底部「历史记录」：按钮 rect + 弹窗句柄（弹窗是独立 Toplevel，不参与玻璃渲染）
        self._history_rect = None
        self._hist = None
        self._base_h = 0
        self._bar = None
        self._bar_len = 0
        self._bar_color = "#b8cbe0"
        self._aux_at = 0.0

        self._hwnd = None
        self._excluded = False
        # **plain**：不抓屏、不做折射，直接画一块深色面板（2026-11-05 用户要求）。
        # 抓屏 + 折射每帧都要重算，拖动/缩放时既掉帧、背景还跟着闪；纯色面板只剩
        # 几个圆角矩形，缩放能跟到 60 帧。
        #
        # **但它仍然要抓一次"窗口背后的桌面"当底色**（半透明是按 alpha 叠出来的）。
        # 所以 plain 模式下 WDA 必须开着：否则抓到的画面里含窗口自身，
        # 每重画一次就是"自己盖自己一层"，越叠越黑（2026-11-05 实报）。
        self._plain = True
        self._cappable = capturable()
        # solid：远程/录屏下 WDA 会让整窗在对面消失；不抓屏、不设 WDA。
        self._solid = glass_mode() == "solid"
        self._frame_done = None
        # 展开中的气泡（消息的 at 时间戳）；None = 全是两行摘要
        self._expanded = None
        # 调试入口：启动时直接展开指定消息（自动化点击在透明窗口上不可靠）
        if os.environ.get("DSH_SEE_EXPAND_AT"):
            self._expanded = os.environ["DSH_SEE_EXPAND_AT"]
        self._btn_hits = []
        # 图片点击放大（2026-11-06）：每次重画气泡时记下「屏幕 rect → src」，
        # 点中就直接开原尺寸预览窗。滚动/重画都会重建，不需要额外失效逻辑。
        self._img_hits = []
        self._viewer = None
        self._orig_url = {}
        self._orig_busy = set()
        # 自动清理（2026-11-06）：配置独立存 see-now/cleanup.json，别和插件抢 see-now.json
        self._cleanup_at = 0.0
        self._cleanup_cache = None
        # 消息列表滚动状态（FEED_LIST 路径）：_scroll_px 0=顶部，越大越往回看
        self._scroll_px = 0
        self._scroll_target = 0
        self._scroll_max = 0
        self._scroll_at = 0.0
        self._scroll_timer = None
        self._follow_bottom = True
        self._feed_entries = []
        self._feed_total = 0
        self._view = (0, 0)
        # 回合状态（2026-11-06 用户要求 ①）：{sid: {...}}，文件变了才重读
        self._turn_states = {}
        self._turn_key = None
        # 投递回执（用户要求 ③）：{at: True/False}，文件变了才重读
        self._delivered = {}
        self._delivered_key = None
        # 「回到最新」按钮（用户要求 ②）：不在底部且来了新消息时才亮
        self._new_below = False
        self._jump_rect = None
        # 感官状态行（用户要求）：focus.json 的读取缓存
        self._focus_key = None
        self._focus_raw = {}
        self._focus_label = None
        # 图片（气泡里的 markdown / 裸路径 / URL）：本地同步加载，网络后台下载
        self._img_cache = {}
        self._img_pending = {}
        self._img_busy = set()
        self._seg_cache = {}
        self._charw_cache = {}
        self._probe_cache = {}
        self._drag = None
        self._resize = None
        self._preview_at = 0.0

        self._q: queue.Queue = queue.Queue(maxsize=1)
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._geo_lock = threading.Lock()
        self._source = CaptureSource((self._sw, self._sh), cappable=self._cappable,
                                     solid=self._solid,
                                     # 窗口落在副屏时，抓屏范围要按虚拟桌面钳
                                     bounds=(self._vx, self._vy, self._vw, self._vh))
        self._renderer = self._make_renderer(self._geo)
        self._worker = threading.Thread(target=self._work, daemon=True)

        self._hz = display_hz()
        self._target_fps = min(MAX_FPS, self._hz)
        self._ema = 1.0 / max(1, self._target_fps)
        self._last_motion = 0.0

        self.feed.reload()
        self._bound_sid = self._read_bound_session()
        self._replay_protocol()      # 先跳过旧事件，别让上一轮调试命令重跑
        self._claim_pid()            # 手动启动的窗口也要被插件认成"活着"
        self._layout()

        self.root.deiconify()
        self.root.update_idletasks()
        self.text.refresh()
        self._set_exclude(False if self._plain else (not capturable() and not self._solid))
        self._worker.start()
        self.root.lift()
        self.root.after(80, self.root.lift)
        self.root.after(120, self.root.focus_set)
        self.root.after(60, self._tick)
        self.root.after(30, lambda: self._intro_step(0))
        self.root.after(500, self._apply_placement)
        _bind_dbg = os.environ.get("DSH_SEE_BIND_OPEN")
        if _bind_dbg in ("1", "2"):
            # 调试入口：注入的鼠标进不了 -transparentcolor 窗，只能这样进「关联变更」态
            # "1" = 打开停住；"2" = 开一下再关（自测"开/关之后位置有没有跑"）
            self.root.after(700, self._show_bind_bar)
            if _bind_dbg == "2":
                self.root.after(1900, self._hide_bind_bar)
        elif _bind_dbg == "3":
            # "3" = 启动 8 秒后开、10 秒后关：留给外部脚本逐帧抓过渡
            self.root.after(8000, self._show_bind_bar)
            self.root.after(10000, self._hide_bind_bar)
        self.root.after(250, self._poll_chat)
        self.root.after(1200, self._keep_on_top)
        if SNAPSHOT:
            self.root.after(2600, self._snapshot_mode)

    # ---- 渲染后端 ----

    def _make_renderer(self, geo: Geometry):
        if USE_GPU:
            try:
                from glass_gpu import GpuRenderer
                return GpuRenderer(geo, MotionTracker(), native=NATIVE)
            except Exception as exc:
                print("GPU 初始化失败，回落到 CPU:", repr(exc), flush=True)
        return CpuRenderer(geo)

    # ---- 尺寸 ----

    def _shapes(self, w=None, h=None):
        """`shapes_for` 的带 pad 版本：所有布局都要走它，否则「关联变更」行一开就错位。"""
        pad = getattr(self, "_pad", 0)
        return shapes_for(self._geo.width if w is None else w,
                          self._geo.height if h is None else h, pad)

    def _initial_geometry(self, geo, bump: bool = False):
        sw, sh = self._sw, self._sh
        w, h = DEFAULT_W, DEFAULT_H
        # 默认位置仍是主屏居中偏右下（和以前一致）；恢复位置按虚拟桌面钳位，
        # 否则上次存在第二块屏上的坐标（负数）会被拉回主屏左上角。
        x, y = max(40, sw - w - 80), max(40, (sh - h) // 2 - 40)
        try:
            size, rest = geo.split("+", 1)
            pw, ph = (int(v) for v in size.split("x"))
            px, py = (int(v) for v in rest.split("+")[:2])
            w = max(MIN_W, min(sw - 40, pw))
            h = max(MIN_H, min(sh - 40, ph))
            # 2026-11-06 底栏：第一次跑新版本往下长 48px，消息区面积不变。
            # 用配置里的 `historyRow` 做一次性标记，不然每次重启都长高一截。
            if bump:
                h = max(MIN_H, min(sh - 40, h + HISTORY_ROW_H))
            # 钳位范围取「虚拟桌面 ∪ 主屏」：多显示器拔掉之后，注册表里那块屏还会被
            # GetSystemMetrics 报出来（比如整块在主屏左边，虚拟桌面右边缘就只剩 1133），
            # 按它钳位会把保存好的位置硬拉回左边 —— 每次重启窗都"自己跑掉"（2026-11-05 实踩）。
            x0 = min(self._vx, 0)
            x1 = max(self._vx + self._vw, sw)
            y0 = min(self._vy, 0)
            y1 = max(self._vy + self._vh, sh)
            x = max(x0, min(x1 - w, px))
            y = max(y0, min(y1 - h, py))
            print(f"geometry: saved={geo} screen={sw}x{sh} "
                  f"virtual=({self._vx},{self._vy},{self._vw},{self._vh}) -> {x},{y}", flush=True)
            print(f"flags: wda_off={DEBUG_NO_WDA} plain={PREVIEW or SNAPSHOT} "
                  f"cappable={capturable()}", flush=True)
        except Exception:
            pass
        return w, h, x, y

    def _sync_screens(self):
        """刷新虚拟桌面范围：接/拔显示器、改分辨率后不用重开窗口。

        拖动/缩放开始前调一次就够（GetSystemMetrics 很便宜，但没必要每帧问）。
        """
        vx, vy, vw, vh = virtual_bounds(self._sw, self._sh)
        if vw > 0 and vh > 0:
            self._vx, self._vy, self._vw, self._vh = vx, vy, vw, vh
            if getattr(self, "_source", None) is not None:
                self._source.bounds = (vx, vy, vw, vh)
        return self._vx, self._vy, self._vw, self._vh

    def _set_geometry(self, geo: Geometry) -> None:
        """换一套几何：渲染器跟着换，静态跳帧的签名作废。

        `_defer_canvas_size`：canvas 是 `pack(fill=both)`，改它的尺寸会顺着 pack 传播
        把 toplevel 也改大。开/关「关联变更」输入行时我们要**先在旧尺寸的画布上把新一帧
        画完，再一次性改窗口大小**，否则新长出来那条会先黑一下（2026-11-05 实报）。
        """
        self._geo = geo
        self._renderer.set_geometry(geo)
        if not getattr(self, "_defer_canvas_size", False):
            self.canvas.config(width=geo.width, height=geo.height)

    def _apply_shapes(self, shapes) -> None:
        """气泡宽度/高度变了：尺寸相关的遮罩/折射图直接复用，只重算框。"""
        with self._geo_lock:
            self._set_geometry(self._geo.with_shapes(shapes))

    # ---- 窗口外观 ----

    def _intro_step(self, n: int) -> None:
        try:
            if n >= 6:
                self._y = self._intro_target_y
            else:
                self._y = self._intro_target_y + int(22 * (1 - (n + 1) / 6.0))
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
        except Exception:
            pass
        if n < 6:
            self.root.after(26, lambda: self._intro_step(n + 1))

    def _keep_on_top(self) -> None:
        """把窗口重新顶回 topmost 带的最前面。

        只设一次 `-topmost` 不够：游戏、截图工具自己也是 topmost 窗口，而 Windows 的
        同一个 topmost 带里**谁最后 SetWindowPos 谁在上面**。现在每 800ms 用
        `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` 硬顶一次：不抢焦点、不重绘。

        **能力边界**：独占全屏下桌面不参与合成，任何普通窗口都盖不上去（只有 D3D hook
        的 overlay 做得到）；无边框窗口化 / 有边框窗口下这条看门狗有效。
        """
        try:
            # 预览窗/右键菜单/确认弹窗开着时也不要抢：这条每 800ms 把主窗顶回
            # topmost 带最前面，会把刚打开的图窗、右键菜单、确认框挤到下面去
            # （2026-11-06 实测；重命名/删除确认框同理）。
            if (not self._hidden and not self._collapsed
                    and not self._viewer_alive()
                    and not getattr(self, "_img_menu", None)
                    and not self._dialog_alive()):
                hwnd = self._hwnd_root()
                if hwnd:
                    user32 = ctypes.windll.user32
                    user32.SetWindowPos.argtypes = [
                        wintypes.HWND, wintypes.HWND,
                        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                        wintypes.UINT,
                    ]
                    user32.SetWindowPos.restype = wintypes.BOOL
                    # HWND_TOPMOST=-1；SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE
                    user32.SetWindowPos(
                        wintypes.HWND(hwnd), wintypes.HWND(-1), 0, 0, 0, 0,
                        0x0001 | 0x0002 | 0x0010)
                self.root.attributes("-topmost", True)
                self.root.lift()
        except Exception as exc:
            # 每 800ms 一次，出错不能刷屏；但第一次必须留痕（日志见 see-now-window.log）
            if not getattr(self, "_top_err_logged", False):
                self._top_err_logged = True
                print("keep_on_top error", exc, flush=True)
        try:
            self.root.after(800, self._keep_on_top)
        except Exception:
            pass

    # ---- 协议 ----

    def _render_event(self, event) -> None:
        if not isinstance(event, dict):
            return
        if event.get("type") in ("message", "meta"):
            ev = dict(event)
            # 协议推来的消息没有 `sid`：按"当前绑定"记，否则会被主窗的会话过滤丢掉
            ev.setdefault("sid", getattr(self, "_bound_full", ""))
            msg = ChatFeed.parse(json.dumps(ev, ensure_ascii=False))
            if self.feed.add(msg):
                self._refresh_feed()
                if msg is not None and msg.get("role") == "assistant":
                    self._maybe_notify([msg])
        elif event.get("type") == "control":
            self._apply_control(event)

    def _apply_control(self, event) -> None:
        action = str(event.get("action") or "")
        value = event.get("value")
        try:
            if action == "rename" and str(value or "").strip():
                self.name = str(value).strip()[:24]
                self.root.title(self.name)
                write_config({"name": self.name})
                self._refresh_feed()
            elif action == "collapse" and not self._collapsed:
                self.toggle_collapse()
            elif action == "expand" and self._collapsed:
                self.toggle_collapse()
            elif action == "bench" and DEBUG_CTL:
                # 量"缩放掉帧"到底花在哪：几何构建 / 面板合成 / 整次 preview
                import time as _t
                pw, ph = self._geo.width, self._geo.height
                for (bw, bh) in ((480, 615), (700, 800), (900, 1000)):
                    t0 = _t.perf_counter()
                    g = Geometry.for_size(bw, bh, pad=self._pad)
                    t1 = _t.perf_counter()
                    old = self._geo
                    self._geo = g
                    self._plain_frame()
                    t3 = _t.perf_counter()
                    self._geo = old
                    self._preview_size = (0, 0)
                    self._preview_resize(bw, bh)
                    t4 = _t.perf_counter()
                    print(f"[bench] {bw}x{bh} geo={(t1-t0)*1000:.1f}ms "
                          f"frame={(t3-t1)*1000:.1f}ms "
                          f"preview_resize={(t4-t3)*1000:.1f}ms", flush=True)
                # 复原：preview 会把 canvas/toplevel 撑到最后一档，必须自己收回来
                self._preview_size = (0, 0)
                self._rebuild(pw, ph)
                self.canvas.config(width=pw, height=ph)
                self._place_now(pw, ph)
                self.root.update_idletasks()
            elif action == "simrelease" and DEBUG_CTL:
                # 复现"松手"：窗口先摆到目标尺寸（拖手时就是这样），再走真实 _release。
                # 用来量松手后到底卡在哪一步，不用手动拖。
                import types
                tw, th = int(value[0]), int(value[1])
                self._resize = ("se", 0, 0, self._x, self._y, tw, th)
                self._resize_target = (tw, th, self._x, self._y)
                self._preview_size = (0, 0)
                self.root.geometry(f"{tw}x{th}+{self._x}+{self._y}")
                self.root.update_idletasks()
                self._release(types.SimpleNamespace(x=10, y=10,
                                                   x_root=self._x + 10,
                                                   y_root=self._y + 10))
            elif action == "notif" and DEBUG_CTL:
                # 调试（要 DSH_SEE_DEBUG=1）：造一条假新消息灌进收起态气泡，
                # 用来量「封顶高度 / 气泡内滚动」，不写 chat.jsonl。
                # value = {"chars": 5000, "img": "C:\\...\\x.png"}
                v = value if isinstance(value, dict) else {}
                chars = max(0, int(v.get("chars", 300)))
                img = str(v.get("img") or "")
                if not self._collapsed:
                    self.toggle_collapse()
                body = (("很长的正文用来把气泡撑高，看它会不会顶出屏幕，能不能滚到底。"
                         * (chars // 25 + 1))[:chars] if chars else "")
                if img:
                    body = (body + "\n\n![图片](" + img + ")").strip()
                self._show_notification({"role": "assistant", "text": body,
                                         "at": f"{time.time():.3f}"})
                _n = self._notif or {}
                print(f"[notif] chars={chars} img={bool(img)} "
                      f"h={_n.get('h', 0)} inner={_n.get('inner_h', 0)} "
                      f"view={_n.get('view_h', 0)} ls={_n.get('ls', 0)} "
                      f"cap={self._notif_cap()} saved_h={self._saved_h}",
                      flush=True)
            elif action == "dump" and DEBUG_CTL:
                # 调试：把画布上真有的 item 数/类型/包围盒打出来（截图看不到窗时用）
                items = self.canvas.find_all()
                print(f"[dump] items={len(items)} collapsed={self._collapsed} "
                      f"geo={self._geo.width}x{self._geo.height} "
                      f"notif={bool(self._notif)} "
                      f"canvas={self.canvas.winfo_width()}x{self.canvas.winfo_height()} "
                      f"root={self.root.winfo_width()}x{self.root.winfo_height()} "
                      f"mapped={self.canvas.winfo_ismapped()} "
                      f"bgitem={self._bg is not None}", flush=True)
                for i in items[:14]:
                    try:
                        print("   ", self.canvas.type(i), self.canvas.bbox(i),
                              self.canvas.itemcget(i, "tags"), flush=True)
                    except Exception as exc:
                        print("    err", exc, flush=True)
            elif action in ("bindbar", "resize") and DEBUG_CTL:
                # 调试入口（要 DSH_SEE_DEBUG=1）：-transparentcolor 窗收不到 SendInput，
                # PostMessage 也进不了 Tk 的绑定，只能靠协议触发；同时挡住"重启时把
                # 上一轮调试事件重放一遍"——否则窗会自己开一下、变大一次。
                if action == "bindbar":
                    self._toggle_bind_bar()
                else:
                    rw, rh = int(value[0]), int(value[1])
                    self._pad = 0
                    self._sync_pos()
                    self._rebuild(rw, rh)
                    self._place_now(rw, rh)
                    self.root.update_idletasks()
                    if not self._collapsed:
                        self._saved_h = max(MIN_H, rh)
                    self._save_geometry()
                    print(f"[trace] resize {rw}x{rh} "
                          f"root={self.root.winfo_width()}x{self.root.winfo_height()}",
                          flush=True)
            elif action == "history" and DEBUG_CTL:
                # 调试入口：协议里发 `{"action":"history"}` 打开选会话页；
                # `"value":"session-xxxx"` 直接看那个会话。透明窗没法自动化点击。
                self._open_history(value if isinstance(value, str) and value.strip() else None)
            elif action == "hide":
                self._hidden = True
                write_config({"hidden": True})
                self.root.withdraw()
            elif action == "show":
                self._hidden = False
                write_config({"hidden": False})
                self.root.deiconify()
                self.root.attributes("-topmost", True)
        except Exception as exc:
            # 静默失败查起来太贵（2026-11-06 调试 resize 时整条命令被吞）
            print("control failed:", action, repr(exc), flush=True)

    def _drain_protocol(self) -> list:
        if self._protocol is None:
            return []
        try:
            return self._protocol.read_events()
        except Exception:
            return []

    def _replay_protocol(self) -> None:
        """开场：把 `window-events.jsonl` 里已有的行**全部跳过**，只从当前末尾往后读。

        以前这里想"回放最后 60 条"，但 `read_events()` 的偏移从来没被初始化，
        第一次 `_drain_protocol` 仍然从头读 —— 上一轮调试留下的 `bench` / `simrelease`
        会在启动时整个执行一遍（2026-11-06 实测：窗口自己从 520x758 变成 820x920）。
        消息也不在这儿补：它们都在 `chat.jsonl` 里，`ChatFeed` 会读。
        """
        if self._protocol is None:
            return
        try:
            self._protocol.reset_events(0)
        except Exception:
            pass

    # ---- 聊天轮询 ----

    # ---- 回合状态 / 投递回执（2026-11-06 用户要求 ①③） ----

    def _load_turn_states(self) -> bool:
        """重读 `turn-state.json`（插件写的）。返回"变了没有"。"""
        try:
            st = TURN_STATE_FILE.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key == self._turn_key:
            return False
        self._turn_key = key
        try:
            data = json.loads(TURN_STATE_FILE.read_text(encoding="utf-8"))
            self._turn_states = data if isinstance(data, dict) else {}
        except Exception:
            self._turn_states = {}
        return True

    def _turn_info(self, sid: str):
        if not sid:
            return None
        info = self._turn_states.get(sid)
        return info if isinstance(info, dict) else None

    @staticmethod
    def _dur_label(ms) -> str:
        try:
            sec = max(0, int(round(float(ms) / 1000.0)))
        except Exception:
            return ""
        h, rest = divmod(sec, 3600)
        m, s = divmod(rest, 60)
        if h:
            return f"{h} 小时 {m} 分"
        if m:
            return f"{m} 分 {s} 秒"
        return f"{s} 秒"

    def _status_text(self, sid: str) -> str:
        """最新气泡下面那行灰字。没状态（插件没写过 / 老会话）就不画。"""
        self._load_turn_states()      # stat 一下，变了才重读
        info = self._turn_info(sid)
        if not info:
            return ""
        state = str(info.get("state") or "")
        if state == "running":
            return "运行中"
        if state == "completed":
            started, ended = info.get("startedAt"), info.get("endedAt")
            try:
                if started and ended and float(ended) >= float(started):
                    return f"已完成，用时 {self._dur_label(float(ended) - float(started))}"
            except Exception:
                pass
            return "已完成"
        if state == "error":
            return "出错"
        if state == "stopped":
            reason = str(info.get("reason") or "")
            if reason == "max-tokens":
                return "已停止（超出长度）"
            if reason == "blocked":
                return "已阻止"
            if reason == "forked":
                return "已分叉"
            return "已停止"
        return ""

    def _load_delivered(self) -> bool:
        """重读 `delivered.jsonl`：`{at: True/False}`（True=已送达，False=发送失败）。"""
        try:
            st = DELIVERED_FILE.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key == self._delivered_key:
            return False
        self._delivered_key = key
        out = {}
        try:
            for line in DELIVERED_FILE.read_text(encoding="utf-8").splitlines()[-4000:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                at = rec.get("at")
                if at:
                    out[str(int(at))] = bool(rec.get("ok", True))
        except Exception:
            out = {}
        self._delivered = out
        return True

    # 多久之后不能再叫「发送中」。
    #
    # 回执是**事后**才写的（循环 / relay / 阻塞等待三个消费者各写一条）。只要有一条
    # 漏写，那颗胶囊就永远是橙的 —— 用户明明已经看到回复了，气泡还挂着「发送中」，
    # 显示的是假信息（2026-11-08 实报「图2」；根因是阻塞等待那条路没写回执，已修）。
    # 这里加一条兜底：超过两分钟还没回执，说的就不是"正在发"，而是"我不知道"。
    SEND_STALE_SEC = 120.0

    def _send_state(self, at) -> tuple[str, str]:
        """(文字, 颜色)：橙=还没确认收到、绿=已送达、红=投递失败、灰=太久没回执。"""
        key = str(at or "")
        if key in self._delivered:
            return ("已送达", "#3ddc84") if self._delivered[key] else ("发送失败", "#e05a5a")
        try:
            age = time.time() - float(at) / 1000.0
        except (TypeError, ValueError):
            age = 0.0
        if age > self.SEND_STALE_SEC:
            return ("未确认", "#8e9db2")
        return ("发送中", "#f0a020")

    def _draw_send_state(self, e, stamp_y) -> None:
        """③ 用户气泡时间戳左边那枚小胶囊（深底圆角 + 彩点 + 彩字）。

        不参与排版：它画在时间戳那一行里，高度/宽度都不改条目尺寸，
        所以回执变化时只要 `_redraw_bubbles()` 就够，不用重排。
        """
        label, col = self._send_state(e.get("key"))
        f9 = self.fonts.get(9)
        stamp_w = f9.measure(e.get("stamp") or "")
        x1 = e["stamp_tx"] - stamp_w - 10
        x0 = x1 - (f9.measure(label) + 28)
        y0, y1 = stamp_y + 1, stamp_y + 17
        cy = (y0 + y1) / 2
        try:
            self.canvas.create_polygon(self._rounded_points(x0, y0, x1, y1, 8, 4),
                                       fill="#0f1612", outline="#243029",
                                       smooth=True, tags=("bubbles", "sendstate"))
            self.canvas.create_oval(x0 + 8, cy - 3, x0 + 14, cy + 3, fill=col,
                                    outline="", tags=("bubbles", "sendstate"))
            self.text.draw(x0 + 20, cy, label, anchor="w", fill=col, size=9,
                           tags=("bubbles", "sendstate"))
        except Exception:
            pass

    # ---- 感官状态：标题栏分割线下面那行固定小字（2026-11-06 用户要求） ----

    FOCUS_STALE_SEC = 10.0
    # 四态（2026-11-09 用户要求：视觉 / 听觉两个轴分开亮，再细出「仅开启视觉」）。
    # 插件只写 `state`（live/listen/off）+ `audio`（bool），四态由这两个量组合出来。
    FOCUS_LIVE = "#3ddc84"      # 视觉 + 听觉：两轴都开
    FOCUS_VISION = "#ffa63d"    # 仅开启视觉（橙）
    FOCUS_AUDIO = "#4da3ff"     # 仅开启听觉（蓝）
    FOCUS_OFF = "#8e9db2"       # 未启用感官聚焦（灰）
    # 标题栏那颗点外圈的描边：同色压暗一档，亮在玻璃上不糊
    FOCUS_EDGE = {FOCUS_LIVE: "#2b6b45", FOCUS_VISION: "#8a4f18",
                  FOCUS_AUDIO: "#2b4d73", FOCUS_OFF: "#4a5563"}

    def _focus_info(self) -> tuple[str, str]:
        """(文字, 颜色)。插件写的 `focus.json` 超过几秒没更新就按「未启用」处理 ——
        DSH 关掉 / 插件卸掉之后不能一直亮着绿灯。

        四态，按「视觉开没开 / 耳朵开没开」两轴判定：
          视觉 + 听觉 → 绿「实时视觉 + 听觉」
          只有视觉    → 橙「仅开启视觉」
          只有听觉    → 蓝「仅开启听觉」（原「暂时仅监听」，2026-11-09 改名）
          都没开      → 灰「未启用感官聚焦」
        两轴各自只看自己的证据：视觉 = `state == "live"`，听觉 = `audio` 为真。
        **不拿 `state == "listen"` 当耳朵开着**（2026-11-09 实测踩过：切「只听」那一下
        回环设备没打开，state 仍是 listen，灯照蓝 = 骗人）。
        """
        try:
            st = FOCUS_FILE.stat()
            key, fresh = (st.st_mtime_ns, st.st_size), (time.time() - st.st_mtime) <= self.FOCUS_STALE_SEC
        except OSError:
            key, fresh = None, False
        if key != getattr(self, "_focus_key", None):
            self._focus_key = key
            try:
                self._focus_raw = json.loads(FOCUS_FILE.read_text(encoding="utf-8")) if key else {}
            except Exception:
                self._focus_raw = {}
        raw = self._focus_raw if fresh else {}
        state = str((raw or {}).get("state") or "off")
        audio = bool((raw or {}).get("audio"))
        if state == "live":
            if audio:
                return ("实时视觉 + 听觉", self.FOCUS_LIVE)
            return ("仅开启视觉", self.FOCUS_VISION)
        # 蓝色只看 `audio`，**不看 `state == "listen"`**：2026-11-09 实测切「只听」时
        # 耳朵起不来（回环设备没打开），可 state 仍是 listen —— 灯照蓝就是骗人。
        # 转写短暂 `paused` 时 audio 会假一会儿，那时显示灰也算实话（确实没在收东西）。
        if audio:
            return ("仅开启听觉", self.FOCUS_AUDIO)
        return ("未启用感官聚焦", self.FOCUS_OFF)

    def _draw_focus_line(self) -> None:
        """固定居中画在「标题栏分割线(78+pad)」与「消息视口顶(104+pad)」之间。

        刻意**不进** `_feed_entries`：它不属于内容流，滚动、翻页、新消息都不该动它。
        """
        c = self.canvas
        try:
            c.delete("focusline")
        except Exception:
            pass
        label, col = self._focus_info()
        self._focus_label = label
        if getattr(self, "_collapsed", False) or getattr(self, "_hidden", False):
            return
        w = self._geo.width
        pad = getattr(self, "_pad", 0)
        # 字号跟【历史记录】胶囊同级（11）；这条带子只有 26px 高，上下各留 3px
        cy = 91 + pad
        try:
            f11 = self.fonts.get(11)
            tw = f11.measure(label)
            dot = 8
            x0 = (w - (tw + dot + 8)) / 2
            c.create_oval(x0, cy - dot / 2, x0 + dot, cy + dot / 2, fill=col, outline="",
                          tags=("focusline",))
            self.text.draw(x0 + dot + 6, cy, label, anchor="w", fill=col, size=11,
                           tags=("focusline",))
            c.tag_raise("focusline")
        except Exception:
            pass

    def _poll_chat(self) -> None:
        try:
            self._sync_visible()
            for event in self._drain_protocol():
                self._render_event(event)
            if self._mic_proc is not None and self._mic_proc.poll() is not None:
                self._mic_proc = None
                self.feed.status = ""
                self._refresh_feed()
                self._draw_mic_dot()
            n0 = len(self.feed.messages)
            if self.feed.poll():
                new = self.feed.messages[n0:]
                # 不在底部时来了新消息 → 亮「回到最新」（2026-11-06 用户要求 ②）
                if (new and self._expanded is None
                        and not getattr(self, "_collapsed", False)
                        and not getattr(self, "_follow_bottom", True)):
                    self._new_below = True
                self._refresh_feed()
                self._maybe_notify(new)
            # 回合状态变了：重排（状态行是内容的一部分，会跟着滚）
            if self._load_turn_states():
                self._refresh_feed()
            # 投递回执变了：只重画气泡（时间戳左边那枚胶囊，不影响排版）
            if self._load_delivered():
                self._redraw_bubbles()
            # 感官状态行 + 标题栏那颗点：状态变了才重画（含"文件过期→灰"这种随时间切换）
            if self._focus_info()[0] != getattr(self, "_focus_label", None):
                self._draw_focus_line()
                self._refresh_header()
            self._feed_watchdog()
        except Exception as exc:
            import traceback
            print("chat poll error", exc, flush=True)
            print(traceback.format_exc(), flush=True)
        if not self._stop.is_set():
            self.root.after(250, self._poll_chat)

    def _feed_watchdog(self) -> None:
        """自愈：聊天流空了、但文件里确实有本会话的行 → 强制重读。

        2026-11-08 实报：换绑后主窗一直空白，头栏的短 id 却是对的。根因没抓到
        （feed 的增量游标停在了"读得到字节、但一行都没收下"的位置），但这种情况
        用一个便宜的自检就能兜住：每 5 秒看一眼，空 + 文件里有本会话的行 → reload。
        正常时（messages 非空）这一步不读盘，开销就是一次 len()。
        """
        now = time.time()
        if now - getattr(self, "_wd_at", 0.0) < 5.0:
            return
        self._wd_at = now
        if self.feed.messages:
            return
        sid = self.feed.sid
        try:
            size = CHAT_FILE.stat().st_size
        except OSError:
            return
        if size <= 0:
            return
        try:
            with open(CHAT_FILE, "r", encoding="utf-8") as f:
                tail = f.readlines()[-400:]
        except Exception:
            return
        for line in tail:
            m = ChatFeed.parse(line)
            if not m:
                continue
            if m.get("role") == "meta" or (sid and m.get("sid") == sid):
                print(f"[feed] watchdog reload sid={sid[:20]} size={size} "
                      f"oldpos={self.feed._pos}", flush=True)
                self.feed.reload()
                self._refresh_feed()
                return

    def _sync_visible(self) -> None:
        try:
            st = CONFIG.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key == self._cfg_key:
            return
        self._cfg_key = key
        want = bool(read_config().get("hidden"))
        if want == self._hidden:
            return
        self._hidden = want
        try:
            if want:
                self.root.withdraw()
            else:
                self.root.deiconify()
                self.root.attributes("-topmost", True)
                self.root.lift()
        except Exception:
            self._hidden = not want

    # ---- 输入 ----

    def _send(self, _event=None):
        if self._entry is None:
            return "break"
        text = self._entry.get().strip()
        if not text:
            return "break"
        text = self._expand_draft(text)      # [图片N] → ![图片](路径)
        try:
            append_user(text)
        except Exception as exc:
            self.feed.status = f"写不进去：{exc}"
            self._refresh_feed()
            return "break"
        try:
            self._entry.delete(0, "end")
        except Exception:
            pass
        self._img_refs = {}
        # 展开着某条气泡时发新话：先把它收回来，再贴到底部（2026-11-09 用户要求）。
        # 不收的话画面还钉在展开的那条上，自己刚发的话永远在视口外 —— 展开态把
        # `_scroll_px` 锁在 0（见 `_redraw_feed_layer`），新消息进来也看不见，
        # 只能手点「收回」。40ms 后那拍轮询拿到新消息时 `_follow_bottom` 仍是 True，
        # 于是自然停在最新一条。
        try:
            self._collapse_expanded(to_latest=True)
        except Exception as exc:
            print("collapse on send failed:", repr(exc), flush=True)
        try:
            if self._protocol is not None:
                self._protocol.action("say", text=text)
        except Exception:
            pass
        self._render_input()
        self.root.after(40, self._poll_chat)
        return "break"

    def _wheel(self, e):
        n = getattr(self, "_notif", None)
        if self._collapsed and n and n.get("overflow"):
            bx0, by0, bx1, by1 = n["bubble"]
            if bx0 <= e.x <= bx1 and by0 <= e.y <= by1:
                # 收起态长消息：滚轮滚气泡（一格 3 行），不滚背后看不见的列表
                step = NOTIF_SCROLL_STEP * max(1, n["ls"])
                self._notif_scroll_by(-step if e.delta > 0 else step)
                return
        if self.FEED_LIST:
            # 列表 / 展开态统一像素滚动，向上 = 往回看（120px/格）
            self._scroll_by(-120 if e.delta > 0 else 120)
            return
        if self._expanded is not None and getattr(self, "_expand_max", 0) > 0:
            # 旧四槽路径的展开翻页（FEED_LIST=False 时才走）
            step = -3 if e.delta > 0 else 3
            self._expand_offset = max(0, min(self._expand_max,
                                             getattr(self, "_expand_offset", 0) + step))
            self._layout()
            return
        if self.feed.scroll(1 if e.delta > 0 else -1):
            self._refresh_feed()

    def _toggle_mic(self):
        if self._mic_proc is not None and self._mic_proc.poll() is None:
            self._stop_mic()
            return
        if not MIC_SCRIPT.exists():
            self.feed.status = "找不到 mic.py"
            self._refresh_feed()
            return
        try:
            cmd = [asr_python(), str(MIC_SCRIPT), "--engine", "local"]
            models = _asr_config().get("models")
            if models:
                cmd += ["--models-dir", models]
            log_path = os.path.join(os.environ.get("DSH_VIDEO_CACHE_DIR", "."), "mic.log")
            try:
                log_fd = open(log_path, "a", encoding="utf-8")
            except Exception:
                log_fd = subprocess.DEVNULL
            self._mic_proc = subprocess.Popen(
                cmd, stdout=log_fd, stderr=log_fd,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            if log_fd is not subprocess.DEVNULL:
                log_fd.close()
            self.feed.status = "录音中"
            self.root.after(5000, self._check_mic)
        except Exception as exc:
            self.feed.status = f"麦起不来：{exc}"
        self._refresh_feed()
        self._draw_mic_dot()

    def _check_mic(self) -> None:
        """起麦克风 5 秒后还活着才算真的在录；秒退就把 mic.log 的位置露在状态行上。

        本机没有可用的输入端点（只枚举到 WDM-KS，PortAudio 打不开），mic.py 会秒退。
        不检查的话状态行一直写着"录音中"，实际什么都没录 —— 骗人。
        """
        p = self._mic_proc
        if p is None:
            return
        if p.poll() is not None:
            self._mic_proc = None
            self.feed.status = "麦克风没起来（看 ~/.dsh/see-now/mic.log）"
        self._refresh_feed()
        self._draw_mic_dot()

    def _stop_mic(self):
        p = self._mic_proc
        self._mic_proc = None
        self.feed.status = ""
        if p is not None and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        self._refresh_feed()
        self._draw_mic_dot()

    def _render_input(self) -> None:
        """输入文字画在 Canvas 上；Entry 只负责 IME/键盘，永远不可见。"""
        if self._entry is None:
            return
        c = self.canvas
        c.delete("inputtext", "inputcursor")
        try:
            text = self._entry.get()
            focused = self.root.focus_get() is self._entry
        except Exception:
            text, focused = "", False
        x0, y0, x1, y1, _r = self._geo.input_shape
        x, y = x0 + 84, y0 + 27
        maxw = max(60, x1 - x0 - 100)
        font = self.fonts.get(11)
        if not text:
            self._input_shift = 0
            self._input_start = 0
            self._img_refs = {}          # 草稿清空 = 图片标记作废
            if not focused:
                # 占位文案也必须截断：窄窗时它会穿过「发送」按钮（2026-11-06 实报）。
                room = x1 - x - 14
                ph = "在这里向它输入文字或图片……"
                if font.measure(ph) > room:
                    ph = "输入文字或图片…"
                self.text.draw(x, y, self._fit_text(font, ph, room), anchor="w",
                               fill="#8e9db2", size=11,
                               tags=("inputtext", "inputzone", "chrome"))
            else:
                self._caret_item(c, x + 1, y)
            self.text.refresh()
            return
        # 视图跟着插入点走（2026-11-07 实报：长文字时按 ←，左边被挡的字回不来）。
        # 老写法「从头上逐字砍到塞得下」永远钉在末尾，光标左移只会被钳到那一段开头。
        try:
            ins = int(self._entry.index("insert"))
        except Exception:
            ins = len(text)
        start, end = self._input_view(font, text, ins, maxw)
        if TRACE:
            print(f"[trace] input view n={len(text)} ins={ins} start={start} end={end}",
                  flush=True)
        self._input_shift = start
        self._draw_input_text(c, x, y, font, text[start:end], start, focused)
        self.text.refresh()

    def _input_view(self, font, text, ins, maxw):
        """长文本的可见区间 [start, end)：光标在视野里就不动，出界才滚。

        2026-11-07 实报：长文字按 ← 时，被左边挡住的字不会往右回来。
        老写法是"从头逐字砍到塞得下"，视图永远钉在尾，光标左移只被钳在尾巴那段开头。
        现在按原生单行输入框的规矩走：
        - 光标还在视野里 → 视图不动（鼠标点中间不会整段跳）；
        - 从左边出界 → 每按一次只右移一个字，文字连续滑，不回跳；
        - 从右边出界（打字 / End）→ 贴尾，留 2px 给光标。
        """
        n = len(text)
        if n <= 0:
            return 0, 0
        ins = max(0, min(n, ins))

        def end_from(s):
            """从 s 起最多装到哪（宽度 ≤ maxw）。只看可见那一截，不扫全文。"""
            e, w = s, 0.0
            while e < n:
                c = self._char_w(font, text[e])
                if w + c > maxw:
                    break
                w += c
                e += 1
            return e

        start = max(0, min(n - 1, getattr(self, "_input_start", 0)))
        end = end_from(start)
        if ins < start:
            # 左边出界：一次只挪一个字，文字连续右滑
            start = max(0, ins - 1)
        elif ins >= end:
            # 右边出界（打字 / End）：贴尾，留 2px 给光标
            s, w = ins, 0.0
            while s > 0:
                c = self._char_w(font, text[s - 1])
                if w + c > maxw - 2:
                    break
                w += c
                s -= 1
            start = s
        elif end == n and start > 0:
            # 尾巴已经全露出来：把左边也尽量拉回来（删字后不留一段空白）
            w = 0.0
            for i in range(start, n):
                w += self._char_w(font, text[i])
            while start > 0:
                c = self._char_w(font, text[start - 1])
                if w + c > maxw:
                    break
                w += c
                start -= 1
        self._input_start = start
        return start, end_from(start)

    def _draw_input_text(self, c, x, y, font, text, shift, focused) -> None:
        """正文 + 选择高亮（Windows 那种蓝底白字）+ 插入光标。"""
        sel = getattr(self, "_sel", None)
        normal, picked = "#eef6ff", "#ffffff"
        if sel:
            a = max(0, min(len(text), sel[0] - shift))
            b = max(0, min(len(text), sel[1] - shift))
        else:
            a = b = -1
        if sel and b > a:
            xs = x + sum(self._char_w(font, ch) for ch in text[:a])
            xe = xs + sum(self._char_w(font, ch) for ch in text[a:b])
            c.create_rectangle(xs - 1, y - 11, xe + 1, y + 11, fill="#0a64c8",
                               outline="", tags=("inputtext", "chrome"))
            if a:
                self.text.draw(x, y, text[:a], anchor="w", fill=normal, size=11,
                               tags=("inputtext", "inputzone", "chrome"))
            self.text.draw(xs, y, text[a:b], anchor="w", fill=picked, size=11,
                           tags=("inputtext", "inputzone", "chrome"))
            if b < len(text):
                self.text.draw(xe, y, text[b:], anchor="w", fill=normal, size=11,
                               tags=("inputtext", "inputzone", "chrome"))
        else:
            self.text.draw(x, y, text, anchor="w", fill=normal, size=11,
                           tags=("inputtext", "inputzone", "chrome"))
        if not focused:
            return
        try:
            ins = int(self._entry.index("insert")) - shift
        except Exception:
            ins = len(text)
        ins = max(0, min(len(text), ins))
        cx = x + sum(self._char_w(font, ch) for ch in text[:ins])
        self._caret_item(c, cx + 1, y)

    CARET_COLOR = "#eaf4ff"
    CARET_W = 2

    def _caret_item(self, c, cx, y) -> int:
        """输入光标：2px 亮白、上下各 10px，按 `_caret_on` 决定先画不画（闪烁）。

        2026-11-06 用户实报「光标太不显眼」：原来是 1px 的 #b9d7ff，压在深色输入条上
        基本看不见。现在加粗提亮 + 520ms 闪一次。
        """
        try:
            item = c.create_line(cx, y - 10, cx, y + 10, fill=self.CARET_COLOR,
                                 width=self.CARET_W, tags=("inputcursor", "chrome"))
        except Exception:
            return 0
        if not getattr(self, "_caret_on", True):
            try:
                c.itemconfigure(item, state="hidden")
            except Exception:
                pass
        return item

    def _caret_tick(self) -> None:
        """光标闪烁：只有输入框有焦点才翻；没焦点保持常亮，下次聚焦立刻可见。"""
        try:
            focused = self._entry is not None and self.root.focus_get() is self._entry
        except Exception:
            focused = False
        if focused:
            self._caret_on = not getattr(self, "_caret_on", True)
            try:
                self.canvas.itemconfigure(
                    "inputcursor", state=("normal" if self._caret_on else "hidden"))
            except Exception:
                pass
        else:
            self._caret_on = True
        try:
            self.root.after(520, self._caret_tick)
        except Exception:
            pass

    def _queue_input_render(self):
        """把重画排到 idle：连按时只留一个待画，一串键只画最后状态。"""
        if getattr(self, "_input_render_queued", False):
            return
        self._input_render_queued = True

        def _redraw():
            self._input_render_queued = False
            t0 = time.perf_counter() if TRACE else 0.0
            # 键盘选择（Shift+方向 / Ctrl+A）在隐藏 Entry 里发生：同步过来再画
            self._sel = self._entry_selection()
            self._render_input()
            if TRACE:
                try:
                    n = len(self._entry.get())
                except Exception:
                    n = -1
                print(f"[trace] input key n={n} {(time.perf_counter() - t0) * 1000:.1f}ms",
                      flush=True)

        try:
            self.root.after_idle(_redraw)
        except Exception:
            _redraw()

    def _on_input_key(self, _e=None):
        # 先让 Tk 把光标/文本改完，再在 idle 里重画。
        # 2026-11-07 实报：按 ← 时视图不动，要等下一次按键才补上 —— 根因是同步重画
        # 读到的还是改之前的 insert 索引（实测 trace 里连按 3 次 ← 都是 ins=5000）。
        self._queue_input_render()
        return None

    def _on_root_key(self, _e=None):
        """按住方向键时 Windows 只发重复的 KeyDown（松手才有一个 KeyUp）。

        只绑 `<KeyRelease>` 的话，按住期间一次重画都没有 —— 用户看到的是"光标
        只在松手后跳一下，看不到移动过程"（2026-11-07 实报，输入栏里有字时）。
        root 的绑定排在 Entry 类绑定之后，读到的 insert 已经是新位置。
        """
        if self._entry is None:
            return None
        try:
            if self.root.focus_get() is not self._entry:
                return None
        except Exception:
            return None
        self._queue_input_render()
        return None

    def _entry_selection(self):
        try:
            if self._entry is not None and self._entry.selection_present():
                a = int(self._entry.index("sel.first"))
                b = int(self._entry.index("sel.last"))
                return (min(a, b), max(a, b))
        except Exception:
            pass
        return None

    def _input_index_at(self, x):
        """画布 x → 文本里的字符索引（和绘制同一套字宽、同一段可见区间）。"""
        text = self._entry.get() if self._entry is not None else ""
        f = self.fonts.get(11)
        x0, _y0, _x1, _y1, _r = self._geo.input_shape
        base = x0 + 84
        shift = getattr(self, "_input_shift", 0)
        acc = 0.0
        for i, ch in enumerate(text[shift:], start=shift):
            w = self._char_w(f, ch)
            if base + acc + w / 2 > x:
                return i
            acc += w
        return len(text)

    def _input_press(self, e=None):
        """点输入栏：拿焦点 + 把光标放到点的位置，并开始一段选择。"""
        self._focus_input(e)

    def _input_select_to(self, x):
        anchor = getattr(self, "_sel_anchor", None)
        if anchor is None:
            return
        idx = self._input_index_at(x)
        self._sel_cur = idx
        self._sel = None if idx == anchor else (min(idx, anchor), max(idx, anchor))
        try:
            self._entry.icursor(idx)
        except Exception:
            pass
        self._render_input()

    def _focus_input(self, _e=None):
        try:
            self._entry.focus_force()
        except Exception:
            pass
        if _e is not None and hasattr(_e, "x"):
            idx = self._input_index_at(_e.x)
            self._sel_anchor = idx
            self._sel_cur = idx
            self._sel = None
            self._sel_drag = True
            try:
                self._entry.icursor(idx)
            except Exception:
                pass
        else:
            try:
                self._entry.icursor("end")
            except Exception:
                pass
        self._render_input()

    # ---- 改名 ----

    def _edit_title(self, _event=None):
        # **收起态不许改名**：那条 78px 里没地方放 180px 的输入框，而且"按住标题拖"
        # 本来就是收起态最常用的动作 —— 双击在收起态没有第二个含义。
        if getattr(self, "_collapsed", False):
            return "break"
        # **刚拖过就不算双击**：Tk 判双击只看两次按下的时间差（500ms），不看中间位移，
        # 于是"点住标题拖一下、松手、紧接着再点一下"也会进改名 —— 输入框悬在标题上，
        # 光标就停在「DSH」后面（2026-11-08 实报「拖动标题栏后冒出迷之光标」）。
        if time.time() - getattr(self, "_drag_moved_at", 0.0) < 0.8:
            return "break"
        if self._editing:
            return "break"
        self._editing = True
        if self._title_entry is None:
            self._title_entry = tk.Entry(self.root, font=self.fonts.spec(15), relief="flat",
                                         bd=0, bg="#1b2330", fg="#f7fbff",
                                         insertbackground="#f7fbff")
            self._title_entry.bind("<Return>", self._commit_title)
            self._title_entry.bind("<Escape>", self._cancel_title)
            self._title_entry.bind("<FocusOut>", self._commit_title)
        self._title_entry.delete(0, "end")
        self._title_entry.insert(0, self.name)
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
        self._title_item = self.canvas.create_window(68, 38, anchor="w",
                                                     window=self._title_entry, width=180)
        self._title_entry.focus_set()
        self._title_entry.select_range(0, "end")
        return "break"

    def _commit_title(self, _event=None):
        if not self._editing:
            return
        self._editing = False
        text = self._title_entry.get().strip()
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        if text and text != self.name:
            self.name = text[:24]
            self.root.title(self.name)
            write_config({"name": self.name})
            try:
                if self._protocol is not None:
                    self._protocol.action("rename", value=self.name)
            except Exception:
                pass
        self._refresh_feed()
        return "break"

    def _cancel_title(self):
        self._editing = False
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        self._refresh_feed()
        return "break"

    # ---- 折叠 ----

    def toggle_collapse(self, _event=None):
        # 折叠时没有"标题栏上方"这一说，先把输入行收掉，否则高度和 pad 对不上。
        # **不在这里记账**（save=False）：收输入行时窗高是中间值（展开高/`_base_h`），
        # 而 `_collapsed` 这时还是 False，`_save_geometry` 会按「展开态」去读窗高。
        # 只要窗当时停在过渡尺寸（比如展开请求被 Tk/DPI 吞掉、还停在气泡的 998），
        # 998 就被写进配置，下次展开/重启矮一截（2026-11-07 23:3x 实踩）。
        if getattr(self, "_pad", 0):
            self._hide_bind_bar(save=False)
        # 收起前先把改名输入框收掉：它会作为 canvas window item 悬在标题上，
        # 收起后没有标题栏可改，留着就是一颗凭空闪的光标（2026-11-08 实报）。
        if getattr(self, "_editing", False):
            self._editing = False
            if self._title_item is not None:
                self.canvas.delete(self._title_item)
                self._title_item = None
        # 先读真实坐标再切高度：_x/_y 只是启动时的缓存，拖动/缩放后已过期。
        self._sync_pos()
        self._collapsed = not self._collapsed
        if self._collapsed:
            self._saved_h = max(MIN_H, self._geo.height)
            # 每次重新收起都按当前展开高度重新封顶，别沿用上一轮拖出来的临时高度
            self._notif_cap_override = None
            self._notif_scroll = 0
            # 收起后展开态那些点击区全部失效（坐标和现在这扇窗对不上）：
            # 不清掉的话点「新消息」里的图会先命中上一轮气泡的「展开」三角
            self._btn_hits = []
            self._img_hits = []
            self._history_rect = None
            self._collapse_rect = None
            # 先换成折叠尺寸的几何，再按它裁上一帧，否则圆角遮罩还是整窗高度
            self._set_geometry(Geometry.for_size(self._geo.width, collapsed_height()))
            # dxcam 的帧来自它自己的采集线程：必须**常开** WDA 才能把它排除掉，
            # 否则每次抓到的垫图里都带着上一帧的自己，刷新就变成"叠加"（2026-11-06 实报）。
            # 代价：收起态窗在截图/录屏里看不到（展开态不受影响）。
            # 调试（DSH_SEE_WDA=0）：不常开 —— 代价是抓垫图退回 mss（见 `_grab_backdrop`）。
            self._set_exclude(not DEBUG_NO_WDA)
            # 抓一块带留白的垫图当底（抓不到就退化成没有垫图、只剩遮罩）
            self._grab_collapsed_bg()
            self._collapsed_frame = None
            self._coll_prev = None
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout()
        else:
            self._clear_notification()
            self._collapsed_frame = None
            self._coll_photo = None
            self._coll_photo_size = None
            self._set_exclude(False)
            self._set_geometry(Geometry.for_size(self._geo.width, self._saved_h))
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout(seed=True)
        try:
            if self._protocol is not None:
                self._protocol.action("collapse" if self._collapsed else "expand")
        except Exception:
            pass

    # ---- 收起态标题栏：半透明（2026-11-06 用户要求「黑色 50%，其他元素 100%」） ----
    #
    # 整窗 `-alpha` 会把文字/按钮一起变淡，所以不用它：照纯色模式的老思路，
    # 把窗口背后的桌面抓下来，和 50% 黑预混成一张不透明图当底，文字照旧画在上面。
    # 抓屏时临时开 WDA 排除自己，否则抓到的就是上一帧的半透明条，越刷越黑。

    def _collapsed_mask(self, w: int, h: int):
        """标题条那块圆角遮罩（和 `Geometry.collapsed_frame` 同一块），按尺寸缓存。"""
        key = (w, h)
        if getattr(self, "_coll_mask_key", None) != key:
            mask = Image.new("L", (w, h), 0)
            try:
                x0, y0, x1, y1 = self._geo.slabs[0][:4]
            except Exception:
                x0, y0, x1, y1 = 12, 12, w - 12, 66
            ImageDraw.Draw(mask).rounded_rectangle((x0, y0, x1, y1),
                                                   radius=SLAB_RADIUS, fill=255)
            self._coll_mask, self._coll_mask_key = mask, key
        return self._coll_mask

    def _grab_backdrop(self, x: int, y: int, w: int, h: int):
        """抓窗口背后一块**带留白**的桌面：返回 (padded 图, (gx, gy))；失败 (None, None)。

        留白是给拖动用的：窗口在留白范围内移动时，直接从缓存里裁当前窗口下面那块，
        位置永远是对的，不用每帧重抓（抓一次 6~20ms，拖动按 60fps 重抓不现实）。
        抓的时候临时 WDA 排除自己，抓完恢复。
        """
        if self._solid:
            return None, None
        fn = ctypes.windll.user32.SetWindowDisplayAffinity
        fn.argtypes = [wintypes.HWND, wintypes.DWORD]
        fn.restype = wintypes.BOOL
        try:
            hwnd = wintypes.HWND(self._hwnd_root())
        except Exception:
            return None, None
        pad = COLL_PAD
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        gx = max(vx, int(x) - pad)
        gy = max(vy, int(y) - pad)
        gr = min(vx + vw, int(x) + int(w) + pad)
        gb = min(vy + vh, int(y) + int(h) + pad)
        gw, gh = gr - gx, gb - gy
        if gw <= 0 or gh <= 0:
            return None, None
        with self._grab_lock:
            prev = 0x11 if getattr(self, "_excluded", False) else 0
            if not fn(hwnd, 0x11):
                return None, None
            try:
                # 调试（DSH_SEE_WDA=0）：dxcam 的帧来自常驻采集线程，WDA 才设下去时它拿到的
                # 还是旧帧（就是第 62 条的"叠加"根因）。调试时退回 mss —— 同步抓，WDA 已生效。
                img = None if DEBUG_NO_WDA else _dxcam_grab(gx, gy, gr, gb)
                if img is not None:
                    return _frost(img), (gx, gy)
                if self._sct is None:
                    # mss 10 起 `mss.mss()` 已弃用（会往日志里打 DeprecationWarning）
                    self._sct = mss.MSS() if hasattr(mss, "MSS") else mss.mss()
                shot = self._sct.grab({"left": gx, "top": gy,
                                       "width": gw, "height": gh})
                if shot.size != (gw, gh):
                    return None, None
                img = Image.frombytes("RGB", shot.size, shot.rgb)
                return _frost(img), (gx, gy)
            except Exception:
                return None, None
            finally:
                fn(hwnd, prev)
                self._excluded = bool(prev)

    @staticmethod
    def _crop_bg(bg, origin, x, y, w, h):
        """从带留白的缓存里裁出窗口当前位置那块；超出缓存返回 None。"""
        if bg is None:
            return None
        left = int(x) - int(origin[0])
        top = int(y) - int(origin[1])
        if left < 0 or top < 0 or left + w > bg.width or top + h > bg.height:
            return None
        return bg.crop((left, top, left + w, top + h))

    def _collapsed_overlay(self, w: int, h: int):
        """窗口大小的 RGBA 遮罩层：形状内是 50% 色块，形状外涂 KEY（被抠成透明）。

        收起态改成「垫图 + 遮罩层」：垫图钉在桌面坐标里，拖动时只挪画布上的图，
        内容不会跟着窗口晃（2026-11-06 用户要求）。
        """
        n = getattr(self, "_notif", None)
        bub = tuple(n["bubble"]) if n else None
        key = (w, h, bub)
        if getattr(self, "_ovl_key", None) == key and getattr(self, "_ovl_img", None) is not None:
            return self._ovl_img
        img = Image.new("RGBA", (w, h), (1, 2, 3, 255))       # == KEY #010203
        d = ImageDraw.Draw(img)
        try:
            x0, y0, x1, y1 = self._geo.slabs[0][:4]
        except Exception:
            x0, y0, x1, y1 = 12, 12, w - 12, 66
        d.rounded_rectangle((x0, y0, x1, y1), radius=SLAB_RADIUS,
                            fill=(0, 0, 0, 128))
        if bub:
            bx0, by0, bx1, by1 = bub
            if by1 > by0 and bx1 > bx0:
                d.rounded_rectangle((bx0, by0, bx1, by1), radius=NOTIF_RADIUS,
                                    fill=(26, 46, 84, 128))
        self._ovl_img, self._ovl_key = img, key
        return img

    def _setup_collapsed_layers(self, c, w: int, h: int) -> None:
        """收起态画面 = 带留白的垫图（屏幕坐标）+ 窗口大小的遮罩层。"""
        try:
            l, t, _r, _b = self._bbox()
        except Exception:
            l, t = self._x, self._y
        self._bg_photo = None
        self._bg_item = None
        bg = getattr(self, "_coll_bg", None)
        if bg is not None:
            try:
                self._bg_photo = ImageTk.PhotoImage(bg, master=c)
                self._bg_item = c.create_image(0, 0, anchor="nw",
                                               image=self._bg_photo)
            except Exception:
                self._bg_photo = None
                self._bg_item = None
        self._bg = self._bg_item
        try:
            self._ovl_photo = ImageTk.PhotoImage(self._collapsed_overlay(w, h),
                                                 master=c)
            c.create_image(0, 0, anchor="nw", image=self._ovl_photo,
                           tags=("ovl",))
        except Exception:
            self._ovl_photo = None
        self._move_collapsed_backdrop(l, t)
        self._coll_gen_shown = getattr(self, "_coll_gen", 0)

    def _move_collapsed_backdrop(self, x, y) -> None:
        """把垫图挪到「窗口在桌面上的位置」：内容钉在屏幕坐标里，不跟窗口走。"""
        item = getattr(self, "_bg_item", None)
        if item is None:
            return
        o = getattr(self, "_coll_bg_origin", (0, 0))
        try:
            self.canvas.coords(item, int(o[0]) - int(x), int(o[1]) - int(y))
        except Exception:
            pass

    def _schedule_backdrop_sync(self) -> None:
        """垫图的位移合到下一次 idle：和窗口移动同一拍上屏，不差一帧。"""
        if getattr(self, "_bd_sync_pending", False):
            return
        self._bd_sync_pending = True
        try:
            self.root.after_idle(self._sync_backdrop_now)
        except Exception:
            self._bd_sync_pending = False

    def _sync_backdrop_now(self) -> None:
        self._bd_sync_pending = False
        if not self._collapsed:
            return
        try:
            l, t, _r, _b = self._bbox()
        except Exception:
            return
        self._move_collapsed_backdrop(l, t)

    def _update_collapsed_backdrop(self, l, t) -> None:
        """换了新垫图：重建 PhotoImage、重新定位（整块上传，~10ms，别每帧做）。"""
        bg = getattr(self, "_coll_bg", None)
        if bg is None or getattr(self, "canvas", None) is None:
            return
        try:
            photo = ImageTk.PhotoImage(bg, master=self.canvas)
        except Exception:
            return
        self._bg_photo = photo
        item = getattr(self, "_bg_item", None)
        if item is None:
            self._layout()
            return
        try:
            self.canvas.itemconfigure(item, image=photo)
            self.canvas.tag_lower(item)
        except Exception:
            return
        self._move_collapsed_backdrop(l, t)
        self._coll_gen_shown = getattr(self, "_coll_gen", 0)

    def _grab_collapsed_bg(self) -> None:
        """抓一块带留白的垫图（收起 / 气泡出现 / 松手时用）。"""
        geo = self._geo
        try:
            l, t, _r, _b = self._bbox()
        except Exception:
            return
        bg, origin = self._grab_backdrop(l, t, geo.width, geo.height)
        if bg is None:
            return
        self._coll_bg, self._coll_bg_origin = bg, origin
        self._coll_gen = getattr(self, "_coll_gen", 0) + 1
        self._coll_need_grab = False

    def _refresh_collapsed(self, force: bool = False) -> None:
        """静止时定期重抓垫图：画面没变就只花一次抓屏，不重传图。"""
        if not self._collapsed or getattr(self, "_hidden", False):
            return
        if PREVIEW or SNAPSHOT or self._solid:
            return
        now = time.time()
        if not force and now - getattr(self, "_coll_at", 0.0) < COLLAPSED_REFRESH:
            return
        self._coll_at = now
        geo = self._geo
        w, h = geo.width, geo.height
        try:
            l, t, _r, _b = self._bbox()
        except Exception:
            return
        bg, origin = self._grab_backdrop(l, t, w, h)
        if bg is None:
            return
        self._coll_bg, self._coll_bg_origin = bg, origin
        self._coll_gen = getattr(self, "_coll_gen", 0) + 1
        self._coll_need_grab = False
        crop = self._crop_bg(bg, origin, l, t, w, h)
        if crop is not None:
            prev = getattr(self, "_coll_prev", None)
            cur = np.asarray(crop, dtype=np.int16)
            if prev is not None and prev.shape == cur.shape:
                d = np.abs(cur - prev)
                if float(d.mean()) < 0.4 and int(d.max()) < 8:
                    self._coll_gen_shown = self._coll_gen   # 内容没变，不用重传
                    return
            self._coll_prev = cur
        self._update_collapsed_backdrop(l, t)

    def _apply_drag_cache(self, force: bool = False) -> None:
        """拖动中：后台抓到新垫图就换一次；窗口快出垫图边缘时**必须**换（不然会露空）。

        换图是整块上传（840×820 约 10ms），平时限速 ~80ms；加速拖动时窗口可能一瞬间
        跑出 160px 的留白，所以靠近边缘时不受限速约束。
        """
        if not self._collapsed:
            return
        bg = getattr(self, "_coll_bg", None)
        if bg is None:
            return
        try:
            l, t, r, b = self._bbox()
        except Exception:
            return
        o = getattr(self, "_coll_bg_origin", (0, 0))
        margin = 40
        near_edge = (l - o[0] < margin or t - o[1] < margin
                     or (o[0] + bg.width) - r < margin
                     or (o[1] + bg.height) - b < margin)
        if not (force or near_edge):
            if getattr(self, "_coll_gen", 0) == getattr(self, "_coll_gen_shown", 0):
                return
            now = time.time()
            if now - getattr(self, "_drag_photo_at", 0.0) < 0.05:
                return
        self._drag_photo_at = time.time()
        self._update_collapsed_backdrop(l, t)

    def _start_drag_grab(self) -> None:
        """拖动时后台每 ~40ms 补抓一次桌面。

        拖动本身不抓屏（抓一次 6~20ms 会把拖动拖顿），但大气泡下背景不能一直冻着：
        用户实报「气泡出现后拖动还是延迟」。后台抓、主线程只负责裁+贴，互不打架。
        40ms 是用户定的：拖动本来就只拖一小会，CPU 高一点可以接受。
        """
        if getattr(self, "_drag_worker_alive", False):
            return
        try:
            self._hwnd_root()          # 先在主线程把句柄缓存好，线程里不再碰 Tk
        except Exception:
            return
        self._drag_worker_alive = True
        threading.Thread(target=self._drag_grab_loop, daemon=True).start()

    def _drag_grab_loop(self) -> None:
        try:
            while not self._stop.is_set():
                time.sleep(0.04)
                if not self._drag or not self._collapsed or self._stop.is_set():
                    break
                geo = self._geo
                try:
                    l, t, _r, _b = self._bbox()
                except Exception:
                    continue
                bg, origin = self._grab_backdrop(l, t, geo.width, geo.height)
                if bg is not None:
                    self._coll_bg, self._coll_bg_origin = bg, origin
                    self._coll_gen = getattr(self, "_coll_gen", 0) + 1
        except Exception:
            pass
        finally:
            self._drag_worker_alive = False

    # ---- 收起态「新消息」气泡（2026-11-06 用户要求） ----
    #
    # 收起时来一条 DSH 的新消息：主窗下方长出「头像 + 新消息 + 深蓝 50% 气泡」，
    # 气泡里是全文（不截断、没有展开按钮），文字白色、图片原样，图片可点开原尺寸。
    # 新消息直接顶掉旧的；点标题栏的展开（▾）就消失。
    # 气泡底同样用「抓屏背景 + 50% 深蓝预混」，所以整窗颜色和标题条是一套做法。

    def _notif_cap(self) -> int:
        """收起态气泡窗口的高度上限（口径 A，用户 2026-11-07 定）。

        取「展开态高度」`_saved_h`，让气泡底边正好压在展开窗的底边上；用户在收起态
        自己拖过边，就以拖出来的高度为准（`_notif_cap_override`，不写回展开高度）。
        最后再让屏幕底边兜底：窗口顶部在 `_y`，往下长不能越过屏幕。
        """
        cap = getattr(self, "_notif_cap_override", None) or self._saved_h or DEFAULT_H
        try:
            avail = (self._vy + self._vh) - self._y - 12
        except Exception:
            avail = cap
        return max(200, min(int(cap), int(avail)))

    def _compute_notif(self, msg):
        """把一条消息排成：segments、气泡 rect、视口、窗口高度。

        高度封顶（展开态高度 / 屏幕底边）。封不住的内容**不再从尾部删**，改为气泡
        内滚动查看（2026-11-07 用户要求：原来超长消息是被悄悄截断的）。
        段高统一对齐到行网格，滚动量恒为 `ls` 的整数倍 —— 文字永远不会出现半行。
        """
        if not msg:
            return None
        w = self._geo.width
        pad = NOTIF_PAD_X
        bx0, bx1 = NOTIF_MARGIN, w - NOTIF_MARGIN
        content_max = max(80, (bx1 - bx0) - 2 * pad)
        ls = max(1, self.fonts.get(11).metrics("linespace"))
        segs = []
        for kind, payload in self._parse_blocks(str(msg.get("text") or "")):
            if kind == "text":
                body = payload.strip("\n")
                if not body.strip():
                    continue
                lines = self._seg_lines(body, content_max, keep_blank=True)
                while lines and not any(lines[-1]):
                    lines.pop()
                if not lines:
                    continue
                segs.append({"kind": "text", "lines": lines,
                             "h": len(lines) * ls})
                continue
            src = str(payload)
            if src.startswith(("http://", "https://")):
                got = self._img_state(src, content_max, NOTIF_IMG_H)
                size = ((got[1].width(), got[1].height())
                        if got and got[1] is not None else None)
            else:
                size = self._img_probe(src, content_max, NOTIF_IMG_H)
            if size is None:
                segs.append({"kind": "img", "src": src, "w": 0, "h": ls + 6,
                             "max_w": content_max, "max_h": NOTIF_IMG_H})
            else:
                segs.append({"kind": "img", "src": src, "w": size[0],
                             "h": size[1] + 10, "max_w": content_max,
                             "max_h": NOTIF_IMG_H})
        if not segs:
            return None
        for seg in segs:
            seg["h"] = max(ls, -(-int(seg["h"]) // ls) * ls)   # 向上取整到行高
        inner_h = sum(s["h"] for s in segs)
        bubble_top = NOTIF_TOP + 28 + NOTIF_GAP
        view_max = self._notif_cap() - bubble_top - 12 - NOTIF_PAD_Y * 2
        view_max = max(ls * NOTIF_MIN_LINES, view_max)
        view_h = min(inner_h, max(ls, (view_max // ls) * ls))
        bubble_h = view_h + NOTIF_PAD_Y * 2
        h = bubble_top + bubble_h + 12
        return {"msg": msg, "segs": segs, "ls": ls, "w": w, "h": h,
                "bubble": (bx0, bubble_top, bx1, bubble_top + bubble_h),
                "tx": bx0 + pad, "ty": bubble_top + NOTIF_PAD_Y,
                "view": (bx0 + pad, bubble_top + NOTIF_PAD_Y,
                         bx1 - pad, bubble_top + NOTIF_PAD_Y + view_h),
                "inner_h": inner_h, "view_h": view_h,
                "scroll_max": max(0, inner_h - view_h),
                "overflow": inner_h > view_h}

    def _show_notification(self, msg) -> None:
        if not self._collapsed or not msg:
            return
        self._notif_msg = msg
        self._notif_scroll = 0          # 新消息顶掉旧的：从开头读
        self._layout_notification()

    def _clear_notification(self) -> None:
        self._notif = None
        self._notif_msg = None
        self._notif_img_hits = []
        self._notif_scroll = 0

    def _layout_notification(self) -> None:
        """按新消息重排：换几何 → 换窗高（往下长）→ 重抓底图 → 重画。"""
        if not self._collapsed or not getattr(self, "_notif_msg", None):
            return
        self._sync_pos()
        n = self._compute_notif(self._notif_msg)
        if n is None:
            return
        self._notif = n
        self._notif_scroll = max(0, min(int(getattr(self, "_notif_scroll", 0)),
                                        n["scroll_max"]))
        w, h = n["w"], n["h"]
        self._defer_canvas_size = True
        try:
            self._set_geometry(Geometry.for_size(w, h))
        finally:
            self._defer_canvas_size = False
        self._grab_collapsed_bg()
        self._collapsed_frame = None
        self._coll_prev = None
        try:
            self.root.geometry(f"{w}x{h}+{self._x}+{self._y}")
        except Exception:
            pass
        self._layout()

    def _draw_notification(self) -> None:
        """画头像 / 「新消息」/ 气泡内容；只画视口内的部分，超出靠滚动看。"""
        c = self.canvas
        try:
            dead = set(c.find_withtag("notif"))
            c.delete("notif")
        except Exception:
            dead = set()
        if dead:
            # item 删了，文字层还记着它们：顺手清掉，否则滚动多了缓存越积越大
            t = self.text
            t.items = [i for i in t.items if i not in dead]
            t._fixed.difference_update(dead)
            for i in dead:
                t._colors.pop(i, None)
                t._pending.pop(i, None)
        self._notif_img_hits = []
        n = getattr(self, "_notif", None)
        if not self._collapsed or not n:
            return
        if self._avatar_img is not None:
            try:
                c.create_image(20, NOTIF_TOP, anchor="nw",
                               image=self._avatar_img, tags=("notif",))
            except Exception:
                pass
        self.text.draw(54, NOTIF_TOP + 14, "新消息", anchor="w", fill="#ffffff",
                       size=10, tags=("notif",), shadow=True, adapt=False,
                       per_char=False)
        self._draw_notif_hint()
        vx0, vy0, vx1, vy1 = n["view"]
        scroll = int(getattr(self, "_notif_scroll", 0))
        x = n["tx"]
        y = n["ty"] - scroll          # 内容坐标：屏幕 y = 内容 y - 滚动量
        ls = n["ls"]
        bx0, _by0, bx1, _by1 = n["bubble"]
        body_w = bx1 - bx0
        for seg in n["segs"]:
            if seg["kind"] == "text":
                for line in seg["lines"]:
                    if y + ls > vy0 and y < vy1:
                        self._draw_notif_runs(x, y, line)
                    y += ls
                continue
            got = self._img_state(seg["src"], seg["max_w"], seg["max_h"])
            pil = got[0] if got else None
            photo = got[1] if got else None
            if photo is None:
                if y + ls > vy0 and y < vy1:
                    self.text.draw(x, y, "[图片]", anchor="nw", fill="#cfe0f5",
                                   size=11, tags=("notif",), adapt=False,
                                   per_char=False)
            elif pil is not None and y + photo.height() > vy0 and y < vy1:
                # canvas image 不能裁剪：越界部分先 crop 再贴（第 42 条的同一套）
                top = max(0, int(vy0 - y))
                bot = max(0, int((y + photo.height()) - vy1))
                cut = (self._crop_photo(str(seg.get("src") or ""), pil, top, bot)
                       if (top or bot) else photo)
                if cut is not None:
                    ix = bx0 + max(0, (body_w - cut.width()) // 2)
                    iy = y + top
                    try:
                        c.create_image(ix, iy, anchor="nw", image=cut,
                                       tags=("notif",))
                        self._notif_img_hits.append(
                            ((ix, iy, ix + cut.width(), iy + cut.height()),
                             str(seg.get("src") or "")))
                    except Exception:
                        pass
            y += seg["h"]
        if n["overflow"]:
            self._draw_notif_bar(n, scroll)

    def _draw_notif_hint(self) -> None:
        """「怎么关掉这条气泡」的提示（2026-11-07 用户要求）。

        跟「新消息」同一行，末尾的 ↑ 正对标题栏那颗展开按钮（▾ 的竖中线）——
        点它就收起、气泡跟着消失。**统一用精简句**（用户 23:1x 定：整句在窄窗会被
        截成「点击这个展…」，两种文案不如只用一种）；放不下就降字号，再不行才截断。
        """
        w = self._geo.width
        rect = getattr(self, "_title_tri_rect", None)
        tri_cx = ((rect[0] + rect[2]) / 2.0) if rect else (w - 91)
        cy = NOTIF_TOP + 14
        f10 = self.fonts.get(10)
        text = "要关闭预览气泡就点击这个"
        arrow = "↑"
        x0 = 54 + f10.measure("新消息") + 10            # 紧跟在「新消息」右边
        right = tri_cx - f10.measure(arrow) / 2.0 - 6   # 留 6px，别贴上箭头
        avail = right - x0
        size = 10
        for size in (10, 9, 8):
            if self.fonts.get(size).measure(text) <= avail:
                break
        else:
            size = 8
            text = self._fit_text(self.fonts.get(8), text, max(30, avail))
        self.text.draw(right, cy, text, anchor="e", fill="#dbe6f5", size=size,
                       tags=("notif",), shadow=True, adapt=False, per_char=False)
        self.text.draw(tri_cx, cy, arrow, anchor="center", fill="#ffffff",
                       size=max(11, size + 1), tags=("notif",), shadow=True,
                       adapt=False, per_char=False)

    def _draw_notif_bar(self, n, scroll: int) -> None:
        """气泡右侧细滚动条：只表示「还有多少、现在在哪」，不做拖拽。"""
        bx0, by0, bx1, by1 = n["bubble"]
        top = by0 + NOTIF_PAD_Y
        bot = by1 - NOTIF_PAD_Y
        track = max(1, bot - top)
        x = bx1 - 6
        try:
            self.canvas.create_line(x, top, x, bot, width=3, fill="#22304a",
                                    capstyle="round", tags=("notif",))
            thumb = max(24, int(track * n["view_h"] / max(1, n["inner_h"])))
            thumb = min(track, thumb)
            span = max(0, track - thumb)
            pos = (scroll / n["scroll_max"]) if n["scroll_max"] else 0.0
            y0 = top + int(span * max(0.0, min(1.0, pos)))
            self.canvas.create_line(x, y0, x, y0 + thumb, width=3,
                                    fill="#a8c0dd", capstyle="round",
                                    tags=("notif",))
        except Exception:
            pass

    def _notif_scroll_by(self, dy: int) -> bool:
        """滚气泡内容；到顶/到底也算「吃掉了这次滚轮」，别漏给背后看不见的列表。"""
        n = getattr(self, "_notif", None)
        if not self._collapsed or not n or not n.get("overflow"):
            return False
        cur = int(getattr(self, "_notif_scroll", 0))
        new = max(0, min(n["scroll_max"], cur + dy))
        if new == cur:
            return True
        self._notif_scroll = new
        self._draw_notification()
        return True

    def _draw_notif_runs(self, x, y, line) -> None:
        """气泡正文：白字 100%，粗体加粗；和主窗同一套折行宽度。"""
        cx = x
        for txt, style in line:
            if not txt:
                continue
            self.text.draw(cx, y, txt, anchor="nw", fill="#ffffff", size=11,
                           bold=(style == "b"), tags=("notif",),
                           shadow=False, adapt=False, per_char=False)
            cx += self._run_font(style).measure(txt)

    def _maybe_notify(self, msgs) -> None:
        """刚进来的消息里挑最后一条 DSH 消息 → 收起态显示气泡。"""
        if not self._collapsed or not msgs:
            return
        last = None
        for m in msgs:
            if (m and str(m.get("role") or "") == "assistant"
                    and str(m.get("text") or "").strip()):
                last = m
        if last is not None:
            self._show_notification(last)

    # ---- 气泡布局 ----

    def _fit_lines(self, text, size, max_width, max_height) -> list[str]:
        """按框宽/框高折行并截断，避免文字溢出气泡。"""
        font = self.fonts.get(size)
        measure = font.measure
        ls = max(1, font.metrics("linespace"))
        max_lines = max(1, int(max_height // ls))
        no_start = "，。、；：！？）》」』…,.;:!?)]}"
        lines = []
        for para in str(text).splitlines() or [""]:
            cur = ""
            for ch in para:
                if not cur or measure(cur + ch) <= max_width:
                    cur += ch
                elif ch in no_start:
                    cur += ch          # 标点不能单独掉到下一行
                else:
                    lines.append(cur)
                    cur = ch
            lines.append(cur)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            last = lines[-1]
            while last and measure(last + "…") > max_width:
                last = last[:-1]
            lines[-1] = (last + "…") if last else "…"
        return lines or [""]

    def _message_shapes(self, shown):
        """按正文文字测量聊天气泡：**长句吃掉相邻的槽**，不越出既有槽位边界。

        2026-11-05 的两次踩坑：
          ① 原实现把四条槽写死 88px（`chat_layout`），气泡被夹住，长句只能截断；
          ② 第一版"自己算消息区坐标"的实现把**玻璃底板整块搞没了** —— `with_shapes`
             拿越界的盒子生成折射/底板贴图，整窗退化成全透明（进程活着、心跳在跳、
             屏幕上什么都没有）。所以现在只在槽位边界内分配。
        兜底：自适应路径**任何异常都退回 legacy**，并往窗口日志留一行。
        """
        try:
            if os.environ.get("DSH_BUBBLE_LEGACY") == "1":
                return self._message_shapes_legacy(shown)
            shapes, infos = self._message_shapes_adaptive(shown)
            if shown and not any(s[3] > s[1] for s in shapes[:MESSAGE_SLOTS]):
                raise RuntimeError("adaptive layout produced no bubble boxes")
            return shapes, infos
        except Exception as exc:
            if not getattr(self, "_bubble_err_logged", False):
                self._bubble_err_logged = True
                print("adaptive bubble layout failed, falling back to legacy:", repr(exc), flush=True)
            return self._message_shapes_legacy(shown)

    def _message_shapes_legacy(self, shown):
        """旧的四等分槽位布局（兜底路径）。"""
        w, h = self._geo.width, self._geo.height
        base = self._shapes(w, h)
        left, right = base[0][0], base[0][2]
        max_bubble = min(right - left, max(240, int((right - left) * 0.72)))
        min_bubble = min(110, max_bubble)
        pad = 18
        fbody = self.fonts.get(11)
        fstamp = self.fonts.get(9)
        ls = max(1, fbody.metrics("linespace"))
        shapes, infos = [], []
        for i in range(MESSAGE_SLOTS):
            if i >= len(shown):
                shapes.append((0, 0, 0, 0, 0))     # 没有这条消息：不画框
                continue
            msg = shown[i]
            x0, y0, x1, y1, _r = base[i]
            slot_h = y1 - y0
            is_user = str(msg.get("role") or "").lower() in ("user", "me", "human")
            stamp = str(msg.get("stamp") or "")
            stamp_h = fstamp.metrics("linespace") if stamp else 0
            body_avail = max(12, slot_h - stamp_h)
            content_max = max(80, max_bubble - 2 * pad)
            lines = self._fit_lines(msg.get("text") or "", 11, content_max, body_avail)
            inner = max([0] + [fbody.measure(line) for line in lines])
            bw = min(max_bubble, max(min_bubble, inner + 2 * pad))
            bh = min(body_avail, max(ls + 16, len(lines) * ls + 16))
            by0 = y0 + stamp_h
            by1 = min(y1, by0 + bh)
            if is_user:
                bx1 = right
                bx0 = bx1 - bw
                tx, ta = bx1 - pad, "ne"
            else:
                bx0 = left
                bx1 = bx0 + bw
                tx, ta = bx0 + pad, "nw"
            shape = (bx0, by0, bx1, by1, min(26, max(16, bh // 3)))
            shapes.append(shape)
            infos.append({
                "shape": shape, "is_user": is_user, "stamp": stamp,
                "tx": tx, "ta": ta, "lines": lines,
                "ty": by0 + max(4, (bh - len(lines) * ls) // 2),
                "stamp_y": y0, "ls": ls,
            })
        self._slot_roles = [bool(info.get("is_user")) for info in infos]
        shapes.extend(base[MESSAGE_SLOTS:])
        return shapes, infos

    def _message_shapes_adaptive(self, shown):
        """按文字需要的高度分配槽位：一条消息可以占相邻的好几格。

        所有盒子的边都落在既有槽位的边界上（`slots[top][1]` 与槽底），所以玻璃底板
        的生成范围不会变 —— 这是第一版越界实现弄坏整窗之后定下的硬约束。
        """
        w, h = self._geo.width, self._geo.height
        base = self._shapes(w, h)
        slots = [tuple(base[i]) for i in range(MESSAGE_SLOTS)]
        if not slots or slots[0][3] <= slots[0][1]:
            raise RuntimeError("no message slots")
        left, right = slots[0][0], slots[0][2]
        pad = 18
        fbody = self.fonts.get(11)
        fstamp = self.fonts.get(9)
        ls = max(1, fbody.metrics("linespace"))
        stamp_ls = max(0, fstamp.metrics("linespace"))
        max_bubble = min(right - left, max(240, int((right - left) * 0.72)))
        min_bubble = min(110, max_bubble)
        content_max = max(80, max_bubble - 2 * pad)

        def measure(msg):
            stamp = str(msg.get("stamp") or "")
            stamp_h = stamp_ls if stamp else 0
            lines = self._fit_lines(msg.get("text") or "", 11, content_max, 10 ** 6)
            body = max(ls + 16, len(lines) * ls + 16)
            return stamp, stamp_h, lines, body

        # 摘要模式：DSH 的气泡只显示两行，右下角给一个「展开 / 收回」小按钮；
        # 自己发的气泡不截断（自己的话一般就一两句，截了反而看不到自己说了什么）。
        expanded = getattr(self, "_expanded", None)
        shown_list = list(shown)
        if expanded is not None:
            for msg in shown_list:
                if str(msg.get("at") or "") == str(expanded):
                    shown_list = [msg]          # 展开时独占整个消息区
                    break

        picked = []          # 旧的在前，最新的在后
        bottom = MESSAGE_SLOTS - 1
        for msg in reversed(shown_list):
            if bottom < 0:
                break
            stamp, stamp_h, lines, body = measure(msg)
            key = str(msg.get("at") or "")
            is_user = str(msg.get("role") or "").lower() in ("user", "me", "human")
            is_open = expanded is not None and key == str(expanded)
            more = False
            if not is_user and not is_open and len(lines) > 2:
                more = True
                lines = lines[:2]
                last = lines[-1]
                while last and fbody.measure(last + "…") > content_max:
                    last = last[:-1]
                lines[-1] = (last + "…") if last else "…"
                # 给右下角那颗按钮留出高度，别让它压在文字上
                body = max(ls + 16, len(lines) * ls + 16) + 32
            need = stamp_h + body
            top = bottom
            while top > 0 and slots[bottom][3] - slots[top][1] < need:
                top -= 1
            span = slots[bottom][3] - slots[top][1]
            if span < need:
                room = span - stamp_h
                if room < ls + 16:
                    break
                if is_open:
                    # 展开也放不下（窗口太矮）：展开态自己带一个行偏移，滚轮往下翻，
                    # 不然"展开了却看不到后面的内容、滚动条又到底"（2026-11-05 实报）
                    cap = max(1, (room - 16) // ls)
                    start = max(0, min(getattr(self, "_expand_offset", 0),
                                       max(0, len(lines) - cap)))
                    self._expand_offset = start
                    self._expand_max = max(0, len(lines) - cap)
                    lines = lines[start:start + cap]
                    body = max(ls + 16, len(lines) * ls + 16)
                else:
                    self._expand_max = 0
                    lines = self._fit_lines(msg.get("text") or "", 11, content_max, room)
                    body = max(ls + 16, min(len(lines) * ls + 16, room))
            picked.append((msg, stamp, stamp_h, lines, body, top, more or is_open, key))
            bottom = top - 1
        picked.reverse()

        shapes = [(0, 0, 0, 0, 0) for _ in range(MESSAGE_SLOTS)]
        infos = []
        for i, (msg, stamp, stamp_h, lines, body, top, show_btn, key) in enumerate(picked):
            y0 = slots[top][1]
            is_user = str(msg.get("role") or "").lower() in ("user", "me", "human")
            inner = max([0] + [fbody.measure(line) for line in lines])
            bw = min(max_bubble, max(min_bubble, inner + 2 * pad))
            by0 = y0 + stamp_h
            by1 = by0 + body
            if is_user:
                bx1 = right
                bx0 = bx1 - bw
                tx, ta = bx1 - pad, "ne"
            else:
                bx0 = left
                bx1 = bx0 + bw
                tx, ta = bx0 + pad, "nw"
            shape = (bx0, by0, bx1, by1, min(26, max(16, body // 3)))
            shapes[i] = shape
            info = {
                "shape": shape, "is_user": is_user, "stamp": stamp,
                "tx": tx, "ta": ta, "lines": lines,
                "ty": (by0 + 8 if (show_btn and not is_user)
                       else by0 + max(4, (body - len(lines) * ls) // 2)),
                "stamp_y": y0, "ls": ls, "key": key,
            }
            if show_btn and not is_user:
                # 展开/收回按钮：气泡右下角，样式仿「发送」但更小
                info["btn"] = (bx1 - 78, by1 - 32, bx1 - 10, by1 - 6)
                info["btn_label"] = "收回" if str(expanded) == str(key) else "展开"
            infos.append(info)
        self._slot_roles = [bool(info.get("is_user")) for info in infos]
        shapes.extend(base[MESSAGE_SLOTS:])
        return shapes, infos

    # ---- 布局 ----

    def _ensure_entry(self) -> None:
        """Entry 只建一次：每次消息都销毁重建会丢输入法状态和草稿光标。"""
        if self._entry is not None:
            return
        # 2×2 的隐藏 Entry 只用来吃键盘/IME；背景和光标都必须和底板同色，
        # 否则会在输入框左上角漏出一个白点（2026-11-06 实报）。
        self._entry = tk.Entry(self.root, bg="#000000", fg="#000000",
                               insertbackground="#000000",
                               relief="flat", bd=0, font=self.fonts.spec(11),
                               insertwidth=1, highlightthickness=0)
        self._entry.bind("<KeyRelease>", self._on_input_key)
        # 按住方向键期间只有重复的 KeyDown（Windows 松手才发 KeyUp），
        # 补一条 root 级绑定，让移动过程也能实时重画（第 83 条）。
        self.root.bind("<KeyPress>", self._on_root_key, add="+")
        self._entry.bind("<Return>", self._send)
        self._entry.bind("<Control-v>", self._paste_image)
        self._entry.bind("<Control-V>", self._paste_image)
        self._entry.bind("<FocusIn>", lambda _e: self._render_input())
        self._entry.bind("<FocusOut>", lambda _e: self._render_input())

    def _image_dir(self) -> str:
        folder = os.path.join(os.environ.get("DSH_VIDEO_CACHE_DIR", "."), "images")
        os.makedirs(folder, exist_ok=True)
        return folder

    def _paste_image(self, _e=None):
        """Ctrl+V：剪贴板里是位图/图片文件就插成 `![图片](src)`，否则交回默认文字粘贴。

        悬浮窗里给 DSH 发图的入口：截图 → Ctrl+V，图片落到 `~/.dsh/see-now/images/`，
        消息正文里带本地路径（DSH 那边可以直接读这个路径）。
        """
        clip = None
        try:
            from PIL import ImageGrab
            clip = ImageGrab.grabclipboard()
        except Exception:
            clip = None
        exts = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
        if isinstance(clip, list):
            for path in clip:
                if str(path).lower().endswith(exts):
                    self._insert_image(path)
                    return "break"
            return None
        if clip is not None:
            try:
                path = os.path.join(self._image_dir(),
                                    f"paste-{int(time.time() * 1000)}.png")
                clip.convert("RGB").save(path)
            except Exception:
                return None
            self._insert_image(path)
            return "break"
        return None

    def _insert_image(self, path: str) -> None:
        """输入框里只放一个短标记（[图片1]），真正发出去的还是 ![图片](路径)。

        2026-11-07 用户要求：完整路径+文件名在输入栏里太长，精简掉。
        """
        refs = getattr(self, "_img_refs", None)
        if refs is None:
            refs = self._img_refs = {}
        n = 1
        while f"[图片{n}]" in refs:
            n += 1
        token = f"[图片{n}]"
        refs[token] = f"![图片]({path})"
        self._insert_draft(token)

    def _expand_draft(self, text: str) -> str:
        """把草稿里的 [图片N] 换回 ![图片](路径)（发出去的内容一个字都不少）。"""
        for token, md in (getattr(self, "_img_refs", {}) or {}).items():
            if token in text:
                text = text.replace(token, md)
        return text

    def _insert_draft(self, text: str) -> None:
        try:
            self._entry.insert("insert", text)
            self._entry.focus_force()
            self._entry.icursor("end")
        except Exception:
            pass
        self._render_input()

    def _layout(self, seed: bool = False) -> None:
        """整窗重排：标题栏 + 气泡 + 输入区 + 滚动条，然后把上一帧贴回去。

        `seed=True` 时按新尺寸缩放上一帧先顶着（缩放/展开的过渡帧）。
        """
        c = self.canvas
        geo = self._geo
        w, h = geo.width, geo.height
        t_start = time.perf_counter()
        c.delete("all")
        self.text.reset()
        if self._collapsed:
            # 收起态：垫图 + 遮罩层（垫图钉在屏幕坐标，拖动只挪图）
            self._setup_collapsed_layers(c, w, h)
        else:
            self._bg = c.create_image(0, 0, anchor="nw")
            frame = self._last_frame
            if frame is not None and frame.size == (w, h):
                try:
                    self._img = ImageTk.PhotoImage(frame, master=c)
                    c.itemconfigure(self._bg, image=self._img)
                except Exception:
                    pass
            elif seed and self._last_frame is not None:
                preview = self._last_frame.resize((w, h), Image.Resampling.BILINEAR)
                try:
                    self._img = ImageTk.PhotoImage(preview, master=c)
                    c.itemconfigure(self._bg, image=self._img)
                except Exception:
                    pass
        if PREVIEW:
            c.create_rectangle(0, 0, w, h, fill="#0d131d", outline="", tags=("preview-bg",))
            c.tag_lower("preview-bg")

        self._draw_header()
        if self._collapsed:
            self._bind_header()
            if self._bg is not None:
                c.itemconfigure(self._bg, state="normal")
            self._bar = None
            if not self._plain:   # 纯色模式没有"玻璃高光"，这条线只会浮在标题上
                self._bar_len = max(72, int(w * BAR_FRAC))
                self._bar = c.create_line(w // 2 - self._bar_len // 2, BAR_Y,
                                          w // 2 + self._bar_len // 2, BAR_Y,
                                          width=BAR_THICK, fill=self._bar_color,
                                          capstyle="round")
            self._draw_notification()
            self.text.refresh()
            return

        self._draw_feed()
        t_feed = time.perf_counter()
        self._draw_input()
        self._draw_history_bar()
        # 感官状态行：固定压在「分割线 ↔ 消息视口顶」那条带子里
        self._draw_focus_line()
        if self._pad:
            self._draw_bind_bar()
        self._draw_scrollbar()
        self._bind_header()
        if TRACE:
            print(f"[trace] layout feed={(t_feed - t_start) * 1000:.0f}ms "
                  f"rest={(time.perf_counter() - t_feed) * 1000:.0f}ms", flush=True)
        c.tag_bind("send", "<Button-1>", self._send)
        c.tag_bind("inputzone", "<Button-1>", self._input_press)
        c.tag_raise("close")
        c.tag_raise("send")
        if self._pad:
            c.tag_raise("bindbar")      # 气泡/图片可能压上来，输入行必须在最上
            self._render_bind_input()

        self._bar = None
        if not self._plain:       # 纯色模式没有"玻璃高光"，这条线只会浮在标题上
            self._bar_len = max(72, int(w * BAR_FRAC))
            self._bar = c.create_line(w // 2 - self._bar_len // 2, BAR_Y,
                                      w // 2 + self._bar_len // 2, BAR_Y,
                                      width=BAR_THICK, fill="#b8cbe0", capstyle="round")
        self._bar_color = "#b8cbe0"
        self.text.refresh()

    def _read_bound_session(self) -> str:
        """`~/.dsh/see-now.json` 里绑定的会话短 ID（前 8 位），标题栏用。"""
        sid = bound_sid_full()
        if sid.startswith("session-"):
            sid = sid[len("session-"):]
        return sid[:8]

    def _draw_header(self) -> None:
        c = self.canvas
        w = self._geo.width
        # 标题栏左边这颗点表示**感官状态**（2026-11-09 起四态）：
        # 绿=实时视觉 + 听觉、橙=仅开启视觉、蓝=仅开启听觉、灰=未启用；
        # 文案与颜色都出自 `_focus_info()`，这颗点只取色，别再写死一份。
        # 麦克风开关挪到输入栏图标右边那颗小点，见 `_draw_mic_dot`。
        _label, dot = self._focus_info()
        edge = self.FOCUS_EDGE.get(dot, "#4a5563")
        # 标题栏玻璃是 y=12..66，中心 39；右边 ▾/✕ 也在 38。点、名字、状态必须
        # 同一条水平中线，且字号要能完整落在条内，不能压到气泡区。
        # pad：「关联变更」输入行打开时整条标题栏往下挪 pad，屏幕位置不变。
        pad = getattr(self, "_pad", 0)
        cy, dot_x, title_x = 38 + pad, 54, 68
        c.create_oval(dot_x - 9, cy - 9, dot_x + 9, cy + 9,
                      outline=edge, width=1,
                      tags=("header",))
        c.create_oval(dot_x - 4, cy - 4, dot_x + 4, cy + 4, fill=dot, outline="",
                      tags=("header",))
        name = self.name[:10]
        # 条数只数看得见的：被隐藏的条目不再出现在流里，写在这里会自相矛盾
        hid = self._hidden_keys()
        vis = sum(1 for m in self.feed.messages
                  if msg_key(m.get("sid") or "", m.get("at")) not in hid)
        count = self.feed.status or f"{vis} 条"
        label = "关联变更"
        f16, f11, f10 = (self.fonts.get(16, True), self.fonts.get(11),
                         self.fonts.get(10))
        tw = f10.measure(label)
        bx1 = w - 140
        bx0 = bx1 - (tw + 18)
        sid = getattr(self, "_bound_sid", "")
        # 窄窗降级顺序（2026-11-06 实报「窗口很小时文字飞出框」）：
        # 会话全称 → 只留短 ID → 连条数一起让位 → 名字自己截断。
        # 以前这里全是绝对坐标，480 宽时会话文字直接从名字上压过去。
        right_edge = bx0 - 14
        full_sid = f"【当前关联会话：{sid}】" if sid else None
        short_sid = sid or None
        count_w = f11.measure(count)
        name_w = f16.measure(name)
        # 展开态标题栏还要放一颗「收回」（52 宽 + 间距）：排会话文字时先把它扣出来，
        # 否则窄窗里它会被 `_chip_limit` 判定撞车而**整个不画** —— 展开后就没有收回入口了
        # （2026-11-06 实报：697 宽展开一条后只能重启窗口）。
        # 展开态的「收回」已经挪到那条消息的时间戳右边（`_paint_bubbles`），
        # 标题栏不再为它让位。
        chip_reserve = 0
        chosen = None
        for cand in ((full_sid, short_sid) if sid else (None,)):
            if cand is None:
                continue
            for with_count in (True, False):
                sid_w = f10.measure(cand)
                limit = right_edge - sid_w - 12
                need = (title_x + name_w + ((10 + count_w) if with_count else 0)
                        + chip_reserve)
                if need <= limit:
                    chosen = (cand, with_count)
                    break
            if chosen:
                break
        if chosen is None:
            # 连短 ID 都塞不下（480 宽就是这种）：先保条数，把 ID 截成「4f1ebd…」；
            # 条数也让不出来时，再让条数走、ID 独占剩下的宽度。
            avail = right_edge - 12 - (title_x + name_w + 10 + count_w) - chip_reserve
            if sid and avail >= 60:
                chosen = (self._fit_text(f10, sid, avail), True)
            else:
                avail = right_edge - 12 - (title_x + name_w) - chip_reserve
                if sid and avail >= 55:
                    chosen = (self._fit_text(f10, sid, avail), False)
                else:
                    chosen = (None, False)
        sid_text, show_count = chosen
        limit = (right_edge - (f10.measure(sid_text) + 12)) if sid_text else (bx0 - 12)
        name = self._fit_text(f16, name, limit - title_x - (count_w + 10 if show_count else 0))
        self.text.draw(title_x, cy, name, anchor="w", fill="#f7fbff", size=16,
                       bold=True, tags=("header", "title"))
        nx = title_x + f16.measure(name) + 10
        if show_count:
            self.text.draw(nx, cy, count, anchor="w",
                           fill="#ffb4b4" if self.feed.status else "#dbe6f5", size=11,
                           tags=("header",))
        # ▾ 展开/收起：2026-11-06 用户要求「和 ✕ 一样大」+「实际是收起时用正三角」。
        # 字形 ▾ 在同等字号下只有 ✕ 一半的视觉高度，改成 Canvas 实心三角，宽高都能对齐，
        # 点击区也跟着变成一整块。方向跟着当前动作走：正常态=收起→▴，收起态=展开→▾。
        # 2026-11-06 用户要求「加大一点」：三角 16×13 → 22×17，✕ 13 → 18 号字。
        tri_cx = w - 91
        try:
            if getattr(self, "_collapsed", False):
                tri = (tri_cx - 11, cy - 9, tri_cx + 11, cy - 9, tri_cx, cy + 10)
            else:
                tri = (tri_cx - 11, cy + 9, tri_cx + 11, cy + 9, tri_cx, cy - 10)
            c.create_polygon(*tri, fill="#ffffff", outline="",
                             tags=("header", "collapse"))
        except Exception:
            pass
        self.text.draw(w - 58, cy, "✕", anchor="w", fill="#ffffff", size=18,
                       tags=("header", "close"))
        # 判定范围跟着放大：原来按字形算（三角 16×13、✕ 只有一个字宽），
        # 现在各给一整块矩形，由 `_press` 先判 —— 见 2026-11-06 用户要求。
        self._title_tri_rect = (tri_cx - 18, cy - 19, tri_cx + 18, cy + 19)
        self._title_close_rect = (w - 70, cy - 19, w - 26, cy + 19)
        # 右侧排布：会话文字 | 【关联变更】| ▾ | ✕。原来会话文字贴到 w-112，
        # 和 ▾ 之间只有 18px，塞不下按钮 —— 整体左移给按钮腾位。
        # 胶囊宽度按文字实测宽 + 左右各 9px：框正好裹住四个字，不空也不裁（2026-11-05 用户要求）
        if sid_text:
            self.text.draw(bx0 - 14, cy, sid_text, anchor="e",
                           fill="#ffffff", size=10, tags=("header", "sessionid"))
        try:
            # 上下各留 15px（原来 11px 太薄，用户要求再高一点）
            c.create_polygon(self._rounded_points(bx0, cy - 15, bx1, cy + 15, 10, 4),
                             fill="#000000",
                             outline=(BTN_EDGE_ON if pad else BTN_EDGE), smooth=True,
                             tags=("header", "bindbtn"))
            self.text.draw((bx0 + bx1) // 2, cy, label, anchor="center",
                           fill="#ffffff", size=10, tags=("header", "bindbtn"))
            self._bind_btn_rect = (bx0, cy - 15, bx1, cy + 15)
        except Exception:
            self._bind_btn_rect = None
        # 标题栏与消息区之间的装饰分割线：标题条下沿 66+pad、消息区 104+pad，
        # 落在 78+pad 上正好居中；两端内缩，不做成整窗宽
        try:
            dy = cy + 40
            c.create_line(40, dy, w - 40, dy, fill="#ffffff", width=1,
                          tags=("header", "divider"))
        except Exception:
            pass
        # 「收回」放标题栏：气泡右下角那颗在展开态会被正文压住，长消息还得滚到底才够得着
        self._chip_x = nx + 14 + (count_w if show_count else 0)
        self._chip_cy = cy
        self._chip_limit = limit      # 右边到这儿为止（会话文字/胶囊的左缘）
        self._refresh_chip()

    def _refresh_chip(self) -> None:
        """「收回」现在画在展开那条气泡的时间戳右边（2026-11-06 用户要求 ⑤）。

        标题栏不再放这颗胶囊；这里只负责清掉旧版残留。`_collapse_rect` 交给
        `_paint_bubbles` 管（它每次重画都会重建），**不能在这里清** ——
        `_toggle_expand` 是先重画气泡、再调这里的。
        """
        try:
            self.canvas.delete("chip")
        except Exception:
            pass

    def _refresh_header(self) -> None:
        """只重画标题栏：绑定会话变了、条数变了，都不该整窗重排。"""
        try:
            self.canvas.delete("header")
            self._draw_header()
            self.text.refresh()
        except Exception as exc:
            print("header refresh failed:", repr(exc), flush=True)

    def _poll_bound_session(self) -> None:
        """每 2 秒看一眼 `see-now.json` 的 `session`，变了就切聊天流 + 重画标题栏。

        绑定现在由插件热读（改完不用重载插件），窗里这几个字必须跟着变 ——
        否则"我明明改了绑定"和"窗上还写着旧 id"会同时成立。

        2026-11-06：绑定也是"哪个会话的记录算主对话"的开关。变了就 `feed.set_sid()`
        整份重读 —— 主窗只留新会话的；旧的仍在 chat.jsonl 里，进【历史记录】。
        """
        now = time.time()
        if now - getattr(self, "_sid_at", 0.0) < 2.0:
            return
        self._sid_at = now
        # 同一拍里看一眼标题源（DSH 改名、窗口改名都会让签名变）
        self._poll_titles()
        try:
            full = bound_sid_full()
        except Exception:
            return
        if full == getattr(self, "_bound_full", ""):
            return
        self._bound_full = full
        self._bound_sid = self._read_bound_session()
        self._touch_group(full)
        if full:
            self._announce_bind(full)
        self.feed.set_sid(full)
        self._refresh_feed()
        try:
            print(f"[bind] sid={full[:20]} feed_msgs={len(self.feed.messages)} "
                  f"pos={self.feed._pos} size={CHAT_FILE.stat().st_size}",
                  flush=True)
        except Exception:
            pass

    # ---- 历史记录：分组元数据 ----

    def _groups_file(self) -> Path:
        return CHAT_FILE.with_name("session-groups.json")

    def _read_groups(self) -> dict:
        """{sid: boundAt}；文件坏了就当空的，不影响主流程。"""
        try:
            data = json.loads(self._groups_file().read_text(encoding="utf-8"))
        except Exception:
            return {}
        out = {}
        for g in (data.get("order") or []):
            if not isinstance(g, dict) or not g.get("sid"):
                continue
            try:
                out[str(g["sid"])] = int(g.get("boundAt") or g.get("lastAt") or 0)
            except Exception:
                out[str(g["sid"])] = 0
        return out

    def _touch_group(self, sid: str, at: int | None = None) -> None:
        """记一笔"这个会话什么时候被关联"。历史列表的排序用它。"""
        sid = (sid or "").strip()
        if not sid:
            return
        now = int(at if at is not None else time.time() * 1000)
        try:
            data = {}
            p = self._groups_file()
            if p.exists():
                try:
                    data = json.loads(p.read_text(encoding="utf-8")) or {}
                except Exception:
                    data = {}
            order = [g for g in (data.get("order") or []) if isinstance(g, dict) and g.get("sid")]
            for g in order:
                if g.get("sid") == sid:
                    g["boundAt"] = now
                    break
            else:
                order.append({"sid": sid, "boundAt": now})
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"order": order}, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            os.replace(tmp, p)
        except Exception as exc:
            print("group write failed:", repr(exc), flush=True)

    def _history_sessions(self) -> list[dict]:
        """除当前会话外的所有历史分组：[{sid, short, count, lastAt, boundAt}]，最近关联在前。

        2026-11-06：迁移时有一条 `say` 在会话日志里查不到（窗里说的话不进会话记录），
        它没有 `sid` —— 单列成「未归属」，不许默默丢掉。
        """
        cur = getattr(self, "_bound_full", "")
        hid = self._hidden_keys()
        stats: dict[str, dict] = {}
        try:
            lines = CHAT_FILE.read_text(encoding="utf-8").splitlines()[-4000:]
        except Exception:
            lines = []
        for line in lines:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("role") == "meta":
                continue
            sid = str(e.get("sid") or "")
            if sid == cur:
                continue
            if msg_key(sid, e.get("at")) in hid:      # 隐藏的不计数（2026-11-06）
                continue
            g = stats.setdefault(sid, {"sid": sid, "count": 0, "lastAt": 0})
            g["count"] += 1
            try:
                g["lastAt"] = max(g["lastAt"], int(e.get("at") or 0))
            except Exception:
                pass
        bound = self._read_groups()
        titles = self._session_titles()
        out = []
        for sid, g in stats.items():
            if not sid:
                out.append({"sid": "", "short": "未归属", "title": "",
                            "count": g["count"], "lastAt": g["lastAt"], "boundAt": 0})
                continue
            short = sid[len("session-"):][:8] if sid.startswith("session-") else sid[:8]
            out.append({"sid": sid, "short": short,
                        "title": titles.get(sid) or "",
                        "count": g["count"], "lastAt": g["lastAt"],
                        "boundAt": bound.get(sid) or g["lastAt"]})
        out.sort(key=lambda g: g["boundAt"], reverse=True)
        return out

    def _local_titles(self) -> dict:
        """窗口自己改的标题：{完整 sid: {"title": str, "at": ms}}。

        老格式是 `{sid: 标题}`（没有时间戳）：读的时候补 `at=0`，于是 DSH 镜像里
        任何一条都会盖过它 —— 迁移后这正是想要的（DSH 是真源，窗口只留自己的记录
        当后备）。
        """
        try:
            st = TITLES_FILE.stat()
            sig = ("local", st.st_mtime_ns, st.st_size)
        except OSError:
            return {}
        if sig == getattr(self, "_titles_sig", None):
            return {k: dict(v) for k, v in getattr(self, "_titles_cache", {}).items()}
        out = {}
        try:
            data = json.loads(TITLES_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, dict):
                    title = str(v.get("title") or "").strip()
                    at = int(v.get("at") or 0)
                else:
                    title, at = str(v or "").strip(), 0
                if title:
                    out[str(k)] = {"title": title, "at": at}
        self._titles_sig, self._titles_cache = sig, out
        return {k: dict(v) for k, v in out.items()}

    def _sync_titles(self) -> dict:
        """插件写的 DSH 标题镜像：{完整 sid: {"title", "source", "at"}}（只读）。"""
        try:
            st = TITLES_SYNC.stat()
            sig = ("sync", st.st_mtime_ns, st.st_size)
        except OSError:
            return {}
        if sig == getattr(self, "_sync_sig", None):
            return {k: dict(v) for k, v in getattr(self, "_sync_cache", {}).items()}
        out = {}
        try:
            data = json.loads(TITLES_SYNC.read_text(encoding="utf-8"))
            for sid, v in (data.get("titles") or {}).items():
                if not isinstance(v, dict):
                    continue
                title = str(v.get("title") or "").strip()
                if not title:
                    continue
                out[str(sid)] = {"title": title, "source": str(v.get("source") or ""),
                                 "at": int(v.get("at") or 0)}
        except Exception:
            out = {}
        self._sync_sig, self._sync_cache = sig, out
        return {k: dict(v) for k, v in out.items()}

    def _titles_detail(self) -> dict:
        """合并本地与 DSH 镜像，按 `at` 取新者：{sid: {title, at, source}}。

        时间戳是唯一裁判：两边都改了名时，谁改得晚听谁的；本地的老格式（`at=0`）
        自然输给 DSH 镜像。
        """
        merged = {}
        for sid, v in self._local_titles().items():
            merged[sid] = {"title": v["title"], "at": int(v["at"]), "source": "local"}
        for sid, v in self._sync_titles().items():
            cur = merged.get(sid)
            if cur is None or int(v["at"]) >= cur["at"]:
                merged[sid] = {"title": v["title"], "at": int(v["at"]),
                               "source": v.get("source") or "dsh"}
        return merged

    def _session_titles(self) -> dict:
        """回顾列表显示的标题：{完整 sid: 标题}（DSH 与本地已合并）。"""
        return {sid: v["title"] for sid, v in self._titles_detail().items()}

    def _save_titles(self, titles: dict) -> None:
        """写本地标题；值统一成 {"title", "at"}（改名时一律带时间戳）。"""
        try:
            tmp = TITLES_FILE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(titles, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, TITLES_FILE)
        except Exception as exc:
            print("titles save failed:", repr(exc), flush=True)
        self._titles_sig = None

    # ---- 标题同步（2026-11-09 用户要求） ----
    #
    # DSH 是真源：会话日志里最新的 `session/title`。插件把事件写成 `title-sync.json`
    # 镜像，窗口这边只读它；窗口里改的标题反过来写 `title-request.json`，插件调
    # `sessionController.rename` 写回 DSH（左侧栏跟着变）。**不要**自己往会话日志塞
    # 事件 —— 那是 zstd 追加流，进不了客户端投影。

    def _poll_titles(self) -> None:
        """每 2 秒看一次标题源变了没有（`_poll_bound_session` 里调）。

        变了就做两件事：① 当前绑定会话的标题若被**用户**改过，主窗补一条居中系统
        提示（自动生成的标题不弹，否则每轮都吵）；② 回顾窗停在列表页时重画。
        """
        sig = []
        for p in (TITLES_FILE, TITLES_SYNC):
            try:
                st = p.stat()
                sig.append((st.st_mtime_ns, st.st_size))
            except OSError:
                sig.append(None)
        sig = tuple(sig)
        first = not hasattr(self, "_titles_seen_sig")
        if sig == getattr(self, "_titles_seen_sig", None):
            return
        self._titles_seen_sig = sig
        detail = self._titles_detail()
        prev = getattr(self, "_titles_last", None)
        self._titles_last = detail
        bound = getattr(self, "_bound_full", "")
        prev_bound = getattr(self, "_titles_bound", None)
        self._titles_bound = bound
        # 开窗第一拍、或刚换绑：只记基线，不为"旧标题"弹气泡
        if first or prev is None or prev_bound != bound:
            return
        cur = detail.get(bound) if bound else None
        if not cur:
            return
        before = (prev.get(bound) or {}).get("title")
        if cur["title"] != before and cur.get("source") == "user":
            append_notice(f"会话标题已改为「{cur['title']}」", bound)
            self._refresh_feed()
        st = self._hist
        if st and st.get("page") == "list":
            try:
                self._hist_redraw()
            except Exception as exc:
                print("titles redraw failed:", repr(exc), flush=True)

    def _request_title_sync(self, sid: str, title: str) -> None:
        """请插件把标题写回 DSH（插件轮询这个文件 → `sessionController.rename`）。

        写的是"待办"不是"结果"：DSH 没开时文件留着，插件下次加载补做。
        """
        rid = int(time.time() * 1000)
        try:
            tmp = TITLE_REQUEST.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"id": rid, "sid": sid, "title": title},
                                      ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, TITLE_REQUEST)
        except Exception as exc:
            print(f"[title] request write failed: {exc!r}", flush=True)
            return
        self.root.after(2500, lambda: self._check_title_sync(rid, sid, title))

    def _check_title_sync(self, rid: int, sid: str, title: str) -> None:
        """2.5 秒后看回执：失败在主窗说一句；没回执 = 排队（DSH 没开或插件没加载）。"""
        try:
            res = json.loads(TITLE_RESULT.read_text(encoding="utf-8"))
        except Exception:
            res = None
        if not res or int(res.get("id") or 0) != rid:
            print(f"[title] queued (no plugin): {sid[:16]} -> {title}", flush=True)
            return
        if res.get("ok"):
            print(f"[title] synced to DSH: {sid[:16]} -> {title}", flush=True)
            return
        err = str(res.get("error") or "未知错误")
        print(f"[title] sync failed: {sid[:16]} -> {title}: {err}", flush=True)
        append_notice(f"「{title}」只改了浮窗：DSH 同步失败（{err}）")
        self._refresh_feed()

    def _history_entries(self, sid: str) -> list[dict]:
        """chat.jsonl 里属于 `sid` 的全部条目（按写入顺序，最多 500 条）。"""
        try:
            lines = CHAT_FILE.read_text(encoding="utf-8").splitlines()[-4000:]
        except Exception:
            return []
        out = []
        for line in lines:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if str(e.get("sid") or "") != sid or e.get("role") == "meta":
                continue
            if msg_key(sid, e.get("at")) in self._hidden_keys():
                continue
            out.append(e)
        return out[-500:]

    def _bind_header(self) -> None:
        c = self.canvas
        # ▴/▾ 与 ✕ 不再用 tag_bind：字形本身太小，判定范围要按整块矩形放大
        # （2026-11-06 用户要求），统一放到 `_press` 里判。
        # 双击改名：单击要留给「按住标题拖动窗口」，两者不能抢同一个事件
        c.tag_bind("title", "<Double-Button-1>", self._edit_title)

    # 消息区改成独立视口 + 自然高度列表；False = 回滚到四槽布局（2026-11-05）
    FEED_LIST = True

    def _draw_feed(self) -> None:
        if self.FEED_LIST:
            self._draw_feed_list()
        else:
            self._draw_feed_slots()

    def _draw_feed_list(self) -> None:
        """一屏一个视口：气泡按自然高度排成一条列表，滚轮只改偏移重画可见部分。

        2026-11-05 的教训：上一版把底图/几何绑在气泡盒子上，滚一次就重算
        `with_shapes` + 底图 + 全部文字，滚轮必然顿。现在 `geo.shapes` 固定成四个
        占位槽，滚动只 delete/recreate `bubbles` 这组 canvas 图元。
        """
        w, h = self._geo.width, self._geo.height
        # 隐藏过的气泡不参与排版（2026-11-06 用户要求：只扣浮窗的显示，不动会话记录）
        hid = self._hidden_keys()
        shown = [m for m in self.feed.messages
                 if msg_key(m.get("sid") or "", m.get("at")) not in hid]
        geo = self._geo
        base = self._shapes(w, h)
        view_top = base[0][1]
        view_bottom = base[MESSAGE_SLOTS - 1][3]
        self._view = (view_top, view_bottom)
        t_m0 = time.perf_counter()
        entries, total_h = self._feed_measure(shown, view_top, view_bottom)
        t_m1 = time.perf_counter()
        self._feed_entries = entries
        self._feed_total = total_h
        view_h = max(1, view_bottom - view_top)
        self._scroll_max = max(0, total_h - view_h)
        if self._expanded is not None:
            self._follow_bottom = False
            # 不重置 `_scroll_px`：异步图片加载完会重绘一次，重置就会跳回顶部
        elif getattr(self, "_follow_bottom", True):
            self._scroll_px = self._scroll_max
        self._scroll_px = max(0, min(self._scroll_max, self._scroll_px))
        self._scroll_target = self._scroll_px

        # shapes 固定：四个占位槽 + 输入框/发送。滚动期间不能再变，
        # 否则 `_work` 会按 key 重画整块底图（滚轮顿的根因）。
        shapes = tuple(base)
        plate = bool(shown)
        if tuple(geo.shapes) != shapes or geo.plate != plate:
            with self._geo_lock:
                self._set_geometry(geo.with_shapes(shapes, plate=plate))
        self._paint_bubbles(w)
        if TRACE:
            print(f"[trace] feed measure={(t_m1 - t_m0) * 1000:.0f}ms "
                  f"paint={(time.perf_counter() - t_m1) * 1000:.0f}ms "
                  f"msgs={len(shown)}", flush=True)
        if not shown:
            self.text.draw(w // 2, view_top + view_h // 2,
                           "在这里跟它说话 · 滚轮翻历史", anchor="center",
                           fill="#8e9db2", size=12, tags=("bubbles",))

    # 图片识别：markdown 语法与裸路径/URL 都认
    IMG_MD = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')
    # 行内代码区间：里面的 `![...](...)` 是示例文字，不参与图片识别（2026-11-06）
    CODE_SPAN = re.compile(r'`[^`\n]+`')
    IMG_RAW = re.compile(
        r'(?<![\w(])((?:https?://[^\s<>"\u3000）)]+)'
        r'|[A-Za-z]:\\[^\s<>"\u3000）)]+\.(?:png|jpe?g|gif|webp|bmp))', re.I)

    def _parse_blocks(self, text):
        """把消息正文切成 [("text", 文本) | ("img", 地址)]，保持原有顺序。

        2026-11-06：**行内代码里的 `![...](...)` 是示例文字，不当图片。**
        5073c65e 22:43:15 那条回复用 `` `![图片](本地路径)` `` 解释链路，被当成
        真图片渲染成 `[图片]`，用户追问后才发现 —— 解析时必须先认出代码区间。
        """
        spans = [(m.start(), m.end()) for m in self.CODE_SPAN.finditer(text)]

        def in_code(i, table):
            for a, b in table:
                if a <= i < b:
                    return True
            return False

        pieces = []
        pos = 0
        for m in self.IMG_MD.finditer(text):
            if in_code(m.start(), spans):
                continue
            if m.start() > pos:
                pieces.append(("text", text[pos:m.start()]))
            pieces.append(("img", m.group(2).strip()))
            pos = m.end()
        pieces.append(("text", text[pos:]))

        out = []
        for kind, payload in pieces:
            if kind == "img":
                out.append((kind, payload))
                continue
            sub = [(m.start(), m.end()) for m in self.CODE_SPAN.finditer(payload)]
            last = 0
            for m in self.IMG_RAW.finditer(payload):
                if in_code(m.start(), sub):
                    continue
                if m.start() > last:
                    out.append(("text", payload[last:m.start()]))
                out.append(("img", m.group(1)))
                last = m.end()
            if last < len(payload):
                out.append(("text", payload[last:]))
        return out

    # 行内 markdown：粗体 / 行内代码。只认成对的标记，认不出就原样当文字。
    BOLD_MD = re.compile(r"(\*\*[^*\n]+?\*\*)")
    CODE_MD = re.compile(r"(`[^`\n]+?`)")

    def _inline_runs(self, line):
        """一行切成 [(文本, 样式)]：b=粗体、c=代码、n=普通；标记本身不显示。"""
        runs = []
        for part in self.BOLD_MD.split(line):
            if not part:
                continue
            bold = len(part) > 4 and part.startswith("**") and part.endswith("**")
            body = part[2:-2] if bold else part
            for chunk in self.CODE_MD.split(body):
                if not chunk:
                    continue
                if len(chunk) > 2 and chunk.startswith("`") and chunk.endswith("`"):
                    runs.append((chunk[1:-1], "c"))
                else:
                    runs.append((chunk, "b" if bold else "n"))
        return runs

    def _run_font(self, style):
        return self.fonts.get(11, style == "b")

    def _char_w(self, font, ch):
        """单字宽度缓存：折行是逐字量的，一次 Tk `measure` ~0.1ms。

        实报（2026-11-06）：108 条消息、3 万字符，松手重排时 `_wrap_runs` 一个人
        吃掉 3.1s —— 就是这 3 万次 Tcl 调用。同样的字宽度不会变，缓一次就够。
        """
        cache = self._charw_cache
        k = (id(font), ch)
        v = cache.get(k)
        if v is None:
            v = font.measure(ch)
            if len(cache) > 20000:      # 长文本的整行 run 也会进这个表，别无限长
                cache.clear()
            cache[k] = v
        return v

    def _runs_width(self, line):
        return sum(self._char_w(self._run_font(st), txt) for txt, st in line)

    def _wrap_runs(self, text, content_max, keep_blank=False):
        """按字符折行，返回 [[(文本, 样式), …], …]。

        粗体比常规字宽，所以**不能**先按常规字宽折行再换成粗体画（会溢出气泡）；
        折行和绘制都走同一套 run，宽度才一致。
        """
        no_start = "，。、；：！？）》」』…,.;:!?)]}"
        out = []
        for para in str(text).splitlines():
            if not para.strip():
                if keep_blank and out:
                    out.append([])          # 段落空行：只在展开态保留
                continue
            para = re.sub(r"^\s{0,3}#{1,6}\s+", "", para)     # "## 小标题" 去掉 #
            cur, cur_w = [], 0.0
            for txt, style in self._inline_runs(para):
                font = self._run_font(style)
                for ch in txt:
                    w = self._char_w(font, ch)
                    if cur and cur_w + w > content_max and ch not in no_start:
                        out.append(cur)
                        cur, cur_w = [], 0.0
                    if cur and cur[-1][1] == style:
                        cur[-1] = (cur[-1][0] + ch, style)
                    else:
                        cur.append((ch, style))
                    cur_w += w
            out.append(cur)
        return out or [[]]

    def _draw_runs(self, x, y, line):
        """按 run 画一行：粗体加粗、行内代码换淡蓝。宽度与折行用同一套 measure。"""
        cx = x
        for txt, style in line:
            if not txt:
                continue
            fill = "#ffffff" if style == "b" else ("#9fd6ff" if style == "c" else "#edf6ff")
            self.text.draw(cx, y, txt, anchor="nw", fill=fill, size=11,
                           bold=(style == "b"), tags=("bubbles",),
                           shadow=False, adapt=not PLATE, per_char=not PLATE)
            cx += self._run_font(style).measure(txt)

    def _seg_lines(self, text, content_max, keep_blank=False):
        """按段折行并缓存（展开翻页不重折行）；结果是 [[(文本, 样式), …], …]。"""
        key = (text, content_max, keep_blank)
        cache = getattr(self, "_seg_cache", None)
        if cache is None:
            cache = self._seg_cache = {}
        hit = cache.get(key)
        if hit is None:
            hit = self._wrap_runs(text, content_max, keep_blank)
            if len(cache) > 600:
                cache.clear()
            cache[key] = hit
        return hit

    def _resolve_path(self, src):
        """把消息里的本地图片地址解析成真实路径。

        绝对路径原样返回；相对路径先按工作区根（`ROOT`）拼，再按当前 cwd 拼 ——
        DSH 正文里的 `.tmp2/shot.png` 是工作区相对的，窗口进程 cwd 若不是工作区，
        原来的 `os.path.exists(src)` 就全判成"文件不存在"，气泡里只剩一行 `[图片]`。

        2026-11-06（用户截图报「一堆 [图片]」）：历史消息里有被**截断**的路径，
        形如 `...paste-1793889774141.png`（前几轮生成/转述时把前缀省了）。这种按
        原样永远找不到；但只要文件名还在，就能到 `see-now/images/` 下按名字找回来。
        """
        if not src or os.path.isabs(src):
            return src
        for base in (ROOT, Path.cwd()):
            try:
                p = os.path.normpath(os.path.join(str(base), src))
            except (OSError, ValueError):
                continue
            if os.path.exists(p):
                return p
        # 截断路径兜底：`...name.png` → 去 see-now/images/ 找同名文件
        try:
            if "..." in src:
                name = src.replace("\\", "/").split("/")[-1].lstrip(".")
                cand = Path(os.environ.get("DSH_VIDEO_CACHE_DIR", "")) / "images" / name
                if name and cand.is_file():
                    return str(cand)
        except Exception:
            pass
        return src

    def _img_probe(self, src, max_w, max_h):
        """只看图片头拿显示尺寸（不解码像素）——排高度用。

        像素留给 `_paint_bubbles`，只加载真正要画的那几张（2026-11-06：
        27 张全量解码/缩放是松手卡顿的主因之一）。
        """
        try:
            p = self._resolve_path(src)
            st = os.stat(p)
        except OSError:
            return None
        key = (os.path.normcase(p), st.st_mtime_ns, max_w, max_h)
        cache = self._probe_cache
        if key in cache:
            return cache[key]
        try:
            with Image.open(p) as im:
                iw, ih = im.size
                # EXIF 里的方向会把宽高换过来（`_img_full` 会 exif_transpose），
                # 只读文件头时也必须照做，否则量出来 491×44、画出来 44×491，
                # 高度对不上就退化成 `[图片]`（2026-11-06 用户截图实报）。
                try:
                    if int(im.getexif().get(0x0112, 1) or 1) in (5, 6, 7, 8):
                        iw, ih = ih, iw
                except Exception:
                    pass
        except Exception:
            cache[key] = None
            return None
        scale = min(max_w / max(1, iw), max_h / max(1, ih), 1.0)
        got = (max(1, int(iw * scale)), max(1, int(ih * scale)))
        if len(cache) > 600:
            cache.clear()
        cache[key] = got
        return got

    def _img_full(self, src):
        """按 (路径, mtime) 缓存**解码后**的原图。

        缩放窗口时每挡尺寸的 `max_w/max_h` 都不同，`_img_state` 的 key 就全改了，
        于是整条 chat 的图（108 条消息里 34 处，含 800KB 的 PNG）每次重排都要
        重新 open+load+转 RGB —— 2026-11-06 实测：拖完松手 3.8s 里 3.5s 都花在这。
        解码结果留下来，之后每次只做一次 resize。
        """
        try:
            st = os.stat(src)
        except OSError:
            return None
        key = (os.path.normcase(src), st.st_mtime_ns)
        cache = getattr(self, "_img_full_cache", None)
        if cache is None:
            from collections import OrderedDict
            cache = self._img_full_cache = OrderedDict()
        hit = cache.get(key)
        if hit is not None:
            cache.move_to_end(key)
            return hit
        try:
            img = Image.open(src)
            img.load()
            img = ImageOps.exif_transpose(img).convert("RGB")
        except Exception:
            return None
        cache[key] = img
        while len(cache) > 16:          # 大截图 ~3MB/张，留 16 张够翻几屏了
            cache.popitem(last=False)
        return img

    def _img_state(self, src, max_w, max_h):
        """取图片 (PIL, PhotoImage)；失败返回 (None, None)，下载中返回 None。

        PIL 原图要一起留着：图片超出气泡/视口时得靠它 crop 可见部分
        （Tk 的 canvas image 本身不能裁剪）。
        """
        url = src.startswith(("http://", "https://"))
        if url:
            key = ("url", src, max_w, max_h)
        else:
            src = self._resolve_path(src)
            if not os.path.exists(src):
                return None
            try:
                st = os.stat(src)
            except OSError:
                return None
            key = ("local", os.path.normcase(src), st.st_mtime_ns, max_w, max_h)
        cache = getattr(self, "_img_cache", None)
        if cache is None:
            cache = self._img_cache = {}
        if key in cache:
            return cache[key]
        if url:
            busy = getattr(self, "_img_busy", None)
            if busy is None:
                busy = self._img_busy = set()
            if key not in busy:
                busy.add(key)
                threading.Thread(target=self._fetch_image,
                                 args=(src, key, max_w, max_h), daemon=True).start()
            return None
        full = self._img_full(src)
        if full is None:
            got = (None, None)
        else:
            try:
                img = full
                scale = min(max_w / max(1, img.width), max_h / max(1, img.height), 1.0)
                if scale < 1.0:
                    # reducing_gap：先做快速降采样再 LANCZOS，缩到 1/8 大小时快好几倍
                    # （27 张图的释放重排 317ms → 见 log）
                    img = img.resize((max(1, int(img.width * scale)),
                                      max(1, int(img.height * scale))),
                                     Image.Resampling.LANCZOS, reducing_gap=2.0)
                got = (img, ImageTk.PhotoImage(img, master=self.canvas))
            except Exception:
                got = (None, None)
        if len(cache) > 120:
            cache.clear()
        cache[key] = got
        return got

    def _crop_photo(self, src, pil, top, bot):
        """裁掉图片顶部/底部越界部分（canvas image 不能裁剪，先 crop 再转图）。"""
        top = max(0, int(top))
        bot = max(0, int(bot))
        if pil.height - top - bot <= 0:
            return None
        key = (src, pil.width, pil.height, top, bot)
        cache = getattr(self, "_crop_cache", None)
        if cache is None:
            cache = self._crop_cache = {}
        hit = cache.get(key)
        if hit is not None:
            return hit
        try:
            hit = ImageTk.PhotoImage(
                pil.crop((0, top, pil.width, pil.height - bot)),
                master=self.canvas)
        except Exception:
            hit = None
        if len(cache) > 60:
            cache.clear()
        cache[key] = hit
        return hit

    def _fetch_image(self, url, key, max_w, max_h):
        """后台线程：下载 + 缩放成 PIL 图；PhotoImage 留给主线程建。"""
        img = None
        try:
            import urllib.request
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = resp.read(10 * 1024 * 1024)      # 10MB 上限
            img = Image.open(io.BytesIO(data))
            img.load()
            img = ImageOps.exif_transpose(img).convert("RGB")
            scale = min(max_w / max(1, img.width), max_h / max(1, img.height), 1.0)
            if scale < 1.0:
                img = img.resize((max(1, int(img.width * scale)),
                                  max(1, int(img.height * scale))),
                                 Image.Resampling.LANCZOS)
        except Exception:
            img = None
        pending = getattr(self, "_img_pending", None)
        if pending is None:
            pending = self._img_pending = {}
        pending[key] = img
        try:
            self.root.after(0, self._apply_pending_images)
        except Exception:
            pass

    def _apply_pending_images(self):
        """主线程：把后台下好的图变成 PhotoImage 并重绘一次。"""
        pending = getattr(self, "_img_pending", {})
        if not pending:
            return
        cache = getattr(self, "_img_cache", None)
        if cache is None:
            cache = self._img_cache = {}
        busy = getattr(self, "_img_busy", None)
        while pending:
            key, img = pending.popitem()
            try:
                cache[key] = ((img, ImageTk.PhotoImage(img, master=self.canvas))
                              if img is not None else (None, None))
            except Exception:
                cache[key] = (None, None)
            if busy is not None:
                busy.discard(key)
        # 收起态「新消息」里可能有 URL 图：下好了要重排气泡高度（量的时候还不知道尺寸）
        if self._collapsed:
            if getattr(self, "_notif_msg", None) is not None:
                try:
                    self._layout_notification()
                except Exception:
                    pass
        elif self.FEED_LIST and hasattr(self, "canvas"):
            try:
                self._redraw_feed_layer()
            except Exception:
                pass
        # 回顾窗开着正文页：URL 图刚下好，气泡高度要重算（量的时候还不知道尺寸）
        try:
            st = getattr(self, "_hist", None)
            if st and st.get("page") == "viewer" and st["win"].winfo_exists():
                self._hist_relayout_keep_scroll()
        except Exception:
            pass

    def _feed_measure(self, shown, view_top, view_bottom):
        """按自然高度量每条消息；返回 (entries, 总高)。不依赖四槽边界。"""
        w, h = self._geo.width, self._geo.height
        base = self._shapes(w, h)
        left, right = base[0][0], base[0][2]
        pad = 18
        fbody = self.fonts.get(11)
        fstamp = self.fonts.get(9)
        ls = max(1, fbody.metrics("linespace"))
        stamp_ls = max(0, fstamp.metrics("linespace"))
        max_bubble = min(right - left, max(240, int((right - left) * 0.72)))
        min_bubble = min(110, max_bubble)
        content_max = max(80, max_bubble - 2 * pad)
        view_h = max(1, view_bottom - view_top)

        expanded = getattr(self, "_expanded", None)
        msgs = list(shown)
        if expanded is not None:
            picked = [m for m in msgs if str(m.get("at") or "") == str(expanded)]
            msgs = picked[:1]

        entries = []
        # 展开态这条消息贴着视口顶；头像画在 `stamp_y - 4`，贴顶时会被
        # "整块在视口内才画" 的判据丢掉（2026-11-06 实报：展开后没有头像）。
        # 给展开态留 6px 顶距，头像就完整落在视口里。
        # 展开态还多留 8px：那条的时间戳右边有「收回」胶囊，胶囊要比字高出一圈
        # （2026-11-06 用户要求「框别贴着字」），不占行高就只能压到气泡上。
        y = (14 if expanded is not None else 0)
        t_txt = t_img = 0.0
        n_txt = n_img = 0
        for msg in msgs:
            key = str(msg.get("at") or "")
            # 居中「系统提示」气泡（2026-11-06 用户要求）：不带头像/时间戳，
            # 单独一条窄行，宽度随文字走、位置固定在窗口中线。
            if str(msg.get("role") or "") == "notice":
                nw = min(int((right - left) * 0.78), max(120, right - left - 24))
                nlines = self._seg_lines(str(msg.get("text") or ""), nw)
                nh = len(nlines) * ls + 22
                ntext_w = max([0.0] + [self._runs_width(ln) for ln in nlines])
                entries.append({
                    "kind": "notice", "key": key, "lines": nlines, "ls": ls,
                    "bw": max(120.0, min(float(nw + 28), ntext_w + 28)),
                    "list_y": y, "h": nh + 8,
                })
                y += nh + 8
                continue
            is_user = str(msg.get("role") or "").lower() in ("user", "me", "human")
            stamp = str(msg.get("stamp") or "")
            is_open = expanded is not None and key == str(expanded)
            stamp_h = (stamp_ls + 8 if is_open else stamp_ls) if stamp else 0
            text = msg.get("text") or ""
            max_img_h = (int(view_h * 0.6) if is_open else 120)

            # 1) 切成段：文本（折行）/ 图片
            raw = []
            for kind, payload in self._parse_blocks(text):
                if kind == "text":
                    seg = payload.strip("\n")
                    if not seg.strip():
                        continue
                    _t0 = time.perf_counter()
                    raw.append(("text", self._seg_lines(seg, content_max,
                                                        keep_blank=is_open)))
                    t_txt += time.perf_counter() - _t0
                    n_txt += len(seg)
                else:
                    raw.append(("img", payload))

            total_lines = sum(len(p) for k, p in raw if k == "text")
            total_imgs = sum(1 for k, p in raw if k == "img")

            # 2) 摘要态：文本共 2 行 + 第一张图；展开态全给（超出靠像素滚动）
            if not is_open:
                cut = []
                text_left, img_left = 2, 1
                for kind, payload in raw:
                    if kind == "text" and text_left > 0:
                        # 空行不占那两行的名额（原来段落之间的空行会把第二行吃掉，
                        # 屏幕上看就是"气泡里一行字 + 一大片空白"）
                        part = [ln for ln in payload if ln][:text_left]
                        if part:
                            cut.append(("text", part))
                            text_left -= len(part)
                    elif kind == "img" and img_left > 0:
                        cut.append(("img", payload))
                        img_left -= 1
                raw = cut
            kept_lines = sum(len(p) for k, p in raw if k == "text")
            kept_imgs = sum(1 for k, p in raw if k == "img")
            more = (not is_open) and (kept_lines < total_lines or kept_imgs < total_imgs)
            if more:
                # 截断了就要说一句：以前直接把尾巴砍掉，正文停在半句上（实报"话没说完"）
                for i in range(len(raw) - 1, -1, -1):
                    if raw[i][0] != "text" or not raw[i][1]:
                        continue
                    lines_cut = list(raw[i][1])
                    last_cut = list(lines_cut[-1]) + [("…", "n")]
                    # 省略号也要塞回 content_max 里，不然会顶出气泡
                    while len(last_cut) > 1 and self._runs_width(last_cut) > content_max:
                        txt, st = last_cut[-2]
                        if len(txt) > 1:
                            last_cut[-2] = (txt[:-1], st)
                        else:
                            del last_cut[-2]
                    lines_cut[-1] = last_cut
                    raw[i] = ("text", lines_cut)
                    break

            # 3) 图片：**只量尺寸、不加载像素**。108 条消息里 27 张图，松手重排时
            #    全量解码+缩放要 300ms+，而其中大部分根本不在视口里 —— 像素留到
            #    `_paint_bubbles` 只为真正要画的那几张加载（2026-11-06 实测）。
            segs = []
            for kind, payload in raw:
                if kind == "text":
                    segs.append({"kind": "text", "lines": payload,
                                 "h": len(payload) * ls})
                else:
                    _t0 = time.perf_counter()
                    url = str(payload).startswith(("http://", "https://"))
                    if url:
                        got = self._img_state(payload, content_max, max_img_h)
                        size = None
                        if got is not None:
                            pil, photo = got
                            size = (photo.width(), photo.height())
                    else:
                        got = None
                        size = self._img_probe(payload, content_max, max_img_h)
                    t_img += time.perf_counter() - _t0
                    n_img += 1
                    if size is not None:
                        segs.append({"kind": "img", "src": payload,
                                     "photo": (got[1] if got else None),
                                     "pil": (got[0] if got else None),
                                     "w": size[0], "h": size[1] + 14,
                                     "max_w": content_max, "max_h": max_img_h})
                    else:
                        segs.append({"kind": "img", "src": payload, "photo": None,
                                     "w": 0, "h": ls + 6})
            body = max(ls + 16, sum(s["h"] for s in segs) + 16)
            if more:
                body += 32          # 给右下角「展开」按钮留高度
            inner = max([0] + [self._runs_width(line) for s in segs if s["kind"] == "text"
                               for line in s["lines"]]
                        + [s["w"] for s in segs if s["kind"] == "img"])
            bw = min(max_bubble, max(min_bubble, inner + 2 * pad))
            if is_user:
                bx1 = right
                bx0 = bx1 - bw
                # 正文左对齐（贴左内边），但时间戳仍贴右内边 —— 只改正文，没要求动时间戳
                tx, ta = bx0 + pad, "nw"
                stamp_tx, stamp_ta = bx1 - pad, "ne"
            else:
                bx0 = left
                bx1 = bx0 + bw
                tx, ta = bx0 + pad, "nw"
                stamp_tx, stamp_ta = bx0 + pad, "nw"
            by0 = y + stamp_h
            entries.append({
                "msg": msg, "key": key, "is_user": is_user, "stamp": stamp,
                "stamp_h": stamp_h, "segs": segs, "more": more,
                "is_open": is_open, "ls": ls, "body": body,
                "bx0": bx0, "bx1": bx1, "tx": tx, "ta": ta, "text_off": 8,
                "stamp_tx": stamp_tx, "stamp_ta": stamp_ta,
                "r": min(26, max(16, body // 3)),
                "list_y": y, "h": stamp_h + body + 6,
            })
            y += stamp_h + body + 6
        if TRACE:
            print(f"[trace] measure text={t_txt * 1000:.0f}ms({n_txt}字符) "
                  f"img={t_img * 1000:.0f}ms({n_img}张) w={w}", flush=True)
        # ① 最新气泡下面那行状态（2026-11-06 用户要求）：**排在内容流里**，所以往上翻
        # 就看不见它 —— 反过来，"看不见状态行"本身就等于"已经不在底部"。
        # 展开态不画：那时视口里只有展开的那一条，底下挂个「已完成」很怪。
        if expanded is None and entries:
            status = self._status_text(getattr(self, "_bound_full", ""))
            if status:
                y += 10
                entries.append({"kind": "status", "text": status, "list_y": y, "h": 28})
                y += 28
        return entries, y

    def _paint_bubbles(self, w) -> None:
        """只画与视口相交的部分；滚动时先 delete("bubbles") 再调它。"""
        c = self.canvas
        view_top, view_bottom = self._view
        scroll = getattr(self, "_scroll_px", 0)
        self._load_delivered()        # ③ 行内小胶囊的依据（stat 一下，变了才重读）
        self._btn_hits = []
        self._img_hits = []
        self._bubble_hits = []          # 气泡整块 → entry（右键菜单命中用，2026-11-06）
        self._collapse_rect = None
        for e in getattr(self, "_feed_entries", []):
            if e.get("kind") == "status":
                # ① 居中一行灰字：整行落在视口里才画（半行字比没有更难看）
                sy = view_top + e["list_y"] - scroll
                if sy >= view_top and sy + e["h"] <= view_bottom:
                    self.text.draw(w // 2, sy + e["h"] / 2, e["text"], anchor="center",
                                   fill="#7f8b9c", size=10, tags=("bubbles",))
                continue
            if e.get("kind") == "notice":
                # 居中「系统提示」气泡：圆角底板 + 文字居中，无头像无时间戳。
                # **底板和文字都必须裁到视口**：它往上滚出去时，以前是整块照画，
                # 于是底板的圆角、正文会压到标题栏分割线和感官状态行上，和
                # 「实时视觉 + 听觉」叠成一团乱码（2026-11-08 实报「图1 叠字」）。
                # 普通气泡一直有这条裁切（见下面 `clip_top`），这里漏了。
                ny = view_top + e["list_y"] - scroll
                nh = max(20.0, e["h"] - 8)
                if ny >= view_bottom or ny + nh <= view_top:
                    continue
                cw = float(e["bw"])
                cx = w / 2.0
                ly = ny + 11
                rows = []
                for line in e["lines"]:
                    # 整行落在可见区才画（和普通气泡同一条判据）
                    if ly >= view_top and ly + e["ls"] <= view_bottom:
                        rows.append((ly, line))
                    ly += e["ls"]
                # 顶上被切掉、正文一行也露不出来时**整块不画**：只剩一条底板残条，
                # 看着就是"凭空多出来一条横线"，正压在状态行下面（普通气泡的
                # `has_content` 是同一条道理）。滑动时它就正常滑出去。
                if not rows and ny < view_top:
                    continue
                py0, py1 = max(ny, view_top), min(ny + nh, view_bottom)
                if py1 - py0 >= 4:
                    # 顶上被切掉时不画圆角：圆角是"这块东西的边"，切一半还画圆角会
                    # 看成一颗完整的小胶囊多出来一条，方边才读得出"上面还有内容"。
                    r = 0.0 if ny < view_top else min(12.0, (py1 - py0) / 2)
                    try:
                        c.create_polygon(
                            self._rounded_points(cx - cw / 2, py0, cx + cw / 2, py1,
                                                 r, 14),
                            fill="#232c39", outline="",
                            smooth=r > 0, tags=("bubbles",))
                    except Exception:
                        pass
                for ly, line in rows:
                    lw = self._runs_width(line)
                    self._draw_runs(cx - lw / 2, ly, line)
                continue
            is_open = bool(e.get("is_open"))
            top = view_top + e["list_y"] - scroll
            # 展开态（2026-11-06 用户要求 ⑥）：头像 / 时间戳 / 收回按钮钉在视口顶，
            # 只有气泡内容跟着滚；内容在 `clip_top` 以下才画，滚上去就被裁掉。
            over = max(0.0, scroll - e["list_y"]) if is_open else 0.0
            stamp_y = (view_top + e["list_y"]) if is_open else top
            clip_top = (view_top + e["list_y"] + e["stamp_h"]) if is_open else view_top
            if not is_open and (top + e["h"] <= view_top or top >= view_bottom):
                continue
            # 头像与时间戳：整行在视口内才画（被切一半的字比没有更难看）
            if (e["stamp"] and stamp_y >= view_top
                    and stamp_y + e["stamp_h"] <= view_bottom):
                if (not e["is_user"] and self._avatar_img is not None
                        and stamp_y - 4 >= view_top):
                    try:
                        c.create_image(20, stamp_y - 4, anchor="nw",
                                       image=self._avatar_img, tags=("bubbles",))
                    except Exception:
                        pass
                if (e["is_user"] and self._avatar_user_img is not None
                        and stamp_y - 4 >= view_top):
                    try:
                        c.create_image(w - 48, stamp_y - 4, anchor="nw",
                                       image=self._avatar_user_img, tags=("bubbles",))
                    except Exception:
                        pass
                self.text.draw(e["stamp_tx"], stamp_y, e["stamp"], anchor=e["stamp_ta"],
                               fill="#a8b7c9", size=9, tags=("bubbles",))
                # ③ 自己发的：时间戳左边补「发送中 / 已送达」（2026-11-06 用户要求）
                if e["is_user"]:
                    self._draw_send_state(e, stamp_y)
            # 「收回」：画在当前已展开这条消息的时间戳右边（2026-11-06 用户要求 ⑤）。
            # 标题栏不再放；放在这里展开的是哪条、收回按钮就跟着哪条。
            if e.get("is_open"):
                sw = self.fonts.get(9).measure(e["stamp"] or "")
                if e["stamp_ta"] == "nw":
                    cx0 = e["stamp_tx"] + sw + 8
                else:
                    # 自己发的那侧时间戳贴右缘，右边再放 52px 会被窗口裁掉
                    # （2026-11-06 用户气泡也能展开之后实报）→ 放到行首空位
                    cx0 = 24.0
                cy2 = stamp_y + max(8.0, (e["stamp_h"] - 8) / 2)
                cy0, cx1, cy1 = cy2 - 13, cx0 + 52, cy2 + 13
                if cy0 >= view_top and cy1 <= view_bottom:
                    try:
                        c.create_polygon(self._rounded_points(cx0, cy0, cx1, cy1, 12, 4),
                                         fill="#000000", outline=BTN_EDGE, smooth=True,
                                         tags=("bubbles", "chip2"))
                        self.text.draw((cx0 + cx1) / 2, cy2, "收回", anchor="center",
                                       fill="#ffffff", size=10,
                                       tags=("bubbles", "chip2"))
                        self._collapse_rect = (cx0, cy0, cx1, cy1)
                    except Exception:
                        pass
            by0 = (view_top + e["list_y"] + e["stamp_h"] - over) if is_open else (top + e["stamp_h"])
            by1 = by0 + e["body"]
            p0 = max(by0, clip_top)
            p1 = min(by1, view_bottom)
            # 右键命中区：整条气泡（裁到视口）。和 `_img_hits` 同款，每帧重建。
            if p1 > p0 and e["bx1"] > e["bx0"]:
                self._bubble_hits.append(((e["bx0"], p0, e["bx1"], p1), e))
            # 一条内容都没露出来的气泡就别画那层壳：滚到边上时只剩底部 6~10px 的
            # 圆角条，看着像一条凭空多出来的横线（2026-11-05 实报"消息区顶上那条线"）
            content_top = by0 + e["text_off"]
            content_bot = content_top + sum(s["h"] for s in e["segs"])
            has_content = content_bot > clip_top and content_top < view_bottom
            if p1 - p0 >= 6 and e["bx1"] > e["bx0"] and has_content:
                r = min(e["r"], (p1 - p0) // 2)
                c.create_polygon(
                    self._rounded_points(e["bx0"], p0, e["bx1"], p1, r, 14),
                    fill=("#63463a" if e["is_user"] else "#1a2e54"),
                    smooth=True, tags=("bubbles",))
            sy = by0 + e["text_off"]
            for seg in e["segs"]:
                if seg["kind"] == "text":
                    for line in seg["lines"]:
                        ly = sy
                        sy += e["ls"]
                        # 整行落在可见区才画：展开态的上界是钉住的时间戳行（clip_top）
                        if ly < clip_top or ly + e["ls"] > view_bottom:
                            continue
                        self._draw_runs(e["tx"], ly, line)
                elif seg["kind"] == "img":
                    iy = sy
                    sy += seg["h"]
                    if iy >= view_bottom or iy + seg["h"] < view_top:
                        continue
                    photo = seg.get("photo")
                    pil = seg.get("pil")
                    if photo is None and seg.get("max_w") is not None:
                        # 懒加载：只有真要画的这几张才解码
                        got = self._img_state(seg["src"], seg["max_w"], seg["max_h"])
                        if got:
                            pil, photo = got
                    if photo is None:
                        # 文件不存在 / 下载失败 / 正在下载：先占一行
                        self.text.draw(e["tx"], iy, "[图片]", anchor=e["ta"],
                                       fill="#8e9db2", size=11, tags=("bubbles",),
                                       shadow=False, adapt=not PLATE, per_char=not PLATE)
                        continue
                    # 图片只能出现在气泡底板范围内：超出气泡底 / 视口的部分裁掉
                    # （canvas image 不能裁剪，得先用 PIL crop）
                    bottom_limit = min(view_bottom, by1)
                    crop_top = max(0, clip_top - iy)
                    crop_bot = max(0, (iy + seg["h"] - 14) - bottom_limit)
                    if (crop_top or crop_bot) and pil is not None:
                        photo = self._crop_photo(seg["src"], pil, crop_top, crop_bot)
                        if photo is None:
                            continue
                    ix = e["bx0"] + max(0, (e["bx1"] - e["bx0"] - seg["w"]) // 2)
                    try:
                        c.create_image(ix, iy + crop_top, anchor="nw", image=photo,
                                       tags=("bubbles",))
                        # 点击放大：记下实际画出来的 rect（裁剪过的可见部分）
                        self._img_hits.append(
                            ((ix, iy + crop_top, ix + photo.width(),
                              iy + crop_top + photo.height()),
                             str(seg.get("src") or "")))
                    except Exception:
                        pass
            # 展开态的「收回」在标题栏（见 `_refresh_chip`）：气泡右下角那个位置
            # 正好压在正文最后一行上，长消息还得滚到底才点得到。
            # 2026-11-06 用户实报「我自己发的气泡没有展开/收回」：这里原来写死了
            # `not e["is_user"]`，自己那侧长消息就只能截断着看。改成两侧都给。
            if e["more"] and not e["is_open"]:
                # 2026-11-06 用户要求：【展开】不再用文字胶囊，改成标题栏同款实心三角。
                tri_cx = e["bx1"] - 26
                tri_cy = by1 - 19
                if tri_cy + 7 <= view_top or tri_cy - 6 >= view_bottom:
                    continue
                if tri_cy - 6 >= view_top and tri_cy + 7 <= view_bottom:
                    try:
                        c.create_polygon(tri_cx - 8, tri_cy - 6, tri_cx + 8, tri_cy - 6,
                                         tri_cx, tri_cy + 7,
                                         fill="#8a97ab", outline="", tags=("bubbles",))
                    except Exception:
                        pass
                    # 三角本身 16×13 太小，点击区放到 32×28（人不用瞄得很准）
                    self._btn_hits.append(((tri_cx - 16, tri_cy - 14,
                                            tri_cx + 16, tri_cy + 14), e["key"]))

    def _redraw_bubbles(self) -> None:
        """滚动专用：只重建气泡/文字图元，不碰几何、底图和输入框。"""
        if not self.FEED_LIST or not hasattr(self, "canvas"):
            return
        self.canvas.delete("bubbles")
        self._paint_bubbles(self._geo.width)
        # 重新画的气泡在图元顺序上晚于输入栏，图片会盖住它；把 chrome 提回最上
        try:
            self.canvas.tag_raise("chrome")
        except Exception:
            pass
        # 感官状态行是固定叠层，必须永远在气泡之上
        try:
            self.canvas.tag_raise("focusline")
        except Exception:
            pass
        # 不调 text.refresh()：气泡文字 adapt=False、不进翻色名单，
        # find_all 全画布扫一遍在这里纯属浪费（滚轮每格都要付一次）。
        self._draw_scrollbar()

    def _scroll_by(self, delta: int) -> None:
        if self._scroll_max <= 0:
            return
        # 单次重绘已经是毫秒级（整行文字 + 只重建气泡层），不再节流：
        # 直接应用最新偏移。节流窗口本身会额外加一帧延迟（实测 200ms+）。
        self._scroll_target = max(0, min(self._scroll_max,
                                        self._scroll_target + delta))
        self._follow_bottom = self._scroll_target >= self._scroll_max - 2
        # 自己滚回底部 = 已经看到最新，不用再提示（2026-11-06 用户要求 ②）
        if self._follow_bottom and getattr(self, "_new_below", False):
            self._new_below = False
            try:
                self._draw_history_bar()
            except Exception:
                pass
        self._apply_scroll()

    def _apply_scroll(self) -> None:
        self._scroll_timer = None
        if self._scroll_px == self._scroll_target:
            return
        self._scroll_px = self._scroll_target
        self._redraw_bubbles()
        # Tk 的 canvas 重绘是 idle 任务，不主动跑一次的话这一帧要等主循环空闲
        # 才上屏（实测滚一下画面 130-400ms 后才动）。这里当场把 idle 跑掉。
        try:
            self.canvas.update_idletasks()
        except Exception:
            pass

    def _redraw_feed_layer(self, restore: int | None = None) -> None:
        """展开态翻页 / 展开收起专用：重算消息布局 + 只重画气泡层。

        以前走 `_layout()`：整窗 delete("all")、重建标题栏/输入框、重贴底图、
        全部文字重画 —— 展开一条长消息后每格滚轮都付这一遍，就是掉帧。

        `restore`：收起展开气泡时，把列表滚动偏移还原到展开前的位置
        （展开态把 `_scroll_px` 强制成 0，不还原的话一收起来就跳回最顶端）。
        """
        if not self.FEED_LIST or not hasattr(self, "canvas"):
            return
        view_top, view_bottom = self._view
        entries, total_h = self._feed_measure(list(self.feed.messages),
                                              view_top, view_bottom)
        self._feed_entries = entries
        self._feed_total = total_h
        view_h = max(1, view_bottom - view_top)
        self._scroll_max = max(0, total_h - view_h)
        if self._expanded is not None:
            self._follow_bottom = False
            self._scroll_px = max(0, min(self._scroll_max, self._scroll_px))
        elif restore is not None:
            self._scroll_px = max(0, min(self._scroll_max, restore))
            self._follow_bottom = getattr(self, "_saved_follow", True)
        else:
            self._scroll_px = max(0, min(self._scroll_max, self._scroll_px))
            # 图片是异步加载的：加载完总高会变大，原本贴底的必须重新贴底，
            # 否则新图被顶到视口外、只剩一块空白（2026-11-05 实报）。
            if getattr(self, "_follow_bottom", True):
                self._scroll_px = self._scroll_max
        self._scroll_target = self._scroll_px
        self._redraw_bubbles()
        try:
            self.canvas.update_idletasks()
        except Exception:
            pass

    def _draw_feed_slots(self) -> None:
        w = self._geo.width
        shown = self.feed.visible()
        if shown:
            shapes, infos = self._message_shapes(shown)
        else:
            shapes, infos = self._shapes(w, self._geo.height), []
        if shapes != self._geo.shapes:
            with self._geo_lock:
                self._set_geometry(self._geo.with_shapes(shapes, plate=bool(shown)))
        # 试验：气泡底板用 canvas 圆角多边形画（不做图像合成，滚动时不用重算底图）
        if self.PLATE_CANVAS:
            for info in infos:
                x0, y0, x1, y1, r = info["shape"]
                if x1 <= x0 or y1 <= y0:
                    continue
                try:
                    self.canvas.create_polygon(
                        self._rounded_points(x0, y0, x1, y1, min(r, (y1 - y0) // 2), 14),
                        fill=("#63463a" if info["is_user"] else "#1a2e54"),
                        smooth=True, tags=("feed",))
                except Exception:
                    pass

        # 每条消息只按正文占一块；时间戳贴在气泡上方，不进框
        for info in infos:
            # 来自 DSH 的气泡：左边时间戳那一行贴一个小头像
            if not info["is_user"] and self._avatar_img is not None:
                try:
                    self.canvas.create_image(20, max(2, info["stamp_y"] - 4), anchor="nw",
                                             image=self._avatar_img, tags=("feed",))
                except Exception:
                    pass
            # 自己发的气泡：镜像到时间戳右侧，尺寸和间距与左边那颗一致
            if info["is_user"] and self._avatar_user_img is not None:
                try:
                    self.canvas.create_image(w - 48, max(2, info["stamp_y"] - 4), anchor="nw",
                                             image=self._avatar_user_img, tags=("feed",))
                except Exception:
                    pass
            if info["stamp"]:
                self.text.draw(info["tx"], info["stamp_y"], info["stamp"],
                               anchor=info["ta"], fill="#a8b7c9", size=9, tags=("feed",))
            for li, line in enumerate(info["lines"]):
                # 气泡里有底板，文字颜色固定、再补一层 1px 深色偏移当描边
                self.text.draw(info["tx"], info["ty"] + li * info["ls"], line,
                               anchor=info["ta"], fill="#edf6ff", size=11, tags=("feed",),
                               shadow=PLATE, adapt=not PLATE)
        self._btn_hits = []
        for info in infos:
            btn = info.get("btn")
            if not btn:
                continue
            x0, y0, x1, y1 = btn
            try:
                self.canvas.create_polygon(
                    self._rounded_points(x0, y0, x1, y1, 9, 5),
                    fill="#000000", outline="#ffffff", smooth=True, tags=("feed",))
                self.text.draw((x0 + x1) // 2, (y0 + y1) // 2,
                               info.get("btn_label", "展开"), anchor="center",
                               fill="#ffffff", size=11, tags=("feed",))
            except Exception:
                pass
            self._btn_hits.append(((x0, y0, x1, y1), info.get("key")))
        if not shown:
            slot = self._geo.shapes[0]
            self.text.draw(w // 2, slot[1] + (slot[3] - slot[1]) // 2,
                           "在这里跟它说话 · 滚轮翻历史", anchor="center",
                           fill="#8e9db2", size=12, tags=("feed",))

    def _draw_input(self) -> None:
        geo = self._geo
        x0, y0, x1, y1, _r = geo.input_shape
        self._ensure_entry()
        # Entry 放到 2x2 且底色是键色：真正显示的文字画在 Canvas 上，
        # 否则玻璃里会出现一个突兀的黑条（IME 候选框仍然正常）。
        self._entry_item = self.canvas.create_window(
            x0 + 84, y0 + 27, window=self._entry, anchor="w",
            width=2, height=2, tags=("feed", "chrome"))
        self._render_input()
        sx0, sy0, sx1, sy1, _r = geo.send_shape
        self.text.draw((sx0 + sx1) // 2, sy0 + 27, "发送", tags=("send", "feed", "chrome"),
                       fill="#ffffff", size=12, bold=True)
        self._draw_mic_dot()

    MIC_DOT_ON = "#e05a5a"
    MIC_DOT_OFF = "#6b7686"

    def _draw_mic_dot(self) -> None:
        """输入栏里麦克风图标右边那颗小圆点：灰=关、红=开（2026-11-07 用户要求）。

        麦克风图标本身烘在玻璃底图里（`paste_mic`），这颗点画在 Canvas 上，
        所以开/关要自己重画 —— 调用点是 `_draw_input` 和三个改状态的地方。
        """
        c = self.canvas
        try:
            c.delete("micdot")
        except Exception:
            pass
        if getattr(self, "_collapsed", False) or getattr(self, "_hidden", False):
            return
        try:
            mx, my = self._geo.mic_pos
        except Exception:
            return
        on = self._mic_proc is not None and self._mic_proc.poll() is None
        cx, cy = mx + MIC_SIZE + 9, my + MIC_SIZE // 2
        try:
            c.create_oval(cx - 4, cy - 4, cx + 4, cy + 4,
                          fill=(self.MIC_DOT_ON if on else self.MIC_DOT_OFF),
                          outline="", tags=("micdot", "chrome"))
        except Exception:
            pass

    # ---- 底部「历史记录」那一栏（2026-11-06） ----

    HISTORY_LABEL = "收藏/历史"
    HISTORY_LABEL_SHORT = "收藏"

    def _draw_history_bar(self) -> None:
        """输入栏上方那一行：左边一颗【历史记录】胶囊，右边一句话数。

        位置按"底块"算：底块现在从 h-130 开始（SLAB_BOT_H=118），这条占
        h-126..h-86，下面 h-80 起才是输入框，两者不重叠。
        """
        c = self.canvas
        w, h = self._geo.width, self._geo.height
        # 自己那几样先删掉再画：这个函数会被「回到最新」的显隐单独重调，
        # 不删就会一层层叠上去（2026-11-06）
        try:
            c.delete("historybtn")
            c.delete("jumpbtn")
        except Exception:
            pass
        # 主对话区和这一栏之间的白色分割线：落在主体玻璃与底块之间的透明缝里
        # （主体到 h-142，底块从 h-130 起），和标题栏下面那条一样只做内缩的一段
        try:
            c.create_line(40, h - 136, w - 40, h - 136, fill="#ffffff", width=1,
                          tags=("historybtn", "hdivider"))
        except Exception:
            pass
        y0, y1 = h - 126, h - 86
        f = self.fonts.get(11)
        cy = (y0 + y1) // 2
        x0 = 36
        # 「收藏/历史」比原来的「历史记录」宽一点：极窄窗退成「收藏」，
        # 否则右边那串（回到最新 / 会话数 / 价格标签）就没地方了（2026-11-06）
        label = self.HISTORY_LABEL if w >= 520 else self.HISTORY_LABEL_SHORT
        x1 = x0 + f.measure(label) + 30
        try:
            # 回顾窗开着的时候按钮压成高亮，明确「再点一次就是关」
            on = self._hist_alive()
            c.create_polygon(self._rounded_points(x0, y0, x1, y1, 20, 5),
                             fill=("#17324f" if on else "#000000"),
                             outline=(BTN_EDGE_ON if on else BTN_EDGE), smooth=True,
                             tags=("historybtn", "chrome"))
            if label == self.HISTORY_LABEL:
                # 2026-11-06 用户要求：「收藏」黄字，「/历史」保持白字
                p1, p2 = "收藏", label[len("收藏"):]
                start = (x0 + x1) / 2 - f.measure(label) / 2
                self.text.draw(start, cy, p1, anchor="w", fill="#e8c34a", size=11,
                               tags=("historybtn", "chrome"))
                self.text.draw(start + f.measure(p1), cy, p2, anchor="w",
                               fill="#ffffff", size=11, tags=("historybtn", "chrome"))
            else:
                # 窄窗只剩「收藏」两个字：整颗黄字
                self.text.draw((x0 + x1) // 2, cy, label, anchor="center",
                               fill="#e8c34a", size=11, tags=("historybtn", "chrome"))
        except Exception:
            self._history_rect = None
            return
        self._history_rect = (x0, y0, x1, y1)
        # 右边：还有几个历史会话。
        # 2026-11-06 用户要求：**窄窗优先保价格标签** —— 这句可以缩成「8 条」甚至不画，
        # 但时段标签必须回来。所以先给价格标签占好位，再拿剩下的宽度挑文案。
        try:
            n = len([g for g in self._history_sessions() if g["sid"]])
        except Exception:
            n = 0
        f9 = self.fonts.get(9)
        chip = self._price_chip_text()
        chip_w = (f9.measure(chip[0]) + 34) if chip else 0
        MIN_GAP = 16
        chip_fits = bool(chip) and (w - 36 - chip_w - MIN_GAP) >= (x1 + 14)
        right_limit = (w - 36 - chip_w) if chip_fits else (w - 36)
        # ② 先给「回到最新」留位：它是功能，比「8 条」这种装饰重要，
        #    窄窗时宁可把会话数缩没，也要留得下那颗按钮（2026-11-06）
        jump_reserve = 0
        if (getattr(self, "_new_below", False) and not getattr(self, "_collapsed", False)
                and getattr(self, "_expanded", None) is None):
            room_j = (right_limit - 12) - (x1 + 14 + MIN_GAP)
            for cand in ("↓ 回到最新", "回到最新", "↓ 最新", "最新", "↓"):
                cw = f9.measure(cand) + (16 if len(cand) <= 2 else 20)
                if cw <= room_j:
                    jump_reserve = cw + MIN_GAP
                    break
        room = right_limit - MIN_GAP - jump_reserve - (x1 + 14)
        hint = ""
        for cand in ((f"{n} 个历史会话" if n else "还没有历史会话"),
                     (f"{n} 个会话" if n else "没有历史会话"),
                     (f"{n} 条" if n else "")):
            if cand and f9.measure(cand) <= room:
                hint = cand
                break
        if hint:
            # 2026-11-06 用户要求靠左：紧跟在【历史记录】胶囊右边，不再贴窗右缘
            self.text.draw(x1 + 14, cy, hint, anchor="w", fill="#8e9db2",
                           size=9, tags=("historybtn", "chrome"))
            self._hist_hint_end = x1 + 14 + f9.measure(hint)
        else:
            self._hist_hint_end = x1 + 14
        # 右端空位放价格时段标签（2026-11-06 用户要求）
        self._draw_price_chip()
        # ② 「回到最新」：价格标签左边、历史会话数右边的空位（用户 2026-11-06 指定）
        self._draw_jump_button()

    def _draw_jump_button(self) -> None:
        """② 「↓ 回到最新」：**只在**「不在底部」且「有新消息进来」时出现。

        点了 / 自己滚到底就消失（`_jump_to_latest` 与 `_scroll_by` 里清标记）。
        仅主窗展开态有这一条（收起态没有底栏）。
        """
        c = self.canvas
        self._jump_rect = None
        if not getattr(self, "_new_below", False):
            return
        if getattr(self, "_collapsed", False) or getattr(self, "_hidden", False):
            return
        if getattr(self, "_expanded", None) is not None:
            return
        w, h = self._geo.width, self._geo.height
        f9 = self.fonts.get(9)
        x0 = float(getattr(self, "_hist_hint_end", 0) or 0) + 16
        right_limit = getattr(self, "_price_chip_x0", None)
        if right_limit is None:
            right_limit = w - 36
        # 位置是"历史会话数右边 → 价格标签左边"，窄窗就这么窄：按宽度退到更短的文案，
        # 一个都放不下才不画（2026-11-06 实报 651 宽时「↓ 回到最新」塞不进去、整个按钮消失）
        avail = right_limit - 12 - x0
        label, bw = None, 0.0
        for cand in ("↓ 回到最新", "回到最新", "↓ 最新", "最新", "↓"):
            pad = 16 if len(cand) <= 2 else 20
            cw = f9.measure(cand) + pad
            if cw <= avail:
                label, bw = cand, cw
                break
        if label is None:
            return
        x1 = x0 + bw
        cy = h - 106
        try:
            c.create_polygon(self._rounded_points(x0, cy - 11, x1, cy + 11, 11, 5),
                             fill="#17324f", outline=BTN_EDGE_ON, smooth=True,
                             tags=("jumpbtn", "chrome"))
            self.text.draw((x0 + x1) / 2, cy, label, anchor="center",
                           fill="#ffffff", size=9, tags=("jumpbtn", "chrome"))
            self._jump_rect = (x0, cy - 11, x1, cy + 11)
        except Exception:
            self._jump_rect = None

    def _jump_to_latest(self) -> None:
        """滚回底部，并把「回到最新」收掉。"""
        self._new_below = False
        self._follow_bottom = True
        if getattr(self, "_scroll_max", 0) > 0:
            self._scroll_px = self._scroll_max
            self._scroll_target = self._scroll_max
        try:
            self._redraw_bubbles()
        except Exception:
            pass
        try:
            self._draw_history_bar()
        except Exception:
            pass

    def _price_chip_text(self):
        """(文字, 是否高峰)；离切换不到 30 分钟时附倒计时，口径同 dsh-price-period。"""
        if not price_chip_enabled():
            return None
        try:
            peak, remain, next_peak, _holiday = price_period()
        except Exception:
            return None
        label = "高峰期" if peak else "半价期"
        if remain is not None and 0 < remain < 30 * 60:
            total = max(0, int(remain + 0.999))
            hours, rest = divmod(total, 3600)
            minutes, seconds = divmod(rest, 60)
            left = (f"{hours}:{minutes:02d}:{seconds:02d}" if hours
                    else f"{minutes:02d}:{seconds:02d}")
            label += f" · {'距高峰' if next_peak else '距半价'} {left}"
        return label, peak

    def _draw_price_chip(self) -> None:
        """底栏右侧那枚时段标签：绿=半价期、橙=高峰期，放不下就不画。"""
        c = self.canvas
        try:
            c.delete("pricechip")
        except Exception:
            pass
        if getattr(self, "_collapsed", False) or getattr(self, "_hidden", False):
            return
        info = self._price_chip_text()
        if not info:
            return
        text, peak = info
        w, h = self._geo.width, self._geo.height
        f9 = self.fonts.get(9)
        chip_w = f9.measure(text) + 34
        x1 = w - 36
        x0 = x1 - chip_w
        if chip_w < 60 or x0 < getattr(self, "_hist_hint_end", 0) + 16:
            self._price_chip_x0 = None
            return
        self._price_chip_x0 = x0
        cy = h - 106
        col = "#f0a020" if peak else "#3ddc84"
        try:
            c.create_polygon(self._rounded_points(x0, cy - 11, x1, cy + 11, 11, 5),
                             fill="#0f1612", outline="#243029", smooth=True,
                             tags=("pricechip", "chrome"))
            c.create_oval(x0 + 10, cy - 3, x0 + 16, cy + 3, fill=col, outline="",
                          tags=("pricechip", "chrome"))
            self.text.draw(x0 + 22, cy, text, anchor="w", fill=col, size=9,
                           tags=("pricechip", "chrome"))
        except Exception:
            pass

    def _price_tick(self) -> None:
        """每秒重算一次：跨期与倒计时都靠它；文字没变就不重画。"""
        try:
            info = self._price_chip_text()
            if info != getattr(self, "_price_last", None):
                self._price_last = info
                self._draw_price_chip()
        except Exception:
            pass
        try:
            self.root.after(1000, self._price_tick)
        except Exception:
            pass

    # ---- 历史记录弹窗：先选会话，再只看那一个会话（2026-11-06 第二轮改版） ----
    #
    # 用户要求：① 和主窗同一个风格；② 列表要有上下滚动栏，关窗按钮只留右上角 ✕；
    # ③ 历史里要能看图片，含双方头像。所以不再是 Tk 控件拼的普通窗，改成和主窗
    # 同一套画法：无边框 Toplevel + `-transparentcolor` 抠圆角 + Canvas 自绘
    # （圆角面板 / 胶囊 / 气泡 / 头像 / 图片），文字走同一套 `_seg_lines` + `_run_font`
    # 折行，颜色、字体、圆角半径全部复用主窗。

    HIST_W, HIST_H = 480, 660
    # 回顾窗可拖边角缩放（2026-11-09 用户要求）：下限取「正文页折行还看得下去」的宽度，
    # 上限每次按下按虚拟桌面现算。尺寸记在 `watch-window.json` 的 `historySize`。
    HIST_MIN_W, HIST_MIN_H = 360, 420
    H_PANEL = "#0a1017"
    H_ROW = "#121c2a"
    H_ROW_HL = "#1b2839"
    H_TEXT = "#eaf3ff"
    H_MUTED = "#8e9db2"
    H_AV = 26

    def _history_window(self):
        st = getattr(self, "_hist", None)
        if st is not None:
            try:
                if st["win"].winfo_exists():
                    return st["win"]
            except Exception:
                pass
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.configure(bg=KEY)
        try:
            win.attributes("-transparentcolor", KEY)
            win.attributes("-topmost", True)
        except Exception:
            pass
        w, h = self._hist_size()
        x = self._x - w - 14
        if x < 10:
            x = min(self._x + self._geo.width + 14, self._sw - w - 10)
        x = max(10, x)
        y = max(10, min(self._y, self._sh - h - 10))
        win.geometry(f"{w}x{h}+{x}+{y}")
        canvas = tk.Canvas(win, bg=KEY, highlightthickness=0, bd=0, width=w, height=h)
        canvas.pack(fill="both", expand=True)
        self._hist = {
            "win": win, "canvas": canvas, "w": w, "h": h,
            "text": TextLayer(self.root, canvas, self.fonts),
            "page": None, "sid": None, "scroll": 0, "total": 0, "max": 0,
            "view": None, "rows": [], "close": None, "back": None,
            "track": None, "thumb": None, "drag": None, "sb_drag": None,
            "hover_sid": None,
            # 拖边角缩放（2026-11-09）：`resize` = 这次拖的是哪条边/哪个角，
            # `resize_target` = 节流后要落到的最终框，松手按它补最后一帧。
            "resize": None, "resize_target": None, "resize_at": 0.0,
            # 标题栏那两口（短 id / 标题）：拖手期间重画标题栏时不用再去读标题文件
            "h_head": ("", ""),
            # 2026-11-06：正文里的「展开某条」状态（按 at 认），展开后标题栏出【收回】
            "expanded": None, "chip": None, "expand_hits": [],
        }
        canvas.bind("<MouseWheel>", self._hist_wheel)
        canvas.bind("<ButtonPress-1>", self._hist_press)
        canvas.bind("<Button-3>", self._hist_menu_open)   # 气泡图片右键菜单（2026-11-06）
        canvas.bind("<B1-Motion>", self._hist_motion)
        canvas.bind("<ButtonRelease-1>", self._hist_release)
        canvas.bind("<Motion>", self._hist_hover)
        win.protocol("WM_DELETE_WINDOW", self._close_history)
        return win

    # ---- 回顾窗尺寸：记忆 + 拖边角缩放（2026-11-09 用户要求） ----

    def _hist_size(self):
        """回顾窗该用多大：`watch-window.json` 的 `historySize`（"WxH"），解不出用默认。

        只记尺寸不记位置（用户 2026-11-09 选的口径）：位置每次打开都按主窗现摆。
        """
        w, h = self.HIST_W, self.HIST_H
        try:
            raw = read_config().get("historySize")
            if isinstance(raw, str):
                a, b = raw.lower().split("x", 1)
                w, h = int(float(a)), int(float(b))
        except Exception:
            w, h = self.HIST_W, self.HIST_H
        vw = int(self._vw or self._sw or 0)
        vh = int(self._vh or self._sh or 0)
        if vw > self.HIST_MIN_W + 20:
            w = min(w, vw - 20)
        if vh > self.HIST_MIN_H + 20:
            h = min(h, vh - 20)
        return int(max(self.HIST_MIN_W, w)), int(max(self.HIST_MIN_H, h))

    def _save_hist_size(self, w: int, h: int) -> None:
        """写回 `watch-window.json`。`write_config` 是读-改-写，不会碰 geometry /
        capturable 那些键。"""
        try:
            write_config({"historySize": f"{int(w)}x{int(h)}"})
        except Exception as exc:
            print("history size save failed:", repr(exc), flush=True)

    def _hist_edge_at(self, x, y):
        """鼠标在回顾窗的哪条边 / 哪个角上；`None` = 窗内。

        两个必须知道的坑：
        ① 面板自己缩进 5px（`_hist_chrome` 的 `_rounded_points(5, 5, w-5, h-5, 30, 6)`），
           外面那圈是 `-transparentcolor` 的 KEY 色 —— 那几像素**点不到**（鼠标穿透 /
           命中 DWM 非客户区），所以命中带要按「面板边缘」往里量，不是按窗口外沿；
        ② 右边 `w-23` 是滚动条轨道、底部 `h-32` 是「自动清理」那一行，边带放宽到 20px
           会把它们吃掉。所以边只有 8px，靠四个角（34px）给用户好抓的地方。
        """
        st = self._hist
        if not st:
            return None
        w, h = st["w"], st["h"]
        inset, edge, corner = 5, 8, 34
        if x <= corner and y <= corner:
            return "nw"
        if x >= w - corner and y <= corner:
            return "ne"
        if x <= corner and y >= h - corner:
            return "sw"
        if x >= w - corner and y >= h - corner:
            return "se"
        if y <= inset + edge:
            return None          # 顶部中间只拖动，不缩放（和主窗同一条规矩）
        if x <= inset + edge:
            return "w"
        if x >= w - inset - edge:
            return "e"
        if y >= h - inset - edge:
            return "s"
        return None

    def _hist_live_frame(self) -> None:
        """拖边角期间的一帧：只画底板 + 标题栏。

        正文要按新宽度重折行（`_hist_measure` → `_seg_lines` 按 `(文本, 宽度)` 缓存，
        **每一个新宽度都是全量重算**），拖手时 20fps 重排必掉帧 —— 而且它和主窗共用
        一个 Tk 主循环，卡住的就是主窗那边的画面。这里每拍只重建十几个 item，
        松手 `_hist_finish_resize()` 再整体重排。
        """
        st = self._hist
        if not st:
            return
        st["canvas"].delete("all")
        st["text"].reset()
        st["rows"] = []
        st["bubble_hits"] = []
        st["img_hits"] = []
        st["del_hits"] = []
        st["expand_hits"] = []
        sid, title = st.get("h_head") or ("", "")
        self._hist_chrome(sid, title)

    def _hist_apply_size(self, w: int, h: int, x: int, y: int,
                         live: bool = True) -> None:
        st = self._hist
        if not st:
            return
        w, h = int(w), int(h)
        st["w"], st["h"] = w, h
        st["win"].geometry(f"{w}x{h}+{int(x)}+{int(y)}")
        try:
            # canvas 是 `pack(fill=both)`：窗口变大时它自己会跟着长，缩小时不跟，
            # 所以显式改一次请求尺寸，让画布坐标和 `st["w"]/["h"]` 始终一致。
            st["canvas"].config(width=w, height=h)
        except Exception:
            pass
        if live:
            self._hist_live_frame()

    def _hist_finish_resize(self) -> None:
        """松手：补最后一帧尺寸 → 记盘 → 按新尺寸整体重排。"""
        st = self._hist
        if not st:
            return
        target = st.get("resize_target")
        st["resize_target"] = None
        st["resize_at"] = 0.0
        if target:
            self._hist_apply_size(target[0], target[1], target[2], target[3],
                                  live=False)
        w, h = int(st["w"]), int(st["h"])
        self._save_hist_size(w, h)
        self._hist_rebuild()
        print(f"[hist] resize {w}x{h} saved", flush=True)

    def _hist_rebuild(self) -> None:
        """按当前 `st["w"]/["h"]` 重排这一页（只在松手后走一次）。"""
        st = self._hist
        if not st:
            return
        try:
            if st.get("page") in ("viewer", "fav"):
                self._hist_relayout_keep_scroll()
            else:
                st["canvas"].delete("all")
                st["text"].reset()
                st["rows"] = []
                self._hist_draw_list()
        except Exception as exc:
            print("history relayout failed:", repr(exc), flush=True)

    def _hist_clear(self):
        st = self._hist
        st["canvas"].delete("all")
        st["text"].reset()
        st["rows"] = []
        st["close"] = None
        st["back"] = None
        st["latest"] = None
        st["hover_latest"] = False
        st["hover_sid"] = None
        st["track"] = None
        st["thumb"] = None
        st["view"] = None
        st["drag"] = None
        st["sb_drag"] = None
        st["img_hits"] = []
        st["bubble_hits"] = []
        st["del_hits"] = []
        st["fav_hit"] = None
        st["sort"] = None
        st["cleanup_rect"] = None
        st["expand_hits"] = []
        st["chip"] = None
        if "expanded" not in st:
            st["expanded"] = None

    def _close_history(self) -> None:
        st = getattr(self, "_hist", None)
        self._hist = None
        try:
            if st is not None:
                # 松手已经记过一次；这里再记一次是兜底（拖到一半就被程序化关窗）
                self._save_hist_size(st.get("w") or self.HIST_W,
                                     st.get("h") or self.HIST_H)
                st["win"].destroy()
        except Exception:
            pass
        self._refresh_history_btn()

    def _open_history(self, sid: str | None = None) -> None:
        """点【历史记录】：`sid` 为空 → 选会话列表；给了 → 直接看那个会话。"""
        if sid:
            self._history_show_session(sid)
        else:
            self._history_show_list()
        self._refresh_history_btn()

    def _hist_alive(self) -> bool:
        """回顾窗现在是不是开着（底栏按钮拿它做「开/关」切换）。"""
        st = getattr(self, "_hist", None)
        if not st:
            return False
        try:
            return bool(st["win"].winfo_exists())
        except Exception:
            return False

    def _toggle_history(self) -> None:
        if self._hist_alive():
            self._close_history()
        else:
            self._open_history()

    def _refresh_history_btn(self) -> None:
        """开/关回顾窗之后只重画底栏那颗按钮（不整窗重排）。"""
        try:
            self.canvas.delete("historybtn")
            self._draw_history_bar()
            self.text.refresh()
        except Exception as exc:
            print("history btn refresh failed:", repr(exc), flush=True)

    def _bind_to(self, sid: str) -> bool:
        """把主窗关联切到 `sid`：等同窗内【关联变更】确定，只是不用手打 ID。"""
        try:
            self._write_bound_session(sid)
        except Exception as exc:
            print("bind failed:", repr(exc), flush=True)
            return False
        self._bound_full = sid
        self._bound_sid = self._read_bound_session()
        self._touch_group(sid)
        self.feed.set_sid(sid)
        self._follow_bottom = True
        self._refresh_feed()
        self._refresh_header()
        return True

    def _back_to_latest(self) -> None:
        """「返回最新对话」：把主窗切回最新那个会话，关掉回顾窗，落回最新一条。

        这条专门救"用【关联变更】切到旧对话之后回不去了"——不用再记/输会话 ID。
        """
        st = self._hist or {}
        sid = st.get("latest_sid") or ""
        if sid:
            self._bind_to(sid)
        self._close_history()
        try:
            if getattr(self, "_expanded", None) is not None:
                self._expanded = None
                self._refresh_chip()
            self._follow_bottom = True
            self._scroll_px = getattr(self, "_scroll_max", 0)
            self._scroll_target = self._scroll_px
            self._redraw_feed_layer(None)
        except Exception as exc:
            print("back to latest failed:", repr(exc), flush=True)
        self._refresh_header()

    # ---- 公共外观：圆角面板 + 标题栏（蓝点 / 名字 / ✕）+ 分割线 ----

    def _hist_chrome(self, sid: str = "", title: str = "") -> None:
        """标题栏：蓝点 +「回顾」（和主窗「DSH」同款）+ 会话标题（没有标题就用短 ID）。"""
        st = self._hist
        # 记下这两口：拖边角期间 `_hist_live_frame()` 要重画标题栏，但不能再去读标题文件
        st["h_head"] = (sid or "", title or "")
        c, w, h = st["canvas"], st["w"], st["h"]
        c.create_polygon(self._rounded_points(5, 5, w - 5, h - 5, 30, 6),
                         fill=self.H_PANEL, outline="", smooth=True, tags=("panel",))
        c.create_oval(40, 34, 52, 46, outline="#2b4d73", width=1, tags=("hhead",))
        c.create_oval(43, 37, 49, 43, fill="#0a84ff", outline="", tags=("hhead",))
        c.create_text(62, 40, text="回顾", anchor="w", fill="#f7fbff",
                      font=self.fonts.spec(16, True), tags=("hhead",))
        if sid:
            # 和主窗标题栏里的会话 ID 同一档：10px、灰蓝、紧跟在名字后面（这段靠左）
            nx = 62 + self.fonts.get(16, True).measure("回顾") + 10
            label = self._fit_text(self.fonts.get(10), title or sid,
                                   max(20.0, (w - 60) - nx))
            c.create_text(nx, 40, text=label, anchor="w", fill="#8e9db2",
                          font=self.fonts.spec(10), tags=("hhead",))
        # 2026-11-06 用户要求 ⑤：「收回」不再放标题栏，改画在已展开那条的时间戳右边
        # （见 `_hist_paint`）。标题栏这里只负责把旧值清掉。
        st["chip"] = None
        c.create_text(w - 40, 40, text="✕", anchor="center", fill="#9fb0c8",
                      font=self.fonts.spec(13), tags=("hhead",))
        st["close"] = (w - 58, 22, w - 22, 58)
        c.create_line(28, 76, w - 28, 76, fill="#ffffff", width=1, tags=("hhead",))

    def _chat_sessions(self) -> dict:
        """{sid: {sid, firstAt, lastAt}} —— 从 chat.jsonl 现算（最多 4000 行）。"""
        try:
            lines = CHAT_FILE.read_text(encoding="utf-8").splitlines()[-4000:]
        except Exception:
            return {}
        out = {}
        for line in lines:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("role") == "meta":
                continue
            sid = str(e.get("sid") or "")
            if not sid:
                continue
            try:
                at = int(e.get("at") or 0)
            except Exception:
                continue
            g = out.get(sid)
            if g is None:
                out[sid] = {"sid": sid, "firstAt": at, "lastAt": at}
            else:
                g["firstAt"] = min(g["firstAt"], at)
                g["lastAt"] = max(g["lastAt"], at)
        return out

    def _latest_other_session(self) -> dict | None:
        """「最新对话」= 首条消息时间最新的那个会话。

        用它的场景（用户 2026-11-06 补充）：主窗【关联变更】切到了旧对话之后，
        想回到"原本的新对话"却懒得再输一遍会话 ID。所以：
        - 当前已经绑在最新那个上（或者当前会话还一条记录都没有）→ 返回 None，那一行不画；
        - 否则返回 {sid, short}，点一下就把主窗关联切回去（等同【关联变更】确定）。
        """
        cur = getattr(self, "_bound_full", "")
        stats = self._chat_sessions()
        if not stats or cur not in stats:
            return None
        newest = max(stats.values(), key=lambda g: (g["firstAt"], g["lastAt"]))
        if newest["sid"] == cur:
            return None
        sid = newest["sid"]
        short = sid[len("session-"):][:8] if sid.startswith("session-") else sid[:8]
        return {"sid": sid, "short": short}

    def _hist_draw_list(self) -> None:
        st = self._hist
        st["del_hits"] = []
        st["fav_hit"] = None
        self._hist_chrome()
        c, w, h = st["canvas"], st["w"], st["h"]
        # ① 置顶：收藏内容（2026-11-06 用户要求）。样式同普通列表行，但右侧
        #    没有时间戳、没有红 ✕ —— 钉在列表顶上，不随会话列表滚动。
        #    2026-11-06 用户要求：和底栏「收藏」一起用黄字。
        fy0, fy1 = 88, 136
        hf = bool(st.get("hover_fav"))
        c.create_polygon(self._rounded_points(28, fy0, w - 30, fy1, 16, 5),
                         fill=(self.H_ROW_HL if hf else self.H_ROW),
                         outline="", smooth=True, tags=("hfav",))
        c.create_text(46, (fy0 + fy1) // 2, text="收藏内容", anchor="w",
                      fill="#e8c34a", font=self.fonts.spec(12, True))
        st["fav_hit"] = (28, fy0, w - 30, fy1)
        y = fy1 + 8
        latest = self._latest_other_session()
        if latest:
            # 「<最新会话短id> 返回最新对话」：一键把主窗切回新对话，不用手打 ID
            label = "返回最新对话"
            f10 = self.fonts.get(10)
            pw = (self.fonts.get(11).measure(label) + 32
                  + f10.measure(latest["short"]) + 10)
            lx0, ly0, lx1, ly1 = 28, y, min(w - 30, 28 + pw), y + 40
            hl = bool(st.get("hover_latest"))
            c.create_polygon(self._rounded_points(lx0, ly0, lx1, ly1, 20, 5),
                             fill=("#17324f" if hl else "#000000"),
                             outline=(BTN_EDGE_ON if hl else BTN_EDGE), smooth=True,
                             tags=("hlatest",))
            tx = lx0 + 16
            cy = (ly0 + ly1) // 2
            c.create_text(tx, cy, text=latest["short"], anchor="w", fill="#8e9db2",
                          font=self.fonts.spec(10))
            tx += f10.measure(latest["short"]) + 10
            c.create_text(tx, cy, text=label, anchor="w", fill="#ffffff",
                          font=self.fonts.spec(11))
            st["latest"] = (lx0, ly0, lx1, ly1)
            st["latest_sid"] = latest["sid"]
            y = ly1 + 8
        else:
            st["latest"] = None
            st["latest_sid"] = ""
        title_y, sub_y, top = y + 14, y + 48, y + 78
        c.create_text(28, title_y, text="选择已有会话记录", anchor="nw",
                      fill=self.H_TEXT, font=self.fonts.spec(12, True))
        # 窄窗（缩放后 360 左右）这句会顶出面板右缘：按可用宽度裁一下
        c.create_text(28, sub_y, anchor="nw", fill=self.H_MUTED, font=self.fonts.spec(9),
                      text=self._fit_text(self.fonts.get(9),
                                          "按关联时间从新到旧 · 点一行只看那个会话",
                                          max(60.0, w - 56)))
        bottom = h - 62
        st["view"] = (top, bottom)
        # 列表底下固定一行：自动清理选项（2026-11-06 用户要求）
        self._hist_draw_cleanup_row()
        row_h, gap = 52, 8
        items = self._history_sessions()
        total = len(items) * (row_h + gap)
        st["total"] = total
        st["max"] = max(0, total - (bottom - top))
        st["scroll"] = max(0, min(st["scroll"], st["max"]))
        if not items:
            c.create_text(w // 2, (top + bottom) // 2, text="还没有其它会话的记录",
                          fill=self.H_MUTED, font=self.fonts.spec(10))
            self._hist_scrollbar()
            return
        y = top - st["scroll"]
        for g in items:
            if y + row_h >= top and y <= bottom:
                # `clip_top` / `clip_bottom`：行是按"和视口相交"判定的，所以首行会
                # 伸到视口上边（滚 30px 就压住「选择已有会话记录」和副标题 —— 用户
                # 2026-11-09 截图报「往下滚动这些选项往上飘」），末行会伸出底边压到
                # 「自动清理超过 N 天」上。两头都按视口裁掉。
                self._hist_draw_row(g, y, row_h, clip_top=top, clip_bottom=bottom)
            y += row_h + gap
        self._hist_scrollbar()

    def _hist_draw_row(self, g, y, row_h, clip_top=None, clip_bottom=None) -> None:
        st = self._hist
        c, w = st["canvas"], st["w"]
        x0, x1 = 28, w - 30
        y0 = y if clip_top is None else max(y, clip_top)
        y1 = y + row_h
        if clip_bottom is not None and y1 > clip_bottom:
            y1 = clip_bottom
        # 只剩几像素的残行不画：半个圆角看着像脏像素，滚动时还会闪
        if y1 - y0 < 10:
            return
        full = (y1 - y0) >= row_h
        # 文字按「这一行的自然位置」排（不跟着裁切上下跳）；被上边裁掉时整行不落字
        cy = (y + y1) // 2
        hl = st.get("hover_sid") == g["sid"]
        c.create_polygon(self._rounded_points(x0, y0, x1, y1, 16 if full else 4, 5),
                         fill=(self.H_ROW_HL if hl else self.H_ROW),
                         outline="", smooth=True, tags=("hrow",))
        # 被裁到很矮的行只留一条色块，硬塞文字更难看 —— 够 30px 才画字
        if y1 - y0 >= 30 and (clip_top is None or cy - 10 >= clip_top):
            meta = f'{g["count"]} 条 · {self._clock(g["lastAt"])}'
            mw = self.fonts.get(9).measure(meta)
            title = str(g.get("title") or g["short"])
            room = max(20.0, (x1 - 44 - mw - 14) - (x0 + 18))
            if room < 90:
                # 窄窗（缩到 360 左右）里时间戳会把标题挤成「his…」：这一行只留条数
                meta = f'{g["count"]} 条'
                mw = self.fonts.get(9).measure(meta)
                room = max(20.0, (x1 - 44 - mw - 14) - (x0 + 18))
            label = self._fit_text(self.fonts.get(12, True), title, room)
            c.create_text(x0 + 18, cy, text=label, anchor="w",
                          fill=self.H_TEXT, font=self.fonts.spec(12, True))
            c.create_text(x1 - 44, cy, text=meta,
                          anchor="e", fill=self.H_MUTED, font=self.fonts.spec(9))
        st["rows"].append(((x0, y0, x1, y1), g))

    # ---- 自动清理（2026-11-06） ----
    #
    # 状态存在 `see-now/cleanup.json`，**不写 see-now.json**：那个文件是插件的
    # 绑定配置，两边都写迟早互相覆盖。删记录前一律先整份备份到 `see-now/trash/`，
    # 误删能捞回来；超过 20 份才清旧的。

    CLEANUP_DEFAULT = 30

    def _cleanup_file(self) -> Path:
        return CHAT_FILE.parent / "cleanup.json"

    def _cleanup_cfg(self) -> dict:
        """读配置（2 秒缓存：列表页每次重画都会问一次）。"""
        now = time.time()
        hit = getattr(self, "_cleanup_cache", None)
        if hit and now - hit[1] < 2.0:
            return dict(hit[0])
        cfg = {"enabled": False, "days": self.CLEANUP_DEFAULT}
        try:
            data = json.loads(self._cleanup_file().read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for k in ("enabled", "days"):
                    if k in data:
                        cfg[k] = data[k]
        except Exception:
            pass
        try:
            cfg["days"] = max(1, int(cfg.get("days") or self.CLEANUP_DEFAULT))
        except Exception:
            cfg["days"] = self.CLEANUP_DEFAULT
        cfg["enabled"] = bool(cfg.get("enabled"))
        self._cleanup_cache = (dict(cfg), now)
        return cfg

    def _cleanup_save(self, cfg: dict) -> None:
        try:
            p = self._cleanup_file()
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, p)
        except Exception as exc:
            print("cleanup save failed:", repr(exc), flush=True)
        self._cleanup_cache = (dict(cfg), time.time())

    def _toggle_cleanup(self) -> None:
        cfg = self._cleanup_cfg()
        cfg["enabled"] = not bool(cfg.get("enabled"))
        self._cleanup_save(cfg)
        try:
            self._hist_redraw()
        except Exception as exc:
            print("cleanup redraw failed:", repr(exc), flush=True)
        if cfg["enabled"]:
            self._run_cleanup(int(cfg.get("days") or self.CLEANUP_DEFAULT))

    def _maybe_cleanup(self) -> None:
        """`_tick` 里每 60 秒问一次；开了就删，没开什么都不做。"""
        now = time.time()
        if now - getattr(self, "_cleanup_at", 0.0) < 60:
            return
        self._cleanup_at = now
        cfg = self._cleanup_cfg()
        if cfg.get("enabled"):
            self._run_cleanup(int(cfg.get("days") or self.CLEANUP_DEFAULT))

    def _run_cleanup(self, days: int) -> None:
        cutoff = int((time.time() - days * 86400) * 1000)
        try:
            lines = CHAT_FILE.read_text(encoding="utf-8").splitlines()
        except Exception:
            return
        keep, gone = [], 0
        for line in lines:
            try:
                e = json.loads(line)
            except Exception:
                keep.append(line)          # 坏行原样保留，不因清理丢数据
                continue
            try:
                at = int(e.get("at") or 0)
            except Exception:
                at = 0
            if at and at < cutoff:
                gone += 1
                continue
            keep.append(line)
        if not gone:
            return
        self._backup_chat("auto")
        self._write_chat_lines(keep)
        self.feed.reload()
        try:
            self._refresh_feed()
            st = self._hist
            if st and st.get("page") == "viewer" and st.get("sid"):
                self._hist_relayout_keep_scroll()
            elif st and st.get("page") == "list":
                self._hist_redraw()
            self._refresh_history_btn()
        except Exception as exc:
            print("cleanup refresh failed:", repr(exc), flush=True)
        print(f"cleanup: removed {gone} entries older than {days}d", flush=True)

    def _backup_chat(self, tag: str = "del") -> None:
        """删任何记录前先整份备份：删错了还能从 trash/ 捞回来。"""
        try:
            folder = CHAT_FILE.parent / "trash"
            folder.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            dst = folder / f"chat-{stamp}-{tag}.jsonl"
            dst.write_bytes(CHAT_FILE.read_bytes())
            olds = sorted(folder.glob("chat-*.jsonl"))
            for old in olds[:-20]:
                try:
                    old.unlink()
                except OSError:
                    pass
        except Exception as exc:
            print("chat backup failed:", repr(exc), flush=True)

    def _write_chat_lines(self, lines: list) -> None:
        tmp = CHAT_FILE.with_suffix(".jsonl.tmp")
        tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        os.replace(tmp, CHAT_FILE)

    def _delete_skip(self) -> bool:
        try:
            return bool(json.loads(DELETE_CFG.read_text(encoding="utf-8")).get("skip"))
        except Exception:
            return False

    def _set_delete_skip(self, on: bool) -> None:
        try:
            DELETE_CFG.write_text(json.dumps({"skip": bool(on)}, ensure_ascii=False),
                                  encoding="utf-8")
        except Exception as exc:
            print("delete cfg failed:", repr(exc), flush=True)

    def _ask_delete(self, sid: str) -> None:
        if self._delete_skip():
            self._delete_session(sid)
            return
        self._show_delete_confirm(sid)

    def _show_delete_confirm(self, sid: str) -> None:
        """删除整组会话前的确认弹窗：同「隐藏气泡」那款——实际影响、是/否、免提醒。"""
        n = 0
        try:
            for g in self._history_sessions():
                if str(g.get("sid") or "") == sid:
                    n = int(g.get("count") or 0)
                    break
        except Exception:
            pass
        w, h = 500, 250
        vx, vy = self._vx, self._vy
        x = max(vx + 8, min(self._x + (self._geo.width - w) // 2, vx + self._vw - w - 8))
        y = max(vy + 8, min(self._y + (self._geo.height - h) // 3, vy + self._vh - h - 8))
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.configure(bg="#000000")
        try:
            win.attributes("-topmost", True)
        except Exception:
            pass
        win.geometry(f"{w}x{h}+{x}+{y}")
        self._delete_dlg = win
        c = tk.Canvas(win, bg="#000000", highlightthickness=0, bd=0, width=w, height=h)
        c.pack()
        pad = 24
        c.create_polygon(self._rounded_points(0, 0, w, h, 16, 6),
                         fill="#0f1319", outline="#2a3546", smooth=True)
        c.create_text(pad, pad, text="删除这组会话记录？", anchor="nw",
                      fill="#e6eef8", font=self.fonts.spec(14, True))
        c.create_text(pad, pad + 34, anchor="nw", fill="#9fb0c8",
                      font=self.fonts.spec(10), width=w - pad * 2,
                      text=f"将删除这组会话在浮窗里的全部 {n} 条记录，"
                           "并从回顾列表移除。DSH 会话本身不受影响，"
                           "删除前会整份备份到 trash/（可在那里找回）。")
        cb = (pad, h - 96, pad + 16, h - 80)
        c.create_rectangle(*cb, outline="#6b7d95", width=1, fill="#111a24")
        c.create_text(pad + 24, h - 88, text="我已知晓，无需提醒", anchor="w",
                      fill="#9fb0c8", font=self.fonts.spec(10))
        bw, bh, by = 78, 32, h - 56
        no = (w - pad - bw, by, w - pad, by + bh)
        yes = (no[0] - bw - 10, by, no[0] - 10, by + bh)
        for (bx0, b0, bx1, b1), label, tag in (((yes, "是", "dyes")),
                                               ((no, "否", "dno"))):
            c.create_polygon(self._rounded_points(bx0, b0, bx1, b1, 14, 5),
                             fill=("#17324f" if tag == "dyes" else "#000000"),
                             outline=(BTN_EDGE_ON if tag == "dyes" else BTN_EDGE),
                             smooth=True, tags=(tag,))
            c.create_text((bx0 + bx1) / 2, (b0 + b1) / 2, text=label,
                          anchor="center", fill="#ffffff",
                          font=self.fonts.spec(11, True), tags=(tag,))
        state = {"skip": False, "done": False}

        def draw_tick():
            c.delete("dtick")
            if state["skip"]:
                c.create_line(cb[0] + 3, cb[1] + 8, cb[0] + 7, cb[1] + 12,
                              cb[0] + 13, cb[1] + 3, fill="#7fc4ff", width=2,
                              tags=("dtick",))

        def close():
            if state["done"]:
                return
            state["done"] = True
            if getattr(self, "_delete_dlg", None) is win:
                self._delete_dlg = None
            try:
                win.grab_release()
            except Exception:
                pass
            try:
                win.destroy()
            except Exception:
                pass

        def hit(box, e):
            return box[0] <= e.x <= box[2] and box[1] <= e.y <= box[3]

        def click(e):
            if hit((cb[0] - 6, cb[1] - 8, cb[0] + 140, cb[3] + 8), e):
                state["skip"] = not state["skip"]
                draw_tick()
                return
            if hit(yes, e):
                skip = state["skip"]
                close()
                if skip:
                    self._set_delete_skip(True)
                self._delete_session(sid)
            elif hit(no, e):
                close()

        c.bind("<Button-1>", click)
        win.bind("<Escape>", lambda _e: close())
        try:
            win.grab_set()
        except Exception:
            pass
        try:
            win.lift()
            win.focus_force()
        except Exception:
            pass
        self._pin_topmost(win)

    def _show_rename_dialog(self, sid: str) -> None:
        """重命名这组会话的标题：本地立即生效，同时写回 DSH（左侧栏跟着变）。"""
        cur = self._session_titles().get(sid) or ""
        w, h = 500, 250
        vx, vy = self._vx, self._vy
        x = max(vx + 8, min(self._x + (self._geo.width - w) // 2, vx + self._vw - w - 8))
        y = max(vy + 8, min(self._y + (self._geo.height - h) // 3, vy + self._vh - h - 8))
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.configure(bg="#000000")
        try:
            win.attributes("-topmost", True)
        except Exception:
            pass
        win.geometry(f"{w}x{h}+{x}+{y}")
        self._rename_dlg = win
        c = tk.Canvas(win, bg="#000000", highlightthickness=0, bd=0, width=w, height=h)
        c.pack()
        pad = 24
        c.create_polygon(self._rounded_points(0, 0, w, h, 16, 6),
                         fill="#0f1319", outline="#2a3546", smooth=True)
        c.create_text(pad, pad, text="重命名标题", anchor="nw",
                      fill="#e6eef8", font=self.fonts.spec(14, True))
        c.create_text(pad, pad + 34, anchor="nw", fill="#9fb0c8",
                      font=self.fonts.spec(10), width=w - pad * 2,
                      text="会同时改成 DSH 会话标题（左侧栏跟着变）。留空只清掉浮窗里的"
                           "自定义名，DSH 那边不动。")
        ent = tk.Entry(win, font=self.fonts.spec(12), relief="flat", bd=0,
                       bg="#111a24", fg="#e6eef8", insertbackground="#eaf4ff")
        ent.insert(0, cur)
        c.create_window(pad, pad + 104, anchor="nw", window=ent,
                        width=w - pad * 2, height=30)
        bw, bh, by = 78, 32, h - 56
        no = (w - pad - bw, by, w - pad, by + bh)
        yes = (no[0] - bw - 10, by, no[0] - 10, by + bh)
        for (bx0, b0, bx1, b1), label, tag in (((yes, "确定", "ryes")),
                                               ((no, "取消", "rno"))):
            c.create_polygon(self._rounded_points(bx0, b0, bx1, b1, 14, 5),
                             fill=("#17324f" if tag == "ryes" else "#000000"),
                             outline=(BTN_EDGE_ON if tag == "ryes" else BTN_EDGE),
                             smooth=True, tags=(tag,))
            c.create_text((bx0 + bx1) / 2, (b0 + b1) / 2, text=label,
                          anchor="center", fill="#ffffff",
                          font=self.fonts.spec(11, True), tags=(tag,))
        state = {"done": False}

        def close():
            if state["done"]:
                return
            state["done"] = True
            if getattr(self, "_rename_dlg", None) is win:
                self._rename_dlg = None
            try:
                win.grab_release()
            except Exception:
                pass
            try:
                win.destroy()
            except Exception:
                pass

        def commit(_e=None):
            text = ent.get().strip()
            titles = self._local_titles()
            if text:
                titles[sid] = {"title": text[:40], "at": int(time.time() * 1000)}
            else:
                titles.pop(sid, None)
            self._save_titles(titles)
            # 写回 DSH（留空只清浮窗本地名：DSH 没有"删除标题"的接口，硬刷新会把
            # 自动生成的标题再写回来，不如不动）
            if text:
                self._request_title_sync(sid, text[:40])
            close()
            try:
                st = self._hist or {}
                if st.get("page") == "viewer" and st.get("sid"):
                    self._history_show_session(st.get("sid"))
                else:
                    self._hist_redraw()
            except Exception as exc:
                print("rename redraw failed:", repr(exc), flush=True)

        def hit(box, e):
            return box[0] <= e.x <= box[2] and box[1] <= e.y <= box[3]

        def click(e):
            if hit(yes, e):
                commit()
            elif hit(no, e):
                close()

        c.bind("<Button-1>", click)
        ent.bind("<Return>", commit)
        win.bind("<Escape>", lambda _e: close())
        try:
            win.grab_set()
        except Exception:
            pass
        try:
            win.lift()
            win.focus_force()
            ent.focus_force()
            ent.select_range(0, "end")
        except Exception:
            pass
        self._pin_topmost(win)

    def _delete_session(self, sid: str) -> None:
        """删掉一个会话的全部记录（先备份；当前绑定会话不从历史里删）。"""
        if sid and sid == getattr(self, "_bound_full", ""):
            print("delete session: refuse current session", flush=True)
            return
        try:
            lines = CHAT_FILE.read_text(encoding="utf-8").splitlines()
        except Exception as exc:
            print("delete read failed:", repr(exc), flush=True)
            return
        keep, gone = [], 0
        for line in lines:
            try:
                raw = json.loads(line)
            except Exception:
                keep.append(line)          # 坏行原样保留
                continue
            if str(raw.get("sid") or "") == sid:
                gone += 1
                continue
            keep.append(line)
        if not gone:
            print("delete session: nothing matched", flush=True)
            return
        self._backup_chat("del-session")
        self._write_chat_lines(keep)
        try:
            titles = self._local_titles()
            if sid in titles:
                titles.pop(sid, None)
                self._save_titles(titles)
        except Exception:
            pass
        try:
            st = self._hist
            if st and st.get("page") == "viewer" and st.get("sid") == sid:
                self._history_show_list()
            elif st and st.get("page") == "list":
                st["scroll"] = 0
                self._hist_redraw()
            self._refresh_history_btn()
        except Exception as exc:
            print("delete session refresh failed:", repr(exc), flush=True)
        print(f"delete session: removed {gone} entries sid={sid}", flush=True)

    def _hist_draw_cleanup_row(self) -> None:
        """列表底下那一行：「☐ 自动清理超过 N 天的记录」。"""
        st = self._hist
        c, h = st["canvas"], st["h"]
        cfg = self._cleanup_cfg()
        days = max(1, int(cfg.get("days") or self.CLEANUP_DEFAULT))
        on = bool(cfg.get("enabled"))
        cy = h - 32
        x0 = 28
        try:
            c.create_rectangle(x0, cy - 9, x0 + 18, cy + 9, outline="#5c6b80",
                               fill=("#0a84ff" if on else "#000000"), width=1,
                               tags=("hclean",))
            if on:
                c.create_text(x0 + 9, cy, text="✓", fill="#ffffff",
                              font=self.fonts.spec(10, True), tags=("hclean",))
            label = f"自动清理超过 {days} 天的记录"
            c.create_text(x0 + 28, cy, text=label, anchor="w", fill=self.H_MUTED,
                          font=self.fonts.spec(10), tags=("hclean",))
            tw = self.fonts.get(10).measure(label)
            st["cleanup_rect"] = (x0 - 6, cy - 15, x0 + 28 + tw + 6, cy + 15)
        except Exception:
            st["cleanup_rect"] = None

    def _hist_scrollbar(self) -> None:
        st = self._hist
        c, w, h = st["canvas"], st["w"], st["h"]
        top, bottom = st.get("view") or (88, h - 22)
        st["track"] = None
        st["thumb"] = None
        got = self._sb_paint(c, w - 23, top, bottom, st["total"],
                             max(1, bottom - top), st["scroll"], st["max"], ())
        if not got:
            return
        st["track"], st["thumb"] = got

    # ---- 会话正文：气泡 + 头像 + 图片 ----

    def _hist_draw_runs(self, cx, y, line) -> None:
        """和主窗 `_draw_runs` 同一套 run（粗体/行内代码）画法，只是落在弹窗画布上。"""
        t = self._hist["text"]
        for txt, style in line:
            if not txt:
                continue
            fill = "#ffffff" if style == "b" else ("#9fd6ff" if style == "c" else "#edf6ff")
            t.draw(cx, y, txt, anchor="nw", fill=fill, size=11,
                   bold=(style == "b"), tags=("hbody",),
                   shadow=False, adapt=False, per_char=False)
            cx += self._run_font(style).measure(txt)

    def _hist_measure(self, entries, source: bool = False):
        """把条目排成气泡：返回 (布局, 总高)。折行/图片尺寸都复用主窗那套缓存。

        2026-11-06（用户要求）：和主窗一样先给摘要（2 行文本 + 1 张图），
        点气泡右下角三角展开整条，展开后标题栏出【收回】。默认不再整段铺开。
        `source=True` 是收藏页：每条气泡下面多一行「来源 <短 id>」。
        """
        st = self._hist
        w = st["w"]
        ls = self.fonts.get(11).metrics("linespace")
        stamp_ls = self.fonts.get(9).metrics("linespace")
        pad = 14
        left, right = 28, w - 28
        max_bubble = (right - left) - 34
        content_max = max_bubble - pad * 2
        expanded = st.get("expanded")
        # 展开态只排这一条（和主窗一致）：时间戳钉得住，其他消息也不会从上面滚过来
        if expanded is not None:
            picked = [e for e in entries
                      if str(e.get("_key") or e.get("at") or "") == str(expanded)][:1]
            if picked:
                entries = picked
        # 展开态多留 10px：给「收回」胶囊的上下留白（2026-11-06 用户要求）
        out, y = [], (10 if expanded is not None else 0)
        for e in entries:
            is_user = str(e.get("role") or "").lower() in ("user", "me", "human")
            stamp = self._clock(e.get("at")) if e.get("at") else ""
            key = str(e.get("_key") or e.get("at") or "")
            is_open = expanded is not None and key == str(expanded)
            raw = []
            for kind, payload in self._parse_blocks(e.get("text") or ""):
                if kind == "text":
                    seg = payload.strip("\n")
                    if not seg.strip():
                        continue
                    raw.append(("text", self._seg_lines(seg, content_max)))
                else:
                    raw.append(("img", payload))

            total_lines = sum(len(p) for k, p in raw if k == "text")
            total_imgs = sum(1 for k, p in raw if k == "img")
            more = False
            if not is_open:
                cut = []
                text_left, img_left = 2, 1
                for kind, payload in raw:
                    if kind == "text" and text_left > 0:
                        # 空行不占那两行的名额（主窗同款：不然摘要只剩一行字）
                        part = [ln for ln in payload if ln][:text_left]
                        if part:
                            cut.append(("text", part))
                            text_left -= len(part)
                    elif kind == "img" and img_left > 0:
                        cut.append(("img", payload))
                        img_left -= 1
                kept_lines = sum(len(p) for k, p in cut if k == "text")
                kept_imgs = sum(1 for k, p in cut if k == "img")
                more = kept_lines < total_lines or kept_imgs < total_imgs
                if more:
                    # 截断了就补省略号：以前直接砍断，正文停在半句上
                    for i in range(len(cut) - 1, -1, -1):
                        if cut[i][0] != "text" or not cut[i][1]:
                            continue
                        lines_cut = list(cut[i][1])
                        last_cut = list(lines_cut[-1]) + [("…", "n")]
                        while len(last_cut) > 1 and self._runs_width(last_cut) > content_max:
                            txt, sty = last_cut[-2]
                            if len(txt) > 1:
                                last_cut[-2] = (txt[:-1], sty)
                            else:
                                del last_cut[-2]
                        lines_cut[-1] = last_cut
                        cut[i] = ("text", lines_cut)
                        break
                raw = cut

            segs = []
            for kind, payload in raw:
                if kind == "text":
                    segs.append({"kind": "text", "lines": payload,
                                 "h": len(payload) * ls})
                else:
                    src = str(payload)
                    size = None
                    if src.startswith(("http://", "https://")):
                        # 网络图先触发下载；下好之前量不到尺寸，先占一行，
                        # 下载完 `_apply_pending_images` 会重新量（否则气泡按占位高，
                        # 图却按真实大小画出来 → 图直接溢出气泡，2026-11-06 实报）
                        got = self._img_state(src, content_max, 210)
                        if got and got[1] is not None:
                            size = (got[1].width(), got[1].height())
                    else:
                        size = self._img_probe(src, content_max, 210)
                    if size:
                        segs.append({"kind": "img", "src": payload, "w": size[0],
                                     "h": size[1] + 10, "max_w": content_max,
                                     "max_h": 210})
                    else:
                        segs.append({"kind": "img", "src": payload, "w": 0,
                                     "h": ls + 6, "max_w": content_max, "max_h": 210})
            body = max(ls + 16, sum(s["h"] for s in segs) + 16)
            if more:
                body += 26          # 给右下角展开三角留高度
            src_short = ""
            if source:
                # 收藏页：气泡下面那行「来源 <短 id>」（2026-11-06 用户要求）
                sid_full = str(e.get("sid") or "")
                src_short = (sid_full[len("session-"):][:8] if sid_full.startswith("session-")
                             else (sid_full[:8] or "未归属"))
            inner = max([0] + [self._runs_width(ln) for s in segs if s["kind"] == "text"
                               for ln in s["lines"]]
                        + [s["w"] for s in segs if s["kind"] == "img"])
            bw = min(max_bubble, max(140, inner + pad * 2))
            if is_user:
                bx1 = right - 34
                bx0 = bx1 - bw
                stamp_x, stamp_a = bx1, "ne"
            else:
                bx0 = left + 34
                bx1 = bx0 + bw
                stamp_x, stamp_a = bx0, "nw"
            # 展开态的时间戳行多留 8px，给「收回」胶囊（主窗同款，2026-11-06）
            stamp_h = (stamp_ls + 8 if is_open else stamp_ls) if stamp else 0
            out.append({"is_user": is_user, "stamp": stamp, "stamp_h": stamp_h,
                        "stamp_x": stamp_x, "stamp_a": stamp_a,
                        "segs": segs, "body": body, "bx0": bx0, "bx1": bx1,
                        "pad": pad, "r": min(18, max(12, body // 3)),
                        "key": key, "more": more, "is_open": is_open,
                        "text": str(e.get("text") or ""), "sid": str(e.get("sid") or ""),
                        "at": e.get("at"), "src": src_short,
                        "list_y": y, "h": stamp_h + body + (30 if source else 10)})
            y += stamp_h + body + (30 if source else 10)
        # ① 回顾窗同样在最新气泡下面挂一行状态（用户 2026-11-06 要求：主窗 + 回顾窗）
        if st.get("expanded") is None and out:
            status = self._status_text(str(st.get("sid") or ""))
            if status:
                y += 10
                out.append({"kind": "status", "text": status, "list_y": y, "h": 28})
                y += 28
        return out, y

    def _hist_paint(self, layout) -> None:
        st = self._hist
        c = st["canvas"]
        top, bottom = st["view"]
        scroll = st["scroll"]
        c.delete("hbody")
        st["text"].reset()
        st["img_hits"] = []
        st["bubble_hits"] = []
        st["del_hits"] = []
        st["expand_hits"] = []
        st["chip"] = None
        for e in layout:
            if e.get("kind") == "status":
                sy = top + e["list_y"] - scroll
                if sy >= top and sy + e["h"] <= bottom:
                    st["text"].draw(st["w"] // 2, sy + e["h"] / 2, e["text"], anchor="center",
                                    fill="#7f8b9c", size=10, tags=("hbody",),
                                    shadow=False, adapt=False, per_char=False)
                continue
            is_open = bool(e.get("is_open"))
            # 展开态（2026-11-06 用户要求 ⑥）：时间戳 / 收回钉在视口顶，内容从它下面滚
            y = (top + e["list_y"]) if is_open else (top + e["list_y"] - scroll)
            over = max(0.0, scroll - e["list_y"]) if is_open else 0.0
            clip_top = (top + e["list_y"] + e["stamp_h"]) if is_open else top
            if not is_open and (y + e["h"] <= top or y >= bottom):
                continue
            if e["stamp"] and y >= top and y + e["stamp_h"] <= bottom:
                ax = (e["bx1"] + 6) if e["is_user"] else (e["bx0"] - 34)
                img = self._avatar_user_img if e["is_user"] else self._avatar_img
                if img is not None and y - 4 >= top:
                    try:
                        c.create_image(ax, y - 4, anchor="nw", image=img, tags=("hbody",))
                    except Exception:
                        pass
                st["text"].draw(e["stamp_x"], y, e["stamp"], anchor=e["stamp_a"],
                                fill="#a8b7c9", size=9, tags=("hbody",),
                                shadow=False, adapt=False, per_char=False)
            # 「收回」：画在当前已展开这条的时间戳右边（2026-11-06 用户要求 ⑤，回顾同理）
            if e.get("is_open"):
                sw = self.fonts.get(9).measure(e["stamp"] or "")
                if e["stamp_a"] == "nw":
                    cx0 = e["stamp_x"] + sw + 8
                else:
                    cx0 = 28.0      # 自己发的那侧同理：贴右缘放不下，放行首
                cy2 = y + max(8.0, (e["stamp_h"] - 8) / 2)
                cy0, cx1, cy1 = cy2 - 13, cx0 + 52, cy2 + 13
                if cy0 >= top and cy1 <= bottom:
                    try:
                        c.create_polygon(self._rounded_points(cx0, cy0, cx1, cy1, 12, 4),
                                         fill="#000000", outline=BTN_EDGE, smooth=True,
                                         tags=("hbody", "hchip2"))
                        c.create_text((cx0 + cx1) / 2, cy2, text="收回", anchor="center",
                                      fill="#ffffff", font=self.fonts.spec(10),
                                      tags=("hbody", "hchip2"))
                        st["chip"] = (cx0, cy0, cx1, cy1)
                    except Exception:
                        pass
            by0 = (top + e["list_y"] + e["stamp_h"] - over) if is_open else (y + e["stamp_h"])
            by1 = by0 + e["body"]
            p0, p1 = max(by0, clip_top), min(by1, bottom)
            if p1 > p0 and e["bx1"] > e["bx0"]:
                st["bubble_hits"].append(((e["bx0"], p0, e["bx1"], p1), e))
            if p1 - p0 >= 8:
                r = min(e["r"], (p1 - p0) // 2)
                c.create_polygon(
                    self._rounded_points(e["bx0"], p0, e["bx1"], p1, r, 14),
                    fill=("#63463a" if e["is_user"] else "#1a2e54"),
                    smooth=True, tags=("hbody",))
            sy = by0 + 8
            for seg in e["segs"]:
                if seg["kind"] == "text":
                    for line in seg["lines"]:
                        ly = sy
                        sy += self.fonts.get(11).metrics("linespace")
                        if ly < clip_top or ly + 20 > bottom:
                            continue
                        self._hist_draw_runs(e["bx0"] + e["pad"], ly, line)
                else:
                    iy = sy
                    sy += seg["h"]
                    if iy >= bottom or iy + seg["h"] < top:
                        continue
                    got = self._img_state(seg["src"], seg["max_w"], seg["max_h"])
                    if not got or got[1] is None:
                        # 占位**必须**带 hbody tag：不带的话 `delete("hbody")` 删不掉，
                        # 每滚一次留一行，最后满屏都是 [图片]（2026-11-06 用户截图实报）。
                        c.create_text(e["bx0"] + e["pad"], iy, text="[图片]",
                                      anchor="nw", fill="#8e9db2",
                                      font=self.fonts.spec(11), tags=("hbody",))
                        continue
                    pil, photo = got
                    if TRACE:
                        print(f"[hist] img iy={iy:.0f} segh={seg['h']:.0f} "
                              f"photo={photo.width()}x{photo.height()} "
                              f"by1={by1:.0f} bottom={bottom} scroll={scroll}", flush=True)
                    # 兜底：量的时候图还没下好、占位只有一行高，这时哪怕图已经到了
                    # 也不能按原尺寸画（会顶出气泡）；先留着占位，等重新量过再画。
                    if photo is not None and photo.height() > max(1, seg["h"] - 10) + 2:
                        if TRACE:
                            print("[hist] img height mismatch -> placeholder", flush=True)
                        c.create_text(e["bx0"] + e["pad"], iy, text="[图片]",
                                      anchor="nw", fill="#8e9db2",
                                      font=self.fonts.spec(11), tags=("hbody",))
                        continue
                    crop_top = max(0, clip_top - iy)
                    crop_bot = max(0, (iy + seg["h"] - 10) - min(bottom, by1))
                    if crop_top or crop_bot:
                        photo = self._crop_photo(seg["src"], pil, crop_top, crop_bot)
                        if photo is None:
                            continue
                    ix = e["bx0"] + max(0, (e["bx1"] - e["bx0"] - seg["w"]) // 2)
                    try:
                        c.create_image(ix, iy + crop_top, anchor="nw", image=photo,
                                       tags=("hbody",))
                        # 点击放大：和主窗同一套 rect → src
                        st["img_hits"].append(
                            ((ix, iy + crop_top, ix + photo.width(),
                              iy + crop_top + photo.height()),
                             str(seg.get("src") or "")))
                    except Exception:
                        pass
            # 收藏页：气泡下面一行「来源 <短 id>」（2026-11-06 用户要求）
            if e.get("src"):
                ly = p1 + 3
                if ly + 12 <= bottom:
                    try:
                        st["text"].draw(e["bx0"] + 2, ly, "来源 " + e["src"],
                                        anchor="nw", fill="#7f8b9c", size=9,
                                        tags=("hbody",), shadow=False, adapt=False,
                                        per_char=False)
                    except Exception:
                        pass
            # 展开三角：气泡右下角（和主窗标题栏同款），整块在视口内才画
            if e.get("more") and not e.get("is_open"):
                tri_cx = e["bx1"] - 24
                tri_cy = by1 - 17
                if tri_cy - 6 >= top and tri_cy + 7 <= bottom:
                    try:
                        c.create_polygon(tri_cx - 8, tri_cy - 6, tri_cx + 8, tri_cy - 6,
                                         tri_cx, tri_cy + 7,
                                         fill="#8a97ab", outline="",
                                         tags=("hbody", "hexpand"))
                        st["expand_hits"].append(
                            ((tri_cx - 16, tri_cy - 14, tri_cx + 16, tri_cy + 14),
                             e["key"]))
                    except Exception:
                        pass
        self._hist_scrollbar()

    def _history_show_list(self) -> None:
        self._history_window()
        self._hist_clear()
        st = self._hist
        st["page"] = "list"
        st["sid"] = None
        st["scroll"] = 0
        st["expanded"] = None       # 回列表就收起展开态
        self._hist["win"].title("回顾")
        self._hist_draw_list()
        st["win"].deiconify()
        st["win"].lift()

    def _history_show_session(self, sid: str) -> None:
        self._history_window()
        prev = (self._hist or {}).get("sid")
        self._hist_clear()
        st = self._hist
        if prev != sid:
            st["expanded"] = None       # 换会话不继承展开态
        st["page"] = "viewer"
        st["sid"] = sid
        st["scroll"] = 0
        short = ("未归属" if not sid else
                 (sid[len("session-"):][:8] if sid.startswith("session-") else sid[:8]))
        title = self._session_titles().get(sid) or ""
        self._hist["win"].title(f"回顾 · {title or short}")
        self._hist_chrome(short, title)
        c, w, h = st["canvas"], st["w"], st["h"]
        c.create_polygon(self._rounded_points(28, 90, 118, 124, 14, 5),
                         fill="#000000", outline=BTN_EDGE, smooth=True, tags=("hback",))
        c.create_text(73, 107, text="← 返回", anchor="center", fill="#ffffff",
                      font=self.fonts.spec(10), tags=("hback",))
        st["back"] = (28, 90, 118, 124)
        entries = self._history_entries(sid)
        c.create_text(w - 28, 107, text=f"{len(entries)} 条", anchor="e",
                      fill=self.H_MUTED, font=self.fonts.spec(9))
        top, bottom = 134, h - 22
        st["view"] = (top, bottom)
        layout, total = self._hist_measure(entries)
        st["layout"] = layout
        st["total"] = total
        st["max"] = max(0, total - (bottom - top))
        st["scroll"] = st["max"]          # 打开就停在最新一条
        self._hist_paint(layout)
        st["win"].deiconify()
        st["win"].lift()

    def _fav_entries_view(self) -> list:
        """收藏页要排的条目：按**消息本身的时间**排（2026-11-06 用户改口径：
        收藏行为发生的时间会让回顾变乱），「最新在上 / 最早在上」也是指消息时间。"""
        items = list(self._fav_list())
        newest = (self._hist or {}).get("fav_order", "new") != "old"
        items.sort(key=lambda e: (int(e.get("at") or 0), int(e.get("fav_at") or 0)),
                   reverse=newest)
        out = []
        for e in items:
            key = str(e.get("key") or "")
            out.append({"key": key, "_key": key,
                        "sid": str(e.get("sid") or ""),
                        "at": e.get("at"),
                        "role": str(e.get("role") or "assistant"),
                        "text": str(e.get("text") or "")})
        return out

    def _history_show_favorites(self) -> None:
        """收藏页：跨会话、按收藏时间排，每条气泡下面带来源短 id（2026-11-06 用户要求）。"""
        self._history_window()
        prev = (self._hist or {}).get("page")
        self._hist_clear()
        st = self._hist
        if prev != "fav":
            st["expanded"] = None       # 从别的页切进来不继承展开态
        st["page"] = "fav"
        st["sid"] = None
        st["scroll"] = 0
        self._hist["win"].title("回顾 · 收藏")
        self._hist_chrome("")           # 标题栏没有单个会话 id
        c, w, h = st["canvas"], st["w"], st["h"]
        c.create_polygon(self._rounded_points(28, 90, 118, 124, 14, 5),
                         fill="#000000", outline=BTN_EDGE, smooth=True, tags=("hback",))
        c.create_text(73, 107, text="← 返回", anchor="center", fill="#ffffff",
                      font=self.fonts.spec(10), tags=("hback",))
        st["back"] = (28, 90, 118, 124)
        entries = self._fav_entries_view()
        c.create_text(128, 107, text=f"{len(entries)} 条", anchor="w",
                      fill=self.H_MUTED, font=self.fonts.spec(9))
        # 排序切换：默认最新收藏在上，点一下翻成最早在上（2026-11-06 用户要求）
        label = "最新在上" if st.get("fav_order", "new") != "old" else "最早在上"
        bw = self.fonts.get(10).measure(label) + 44
        bx1 = w - 28
        bx0 = bx1 - bw
        c.create_polygon(self._rounded_points(bx0, 90, bx1, 124, 14, 5),
                         fill="#000000", outline=BTN_EDGE, smooth=True, tags=("hsort",))
        c.create_text((bx0 + bx1) / 2, 107, text=label, anchor="center",
                      fill="#ffffff", font=self.fonts.spec(10), tags=("hsort",))
        st["sort"] = (bx0, 90, bx1, 124)
        top, bottom = 134, h - 22
        st["view"] = (top, bottom)
        layout, total = self._hist_measure(entries, source=True)
        st["layout"] = layout
        st["total"] = total
        st["max"] = max(0, total - (bottom - top))
        st["scroll"] = 0
        if not entries:
            c.create_text(w // 2, (top + bottom) // 2, text="还没有收藏",
                          fill=self.H_MUTED, font=self.fonts.spec(10))
        self._hist_paint(layout)
        st["win"].deiconify()
        st["win"].lift()

    def _fav_toggle_order(self) -> None:
        st = self._hist
        if not st:
            return
        st["fav_order"] = "old" if st.get("fav_order", "new") != "old" else "new"
        self._history_show_favorites()

    # ---- 交互：点击 / 滚轮 / 拖动 ----

    def _hist_hit_row(self, x, y):
        for rect, g in self._hist.get("rows") or []:
            if rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]:
                return g
        return None

    def _hist_hover(self, e) -> None:
        st = self._hist
        if not st:
            return
        # 拖边角时光标跟着边角换形状。无边框 Tk 窗的 `<Motion>` 不一定派发（按下才准），
        # 所以 `_hist_press` 里也会设一次 —— 这里成了就是免费的预览。
        if not st.get("resize"):
            try:
                st["canvas"].config(cursor=self._cursor_for(self._hist_edge_at(e.x, e.y)))
            except Exception:
                pass
        if st["page"] != "list":
            return
        r = st.get("latest")
        over_latest = bool(r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3])
        fr = st.get("fav_hit")
        over_fav = bool(fr and fr[0] <= e.x <= fr[2] and fr[1] <= e.y <= fr[3])
        hit = None if (over_latest or over_fav) else self._hist_hit_row(e.x, e.y)
        sid = hit["sid"] if hit else None
        if (over_latest != st.get("hover_latest")
                or over_fav != st.get("hover_fav")
                or sid != st.get("hover_sid")):
            st["hover_latest"] = over_latest
            st["hover_fav"] = over_fav
            st["hover_sid"] = sid
            self._hist_redraw()

    def _hist_menu_open(self, e) -> None:
        """回顾窗右键：列表行出「查看/重命名标题/删除」，正文页图片/气泡走各自菜单。

        2026-11-06 用户要求：列表行原来的红色 ✕ 去掉，全部收进这个右键菜单。
        """
        st = getattr(self, "_hist", None)
        if not st or st.get("page") not in ("viewer", "fav", "list"):
            return
        if st.get("page") == "list":
            g = self._hist_hit_row(e.x, e.y)
            if g:
                self._show_row_menu(e.x_root, e.y_root, g)
            return
        for rect, src in st.get("img_hits") or []:
            if src and rect[0] <= e.x <= rect[2] and rect[1] <= e.y <= rect[3]:
                self._show_img_menu(e.x_root, e.y_root, src)
                return
        for rect, ent in st.get("bubble_hits") or []:
            if rect[0] <= e.x <= rect[2] and rect[1] <= e.y <= rect[3]:
                self._bubble_menu(e.x_root, e.y_root, ent,
                                  in_fav=(st.get("page") == "fav"))
                return

    def _show_row_menu(self, x_root, y_root, g) -> None:
        """回顾列表一行的右键菜单：查看 / 重命名标题 / 删除（删除项红字）。"""
        sid = str(g.get("sid") or "")
        items = [("查看", "view")]
        if sid:
            items.append(("重命名标题", "rename"))
        items.append(("删除", "del", "#e05a5a"))

        def pick(action):
            if action == "view":
                self._history_show_session(sid)
            elif action == "rename":
                self._show_rename_dialog(sid)
            elif action == "del":
                self._ask_delete(sid)

        self._menu_popup(x_root, y_root, items, pick)

    def _hist_press(self, e) -> None:
        st = self._hist
        if not st:
            return
        # 右上角 ✕
        r = st.get("close")
        if r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
            self._close_history()
            return
        # 标题栏【收回】：展开某条之后才有（2026-11-06）
        r = st.get("chip")
        if r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
            self._hist_toggle_expand(st.get("expanded"))
            return
        if st["page"] in ("viewer", "fav"):
            r = st.get("back")
            if r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                self._history_show_list()
                return
            if st["page"] == "fav":
                r = st.get("sort")
                if r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                    self._fav_toggle_order()
                    return
            # 气泡右下角三角：展开/收回这一条
            for rect, key in st.get("expand_hits") or []:
                if rect[0] <= e.x <= rect[2] and rect[1] <= e.y <= rect[3]:
                    self._hist_toggle_expand(key)
                    return
            # 图片点击放大（原尺寸）
            for rect, src in st.get("img_hits") or []:
                if src and rect[0] <= e.x <= rect[2] and rect[1] <= e.y <= rect[3]:
                    self._open_image(src)
                    return
        # 滚动条：按在滑块上拖，按在轨道上跳
        tr, th = st.get("track"), st.get("thumb")
        if tr and th and tr[0] - 4 <= e.x <= tr[2] + 4:
            top, bottom = st["view"]
            th_h = th[3] - th[1]
            span = (bottom - top) - th_h
            if th[1] <= e.y <= th[3]:
                st["sb_drag"] = e.y - th[1]
            else:
                st["sb_drag"] = th_h // 2
                self._hist_scroll_to(e.y - th_h // 2)
            return
        # 拖边角改窗口大小（2026-11-09 用户要求）。放在滚动条/列表行之后：
        # 那条判定带会被它先吃掉，右侧滚动条就点不动了。
        mode = self._hist_edge_at(e.x, e.y)
        if mode:
            self._sync_screens()          # 拖动前重读虚拟桌面（多显示器/改分辨率）
            st["resize"] = (mode, e.x_root, e.y_root,
                            st["win"].winfo_x(), st["win"].winfo_y(),
                            st["w"], st["h"])
            st["resize_target"] = None
            st["resize_at"] = 0.0
            st["drag"] = None
            st["sb_drag"] = None
            try:
                st["canvas"].config(cursor=self._cursor_for(mode))
            except Exception:
                pass
            return
        # 列表行 / 「返回最新对话」/ 底部自动清理
        if st["page"] == "list":
            r = st.get("cleanup_rect")
            if r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                self._toggle_cleanup()
                return
            r = st.get("fav_hit")
            if r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                self._history_show_favorites()
                return
            r = st.get("latest")
            if r and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                self._back_to_latest()
                return
            g = self._hist_hit_row(e.x, e.y)
            if g:
                self._history_show_session(g["sid"])
                return
        # 标题栏拖动
        if e.y < 76:
            st["drag"] = (e.x_root - st["win"].winfo_x(),
                          e.y_root - st["win"].winfo_y())
            return

    def _hist_motion(self, e) -> None:
        st = self._hist
        if not st:
            return
        if st.get("resize"):
            mode, sx, sy, x0, y0, w0, h0 = st["resize"]
            dx, dy = e.x_root - sx, e.y_root - sy
            # 缩放边界 = 虚拟桌面（第二块屏在主屏左边时坐标本来是负的）
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            nw, nh, nx, ny = w0, h0, x0, y0
            if "e" in mode:
                nw = max(self.HIST_MIN_W,
                         min(max(self.HIST_MIN_W, vx + vw - x0), w0 + dx))
            if "w" in mode:
                nw = max(self.HIST_MIN_W,
                         min(max(self.HIST_MIN_W, x0 + w0 - vx), w0 - dx))
                nx = x0 + w0 - nw
            if "s" in mode:
                nh = max(self.HIST_MIN_H,
                         min(max(self.HIST_MIN_H, vy + vh - y0), h0 + dy))
            if "n" in mode:
                nh = max(self.HIST_MIN_H,
                         min(max(self.HIST_MIN_H, y0 + h0 - vy), h0 - dy))
                ny = y0 + h0 - nh
            nx = max(vx, min(nx, max(vx, vx + vw - nw)))
            ny = max(vy, min(ny, max(vy, vy + vh - nh)))
            # 合并尺寸变更：鼠标事件 ~100Hz，而改一次尺寸 + 重画底板本身要几毫秒。
            # 每次都发 `geometry` 只会让队列越堆越长（主窗那边 2026-11-05 真踩过），
            # 这里 50ms 合并一次，永远应用最新目标，松手补最后一帧。
            st["resize_target"] = (nw, nh, nx, ny)
            now = time.time()
            if now - st.get("resize_at", 0.0) >= 0.05:
                st["resize_at"] = now
                self._hist_apply_size(nw, nh, nx, ny)
            return
        if st.get("drag"):
            dx, dy = st["drag"]
            st["win"].geometry(f"+{e.x_root - dx}+{e.y_root - dy}")
            return
        if st.get("sb_drag") is not None and st.get("thumb"):
            self._hist_scroll_to(e.y - st["sb_drag"])

    def _hist_release(self, _e=None) -> None:
        st = self._hist
        if not st:
            return
        st["drag"] = None
        st["sb_drag"] = None
        if st.get("resize"):
            st["resize"] = None
            try:
                st["canvas"].config(cursor="")
            except Exception:
                pass
            self._hist_finish_resize()

    def _hist_scroll_to(self, thumb_y: float) -> None:
        st = self._hist
        tr, th = st.get("track"), st.get("thumb")
        if not tr or not th:
            return
        top, bottom = st["view"]
        th_h = th[3] - th[1]
        span = (bottom - top) - th_h
        if span <= 0:
            return
        ratio = max(0.0, min(1.0, (thumb_y - top) / span))
        st["scroll"] = int(ratio * st["max"])
        self._hist_redraw()

    def _hist_wheel(self, e) -> None:
        st = self._hist
        if not st or st["max"] <= 0:
            return
        step = 70 if e.delta > 0 else -70
        st["scroll"] = max(0, min(st["max"], st["scroll"] - step))
        self._hist_redraw()

    @staticmethod
    def _clock(ms) -> str:
        try:
            return time.strftime("%m-%d %H:%M", time.localtime(float(ms) / 1000.0))
        except (TypeError, ValueError, OSError):
            return ""

    def _hist_relayout_keep_scroll(self) -> None:
        """图片下载完之后重排回顾正文；保持"离底部多远"不变（否则会跳回顶部/底部）。"""
        st = self._hist
        if not st or st.get("page") not in ("viewer", "fav"):
            return
        if st.get("resize"):
            # 拖边角期间不改布局；松手时 `_hist_finish_resize()` 会整体重排一次
            return
        from_bottom = max(0, (st.get("max") or 0) - (st.get("scroll") or 0))
        if st.get("page") == "fav":
            self._history_show_favorites()
        else:
            self._history_show_session(st.get("sid") or "")
        st = self._hist
        if st:
            st["scroll"] = max(0, (st.get("max") or 0) - from_bottom)
            self._hist_paint(st.get("layout") or [])

    def _hist_toggle_expand(self, key) -> None:
        """展开/收回一条回顾消息（2026-11-06 用户要求）。

        「收回」画在那条的时间戳右边（见 `_hist_paint`），所以**展开时要把这条
        滚到视口顶**，否则它撑高之后时间戳整行已经在视口上方，收回按钮就看不见了。
        收回时保持离底部距离，不跳回顶部。
        """
        st = self._hist
        if not st or st.get("page") not in ("viewer", "fav"):
            return
        opening = str(st.get("expanded") or "") != str(key)
        if key is None or not opening:
            st["expanded"] = None
            self._hist_relayout_keep_scroll()
            return
        st["expanded"] = str(key)
        self._hist_relayout_keep_scroll()
        st = self._hist
        if st:
            # 展开后从这条的顶部看起（时间戳已钉住，内容从下面滚）
            st["scroll"] = 0
            self._hist_paint(st.get("layout") or [])

    def _hist_redraw(self) -> None:
        st = self._hist
        if not st:
            return
        # 拖边角期间一律不重排：每拍按新宽度重新折行就是掉帧（见 `_hist_live_frame`）
        if st.get("resize"):
            return
        if st["page"] == "list":
            st["canvas"].delete("all")
            st["text"].reset()
            st["rows"] = []
            self._hist_draw_list()
        elif st["page"] in ("viewer", "fav"):
            self._hist_paint(st.get("layout") or [])

    # ---- 「关联变更」：标题栏上方那一行 ----

    BAR_H = 60          # 打开时窗口向上长高的高度（底边不动）

    def _ensure_bind_entry(self) -> None:
        """会话 ID 输入用的 Entry：和底部输入框一样只当 IME/键盘用，字画在 Canvas 上。"""
        if self._bind_entry is not None:
            return
        self._bind_entry = tk.Entry(self.root, bg=KEY, fg=KEY, insertbackground=KEY,
                                    relief="flat", bd=0, font=self.fonts.spec(11),
                                    insertwidth=0, highlightthickness=0)
        self._bind_entry.bind("<KeyRelease>", self._on_bind_key)
        self._bind_entry.bind("<Return>", self._confirm_bind)
        self._bind_entry.bind("<Escape>", lambda _e: self._hide_bind_bar())

    def _draw_bind_bar(self) -> None:
        """标题栏上方那行：输入栏 + 【确定变更】（样式仿下方输入栏与发送按钮）。"""
        c = self.canvas
        w = self._geo.width
        # 底部那颗「发送」是 98 宽装两个字；这里四个字要更宽，否则右边会被裁掉
        x0, y0, x1, y1 = 36, 4, w - 174, 58
        sx0, sy0, sx1, sy1 = w - 162, 4, w - 36, 58
        try:
            c.create_polygon(self._rounded_points(x0, y0, x1, y1, 27, 12),
                             fill="#060708", outline="#ffffff", smooth=True,
                             tags=("bindbar", "chrome"))
            c.create_polygon(self._rounded_points(sx0, sy0, sx1, sy1, 27, 12),
                             fill="#000000", outline="#ffffff", smooth=True,
                             tags=("bindbar", "chrome"))
            self.text.draw((sx0 + sx1) // 2, (sy0 + sy1) // 2, "确定变更", anchor="center",
                           fill="#ffffff", size=11, bold=True, tags=("bindbar", "chrome"))
        except Exception:
            return
        self._bind_input_rect = (x0, y0, x1, y1)
        self._bind_ok_rect = (sx0, sy0, sx1, sy1)
        self._ensure_bind_entry()
        self._bind_entry_item = c.create_window(
            x0 + 82, y0 + 27, window=self._bind_entry, anchor="w",
            width=2, height=2, tags=("bindbar", "chrome"))
        self._render_bind_input()

    def _render_bind_input(self) -> None:
        # `_pad` 为 0 说明输入行已经收起：此时还可能有排队的 KeyRelease 打到
        # `_on_bind_key`，按旧 rect 画字就会在标题栏位置留一条"游离的短 ID"
        # （2026-11-06 实报：收起后截图里标题左边多出 `4f1ebdde`）。
        if self._bind_entry is None or not self._pad:
            return
        c = self.canvas
        c.delete("bindtext")
        x0, y0, _x1, _y1 = self._bind_input_rect or (36, 4, 0, 0)
        err = getattr(self, "_bind_err", "")
        try:
            text = self._bind_entry.get().strip()
        except Exception:
            text = ""
        # 输入栏里的字同样要按框宽截断，否则窄窗会压到【确定变更】上
        font = self.fonts.get(11)
        room = max(20, (self._bind_input_rect[2] if self._bind_input_rect else _x1)
                   - (x0 + 18) - 12)
        if err:
            self.text.draw(x0 + 18, y0 + 27, self._fit_text(font, err, room),
                           anchor="w", fill="#ff9b9b",
                           size=11, tags=("bindtext", "chrome"))
        elif not text:
            ph = "在这里输入要关联的会话 Session ID，长短ID不限"
            if font.measure(ph) > room:
                ph = "输入 Session ID"
            self.text.draw(x0 + 18, y0 + 27, self._fit_text(font, ph, room),
                           anchor="w", fill="#8e9db2", size=11,
                           tags=("bindtext", "chrome"))
        else:
            # 光标在末尾：长 ID 从左边砍，保证看到的是刚输入的那截
            shown = text
            while shown and font.measure(shown) > room:
                shown = shown[1:]
            self.text.draw(x0 + 18, y0 + 27, shown, anchor="w", fill="#eef6ff",
                           size=11, tags=("bindtext", "chrome"))
        self.text.refresh()

    def _on_bind_key(self, _e=None):
        self._bind_err = ""
        self._render_bind_input()
        return None

    def _toggle_bind_bar(self) -> None:
        if self._pad:
            self._hide_bind_bar()
        else:
            self._show_bind_bar()

    def _place_now(self, w: int | None = None, h: int | None = None) -> None:
        """按 `self._x/_y`（物理像素）摆位置，可选同时改尺寸。

        **尺寸和位置都走 SetWindowPos**：这台机器上 `root.geometry("909x1100")`
        （不带位置的纯尺寸请求）会被 Tk 忽略 —— 实测 `winfo_height()` 还是 1040
        （2026-11-05 实报"点关联变更窗移动/错位"）。带位置的 geometry 又会按另一种
        DPI 解释把窗挪走。所以两件事都不交给 Tk，交给 Win32。
        """
        try:
            hwnd = self._hwnd_root()
            if not hwnd:
                return
            user32 = ctypes.windll.user32
            flags = 0x0004 | 0x0010          # SWP_NOZORDER | SWP_NOACTIVATE
            sw = int(w or 0)
            sh = int(h or 0)
            if not sw or not sh:
                flags |= 0x0001              # SWP_NOSIZE
            user32.SetWindowPos(wintypes.HWND(hwnd), None, int(self._x), int(self._y),
                                sw, sh, flags)
        except Exception as exc:
            print("place failed:", repr(exc), flush=True)

    def _show_bind_bar(self) -> None:
        """窗口向上长高 BAR_H，新行插在标题栏上方；底边和消息区内容位置都不动。

        一次 SetWindowPos 同时改位置和尺寸：左上角上移 pad、高度 +pad，
        所以下沿原地不动，不会有"先长高再上移"的中间帧。
        """
        if self._pad:
            return
        if self._collapsed:
            # 收起态点【关联变更】：先把窗展开回用户态高度。否则 `_base_h` 记的是
            # 收起条 / 新消息气泡的高度，关掉输入行时窗会缩回那个高度（2026-11-08
            # 实测：带 998 的气泡开输入行 → 关掉后窗只剩 998）；之后只要有一笔记账
            # 落在「窗还没被展开高度盖住」的瞬间，过渡高度就会被当成用户态高度写进
            # watch-window.json。
            self.toggle_collapse()
            if self._collapsed:      # 展开失败就别开输入行
                return
        self._sync_pos()          # 用真实坐标，不用可能过期的缓存
        w, h = self._geo.width, self._geo.height
        self._base_h = h
        self._pad = self.BAR_H
        self._y -= self._pad
        self._bind_err = ""
        try:
            # 1) 先在**旧尺寸**的画布上把新一帧整个画完：内容超出窗口的部分被裁掉，
            #    用户看不见。这样就不会出现"长出来一条黑的、等它加载"的中间态。
            self._defer_canvas_size = True
            self._rebuild(w, h + self._pad)
            self._defer_canvas_size = False
            # 2) 一次 SetWindowPos：上移 pad + 长高 pad，已经画好的内容整体露出来
            self._place_now(w, h + self._pad)
            self.canvas.config(width=w, height=h + self._pad)
            # **把 canvas 真的撑大再回事件循环**：`config()` 只是改请求尺寸，
            # 真正的 pack 重排 + 重绘要等 idle。这一等就是一个 60px 的洞 ——
            # 窗口已经 1100、canvas 还是 1040，多出来的那条是 toplevel 底色
            # （-transparentcolor 的 KEY）→ 透出桌面。2026-11-06 逐帧抓到了
            # 实锤帧：底 60px 是桌面内容。update_idletasks() 强制在这里跑完
            # 重排/重绘，出事件循环时底图已经是 1100 高的那张。
            self.root.update_idletasks()
            if TRACE:
                print(f"[trace] open w={w} h={h + self._pad} "
                      f"root={self.root.winfo_width()}x{self.root.winfo_height()} "
                      f"canvas={self.canvas.winfo_width()}x{self.canvas.winfo_height()} "
                      f"img={getattr(self._last_frame, 'size', None)}", flush=True)
            self._ensure_bind_entry()
            self._bind_entry.delete(0, "end")
            # 预填"最新未绑定会话"：开新对话时不用再回来翻一遍 ID
            try:
                _pre = self._latest_unbound_session()
            except Exception as _exc:
                _pre = ""
                print("prefill failed:", repr(_exc), flush=True)
            if _pre:
                self._bind_entry.insert(0, _pre)
                self._render_bind_input()
            self._bind_entry.focus_force()
            print(f"bind open: want={w}x{h + self._pad} got={self.root.winfo_width()}x"
                  f"{self.root.winfo_height()} @{self.root.winfo_x()},{self.root.winfo_y()}",
                  flush=True)
        except Exception as exc:
            self._defer_canvas_size = False
            print("bind bar open failed:", repr(exc), flush=True)

    def _hide_bind_bar(self, save: bool = True) -> None:
        if not self._pad:
            return
        self._sync_pos()
        w = self._geo.width
        h = max(MIN_H, self._base_h or (self._geo.height - self._pad))
        self._pad = 0
        try:
            # 同一套思路反过来：先在旧（大）窗口上把收起态画完，再一次性缩回去
            self._defer_canvas_size = True
            self._rebuild(w, h)
            self._defer_canvas_size = False
            self._y += self.BAR_H
            self._place_now(w, h)
            self.canvas.config(width=w, height=h)
            self.root.update_idletasks()
            if TRACE:
                print(f"[trace] close w={w} h={h} "
                      f"root={self.root.winfo_width()}x{self.root.winfo_height()} "
                      f"canvas={self.canvas.winfo_width()}x{self.canvas.winfo_height()} "
                      f"img={getattr(self._last_frame, 'size', None)}", flush=True)
            self._bind_err = ""
        except Exception as exc:
            self._defer_canvas_size = False
            print("bind bar close failed:", repr(exc), flush=True)
        if save:
            self._save_geometry()

    def _focus_bind_input(self, _e=None) -> None:
        try:
            self._bind_entry.focus_force()
            self._bind_entry.icursor("end")
        except Exception:
            pass

    def _sessions_root(self) -> Path:
        return Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "sessions"

    @staticmethod
    def _session_header(sdir: Path) -> dict:
        """只解压会话日志的第一行（header）——拿 `delegationDepth` / `createdAt`。

        整份 6MB 全解压太贵；zstd 流式读前几 KB 就够第一行了。
        """
        f = sdir / "session.v4.jsonl.zstd"
        try:
            import zstandard
            with open(f, "rb") as fh:
                reader = zstandard.ZstdDecompressor().stream_reader(fh)
                try:
                    head = reader.read(4096)
                finally:
                    try:
                        reader.close()
                    except Exception:
                        pass
            line = head.split(b"\n", 1)[0]
            obj = json.loads(line.decode("utf-8", "replace"))
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}

    def _latest_unbound_session(self) -> str:
        """「最新未绑定会话」的短 ID —— 给【关联变更】输入框预填。

        场景（用户 2026-11-06）：开了一个新对话，要用【关联变更】把窗绑过去。
        判据不是"最近写过盘"（当前会话自己一直在写，永远是它最新），而是
        **header 的 `createdAt` 比当前绑定的会话更晚** —— 也就是"之后才建的会话"。
        子代理会话（`delegationDepth > 0`）不算，否则会把窗绑到某个子会话上。
        找不到（或 header 读不了）就返回空串，保持手输。
        """
        cur = getattr(self, "_bound_full", "")
        root = self._sessions_root()
        cur_dir = None
        items = []
        try:
            profs = [p for p in root.iterdir() if p.is_dir()]
        except Exception:
            return ""
        for prof in profs:
            try:
                dirs = [d for d in prof.iterdir() if d.is_dir()
                        and d.name.startswith("session-")]
            except Exception:
                continue
            for sdir in dirs:
                if sdir.name == cur:
                    cur_dir = sdir
                    continue
                try:
                    mt = (sdir / "session.v4.jsonl.zstd").stat().st_mtime
                except OSError:
                    try:
                        mt = sdir.stat().st_mtime
                    except OSError:
                        continue
                items.append((mt, sdir))
        if cur_dir is not None:
            # 同一个工作区（cwd）优先：别的 workspace 的对话不该被预填进来
            items = [it for it in items if it[1].parent == cur_dir.parent]
        items.sort(key=lambda it: it[0], reverse=True)
        cur_created = int(self._session_header(cur_dir).get("createdAt") or 0) if cur_dir else 0
        best_ca, best_sid = 0, ""
        for _mt, sdir in items[:12]:
            h = self._session_header(sdir)
            if int(h.get("delegationDepth") or 0) != 0:
                continue
            ca = int(h.get("createdAt") or 0)
            if ca and ca > cur_created and ca > best_ca:
                best_ca, best_sid = ca, sdir.name
        if not best_sid:
            return ""
        return (best_sid[len("session-"):][:8]
                if best_sid.startswith("session-") else best_sid[:8])

    def _resolve_session(self, text):
        """长短 ID 都认：前缀在 `~/.dsh/sessions/*/session-<id>` 里唯一命中才算数。"""
        raw = str(text or "").strip()
        if not raw:
            return None, "先填一个会话 ID"
        want = raw if raw.startswith("session-") else f"session-{raw}"
        hits = set()
        try:
            for ws in self._sessions_root().iterdir():
                if not ws.is_dir():
                    continue
                for d in ws.iterdir():
                    if d.is_dir() and d.name.startswith(want):
                        hits.add(d.name)
        except Exception:
            pass
        if len(hits) == 1:
            return hits.pop(), None
        if not hits:
            return None, f"没找到会话 {raw}"
        return None, f"匹配到 {len(hits)} 个，再多输几位"

    def _write_bound_session(self, sid: str) -> None:
        base = os.path.dirname(os.environ.get("DSH_VIDEO_CACHE_DIR", "."))
        path = Path(base, "see-now.json")
        try:
            cfg = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        cfg["session"] = sid
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def _confirm_bind(self, _e=None):
        """只有这一下才动状态：解析 → 写 see-now.json → 收起 → 标题栏跟着刷新。"""
        text = ""
        try:
            text = self._bind_entry.get() if self._bind_entry else ""
        except Exception:
            pass
        sid, err = self._resolve_session(text)
        if err:
            self._bind_err = err
            self._render_bind_input()
            return "break"
        try:
            self._write_bound_session(sid)
        except Exception as exc:
            self._bind_err = f"写不进 see-now.json：{exc}"
            self._render_bind_input()
            return "break"
        old = getattr(self, "_bound_full", "")
        self._bound_full = sid
        self._bound_sid = sid[len("session-"):][:8] if sid.startswith("session-") else sid[:8]
        # 上一段对话从主窗消失、按短 ID 归到【历史记录】：它的消息本来就带着自己的
        # `sid`，这里只要把主窗切到新会话，再补一笔"关联时间"。
        self._touch_group(sid)
        if sid and old != sid:
            self._announce_bind(sid)
        self.feed.set_sid(sid)
        self._hide_bind_bar()
        self._refresh_header()
        return "break"

    def _announce_bind(self, sid: str) -> None:
        """绑定变更后落两条居中系统提示（2026-11-06 用户要求）。

        第一条写「关联会话 <短id> 已成功」；第二条同步 DSH 里这个会话的自定义
        标题（`session/title` 记录）。标题读不到时退回「当前会话 <短id>」。
        """
        short = sid[len("session-"):][:8] if sid.startswith("session-") else sid[:8]
        try:
            append_notice(f"关联会话 {short} 已成功", sid)
            title = session_title(sid)
            append_notice(title or f"当前会话 {short}", sid)
        except Exception as exc:
            print("bind announce failed:", repr(exc), flush=True)

    def _sb_paint(self, canvas, x, top, bottom, total, view, offset, max_off,
                  tags) -> tuple | None:
        """统一的滚动条：细轨 + 圆头滑块（主窗与历史弹窗同一套，2026-11-06 用户要求）。

        返回 (轨道 rect, 滑块 rect) 或 None，历史弹窗拿它做点击/拖动命中；
        主窗只需要画，不管返回值。
        """
        if total <= view or max_off <= 0 or bottom - top < 40:
            return None
        w = 6
        half = w / 2.0
        canvas.create_polygon(
            self._rounded_points(x - half, top, x + half, bottom, half, 6),
            fill="#1b2839", outline="", smooth=True, tags=tags)
        thumb_h = max(30.0, (bottom - top) * (view / float(total)))
        span = (bottom - top) - thumb_h
        t = max(0.0, min(1.0, offset / float(max_off)))
        y0 = top + span * t
        canvas.create_polygon(
            self._rounded_points(x - half, y0, x + half, y0 + thumb_h, half, 6),
            fill="#8d95a4", outline="", smooth=True, tags=tags)
        return ((x - half, top, x + half, bottom),
                (x - half, y0, x + half, y0 + thumb_h))

    def _draw_scrollbar(self) -> None:
        """滚动条放在主体玻璃靠右内侧；导轨+滑块的样子与历史弹窗一致。"""
        c = self.canvas
        c.delete("sbar")
        if self.FEED_LIST:
            # 连续滑块：按内容总高 / 视口高算，不再按"第几条"
            if self._expanded is not None:
                return          # 展开态滚动是条内翻页，列表滚动条不适用
            total = getattr(self, "_feed_total", 0)
            view_top, view_bottom = getattr(self, "_view", (0, 0))
            view_h = max(1, view_bottom - view_top)
            if self._sb_paint(c, self._geo.width - 18, view_top + 8, view_bottom - 8,
                              total, view_h, getattr(self, "_scroll_px", 0),
                              getattr(self, "_scroll_max", 0), ("sbar",)):
                c.tag_raise("sbar")
            return
        total = len(self.feed.messages)
        visible = MESSAGE_SLOTS
        body = self._geo.slabs[1]
        view_h = max(1, body[3] - body[1] - 16)
        max_off = max(1, total - visible)
        # 旧槽位布局：offset 越大越往回看，滑块方向要反过来
        if self._sb_paint(c, self._geo.width - 18, body[1] + 8, body[3] - 8,
                          total, visible, max_off - max(0, min(max_off, self.feed.offset)),
                          max_off, ("sbar",)):
            c.tag_raise("sbar")

    def _refresh_feed(self) -> None:
        """聊天流变了就重排；Entry 的草稿和焦点要保住（它在 _layout 里复用）。"""
        if not hasattr(self, "canvas"):
            return
        self._layout()
        if self._last_frame is not None:
            self._adapt_now(self._last_frame)

    def _adapt_now(self, frame) -> None:
        self._aux_at = 0.0
        self.text.adapt(frame)
        self._adapt_bar(frame)

    def _adapt_bar(self, frame) -> None:
        """最上面细条随背景切换深浅（同样要滞回，理由见 TextLayer.adapt）。"""
        if frame is None or self._bar is None:
            return
        now = time.time()
        if now - self._aux_at < 0.25:
            return
        self._aux_at = now
        mid = self._geo.width // 2
        half = max(50, self._bar_len // 2)
        try:
            arr = np.asarray(frame.convert("L"))
        except Exception:
            return
        patch = arr[max(0, BAR_Y - 6):BAR_Y + 12, max(0, mid - half):mid + half]
        if patch.size == 0:
            return
        p50 = float(np.median(patch)) / 255.0
        cur = self._bar_color
        if cur == "#4e6278":
            fill = "#b8cbe0" if p50 < 0.36 else cur      # 已很深：要够暗才翻浅
        else:
            fill = "#4e6278" if p50 > 0.60 else cur
        if fill != cur:
            self._bar_color = fill
            try:
                self.canvas.itemconfigure(self._bar, fill=fill)
            except Exception:
                pass

    # ---- 预览 / 重建 ----

    @staticmethod
    def _fit_text(font, text: str, max_w: float) -> str:
        """单行截断：放不下就按字砍、结尾补「…」。

        窄窗（MIN_W=480）时标题栏/输入栏里的字会直接画到框外（2026-11-06 实报），
        所以凡是不换行的地方都得先量一遍再决定画多少。逐字累加，避免 O(n²) 次
        Tcl measure —— 这些字段每帧都可能重画。
        """
        if max_w <= 0:
            return ""
        try:
            if font.measure(text) <= max_w:
                return text
            ell = "…"
            room = max_w - font.measure(ell)
            if room <= 0:
                return ""
            out, used = [], 0.0
            for ch in text:
                cw = font.measure(ch)
                if used + cw > room:
                    break
                out.append(ch)
                used += cw
            return ("".join(out) + ell) if out else ell
        except Exception:
            return text

    @staticmethod
    def _rounded_points(x0, y0, x1, y1, r, steps: int = 7):
        """圆角矩形的多边形近似（Tk canvas 没有圆角矩形图元）。"""
        import math
        pts = []
        for cx, cy, a0 in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0),
                           (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
            for i in range(steps + 1):
                a = math.radians(a0 + 90 * i / steps)
                pts.extend((cx + r * math.cos(a), cy + r * math.sin(a)))
        return pts

    def _preview_resize(self, w: int, h: int) -> None:
        """拖手期间只画一块**纯色占位面板**，不生成位图、不重排文字。

        为什么不是"缩放上一帧"（2026-11-05 实报"20fps 但有 1 秒迟滞"）：
        每个 motion 事件都要 `ImageTk.PhotoImage` 生成一张新位图 + 清空并重建 canvas，
        主线程被这些活占满，`root.geometry()` 的更新排在后面 —— 表现就是帧率看着还行、
        但窗口追不上手。占位面板只有一次画多边形，毫秒级，几何更新立刻就能落地。
        松手的 `_rebuild()` 再一次性重建玻璃、文字和抓屏线程。
        """
        if w < MIN_W or h < MIN_H:
            return
        if w == getattr(self, "_preview_size", (0, 0))[0] and h == getattr(self, "_preview_size", (0, 0))[1]:
            return
        self._preview_size = (w, h)
        try:
            self.canvas.config(width=w, height=h)
            frame = None
            if self._plain:
                # 只算 blocks 的几何（shapes_for 是纯算术），不建遮罩/折射图 ——
                # `Geometry.for_size` 在这台机上 480 宽就要 27ms、900 宽 77ms，
                # 预览按 40ms 节流跑，它一进场就是"掉帧"的主因（2026-11-06 实测）。
                frame = self._plain_frame(
                    _PanelGeo(w, h, shapes_for(w, h, getattr(self, "_pad", 0))),
                    mic=False)
            self.canvas.delete("all")
            if frame is not None:
                self._last_frame = frame
                self._img = ImageTk.PhotoImage(frame, master=self.canvas)
                self._bg = self.canvas.create_image(0, 0, anchor="nw", image=self._img)
            else:
                self._bg = self.canvas.create_image(0, 0, anchor="nw")
                self.canvas.create_polygon(
                    self._rounded_points(1, 1, w - 1, h - 1, 26),
                    fill="#1b2734", outline="#2b3a4a", smooth=True)
        except Exception:
            # 预览画不出来只会"空白一下"，不能让缩放死掉
            pass

    # 试验开关：气泡底板改由 canvas 多边形绘制（判断毛边能不能接受）
    PLATE_CANVAS = True

    # 配色：**预先混好的不透明色**（等价于"30% / 70% 叠在中性深色桌面上"）。
    # 等透明的方案定下来，再把这里换成"抓屏背景 + 真 alpha"的版本。
    PLAIN_BG = (20, 22, 26)           # 本体：黑 30% 预混
    PLAIN_TITLE = (16, 18, 21)        # 标题条
    PLAIN_DSH = (24, 39, 67)          # DSH 的气泡：深蓝 70% 预混
    PLAIN_USER = (75, 56, 41)         # 我发的气泡：咖啡色 70% 预混
    PLAIN_INPUT = (6, 7, 8)           # 输入栏：黑 70% 预混
    PLAIN_SEND = (0, 0, 0)            # 发送按钮底：黑 100%
    PLAIN_LINE = (255, 255, 255)      # 白色描边 / 麦克风

    def _backdrop(self, w: int, h: int):
        """窗口背后那块桌面（只抓一次，按位置+尺寸缓存）。

        拖动期间窗口在动，但底色只是一层 30% 的黑，底下那张"冻结"的背景看不出差别；
        松手后 `_sync_pos` 改了位置，key 变了就会重抓。
        """
        try:
            x, y = self.root.winfo_x(), self.root.winfo_y()
        except Exception:
            x, y = 0, 0
        key = (x, y, w, h)
        if getattr(self, "_backdrop_key", None) == key and getattr(self, "_backdrop_img", None) is not None:
            return self._backdrop_img
        try:
            import mss
            with mss.mss() as sct:
                shot = sct.grab({"left": x, "top": y, "width": w, "height": h})
            img = Image.frombytes("RGB", shot.size, shot.rgb).resize((w, h))
        except Exception:
            img = Image.new("RGB", (w, h), (32, 36, 42))
        self._backdrop_img, self._backdrop_key = img, key
        return img

    def _plain_frame(self, geo=None, mic: bool = True):
        """纯色面板：不抓屏、不影响截图。

        2026-11-05 用户要求"先把 WDA 关了做得差不多再说透明" —— 所以这里**完全不抓屏**，
        背景是固定的深灰；你要的 30% / 70% 不透明度按比例预先混好写死在这几个常量里
        （等价于"叠在一张中性深色桌面上"）。等透明那件事定了再换回抓屏版本。

        `geo` 可以传一个只有 width/height/shapes 的轻量对象（缩放预览用）：
        拖手期间每次都要一张新面板，走 `Geometry.for_size` 光建遮罩/折射图就要
        27–77ms（2026-11-06 实测 bench），预览根本不需要那些东西。
        """
        geo = geo or self._geo
        w, h = int(geo.width), int(geo.height)
        if w <= 0 or h <= 0:
            return None
        img = Image.new("RGB", (w, h), KEY)
        d = ImageDraw.Draw(img)
        pad = getattr(self, "_pad", 0)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=26, fill=self.PLAIN_BG[:3])
        # 标题条跟着 pad 下移：「关联变更」输入行占掉最上面那条
        d.rounded_rectangle((0, pad, w - 1, pad + 46), radius=26, fill=self.PLAIN_TITLE[:3])
        roles = getattr(self, "_slot_roles", [])
        for i, (x0, y0, x1, y1, r) in enumerate(geo.shapes):
            if x1 <= x0 or y1 <= y0:
                continue
            if i >= MESSAGE_SLOTS:
                fill = self.PLAIN_SEND if i == MESSAGE_SLOTS + 1 else self.PLAIN_INPUT
                d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=fill[:3],
                                    outline=self.PLAIN_LINE[:3], width=1)
                continue
            # 列表布局的气泡由 canvas 自己画多边形，这里的槽只是四槽时代留下的板子。
            # 纯色模式下画出来就是消息区顶部那条 2px 的深蓝细线（槽高被压到几个像素
            # 时尤其明显，2026-11-05 实报"顶上多一条线"）。旧四槽路径还要靠它当底色。
            if self.FEED_LIST:
                continue
            if self.PLATE_CANVAS:
                continue          # 底板交给 canvas 画（毛边试验）
            is_user = bool(roles[i]) if i < len(roles) else False
            color = self.PLAIN_USER if is_user else self.PLAIN_DSH
            d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=color[:3])
        try:
            final = img
            if mic:
                # 麦克风：底子是深色，paste_mic 会自动选浅色（近白）那版
                final = paste_mic(geo, final)
        except Exception as exc:
            if not getattr(self, "_mic_err_logged", False):
                self._mic_err_logged = True
                print("mic paste failed:", repr(exc), flush=True)
            final = img
        return final

    def _rebuild(self, w: int, h: int) -> None:
        """松手后按最终尺寸重建（含遮罩/折射图）。"""
        t0 = time.perf_counter()
        self._pause.set()
        with self._geo_lock:
            self._set_geometry(Geometry.for_size(w, h, pad=getattr(self, '_pad', 0)))
        t1 = time.perf_counter()
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
        if self._plain:
            # 先把最终尺寸的面板画好再排文字，避免松手瞬间露出上一帧的旧尺寸
            try:
                self._last_frame = self._plain_frame()
                self._frame_done = (self._geo.width, self._geo.height, tuple(self._geo.shapes))
            except Exception:
                pass
        t2 = time.perf_counter()
        self._layout(seed=True)
        t3 = time.perf_counter()
        self._pause.clear()
        self._rebuild_at = time.perf_counter()
        if TRACE:
            print(f"[trace] rebuild {w}x{h} geo={(t1 - t0) * 1000:.1f}ms "
                  f"frame={(t2 - t1) * 1000:.1f}ms layout={(t3 - t2) * 1000:.1f}ms",
                  flush=True)

    # ---- 截屏 / 心跳 ----

    def _snapshot_mode(self) -> None:
        """只给文档截图：停抓取、关 WDA，保留最后一帧（不改变正常路径）。"""
        self._snapshot_done = True
        self._pause.set()
        if self._excluded:
            self._set_exclude(False)

    def _claim_pid(self) -> None:
        """把当前进程号写进插件认的那份 pid 文件。

        插件侧 `windowAlive()` 先看 pid 文件里的进程还在不在，再看心跳。窗口不是由
        插件 `openWindow()` 拉起时（手动起、调试起），这份文件不会更新 → 插件一直
        以为窗死了 → relay 不投递，"窗里打的字没人理"（2026-11-05 实报）。
        """
        base = os.path.dirname(os.environ.get("DSH_VIDEO_CACHE_DIR", "."))
        try:
            with open(os.path.join(base, "see-now-window.pid"), "w",
                      encoding="utf-8") as f:
                f.write(str(os.getpid()))
        except Exception:
            pass

    def _beat(self) -> None:
        """写心跳（每秒最多一次）。插件侧 `windowAlive()` 读它的 mtime。"""
        now = time.time()
        if now - getattr(self, "_beat_at", 0.0) < HEARTBEAT_EVERY:
            return
        self._beat_at = now
        try:
            HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
            HEARTBEAT.write_bytes(b"")
        except Exception:
            pass

    # ---- 主循环 ----

    def _tick(self) -> None:
        self._beat()
        # 自动清理（30 天 / 测试期 1 天）：内部 60 秒节流，没开就什么都不做
        self._maybe_cleanup()
        # 绑定会话可以热改（插件每 2 秒重读 see-now.json），标题栏这几字也要跟上，
        # 否则窗里显示的还是上一个会话的短 id —— 会让人以为"改了没用"。
        self._poll_bound_session()
        if SNAPSHOT and self._snapshot_done:
            self._pause.set()
            if self._excluded:
                self._set_exclude(False)
            self.root.after(100, self._tick)
            return
        if PREVIEW:
            self._pause.set()
            if self._excluded:
                self._set_exclude(False)
            self.root.after(100, self._tick)
            return
        # 收起态的标题条是半透明的：背景要跟着桌面刷新（没变时内部会跳过重绘）
        if self._collapsed:
            if self._drag:
                # 拖动中：位置每帧靠挪图（_move_collapsed_backdrop），只在后台抓到新垫图时换图
                self._apply_drag_cache()
            else:
                self._refresh_collapsed()
            self.root.after(INTERVAL_MS, self._tick)
            return
        # 缩放/拖动拖拽期间由预览负责画面：这里**不能**清 `_pause`，
        # 否则抓屏线程会立刻恢复、旧帧把预览盖掉（拖动时也白烧一次全窗合成）
        if self._resize or self._drag:
            self.root.after(INTERVAL_MS, self._tick)
            return
        if not self._excluded and not self._cappable and not self._solid:
            self._set_exclude(True)
        self._pause.clear()

        try:
            out = self._q.get_nowait()
        except queue.Empty:
            out = None
        # **尺寸对不上的帧一律丢弃**：开/关「关联变更」输入行时窗口会在一帧之内变高 60px，
        # 而抓屏线程可能正好在旧尺寸上合成完、把那张 1040 高的图塞进队列。主线程拿它去
        # 贴 `_bg`，窗底部就会少 60px —— 表现就是"一条黑带 + 下方输入栏消失再出现"
        # （2026-11-05 实报，两次都以为是自己重画慢，真凶是这张迟到的旧帧）。
        if out is not None and out.size != (self._geo.width, self._geo.height):
            if TRACE:
                print(f"[trace] drop stale frame {out.size} "
                      f"geo=({self._geo.width},{self._geo.height})", flush=True)
            out = None
        if TRACE:
            rh, ch = self.root.winfo_height(), self.canvas.winfo_height()
            gap = (rh, ch) if rh != ch else None
            if gap != getattr(self, "_trace_gap", None):
                self._trace_gap = gap
                if gap:
                    print(f"[trace] gap root={self.root.winfo_width()}x{rh} "
                          f"canvas={self.canvas.winfo_width()}x{ch}", flush=True)
        if out is not None:
            try:
                self._last_frame = out
                self._img = ImageTk.PhotoImage(out, master=self.canvas)
                self.canvas.itemconfigure(self._bg, image=self._img)
                self.canvas.tag_lower(self._bg)
                self.text.adapt(out)
                self._adapt_bar(out)
                if TRACE and getattr(self, "_rebuild_at", 0):
                    ra = self._rebuild_at
                    dt = (time.perf_counter() - ra) * 1000
                    if 0 < dt < 15000:
                        self._rebuild_at = 0
                        print(f"[trace] first frame after rebuild +{dt:.0f}ms", flush=True)
            except Exception as exc:
                print("draw error", exc, flush=True)

        self.root.after(INTERVAL_MS, self._tick)

    def _work(self) -> None:
        """抓取 + 合成全在后台，主线程只负责显示最新一帧。"""
        if self._plain:
            # 纯色面板：不抓屏、不模糊、不折射。只有几何/内框变了才重画一张，
            # 其余时间这个线程在睡觉 —— 拖动时窗口本身跟着鼠标走就是满帧。
            while not self._stop.is_set():
                try:
                    if self._pause.is_set() or self._collapsed:
                        time.sleep(0.05)
                        continue
                    key = (self.root.winfo_x(), self.root.winfo_y(),
                           self._geo.width, self._geo.height, tuple(self._geo.shapes))
                    if key == self._frame_done:
                        time.sleep(0.05)
                        continue
                    out = self._plain_frame()
                    self._frame_done = key
                    if out is None:
                        continue
                    # 合成期间几何又变了（开/关输入行就是这种）：这张已经过期，
                    # 贴上去会"底部少一截 / 顶部黑一条"，直接丢掉，下一拍重画。
                    if (self.root.winfo_x(), self.root.winfo_y(),
                            self._geo.width, self._geo.height,
                            tuple(self._geo.shapes)) != key:
                        continue
                    if out.size != (self._geo.width, self._geo.height):
                        continue
                    try:
                        self._q.get_nowait()
                    except queue.Empty:
                        pass
                    self._q.put(out)
                except Exception as exc:
                    if not getattr(self, "_plain_err_logged", False):
                        self._plain_err_logged = True
                        print("plain frame error", exc, flush=True)
                    time.sleep(0.1)
            return

        import mss

        idle = 0
        with mss.mss() as sct:
            while not self._stop.is_set():
                if self._pause.is_set() or self._collapsed:
                    time.sleep(0.03)
                    continue
                t0 = time.perf_counter()
                try:
                    out = self._renderer.render(self._source, sct, self._bbox())
                    if out is not None:
                        idle = 0
                        try:
                            self._q.get_nowait()
                        except queue.Empty:
                            pass
                        self._q.put(out)
                    else:
                        idle += 1
                except Exception as exc:
                    print("capture error", exc, flush=True)
                    # GPU 起不来（没有 moderngl / 显卡不支持 GL3.3）就换回 CPU，
                    # 不然后台线程每帧刷一条，用户只看到一块永远不刷新的玻璃。
                    if getattr(self._renderer, "broken", False):
                        print("GPU 不可用，切换到 CPU 渲染", flush=True)
                        self._renderer = CpuRenderer(self._geo)
                dt = time.perf_counter() - t0
                self._ema = self._ema * 0.9 + dt * 0.1
                if self._ema > 0.026:
                    self._target_fps = 45
                elif self._ema > 0.016:
                    self._target_fps = 60
                elif self._ema > 0.011:
                    self._target_fps = 90
                else:
                    self._target_fps = min(MAX_FPS, self._hz)
                # 静态画面：合成已经跳过，但「有没有变」只能靠抓屏看，单次 grab
                # 就要 ~7ms —— 按 60fps 空转等于白烧 40% 单核。探针降到 30fps，
                # 有变化时 idle 立刻归零、下一拍就恢复全速（最坏多等 33ms，
                # 拖动/滚动/播视频这类真的在动的情况根本进不到这个分支）。
                fps = self._target_fps if idle <= 20 else min(self._target_fps, PROBE_FPS)
                time.sleep(max(0.004, 1 / max(1, fps) - dt))

    # ---- 窗口句柄 ----

    def _hwnd_root(self):
        if self._hwnd is None:
            self._hwnd = ctypes.windll.user32.GetAncestor(self.root.winfo_id(), 2)
        return self._hwnd

    def _set_exclude(self, on: bool) -> None:
        hwnd = self._hwnd_root()
        fn = ctypes.windll.user32.SetWindowDisplayAffinity
        fn.argtypes = [wintypes.HWND, wintypes.DWORD]
        fn.restype = wintypes.BOOL
        ok = bool(fn(hwnd, 0x11 if on else 0))
        self._excluded = ok and on
        if not ok:
            print("WDA failed", ctypes.GetLastError(), flush=True)

    def _bbox(self):
        rc = _RECT()
        ctypes.windll.user32.GetWindowRect(self._hwnd_root(), ctypes.byref(rc))
        return (rc.left, rc.top, rc.right, rc.bottom)

    def _apply_placement(self) -> None:
        """窗口映射之后，用 SetWindowPos 把位置钉到算好的坐标上。

        Tk 在窗口**还没映射**时接的 `geometry(+x+y)` 在这种 DPI 环境里会被吞掉：
        2026-11-05 实测，算出来是 `2931,898`（右缘，日志里有），系统落点却在屏左侧
        `340,828`；映射之后从外面挪一次是能站住的。所以这里补一枪物理坐标。
        """
        if self._drag or self._resize:
            return                  # 用户已经在拖了，别抢
        try:
            hwnd = self._hwnd_root()
            if not hwnd:
                return
            user32 = ctypes.windll.user32
            # SWP_NOSIZE(0x1) | SWP_NOZORDER(0x4)
            user32.SetWindowPos(wintypes.HWND(hwnd), None, int(self._x), int(self._y),
                                0, 0, 0x0001 | 0x0004)
            self._sync_pos()
        except Exception as exc:
            print("placement failed:", repr(exc), flush=True)

    def _sync_pos(self) -> None:
        """把 Tk 当前左上角同步回 _x/_y。

        拖动/缩放只改了 root.geometry，没改这两个缓存；折叠时如果继续用旧坐标，
        窗口会被拉回拖动前的位置（用户看到的就是「点收起位置跳回」）。
        """
        try:
            self._x = int(self.root.winfo_x())
            self._y = int(self.root.winfo_y())
        except Exception:
            pass

    def _save_geometry(self) -> None:
        """记账**只记用户态高度**，不读当前窗高。

        输入行（pad）和新消息气泡都是临时长高：写进配置，下次启动/展开就会带着
        一截空白（2026-11-05 输入行实踩）或矮一截（2026-11-07 收起态气泡实踩，
        693x1025 被写成 693x998）。用户态高度只由 `_saved_h` 维护 —— 收起时从
        展开几何取，展开态拖边松手时更新 —— 这里只读它，任何临时尺寸都进不来。
        """
        pad = getattr(self, "_pad", 0)
        h = max(MIN_H, int(getattr(self, "_saved_h", 0) or DEFAULT_H))
        y = self.root.winfo_y() + (pad or 0)
        write_config({"geometry": f"{self.root.winfo_width()}x{h}"
                                  f"+{self.root.winfo_x()}+{y}"})
        if TRACE:
            print(f"[save] geom={self.root.winfo_width()}x{h}"
                  f"+{self.root.winfo_x()}+{y} collapsed={self._collapsed} "
                  f"pad={pad} saved_h={self._saved_h} "
                  f"root_h={self.root.winfo_height()} "
                  f"notif={bool(getattr(self, '_notif_msg', None))}", flush=True)

    # ---- 图片查看器：点气泡里的图片按原尺寸打开（2026-11-06） ----
    #
    # 用户要求：主窗与回顾窗里的图片都能点开看原尺寸，右上角一颗关闭。
    # 实现和回顾窗同一套思路：无边框 Toplevel + Canvas 自绘（一张图 + 一条标题）。
    # **不做玻璃/抓屏**：看图的重点就是图片本身，背景抓屏只会多一层开销。
    # 只有原图大于屏幕可用区域时才等比缩小（否则整张图根本看不全），标题里写明。

    VIEW_TOP = 68            # 顶部标题条高度（用户要求标题/按钮都 ×2）
    VIEW_BTN_GAP = 30        # 100% 与 ↓ 之间额外拉开，别让人看成「这张图已下载完」
    VIEW_MAX = 0.92          # 最多占虚拟桌面的比例
    VIEW_MIN_W = 560         # 窗口最窄：五颗按钮 + 一段文件名都放得下

    def _open_image(self, src: str) -> None:
        """打开一张图的原尺寸预览。同一时间只留一个窗，重复点就是换图。"""
        if not src:
            return
        if src.startswith(("http://", "https://")):
            img = getattr(self, "_orig_url", {}).get(src)
            if img is None:
                self._fetch_original(src)      # 后台下原图，下完自己弹出来
                return
        else:
            img = self._load_original(src)
        if img is None:
            print("open image failed: cannot load", src, flush=True)
            return
        self._show_viewer(img, src)

    def _load_original(self, src: str):
        """本地原图（不解码缩放）。读不到就返回 None，由调用方打日志。"""
        try:
            p = self._resolve_path(src)
            img = Image.open(p)
            img.load()
            return ImageOps.exif_transpose(img).convert("RGB")
        except Exception:
            return None

    def _fetch_original(self, url: str, then=None) -> None:
        """URL 图单独下一次原图；`then(img)` 给右键菜单用，不给就弹预览窗。"""
        busy = getattr(self, "_orig_busy", None)
        if busy is None:
            busy = self._orig_busy = set()
        if url in busy:
            return
        busy.add(url)
        cache = getattr(self, "_orig_url", None)
        if cache is None:
            cache = self._orig_url = {}

        def work():
            img = None
            try:
                import urllib.request
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read(20 * 1024 * 1024)
                got = Image.open(io.BytesIO(data))
                got.load()
                img = ImageOps.exif_transpose(got).convert("RGB")
            except Exception as exc:
                print("viewer fetch failed:", repr(exc), flush=True)
            busy.discard(url)
            if img is None:
                return
            cache[url] = img
            while len(cache) > 8:               # 原图可能几 MB，别无限攒
                cache.pop(next(iter(cache)))
            try:
                if then is not None:
                    self.root.after(0, lambda: then(img))
                else:
                    self.root.after(0, lambda: self._show_viewer(img, url))
            except Exception:
                pass

        threading.Thread(target=work, daemon=True).start()

    # ---- 气泡图片右键菜单（2026-11-06）----
    #
    # 右键气泡里的图 → 查看 / 复制 / 下载图片。菜单是自绘的（和主窗一个风格），
    # 抓起鼠标抓（grab）：点到菜单外面就关，不用管焦点跑哪儿去了。

    def _img_menu_open(self, e):
        src = None
        for (x0, y0, x1, y1), s in getattr(self, "_img_hits", []):
            if s and x0 <= e.x <= x1 and y0 <= e.y <= y1:
                src = s
                break
        if src is None:
            for (x0, y0, x1, y1), s in (getattr(self, "_notif_img_hits", None) or []):
                if s and x0 <= e.x <= x1 and y0 <= e.y <= y1:
                    src = s
                    break
        if src:
            self._show_img_menu(e.x_root, e.y_root, src)
            return
        # 图片之外：落在气泡上就弹气泡菜单（2026-11-06 用户要求）
        for (x0, y0, x1, y1), ent in getattr(self, "_bubble_hits", []):
            if x0 <= e.x <= x1 and y0 <= e.y <= y1:
                self._bubble_menu(e.x_root, e.y_root, ent)
                return

    def _show_img_menu(self, x_root, y_root, src: str) -> None:
        items = (("查看", "view"), ("复制", "copy"), ("下载图片", "save"))

        def pick(action):
            if action == "view":
                self._open_image(src)
            elif action == "copy":
                self._copy_image(src)
            elif action == "save":
                self._save_image_ui(src)

        self._menu_popup(x_root, y_root, items, pick)

    def _menu_popup(self, x_root, y_root, items, on_pick) -> None:
        """通用右键弹层（图片菜单 / 气泡菜单共用）。

        深色无边框 Toplevel + Canvas 自绘，hover 高亮、点外面 / Esc / 失焦都关。
        `items` = ((文案, 动作), ...)，点中后回调 `on_pick(动作)`。
        """
        self._close_img_menu()
        f = self.fonts.get(10)
        try:
            w = max(f.measure(it[0]) for it in items) + 44
        except Exception:
            w = 140
        row, pad = 34, 6
        h = row * len(items) + pad * 2
        x = max(self._vx + 2, min(int(x_root), self._vx + self._vw - w - 4))
        y = max(self._vy + 2, min(int(y_root), self._vy + self._vh - h - 4))
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.configure(bg="#000000")
        try:
            win.attributes("-topmost", True)
        except Exception:
            pass
        win.geometry(f"{w}x{h}+{x}+{y}")
        c = tk.Canvas(win, bg="#000000", highlightthickness=0, bd=0,
                      width=w, height=h)
        c.pack()
        try:
            c.create_polygon(self._rounded_points(0, 0, w, h, 10, 6),
                             fill="#0f1319", outline="#2a3546", smooth=True)
        except Exception:
            c.configure(bg="#0f1319")
        for i, item in enumerate(items):
            yy = pad + i * row
            label = item[0]
            # 第三项可选：文字颜色（删除项红字，2026-11-06 用户要求）
            color = item[2] if len(item) >= 3 else "#e6eef8"
            c.create_text(16, yy + row // 2, text=label, anchor="w",
                          fill=color, font=f, tags=(f"mrow{i}",))
        self._img_menu = {"win": win, "canvas": c, "w": w,
                          "row": row, "pad": pad, "items": items, "hover": None,
                          "t0": time.time(), "on_pick": on_pick}
        c.bind("<Button-1>", self._img_menu_click)
        # **必须也绑在 Toplevel 上**：grab 激活后，落在菜单外面的点击会被投给
        # 「抓鼠标的那个窗口」（win），而不是它的 canvas —— 只绑 canvas 的话，
        # 点浮窗其它地方什么都不发生（2026-11-06 用户实报「关不掉」）。
        win.bind("<Button-1>", self._img_menu_click)
        c.bind("<Motion>", self._img_menu_hover)
        c.bind("<Leave>", lambda _e: self._img_menu_hover(None))
        win.bind("<Escape>", lambda _e: self._close_img_menu())
        # 点桌面/别的应用时，Tk 的 grab 收不到那个点击（只在应用内生效），
        # 靠焦点丢失兜底关掉；刚弹出的 300ms 内忽略，免得 focus_force 本身把菜单关了。
        win.bind("<FocusOut>", lambda _e: self.root.after(160, self._img_menu_focus_lost))
        # 2026-11-06 用户实报：「菜单能开，但点浮窗哪儿都关不掉」。
        # 根因：`grab_set()` 在窗口还没映射时会抛 TclError("window not viewable")，
        # 原来那个裸 except 把它吞了 —— 菜单看着在，其实根本没抓住鼠标，
        # 点击全落到下面的主窗上。先等窗口真正可见再抓，抓不到 30ms 后补一次。
        def _grab(n=0):
            try:
                win.grab_set()
            except Exception as exc:
                if n == 0:
                    self.root.after(30, lambda: _grab(1))
                else:
                    print("menu grab failed:", repr(exc), flush=True)

        try:
            win.update_idletasks()
            win.wait_visibility()
        except Exception:
            pass
        _grab()
        try:
            win.lift()
            win.focus_force()
        except Exception:
            pass

    def _img_menu_focus_lost(self) -> None:
        m = getattr(self, "_img_menu", None)
        if not m:
            return
        if time.time() - m.get("t0", 0) < 0.3:
            return          # 刚弹出来，忽略这次焦点变化
        self._close_img_menu()

    def _close_img_menu(self) -> None:
        m = getattr(self, "_img_menu", None)
        self._img_menu = None
        if not m:
            return
        try:
            m["win"].grab_release()
        except Exception:
            pass
        try:
            m["win"].destroy()
        except Exception:
            pass

    def _img_menu_hover(self, e) -> None:
        m = getattr(self, "_img_menu", None)
        if not m:
            return
        idx = -1
        if e is not None:
            i = int((e.y - m["pad"]) // m["row"])
            if 0 <= i < len(m["items"]) and m["pad"] <= e.y <= m["pad"] + m["row"] * len(m["items"]):
                idx = i
        if idx == m.get("hover"):
            return
        m["hover"] = idx
        c, w, row, pad = m["canvas"], m["w"], m["row"], m["pad"]
        try:
            c.delete("mhl")
            if idx >= 0:
                y0 = pad + idx * row
                c.create_polygon(self._rounded_points(4, y0, w - 4, y0 + row, 8, 4),
                                 fill="#1b2431", outline="", smooth=True,
                                 tags=("mhl",))
                c.tag_lower("mhl")
        except Exception:
            pass

    def _img_menu_click(self, e) -> None:
        m = getattr(self, "_img_menu", None)
        if not m:
            return
        inside = (0 <= e.x <= m["w"] and 0 <= e.y <= m["row"] * len(m["items"]) + m["pad"] * 2)
        if not inside:
            self._close_img_menu()
            return
        i = int((e.y - m["pad"]) // m["row"])
        if not (0 <= i < len(m["items"])):
            self._close_img_menu()
            return
        action = m["items"][i][1]
        on_pick = m.get("on_pick")
        self._close_img_menu()
        try:
            if on_pick:
                on_pick(action)
        except Exception as exc:
            print("menu action failed:", repr(exc), flush=True)

    # ---- 气泡右键 / 收藏 / 隐藏（2026-11-06 用户要求） ----
    #
    # 两份旁路清单都在 `~/.dsh/see-now/`：收藏是**快照**（自动清理把老记录从
    # chat.jsonl 删掉时，收藏里那条还在），隐藏只存 key（读取时过滤，不动记录）。

    def _hidden_keys(self) -> set:
        try:
            st = HID_FILE.stat()
            sig = (st.st_mtime_ns, st.st_size)
        except OSError:
            return set()
        if sig == getattr(self, "_hid_sig", None):
            return self._hid_cache
        keys = set()
        try:
            for line in HID_FILE.read_text(encoding="utf-8").splitlines():
                try:
                    keys.add(str(json.loads(line).get("key") or ""))
                except Exception:
                    continue
        except Exception:
            pass
        self._hid_sig, self._hid_cache = sig, keys
        return keys

    def _fav_list(self) -> list:
        """收藏记录（按写入顺序 = 收藏时间正序）。"""
        try:
            st = FAV_FILE.stat()
            sig = (st.st_mtime_ns, st.st_size)
        except OSError:
            return []
        if sig == getattr(self, "_fav_sig", None):
            return self._fav_cache
        out = []
        try:
            for line in FAV_FILE.read_text(encoding="utf-8").splitlines():
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if isinstance(e, dict) and e.get("key"):
                    out.append(e)
        except Exception:
            pass
        self._fav_sig, self._fav_cache = sig, out
        return out

    def _fav_keys(self) -> set:
        return {str(e.get("key") or "") for e in self._fav_list()}

    def _fav_invalidate(self) -> None:
        self._fav_sig, self._fav_cache = None, []

    def _fav_add(self, sid: str, at, ent: dict) -> None:
        key = msg_key(sid, at)
        if key in self._fav_keys():
            self._flash_status("已经在收藏里了")
            return
        rec = {"key": key, "sid": sid, "at": at,
               "role": str(ent.get("role") or "assistant"),
               "text": str(ent.get("text") or ""),
               "fav_at": int(time.time() * 1000)}
        try:
            with open(FAV_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception as exc:
            print("favorite failed:", repr(exc), flush=True)
            self._flash_status("收藏失败")
            return
        self._fav_invalidate()
        self._flash_status(f"已收藏 · 共 {len(self._fav_list())} 条")
        if self._hist_alive() and (self._hist or {}).get("page") == "fav":
            try:
                self._history_show_favorites()
            except Exception:
                pass

    def _fav_remove(self, key: str) -> None:
        items = [e for e in self._fav_list() if str(e.get("key") or "") != key]
        try:
            tmp = FAV_FILE.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                for e in items:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
            os.replace(tmp, FAV_FILE)
        except Exception as exc:
            print("unfavorite failed:", repr(exc), flush=True)
            self._flash_status("取消收藏失败")
            return
        self._fav_invalidate()
        self._flash_status(f"已取消收藏 · 还剩 {len(items)} 条")
        if self._hist_alive() and (self._hist or {}).get("page") == "fav":
            try:
                self._history_show_favorites()
            except Exception:
                pass

    def _src_uri(self, src: str) -> str:
        """复制用：本地图转 file:/// URI，网络图原样；找不到文件就返回空。"""
        src = str(src or "").strip()
        if not src:
            return ""
        if src.startswith(("http://", "https://")):
            return src
        try:
            p = Path(self._resolve_path(src))
            if p.exists():
                return p.resolve().as_uri()
        except Exception:
            pass
        return ""

    def _bubble_html(self, text: str) -> str:
        """气泡正文 → CF_HTML 片段：一行一个 div，图片用 file:/// 内嵌。"""
        import html as _h
        parts = []
        for kind, payload in self._parse_blocks(str(text or "")):
            if kind == "text":
                for line in str(payload).split("\n"):
                    s = line.strip()
                    parts.append("<div>" + (_h.escape(s) if s else "<br>") + "</div>")
            else:
                uri = self._src_uri(payload)
                if uri:
                    parts.append('<div><img src="' + _h.escape(uri)
                                 + '" style="max-width:560px"></div>')
                else:
                    parts.append("<div>[图片]</div>")
        return ('<div style="font-family:Microsoft YaHei,Segoe UI;'
                'font-size:13px;color:#1a1a1a">' + "".join(parts) + "</div>")

    def _copy_bubble(self, sid: str, at, text: str) -> None:
        try:
            ok = _set_clipboard_rich(str(text or ""), self._bubble_html(text))
        except Exception as exc:
            print("copy bubble failed:", repr(exc), flush=True)
            ok = False
        self._flash_status("已复制内容" if ok else "复制失败")

    def _bubble_menu(self, x_root, y_root, ent: dict, in_fav: bool = False) -> None:
        """气泡右键：复制内容 / 隐藏这条（红）/ 收藏（黄）。图片上右键仍走图片菜单。"""
        src = ent.get("msg") or ent
        sid = str(src.get("sid") or ent.get("sid") or self._bound_full or "")
        at = src.get("at", ent.get("at"))
        key = str(ent.get("_key") or msg_key(sid, at))
        fav = key in self._fav_keys()
        # 2026-11-06 用户要求：从上到下 = 复制内容（白）/ 隐藏这条（红）/ 收藏（黄）
        items = [("复制内容", "copy")]
        if in_fav:
            items.append(("取消收藏", "unfav", "#e8c34a"))
        else:
            items.append(("隐藏这条", "hide", "#e05a5a"))
            items.append(("取消收藏" if fav else "收藏", "unfav" if fav else "fav",
                          "#e8c34a"))

        def pick(action):
            if action == "copy":
                self._copy_bubble(sid, at, str(src.get("text") or ""))
            elif action == "fav":
                self._fav_add(sid, at, src)
            elif action == "unfav":
                self._fav_remove(key)
            elif action == "hide":
                self._ask_hide(sid, at)

        self._menu_popup(x_root, y_root, items, pick)

    def _hide_skip(self) -> bool:
        try:
            return bool(json.loads(HIDE_CFG.read_text(encoding="utf-8")).get("skip"))
        except Exception:
            return False

    def _set_hide_skip(self, on: bool) -> None:
        try:
            HIDE_CFG.write_text(json.dumps({"skip": bool(on)}, ensure_ascii=False),
                                encoding="utf-8")
        except Exception as exc:
            print("hide cfg failed:", repr(exc), flush=True)

    def _ask_hide(self, sid: str, at) -> None:
        if self._hide_skip():
            self._hide_entry(sid, at)
            return
        self._show_hide_confirm(sid, at)

    def _dialog_alive(self) -> bool:
        """确认/重命名这类模态弹窗是否开着（主窗的 topmost 看门狗要给它们让路）。"""
        for name in ("_hide_dlg", "_delete_dlg", "_rename_dlg"):
            w = getattr(self, name, None)
            if not w:
                continue
            try:
                if w.winfo_exists():
                    return True
            except Exception:
                pass
        return False

    def _force_topmost(self, win) -> None:
        """把 `win` 的**顶层** HWND 顶到 topmost 带最前面。

        无边框 Toplevel 的 `attributes("-topmost")` 不保证排在同带最前：
        主窗和弹窗都在 topmost 带里，谁最后 SetWindowPos 谁在上。弹窗刚弹出来时
        主窗可能刚被看门狗顶过，于是重命名/删除框会被主窗压住（2026-11-06 实测
        「弹窗右半被底栏盖住」）。用 GetAncestor 拿 Toplevel 的真实顶层 HWND。
        """
        try:
            hwnd = int(win.winfo_id())
            u = ctypes.windll.user32
            top = u.GetAncestor(wintypes.HWND(hwnd), 2)   # GA_ROOT = 2
            if top:
                u.SetWindowPos(wintypes.HWND(top), wintypes.HWND(-1), 0, 0, 0, 0,
                               0x0001 | 0x0002 | 0x0010)
        except Exception:
            pass

    def _pin_topmost(self, win) -> None:
        """弹窗存续期间每 400ms 顶一次（焦点/系统事件都可能把它压到主窗下面）。"""
        try:
            if not win.winfo_exists():
                return
        except Exception:
            return
        self._force_topmost(win)
        try:
            win.after(400, lambda: self._pin_topmost(win))
        except Exception:
            pass

    def _hide_dlg_alive(self) -> bool:
        w = getattr(self, "_hide_dlg", None)
        if not w:
            return False
        try:
            return bool(w.winfo_exists())
        except Exception:
            return False

    def _show_hide_confirm(self, sid: str, at) -> None:
        """确认弹窗：不可恢复 + 不动会话记录 +「我已知晓，无需提醒」。"""
        w, h = 460, 250
        vx, vy = self._vx, self._vy
        x = max(vx + 8, min(self._x + (self._geo.width - w) // 2, vx + self._vw - w - 8))
        y = max(vy + 8, min(self._y + (self._geo.height - h) // 3, vy + self._vh - h - 8))
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.configure(bg="#000000")
        try:
            win.attributes("-topmost", True)
        except Exception:
            pass
        win.geometry(f"{w}x{h}+{x}+{y}")
        self._hide_dlg = win
        c = tk.Canvas(win, bg="#000000", highlightthickness=0, bd=0, width=w, height=h)
        c.pack()
        pad = 24
        c.create_polygon(self._rounded_points(0, 0, w, h, 16, 6),
                         fill="#0f1319", outline="#2a3546", smooth=True)
        c.create_text(pad, pad, text="隐藏这条气泡？", anchor="nw",
                      fill="#e6eef8", font=self.fonts.spec(14, True))
        c.create_text(pad, pad + 34, anchor="nw", fill="#9fb0c8",
                      font=self.fonts.spec(10),
                      text="本操作不可恢复，但不会删除\n"
                           "DSH 会话里的对应记录，\n"
                           "只是在这个浮窗里不再显示。")
        cb = (pad, h - 96, pad + 16, h - 80)
        c.create_rectangle(*cb, outline="#6b7d95", width=1, fill="#111a24")
        c.create_text(pad + 24, h - 88, text="我已知晓，无需提醒", anchor="w",
                      fill="#9fb0c8", font=self.fonts.spec(10))
        bw, bh, by = 78, 32, h - 56
        no = (w - pad - bw, by, w - pad, by + bh)
        yes = (no[0] - bw - 10, by, no[0] - 10, by + bh)
        for (bx0, b0, bx1, b1), label, tag in (((yes, "是", "hyes")),
                                               ((no, "否", "hno"))):
            c.create_polygon(self._rounded_points(bx0, b0, bx1, b1, 14, 5),
                             fill=("#17324f" if tag == "hyes" else "#000000"),
                             outline=(BTN_EDGE_ON if tag == "hyes" else BTN_EDGE),
                             smooth=True, tags=(tag,))
            c.create_text((bx0 + bx1) / 2, (b0 + b1) / 2, text=label,
                          anchor="center", fill="#ffffff",
                          font=self.fonts.spec(11, True), tags=(tag,))
        state = {"skip": False, "done": False}

        def draw_tick():
            c.delete("htick")
            if state["skip"]:
                c.create_line(cb[0] + 3, cb[1] + 8, cb[0] + 7, cb[1] + 12,
                              cb[0] + 13, cb[1] + 3, fill="#7fc4ff", width=2,
                              tags=("htick",))

        def close():
            if state["done"]:
                return
            state["done"] = True
            if getattr(self, "_hide_dlg", None) is win:
                self._hide_dlg = None
            try:
                win.grab_release()
            except Exception:
                pass
            try:
                win.destroy()
            except Exception:
                pass

        def hit(box, e):
            return box[0] <= e.x <= box[2] and box[1] <= e.y <= box[3]

        def click(e):
            if hit((cb[0] - 6, cb[1] - 8, cb[0] + 140, cb[3] + 8), e):
                state["skip"] = not state["skip"]
                draw_tick()
                return
            if hit(yes, e):
                skip = state["skip"]
                close()
                if skip:
                    self._set_hide_skip(True)
                self._hide_entry(sid, at)
            elif hit(no, e):
                close()

        c.bind("<Button-1>", click)
        win.bind("<Escape>", lambda _e: close())
        try:
            win.grab_set()
        except Exception:
            pass
        try:
            win.lift()
            win.focus_force()
        except Exception:
            pass

    def _hide_entry(self, sid: str, at) -> None:
        key = msg_key(sid, at)
        try:
            with open(HID_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps({"key": key, "sid": sid, "at": at,
                                    "hid_at": int(time.time() * 1000)},
                                   ensure_ascii=False) + "\n")
        except Exception as exc:
            print("hide failed:", repr(exc), flush=True)
            self._flash_status("隐藏失败")
            return
        self._hid_sig = None
        if str(getattr(self, "_expanded", None)) == str(at):
            self._expanded = None
        try:
            self._refresh_feed()
        except Exception:
            pass
        if self._hist_alive():
            st = self._hist or {}
            try:
                if st.get("page") == "fav":
                    self._history_show_favorites()
                elif st.get("page") == "viewer":
                    self._history_show_session(st.get("sid") or "")
            except Exception:
                pass
        self._flash_status("已隐藏这条 · 会话记录没动")

    def _with_original(self, src: str, cb) -> None:
        """拿到原图再回调：本地直接读，URL 走缓存/后台下载。"""
        if not src.startswith(("http://", "https://")):
            img = self._load_original(src)
            if img is None:
                self._flash_status("读不到这张图")
                return
            cb(img)
            return
        img = getattr(self, "_orig_url", {}).get(src)
        if img is not None:
            cb(img)
            return
        self._flash_status("正在下载原图…")
        self._fetch_original(src, then=cb)

    def _copy_image(self, src: str) -> None:
        def done(img):
            try:
                ok = _set_clipboard_image(img)
            except Exception as exc:
                print("clipboard failed:", repr(exc), flush=True)
                ok = False
            self._flash_status("已复制图片" if ok else "复制失败")

        self._with_original(src, done)

    def _save_image_ui(self, src: str) -> None:
        name = os.path.basename(str(src).split("?")[0].rstrip("/")) or "image.png"
        ext = os.path.splitext(name)[1] or ".png"
        if not os.path.splitext(name)[1]:
            name += ext
        try:
            from tkinter import filedialog
            path = filedialog.asksaveasfilename(
                parent=self.root, title="保存图片", initialfile=name,
                initialdir=str(Path.home() / "Downloads"),
                defaultextension=ext)
        except Exception as exc:
            print("save dialog failed:", repr(exc), flush=True)
            self._flash_status("打不开保存框")
            return
        if not path:
            return

        def done(img):
            try:
                if not src.startswith(("http://", "https://")):
                    import shutil
                    shutil.copyfile(self._resolve_path(src), path)
                else:
                    fmt = (os.path.splitext(path)[1] or ".png").lstrip(".").upper()
                    if fmt == "JPG":
                        fmt = "JPEG"
                    img.save(path, format=fmt)
            except Exception as exc:
                print("save image failed:", repr(exc), flush=True)
                self._flash_status("保存失败")
                return
            self._flash_status(f"已保存 {os.path.basename(path)}")

        self._with_original(src, done)

    def _flash_status(self, text: str, ms: int = 2200) -> None:
        """标题栏状态位闪一句（复制/保存的结果），几秒后复原。"""
        try:
            self.feed.status = str(text)
            self._refresh_header()
        except Exception:
            return

        def clear():
            try:
                if self.feed.status == str(text):
                    self.feed.status = ""
                    self._refresh_header()
            except Exception:
                pass

        try:
            self.root.after(ms, clear)
        except Exception:
            pass

    def _viewer_alive(self) -> bool:
        v = getattr(self, "_viewer", None)
        if not v:
            return False
        try:
            return bool(v["win"].winfo_exists())
        except Exception:
            return False

    def _close_viewer(self) -> None:
        v = getattr(self, "_viewer", None)
        self._viewer = None
        try:
            if v is not None:
                v["win"].destroy()
        except Exception:
            pass

    def _show_viewer(self, img, src: str) -> None:
        """无边框 Lightbox：原尺寸起，滚轮缩放、放大后拖动平移，✕ / Esc 关。

        （2026-11-06 重做）原来只会把超大图等比缩到 92% 屏、没有缩放/平移，
        4K 截图里的字根本看不清；顶栏也只有一行尺寸小字。现在：
        - 顶栏：文件名 · 原始尺寸 · 缩放百分比，右侧 ✕（判定 38×顶栏高）；
        - 滚轮以光标为锚点缩放（下限 = 适应窗口的一半，上限 400%）；
        - 双击在「适应窗口 ↔ 100%」之间切（图本身比屏小则切 200%）；
        - 图比窗口大时拖动 = 平移图片；否则拖动 = 移动窗口（顶栏拖动始终移窗）。
        """
        self._close_viewer()
        iw, ih = img.size
        title_h = self.VIEW_TOP
        avail_w = max(200.0, self._vw * self.VIEW_MAX - 8)
        avail_h = max(160.0, self._vh * self.VIEW_MAX - title_h - 8)
        fit = min(1.0, avail_w / max(1, iw), avail_h / max(1, ih))
        dw, dh = max(1, round(iw * fit)), max(1, round(ih * fit))
        w = int(min(avail_w, max(dw, self.VIEW_MIN_W)))
        h = int(title_h + min(avail_h, max(dh, 120)))
        x = max(self._vx, min(self._x + (self._geo.width - w) // 2,
                             self._vx + self._vw - w))
        y = max(self._vy, min(self._y + (self._geo.height - h) // 2,
                             self._vy + self._vh - h))
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.configure(bg="#000000")
        try:
            win.attributes("-topmost", True)
        except Exception:
            pass
        win.geometry(f"{w}x{h}+{x}+{y}")
        canvas = tk.Canvas(win, bg="#000000", highlightthickness=0, bd=0,
                           width=w, height=h)
        canvas.pack(fill="both", expand=True)
        self._viewer = {"win": win, "canvas": canvas, "photo": None, "img": img,
                        "src": src, "w": w, "h": h, "title_h": title_h,
                        "scale": fit, "fit": fit, "ox": 0.0, "oy": 0.0,
                        "drag": None, "close": None, "btns": {},
                        "maxed": False, "prev": None, "hover": None}
        # 最小化不靠系统任务栏：overrideredirect 窗被 Win32 最小化后会缩成
        # 一条意义不明的标题条、还还原不回来（2026-11-06 实报），改成收成顶栏（见 `_viewer_min`）。
        self._viewer_chrome()
        self._viewer_render()
        canvas.bind("<ButtonPress-1>", self._viewer_press)
        canvas.bind("<B1-Motion>", self._viewer_motion)
        canvas.bind("<ButtonRelease-1>", self._viewer_release)
        canvas.bind("<MouseWheel>", self._viewer_wheel)
        canvas.bind("<Double-Button-1>", self._viewer_double)
        win.bind("<Escape>", lambda _e: self._close_viewer())
        try:
            win.focus_force()
        except Exception:
            pass
        # 主窗也是 topmost：不显式抬一次，预览窗会被压在它下面（2026-11-06 实测）
        try:
            win.lift()
        except Exception:
            pass

    def _viewer_chrome(self) -> None:
        """顶栏：标题 + 左侧 100% / 下载 / 收起 / 最大化 / 关闭 五颗图标按钮。

        图标不是字体字符 —— 都是 PIL 超采样画好再缩小的位图（14×14），
        所以描边是抗锯齿的、五个按钮同一套粗细和颜色，看起来是一套 UI 而不是
        「从键盘上抠几个符号」（2026-11-06 用户要求）。
        """
        v = getattr(self, "_viewer", None)
        if not v:
            return
        c, w = v["canvas"], v["w"]
        top = v["title_h"]
        c.delete("chrome")
        c.create_rectangle(0, 0, w, top, fill="#0b0f16", outline="",
                           tags=("chrome",))
        c.create_line(0, top - 0.5, w, top - 0.5, fill="#1d2735",
                      tags=("chrome",))
        # 从左到右：100% ↓ — □ ✕（2026-11-06 用户要求）
        # 尺寸：标题条 68、按钮图标 28、槽位 68（判定范围同步 ×2）；
        # 窗口窄了按比例缩（下界 40），很窄时先摘掉 100%（双击也能复位）。
        keys, slot, gap = self._viewer_btn_layout(w)
        n = len(keys)
        icon = max(14, min(28, slot - 12))
        f100 = max(11, round(18 * slot / 68))
        btns = {}
        for i, key in enumerate(keys):
            cx = w - slot * (n - i) + slot // 2 - (gap if key == "100" else 0)
            btns[key] = (cx - slot // 2, 0, cx + slot // 2, top)
            if key == "100":
                c.create_text(cx, top / 2, text="100%", anchor="center",
                              fill="#cfd9e6",
                              font=self.fonts.spec(f100), tags=("chrome",))
            else:
                c.create_image(cx, top / 2,
                               image=self._viewer_icon_photo(key, icon),
                               tags=("chrome",))
        # 缩放标签与窗口按钮之间一条细分隔线（落在加宽的那段空隙里）
        if gap:
            sx = w - slot * 4 - gap / 2
            c.create_line(sx, top * 0.24, sx, top * 0.76, fill="#2b3748",
                          width=1, tags=("chrome",))
        v["btns"] = btns
        self._viewer_title()
        c.tag_raise("chrome")

    def _viewer_btn_layout(self, w: int):
        """按钮布局：返回 (键列表, 槽位, 100% 与 ↓ 的额外间距)。

        宽窗槽 68、间距 30；窗口窄了槽缩到 40、间距缩到 18 —— 五颗始终都在，
        只是挤一点，别把 100% 藏起来让人找不到。
        """
        keys = ("100", "save", "min", "max", "close")
        slot = 68 if w >= 1000 else (52 if w >= 700 else 44)
        gap = self.VIEW_BTN_GAP if slot >= 60 else 18
        return keys, slot, gap

    def _viewer_icon_photo(self, key: str, size: int = 28):
        """抗锯齿图标（4 倍超采样再缩）：描边粗细、颜色、状态都同一套。

        颜色跟着 hover 走；`maxed` 时「最大化」换成「还原」两个方框。带缓存。
        """
        v = self._viewer
        cache = v.setdefault("icons", {})
        ck = (key, size, bool(v.get("maxed")))
        hit = cache.get(ck)
        if hit is not None:
            return hit
        S = 4
        px = size * S
        img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        col = (207, 217, 230, 255)
        wd = max(2, round(size / 7)) * S
        cx = cy = px / 2
        k = size / 28.0 * S          # 以 28×28 为基准设计，按 size 缩放
        if key == "save":
            d.line([(cx, cy - 12 * k / 1.0), (cx, cy + 6 * k / 1.0)],
                   fill=col, width=wd)
            d.line([(cx - 9 * k / 1.0, cy - 3 * k / 1.0), (cx, cy + 6 * k / 1.0),
                    (cx + 9 * k / 1.0, cy - 3 * k / 1.0)], fill=col, width=wd,
                   joint="curve")
            d.line([(cx - 12 * k / 1.0, cy + 13 * k / 1.0),
                    (cx + 12 * k / 1.0, cy + 13 * k / 1.0)], fill=col, width=wd)
        elif key == "min":
            d.line([(cx - 12 * k / 1.0, cy), (cx + 12 * k / 1.0, cy)],
                   fill=col, width=wd)
        elif key == "max":
            if v.get("maxed"):
                d.rectangle([cx - 12 * k / 1.0, cy - 12 * k / 1.0,
                             cx + 1 * k / 1.0, cy + 1 * k / 1.0],
                            outline=col, width=wd)
                d.line([(cx - 2 * k / 1.0, cy + 12 * k / 1.0),
                        (cx + 12 * k / 1.0, cy + 12 * k / 1.0),
                        (cx + 12 * k / 1.0, cy - 2 * k / 1.0)],
                       fill=col, width=wd, joint="curve")
            else:
                d.rectangle([cx - 12 * k / 1.0, cy - 12 * k / 1.0,
                             cx + 12 * k / 1.0, cy + 12 * k / 1.0],
                            outline=col, width=wd)
        elif key == "close":
            d.line([(cx - 10 * k / 1.0, cy - 10 * k / 1.0),
                    (cx + 10 * k / 1.0, cy + 10 * k / 1.0)], fill=col, width=wd)
            d.line([(cx - 10 * k / 1.0, cy + 10 * k / 1.0),
                    (cx + 10 * k / 1.0, cy - 10 * k / 1.0)], fill=col, width=wd)
        img = img.resize((size, size), Image.LANCZOS)
        ph = ImageTk.PhotoImage(img, master=v["canvas"])
        cache[ck] = ph
        return ph

    def _viewer_title(self) -> None:
        v = getattr(self, "_viewer", None)
        if not v:
            return
        c = v["canvas"]
        iw, ih = v["img"].size
        name = os.path.basename(v["src"].split("?")[0].rstrip("/")) or "图片"
        keys, slot, gap = self._viewer_btn_layout(v["w"])
        avail = max(24, v["w"] - (len(keys) * slot + gap) - 44)
        pct = int(round(v["scale"] * 100))
        if v.get("mini"):
            head, info = name, " · 已收起 —— 点这条还原"
        elif avail >= 300:
            head, info = name, f" · {iw}×{ih} · {pct}%"
        else:
            # 窄窗先把「宽×高」让给文件名，只留百分比
            head, info = name, f" · {pct}%"
        # 字号跟着可用宽度走：窄窗再用 22pt，一行只放得下三四个字（2026-11-06 实测）
        if avail >= 420:
            fh, fi = self.fonts.get(22, True), self.fonts.get(18)
        elif avail >= 300:
            fh, fi = self.fonts.get(18, True), self.fonts.get(16)
        else:
            fh, fi = self.fonts.get(15, True), self.fonts.get(13)
        if fh.measure(head) + fi.measure(info) > avail:
            head = self._fit_text(fh, head, max(50, avail - min(fi.measure(info), avail // 2)))
            info = self._fit_text(fi, info, max(30, avail - fh.measure(head)))
        left = 32                          # 左边留白（2026-11-06 用户要求）
        c.delete("vtitle")
        c.create_text(left, v["title_h"] / 2, text=head, anchor="w",
                      fill="#ffffff", font=fh, tags=("chrome", "vtitle"))
        c.create_text(left + fh.measure(head), v["title_h"] / 2, text=info,
                      anchor="w", fill="#9fb0c8", font=fi,
                      tags=("chrome", "vtitle"))

    def _viewer_flash(self, text: str, ms: int = 2500) -> None:
        """顶栏临时顶一句提示（保存成功/失败），几秒后恢复。"""
        v = getattr(self, "_viewer", None)
        if not v:
            return
        c = v["canvas"]
        c.delete("vflash")
        c.create_text(14, v["title_h"] / 2, text=text, anchor="w",
                      fill="#9fe0a8", font=self.fonts.get(18),
                      tags=("chrome", "vflash"))
        c.itemconfigure("vtitle", state="hidden")

        def restore():
            if not self._viewer_alive():
                return
            try:
                v["canvas"].delete("vflash")
                v["canvas"].itemconfigure("vtitle", state="normal")
            except Exception:
                pass

        v["win"].after(ms, restore)

    def _viewer_min(self) -> None:
        """收起 / 还原：窗口只留一条顶栏，点它任意处还原。

        Win32 的 `ShowWindow(SW_MINIMIZE)` 对 overrideredirect 窗是假的 ——
        会缩成一条意义不明的标题条、也没有任务栏入口能还原（2026-11-06 实报）。
        """
        v = getattr(self, "_viewer", None)
        if not v:
            return
        if v.get("mini"):
            w, h, x, y = v["mini_prev"]
            v["mini"] = False
            v["w"], v["h"] = int(w), int(h)
            v["win"].geometry(f"{v['w']}x{v['h']}+{int(x)}+{int(y)}")
            v["canvas"].config(width=v["w"], height=v["h"])
            self._viewer_chrome()
            self._viewer_render()
        else:
            x, y = v["win"].winfo_x(), v["win"].winfo_y()
            v["mini_prev"] = (v["w"], v["h"], x, y)
            v["mini"] = True
            v["canvas"].delete("vimg")
            v["w"] = min(v["w"], 560)      # 收起成一条窄的，别横贯整屏
            v["h"] = v["title_h"]
            v["win"].geometry(f"{v['w']}x{v['h']}+{x}+{y}")
            v["canvas"].config(width=v["w"], height=v["h"])
            self._viewer_chrome()

    def _monitor_work(self, x: int, y: int):
        """点 (x, y) 所在显示器的可用区域（已扣掉任务栏）。"""
        try:
            u = ctypes.windll.user32

            class MONITORINFO(ctypes.Structure):
                _fields_ = [("cbSize", wintypes.DWORD),
                            ("rcMonitor", wintypes.RECT),
                            ("rcWork", wintypes.RECT),
                            ("dwFlags", wintypes.DWORD)]

            hmon = u.MonitorFromPoint(wintypes.POINT(int(x), int(y)), 2)
            mi = MONITORINFO()
            mi.cbSize = ctypes.sizeof(MONITORINFO)
            if u.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                r = mi.rcWork
                return r.left, r.top, r.right, r.bottom
        except Exception:
            pass
        return self._vx, self._vy, self._vx + self._vw, self._vy + self._vh

    def _viewer_max_toggle(self) -> None:
        """最大化 = 铺满当前显示器的可用区域（扣任务栏）；再点回到原尺寸。"""
        v = getattr(self, "_viewer", None)
        if not v or v.get("mini"):
            return
        if v.get("maxed") and v.get("prev"):
            w, h, x, y, scale = v["prev"]
            v["maxed"] = False
            v["scale"] = scale
        else:
            w, h = v["w"], v["h"]
            x, y = v["win"].winfo_x(), v["win"].winfo_y()
            v["prev"] = (w, h, x, y, v["scale"])
            l, t, r, b = self._monitor_work(x + 40, y + 40)
            x, y, w, h = l, t, r - l, b - t
            v["maxed"] = True
            iw, ih = v["img"].size
            v["fit"] = min(1.0, max(1.0, w - 16) / iw,
                           max(1.0, h - v["title_h"] - 16) / ih)
            v["scale"] = v["fit"]
            v["ox"] = v["oy"] = 0.0
        v["w"], v["h"] = max(200, int(w)), max(120, int(h))
        v["win"].geometry(f"{v['w']}x{v['h']}+{int(x)}+{int(y)}")
        v["canvas"].config(width=v["w"], height=v["h"])
        self._viewer_chrome()
        self._viewer_render()

    def _viewer_save(self) -> None:
        """存到本地：本地图原样复制，URL 图用缓存里的原图另存。"""
        v = getattr(self, "_viewer", None)
        if not v:
            return
        src = v["src"]
        name = os.path.basename(src.split("?")[0].rstrip("/")) or "image.png"
        ext = os.path.splitext(name)[1] or ".png"
        if not os.path.splitext(name)[1]:
            name += ext
        try:
            from tkinter import filedialog
            path = filedialog.asksaveasfilename(
                parent=v["win"], title="保存图片", initialfile=name,
                initialdir=str(Path.home() / "Downloads"),
                defaultextension=ext)
        except Exception as exc:
            self._viewer_flash(f"打不开保存框：{exc}")
            return
        if not path:
            return
        try:
            if not src.startswith(("http://", "https://")):
                import shutil
                shutil.copyfile(self._resolve_path(src), path)
            else:
                fmt = (os.path.splitext(path)[1] or ".png").lstrip(".").upper()
                if fmt == "JPG":
                    fmt = "JPEG"
                v["img"].save(path, format=fmt)
        except Exception as exc:
            self._viewer_flash(f"保存失败：{exc}")
            return
        self._viewer_flash(f"已保存：{os.path.basename(path)}")

    def _viewer_clamp(self) -> None:
        """图片比窗口小就居中；大就把偏移钳住，别拖到只剩一条边。"""
        v = self._viewer
        iw, ih = v["img"].size
        s = v["scale"]
        dw, dh = iw * s, ih * s
        w, h, top = v["w"], v["h"], v["title_h"]
        area_h = h - top
        v["ox"] = (w - dw) / 2 if dw <= w else min(0.0, max(w - dw, v["ox"]))
        v["oy"] = ((top + (area_h - dh) / 2) if dh <= area_h
                   else min(float(top), max(h - dh, v["oy"])))

    def _viewer_render(self, fast: bool = False) -> None:
        """只裁当前可见那块再缩放：4K 图放大到 400% 也不会整张解码/上传。"""
        v = getattr(self, "_viewer", None)
        if not v:
            return
        c = v["canvas"]
        self._viewer_clamp()
        img = v["img"]
        iw, ih = img.size
        s = v["scale"]
        ox, oy = v["ox"], v["oy"]
        w, h, top = v["w"], v["h"], v["title_h"]
        sx0 = max(0.0, -ox / s)
        sy0 = max(0.0, (top - oy) / s)
        sx1 = min(float(iw), (w - ox) / s)
        sy1 = min(float(ih), (h - oy) / s)
        if sx1 - sx0 <= 0.5 or sy1 - sy0 <= 0.5:
            c.delete("vimg")
            return
        box = (int(sx0), int(sy0),
               int(min(iw, sx1 + 1)), int(min(ih, sy1 + 1)))
        crop = img.crop(box)
        tw = max(1, round(crop.width * s))
        th = max(1, round(crop.height * s))
        if (tw, th) != crop.size:
            crop = crop.resize((tw, th),
                               Image.Resampling.BILINEAR if fast
                               else Image.Resampling.LANCZOS)
        photo = ImageTk.PhotoImage(crop, master=c)
        c.delete("vimg")
        c.create_image(ox + box[0] * s, oy + box[1] * s, anchor="nw",
                       image=photo, tags=("vimg",))
        v["photo"] = photo          # 不存引用的话 Tk 会把图回收成空白
        c.tag_lower("vimg")         # 压到顶栏下面

    def _viewer_zoom(self, target: float, ax=None, ay=None) -> None:
        v = getattr(self, "_viewer", None)
        if not v or v.get("mini"):
            return
        lo = max(0.05, min(v["fit"], 1.0) * 0.5)
        target = max(lo, min(4.0, float(target)))
        s = v["scale"]
        if abs(target - s) < 1e-4:
            return
        ax = v["w"] / 2 if ax is None else ax
        ay = (v["title_h"] + v["h"]) / 2 if ay is None else ay
        ix = (ax - v["ox"]) / s        # 光标下的图像坐标，缩放后还贴着光标
        iy = (ay - v["oy"]) / s
        v["scale"] = target
        v["ox"] = ax - ix * target
        v["oy"] = ay - iy * target
        self._viewer_render()
        self._viewer_title()

    def _viewer_wheel(self, e) -> None:
        v = getattr(self, "_viewer", None)
        if not v:
            return
        self._viewer_zoom(v["scale"] * (1.12 if e.delta > 0 else 1 / 1.12),
                          e.x, e.y)

    def _viewer_double(self, e) -> None:
        v = getattr(self, "_viewer", None)
        if not v or e.y < v["title_h"]:
            return
        fit = v["fit"]
        if abs(v["scale"] - fit) > 0.02:
            target = fit
        else:
            target = 2.0 if fit > 0.95 else 1.0
        self._viewer_zoom(target, e.x, e.y)

    def _viewer_press(self, e) -> None:
        v = getattr(self, "_viewer", None)
        if not v:
            return
        for key, r in (v.get("btns") or {}).items():
            if r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                if key == "close":
                    self._close_viewer()
                elif key == "min":
                    self._viewer_min()
                elif key == "max":
                    self._viewer_max_toggle()
                elif key == "save":
                    self._viewer_save()
                elif key == "100":
                    self._viewer_zoom(1.0)
                return
        if v.get("mini"):
            self._viewer_min()          # 收起态：点条上任意处还原
            return
        # 边缘 / 四角：拖动改窗口大小（2026-11-06 用户要求）
        edge = self._viewer_edge_at(e.x, e.y)
        if edge:
            v["drag"] = {"mode": "resize", "edge": edge,
                         "sx": e.x_root, "sy": e.y_root,
                         "wx": v["win"].winfo_x(), "wy": v["win"].winfo_y(),
                         "ww": v["w"], "wh": v["h"]}
            try:
                v["canvas"].configure(cursor="sizing")
            except Exception:
                pass
            return
        iw, ih = v["img"].size
        s = v["scale"]
        big = (iw * s > v["w"] + 1) or (ih * s > (v["h"] - v["title_h"]) + 1)
        mode = "pan" if (e.y >= v["title_h"] and big) else "move"
        v["drag"] = {"mode": mode, "sx": e.x_root, "sy": e.y_root,
                     "wx": v["win"].winfo_x(), "wy": v["win"].winfo_y(),
                     "ox": v["ox"], "oy": v["oy"]}
        if mode == "pan":
            try:
                v["canvas"].configure(cursor="fleur")
            except Exception:
                pass

    def _viewer_edge_at(self, x, y) -> str:
        """命中边缘/四角返回 "n"/"s"/"e"/"w"/"nw"...（无则空串）。"""
        v = self._viewer
        w, h = v["w"], v["h"]
        edge, corner = 12, 28
        if x <= corner and y <= corner:
            return "nw"
        if x >= w - corner and y <= corner:
            return "ne"
        if x <= corner and y >= h - corner:
            return "sw"
        if x >= w - corner and y >= h - corner:
            return "se"
        if y <= edge:
            return "n"
        if y >= h - edge:
            return "s"
        if x <= edge:
            return "w"
        if x >= w - edge:
            return "e"
        return ""

    def _viewer_resize(self, d, e) -> None:
        """按拖动方向改窗口大小；左上角反向长，右下角正向长。"""
        v = self._viewer
        now = time.time()
        if now - v.get("_rz_at", 0.0) < 0.035:      # ~28fps，别把主线程压满
            return
        v["_rz_at"] = now
        dx, dy = e.x_root - d["sx"], e.y_root - d["sy"]
        x, y, w, h = d["wx"], d["wy"], d["ww"], d["wh"]
        edge = d["edge"]
        if "e" in edge:
            w += dx
        if "w" in edge:
            w -= dx
            x += dx
        if "s" in edge:
            h += dy
        if "n" in edge:
            h -= dy
            y += dy
        w, h = max(280, w), max(160, h)
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        x = max(vx, min(x, vx + vw - 280))
        y = max(vy, min(y, vy + vh - 160))
        v["w"], v["h"] = int(w), int(h)
        v["win"].geometry(f"{v['w']}x{v['h']}+{int(x)}+{int(y)}")
        v["canvas"].config(width=v["w"], height=v["h"])
        self._viewer_chrome()
        self._viewer_render(fast=True)

    def _viewer_motion(self, e) -> None:
        v = getattr(self, "_viewer", None)
        if not v or not v.get("drag"):
            return
        d = v["drag"]
        if d["mode"] == "resize":
            self._viewer_resize(d, e)
            return
        dx, dy = e.x_root - d["sx"], e.y_root - d["sy"]
        if d["mode"] == "move":
            v["win"].geometry(f"+{d['wx'] + dx}+{d['wy'] + dy}")
        else:
            v["ox"] = d["ox"] + dx
            v["oy"] = d["oy"] + dy
            self._viewer_render(fast=True)

    def _viewer_release(self, _e=None) -> None:
        v = getattr(self, "_viewer", None)
        if not v:
            return
        was = v.get("drag")
        v["drag"] = None
        try:
            v["canvas"].configure(cursor="")
        except Exception:
            pass
        if was and was.get("mode") == "resize":
            # 尺寸变了：fit 跟着重算，双击「适应」才符合新窗口
            iw, ih = v["img"].size
            v["fit"] = min(1.0, max(1, v["w"] - 8) / iw,
                           max(1, v["h"] - v["title_h"] - 8) / ih)
            self._viewer_render()
        elif was and was.get("mode") == "pan":
            self._viewer_render()      # 松手再按 LANCZOS 出一张清晰的

    # ---- 关闭 / 隐藏 ----

    def _close(self, _e=None):
        # 预览窗是独立 Toplevel：主窗关掉时必须一起走，否则留一张图挂在桌面上
        self._close_viewer()
        if self._pad:
            # Esc 先收输入行，不要一按就把窗关了
            self._hide_bind_bar()
            return
        try:
            self._save_geometry()
            self._stop_mic()
            self._stop.set()
            self._pause.set()
            self._set_exclude(False)
            self._worker.join(timeout=0.3)
            try:
                self._renderer.close()
            except Exception:
                pass
            ctypes.windll.winmm.timeEndPeriod(1)
        finally:
            self.root.destroy()
        return "break"

    # ---- 边缘缩放 / 拖动 ----

    def _edge_at(self, x, y):
        w, h = self.root.winfo_width(), self.root.winfo_height()
        # 圆角是透明的，鼠标落在最外侧时命中的是 DWM 非客户区；
        # 命中带放宽到 20px，用户不必精确到 1px 也能拖边缘/四角。
        edge, corner = 20, 32
        if x <= corner and y <= corner:
            return "nw"
        if x >= w - corner and y <= corner:
            return "ne"
        if x <= corner and y >= h - corner:
            return "sw"
        if x >= w - corner and y >= h - corner:
            return "se"
        if y <= edge:
            return None          # 顶部中间只拖动，不缩放
        if x <= edge:
            return "w"
        if x >= w - edge:
            return "e"
        if y >= h - edge:
            return "s"
        return None

    @staticmethod
    def _cursor_for(mode):
        return {"nw": "size_nw_se", "se": "size_nw_se",
                "ne": "size_ne_sw", "sw": "size_ne_sw",
                "w": "size_we", "e": "size_we",
                "n": "size_ns", "s": "size_ns"}.get(mode, "")

    def _hover(self, e):
        if self._resize:
            return
        try:
            self.canvas.config(cursor=self._cursor_for(self._edge_at(e.x, e.y)))
        except Exception:
            pass

    def _leave(self, _e):
        if not self._resize:
            self.canvas.config(cursor="")

    def _toggle_expand(self, key) -> None:
        """点气泡右下角的「展开 / 收回」：一次只展开一条，收起后回到两行摘要。"""
        if str(self._expanded) == str(key):
            self._collapse_expanded()        # 收回：回到展开前的位置
            return
        # 记住展开前的列表位置，收起时还原（否则一收就跳回最顶端）
        self._saved_scroll = self._scroll_px
        self._saved_follow = getattr(self, "_follow_bottom", True)
        self._scroll_px = 0
        self._scroll_target = 0
        self._expanded = key
        self._expand_offset = 0
        self._expand_max = 0
        try:
            if self.FEED_LIST:
                self._redraw_feed_layer(None)
            else:
                self._layout()
        except Exception as exc:
            print("expand layout failed:", repr(exc), flush=True)
        self._after_expand_change()

    def _collapse_expanded(self, to_latest: bool = False) -> bool:
        """把「展开某条气泡」收回来；返回这次是否真的从展开态退出。

        `to_latest=True`（发新话时）：收完直接贴到底部，不还原展开前的位置 ——
        用户 2026-11-09 要求「发出去就跳到最新消息」。
        默认（点「收回」）：还原到展开前的滚动位置。
        """
        if self._expanded is None:
            return False
        self._expanded = None
        self._expand_offset = 0
        self._expand_max = 0
        if to_latest:
            self._follow_bottom = True
            self._new_below = False
            self._scroll_px = 0      # `_redraw_feed_layer` 会按「贴底」重设偏移
            self._scroll_target = 0
        restore = None if to_latest else getattr(self, "_saved_scroll", 0)
        try:
            if self.FEED_LIST:
                self._redraw_feed_layer(restore)
            else:
                self._layout()
        except Exception as exc:
            print("collapse expanded failed:", repr(exc), flush=True)
        self._after_expand_change()
        return True

    def _after_expand_change(self) -> None:
        """展开/收起之后标题栏与「收回」胶囊要跟着重排（两边共用）。"""
        try:
            # 展开/收起会改变标题栏要不要给「收回」让位，必须重排一次标题栏
            self._refresh_header()
        except Exception:
            pass
        try:
            self._refresh_chip()
        except Exception:
            pass

    def _press(self, e):
        self._close_img_menu()
        self._sel_drag = False
        # 标题栏 ▴/▾ 与 ✕：整块矩形判定（2026-11-06 用户要求判定范围同步加大）
        r = getattr(self, "_title_close_rect", None)
        if r is not None and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
            self._close()
            return
        r = getattr(self, "_title_tri_rect", None)
        if r is not None and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
            self.toggle_collapse()
            return
        # 先看有没有点中气泡上的「展开 / 收回」按钮
        for (x0, y0, x1, y1), key in getattr(self, "_btn_hits", []):
            if x0 <= e.x <= x1 and y0 <= e.y <= y1:
                self._toggle_expand(key)
                return
        # 点气泡里的图片：原尺寸预览（2026-11-06）
        for (x0, y0, x1, y1), src in getattr(self, "_img_hits", []):
            if src and x0 <= e.x <= x1 and y0 <= e.y <= y1:
                self._open_image(src)
                return
        # 收起态「新消息」气泡里的图片：同样原尺寸预览
        for (x0, y0, x1, y1), src in getattr(self, "_notif_img_hits", []) or []:
            if src and x0 <= e.x <= x1 and y0 <= e.y <= y1:
                self._open_image(src)
                return
        # 「回到最新」（2026-11-06 用户要求 ②）
        jr = getattr(self, "_jump_rect", None)
        if jr is not None and jr[0] <= e.x <= jr[2] and jr[1] <= e.y <= jr[3]:
            self._jump_to_latest()
            return
        # 底部那一栏【历史记录】：开/关回顾列表
        hr = getattr(self, "_history_rect", None)
        if hr is not None and hr[0] <= e.x <= hr[2] and hr[1] <= e.y <= hr[3]:
            self._toggle_history()
            return
        # 「关联变更」这一行：确定变更 / 输入框（在标题栏上方）
        if self._pad:
            r = getattr(self, "_bind_ok_rect", None)
            if r is not None and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                self._confirm_bind()
                return
            r = getattr(self, "_bind_input_rect", None)
            if r is not None and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
                self._focus_bind_input()
                return
        # 标题栏那颗【关联变更】
        r = getattr(self, "_bind_btn_rect", None)
        if r is not None and r[0] <= e.x <= r[2] and r[1] <= e.y <= r[3]:
            self._toggle_bind_bar()
            return
        # 标题栏那颗「收回」
        cr = getattr(self, "_collapse_rect", None)
        if cr is not None and cr[0] <= e.x <= cr[2] and cr[1] <= e.y <= cr[3]:
            self._toggle_expand(self._expanded)
            return
        # 每次按下先把屏幕布局重新读一遍：拖动前插/拔显示器也能立刻生效
        self._sync_screens()
        # 麦克风图标画在玻璃里，不在 Canvas 上单独建控件；点它不能当拖窗
        mx, my = self._geo.mic_pos
        if abs(e.x - (mx + MIC_SIZE // 2)) <= 22 and abs(e.y - (my + MIC_SIZE // 2)) <= 22:
            self._toggle_mic()
            return
        x0, y0, x1, y1, _r = self._geo.input_shape
        if x0 <= e.x <= x1 and y0 <= e.y <= y1:
            self._input_press(e)
            return
        mode = self._edge_at(e.x, e.y)
        if mode:
            self._resize = (mode, e.x_root, e.y_root,
                            self.root.winfo_x(), self.root.winfo_y(),
                            self.root.winfo_width(), self.root.winfo_height())
            self._drag = None
            self._preview_size = (0, 0)
            self._pause.set()
            return
        self._drag = (e.x_root - self.root.winfo_x(),
                      e.y_root - self.root.winfo_y())
        self._press_root = (e.x_root, e.y_root)
        self._applied_x = self.root.winfo_x()
        self._applied_y = self.root.winfo_y()
        # 拖动期间**停掉抓屏线程**：背景只是"窗后面那张模糊"，跟着手走的是窗口本身，
        # 不需要每帧重抓重合成。以前这里不停，一次拖动就是几十次全窗抓屏+合成，
        # 用户体感就是掉帧（2026-11-05 实报）。松手后 `_release` 再恢复。
        self._pause.set()
        if self._collapsed:
            self._start_drag_grab()

    def _motion(self, e):
        if getattr(self, "_sel_drag", False):
            self._input_select_to(e.x)
            return
        if self._resize:
            mode, sx, sy, x0, y0, w0, h0 = self._resize
            dx, dy = e.x_root - sx, e.y_root - sy
            nw, nh, nx, ny = w0, h0, x0, y0
            # 缩放边界 = 虚拟桌面（多显示器），不是主屏
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            if "e" in mode:
                nw = max(MIN_W, min(max(MIN_W, vx + vw - x0), w0 + dx))
            if "w" in mode:
                nw = max(MIN_W, min(max(MIN_W, x0 + w0 - vx), w0 - dx))
                nx = x0 + w0 - nw
            if "s" in mode:
                nh = max(MIN_H, min(max(MIN_H, vy + vh - y0), h0 + dy))
            if "n" in mode:
                nh = max(MIN_H, min(max(MIN_H, y0 + h0 - vy), h0 - dy))
                ny = y0 + h0 - nh
            nx = max(vx, min(nx, max(vx, vx + vw - nw)))
            ny = max(vy, min(ny, max(vy, vy + vh - nh)))
            # 合并尺寸变更：鼠标事件 ~100Hz，而分层窗口改一次尺寸本身就要几十毫秒。
            # 每次都发 `geometry` 只会让队列越堆越长 —— 表现是"帧率看着有 20，但窗口落后手 1 秒"
            # （2026-11-05 实报）。这里按 60ms 合并：丢掉中间帧，永远应用最新的目标尺寸。
            self._resize_target = (nw, nh, nx, ny)
            now = time.time()
            if now - getattr(self, "_resize_apply_at", 0.0) >= 0.06:
                self._resize_apply_at = now
                self.root.geometry(f"{nw}x{nh}+{nx}+{ny}")
                if now - self._preview_at >= 0.04:
                    self._preview_at = now
                    self._preview_resize(nw, nh)
            return
        if self._drag:
            # 记一次"真的拖过"：`_edit_title` 靠它把「拖完再点一下」排除在双击之外。
            pr = getattr(self, "_press_root", None)
            if pr and max(abs(e.x_root - pr[0]), abs(e.y_root - pr[1])) > 3:
                self._drag_moved_at = time.time()
            # 拖到屏幕外时窗口坐标会变负，抓屏区域随之越界（高度算出负数），
            # 背景永远画不出来 —— 表现为花屏。必须钳位。
            # 边界是虚拟桌面而不是主屏：第二块屏在主屏左边时坐标本来就是负的，
            # 老代码 max(0, …) 等于把窗口钉死在一块屏里。
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            nx = e.x_root - self._drag[0]
            ny = e.y_root - self._drag[1]
            nx = max(vx, min(nx, max(vx, vx + vw - self.root.winfo_width())))
            ny = max(vy, min(ny, max(vy, vy + vh - self.root.winfo_height())))
            self._drag_target = (nx, ny)
            if self._collapsed:
                # 手拖时鼠标事件是上百 Hz、每步可能只有 1px；半透明条里内容钉在桌面上，
                # 窗口 1px 抖一下、内容反向抖一下，看起来就是"抖动被放大"。
                # 只吃掉 1px 的抖动：不合并、不节流 —— 骤然加速时每个事件都立刻应用，
                # 否则窗口会比手慢半拍（2026-11-06 实报「加速拖动还是有延迟」）。
                if (abs(nx - getattr(self, "_applied_x", nx)) < 2
                        and abs(ny - getattr(self, "_applied_y", ny)) < 2):
                    return
            self.root.geometry(f"+{nx}+{ny}")
            self._applied_x, self._applied_y = nx, ny
            if self._collapsed:
                self._move_collapsed_backdrop(nx, ny)

    def _release(self, e):
        t0 = time.perf_counter()
        if getattr(self, "_sel_drag", False):
            # 鼠标框选结束：把选区推进隐藏 Entry，后续打字才能整段替换
            self._sel_drag = False
            sel = getattr(self, "_sel", None)
            if sel:
                try:
                    self._entry.selection_range(sel[0], sel[1])
                    self._entry.icursor(sel[1])
                except Exception:
                    pass
        if self._resize:
            target = getattr(self, "_resize_target", None)
            if target:
                # 合并节流会丢掉最后一帧，松手时把最终尺寸补上
                self.root.geometry(f"{target[0]}x{target[1]}+{target[2]}+{target[3]}")
            self._resize = None
            self._resize_target = None
            self._resize_apply_at = 0.0
            self._preview_at = 0.0
            self._preview_size = (0, 0)
            self.root.update_idletasks()
            t1 = time.perf_counter()
            self._rebuild(max(MIN_W, self.root.winfo_width()),
                          max(MIN_H, self.root.winfo_height()))
            t2 = time.perf_counter()
            self._sync_pos()
            if not self._collapsed:
                # 展开态拖边改的就是用户态高度：先更新 `_saved_h` 再记账（收起态
                # 拖边只是这次气泡的封顶高度 `_notif_cap_override`，不动用户态高度）
                pad = getattr(self, "_pad", 0)
                self._saved_h = max(MIN_H, self.root.winfo_height() - pad)
                if pad:
                    # 输入行开着时拖边：关输入行要回到同一个用户态高度
                    self._base_h = self._saved_h
            self._save_geometry()     # 拖完就记账：下次重启（插件拉起也算）回到同一处
            if self._collapsed:
                # 收起态手动拖高了：这一次的气泡按拖出来的高度重排（不写回展开高度）
                self._notif_cap_override = max(200, self.root.winfo_height())
                if getattr(self, "_notif_msg", None) is not None:
                    try:
                        self._layout_notification()
                    except Exception:
                        pass
            self._hover(e)
            if TRACE:
                print(f"[trace] release idle={(t1 - t0) * 1000:.1f}ms "
                      f"rebuild={(t2 - t1) * 1000:.1f}ms "
                      f"tail={(time.perf_counter() - t2) * 1000:.1f}ms",
                      flush=True)
            return
        # 拖动结束：恢复抓屏线程，让它按新位置重新抓背景
        target = getattr(self, "_drag_target", None)
        self._drag = None
        if target is not None and self._collapsed:
            try:                       # 合并/死区可能吞掉最后几帧，松手补到最终位置
                self.root.geometry(f"+{target[0]}+{target[1]}")
            except Exception:
                pass
        self._sync_pos()
        self._save_geometry()
        self._pause.clear()
        if self._collapsed:
            self._refresh_collapsed(force=True)

    def _escape(self, _e=None):
        """Esc：先关图片预览，再按原逻辑（收输入行 / 关窗）。"""
        if self._viewer_alive():
            self._close_viewer()
            return "break"
        return self._close()

    def run(self):
        self.root.bind("<Escape>", self._escape)
        self.root.after(1000, self._price_tick)     # 价格时段标签：跨期/倒计时
        self.root.bind("<MouseWheel>", self._wheel)
        # 焦点不在输入框时也能贴图（root 级兜底；Entry 有焦点时走 Entry 那条）
        self.root.bind("<Control-v>", self._paste_image)
        self.root.bind("<Control-V>", self._paste_image)
        self.root.bind("<Motion>", self._hover, add="+")
        self.root.bind("<Leave>", self._leave, add="+")
        self.root.bind("<ButtonPress-1>", self._press, add="+")
        self.root.bind("<Button-3>", self._img_menu_open, add="+")
        self.root.bind("<B1-Motion>", self._motion, add="+")
        self.root.bind("<ButtonRelease-1>", self._release, add="+")
        # 输入光标闪烁（2026-11-06：用户说光标太不显眼）
        try:
            self.root.after(520, self._caret_tick)
        except Exception:
            pass
        self.root.mainloop()


if __name__ == "__main__":
    LiveGlass().run()
