# 黑听抬头 P2-A：留底环形缓冲 + 取帧

> 2026-11-10 20:5x 写。上一棒 `session-208f8ef7`（代码 `fe3a38f`）。
> 工作区：`C:\Users\Administrator\Documents\deepseek-harness\see-now-more`（**运行态就是这一仓**）。
> 机制全文：`see-now/docs/tasks/see-now-listen-lift.md`（另一仓，只读参考）。

## 状态

- **2026-11-10 20:5x 建档，未动代码。**
- 已有：触发层 + 警觉池 + 仅监听接线（`fe3a38f`，8 个文件，`node --test` 全绿）。
- 已验到：强命中端到端（TTS「你看这个」→ 3 秒后唤醒，文案带时间码与摘要）；弱命中不叫醒。
- 未验：`lift.enabled:false`（要重启）、30 秒同句去重端到端、`holdSec` / `look` / `chase` / `lift.jsonl`。
- **命名**：上一棒把「触发层」叫 P0、「接线」叫 P1；机制文档里 P1 是环形缓冲、P2 是四档闭环。
  本任务书按机制文档的叫法，**这一棒只做环形缓冲**，四档闭环（`see-now-lift-p2-levels.md`，未写）留给下一棒。

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

## 验收（缺一不算完）

1. `listen` 后 `status` 出现「留底中：N 帧 / ≈M MB」，N 与 0.5 fps × 30 秒对得上（≈15 帧）。
2. 念/放一句「你看这个」后，能按 `t0` 取回前后 1 秒的帧；帧时间戳与台词偏差 **≤1 秒**。
3. 30 分钟黑听：内存峰值、CPU 占用有实测数字（写进本文件「状态」）。
4. `see-now.json` 写 `"lift": {"enabled": false}` 并重启后：不留底、`status` 不显示留底、行为与现在一致。
5. 退出仅监听 / `stop` 后：缓冲清空、采集进程收干净（`listen.pid` 那条路照旧）。
6. `node --test` 全绿（现有 86 条一条不许挂）。

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

## 不做（这一棒）

- 四档动作（`glance` 取 1 帧不叫醒 / `look` 叫醒 / `chase`）、`lift.jsonl`、`holdSec` 回落、
  `status` 的今日计数——下一棒，见机制文档「分阶段 P2」。
- 不改悬浮窗外观、不改 README（隐私那句等四档闭环一起写，那时才有「留底中」可写）。
- 不碰 `see-now` 仓（那份 fork 只作为参考实现和测试来源）。
