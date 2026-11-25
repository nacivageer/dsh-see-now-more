# 交接：`see_now` 的「屏幕读取总开关」（档 B）

> 交接给 **see-now-more 工作区**的会话执行。本文件自包含：为什么做、代码在哪、按什么形态做、验收怎么算过。
> 写于 2026-11-25，来自评估上游 0.2.6–0.2.8 的那轮（session-d52e3d48）。那一轮只做了档 A
> （开窗单飞 + `chat.jsonl` 权限兜底，已发 `v0.1.1-more.26`）；本文件是当时明确留待的档 B。

## 状态

- 状态：已发版（0.1.1-more.27；实机 1→9 全走完，含 `rise` 的循环唤醒自己开窗）
- 对象：给 `see_now` 加一个**用户侧**的屏幕读取总开关——关掉后 `watch` / `start` / `peek` / `region`
  一律硬拒（**连显式 `source` 也不放行**），模型侧没有任何 action 能打开它；唯一入口是悬浮窗里的设置卡。
  配套加一个「关闭悬浮窗后默认行为」四档开关（见文末那一节，格 2026-11-25 定的档位与默认值）。
- 归属：`C:\Users\Administrator\Documents\deepseek-harness\see-now-more`（session-d52e3d48 写）
- 下一步：commit → 打 `v0.1.1-more.27`（annotated）→ Release 标 prerelease（等格点头再推）。
- 证据：单测 `node --test` 366 项 / 363 过 / 3 skip；实机记录见文末「实机验收记录」。
- 更新：2026-11-26 03:35 CST（session-2eaf2d91 接手后）

## 实机验收记录（2026-11-26，格在旁共测）

| # | 项 | 结果 |
|---|---|---|
| 1 | `node --test` | 366 项 / 363 过 / 3 skip（新增 `test/screen-gate.test.mjs` 7 条） |
| 2 | 总开关热生效 | 写 `enabled:false` → 2.2s 后 `status` 首行「总开关：关」；`watch`（带 `source:"screen"`）/ `region` / `peek` / `start` 四入口全返 `disabled-by-user`；进程表无 `ffmpeg` / `window.py` / `pick_region`，`window-heartbeat` 未更新。**设置卡路径**：格点「屏幕读取」→ 关 / 开，JSON 写入正确、`status` 跟随 |
| 3 | 窗还在、还能聊 | 窗里打的话进会话，`relay.log`：`ok(chat,followup)`（19:29:43）—— 第一次 `FAILED(session not found)` 是配置里绑定的旧会话 id（重启前的），插件自动退回当前会话重投，这是既有行为、与本档无关 |
| 4 | 点回「开」→ 能看 | `watch` 正常出图（03:29） |
| 5 | 重启后仍是关 | 重启后 `status` 首行「总开关：关」，采集未起（03:28） |
| 6 | 版本 / 安装一致 | 三处 `0.1.1-more.27`；`install-dev --check` = `current`。tag / Release 待做 |
| 7 | 四档 | `stop`：循环 `已停（window-closed）` + 采集停 + 听觉停 + 挂断说明；`ears`：循环 `只听` + 采集停 + **听觉在听**；`ghost`：`在看 screen`（21s / 233 帧）+ 循环在跑 + 听觉在听 + 窗不弹回；`rise`：`watch` 自己重开了窗（pid 换新），**循环唤醒那条也验到了** —— 03:42:28 的仅监听唤醒之后 1 秒新窗进程 138452 起（心跳随即刷新） |
| 8 | `say` 没窗 | 结果末尾出现「窗没开着，这句 say 没有气泡可投」 |
| 9 | 默认档回归 | 未配置 `onWindowClose`（= stop）时关窗行为与 `more.26` 一致：全停 + 挂断 |

实机才暴露、已修的三处：

