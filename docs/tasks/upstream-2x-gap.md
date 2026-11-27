<!-- 来源：session-7ef46cbe（see-now-more 会话）。依据：上游 v0.2.9 的 CHANGELOG 与本仓源码对表。
     2026-11-27 写；只做判定，没动代码。 -->

# 上游 0.2.x 差距与采纳计划

状态：等你定
对象：把上游 `SAOS-3624/dsh-see-now` 从 v0.1.2 到 v0.2.9 之间、与本仓方向相符的能力列成判定表（搬 / 只抄数据 / 不搬），并挑出一批能立刻开工的。
归属：session-7ef46cbe-1f6f-458e-a891-337033107248 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：你挑批次；默认建议 P1 = 图库自动省略 + 第二套阈值曲线。点头后开工。
证据：
  - 本仓无 offload：`Test-Path src\offload.js` = False；`src` 里 `图库|imageTrigger|imageKeep` 0 命中
  - 本仓只有一套阈值：`src/tiers.js:38` `LEVEL_THRESHOLDS = [0.26,0.6,0.9,1.2,1.8,2.4,3.0]`（= 上游 `docx` 那套）
  - 本仓排布只有行式：`src/pack.js:79` `rowOptions` / `:158` `precompute`；`skyline` 全仓 0 命中
  - 已经等价、不必搬：`src/index.js:211-229` 已有 define-tool 三段兜底；`src/index.js:1851` 已有 `disabled-by-user` 总开关
  - 上游侧：v0.2.9 的 `CHANGELOG.md`，`[0.2.0]` 段在第 448 行，0.1.2–0.2.9 共 12 个版本
账：无需（本轮只读上游 + 写这份文档）
更新：2026-11-27 10:06 CST

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

## P1（建议先做这两件）

挑选标准只有一条：**只减少本仓的漏账、或纯收益，不改产品形态**。这两件都不碰采集链，也不碰窗口层。

### P1-A 图库自动省略（offload）

- **目标**：会话里截图涨到 `imageTrigger`（默认 300）时，把更早的一次省到 `imageKeep`（默认 100），走宿主的 `image/offload`；`status` 多一行「图库：本次采集出 N 张」。
- **为什么值得**：本仓现在是**只增不减**——读字幕档 1–2 fps，一次长会话几十张图挂在会话里，上下文和会话文件一起涨。这是纯漏账，没有任何取舍。
- **步骤**：读上游 `src/offload.js` 与它那组测试 → 本仓新建 `src/offload.js`，接到出图交付路径上（每交付一张 +1）→ `status` 渲染加「图库」行 → 单测（阈值边界 / keep 数量 / 宿主没这个能力时不崩）。
- **验收**：`node --test` 全过；单测用小阈值（如 trigger=5、keep=2）跑真实触发；宿主缺 `image/offload` 时 `status` 只报数、不省略、不报错。
- **风险**：`image/offload` 是宿主能力，DSH 版本不同可能没有 → 先 capability 探测，缺了就退化。
- **同批要改的另一半（2026-11-27 格提）**：浮窗历史底部「☐ 自动清理超过 30 天的记录」
  现在只有开关、天数写死 30，要改成 3 / 7 / 14 分档。这是同一个旋钮的两头
  （图留多少 / 记录留多久），见 `docs/tasks/history-retention-tiers.md`。

### P1-B 第二套阈值曲线（tierCurve）

- **目标**：`tierCurve: 'docx' | 'perceptual'`，默认 `docx`；**只影响一张图里格子多大**，不改切点、不改「一格代表多少秒」。
- **数据现成**：`perceptual` 七道 = 0.333 / 0.489 / 0.718 / 1.054 / 1.547 / 2.271 / 3.333 帧每秒。上游实测 PV 11 张→9 张（-18% token/分）、游戏 7→6（-14%），平均档位 +0.5。
- **步骤**：`src/tiers.js` 加 `PERCEPTUAL_THRESHOLDS`（frozen，紧挨 `LEVEL_THRESHOLDS`）→ `createTiers` 走已有的 `thresholds` 参数（`src/tiers.js:72`）→ `src/tuning.js` 加键与校验（三选一，坏值退回默认并报 warn）→ 只从 `see-now.json` / 调用参数读。
- **验收**：单测（两套表切换后档位符合预期；坏值退回 docx 并有一条 warn）；`status` 里能看出当前是哪套曲线。

## 先不做（写清原因）

- **托盘**：恢复入口我们**已经有了**——`conversation.header.leading` 槽位那个按钮（`client.js:19`），点一下 POST `/dsh-see-now-window/open`，三种状态（进程没起 / 被藏了 / 心跳过期）走同一条路，还会把窗绑到点开它的那个会话（`src/open-window.js:8-19`）。关窗本身也有四档（`onWindowClose: stop/ears/rise/ghost`，`src/tuning.js:23`），所以「关窗」不等于收工。托盘唯一还多给的是**DSH 主窗自己最小化、或人不在主窗时**也能点回来；补它要在窗口进程里做 `Shell_NotifyIconW` + 子线程消息泵（上游 `tray.py` 346 行），为这一种情形不值。
- **弹幕**：真没有，且要往 `window.py` 里加一层横跨整屏的透明窗（`WS_EX_TRANSPARENT` 才能不挡点击、又不能同时用 `-alpha`），那是产品形态差异——给「全屏看剧的人」，不给我们这条「边聊边看」的线。
- **设置页**：本仓参数走 `see-now.json` + 浮窗的预设面板；再做一套 GUI 表单就是第二个真相源，还要处理「表单存的与手改 JSON 谁赢」。上游自己在 0.2.0 就栽过（幽灵字段让改什么都不给存）。
- **Linux / portal**：`docs/决策记录.md:72` 已定不做 macOS；Linux 同理不在支持面，搬了也没人能验。
- **`sync:window` 同步上游窗口**：`docs/决策记录.md:69` 明确禁跑——它会用上游覆盖我们的 `window.py`。

## 边界

- 不动外部契约：工具名、参数名、返回字段、落盘格式照上游；新能力只以**新增**出现（`tierCurve` 新键、`status` 新行）。
- 不为了「和上游版本号对齐」改 `-more.N`；版本先后按时间与 commit 看。
- 这一批不引入任何新的宿主 API，除 `image/offload` 一个。
- README 的「与上游差异」段等 P1 落地再一起改（发版六步第 1 步）。

## 日志

- 2026-11-27 10:06 新建（等你定）。依据：上游 v0.2.9 的 `CHANGELOG.md`（`[0.2.0]` 在第 448 行、0.1.2–0.2.9 共 12 个版本）与本仓源码逐条对表（`src/tiers.js:38`、`src/pack.js:79`/`:158`、`Test-Path src\offload.js` = False、`src/index.js:211-229`、`src/index.js:1851`）。只读 + 写本文件，没动代码。
- 2026-11-27 10:09 修正「托盘」判定：格指出本仓的等价物是主窗会话页标题左边的入口。核对为真——`client.js:19` 注册 `conversation.header.leading`，走 `src/open-window.js` 的三态开窗；判定表、「先不做」、「已等价」三处改口，托盘的残留差异收窄到「DSH 主窗自己也最小化时怎么点回来」。
- 2026-11-27 10:19 相关：定位层面的另一份任务书 `docs/tasks/window-supervisor.md`（独立启动 / 重启 DSH / 回来自核）。两份并行，互不阻塞。
