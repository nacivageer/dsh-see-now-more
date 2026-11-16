# SenseVoice 替换 paraformer（CER 对比）

状态：已定（2026-11-17 03:0x 格定**保留 SenseVoice**：1–3 点是净收益，延迟约 +30%；
     验收判据「明显低于 37.7%」没有达到，别再指望换模型治漏字）
对象：把 `H:\asr-local\server-sherpa.py` 的识别引擎从 paraformer-zh 换成 SenseVoice，
     用**同一套三段样本**重算 CER，验证“漏字”这个主要误差能不能压下去。
归属：session-03ce6845（三段基线 + 交接文）/ session-9f3ff405（换引擎与实测，2026-11-17）
下一步：没有待办。两条遗留已在 2026-11-17 03:2x 修掉（见 §实测「遗留已修」）。
     漏字要动的是切块长度与真值口径，不是模型。
证据：
  - 基线三段 CER：28.7% / 38.5% / 46.0%（均值 37.7%），来源 `%TEMP%\cer-s1..s3.json`
  - 转写字数稳定为真值的 72–75%（漏字是主因，不是错字）
  - 代码提交：see-now-more `8e16ed7`（逐句落盘 + 声纹延迟开号）
  - 2026-11-17 02:1x：SenseVoice int8 已下（`H:\asr-local\models-sensevoice`，239,233,841 B + tokens.txt）；
    `server-sherpa.py` 加 `--engine paraformer|sense-voice`（+`--language`，model-name 按引擎取默认）；
    `--check` 通过；服务以 sense-voice 起在 :8000，`/v1/models` 回显 `sense-voice-zh-en-ja-ko-yue-2024-07-17`，
    HTTP 转写返回 `text/duration/segments/spk_emb` 齐全；`~/.dsh/asr.json` 已切（备份 `asr.json.bak-20261117-sensevoice`）。
  - 2026-11-17 02:2x–02:5x：线上三段 48.1 / 42.6 / 53.3（均值 48.0%）——**不可与基线直接比**（ref 被称号污染，见下）；
    同音频 A/B：para 32.1 / 30.8，SenseVoice 29.9 / 29.5（CER），插件链 26.0%。
更新：2026-11-17 02:56 CST

## 现状（接手前必读）

**链路**：屏幕/窗口 → `live-subs.py`（真值） ＋ 回环音频 → `listen.py` → 本机 ASR 服务 → 台词缓冲 → 逐句落盘
**真值**：`H:\asr-local\live-subs.py`，Windows OCR（winrt），毫秒级
**转写**：`H:\asr-local\server-sherpa.py`，sherpa-onnx，`--engine paraformer|sense-voice`
（2026-11-17 起默认仍 paraformer，服务实际用 `~/.dsh/asr.json` 的 `manage.start` 决定 = sense-voice）
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

## 实测（2026-11-17 02:2x–02:5x）

### 干净 A/B：同一条音频、同一种切块

来源 `%TEMP%\ab-clean.wav`（139.2 秒回环录音，峰值 -23.3 dBFS / rms ≈ -43 dBFS）＋ 同窗口 OCR
参考 `%TEMP%\subs-ab.json`（14 句 / 308 字）。两边都切 **10 秒**块解码、整段拼起来再算 CER：

| 解码 | CER | 编辑距离 |
|---|---|---|
| paraformer 原始电平 | 32.1% | 99 |
| SenseVoice 原始电平 | 29.9% | 92 |
| paraformer 峰值归一（0.9） | 30.8% | 95 |
| SenseVoice 峰值归一 | 29.5% | 91 |
| 插件链现状（SenseVoice + 6s 切块 + 术语表） | 26.0% | 80 |

结论：**SenseVoice 只领先 paraformer 1.3–2.6 个点**，离「明显低于 37.7%」差得远；
峰值归一两边各赚 1.3 点，说明低电平是次要变量。真正把数压到 26.0% 的是插件那条链
（更细的切块 + 术语表替换），不是模型本身。

### 线上三段（窗口化 OCR）

| 段 | 参考 | 转写 | 字数比 | CER |
|---|---|---|---|---|
| 1 | 10 句 / 162 字 | 19 句 / 109 字 | 67% | 48.1% |
| 2 | 10 句 / 230 字 | 18 句 / 153 字 | 67% | 42.6% |
| 3 | 20 句 / 473 字 | 34 句 / 271 字 | 57% | 53.3% |

