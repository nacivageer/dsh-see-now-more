/**
 * cuts.js — 逐帧画面变化分。**因果**，不看未来（除了一帧的尖峰确认）。
 *
 * `scorePair` 照抄 storyboard 的 scan.js（HSV 三通道加权绝对差，0–255）——
 * 同一段测试片它 9/9 命中、`ffmpeg scdet` 只 4/9（scdet 算亮度类 MAFD，对"同亮度换色"失明）。
 * 唯一改动：喂进来的不是整帧，而是 64×36 的网格，顺带把降采样的平均做了。
 */

export const SCAN_W = 64;
export const SCAN_H = 36;

/** 64×36 网格：每格取 4 个采样点求平均（降噪，且只花 9k 次读）。 */
export function gridRgb(rgb, width, height, out) {
  const sx = width / SCAN_W;
  const sy = height / SCAN_H;
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    const y0 = ((gy + 0.25) * sy) | 0;
    const y1 = ((gy + 0.75) * sy) | 0;
    const r0 = y0 * width;
    const r1 = y1 * width;
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const x0 = ((gx + 0.25) * sx) | 0;
      const x1 = ((gx + 0.75) * sx) | 0;
      const a = (r0 + x0) * 3;
      const b = (r0 + x1) * 3;
      const c = (r1 + x0) * 3;
      const d = (r1 + x1) * 3;
      const i = gy * SCAN_W + gx;
      out[i * 3] = (rgb[a] + rgb[b] + rgb[c] + rgb[d]) * 0.25;
      out[i * 3 + 1] = (rgb[a + 1] + rgb[b + 1] + rgb[c + 1] + rgb[d + 1]) * 0.25;
      out[i * 3 + 2] = (rgb[a + 2] + rgb[b + 2] + rgb[c + 2] + rgb[d + 2]) * 0.25;
    }
  }
  return out;
}

/** RGB → HSV（各通道归一到 0–255，H 由角度缩放）。就地写进 out，不分配。 */
export function rgbToHsv(rgb, out) {
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 3) {
    const rn = rgb[i] / 255;
    const gn = rgb[i + 1] / 255;
    const bn = rgb[i + 2] / 255;
    const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    out[j] = (h / 360) * 255;
    out[j + 1] = max === 0 ? 0 : (d / max) * 255;
    out[j + 2] = max * 255;
  }
  return out;
}

/** 两帧 HSV 的加权绝对差均值，0–255。色相按环形处理，低饱和像素的色相降权。 */
function hsvDiff(a, b, pa, pb = pa) {
  const dh = Math.abs(a[pa] - b[pb]);
  const hd = Math.min(dh, 255 - dh);
  const w = Math.min(a[pa + 1], b[pb + 1]) / 255;
  return (hd * w + Math.abs(a[pa + 1] - b[pb + 1]) + Math.abs(a[pa + 2] - b[pb + 2])) / 3;
}

export function scorePair(prev, cur) {
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return sum / ((cur.length / 3) * 3);
}

// ---------------------------------------------------------------- 亮度归一 / 黑边补偿

/**
 * 参考亮度：**不再用 160**。
 *
 * 160 是 storyboard 拿影视素材定的，那边门槛是**分位数**，参考点漂一点无所谓（整体放大不改排序）。
 * 这边 `cutAbs: 12` 是常数，REF_V 就等于"门槛的零点"—— 定高了，所有普通内容都会被白白放大一档。
 * 实测（2026-11-06，真 PV 关键帧拼的 12fps 滑块）：这批素材的有效行 V 均值 = **96**，
 * 而按老口径 160 算出来的 gain 是 1.67 —— 也就是门槛被整体下调了 40%，`cutAbs: 12` 的标定全部作废。
 * 取 REF_V = 96 = "视频/影视内容的常规亮度"。亮色 UI（V 150–200）仍恒为 1，所以对日常屏幕是 no-op。
 */
