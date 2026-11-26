# 任务书：浮窗主聊天窗同步 DSH 会话 + 气泡选区「引用选中文字」

状态：已发版（`v0.1.1-more.30`，prerelease；功能与图片修复均实机验过）
对象：给 see-now-more 的悬浮窗补两条。① **消息同步**：绑定会话里、用户在 DSH 主窗发的消息，实时进浮窗主聊天窗（用户气泡），并在插件启动 / 换绑时回填最近的用户消息；② **选区引用**：气泡里选中文字后右键多一项「引用选中文字」，输入区出现引号 chip，可删；发送后正文是 DSH 同款的 Markdown blockquote（每行 `> `），DSH 主窗也按引用渲染。
归属：session-a58208c0-82bc-48b0-ad40-6cbf7a9a7756（任务书）/ `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：已发版 `v0.1.1-more.30` / prerelease <https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.30>；交接文 `docs/tasks/session-mirror-quote-handoff-2026-11-26-2048.md`。剩：按格需要做存档；P2 列表见交接文。
证据：
  - `src/index.js:877-898`：`mirrorAssistantText` 只镜像 `assistant/message` 的正文；`src/index.js:906-945` 的 `session/event` 钩子已经在按绑定会话过滤，但 `user/message` 只用于 `loop.noteUserSpoke`（937 行），没有写进聊天流。
  - `examples/floating-chat/window.py:685-690`：浮窗用户消息由窗口自己 `append_user` 写 `chat.jsonl`；`src/chat.js:80-89` 是插件侧唯一写入口。
  - `examples/floating-chat/window_widgets.py:108-133`：`ChatFeed` 只按 `sid` 过滤 + 按写入顺序追加；`window.py:3684-3701` 的回顾列表取「文件里最后 500 条」。
  - `window.py:9476-9505`：气泡右键菜单目前是「复制选中文字 / 复制全文 / 隐藏 / 收藏」；选区取文在 `window.py:4786-4789`。
  - DSH 主窗的引用由安装包内 `@deepseek-ai/dsh-message-quotes@0.2.2-rc.5` 实现；`formatQuoteText` 为「每行前缀 `> `」，输入框用 `QuotePreview`（引号图标 + 单行省略）。
  - 上游 `SAOS-3624/dsh-see-now` v0.2.9（2026-11-25）只同步 mic / window 三处修复；本仓 `mic.py:236` 仍写死 `D:/asr-local/models-sherpa`，`window.py:1615-1619` 仍每 250ms 清麦克风状态。
  - `git status --short` 空；HEAD `cb8ea1e`；版本 `0.1.1-more.27`（`package.json` / `dsh.plugin.json` 同值）。
账：无需（本任务书只写方案，未跑实现 / 验收）
更新：2026-11-26 20:55 CST

## 现状依据

### 1. 浮窗为什么少了用户消息

`chat.jsonl` 是浮窗气泡流的唯一来源，写它的只有两处：

- **窗口自己**：用户在本窗打字时 `append_user()` 追加 `{role:"user"}`（`window.py:685-690`）；
- **插件**：`appendChat()` / `appendSpoken()` / `appendNotice()`（`src/chat.js:68-89`、`190-199`）。其中和会话有关的只有 `mirrorAssistantText(event)` —— 它只在 `assistant/message` 时写模型正文（`src/index.js:877-898`），并在窗没开时直接跳过。

所以用户切回 DSH 主窗打字时：会话日志里有 `user/message`，浮窗这条流里一条都没有；模型回复照常镜像进来，回看就是「它一个人在说话」。`session/event` 钩子已经能看见这些事件，也已经有绑定会话过滤（`src/index.js:914-924`），缺的只是「把 `user/message` 也写进流」这一步。

### 2. 现有消费者把 `chat.jsonl` 里的 `user` 当成「用户刚在浮窗说的」

这条语义是隐含的，但有四处依赖它：

- relay 的启动补投 `replayUnanswered()`：从文件尾往回找 `user`，最后一条 assistant/meta 之后的都重投（`src/index.js:1444-1458`）；
- relay 每 700ms 的增量投递：`chatWatcherShared()()` 里筛 `role === 'user'`（`src/index.js:1488-1489`）；
- 常驻循环与阻塞等待：`loop.js:851`、`runner.js:1741` 同样把新 `user` 条目当「窗里有人插话」。

**直接往 `chat.jsonl` 灌会话里的用户消息，会让这四处把历史自己讲的话再投一遍，或让 watch 误以为用户插话。** 所以镜像条目必须带稳定标记（`origin:"dsh"`），四处各加一道过滤（启动补投、增量 relay、常驻循环、阻塞 watch）；这是功能 1 的主要风险面。

**现场（2026-11-26 07:59 实测）**：`~/.dsh/see-now.json` 当时绑的是 `session-880ed9d0-…`，它在 `chat.jsonl` 里有 12 条 —— 10 条 assistant、2 条 notice、**0 条 user**；当前这条会话 `session-a58208c0-…` 一条都没有（没绑）。这就是「回看时只看到它一个人在说话」的实物，不是只靠代码推断。

### 3. DSH 主窗的「引用文本」是怎么做的

从本机安装包（`H:\DSH\Current\resources\app.asar`，DSH `0.2.2-rc.5`）解出 `@deepseek-ai/dsh-message-quotes@0.2.2-rc.5`，它的实现是**纯 Markdown，没有引用元数据**：

- 触发：消息里选中文字 → `conversation.chat.text-interaction` 槽出现按钮（中文文案「引用文本」）→ `inputActions.insertQuote(text)`。
- 输入框：插入一个原子 quote 节点（外加一个空格），用 `QuotePreview` 显示 —— 开引号图标 + 单行正文（`white-space:nowrap; text-overflow:ellipsis`，`max-width:min(80%,300px)`，颜色 `state-business-primary`）；悬停显示全文，点引号图标 / 在相邻位置按退格删除整个节点。
- 编码：`formatQuoteText(text)` = 统一 CRLF → 按 `\n` 切开 → 每行前缀 `> ` → 拼回。即 `"a\nb"` → `"> a\n> b"`。
- 与正文混排：`normalizeQuoteBoundaries` 把引用块和前后文字之间的空白收成 `\n\n`，相邻两个引用之间也是 `\n\n`；只有引用、没有正文时就只有引用块。
- 转录：`quoteRule` 认「连续的、最多 3 个前导空格的 `>` 行」，整段交给同一个 `QuotePreview`；因此**模型看到的和主窗看到的是同一份文本**，不靠额外字段。
- 识别是宽容的：`^ {0,3}>[ \t]?`，行内 `>` 不算；空引用行会被跳过判断，但保留在范围里。
- **活样本（本会话自己的 `seq 63`，2026-11-26 07:46）**：用户在 DSH 主窗引用后发的那条，`source.kind = "user"`，`text` 逐字为 `"> 具体的效果应当类似在dsh主窗口里的那个「引用文字」功能。\n\n指的是这个"`。这同时证明了两件事：引用就是普通 Markdown；`user/message` 事件带 `seq` / `time` / `source`（镜像要的字段都在）。可直接拿它当单测 fixture。

结论：浮窗只要照 `formatQuoteText` 编码，DSH 主窗就能渲染；浮窗自己的气泡也要认同一套 `>` 行，否则发出去的话在浮窗里会显示成裸 `>`。

### 4. 上游 v0.2.9（前置，不是本任务的一部分）

- 2026-11-25 13:17 CST 发版，正文只有一件事：`examples/floating-chat/{window,mic}.py` 从 `dsh-watch-together` 0.3.7 同步，修 #66（单 C 盘机器点 🎤 没反应）的三层：`mic.py` 写死 `D:/asr-local/models-sherpa`；`window.py` 丢掉子进程 stderr；`_poll_chat()` 每 250ms 清状态。
- 本仓现状：`mic.py:236` 仍写死；`window.py:1615-1619` 仍在 `_poll_chat` 里直接 `feed.status=""`；第三层（子进程 stderr）本地已经覆盖一半 —— `_toggle_mic` 把 stdout/stderr 落到 `mic.log`（`window.py:1795-1802`），缺的是「异常退出原因显示出来后不被下一拍抹掉」。
- 本仓 `window.py` 是 10,087 行的重改版（上游 v0.2.9 那份 2,353 行，没有历史 / 收藏 / 会话绑定），**不能整文件覆盖**，只能按上面三条手工回移。先合它再动本任务，是因为功能 1 要改 `_poll_chat` 附近的 `ChatFeed` 轮询、功能 2 要改同一文件的输入区；同一段代码两轮改，冲突只会更贵。
- 这两项功能上游**没有**：v0.2.9 的 `src/index.js` 仍只有 `mirrorAssistantText`，`window.py` 没有「引用」。所以没有「等上游做」这条捷径。
- 同时收到的 `dsh-video-storyboard v0.8.1` 是站点字幕误判修复，和本任务无关，不引入。
- **2026-11-26 08:08 已按本节回移**；上面的行号与「mic.log」描述是改动前快照，留在原处当对照。

## 目标（P0，做到这几条算完）

1. 绑定会话里、用户在 DSH 主窗发的 `user/message`（`source.kind === "user"`），**1 秒内**以用户气泡出现在浮窗主聊天窗；时间戳用会话事件时间。
2. 浮窗自己发出的消息**不会被镜像回来**（不重复气泡、不重复投递）；relay / 常驻循环 / 阻塞 watch 都不会把镜像条目当成「用户刚在浮窗说话」。
3. 插件启动、绑定会话变化时，回填该会话最近的用户消息；回填可重复执行而不产生重复（水位 + `mid`）。
4. 气泡有选区时，右键菜单出现「引用选中文字」；点后输入区出现引号 chip（单行省略 + ×），可删除；输入正文可选。
5. 发送时按 DSH 的 `formatQuoteText` + `\n\n` 规则编码；DSH 主窗能把它渲染成引用，且引用不被 relay 的 200 字截断。
6. 现有单测、窗口开合、relay、watch、历史 / 收藏行为不变。

## 非目标（v1 不做）

- 不镜像工具调用 / thinking / reasoning / 附件实体；用户消息里的图片只显示一行 `[图片]`。
- 不做双向同步：浮窗 → DSH 仍走现有 relay，不新增通道。
- 不做多条引用、不做引用文字的就地编辑、不做 caret 落在 chip 中间的 DSH 式原子节点。
- 不回填「窗关着期间的 assistant 正文」（P2，见「风险与后续」）。
- 不改 DSH 的 `dsh-message-quotes`，不做 mac、不发 npm。

## 拍板项（已给推荐值；格不同意就改这里再开工）

| # | 问题 | 推荐值 | 理由 |
|---|---|---|---|
| 1 | 引用要不要原样进 DSH 会话？ | **要**：`interjectNote` 检测开头引用块，引用块原样放最前、说明文字放后面，引用不参与 200 字截断 | 否则 DSH 主窗只看到 `[看屏幕·用户插话] 「> …」`，长引用还会被截断，等于只在浮窗里有效 |
| 2 | 回填范围 | **只绑定会话、只 user、最近 500 条或 30 天**，跳过 fork 继承前缀 | 主窗内存只留 200 条、回顾页每组 500 条；再老的不在浮窗回看范围，全量灌会拖慢开窗 |
| 3 | 单次引用长度上限 | **4000 字**，超出截断并在状态行提示 | 引用整章 3 万字会把模型输入打爆；4000 字够一次长贴 |
| 4 | 一条消息多个引用 | **v1 只保留一个**，再引用替换旧的并提示「已替换引用」 | 单行输入里排多个 chip 要重写输入布局，收益低 |
| 5 | chip 位置 | **输入栏内、正文左侧固定**（引号 + 省略 + ×），正文从 chip 右边开始 | Tk 是单行隐藏 Entry，做不到 DSH 的原位原子节点；固定 chip 已达到「输入框里看到引文」的效果 |

## 参考：watch-together v0.3.7（2026-11-26 看过，只借模式）

仓库 [SAOS-3624/dsh-watch-together](https://github.com/SAOS-3624/dsh-watch-together)（32 个 `src` 模块，`window.py` 约 2.4k 行）。它自己**没有**用户消息镜像，也**没有**引用 / 选区菜单，所以两项功能仍按本任务书做。值得借的只有四个模式：

- `chat-store.js` 的 **`at` 严格单调**（`tailStamp`）：同一毫秒连写两条会撞「新消息」判据；我们不改全局 `at`，改用 `mid` 进 ChatFeed 去重键。
- `chat-store.js` 的 **`writtenKeys` 跨写路径共用去重账**：对应我们的 `mid` 集合，live / backfill 共用，启动时再从 `chat.jsonl` 尾部扫一遍补齐。
- `CHANGELOG 0.3.3` 的 **outbox 水位**：只追加的动作通道重启会重放，只认比水位新的行；对应我们的 `throughSeq`。
- **测试形状**：`test/interject-anywhere.test.mjs` 的「等待者优先」用例；`scripts/check-input-select.py` 的「`object.__new__` + 假字体 / 假 root」无 GUI 测真实方法。

**不借 / 不误读**：

- `window-outbox.jsonl` **不是聊天输入通道**。上游只拿它做 `pause` / `resume` 等控制动作，用户文字仍走 `chat.jsonl`；它不能替我们消掉四个消费点，功能 1 仍按 `origin:"dsh"` 过滤。
- 不为两项功能引入 `window-events` 双写（窗口 250ms 轮询 `chat.jsonl` 够快，ChatFeed 已有按 `sid` 去重）；也不做整体 32 模块拆分。
- 视频相关模块（`playhead` / `position-bridge` / `reply-guard` / `watch-loop`）语义绑在播放进度上，不搬。

## 方案一：把绑定会话的用户消息同步进浮窗

### 数据流

```
DSH session event（user/message，source.kind = user）
  └─ src/index.js  session/event 钩子（已有；绑定会话过滤也已有）
       └─ src/mirror.js  onEvent()
            ├─ 取文本（content 里 type=text 的块；有图 → 追加 [图片]）
            ├─ 去重（mid = `${sid}:${seq}`；水位 throughSeq）
            └─ chat.js  appendChat({role:"user", origin:"dsh", mid, at:event.time, sid})
                 └─ ~/.dsh/see-now/chat.jsonl
                      └─ window.py ChatFeed（按 sid 过滤、按 at 排序）→ 用户气泡

