# 任务书：`see_now` 的「指 + 等」（新 action `pointer`）

状态：可验收（真机调用已过；`0.1.1-more.23` 已发并装进 profile）
对象：给 `see_now` 加一个新动作 `pointer`——在屏幕指定坐标画一个圈/箭头（带标签），然后停住等一个信号（点击 / 那块位置换了窗口 / 超时）再返回，并把「等到的是哪一种」如实报出来。默认关，不动 `window.py`。
归属：session-83213926-c4a7-4291-8390-59768f8df1b0（任务书）/ session-4c36066b-e5c6-465c-b878-8c8eb6f43e12（验收与发版）/ `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：等格确认收尾；热读文案修正只在 main 上（`.23` 的 Release 不含），下次发版带进 CHANGELOG。攻略地图实测已完成（见日志 22:20）；可选：装 `windows-capture` 后用 `source:"window"` 抓游戏窗口，不受主窗遮挡。
证据：
  - `node --test` → 352 tests / 349 pass / 0 fail（含 `test/pointer.test.mjs` 8 条、`tool-spec` 体积预算）
  - `DSH_SEE_POINTER=1 node scripts/pointer-smoke.mjs --x 300 --y 300 --label 点这里 --wait none` → `{"ok":true,"signal":"none"}`，exit 0
  - `signal:"change"` 实测：964ms 命中，`hwndBase 66668 → hwnd 17303470`
  - `signal:"timeout"` 实测：`elapsedMs` 4048 / 6014，进程无残留
  - 画得出：屏上数到 1540 个 `#FF3B30` 像素，圈顶在 y=239（圆心 300、半径 60，物理像素，与声明一致）
  - 人工点验（session-4c36066b）：`inside:true`（cursor (1891,1114)，距圆心 45px）/ `inside:false`（cursor (1746,1099)，圈在 (500,500)）/ Esc → `ok:false, reason:"cancelled"`
  - 契约对齐：`cancelled` 原先回 `ok:true`，已按 `region` 的约定改为 `ok:false, reason:"cancelled"`；复跑 `node --test` 全绿（顺手修了 `coverage-ledger` 分钟边界的浮点严格相等）
更新：2026-11-20 22:44 CST

## 现状依据（已核，2026-11-20）

- 我们**能看不能指**：`see_now` 有 `watch/peek/listen/lift/window/region/bloodbar` 等动作，没有「指向某个坐标」的能力。`region` 只让用户框一块给 AI 看，方向相反。
- 参照实现是 `dsh-subtitle-pointer` 0.2.0（B 站 BV1awWV6QEJZ，评审见 [bilibili 仓 `Review_BV1awWV6QEJZ.md`](../../../bilibili/bili/reviews/Review_BV1awWV6QEJZ.md)）：三件套里唯一不可替代的是 `overlay_guide`——先指、再停住等，结束条件三选一并回报来源。它的两个问题我们不该照搬：**只有夸克网盘、无仓库**（不可审）；**用「画面变了」当「人做完了」**（弹窗/动画即误判）。
- 契约与预算现状：`ACTION_VALUES` 十项（`src/tool-spec.js:46-48`）；`see_now` 定义体积 2026-11-17 量账约 5,738 字符，上限 `SPEC_BUDGET_CHARS = 7500`（`test/tool-spec.test.mjs:33`），**余量约 1,760 字符**；`test/tool-spec.test.mjs` 已守着「每个 action 值必须有分支」「每个参数必须有 description」「index.js 读到的参数必须声明」。
- 可照抄的先例：`src/region.js` + `examples/floating-chat/pick_region.py`——Python 只负责交互、stdout 吐一行 JSON；Node 负责挑解释器（`pythonCandidates()` / `hasTkinter()`）、超时、校验坐标、清理。`pick_region.py` 是**我们独有的**，`scripts/sync-window.mjs:173-177` 明确它不进 `ASSETS`、同步不会覆盖它——`pointer.py` 按同一位置放。

## 契约（新增，不改旧语义）

按分叉纪律第一条：**只新增**。`action` 加一个值 `pointer`，其余动作的行为、返回字段、落盘格式一律不动。