export const REF_V = 96;
/**
 * 放大上限 **1.85**：实测需要的最多就是 1.86 倍，`3` 是把暗场顶成 2 倍过冲的根因。
 *
 * 同一批素材逐档压暗，量"需要多少 gain 才能把分数拉回原值"：
 *
 * | V(有效行) | 96 | 72.6 | 53.4 | 46.8 | 37.3 | 32 | 24 |
 * | 需要 gain | 1.00 | 1.34 | 1.66 | 1.79 | 1.86 | 1.86 | 1.80 |
 *
 * 曲线是**饱和**的（V 再低也不会更暗），所以 `REF_V/V` 这个形状本身没问题，只是上限要收到 1.85；
 * 平方根那类更陡的曲线拟合更差（RMS 0.337 vs 0.315）。
 */
export const GAIN_MAX = 1.85;
/** 参考亮度下限：V 均值低于它不再继续放大（1.85 的上限先到，留着是防除零）。 */
export const V_FLOOR = 40;
/**
 * 噪声地板（**本仓独有，storyboard 没有**）。
 *
 * 它那边的绝对门槛是**分位数**（按原始刻度算），噪声再放大也只影响排序；
 * 这边 `cutAbs: 12` 是常数，所以放大前得先把"噪声"和"真变化"分开。
 *
 * 取 **2**（原先是 6，自相矛盾：交接文档举的例子就是"暗场真切点约 5 分"，5 < 6 永远救不回来）。
 * 实测静止暗场的编码噪声 raw 只有 **0.00–0.13**（crf 26/30，12fps），留 15 倍余量；
 * 而放大链最长 `1.85 × 1.54 = 2.85`，raw 2 顶到 5.7、raw 4 顶到 11.4，都还在 `cutAbs: 12` 以下 ——
 * 也就是说地板降到 2 不会让噪声变成刀。
 */
export const NOISE_FLOOR = 2;
/** 黑边判定：窗口内每行的 V 均值 < BAR_MEAN，且该行一次都没亮过（< BAR_MAX）。 */
export const BAR_MEAN = 16;
export const BAR_MAX = 24;
/** 黑边占比上限：超过它多半是"整段黑场"，不做补偿。 */
export const BAR_CAP = 0.35;
/**
 * 黑边窗口（帧）。12fps 下 24 帧 = 2 秒。
 *
 * **必须累积**：判据是"一直黑"而不是"这一帧黑"。片头/转场黑场每一行都黑，
 * 但它随后亮了 —— 只看当前帧就会把整幅画面当成黑边，分数除以 0.65 白白放大 1.5 倍。
 * 窗口也不宜太长：换到夜景后的前 2 秒补偿会消失（偏保守，宁可少放大）。
 */
export const BAR_WINDOW = 24;

/** 亮度增益：只在暗场 > 1，亮画面（V ≥ REF_V）恒等于 1 —— 这是"不破坏现有体验"的安全阀。 */
export function brightnessGain(meanV, { refV = REF_V, gainMax = GAIN_MAX, vFloor = V_FLOOR } = {}) {
  if (!Number.isFinite(meanV) || meanV <= 0) return 1;
  return Math.min(gainMax, Math.max(1, refV / Math.max(vFloor, meanV)));
}

/**
 * 把绝对分换算到"参考亮度、无黑边"的刻度上。**纯函数**（可单测，无状态）。
 *
 * 两条恒等条件必须保持：`meanV ≥ REF_V` 且 `barFrac = 0` 时**原样返回** ——
 * 亮场逐位不变，是这次改动的回滚线（也是标定的第一条判据）。
 *
 * @param {number|null} raw 原始分（0–255）
 * @param {{meanV?:number, barFrac?:number, noiseFloor?:number}} [opts]
 *   `meanV` = 当前帧 V 均值；`barFrac` = 累积黑边占比（见 `barFraction`）
 */
