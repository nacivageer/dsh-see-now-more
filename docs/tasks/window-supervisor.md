<!-- 来源：session-7ef46cbe。2026-11-27 写；只写方案，没动代码。
     与 `upstream-2x-gap.md` 是两份账：那份补功能，这份改定位；互不阻塞。 -->

# 悬浮窗做 DSH 的监护进程：独立启动 / 重启 DSH / 回来自核

状态：可验收（真机两轮：重启 + 回执都验到；`0.1.1-more.39` 已装进 profile，未 commit、未发版）
对象：把悬浮窗从「DSH 的附属 UI」变成「活得更久、能操作 DSH 的监护进程」。第一版只做两件：**能把 DSH 重启、回来自己核一遍并回报**（独立启动已降 P2，理由见下）。**不做第二个 agent，不做 DSH 的 fork。**
归属：session-7ef46cbe-1f6f-458e-a891-337033107248 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：再点一次「重启 DSH」——这次宿主起来的是 `.39`，会写 `host.json` 并落回执
证据：
  - 窗比 DSH 活得久：`src/window.js:495` `detached: true`
  - 窗有自己的对话记录：`src/chat.js:31` → `~/.dsh/see-now/chat.jsonl`
  - 重启后补投：`src/index.js` 的 `replayUnanswered()` 路径
  - 别人家有：`dshmarket/lib/restart.js`（`restartAllowed` / `detectedSupervisor` / `scheduleRestart`）
  - 桌面端位置：`H:\DSH\Current\DeepSeek Harness.exe`（Electron）
  - 本版落地：`src/host-info.js`、`examples/floating-chat/host_restart.py`、
    `window.py` 的 `restartbtn`、`test/host-info.test.mjs`、`scripts/check-restart.py`
  - 真机（2026-11-27 11:35）：`restart.log` 记「Electron 91168: 成功 / spawn pid=94112」，
    新 Electron 的父进程是窗口 `92276` —— 窗口没被收掉，跨过了整次重启
账：真机两轮重启（11:35 一轮；验收回执还要一轮），离线脚本可反复跑
更新：2026-11-27 10:55 CST

## 为什么这件事值得单开一份

- 痛点原话（格，2026-11-27）：「我其实很烦自己手动重启 dsh」。改完插件必须重启才生效，而重启只能人手做——模型所在的回合跟着进程一起死，**谁都不能重启自己**。
- 所以要有一个**不属于 DSH 进程树**的进程：它活着，才能把 DSH 关掉再拉起来。现有窗正好是 `detached: true` 起的（`src/window.js:495`）——这是这件事唯一一个现成的前提。
- 与上游差距那份无关：那份是「补哪些上游功能」，这份是「它到底是什么东西」。两份并行，互不阻塞。

## 一个顺序问题（10:41 改口）

原先写的是「能重启 DSH 的前提，是它自己能独立起来」，怕鸡生蛋。**这条降级了**：窗平时就开着，DSH 关掉时它还在（`detached`，`src/window.js:495`），所以重启的执行端已经在场——P1 不依赖独立启动。

鸡生蛋只在「连窗也关掉了」时成立，那种情况手动开一次 DSH 就行。独立启动因此进 P2，不再挡 P1。

## 现有零件（已核）

| 零件 | 在哪 | 能不能直接用 |
|---|---|---|
| 窗比 DSH 活得久 | `src/window.js:495` | 能，已满足 |
| 窗自己的对话记录 | `src/chat.js:31` | 能，重启后靠它续 |
| 重启后补投没人回的句子 | `src/index.js:1609` | 能，但要真重启验一次 |
| 重启 DSH 的现成实现 | `dshmarket/lib/restart.js` | **不能照抄**：它 relaunch 的是 `dsh web` 的调用（`dshArgv()`），桌面端是 Electron |
| 宿主启动坐标（exe / argv / cwd） | **没有** → 已补：`src/host-info.js` | 插件每次启动写 `host.json` |
| 本仓的重启能力 | **0 命中** → 已补：`examples/floating-chat/host_restart.py` | 窗口按 pid 杀 + 按坐标 spawn |

## P1：三步

### 1. 宿主留坐标（新 `src/host-info.js`，已落地）

启动时写 `~/.dsh/see-now/host.json`：`{exe, appPid, hostPid, cwd, argv, env(白名单), poison, version, at}`。
**不写密钥**：env 只留 `DSH_HOME` / `DSH_PROFILE` / `DSH_PRIMARY_RUNTIME` 三个键。

为什么必须有：窗要重启 DSH，就得知道它当初是怎么起来的。桌面端的 `process.execPath` /
`process.ppid` 与 `dsh web` 不同，抄不得；不写这份，窗只能猜一条 exe 路径。