回填：sessionQuery.readSession(sid)
  → 过滤 type=user/message + source.kind=user + seq > 水位 + 非 fork 继承
  → 同一个 appendChat 入口
```

### 关键决定

1. **复用 `chat.jsonl`，加 `origin:"dsh"` 标记，不新开文件。** 窗口的显示 / 历史 / 收藏 / 隐藏 / 删除全都只认这一条流；新开文件要同步改五处列表逻辑，而且收藏快照、隐藏 key、删除会话都会分裂。代价是四个 JS 消费点要各加一道过滤（见下），这是可控的。
2. **只镜像 `source.kind === "user"`。** 不镜像 `see-now`（插件自己的叫醒 / 投递 / 插话）和 `action-cards`（卡片按钮，不是用户打的字）。**新增 `isTypedUserMessage(event)`，不复用 `isHumanMessage()`**：后者故意把 `action-cards` 算进来，是给循环续命用的，语义不同（`src/human.js:26-31`）。两者都要有单测，防止以后有人把它们合并。
3. **`mid` + 水位**。`mid` 写进条目（`<sid>:<seq>`），水位存 `~/.dsh/see-now/session-mirror.json`：`{v:1, sids:{sid:{throughSeq, updated}}}`，最多 50 个 sid。**写盘成功后才推进水位**；写失败不推进，下次重试。水位保证「在浮窗里删掉 / 隐藏的条目不会被回填重新灌回来」，也保证回填幂等。

另加一道保险：**启动时扫一遍 `chat.jsonl` 尾部（最近 4000 行）的 `mid`**，回填先跳过这些。写盘成功、水位还没落盘就崩时，只靠水位会重复；`mid` 扫描把这段窗口补上（watch-together 的 `writtenKeys` 是同一思路）。
4. **`at` 用事件时间，`ChatFeed` 按 `at` 稳定排序。** 回填的条目必然比文件尾旧，不能靠「追加顺序 = 时间顺序」；`ChatFeed.add()` 发现新条目 `at` 小于末条时，对 `messages` 做一次稳定排序（≤4000 条，一次排序可接受）；`reload()` 末尾也排一次。

### 事件 → 条目

| 字段 | 取值 | 说明 |
|---|---|---|
| `role` | `"user"` | 和浮窗自己打的字同角色，气泡样式一致 |
| `text` | `content` 里 `type:"text"` 的 `text` 按 `\n` 连接 | 没有文本但含图片 → 写一行 `[图片]`；两者都没有 → 跳过 |
| `at` | `event.time`（epoch ms） | 用会话时间，不用插件收到的时间 |
| `sid` | 绑定会话全 ID | 显式传，避免 `appendChat` 去读 2 秒缓存的配置 |
| `mid` | `` `${sid}:${event.seq}` `` | 去重 / 排查用；窗口可忽略 |
| `origin` | `"dsh"` | JS 消费者的过滤依据；窗口照常渲染 |

- 正文截断沿用 assistant 镜像的口径：超过 3000 字截到 3000 并加 `…`。
- 附件 / 图片不搬实体：`[图片]` 只是占位，点不开。
- `source.kind === "user"` 里包含 DSH 主窗、ACP bridge 发来的消息；`action-cards`、`scheduler`、`tool`、`see-now` 一律不写。

### 必须同步改的四个消费点

| 位置 | 现状 | 改法 |
|---|---|---|
| `src/index.js:1444-1458` `replayUnanswered()` | 从文件尾往回找 `user`，遇 assistant/meta 停 | 遇 `origin === "dsh"` **跳过但不停**；镜像条目不能进补投队列 |
| `src/index.js:1488-1489` relay 增量 | `filter(e => e?.role === "user" && text)` | 再加 `e?.origin !== "dsh"` |
| `src/loop.js:851` 常驻循环 | `if (e?.role === "user" && text)` | 再加 `e?.origin !== "dsh"` |
| `src/runner.js:1741` 阻塞 watch | `chatPoll().filter(e => e.role === "user")` | 再加 `e?.origin !== "dsh"` |

四处不要各写一份判断：在 `src/chat.js` 加一个 `isFloatUserEntry(entry)`（`role === "user" && origin !== "dsh"`），四处都调它。单测直接钉这个函数 + 至少一条 relay 的端到端测试；否则以后新增第五个消费者会漏。

### 窗口侧要跟着改的排序

- `ChatFeed.add()`：追加后若 `at` 比末条小，按 `at` 对 `messages` 做稳定排序（Python `sort` 稳定，同毫秒保持写入顺序）。
- **`ChatFeed` 去重键从 `(role, text, at, sid)` 扩成 `(role, text, at, sid, mid)`**：镜像消息可能同文同毫秒，现有 key 会把后一条当重复吞掉。`mid` 缺省为空串，浮窗自己写的条目行为不变。
- `ChatFeed.reload()`：读完最后 4000 行后统一按 `at` 排一次。
- `_history_entries(sid)`（`window.py:3684-3701`）：先按 `sid` 过滤，再按 `at` 排序，最后取 `[-500:]`。**这一步不能省**：回填把旧条目追加在文件尾，原来的「取最后 500 行」会拿到最旧的那批，把最近的挤掉。
- `_history_sessions` / `_chat_sessions` 已经是 `min/max`（`window.py:3478-3500`、`5818-5845`），不用改。
- `_maybe_notify` 只挑 `assistant`（`window.py:2828-2833`），镜像的用户消息不会弹通知；不用改。
- 回执 `delivered.jsonl` 只对浮窗发出的 `at` 生效；镜像条目理论上可能撞同一毫秒，概率极低，不处理，写进已知边界。

### 触发、回填与配置

- **实时**：`session/event` 钩子里，只有在 `bound` 存在且 `id === bound` 时才镜像（沿用现有过滤）；没绑定会话时**不猜**，一条都不写。
- **回填**：插件 `apply` 后 3 秒试一次；`modeWatcher`（1.5 秒轮询）里比较 `boundSessionNow()` 与 `lastMirrorSid`，变了就回填新会话。不做「窗口打开」特判 —— 实时镜像不看窗在不在，回填只补 DSH 停机期间的缺口。
- **回填步骤**：读水位 → `ctx.sessionQuery.readSession(sid)` → 跳过 `inheritedEventCount` 的 fork 继承前缀 → 过滤 `user/message` + `source.kind === "user"` + `seq > throughSeq` → 取最近 500 条（或 30 天内）→ 按 seq 顺序 `appendChat`。**每条写成功才把水位推到它的 seq**；中途写失败就停在失败那条之前，下次从它重试。扫描完没有可写的（全被过滤 / 都低于水位）也要把水位推到扫描到的最后一条 seq，避免每次重扫。
- **配置**：`~/.dsh/see-now.json` 加 `mirror`：`{ "users": true, "backfill": true }`，缺省都算 `true`；`users:false` 一键关掉实时 + 回填（kill switch）。不做设置页开关（设置页在共用的 `window.py` 里，越过扩展区）。
- **失败**：`sessionQuery` 不在 / 会话不存在 / 读盘失败 → 只写 `~/.dsh/see-now/mirror.log`，不重试、不弹窗、不影响实时镜像和工具调用。

### 写能力六问（`write-guard`）

| # | 问题 | 答案 |
|---|---|---|
| 1 | 改谁的状态 | 只追加本机 `~/.dsh/see-now/chat.jsonl` 与 `session-mirror.json`；不联网、不改会话、不发消息 |
| 2 | 默认开还是关 | 默认开（格要的就是这个），但 `mirror.users:false` 可一键停；不影响任何工具 |
| 3 | 失败 / 超时是暂停还是重试 | **暂停**：写失败不推水位、只记日志，下一拍不会咬着同一句重试 |
| 4 | 有没有范围 | 绑定会话、`source.kind=user`、单条 3000 字、回填 500 条 / 30 天、最多 50 个会话水位 |
| 5 | 结果不明会不会写成成功 | 不会：`appendChat` 成功才推水位；`mirror.log` 记 `wrote/scanned/ms` |
| 6 | 撤销路径 | 改配置即停；删 `chat.jsonl` 条目 + `session-mirror.json` 即彻底清；窗口删会话只删条目，水位挡住回填复活 |

这条不是「对外写」：只追加本机浮窗的展示流，不碰会话、不发消息、不联网。`write-guard` 的「默认关」针对外部状态；这里缺省开是格的明确要求（本任务书的出发点），等价开关 `mirror.users` 随时可关。**若以后要镜像到别处（转发、云同步、写进别人可见的地方），按 `write-guard` 四条重新审，不许沿用这里的默认开。**

## 方案二：气泡选区「引用选中文字」

### 交互流程

1. 在主聊天窗拖选气泡文字（现有选区机制，`window.py:4786-4789` 取纯文本）。
2. 右键气泡 → 菜单多一项 **「引用选中文字」**，排在「复制选中文字」上面（有选区才出现；没选区不出现）。
3. 点它 → 选中文字存进 `self._draft_quote`，输入框拿到焦点，正文左侧画出引号 chip。
4. 用户可继续打字（正文可选）；点 chip 右侧的 ×、或在正文开头按退格 / Delete → 整个引用被删掉。
5. 发送：引用块在前、正文在后；发完清空 chip 与输入框。
6. 再次引用 → 替换旧引用，状态行提示「已替换引用」。

### 数据模型

- `self._draft_quote = {"text": str, "at": ms} | None`：**v1 只有一个**，不进 `chat.jsonl`，只是输入草稿的一部分。
- `self._quote_hit = (x0, y0, x1, y1, rx0, rx1) | None`：chip 的命中矩形 + × 的命中区间，每次 `_render_input` 重算。
- `self._input_text_x`：正文起画 x。有 chip 时 = 原起点 + chip 宽 + 8；`_render_input` / `_input_index_at` / `_draw_input_text` 三处共用，避免各算一套。
- 引用上限 4000 字：超出截断、末尾加 `…`，状态行提示「引用过长，已截到 4000 字」。

### 编码（必须和 DSH 的 `formatQuoteText` 同形）

```python
def format_quote_text(text: str) -> str:
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    return "\n".join("> " + line for line in text.split("\n"))
```

- 选中文字先 `strip()` 掉首尾空白 / 换行，内部换行保留；空行也照 DSH 的规则写成 `> `（不是空串）。
- 发送拼装：`quote + ("\n\n" + body if body else "")`；只有引用、没有正文时消息正文就是引用块。
- 例：选 `你好\n世界` + 打 `这句什么意思` →
  ```
  > 你好
  > 世界

  这句什么意思
  ```
- `body` 仍走现有 `_expand_draft()`（`[图片N]` → `![](...)`）；引用文本不展开任何 token。

### 输入区 chip（视觉照 `QuotePreview`）

- 位置：输入栏内、正文起点（`x0 + 84`），高 22px、垂直居中（`y0 + 27`）；最大宽 `min(正文区 55%, 260px)`。
- 样式：圆角 11px 底板 `#14202e`、描边 `#2a4057`；左侧开引号 `“` 12px 强调色 `#7fb8ff`；中间预览文字 11px `#c7d6e8`，单行、超出用 `…`；右侧闭引号 `”` + `×`（`#8e9db2`）。
- 预览文本：引用原文把换行 / 连续空白压成单个空格再显示；**发送用的是原文，不是预览**。
- 有 chip 时正文区从 chip 右边开始，可用宽度相应减少；没有正文就在 chip 右边显示灰色占位「输入你的话…」。
- 引号的开 / 闭两枚都画：格原话是「用双引号括住」，DSH 只画开引号；这是有意的差异，视觉上仍与 DSH 同族。

