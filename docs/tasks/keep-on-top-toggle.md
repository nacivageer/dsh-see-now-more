<!-- 来源：格 2026-11-27 20:23 的原话「给本插件设置里面加上【保持置顶】的开关用来控制是否置顶，
     现在这个窗口一直置顶只能靠折叠也有点麻烦。默认为保持置顶：开」；交接文
     `handoff-2026-11-27-2016.md`（.43 发完、无硬缺口）。时间抄自本轮 Get-Date，不是估的。 -->

# 设置页「保持置顶」开关（`keepOnTop`）

状态：**已验收、已提交（未发版）**（实现 / 离线 / 真机三档都过了，格也自己点过并说「实测生效了」；
      20:41 格明示「先别发版」→ 只提交，未 tag、未 push、未 Release、未 install-dev；
      `.44` 的版本号 + CHANGELOG 段**不在提交里**，草稿见文末「发版草稿」）
对象：① 【本插件设置】加「保持置顶」（开 / 关，**默认开**），关掉后主窗是普通窗口、别的窗口能压上来；
      ② 所有「把主窗叫到前面」的入口收成 `_raise_window()`，关着时不再焊回最前；
      ③ `selftest-ui.py` 的顶置位跟着配置走；④ 顺手修设置卡最窄宽度下两行被截断 + 加离屏守卫
归属：session-e3da6a5f-3cb4-4dd5-861d-5964a647dbb9 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：等格开口发版：把文末草稿贴进 CHANGELOG 开头、`package.json` / `dsh.plugin.json` 改 `.44`
      → 提交 `release: 0.1.1-more.44 …` → `tag v0.1.1-more.44` → 推 → Release（prerelease）
      → `node scripts/install-dev.mjs` 让 profile 副本同步。**不用重启 DSH**（这次没改宿主侧 JS）。
      `.44` 还应收同一天的两处设置卡修复：「拖动后不再弹回原位」与「卡片也跟随保持置顶」——
      见 `settings-card-drag.md` / `settings-card-topmost.md` 的草稿。证据（全部本轮工具输出里抄的）：
  - 判据：`examples/floating-chat/window.py:401` `keep_on_top_enabled()`（默认开、只认真正的布尔）
  - 启动：`:958` `self._topmost_on = keep_on_top_enabled(self._settings_read())`
  - 看门狗：`:1290` `_keep_on_top()`（关着时只撤一次 `-topmost`，不反复 SetWindowPos）
  - 立即生效：`:1353` `_apply_topmost()`；设置页点击走 `:10116` 附近 `_settings_cycle` 的 `keepOnTop` 分支
  - 三处重新显示的入口：`:1373` `_raise_window()`（`_sync_visible` / 协议 `show` / 引用后回主窗都改走它）
  - 设置页：`:9350` 那一行；`:9537` 单独的「保持置顶：即时生效」提示行
  - selftest：`scripts/selftest-ui.py:323` 起按 `keepOnTop` 判顶置位；`:367` 关着时命中测试降 WARN；
    `:401` 关着时遮挡判 PASS；`:377` `dialogs-topmost` 排除主窗
  - 离线：`scripts/check-topmost-toggle.py`（**all passed**）、`scripts/check-settings-card.py`
    （**all passed (overflow none at 456px card)**）、`scripts/check-notif-toggle.py` / `check-quote.py` /
    `check-cleanup-tiers.py` / `check-restart.py` 全 exit 0
  - `node --test` **534 pass / 0 fail / 0 skip**（新增 `test/topmost-toggle.test.mjs`、`test/settings-card.test.mjs`）
  - 真机（4K / 150%，窗口 590×935 @254,181，pid 118776，起于 20:30:37，window.py mtime 20:30:01）：
    ① 默认：`topmost-bit PASS ex=0x00080088`，selftest **9 passed / 0 failed / 5 skipped**
    ② 写 `keepOnTop:false` 3 秒内：`topmost-bit PASS keepOnTop=false, ex=0x00080080`（WS_EX_TOPMOST 0x8 消失），
       `z-order PASS keepOnTop=false: coverage is expected`
    ③ 删键恢复默认 3 秒内：`topmost-bit PASS ex=0x00080088`；`see-now.json` 与改动前逐行一致（23 行）
  - **格自己点过（2026-11-27，本轮截图）**：设置页里点成「关」后，悬浮窗被 DSH 主窗和 Clash Verge
    压在下面（截图可见），她原话「实测生效了」；`see-now.json` 里落成 `"keepOnTop": false`
    （她的本地配置，不改默认值）
  - 设置卡离屏量宽（`_scratch/probe-settings-card.py`，不作交付物）：456px 卡片里最宽文字右缘 **431**、
    开 / 关两种档 `overflow: none`；修之前那两行右缘是 **467**（`模型能看屏幕（watch / peek / region 都可用）`）
    与 **517**（重启提示）