### 2. 窗能发起重启（独立启动已降 P2，不挡这一步）

- **落地（2026-11-27 11:5x 改口径）**：不借 outbox —— 它是「窗口 → 插件」，而插件就住在
  要重启的进程里，只能把活转手。改为窗口自己读 `host.json` 的坐标动手，意图写
  `~/.dsh/see-now/restart.json`（窗口写 requested/killing/launched，新宿主收敛成 done）。
  工具契约、outbox 线格式都没动。
- **编排**（`examples/floating-chat/host_restart.py`）：等空闲 → 按 pid 杀 Electron 主进程
  （**不用 `/T`**：窗口自己在这棵树里）→ Host 收 IPC 断开自动退，不退补一刀 →
  Popen 起 exe（剥 `ELECTRON_RUN_AS_NODE`）→ 轮询 host.json 直到新 hostPid 写回（上限 120 秒）→
  失败报原因并**停手**。回来时窗口会亮一下——桌面端没有静默启动，见 P2 的判定。

### 3. 回来之后自核三件，写回窗里（落地：由新宿主写，窗口只报"已拉起"）

- **版本 / 工具注册**：插件在 `ctx.tools.register` 成功之后才写 `host.json`（`src/host-info.js`），
  所以「新 host.json 出现」本身就是"这一版起来了、工具注册过了"的证据；回执里带版本、
  pid 迁移（`111 → 222`）和用时。
- **采集**：如实写「采集未开（要 watch 才起）」—— 默认本来就没在采，写成 ready 是撒谎。
- 回执落一条居中提示进 `chat.jsonl`，`restart.json` 相位变 `done`。窗口不知道新进程加载了
  哪一版，所以它只报"已拉起，等插件写回来"。

## 验收（真机，不靠感觉）

离线部分已完成（2026-11-27）：`node --test` 全绿（含 `test/host-info.test.mjs`），
`python scripts/check-restart.py` 全过（假应用 + 假 Host + detached 假窗口）。

真机第一轮（11:35，`.38` 副本）：点按钮时那一轮还在跑 → 窗口等到回合结束才动手 →
`restart.log` 记「Electron 91168: 成功 / spawn pid=94112」→ 新 Electron 的父进程是窗口 92276。
**重启本身成立**。但窗口 120 秒没等到 `host.json`（`.38` 没这段代码），报了一次 `host-not-back`
—— 那是误报，已改成 `degraded`（见日志 11:43）。

还剩两件（都不是功能）：

1. commit（规则：能跑的小功能先让格确认；她已用真机点过两次）
2. 发版（tag + Release）等她点头；`-more.N` 是预发布，Release 标 prerelease

## 真机第二轮（2026-11-27 11:42，`.39` 已在 profile）

`restart.json` 收敛成 `done`，`elapsedMs=14011`，回执文本：

> 已回到 v0.1.1-more.39（窗发起，宿主 ? → 88436，用时 14 秒） · 工具已注册 · 采集未开（要 watch 才起）

- `host.json` 由新宿主写出：`appPid 94168` / `hostPid 88436` / `cwd ...\profiles\desktop` /
  `version 0.1.1-more.39`；**`oldHostPid` 是 `?`** —— 上一次重启之前还没有这份文件
  （`.38` 不写），从现在起才有「宿主 A → B」的完整迁移。
- 进程树：`94168`（Electron）的父进程是 `87424`，也就是窗口；窗口跨过两次重启没被收掉。
- 回执在 `chat.jsonl` 里的 `sid` 是当前会话，窗里同屏可见。

## P2（降级，不挡 P1）

- **独立启动**：一个 `.lnk` / `.bat` 拉起 `window.py`，不依赖 DSH；连不上宿主时给「DSH 没开，要我拉起来吗」，而不是静默空转。只在「连窗也关掉了、又想不手开 DSH」时才有用。
- **跟着静默启动宿主 —— 判定：不做**（格 2026-11-27 收，11-27 10:55 验完）。桌面端没有静默启动：
  - `lib/main.js:20405` 全文件唯一读命令行开关的地方是 `--updated`，没有 `--hidden` / `--minimized`；
  - `lib/main.js:21515-21521` `enterWorkspace({activate=true})` → `window.show()`，启动路径 `openInitialWindow()` 不传 `activate`，所以窗口必亮；
  - 中文文案（`:13072-13206`）里没有「启动时最小化 / 开机自启 / 托盘设置」这类开关；
  - 备选「起 headless 主机代替」也被 `:13127` 的 `startupAddressInUse` 堵死：桌面端与 `dsh web` **不能同时跑**；
  - 只剩「起了再从外面 `ShowWindow(SW_HIDE)` 藏掉」，要为一次闪窗维护一套跟窗口逻辑漂移的 hack，格 10:55 说「算了」。
  - 结论：从窗拉起 DSH 时，**接受它弹一下**。
