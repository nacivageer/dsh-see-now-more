# 任务书：主窗发来的图片也进浮窗（0.1.1-more.32）

状态：可验收（代码 / 单测 / 插件入口 / 窗口冒烟都过；真机重启这一层待做）
对象：绑定会话里用户发的 `image` 块，镜像进浮窗时写成 `![图片](<附件对象绝对路径>)`，浮窗里显示成真图；对象不在就退回 `[图片]`。不复制图片、不改窗口。
归属：session-8cca3e59-4846-40d9-bf73-893e55226978 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：格重启 DSH 让 `.32` 生效 → 主窗发一张带文字的图，浮窗出现缩略图 → commit（按实际路径）/ tag `v0.1.1-more.32` / prerelease。
证据：
  - 真实事件形状（本会话 seq 1446 / 1466）：`{type:"image", attachment:{attachmentId:"sha256:9c62f2a3…", mediaType, width, height, bytes, name}}`。
  - 附件对象路径 `~/.dsh/attachments/v1/objects/<hex 前两位>/<hex>`（用 seq 1446 / 1466 的 sha 实测存在）。
  - `mirrorTextOf` 对两条真实事件的输出：`![图片](C:\…\objects\9c\9c62…)` + 原文；`![图片](C:\…\objects\72\7244…)` + 原文。
  - `node --test` → 409 tests / 406 pass / 0 fail / 3 skip；`session-mirror` 28 条（新增图片用例）。
  - 插件入口 harness（`_scratch/apply_harness.mjs image`，装好的 `.32` + 临时 home + 真实附件对象）：
    `user:![图片](<temp home>\attachments\v1\objects\72\7244…)\n带图的话:dsh:session-harness-image:2` → PASS。
  - 窗口冒烟：临时 home + 真 `bin/see-window.mjs`，该 markdown 渲染成缩略图 + 文字（`_scratch/mirror-image-bubble.png`）。
账：无需（小改动）
更新：2026-11-26 23:09 CST

## 设计

1. `mirrorTextOf(event, env)` 遍历内容块：`text` 原样、`image` 走 `imageMarkdownOf()`，按原块顺序拼；
   正文仍 3000 字截断。
2. `imageMarkdownOf(block, env)`：`attachmentId` 必须是 `sha256:<64 hex>`；对象文件存在 →
   `![图片](<绝对路径>)`，否则 `[图片]`。
3. 不复制：窗口按绝对路径加载、按内容解码，扩展名不影响。
4. 回填走同一条函数：老消息的附件对象不在了自然退回 `[图片]`。

## 验收

- A：主窗发一张带文字的图 → 浮窗用户气泡里出现缩略图，文字也在，按时间排对。
- B：纯图片消息（无文字）→ 浮窗里是图，不再是 `[图片]`。
- C：手动把对象文件挪走再回填 → 退回 `[图片]`，不报错（单测覆盖）。

## 边界

- 不镜像 `assistant` 消息里的图片（那是正文 Markdown，原样显示）。
- 不复制附件、不清理附件库；`DSH_HOME` 搬家后老条目退回 `[图片]`。
- 不碰 `window.py`；版本 `.32`，发版照「发版六步」。

## 日志

- 2026-11-26 23:08 新建（进行中）。起因：格在主窗发图测试，浮窗只同步了文字（chat.jsonl 里
  `{"text":"测试图片信息同步2","origin":"dsh"}`，没有图也没有 `[图片]`）。
- 2026-11-26 23:09 代码 + 单测 + 文档完成（未提交）：`mirrorTextOf` 认 image 块、新增
  `imageMarkdownOf`；README / 机制.md / 决策记录 / CHANGELOG / 版本 `.32`。真实事件跑通路径拼接，
  窗口冒烟出图。
- 2026-11-26 23:10 证据补齐（仍等真机）：`node --test` 409 / 406 过 / 0 失败；装好的 `.32` 走插件入口
  harness 写出 `![图片](…)\n带图的话`；profile 已同步 `.32`。真机那条要重启后验。
