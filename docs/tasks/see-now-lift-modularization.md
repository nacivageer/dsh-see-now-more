# 黑听抬头内部模块化：把编排从 `startLoop` 闭包抽成 `createLift(ports)`

状态：进行中（任务书已建档，尚未开工）
对象：把黑听抬头的判档/取帧/唤醒编排从 `src/loop.js` 的 `startLoop` 闭包里抽成 `src/lift/index.js` 的 `createLift(ports)`；行为不变、测试可脱离 DSH / ffmpeg / Python / 窗口运行。不拆包、不上架。
归属：session-3ed91486-446a-4e93-b76f-0dc42846bc78 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：新会话在 `see-now-more` 打开后，先读本文件和 `docs/决策记录.md`；从第 0 步开始，只做只读与基线，不改代码。
证据：
  - `node --test`：135 个通过 / 0 失败（2026-11-12，HEAD `56cedd9`）
  - 已拆模块：`src/lift-buffer.js`、`lift-levels.js`、`lift-log.js`、`lift-pool.js`、`lift-triggers.js`
  - 未拆编排：`src/loop.js` 的 `maybeWakeFromLift` / `maybeFallBackFromLift` / `liftDialogActive` 及其闭包状态
更新：2026-11-12 21:20 CST

## 日志

- 2026-11-12 21:20 建档；基线 135/135；对象、端口、步骤、验收、风险定稿。

## 为什么做

黑听抬头的纯逻辑已经拆得差不多，但**编排**还长在 `startLoop` 的闭包里：

- `maybeWakeFromLift()`：扫台词 → 进池 → 判档 → 取帧 → 记账 → 叫醒；
- `maybeFallBackFromLift()`：`holdSec` 到点且画面不动 → 回落；
- `liftDialogActive()`：最近 5 分钟有没有活跃对话；
- 一串闭包状态：`lastLiftScanAt`、`liftPushedT0`、`liftSeen`、`lastLiftVoiceAt`、`liftAlarmTimes`、`liftLevelNow`、`liftHoldFrom`。

结果是：这段逻辑只能通过启动整个 `startLoop` 才能跑到，没法在“没有 DSH、没有窗口、没有 ffmpeg”的环境里单独测；以后若要做 headless 版本或让第二个消费者复用，也只能整段搬。

这次只做**内部模块化**：把编排抽成一个带端口的模块，让 `startLoop` 变成“时钟 + 接线”。不新增包、不改行为、不上架。

## 现状

已经拆出来的（不要重做）：

| 文件 | 职责 | 测试 |
|---|---|---|
| `src/lift-buffer.js` | 0.5 fps 环形缓冲、`frameAt(t0)`、`changedFraction` | `test/lift-buffer.test.mjs` |
| `src/lift-levels.js` | `decideLevel` / `shouldFallback` 纯函数 | `test/lift-levels.test.mjs` |
| `src/lift-log.js` | `lift.jsonl`、每日帧目录、`todayCounts`、`pruneOld` | `test/lift-log.test.mjs` |
| `src/lift-pool.js` | 十分钟台词池、`summary()` | `test/lift-pool.test.mjs` |
| `src/lift-triggers.js` | 强/弱命中词表与去重 | `test/lift-triggers.test.mjs` |
| `src/runner.js` | 采集生命周期、`frameAt` / `framePng` / `recentLines` / `still` | `test/runner-lift.test.mjs`（假采集） |

还没拆的：

- `src/loop.js`：`startLoop` 里的编排 + 状态；`HANGUP_NOTE` 和窗口判定也在这一层，**这次不动**。
- `src/index.js`：`liftLine` / `liftGearLine` 文案、`action:"lift"`、`status` 里的档位行；这次只搬文案格式化，不改工具契约。

## 目标形态

```
src/lift/
  index.js      // createLift(ports)：tick() / frameAt() / status() / reset()
  status.js     // liftLine / liftGearLine 纯格式化（从 index.js 搬）
  （可选，最后一步）buffer.js / levels.js / log.js / pool.js / triggers.js
```

`createLift` 的端口：

```js
createLift({
  config,                    // tuning.lift：{ enabled, level, holdSec, ... }
  now,                       // () => epoch ms；测试用假时钟
  senses: {
    recentLines(from, to),   // 定稿台词 [{ t0, t1, text, partial }]
    frameAt(t0),             // { ok, frame, deltaMs } | { ok:false, reason }
    framePng(t0),            // { ok, path, at, deltaMs, size } | { ok:false, reason }
    still(),                 // runner.still() 的返回值；判不了就 null
    turnEndAt(),             // 模型上一回合结束时刻；取不到 0
    lastUserSpokeAt(),       // 用户最后一次真的说话；没有 0
  },
  sinks: {
    record(rec),             // appendLift(rec)
    debug(text),             // appendLiftDebug(text)
    glance(text, meta),      // appendSpoken('meta', text, { speak:false })
    wake(text, { t0 }),      // 现有 wake()；返回 ok
    hint(),                  // lastSaidHint() 返回的尾注
  },
  gate: {
    canWake(now),            // 和 maybeWakeFromAudio 共用的退避线
    noteWake(now),           // 记一次叫醒
    noteNoAnswer(),          // 叫醒失败/没人理
  },
})
```

