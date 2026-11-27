<!-- 来源：格 2026-11-27 20:52 的截图 + 「呃，设置页不受【保持置顶】的控制吗」，以及随后那句
     「要统一」——所有临时弹窗也跟随「保持置顶」。 -->

# 弹窗统一跟随「保持置顶」（Win32 owner + 跟随开关）

状态：**已验收、已随 `.44` 发版**（tag `v0.1.1-more.44` → `5bc83f8`；格 2026-11-27 21:03
      三张截图实测）
对象：8 个 Toplevel（设置卡 / 回顾窗 / 图查看器 / 清理确认 / 删除确认 / 重命名 / 关窗确认 /
      右键菜单）原来一律无条件 `attributes("-topmost", True)`，所以「保持置顶」关掉后弹窗
      仍压在所有应用上面。现在统一走 `_dialogs_topmost(win)`：跟随开关 + 设 Win32 owner。
归属：session-e3da6a5f-3cb4-4dd5-861d-5964a647dbb9 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：无（真机已验证）。
证据：
  - 统一入口：`examples/floating-chat/window.py:10549` `_dialogs_topmost(win)`；8 个弹窗全部
    改走它（`_open_settings` / 回顾窗 / 图查看器 / 清理 / 删除 / 重命名 / 关窗确认 / `_menu_popup`）
  - Win32 owner：`:10576` `_own_dialog(win)` —— `SetWindowLongPtrW(GWLP_HWNDPARENT)`
  - 旧的两处强制顶：`_force_topmost` / `_pin_topmost` 在关掉置顶时直接返回（不再排下一拍）
  - **为什么不用 Tk 的 `transient`**：探针实测——正常 Toplevel `transient(root)` 后
    `GetWindow(GW_OWNER)` = 主窗顶层 HWND；`overrideredirect(True)` 的窗是 **0**（Tk 不给它设
    owner），而且 master 没映射时窗口会迟迟不 map。所以自己设 `GWLP_HWNDPARENT`
  - 探针（`_scratch/probe-owner-set.py`）：手工设完 `GW_OWNER` 等于主窗，主窗 `lift()` 后
    z 序里弹窗仍在主窗上面
  - 离线：`scripts/check-settings-card.py` 新增 `test_dialog_owner`（真 Win32：owner 等于主窗；
    `keepOnTop=false` 时弹窗无 `WS_EX_TOPMOST`、`true` 时有）→ **all passed**；
    `scripts/check-topmost-toggle.py` 的源码守卫新增「弹窗不许硬写 topmost=True、
    `_dialogs_topmost` 调用点 ≥ 9」→ **all passed**
  - `node --test` **534 pass / 0 fail / 0 skip**
  - 真机：窗 21:00:29 重启（pid 120640，`keepOnTop=false`），`selftest-ui.py` 判主窗
    `ex=0x00080080`（未置顶）、**9 passed / 0 failed / 5 skipped** —— 启动时按配置走这条已验
  - **格实测（2026-11-27 21:03，三张截图）**：设置卡的下半被 DSH 主窗盖住；回顾窗压在
    悬浮窗上面（截图里它盖住悬浮窗右上）；两者之间按打开/点击顺序叠，没有「弹窗反过来
    压住别的应用」——两层语义都成立
账：重启窗 1 次（119156 → 120640）；探针 4 个（owner / z 序 / map / topmost-vs-owner）；
    离线测试 3 轮；无鼠标 / 键盘模拟输入
更新：2026-11-27 21:04 CST

## 为什么这样改

- **「保持置顶」关掉 = 不想让这层 UI 压着别的应用**，弹窗属于这层 UI；只关主窗不关弹窗，
  等于开关只做了一半（格的原话是「设置页不受保持置顶的控制吗」，接着要求统一）。
- **但弹窗不能变成普通窗**：普通 Toplevel 在关掉 topmost 后，点一下悬浮窗就会被**自己的主窗**
  盖住（设置卡在改选项，主窗一激活就把卡压下去）。Windows 的 owned window 永远排在 owner
  上面，正好是「不压别人、只压自己的主窗」这两层语义。
- **Tk 的 `transient` 靠不住**：只对非 override 的窗设 owner；这批弹窗全是
  `overrideredirect`，实测 owner=0。所以 `_own_dialog` 自己调 `GWLP_HWNDPARENT`（映射后 60ms）。
- **两个旧看门狗跟着让路**：`_force_topmost`（确认框每 400ms 硬顶）在关掉置顶时直接返回，
  `_pin_topmost` 不再排下一拍 —— 否则等于把开关废掉。

## 已知边界

- ~~**只对新开的弹窗生效**~~（2026-11-27 晚已补）：已经开着的弹窗现在会跟着翻面 ——
  弹窗在 `_dialogs_topmost` 里登记进 `self._dlgs`，翻面时 `_follow_dialogs_topmost()`
  一起改档（关 → 退出 topmost 带；开 → 进带 + 补一条 pin 链，`_see_now_pin` 防叠第二条）。
  验收：`check-topmost-toggle.py` 的 `test_open_dialogs_follow`。
- owner 关系只在 Windows 上验过；`overrideredirect` 窗被系统最小化/隐藏时 owner 的行为没验
  （这扇窗没有系统标题栏，正常路径不会最小化）。
- 独占全屏下仍然盖不上（和主窗同一条边界）。

## 发版草稿（已随 `.44` 发版；正文以 `CHANGELOG.md` 为准，这里留作任务记录）

```markdown
### Fixed — 弹窗统一跟随「保持置顶」

- 设置卡、回顾窗、图查看器、清理 / 删除 / 重命名 / 关窗确认、右键菜单这 8 个弹窗原来一律
  无条件置顶，关掉「保持置顶」后仍压着所有应用。现在统一走 `_dialogs_topmost()`：置顶开着时
  进 topmost 带（和以前一样），关着时退出 topmost 带、别的应用能盖住它。
- 弹窗同时是主窗的 **owned window**（Win32 `GWLP_HWNDPARENT`）：关掉置顶后点悬浮窗不会把
  弹窗压住。**没用 Tk 的 `transient`** —— 实测它对 `overrideredirect` 的窗根本不设 owner。
- 确认框的 400ms 硬顶（`_pin_topmost`）在关掉置顶时停手，不再排下一拍。
- 守卫：`check-settings-card.py` 新增真 Win32 的 owner / topmost 位检查；`check-topmost-toggle.py`
  加源码守卫（弹窗不许硬写 `topmost=True`，`_dialogs_topmost` 调用点 ≥9）。
```