1. **留耳档关窗后耳朵被自己关掉**：`stopVision()` 停采集进程 → `run.done` 回调走 `teardown()` →
   `listener.stop('采集收工')`。修法：`teardown(why, { keepAudio })` + `stopVision()` 在停进程前立标记。
2. **设置卡那行提示被右边界截断**（格红框标出）：拆成两行短句（卡片最窄 380px 也放得下）。
3. 附带：`ears` / `ghost` 下 `watch` 的「悬浮窗没开起来」改成「悬浮窗是关着的」——那一档是**故意不弹窗**，
   不该写成故障。

## 一句话

现在能"别看了"的只有 `stop`（模型调的）和关窗；而**关窗在我们这儿不算闸**——`guardReason` 对显式来源
放行（`src/runner.js:194`），模型传个 `source` 还是能看。这一档补的是用户自己按得下、模型解不开的那道闸。

## 为什么是我们自己做，不是直接抄上游

上游 `SAOS-3624/dsh-see-now` 的 **v0.2.7（#77, commit `74e6341`）** 就是这件事。口径可以照抄，
**形态不能照抄**，因为它有三个前提我们都没有：

| 上游 | 我们 |
|---|---|
| 入口是设置页 + `/seenow on|off` 命令 | 没有设置页，也没有 `/seenow`（宿主命令 API 未核过） |
| 关掉时**连窗一起关** | 入口就在窗里——关窗等于把用户锁在门外 |
| 关掉后窗里打字没人回（所以他们要 #76 一起关窗） | 我们有 relay：窗留着、打字照投，只是不能看 |

所以这版的做法是：**闸照抄，入口换成窗口的设置卡，关掉时不关窗。**

## 落地位置（2026-11-25 核过的行号）

- `src/tuning.js:21` `TUNING_DEFAULTS` 加 `enabled: true`。
  校验照 `lift.enabled` 那条（`189` 行附近的写法）：**只认真正的 boolean**，字符串 `"false"` 要报
  warning 并回默认 true——字符串是真值，用户以为关了、其实一直开着（上游踩过这个坑）。
  （上游还有 `WRITABLE_KEYS` / 设置 API 那一套，我们这份没有——别为这个补。）
- `src/runner.js:194` `guardReason(...)` 加 `disabled`，**第一个判**（在 `explicitSrc` 之前）：
  ```js
  if (disabled) return 'disabled-by-user';
  if (explicitSrc) return null;
  ```
  同一文件 `893` 行 `let hungUp = false` 旁边加 `let enabled = true`；`1545` 的调用点传
  `disabled: !enabled`；`createRunner` 参数表加 `enabled` 初值；导出 `enabled()` / `setEnabled(next)`。
- `src/index.js`：
  - `697` `createRunner({...})` 传 `enabled: tuning.enabled`。
  - 四个入口先判、再干活：`1628` watch、`1834` peek、`1853` start、`2011` region。
    **region 也要拒**——它的选择器要先抓一张屏，等于看一眼。
  - `1734` 那个 `r.reason === 'hung-up'` 分支旁边加 `disabled-by-user`，并且要排在它**前面**
    （闸比"关过窗"更硬）。
  - `2316` status 正文最前面加一行：`总开关：开` / `总开关：**关**（你自己关的；在悬浮窗设置卡里打开）`。
  - `1016` `modeWatcher` 每 1.5 秒已经 `readTuning()` 一次，在同一拍里比 `enabled`：变了就
    `applyEnabled()`。**别把它和 `mode` 那个条件混在一个 if 里**（改节奏也会误触）。
    关掉时顺序：`stopLoop()` → 画面一定停 → **不动窗**；听觉按配套那节的 `onWindowClose` 分流
    （`stop` 一起停、`ears`/`rise` 留听、`ghost` 等同 `ears`）。打开时只改状态，
    不自动开采集（让模型/user 下一句自己决定）。
