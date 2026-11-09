"""window_widgets.py — 悬浮窗里与「窗口」无关的三块逻辑。

这里是纯数据/绘制辅助，不碰窗口生命周期、不碰渲染管线：

    Fonts       tkfont.Font 缓存（每帧新建几百个 Tcl 对象既慢又泄引用）
    ChatFeed    chat.jsonl 的增量视图（消息、去重滚动、meta 状态行）
    TextLayer   Canvas 上的逐字文字 + 按背后明暗单独翻色

拆出来的原因只有一个：`window.py` 原来 1900 行里，这三块和「拖动/缩放/渲染
状态机」混在一起，改一个阈值要在同一文件里翻三遍。
"""
import json
import time
from pathlib import Path

import numpy as np
import tkinter.font as tkfont
from PIL import Image

from glass_geometry import MESSAGE_SLOTS

FONT = "Microsoft YaHei UI"


def clock(ms) -> str:
    """毫秒时间戳 → HH:MM:SS；坏值返回空串（气泡上方那行小字）。"""
    try:
        return time.strftime("%H:%M:%S", time.localtime(float(ms) / 1000.0))
    except (TypeError, ValueError, OSError):
        return ""


# ---------------------------------------------------------------- 字体缓存

class Fonts:
    """`tkfont.Font` 是个 Tcl 对象：每帧新建几百个既慢又漏 Tcl 引用。按尺寸缓存。"""

    def __init__(self, root):
        self.root = root
        self._cache: dict = {}

    def spec(self, size: int, bold: bool = False) -> tuple:
        return (FONT, size, "bold") if bold else (FONT, size)

    def get(self, size: int, bold: bool = False) -> tkfont.Font:
        key = (size, bold)
        hit = self._cache.get(key)
        if hit is None:
            hit = tkfont.Font(root=self.root, font=self.spec(size, bold))
            self._cache[key] = hit
        return hit


# ---------------------------------------------------------------- 聊天流

class ChatFeed:
    """chat.jsonl 的增量视图：消息、去重、(role,text,at) 游标、meta 状态行。

    2026-11-06：一条流里现在混着多个会话的记录（每条带 `sid`）。主窗只显示
    `sid` 等于当前绑定会话的那些；换绑时 `set_sid()` 会整份重读。
    """

    KEEP = 200          # 内存里留多少条
    SEEN = 2000         # 去重集合上限
    READ_LINES = 4000   # 重读时最多看多少行（历史分组也是从这几行里数的）

    def __init__(self, path: Path, sid: str = ""):
        self.path = path
        self.sid = sid or ""
        self.messages: list[dict] = []
        self.status = ""
        self.offset = 0          # 相对最新一条的滚动量
        self._seen: set = set()
        self._pos = 0

    # ---- 解析 ----

    @staticmethod
    def parse(line: str) -> dict | None:
        line = (line or "").strip()
        if not line:
            return None
        try:
            raw = json.loads(line)
        except Exception:
            return None
        text = raw.get("text")
        role = raw.get("role") or ("meta" if raw.get("type") == "meta" else "assistant")
        sid = str(raw.get("sid") or "")
        # meta 行是宿主/麦克风状态（叫醒失败、录音状态），不是聊天内容：不进气泡，
        # 放到标题栏下面那行状态里，别把四条消息挤掉。
        if role == "meta":
            return {"role": "meta", "text": str(text or ""), "stamp": "",
                    "at": raw.get("at"), "sid": sid}
        # 居中「系统提示」气泡（绑定变更公告）；和 meta 一样不是聊天内容，
        # 但它要占一条、要显示，所以按消息收进流里。
        if role == "notice":
            if not isinstance(text, str) or not text.strip():
                return None
            return {"role": "notice", "text": text.strip(), "stamp": "",
                    "at": raw.get("at"), "sid": sid}
        if not isinstance(text, str) or not text:
            return None
        return {"role": role, "text": text,
                "stamp": clock(raw.get("at")) if raw.get("at") is not None else "",
                "at": raw.get("at"), "sid": sid}

    def admit(self, msg: dict | None) -> bool:
        """这条归不归当前会话：meta 行不参与分组，其余必须 `sid` 对上。"""
        if not msg:
            return False
        if msg.get("role") == "meta":
            return True
        if not self.sid:
            return True          # 没绑会话：保持旧行为，全显示
        return msg.get("sid") == self.sid

    def add(self, msg: dict | None) -> bool:
        if not self.admit(msg):
            return False
        key = (msg.get("role"), msg.get("text"), msg.get("at"), msg.get("sid"))
        if key in self._seen:
            return False
        self._seen.add(key)
        if len(self._seen) > self.SEEN:
            self._seen = set(list(self._seen)[-int(self.SEEN * 0.6):])
        if msg.get("role") == "meta":
            self.status = str(msg.get("text") or "")[:80]
            return True
        self.messages.append(msg)
        if len(self.messages) > self.KEEP:
            self.messages = self.messages[-self.KEEP:]
        return True

    # ---- 读取 ----

    def set_sid(self, sid: str) -> bool:
        """换绑：整份重读。返回是否真的变了（调用方据此决定要不要重排）。"""
        sid = sid or ""
        if sid == self.sid:
            return False
        self.sid = sid
        self.reload()
        return True

    def reload(self) -> None:
        """重读最近若干行（文件被清短 / 首次加载 / 换绑）。"""
        self.messages = []
        self._seen.clear()
        self._pos = 0
        self.offset = 0
        self.status = ""
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()[-self.READ_LINES:]
            for line in lines:
                self.add(self.parse(line))
            self._pos = self.path.stat().st_size
        except Exception:
            self._pos = 0

    def poll(self) -> bool:
        """增量读；返回是否有变化。"""
        try:
            size = self.path.stat().st_size
        except OSError:
            return False
        if size < self._pos:
            self.reload()
            return True
        if size == self._pos:
            return False
        with open(self.path, "r", encoding="utf-8") as f:
            f.seek(self._pos)
            data = f.read()
            self._pos = f.tell()
        changed = False
        for line in data.splitlines():
            if self.add(self.parse(line)):
                changed = True
        if changed:
            if self.offset > 0:
                self.offset += len(data.splitlines())
            self.offset = max(0, min(self.offset, max(0, len(self.messages) - MESSAGE_SLOTS)))
        return changed

    # ---- 视图 ----

    def visible(self) -> list[dict]:
        total = len(self.messages)
        n = min(MESSAGE_SLOTS, total)
        start = max(0, total - n - self.offset)
        return self.messages[start:start + n]

    def scroll(self, step: int) -> bool:
        if not self.messages:
            return False
        top = max(0, len(self.messages) - MESSAGE_SLOTS)
        new = max(0, min(top, self.offset + step))
        if new == self.offset:
            return False
        self.offset = new
        return True


