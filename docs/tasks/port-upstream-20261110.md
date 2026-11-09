# 上游补丁移植：listen 进程树收尾 + 亮度归一

## 状态

- **2026-11-10 执行中：A 完成并验证，B 待新会话。** 目标仓 `see-now-more`，基线 `a92809f`
  （main 头，领先 tag `v0.2.0-more.1`（`b96fed4`）两条文档提交）。
- 来源：上游 `SAOS-3624/dsh-see-now` 的 `d2835d1`（listen 按进程树结束 + `listen.pid`）与
  `a0ff4d5`（亮度归一 + 黑边补偿）。
- 本机缓存了完整 diff：`see-now/_scratch/port-diffs/d2835d1.diff`、`a0ff4d5.diff`；
  上游工作树在 `see-now/_scratch/upstream-20261110/`（两个测试文件都在里面）。
- 两个补丁各自带测试，测试原样搬。
- **2026-11-10 补丁 A 已落地**（分支 `port/upstream-listen-kill`，见该分支首个 commit）：
  `src/listen.js` / `py/listen.py` / `test/listen-kill.test.mjs`，`node --test` 34 条通过；
  版本改为 `0.1.1-more.2`。**补丁 B 交新会话做**（下面的 B 段就是交接内容）。
- **2026-11-10 01:35 已装进 desktop profile**（`install-dev`，副本 `0.1.1-more.2` ✓ 与源码一致）。
  模块级运行时验证直接对着**装机副本**跑（真 python + 真回环设备）：start → `listen.pid` 落盘、
  stop → 按树杀 + 删 pid 文件、先留孤儿再 start → 孤儿被清且 pid 换成新的、收工无残留，12 项全过。
  **DSH 进程内那条路要重启 Desktop 后才用新代码**：当前进程里仍是旧 `listen.js`，这期间开/关
  采集可能留下孤儿与 pid 文件，重启后第一次 `start()` 会自动清掉。
- **2026-11-10 01:40 DSH 内验证通过**（重启 Desktop 后，装机副本 `0.1.1-more.2`）：
  `watch(mode:"both")` → `listen.pid` 落盘且 pid 与进程一致；`stop` → 采集进程消失、pid 文件被删；
  再 `watch` → 新 pid、单实例；`taskkill /F` 制造孤儿 → 下次 `watch` 把陈旧 pid 文件换成新的、
  仍单实例。**用户点窗口关闭**那条路走的是同一个 `listener.stop()`，未单独压测。
- **2026-11-10 B 完成**（分支 `port/upstream-score-normalize`，从 `port/upstream-listen-kill` 派生）：
  `cuts.js` / `pipeline.js` / `runner.js` / `index.js` / `tuning.js` / `scripts/sim.mjs` 按 B 段落地，
  测试原样搬 `test/score-normalize.test.mjs`（**口径以工作树为准，见下面的修正**），版本
  `0.1.1-more.3` 三处同改，`node --test` 全绿。运行时验证（`.tmp/b/`，全部 gitignored）：
  亮场（V 158–233）开关前后出图 PNG **逐字节相同**、`stats` 与 `kept` 完全一致；
  真实 trailer 前 120 秒 `--scoreNormalize=0/1` → 切点 **43 → 44**、积分 72 → 96、出图同为 14 张，
  141 帧里 115 帧 gain > 1（最高 1.85）；letterbox（上下各 3/36 行黑）`barFrac = 0.167`、
  `meanV` 与无黑边版本相同（162 vs 168，差在逐行取整）、`score = raw/(1-0.167)`；
  静止暗画面（带时域噪声，V≈40）开关开时**0 假切点**。
  **未发 tag、未合 `main`** —— 按计划 A+B 一起发 `v0.1.1-more.3`。

## 交接（给做 B 的新会话）

- **起点**：分支 `port/upstream-listen-kill`（`origin` 上已有；3 个 commit：补丁 A + 两份验证记录）。
  从它派生新分支，**不要从 `main`** —— `main` 还没有 A 的 `listen.js` 改动。
