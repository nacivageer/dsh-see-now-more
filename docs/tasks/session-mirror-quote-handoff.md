# 交接：浮窗同步主窗消息 + 气泡选区「引用选中文字」（see-now-more）

> 交接给 **see-now-more 工作区**的下一个会话。本文件自包含：现在到哪了、下一步做什么、坑在哪、怎么验收。
> 写于 2026-11-26 08:40 CST，来自 session-a58208c0。格明确说：**先不要开工**，等她说开工再动功能 1。

## 状态

- 状态：任务书完成 + 上游 `.28` 已发 / 已装；**功能 1、2 均未开工**（没有改 `src/` 与功能相关代码）
- 对象：给悬浮窗补两条——① 主聊天窗同步绑定会话里用户在主窗发的消息（实时 + 回填）；② 气泡选区右键「引用选中文字」，输入区引号 chip，发送为 DSH 同款 Markdown blockquote
- 归属：session-a58208c0-82bc-48b0-ad40-6cbf7a9a7756（写）/ `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
- 下一步：**等格说开工**；开工前重启 DSH 让 `.28` 生效，先和她对齐任务书验收 A/B/C 三条，再按「任务顺序」1→8
- 证据：`node --test` 366 项 / 363 过 / 0 失败 / 3 skip；`.28` 已装（`install-dev --check` = current）；任务书与交接文均已提交
- 更新：2026-11-26 08:40 CST

## 一句话

上游 v0.2.9 的麦克风修复已经发成 `0.1.1-more.28` 并装进 profile（**重启 DSH 才生效**）；两项功能的方案、拍板项、验收、watch-together 参考都已写进任务书，但一行功能代码都还没写。

## 已经做完的

### 1. 任务书（主文件）

`docs/tasks/session-mirror-quote.md` —— 方案、拍板项、实现落点、任务顺序、10 条验收、风险、日志都在里面。最后一次更新 `0ea32ca`（补 watch-together 参考）。开工前先通读这一份，不要另起方案。

### 2. 上游 v0.2.9 回移 + 发版 `.28`

- 内容：`mic.py` 的 `resolve_models_dir`（`--models-dir` → `DSH_ASR_MODELS` → `<DSH_HOME>/asr-models/sherpa` → 旧 `D:/asr-local`；显式目录缺文件 exit 2、列缺哪几个；http 只查 VAD）；`window.py` 的 `_on_mic_exit` + stderr 泵（只留内存、跳过 `识别` 转写行、不落盘）；本仓额外 `_mic_models_from_asr()`（从 `asr.json` 的 `--vad` / `--punct` 反推 mic 的 sherpa 目录）。
- 提交 `e80403a`；tag `v0.1.1-more.28`；Release <https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.28>（prerelease）。
- `install-dev.mjs` 已把 desktop profile 同步到 `.28`，旧副本备份在 `~/.dsh/backups/dsh-see-now-more/2026-11-26T00-18-26-754Z`。**运行中的 DSH 还是 `.27`，重启后才换。**
- 详细验收数据在 CHANGELOG 的 `.28` 段；任务书「上游 v0.2.9」节保留改动前快照。

### 3. watch-together v0.3.7 参考

看过 `SAOS-3624/dsh-watch-together`，它**没有**用户消息镜像，也**没有**引用/选区菜单，两项功能仍按我们的方案做。只借了 4 个模式，已写进任务书「参考」节：

- `chat-store.js` 的 `at` 严格单调（`tailStamp`）→ 我们改用 `mid` 进 ChatFeed 去重键；
- `writtenKeys` 跨写路径共用去重账 → live / backfill 共用 `mid` 集合，启动扫 `chat.jsonl` 尾部补齐；
- 0.3.3 的 outbox 水位 → 对应我们的 `throughSeq`；
- 测试形状：`interject-anywhere.test.mjs`（等待者优先）+ `check-input-select.py`（无 GUI 测真实方法）。

**不借**：outbox 不是聊天输入通道（上游只做 pause/resume，用户文字仍走 `chat.jsonl`），不能替我们消掉四个消费点；`window-events` 双写、视频模块、整体 32 模块拆分都不做。

## 开工前必须知道的

- **先重启 DSH**。插件树在进程启动时组合，不重启的话跑的还是 `.27`。重启后跑 `node scripts/install-dev.mjs --check`，应显示 `current`（副本 `.28` / 源码 `.28`）。
- **本机点 🎤 的预期**：会看到 `麦没起来：挂了：Error querying device -1`。这不是 `.28` 引入的故障——这台机器没有可用输入端点，`.28` 做的是「把原因显示出来、不被 250ms 轮询抹掉」。真机麦克风成功路径仍未验证；有麦克风时才算补上。
- **`~/.dsh/asr.json` 的 `--models` 是 ASR 服务的 SenseVoice 目录，不是 mic 的 paraformer 目录。** 不要把它当 `--models-dir` 传给 `mic.py`，否则新校验会报「模型不完整」并把麦克风弄哑。窗口用 `_mic_models_from_asr()` 从 `--vad` / `--punct` 反推正确的 sherpa 目录（本机是 `H:\asr-local\models-sherpa\sherpa-onnx-paraformer-zh-2024-03-09`），设给子进程的 `DSH_ASR_MODELS`。
- **`window.py` 是 10.9k 行的重改版**（watch-together 那份约 2.4k 行，没有历史/收藏/绑定）。**不要跑 `npm run sync:window`，不要整文件覆盖**；只按任务书做局部改动。文件头写着「生成文件」，但本仓早已按分叉纪律手改，照旧。
- **`window-outbox` 不是聊天输入通道**（见上），功能 1 继续走 `chat.jsonl` + `origin:"dsh"` + 四处过滤，不要为它迁协议。
- **`mic.py --help` 在 PATH 的 Python 3.14 上会撞 argparse 的 `%` 老 bug**（不是 `.28` 引入）；窗口实际用 ASR venv 的 3.12，不受影响。别把它当成回归。
- 当前 `~/.dsh/see-now.json` 的 `session` 绑的是 `session-880ed9d0-…`（bilibili 那条），不是本会话。测功能 1 时先用窗顶【关联变更】绑到测试会话；`chat.jsonl` 里现在这条会话是 0 条。
- 任务书里已经写死的三个补丁，开工时直接做：`ChatFeed` 去重键加 `mid`；启动扫 `chat.jsonl` 尾部已有 `mid`；`scripts/check-quote.py` 无 GUI harness + 「镜像条目不唤醒 loop/watch」测试。

## 下一步（按任务书顺序）

1. **重启 DSH，确认 `.28` 生效**：`node scripts/install-dev.mjs --check`；点 🎤 看状态行是否显示 `麦没起来：…`（预期失败原因）；`node --test` 仍应 366/363/0/3。
2. **功能 1（消息同步）**：
   - 判据层：`src/human.js` 加 `isTypedUserMessage`；`src/chat.js` 加 `isFloatUserEntry` 并让 `appendChat` 支持 `{sid, at, mid, origin}`；先写单测。
   - 镜像核心：`src/mirror.js`（新）实现 `onEvent` / `backfill` / 水位 / `mid` 扫描 / `mirror.log`；接到 `src/index.js` 的 `session/event` 钩子与 `modeWatcher`；四处消费点过滤。
   - 窗口侧：`ChatFeed` 去重键加 `mid`、按 `at` 排序；`_history_entries` 先排序再取 500。
   - 单测 + 手工：主窗发一句 → 浮窗 1 秒内出现；浮窗发的话不镜像回来；relay 启动补投不重投。
3. **功能 2（引用）**：
   - `quote_text.py` 纯函数（`format_quote_text` / `split_quote_blocks` / `quote_preview`）+ `scripts/check-quote.py`。
   - `window.py`：菜单项、`_draft_quote`、chip 绘制、`_input_text_x` 偏移、退格/Delete、发送拼装。
   - 气泡：只对 `role=="user"` 认 `>` 块，主窗 + 回顾窗都要处理；assistant 的 `>` 保持原样。
   - `src/interject.js`：开头引用块原样放最前、不参与 200 字截断；无引用时逐字不变。
4. **发版 `.29`**：文档、三处版本、tag/prerelease。发版六步见 `docs/决策记录.md`。
5. **验收 A/B/C**（任务书「开工前先钉死的 3 条」）：主窗发一句→浮窗出现；选区引用→chip→发送成引用块；浮窗自己的话不重复、不被重投。

## 关键路径与命令

| 东西 | 位置 / 命令 |
|---|---|
| 任务书（先读） | `docs/tasks/session-mirror-quote.md` |
| 本交接文 | `docs/tasks/session-mirror-quote-handoff.md` |
| `.28` 提交 / tag / Release | `e80403a` / `v0.1.1-more.28` / <https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.28> |
| `.28` 变更说明 | `CHANGELOG.md` 的 `## [0.1.1-more.28]` 段 |
| 任务书历史提交 | `172b205`（初版）/ `888de55`（.28 进度）/ `0ea32ca`（watch-together 参考） |
| 镜像要接的钩子 | `src/index.js` 的 `session/event`（约 906-945 行）、`mirrorAssistantText`（877-898） |
| 聊天流读写 | `src/chat.js`（`appendChat` / `makeChatWatcher` / `isFloatUserEntry` 待加） |
| 窗口聊天流 | `examples/floating-chat/window_widgets.py` 的 `ChatFeed` |
| 窗口输入/菜单 | `window.py` 的 `_render_input` / `_send` / `_bubble_menu` / `_feed_sel_text` |
| relay 包裹 | `src/interject.js` 的 `interjectNote` |
| 测试 | `node --test`；`python -m py_compile …`；待建 `scripts/check-quote.py` |
| 手动开窗 | `node bin/see-window.mjs --force`（关：`--close`；状态：`--status`） |
| 装回 profile | `node scripts/install-dev.mjs`，然后**重启 DSH** |