export function normalizeScore(raw, {
  meanV = NaN, barFrac = 0, noiseFloor = NOISE_FLOOR, ...gainOpts
} = {}) {
  if (!Number.isFinite(raw) || raw <= 0) return raw;
  // 地板以下不放大：暗场的编码噪声 × 增益会变成假切点
  if (raw < noiseFloor) return raw;
  const gain = brightnessGain(meanV, gainOpts);
  const bf = Number.isFinite(barFrac) && barFrac > 0 ? Math.min(barFrac, BAR_CAP) : 0;
  if (gain === 1 && bf === 0) return raw;
  return (raw * gain) / Math.max(0.05, 1 - bf);
}

/**
 * 黑边行数：窗口里"一直是黑"的顶部/底部连续行。
 *
 * 和 `barFraction` 同源 —— 那个只要占比，这个要**行号**：算"有效行亮度"时得跳过它们。
 * 拆出来的原因见 `readBarWindow`：全帧 V 均值会把黑边一起算成"变暗"，
 * 于是增益再放大一次，和 `/(1-bar)` 重复补偿。
 */
export function barRows({ rowV, rowVMax, frames } = {}) {
  if (!rowV || !rowVMax || !(frames > 0)) return { top: 0, bottom: 0 };
  const h = rowV.length;
  const dark = (y) => rowV[y] / frames < BAR_MEAN && rowVMax[y] < BAR_MAX;
  let top = 0;
  while (top < h && dark(top)) top += 1;
  let bottom = 0;
  while (bottom < h - top && dark(h - 1 - bottom)) bottom += 1;
  return { top, bottom };
}

/**
 * 黑边占比：窗口内"一直是黑的"顶部/底部行占多少。
 *
 * 与 `contentHeightRatio` 的区别：那个判**这一帧**（给前景守卫用，要求实时），
 * 这个判**整窗**（给分数补偿用，要求不被片头黑场骗）。
 *
 * @param {{rowV:Float32Array|number[], rowVMax:Float32Array|number[], frames:number}} o
 *   `rowV` 是窗口内逐行 V **累加值**（不是均值），除以 `frames` 才是均值
 * @returns {number} 0 – BAR_CAP；整段黑场返回 0（没有"补偿"可言）
 */
export function barFraction({ rowV, rowVMax, frames, cap = BAR_CAP } = {}) {
  if (!rowV || !rowVMax || !(frames > 0)) return 0;
  const { top, bottom } = barRows({ rowV, rowVMax, frames });
  const frac = (top + bottom) / rowV.length;
  return frac >= cap || frac >= 0.999 ? 0 : +frac.toFixed(3);
}

/**
 * 打分器：内部维护上一帧的 HSV。
 * 返回 `{ score, hsv }`，score 为 null 表示这是第一帧（没有前帧可比）。
 * **hsv 是复用的缓冲**，要用就自己拷走。
 */
/**
 * 运动补偿打分（可选口径）：每个格子在下一帧 ±radius 邻域里找最像的，连最像的都超 tau 才算"变了"，
 * 返回 0–255 的占比刻度（×255 与旧口径同量级，便于复用现有阈值经验）。
 * 出处：Nagasaka & Tanaka 1992（像素变化计数）、Shahraray 1995（邻域匹配）；独立实现，未取代码。
 */
