# 覆盖率账：按分钟落盘（交接文）

状态：可验收（2026-11-17 04:18；①②③ 已做；重启后第一次真跑暴露并修了 `speechSec=0` 的口径，**要再重启一次**）
对象：把「**出字秒数 / 送审语音秒数**」这本账从内存（最近 10 分钟）落成按分钟的
     `coverage.jsonl`，让一局/一天的复盘能回答「漏抬那一刻到底听没听见」。
归属：session-9f3ff405（交接，2026-11-17）/ session-f9b26b06（接手，2026-11-17）；
     代码仓 `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：再重启一次 DSH（本轮的 0/没回传口径修在 src 里）→ 听一段 → `node scripts/coverage.mjs --ledger`
证据：
  - `test/coverage-ledger.test.mjs`、`test/coverage.test.mjs` 全部通过；全量 `node --test` 通过
  - 第一次真跑：账已落盘（`coverage/2026-11-17.jsonl`，9 行）；但 9 段全是 `textSec 0`，
    手工复测 `duration: 0` → 已修「VAD 0 秒」与「没回传」混在一起的问题（见下第 4 条）
  - 假数据实跑 `--ledger`：5 分钟分段 / 合计 / 漏抬 1 分钟 / 误抬 2 分钟对得上（见「进展」）
  - 落盘 `src/coverage-ledger.js`；接线 `src/listen.js:1304`、`:1320`；读它 `scripts/coverage.mjs:93`
  - 版本 `0.1.1-more.13`，已 `install-dev`（副本 = 源码）
  - 提交：see-now-more `f07c0a1`（2026-11-17）
更新：2026-11-17 04:18 CST

## 进展（2026-11-17 04:07，session-f9b26b06）

三件都做完了，代码在 `see-now-more`：

1. **落盘**：新增 `src/coverage-ledger.js`。每段音频按**本地分钟**拆行，append 到
   `~/.dsh/see-now/coverage/<YYYY-MM-DD>.jsonl`：
   `{day, minute, sentSec, speechSec, textSec, emptySegs, segs}`。
   - 一行是**增量**不是累计快照：同一分钟可以有多行，读的人求和 —— 重启/重试/崩溃都幂等；
   - 跨分钟按时间比例拆两行，`segs` / `emptySegs` 只记在最长的那一分钟；
   - 归属用**这段音频的开始时刻** `t0`（不是转写完的 `at`）：转写晚约 1 秒，
     按完成时刻分桶跨分钟时会和 lift 的 `wall` 错开；
   - `listen.js` 在 `covEntries.push` 之后顺手写（**没出字的段也写**），失败只记一次日志、不抛。
2. **读它**：`scripts/coverage.mjs --ledger [--minutes N] [--json] [--date YYYY-MM-DD]`，
   每 5 分钟一段 + 全天合计（语音 / 出字 / 覆盖 / 段数 / 像说话没字）。
3. **对齐**：同一分钟「有字却没抬」= 漏抬候选、「抬了但那分钟没出字」= 误抬候选；
   台账里没有的分钟（台账刚上线、那段时间没在听）单列为 `没对上分钟的 N 次`，不判误抬。
   **真实路径是 `lift/<YYYY-MM-DD>/log.jsonl`**（不是交接文原来写的 `lift/lift.jsonl`）；
   分钟取 `wall ?? at`（`wall` 是那句话的 ASR `t0`）。
4. **重启后第一次真跑（04:14）**：账真的开始写了（当时 9 行），但 9 段全是
   `speechSec 6 / textSec 0`。把当时的 `live-*.wav` 手工发给 :8000，回 `duration: 0` ——
   VAD 明确说这段没人说话（纯 BGM）。根因是 `httpTranscriber` 把 `duration: 0` 折成
   `null`，`listen.js` 再拿段长兜底，于是「没人说话」被记成「语音 6 秒、像说话没字」，
   status 覆盖率被刷成 0%。已修：**0 与「没回传」分开**（`listen.js` 的
   `httpTranscriber` / `unpackTranscription` / entry，`coverage-ledger.js` 的 `ledgerRows`）；
   `--ledger` 遇到「有段但语音 0 秒」会明说「VAD 判所有段都没人说话」。
   旧口径写的那 9 行已删，别算进今天的数。**这一修要再重启一次才生效。**
   修完用 repo 里的新代码单独起了一个 listener（临时 DSH_HOME，听 25 秒）复验：
   8 段 / `sentSec 24.1` / `speechSec 0` / `emptySegs 0` / `ratio null` —— 纯 BGM 不再被
   算成语音，账里只留「送了 24 秒、VAD 说没人说话」这个事实。

假数据实跑（验证读侧，不碰真机）：

```text
账 2026-11-17 · …\coverage\2026-11-17.jsonl
04:00–04:04  语音 4.8s · 出字 2.4s · 覆盖 50% · 段 2 · 像说话没字 1
04:05–04:09  语音 4.8s · 出字 2.4s · 覆盖 50% · 段 2 · 像说话没字 1
合计：语音 9.6s · 出字 4.8s · 覆盖 50% · 段 4 · 像说话没字 2
抬升：3 次（叫醒 2） · 漏抬候选 1 分钟 · 误抬候选 2 分钟
  漏抬 04:05  语音 2.4s/出字 2.4s  ← 这一分钟有字但没抬
  误抬 04:04  抬 1 次（glance），这一分钟没出字
  误抬 04:07  抬 1 次（alarm），这一分钟没出字
