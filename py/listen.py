#!/usr/bin/env python3
"""listen.py — 听"电脑正在放什么"，断句，落成 16k 单声道 WAV。

## 它解决什么

see-now 抓的是**屏幕**（ddagrab / gdigrab），那条管道 `-an`，**没有音频轨**。
所以"视频里的人在说什么"必须另外抓一路 —— 抓系统输出的回环（WASAPI loopback），
不是麦克风（那是用户自己在说话，见 `mic.py`，两条流互不相干）。

## 为什么是 pyaudiowpatch，不是 sounddevice / soundcard

实测（Win11 + Realtek，2026-11-04）：

  · `soundcard` 的 loopback 两个端点、四组采样率**恒返回 0**（物理麦克风同库正常）；
  · `sounddevice`（PortAudio 原生）的 WASAPI host API 里**根本没有 loopback 设备**
    —— 官方 PortAudio 不暴露，只有 pyaudiowpatch 那个 fork 打了补丁；
  · `pyaudiowpatch` 直接列出 `扬声器/耳机 (...) [Loopback]`，不需要装任何虚拟声卡。

ffmpeg 的 dshow 也走不通：这台机器 dshow 枚举不到"立体声混音"（注册表里有、设备管理器
也显示启用，但 dshow 就是看不到）。

## 三个必须守住的点（都是踩过的）

1. **静音段 WASAPI loopback 不推送数据**（实测 3 秒静音 callback 触发 0 次）。
   所以时间码只能来自**每块到达的 wall clock**，绝不能拿样本数累加 —— 否则静音 10 秒后
   一开口，字幕整体漂 10 秒。
2. **先混单声道再降采样**。把 `reshape(-1, 3).mean()` 一步做完会因双声道相位抵消，
   ASR 只认出"嗯。"。顺序必须是 `reshape(-1, ch).mean(1)` → 3 点箱式平均。
3. **它听得见自己**。AI 用 TTS 念台词 → 音箱出声音 → 回环收回去 → 转成"视频里的台词"。
   所以每段落盘前查一次 `quiet-until.json`（`say` / `cue` 念之前会占住这个窗口）。

## 用法

    python listen.py --out ~/.dsh/see-now/audio
    python listen.py --out ... --device "耳机 (Realtek(R) Audio) [Loopback]"
    python listen.py --out ... --list-devices
    python listen.py --out ... --silence 0.35 --max-seg 8

依赖：`pip install pyaudiowpatch numpy`。装不上就退出码 2，上层据此静默降级（只看图，无字幕）。

输出：每句话一个 `seg-<epochMs>.wav`（16k 单声道 PCM16），`epochMs` 是**这句话开头**的
墙上时间 —— 这是全链路唯一的时间码来源，Node 侧靠它把台词对到画面帧上。
"""

import argparse
import collections
import json
import os
import queue
import signal
import sys
import time
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import numpy as np
except ImportError:
    sys.stderr.write("缺 numpy：pip install numpy\n")
    raise SystemExit(2)

try:
    import pyaudiowpatch as pa
except ImportError:
    sys.stderr.write("缺 pyaudiowpatch：pip install pyaudiowpatch\n")
    raise SystemExit(2)


# 目标格式。16k 单声道是 ASR（paraformer / SenseVoice）的标准输入。
SR = 16000

# pid 文件（放在 --out 目录里）。上层（src/listen.js）杀进程靠它兜底：
# Windows 上 node 拿到的 pid 是 venv launcher，关窗那条路上引用还可能丢 ——
# 让录音进程自己把"我是谁"写下来，比让 Node 记着更可靠。
PID_FILE = "listen.pid"


def write_pid_file(out_dir):
    try:
        path = os.path.join(out_dir, PID_FILE)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(),
                       "script": os.path.basename(__file__),
                       "at": int(time.time() * 1000)}, f)
        return path
    except OSError:
        return None


def remove_pid_file(path):
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    """给 Node 侧的一行 JSON（诊断用；真正的产物是磁盘上的 wav）。"""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def watch_out_dir():
    explicit = os.environ.get("WATCH_OUT") or os.environ.get("DSH_WATCH_OUT")
    if explicit:
        return explicit
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "watch", "out")


