<!-- 来源：格 2026-11-27 19:5x 定「写任务书」。问题出在：窗口化播放时 `preset:"subtitle"`
     只取屏幕底部 16%，而字幕在窗口底部、屏幕上那条是桌面。只写文档，没动代码。 -->

# 字幕条带图认字幕框：`preset:"subtitle"` 按 `text.region` 裁

状态：等你定（口径已定死，两处默认值见「待定」，格点头就开工）
对象：让 `see_now({preset:"subtitle"})` 出的长条图**跟着 `text.region` 走**——用户框一次字幕行，
      OCR 和长条图都对上；窗口化播放时也能出对图。不设框 / 窗口源 / 文件源时行为完全不变。
归属：session-8cf3c4c4-c2cf-4dc8-bd31-702697f46ef0 / `C:\Users\Administrator\Documents\deepseek-harness\see-now-more`
下一步：格拍板「待定」两条 → 开工（`src/pipeline.js` + `src/index.js` + 单测 + 一行 schema 描述）
证据：
  - `preset:"subtitle"` 现在固定帧比例带：`src/index.js:175` `SUBTITLE_BAND = [0.84, 1.0, 0.10]`
  - 框存的是屏幕像素 + 取框时的屏幕尺寸：`see-now.json` 的 `text.region = {x,y,w,h,sw,sh}`
  - 换算已有唯一实现：`src/text-band.js:80` `rectFromRegion(width, height, region)`
  - 换算前提：采集把整屏 `scale` 到画布、**不裁不补**（`src/capture.js:215`）
  - 帧尺寸：ultra = 1596×900（`src/runner.js:63`）；`preset:"subtitle"` 已强制 ultra（`src/index.js:2087`）
  - 条带叠图在 `src/pipeline.js:815` `flushBand()`；带参数解析在 `:789` `bandOf()`
  - 守卫先例：文字流只对整屏用框（`src/text-stream.js:363` `regionAllowed`）
  - 真机现状（2026-11-27 19:36，4K 屏）：框 (844,1695) 2296×379 → 帧内 954×158（按 `rectFromRegion` 算的，未验）
账：写文档一轮（19:49–19:5x），无需
更新：2026-11-27 19:52 CST

## 为什么做

窗口化播放时字幕在**窗口**底部、不在屏幕底部：`[0.84, 1.0]` 裁到的是桌面/任务栏，长条图出来是空的。
`.42` 的字幕框只解决了 OCR 那一路，`preset:"subtitle"` 那条没跟上 —— 同一个用户动作（框一次），
理应对两个消费者都生效。

## 口径（方案 A，定死）

1. **不加工具参数**：schema 只剩 36 字符余量（交接 19:31 记 7464 / 7500），加不动。共用方式是读 `text.region`。
2. **只在整屏源生效**：`source` 缺省或 `screen` 用框；`window` / `file` / `obs` / `camera` 与 region 模式
   一律退回默认带。口径与 `src/text-stream.js:363` 的 `regionAllowed` 一致。
3. **quality 不变**：仍是 `ultra`（`src/index.js:2087`）。框只决定「裁哪一块」，不决定清晰度。
4. **换算只走 `rectFromRegion()`**，不另写一份换算。
5. **兜底不静默**：换算不出（任一边 < 8px）、`sw/sh` 缺失、框超出画面 → 退回默认带，并在图注 / `status`
   写明「字幕框不可用，按底部条带」。不做「悄悄裁到空」。
6. **框内不再让左右 10%**：框是用户自己框的，已经不含空边。
7. **叠图逻辑不动**：最多 4 条、带内差分、上=早、每格 1px 分隔线。

## 待定（给了默认值，格可以推翻）

1. **框内左右让边**：默认**不让**（口径 6）。
2. **帧内高度太小**（< 16px，说明框太小、字读不出）：默认**退回默认带**并写一句原因；
   备选是「照出图、图注标『框太小』」。默认取前者——宁可给出能用的一张，不给出读不了的一张。

## 实现步骤（按文件）