- **版本**：`0.1.1-more.3`。`package.json` + `dsh.plugin.json` + CHANGELOG 新段三处同改
  （`test/version.test.mjs` 会拦漏改）；CHANGELOG 新段放在 `## [0.1.1-more.2]` 上面。
- **范围**：只按「补丁 B」段改 `cuts.js` / `pipeline.js` / `runner.js` / `index.js` / `tuning.js` /
  `scripts/sim.mjs`，测试搬 `test/score-normalize.test.mjs`。**别碰 `window.py` / `py/listen.py`。**
- **完成后**：`node --test`（当前 34 条 + 新增 12 条）；更新本文件状态块；回报 commit。
- **不要发 tag、不要合 `main`**：等 B 完成一起发（A+B 共用一个 release，见下）。
- 发布计划（B 完成后由用户拍板）：`main` 合入 A+B → annotated tag `v0.1.1-more.3` → Release 标
  prerelease，正文合并 0.1.1-more.2 与 0.1.1-more.3 两段。**A 的 `0.1.1-more.2` 不单独发 tag。**

## 为什么不是 cherry-pick

两侧 git 没有共同祖先（`merge-base` 为空），`git cherry-pick` 连对象都找不到；只能按 hunk 手工套。
好在本地改动不在这两处结构上：`cuts.js` 相对 v0.1.1 只动过 26 行，`listen.js` 的 `start()/stop()`
结构与上游一致 —— 下面每个落位点都给了本地行号。

---

## 补丁 A：`d2835d1` —— 采集按进程树结束 + `listen.pid`

两个病：① Windows 上 `child.kill()` 只杀 venv launcher，真正在录音的基座解释器活着；② 关窗走
`hangUp()` 时 `child` 引用可能已丢，连 pid 都拿不到。上游的方案是「Python 自己写 pid 文件 +
Node 按进程树杀 + 开工前清孤儿」。

### A1 `src/listen.js`（新增约 95 行）

**A1.1 新函数块** —— 插在 `canListen()`（本地 351–354 行）结束、`findListenPython`（365 行）之前，
即第 354 行 `}` 与第 356 行注释之间：

```js
/**
 * Python 自己写的 pid 文件（放在音频目录里）。
 *
 * **为什么需要它**：Windows 上 `spawn(python, …)` 拿到的 pid 是 venv 的 launcher，
 * 真正在录音的是它拉起来的基座解释器 —— `child.kill()` 只杀 launcher，子进程活着。
 * 而关窗走 `hangUp()` 时 `child` 引用可能已丢，连 pid 都拿不到。
 * 所以让 Python 把"我是谁"落盘，Node 侧只认这个文件。
 */
export const PID_FILE = 'listen.pid';

/** 读 pid 文件；内容不合法就返回 null（不抛）。 */
export function readListenPid(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const pid = Number(raw?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // 只认自己写的：脚本名对不上、或者记录老得离谱，都当成脏文件
    if (String(raw?.script ?? '') !== 'listen.py') return null;
    const at = Number(raw?.at);
    if (Number.isFinite(at) && at > 0 && Date.now() - at > 6 * 3600 * 1000) return null;
    return pid;
  } catch {
    return null;
  }
}

const defaultRun = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 8000 });
  } catch {
    return null;
  }
};

/**
 * 结束一根采集进程（**按进程树**，Windows 上必须）。
 *
 * 两条保护，都是"别误杀别人"：
 *   1. 先 `tasklist` 确认这个 pid 的映像名是 python —— pid 会被系统复用；
 *   2. 映像名不对就什么都不做（返回 'skipped'）。
 *
 * @returns {'killed'|'skipped'|'gone'}
 */
export function killListenTree(pid, {
  platform = process.platform, run = defaultRun, kill = process.kill,
} = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return 'gone';
  if (platform !== 'win32') {
    // POSIX：listen.py 是直接子进程，SIGTERM 就够（它自己接了这个信号收尾）
    try { kill(id, 'SIGTERM'); return 'killed'; } catch { return 'gone'; }
  }
  const list = run('tasklist', ['/FI', `PID eq ${id}`, '/FO', 'CSV', '/NH']);
  const image = String(list?.stdout ?? '').toLowerCase();
  if (!image.includes('python')) return 'skipped';
  const out = run('taskkill', ['/PID', String(id), '/T', '/F']);
  return out?.status === 0 ? 'killed' : 'skipped';
}
```