QUIET_FILE = os.environ.get("DSH_QUIET_FILE") or os.path.join(watch_out_dir(), "quiet-until.json")


def quiet_until_ms():
    """静音窗口到什么时候（epoch ms）。0 = 没有窗口。"""
    try:
        with open(QUIET_FILE, "r", encoding="utf-8") as f:
            return float(json.load(f).get("until") or 0)
    except Exception:
        return 0.0


def tts_busy(at_ms=None):
    """这一段里有没有 AI 自己的声音。

    `at_ms` 给了就按**段的时间窗**判（起点落在窗口内 = 这段被污染），
    不给就按"此刻"判。**为什么不能只看此刻**：段落盘发生在说完之后，
    一句话正好跨过窗口末尾时，"此刻"已经出了窗口，但它的前半段还是 AI 的声音
    （实测：窗口还剩 0.25 秒时落盘，整段被当成视频台词收了进去）。
    """
    until = quiet_until_ms()
    if not until:
        return False
    if at_ms is None:
        return time.time() * 1000 < until
    return at_ms < until


def list_devices():
    p = pa.PyAudio()
    try:
        rows = []
        try:
            default = p.get_default_wasapi_loopback()
        except Exception:
            default = None
        for d in p.get_loopback_device_info_generator():
            rows.append({
                "name": d["name"],
                "rate": int(d["defaultSampleRate"]),
                "channels": int(d["maxInputChannels"]),
                "default": bool(default and d["name"] == default["name"]),
            })
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    finally:
        p.terminate()


def pick_device(p, want=None):
    """选回环设备。`want` 给了就按名字子串找（用户可能有多块声卡）。"""
    if want:
        for d in p.get_loopback_device_info_generator():
            if want.lower() in d["name"].lower():
                return d
        raise SystemExit(f"找不到名字含「{want}」的回环设备（用 --list-devices 看看有哪些）")
    try:
        return p.get_default_wasapi_loopback()
    except Exception:
        for d in p.get_loopback_device_info_generator():
            return d
        raise SystemExit("这台机器没有可用的回环设备（WASAPI loopback 一个都没列出来）")


