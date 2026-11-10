# 黑听抬头 P2-A：留底环形缓冲 + 取帧

> 2026-11-10 20:5x 写。上一棒 `session-208f8ef7`（代码 `fe3a38f`）。
> 工作区：`C:\Users\Administrator\Documents\deepseek-harness\see-now-more`（**运行态就是这一仓**）。
> 机制全文：`see-now/docs/tasks/see-now-listen-lift.md`（另一仓，只读参考）。

## 状态

- **2026-11-10 20:5x 建档，未动代码。**
- 已有：触发层 + 警觉池 + 仅监听接线（`fe3a38f`，8 个文件，`node --test` 全绿）。
- 已验到：强命中端到端（TTS「你看这个」→ 3 秒后唤醒，文案带时间码与摘要）；弱命中不叫醒。
- 未验：`lift.enabled:false`（要重启）、30 秒同句去重端到端、`holdSec` / `look` / `chase` / `lift.jsonl`。
- **2026-11-10 21:2x P2-A 代码完成（未提交，等确认）**：见下「改了什么」；`node --test` 全绿；
  运行态未验（要 `install-dev` + 重启 Desktop，这步由格做）。
- **2026-11-10 22:3x 运行态验收 6/6 全过**（数字见「实测」）。#4 用 `"lift":{"enabled":false}`
  单独重启验过一次，验完已把配置改回默认（开）。运行态的取证落点：插件日志在打包后的 Desktop 里
  看不见，所以强命中时额外写一行到 `~/.dsh/see-now/lift.log`（`src/lift-log.js`，**P2-B 接
  `lift.jsonl` 时删掉**）。
- **命名**：上一棒把「触发层」叫 P0、「接线」叫 P1；机制文档里 P1 是环形缓冲、P2 是四档闭环。
  本任务书按机制文档的叫法，**这一棒只做环形缓冲**，四档闭环（`see-now-lift-p2-levels.md`，未写）留给下一棒。

## 改了什么（P2-A）

- `src/lift-buffer.js`（新）：环形缓冲。窗口淘汰 / 按 `t0` 二分取帧（返回真实 `deltaMs`，失败分
  `empty` / `too-old` / `too-new` / `far`）/ 内存硬上限 / `stale`（最后一帧太久以前）。纯内存，
  无 fs、无定时器、不编码。
- `src/runner.js`：仅监听时起留底那一路（`listenOnly()`）；`start()` 看画面时停掉并清空；
  `teardown()` 收工清空；`status().lift` 账本；`frameAt(t0)`；采集自己退出/失败时 3/6/9 秒重试 3 次。
- `src/index.js`：`status` 与 `listen` 的文案带「留底中：N 帧 / ≈M MB」；进仅监听时按上次的
  region 抓（瞥到的和看到的是同一块）。
- `src/loop.js`：强命中时打一行 `[lift] 台词 t0 → 帧 偏差 Xms`（**只记日志，不取帧、不改行为**）
  —— 验收 #2 在运行态的唯一证据，接上四档后可以删。
- `src/capture.js`：`spawnFrames` 返回值加 `pid`（测 CPU、核对「进程收干净」）。
- `scripts/lift-buffer-probe.mjs`（新）：实测脚本。`--minutes 30` 就是长跑，`--region x,y,w,h`
  验框选那条路。

## 为什么先做这个

现在的接线是**简化口径**：强命中直接叫醒（= 机制里的「看」）。机制文档拍板的默认档是**「瞥」**——
取 1 帧、不叫醒、窗里落一行轻记录。没有环形缓冲，「瞥」就取不到「那句话那一刻」的画面，
只能拿当前帧冒充（机制文档明令禁止）。所以四档闭环的前置是缓冲，不是反过来。

## 目标（这一棒）

黑听（仅监听）时，后台以 **0.5 fps** 采一路画面，只留**最近 30 秒**的缩略帧（长边 ≤800）在内存里；
不拼图、不进上下文、不落盘、不花 token。触发时能按台词时间戳 `t0` 回取那一刻的帧。