> 依赖检查：`spawnSync` / `readFileSync` / `unlinkSync` / `join` 本地都已 import（listen.js 25–30 行），
> 不用加 import。

**A1.2 `start()` 清孤儿** —— 本地 1219 行 `if (child) return { ok: true, reason: 'already' };`
之后、`DSH_SEE_AUDIO` 检查（1220 行）之前插：

```js
    /**
     * 开工前先扫一遍**上一轮留下的孤儿**：pid 文件还在 = 上一轮没杀干净。
     * 不清掉就会同时有两根管道在录音，同一句话被转两遍。杀不掉也继续。
     */
    const stale = readListenPid(join(audioDir, PID_FILE));
    if (stale) {
      const how = killListenTree(stale);
      log(`[listen] 清掉上一次留下的采集进程 ${stale}（${how}）`);
      try { unlinkSync(join(audioDir, PID_FILE)); } catch { /* 本来就没有 */ }
    }
```

**A1.3 `stop()` 改法** —— 本地 1326–1334 行整段替换：

```js
  function stop(why = null) {
    if (timer) { clearInterval(timer); timer = null; }
    /**
     * 两条都杀：**内存里的 pid** 和 **磁盘上的 pid 文件**。
     * 关窗走 hangUp() 时 child 可能已置空，只剩 pid 文件记着真正在录音的 python；
     * 反过来 pid 文件写失败时 child.pid 还在。两边并起来，各杀一次。
     */
    const pidPath = join(audioDir, PID_FILE);
    const pids = new Set();
    if (child?.pid) pids.add(Number(child.pid));
    const fromFile = readListenPid(pidPath);
    if (fromFile) pids.add(fromFile);
    for (const pid of pids) {
      const how = killListenTree(pid);
      if (how === 'killed') log(`[listen] 已结束采集进程 ${pid}`);
      else if (how === 'skipped') log(`[listen] pid ${pid} 看着不是 python，没杀（可能已被复用）`);
    }
    child = null;
    try { unlinkSync(pidPath); } catch { /* 本来就没有 */ }
    enabled = false;
    reason = why || '停了';
  }
```

**A1.4 不要搬的**：上游在 `start()` 里还有一行 `buffer.reset()`（对应上游 issue #39，跨轮台词污染）。
本地没有这条 —— `buffer` 是 `createListener()` 里新建的（897 行），不存在跨轮污染，抄进来反而多余。

### A2 `py/listen.py`（新增约 25 行）

- 常量与两个函数插在 `SR = 16000`（本地 75 行）之后：

```python
# pid 文件（放在 --out 目录里）。上层（src/listen.js）杀进程靠它兜底。
PID_FILE = "listen.pid"


def write_pid_file(out_dir):
    try:
        path = os.path.join(out_dir, PID_FILE)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(),
                       "script": os.path.basename(__file__),
                       "at": int(time.time() * 1000)}, f)
        return path
    except OSError:
        return None


def remove_pid_file(path):
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass
```

- `main()` 里写：`os.makedirs(args.out, exist_ok=True)`（本地 646 行）之后、`signal.signal(...)`
  （649 行）之前，加一行 `pid_path = write_pid_file(args.out)`。
- `main()` 里删：本地 `main()` 已经有 `try/except/finally`（`try` 在 652 行，`finally` 在 763 行），
  在 finally 末尾 `p.terminate()`（781 行）之后加：

