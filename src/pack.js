/**
 * pack.js — 可变尺寸的分镜排布：把 N 个格子按 1/k 档位排进方形画布，最大化占用率。
 *
 * 每格可以不同大小（1/1…1/8，可连续缩放到相邻一档），按行流式排布，
 * 最后一行不满也不会留整格空槽。**帧的时序一格不动**：格子 i 放第 i 帧。
 *
 * 几何约定（与 Python 原型 pack_squares/ 完全一致）：
 *   - 在**归一化方形容器** [0,1]² 里排方块，格子边长 s 就是"占容器宽度的比例"
 *   - 行高 = 该行最大边长；行内上沿对齐
 *   - 档位 k 的边长 1/k，可缩放到 [1/(k+1), 1/(k-1)]；1/2 不许放大，1 只许缩到 1/2
 *
 * 换回像素时：格子是正方形 → 直接乘 width/height 就变成 width:height 的矩形。
 * 所以**源画面比例 = 画布比例**时格子不变形；要别的比例就换 width/height 即可。
 */

/** 允许"升"的档位（1 和 1/2 一律不许升：它们已经是"满格"了）。 */
export const DEFAULT_GROW = Object.freeze([3, 4, 5, 6, 7, 8]);
/** 高度网格精度：容器宽度分成多少份。840 = lcm(1..8)，让所有档位都是整数。 */
export const UNIT = 840;

/**
 * 宽高比容差（与 storyboard 的 pack.DEFAULT_STRETCH 同一个数）。
 *
 * 0.3：最宽的格压到 h/w = 1/1.3、最窄格拉到 1.3，一行里能拉平的组合明显变多。
 * 实测 40 帧混合档位的 solve 从 1.78ms 涨到 2.25ms（p50），换来箱数 -5%；
 * 帧预算 83ms，这点开销可以忽略，而少 flush 一次省的是 PNG 8.3ms。
 */
export const DEFAULT_STRETCH = 0.3;

/**
 * 档位 k 的边长区间（UNIT 单位）。
 *
 *   k=1  [1/2, 1]     —— 整幅只许缩到一半（两张 1 档正好并排）
 *   k=2  [1/3, 1/2]   —— 只许缩小（1/2 已经是"能看清"的上限）
 *   k≥3  [1/(k+1), 1/(k-1)] —— 相邻一档之间连续取值
 */
/** 自由尺寸（补位帧用）：边长可以在 1/12 ~ 1/1 之间任意取，由排布器决定。 */
export const FREE = 0;

export function bounds(k, grow = DEFAULT_GROW) {
  // FREE 档：没有"档位"这回事，只给物理下限（再小就认不出画面）和上限（整幅）
  // 下限给得很小：补位帧就是来填缝的，剩多窄就填多窄（1/24 ≈ 33px，再小就认不出画面了）。
  // 上限锁在 1/2：允许它长到整幅时会被排布器挪去别处占地盘（实测跑掉）。
  if (k === FREE) return [UNIT / 24, UNIT / 2];
  const lo = UNIT / (k + 1);
  const up = k >= 3 && grow.includes(k) ? UNIT / (k - 1) : UNIT / k;
  return [lo, up];
}

/**
 * 一行（连续若干格）的候选方案。
 * @param {number[]} tiers 这一行各格的档位
 * @returns {Array<{c:number, A:number, s:number[]}>} c=行高(UNIT)，A=行内面积，s=各格边长
 */
const ROW_CACHE = new Map();
const ROW_CACHE_MAX = 20000;

export function rowOptions(tiers, grow = DEFAULT_GROW, stretch = DEFAULT_STRETCH, fillRows = true) {
  // **键必须覆盖所有影响结果的参数**：键里只要 `stretch > 0.15` 这个布尔是错的 ——
  // flat 的行高直接等于 `最宽/(1+stretch)`，0.2 和 0.3 会算出不同的候选，
  // 却共用同一份缓存。加了 `grow` 之后还多一层：允不允许升档也是两套结果。
  //
  // 2026-11-04 把默认 stretch 从 0.2 提到 0.3 时踩到了：先算过 0.2 再算 0.3，
  // 拿到的是 0.2 的候选（flat 缺失），单测直接给出假结论。
  // 原来的数值键还有个隐患：`key * 9 + tier` 累乘，60 档时早就越过安全整数范围。
  const key = `${tiers.join(',')}|${grow.join(',')}|${stretch}|${fillRows ? 1 : 0}`;
  const hit = ROW_CACHE.get(key);
  if (hit !== undefined) return hit;
  const val = rowOptionsRaw(tiers, grow, stretch, fillRows);
  if (ROW_CACHE.size > ROW_CACHE_MAX) ROW_CACHE.clear();
  ROW_CACHE.set(key, val);
  return val;
}