返回：

```js
{
  tick(),        // 每拍调用：扫描、进池、判档、按档做事、回落
  frameAt(t0),   // 供 see_now({action:"lift"}) 用；内部转 sense.frameAt
  status(),      // { enabled, level, alarms, glances, looks, ... } 供状态行
  reset(),       // stopLoop / 重新 startLoop 时清状态
}
```

## 关键约束

1. **退避线必须由 `startLoop` 持有，通过 `gate` 注入。** `lastAudioWakeAt` / `unansweredListenWakes` 是 lift 和 `maybeWakeFromAudio` 共用的；各开一条同一拍会连叫两次。`createLift` 不拥有这两个变量。
2. **窗口是 sink，不是依赖。** `appendSpoken('meta', …)`、`lastSaidHint()` 都走端口；`src/lift/**` 不 import `window.js`、`client.js`、`index.js`、`loop.js`。
3. **`lift.jsonl` 走 store 端口。** 默认实现包 `lift-log.js`；测试用内存 store，不写 `DSH_HOME`。
4. **状态归属**：`liftPool`、`liftSeen`、`liftPushedT0`、`liftAlarmTimes`、`lastLiftScanAt`、`lastLiftVoiceAt`、`liftLevelNow`、`liftHoldFrom` 都搬进 `createLift`；`lastUserSpokeAt` 和 `turnEndAt` 由 `startLoop` 提供。
5. **行为不变**：阈值、档位、文案、`lift.jsonl` 字段、日志行、`see_now` 工具返回结构都不改。第一版只搬，不顺手优化。

## 步骤

### 第 0 步：只读 + 基线（不改代码）

1. 读本文件、`docs/决策记录.md`、`docs/tasks/see-now-lift-p2-buffer.md`、`docs/tasks/see-now-lift-p2-levels.md`。
2. 跑 `node --test`，记录 135/135 和 HEAD。
3. 用 `git grep -n "maybeWakeFromLift\|maybeFallBackFromLift\|liftDialogActive\|HANGUP_NOTE"` 标出当前行号（行号会漂，以函数名为锚）。
4. 把“准备怎么搬、3 条验收、预计改哪些文件”发给格确认；**确认前不动代码**。

验收：基线测试输出 + 文件清单 + 计划。

### 第 1 步：建 `src/lift/index.js`，逐字搬编排

1. 新建 `createLift`，把 `maybeWakeFromLift` / `maybeFallBackFromLift` / `liftDialogActive` 和状态搬进去。
2. `startLoop` 每拍改调 `lift.tick()`；`wake`、`record`、`glance`、`debug`、`gate`、`senses` 都从闭包传进去。
3. 逻辑不改：判档仍调 `decideLevel`，触发仍调 `matchLiftTriggers`，池仍用 `createLiftPool`。
4. `stopLoop` / 重新 `startLoop` 时调 `lift.reset()`。

验收：`node --test` 135/135；`see_now({action:"listen"})` 能进仅监听、`lift.jsonl` 行数/字段与改造前同形；没有双唤醒。

### 第 2 步：写时间线测试（characterization test）

新建 `test/lift-timeline.test.mjs`，用假 `senses` / `sinks` / `gate` / 假时钟，按事件表驱动：

- 弱命中 + 无对话 → `alarm`：record 一行，`framePng` 不调，`wake` 不调；
- 强命中 + 无对话 → `glance`：`framePng` 调一次，`glance` 调一次，`wake` 不调；
- 强命中 + 有对话 → `look`：`wake` 一次，record `spoke:true`，档位变 `look`；
- 5 分钟内 3 次警觉 → 第 4 次升 `glance`（`trigger:"pool"`）；
- `holdSec` 到点 + `still()` 静 → 回落 `alarm`（`trigger:"hold"`），档位清空；
- 同一 `t0` 重复扫描 → 只记一次；
- `gate.canWake=false` → 不叫醒，不增 `unanswered`；
- `framePng` 失败 → record 带 `reason`，不拿当前帧顶；
- `enabled:false` → `tick()` 什么都不做。

验收：`node --test test/lift-timeline.test.mjs` 全绿；**不设 `DSH_HOME`、不需要 ffmpeg / python / 窗口**。

### 第 3 步：搬状态文案与工具适配

1. `liftLine` / `liftGearLine` 搬到 `src/lift/status.js`；`index.js` 只调用。
2. `action:"lift"` 改走 `lift.frameAt()`；返回结构不变。
3. `status` 里的档位行改读 `lift.status()`；文字逐字不变。

验收：`see_now({action:"status"})` 的输出与改造前逐字对比（除时间/计数外）；`see_now({action:"lift", since})` 仍返回同一结构。

