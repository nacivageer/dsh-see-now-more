"""兼容层：早期 PR #15 的窗口模块名是 `glass_window`。

窗口后来改名 `window.py`（交互补全都在里面），但社区脚本和 GPU 入口还按
`import glass_window as G` 找它。这里用动态代理转发，不再 `from window import *`
—— 那样会在导入时复制一份全局量，窗口缩放后 GPU 仍拿旧坐标合成。
"""

import window as _window


def __getattr__(name):
    return getattr(_window, name)