export function mcStats(prev, cur, { tau = 15, radius = 2 } = {}) {
  const n = SCAN_W * SCAN_H;
  let changed = 0;
  let minX = SCAN_W;
  let minY = SCAN_H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SCAN_H; y += 1) {
    for (let x = 0; x < SCAN_W; x += 1) {
      const p3 = (y * SCAN_W + x) * 3;
      /**
       * **先测同位置（dx=dy=0）**。
       *
       * 屏幕最常见的状态是"这一格没变"，而旧的 dy 从 -radius 开始扫：
       * radius=4 时同位置在第 41 个才轮到，静止画面每个格都要白算 40 次才命中。
       * 实测整屏静止的 mcStats 从 0.72ms 降到 0.06ms（-92%）。
       */
      let matched = false;
      {
        const dh0 = Math.abs(cur[p3] - prev[p3]);
        const hd0 = dh0 < 255 - dh0 ? dh0 : 255 - dh0;
        const hw0 = (cur[p3 + 1] < prev[p3 + 1] ? cur[p3 + 1] : prev[p3 + 1]) / 255;
        const d0 = (hd0 * hw0
          + Math.abs(cur[p3 + 1] - prev[p3 + 1])
          + Math.abs(cur[p3 + 2] - prev[p3 + 2])) / 3;
        matched = d0 <= tau;
      }
      if (!matched) {
        for (let dy = -radius; dy <= radius && !matched; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= SCAN_H) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (dx === 0 && dy === 0) continue;      // 上面已经测过
            const xx = x + dx;
            if (xx < 0 || xx >= SCAN_W) continue;
            const q3 = (yy * SCAN_W + xx) * 3;
            const dh = Math.abs(cur[q3] - prev[p3]);
            const hueDiff = Math.min(dh, 255 - dh);
            const hueWeight = Math.min(cur[q3 + 1], prev[p3 + 1]) / 255;
            const d = (hueDiff * hueWeight
              + Math.abs(cur[q3 + 1] - prev[p3 + 1])
              + Math.abs(cur[q3 + 2] - prev[p3 + 2])) / 3;
            if (d <= tau) { matched = true; break; }
          }
        }
      }
      if (!matched) {
        changed += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const w = changed === 0 ? 0 : maxX - minX + 1;
  const h = changed === 0 ? 0 : maxY - minY + 1;
  return {
    score: (changed / n) * 255,
    bbox: ((w * h) / n) * 255,
    fill: changed === 0 ? 0 : changed / (w * h),
    spanY: h / SCAN_H,
  };
}

export function mcRatioScore(prev, cur, opts = {}) {
  return mcStats(prev, cur, opts).score;
}

/**
 * 变化面积占比（0–1）：全分辨率逐像素，三通道平均绝对差 > `tau` 的像素算「变了」。
 *
 * 为什么不复用 `mcStats` 的 64×36 格子：一格约 12×12 像素，一块 20×20 的小面板
 * 只落进一两格，平均之后差值被稀释 —— 而这恰恰是最需要定量的情况
 * （framedelta 的评测里，<1% 的面板更新被读图方说成「弹出卡片」，就是缺这个数）。
 *
 * 口径要和 `mcStats` **分清**：这里不做运动补偿。整屏滚动会被记成大面积变化，
 * 这是故意的 —— 那两格确实不是同一张画面，读图方需要知道「几乎全换了」。
 *
 * 只在**留下来的帧**上算（一张图 3–8 帧），798×450 一次约 36 万次比较。
 * 两边长度不一致（换了档位/尺寸）时返回 null，不猜。
 */
export function changedArea(prev, cur, { tau = 12 } = {}) {
  if (!prev || !cur || prev.length !== cur.length) return null;
  const n = cur.length;
  let changed = 0;
  for (let i = 0; i < n; i += 3) {
    const d = (Math.abs(cur[i] - prev[i])
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2])) / 3;
    if (d > tau) changed += 1;
  }
  return changed / (n / 3);
}

/**
 * 背景模型：在最近 `history.length` 帧里找**一直没怎么动**的格子，
 * 再看当前帧把这些稳定背景格改掉了多少。
 *
 * 前景运动（手、勺子、遮挡物）只盖住一部分背景，稳定背景格大部分还在；
 * 真正切镜头会把旧背景整片换掉。返回值里的 `score` 是稳定背景格的变化占比（0–255），
 * `stable` 少的时候不要用它下结论。
 */
