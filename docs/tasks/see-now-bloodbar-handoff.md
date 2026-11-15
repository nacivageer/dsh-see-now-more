# 血条线（黑听读数）交接 — 2026-11-16

> 代码在 `see-now-more`，任务书在 `see-now/docs/tasks/see-now-audio-cluster.md`。
> 读这一页就够接手；机制全文在那份任务书里。

## 一句话现状

**采集、报告、被遮挡读取都已经跑通并在真机验过；「读数准」这一项在低血时失败**——
不是 bug，是像素法的原理局限：鸣潮掉到低血时血条从白变成**暗红**，亮度和背景分不开。
下一步要么上 OCR 读框里的 `当前/最大`，要么重做成「与背景的色差」。

## 已经能做的（真机验过）

- **框选**：`see_now({action:"bloodbar"})` 拖框 → `~/.dsh/see-now/bloodbar.json`
  （`region` / `threshold` / `window`）。也支持直给 `region:"x,y,w,h"` + `threshold` + `window`，热更新不重启。
- **读数**：`ratioFromPixels(mode:"band")`——找亮行带 + 列亮比例扫填充端点。
  单次读 `read:true`（抓一帧、不出图、不记账）；进仅监听后 1 fps 常驻，读数进 3 分钟轨迹。
- **报告（P2）**：`runner.bloodbarNote()` 一行
  `血条 64%（低于阈值 30%）· 30 秒前 70% · 近 60 秒 64–90% · 上次低血 00:06:20`，
  接在三处：① 音频 / lift 唤醒文案末尾；② `watch` / `peek` 结果；③ `status`。
  **它不是触发器**：不调 `wake()`、不占 `listenGap`。要不要抬头由模型自己决定 ——
  2026-11-15 用户否掉过「低血唤醒」，理由是三人队切人 / 奶妈 / 免死会让低血只出现一小会。
- **按窗口抓（WGC）**：`bloodbar.json` 配 `window:"云·鸣潮"` 就走 `py/wgc_capture.py`
  （`windows-capture` 包，BGRA rawvideo 到 stdout），**被别的窗口挡住、失去焦点也能读**。
  实测：置顶黑窗盖住血条时窗口抓 `ratio=1`、屏幕抓 `ratio=0`。
  `watch` 时**不停**这条（`start()` 里只对 gdigrab 停），否则一看画面读数就冻结。

## 未解决：低血时读数不准（最重要）

2026-11-16 00:3x 实测，屏幕 `882/20725 = 4.3%`，算法给 **11%**。同一帧像素统计：

| 区域 | 平均 RGB | 亮度 V |
|---|---|---|
| 最左 24 列（红色填充） | (98, 52, 55) | **0.38** |
| 24–90 列（未填充背景） | (58, 57, 68) | 0.27 |
| 95–205 列（数字白字） | (117, 119, 132) | 0.47 |

三件事叠在一起：① 填充变暗红，`V ≥ 0.55` 的门槛把它当背景；② 数字白字比填充更亮，抢端点；
③ 右端 `Lv.90` 的白字也会抢端点（这一条已用「连续暗列」修掉）。

**方向**：优先 OCR 读框内数字（Windows.Media.Ocr，框只有 421×16，1 fps 跑得动），
它解决的是「读数准」本身，还能防「条被特效遮住」。色差法次选——暗红与暗紫灰的距离只有 42，阈值难定。

## 待办（按优先级）

1. **低血读数**（上面那条）。
2. **窗口移动会让框失效**：`region` 存的是**屏幕坐标**，窗口一挪就指向别处（2026-11-16 实测：
   窗口从 x1267 挪到 x1428，框还停在旧位置，抓到的是场景）。两个修法二选一：
   存窗口内相对坐标，或框选时记下窗口 rect、运行时换算。
3. **glance 记录只在仅监听时落**：`maybeGlanceBloodbar()` 在 `loop.js` 的 `listen` 分支里；
   看画面（`active`）时不记。这是设计，但如果要在「看画面时也复盘」，得另外落一条。
4. **换游戏验证**：浅色 HUD 的游戏框一次就能用；换游戏 / 换 UI 缩放要重框。
5. **阈值**：默认 30%，只是报告里「低于阈值」那半句的分界线。

## 边界

- 不改 `window.py`、不改 lift 四档、不动 `lift.jsonl` 已有字段语义。
- **血条永远不叫醒模型**。想加「低血提醒」要先过用户那一关。
- 最小化时 WGC 也拿不到帧；D3D 独占全屏 WGC 抓不到（那时游戏必然前台全屏，走 ddagrab）。
- 常驻采集起不来只记 `status().bloodbar.error`，不拖垮听声音。

## 踩过的坑（别再踩）

- **`file:` 安装是拷贝**：改了 `src/` 不跑 `node scripts/install-dev.mjs` 不生效；`--check` 只比版本号、
  不比内容。改完就装，**再重启 DSH**（插件树是进程启动时组合的）。
- **端点不能取「最后一个强填充列」**：右端 `Lv.90` 白字亮度过 `strongFill`，right 被拉到框边，
  69% 读成 99.8%（`d4c4e2a` 已改成「连续 6 列低于 0.5 才算到头」）。
- **验证脚本别写死坐标**：窗口挪了 161px，脚本还框着旧位置，抓到场景会被误读成「算法把血条读成 gone」。
- `windows_capture/__init__.py` 顶层 `import cv2`：sidecar 塞 `sys.modules['cv2']` stub 绕开；
  `resolveWgcPython()` 的探针必须带同样的 stub，否则出现假阴性。
- `draw_border=False` 在 Win10 会抛异常，别传。
- `pick_region.py` 的 `MIN_SIDE` 原为 24，血条只有 10–20px 高，**松手永远不确认**（已降到 8）。
- `capture.js` 的 `isDda()`：带 region 的屏幕源会被误判成 ddagrab，gdigrab 的 bgr0 过不去
  （`Function not implemented`）。带 region 一律不走 dda、同尺寸不缩放、输出 BGRA。
- **框必须盖住整条**：只盖左半时端点法会给出 100% 的假读数。

## 相关

- 任务书：`see-now/docs/tasks/see-now-audio-cluster.md`
- 代码：`src/bloodbar.js`（纯函数）、`src/bloodbar-capture.js`（单次读）、`src/capture-window.js`（WGC）、
  `py/wgc_capture.py`（sidecar）、`src/runner.js`（bloodbar 段）、`src/loop.js`（`maybeGlanceBloodbar` / `bloodbarTail`）
- 测试：`test/bloodbar.test.mjs`（176 条全量里含 band 模式、端点、简报、配置读写）
- 提交：`see-now-more` `d4c4e2a`（HEAD）
