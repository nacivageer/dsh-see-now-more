# P2 收尾：大图门槛 / 回顾窗引用 / 多条引用

状态：可验收
对象：把交接文 `handoff-2026-11-27-0005.md` 列的 P2 做掉——② 大图先缩后存（实为拆错门槛，已做）、① 回顾窗里的引用（已做）、③ 一条多条引用（未做，按「单 chip 多条」留作后续）。
归属：session-75e4517a-2334-453e-a2b0-e7d15e537e67 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：等你验。② 的真机验证要等 DSH 下一次重启（当前进程还是 .34）：浮窗发 `_scratch/screen-map4.png`（5.5MB）→ `relay.log` 一条 `ok`、会话里 `user/message` 是 attachment 且带 `originalDimensions`（证明被归一化过）。
证据：
  - `node --test`：412 tests / 409 pass / 0 fail / 3 skip（2026-11-27 00:27，本仓）
  - `python scripts/check-quote.py` exit 0；`py_compile` 三文件 OK；`scripts/check-feed-order.py` exit 0
  - ② 单测：`test/relay-image.test.mjs`「超过 4MB 的图也交给 saveImage」通过；DSH 侧依据 `_scratch/attachment-local/index.ts:33`（源上限 50MB）、`:58`（归一化目标 4MB）、`store.ts:104`、`normalization.ts:109`
  - ① 真机：window log `[hist] press 385,229 page=list … rowhit=39caa84d` → 进入正文；拖选 `[sel] extend …`；右键菜单截图 `_scratch/p2-hist-menu.png`（「引用选中文字」在第一项）；点后回顾窗关、主窗 chip「到了，是我上…×」`_scratch/p2-quote-main.png`；退格删除 `_scratch/p2-chip-cleared4.png`
  - 发版：tag `v0.1.1-more.35`（`c04e3a7`）已 push；Release <https://github.com/nacivageer/dsh-see-now-more/releases/tag/v0.1.1-more.35>（prerelease）；profile 已装 `.35`（`--check` 一致）
账：无需（短任务）
更新：2026-11-27 00:32 CST

## 日志

- 2026-11-27 00:20 新建（进行中）。依据：交接文 P2 三项；`src/index.js:563` 的 4MB 门槛；DSH `dsh-attachment-local` 源码（源上限 50MB、归一化 2048²/4MB，见 `_scratch/attachment-local/`）。未动代码。
- 2026-11-27 00:32 进行中 → 可验收。② 改 `RELAY_IMAGE_BYTES` 32MB + 守门测试；① 回顾窗 `allow_quote=True` + `_quote_choice()`（关窗 + 主窗前置 + 焦点）；文档与版本 `0.1.1-more.35` 同步；提交 `c04e3a7` + tag + Release，profile 已装。① 的真机截图与日志见上；② 真机待重启。

## 边界

- ③ 多条引用没做：若做，按「单 chip 存 list、预览显示 ×N」，不做多 chip 横排。
- `.34` 那三个可选项（steer 说明卡 / 绝对路径 / 启动通知）没动。
- `window.py` 只定点改，没跑 `npm run sync:window`、没整文件覆盖。
