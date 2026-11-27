<!-- 来源：session-7ef46cbe（see-now-more 会话）。依据：上游 v0.2.9 的 CHANGELOG 与本仓源码对表。
     2026-11-27 写；只做判定，没动代码。 -->

# 上游 0.2.x 差距与采纳计划

状态：进行中（P1-B 代码已落、单测绿，**等格确认后提交**；P1-A 与清理分档未开工）
对象：把上游 `SAOS-3624/dsh-see-now` 从 v0.1.2 到 v0.2.9 之间、与本仓方向相符的能力列成判定表（搬 / 只抄数据 / 不搬），并挑出一批能立刻开工的。
归属：session-7ef46cbe-1f6f-458e-a891-337033107248 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：格确认 P1-B → 提交 → 开工 P1-A（offload）→ 再把 `docs/tasks/history-retention-tiers.md` 的清理分档并进来；
三件改完按发版六步出 `.40`。口径已于 2026-11-27 12:25 定下（见「日志」两条）。
证据：
  - 本仓无 offload：`Test-Path src\offload.js` = False；`src` 里 `图库|imageTrigger|imageKeep` 0 命中
  - 本仓只有一套阈值：`src/tiers.js:38` `LEVEL_THRESHOLDS = [0.26,0.6,0.9,1.2,1.8,2.4,3.0]`（= 上游 `docx` 那套）
  - 本仓排布只有行式：`src/pack.js:79` `rowOptions` / `:158` `precompute`；`skyline` 全仓 0 命中
  - 已经等价、不必搬：`src/index.js:211-229` 已有 define-tool 三段兜底；`src/index.js:1851` 已有 `disabled-by-user` 总开关
  - 上游侧：v0.2.9 的 `CHANGELOG.md`，`[0.2.0]` 段在第 448 行，0.1.2–0.2.9 共 12 个版本
账：无需（本轮只读上游 + 写这份文档）
更新：2026-11-27 12:32 CST

## 为什么现在写

- 上游已经到 `v0.2.9`（2026-11-25），本仓代码基线还是 `v0.1.1`（2026-11-04）——**中间 12 个版本没跟**。
- 分叉纪律在 `docs/决策记录.md:142-166`：外部契约不动、差异集中在扩展区、单向同步（上游 → 我们）。所以这不是「补齐上游」，是「从上游挑值得搬的」。
- 起因是 `v0.2.0-more.1` 在 GitHub 的 tag 下拉里一直排第一（看着像最新版）。那笔账已经算清；这份是把「当时缺的那些」逐条落到判定上。

## 判定表

| 上游能力 | 上游位置 | 本仓现状 | 判定 |
|---|---|---|---|
| 图库自动省略（offload） | `src/offload.js` + `test/offload.test.mjs` | 无（`src` 里 `imageTrigger`/`imageKeep`/`图库` 0 命中） | **搬（P1）** |
| 第二套阈值 `tierCurve` | `src/tiers.js` 双表 | 只有 `docx` 那套（`src/tiers.js:38`） | **只抄数据（P1）** |
| `tierMode: 'weight'` 按面积分档 | `src/pack.js` | 排布只有行式（`rowOptions`/`precompute`） | 抄算法（P2，先 A/B） |
| 设置页（档位/阈值进 GUI） | `src/settings-api.mjs`、`settings-trust.js` | 无 GUI 表单；有 `src/tuning.js` 校验层 | **不搬**（见下） |
| 托盘（窗收进通知区） | `examples/floating-chat/tray.py` | 无托盘；**等价入口已有**：标题栏左上角按钮（`client.js:19` → `src/open-window.js`） | **不搬**（见下） |
| 弹幕（台词飘屏） | `examples/floating-chat/danmaku.py` | 无 | **不搬** |
| Linux portal 采集 | `src/portal-capture.js`、`portal_stream.py` | 无 | **不搬** |
| 本地视频 `pause/resume/seek/configure` | 上游 `[0.2.0]` | 有 `source:"file"` 回放；暂停/跳转未逐条核 | 待核 |
| `/seenow` 斜杠命令 | 上游 `[0.2.1]` | 无 | 待定（低优先） |
| `listen.source` 按进程分声源 | 上游 `[0.2.6]` | 未核 | 待核 |
| `timeNormalizeFrames`（阈值不随 fps 漂） | 上游 `[0.2.4]` | 有自己的一套 `src/pacing.js`；差异未核 | 待核 |

