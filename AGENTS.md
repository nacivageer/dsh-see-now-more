# see-now-more 工作区

动手前先读 `docs/决策记录.md`：做什么、不做什么、发版六步都在那里。

发版（打 tag / Release）前先核文档：这一版改到的行为 / 参数 / 数字有没有落进 `README.md` 和
`src/tool-spec.js`（模型看到的 schema）；**这一版没有对应改动也要核一遍再往下**（发版六步的第 1 步）。

改到窗口的代码（`examples/floating-chat/window.py`、`src/window.js`、`src/index.js`
里碰窗口 / 置顶 / 穿透的部分）之后，跑两条：

```
node --test                       # 逻辑单测；版本、插件名、CHANGELOG 三条守卫也在这
python scripts/selftest-ui.py     # 悬浮窗的 Win32 不变量；要求窗口开着，退出码 2 = 没开
```

第二条读的是窗口状态（置顶位、无边框、命中测试、同进程弹窗是否都在 topmost 带、
单飞、位置、配置形状），**不发输入、不碰光标**。它末尾那 5 项——hover、拖拽、
端到端点击穿透、IME、pointer 的等待信号——只能真发输入，攒成一批一次做完，
不要每改一处就抢一次鼠标。

**真发输入（鼠标 / 键盘）之前，先用 `see_now` 的 `say` 发一条语音提醒**：借什么、
大概几秒、让她先别碰。共用同一只鼠标，模拟点击 / 拖选会被真人操作打断；不提醒就是
无声抢鼠标。（规则源：`~/.dsh/memory/profile.md` 的 2026-11-27 [user-stated] 条）

能读窗口状态答的问题，不要用"点一遍看看"来答。

**折叠态的窗拍不到，别对着真窗连抓**：收起那一下会常开 `WDA_EXCLUDEFROMCAPTURE`，截图里整窗
消失（`capturable: true` 也压不住；展开态才按它决定）。要验折叠条 / 气泡，另开隔离实例带
`DSH_SEE_WDA=0`（+ `DSH_SEE_REFRESH=99` 更稳）；只验状态就跑上面那条 `selftest-ui.py`，它不抓屏。
机制与判据：`docs/决策记录.md`「收起态的窗抓不到」。