1. `src/pipeline.js`
   - `bandOf()`（:789）：多认一种形态 `{ region: {x,y,w,h,sw,sh} }`，返回 `{ region }`；
     `o.band` 仍是数组或 `'auto'` 时一行都不改。
   - `flushBand()`（:815）：`cfg.region` 存在 → `rectFromRegion(width, height, cfg.region)`；
     非空则 `x0 = r.x, top = r.y, bandW = r.w, rows = r.h`，**跳过** `auto` 与 `inset` 两条分支；
     为空（或按「待定 2」判太小）→ 退回现有 `[0.84, 1.0, 0.10]` 计算。
   - `sheet.band`：region 模式**不要**把像素 rect 塞进原来那个比例数组（下游按 `[y0,y1,inset]` 解析），
     要么写 `null` + 新字段 `regionRect`，要么保持默认带数值并另加 `regionApplied: true`。
2. `src/index.js`
   - `subtitleMode` 分支（:2103）：`built.src`（:2045）说明这次是什么源；整屏且有 `tuning.text?.region`
     → `band: { region: ... }`，否则 `band: SUBTITLE_BAND`。
   - **不碰** `region`（`watch` 抓哪块）那条线，也不碰 `region.json`。
3. `test/`：新增 `test/band-region.test.mjs`（或并入现有 band 测试）
   - 1596×900 帧 + `{844,1695,2296,379,3840,2160}` → rect `{x:351, y:706, w:954, h:158}`；
     图宽 = 954、每格高 158、最多 4 格；
   - region 缺失 / 任一边 < 8px / `sw/sh` 为 0 → 默认带（1276 宽、144 高）；
   - `bandOf()` 对 `{region}` 与 `[y0,y1,inset]` 两种形态都认，且数组行为逐字节不变。
4. 文档：`README.md` 的 `preset:"subtitle"` 段（约 570 行）加一句；`src/tool-spec.js:168` 那句
   「只取底部 16% 那条」要改成「底部 16%（框了字幕行就按框）」，**同笔从别处长句删够字符**
   （`test/tool-spec.test.mjs` 的 `SPEC_BUDGET_CHARS = 7500` 会拦）。

## 验收

- 离线：`node --test` 全过（含新增 4 条）。
- 真机 A（**窗口化**播放，窗口不最大化）：`see_now({action:"region", for:"text"})` 框字幕行 →
  `watch({preset:"subtitle"})` → 长条图只含字幕行、每行一句、图宽 ≈ 954；清框 → 图回到整屏底部
  （宽 1276，含字幕以外的画面）。
- 真机 B（**全屏**播放）：同 A；图应比默认带窄、字高不变（这是「不该变差」的回归）。
- 真机 C（`source:"file"` 播放同一视频、且已有框）：仍按默认带出图 —— 守卫生效。
- 真机 D（框得很小，约 300×100）：若帧内高 < 16px，走「待定 2」的兜底，图注 / `status` 能看到原因。
- 素材复用 `_scratch/bili-p2-1080p.mp4`（B 站 `BV1eS1czoEaD` p2），`ffplay -loop 0 -fs -an` 全屏、
  窗口化各跑一次。

## 风险

- **坐标系依赖**：region 是屏幕像素、帧是 scale 后的画布；采集一旦改成 crop / pad，`rectFromRegion`
  要重写（`src/text-band.js:71-79` 已写明这条前提）。
- **4K + ultra 帧只有 1596 宽**：2296 宽的框在帧内 954 宽，字高按 4K 字号粗算够 OCR（验收时量，
  不写没核的数）；但用户框小（300 宽）时帧内只剩 125 宽 —— 图也读不了，靠「待定 2」兜底，不假装成功。
- **多屏**：沿用「只支持主屏」；`sw/sh` 与当前屏幕不一致时框会偏（与 `.42` 同一条，界面不变）。
- **schema 预算**：改描述必须同笔删够，否则 `node --test` 拦。

## 不做

- 不加工具参数、不改 `region.json`、不改 `watch` 抓哪块。
- 不自动跟随字幕位置（`auto` 那条是另一件事；`.42` 也明确不跟随）。
- 不改 `text.region` 的存储格式与取框交互、不改叠图 / 去重逻辑。
- 不碰 `window.py`。

## 日志

- 2026-11-27 19:49–19:52 新建（格定「写任务书」）。依据逐条核过：preset 现按帧比例带
  （`src/index.js:175`）、region 换算唯一实现（`src/text-band.js:80`）、ultra 帧 1596×900
  （`src/runner.js:63`）、守卫口径照 `src/text-stream.js:363`。本轮只读代码 + 写文档，未动代码。
