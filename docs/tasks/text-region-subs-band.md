<!-- 来源：格 2026-11-27 19:0x 的问题（「读字幕居然要全屏看视频」「更早的版本做过框选区域读字幕」）
     + 19:1x 拍板「按方案 A 写任务书」。只写文档，没动代码。 -->

# 字幕框：`text.region` —— 框一条字幕行，不再要求全屏

状态：可验收（`.42` 已发版 `v0.1.1-more.42`；两种画面都真机验过：4K 窗口化文字 19:27、真视频字幕 19:36）
对象：让「读字幕」能框住屏幕上一行字幕来读，而不是只读整屏底部 20%。窗口化播放的视频也能读；
     `watch` 抓哪块**不受影响**（`region.json` 一个字都不动）。
归属：session-23ac3c7e-8528-43c1-8915-49fcada193cc / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：无（已收口）。可选后续：`preset:"subtitle"` 出的长条图要不要共用同一个字幕框。
证据：
  - 现状互斥：`src/runner.js:1228` 只有 `!src.region` 才把帧喂给文字流 —— 设了 region 就静默不读
  - 条带默认：`src/text-band.js:26` `band: [0.80, 1.0, 0.10]`，**是整帧的比例**，不是屏幕坐标
  - 条带裁剪：`src/text-stream.js:129` `bandRect(width, height, cfg.band)`；`width/height` 是管线帧尺寸（如 798×450）
  - README 的限制句：`README.md:570`「它只读屏幕底部那条……全屏播放才有效」
  - 手框当年是**主动推迟**的：`docs/tasks/text-event-stream.md:55`「条带先用分数配置，手框留 P1.5」
  - 早年的「框选读字幕」**不在插件里**：`docs/tasks/sensevoice-cer.md:67-68` —— `H:\asr-local\live-subs.py --rect`
    做真值 OCR，借 `see_now({action:"region"})` 标定，结果写 `subs-band.json`，还特意写了「别留在 region.json」
  - 采集把整屏 `scale` 到画布、**不裁不补**：`src/capture.js:215`；所以「屏幕像素 → 帧内比例」是线性的
    （`fx = x / sw`）—— 这是整个方案成立的前提，换采集引擎要先复核
  - 取框脚本手里就有主屏物理尺寸：`examples/floating-chat/pick_region.py` 的 `sw, sh`（DPI aware），
    但 stdout 只吐 `{x,y,w,h}`
  - 热更先例：`src/index.js:1257` 改 `text.fps` 即时生效 → `src/runner.js:1557` `setTextFps`
  - schema 预算：`test/tool-spec.test.mjs:33` `SPEC_BUDGET_CHARS = 7500`；本轮实测 **7499**（只剩 1 字符）
  - 实现后：`node --test` **528 全过**（新增 `test/text-region.test.mjs` 13 条）；假 ctx 路由
    （`for:"screen"` 被拒、`for:"text", region:"off"` 只删 `text.region`）
  - 真机（4K / 150% 缩放，**窗口化**的 DSH 窗口、没最大化）：框 (1580,630) 350×360 →
    侧车命令行 `--w 350 --h 360 --canvas-h 720`；`status` = `读数中 · 字幕框 1580,630 350×360
    （主屏 3840×2160） · 入流 6 / 已送 OCR 10 帧`；`watch` 结果带回 6 行 OCR 文本。清框后回到条带。
  - 真视频（2026-11-27 19:36，交接 19:31 第 1 条补验）：`_scratch/bili-p2-1080p.mp4`（B 站
    `BV1eS1czoEaD` p2，1920×1080）用 `ffplay -loop 0 -fs -an` 全屏循环 → 框 (844,1695) 2296×379
    → 侧车 `--w 1600 --h 264 --scale 2 --canvas-h 528`（2296 被上限 1600 截、高按比例 264）；
    `status` 入流 16→36 / 已送 OCR 146 帧；12 行台词里 8–9 行整句通顺（条带同期把「亻门的世界」
    这类读歪了）；清框后回「条带 80–100%」。
账：真机 4 分钟 ffplay 全屏 + 采集（2026-11-27 19:36–19:40），测完已停、已清框
更新：2026-11-27 19:39 CST

## 为什么要做（问题不是"神秘"，是真漏了一块场景）

文字流（字幕 OCR）现在的取字范围 = **被抓那一帧**的底部 20%（`text.band`）。三条路各有各的别扭：

| 用法 | 结果 |
|---|---|
| `watch` 整屏（默认） | 只有字幕落在**屏幕**底部才读得到 → 全屏播放才行 |
| `watch` + `source:"window"` + 标题 | 窗口化也能读，但每次调用都要模型自己带 `source` / `window`，没有粘性 |
| 设了 `region`（拖框） | **完全不读**（`!src.region` 把文字流关了），`status` 还照旧显示条带比例 |

而插件里**已经有**拖框 UI（`region` / 血条），字幕却只认屏幕底部 —— 等于把「窗口化看视频」整类场景
关掉了。当年的 `subs-band.json` 思路正好补这一块，只是那次没进插件。

## 口径（方案 A，定死）