function rowOptionsRaw(tiers, grow, stretch, fillRows = true) {
  const cs = tiers.map((k) => (k === FREE ? UNIT / 4 : UNIT / k));
  const los = tiers.map((k) => bounds(k, grow)[0]);
  const his = tiers.map((k) => bounds(k, grow)[1]);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  if (sum(los) > UNIT + 1e-9) return [];

  const out = [];
  if (sum(cs) <= UNIT) out.push({ c: Math.max(...cs), A: sum(cs.map((x) => x * x)), s: cs });

  // **最小档候选**：每格都压到自己的下限。
  //
  // 批量场景用不到它（`fillGaps` 会把不满的张重排），但实时逐帧追加必须要有：
  // 3 个 1 档帧的正确排法是「2 个并排 + 1 个占半行」（75%），而原来一行只有
  // 「铺满整宽」这一个候选（1 档 = 840），于是 2+1 直接超出一箱 → 误判成"装不下"，
  // 结果每张只放 2 帧、fill 恒 50%。加了这个锚点，L 形排法才存在。
  const cMin = Math.max(...los);
  if (los.every((v, i) => Math.abs(v - cs[i]) > 1e-9)) {
    out.push({ c: cMin, A: sum(los.map((x) => x * x)), s: los.slice() });
  }
  // `fillRows=false`：**不强行把这一行填满**。格子按自己的档位尺寸放，剩下多少空多少，
  // 换行就行（用户要的"从上到下、从左到右"流式排法）。这时只剩"原尺寸"这一个候选。
  if (!fillRows) return out;

  // 二分出行高，把矮的往高的拉平，使总宽正好 = UNIT
  let s;
  if (sum(his) < UNIT - 1e-9) {
    s = his.slice();                        // 全放到最大也填不满
  } else {
    let a = 0, b = Math.max(...his);
    for (let i = 0; i < 24; i += 1) {
      const m = (a + b) / 2;
      const tot = tiers.reduce((acc, _, j) => acc + Math.min(Math.max(m, los[j]), his[j]), 0);
      if (tot < UNIT) a = m; else b = m;
    }
    s = tiers.map((_, j) => Math.min(Math.max(b, los[j]), his[j]));
    const tot = sum(s);
    if (tot > UNIT) s = s.map((v) => (v * UNIT) / tot);
  }
  const c = Math.max(...s);
  const A = sum(s.map((v) => v * v));
  if (!out.length || Math.abs(out[0].c - c) > 1e-9 || Math.abs(out[0].A - A) > 1e-9) {
    out.push({ c, A, s });
  }

  // 3) **格内拉伸**：同一行里各自纵向拉高到行高（宽高比变化 <= stretch）
  //    可行条件是"最宽的格 / 最窄的格 <= 1 + 2*stretch"，此时行高取 最宽/(1+stretch)。
  //    满足后这一行**零空隙**（面积 = 行高 × 1）。
  if (stretch > 0 && s.length > 1) {
    const wmax = Math.max(...s), wmin = Math.min(...s);
    if (wmax <= wmin * ((1 + stretch) * (1 + stretch)) + 1e-9) {
      const c2 = wmax / (1 + stretch);
      const A2 = c2 * sum(s);                    // 面积 = 行高 × 本行实占宽度（未满宽就不许虚报）
      if (!out.some((o) => Math.abs(o.c - c2) < 1e-9 && Math.abs(o.A - A2) < 1e-9)) {
        out.push({ c: c2, A: A2, s, flat: true });
      }
    }
  }
  return out;
}

/** 预计算：ropt[i][ln-1] = seq[i..i+ln) 这一行的候选。DP 内层只查表。 */
export function precompute(tiers, grow = DEFAULT_GROW, stretch = DEFAULT_STRETCH, fillRows = true) {
  const n = tiers.length;
  const ropt = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    for (let ln = 1; ln <= 8 && i + ln <= n; ln += 1) {
      const opts = rowOptions(tiers.slice(i, i + ln), grow, stretch, fillRows);
      if (!opts.length) break;                 // 更长只会更宽
      ropt[i].push(opts);
    }
  }
  return ropt;
}