### 键盘与鼠标

- `_input_press`：先判 `_quote_hit` 的 × 区 → 删引用、重画、`return`；点在 chip 其它地方 → 焦点给 Entry、光标放 0；点在正文 → 走现有 `_focus_input`。
- Entry 绑 `<BackSpace>`：无选区且 `index("insert") == 0` 且有引用 → 删引用并 `return "break"`（不让 Entry 再删一个字）。
- Entry 绑 `<Delete>`：同样条件 → 删引用。
- 输入法组字期间不拦（组字中 `index("insert")` 通常不为 0）；极端情况在「已知边界」里写明。

### 发送

- `_send` 改为：`body = entry.get().strip()`；`if not body and not self._draft_quote: return`。
- 拼好的正文传 `append_user()`；**写盘成功后才清空** chip / 输入框 / `_img_refs`（和现在「写不进去时字不清空」一致，`window.py:1728-1735`）。
- 发送后回到最新一条的逻辑不变（`_collapse_expanded`、`_poll_chat`）。

### 气泡里怎么显示引用

- 解析：把 `_parse_blocks()` 升级成先切引用块、再对剩下的文本跑现有图片识别。引用块规则与 DSH 一致：连续的、最多 3 个前导空格的 `>` 行，剥掉一个 `>` 标记；遇到第一条非引用行结束；整块去空白后为空则丢弃。
- **只对 `role == "user"` 的气泡启用**：assistant 正文里的 `>` 维持现状（原样显示），避免这次顺手改掉模型输出的渲染。`_parse_blocks(text, quote_blocks=is_user)` 一个参数即可，主窗 / 回顾窗都传。
- 版式：引用段左侧画 2px 强调色竖条 + 8px 间距，文字按 `content_max - 10` 折行，颜色 `#a9c4e0`（新样式 `"q"`）；摘要态的「2 行」预算把引用行也算进去，展开态全给。
- 两个绘制处都要处理新段类型：主窗 `_message_shapes` / `_paint_bubbles`（约 4280-4440）与回顾窗的对应绘制（约 6420-6600）。漏一处就是 `KeyError` / 空白气泡。
- 选区 / 复制：引用行按普通文字行进 `_sel_lines`，选中复制得到的是**去掉 `>` 的原文**；「复制全文」仍复制 `chat.jsonl` 里的原始 Markdown（和 DSH 剪贴板是同一份）。这个差异写进 README。
- 样式 `"q"` 要在三处颜色映射里登记（`window.py:3920`、`6427`、通知气泡 2819 附近），否则会落回默认白字。

