# see-now-more 工作区

动手前先读 `docs/决策记录.md`：做什么、不做什么、发版六步都在那里。

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

能读窗口状态答的问题，不要用"点一遍看看"来答。