```python
        try:
            p.terminate()
        finally:
            remove_pid_file(pid_path)
```

- **不要照抄上游那段重排**：上游把 `Recorder` 包进 try/finally 并重排了 main 的尾段；本地没有
  `Recorder` 类（音频循环直接写在 main 里），挂在既有 finally 上即可。

### A3 测试

`test/listen-kill.test.mjs`（312 行）从上游工作树原样拷进 `test/`，import 路径 `../src/listen.js`
不用改。本地导出名（`killListenTree` / `readListenPid` / `PID_FILE`）与测试一致。

### A4 风险 / 备注

- 本机 `findListenPython()` 返回的可能是真解释器而不是 venv launcher，未必能复现 #61；但 #62
  （hangUp 时引用丢了）照样存在，pid 文件是那条路的唯一兜底。
- 非 win32 走 SIGTERM：本地 `listen.py` 已接 `signal.SIGTERM` → 会走 finally 收尾。
- 杀之前 `tasklist` 验身，pid 被系统复用不会误杀。

---

## 补丁 B：`a0ff4d5` —— 亮度归一 + 黑边补偿

病：`scorePair` 是绝对差，而门槛 `cutAbs: 12` 是常数 —— 暗场真切点只有约 5 分（永远够不着），
2.39:1 的黑边把分数打了 75 折。方案是乘 `gain = clamp(160/V均值, 1, 3)`、再除 `(1 - 黑边占比)`；
亮场（V ≥ 160、无黑边）逐位返回原分数，所以日常屏幕是 no-op。

### B1 `src/cuts.js`（新增约 150 行）

**B1.1 常量 + 3 个纯函数** —— 插在 `scorePair()` 结束（本地 80 行）之后、`createScorer` 注释之前：

```js
// ---------------------------------------------------------------- 亮度归一 / 黑边补偿

/** 参考亮度：常见影视/网课素材的 V（max 通道）均值落在 140–180，正常片子增益 ≈ 1。 */
export const REF_V = 160;
/** 放大上限：再暗也不超过 3 倍，否则纯黑画面里的编码噪声会被一起放大成刀。 */
export const GAIN_MAX = 3;
/** 参考亮度下限：V 均值低于它不再继续放大。 */
export const V_FLOOR = 40;
/**
 * 噪声地板（**本仓独有，storyboard 没有**）。
 *
 * 那边绝对门槛是分位数，噪声再放大也只影响排序；这边 `cutAbs: 12` 是常数，
 * 暗场 2~3 分的编码噪声 ×3 能顶到 6~9 分的「孤立弱切点」区间，会在静止暗画面上切个不停。
 * 所以低于地板的分数**原样返回**，不参与放大。
 */
export const NOISE_FLOOR = 6;
/** 黑边判定：窗口内每行的 V 均值 < BAR_MEAN，且该行一次都没亮过（< BAR_MAX）。 */
export const BAR_MEAN = 16;
export const BAR_MAX = 24;
/** 黑边占比上限：超过它多半是"整段黑场"，不做补偿。 */
export const BAR_CAP = 0.35;
/** 黑边窗口（帧）。12fps 下 24 帧 = 2 秒；判据是"一直黑"而不是"这一帧黑"。 */
export const BAR_WINDOW = 24;

/** 亮度增益：只在暗场 > 1，亮画面（V ≥ REF_V）恒等于 1 —— 这是"不破坏现有体验"的安全阀。 */
export function brightnessGain(meanV, { refV = REF_V, gainMax = GAIN_MAX, vFloor = V_FLOOR } = {}) {
  if (!Number.isFinite(meanV) || meanV <= 0) return 1;
  return Math.min(gainMax, Math.max(1, refV / Math.max(vFloor, meanV)));
}

/**
 * 把绝对分换算到"参考亮度、无黑边"的刻度上。**纯函数**。
 * 恒等条件：`meanV ≥ REF_V` 且 `barFrac = 0` 时原样返回 —— 这是回滚线。
 */
export function normalizeScore(raw, {
  meanV = NaN, barFrac = 0, noiseFloor = NOISE_FLOOR, ...gainOpts
} = {}) {
  if (!Number.isFinite(raw) || raw <= 0) return raw;
  if (raw < noiseFloor) return raw;
  const gain = brightnessGain(meanV, gainOpts);
  const bf = Number.isFinite(barFrac) && barFrac > 0 ? Math.min(barFrac, BAR_CAP) : 0;
  if (gain === 1 && bf === 0) return raw;
  return (raw * gain) / Math.max(0.05, 1 - bf);
}

/**
 * 黑边占比：窗口内"一直是黑的"顶部/底部行占多少。
 * 与 contentHeightRatio 的区别：那个判**这一帧**（前景守卫用），这个判**整窗**（不被片头黑场骗）。
 * @param {{rowV:Float32Array|number[], rowVMax:Float32Array|number[], frames:number}} o
 *   `rowV` 是窗口内逐行 V **累加值**（不是均值），除以 `frames` 才是均值
 */
export function barFraction({ rowV, rowVMax, frames, cap = BAR_CAP } = {}) {
  if (!rowV || !rowVMax || !(frames > 0)) return 0;
  const h = rowV.length;
  const dark = (y) => rowV[y] / frames < BAR_MEAN && rowVMax[y] < BAR_MAX;
  let top = 0;
  while (top < h && dark(top)) top += 1;
  let bottom = 0;
  while (bottom < h - top && dark(h - 1 - bottom)) bottom += 1;
  const frac = (top + bottom) / h;
  return frac >= cap || frac >= 0.999 ? 0 : +frac.toFixed(3);
}
```