class Segmenter:
    """能量 VAD 断句器。输入是 16k 单声道 float 块，输出是"一段话"。

    为什么不用固定窗：固定 3 秒会把词切在两半（"第一个维" / "度是技术"），
    ASR 两边都识别成残句。按静音断句，一段就是一个完整的句子或一口气。

    为什么保留预卷：人开口的第一个字音量往往还没起来，纯按阈值切会把首字削掉。
    预卷 `pre` 秒是"从判定有声往前多拿一点"。
    """

    def __init__(self, silence=0.35, max_seg=3.0, pre=0.25, min_seg=0.5, thr=0.0035,
                 live_min=1.8, live_step=1.2):
        self.silence = silence
        self.max_seg = max_seg
        self.pre = pre
        self.min_seg = min_seg
        self.thr = thr
        # 「边说边出字幕」：说满 live_min 秒先给一版快照，之后每 live_step 秒刷新。
        # live_min <= 0 = 关掉（只用整句）。
        self.live_min = live_min
        self.live_step = live_step
        self.last_live_span = 0.0
        self.pre_buf = collections.deque()     # (wall, block)，只留 pre 秒
        self.in_speech = False
        self.cur = []                          # [(wall, block)]
        self.start_wall = 0.0
        self.silence_run = 0.0
        self.last_loud_wall = 0.0

    def _pre_len(self):
        return sum(len(b) for _, b in self.pre_buf) / SR

    def push(self, wall, block):
        """喂一块（约 21ms）。返回要落盘的 [(t0, np.ndarray)]（通常是 0 或 1 个）。"""
        n = len(block)
        if n == 0:
            return []
        dur = n / SR
        rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
        loud = rms > self.thr

        if not self.in_speech:
            self.pre_buf.append((wall, block))
            while self._pre_len() > self.pre:
                self.pre_buf.popleft()
            if not loud:
                return []
            # 开口：把预卷一起收进来，起点按预卷第一块的时刻算
            self.in_speech = True
            self.cur = list(self.pre_buf)
            self.start_wall = self.cur[0][0] if self.cur else wall
            self.pre_buf.clear()
            self.silence_run = 0.0
            self.last_loud_wall = wall
            return []

        self.cur.append((wall, block))
        if loud:
            self.silence_run = 0.0
            self.last_loud_wall = wall
        else:
            self.silence_run += dur

        span = wall - self.start_wall
        if self.silence_run >= self.silence or span >= self.max_seg:
            return self._close()
        return []

    def tick(self, now):
        """静音期**没有数据块**（WASAPI loopback 不推送），只能靠墙上时间判"说完了"。

        没有这个 tick，一句话会一直挂到 `max_seg` 强切 —— 实测 12 秒连续语音只出
        1 段 6 秒的，后 6 秒要等下一次开口才补出来。
        """
        if not self.in_speech:
            return []
        if now - self.last_loud_wall >= self.silence:
            return self._close()
        return []

    def snapshot(self):
        """**这句说到目前的音频**（「边说边出字幕」用）。

        为什么要有：长句要等 `max_seg`（3 秒）强切才送去转写，而本地 paraformer
        转 1.8 秒音频只要 150ms —— **等断句的时间是转写本身的 20 倍**。
        说满 `live_min` 秒就先给一版，让字幕早几秒出现；整句落盘后 Node 侧会用
        准确结果把它覆盖掉（`upsert`），所以这一版**永远只是临时的**。

        节流在内部，调用方可以每块都调。`live_min <= 0` 直接关掉。
        """
        if not self.in_speech or self.live_min <= 0 or self.live_step <= 0:
            return []
        if not self.cur:
            return []
        # 用"最后一块的到达时刻 + 块时长"算，不用 time.time() —— 主循环调度抖动不该算进来
        wall, block = self.cur[-1]
        span = wall + len(block) / SR - self.start_wall
        if span < self.live_min:
            return []
        if self.last_live_span > 0 and span - self.last_live_span < self.live_step:
            return []
        self.last_live_span = span
        # 尾部静音**不 trim**：这句还没说完，trim 会把正在说的字削掉
        audio = np.concatenate([b for _, b in self.cur])
        return [(self.start_wall, audio)]

    def flush(self):
        """退出时把没说完的那半句也交出来（够长才要）。"""
        if self.in_speech:
            return self._close()
        return []

    def _close(self):
        frames = self.cur
        self.cur = []
        self.in_speech = False
        self.silence_run = 0.0
        self.last_live_span = 0.0
        self.pre_buf.clear()
        if not frames:
            return []
        # 尾巴的静音不要（ASR 对纯静音会吐"嗯。"这种幻觉）
        keep_until = self.last_loud_wall + 0.12
        trimmed = [(w, b) for w, b in frames if w <= keep_until]
        if not trimmed:
            return []
        audio = np.concatenate([b for _, b in trimmed])
        if len(audio) / SR < self.min_seg:
            return []
        return [(self.start_wall, audio)]


def write_wav(path, audio):
    """**先写 .tmp 再 rename**：Node 侧是扫目录取文件的，读到写了一半的 wav 会让
    转写服务直接报错（host 那边只认完整长度）。rename 在同一个盘上是原子的。"""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    tmp = f"{path}.tmp"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


class LevelMeter:
    """每 `step` 秒一个格子的响度（dBFS），给图底下的音量条用。

    **按时间格子存，不按"有数据才写"**：WASAPI loopback 静音时一个字节都不推，
    照数据写出来的序列在时间轴上是断的 —— 画成条就是"柱子之间一片黑"。
    所以静音格子显式补 -120dB，时间轴才连续。

    顺手做的理由：这段音频**本来就要过一遍**（算 RMS 断句），
    再加一次 `20log10` 几乎没有成本。不用像 storyboard 那样再开一次 ffmpeg 跑 ebur128。
    """

    def __init__(self, step=0.1, keep=180.0):
        self.step = step
        self.keep = keep
        self.t0 = None
        self.grid = {}

    def push(self, wall, block):
        if self.t0 is None:
            self.t0 = wall
        if len(block) == 0:
            return
        idx = int((wall - self.t0) / self.step)
        peak = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
        if peak > self.grid.get(idx, 0.0):
            self.grid[idx] = peak
        # 修剪：只留 keep 秒
        span = int(self.keep / self.step)
        if len(self.grid) > span + 40:
            cut = idx - span
            for k in [k for k in list(self.grid) if k < cut]:
                del self.grid[k]

    def snapshot(self):
        if self.t0 is None or not self.grid:
            return None
        lo, hi = min(self.grid), max(self.grid)
        db = []
        for i in range(lo, hi + 1):
            v = self.grid.get(i)
            db.append(-120.0 if v is None else round(20.0 * np.log10(max(v, 1e-6)), 1))
        return {"step": self.step, "from": int((self.t0 + lo * self.step) * 1000), "db": db}


