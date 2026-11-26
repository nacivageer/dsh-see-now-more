# 任务书：浮窗补齐会话里的模型正文（assistant 镜像 + 回填，0.1.1-more.31）

状态：可验收（真机 A/B 已过；提交 + tag + Release 进行中）
对象：把绑定会话里 assistant 的正文也同步进浮窗的聊天流 —— 窗关着时照写、插件启动 / 换绑时回填，补掉「关窗一段再开，回看只有用户半边」的缺口。不碰窗口 UI。
归属：session-8cca3e59-4846-40d9-bf73-893e55226978 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：提交（11 个路径）→ tag `v0.1.1-more.31` → prerelease Release（草稿 `_scratch/release-031.md`；提交信息按实际读数改 `Verified:`）。之后把本状态块改成「已发版」再补一笔文档提交，不挪 tag。
证据：
  - **真机（2026-11-26 22:15，格重启 DSH 后 `.31` 生效）**：`mirror.log` `14:15:06.215Z backfill session-8cca3e59 startup: wrote 0 users + 6 assistant / 0+6 scanned 1151 ms=4027`；`14:17:20.186Z wrote session-8cca3e59-…:1156（26 字）`（格在主窗发的那句，窗关着 → live 镜像）；`_scratch/verify_after_restart.mjs` PASS（9 条镜像：user 3 / assistant 6，0 重复 mid）；开窗截图 `_scratch/assistant-mirror-real-restart.png`（4 条回填的模型气泡 + 22:17 那条用户气泡）。
  - `node --test` → 408 tests / 405 pass / 0 fail / 3 skip（2026-11-26 21:50，含 `pushAssistantText` 接线测试）。
  - `node --test test/session-mirror.test.mjs` → 27 tests / 27 pass：live 关窗写（接线层单独测）、独立游标、旧条目去重（同文 ≤10s / say 占比 ≥30% ≤120s）、500 上限、幂等、补投不被遮断。
  - **真实文件升级检查**（`_scratch/real_upgrade_check.mjs`：把真 `chat.jsonl` + 水位复制进临时 home，用本会话真实事件跑 `.31` 回填）：只补 3 条 assistant、用户条目 2 条不变、行数 1556→1559、第二次回填 0 写 → PASS。
  - **窗口冒烟**（`_scratch/wm31-a` 式的临时 home + 真 `bin/see-window.mjs`）：回填出来的模型正文按时间排在用户气泡之间、没有投递状态、顺序正确；截图 `_scratch/assistant-mirror-smoke.png`。
  - **真实会话事件集成**（`_scratch/mirror_real_check.mjs`，三份会话 cb8c0785 / a58208c0 / 39caa84d）：形状 / 顺序 / mid 唯一 / 截断 / 二次回填 0 写 / 旧条目退化后 0 重复 → 全 PASS。
  - `python -m py_compile examples/floating-chat/window.py examples/floating-chat/quote_text.py` exit 0；`scripts/check-quote.py` / `scripts/check-feed-order.py` exit 0。
  - 重启后一条命令：`node _scratch/verify_after_restart.mjs`（查副本版本、`.31` 的 startup 回填行、绑定会话两侧条目、重复 mid）。当前跑出来是「还没重启」。
  - 代码落点：`src/mirror.js`（`assistantTextOf` / `onAssistant` / `pushAssistantText` / `assistantThroughSeq` / 回填合并），`src/chat.js`（`pendingStartupEntries` 跳过镜像 assistant），`src/index.js`（接线，朗读仍只在窗开时）。
账：无需（实现轮）
更新：2026-11-26 21:53 CST

## 验收（3 条，格确认过；中途要加先问）

- **A 关窗也同步**：关着浮窗，在主窗聊两轮 → 打开浮窗，两句用户 + 两句模型正文都在，按时间顺序，不重复。
- **B 重启不重复**：重启 DSH（插件重载）后再开窗，同一批内容不重复追加；`mirror.log` 有 assistant 回填行，`chat.jsonl` 行数不变。
- **C 补投不被遮断**：一条没投出去的浮窗消息，在 assistant 条目写进 `chat.jsonl` 之后仍会被启动补投（单测钉住；实跑看 `relay.log`）。

