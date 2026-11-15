# 血条线（黑听抬头）交接 — 2026-11-15

> 上一棒 `session-10a846f1`：代码在 `see-now-more`，任务书在 `see-now`。
> 读这一页就够接手；机制全文在 `see-now/docs/tasks/see-now-audio-cluster.md`。

## 现状（已核实）

P1 血条读数完成并验过；P2 改为「**只报告读数，不唤**」，代码已写、单测 172/172，运行态待重启验。

- **框选**：`see_now({action:"bloodbar"})` 拖框 → 存 `~/.dsh/see-now/bloodbar.json`
  （`region` / `threshold`），与看图的 `region.json` 分开。支持
  `see_now({action:"bloodbar", region:"x,y,w,h", threshold:0.3})` 直给 + 热更新，不弹框、不重启。
- **读数**：`src/bloodbar.js` 的 `ratioFromPixels(mode:"band")`——自动找亮行带（行亮 ≥ 最亮行 0.8）
  + 强填充端点（列亮 ≥ 0.9）。单次读走 `action:"bloodbar", read:true`（抓一帧、不出图、不记账）。
- **常驻**：进仅监听时 `runner` 起 1 fps BGRA 采集，读数进 3 分钟轨迹（`pushTrack`）；
  `loop` 每拍过 `shouldGlance()` 记一条 `level:"glance", trigger:"bloodbar"`——
  **只是日志**，不出图、不叫醒。
- **报告（P2，2026-11-15）**：`runner.bloodbarNote()` 产出一行
  `血条 64%（低于阈值 30%）· 30 秒前 70% · 近 60 秒 64–90% · 上次低血 12:28:31`，
  接在三处：① 音频 / lift 唤醒文案末尾（`loop.js` 的 `bloodbarTail()`）；
  ② `watch` / `peek` 的结果（`sheetText()` 的 `bloodbar` 字段）；③ `status` 的血条行（加「上次低血」）。
  **不调用 `wake()`，不占 `listenGap` 退避。** 要不要抬头由模型自己看情况决定。
- **验收记录**：框紧（332×16）连读 5 次 **91.87%** 完全一致，屏幕数字 17223/18980 = **90.75%**，
  差 1.1 点；2026-11-15 12:15 战斗中掉到 **64%** 落一条
  `{"level":"glance","trigger":"bloodbar","spoke":false}`，满血 100% 不记，30 秒冷却无重复。

代码提交：`see-now-more` `7e02bdc`（P1c）+ 本轮 P2 改动待提交；任务书提交：`see-now` `df32070`。

## 待办（按优先级）

1. **重启 DSH 验 P2**：低血时**不该**多出一次独立唤醒；被别的原因叫醒时文案里要有血条那行，
   数值与屏幕一致；`watch` 结果里同样有。装机副本已同步（`node scripts/install-dev.mjs`），
   但插件树是进程启动时组合的，**新开一个会话不够**。
2. **彩色血条**：现在只认低饱和亮色横条。红/绿条（巫师 3 一类）读不出；要支持得加一层
   「框选后学主色、按与主色差异算填充」。
3. **换游戏验证**：浅色 HUD 的游戏框一次就能用；换游戏 / 换 UI 缩放要重框。
4. **阈值**：默认 30%，只是报告里「低于阈值」那半句的分界线；等真实战斗样本再定合不合适。

## 边界

- 不改 `window.py`、不改 lift 四档、不动 `lift.jsonl` 已有字段语义。
- **血条永远不叫醒模型**：它是读数，不是触发器。想加「低血提醒」得先过用户那一关——
  2026-11-15 他否过一次，理由是切人 / 奶妈 / 免死会让低血只出现一小会。
- 血条只在仅监听时采；开始看画面时 `start()` 会停掉这一路，`watch` 里那一行可能是旧读数，
  所以文案带「xx 秒前的读数」。
- 常驻采集是独立一路 1 fps ffmpeg；起不来只记 `status().bloodbar.error`，不拖垮听声音。

## 踩过的坑（别再踩）

- **`file:` 安装是拷贝，不是软链**：改了 `src/` 不跑 `node scripts/install-dev.mjs` 就不生效；
  而 `--check` 只比版本号、不比内容，版本没升时它会报「一致」却在跑旧代码。改完就装。
- `pick_region.py` 的 `MIN_SIDE` 原为 24：血条只有 10–20px 高，**松手永远不确认**
  （用户连取消两次就是它），已降到 8。
- `capture.js` 的 `isDda()`：带 region 的屏幕源会被误判成 ddagrab → 给 gdigrab 的帧挂
  `hwdownload` → ffmpeg 报 `Function not implemented`；同尺寸还会挂 `scale=…:flags=area`，
  gdigrab 的 bgr0 过不去。修法：带 region 一律不走 dda、同尺寸不缩放、输出 BGRA。
- `setBloodbar` 停完必须重开（已修）；`action:"bloodbar"` 直给坐标/阈值可热更新，不用重启。
- **框必须盖住整条**：只盖左半时端点法会给出 100% 的假读数（框左端对、右端没到条尾）。
- 重框后旧读数与旧轨迹都会被清空；`status` 显示「未采」时先看是不是采集没起来。

## 相关

- 任务书：`see-now/docs/tasks/see-now-audio-cluster.md`
- 代码：`src/bloodbar.js`、`src/bloodbar-capture.js`、`src/runner.js` 的 bloodbar 侧、
  `src/loop.js` 的 `maybeGlanceBloodbar()`
- 测试：`test/bloodbar.test.mjs`（含 band 模式、shouldGlance、配置读写）