- **常驻形态**（托盘 / 热键）：要等独立启动真做了再说；现在判过不搬上游的托盘。

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
- 2026-11-27 10:41 砍掉「独立启动」：交接卡落到全局 `C:\Users\Administrator\.dsh\offline-card.md` 之后，格关 DSH 时不再需要窗里有模型；而窗平时一直开着（detached），重启的执行端已经在场。所以 P1 从三件减到两件，独立启动与常驻形态并入 P2。
- 2026-11-27 10:51 补「跟着静默启动宿主」（格提）：从窗启动时可让 DSH 一起起来但不出主窗、不抢焦点。选项 hostStart: ask|silent|never，默认 ask；同一个姿态也管 P1 重启回来时的样子。桌面端是否支持静默启动**待验**，备选是拉起 headless 主机连它。
- 2026-11-27 10:55 验完并否掉「跟着静默启动」：桌面端无静默启动（唯一 argv 开关是 --updated；启动路径 enterWorkspace 默认 show），headless 备选被 startupAddressInUse 堵死（桌面端与 dsh web 不能同时跑）。剩下的外部隐藏窗口 hack 不值得维护，格说「算了」。从窗拉起 DSH 时接受弹一下。
- 2026-11-27 11:16 HMR 试完，判不可用（详见 `docs/决策记录.md` 同名小节）：不是 combo bundle；`--expose-internals` 已满足；默认 `ignored` 含 `node_modules`，覆盖后重启仍不重载。四处改动已回滚，插件副本与源码一致（`.38`）。这条不改变 P1，反而更说明「重启要自动化」而不是「靠热载绕过」。
- 2026-11-27 11:22 开工 P1（格选 A）。读宿主 `lib/main.js` 得到三条硬事实：①生产构建没有「重启应用与 Host」菜单项（只在 development 里加），②关窗只 hide 到托盘、不退出，③`app.relaunch()` 只对主进程自己可见。所以执行端定为**窗口**，按 `host.json` 的坐标杀 + 拉起。
- 2026-11-27 11:24 砍掉「走 outbox 发起」的原方案：outbox 是「窗口 → 插件」，插件住在要重启的进程里，只能转手；改为窗口直接执行、`restart.json` 记意图与相位。工具契约与 outbox 线格式未动。
- 2026-11-27 11:26 两处安全判定：**杀进程不用 `/T`**（窗口在 Electron 进程树里，`/T` 会把自己一起收掉，重启只做一半）；**spawn 必须剥 `ELECTRON_RUN_AS_NODE`**（本机实测宿主带 `=1`，原样继承会拉起一个 node、没有面板）。
- 2026-11-27 11:27 落地并离线验收：`src/host-info.js`（host.json + 回执收敛）、`host_restart.py`（编排 + CLI `--check`）、`window.py` 设置页「重启 DSH」、`test/host-info.test.mjs`、`scripts/check-restart.py`（含 detached 假窗口必须活下来）。`node --test` 全绿。
- 2026-11-27 11:35:52 真机第一轮（`.38` 副本，坐标走窗口标题兜底）：点按钮时那一轮还在跑 → 等到 11:35:25 回合结束才动手 → 杀掉 91168、spawn 94112；**新 Electron 的父进程是窗口 92276**，窗口没被收掉。但窗口等了 120 秒没等到 `host.json`（`.38` 没这段代码），11:37:53 误报 `host-not-back`。
- 2026-11-27 11:37:37 `install-dev` 把 `.39` 装进 profile（包外备份 `2026-11-27T03-37-37-510Z`）；正在跑的宿主仍是旧代码，回执要等下一次重启。
- 2026-11-27 11:43 修误报 + 改等待口径：进程起来了但写不出自核记录时报告 `degraded`（相位 `launched-legacy`），不再判失败；等空闲**不设上限**（`wait_idle_sec=None`，新相位 `waiting-idle`），要掐断当前回合用 `--force`。原因是「回合内点按钮、又在本回合等结果」是自锁——格 11:34 点出来的。
- 2026-11-27 11:46 重开窗（`87424`）加载最终 `window.py`；离线脚本复跑全过（含排队、旧版 degraded 两条）。
- 2026-11-27 11:42:16 真机第二轮（`.39` 已在 profile）：11:41:43 点按钮、11:41:43 杀旧、11:41:57 新宿主写回 `host.json`（`hostPid 88436`），`restart.json` 收敛 `done`、`elapsedMs 14011`，回执进 `chat.jsonl`。新 Electron `94168` 的父进程仍是窗口 `87424` —— **窗口跨过两次重启**。旧宿主 pid 记成 `?`：升级前没有 `host.json`，下一次起才是完整的「A → B」。
