# 任务书：浮窗纯图去占位 + 插话提示改口径（0.1.1-more.33）

状态：已发版（`v0.1.1-more.33`，prerelease <https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.33>；真机 A/B/C 通过）
对象：① 浮窗发纯图时，投给会话的用户消息不再补 `[图片]` 正文（主窗只显示图）；② 插话提示里「普通回复悬浮窗里一个字都看不到」改成与 `.31` 实际行为一致（正文会镜像，只有 `say` 会念）。
归属：session-8cca3e59-4846-40d9-bf73-893e55226978 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：无。已知边界：纯图消息在主窗没有文字可搜/引用，要可搜就带一句。
证据：
  - 现状（23:17 实测）：浮窗发纯图 → 会话 `seq 1869` = `text:"[图片]"` + `image:241x59`；主窗气泡先显示 `[图片]` 再是图。
  - `[图片]` 来自 `src/index.js` 原 `sendText = relayed.text || (relayed.images.length ? '[图片]' : clean)`。
  - 改动：`src/interject.js` 新增 `relaySendText()`；`src/index.js` 用它算正文，说明那条另用 `[图片]` 占位。
  - `node --test` → 410 tests / 407 pass / 0 fail / 3 skip（含 `relaySendText` 4 条、插话提示逐字用例按新文案）。
  - **真机（23:25 重启 `.33` 后）**：浮窗发纯图 → 会话 `seq 2157` 只有 `image:200×47`、没有 text 块；
    浮窗发图+文字 → `seq 2178` 的 image + text 都在；插话卡 `seq 2179` 已是新文案。
  - 文档：README（`say` 行两处）/ 机制.md 第十节 / 决策记录 / CHANGELOG / 版本 `.33`；tool description
    没动（体积预算只剩 24 字，改在 instruction 里）。
账：无需（小改动）
更新：2026-11-26 23:31 CST

## 验收

- A：浮窗发纯图 → 主窗只有图，没有 `[图片]` 那行字。
- B：浮窗发「图 + 文字」→ 主窗图 + 文字，顺序不乱。
- C：下一条浮窗消息的提示卡不再说「普通回复看不到」，只说「`say` 才会念」。

## 边界

- 不改 `loadRelayImages` / 图片形状；不动镜像（`.32`）。
- 纯图消息在主窗没有文字可搜，已知边界，写进决策记录。

## 日志

- 2026-11-26 23:22 新建（进行中）。起因：格 23:17 从浮窗发纯图，主窗先出 `[图片]` 一行；
  同时那条提示卡还写着「普通回复一个字都看不到」，与 `.31` 的镜像行为矛盾。格说「都修」。
- 2026-11-26 23:24 代码 + 单测 + 文档完成（未提交）：`relaySendText` + 提示卡改写；
  全量 410 / 407 过。等重启后真机验 A/B/C，再提交发版。
- 2026-11-26 23:30 **真机 A/B/C 通过 + 发版**：纯图 `seq 2157` 无 text；图+文字 `seq 2178` 两者都在；
  插话卡 `seq 2179` 新文案。commit `cc6fdeb`（11 个路径）、tag `v0.1.1-more.33`、prerelease 已核
  （推送第一次探路两条都超时，curl 复测代理正常后重试成功）。