- `examples/floating-chat/window.py:8599` `SETTINGS_ROWS` 加一行，格式照现有三行：
  ```python
  ("enabled", "屏幕读取", (True, False), {True: "开", False: "关"}, True),
  ```
  写盘走现成的 `_settings_write`（`8639`，无 BOM、`os.replace`）。窗侧别的都不用改：插件 1.5 秒内读到。
- `src/tool-spec.js` 的 description 加 2–3 句（`disabled-by-user` 不是故障、别重试、别换参数绕开、
  只有用户能开）。我们 description 现在 1651 字符，加了也远低于上游 3800 的预算线。
- 新增 `test/screen-gate.test.mjs`。上游那 7 条（v0.2.7 的 `test/screen-gate.test.mjs`）可以照口径改：
  关闭后四个入口全拒且不去开窗 / 显式来源压不过总闸 / 配置写成字符串要报错 / 重复收工不报错 /
  status 报内存实况而不是文件。

## 拒绝文案（照抄上游口径，把 `/seenow` 换掉）

watch / start：

> 用户关掉了「屏幕读取」总开关，现在不许采集屏幕。
> **这不是故障**，也不要重试、更不要换参数绕开 —— 闸在你调不动的层。
> 能打开它的只有用户自己：悬浮窗 →「本插件设置」→「屏幕读取」。
> 想继续看就直接请他打开；在那之前别再说「我在看着你」。

peek 单独一句，**不能落到"还没攒到画面"**——那句会把责任推给"还没攒"，模型于是继续等、继续 peek：

> 用户关掉了「屏幕读取」总开关，现在没有画面可给。**别重试**，只有用户自己能打开。

region：

> 用户关掉了「屏幕读取」总开关，选择器要先抓一张屏，所以也开不了。

## 配套：关闭悬浮窗后默认行为（`onWindowClose`）

格 2026-11-25 定：**未配置时 = 收工**（关窗同时关视觉与听觉，即现在的行为）。四档放进设置卡；
「收工」「隐身」这类短名单看含糊，**每档旁边要有一行小字写实际功能**。

| 值 | 卡片短名 | 小字（卡片上显示） | 画面 | 听觉 | 关窗后会不会自己把窗弹回来 |
|---|---|---|---|---|---|
| `stop` | 收工 | 停画面、停听觉；之后不会自己开窗 | 停 | 停 | 不会（挂断） |
| `ears` | 留耳 | 停画面、保留听觉；有料时只在会话里说，不开窗 | 停 | 留 | 不会 |
| `rise` | 可抬头 | 停画面、保留听觉；有料时自己重开窗并说明 | 停 | 留 | 会 |
| `ghost` | 隐身 | 窗收起，画面和听觉都继续 | 继续 | 继续 | — |

现状（要改的就是这里）：`src/index.js:1278` 的 `onStop` 收到 `window-closed` 就
`runner.note(HANGUP_NOTE)` + `runner.hangUp()`（`runner.js:1421`），而 `hangUp()` 里的 `teardown()`
会停画面、留底、血条、听觉（`runner.js:907-920`，`listener.stop('采集收工')`）。没有中间档。

接线：

- 配置键 `~/.dsh/see-now.json` 的 `onWindowClose`（枚举四值，默认 `stop`；写错回默认并在 `status` 报一句）。
- `onStop` 的 `window-closed` 分支按值分流：`stop` = 现行为；`ears` / `rise` = `runner.stopVision()`
  （只停画面，留听 + 留底），**不 `hangUp()`**；`ghost` = 什么都不停，只把"窗没了 = 挂断"这条判据摘掉。
- **循环那边也要一起改**：`src/loop.js:832` 现在是 `if (verdict === 'closed') { stop('window-closed'); return; }`
  ——`ears`/`rise` 要改成"停画面、循环继续"（`stopVision()` 后接着 tick），`ghost` 要完全不理会窗没了。
  判据本身在 `windowVerdict()`（`loop.js:257`，连续几拍才认），别绕开它自己数。