/**
 * 精确 DP：给定档位序列，求占用率最高的按行排布。
 *
 * 目标函数是 `Σ面积 − 箱数 × 每箱面积 × 1.02`。
 * 那个 1.02 是**箱子本身的代价**：多一张图就多付一份图像的钱（按像素算，不是 384/张），
 * 所以两套排布占用率相同时必须选箱数少的。没有它的时候
 * `[1,1]` 会被排成"两张各 100%"，而正确解是"一张里并排两个 1/2"。
 *
 * @returns {{bins:number, fill:number, area:number,
 *            cells:Array<{x:number,y:number,w:number,h:number,t:number,f:number,bin:number}>}}
 *          x/y/w/h 是归一化坐标（0..1，y 相对本张），t=档位，f=实际缩放系数
 */
export function solve(tiers, {
  grow = DEFAULT_GROW, mu = 1, stretch = DEFAULT_STRETCH, binCost = 1.02, fillRows = true,
} = {}) {
  const n = tiers.length;
  if (!n) return { bins: 0, fill: 0, cells: [], area: 0 };
  const ropt = precompute(tiers, grow, stretch, fillRows);
  const CAP = UNIT;                     // 方形容器：行高总和 <= 1
  const BIN = UNIT * UNIT;              // 每箱面积
  const CLOSE = BIN * binCost;          // 封箱的真实代价

  /** dp[i] = Map(累计行高 -> [score, areaSum, back]) */
  const dp = Array.from({ length: n + 1 }, () => new Map());
  dp[0].set(0, [0, 0, null]);

  for (let i = 0; i < n; i += 1) {
    const cur = dp[i];
    if (!cur.size) continue;
    // 就地封箱
    let bc = -Infinity, bestA = 0, bC = null;
    for (const [C, [v, a]] of cur) {
      const v2 = v - CLOSE;
      if (v2 > bc) { bc = v2; bestA = a; bC = C; }
    }
    if (bC !== null && !cur.has(0)) cur.set(0, [bc, bestA, { close: bC }]);

    for (const [C, [v, a]] of [...cur]) {
      for (let ln = 1; ln <= ropt[i].length; ln += 1) {
        const j = i + ln;
        const tgt = dp[j];
        for (const opt of ropt[i][ln - 1]) {
          const ci = Math.round(opt.c);
          let nC = C + ci;
          let nv = v + mu * opt.A;
          const na = a + opt.A;
          if (nC > CAP) { nv -= CLOSE; nC = ci; }
          const old = tgt.get(nC);
          if (!old || nv > old[0]) tgt.set(nC, [nv, na, { i, C, s: opt.s, flat: !!opt.flat, c: opt.c }]);
        }
      }
    }
  }

  let bestV = -Infinity, bestRec = null;
  for (const [C, [v, a]] of dp[n]) {
    const v2 = v - CLOSE;
    if (v2 > bestV) { bestV = v2; bestRec = [v2, a, C]; }
  }
  const [, aSum] = bestRec;
  let C = bestRec[2];

  // 回溯
  const rows = [];
  let i = n;
  while (i > 0) {
    const st = dp[i].get(C)?.[2];
    if (!st) break;
    if (st.close !== undefined) { C = st.close; continue; }
    rows.push({ i0: st.i, s: st.s, flat: st.flat, c: st.c });
    i = st.i;
    C = st.C;
  }
  rows.reverse();

  const cells = [];
  let binH = 0;
  let bin = 0;
  rows.forEach(({ i0, s, flat, c }) => {
    const rowH = flat ? c : Math.max(...s);          // 拉伸行：统一拉高到行高
    const cN = rowH / UNIT;
    if (binH + cN > 1 + 1e-9) { binH = 0; bin += 1; }
    let x = 0;
    s.forEach((sv, k) => {
      const tier = tiers[i0 + k];
      cells.push({
        x: x / UNIT,
        y: binH,
        w: sv / UNIT,
        h: (flat ? rowH : Math.min(rowH, sv * (1 + stretch))) / UNIT,
        s: sv / UNIT,                                 // 兼容旧字段
        stretch: sv / (flat ? rowH : Math.min(rowH, sv * (1 + stretch))),
        t: tier,
        f: (sv * tier) / UNIT,
        bin,                                          // 第几张图（0-based）
        seq: cells.length,                            // 时序（= 帧序号 - 1）
      });
      x += sv;
    });
    binH += cN;
  });

  // 箱数与占用率一律按**重建后的真实几何**算，避免 DP 记账与渲染不一致
  const binsReal = cells.length ? Math.max(...cells.map((c) => c.bin)) + 1 : 0;
  const areaReal = cells.reduce((acc, c) => acc + c.w * c.h, 0);
  return {
    bins: binsReal, fill: binsReal ? areaReal / binsReal : 0, cells, area: areaReal,
  };
}

