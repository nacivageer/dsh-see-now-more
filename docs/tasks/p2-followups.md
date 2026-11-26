# P2 收尾：大图门槛 / 回顾窗引用 / 多条引用

状态：进行中
对象：把交接文 `handoff-2026-11-27-0005.md` 列的 P2 三项做掉——② 大图先缩后存（实为拆错门槛）、① 回顾窗里的引用、③ 一条多条引用（可选）。
归属：session-75e4517a-2334-453e-a2b0-e7d15e537e67 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：先改 ②（`RELAY_IMAGE_BYTES` 4MB → 32MB + 守门测试），跑 `node --test`，再改 ①（回顾窗 `allow_quote`）。
证据：
  - 待补
账：无需（短任务）
更新：2026-11-27 00:20 CST

## 日志

- 2026-11-27 00:20 新建（进行中）。依据：交接文 P2 三项；`src/index.js:563` 的 4MB 门槛；DSH `dsh-attachment-local` 源码（源上限 50MB、归一化 2048²/4MB，见 `_scratch/attachment-local/`）。未动代码。

## 边界

- ③ 多条引用按「单 chip 多条」做（若做），不做多 chip 横排。
- `.34` 那三个可选项（steer 说明卡 / 绝对路径 / 启动通知）不动。
- `window.py` 只定点改，不跑 `npm run sync:window`、不整文件覆盖。