**已经等价、不要重造**：define-tool 三段兜底（`src/index.js:211-229`，比上游多一条 profile 解析）、屏幕读取总开关（`src/index.js:1851` `disabled-by-user`）、排布默认不裁画面（`maxCrop`，2026-11-16 就定了）、**悬浮窗的恢复入口**（`client.js` 的标题栏按钮，对应上游的托盘）。

## P1（这一批做的两件）

挑选标准只有一条：**只减少本仓的漏账、或纯收益，不改产品形态**。这两件都不碰采集链，也不碰窗口层。

### P1-A 图库自动省略（offload）

- **目标**：会话里截图涨到 `imageTrigger`（默认 300）时，把更早的一次省到 `imageKeep`（默认 100），走宿主的 `image/offload`；`status` 多一行「图库：本次采集出 N 张」。
- **口径（2026-11-27 定）**：`imageTrigger`（`0` = 关掉整件事）/ `imageKeep`（必须 `< trigger`，否则直接报错、不干活）**只从 `see-now.json` 读**；不做上游那个 `action:"offload"` + `trigger` / `keep` 的调用级入口——工具 schema 已经顶在硬预算上（`test/tool-spec.test.mjs` 的 `SPEC_BUDGET_CHARS`，本轮实测只剩 1 个字符），而且「图留多少」是全局旋钮，不是「这次要看什么」。
- **节拍照上游，别按「每交一张立刻判」实现**：上游是每次交付后**隔 30 秒**、按会话各记一个时间戳，再 `setTimeout(0)` 甩出去（`_scratch/up-024/src/index.js:816-833`）。理由有两条：重放整份会话日志本身要几十到几百毫秒；trigger/keep 的攒批意义在于「攒 200 张才重写一次历史」，每张都改历史会让前缀缓存每轮全废，比不省还贵（`offload.js:165` 与上游 `help.js` 的 offload 节）。**交付不能被它拖慢。**
- **为什么值得**：本仓现在是**只增不减**——读字幕档 1–2 fps，一次长会话几十张图挂在会话里，上下文和会话文件一起涨。这是纯漏账，没有任何取舍。
- **步骤**：读上游 `src/offload.js` 与它那组测试 → 本仓新建 `src/offload.js`，挂到 `afterDelivery` 那条路径上（照上游的节流检查，不在交付路径里同步等）→ `status` 渲染加「图库」行 → 单测（阈值边界 / keep 数量 / 宿主没这个能力时不崩）。
- **验收**：`node --test` 全过；单测用小阈值（如 trigger=5、keep=2）跑真实触发；宿主缺 `image/offload` 时 `status` 只报数、不省略、不报错。
- **风险**：`image/offload` 是宿主能力，DSH 版本不同可能没有 → 先 capability 探测，缺了就退化。
- **同批要改的另一半（2026-11-27 格提）**：浮窗历史底部「☐ 自动清理超过 30 天的记录」
  现在只有开关、天数写死 30，要改成 3 / 7 / 14 分档。这是同一个旋钮的两头
  （图留多少 / 记录留多久），见 `docs/tasks/history-retention-tiers.md`。

### P1-B 第二套阈值曲线（tierCurve）