# ---------------------------------------------------------------- 文字层

class TextLayer:
    """Canvas 上的文字：逐字建 item，按每个字背后的明暗单独翻色。

    为什么逐字：玻璃背后是桌面/视频，同一行里可能左半在暗处右半在亮处，
    整行一个颜色必然有一半看不清。代价是 item 多，所以采样要快 —— 见 `adapt()`。
    """

    COLOR_LIGHT = "#f2f8ff"
    COLOR_DARK = "#07111d"

    def __init__(self, root, canvas, fonts: Fonts):
        self.root = root
        self.canvas = canvas
        self.fonts = fonts
        self.items: list[int] = []
        self._colors: dict = {}
        self._pending: dict = {}
        self._fixed: set = set()     # 有底板的文字：颜色不跟背景走
        self._at = 0.0

    def refresh(self) -> None:
        # 描边是另建的一层 item，翻色不能把它也算进去（会跟着一起变色）
        shadow = set(self.canvas.find_withtag("tshadow"))
        self.items = [i for i in self.canvas.find_all()
                      if i not in shadow and self.canvas.type(i) == "text"]

    def reset(self) -> None:
        self.items = []
        self._colors.clear()
        self._pending.clear()
        self._fixed.clear()
        self._at = 0.0

    # ---- 绘制 ----

    def draw(self, x, y, text, anchor="center", fill=COLOR_LIGHT,
             size=11, bold=False, max_width=None, tags=(), shadow=False,
             adapt=True, per_char=True) -> None:
        """按字符拆开建 item；anchor 支持 w/e/center 与 n/s 变体。

        `shadow=True` 时每个字先落一层描边：**四个方向各偏移 1px** 的深色副本。
        原来只有右下 1px，等于投影 —— 背景是浅色视频时右下那条边不够，字看起来
        还是浮在水里（#44 第 2 条）。四方向才是真的描边，成本是每字多 3 个 item。
        `adapt=False` 表示这块字有自己的底板，颜色固定、不参与 `adapt()` 采样。

        `per_char=False`：整行一个 item（不逐字）。气泡文字压在纯色底板上时
        不需要按背后明暗翻色，逐字只会把 item 数放大十几倍 —— 滚动时重建几百个
        text item 就是 100~300ms 的卡顿（2026-11-05 实测）。
        """
        font = self.fonts.get(size, bold)
        measure = font.measure
        linespace = font.metrics("linespace")
        if max_width is not None:
            lines, cur = [], ""
            for ch in text:
                if not cur or measure(cur + ch) <= max_width:
                    cur += ch
                else:
                    lines.append(cur)
                    cur = ch
            lines.append(cur)
        else:
            lines = [text]
        top = anchor in ("n", "nw", "ne")
        right = anchor in ("e", "ne", "se")
        center = anchor in ("center", "n", "s")
        height = font.metrics("ascent") + font.metrics("descent")
        spec = self.fonts.spec(size, bold)
        base_tags = tags if isinstance(tags, tuple) else ((tags,) if tags else ())
        shadow_tags = base_tags + ("tshadow",) if shadow else ()
        stroke = ((-1, 0), (1, 0), (0, -1), (0, 1)) if shadow else ()
        for row, line in enumerate(lines):
            width = measure(line)
            lx = x - width if right else (x - width / 2 if center else x)
            ly = (y + row * linespace + height / 2 if top
                  else y + (row - (len(lines) - 1) / 2) * linespace)
            if not per_char:
                # 整行一个 item：气泡有底板时够用，item 数从「每字 5 个」降到「每行 1 个」
                for dx, dy in stroke:
                    self.canvas.create_text(lx + dx, ly + dy, text=line, anchor="w",
                                            fill=self.COLOR_DARK, font=spec,
                                            tags=shadow_tags)
                item = self.canvas.create_text(lx, ly, text=line, anchor="w",
                                               fill=fill, font=spec, tags=tags)
                if not adapt:
                    self._fixed.add(item)
                continue
            # 累积宽度，别对每个字重新 measure 前缀（那是 O(n²) 次 Tcl 调用）
            cx = lx
            for ch in line:
                for dx, dy in stroke:
                    self.canvas.create_text(cx + dx, ly + dy, text=ch, anchor="w",
                                            fill=self.COLOR_DARK, font=spec,
                                            tags=shadow_tags)
                item = self.canvas.create_text(cx, ly, text=ch, anchor="w",
                                               fill=fill, font=spec, tags=tags)
                if not adapt:
                    self._fixed.add(item)
                cx += measure(ch)

    # ---- 翻色 ----

    def adapt(self, frame: Image.Image | None) -> None:
        """按文字背后的暗部/亮部比例选色。

        **必须带滞回**：气泡是透明的，背后就是桌面/视频/网页。画面一动，这块
        背景的中位亮度就在 0.5 附近来回穿越；原来是 `p50 < 0.50` 硬切、每 0.12 秒
        判一次，结果字一秒能翻七八次黑白，肉眼就是「一直闪」。

        两道闸：
        1. **滞回**：白的要暗到 0.38 才翻深，深的要亮到 0.62 才翻白；
        2. **连续两次同向才切**：单帧跳变忽略，最坏 0.24 秒换一次色。
        """
        if frame is None or not self.items:
            return
        now = time.time()
        if now - self._at < 0.12:
            return
        self._at = now
        gray = np.asarray(frame.convert("L"))
        h, w = gray.shape[:2]
        for item in self.items:
            if item in self._fixed:      # 有底板的字：颜色固定，别跟着画面翻
                continue
            box = self.canvas.bbox(item)
            if not box:
                continue
            x0, y0 = max(0, box[0] - 2), max(0, box[1] - 2)
            x1, y1 = min(w, box[2] + 2), min(h, box[3] + 2)
            if x1 <= x0 or y1 <= y0:
                continue
            patch = gray[y0:y1, x0:x1]
            p50 = float(np.percentile(patch, 50)) / 255.0
            dark = float(np.mean(patch < 107))
            light = float(np.mean(patch > 158))
            cur = self._colors.get(item)
            if dark > light + 0.08:
                want = self.COLOR_LIGHT
            elif light > dark + 0.08:
                want = self.COLOR_DARK
            elif cur == self.COLOR_DARK:
                want = self.COLOR_LIGHT if p50 < 0.38 else cur
            else:
                want = self.COLOR_DARK if (cur is not None and p50 > 0.62) else (cur or self.COLOR_LIGHT)
            if want == cur:
                self._pending.pop(item, None)
                continue
            if self._pending.get(item) != want:
                self._pending[item] = want       # 第一次：只记下，不换
                continue
            self._pending.pop(item, None)
            self.canvas.itemconfigure(item, fill=want)
            self._colors[item] = want