验收以机制文档 #1/#2 为准，外加内存与 CPU 的实测数字。

## 约束

- **方案 A 已拍板**（2026-11-10）：黑听时屏幕仍在被低帧率采集。这是明示的代价。
- `lift.enabled:false` 必须能一键停掉留底；`status` 要显示「留底中：N 帧 / ≈M MB」，不能只写「在听」。
- 池子 10 分钟、缓冲只有 30 秒：**升档前必须判「那句话还在缓冲里吗」**，不在就只报文字 + 说明
  「那一刻的画面没了」，**不许拿当前帧冒充**（机制文档「风险」第一条）。
- 不碰悬浮窗外观、不改绑定语义、不把缓冲落盘。
- 采集不能与 `listen.py` 抢设备/抢 ffmpeg 到互相拖垮；实测不过就降帧率或缩窗。

## 已核实的接点

| 位置 | 现状 |
|---|---|
| `src/runner.js:406` `start()` | 现有采集入口；`pipeline` 的 `constants.fps` 在 `runner.js:473` |
| `src/runner.js:562` `listenOnly()` | 进仅监听走的这条路；目前只起耳朵，不起画面 |
| `src/runner.js` `trajectory` / `recentLines` | 只读出口的写法可以照抄 |
| `src/loop.js` `maybeWakeFromLift()` | 触发点在这；取帧要在它命中之后 |
| `src/index.js:528` | `tuning` 启动时读一次——`lift.*` 改动要重启 Desktop 才生效 |
| `src/tuning.js` `LIFT_DEFAULTS` | `enabled / level / holdSec` 已有，**不要加新字段**，除非先记进机制文档 |

## 待你拍板（开工前 5 分钟）

1. **取帧接口**：开 `see_now({action:"lift", since})` 新 action，还是先只做内部函数、
   等四档闭环再暴露？我倾向先内部（可单测、可脚本验），action 留给四档那一棒。
2. **帧存哪**：Node 侧环形数组（`Buffer` × 15 帧 ≈ 16 MB）还是让 ffmpeg 吐 JPEG 到内存。
   倾向 Node 侧数组，好算内存、好按时间戳二分。
3. **与 pipeline 的关系**：复用 `pipeline` 的低帧率采集，还是另起一路只吐帧不拼图？
   倾向另起一路（`pipeline` 的职责是出图，把它拆开风险更大）。

**拍板结果（2026-11-10 21:0x，三条都按倾向）**：① 只做内部函数 `runner.frameAt(t0)`，
不开新 action；② Node 侧环形数组存裸 RGB；③ 另起一路采集，不碰 `pipeline`。

**采集口径有一处偏离，是实测逼出来的（2026-11-10 21:2x）**：本任务「目标」写的是
「后台以 0.5 fps 采一路」，但 ffmpeg 6.0 上两种引擎的 0.5 fps 都不可靠：

| 引擎 | 0.5 fps | 2 fps |
|---|---|---|
| gdigrab + region | **13 秒一帧不出，然后突发几十帧** | 0.50s 稳定 |
| gdigrab 整屏 | 2.00s（可用，但上面的 region 变体说明低帧率不可信） | 0.50s 稳定 |
| ddagrab | 静态屏 12 秒只给 1–2 帧（DDA 是变更驱动） | 1.7 fps |

所以改成**采集侧 2 fps + Node 侧每 4 帧留 1 帧**：留底结果仍是 0.5 fps / ≈15 帧 / 30 秒。
**不做这个抽稀的话，静止屏幕 30 秒后 `pickAt` 会报「too-new」**——把「那一刻的画面还在」
误判成「没了」，正好踩中机制文档「风险」第一条。代价是采集多抓 4 倍帧：实测整屏
gdigrab 2 fps ≈ 0.1 核（见「实测」）。

## 验收（缺一不算完）