- **目标**：`tierCurve: 'docx' | 'perceptual'`，默认 `docx`；**只影响一张图里格子多大**，不改切点、不改「一格代表多少秒」。
- **数据现成**：`perceptual` 七道 = 0.333 / 0.489 / 0.718 / 1.054 / 1.547 / 2.271 / 3.333 帧每秒。上游实测 PV 11 张→9 张（-18% token/分）、游戏 7→6（-14%），平均档位 +0.5。
- **步骤**：`src/tiers.js` 加 `PERCEPTUAL_THRESHOLDS`（frozen，紧挨 `LEVEL_THRESHOLDS`）→ `createTiers` 走已有的 `thresholds` 参数（`src/tiers.js:72`）→ `src/tuning.js` 加键与校验（**二选一**：`docx` / `perceptual`，坏值退回 `docx` 并报一条 warn）→ **只从 `see-now.json` 读**，不进工具 schema。
- **为什么不进 schema（2026-11-27 定）**：上游 `0.2.4` 的 schema 有 `tier`、没有 `tierCurve`；它把曲线放在 `tuning.js` + help 文本 + `status` 里（`_scratch/up-024/src/tuning.js:393`、`help.js:61-70`）。外部契约照上游，位置也就照上游。本仓同类先例是 `packStretch`（`src/tuning.js:85-92`）——同样是排布旋钮，同样只走配置。代价说清：调用级选不了，改配置要重开 DSH。以后真要按内容自动切，挂「预设 n 选 1」那条路（它本来就是一次点击改写一组配置），别往 schema 里塞。
- **不搬 `custom`**（上游第三个值，读 `tierThresholds`：7 个严格递增的帧/秒数）：`perceptual` 还没在本机真实素材上出过数，先不开这条后门；要开的时候单独写一份任务书，别在这一批顺手带上。
- **验收**：单测（两套表切换后档位符合预期；坏值退回 docx 并有一条 warn）；`status` 里能看出当前是哪套曲线——照上游「只报非默认层」的写法（`判据 weight · 阈值 perceptual`），不新增一行常驻文字。

## 先不做（写清原因）

- **托盘**：恢复入口我们**已经有了**——`conversation.header.leading` 槽位那个按钮（`client.js:19`），点一下 POST `/dsh-see-now-window/open`，三种状态（进程没起 / 被藏了 / 心跳过期）走同一条路，还会把窗绑到点开它的那个会话（`src/open-window.js:8-19`）。关窗本身也有四档（`onWindowClose: stop/ears/rise/ghost`，`src/tuning.js:23`），所以「关窗」不等于收工。托盘唯一还多给的是**DSH 主窗自己最小化、或人不在主窗时**也能点回来；补它要在窗口进程里做 `Shell_NotifyIconW` + 子线程消息泵（上游 `tray.py` 346 行），为这一种情形不值。
- **弹幕**：真没有，且要往 `window.py` 里加一层横跨整屏的透明窗（`WS_EX_TRANSPARENT` 才能不挡点击、又不能同时用 `-alpha`），那是产品形态差异——给「全屏看剧的人」，不给我们这条「边聊边看」的线。
- **设置页**：本仓参数走 `see-now.json` + 浮窗的预设面板；再做一套 GUI 表单就是第二个真相源，还要处理「表单存的与手改 JSON 谁赢」。上游自己在 0.2.0 就栽过（幽灵字段让改什么都不给存）。
- **Linux / portal**：`docs/决策记录.md:72` 已定不做 macOS；Linux 同理不在支持面，搬了也没人能验。
- **`sync:window` 同步上游窗口**：`docs/决策记录.md:69` 明确禁跑——它会用上游覆盖我们的 `window.py`。

## 边界

- 不动外部契约：工具名、参数名、返回字段、落盘格式照上游；新能力只以**新增**出现（`tierCurve` 新键、`status` 新行）。
- **新旋钮一律先走 `see-now.json`**：工具 schema 顶在硬预算上，只有「这一次要看什么」（`source` / `region` / `preset` / `pace` 这类）才值得占它的字；管「全局怎么渲染、留多少」的（`tierCurve`、`imageTrigger` / `imageKeep`、`packStretch`）都进配置，可见性靠 `status` 报非默认值。
- 不为了「和上游版本号对齐」改 `-more.N`；版本先后按时间与 commit 看。
- 这一批不引入任何新的宿主 API，除 `image/offload` 一个。
- README 的「与上游差异」段等 P1 落地再一起改（发版六步第 1 步）；同一笔还要补 `决策记录.md` 那句版本口径，见「日志」的待办条。

