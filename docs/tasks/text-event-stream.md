<!-- 来源：session-40cc9db3（bilibili 工作区评 BV1WGyrzHExU 时读到的三个上游仓）。执行在 see-now-more。
     v2 由 see-now-more 会话按本仓代码对表改写，改了什么见文末日志。 -->

# 屏幕文字事件流：让静默期不花 token

状态：进行中（未开工；v2 方案定稿）
对象：给 see-now-more 加一条**屏幕文字事件流**——把画面上的字（尤其底部字幕带）变成带时间码的文本事件，
随唤醒 / 图交付而不是另开一路；做到「静默期只入队不进上下文、说话时少漏字、有本账能算清省了多少」。
归属：session-40cc9db3-6a98-481e-8252-9da96f75f401（bilibili 工作区出方案）/ 执行在
`C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：P1 第 1 步（事件模型 + 闸门）开工；P2 等 P1 的数字；P4 等 P1 做完、发版时一起改 README。
证据：参照物三个仓都实读过 README（2026-11-27 04:45–04:48，GitHub API 经代理）；本仓现状与 v2 改动见下文 `文件:行`。
账：无需（本文件只出方案）
更新：2026-11-27 05:05 CST

## 为什么值得做（三条已核）

1. **成本是「按图、按 15 秒」**：`low` 档一张图 222 token，一张图覆盖 15 秒（`maxWaitSec`），第 3 秒说的话
   要等第 15 秒出图才随图交付（`docs/机制.md` §3 §4）。画面没变的那十几秒钱照付——**而这段时间里屏幕上
   的字，我们一个都没读**。
2. **OCR 只有一路，且是血条专用**：`src/ocr.js:1-24` 写明它是「血条数字识别」，WinRT sidecar 常驻、1fps、
   4× Lanczos + 240px 画布，只为把 `4.3%` 读成 `882/20725`。**屏幕上的字从未进过上下文**。
3. **覆盖率账只算声音**：`src/coverage.js:1-18` 的口径是「人声时间里有多少真的被转写盖住」，还带按分钟
   落盘（`src/coverage-ledger.js`）。**没有「屏幕上的字被读到了多少」这本账**——所以「漏字」现在无法归因。

参照物怎么解：`dsh-watch-along` 把三路识别搬本机、交事件不交图；`dsh-streamvision` 给出「文字流的质量闸」
与「长轮询而不是注入消息」；`dsh-better-ears` 给出「不确定就必须打印」的写法。三个都 MIT，都是**读来的**，
没抄代码。

## 已有、别重造（先对表）

| 能力 | 现状 | 结论 |
|---|---|---|
| 变化判据 | 切点 + 积分 + 背景模型 + 未来帧确认（`docs/机制.md` §1） | **比 streamvision 的三判据细**，不要照抄它的 `cutAbs/localCut/areaCut` |
| token 口径 | 222 / 392 / 560 / 860，宽度对齐 42（§4） | 已有精确账，不用重算 |
| 音频覆盖率 | `coverage.js` + `coverage-ledger.js`（人声/有声/没测到/有字四态） | 已比 watch-along 细；**新账照这个形状写** |
| 通道失败姿态 | `ocr.js` 返回 `{ok:false, reason}`，`status` 里写明「OCR 不可用」，不编数字 | 已经是好样板，扩字段而不是改姿势 |
| 黑听 / 唤醒 / 延迟 | §2 §3（含 350ms 静音判定、1.8 秒先转一版） | 不动 |
| **随图交付的先例** | `runner.attachLines()`（`src/runner.js:845-861`）把音频台词按「上一张 `wallTo` → 这一张 `wallTo`」挂到 sheet；`index.linesText()`（`src/index.js:298-329`）渲染成结果里的「台词」块 | **文字照这条挂**，不另开消息流；`peek()` 也走同一处（`src/runner.js:1906`） |
| **`preset:"subtitle"` 是图** | `src/index.js:156` + `src/tool-spec.js:161`：固定带 `[0.84, 1.0, 0.10]`（底部 16%、左右各让 10%），出的是**长条图** | 文字流不重造这块；条带坐标沿用同一口径 |

**关键复用点**：`py/ocr_sidecar.py` 这条 WinRT 常驻链路已经存在（冷启动的坑已经踩过）。它已支持
`--scale/--canvas-h/--lang`，但 `--w/--h` 在启动时定死（`py/ocr_sidecar.py:193-197`）——条带要**另起一个
`--w/--h` 是条带尺寸的 sidecar 实例**，协议不动。4×/240 是血条数字调出来的，宽条要另调（2–3× 可能够，
实测再定）。streamvision 自己实测 Windows OCR 对中文不稳（「安装」→「女装」、「目录」→`d i rectO`），
所以质量闸不是可选项。

## P1（第一批，先做这个）

**P1 只做三件：事件模型 + 闸门 → 条带 OCR → 交付 + 账。** 顺序是刻意的：闸门是纯函数，可以先写先测；
条带质量（WinRT 认中文条带行不行）是最不确定的一段，放第二步，闸门和交付形态不会被它拖住。
引擎抽象（配置 → 环境变量 → hook → 默认）和框选 UI **不进 P1**：现在只有一个引擎、hook 没有定义；
条带先用分数配置，手框留 P1.5。

### 1. 事件模型 + 闸门（纯函数，先做）

- 数据结构：`TextEvent { t0, t1, text, conf }`。`t0/t1` 用 epoch ms，和帧的 `wall` 同一坐标系；
  `t1` 先按采样间隔记，不做逐字时间。
- 入流规则：
  - 一行要被认到两次、间隔 **≥1.2 s**、且**归一化后**的 bigram 相似度 **≥0.85**（归一化：去空白、全角转
    半角、中英文标点统一）；
  - 两版取**更完整**的那版（字数优先，同字数取 `conf` 高）——**不是** streamvision 的「保留较早那版」：
    逐字出现的字幕，早版是半句（「你好」→「你好世界」），保留早版会系统性丢后半句；
  - 丢单字行：`minChars` 默认 2，可配。原任务书写的「与字幕通道同口径」没有出处（仓库里没有叫字幕
    通道的东西；`video_subtitles` 出图、`listen` 是音频转写，都没有 `minChars 2`），v2 改成自定义；
  - **跨 sheet 去重**：`attachLines` 的取数窗口有 **±400/800 ms 重叠**（`src/runner.js:854`），同一条字
    会被两张图各挂一次；事件按 `(text, t0 对齐到 0.5 s)` 去重，重复进 `deduped` 计数；
  - 预算：每次交付 **≤12 行 / ≤300 字**，超出从旧丢并写「另有 N 行」。
- 单测（`test/`）：三条规则各一；跨 sheet 去重；预算；空行 / 全角半角 / 中英标点；「更完整版」；
  `conf` 缺失。
- 验收：`node --test` 全绿。

### 2. 条带 OCR（不新增抓屏）

- **条带默认 `[0.84, 1.0]`、左右各 10%**（与 `preset:"subtitle"` 的 `[0.84,1.0,0.10]` 同口径）；
  `[0.66, 1.0]` 作为可配的宽条（会混入播放器控件 / 评论区，混入率另测）。原任务书的 0.66 默认会读进
  一大堆 UI 字，闸门救不回「读进来但认错」。
- **取帧**：在 `pipeline.push()`（`src/pipeline.js:1126`）的**原始帧**上按 1 fps 抽一帧裁条带；
  **不能只喂 sheet 里的 keep 帧**——`keep()` 会被去重挡掉（`src/pipeline.js:1106` 的注释），字幕变了也
  可能没有新 sheet，「图不变、文字可以变」正是这种情况。
- **引擎**：只做一个——`py/ocr_sidecar.py`。条带另起一个实例（`--w/--h` = 条带尺寸，`--scale 2–3`，
  `--canvas-h` 另调）；默认不下载任何模型（WinRT 用系统 OCR）。
- **失败姿态**：没装 winrt / 没中文识别器 / sidecar 起不来 → `status` 写一行原因，采集和出图照旧；
  **不在 P1 给工具返回加字段**（见第 3 步，返回形态不变）。
- **配置**：`~/.dsh/see-now.json` 的 `text` 段：`band` / `fps` / `minChars` / `lang`。P1 读到即用，不做框选 UI。
- 验收：真实视频 10 分钟（素材见第 3 步），报「入流 / 挡下 / 未确认 / 判重」四个数；中途杀掉 sidecar，
  图和声音照旧。

### 3. 交付 + 账

- **交付点三处**：loop 的**唤醒消息**、`watch` 结果、`peek` 结果（`peek()` 已经在 `src/runner.js:1895`
  走 `attachLines`）。
  - 唤醒消息带「这 15 秒屏幕文字」摘要（≤12 行 / ≤300 字），带 `textSeq` 水位；
  - `watch` / `peek` 只补**未读**（水位之后的行），避免唤醒里一份、图里再一份；
  - 「15 秒」= 与 `attachLines` 同一个窗口（上一张 `wallTo` → 这一张 `wallTo`，±400/800 ms）。
  - **为什么是唤醒消息而不是只随图**：省 token 的机制是「唤醒里已经有字 → 模型可以不拉图」；
    只随图 = 模型还得先拉图才看得到字，图 token 一分没省。这也修掉原任务书第 3 条自相矛盾的地方。
- `meta.textStats = { lines, blocked, unconfirmed, deduped, dropped, seq }`；`status` 加一行同名字段。
- `textCoverage`：**分母 = OCR 采样到「有字」的时长**（采样即分母，不新增采集），分子 = 被入流行覆盖
  的时长；像 `coverage.js` 一样带按分钟落盘可选项。**不写「0 token」**——字本身要 token；账报
  「图 token 省 X / 文字 token 花 Y / 净省 Z」。
- **行级召回**：同一段 10 分钟软字幕视频，用 ffmpeg 抽**软字幕轨**当 ground truth（没有软字幕就人工抽
  20 帧，标在文件里）；报「召回 / 入流 / 挡下」三个数，并写明分母与样本。
- **成本 A/B**：同一场景开 / 关各 5 分钟，比 **peek 率**（唤醒后还拉不拉图）、图 token、文字 token、
  **净省**、文本-only 回答数。只比总 token 分不清「省了」和「模型没看懂多问一轮」。
- 验收：闸门单测；10 分钟行级召回 + 四数；A/B 的净省与 peek 率。

## 第二批（P2）：只做失败可见化，不建事件队列

- **不建 `events.seq` / `sinceId`**：那是 streamvision 常驻事件流的架构；我们的文字已经随 sheet / 唤醒
  走，没有独立消费端，照搬会多一套状态。
- 只保留两条：三种空分开报（没开 / 开着没变化 / 上次失败）；连续失败 N 次 → 停 watcher +
  `stopReason:"error"`，接现有 `status` 行。
- 触发条件：P1 的「静默期漏字」数字证明需要时才做。

## 第三批（P3）：判据写进 status / lift 日志，不进唤醒正文

- 「每次唤醒自报判据数」会往每条唤醒里加几十到几百 token，和「省 token」直接打架；改落点：`status`
  的循环行 / `lift.jsonl` 的诊断行。用户问「你为什么醒」时模型再去读。
- 幻觉词表（「谢谢观看」「字幕由…提供」等）命中就丢，计数进 `textStats`。
- 通道降级写成一行的可读顺序：host → endpoint → command → **明说没有通道，不猜**（P3 只写日志，
  不改唤醒文案）。

## 第四批（P4，文档，等 P1 做完发版时一起改）

**先不改 README**：等 P1 落地、这版发版时顺手改，避免两次改同一处；发版时按 `AGENTS.md` 的
「发版前核 README / schema」一起核。

**问题**：上游最招恨的不是功能，是那个窗——关掉就再也调不动（[#59](https://github.com/SAOS-3624/dsh-see-now/issues/59)）、
进程活着却永远看不见（[#32](https://github.com/SAOS-3624/dsh-see-now/issues/32)）、纯色档还在 60fps 抓屏
（[#35](https://github.com/SAOS-3624/dsh-see-now/issues/35)）、`calm` 下仍被连续唤醒「体感很吵」
（[#5](https://github.com/SAOS-3624/dsh-see-now/issues/5)）。这几条我们已经修了：`hungUp` 守卫
（`src/runner.js:181-201`）、`resumeFromReopen`（`:192`）、关窗后四档（`src/index.js:2601`）、
留耳/隐身不自动支窗（`src/index.js:1160`）。**但 README 里查不到**：搜 `onWindowClose` / 留耳 / 隐身，
README 0 命中，只有 `README.md:86` 那句「点 × 只是这一次不看」。

**做什么**（只改文档，不改行为）：

1. `README.md:86` 附近补一张四档表。**语义已核到实现**，源是 `src/loop.js:874-883` 那张注释表 + 实现：

   | 档 | 画面 | 听觉 | 循环 | 会不会自己弹窗 |
   |---|---|---|---|---|
   | `stop`（默认） | 停 | 停 | 停（收工） | 否 |
   | `ears` 留耳 | 停 | **留** | 继续听 | 否（`setAutoOpenWindow(false)`） |
   | `rise` 可抬头 | 停 | **留** | 继续听 | **是**——下一次有话要说时自己把窗开回来（`loop.js:766-774`、`runner.js:1272`） |
   | `ghost` 隐身 | **继续** | **继续** | 完全不理窗没了 | 否（`setAutoOpenWindow(false)`） |

   两个坑要一起写进 README：① **关窗之后只有 `rise` 会自动重开**（`loop.js:896` 把 `autoOpenWindow`
   设成 `closeMode === 'rise'`）；② 「屏幕读取总开关」关掉时，`ghost` 退化成留耳（`index.js:1057-1058`）。
2. 给推荐组合，按「想要什么」分：**要看屏幕但不要那个窗** → `ghost`（功能全留、窗关着不弹，代价是没有
   气泡，插话得回主窗）；**只要听** → `ears`；**想让它有料时自己弹回来** → `rise`（也正是不想被弹窗的
   人该避开的唯一一档）；**全停** → `stop`。并写明默认 `stop` 是「连听觉一起停」，别让人以为关窗只是
   关画面。
3. README 与代码不一致时，**以代码行为为准改 README**，并把差异记进 `docs/决策记录.md`，不静默改文档
   去迁就代码。

**验收**：README 里 `onWindowClose` / 留耳 / 隐身 各至少 1 处命中；四档表四行与 `src/loop.js:874-883`
逐行一致（画面 / 听觉 / 循环 / 弹窗四项都对得上）；`node --test` 不红（发版第 1 步要求文档跟版本走，
2026-11-27 起 `AGENTS.md` 也明文要求发版前核 README 与 schema）。

**边界**：不改 `src/index.js` 的四档行为、不动设置页；README 与 `docs/机制.md` 的分工照旧（README 留
「用户要做的判断」）。

## 不抄（有理由）

- **SVG 转画面**（streamvision 的主路径）：精度低，我们有图；它自己也说 `sv_frame` 才看细节
- **自带 ASR 模型**（watch-along 1.6 GB / better-ears 240 MB）：我们已有 paraformer 链路，重复建设
- **一刀切 34% 条带**（watch-along）：它自认水印角标混入 10–17%；我们 `region` 手框能避开

## 参照物

- [YSBGQAQ/dsh-watch-along](https://github.com/YSBGQAQ/dsh-watch-along)（MIT，9 星）：`README.md` 致谢、
  `.scratch/watch-along/issues/09-*.md` 的覆盖率表
- [shet114513/dsh-streamvision](https://github.com/shet114513/dsh-streamvision)（MIT，11 星，0.2.8）：
  README 的「What's new in 0.2.7/0.2.8」「Watching without being woken up」
- [Destinhue/dsh-better-ears](https://github.com/Destinhue/dsh-better-ears)（MIT，5 星）：README 的
  「设计上的几条『不许撒谎』」「语音识别用哪条通道」

> 顺带的对照：watch-along 把两块不同口径的覆盖率卡并排叫「同一把尺」，是这批里最该防的写法（见
> bilibili 工作区 `bili/reviews/Review_BV1WGyrzHExU.md`）。新增 `textCoverage` 时，一句话里必须带分母与样本。

## 边界

- 本文件只到「做什么 + 验收」，不改代码；执行在 see-now-more，遵守那边 `AGENTS.md` 与
  `docs/决策记录.md` 的发版六步
- P1 没跑出数字前不开 P2；P3 是日志层；P4 是纯文档，等 P1 做完发版时一起改
- 不碰 `window.py`、不跑 `npm run sync:window`、不改 `src/tool-spec.js` 的 schema（P1 不加参数）
- 条带坐标只支持主屏（与 `region` 同一边界），副屏不做
- 文字事件**不落盘**（内存滚动窗）；以后要落盘另开一份文件，并在 README 的「它读哪些本地文件」表里写明

## 日志

- 2026-11-27 04:49 新建（进行中，未开工）。来源：bilibili 工作区评 `BV1WGyrzHExU` 时读的三个上游仓；
  本仓现状按 `docs/机制.md` §1/§3/§4 与 `src/ocr.js`、`src/coverage.js` 对表。未动代码。
- 2026-11-27 04:56 加第四批（文档）。依据：上游 issues #59/#32/#35/#5 与 `README.md:86`、
  `src/index.js:2601`、`src/index.js:1160` 对表；由格要求加入。未动代码。
- 2026-11-27 04:57 第四批的四档语义由「以设置页小字为准」改为**已核到实现**：`src/loop.js:874-883`
  的注释表 + `loop.js:766-774/896`、`runner.js:1272`、`index.js:1057-1058`。核出两处与我原写法不同：
  `ghost` 不是「隐身不采集」而是**画面/听觉/循环全继续、只是窗没了**；只有 `rise` 会自动重开窗。
  未动代码。
- 2026-11-27 05:05 v2：按本仓代码对表改写（只改文档）。改五处：① 交付口径改成「唤醒消息带摘要 +
  `watch`/`peek` 补未读（`textSeq` 水位）」，修掉原第 3 条「随图走」与「叫醒时带」的矛盾，并补上
  「`keep` 会被去重挡掉，OCR 要挂 `pipeline.push` 的原始帧」（`src/pipeline.js:1106`、`:1126`）；
  ② 闸门保留更完整版（不是较早版）、bigram 归一化、跨 sheet 去重（`src/runner.js:854`）、删掉无出处的
  「`minChars 2` 与字幕通道同口径」；③ 条带默认改 `0.84–1.0/10%`，`0.66–1.0` 只作可配；④ 成本账改成
  「净省 + peek 率 + 行级召回（软字幕轨当 ground truth）」，不写「0 token」；⑤ P2 不建事件队列、P3
  判据挪到 status/lift 日志、P4 延后到 P1 完成后发版时一起改。顺序改成「闸门 → 条带 → 交付」。未动代码。
