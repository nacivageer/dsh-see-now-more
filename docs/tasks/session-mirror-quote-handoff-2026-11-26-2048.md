# 交接：浮窗消息同步 + 选区引用 + 浮窗发图（see-now-more，0.1.1-more.30）

> 交接给 see-now-more 工作区的下一个会话，自包含：现在到哪、证据在哪、下一步做什么、坑是什么。
> 写于 2026-11-26 20:48 CST。功能 1/2 与 relay 用户气泡来自 session-cb8c0785；图片修复来自
> session-39caa84d（commit `81db996`）。格的要求是「写交接文」+「继续」。

## 状态

- 状态：**已发版** `v0.1.1-more.30`（prerelease，<https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.30>）。
- 版本：`0.1.1-more.30`（`package.json` / `dsh.plugin.json` / CHANGELOG 三处同值）；profile 已装
  （`node scripts/install-dev.mjs --check` = current）。
- 分支：`main` 已 push；tag `v0.1.1-more.30` 指向 `b11eb37`。tag 之后的文档提交只动文档，不挪 tag。
- 测试：`node --test` 396 项 / 393 过 / 0 失败 / 3 skip；`py_compile` 三文件 OK；
  `python scripts/check-quote.py` / `scripts/check-feed-order.py` exit 0。
- 任务书（living）：`docs/tasks/session-mirror-quote.md`（顶部状态块已更到 20:48）。

## 已经做完的（都验过）

1. **功能 1：主窗用户消息同步进浮窗**。`src/mirror.js`（新）：绑定会话的 `user/message`
   （`source.kind=user`）实时写 `~/.dsh/see-now/chat.jsonl`，带 `origin:"dsh"` / `mid:"<sid>:<seq>"`
   / 会话事件时间；启动 3 秒后与换绑时回填（500 条 / 30 天，跳过 fork 继承前缀）；水位
   `session-mirror.json` 写盘成功才推进，启动扫 `chat.jsonl` 尾部 4000 行 `mid` 补崩溃窗口。
   四个消费点（启动补投 / relay / 常驻循环 / 阻塞 watch）统一走 `isFloatUserEntry()`。
2. **功能 2：气泡选区「引用选中文字」**。`examples/floating-chat/quote_text.py`（纯函数，
   `format_quote_text` 与 DSH `formatQuoteText` 同形）+ `window.py`：主窗右键菜单、引号 chip、
   退格/Delete 删除、发送拼装、气泡引用段（主窗 + 回顾窗，2px 竖条 + `#a9c4e0`、摘要 2 行
   预算含引用行）；`scripts/check-quote.py` 无 GUI harness。
3. **relay 改投递（2026-11-26 20:0x，格选 B）**：浮窗消息拆两条 —— 原话 `source.kind:"user"`
   （主窗显示成**用户气泡**、引用按 Markdown 渲染）+ 说明 `source.kind:"see-now"`（仍是
   「收到执行请求」触发卡）。relay 代投的消息 id 落 `relay-user-ids.json`（最近 200 条），
   mirror 的 live / 回填都跳过，防回灌。
4. **浮窗发图（.30）**：`loadRelayImages()` 把本地图先 `attachments.saveImage()` 换成附件引用，
   投 `{type:'image', attachment:{attachmentId,…}}`；无附件服务 / 读不了 / >4MB / >4 张退回原
   markdown。`followupMessage()` 遇到内联 `{data}` 直接抛错拒投（守门测试 `test/relay-image.test.mjs`）。

## 关键证据（可直接抄）

- **回填**：`mirror.log` 19:31:30 `backfill session-880ed9d0 startup: wrote 18/18 scanned 1952 ms=2942`；
  19:32:06 `session-cb8c0785 rebind: wrote 3/3 scanned 1684 ms=263`。
- **A（实时 3–5ms）**：主窗发「同步测试 A」事件时间 19:33:02.872 → `chat.jsonl` mtime 19:33:02.875，
  条目 `origin:"dsh"` / `mid:"…:1721"`；19:35:13 那条 5ms 再验。
- **B（引用）**：浮窗发 `> 同步测试 A\n\n这句什么意思` → `chat.jsonl` 无 `origin`/`mid`，
  `relay.log` 19:33:23.986 一条 `ok(chat,followup)`；复查（20:05）主窗显示成用户气泡 + 引用预览
  `“ 引用复验 这是浮窗发的原话`。