export function bgStats(history, cur, { stableRange = 24, tau = 15, withModel = false } = {}) {
  const n = SCAN_W * SCAN_H;
  const m = history.length;
  if (m === 0) return { score: null, stable: 0, changed: 0, model: null };
  // 排序用的一次性缓冲，**不在格子循环里分配** —— 旧写法每个格子都 `[0,0,0]`，
  // 2304 格/帧 × 12fps = 每秒 2.7 万个短命数组，全喂给 GC。
  const vals = new Float32Array(m);
  const half = m >> 1;
  const model = withModel
    ? { med: new Float32Array(n * 3), stable: new Uint8Array(n), tau }
    : null;
  let stable = 0;
  let changed = 0;
  for (let c = 0; c < n; c += 1) {
    const p = c * 3;
    let range = 0;
    let medR = 0;
    let medG = 0;
    let medB = 0;
    for (let ch = 0; ch < 3; ch += 1) {
      for (let j = 0; j < m; j += 1) vals[j] = history[j][p + ch];
      // m ≤ 8 的**插入排序**：比 `TypedArray#sort` 快一倍多（后者每次都是一次内建调用，
      // 而这里只有十几次比较）。实测 bgStats 从 1.08ms 降到 0.35ms。
      for (let i = 1; i < m; i += 1) {
        const v = vals[i];
        let k = i - 1;
        while (k >= 0 && vals[k] > v) { vals[k + 1] = vals[k]; k -= 1; }
        vals[k + 1] = v;
      }
      const mid = vals[half];
      if (ch === 0) medR = mid; else if (ch === 1) medG = mid; else medB = mid;
      const r = vals[m - 1] - vals[0];
      if (r > range) range = r;
    }
    if (model) {
      model.med[p] = medR;
      model.med[p + 1] = medG;
      model.med[p + 2] = medB;
    }
    if (range > stableRange) continue;
    stable += 1;
    if (model) model.stable[c] = 1;
    // hsvDiff 的内联版：省一次函数调用 + 省一个 `med` 数组
    const dh = Math.abs(cur[p] - medR);
    const hd = dh < 255 - dh ? dh : 255 - dh;
    const hw = (cur[p + 1] < medG ? cur[p + 1] : medG) / 255;
    const d = (hd * hw + Math.abs(cur[p + 1] - medG) + Math.abs(cur[p + 2] - medB)) / 3;
    if (d > tau) changed += 1;
  }
  return {
    score: stable === 0 ? null : (changed / stable) * 255,
    stable,
    changed,
    model,
  };
}

/** 用候选帧后的画面确认：候选帧改掉的格子，有多少到未来帧还没回到参考背景。 */
export function bgKeep(model, candidate, future, { tau = 15 } = {}) {
  if (!model) return { score: null, changed: 0, kept: 0 };
  const n = SCAN_W * SCAN_H;
  let changed = 0;
  let kept = 0;
  for (let c = 0; c < n; c += 1) {
    const p = c * 3;
    if (hsvDiff(candidate, model.med, p) > tau) {
      changed += 1;
      if (hsvDiff(future, model.med, p) > tau) kept += 1;
    }
  }
  return {
    score: changed === 0 ? null : (kept / changed) * 255,
    changed,
    kept,
  };
}

/**
 * 候选帧改掉了多少外圈（去掉上下黑边）：大面积前景停住时外圈通常还是旧背景；
 * 真正换镜头外圈也会被新画面替换。activeY < 0.25 或全黑时返回 null，保守不判。
 */