账：真机重启窗 2 次（99488 → 38900 → 118776；最后一次 20:30:37，约 10 秒进入心跳）；
     `node --test` 3 轮（22.3s / 21.7s / 22.3s）；真机 selftest 6 次（每次 ~0.2s）；
     无鼠标 / 键盘模拟输入（只有 Stop-Process 与配置写盘，没抢光标）
更新：2026-11-27 20:41 CST（格 20:41 说「先别发版」；本轮未动 git，未装 profile）

## 为什么这么做

- **「不想置顶只能折叠」是两条不合适的选择**：折叠本身是一次操作，而且折叠成一条也仍在
  topmost 带里 —— 挡住的窗口还在被挡。
- **关掉必须是「一次撤顶」，不是每 800ms 撤一次**：看门狗原来无条件
  `SetWindowPos(HWND_TOPMOST)`；开关加在判据上之后，关着时只做一次 `HWND_NOTOPMOST`，
  否则一个普通窗口被反复顶起来会闪、也白烧系统调用。
- **顺手堵一个只会在关掉之后出现的 bug**：`_sync_visible`（关窗后再显示）、协议 `show`、
  引用选中文字后回主窗这三处原来各自硬写 `attributes("-topmost", True)`。不收敛的话，
  开关只在「不重新显示、不引用」时成立。`check-topmost-toggle.py` 用一条源码守卫钉住
  「只有看门狗能硬写 `topmost=True`」。

## 口径（定死）

1. **默认开**，且只在 `~/.dsh/see-now.json` 里存（窗自己的开关，不进工具 schema —— schema 顶在
   7500 字符预算上；「全局怎么显示」按 `.40` / `.41` 的先例走配置）。
2. **只认真正的布尔**：`"false"` / `0` / `null` 一律按默认（开）；写错类型宁可多置顶，不能静默
   变成不置顶（看起来像「窗丢了」）。
3. **宿主不报**：`status` 的窗口行不列它 —— 宿主读不到窗里的实时值，写出来只是配置文件的回声
   （同 `.37`）。设置页那一行自己显示当前档。
4. **关掉 ≠ 藏起来**：窗照常画 / 收消息 / 朗读 / 采集；只是不抢 z 序，折叠条同样不置顶。
5. **提示行不拼长**：卡片最窄 456px，10 号字一行放不下四项 + 「保持置顶」；它单独一行。
   守卫 `check-settings-card.py` 会按最窄那一档量所有 text item 的 bbox。

## 留下的东西

- `scripts/check-topmost-toggle.py`：默认开 / 类型写错回默认 / 看门狗只撤一次顶 / 折叠与隐藏不抢 /
  点一下写盘并当场生效 / 重新显示关着时只 lift / 源码守卫。**不起 Tk**。
- `scripts/check-settings-card.py`：withdrawn 的 Tk 根离屏画整张设置卡，量 bbox 判越界；
  没有 Tk / 桌面时 exit 2（`node` 包装测试会 skip）。
- 交接给下一个会话：这版**已提交**但未发版；`install-dev` 未跑（profile 副本仍是 `.43`，但窗从
  `~/.dsh/see-window.json` 直接指本仓那份，功能已生效）。发版时把下面这段贴进 CHANGELOG 开头、
  把 `package.json` / `dsh.plugin.json` 的 version 改成 `.44`，再按发版六步走。