### relay 的包裹（`src/interject.js`）

现在 `interjectNote()`（`src/interject.js:71-81`）把用户原话塞进 `[看屏幕·用户插话] 「…」`，并且 `clip(said, 200)` —— 引用一旦超过 200 字就被截断，DSH 主窗也只会看到「插话提示」而不是引用块。改法：

1. 检测**开头的引用块**（同一套 `^ {0,3}>` 规则）；没有引用 → 完全维持现状。
2. 有引用 → 返回 `引用块 + "\n\n" + 原说明`，说明里的「」只放**引用之后的正文**（clipped 200）；正文为空就写「用户引用了一段内容（见上方引用块）」。
3. 引用块本身**不参与 200 字截断**；窗口侧已限 4000 字，这里再兜一个 4000 上限。
4. `noteInterjected()` 记「正文」而不是整段引用，避免「未回应」提醒里复读四千字。
5. 效果：DSH 会话里的这条 user 消息以引用块开头 → `quoteRule` 渲染成 `QuotePreview`，说明文字跟在后面；模型也看到完整引用。

### 已知边界

- **回顾窗不提供引用**：v1 只在主聊天窗的菜单里出现「引用选中文字」。回顾窗是独立 Toplevel，点完要么它盖住主窗输入框、要么强行关窗；为避免这种别扭交互，留到 P2。`_bubble_menu` 加一个 `allow_quote` 参数，回顾窗调用处传 `False`。
- 选区跨多条气泡时按一个引用块处理（`_feed_sel_text` 的换行原样保留）；这是允许的，不做「按气泡拆成多个引用」。
- 引用文本里本来就有 `>` 行 → 发送后变成 `> > …`；DSH 剥一层后显示原样，符合预期。
- 引用里含图片 Markdown（`![](…)`）按普通文字处理，不当图片下载。
- 输入法组字期间不拦退格；极端情况下可能删掉引用而不是删组字，记录在案，不为此重写输入法状态机。
- 引用只是输入草稿，不进 `chat.jsonl`；关窗不保留（和现在未发送的草稿一致）。

