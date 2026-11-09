# INSTALL · 给 AI 读的安装单

> 这份是给 DSH 里的 AI 照着执行的，不是给人看的导览；人看 [README.md](./README.md)。
> **第一句：不要用 `dsh plugin add dsh-see-now`。** 那装的是 npm 上的上游，没有聊天窗 / 插队 /
> 历史 / 收藏。本包 `dsh-see-now-more` 没有发布到 npm，只能从源码装。

## 0. 适用范围

- **只保证 Windows 10 + DSH 桌面版 `0.2.2-rc.1`**；其它系统/版本未验证。
- **麦克风输入从未测试**，不要向用户承诺可用。
- 宿主需要已有 `~/.dsh/profiles/desktop`（没开过桌面版就先让用户开一次）。

## 1. 前置检查

```bash
git clone https://github.com/nacivageer/dsh-see-now-more.git
cd dsh-see-now-more
node scripts/install-dev.mjs --check
```

期望看到：

```
profile   : C:\Users\<user>\.dsh\profiles\desktop
dsh-see-now-more: 未安装  bundles 未注册
...
依赖
  python  : C:\...\python.exe  ✓ tkinter/Pillow/mss/numpy
  ffmpeg  : C:\...\ffmpeg.exe  ✓
```

- `python` 行是 `✗`：按提示用同一个解释器 `pip install Pillow mss numpy`，再跑一次 `--check`。
  可选：`pyaudiowpatch`（听声音）、`dxcam`（Windows 截图更快，没有会回退 mss）。
- `ffmpeg` 行是 `✗`：DSH 桌面版自带 ffmpeg，通常在 `~/.dsh/tools/ffmpeg/bin`；
  没有就让用户确认 DSH 安装完整，不要自己下载 ffmpeg。

## 2. 安装

```bash
node scripts/install-dev.mjs
```

期望：

```
已安装。重启 DSH 生效，然后让模型调 `see_now({ action: "watch" })`。
dsh-see-now-more: 已安装  bundles 已注册
```

注意：

- 这是**复制**不是软链；**克隆目录不能删**，删了 profile 里的 `file:` 依赖会坏。
- 如果输出里出现 `⚠ 检测到旧包 dsh-see-now`：先跑
  `node scripts/install-dev.mjs --remove-legacy`，否则两个插件抢同一个 `see_now` 工具。

## 3. 绑定会话（可选）

往 `~/.dsh/see-now.json` 写（UTF-8 无 BOM，保留其它字段）：

```json
{ "session": "session-<当前会话 id>" }
```

- 不写：看图、听声音都正常，但**窗里打的字没人收**。
- 当前会话 id 让用户提供，或取 `~/.dsh/sessions/` 下最新的 `session-*`。
- 改完不用重启（插件 2 秒内热读）。

## 4. 重启 DSH

**必须重启桌面端**，不是新开一个会话（插件树在进程启动时组合）。重启后旧会话下一轮就能看到
`see_now`，宿主还会插一条 `tool-addition` 通知模型。

## 5. 验收

让模型调：

```js
see_now({ action: "status" })
```

期望三行：窗口 / 循环 / 听声音。然后开窗：

```bash
node bin/see-window.mjs
```

## 6. 可选：价格标签

底栏那枚「高峰期 / 半价期」标签是 `window.py` 自己算的，**不依赖 `dsh-price-period`**
（后者是 DSH 标题栏的独立插件，装不装都不影响本包）。

- 默认显示；想关就在 `~/.dsh/see-now.json` 写 `"showPriceChip": false`，重开窗口生效。
- 只想这次关掉：启动窗口时设 `DSH_SEE_PRICE_CHIP=0`。

## 7. 麦克风（求反馈，未验证）

这条路径开发期没有麦克风环境，**没测过**。公开的目的之一就是找有麦克风的人帮忙验证：

1. 打开悬浮窗，点输入栏左边的「麦」图标。
2. 说一句话，看输入框里有没有出字。
3. 没出字：看 `~/.dsh/see-now/mic.log`，把最后 30 行连同这些信息贴到 issue
   （仓库里有「麦克风测试反馈」模板）：
   - Windows 版本、`where python`、麦克风设备名；
   - `see_now({action:"status"})` 的「听声音」行。
4. 出了字：也请说一声——这会是它第一次被验证。

已知坑：

- `mic.py` 默认模型目录是开发机的 `D:/asr-local/models-sherpa`，换机器要传 `--models-dir`
  或改 `~/.dsh/asr.json` 的 `manage.start`。
- 依赖 `sounddevice`：`pip install sounddevice`。
- Windows 设置 → 隐私 → 麦克风 要允许 DSH 使用。

## 8. 失败分支

| 现象 | 先看 |
|---|---|
| 窗起不来 | `~/.dsh/see-now-window-error.log`、`~/.dsh/watch-window-error.log` |
| 插件没加载 / 工具表里没有 `see_now` | `~/.dsh/see-now/plugin-error.log`，再确认已重启 |
| 窗口打开但全黑 | macOS 没给屏幕录制权限；Windows 上检查是否锁屏 / UAC |
| 没有台词 | 缺 WASAPI 回环或 ASR，不是 bug；看 `status` 的「听声音」行 |
| 窗里发的字没人回 | 没绑定会话，见第 3 步 |

## 9. 卸载

```bash
node scripts/install-dev.mjs --remove
```