- 总开关关掉时（见上一节）：画面一定停；听觉按 `onWindowClose` 走 —— `stop` → 一起停，
  `ears` / `rise` → 留听，`ghost` → 等同 `ears`（总开关本身就否定了"继续看"）。
- 设置卡：`window.py:8599` 的 `SETTINGS_ROWS` 从 5 元组扩成 6 元组（多一个 hint 字典）；
  两处解包要跟着改 —— `_settings_value`（`8652`）与 `_settings_paint` 里 `kind == "setting"` 分支（`8871`）。
  带 hint 的行高 56 → 68，在标签下画一行 10px `#8fa0b6` 说明；点击仍走 `_settings_cycle`（`8931`）。
- 热生效：窗口写 json → `index.js:1016` 那个 1.5 秒轮询一并读 `onWindowClose`。

## 验收（可观察，逐条）

1. `node --test` 全绿（当前基线 359 项 / 356 过 / 3 skip；新增的 screen-gate 不被 skip）。
2. 实机：设置卡点成「关」→ **≤2 秒**内 `see_now status` 出现「总开关：关」；`watch`（即使带
   `source:"screen"`）与 `region` 都返回 `disabled-by-user`；采集没起、窗没弹。
3. 窗还在：窗里打一句话 → `~/.dsh/see-now/relay.log` 里有 `ok(chat)`（还能聊，只是不能看）。
4. 设置卡点回「开」→ `watch` 能正常起来。
5. 重启 DSH：`~/.dsh/see-now.json` 里 `enabled:false` 仍是关（读配置那条路通）。
6. 版本三处同改 + `install-dev --check` 一致；发 `0.1.1-more.27`，Release 标 prerelease。
7. 四档各验一次：关窗后 `see_now status` 的「窗口 / 采集 / 听觉」三态符合上表；
   `ghost` 下关窗后 `runner.status().running === true`；`rise` 下关窗后循环仍醒、且能自己开窗
   （`~/.dsh/see-now/relay.log` 或窗口日志里出现 `window open`）。
8. `ears` / `ghost` 下 `say` 返回"窗没开、只有文字"的说明，不静默丢。
9. **回归**：未配置 `onWindowClose` 时行为与 `0.1.1-more.26` 完全一致（关窗 → 全停 + 挂断）。

## 已知的坑（别踩第二遍）

- **别在关掉时关窗**——入口在窗里，关了就只能让用户去手改 JSON。
- **闸别只放在工具入口**：`window show:true`、别的 action 都可能被模型当绕路；闸放在
  `guardReason` 是最早的一层，`hung-up` 能放行的情况它一律不放行。
- **`stop` 的语义不要动**：上游 0.2.7 顺手让 `stop` 关窗（#76），我们不跟——理由写在
  `CHANGELOG.md` 的 `0.1.1-more.26` 段和上面那张表里。
- **`enabled` 写坏成字符串**要能报出来，不能静默当成开。
- 「屏幕读取」那行是**布尔档**（两个值就是开关，别加第三档）；「关窗后」那行才是四档，两行别写成一个组件。
- **`ghost` 与挂断互斥**：循环不能一见 `windowAlive()` 为假就 `hangUp()`，先看 `onWindowClose`。
- **`ears` 下 `say` 没有地方投**（气泡和朗读都挂在窗上）；工具结果要显式说"窗没开、只有文字"，
  否则模型会以为用户看见了。
- **`rise` 就是社区抱怨过的"关掉又弹出来"**——只能是用户显式选的档，绝不能当默认。
- 小字直接画在行里（Tk canvas 没有 tooltip），行高跟着加，别指望悬浮提示。

## 边界

- 不发 npm（源码安装 + tag/Release 锚点）。
- 不做 `/seenow` 命令：这版宿主有没有命令注册 API 还没核，别在没核之前动。
- 不改 `stop`、不改 `window.py` 设置卡以外的部分。
- 上游 0.2.7 的 `stop` 关窗、0.2.8 的文案压缩都不属于这一档。