## 实现落点

行号按当前 HEAD `cb8ea1e`；合过上游 v0.2.9 后可能平移，以函数名为准。

| 文件 | 改什么 | 量级 |
|---|---|---|
| `src/mirror.js`（新） | `createSessionMirror({ctx, log})`：`onEvent` 实时镜像、`backfill({sid, reason})`、水位读写、`mirror.log`、`isTypedUserMessage` 调用 | ~200 行 |
| `src/human.js` | 新增 `isTypedUserMessage(event)`（只认 `user/message` + `source.kind === "user"`），`isHumanMessage` 不动 | ~10 行 |
| `src/chat.js` | `appendChat` 支持 `{sid, at, mid, origin}`；新增 `isFloatUserEntry(entry)` | ~20 行 |
| `src/index.js` | 钩子里调 `mirror.onEvent`；apply 后 3 秒回填；`modeWatcher` 里换绑回填；`replayUnanswered` / relay 两处过滤 | ~60 行 |
| `src/loop.js` | `851` 行过滤镜像条目 | ~2 行 |
| `src/runner.js` | `1741` 行过滤镜像条目 | ~2 行 |
| `window_widgets.py` | `ChatFeed` 去重键加 `mid`；`add/reload` 按 `at` 排序 | ~20 行 |
| `window.py`（同步） | `_history_entries` 先排序再取 500 | ~5 行 |
| `test/session-mirror.test.mjs`（新） | 事件过滤、文本拼接、水位、回填映射、失败不推水位、fork 前缀、启动扫 `mid` 补崩溃窗口 | ~180 行 |
| `test/relay-seen.test.mjs` 或新增 | 镜像条目不被 relay 补投 / 不被当插话（四处消费点）；**不唤醒 loop/watch**（照 `interject-anywhere` 的等待者用例） | ~60 行 |
| `examples/floating-chat/quote_text.py`（新） | `format_quote_text` / `split_quote_blocks` / `quote_preview` 三个纯函数，不 import Tk | ~70 行 |
| `examples/floating-chat/window.py`（引用） | 菜单项、`_draft_quote`、chip 绘制、输入布局偏移、退格/Delete、发送拼装、气泡引用段（主窗 + 回顾窗） | ~250 行 |
| `src/interject.js` | 开头引用块原样保留、不参与 200 字截断 | ~25 行 |
| `test/quote-text.test.mjs`（新） | 调 `python`（没有就 skip）验 `quote_text.py` 的编码 / 切分 / 预览 | ~70 行 |
| `scripts/check-quote.py`（新） | 照 watch-together 的 `check-input-select.py`：`object.__new__` + 假字体 / 假 root，无 GUI 验引用编码、chip 命中矩形、发送拼装 | ~100 行 |
| `test/interject-quote.test.mjs`（新） | `> a\n> b\n\n问题` 原样保留；无引用时输出与现在逐字一致 | ~40 行 |
| `README.md` / `docs/机制.md` / `docs/决策记录.md` / `CHANGELOG.md` | 行为、边界、为什么这样选；版本三处同值 | 各 1 节 |