| 参数 | 类型 | 默认 | 规则 |
|---|---|---|---|
| `x` / `y` | integer | — | 必填，**屏幕物理像素**（与 `region` 同口径）；越界或负数直接拒绝，不画 |
| `label` | string | — | 必填，≤ 40 字；超长截断并在返回里标 `truncated:true` |
| `shape` | enum `circle`/`arrow`/`box` | `circle` | 单次只画一个 |
| `wait` | enum `click`/`change`/`none` | `click` | `none` = 画完即返回，不等 |
| `waitMs` | integer | `20000` | 夹在 1,000–120,000；必须 < `TOOL_TIMEOUT_MS`（900,000） |
| `radius` | integer | `60` | 判定范围（圈半径 / 点击落点与区域变化都按它），上限 400 |
| `clear` | boolean | `false` | `true` = 只清掉当前圈，不画新的 |

返回（`meta` 结构化 + `text` 一句话）：

```json
{ "ok": true,
  "painted": { "x": 960, "y": 540, "shape": "circle", "label": "点这里" },
  "signal": "click" | "change" | "timeout" | "cancelled" | "unknown" | "none",
  "inside": true,
  "elapsedMs": 4123,
  "changedRatio": 0.12 }
```

- `signal` 是**信号名**，不是判断：`change` 只表示「那块像素变过」，`click` 只表示「左键按在了 radius 内/外」。**任何字段都不叫 done / success / 完成**，`text` 也不许写「已教会」「已完成」。
- 失败与不明：未启用 → `{ok:false, reason:'pointer 未启用'}` 且不 spawn；找不到解释器/脚本/子进程异常退出 → `{ok:false, reason:'no-python'|'no-script'|'failed', detail}`；到点没信号 → `ok:true, signal:'timeout'`；子进程崩了而无法判定 → `signal:'unknown'`，**不重画、不重试**。

## 怎么做（三个技术选择）

1. **不碰 `window.py`。** 悬浮窗是 489 KB 的共用脚本（陪看项目也在用，`src/window.js:6-16` 写了为什么不拷）。画圈是独立的一次性进程：`examples/floating-chat/pointer.py`，进程退出即清屏，**不留常驻覆盖层、不需要记忆清理状态**。
2. **不用全局热键。** `RegisterHotKey` 会抢占系统组合键、与输入法冲突（subtitle-pointer 作者自述「做输入法的会话跪了」），而且它的窗口是鼠标穿透 + 不可聚焦的，Tk 的键盘事件根本收不到。改用 **`GetAsyncKeyState(VK_LBUTTON)` 50 ms 轮询 + `GetCursorPos`**：不需要管理员、不抢键、和「鼠标穿透」不冲突（穿透只影响窗口收不收消息，不影响全局轮询）。
3. **「等到了」用两个真信号，不用「画面变了就等于做完」。**
   - `click`：左键按下瞬间取光标位置，算与 (x,y) 的距离 ≤ radius → `inside:true`，否则 `false`（按在圈外也是信息）。
   - `change`：每 200 ms 用 mss 抓 radius×radius 这块，与基线比，变化像素占比 ≥ 3% 且随后 3 帧稳定 → `signal:'change'`，回报 `changedRatio`。文档里必须写清：**它只说明那块画面动过，不说明人做对了。**
   - `timeout`：`waitMs` 到点。
   - 进程内 `Esc` 或右键 → 退出码 2 → `signal:'cancelled'`（与 `pick_region.py` 的取消约定一致）。

## 实现落点

| 文件 | 改什么 | 量级 |
|---|---|---|
| `examples/floating-chat/pointer.py`（新） | 透明置顶 + 鼠标穿透（`WS_EX_TRANSPARENT` + `-transparentcolor`）、按 `DSH_POINTER_ARGS` 的 JSON 画一个 shape、轮询出信号、stdout 一行 JSON、退出码 0/2；开头 `SetProcessDpiAwareness(2)` 保证坐标是物理像素 | ~200 行 |
| `src/pointer.js`（新） | 照 `src/region.js` 的骨架：找 python、超时、校验 x/y/radius/waitMs、把子进程输出解析成上面那个形状；未启用时直接返回、不 spawn | ~120 行 |
| `src/index.js` | `action === 'pointer'` 分支 + `clear` 捷径；返回 `{text, meta}` 与既有动作同形 | ~40 行 |
| `src/tool-spec.js` | `ACTION_VALUES` 加 `'pointer'`；`action` 的 description 加一行；新增上述 7 个参数（**只写规则，不写推导**） | ~700 字符 |
| `scripts/pointer-smoke.mjs`（新） | 手动验收脚本：`--x --y --label --wait --wait-ms` 直接跑一次，打印返回 JSON，用来做人工点验与截图 | ~50 行 |
| `test/pointer.test.mjs`（新） | 参数校验、越界拒绝、label 截断、waitMs 夹取、未启用不 spawn、子进程异常 → `unknown` | ~120 行 |
| `docs/决策记录.md` | 新增一条：「为什么不用 window.py / 不用全局热键 / change 不叫 done」 | 1 节 |
| `docs/机制.md` / `README.md` | 新增「指和等」一节：三种信号的含义、已知边界（DPI、多屏只主屏、独占全屏不显示） | 1 节 |
| `CHANGELOG.md` + `package.json` + `dsh.plugin.json` | 发版六步照旧，三处同值 | — |