**这三个数不能和基线 37.7% 比**：参考被两类噪声污染——说话人称号（`宽厚的战士` 在第三段重复 8 次、
`一一嶙亞尘`）和残影（`厂厂0```、`扌`、`昵`）。称号是画面上的字、不会被念出来，ASR 必然「漏」，
等于白送编辑距离。基线的 ref 只有零散误字、没有成串称号，两边不是同一把尺。

### 遗留已修（2026-11-17 03:2x）

- **长音频切块**：`_decode` 里超过 `MAX_UTTER_S = 25` 秒的段自动切块解码、拼回一段（只告警一次）。
  实测 139.2 秒整段：修前只吐约 30 字胡话，修后 **230 字**、耗时 30.5 秒，日志
  `long audio 139.2s > 25s，按块解码`。只影响兜底路径（VAD 判全静音或调用方直丢长音频）。
- **标点不再成双**：`_clean()` 先看文本里有没有中日标点（`CJK_PUNCT`），有就跳过 ct-transformer，
  再统一 `dedupe_punct` 把 `。。`/`，，` 收成一个。判据看**文本内容**而不是引擎名，换模型/关 ITN 都不会误判。
  实测 `test_wavs/0.wav` 输出：`对我做了介绍啊，那么我想说的是呢，大家如果对我的研究感兴趣呢嗯。`

### 三个新坑（这轮踩的）

- **SenseVoice 不能整段解码**：139 秒一次丢进去只吐三十来个字的胡话（`嫌烦还这本日记助悉这里生活隐私…`），
  paraformer 反而能整段出字。它是按 ≤30 秒 utterance 训练的 —— 服务端要么硬性切块，要么在
  `/v1/audio/transcriptions` 里对长音频加拒绝/告警。
- **窗口化之后短字幕被「够宽」挡光**：`pick_subtitle_lines` 原门槛是窗口宽的 0.18，窗口化到 1922px 后
  等于 346px，`这是怎么回事？`（192px）全丢。已给 `live-subs.py` 加 `--min-w`（默认 0.18，窗口化用 0.06）。
  放宽的副作用：居中的 UI 文案会混进来（`切换至最后一页后可关闭界面`），跑完要按关键词剔。
- **`cer-pair.py` 按 ref 时间窗筛转写行**：用整段单行假设做 A/B 时，那行的 `t0` 必须落在
  `[min(ref.start)-600, max(ref.end)+600]` 内，否则整行被扔掉、CER 直接 100%。第一版就是这么错的。

### 代码改动（`H:\asr-local` 不是 Git 仓，只在磁盘上）

- **备份**：`server-sherpa.py.bak-20261117`（28514 B，sha256 前 16 位 `4AAEC8FE8986F2D1`）、
  `live-subs.py.bak-20261117`（10961 B，`B92E2C5656AD523A`），都是改完当天状态的副本；
  更早还有 `server-sherpa.py.bak-20261117-pre-spk`（11-05，加声纹前）与 `server-sherpa.py.orig`
  （11-04 上游原样，与 `vendor/dsh-video-storyboard/scripts/reference-server-sherpa.py` 同一份）。

- `server-sherpa.py`：`--engine paraformer|sense-voice`、`--language`、`--model-name` 按引擎取默认；
  两种引擎共用 VAD / 标点 / 声纹与响应字段（`text`/`duration`/`segments`/`spk_emb`）。
- `live-subs.py`：`--min-w`（字幕行最小宽度占比）。
- `~/.dsh/asr.json`：`model` 与 `manage.start` 切到 sense-voice；备份 `asr.json.bak-20261117-sensevoice`。

## 日志

- 2026-11-17 01:52 进行中 → 等你定；本会话把“可测性”做完（真值工具 + 逐句落盘 + 三段基线），
  SenseVoice 对比留给下一会话。
- 2026-11-17 02:56 进行中 → 可验收：四步做完（下模型 / 加分支 / 清端口起服务 / 重跑），
  实测结论是「换模型只值 1–3 个点」，验收判据没达到；SenseVoice 的 ≤30s 切块约束与
  OCR 宽度门槛两个坑已写回本文与代码。去留待格定。
- 2026-11-17 03:03 可验收 → 已定：格定**保留 SenseVoice**。理由：同音频 A/B 净赚 1–3 点、
  代价是多一份 230MB 模型与约 30% 延迟，≤30s 约束插件本来就在满足（6s 切块）。
  服务当前跑的就是 sense-voice；不再回退。