## 任务顺序

0. **前置（已完成，`0.1.1-more.28`）**：按「上游 v0.2.9」回移三处 mic / window 修复（模型目录回退链、`_on_mic_exit` 不再清状态、stderr 泵进内存且不落盘），单独验、单独提交。证据：麦克风异常退出时状态行出现 `麦没起来：…` 且不会被 250ms 轮询抹掉；子进程 stderr 被泵进内存（状态行显示最后一条错误，转写行不入内存）；模型目录回退链按 `--models-dir` → `DSH_ASR_MODELS` → `<DSH_HOME>/asr-models/sherpa` → 旧路径。
1. 判据层：`isTypedUserMessage` + `isFloatUserEntry` + 单测（先把「谁算人话、谁算浮窗条目」钉死）。
2. 镜像核心：`mirror.js` + `appendChat` 扩展 + `session/event` 接线 + **启动扫 `chat.jsonl` 尾部 `mid`** + 四处过滤 + 单测。
3. 窗口顺序：`ChatFeed` 去重键加 `mid` + 排序 + `_history_entries` 排序；用「手工往 `chat.jsonl` 追加一条旧 `at` 的 user」验证不顶掉最近消息。
4. 引用纯函数：`quote_text.py` + `scripts/check-quote.py` 无 GUI harness；先不碰 UI。
5. 输入区：`_draft_quote`、chip、布局偏移、退格 / Delete、发送拼装；手工点验。
6. 气泡渲染：主窗 + 回顾窗的引用段与颜色；回归 assistant 的 `>` 原样显示。
7. relay：`interjectNote` 保留引用块 + 单测；在 DSH 主窗确认引用被渲染。
8. 文档、版本（`0.1.1-more.29`）、tag / prerelease、验收记录。**收尾时回头核一遍 `README.md` 与 `src/tool-spec.js`（模型看到的 schema）要不要跟着改**：本任务预期不动 schema（不加参数），但「核过、不用改」也要写进状态块，不能默认跳过。

## 验收（10 条，每条都要能抄出证据）

### 开工前先钉死的 3 条（其余 7 条是回归 / 边界）

- **A**：格在主窗发一句 → 浮窗 1 秒内出现同文用户气泡，时间戳是会话时间。
- **B**：选中一段气泡文字 → 右键「引用选中文字」→ 输入区出现引号 chip → 发送后 `chat.jsonl` 里是 `> ` 引用块，DSH 主窗把它渲染成引用。
- **C**：浮窗自己发的消息不重复、不被 relay 重投、不触发 watch 误判。

**先和格确认这 3 条再写代码**；中途要加第 4 条先问，不偷偷扩。下面 10 条是完整验收，3 条是其中的主干。

1. **单测全绿**：`node --test` → `0 fail`，且新增的 `session-mirror` / `quote-text` / `interject-quote` 三组都在跑；把尾部 `# fail 0` 抄进状态块。
2. **Python 能编译**：`python -m py_compile examples/floating-chat/window.py examples/floating-chat/quote_text.py` → exit 0。
3. **实时同步**：绑定会话后开窗（`node bin/see-window.mjs --force`），格在 DSH 主窗发「同步测试 A」→ 1 秒内浮窗出现用户气泡；`chat.jsonl` 里该条带 `origin:"dsh"` 与 `mid`，`at` 与会话事件时间一致。
4. **不重复**：在浮窗发「浮窗测试 B」→ `chat.jsonl` 里只有一条 `role:"user"` 的 B、不带 `origin`；5 秒后没有镜像回来的 B；`relay.log` 只有一条 `ok`。
5. **不重投**：重启 DSH（或停用再启用插件）→ `relay.log` 的 `startup: 补投` 不包含任何 `origin:"dsh"` 条目；浮窗里 B 不重复。
6. **回填幂等**：准备一个已有若干 user 消息的测试会话 → 清掉它在 `chat.jsonl` 的镜像条目、把水位设为 0、重启插件 → 最近 500 条按时间顺序回来；再重启一次不新增重复。再单独验一次「写成功但水位没落盘」：手工留一条 `mid` 在 `chat.jsonl`、水位回退，重启后不重复。
7. **菜单出现条件**：主窗气泡有选区时右键 → 「引用选中文字」在「复制选中文字」上面；没有选区时该项不出现；回顾窗不出现（v1 边界）。
8. **chip 生命周期**：点菜单 → 输入区出现开引号 + 预览 + ×，正文从 chip 右边开始；点 × → 消失；再引用一次后按退格（光标在正文开头）→ 消失；只引用不打字也能发送。截图存 `_scratch/quote-chip.png`（截图只证明视觉，数据证据看第 9 条）。
9. **发送格式**：引用「你好 / 世界」+ 正文「这句什么意思」→ `chat.jsonl` 正文逐字等于 `"> 你好\n> 世界\n\n这句什么意思"`；DSH 主窗把前两行渲染成引用块；500 字长引用在 relay 后仍是完整引用（不被 200 字截断）。
10. **回归**：assistant 正文里的 `>` 仍原样显示；历史 / 收藏 / 隐藏 / 删除仍工作；`node --test` 与窗口开合、relay、watch 的既有用例全绿；**镜像条目在「有等待者 / 钟空转」两种状态下都不会被 loop / watch 当成用户插话**（单测 + 验收第 4/5 条）。

## 风险与后续

