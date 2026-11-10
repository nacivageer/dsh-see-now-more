# 参与

这是 `dsh-see-now` 的本地分支，不是上游官方版本；当前方向是**黑听抬头**（见 README「它往哪走」）。提交前请先理解三件事：

1. **范围**：只在 **Windows 10 + DSH 桌面版 `0.2.2-rc.1`** 上验证过；macOS / Linux 未验证，
   **麦克风输入从未测试**，不知道是否可用。改这些路径前先在对应环境里跑通。
2. **别跑生成链。** `npm run sync:window` 会用上游 `dsh-watch-together` 覆盖
   `examples/floating-chat/window.py`，而本仓对这个文件改动很大。只读检查用
   `npm run check:window`。
3. **本仓没有发布到 npm。** 包名 `dsh-see-now-more` 只是为了不和上游撞车；
   安装走 `node scripts/install-dev.mjs`。

## PR

- 按 Apache-2.0 提交，不需要签 CLA。
- 改 JS 先跑 `node --test`；改 Python 至少手动起一次悬浮窗。
- 一次 PR 只做一件事；带截图或日志说明"改之前是什么样"。
- 不要提交 `.backup/`、`.tmp/`、`__pycache__/`、本地截图和音频、`~/.dsh` 下的运行数据。

## Issue

- 自用分支，不承诺响应时间；能复现的 bug 优先。
- 报 bug 请附：OS、Node 版本、`see_now({action:"status"})` 的输出、以及
  `~/.dsh/see-now/plugin-error.log` / `watch-window-error.log` 里的相关行（先删掉个人路径）。
- 安全和隐私问题请直接在 issue 里描述现象，不要贴完整的屏幕截图或会话内容。
