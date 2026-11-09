#!/usr/bin/env python3
"""mic.py — 麦克风 → 文字 → 统一文本流（chat.jsonl）。

悬浮窗那个 🎤 按钮开的就是这个进程：点开就开始听，你说完一句，它自动转成文字
**写进聊天流**（和你在框里打字的那条路一模一样）。写进去之后：

  · 悬浮窗 / 浏览器页面下一拍就显示出来（它们读同一个文件）
  · 阻塞中的 `cue` 立刻收到这条 → INTERRUPT → 模型马上接话

## 为什么默认**自己加载一份模型**（--engine local）

视频转写和麦克风是两件事，谁也不该等谁。实测（本机 i9-12900HX）：

  · 一个 int8 paraformer 实例 ≈ **284 MB** 工作集，加载 1.8–2.6 s
  · 同一个实例并发转写几乎不排队（45s 长音频转写时，3s 短句只要 0.14 s）

所以"开两个进程"完全开得起。而且现有服务把解码写在 `async def` 里（CPU 密集的活
堵在事件循环上），视频在转的时候麦克风会跟着排队 —— 自带模型就彻底不相干。

`--engine http` 可以改回共用 8000 端口那个服务（省 284MB，但要等长音频转完）。

## 一个必须挡住的坑：它不能听见自己

陪看时 AI 会用 TTS 念台词，声音从音箱出来 → 麦克风听见 → 转写成"用户说的话"
→ 模型又回一句 → 无限自激。所以每句话转写前都查一次 `quiet-until.json`
（`say`/`cue` 念台词前会占住这个窗口），窗口内直接丢掉这段音频。

## 用法

    python mic.py                      本地模型，默认麦克风
    python mic.py --engine http        共用 ASR 服务（省内存）
    python mic.py --list-devices       看看有哪些输入设备
    python mic.py --device 2           指定麦克风
    python mic.py --from-file a.wav    拿文件当"麦克风"（不用真说话就能测）

依赖：`pip install sounddevice numpy`（ASR 的 venv 里已有 numpy，sounddevice 要装）。
"""

import argparse
import json
import os
import sys
import time
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import numpy as np                            # 模块级：环形缓冲和回声消除都要用
except ImportError:
    sys.stderr.write("缺 numpy：pip install numpy\n")
    raise SystemExit(2)

try:
    from aec import FdafAec, find_loopback_device   # 回声消除：把电脑放出来的声音从麦克风里减掉
except ImportError:                                  # 这份 fork 里没拷 aec.py：降级成"不消回声"也能用
    FdafAec = None
    find_loopback_device = None

# ---------------------------------------------------------------- 与悬浮窗共享的那份流


def cache_dir():
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return d
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return os.path.join(local, "dsh-video-storyboard", "cache")
    return os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                        "dsh-video-storyboard")


CHAT_FILE = os.path.join(cache_dir(), "chat.jsonl")

def watch_out_dir():
    """和 `bin/watch.mjs` 用**同一套默认值**。

    `WATCH_OUT` 优先，否则 `$DSH_HOME/watch/out`（`DSH_HOME` 默认 `~/.dsh`）。
    以前这里写死了作者的工作区路径：别人装上永远找不到那个文件，
    于是"静音窗口"形同不存在 —— 麦克风会把 TTS 自己的声音当用户说话（无限自激）。
    """
    explicit = os.environ.get("WATCH_OUT") or os.environ.get("DSH_WATCH_OUT")
    if explicit:
        return explicit
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "watch", "out")


# TTS 占用窗口：say / cue 念台词前会写这个文件，窗口内的音频一律丢弃
QUIET_FILE = os.environ.get("DSH_QUIET_FILE") or os.path.join(watch_out_dir(), "quiet-until.json")


def append_user(text):
    os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def tts_busy():
    """AI 正在念（或刚念完）：这时麦克风听到的多半是它自己的声音"""
    try:
        with open(QUIET_FILE, "r", encoding="utf-8") as f:
            return time.time() * 1000 < float(json.load(f).get("until") or 0)
    except Exception:
        return False


