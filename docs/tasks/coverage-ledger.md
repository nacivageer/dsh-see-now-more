# 覆盖率账：按分钟落盘（交接文）

状态：等你开工
对象：把「**出字秒数 / 送审语音秒数**」这本账从内存（最近 10 分钟）落成按分钟的
     `coverage.jsonl`，让一局/一天的复盘能回答「漏抬那一刻到底听没听见」。
归属：session-9f3ff405（2026-11-17 存档）；代码仓 `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：① 落盘；② `scripts/coverage.mjs --ledger` 读它；③ 与 `lift.jsonl` 对齐算漏抬/误抬。
证据：
  - `src/coverage.js` `coverageOf()` + 15 项单测；全量 **256 项通过**
  - 实测：`覆盖 53%（语音 15s / 出字 8s），像说话没字 1 段`（2026-11-17 03:50）
  - 代码提交：see-now-more `383d6dc`
更新：2026-11-17 03:55 CST

## 现状（接手前必读）

链路已经是通的，**只差落盘**：

- `listen.js` 每处理完一段音频就往 `covEntries` push 一条
  `{at, sentSec, speechSec, gotText}`（最多留 2000 条）。
- `state().coverage = coverageOf(covEntries, { now })` → `describeCoverage()` → status 那行。
- 主口径：**ratio = 出字段的 speechSec 之和 / 所有段的 speechSec 之和**；
  `emptySegs` = 语音 ≥1.2s 却一个字没出的段数；没人说话时 `ratio = null`（status 不显示，不编 0%）。

实测那一段（放两段测试音频）：语音 15s、出字 8s、覆盖 53%、像说话没字 1 段。

## 为什么分母用 `speechSec` 而不是段长

段长 = 文件长度，含静音尾巴（Python 按 0.6s 静音切）；`speechSec` 是转写器 VAD 回传的
**语音秒数**。用段长当分母会把静音尾巴算成「本该有字」，覆盖率被系统性压低。

## 做法（建议顺序）

1. **落盘**：在 `covEntries.push(...)` 那处顺手累计到一分钟一格，写
   `~/.dsh/see-now/coverage/<YYYY-MM-DD>.jsonl`，每行
   `{minute:"HH:MM", sentSec, speechSec, textSec, emptySegs}`；
   用「写 .tmp 再 rename」或按行 append（`appendFileSync`，单行不超过 4KB 时是原子的）。
   **按天分文件**，别写成一个越来越大的文件。
2. **读它**：`scripts/coverage.mjs` 加 `--ledger [--minutes N]`，输出今天的账（每 5 分钟一段 + 全天合计）。
3. **与抬升事件对齐**：`~/.dsh/see-now/lift/lift.jsonl` 有每次抬升；
   同一分钟内「有字却没抬」= 漏抬候选，「抬了但那分钟没台词」= 误抬候选。
   这才是那三个数（漏抬 / 误抬 / 总次数）第一次能算出来。

## 坑（已经踩过的）

- **别用声学指纹判「人声」**：BGM + 对话的混合音频里，真对话帧的中频占比均值只有
  0.27–0.44，低于 0.6 的门槛，会被判成「有声」，覆盖率算成个位数（实测 9%）。
  声学那版已降级成诊断（`computeCoverage()`），**别拿它当覆盖率报给人看**。
- **中频判类必须先平滑**：acoustic.json 是 ~50ms 一格，逐帧在阈值上下跳，
  不平滑会把 15 秒人声切成几十个 0.1 秒碎片。
- **status 不显示覆盖率时先分两种情况**：没人说话（正常，ratio=null）还是
  `speechSec` 没回传（转写器没给这个字段）—— 后者要查服务端。
- CLI 取日期要用**本地**日期（`toLocaleDateString('sv-SE')`），`toISOString()` 在北京时间
  凌晨会给出「昨天」，读不到当天的 transcript（已修，别再写回去）。
- 插件的 profile 是**拷贝**：改完必须 `node scripts/install-dev.mjs` + 重启 DSH。

## 边界

- 不做：跨设备同步、长期归档压缩、按说话人分账（声纹编号本来就不稳定）。
- 覆盖率是「听没听见」的账，**不判断该不该抬**；该不该抬由 lift 的规则决定，两者别混。