1. `listen` 后 `status` 出现「留底中：N 帧 / ≈M MB」，N 与 0.5 fps × 30 秒对得上（≈15 帧）。
2. 念/放一句「你看这个」后，能按 `t0` 取回前后 1 秒的帧；帧时间戳与台词偏差 **≤1 秒**。
3. 30 分钟黑听：内存峰值、CPU 占用有实测数字（写进本文件「实测」）。
4. `see-now.json` 写 `"lift": {"enabled": false}` 并重启后：不留底、`status` 不显示留底、行为与现在一致。
5. 退出仅监听 / `stop` 后：缓冲清空、采集进程收干净（`listen.pid` 那条路照旧）。
6. `node --test` 全绿（现有 86 条一条不许挂）。

**当前状态**：

| # | 状态 |
|---|---|
| 1 | **已验（运行态）**：`listen` 后 35 秒 → `status` 显示「留底中：16 帧 / ≈16.5 MB」 |
| 2 | **已验（运行态）**：TTS「你看这个，这个转场挺有意思的」→ `lift.log` 记 `delta=-453ms` |
| 3 | 离线长跑：0.15 核 / 15.4 MB（口径见「实测」；运行态的 ASR 占用不在这个数里） |
| 4 | **已验（运行态）**：写 `"lift":{"enabled":false}` + 重启 → `status` 没有「留底」行、`listen` 回复也没有；`listen` 后**没有 ffmpeg**、`listen.py` 照旧在跑（耳朵不受影响）。验完配置已改回默认开 |
| 5 | **已验（运行态）**：`stop` 后没有 ffmpeg / 没有 listen.py；再 `listen` 时从「0 帧」开始（证明清空了） |
| 6 | 绿（含新增用例） |

## 重启后要验的三条（给格）

装完 `node scripts/install-dev.mjs` 并重启 Desktop 之后：

1. **留底行**：调 `see_now({action:"listen"})`，等 30 秒，再 `see_now({action:"status"})` ——
   「留底中：15 帧 / ≈15.4 MB」。0 帧或帧数不动 = 采集没起，看同一行后面的错误。
2. **按 t0 取帧**：黑听时用 TTS 念一句完整的触发句（ASR 会丢很短的话，**要造完整句**），
   看日志里 `[lift] 台词 t0 → 帧 偏差 -xxx ms` —— 偏差 ≤1000 就是过了。
3. **一键关**：`~/.dsh/see-now.json` 写 `"lift": {"enabled": false}` + 重启 → `status` 里
   **一行留底都没有**（`meta.lift.enabled` 是 `false`）、进仅监听后也不起 ffmpeg
   （任务管理器里只有一个 ffmpeg = 没有第二个）。

## 环境与坑