1. **配置存在 `~/.dsh/see-now.json` 的 `text.region`**，形状是**主屏物理像素 + 取框时的主屏尺寸**：
   ```json
   {"text": {"region": {"x": 1811, "y": 1380, "w": 1417, "h": 315, "sw": 2560, "sh": 1440}}}
   ```
   写像素而不是比例：人能看懂、能手改；`sw/sh` 是取框那一刻的屏幕尺寸，用来换算成帧内比例
   （`fx0 = x/sw`、`fx1 = (x+w)/sw`、`fy0 = y/sh`、`fy1 = (y+h)/sh`）。
2. **优先级：`text.region` > `text.band`**。没配 `region` 时行为与现在一字不差（老配置继续有效）。
3. **只对「整屏采集」这条路生效**。所以：
   - `region` 模式：文字流本来就不喂帧（`!src.region`，现状保持），`status` 要把这个原因说出来；
   - `window` / `file` 源：帧是窗口/视频画面（不是屏幕坐标），`text.region` 无意义 → **忽略它、继续用底部 20% 的 `band`**；
   - 只有 `screen` 且没设采集区域时，`text.region` 才是"从整屏帧里裁这一块"。
4. **只写字幕框，不碰采集**：`region.json`（watch 抓哪块）与 `bloodbar.json` 都不动；
   框完 `watch` 照旧整屏 —— 这正是当年那条提醒（「别留在 region.json，否则 watch 只截字幕条」）。
5. **热更**：框完下一帧就按新矩形裁，不用重开 DSH（`setTextFps` 的先例）。
6. **换算失败就退回 `band`**：`text.region` 缺 `sw/sh`、坐标越界、宽高 < 8px → 记一条 warn，按老 `band` 走。
7. **（开工后订正）字幕框那一路要单独起一路原生分辨率的采集**：原设计是「从 `watch` 的帧里裁」，
   真机一跑就露馅 —— 4K 屏 + `low` 档的帧只有 798 宽，350×360 的框裁出来只剩 **73×75**（字高 5px），
   侧车收到 `--w 73 --h 75`，两帧全空、`status` 只报「入流 0」。改成一路 `gdigrab` 只抓这块
   （5 fps 供帧、按 `text.fps` 抽帧、尺寸上限 1600），帧直接喂文字流；`fx = x / sw` 只留给
   「采集起不来时从帧里裁」的退化路径。和血条读数同一个套路。

## 工具入口（已定：`for:"text"`，2026-11-27 19:0x 格选 1）

- **`see_now({action:"region", for:"text"})`（采用）** —— 新参数 `for`，语义直白：这次框的是字幕，不是抓取区域。
  代价：schema 约 +130 字符，而预算 **7499 / 7500**，必须同笔删 ≥130 字符。
  删长文是规则允许的方向（`docs/决策记录.md`「工具契约的体积预算」：超了先删长文，再谈加参数）；
  实际从 `region` / `window` / `source` / `preset` / `task` 五段删掉等量描述，落完 7464 / 7500。
- （备选，未采用）`see_now({action:"region", region:"text"})` —— 复用已有字符串参数当哨兵，
  省预算但把 `region` 变成三态，语义会长期歧义。

## 实现步骤（按文件）

1. `examples/floating-chat/pick_region.py`：stdout 加 `sw` / `sh`（`{"x","y","w","h","sw","sh"}`）。
   向后兼容：老 Node 只读四个键；`saveRegion` 只写四个（`region.json` 形状不变）。
2. `src/region.js`：`runPicker` 校验并保留 `sw/sh`；新增 `saveTextRegion(region, env)` /
   `loadTextRegion(env)` / `clearTextRegion(env)` —— 写 `~/.dsh/see-now.json` 的 `text.region`，
   走 read-modify-write + tmp+rename（照 `index.js` 的 `saveModePref`），**UTF-8 无 BOM**。
3. `src/text-band.js`：`normalizeTextConfig` 加 `region` 校验（四个非负整数 + `sw/sh` 正整数 +
   `x+w ≤ sw`、`y+h ≤ sh`、`w/h ≥ 8px`），坏值 warn 并丢弃；再加唯一一份换算：
   `rectFromRegion(region, width, height)` → 帧内像素矩形（`fx = x/sw`，`round` 后夹在帧内）。
4. `src/text-stream.js`：`onFrame` 里整帧模式 / 按框裁 / 按条带三分支（两个开关：
   `wholeFrame` = 送来的帧本身就是框、`regionAllowed` = 这个采集源配不配用框）；
   新增 `setRegion` / `setWholeFrame` / `setRegionAllowed` / `setIntake`；`status()` 报当前用哪一块。
   sidecar 尺寸变化不用新逻辑：`ensureOcr` 的 key 是 `w×h/scale/lang`，尺寸一变自动重启。
5. `src/runner.js`：**配了字幕框就单独起一路采集**（`startTextCapture`：`gdigrab` 只抓那块、
   原尺寸、5 fps 供帧，`run.done` 退出时退回条带）；`teardown` 里一起停；
   `setTextRegion` 热更（正在看会立刻换那一路）；窗口 / 文件 / region 源不走这条路。