**B1.2 签名** —— 本地 335–339 行的 `createScorer({...})` 末尾加一个参数：

```js
  bgRefWindow = 0, futureMinScore = Infinity, scoreNormalize = false,
```

**B1.3 状态 + 逐行窗口** —— 插在本地 345 行 `let cur = new Float32Array(n * 3);` 之后：

```js
  /**
   * 亮度归一只对 `abs` 口径有意义：`mc` 的分数是"变了多少格"的占比，
   * `cutMcAbs: 60` 是另一套刻度，一起放大等于把两条独立标定混成一条。
   */
  const normalize = scoreNormalize && scoreMode !== 'mc';
  const rowV = Array.from({ length: BAR_WINDOW }, () => new Float32Array(SCAN_H));
  const rowVMax = Array.from({ length: BAR_WINDOW }, () => new Float32Array(SCAN_H));
  const barV = new Float32Array(SCAN_H);
  const barVMax = new Float32Array(SCAN_H);
  let barSlot = 0;
  let barFrames = 0;

  /** 把这一帧的逐行 V 记进窗口，返回 `{ meanV, barFrac }`。只在开关打开时调用。 */
  function readBarWindow(hsv) {
    const sums = rowV[barSlot];
    const maxes = rowVMax[barSlot];
    let vSum = 0;
    for (let y = 0; y < SCAN_H; y += 1) {
      const base = y * SCAN_W * 3;
      let sum = 0;
      let mx = 0;
      for (let x = 0; x < SCAN_W; x += 1) {
        const v = hsv[base + x * 3 + 2];
        sum += v;
        if (v > mx) mx = v;
      }
      sums[y] = sum;
      maxes[y] = mx;
      vSum += sum;
    }
    barSlot = (barSlot + 1) % BAR_WINDOW;
    if (barFrames < BAR_WINDOW) barFrames += 1;
    for (let y = 0; y < SCAN_H; y += 1) {
      let sum = 0;
      let mx = 0;
      for (let k = 0; k < barFrames; k += 1) {
        sum += rowV[k][y];
        if (rowVMax[k][y] > mx) mx = rowVMax[k][y];
      }
      barV[y] = sum;
      barVMax[y] = mx;
    }
    return {
      meanV: vSum / n,
      barFrac: barFraction({ rowV: barV, rowVMax: barVMax, frames: barFrames }),
    };
  }
```

