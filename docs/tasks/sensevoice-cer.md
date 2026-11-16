# SenseVoice 替换 paraformer（CER 对比）

状态：等你定
对象：把 `H:\asr-local\server-sherpa.py` 的识别引擎从 paraformer-zh 换成 SenseVoice，
     用**同一套三段样本**重算 CER，验证“漏字”这个主要误差能不能压下去。
归属：session-03ce6845（2026-11-17 存档）；代码仓 `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：下一会话——① 下 SenseVoice ONNX；② 服务端加引擎分支；③ 重跑三段 CER 并对比基线。
证据：
  - 基线三段 CER：28.7% / 38.5% / 46.0%（均值 37.7%），来源 `%TEMP%\cer-s1..s3.json`
  - 转写字数稳定为真值的 72–75%（漏字是主因，不是错字）
  - 代码提交：see-now-more `8e16ed7`（逐句落盘 + 声纹延迟开号）
更新：2026-11-17 01:52 CST

## 现状（接手前必读）

**链路**：屏幕/窗口 → `live-subs.py`（真值） ＋ 回环音频 → `listen.py` → 本机 ASR 服务 → 台词缓冲 → 逐句落盘
**真值**：`H:\asr-local\live-subs.py`，Windows OCR（winrt），毫秒级
**转写**：`H:\asr-local\server-sherpa.py`，sherpa-onnx，paraformer-zh-2024-03-09
**评测**：`H:\asr-local\cer-pair.py`，整段 CER（逐句只作举例——两边断句不同，逐句会放大到 74%）

**为什么确定要换**：三段的转写字数都只有真值的 72–75%，而错字占比不高。也就是
“有近三成的话根本没转出来”。这不是参数能补的，模型能力问题优先。

## 做法（建议顺序）

1. **下载 SenseVoice ONNX**（sherpa-onnx 格式，约 230MB+），解到 `H:\asr-local\models-sensevoice\`
   （`model.int8.onnx` + `tokens.txt`）。下载被墙就设 `HTTPS_PROXY=http://127.0.0.1:7897`。
2. **服务端加分支**：`server-sherpa.py` 里 `Engine.__init__` 现在硬编码
   `sherpa_onnx.OfflineRecognizer.from_paraformer(...)`；加 `--engine paraformer|sense-voice`，
   sense-voice 用 `OfflineRecognizer.from_sense_voice(model=…, tokens=…, use_itn=True, language="zh")`。
   **响应字段不能变**（`text` / `duration` / `segments` / `spk_emb`）——插件侧依赖它们。
3. **清干净再起**：端口 8000 上可能挂着多个 `server-sherpa` 实例（实测一次有 4 个抢端口）。
   先 `Get-CimInstance Win32_Process | ? {$_.CommandLine -like '*server-sherpa*'}` 全杀，再按
   `~/.dsh/asr.json` 的 `manage.start` 拉起（`.venv\Scripts\pythonw.exe` + `--models …`）。
4. **重跑三段**（每段 150 秒，见下），对比基线。

## 采样与评测（可直接抄）

```powershell
# 1) 听觉必须在跑
#    see_now({mode:"audio"})  —— 没在听就没有转写
# 2) 抓字幕真值（窗口标题现在是「鸣潮」；坐标来自拖框标定）
$py = "H:\DSH\home\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py "H:\asr-local\live-subs.py" --rect "1811,1380,1417,315" --sec 150 --fps 2 --out "$env:TEMP\subs-x.json"
# 3) 算 CER（PYTHONIOENCODING 不加会乱码）
$env:PYTHONIOENCODING="utf-8"
& "H:\asr-local\.venv\Scripts\python.exe" "H:\asr-local\cer-pair.py" --subs "$env:TEMP\subs-x.json" --out "$env:TEMP\cer-x.json"
```

**验收**：同一长度、同一玩法的三段，SenseVoice 的平均 CER **明显低于 37.7%**，且转写字数/真值比
从 72–75% 上去；声纹与术语表行为不劣化（未标率仍 ≤15%，`terms.json` 仍生效）。

## 坑（都踩过）

- `live-subs.py` 必须用 **DSH runtime python**（有 `mss`/`winrt`/`Pillow`/`windows_capture`）；
  `H:\asr-local\.venv` 没有 PIL，`ocr-venv` 没有 windows_capture。
- **别用 rapidocr**：4K 整屏一帧 41 秒、裁到字幕带还要 16–21 秒/帧，实时不可行。
- 窗口被移动/缩放后字幕带坐标失效：重拖一次 `see_now({action:"region"})`，把结果写进
  `~/.dsh/see-now/subs-band.json`（**别**让它留在 `region.json`，否则以后 `watch` 只截字幕条）。
- 也能按窗口抓（不依赖坐标、不怕遮挡）：`live-subs.py --window "鸣潮"`，但字幕带要靠
  “居中 + 够宽”过滤，HUD 多时会误收。
- 插件改完必须 `node scripts/install-dev.mjs` **再重启 DSH**：profile 里是**拷贝**不是链接；
  只改仓库不装、或只重启不装，都等于没改（本会话为此白重启过两次）。
- 术语表 `~/.dsh/see-now/terms.json` 是**热读**（mtime），改它不用重启。
- 台词已逐句落盘：`~/.dsh/see-now/transcript/<YYYY-MM-DD>.jsonl`，每行 `{t0,t1,text,spk?}`，
  不用再等唤醒。

## 边界

- 本次**不**做：声纹编号跨会话稳定（编号按出现顺序，重启会重排）；名字映射（要靠字幕名或用户告知）。
- 模型换了之后 `~/.dsh/asr.json` 的 `model` 字段要同步（服务端 `/v1/models` 会回显），
  否则插件日志里看到的模型名会是旧的。

## 日志

- 2026-11-17 01:52 进行中 → 等你定；本会话把“可测性”做完（真值工具 + 逐句落盘 + 三段基线），
  SenseVoice 对比留给下一会话。