- node 不在 PATH：`H:\DSH\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- 在仓根跑 `node --test`（**不要带 `test` 目录**，Node 20+ 会把目录当文件）。
- 改完要 `node scripts/install-dev.mjs` + **重启 Desktop** 才进运行态；副本在
  `~/.dsh/profiles/desktop/node_modules/dsh-see-now-more`，`--check` 会比对哈希。
- 运行态验证这轮用的办法（有效）：系统 TTS 念一句 → WASAPI 回环 → ASR 定稿 → 触发。
  TTS 用 `Microsoft Huihui Desktop`（zh-CN）。**ASR 会丢很短的话**：「诶诶诶」没落定稿，
  「真的吗？」落了。要造触发句就造完整句。
- 读 `~/.dsh/see-now.json` 前先备份；`mode` 会被 `listen` 改写成 `both`，测完记得改回。
- PowerShell 5.1 的 `Get-Content` 读 UTF-8 中文会乱码，读文件用 read 工具。
- 唤醒文案末尾会拼 `lastSaidHint()`（「你上一句说的是…」），这是设计，别当 bug 改。
- **量采集帧率时别把 ffmpeg 输出到文件、再 `Stop-Process` 那个 `cmd.exe` 外壳**：2026-11-10 踩过，
  只杀了外壳，ffmpeg 继续以 32 MB/s 写 `%TEMP%\*.raw`，十几分钟把 C 盘写到只剩 1 MB。
  一律用 `-t` / `-frames:v` 让 ffmpeg 自己停，输出到 `NUL`；真要中途杀就按 ffmpeg 的 pid 杀。
- **改 `see-now.json` 别用 PowerShell 的 `Set-Content -Encoding UTF8`**：5.1 会写 BOM，而
  `readTuning()` 是 `JSON.parse` 整份文件 —— 带 BOM 直接抛，**整份配置静默退回默认**
  （`maxAutonomousWakes` 24→8 这种，用户看不出来）。2026-11-10 实测踩到，已从备份恢复。
  要改就先用 node 读-改-写，或写无 BOM（`[IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding($false)))`）。
- **插件日志在打包后的 Desktop 里看不见**（`ctx.logger.info` 只进 Electron 主进程控制台）。
  运行态取证要么写文件（`src/lift-log.js` 这一行），要么用工具输出本身。

## 实测

口径：`node scripts/lift-buffer-probe.mjs --minutes 30`，`runner.listenOnly({audio:false})` ——
**只量留底这一路**。听声音/ASR 那部分不在里面（这棒没动它），所以下面就是 P2-A 新加的代价。

| 项 | 30 分钟长跑（整屏 800×450） |
|---|---|
| 帧数 / 窗口 | 15–17 帧 · span 28–30 秒（目标 ≈15） |
| 缓冲内存 | 15.4 MB（峰值 17.5 MB，单帧 1.03 MB） |
| 进程 RSS | 峰值 124.3 MB；稳定后在 63–124 MB 之间来回（GC 锯齿，**没有持续增长**） |
| ffmpeg CPU | **0.15 核**（2 fps 采集那一路，1771 秒采样） |
| 按 t0 取帧 | t0 = 10 秒前 → 偏差 −251 ms（≤1 秒 ✓） |
| stop 后 | 缓冲 0 帧 ✓ · ffmpeg 进程已退出 ✓ |

另外两次短跑（同一份代码）：

| 场景 | 帧数 | 缓冲内存 | 取帧偏差 |
|---|---|---|---|
| 整屏 2 分钟 | 15 帧 / span 28s | 15.4 MB | 513 ms |
| region 360×640（实抓 450×800）32 秒 | 13 帧 / span 24s | 13.4 MB | 347 ms |

**运行态一次真实触发**（2026-11-10 22:22，Desktop 里 TTS → 回环 → ASR）：

```
[lift] 台词 t0 → 帧 偏差 -453ms  t0=1794320558311 frameAt=1794320557858 delta=-453
```

那句台词 `t0` 与取到的帧差 **453 ms**，在 1 秒验收线内；同一次 `status` 是「留底中：16 帧 / ≈16.5 MB」。

## 日志

- 2026-11-10 21:0x 建档 → 三条拍板（都按倾向）→ 21:2x 代码 + 单测完成。
- 2026-11-10 21:2x 实测发现 0.5 fps 抓屏在 gdigrab(region) / ddagrab 上都不可靠 →
  改成「2 fps 采集 + 每 4 帧留 1 帧」（见「待你拍板」后面的偏离说明）。
- 2026-11-10 22:0x 30 分钟长跑完成，数字见「实测」。**全部改动未提交**，等格确认后 commit；
  运行态等 `install-dev` + 重启 Desktop。
- 2026-11-10 22:2x 运行态验收：#1 16 帧 / 16.5 MB、#2 偏差 −453ms、#5 收工无残留进程，全过；
  顺带修了两处：`listen` 回复读了启动结果导致误报「没在采」、强命中的偏差行没有可读落点。
- 2026-11-10 22:3x #4 也验过（`enabled:false` → 无留底行、无 ffmpeg、耳朵照旧），配置已改回默认。
  **P2-A 验收 6/6 完成**，可以提交。

## 不做（这一棒）

- 四档动作（`glance` 取 1 帧不叫醒 / `look` 叫醒 / `chase`）、`lift.jsonl`、`holdSec` 回落、
  `status` 的今日计数——下一棒，见机制文档「分阶段 P2」。
- 不改悬浮窗外观、不改 README（隐私那句等四档闭环一起写，那时才有「留底中」可写）。
- 不碰 `see-now` 仓（那份 fork 只作为参考实现和测试来源）。