# ---------------------------------------------------------------- 引擎


class LocalEngine:
    """自带一份模型：和视频那条路彻底不相干"""

    def __init__(self, models_dir, punct=True):
        import sherpa_onnx

        t0 = time.time()
        self.rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=os.path.join(models_dir, "model.int8.onnx"),
            tokens=os.path.join(models_dir, "tokens.txt"),
            num_threads=4, sample_rate=16000,
        )
        self.punct = None
        if punct:
            p = os.path.join(models_dir, "punct", "model.onnx")
            v = os.path.join(models_dir, "punct", "tokens.json")
            if os.path.exists(p) and os.path.exists(v):
                try:
                    self.punct = sherpa_onnx.OfflinePunctuation(
                        sherpa_onnx.OfflinePunctuationConfig(
                            model=sherpa_onnx.OfflinePunctuationModelConfig(ct_transformer=p)
                        )
                    )
                except Exception as exc:
                    self._log(f"标点模型没起来（{exc}），照常出字")
        self._log(f"本地模型就绪 {time.time()-t0:.1f}s（{models_dir}）")

    def _log(self, msg):
        print(msg, file=sys.stderr, flush=True)

    def __call__(self, samples):
        import sherpa_onnx  # noqa: F401  (已加载，只为保持显式)
        s = self.rec.create_stream()
        s.accept_waveform(16000, samples)
        self.rec.decode_stream(s)
        text = (s.result.text or "").strip()
        if text and self.punct:
            try:
                text = self.punct.add_punctuation(text).strip()
            except Exception:
                pass
        return text


class HttpEngine:
    """共用 8000 端口那个服务。省内存，但视频在转长音频时要排队"""

    def __init__(self, url="http://127.0.0.1:8000"):
        import requests

        self.url = url.rstrip("/")
        self.s = requests.Session()
        print(f"共用 ASR 服务 {self.url}", file=sys.stderr, flush=True)

    def __call__(self, samples):
        import io

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            pcm = (samples * 32767).astype("<i2")
            w.writeframes(pcm.tobytes())
        r = self.s.post(
            f"{self.url}/v1/audio/transcriptions",
            files={"file": ("a.wav", buf.getvalue(), "audio/wav")},
            data={"response_format": "verbose_json", "language": "zh"},
            timeout=120,
        )
        r.raise_for_status()
        return (r.json().get("text") or "").strip()


# ---------------------------------------------------------------- 录音


def make_vad(models_dir):
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = os.path.join(models_dir, "silero_vad.onnx")
    cfg.silero_vad.min_silence_duration = 0.45
    cfg.silero_vad.min_speech_duration = 0.2
    cfg.sample_rate = 16000
    # 环形缓冲 30 秒：一句话说超 30 秒会被切成两段（正常说话不会）
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class Ring:
    """环形缓冲：存原始麦克风（消回声**之前**的），用来判断"这段到底是不是回声"。

    为什么需要它：AEC 消完之后还剩多少，是"这句话是不是你自己的"最直接的证据 ——
    全是电脑声音的话，消完基本就没了；你自己说的话，消完还在。
    """

    def __init__(self, seconds=60, sr=16000):
        self.buf = np.zeros(int(seconds * sr), dtype=np.float32)
        self.n = 0                  # 累计写入的样本数（绝对下标）

    def push(self, x):
        x = np.asarray(x, dtype=np.float32)
        idx = np.arange(self.n, self.n + len(x)) % len(self.buf)
        self.buf[idx] = x
        self.n += len(x)

    def get(self, start, length):
        idx = (int(start) + np.arange(int(length))) % len(self.buf)
        return self.buf[idx]