## 风险 / 未验证

- **真实麦克风成功路径**：本机无输入端点，只验到「失败原因能显示」。有麦克风时再补。
- **`.28` 的 GUI 渲染**：无 Tk 探针走的是真实 `_toggle_mic` / `_on_mic_exit`，但没开窗看点选状态行；重启后手点一次确认。
- **功能 1 的四处过滤**：relay 启动补投 / 增量 relay / 常驻循环 / 阻塞 watch，漏一处就是「它突然回一句很久以前的话」或 watch 误判插话。用 `isFloatUserEntry` 单一实现 + 测试兜住。
- **回填排序**：旧条目追加在文件尾，`ChatFeed` 与 `_history_entries` 都要按 `at` 重排；`ChatFeed` 去重键加 `mid`。
- **fork 继承前缀**：`sessionQuery.readSession` 的 `inheritedEventCount` 之前是父会话历史，必须跳过。
- **引用契约**：依赖 DSH `dsh-message-quotes@0.2.2-rc.5` 的 `formatQuoteText` / `quoteRule`；升级 DSH 后要重核。
- **window.py 分叉**：不要整文件同步；改动集中在输入区 / 气泡解析 / 历史排序。

## 交接时现场

- 工作树在写本文件前干净；HEAD `0ea32ca`（任务书参考版）。交接文随后单独提交，`main` 领先 tag。
- desktop profile 已装 `.28`（`install-dev --check` = current）；**运行中的 DSH 仍是 `.27`**，重启才换。
- `~/.dsh/see-now.json` 当前绑 `session-880ed9d0-…`；`chat.jsonl` 里该会话 12 条（10 assistant / 2 notice / 0 user），本会话 0 条——这就是功能 1 要补的缺口。
- 任务书状态 `进行中`，`下一步：等格说开工`；功能代码一行没写。