坐标口径不做新约定：与 `region` 一样用主屏物理像素，负坐标拒绝（照 `src/region.js:129-133` 的理由）。多屏第二块屏不支持——这是既有边界，不是这次新加的。

## 写能力六问（`write-guard`）

| # | 问题 | 这次的答案 |
|---|---|---|
| 1 | 改谁的状态 | **只改用户屏幕的临时视觉层**：不改文件、不改账号、不联网；进程退出即消失 |
| 2 | 关掉开关后还出现在工具列表吗 | 会出现在 schema（action 枚举里），但**调用即拒**：未启用时直接 `{ok:false, reason:'pointer 未启用'}`，不 spawn 任何进程。要不要连枚举都不出现，见「需要拍板」 |
| 3 | 失败/超时是暂停还是重试 | **暂停**：timeout / 子进程崩 → `signal:'timeout'|'unknown'` + `detail`，不重画、不重试、不换坐标重打 |
| 4 | 有没有范围 | 坐标必须在主屏内；`label ≤ 40 字`；`radius ≤ 400`；`waitMs ≤ 120s`；单次一个 shape；同一会话**每分钟 ≤ 6 次**（内存计数），超了直接拒 |
| 5 | 结果不明会不会写成成功 | 不会：六种 `signal` 分列，`unknown` 单独一档；`text` 只报信号与耗时 |
| 6 | 撤销路径 | 结束即销毁进程与窗口；`clear:true` 立即清；`Esc`/右键随时取消 |

**默认关**是硬要求：`~/.dsh/see-now.json` 的 `pointer.enabled` 缺省 `false`；开发期可用 `DSH_SEE_POINTER=1` 临时开。双条件取「配置开 **且** 调用必须带 `label` 与坐标」——不接受空白圈、不接受「画在所有窗口最上层但什么都不说」。

## 验收（可观察，八条）

1. **默认不画**：`pointer.enabled` 缺省时跑 `node scripts/pointer-smoke.mjs --x 960 --y 540 --label 测试` → 输出 `pointer 未启用`，0.5 s 内退出，前后 `Get-Process python` 数量不变。
2. **画得出**：开启后同一命令 → 屏幕中心出现一个圈 + 标签，`docs/verify-pointer.png` 存截图。
3. **不抢鼠标**：圈在屏时，手动点圈内另一个窗口的按钮 → 那个窗口照常响应（穿透生效）。
4. **三种信号各自可达**：`--wait click` 点圈内 → `signal:"click", inside:true`；点圈外 → `inside:false`；`--wait change` 按「偏差」那节验：让那个坐标上换一个窗口（开菜单/对话框）→ `signal:"change"` + 前后 hwnd（不是像素差）；`--wait-ms 3000` 不操作 → `signal:"timeout", elapsedMs≈3000`。
5. **收得干净**：任一结束方式后没有残留 python 进程、屏幕上没有残留圈；`Esc` 能中途取消并返回 `cancelled`。
6. **契约不破**：`node --test` 全绿——含 `tool-spec.test.mjs` 的体积预算（≤7,500 字符）、「每个 action 有分支」「每个参数有 description」，以及 `version.test.mjs` 的三处同值。
7. **协同（真实使用链）**：用户切在别的会话时，`say` 的指令先进悬浮窗（气泡 + 朗读）、圈同时在屏幕上可见、点击回传发起会话。前提是悬浮窗绑的是发起会话（`see-now.json` 的 `session`）——跨会话的 `say` 会被拦。
8. **先校准再指**：两张图之间的变换用**地物锚点**（海岸线拐点、湖泊、道路交叉、建筑轮廓），不用文字标签；两点定缩放+平移、第三点验残差。指目标前先在**已知地物**上画一个测试圈、用 `crop` 抓屏确认圈落对了；`pointer` 的 `inside/outside` 只当「用户点没点」，不当位置判据。校准后**冻结视图**：只平移不缩放时用一个锚点重算 offset，缩放则整段重算；校准参数落 `_scratch`，别每次从头推。