回归（不算新验收）：`node --test` 0 fail、`python -m py_compile` 两个窗口文件 OK、`scripts/check-quote.py` / `scripts/check-feed-order.py` exit 0。

## 设计（定下来的，实现照这个）

1. **live 不再看窗**：`mirrorAssistantText` 的 `!windowAlive()` 早退去掉 —— 用户消息在 `.29` 里已经关窗照写，模型正文没道理不写。写入带 `{sid, at: event.time, mid: "<sid>:<seq>", origin:"dsh"}`；**朗读仍只在窗开时**（`speakAssistantReply` 照旧，窗不开没人放声音）。
2. **回填 assistant**：独立游标 `assistantThroughSeq`（不跟用户游标共用，否则「assistant 在最后一条 user 之前、且当时窗没开」的那批永远补不到）。取 30 天内、最近 500 条、跳 fork 继承前缀；`mid` + `chat.jsonl` 里已有 assistant 条目做去重：
   - 同文且时间差 ≤10 秒 → 跳过（旧版 live 写的条目没有 `mid`）；
   - 已有条目是候选的一大部分（占比 ≥30%）、时间差 ≤120 秒 → 跳过（`say` 已经把那句话写过一遍；
     live 的判据只是「包含」，加占比是因为实测模型下一轮的长回复里会顺带提旧台词，只看包含会误吞）。
3. **补投判据**：`pendingStartupEntries` 里 `origin:"dsh"` 的 assistant / meta 跟镜像 user 一样「跳过但不停」，普通 assistant / meta 仍停 —— 镜像的回复是会话记录，不是「浮窗这句话有人回了」的证据。10 分钟 cutoff + `relay-delivered.json` 仍是补投的去重主力。
4. **开关**：不新增配置键。`mirror.users:false` = 停会话内容同步（用户消息 + 模型正文的实时 / 回填），`backfill:false` 只停回填；窗里 `say` 的气泡不受影响。
5. 失败只记 `mirror.log`；写失败不推游标。

## 边界

- 不碰 `window.py` / `window_widgets.py` / 回顾窗；镜像条目窗口侧已能按 `mid` 去重、按 `at` 排序，不加改动。
- 不新增 `see_now` 参数、不改 `tool-spec.js`。
- 不把 assistant 的 `reasoning` / `tool-call` 搬进来，只搬 `type:"text"` 的块（多块用换行拼）。
- 版本按 `0.1.1-more.31` 递增；提交前等格验收，发版另行确认。

## 日志

- 2026-11-26 21:40 新建（进行中）。依据：交接文「P2」+ 代码里两处缺口（关窗不写、回填只取 user）；格选「P2-②」。未动代码。
- 2026-11-26 21:41 代码 / 单测 / 文档完成（未提交，等实机验收）：
  - `src/mirror.js`：新增 `assistantTextOf` / `normText` / `saidCovers` / `scanAssistantTexts` /
    `assistantAlreadyInStream`；`onAssistant()` 关窗也写、`mid`+`origin`+事件时间；`advanceTo`
    拆出 `throughSeq` / `assistantThroughSeq` 两条游标；回填把 user / assistant 合成一条按 seq
    的顺序写，两类各 500 条上限。
  - `src/chat.js`：`pendingStartupEntries` 里 `origin:"dsh"` 的 assistant / meta 跳过不停。
  - `src/index.js`：`mirrorAssistantText` 改为调 `mirror.onAssistant`，朗读仍只在窗开时。
  - 测试：`test/session-mirror.test.mjs` 26 条全过；全量 `node --test` 406 / 403 过 / 0 失败。
  - 真实事件集成 `_scratch/mirror_real_check.mjs`（三份真实会话）：回填形状 / 顺序 / mid 唯一 /
    二次回填 0 写 / 把条目退化成无 mid 再回填 0 重复 → 全 PASS。
  - 文档：README / 机制.md 第十节 / 决策记录 / CHANGELOG `.31`；版本三处同值 `0.1.1-more.31`。
  - 没验到的：真机 A（关窗时主窗聊天 → 开窗看得见）和 B（重启不重复）—— 需要装到 profile 并
    重启 DSH，等格点头；读数脚本 `_scratch/check_mirror_live.mjs` 已备好。
