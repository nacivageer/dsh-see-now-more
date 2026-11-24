# 交接：`see_now` 的「屏幕读取总开关」（档 B）

> 交接给 **see-now-more 工作区**的会话执行。本文件自包含：为什么做、代码在哪、按什么形态做、验收怎么算过。
> 写于 2026-11-25，来自评估上游 0.2.6–0.2.8 的那轮（session-d52e3d48）。那一轮只做了档 A
> （开窗单飞 + `chat.jsonl` 权限兜底，已发 `v0.1.1-more.26`）；本文件是当时明确留待的档 B。

## 状态

- 状态：待开工（格 2026-11-25 说「先搁着，哪天想做单开一轮」；交接文按她要求先写）
- 对象：给 `see_now` 加一个**用户侧**的屏幕读取总开关——关掉后 `watch` / `start` / `peek` / `region`
  一律硬拒（**连显式 `source` 也不放行**），模型侧没有任何 action 能打开它；唯一入口是悬浮窗里的设置卡。
- 归属：`C:\Users\Administrator\Documents\deepseek-harness\see-now-more`（session-d52e3d48 写）
- 下一步：开一轮新会话照下面「落地位置」动手；动手前先 `git log --oneline -3` 核行号有没有漂。
- 证据：本会话已核过的锚点行号见下（2026-11-25 05:00 左右）；上游对照物是本地 tag `upv0.2.7`。
- 更新：2026-11-25 07:05 CST

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
    关掉时顺序：`stopLoop()` → `runner.stop()`（连听觉一起停）→ **不动窗**；打开时只改状态，
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

## 验收（可观察，逐条）

1. `node --test` 全绿（当前基线 359 项 / 356 过 / 3 skip；新增的 screen-gate 不被 skip）。
2. 实机：设置卡点成「关」→ **≤2 秒**内 `see_now status` 出现「总开关：关」；`watch`（即使带
   `source:"screen"`）与 `region` 都返回 `disabled-by-user`；采集没起、窗没弹。
3. 窗还在：窗里打一句话 → `~/.dsh/see-now/relay.log` 里有 `ok(chat)`（还能聊，只是不能看）。
4. 设置卡点回「开」→ `watch` 能正常起来。
5. 重启 DSH：`~/.dsh/see-now.json` 里 `enabled:false` 仍是关（读配置那条路通）。
6. 版本三处同改 + `install-dev --check` 一致；发 `0.1.1-more.27`，Release 标 prerelease。

## 已知的坑（别踩第二遍）

- **别在关掉时关窗**——入口在窗里，关了就只能让用户去手改 JSON。
- **闸别只放在工具入口**：`window show:true`、别的 action 都可能被模型当绕路；闸放在
  `guardReason` 是最早的一层，`hung-up` 能放行的情况它一律不放行。
- **`stop` 的语义不要动**：上游 0.2.7 顺手让 `stop` 关窗（#76），我们不跟——理由写在
  `CHANGELOG.md` 的 `0.1.1-more.26` 段和上面那张表里。
- **`enabled` 写坏成字符串**要能报出来，不能静默当成开。
- 设置卡那行是**布尔档**：`SETTINGS_ROWS` 的点击是"循环切值"，两个值就是开关；别给它加第三档。

## 边界

- 不发 npm（源码安装 + tag/Release 锚点）。
- 不做 `/seenow` 命令：这版宿主有没有命令注册 API 还没核，别在没核之前动。
- 不改 `stop`、不改 `window.py` 设置卡以外的部分。
- 上游 0.2.7 的 `stop` 关窗、0.2.8 的文案压缩都不属于这一档。