- **四处过滤漏一个**：镜像条目被 relay 重投或让 watch 误判「用户插话」，表现是「它突然回一句我很久以前说过的话」。对策：`isFloatUserEntry` 单一实现 + 四处单测 + 验收第 5 条。
- **排序副作用**：回填条目追加在文件尾，所有「取最后 N 条 / 最后一个 at」的地方都要按 `at` 重排；已列出的 `ChatFeed` 与 `_history_entries` 是主要的，验收第 10 条覆盖历史 / 收藏。
- **大会话读取**：`sessionQuery.readSession()` 会加载整份日志，长会话可能几百毫秒到几秒；只在启动 / 换绑 / 水位落后时读，`mirror.log` 记 `ms`。若实测 >5 秒，再加「只回填最近 N 天」的更硬门槛，不改接口。
- **fork 继承前缀**：`readSession` 返回的 `inheritedEventCount` 之前是父会话的历史，必须跳过，否则子会话会灌进父会话的用户消息。
- **relay 包裹改动**：`interjectNote` 是所有浮窗消息共用的；无引用时必须逐字不变（单测钉住），有引用时只改开头，不改后面的「先说话再干活」指令。
- **window.py 的分叉**：本仓 `window.py` 是重改版且文件头写着「生成文件」；新改动集中在输入区 / 气泡解析 / 历史排序，仍属扩展区。不要跑 `npm run sync:window`，也不要把上游 v0.2.9 的整文件覆盖进来。
- **DSH 版本漂移**：引用格式依赖 `@deepseek-ai/dsh-message-quotes@0.2.2-rc.5` 的 `formatQuoteText` / `quoteRule`；升级 DSH 后若这两处变了，按「现状依据 3」重核一遍，别假设永久稳定。
- **P2（本任务不做）**：窗关着期间的 assistant 正文回填；回顾窗里的引用；一条消息多个引用 / 原位原子节点；用户消息附件实体。
- **token**：引用 4000 字上限 + relay 说明文字，单条最坏约 4–5k token；不自动朗读引用。

## 不做什么

- 不改 DSH 主窗的 `dsh-message-quotes`，也不给它提交 patch（它已经满足需要）。
- 不新开 `chat-mirror.jsonl` 第二份流；不做数据库 / 索引。
- 不给 `see_now` 加参数、不扩 `tool-spec.js` 的体积预算。
- 不做 macOS、不发 npm；分发仍按源码安装 + tag / Release 锚点。
- 不在设置页加镜像开关（设置页在共用的 `window.py` 里，越过扩展区；用 `see-now.json` 的 `mirror` 键）。

## 日志

- 2026-11-26 07:58 新建（进行中）。依据：`src/index.js` 只镜像 assistant；`dsh-message-quotes@0.2.2-rc.5` 的引用实现；上游 v0.2.9 只同步 mic/window 三处修复；工作树干净（HEAD `cb8ea1e`）。未动任何代码。
- 2026-11-26 07:58 按格要求停在任务书；因上游 v0.2.9 刚发，实现前先合上游，避免同一段 `window.py` 两轮改。
- 2026-11-26 08:08 上游 v0.2.9 三处回移完成（**未提交，等格确认**）：`mic.py` 加 `resolve_models_dir`（显式目录缺文件报错 2、http 只查 `silero_vad.onnx`）；`window.py` 用 `_on_mic_exit` + stderr 泵（只留内存、跳过转写行）+ `_mic_models_from_asr`（asr.json 的 `--models` 是 SenseVoice，不能直接当 mic 目录）。验证：`py_compile` OK；ASR venv 跑 `mic.py --from-file 0.wav --dry-run` 转写成功、exit 0；空 `--models-dir` exit 2 且报缺文件；`node --test` 366 tests / 363 pass / 0 fail / 3 skip；无 Tk 探针把状态跑到 `麦没起来：挂了：Error querying device -1`（本机无输入端点），不再被 250ms 轮询抹掉。
- 2026-11-26 08:18 发版：commit `e80403a` / tag `v0.1.1-more.28` / prerelease <https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.28>；`install-dev.mjs` 已把 desktop profile 同步到 `.28`（`--check` 报 current），**重启 DSH 后生效**。
- 2026-11-26 08:35 补入 watch-together v0.3.7 参考（**未开工**）：ChatFeed 去重键加 `mid`；启动扫 `chat.jsonl` 尾部已有 `mid`（补「写成功但水位没落盘」的崩溃窗口）；加 `scripts/check-quote.py` 无 GUI harness（照 `check-input-select.py`）与「镜像条目不唤醒 loop/watch」测试（照 `interject-anywhere` 的等待者用例）。同时记下：outbox 不是聊天输入通道，不迁协议；视频模块与整体拆分不借。等格说开工再动功能 1。
- 2026-11-26 12:16 按格要求给任务顺序第 8 步补一条收尾检查：做完回头核 `README.md` 与 `src/tool-spec.js`（模型看到的 schema）要不要跟着改；本任务预期不加参数、schema 不动，但核过也要写明。只改任务书，功能代码未动。
- 2026-11-26 12:26 开工（格确认 A/B/C）。功能 1 完成：`human.js` 加 `isTypedUserMessage`；`chat.js` 的 `appendChat` 支持 `{sid,at,mid,origin}`，加 `isFloatUserEntry` / `pendingStartupEntries`；新增 `mirror.js`（实时镜像 / 回填 / 水位 / 启动扫 `mid`）；`index.js` 接线（`session/event` 钩子、3 秒启动回填、换绑回填）；`loop.js` / `runner.js` / 启动补投 / relay 四处过滤；`window_widgets.py` 的 ChatFeed 加 `mid` 去重并按 `at` 排序，`window.py` 的 `_history_entries` 先排再取 500。验证：`node --test` 380 tests / 377 pass / 0 fail / 3 skip；`python scripts/check-feed-order.py` exit 0。代码与本文随本轮提交。
- 2026-11-26 12:35 功能 2 代码完成：`examples/floating-chat/quote_text.py`（`format_quote_text` / `split_quote_blocks` / `quote_preview`）；`scripts/check-quote.py` 无 GUI 验编码 / chip 几何 / 发送拼装 / 退格删引用；`window.py` 加「引用选中文字」菜单（仅主窗，回顾窗 `allow_quote=False`）、`_draft_quote` + 引号 chip + 退格/Delete 删除 + 发送拼装、气泡引用段（主窗 + 回顾窗，竖条 + `#a9c4e0`、摘要 2 行预算含引用行）、收起态与富文本复制把引文去 `>`；`src/interject.js` 开头引用块原样保留、不参与 200 字截断、待回执只记正文。顺带修 `interjectNote` 在 `at=null` 时印出 `@08:00:00`（`Number(null)=0`）。验证：`node --test` 387 tests / 384 pass / 0 fail / 3 skip；`py_compile` exit 0；`check-quote.py` / `check-feed-order.py` 均 exit 0。代码与本文随本轮提交。
- 2026-11-26 12:42 源码窗口冒烟（临时 `DSH_HOME` + 假 `chat.jsonl`，窗口 700×520 / 700×760，`capturable:true`）：镜像条目以用户气泡显示；`> 你好 / > 世界` 显示为 2px 竖条 + `#a9c4e0` 引文 + 正文；assistant 的 `>` 仍原样。**发现并修**：`ChatFeed.parse` 没把 `origin` 带出来，镜像气泡被画上「未确认 / 发送中」的投递状态；现在 `parse` 带 `origin`，`_draw_send_state` 对 `origin=="dsh"` 直接不画。证据：`_scratch/window-smoke/`（临时目录，不入库）。
- 2026-11-26 19:36 **A/B/C 实机验收全部通过**（真重启 DSH 后，插件 `.29`）：
  - **启动 / 换绑回填**：`mirror.log` 19:31:30 `backfill session-880ed9d0 startup: wrote 18/18 scanned 1952 ms=2942`；19:32:06 `backfill session-cb8c0785 rebind: wrote 3/3 scanned 1684 ms=263`。
  - **A**：格在主窗发「同步测试 A」，事件时间 19:33:02.872 → `chat.jsonl` mtime 19:33:02.875（3ms），条目 `origin:"dsh"` / `mid:"session-cb8c0785-…:1721"`；截图里气泡 19:33:02 出现。19:35:13 那条 5ms（1795692913951 → 13.956）再验一次。
  - **B**：浮窗选区引用「同步测试 A」+ 正文「这句什么意思」→ `chat.jsonl` 条目 `text: "> 同步测试 A\n\n这句什么意思"`（无 `origin` / `mid`），`relay.log` 19:33:23.986 一条 `ok(chat,followup)`；DSH 收到的消息开头是 `> 同步测试 A` 空行 + 说明（引用块未被 200 字截断）。**DSH 主窗渲染没截到图**（滚主窗时没滚到那一条），但文本与 DSH `formatQuoteText` 同形；格自己用主窗引用功能发的消息也按同格式到达。
  - **C**：浮窗发「浮窗测试 B」→ 一条 `role:"user"` 无 `origin`/`mid`，`relay.log` 19:33:41.558 一条 `ok(chat,followup)`；`mirror.log` 无新增（没被镜像回来），`focus.json` 为 `off`（没有 watch / 循环在跑，不存在误判插话）。
  - 收尾：浮窗已关（`see-window --close`），`see-now.json` 的 `session` 从测试用的 `cb8c0785` 还原为 `880ed9d0`（备份 `_scratch/see-now.json.bak`）。
