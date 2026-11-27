<!-- 来源：格 2026-11-27 20:52 的截图 + 一句「呃，设置页不受【保持置顶】的控制吗」——她已把
     「保持置顶」关掉，但【本插件设置】那张卡仍压在所有窗口最上面。 -->

# 设置卡也跟随「保持置顶」（owned window + 跟随开关）

状态：**已实现、单测过；真机等格开卡看一眼**（窗 20:51:48 在 `keepOnTop=false` 下重启，
      `selftest-ui` 判主窗 `ex=0x00080080`、9 passed；与拖动修复同一笔待提交）
对象：【本插件设置】那张 Toplevel 原来无条件 `attributes("-topmost", True)`，所以「保持置顶」关掉后
      它还是压在所有应用上面。现在它跟着开关走，同时保持「排在自己主窗上面」。
归属：session-e3da6a5f-3cb4-4dd5-861d-5964a647dbb9 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：格在「保持置顶 = 关」时打开设置卡：①别的应用能盖住它；②点自己的悬浮窗不会把它压住。
      不对劲就回来改（`transient` 这条只有真机能看出来）。
证据：
  - `examples/floating-chat/window.py:9462` `_open_settings`：`win.transient(self.root)`（owned window）
    + `win.attributes("-topmost", keep_on_top_enabled(...))`（开卡时按当前配置）
  - `:1353` `_apply_topmost`：切开关时**同时**把卡切到同一档，再 `lift()` 一次卡（开置顶那一瞬
    主窗可能先跳到卡上面）
  - 离线：`scripts/check-topmost-toggle.py` 新增 `test_card_follows_toggle`（关 → 卡也 `-topmost False`
    且被 lift；开 → 卡也 `True`）→ `check-topmost-toggle: all passed`
  - `node --test` 534 pass / 0 fail；`check-settings-card.py` 仍 all passed
  - 真机：窗 20:51:48 重启（pid 119156，`keepOnTop=false`），`selftest-ui.py` 判主窗
    `ex=0x00080080`（未置顶）、**9 passed / 0 failed / 5 skipped** —— 启动时按配置走这条已验；
    卡片自身的 z 序（owned + 跟随）要开卡才看得到，待格验
账：重启窗 1 次（117344 → 119156）；离线测试 2 轮；无鼠标 / 键盘模拟输入
更新：2026-11-27 20:53 CST

## 为什么这样改

- **「保持置顶」是这张卡的父窗的属性，卡不该反着来**：关掉置顶是为了「别的窗口能盖住我」，
  卡还钉在最上面就自相矛盾。
- **但要 owned（`transient`），不能只是普通 Toplevel**：普通 Toplevel 在关掉 topmost 后，
  点一下悬浮窗就会被自己的主窗盖住（设置卡在改选项，主窗一被激活就把卡压下去）。owned window
  在 Windows 上永远排在 owner 上面，点主窗不会压住它；owner 不再是 topmost 时，卡也一起能被
  别的应用盖住 —— 正好是想要的两层语义。
- **打开那一刻按当前配置**：`keep_on_top_enabled(self._settings_cached())`，不写死 True。
- **切开关那一刻也跟着切**：`_apply_topmost` 里顺带改卡；否则在卡里把「保持置顶」点成关，
  卡自己还压在所有窗口上面，看起来就是开关没生效。
- 回顾窗 / 图片查看器 / 确认框**这次没动**：它们也是无条件的 topmost，但归属「临时弹窗」，
  真遇到同样体感再一起改（见「留给下一个会话」）。

## 留给下一个会话

- 若要「所有弹窗都跟随」：把这批 `win.attributes("-topmost", True)`（回顾窗 / 图查看器 / 菜单 /
  确认框 / 删除确认）统一改成 `transient(self.root)` + `keep_on_top_enabled(...)`。改动面比设置卡
  大（~8 处），而且图查看器 / 确认卡依赖 topmost 显示在自己的窗上面，只有 owned 关系能替代，
  得逐个真机确认，别一次扫。