- 2026-11-26 21:50 补两件不依赖重启的证据（仍未提交）：
  - 把接线从 `registerAll` 闭包里提成 `pushAssistantText()`（`src/mirror.js`）并单测：
    「窗关着也写、不朗读；窗开着才念；say 覆盖的不写不念」—— 原来这行只有代码可读、测不到。
  - 真实文件升级检查：复制真 `chat.jsonl` + 水位进临时 home，用本会话真实事件跑 `.31` 回填 →
    只补 assistant、用户条目不变、第二次 0 写；再从这份数据开真窗口截图
    （`_scratch/assistant-mirror-smoke.png`）：模型正文按时间插在用户气泡之间，顺序对、无投递状态。
  - 全量回归 408 / 405 过 / 0 失败 / 3 skip；profile 已同步回 `.31`（`--check` 一致）。
  - 剩：真机 A/B 需要重启 DSH（格点头后做）；重启后 `node _scratch/verify_after_restart.mjs` 一条命令收证据。
- 2026-11-26 21:52 再补两件不依赖重启的：
  - **live 入口的整段模拟**（`_scratch/live_stream_check.mjs`）：把本会话 149 个真实事件按
    `onEvent` / `pushAssistantText(alive:false)` 的 live 入口喂一遍 → 2 条 user、4 条 assistant
    （135 条纯工具轮跳过）、`alive:false` 时朗读 0 次、mid 唯一、按 at 有序 → PASS。
  - **装好的副本能 import**：直接 `import()` profile 里的 `src/index.js`，导出 `apply` 等、无
    import 期异常 —— 排掉「重启后插件起不来」这一类问题。
  - 下一步清单已写进状态块（一次重启收 A/B/C，B 用「换绑触发再回填」验证，不必二次重启）。
- 2026-11-26 21:52 **装好的插件本体跑通**（`_scratch/apply_harness.mjs`，用 profile 里那份 `.31`，
  临时 `DSH_HOME`，不重启 DSH）：
  - `live`：`apply(ctx)` 注册 1 个工具 + 1 个 `session/event` 处理器（`plugin-error.log` 空），
    手动发 `user/message` + `assistant/message`（窗关着）→ `chat.jsonl` 两条
    `origin:"dsh"` + `mid` 条目。**A 的写入侧不再只是模块单测，是插件入口层。**
  - `startup`：只 apply、等 3 秒 → `backfill … startup: wrote 1 users + 1 assistant / 1+1`；
    同一个 home 再跑一次 → `wrote 0 users + 0 assistant`、文件行数不变（**B 的真机等价物**）。
  - 窗口侧证据仍是 `_scratch/assistant-mirror-smoke.png`（回填数据直接开真窗口）。
  - 结论：A/B 的证据链已到「插件入口 + 真实窗口」；真正剩下的只有「真实 DSH 进程里再跑一遍」
    这一层，格点头重启即可补上。
- 2026-11-26 21:53 窗口的**增量**路径也验了：开着的窗 + 直接往 `chat.jsonl` 追加一条
  `origin:"dsh"` 的 assistant 条目 → 1.2 秒内出现在底部、时间戳正确、无投递状态
  （截图 `_scratch/assistant-mirror-live-append.png`）。窗口侧确实不用改。
  同时把「收起态回填会弹一次通知」这条已知边界写进 `docs/机制.md`（要动共用 `window.py`，不修）。