## 不做什么

- 不做全局热键（理由见「怎么做」第 2 条）。
- 不做「屏幕 OCR 判断用户点对了没有」——那是另一件事，且会把一次 5 秒的指路变成一次 OCR 调用。
- 不做多圈/动画/连续指引（一次一个，避免刷屏与「谁负责清」）。
- 不改 `window.py`、不跑 `npm run sync:window`（决策记录「不做什么」）。
- 不做 mac、不发 npm、仍按源码安装 + tag/Release 锚点。

## 风险与已知边界

- **DPI**：不显式声明 DPI aware 时 Tk 坐标会被系统缩放，圈会画偏——`pointer.py` 必须在建窗前 `SetProcessDpiAwareness(2)`；验收第 2 条要在 125% 缩放下再看一次。
- **独占全屏**：D3D 独占全屏下覆盖层不显示（与 `see_now` 已有的采集边界同源），文档写明「先切窗口化」。
- **多屏**：只支持主屏（沿用 `region` 的口径）。
- **轮询成本**：50 ms 一次的 `GetAsyncKeyState` + 200 ms 一次的 mss 抓 120×120 区域，预计 < 1% 单核；用 `scripts/pointer-smoke.mjs --wait-ms 60000` 跑一分钟测一次，写进 `docs/实测.md`。
- **与悬浮窗同屏**：圈是独立窗口，正常不冲突；若悬浮窗正在朗读，先把 `say` 说完再画（由模型侧顺序决定，不在代码里强同步）。

## 已定（2026-11-20，格：「写你觉得合适的选项就行……边做边看」）

1. **`wait` 默认 `click`**，不给 `both`。两个信号同开会让返回含糊，违反「结果要标明来源」。
2. **开关只放 `~/.dsh/see-now.json` 的 `pointer.enabled` + 开发期 `DSH_SEE_POINTER=1`**，不动设置页（设置页在共用 `window.py` 里，改了就越过扩展区）。

实现时又自己定了一条，写在下面「偏差」里：**`change` 改成「那个坐标上换了窗口」，不是像素差**。

## 实现记录（2026-11-20）

### 落地情况

| 文件 | 状态 |
|---|---|
| `examples/floating-chat/pointer.py` | 新增 ~250 行：DPI aware、全屏透明覆盖层（`-transparentcolor` + `WS_EX_TRANSPARENT` 穿透）、画 circle/arrow/box + 标签、50ms 轮询 `GetAsyncKeyState`（左键 / Esc / 右键）、200ms 轮询 `WindowFromPoint`、stdout 一行 JSON |
| `src/pointer.js` | 新增 ~180 行：开关（默认关）、参数校验/夹取/截断、每分钟 6 次额度、挑 python（`pythonCandidates` + `hasTkinter`）、超时兜底、结果整形 |
| `src/index.js` | `action === 'pointer'` 分支：六种信号各一句中文，`meta` 带 `signal/inside/hwnd/elapsedMs` |
| `src/tool-spec.js` | `ACTION_VALUES` 加 `pointer`；新增 7 个参数；体积预算仍绿（`node --test` 通过） |
| `test/pointer.test.mjs` | 新增 8 条：参数必填/整数/负数拒绝、label 截断、枚举、上下限夹取、开关三态、未启用不 spawn、脚本路径 |
| `scripts/pointer-smoke.mjs` | 人工点验脚本 |

### 两处与原计划的偏差（都是实测改的口）

1. **`change` 不用像素差，改用 `WindowFromPoint` 的句柄变化。**
   实测：覆盖层自己全屏铺在最上层时，抓屏拿到的那块是冻结的——同进程 diff 恒 0，换一个进程也一样（先把采样拆成 `pointer_watch.py` 子进程试过，仍然恒 0）。所以「圈里画面变没变」这条路在当前架构下不可靠。
   句柄信号更窄但可核：**那个坐标上换了个窗口**（菜单/对话框/新窗口）。它看不到「内容变了窗口没变」（翻页、滚动、视频），这一条必须写进文档，不许包装成「画面变了」。
   顺带删掉了 `mss` 依赖与那个采样子进程——少两个活动的零件。