export function bgBorderChanged(model, candidate, activeY = 1, { thick = 4, tau = 15 } = {}) {
  if (!model || !(activeY >= 0.25)) return null;
  const bar = activeY >= 0.999 ? 0 : Math.round((1 - activeY) * SCAN_H / 2);
  const t = Math.max(1, Math.min(thick, Math.floor((SCAN_H - bar * 2) / 4)));
  const y0 = bar + t;
  const y1 = SCAN_H - bar - t;
  if (y1 <= y0) return null;
  let total = 0;
  let changed = 0;
  for (let y = bar; y < SCAN_H - bar; y += 1) {
    const edgeRow = y < y0 || y >= y1;
    for (let x = 0; x < SCAN_W; x += 1) {
      if (!(edgeRow || x < t || x >= SCAN_W - t)) continue;
      total += 1;
      if (hsvDiff(candidate, model.med, (y * SCAN_W + x) * 3) > tau) changed += 1;
    }
  }
  if (!total) return null;
  return { score: (changed / total) * 255, changed, total };
}

/** 画面有效高度占比：去掉上下黑边（宽银幕 letterbox），全黑帧返回 0。 */
export function contentHeightRatio(hsv) {
  const darkRow = (y) => {
    let maxV = 0;
    let sum = 0;
    for (let x = 0; x < SCAN_W; x += 1) {
      const v = hsv[(y * SCAN_W + x) * 3 + 2];
      if (v > maxV) maxV = v;
      sum += v;
    }
    return maxV < 24 && sum / SCAN_W < 12;
  };
  let top = 0;
  let bottom = 0;
  while (top < SCAN_H && darkRow(top)) top += 1;
  while (top + bottom < SCAN_H && darkRow(SCAN_H - 1 - bottom)) bottom += 1;
  return (SCAN_H - top - bottom) / SCAN_H;
}

/**
 * 前景守卫用的有效高度：正常情况等同 contentHeightRatio；
 * 全黑帧仍为 0，但“上下暗、中间有亮内容”的暗场不再被当成没有画面。
 */
export function guardHeightRatio(hsv) {
  const ratio = contentHeightRatio(hsv);
  if (ratio >= 0.25) return ratio;
  let maxV = 0;
  const y0 = Math.floor(SCAN_H * 0.25);
  const y1 = Math.ceil(SCAN_H * 0.75);
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < SCAN_W; x += 1) {
      const v = hsv[(y * SCAN_W + x) * 3 + 2];
      if (v > maxV) maxV = v;
    }
  }
  return maxV >= 48 ? 1 : ratio;
}