## 发版草稿（`.44` 的 CHANGELOG 段，未提交）

```markdown
## [0.1.1-more.44] - 2026-11-27

### Added — 设置页「保持置顶」开关

- 【本插件设置】多一行「保持置顶」（开 / 关，**默认开**，和加这个开关之前完全一样）：
  关掉后悬浮窗就是普通窗口，别的窗口能压上来，不必再靠「折叠」腾地方；折叠条、重新显示、
  引用后回主窗也都按这个值走，不会被重新焊回最前。
- **点完即时生效**：设置页那一行直接改窗自己的 topmost 属性（`_apply_topmost`）；手改
  `~/.dsh/see-now.json` 的 `keepOnTop` 由看门狗每 800ms 现读（`_settings_cached()` 按
  文件 mtime/size 缓存，不反复解析），两拍内跟上。
- 只认真正的布尔：写成 `"false"` / `0` / `null` 按默认（开）处理（同 `collapsedBubble`），
  不让窗静默变成不置顶 —— 那看起来像「窗丢了」。
- 宿主不报这件事：`status` 的窗口行没有它（宿主读不到窗里的实时值，写出来只是配置文件
  的回声，同 `.37` 的理由）；设置页那一行自己显示当前档。
- 设置卡（【本插件设置】）也跟着这个开关：关掉后它退出 topmost 带（别的应用能盖住），
  但仍是主窗的 owned window —— 点悬浮窗不会把它压住。
- `scripts/selftest-ui.py` 的顶置位检查改成跟 `keepOnTop` 走：开着必须在 topmost 带，
  关着必须不在；关着时「被别的窗口压住」从 WARN 降成 PASS、命中测试降成 WARN
  （那一刻验不了，不是失败）。`dialogs-topmost` 把主窗自己排除（它由第 1 条管）。

### Fixed — 设置卡在最窄宽度下有两行文字被右边界截断

- 卡片最窄 `456px`（窗口 `MIN_W=480` 减 24）时，`模型能看屏幕（watch / peek / region 都可用）`
  右缘到 **467**、「改完插件：点下面重启 DSH（有回合在跑会等它跑完）」右缘到 **517**，
  超出的部分被 Canvas 直接裁掉（文字不折行、不省略）。两句收紧成
  `模型能看屏幕（watch / peek / region）` 与 `改完插件：点下面重启 DSH（等回合跑完）`，
  意思没丢。
- 新增 `scripts/check-settings-card.py`：**不显示窗口**（withdrawn 的 Tk 根 + Toplevel）
  离屏画一遍设置卡，量每个 text item 的 bbox，按最窄那一档判越界；`node --test` 经
  `test/settings-card.test.mjs` 跑它（没有 python / Tk / 桌面的机器 skip）。
  起点是加「保持置顶」时顺手量出来的上面那两行 —— 同一个坑第三次见，这次给它一个会报错的守卫。

### 验收

- `node --test` **534 pass / 0 fail / 0 skip**（新增 `test/topmost-toggle.test.mjs`、
  `test/settings-card.test.mjs`）。
- `scripts/check-topmost-toggle.py`：默认开 / `false` 才关 / 类型写错回默认 / 看门狗只撤一次顶 /
  折叠与隐藏不抢 z 序 / 点一下写盘并当场生效 / 重新显示关着时只 lift / 源码里只有看门狗硬写
  `topmost=True`。
- 真机（4K / 150%，重开窗后）：selftest-ui **9 passed / 0 failed / 5 skipped**；
  `keepOnTop:false` 写盘后 3 秒内 `ex` 从 `0x00080088` → `0x00080080`（WS_EX_TOPMOST 消失），
  selftest 判 `topmost-bit PASS (want NOT topmost)`；删键恢复默认后 3 秒内回到 `0x00080088`。
  设置卡离屏量宽：456px 卡片最宽文字右缘 **431**，`keepOnTop` 开 / 关两种档都没有越界。
```