6. `src/index.js`：`action:"region"` 分支加 `for:"text"` → `pickRegion({hint:'框住字幕那一行
   （只给读字幕用，不改 watch 抓哪块） · 松手确认 · Esc 取消', save: saveTextRegion})`；
   成功文案要说三件事：只影响字幕、`watch` 照旧整屏、模糊了重框一次。
   `region:"off"` + `for:"text"` → 删 `text.region`（两套互不牵连）。
7. `status`「屏幕文字」行：整屏 + 配了框 → `字幕框 x,y,w×h`；其他源 → 说明**按底部条带读**
   （不是框）；`region` 模式 → 写明「region 模式不读」，**不能再显示一条假的比例行**。
8. `src/tool-spec.js`：按选定入口改描述，**同笔删够字符**让预算过（`test/tool-spec.test.mjs` 会拦）。
9. 文档：README「读字幕」一节改写（框一行；窗口化也能读；与 `watch` 区域互不影响）+ `see-now.json`
   表加 `text.region`；CHANGELOG + `docs/决策记录.md` 各一条。

## 迁移（老用户不受影响）

- `text.band` 继续有效；`text.region` 缺省时行为与现在一字不差。
- `region.json` / `bloodbar.json` **不动**；框字幕不会让 `watch` 只截字幕条。
- 升级后 `text.region` 是热更的（框完下一帧生效），不用重开 DSH。
- 已经框过采集区域的人：升级后 `status` 会多一句「region 模式不读字幕」，不再默默无字。

## 验收

- 单测：`rectFromRegion` 在 1080p / 1440p / 4K / 非 16:9 下的换算（与 `x/sw` 一致）、越界夹取、
  `sw/sh` 缺失退回 `band`、优先级、`saveTextRegion` 的 read-modify-write 不丢别的键、
  `status` 四种文案（字幕框 / 按条带 / region 不读 / 关着）、`setRegion` 后 sidecar 按新尺寸重启。
- 真机：窗口化的 B 站视频（**不最大化**）→ 框字幕行 → 唤醒里出现台词；清掉框 → 回到整屏底部条带；
  同一时间 `watch` 抓出来的图仍是整屏。
- `node --test` 全过；本方案默认不碰 `window.py`，所以 `selftest-ui.py` 只作回归跑一遍。

## 风险

- **分辨率/缩放变了旧框会偏**：`sw/sh` 与当前屏幕不一致时位置会漂；`status` 打出框坐标，重框一次即可，
  不自动跟随。
- **多屏 / 虚拟桌面**：沿用现有「只支持主屏」边界；`sw/sh` 是主屏尺寸，若采集实际抓的是虚拟桌面，
  比例会偏 —— `status` 把 `sw/sh` 一起报出来便于核对。
- **框太紧**：只框到半行时 OCR 只吐半句，`minChars` 可能把它挡掉；文案提示「框松一点，包含整行」。

## 不做

- 不做自动跟随字幕位置（要视觉检测，另一件事）。
- 不改 `preset:"subtitle"` 出的长条图（那是给眼睛看的；要不要共用同一个框，下一版再看）。
- 不做多框、多语言、自动判断「哪一行是字幕」。
- 不碰 `window.py`。

## 日志

- 2026-11-27 19:13 新建（等你定）。依据：三条路、两次历史记录、采集缩放方式、schema 预算都逐条核过
  （见「证据」）；本轮只读代码 + 写这份文档，没动代码。
- 2026-11-27 19:1x 格选「1」（`for:"text"`）→ 开工：`text.region` 归一化 / `rectFromRegion` /
  `textRectOf` / 文字流三分支 / region 路由的 `for` 分支 / picker 多吐 `sw/sh` / schema 加 `for`
  并从五段删够字数（7464 / 7500）。
- 2026-11-27 19:2x **真机第一跑就露馅**：`status` 显示「入流 0 / 已送 OCR 2 帧」，侧车命令行是
  `--w 73 --h 75` —— 框是从 798×450 的 watch 帧里裁的，4K 屏上 350×360 只剩 73×75，字高 5px。
  修：字幕框单独起一路 `gdigrab` 原生采集（5 fps 供帧、上限 1600），文字流加 `wholeFrame` /
  `regionAllowed` 两个开关；窗口 / 文件源一律按条带读。
- 2026-11-27 19:27 真机重验通过（宿主 106416 → 100640）：侧车 `--w 350 --h 360`，
  `status` 入流 6 / 已送 OCR 10 帧，`watch` 带回 6 行框内文字；清框后回到「条带 80–100%」。
  `node --test` 528 全过。测完已把 `text.region` 清掉、采集停掉。
- 2026-11-27 19:36–19:40 **真视频字幕补验**（交接 19:31 第 1 条）：同一份素材 `ffplay -loop 0 -fs -an`
  全屏循环，按字幕行框 (844,1695) 2296×379。`text.region` 落盘带 `sw/sh`（3840/2160），侧车按
  上限起成 `--w 1600 --h 264 --scale 2`；入流 36、台词整句可读，明显好于条带期。清框即回条带。
  测完停 ffplay、停采集、清掉框，没留残状态。
