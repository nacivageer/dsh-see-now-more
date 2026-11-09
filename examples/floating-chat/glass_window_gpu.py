"""GPU 版悬浮窗入口：`python glass_window_gpu.py`。

这里只是把后端切成 GPU 就交给 `window.py` —— UI、交互、聊天流、状态机全部是
同一份代码，不存在「GPU 版另一个窗口」这种东西。

需要 `moderngl` 和 OpenGL 3.3+：

    pip install -r requirements-glass.txt moderngl

没有 moderngl 时 `window.py` 会打印一行原因并回落到 CPU，窗口照样能开
（而不是像 0.2.10 之前那样每帧抛一次 `GPU capture failed` 刷屏）。

`DSH_GLASS_NATIVE=1` 让采样走全分辨率（边缘透镜没有 1/4 放大的像素感）。
正常使用时不需要手动跑这个文件：插件会拉起 `window.py`，设 `DSH_GLASS_GPU=1`
或 `DSH_GLASS_NATIVE=1` 即可切到 GPU。
"""
import os

os.environ.setdefault("DSH_GLASS_GPU", "1")

import window  # noqa: E402  (必须先设环境变量：后端在 import 时确定)

if __name__ == "__main__":
    window.LiveGlass().run()