export function createScorer({
  width, height, scoreMode = 'abs', mcTau = 15, mcRadius = 2, gateMcRadius = mcRadius,
  bgWindow = 6, bgStableRange = 24, bgTau = 15, bgModel = false,
  bgRefWindow = 0, futureMinScore = Infinity, scoreNormalize = false,
}) {
  const n = SCAN_W * SCAN_H;
  const rgb = new Float32Array(n * 3);
  const bgHistory = [];
  const refHistory = [];
  let prev = null;
  let cur = new Float32Array(n * 3);

  /**
   * 亮度归一只对 `abs` 口径有意义：`mc` 的分数是"变了多少格"的占比，阈值
   * （`cutMcAbs: 60`）是另一套刻度，一起放大等于把两条独立标定混成一条。
   */
  const normalize = scoreNormalize && scoreMode !== 'mc';
  /** 黑边滚动窗：存每帧的逐行 V 累加/峰值，判"一直黑"（见 barFraction）。 */
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
    }
    barSlot = (barSlot + 1) % BAR_WINDOW;
    if (barFrames < BAR_WINDOW) barFrames += 1;
    // 窗口内逐行求和/取峰值。24 帧 × 36 行 × 2 = 1728 次浮点运算，12fps 下可忽略。
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
    const { top, bottom } = barRows({ rowV: barV, rowVMax: barVMax, frames: barFrames });
    /**
     * **亮度只算有效行**（跳过上下黑边）。
     *
     * 黑边像素的差恒为 0，把它们的 V 一起平均进来，等于把画面判成"更暗" → gain 再放大一次。
     * 而下面 `barFrac` 还会 `/(1-bar)` 除回来 —— 同一件事补了两遍。
     * 实测（`base-box.mp4`，`pad` 加 1.25 倍高）：全帧 V=68.9 → gain 2.32，有效行 V=92.7 → gain 1.03，
     * 差的这 2.2 倍就是"归一后是原片 2.20 倍"的来源。
     */
    let vSumActive = 0;
    for (let y = top; y < SCAN_H - bottom; y += 1) vSumActive += sums[y];
    const activeRows = Math.max(1, SCAN_H - top - bottom);
    return {
      // `sums[y]` 是**行内像素和**（不是行均值），所以还要除一次 SCAN_W
      meanV: vSumActive / (activeRows * SCAN_W),
      barFrac: barFraction({ rowV: barV, rowVMax: barVMax, frames: barFrames }),
    };
  }

  return function score(frame) {
    gridRgb(frame, width, height, rgb);
    rgbToHsv(rgb, cur);
    let s = null;
    let rawScore = null;
    let gain = 1;
    let barFrac = 0;
    let meanV = null;
    let mcScore = null;
    let mcBox = null;
    let mcFill = null;
    let mcSpanY = 0;
    let bgScore = null;
    let bgStable = 0;
    let bgChanged = 0;
    let bgModelOut = null;
    let futureModel = null;
    const activeY = contentHeightRatio(cur);
    const guardY = guardHeightRatio(cur);
    if (normalize) {
      // 用**当前帧**的亮度/黑边：分数是"这一帧相对上一帧"的，换算到这一帧的亮度上
      // （storyboard 那边取 `means[i + 1]`，同一个道理 —— 取错一帧在快剪处能差出一个刀）
      const st = readBarWindow(cur);
      meanV = st.meanV;
      barFrac = st.barFrac;
    }
    if (bgWindow > 0 && bgHistory.length >= bgWindow) {
      const bg = bgStats(bgHistory, cur, { stableRange: bgStableRange, tau: bgTau, withModel: bgModel });
      bgScore = bg.score;
      bgStable = bg.stable;
      bgChanged = bg.changed;
      bgModelOut = bg.model;
    }
    if (prev) {
      const mc = mcStats(prev, cur, { tau: mcTau, radius: gateMcRadius });
      mcScore = mc.score;
      mcBox = mc.bbox;
      mcFill = mc.fill;
      mcSpanY = mc.spanY;
      if (scoreMode === 'mc') {
        s = gateMcRadius === mcRadius
          ? mcScore
          : mcRatioScore(prev, cur, { tau: mcTau, radius: mcRadius });
      } else {
        rawScore = scorePair(prev, cur);
        s = normalize ? normalizeScore(rawScore, { meanV, barFrac }) : rawScore;
        gain = normalize ? brightnessGain(meanV) : 1;
      }
    }
    if (bgRefWindow > 0
      && s !== null
      && s >= futureMinScore
      && refHistory.length >= Math.min(bgRefWindow, 8)) {
      const ref = bgStats(refHistory, cur, { stableRange: bgStableRange, tau: bgTau, withModel: true });
      futureModel = ref.model;
    }
    const prevHsv = prev ? Float32Array.from(prev) : null;
    const tmp = prev ?? new Float32Array(n * 3);
    tmp.set(cur);
    prev = tmp;
    if (bgWindow > 0) {
      const snapshot = new Float32Array(n * 3);
      snapshot.set(cur);
      bgHistory.push(snapshot);
      if (bgHistory.length > bgWindow) bgHistory.shift();
    }
    if (bgRefWindow > 0) {
      const snapshot = new Float32Array(n * 3);
      snapshot.set(cur);
      refHistory.push(snapshot);
      if (refHistory.length > bgRefWindow) refHistory.shift();
    }
    return {
      score: s, rawScore, gain, barFrac, meanV,
      mcScore, mcBox, mcFill, mcSpanY, activeY, guardY, bgScore, bgStable, bgChanged,
      bgModel: bgModelOut, futureModel, prevHsv, hsv: cur,
    };
  };
}