2. **`clear` 参数没有实现，也没进 schema。** 原计划让它「只清当前圈」，但进程退出即清屏，没有「常驻的圈」需要清；留一个空转参数不如不留。

### 踩到的两个坑（写下来省下一次重踩）

- **DPI 150%**：测试用的闪窗没声明 DPI aware，`geometry('+300+300')` 实际落在 450,450、尺寸放大 1.5×——于是「明明弹了窗，采样恒 0」，白查半小时。`pointer.py` 自己在建窗前 `SetProcessDpiAwareness(2)`，所以它画的圈坐标是物理像素（实测圈顶 y=239 对得上 300−60+4）。
- **`root.after` 链一断，`mainloop` 永远转**：定基线那一帧提前 `return` 漏了续拍，窗口挂在屏幕上不下来（当时只能去 kill 进程）。现在 `tick` 用 `try/finally` 续拍，只在 `state['code']` 还空着时续。

### 还差什么

- ~~人工点一次~~ 已验：脚本级 `inside:true/false`、真机 `pointer` `inside:true`、`say` + `pointer` 复验 `inside:true`（见日志 18:08 / 18:11）。
- ~~README / 机制 / CHANGELOG / 版本~~ 已补，`0.1.1-more.23` 已发并装机。
- 多显示器、独占全屏未验证（沿用既有边界：只主屏、独占全屏不显示）。

## 日志

- 2026-11-20 11:15 新建（等你定）；依据：subtitle-pointer 评审（BV1awWV6QEJZ）与 `region.js`/`pick_region.py` 的先例；无实现证据。
- 2026-11-20 16:27 接手（session-4c36066b）：merge `pointer-draft`（569f9da）→ `e920ffd`；人工点验 `inside:true` / `inside:false` / Esc `cancelled`；把 `cancelled` 对齐 `region` 的约定（`ok:false, reason:"cancelled"`，原先回的是 `ok:true`）；`pointer.py` 加 `DSH_POINTER_DEBUG=1` 的点击坐标/DPI 日志（只在 stderr，不改契约）；补 README / `docs/机制.md` 第八节 / 决策记录；版本 `0.1.1-more.23`。
- 2026-11-20 18:08 真机验收（session-4c36066b）：宿主已加载 `.23`，工具表里有 `pointer`；临时打开 `pointer.enabled`（热读，未重启即生效），`wait:"none"` 返回 `signal:"none"`，`wait:"click"`（radius 200）点中圈心 → `inside:true`（1.4s）；配置已恢复原样。发现提示文案「改完重启 DSH」不实，改为「下一轮调用就生效」并补热读单测（main 领先 tag，`.23` 的 Release 正文不含这条修正）。
- 2026-11-20 18:11 复验（session-4c36066b）：`pointer` 与 `say` 同一次调——气泡 + 朗读先落悬浮窗（窗已绑本会话），4.8s 点中圈心 → `inside:true`；`say` 在动作之前统一处理，跨会话的 `say` 会被拦。配置已恢复原样。
- 2026-11-20 22:20 攻略地图对照实测（session-4c36066b）：切到目标区域后，`watch` 整屏 → `crop` 对照攻略 → `pointer`；圈中标点后用户点圈里确认。教训：整屏 gdigrab 会被 DSH 主窗遮挡，定位游戏画面前先最小化主窗；WGC 的 `source:"window"` 要 `windows-capture`，本机未装（`status` 里血条窗口抓 ✗），这次只能整屏抓。
- 2026-11-20 22:44 补验收第 8 条（先校准再指）：定位游戏画面先用窗口 rect / `source:"window"` 抓图（避免被主窗压住），地物锚点定缩放/平移、第三点验残差，先在已知地物画测试圈用 `crop` 验证，再指目标；`inside/outside` 只当「用户点没点」。



- 2026-11-20 11:44 等你定 → 进行中；两条拍板项已定（click 默认、开关只放配置），代码落地，`node --test` 349 通过 / 0 失败，`change` 与 `timeout` 实跑有证据；差人工点验与文档。