- **C（不回灌 / 不重投）**：浮窗发「浮窗测试 B」→ 一条 user 无 origin/mid；`relay.log` 19:33:41.558
  一条 `ok`；`mirror.log` 无新增；`focus.json` off（没有 watch / 循环在跑）。
- **发图 e2e（.30，39caa84d）**：`relay.log` 2026-11-26T12:29:46Z `ok`；该会话 `user/message` 为
  attachment（sha256:5f487f63…，1354×326，670236B），该轮请求正常返回。

## 下一步

1. **已发版** `v0.1.1-more.30`（prerelease，20:52）：tag + push 完成，Release 已核
   （`isPrerelease: true`）。之后只动文档的提交不要再挪 tag；真有代码修复就按 `-more.31` 递增。
2. **存档**：若格要「存档本会话」，按 `~/.dsh/skills/memory/SKILL.md` 走三件套。
3. **可选后续（P2）**：回顾窗里的引用；窗关着期间的 assistant 正文回填；大图先缩后存；一条多条引用。

## 坑 / 现场（务必看）

- **图片块只能是附件引用**：内联 `{type:'image', data, mimeType}` 进持久历史后，DeepSeek adapter
  读 `block.attachment.width` 抛 TypeError → `TRANSPORT`，**之后每轮都失败**（`session-cb8c0785`
  中招）。看 `CHANGELOG` `.30` 段与 `src/timer.js` 的注释。
- **会话 cb8c0785 可能仍带坏块**：若下一会话要用它，先确认纯文本轮次是否正常；不要把它当干净会话。
  39caa84d 是修复 + e2e 的会话。
  - **2026-11-26 20:41 更正（session-39caa84d，格已核）**：坏块已移除，此条失效。第一次修法是「整份重压成
    一个 zstd 帧」，DSH 判 corrupt、该会话从 GUI 列表掉出去（`readFirstZstdLine` 要求首帧恰好一行 header）。
    按帧重建后修好：`seq 2475` 的内联块换成附件引用、1459 帧结构不变、首帧 201 字节单行。重启后折叠到
    `seq 2547`，该会话 20:48 实跑完成（4 分 8 秒 + 存档 2 分 41 秒），随后存档并 GUI 归档。脚本 `tmp/repair_frames.py`。
- **两个会话并行改同一仓**：提交按路径 `git add`；动手前 `git status` + `git log` 看有没有新提交
  （本交接就是 `81db996` 之后写的）。
- `~/.dsh/see-now.json` 当前 `session` 绑的是 `session-39caa84d-…`（不是写交接的会话）；测镜像前
  先用窗顶【关联变更】或改配置换绑。浮窗当前**没开**。
- 工作区有一个未跟踪的 `tmp/`（asar 解包脚本与清单，不是本任务产物，别误提交）。
- `window.py` 是重改版，**不要**跑 `npm run sync:window`、不要整文件覆盖；改动集中在输入区 /
  气泡解析 / 历史排序。

## 关键路径

| 东西 | 位置 |
|---|---|
| 任务书 | `docs/tasks/session-mirror-quote.md` |
| 本交接文 | `docs/tasks/session-mirror-quote-handoff-2026-11-26-2048.md` |
| 镜像核心 | `src/mirror.js`；`src/chat.js`（`isFloatUserEntry` / `pendingStartupEntries`） |
| relay 两条投递 | `src/index.js` 的 `relayDeliver`；`src/interject.js`（`relayUserText` / `relayInstruction` / `splitImageMarkdown`） |
| 图片附件 | `src/index.js` 的 `loadRelayImages`；`src/timer.js` 的 `followupMessage`；`test/relay-image.test.mjs` |
| 引用编码 / 窗口 | `examples/floating-chat/quote_text.py`、`window.py`、`scripts/check-quote.py` |
| 窗口排序 | `examples/floating-chat/window_widgets.py` 的 `ChatFeed`；`window.py` 的 `_history_entries` |
| 发版步骤 | `docs/决策记录.md`「发版六步」 |

## 交接时现场

- HEAD `b11eb37`（`v0.1.1-more.30` 已 push）；工作树干净（只有未跟踪 `tmp/`）。
- profile 已装 `.30`（`--check` current）；浮窗关着；`see-now.json` 绑 `39caa84d`。
- 时间 20:48；发版 20:52 完成。