def write_levels(path, meter):
    """原子写。读的一方（Node）随时可能在读，不能让它看到半个 JSON。"""
    snap = meter.snapshot()
    if not snap:
        return
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        pass


class AcousticMeter:
    """每 0.05 秒一格的声音指纹 —— 回答「这段是什么声音」，而不只是「有没有字」。

    ## 为什么在 Python 侧算

    只有这里拿得到原始 PCM；Node 那边只见过已经转成文字的台词。而这段音频本来就要
    过一遍（断句要算 RMS），再加一次 1600 点 rfft 是免费的（20 次/秒，numpy 下可忽略）。

    ## 为什么 0.05 秒一格、0.1 秒窗

    两个都被实测逼出来的：

    · **0.1 秒一格测不出节拍**。90 BPM 的周期是 6.67 格，整数格上取峰值只能报成 85.7；
      20Hz 之后是 13.33 格，抛物线插值能落到 ±2 BPM。120 BPM 本来是 5 格（能中），
      但它跟别的 BPM 共享同一套格子，不能为它单独调。
    · **不重叠的窗会把瞬态削掉**。Hann 窗两端是 0，一个 15ms 的鼓点正好落在帧边界时，
      前后两帧都几乎看不见它 —— 实测整段节拍器的 onset 全是 0。50% 重叠（0.1s 窗、0.05s hop）
      保证任何瞬态至少落在某一窗的中段。

    ## 为什么全是比值

    上一次音频层人声判定就是死在绝对 dB 上：同一个判据在 −25dB 的片子上 8/8 正确、
    在 −48dB 的片子上把 13 段真人讲解全杀了。这里的量没有一个依赖绝对响度：

      · 质心按 Nyquist 归一；
      · 频带能量除以**本帧**总能量；
      · 平坦度是几何均值 / 算术均值；
      · onset 除以本帧谱和。

    增益只改整体幅度，不改这些比值 —— 所以它天然对系统音量不敏感。**实现上也别再往回加
    绝对值判据**，要判「像不像人声」得用窗口内自比（B 层的事），不是这里的阈值。

    ## 缺数据 vs 静音

    WASAPI loopback 静音时**一个字节都不推**。所以「没有格子」和「一格子静音」是两回事：
    缺格写 `None` 并计入 `gaps`，静音格子是真实的 −120dB。上层要能分开（测试清单那条）。
    """

    def __init__(self, hop=0.05, window=0.1, keep=90.0, tempo_span=12.0):
        self.hop = float(hop)
        self.hop_n = max(64, int(round(SR * self.hop)))
        self.win_n = max(self.hop_n * 2, int(round(SR * float(window))))
        self.keep = float(keep)
        self.t0 = None                 # 第一块的墙上时间（epoch 秒）
        self.consumed = 0             # 已经吃掉多少个样本（绝对，从 t0 算）
        self.base_idx = 0              # rows[0] 对应的绝对格子号（修剪后仍然对得上时间）
        self.next_idx = 0              # 下一个要写的绝对格子号
        self.rows = []                 # 每格特征列表，或 None（缺数据）
        self.acc = np.zeros(0, dtype=np.float32)
        self.last_data = 0.0
        self.prev_mag = None
        self.gaps = 0
        self.last_gap_ms = None
        self.tempo = None
        # onset 序列按格子存（缺格补 0）—— 断档后不补 0 的话，自相关会跨着几十秒空白算
        self.onsets = collections.deque(maxlen=max(60, int(round(tempo_span / self.hop))))
        self.flushed = 0
        self._win = np.hanning(self.win_n).astype(np.float32)
        self._freqs = np.fft.rfftfreq(self.win_n, 1.0 / SR)
        # 频带：低频轰鸣 / 人声带 / 冲击。
        # · lo 从 40Hz 起，不是 80：实测样本（BV1rop26FEZf）66% 的能量在 80Hz 以下，
        #   从 80 起算会让"以低频为主"这种话永远说不出来。40Hz 以下（27%）留给噪声/隆隆，
        #   人耳基本听不到，也不该算进"这段是什么声音"。
        # · hi 上限取 6.8k —— 降采样是块平均抽取，8k 以上会折叠回来，再往上取到的不是"高频"是混叠。
        self._bands = [
            (self._freqs >= 40) & (self._freqs < 300),
            (self._freqs >= 300) & (self._freqs < 3400),
            (self._freqs >= 3400) & (self._freqs < 6800),
        ]

    # ---------------------------------------------------------------- 喂数据

    def push(self, wall, block):
        """喂一块 16k 单声道。块的大小不固定（取决于设备原生采样率与 ratio）。"""
        if block is None or len(block) == 0:
            return
        if self.t0 is None:
            self.t0 = wall
        # 断档：上一块到现在隔了两个以上 hop —— 静音时 loopback 不推数据，
        # 这是唯一能发现"中间没听见"的地方。
        if self.last_data and (wall - self.last_data) > self.hop * 2.5:
            self._gap(wall)
        self.last_data = wall
        b = np.asarray(block, dtype=np.float32)
        self.acc = np.concatenate([self.acc, b]) if self.acc.size else b
        while self.acc.size >= self.win_n:
            self._emit(self._features(self.acc[: self.win_n]))
            self.acc = self.acc[self.hop_n:].copy()

    # ---------------------------------------------------------------- 内部

    def _gap(self, wall):
        """断档：手上这截直接丢（跨断点算谱通量只会炸出一次假起音），然后补 null 格。"""
        self.acc = np.zeros(0, dtype=np.float32)
        self.prev_mag = None
        idx = int((wall - self.t0) / self.hop)
        self.consumed = idx * self.hop_n
        self._fill_to_idx(idx)

    def _fill_to_idx(self, idx):
        span = int(self.keep / self.hop)
        if idx - self.next_idx > span + 10:
            # 断得比整个环形缓冲还久（休眠 / 拔耳机）：不用一格一格补，直接快进
            dropped = idx - self.next_idx
            self.gaps += dropped
            self.last_gap_ms = int((self.t0 + self.next_idx * self.hop) * 1000)
            self.rows = []
            self.onsets.clear()
            self.base_idx = idx
            self.next_idx = idx
            return
        while self.next_idx < idx:
            self.rows.append(None)
            self.onsets.append(0.0)
            self.gaps += 1
            self.last_gap_ms = int((self.t0 + self.next_idx * self.hop) * 1000)
            self.next_idx += 1

    def _emit(self, feats):
        idx = self.consumed // self.hop_n
        self._fill_to_idx(idx)
        self.rows.append(feats)
        self.onsets.append(feats[7])
        self.next_idx = idx + 1
        self.consumed += self.hop_n
        self.flushed += 1
        self._trim()
        if self.flushed % 10 == 0:
            self._estimate_tempo()

    def _trim(self):
        span = int(round(self.keep / self.hop))
        if len(self.rows) <= span + 200:
            return
        drop = len(self.rows) - span
        del self.rows[:drop]
        self.base_idx += drop

    def _features(self, seg):
        x = np.asarray(seg, dtype=np.float32) * self._win
        rms = float(np.sqrt(np.mean(x * x)))
        if rms <= 1e-9:
            return [-120.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        db = 20.0 * np.log10(rms)
        mag = np.abs(np.fft.rfft(x))
        p = mag * mag
        total = float(p.sum())
        if total <= 1e-12:
            return [round(db, 1), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        cen = float((self._freqs * p).sum() / total) / (SR / 2.0)
        # 平坦度：全零谱加 eps，避免 log(0)
        flat = float(np.exp(np.mean(np.log(p + 1e-12))) / (np.mean(p) + 1e-12))
        zcr = float(np.count_nonzero(np.diff(np.signbit(x)))) / max(1, len(x) - 1)
        lo = float(p[self._bands[0]].sum() / total)
        mid = float(p[self._bands[1]].sum() / total)
        hi = float(p[self._bands[2]].sum() / total)
        if self.prev_mag is None or len(self.prev_mag) != len(mag):
            onset = 0.0
        else:
            onset = float(np.maximum(mag - self.prev_mag, 0.0).sum() / (mag.sum() + 1e-9))
        self.prev_mag = mag
        return [round(db, 1), round(cen, 4), round(flat, 3), round(zcr, 3),
                round(lo, 3), round(mid, 3), round(hi, 3), round(onset, 3)]

    def _estimate_tempo(self):
        """节拍：先在频域找周期性最强的频率，再用自相关给它一个可信度。

        为什么不是「自相关峰 + 抛物线」：90 BPM 的周期是 13.33 格，整数格上的峰落在 14，
        抛物线也补不回那 0.33 格（实测报 85.9）。频域补零之后峰的位置是连续的，
        分辨率从 ±4 BPM 变成 ±0.2 BPM。

        置信度仍用自相关：它直接回答「这段有多像拍子」，不像频谱峰值那样只看一个点。
        """
        vals = np.array(self.onsets, dtype=np.float32)
        if len(vals) < int(6.0 / self.hop):
            return
        v = vals - float(vals.mean())
        energy = float(np.dot(v, v))
        if energy < 1e-6:              # 稳态音 / 全静音：没有"拍"可言
            self.tempo = None
            return
        n = len(v)
        nfft = 8192                    # 补零只是让峰的位置连续，不增加信息
        spec = np.abs(np.fft.rfft(v * np.hanning(n), nfft))
        freqs = np.fft.rfftfreq(nfft, self.hop)
        lo_f, hi_f = 40.0 / 60.0, 200.0 / 60.0
        i0 = int(np.searchsorted(freqs, lo_f))
        i1 = int(np.searchsorted(freqs, hi_f))
        if i1 <= i0:
            self.tempo = None
            return
        cand = np.arange(i0, i1 + 1)
        f = freqs[cand]

        def at(mult):
            k = np.clip(np.round(f * mult / freqs[1]).astype(int), 0, len(spec) - 1)
            return spec[k]

        # 谐波乘积：真正的拍频在 2f、3f 上也该有能量。取「够高分里最低的那个」，
        # 否则脉冲串的 2f 也几乎一样高，会一路报成双倍速。
        score = at(1.0) * at(2.0) * at(3.0)
        top = float(score.max())
        if top <= 0:
            self.tempo = None
            return
        pick = int(np.where(score >= 0.8 * top)[0][0])
        f_beat = float(f[pick])
        if f_beat <= 0:
            return
        # 可信度两条腿：
        #  · 峰噪比 —— 节拍的谱峰比自己这一带的底噪高多少（对"分数格"周期不敏感，
        #    脉冲串在 13.33 格上也不会像纯自相关那样掉到 0.2）；
        #  · 自相关符号 —— 真正的拍子在整周期上相关；稳态音的"起伏"是负相关，直接压掉。
        # 映射是经验值（1-exp(-rat/80)），**等 D 层样本攒够要重新标**，别把它当物理量。
        # 80 这个尺度是实测选的：白噪/说话的峰噪比在 5–10，落在 0.1 以下；
        # 节拍器在 1600 以上，直接顶到 1.0；真鼓点在中间，越稳越接近 1。
        ratio = top / max(1e-12, float(np.median(score)))
        lags = np.arange(3, 31)
        ac = np.array([float(np.dot(v[:-lag], v[lag:]) / energy) for lag in lags])
        ac_at = float(np.interp(1.0 / (f_beat * self.hop), lags, ac))
        conf = float(1.0 - np.exp(-ratio / 80.0)) * max(0.0, min(1.0, 1.0 + 2.0 * ac_at))
        bpm = f_beat * 60.0
        # 倍频 / 半频折叠。实测：100 BPM 的鼓型（底鼓 1/3、军鼓 2/4、帽子每半拍）
        # 会被报成 199 —— 帽子比鼓密一倍，谱上更"像"拍子；反过来一小节一底鼓的慢歌
        # 会报成 50。折进 60–180 这个常用的数拍区间：这是**显示口径**，不是推断。
        # 代价是 174 BPM 那种快歌会被读成一半（保留，仍在区间内），真 200 的硬核会被读成 100。
        while bpm < 60.0:
            bpm *= 2.0
        while bpm >= 180.0:
            bpm *= 0.5
        self.tempo = {"bpm": round(bpm, 1),
                      "conf": round(max(0.0, min(1.0, conf)), 2),
                      "at": int(time.time() * 1000)}

    # ---------------------------------------------------------------- 出口

    def snapshot(self):
        if self.t0 is None:
            return None
        return {
            "v": 1,
            "hop": self.hop,
            "from": int((self.t0 + self.base_idx * self.hop) * 1000),
            "frames": self.rows,
            "tempo": self.tempo,
            "gaps": {"count": self.gaps, "lastMs": self.last_gap_ms},
        }


def write_acoustic(path, meter):
    """原子写（和 levels.json 同一套规矩）。Node 随时可能读，不能让它看到半个 JSON。"""
    try:
        snap = meter.snapshot()
        if not snap:
            return
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(description="抓系统回环声音，按静音断句落成 16k wav")
    ap.add_argument("--out", required=False, help="wav 输出目录（seg-<epochMs>.wav）")
    ap.add_argument("--device", default=None, help="回环设备名的一部分（默认：系统默认输出的回环）")
    ap.add_argument("--silence", type=float, default=0.35, help="静音多久算一句说完（秒）")
    ap.add_argument("--max-seg", type=float, default=3.0, help="一句话最长多少秒，超了强切")
    ap.add_argument("--pre", type=float, default=0.25, help="预卷：开口前多收多少秒")
    ap.add_argument("--min-seg", type=float, default=0.5, help="短于这个长度的段不发")
    ap.add_argument("--thr", type=float, default=0.0035, help="能量阈值（0~1，默认约 -49dB）")
    ap.add_argument("--live", type=float, default=1.0, help="长句边说边出字幕：1 开 / 0 关")
    ap.add_argument("--live-min", type=float, default=1.8, help="说满这么多秒才给第一版临时字幕")
    ap.add_argument("--live-step", type=float, default=1.2, help="之后每这么多秒刷新一版")
    ap.add_argument("--acoustic", type=float, default=1.0,
                    help="声学指纹（acoustic.json）：1 开 / 0 关。纯本地 DSP，不花 token")
    ap.add_argument("--list-devices", action="store_true", help="列出回环设备后退出")
    args = ap.parse_args()

    if args.list_devices:
        list_devices()
        return
    if not args.out:
        raise SystemExit("要 --out DIR（或者 --list-devices）")
    os.makedirs(args.out, exist_ok=True)
    pid_path = write_pid_file(args.out)

    # 上层是 SIGTERM 收工的：不接这个信号的话 finally 不会跑，正在说的那半句就丢了
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    p = pa.PyAudio()
    try:
        dev = pick_device(p, args.device)
        sr = int(dev["defaultSampleRate"])
        ch = int(dev["maxInputChannels"])
        emit({"event": "device", "name": dev["name"], "rate": sr, "channels": ch})

        # 设备原生格式打开（WASAPI 共享模式不接受别的采样率），降采样自己做。
        #
        # **必须用回调 + 队列，不能用阻塞 read**：静音段 loopback 一个字节都不推，
        # `stream.read()` 会一直挂着（实测想读 4 秒、实际卡了 19 秒才返回），
        # 主循环没有机会跑 tick，那"说完了"就永远判不出来。
        q = queue.Queue()
        ratio = max(1, int(round(sr / SR)))

        def on_audio(in_data, frame_count, time_info, status):
            raw = np.frombuffer(in_data, dtype=np.float32).copy()
            q.put((time.time(), raw))
            return (None, pa.paContinue)

        stream = p.open(format=pa.paFloat32, channels=ch, rate=sr, input=True,
                        input_device_index=dev["index"], frames_per_buffer=1024,
                        stream_callback=on_audio)
        seg = Segmenter(silence=args.silence, max_seg=args.max_seg,
                        pre=args.pre, min_seg=args.min_seg, thr=args.thr,
                        live_min=(args.live_min if args.live else 0.0),
                        live_step=(args.live_step if args.live else 0.0))

        carry = np.zeros(0, dtype=np.float32)   # 48k → 16k 的余数（3 个凑 1 个）
        meter = LevelMeter()
        levels_path = os.path.join(args.out, "levels.json")
        # 声学指纹：同一条 16k 流上多算一遍比值，纯本地、零 token。
        # 关掉只是不写文件，不影响断句/音量条/转写。
        acoustic = AcousticMeter() if args.acoustic else None
        acoustic_path = os.path.join(args.out, "acoustic.json")
        last_beat = time.time()
        last_levels = 0.0
        last_acoustic = 0.0
        dropped = 0
        written = 0

        def drop_ratio(x):
            nonlocal carry
            cat = np.concatenate([carry, x]) if carry.size else x
            n = len(cat) // ratio * ratio
            if n == 0:
                carry = cat
                return np.zeros(0, dtype=np.float32)
            out = cat[:n].reshape(-1, ratio).mean(axis=1).astype(np.float32)
            carry = cat[n:]
            return out

        def land(pieces):
            nonlocal dropped, written
            for t0, audio in pieces:
                if tts_busy(t0 * 1000):
                    dropped += 1
                    emit({"event": "skip", "reason": "tts", "at": round(t0, 3)})
                    continue
                name = f"seg-{int(t0 * 1000)}.wav"
                write_wav(os.path.join(args.out, name), audio)
                # 这句已经有整句了，临时快照作废（Node 侧不必再转一次）
                try:
                    os.remove(os.path.join(args.out, f"live-{int(t0 * 1000)}.wav"))
                except OSError:
                    pass
                written += 1
                emit({"event": "seg", "name": name, "at": round(t0, 3),
                      "dur": round(len(audio) / SR, 2)})

        def land_live(pieces):
            """临时快照：**同名覆盖**（一句话只有一个 live 文件），Node 侧按 size/mtime 判新。"""
            for t0, audio in pieces:
                if tts_busy(t0 * 1000):
                    continue
                name = f"live-{int(t0 * 1000)}.wav"
                write_wav(os.path.join(args.out, name), audio)
                emit({"event": "live", "at": round(t0, 3), "dur": round(len(audio) / SR, 2)})

        stream.start_stream()
        while True:
            try:
                # 20ms 而不是 50：静音期没有数据块，`tick()` 的粒度就是这个超时 ——
                # 它直接计进"说完 → 判定说完"的延迟里。
                wall, raw = q.get(timeout=0.02)
            except queue.Empty:
                wall, raw = None, None
            if raw is not None:
                x = raw.reshape(-1, ch).mean(axis=1) if ch > 1 else raw
                block = drop_ratio(x)
                meter.push(wall, block)          # 音量条：顺手记，不额外解码
                if acoustic is not None:
                    acoustic.push(wall, block)   # 声学指纹：同一块，再算一次 rfft
                land(seg.push(wall, block))
                land_live(seg.snapshot())        # 长句：不等断句，先给一版
            # 静音期没有数据，靠这里把"说完了"判出来
            land(seg.tick(time.time()))
            if time.time() - last_levels > 1.0:
                last_levels = time.time()
                write_levels(levels_path, meter)
            # 3 秒一够 —— 它是个 120 秒的环形缓冲，写太勤只是白扫盘
            if acoustic is not None and time.time() - last_acoustic > 3.0:
                last_acoustic = time.time()
                write_acoustic(acoustic_path, acoustic)
            if time.time() - last_beat > 30:
                last_beat = time.time()
                beats = {"event": "beat", "written": written, "skipped": dropped}
                if acoustic is not None:
                    beats["acoustic"] = {"flushed": acoustic.flushed, "gaps": acoustic.gaps}
                emit(beats)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            land(seg.flush())      # 退出时把没说完的半句也交出去（够长才要）
        except Exception:
            pass
        try:
            write_levels(levels_path, meter)   # 最后一帧音量条也要落下去
        except Exception:
            pass
        try:
            if acoustic is not None:
                write_acoustic(acoustic_path, acoustic)   # 收工时把最后几格也落下去
        except Exception:
            pass
        try:
            stream.stop_stream(); stream.close()
        except Exception:
            pass
        try:
            p.terminate()
        finally:
            # 退出就把自己的 pid 文件收掉：留在盘上只会让下一次 stop() 去杀一个
            # 已经不存在（或者被系统复用）的 pid
            remove_pid_file(pid_path)


if __name__ == "__main__":
    main()