### 第 4 步：加静态边界测试

新建 `test/lift-seam.test.mjs`：读 `src/lift/**`，断言没有从 `../loop.js`、`../index.js`、`../runner.js`、`../window.js`、`../client.js` import；没有 `node:child_process`；没有直接读 `DSH_HOME`（默认 store 除外）。

验收：测试通过；故意加一条反向 import 能让它失败（手工验一次，不留代码）。

### 第 5 步：可选目录整理

把 `lift-*.js` `git mv` 到 `src/lift/`（`buffer.js` / `levels.js` / `log.js` / `pool.js` / `triggers.js`），更新 import；**单独一个 commit**，不混逻辑改动。

验收：135 + 新测试全绿；`git show --stat` 只有重命名和 import 行。

### 第 6 步：运行时冒烟

1. `node scripts/install-dev.mjs --check`（或安装到 dev 副本）。
2. `see_now({action:"listen"})` → 等一拍 → `see_now({action:"status"})` → `see_now({action:"stop"})`。
3. 检查 `~/.dsh/see-now/lift/debug.log`：心跳、`lift-scan` 行还在；无新的 `lift-wake` 失败。
4. 如果格在场，跑一次真实“你看这个”的强命中，确认 `lift.jsonl` 的 `level` / `frameAt` / `spoke` 与改造前同形。

验收：无新错误；`status` 字段齐全；`lift.jsonl` 字段不变。

## 总验收

- `node --test` 135/135 + 新增时间线/边界测试全绿。
- `node --test test/lift-*.test.mjs` 在**不设 `DSH_HOME`**、没有 ffmpeg / python / 窗口的环境里能跑。
- `src/lift/**` 不 import `loop.js` / `index.js` / `runner.js` / `window.js` / `client.js`。
- `startLoop` 的 lift 段只剩 `lift.tick()` + 端口接线；`index.js` 只剩文案格式化与工具适配。
- `see_now` 的 `status` / `listen` / `stop` / `lift` 返回文字和结构不变。
- 没有双唤醒：lift 与 `maybeWakeFromAudio` 仍共用同一条退避线。

## 风险与边界情况

- **共享退避线**：最容易错。`gate` 必须由 `startLoop` 拥有；`createLift` 只问 `canWake`。
- **状态生命周期**：`stopLoop` 后重新 `startLoop` 必须 `reset()`，否则上一场的 `liftSeen` / 池 / 档位会串。
- **`liftTurnEndAt`**：现在走 `getTargetSession` / `lastTurnEndAt`，可能抛；注入后适配器仍要 `try/catch` 返回 0。
- **窗口 sink 抛错**：`appendSpoken` 在窗不在时可能抛；适配器保留现有 `try/catch`，模块不处理窗口。
- **`framePng` 落盘**：模块只拿 `{ok,path,at,deltaMs}`；路径、清理、3 天保留仍归 `runner` / `lift-log`。
- **`still()` 判不了**：返回 null 时按“判不了”处理，不能当“静”；`shouldFallback` 已有这个语义。
- **`holdSec=0`**：允许立即回落；不要改成“至少 1 秒”。
- **`enabled:false`**：`tick()` 直接 return；`status` 不显示留底行，和现在一致。
- **`t0` 单位**：epoch ms；`frameAt` / `framePng` 的容差 1.5 秒不要改。

## 不做

- 不拆成独立包 / 独立插件；不发 npm；不提插件市场 PR。
- 不改 `runner.js` 的采集路径、不改窗口 UI、不改 `see_now` 工具契约。
- 不改阈值、文案、`lift.jsonl` 字段；不顺手修旧状态文案（`ffmpeg 退出` / `显示中` / `stop` 回执），那些另开任务。
- 不先 `git mv` 再改逻辑；目录整理放最后。

## 参考

- `src/loop.js`：`startLoop`、`maybeWakeFromLift`、`maybeFallBackFromLift`、`liftDialogActive`、`HANGUP_NOTE`
- `src/index.js`：`liftLine`、`liftGearLine`、`action === 'lift'`、`action === 'stop'`、`status`
- `src/runner.js`：`createRunner`（`frameAt` / `framePng` / `recentLines` / `still` / `stop`）
- `src/lift-buffer.js`、`lift-levels.js`、`lift-log.js`、`lift-pool.js`、`lift-triggers.js`
- `test/lift-*.test.mjs`、`test/runner-lift.test.mjs`
- `docs/决策记录.md`（单仓理由、第二个消费者才抽包）
- `docs/tasks/see-now-lift-p2-buffer.md`、`docs/tasks/see-now-lift-p2-levels.md`
- `CHANGELOG.md` `0.1.1-more.7`（四档闭环的现状）

## 给新会话的第一句话

> 先读 `docs/tasks/see-now-lift-modularization.md`，只做第 0 步：跑基线、标行号、把计划和 3 条验收发给格确认；确认前不改代码。这次是内部重构，不拆包、不上架、不改行为。
