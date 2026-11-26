# 交接：屏幕文字事件流 P1（闸门 / 条带 OCR / 交付 + 账）

> 交接给 see-now-more 的下一个会话。写于 2026-11-27 06:58 CST。

## 状态

- P1 第 1–3 步**代码已落地并提交**：`cb178f5`（闸门）、`ff393bc`（条带 OCR）、`5270284`（交付 + 账）。
- 未提交：`src/text-stream.js` / `src/runner.js` / `src/index.js` 三处**运行期开关**（`text.enabled` 1.5 秒生效，A/B 用）。
- 测试：`node --test` 464 项全过 / 0 skip（winrt 已装进 DSH runtime python，原来 skip 的 3 条血条 OCR 也跑起来了）。
- **没做完的只有 A/B**（peek 率 / 净省）：两轮都没抓到唤醒样本，原因见「坑」。

## 已完成（按 commit）

1. `cb178f5` 闸门 `src/text-events.js`：归一化 / bigram / 预算 / `createTextGate`；`confirmGapMs` 默认 **900**（临时值，格定，定值等实测）。
2. `ff393bc` 条带 OCR：`src/text-band.js`（几何 / rgb24→BGRA / `tidyOcrLine` / 配置）、`src/text-stream.js`（1 fps 抽帧、忙时丢帧、失败 60 秒冷却）、`pipeline.push()` 的 `onFrame` 钩子、`--mode text` 的 sidecar、`dshRuntimePythons()`。
3. `5270284` 交付 + 账：`unreadSince()` 水位、`takeText()` 三处共用、`sheet.textLines/textStats`、`textLinesText()` 渲染、「屏幕文字」唤醒段、`textCoverage`。

## 验收数字（真机）

- 10 分钟烧字幕测试视频（`_scratch/band-test.mp4`）：入流 196 / 挡下 0 / 未确认 0 / 判重 39；**行级召回 196/196**，相似度 0.97；单次条带 OCR ≈162 ms。
- 用户新录的素材：`H:\DSH\测试用的视频.flv`（1280×720 / 30fps / 311 秒 / 372 MB，字幕烧进画面、无软字幕轨）——**还没跑**。

## 下一步（按顺序）

1. 跑 `H:\DSH\测试用的视频.flv`：按 1 fps 过条带 OCR，报四数 + 覆盖率；召回用「人工抽 20 帧」当 ground truth（无软字幕轨）。
2. A/B：我说「我空闲了」→ 用户放 5 分钟（期间**一次工具都不调**）→ 改 `text.enabled:false` 再 5 分钟 → 取两窗的叫醒 / peek / 图 token / 文字 token。
3. P4：README 四档表（发版时一起改，任务书 P4 有现成表）。

## 坑（务必看）

- **宿主代码要重启才生效**：改 `src/` 后 `node scripts/install-dev.mjs` 同步 profile + 重启 DSH；`text.enabled` 是例外（1.5 秒轮询，即时生效）。
- **`targetBusy()` 会把唤醒 park 掉**：我在回合里连续调工具时循环不叫醒，只写「待领说明」——A/B 必须在我完全空闲时做。
- **WinRT 中文一字一空格**（`我 们 得 先 回 去`）：闸门归一化会去掉（配对不受影响），交付用 `tidyOcrLine()` 收拾。
- **`OcrLine` 没有置信度**，`conf` 恒为 null，「同字数取 conf 高」实际走不到；「字数优先」会被垃圾字符骗（实测 `走吧□99）` 顶掉 `走吧（99）`）。
- **`between()` 的 seq 不保证与 t0 同序**（同帧双语行 OCR 会翻面）→ 水位取 `max(seq)`。
- 悬浮窗跑仓路径；`~/.dsh/see-now.json` 本轮被改过（`text.enabled` 已恢复 true，旧文件备份在 `see-now.json.bak-ab`）。

## 关键路径

| 东西 | 位置 |
|---|---|
| 任务书 / 状态块 | `docs/tasks/text-event-stream.md` |
| 验收脚本（旧素材） | `_scratch/accept-band.mjs`、`_scratch/band-test.mp4` |
| 新素材 | `H:\DSH\测试用的视频.flv` |