```

**重启之后第一件事**：听觉跑一段，再 `--ledger`。没行时它会直接说「没有台账：<路径>」，
不会编一个 0%。

## 现状（接手前必读）

链路已经是通的（**落盘已补，见上「进展」**）：

- `listen.js` 每处理完一段音频就往 `covEntries` push 一条
  `{at, t0, sentSec, speechSec, gotText}`（最多留 2000 条），并顺手写台账。
- `state().coverage = coverageOf(covEntries, { now })` → `describeCoverage()` → status 那行。
- 主口径：**ratio = 出字段的 speechSec 之和 / 所有段的 speechSec 之和**；
  `emptySegs` = 语音 ≥1.2s 却一个字没出的段数；没人说话时 `ratio = null`（status 不显示，不编 0%）。

实测那一段（放两段测试音频）：语音 15s、出字 8s、覆盖 53%、像说话没字 1 段。

## 为什么分母用 `speechSec` 而不是段长

段长 = 文件长度，含静音尾巴（Python 按 0.6s 静音切）；`speechSec` 是转写器 VAD 回传的
**语音秒数**。用段长当分母会把静音尾巴算成「本该有字」，覆盖率被系统性压低。

## 做法（原计划；已完成，见上「进展」）

1. **落盘**：在 `covEntries.push(...)` 那处顺手累计到一分钟一格，写
   `~/.dsh/see-now/coverage/<YYYY-MM-DD>.jsonl`，每行
   `{minute:"HH:MM", sentSec, speechSec, textSec, emptySegs}`；
   用「写 .tmp 再 rename」或按行 append（`appendFileSync`，单行不超过 4KB 时是原子的）。
   **按天分文件**，别写成一个越来越大的文件。
2. **读它**：`scripts/coverage.mjs` 加 `--ledger [--minutes N]`，输出今天的账（每 5 分钟一段 + 全天合计）。
3. **与抬升事件对齐**：`~/.dsh/see-now/lift/<YYYY-MM-DD>/log.jsonl` 有每次抬升
   （交接文原来写的 `lift/lift.jsonl` 是旧路径，现在按天分目录）；
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
- **字幕真值别按屏幕坐标抓**：悬浮窗就在游戏前面，`live-subs.py --rect` 截到的是窗子。
  用 `--window "鸣潮"`（WGC，被遮挡也读得到；窗口标题现在是「鸣潮」，不是「云·鸣潮」），
  OCR 用 Windows 的 winrt（脚本默认）。2026-11-17 04:07 实测：1922×1126、8 秒读到 2 行真台词。
- 插件的 profile 是**拷贝**：改完必须 `node scripts/install-dev.mjs` + 重启 DSH。

## 边界

- 不做：跨设备同步、长期归档压缩、按说话人分账（声纹编号本来就不稳定）。
- 覆盖率是「听没听见」的账，**不判断该不该抬**；该不该抬由 lift 的规则决定，两者别混。
