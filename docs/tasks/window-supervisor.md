<!-- 来源：session-7ef46cbe。2026-11-27 写；只写方案，没动代码。
     与 `upstream-2x-gap.md` 是两份账：那份补功能，这份改定位；互不阻塞。 -->

# 悬浮窗做 DSH 的监护进程：独立启动 / 重启 DSH / 回来自核

状态：等你定
对象：把悬浮窗从「DSH 的附属 UI」变成「活得更久、能操作 DSH 的监护进程」。第一版只做三件：自己起得来、能把 DSH 重启、回来自己核一遍并回报。**不做第二个 agent，不做 DSH 的 fork。**
归属：session-7ef46cbe-1f6f-458e-a891-337033107248 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：你定两件事——P1 的发起口（窗 / 工具）、独立启动的第一形态（快捷方式 / 托盘 / 热键）。点头后开工。
证据：
  - 窗比 DSH 活得久：`src/window.js:495` `detached: true`
  - 窗有自己的对话记录：`src/chat.js:31` → `~/.dsh/see-now/chat.jsonl`
  - 重启后补投：`src/index.js:1609` 提到的 `replayUnanswered()` 路径
  - 本仓没有重启能力：`src` 里 `restart|relaunch|respawn` **0 命中**
  - 别人家有：`dshmarket/lib/restart.js`（`restartAllowed` / `detectedSupervisor` / `scheduleRestart`）
  - 桌面端位置：`H:\DSH\Current\DeepSeek Harness.exe`（Electron）
账：无需（本轮只读代码 + 写文档）
更新：2026-11-27 10:19 CST

## 为什么这件事值得单开一份

- 痛点原话（格，2026-11-27）：「我其实很烦自己手动重启 dsh」。改完插件必须重启才生效，而重启只能人手做——模型所在的回合跟着进程一起死，**谁都不能重启自己**。
- 所以要有一个**不属于 DSH 进程树**的进程：它活着，才能把 DSH 关掉再拉起来。现有窗正好是 `detached: true` 起的（`src/window.js:495`）——这是这件事唯一一个现成的前提。
- 与上游差距那份无关：那份是「补哪些上游功能」，这份是「它到底是什么东西」。两份并行，互不阻塞。

## 一个顺序问题（先想清楚再动手）

**能重启 DSH 的前提，是它自己能独立起来。** 否则鸡生蛋：DSH 关了 → 窗也起不来 → 没人重启 DSH。

所以「形态独立」不是并列的第二件事，是重启的**前置条件**，P1 必须一起做。最小形态可以很轻：一个快捷方式拉起 `window.py`，连不上宿主就显示「DSH 没开」而不是空转。

## 现有零件（已核）

| 零件 | 在哪 | 能不能直接用 |
|---|---|---|
| 窗比 DSH 活得久 | `src/window.js:495` | 能，已满足 |
| 窗自己的对话记录 | `src/chat.js:31` | 能，重启后靠它续 |
| 重启后补投没人回的句子 | `src/index.js:1609` | 能，但要真重启验一次 |
| 重启 DSH 的现成实现 | `dshmarket/lib/restart.js` | **不能照抄**：它 relaunch 的是 `dsh web` 的调用（`dshArgv()`），桌面端是 Electron |
| 宿主启动坐标（exe / argv / cwd） | **没有** | P1 第一件 |
| 本仓的重启能力 | **0 命中** | P1 第二件 |

## P1：三步

### 1. 宿主留坐标（新 `src/host-info.js`）

启动时写 `~/.dsh/see-now/host.json`：`{exe, argv, cwd, env: {PATH, DSH_*}, pid, version, at}`。**不写密钥**，env 走白名单。

为什么必须有：窗要重启 DSH，就得知道它当初是怎么起来的。桌面端的 `process.execPath` / `process.argv` 与 `dsh web` 不同，抄不得；不写这份，窗只能猜一条 exe 路径。

### 2. 窗能自己起 + 能发起重启

- **独立启动**：一个 `.lnk` / `.bat` 拉起 `window.py`，不依赖 DSH；连不上宿主时给「DSH 没开，要我拉起来吗」，而不是静默空转。
- **重启动作走已有的 outbox 通道**（`window-outbox.jsonl`，`window_protocol.py:1-14`）：不新开路由、不动工具契约。
- **编排**：确认旧 pid 真退出 → 按 `host.json` 的坐标 spawn → 轮询心跳/端口直到回来（上限 60 秒）→ 失败报原因并**停手**。

### 3. 回来之后自核三件，写回窗里

- **版本**：`dsh.plugin.json` 的 `version`（或 profile 里安装副本的 `package.json`）
- **工具注册**：宿主日志里 `已注册工具 see_now（v…）` 那一行（`src/index.js:2786`）
- **采集**：`src/capability.js` 里的状态是否 ready

核完在窗里落一行：`回到 vX · 工具已注册 · 采集 ready`；缺哪项就逐项报差。

## 验收（真机，不靠感觉）

1. 改一处可见文案
2. 在窗里点「重启 DSH」
3. 窗自己报出：旧 pid 已退 / 新 pid 起来 / 版本 = 新代码 / 工具已注册 / 采集 ready
4. 失败路径也演一次（把 `host.json` 的 exe 改错）：要报错并停手，不能进重试循环

## 已知的坑（写进代码注释，别靠记性）

- **Electron 单实例锁**：新进程可能把请求转给旧实例后自己退出 → 必须等旧 pid 真退出再拉。
- **别在回合内重启自己**：会掐断正在跑的回合。发起口放窗（回合外）；工具那条等以后，且要排队到回合结束。
- **能热载的别重启**：DSH 支持插件停用/启用/换版本的热重载，重启是兜底，不是首选。
- **失败停手**：连续 3 次失败就停，把 stderr / 日志尾巴带出来。
- **两处留痕**：`~/.dsh/see-now-window.log`（窗侧）与宿主日志，各记一行「谁在什么时候重启了」。

## 不做

- **不做 DSH 的 fork**（格的定位，2026-11-27）：窗只操作 DSH，不接管它的内核。
- **不做「自动改代码 + 自动重启」的闭环**：改由 agent 做，窗只负责重启与回报；闭环等这版跑顺。
- **不做托盘**：上游那份判过不搬；若独立启动确实需要常驻图标，再单开一件。

## 边界

- 不动工具契约：这一步不加新 action，重启只走 outbox。
- 不动采集链、拼图、token 口径。
- 不引新依赖；Python 侧只加状态与按钮。

## 日志

- 2026-11-27 10:19 新建（等你定）。依据：格的定位（不 fork、要能修 DSH 自己、烦手动重启）+ 本轮核对（`src/window.js:495`、`src/chat.js:31`、`src/index.js:1609`、`dshmarket/lib/restart.js`、`src` 里 restart 0 命中、`H:\DSH\Current\DeepSeek Harness.exe`）。未动代码。
- 2026-11-27 10:29 收窄范围：格指出「关掉 DSH 之后还想问」这条用**交接文**就够，不需要窗里再挂一个模型通道。所以 A（窗直连 provider）/ B（headless 会话）两支**不做了**，本任务书只剩「重启 DSH + 回来自核」；离线期间的说明由 `docs/offline-card.md` 承担。
- 2026-11-27 10:39 交接卡迁到全局：`C:\Users\Administrator\.dsh\offline-card.md`（模板 `~/.dsh/templates/offline-card.md`），本区 `docs/offline-card.md` 删除；规则同步写进全局 `AGENTS.md` 的动作反射，本区不再重复。
