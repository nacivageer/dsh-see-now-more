<!-- 来源：session-40cc9db3（bilibili 工作区评 BV1WGyrzHExU 时读到的三个上游仓）。执行在 see-now-more。 -->

# 屏幕文字事件流：让静默期不花 token

状态：进行中（未开工）
对象：给 see-now-more 加一条**屏幕文字事件流**——把画面上的字（尤其底部字幕带）变成带时间码的文本事件，随图交付而不是另开一路；做到「静默期只入队不进上下文、说话时少漏字、有本账能算清省了多少」。
归属：session-40cc9db3-6a98-481e-8252-9da96f75f401（bilibili 工作区出方案）/ 执行在 `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：see-now-more 会话按「第一批」开工；第二批要等第一批的数字出来再定。
证据：参照物的三个仓都实读过 README（2026-11-27 04:45–04:48，GitHub API 经代理）；本仓现状见下文「已有、别重造」的 `文件:行` 与 `docs/机制.md` 小节号。
账：无需（本文件只出方案）
更新：2026-11-27 04:49 CST

## 为什么值得做（三条已核）

1. **我们的成本是「按图、按 15 秒」**：`low` 档一张图 222 token，一张图覆盖 15 秒（`maxWaitSec`），第 3 秒说的话要等第 15 秒出图才随图交付（`docs/机制.md` §3 §4）。画面没变的那十几秒，钱照付——**而这段时间里屏幕上的字，我们一个都没读**。
2. **我们的 OCR 只有一路，且是血条专用**：`src/ocr.js:1-24` 写明它是「血条数字识别」，WinRT sidecar 常驻、1fps、4× Lanczos + 240px 画布，只为把 `4.3%` 读成 `882/20725`。**屏幕上的字从未进过上下文**。
3. **我们有覆盖率账，但只算声音**：`src/coverage.js:1-18` 的口径是「人声时间里有多少真的被转写盖住」，还带按分钟落盘（`src/coverage-ledger.js`）。**没有「屏幕上的字被读到了多少」这本账**——所以「漏字」这件事现在无法归因。

参照物怎么解：`dsh-watch-along` 把三路识别搬本机、交事件不交图；`dsh-streamvision` 给出「文字流的质量闸」与「长轮询而不是注入消息」；`dsh-better-ears` 给出「不确定就必须打印」的写法。三个都 MIT，都是**读来的**，没抄代码。

## 已有、别重造（先对表）

| 能力 | 现状 | 结论 |
|---|---|---|
| 变化判据 | 切点 + 积分 + 背景模型 + 未来帧确认（`docs/机制.md` §1） | **比 streamvision 的三判据细**，不要照抄它的 `cutAbs/localCut/areaCut` |
| token 口径 | 222 / 392 / 560 / 860，宽度对齐 42（§4） | 已有精确账，不用重算 |
| 音频覆盖率 | `coverage.js` + `coverage-ledger.js`（人声/有声/没测到/有字四态） | 已比 watch-along 细；**新账照这个形状写** |
| 通道失败姿态 | `ocr.js` 返回 `{ok:false, reason}`，`status` 里写明「OCR 不可用」，不编数字 | 已经是好样板，扩字段而不是改姿势 |
| 黑听 / 唤醒 / 延迟 | §2 §3（含 350ms 静音判定、1.8 秒先转一版） | 不动 |

**关键复用点**：`py/ocr_sidecar.py` 这条 WinRT 常驻链路已经存在（冷启动几百毫秒的坑已经踩过、常驻方案已经定了）。文字流**不需要新依赖**，只是把画布从「数字块」换成「字幕带长条」，预处理参数另给。streamvision 自己实测 Windows OCR 对中文不稳（「安装」→「女装」、「目录」→`d i rectO`）——所以质量闸不是可选项，见第一批第 2 条。

## 第一批（P1，先做这个）

1. **条带与引擎**
   - 条带可配（默认底部 0.66–1.0，与 `preset:"subtitle"` 同一坐标口径）；一次框定后不随窗口移动跟随，与 `region` 的已知边界一致
   - 引擎可插拔，按 streamvision 的顺序：本机配置 → 环境变量 → hook → 默认 WinRT sidecar。**默认不下载任何模型**
2. **质量闸（这条最关键，抄 streamvision 的 Text stream）**
   - 一行要**被认到两次、间隔 ≥1.2 s、bigram 相似度 ≥0.85** 才入流，保留较早那一版
   - 丢单字行（`minChars 2`，与字幕通道同口径）
   - 三个计数都要进 `status`：挡下的、未确认的、判重的
3. **交付形态**
   - `watch` 返回里加 `text[]`（`t0/t1/text/conf`），**随图走**：图不变、文字可以变
   - 静默期只入队、不进上下文；被叫醒时才带上「这 15 秒的字」
4. **成本账**
   - 新增 `textCoverage`：有字时长 ∩ 屏幕有字时长 / 屏幕有字时长（口径照 `coverage.js`，不新增采集）
   - 报两个数：「每张图多带 N 行字、0 token」「静默期少开几张图」
5. **验收（三条可观察）**
   - 单测：闸门三条各一（两次 / 间隔 / bigram），见 `test/`
   - 一局 10 分钟录像：入流行数、被闸挡下数、与人工抽 20 帧的字行重合率
   - token：同一场景开 / 关文字流各 5 分钟，比唤醒次数与总 token

## 第二批（P2）：事件队列与失败可见化（抄 streamvision）

- **不注入消息、按 unread 拉**：它的理由是「注入一条消息 = 起一个新回合 = 重读一遍上下文，比留在同一回合贵得多」。我们的 `watch` 已经是同回合长轮询，但**叫醒**仍是新回合——所以第二批做的是「静默累积 + 一次带走」，不是改 `watch`
- 高水位线跨重启（`data/events.seq` 那种形状）；`sinceId` 太旧要**标记** `staleSince`，不静默跳过
- 三种空分开报：没开 / 开着没变化 / 上次失败（对照 streamvision 0.2.8 的修法）
- 连续失败 N 次 → 停 watcher + `stopReason:"error"`，并接现有 `status` 行

## 第三批（P3）：不确定性的写法（抄 better-ears）

- 每次唤醒**自报判据数**：score / mc / area / 阈值各是多少，不只说「有变化」（它的 BPM ambiguity、小节相位「归属不确定」是同一个思路）
- 通道降级写成一行的可读顺序：host → endpoint → command → **明说没有通道，不猜**
- 幻觉词表（「谢谢观看」「字幕由…提供」等）命中就丢，但**要计数**

## 第四批（P4，文档）：把「关窗后四档」写进 README

**问题**：上游最招恨的不是功能，是那个窗——关掉就再也调不动（[#59](https://github.com/SAOS-3624/dsh-see-now/issues/59)）、进程活着却永远看不见（[#32](https://github.com/SAOS-3624/dsh-see-now/issues/32)）、纯色档还在 60fps 抓屏（[#35](https://github.com/SAOS-3624/dsh-see-now/issues/35)）、`calm` 下仍被连续唤醒「体感很吵」（[#5](https://github.com/SAOS-3624/dsh-see-now/issues/5)）。这几条我们已经修了：`hungUp` 守卫（`src/runner.js:181-201`）、`resumeFromReopen`（`:192`）、关窗后四档（`src/index.js:2601`）、留耳/隐身不自动支窗（`src/index.js:1160`）。**但 README 里查不到**：搜 `onWindowClose` / 留耳 / 隐身，README 0 命中，只有 `README.md:86` 那句「点 × 只是这一次不看」。

**做什么**（只改文档，不改行为）：

1. `README.md:86` 附近补一张四档表。**语义已核到实现**，源是 `src/loop.js:874-883` 那张注释表 + 实现：

   | 档 | 画面 | 听觉 | 循环 | 会不会自己弹窗 |
   |---|---|---|---|---|
   | `stop`（默认） | 停 | 停 | 停（收工） | 否 |
   | `ears` 留耳 | 停 | **留** | 继续听 | 否（`setAutoOpenWindow(false)`） |
   | `rise` 可抬头 | 停 | **留** | 继续听 | **是**——下一次有话要说时自己把窗开回来（`loop.js:766-774`、`runner.js:1272`） |
   | `ghost` 隐身 | **继续** | **继续** | 完全不理窗没了 | 否（`setAutoOpenWindow(false)`） |

   两个坑要一起写进 README：① **关窗之后只有 `rise` 会自动重开**（`loop.js:896` 把 `autoOpenWindow` 设成 `closeMode === 'rise'`）；② 「屏幕读取总开关」关掉时，`ghost` 退化成留耳（`index.js:1057-1058`）。
2. 给推荐组合，按「想要什么」分：**要看屏幕但不要那个窗** → `ghost`（功能全留、窗关着不弹，代价是没有气泡，插话得回主窗）；**只要听** → `ears`；**想让它有料时自己弹回来** → `rise`（也正是不想被弹窗的人该避开的唯一一档）；**全停** → `stop`。并写明默认 `stop` 是「连听觉一起停」，别让人以为关窗只是关画面。
3. README 与代码不一致时，**以代码行为为准改 README**，并把差异记进 `docs/决策记录.md`，不静默改文档去迁就代码。

**验收**：README 里 `onWindowClose` / 留耳 / 隐身 各至少 1 处命中；四档表四行与 `src/loop.js:874-883` 逐行一致（画面 / 听觉 / 循环 / 弹窗四项都对得上）；`node --test` 不红（发版第 1 步要求文档跟版本走）。

**边界**：不改 `src/index.js` 的四档行为、不动设置页；README 与 `docs/机制.md` 的分工照旧（README 留「用户要做的判断」）。

## 不抄（有理由）

- **SVG 转画面**（streamvision 的主路径）：精度低，我们有图；它自己也说 `sv_frame` 才看细节
- **自带 ASR 模型**（watch-along 1.6 GB / better-ears 240 MB）：我们已有 paraformer 链路，重复建设
- **一刀切 34% 条带**（watch-along）：它自认水印角标混入 10–17%；我们 `region` 手框能避开

## 参照物

- [YSBGQAQ/dsh-watch-along](https://github.com/YSBGQAQ/dsh-watch-along)（MIT，9 星）：`README.md` 致谢、`.scratch/watch-along/issues/09-*.md` 的覆盖率表
- [shet114513/dsh-streamvision](https://github.com/shet114513/dsh-streamvision)（MIT，11 星，0.2.8）：README 的「What's new in 0.2.7/0.2.8」「Watching without being woken up」
- [Destinhue/dsh-better-ears](https://github.com/Destinhue/dsh-better-ears)（MIT，5 星）：README 的「设计上的几条『不许撒谎』」「语音识别用哪条通道」

> 顺带的对照：watch-along 把两块不同口径的覆盖率卡并排叫「同一把尺」，是这批里最该防的写法（见 bilibili 工作区 `bili/reviews/Review_BV1WGyrzHExU.md`）。新增 `textCoverage` 时，一句话里必须带分母与样本。

## 边界

- 本文件只到「做什么 + 验收」，不改代码；执行在 see-now-more，遵守那边 `AGENTS.md` 与 `docs/决策记录.md` 的发版六步
- 第一批没跑出数字前不开第二批；第三批是日志层、第四批是纯文档，这两批随时可插
- 不碰 `window.py`、不跑 `npm run sync:window`
- 条带坐标只支持主屏（与 `region` 同一边界），副屏不做

## 日志

- 2026-11-27 04:49 新建（进行中，未开工）。来源：bilibili 工作区评 `BV1WGyrzHExU` 时读的三个上游仓；本仓现状按 `docs/机制.md` §1/§3/§4 与 `src/ocr.js`、`src/coverage.js` 对表。未动代码。
- 2026-11-27 04:56 加第四批（文档）。依据：上游 issues #59/#32/#35/#5 与 `README.md:86`、`src/index.js:2601`、`src/index.js:1160` 对表；由格要求加入。未动代码。
- 2026-11-27 04:57 第四批的四档语义由「以设置页小字为准」改为**已核到实现**：`src/loop.js:874-883` 的注释表 + `loop.js:766-774/896`、`runner.js:1272`、`index.js:1057-1058`。核出两处与我原写法不同：`ghost` 不是「隐身不采集」而是**画面/听觉/循环全继续、只是窗没了**；只有 `rise` 会自动重开窗。未动代码。