**B1.4 `score()` 内三处**：

1. 本地 360–361 行 `const activeY = ...; const guardY = ...;` 之后加：

```js
    if (normalize) {
      // 用**当前帧**的亮度/黑边：分数是"这一帧相对上一帧"的，换算到这一帧的刻度上
      const st = readBarWindow(cur);
      meanV = st.meanV;
      barFrac = st.barFrac;
    }
```

2. 函数开头的变量声明（本地 `let s = null;` 附近）补：

```js
    let rawScore = null;
    let gain = 1;
    let barFrac = 0;
    let meanV = null;
```

3. `else { s = scorePair(prev, cur); }`（本地约 380 行）改成：

```js
      } else {
        rawScore = scorePair(prev, cur);
        s = normalize ? normalizeScore(rawScore, { meanV, barFrac }) : rawScore;
        gain = normalize ? brightnessGain(meanV) : 1;
      }
```

4. return（本地 406–409 行）在 `score: s,` 后加：

```js
      score: s, rawScore, gain, barFrac, meanV,
```

### B2 `src/pipeline.js`

- `DEFAULTS`：`mcRadius: 2,`（本地 341 行）之后加 `scoreNormalize: true,`（连同注释；默认开）。
- `createScorer({...})`（430–437 行）加一行 `scoreNormalize: o.scoreNormalize,`。
- `log.push({...})`（522–525 行）加三个字段 —— `log` 是"每一帧为什么留下"的离线标定记录
  （465 行），没有这三个量就分不清「切点多是因为门槛低」还是「gain 把分数顶上去了」：

```js
      raw: entry.raw === null || entry.raw === undefined ? null : +entry.raw.toFixed(1),
      gain: entry.gain === undefined ? null : +entry.gain.toFixed(2),
      bar: entry.bar === undefined ? null : entry.bar,
```

- `entry`（1080 行）在 `score: s,` 后加 `raw: r.rawScore, gain: r.gain, bar: r.barFrac,`。

### B3 `src/runner.js`

- 参数表：本地 196 行 `mode = 'both',` 之后加：

```js
  /**
   * 亮度归一 + 黑边补偿（`~/.dsh/see-now.json` 的 `scoreNormalize`，默认开）。
   * **必须进 `createPipeline` 的 opts，不能只拦在 runner 层** —— `scripts/sim.mjs`
   * 走的是管线本身，开关停在 runner 层离线就没法 A/B。
   */
  scoreNormalize = true,
```

- `createPipeline({...})`（442 行）里加：

```js
      scoreNormalize: opts.scoreNormalize ?? scoreNormalize,
```

### B4 `src/index.js`

- `createRunner({...})`（600–609 行）加 `scoreNormalize: tuning.scoreNormalize,`。
- 状态文案：1567 行「…秒叫一次）」之后加：

```js
            + (tuning.scoreNormalize ? ' · 亮度归一开（暗场/黑边已补偿）' : ' · 亮度归一关')
```

### B5 `src/tuning.js`

- `TUNING_DEFAULTS` 尾部（`idleCaptureMin: 5,`（51 行）之后）加 `scoreNormalize: true,`。
- `readTuning()` 在 `mode` 解析之后（243 行）加布尔校验：

```js
  // 只认真正的布尔：写成 `"false"` 是真值 —— 用户以为关掉了，实际一直开着
  let scoreNormalize = TUNING_DEFAULTS.scoreNormalize;
  if (raw.scoreNormalize !== undefined) {
    if (typeof raw.scoreNormalize === 'boolean') scoreNormalize = raw.scoreNormalize;
    else warnings.push('scoreNormalize 只能是 true / false，已用默认 true');
  }
```

- return（250–263 行）加 `scoreNormalize,`。
- 本地没有 `WRITABLE_KEYS`（那是上游设置页的），跳过。