- 2026-11-26 19:52 格选择 **B**（浮窗消息要在主窗显示成用户气泡）。改 relay 投递：
  - `src/timer.js`：`followupMessage` 支持 `sourceKind`（`user` / `see-now`）；`wakeSession` / `wakeWithRetry` 透传；relay 代投的 user 消息 id 落盘 `~/.dsh/see-now/relay-user-ids.json`（最近 200 条），导出 `isRelayInjectedId`。
  - `src/interject.js`：新增 `relayUserText`（原话逐字，投成 `source:"user"`）与 `relayInstruction`（说明单独一条，`see-now`）；`interjectNote` 保留给工具结果用。
  - `src/index.js` 的 `relayDeliver`：先投原话（user），再投说明（see-now）；说明失败只记 warn，不把回执标成失败。
  - `src/mirror.js`：live 与回填都跳过 relay 代投的消息 id —— 否则浮窗刚发的话会被镜像回灌成第二条。
  - 测试：`session-mirror` 加 relay-id 跳过用例；`interject-quote` 加 `relayUserText` / `relayInstruction` 用例。`node --test` 390 tests / 387 pass / 0 fail / 3 skip。
  - 文档：README / 机制.md 第十节 / 决策记录 / CHANGELOG 同步。**待复验**：重启 DSH 后浮窗发一条，主窗应出现用户气泡、引用按 Markdown 渲染、浮窗不重复。
- 2026-11-26 20:05 B 复验通过（重启后）：浮窗发「> 引用复验 / 这是浮窗发的原话」→ 主窗出现**用户气泡**，引用显示成 `“ 引用复验 这是浮窗发的原话` 的引用预览；`relay-user-ids.json` 生成、mirror 无新增（浮窗里那条只出现一次）。随后格从浮窗发「我看看」+ 本地图片，主窗把 `![图片](C:\…png)` 显示成一行路径 —— 格要求**现在补图片**。
- 2026-11-26 20:10 图片支持：`interject.splitImageMarkdown` 把本地图 markdown 拆出来；`index.js` 的 `loadRelayImages` 读成 `{type:"image", data:base64, mimeType}`（单张 ≤4MB、最多 4 张，失败 / 超限保留原 markdown）；`timer.js` 的 `followupMessage` 支持 image 内容块；relay 原话那条带图投递。文档同步。验证：`node --test` 391 tests / 388 pass / 0 fail / 3 skip。**待重启复验**图片显示。
- 2026-11-26 20:20 **内联 base64 方案实炸**：DSH 主窗把 `{type:"image", data, mimeType}` 渲染成「附加内容块」的原始 JSON；更严重的是它被原样写进持久历史，DeepSeek adapter 准备请求时读 `block.attachment.width` 抛 TypeError → 兜底成 `TRANSPORT`（界面「DeepSeek Messages transport failed」），重试 5 次全废，之后每一轮连纯文本都失败，`session-cb8c0785` 被锁死。结论：DSH 只认 `{type:'image', attachment:{attachmentId,…}}`（`attachments.saveImage()` 换来的引用）；`agent.followup()` 这条路上没有准入校验，坏块投进去什么样就存什么样。
- 2026-11-26 20:30 另一会话 `session-39caa84d` 修复（commit `81db996`）：`loadRelayImages` 改 async、逐张 `attachments.saveImage()` 换引用；`followupMessage` 只接 attachment，遇到内联 `data` 直接抛错让这条投递失败（窗口显示「发送失败」、relay.log 有原因）；新增 `test/relay-image.test.mjs` 5 条守门测试；版本 `0.1.1-more.30`。e2e：浮窗发图 `relay.log` 12:29:46Z `ok`；该会话 `user/message` 是 attachment（sha256:5f487f63…，1354×326，670236B），该轮请求正常返回。`node --test` 396 tests / 393 pass / 0 fail / 3 skip。
- 2026-11-26 20:48 发版前文档对齐：README / 机制.md 第十节 / 决策记录把「读成 base64 内容块」改成「附件引用」，并写明内联块锁死会话的事故；交接文另写 `docs/tasks/session-mirror-quote-handoff-2026-11-26-2048.md`。剩 tag `v0.1.1-more.30` + Release。
- 2026-11-26 20:52 **发版 `v0.1.1-more.30`**：tag `v0.1.1-more.30` 指向 `b11eb37`；`git-push.ps1 -TagAtHead` 走代理推送成功（`1d3cf69..b11eb37 main` + new tag）；Release 已建并核 `isPrerelease: true` <https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.30>。tag 之后的提交只动文档，不挪 tag。