/**
 * 把一串档位切成**每段都能装进一张图**的若干段（保序、不丢帧、尽量往前塞）。
 *
 * ## 为什么要有它
 *
 * `solve()` 的 DP 允许跨箱：`bins > 1` 时 `cells` 里照样**包含全部帧**，只靠 `bin` 字段
 * 区分。而画的时候只有一张画布 —— 第二箱的 y 从 0 重新开始，后画的格子**盖在前面的
 * 格子上**，出来是一张糊在一起的图。所以"送进 flush 的批次必须单箱"是硬不变量。
 *
 * ## 现在的正确性靠的是巧合，不是推理
 *
 * 旧代码（多箱时只退一帧）**实测是对的**：穷举 6 组参数 × 6 万条随机序列，没有一条
 * 能让"退一帧"之后仍然多箱。原因是 `solve` 会拉伸格子，**4 个 1 档帧仍然装得进一张**
 * （5 个才装不下），而 `boostMinFrames = 4` 让加成恰好在 4→3 这一档关掉 ——
 * 两个数字刚好咬住，于是每一步都回到了"上一次装得下的状态"。
 *
 * 但这条推理依赖 `boostMinFrames` 和"4 个 1 档装得下"这两件事同时成立。
 * 改 `markBoost`、改 `boostMinFrames`、或者哪天 pack 的拉伸策略变了，
 * 就会**静默**交出一张糊图（画面错了但没人报错）。所以这里改成"退到装得下为止"，
 * 把巧合换成显式规则；`stats.overflow` 是最后一道闸的计数器。
 *
 * @param {number[]} tiers 档位序列（时间顺序）
 * @param {object} [opts] 传给 `solve` 的参数（`binCost` 必须和出图时一致）
 * @returns {number[][]} 至少一段；每段 `solve(段).bins === 1`
 */
export function splitOneBin(tiers, opts = {}) {
  const list = Array.isArray(tiers) ? tiers : [];
  if (list.length === 0) return [];
  const segs = [];
  let cur = [];
  for (const t of list) {
    const next = [...cur, t];
    // 单帧一定装得下（一个格子），所以这里不会出现空段
    if (cur.length > 0 && solve(next, opts).bins > 1) {
      segs.push(cur);
      cur = [t];
    } else {
      cur = next;
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/**
 * 归一化格子 → 像素矩形。
 * @param {Array} cells solve() 的 cells（可以只传一张图的那部分）
 * @param {{width:number, height:number, gutter?:number, bin?:number|null}} o
 *        width/height 决定画布尺寸；两者之比 = 每个格子的画面比例
 *        bin 给定时只取那一张的格子
 */
export function toRects(cells, { width, height, gutter = 0, bin = null } = {}) {
  const list = bin === null ? cells : cells.filter((c) => c.bin === bin);
  const out = list.map((c, idx) => ({
    ...c,
    // 编号是**全局**的：跨张连续，第 2 张从第 17 格接着数
    index: Number.isInteger(c.seq) ? c.seq + 1 : idx + 1,
    px: Math.round(c.x * width) + gutter,
    py: Math.round(c.y * height) + gutter,
    pw: Math.max(1, Math.round((c.w ?? c.s) * width)),
    ph: Math.max(1, Math.round((c.h ?? c.s) * height)),
  }));
  // 取整会让相邻格子差 1px（重叠/裂缝）。两个方向各修一次，只动 1~2px：
  //   水平——同一行里把左边缘贴到前一格的右边缘；
  //   垂直——下一行的上边缘贴到本行的下边缘（否则相邻行会重叠 1px，渲染时后画的盖住前一行）。
  const rows = new Map();
  out.forEach((c) => {
    const k = `${Math.round(c.y * height)}|${Math.round(c.h * height)}`;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(c);
  });
  for (const row of rows.values()) {
    row.sort((a, b) => a.px - b.px);
    for (let i = 1; i < row.length; i += 1) {
      const prev = row[i - 1];
      const cur = row[i];
      const edge = prev.px + prev.pw;
      if (Math.abs(cur.px - edge) <= 2) {
        cur.pw += cur.px - edge;
        cur.px = edge;
      }
    }
  }
  const tops = [...new Set(out.map((c) => c.py))].sort((a, b) => a - b);
  let prevBottom = null;
  for (const top of tops) {
    const line = out.filter((c) => c.py === top);
    if (prevBottom !== null && top < prevBottom && prevBottom - top <= 2) {
      const shift = prevBottom - top;
      for (const c of line) {
        c.py += shift;
        c.ph = Math.max(1, c.ph - shift);
      }
    }
    prevBottom = Math.max(...line.map((c) => c.py + c.ph));
  }
  return out;
}