def run(args):
    models_dir = args.models_dir or os.path.join("D:/asr-local", "models-sherpa")
    engine = LocalEngine(models_dir, punct=not args.no_punct) if args.engine == "local" \
        else HttpEngine(args.url)
    vad = make_vad(models_dir)

    def handle(samples, raw=None):
        dur = len(samples) / 16000
        if dur < args.min_sec:
            return
        # ---- 硬闸门：AEC 把这段基本消没了 = 它本来就是电脑放出来的声音
        # （实测：纯回声段消完只剩约 1/5，人声段基本不动）
        if raw is not None and args.echo_gate > 0:
            a = float(np.sqrt(np.mean(np.asarray(raw, dtype=np.float64) ** 2)))
            b = float(np.sqrt(np.mean(np.asarray(samples, dtype=np.float64) ** 2)))
            if a > 1e-9 and b / a < args.echo_gate:
                log(f"（{dur:.1f}s 丢掉：消完只剩 {b/a*100:.0f}%，是电脑的声音）")
                return
        rms = float(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0.0
        if rms < args.threshold:
            return                                  # 太安静：多半是环境噪声
        if tts_busy():
            log(f"（{dur:.1f}s 丢掉：AI 正在念，那是它自己的声音）")
            return
        t0 = time.time()
        try:
            text = engine(samples)
        except Exception as exc:
            log(f"转写失败：{exc}")
            return
        if not text:
            return
        log(f"识别 {dur:.1f}s / {time.time()-t0:.2f}s：{text}")
        if args.dry_run:
            print(text, flush=True)
            return
        try:
            append_user(text)
        except Exception as exc:
            log(f"写不进聊天流：{exc}")

    # ---- 回声消除：拿"电脑在放什么"当参考，从麦克风里把它减掉
    aec = None
    lb_dev, lb_name = None, None
    if FdafAec is not None and not args.no_aec:
        lb_dev = args.loopback
        if lb_dev is None:
            lb_dev, lb_name = find_loopback_device()
        if lb_dev is not None:
            aec = FdafAec(frame=512, taps=args.taps, mu=0.35, dt_ratio=args.dt_ratio)
            log(f"回声消除开：参考设备 [{lb_dev}] {lb_name or ''}")
        else:
            log("没找到回环设备（扬声器/立体声混音），回声消除关 —— 可用 --loopback 指定设备号")
    ring = Ring()

    def feed(block, ref_block=None):
        """喂一帧：先消回声，再交给 VAD；消完剩多少用来挡纯回声"""
        frame = np.asarray(block, dtype=np.float32).reshape(-1)
        raw = None
        if aec is not None and ref_block is not None:
            raw = frame.copy()
            ring.push(raw)
            frame = aec.process(frame, np.asarray(ref_block, dtype=np.float32).reshape(-1))
        vad.accept_waveform(frame.tolist())
        while not vad.empty():
            seg = vad.front
            samples = np.array(seg.samples, dtype=np.float32)
            handle(samples, ring.get(seg.start, len(samples)) if raw is not None else None)
            vad.pop()

    if args.from_file:
        log(f"用文件当麦克风：{args.from_file}")

        def load(path):
            with wave.open(path, "rb") as w:
                rate = w.getframerate()
                p = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
            if rate != 16000:
                idx = np.linspace(0, len(p) - 1, int(len(p) * 16000 / rate)).astype(int)
                p = p[idx]
            return p / 32768.0

        pcm = load(args.from_file)
        ref_pcm = load(args.ref_file) if args.ref_file else (pcm if aec is not None else None)
        for i in range(0, len(pcm), 512):
            r = ref_pcm[i:i + 512] if ref_pcm is not None else None
            feed(pcm[i:i + 512], r)
        vad.flush()
        while not vad.empty():
            seg = vad.front
            samples = np.array(seg.samples, dtype=np.float32)
            handle(samples, ring.get(seg.start, len(samples)) if aec is not None else None)
            vad.pop()
        log("文件放完了")
        return

    import sounddevice as sd

    if args.list_devices:
        print(sd.query_devices(), flush=True)
        return

    log(f"开始听（设备 {args.device if args.device is not None else '默认'}）"
        f"{'  [dry-run：只打印不写流]' if args.dry_run else ''}")
    ref_stream = None
    if aec is not None:
        try:
            ref_stream = sd.InputStream(samplerate=16000, channels=1, dtype="float32",
                                        blocksize=512, device=lb_dev)
            ref_stream.start()
        except Exception as exc:
            # 设备被别的程序独占、或根本抓不到：退化成不消回声，别整个挂掉
            log(f"回环设备打不开（{exc}），回声消除关")
            aec = None
            ref_stream = None
    # WDM-KS 后端不支持 blocking read（PortAudio："Blocking API not supported yet"），
    # 这台机器只枚举到 WDM-KS 输入设备 —— 用 callback + 队列喂同一套处理逻辑。
    import queue as _queue
    frames_q: "_queue.Queue" = _queue.Queue()

    def _on_audio(indata, _frames, _t, _status):
        try:
            frames_q.put(indata.copy())
        except Exception:
            pass

    with sd.InputStream(samplerate=16000, channels=1, dtype="float32",
                        blocksize=512, device=args.device, callback=_on_audio) as stream:
        while True:
            block = frames_q.get()
            ref = None
            if ref_stream is not None:
                try:
                    ref, _ = ref_stream.read(512)
                except Exception:
                    ref = None
            feed(block, ref)


def main():
    ap = argparse.ArgumentParser(description="麦克风 → 文字 → 陪看聊天流")
    ap.add_argument("--engine", choices=["local", "http"], default="local",
                    help="local=自带模型（默认，和视频那条路互不干扰）；http=共用 8000 服务")
    ap.add_argument("--url", default="http://127.0.0.1:8000", help="http 模式的服务地址")
    ap.add_argument("--models-dir", default=None, help="模型目录（默认 D:/asr-local/models-sherpa）")
    ap.add_argument("--device", type=int, default=None, help="麦克风设备号")
    ap.add_argument("--list-devices", action="store_true", help="列出输入设备后退出")
    ap.add_argument("--from-file", default=None, help="用 wav 文件代替麦克风（测试）")
    ap.add_argument("--min-sec", type=float, default=0.35, help="短于这个秒数的段丢弃")
    ap.add_argument("--threshold", type=float, default=0.004, help="音量门槛（RMS），滤环境噪声")
    ap.add_argument("--no-punct", action="store_true", help="不加标点")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写进聊天流")
    # ---- 回声消除（"只要麦克风，不要电脑声音"）
    ap.add_argument("--no-aec", action="store_true", help="关掉回声消除")
    ap.add_argument("--loopback", type=int, default=None,
                    help="回环设备号（抓「电脑在放什么」）。不给就自动找扬声器/立体声混音")
    ap.add_argument("--ref-file", default=None, help="用 wav 当回环参考（配合 --from-file 测试）")
    ap.add_argument("--taps", type=int, default=8192, help="滤波器长度（8192 ≈ 512ms 混响尾巴）")
    ap.add_argument("--dt-ratio", type=float, default=1.4,
                    help="双讲阈值：麦克风峰值超过参考峰值这么多倍就判定「你在说话」，冻住滤波器")
    ap.add_argument("--echo-gate", type=float, default=0.3,
                    help="消完只剩这么多比例就当纯回声丢掉（0 = 不判）。实测纯回声约剩 20%")
    args = ap.parse_args()

    if args.list_devices:
        import sounddevice as sd
        print(sd.query_devices(), flush=True)
        return

    try:
        run(args)
    except KeyboardInterrupt:
        log("停了")
    except ImportError as exc:
        log(f"缺依赖：{exc}\n  pip install sounddevice numpy（在 ASR 的 venv 里 numpy 已有）")
        return 2
    except Exception as exc:
        log(f"挂了：{exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