## 日志

- 2026-11-27 10:06 新建（等你定）。依据：上游 v0.2.9 的 `CHANGELOG.md`（`[0.2.0]` 在第 448 行、0.1.2–0.2.9 共 12 个版本）与本仓源码逐条对表（`src/tiers.js:38`、`src/pack.js:79`/`:158`、`Test-Path src\offload.js` = False、`src/index.js:211-229`、`src/index.js:1851`）。只读 + 写本文件，没动代码。
- 2026-11-27 10:09 修正「托盘」判定：格指出本仓的等价物是主窗会话页标题左边的入口。核对为真——`client.js:19` 注册 `conversation.header.leading`，走 `src/open-window.js` 的三态开窗；判定表、「先不做」、「已等价」三处改口，托盘的残留差异收窄到「DSH 主窗自己也最小化时怎么点回来」。
- 2026-11-27 10:19 相关：定位层面的另一份任务书 `docs/tasks/window-supervisor.md`（独立启动 / 重启 DSH / 回来自核）。两份并行，互不阻塞。
- 2026-11-27 12:25 定口径（格：按你觉得合理的做）。`tierCurve` **二选一**（`docx` / `perceptual`），不搬上游的 `custom`；**只从 `see-now.json` 读、不进工具 schema**。offload 的 `imageTrigger` / `imageKeep` 同理走配置、不做 `action:"offload"` 的调用级入口，并补上上游的 30 秒节流与攒批理由。依据：上游 `_scratch/up-024` 的 `src/tool-spec.js`（参数表有 `tier`、无 `tierCurve`）、`src/tuning.js:210` / `:393`、`src/index.js:816`（`OFFLOAD_THROTTLE_MS = 30_000`）、`src/help.js:61-70`；本仓 `src/tuning.js:85-92` 的 `packStretch` 先例与 `test/tool-spec.test.mjs` 的预算守卫。
- 2026-11-27 12:25 待办（挂在发版那笔，别漏）：`.40` 的第 1 步（对齐文档）补两处——① `docs/决策记录.md` 的「分发与版本」加一句「版本前缀跟 merge 基线走，不跟 cherry-pick 数量走；跟没跟上上游看断言集，不看版本号」；② `README.md` 的「维护状态与上游关系」补「分叉基线 v0.1.1，已选择性移植上游 0.2.x 的 …」。版本号本身不改，`.40` 仍是 `0.1.1-more.40`。决策会话：session-75d744a0。
- 2026-11-27 12:32 P1-B 落了代码（**未提交**，等格点头）：`src/tiers.js` 加 `PERCEPTUAL_THRESHOLDS` / `TIER_CURVES` / `TIER_CURVE_KEYS` / `thresholdsFor()` / `tierCurveNote()`；`src/tuning.js` 加 `tierCurve`（二选一、坏值 warn 退 `docx`）；`src/pipeline.js` 让 `createTiers` 走 `o.thresholds ?? thresholdsFor(o.tierCurve)`（另留显式 `thresholds` 入口，离线 A/B 用）；`src/runner.js` 一路带进管线；`src/index.js` 接 `tuning.tierCurve`，`status` 的「模式」行只报非默认层。新单测 `test/tier-curve.test.mjs` 六条（表形状 / `thresholdsFor` / 同密度不同档位 / 配置退回 / 端到端接线 / status 段）；`node --test` 485 全过（本轮实测）。README 的 `see-now.json` 表加了 `tierCurve` 行（发版六步第 1 步）。
  端到端接线用合成素材验（每 0.5 秒整屏换色 → 密度约 2 帧/秒）：两套表留帧数一样、perceptual 稳态档位高一档；单测断言的是**方向**不是具体档位，具体数看 `scripts/sim.mjs --tierCurve=perceptual` 的真素材 A/B。
  **真机没验**：`status` 那行要装进 profile（`install-dev` + 重开 DSH）才看得到，这一批没装。