### B6 `scripts/sim.mjs`

`NUM` 集合（20–23 行）加 `'scoreNormalize'`。漏了它，`--scoreNormalize=0` 拿到字符串 `"0"`（真值），
A/B 两边一模一样 —— 标定等于没做。

### B7 测试

`test/score-normalize.test.mjs`（182 行）原样拷进 `test/`。本地导出齐全（`SCAN_W` / `SCAN_H` /
`BAR_CAP` / `barFraction` / `brightnessGain` / `normalizeScore` / `createScorer`），`readTuning`
签名一致，直接能跑。

### B8 版本 + CHANGELOG（必须同一提交）

`test/version.test.mjs` 要求 CHANGELOG 里有 `## [<package.version>]`。所以 bump 三处：
`package.json` 的 `version`、`dsh.plugin.json` 的 `version`、CHANGELOG 新段。
A 已用 `0.1.1-more.2`；**B 从 `port/upstream-listen-kill` 派生，用 `0.1.1-more.3`**
（三处同改，CHANGELOG 新段写 B 的改动，放在 `0.1.1-more.2` 段上面）。

### B9 落地时的口径修正（2026-11-10 执行中发现）

上面 B1.1 的代码块是**交接时的旧版**；`_scratch/upstream-20261110/` 里的工作树与测试是之后的修订版，
两者不一致。**以工作树与测试为准**，实际落地的是修订版：

- `REF_V = 96`（不是 160：按 160 算 gain 是 1.67，等于把 `cutAbs: 12` 的标定整体下调 40%）；
- `GAIN_MAX = 1.85`（不是 3：3 会把暗场顶成 2 倍过冲）；
- `NOISE_FLOOR = 2`（不是 6：6 会把"暗场真切点约 5 分"永远挡在门外，自相矛盾）；
- 多一个 `barRows()`：`readBarWindow` 的 `meanV` **只算有效行**。B1.3 那段把黑边像素一起平均进
  meanV，会既拉低 gain 又被 `/(1-bar)` 除一次 —— 同一件事补两遍（实测 letterbox 素材放大到 2.2 倍）。
  测试里专门有一条钉它。

`test/score-normalize.test.mjs` 也是修订版（比 B7 描述的长），内容按原样搬进 `test/`。

---

## 顺序

A → B，各自一个 commit：

1. `port: listen 按进程树结束 + listen.pid（上游 d2835d1）`
2. `port: 亮度归一 + 黑边补偿（上游 a0ff4d5）`

每个 commit 前跑 `node --test`。

## 验收

**A（listen 收尾）**

- `node --test test/listen-kill.test.mjs`（7 条）。
- 真机：`watch` 带声音 → `<audioDir>/listen.pid` 出现且有 `{pid,script,at}` → `stop` / 关窗 →
  1 秒内 `tasklist /FI "PID eq <pid>"` 查不到；再 `start` 时日志若有「清掉上一次…」说明扫到了残留。

**B（亮度归一）**

- `node --test test/score-normalize.test.mjs`（12 条，核心是「亮场逐位相同」「噪声地板」「一直黑」三条）。
- 亮素材对照：同一段 V ≥ 160 的素材，开关前后出图 PNG 逐字节相同（安全阀）。
- 暗素材：同一素材 `--scoreNormalize=0/1` 各跑一遍，切点数开启时 ≥ 关闭时；静止暗画面不得新增假切点。

**全局**

- `node --test`：本地 5 个测试文件 + 新增 2 个 = 7 个全绿（版本守卫会同时检查版本号三处一致）。

## 回退

- 配置级：`~/.dsh/see-now.json` 写 `"scoreNormalize": false`（**布尔**；写字符串会 warn 并回默认 true）。
- 代码级：`git revert` 对应 commit；或回到 tag `v0.2.0-more.1`。

## 不在这批

procloopback（进程级声源）、tierCurve、`/seenow` 命令、tray / danmaku / settings API、Linux portal。
