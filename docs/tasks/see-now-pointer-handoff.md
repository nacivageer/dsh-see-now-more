# 交接：`see_now` 的 `pointer`（指 + 等）

> 交接给 **see-now-more 工作区**的会话执行。本文件自包含：现状已核实、代码在哪、还差什么、边界。
> 写于 2026-11-20，来自 bilibili 评审会话（session-83213926）。规格原文见同目录 [see-now-pointer.md](see-now-pointer.md)。

## 一句话

`see_now` 新增 `action:"pointer"`——在屏幕坐标画一个圈/箭头（带标签），然后停住等一个信号再返回。**代码已写完并提交**，差人工点验、文档与发版。

## 仓库现状（已核实）

- `main` 停在 `5ab29fa`（只有任务书，没有代码）。
- 实现单独在分支 **`pointer-draft`**，commit **`569f9da`**（7 个文件、703 行新增）：

```
examples/floating-chat/pointer.py   新 268 行
src/pointer.js                      新 187 行
src/index.js                        +54（action === 'pointer' 分支）
src/tool-spec.js                    +42（ACTION_VALUES 加 pointer、7 个参数）
test/pointer.test.mjs               新 8 条
scripts/pointer-smoke.mjs           新
docs/tasks/see-now-pointer.md       规格与决策
```

应用方式二选一：`git cherry-pick 569f9da`，或 `git merge pointer-draft`。（不要用 `git reset --hard pointer-draft`——那会把 `main` 上后来的提交一起带走。）

## 已验证到哪一步（证据）

| 项 | 结果 |
|---|---|
| 全部单测 | `node --test` → 352 tests / **349 pass / 0 fail** / 3 skipped（含 schema 体积预算、版本三处一致） |
| 开关 | 未配置时 `pointAndWait` 直接返回 `{ok:false, reason:'disabled'}`，不 spawn 进程 |
| 端到端（none） | `DSH_SEE_POINTER=1 node scripts/pointer-smoke.mjs --x 300 --y 300 --label 点这里 --wait none` → `{"ok":true,"signal":"none"}`，exit 0 |
| `change` | 实跑命中：964ms，`hwndBase 66668 → hwnd 17303470` |
| `timeout` | 实跑两次：`elapsedMs` 4048 / 6014；结束后无残留 python 进程、无残留窗口 |
| 画得出 | 屏幕截图数到 **1540** 个 `#FF3B30` 像素，圈顶 y=239（圆心 300、半径 60、线宽 4，物理像素） |
| **未验证** | **`click` 的 `inside:true/false`**——要人真的按一下鼠标，我不代按 |

## 待办（按顺序）

1. **人工点验 click**（5 秒，不用装）：
   ```powershell
   cd C:\Users\Administrator\Documents\deepseek-harness\see-now-more
   $env:DSH_SEE_POINTER=1
   node scripts\pointer-smoke.mjs --x 300 --y 300 --label 点这里 --wait click
   ```
   点圈内 → `inside:true`；再跑一次点圈外 → `inside:false`；按 Esc → `cancelled`。
2. **文档**：`README.md` 与 `docs/机制.md` 各补一节「指和等」（三种信号的含义、开关怎么开、已知边界）；`docs/决策记录.md` 补一条「为什么不用 window.py / 不用全局热键 / change 不叫 done」。
3. **发版**：按决策记录的六步，版本三处同值（`package.json` / `dsh.plugin.json` / `CHANGELOG.md`），建议 `0.1.1-more.23`，Release 标 prerelease。
4. **真机验收**：`node scripts/install-dev.mjs` → 重启 DSH → 让模型实际调一次（不只是脚本），确认工具列表里有 `pointer`、圈能画、`say` 与圈不打架。

## 已定的四个取舍（写代码时就照这个）

1. `wait` 默认 **`click`**，不提供 `both`（两个信号同开会让返回含糊）。
2. 开关只在 `~/.dsh/see-now.json` 的 `pointer.enabled`（开发期 `DSH_SEE_POINTER=1`）；**不动设置页**——设置页在共用的 `window.py` 里。
3. `change` = **那个坐标上换了个窗口**（`WindowFromPoint` 句柄变化），不是像素差。语义因此收窄：菜单/对话框/新窗口开在那儿会触发；翻页、滚动、视频不会。
4. 原计划的 `clear` 参数**不做**：进程退出即清屏，没有「常驻的圈」需要清。

## 已知坑（都实测过，别再踩一遍）

- **全屏覆盖层下抓屏拿到的是冻结画面**：自己这层铺满最上层时，同进程 `mss` 抓回来 diff 恒 0，换子进程也一样。所以 `change` 走 `WindowFromPoint`，不要退回去做像素比对。
- **本机 DPI 150%**：没声明 DPI aware 的 Tk 窗，`geometry('+300+300')` 会落到 450,450、尺寸放大 1.5 倍。`pointer.py` 建窗前 `SetProcessDpiAwareness(2)`，坐标才是物理像素（与 `region` 同口径）。
- **`root.after` 链断掉 = 窗口永远留在屏上**：任何提前 `return` 都必须走 `try/finally` 续拍，否则 `mainloop` 空转、只能去 kill 进程。
- **不用全局热键**：`RegisterHotKey` 抢系统组合键、和输入法打架；覆盖层是鼠标穿透的，也收不到 Tk 键盘事件。改用 50ms 轮询 `GetAsyncKeyState`（左键 / Esc / 右键），穿透不影响。

## 边界（不要越过）

- 不改 `window.py`、不跑 `npm run sync:window`（决策记录「不做什么」）。
- 不发 npm；源码安装 + tag/Release 锚点。
- 不做 mac。
- 只支持主屏；独占全屏（D3D exclusive）下覆盖层不显示——文档写明「先切窗口化」。
- 同一会话每分钟 ≤6 次；`label` 必填（不许画空白圈）；坐标越界拒绝。

## 本会话的边界（交代一句）

bilibili 评审会话负责「读视频 → 出评审 → 写任务书」。这次的实现属于越界（本该由 see-now-more 的会话做），所以实现单独放在分支、`main` 只有任务书；后续验收与发版请在这个工作区继续。
