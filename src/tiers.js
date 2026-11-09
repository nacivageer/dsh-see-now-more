/**
 * tiers.js — 档位：这一帧该占多大格子。**因果版**，照 docx 的算法（卷积 → 平滑 → 7 阈值 + 滞回 → 1..8）。
 *
 * ## 与 docx / storyboard 0.6.0 的三处换算
 *
 * docx 写死了三件事：`dt = 100 帧`、阈值是「**每帧**碰上切点的概率」、默认 30fps。
 * 三者是绑死的，单独改 dt 会让整套阈值失效：
 *
 *   dt=100 帧、30fps → 窗宽 3.33s；阈值 0.0085 = 每 118 帧一刀
 *   dt=12 帧、12fps  → 窗宽 1s；    一刀就是 1/12 = 0.083，**一步跨过 5 道阈值**
 *
 * 所以阈值整体换成 **「帧/秒」**（= 原表 × 30），跟 fps 脱钩，dt 才真的变成「看过去几秒」：
 *
 *   [0.26, 0.6, 0.9, 1.2, 1.8, 2.4, 3.0] 帧/秒  ≈ 3.9s / 1.7 / 1.1 / 0.83 / 0.56 / 0.42 / 0.33 一帧
 *
 * ## 密度数的是什么
 *
 * storyboard 只数**真切点**，因为批量场景里「帧 = 镜头」。实时场景里一镜到底的素材
 * 一个真切点都没有，只数切点会让档位永远停在 1 档 —— 而积分帧照样往外冒。
 * 所以这里数的是**所有边界**（切点 + 积分帧 + 兜底帧），也就是「每秒留下几帧」，
 * 它跟「一张图能放几格」是同一件事：
 *
 *   档 k 的格子占比 1/k²，一张图放 k² 格 → 每秒 F 帧时，一张图覆盖 k²/F 秒
 *   k ≈ sqrt(T·F)，取 T≈16s：F=0.25 → k=2；F=1 → k=4；F=4 → k=8
 *
 * 正好落在上面那张阈值表上 —— 这不是巧合，docx 的阈值本来就是按「每秒几刀」标的。
 *
 * ## 两处因果化（批量版都用了未来）
 *
 * - 密度窗：居中 `[t-dt/2, t+dt/2]` → **只看过去** `[t-dt, t]`
 * - 平滑：`movmean(50 帧)` → 每帧走一步的一阶 EMA
 *
 * `tick(t)` 必须**每帧都调**（12 次/秒），不能只在留帧时调 —— 只在留帧时调的话
 * EMA 的步长跟着留帧间隔走，两帧留得远就一步跳满，密度会瞬间冲顶。
 */

/** 帧/秒。docx 的 7 道阈值 × 30fps。 */
export const LEVEL_THRESHOLDS = Object.freeze([0.26, 0.6, 0.9, 1.2, 1.8, 2.4, 3.0]);
export const HYSTERESIS = 0.05;
export const TIER_MIN = 1;
export const TIER_MAX = 8;

/**
 * 实时只用三个策略（storyboard 的 standard「1 档压成 1/2」在实时里等于单帧永远不给整幅，
 * 静态画面白扔 75% 画布，所以不要它）：
 */
export const STRATEGIES = Object.freeze({
  native: { bump: 0, label: '原生' },
  full: { bump: -1, floor: 1, label: '更大' },
  compact: { bump: 1, label: '更小' },
  /**
   * **逐帧模式**专用：不管密度多高，每一帧都占满整张画布。
   *
   * 密度档位是为"一张图塞多帧"设计的 —— 帧越密格子越小。但逐场景播报要的是
   * "一张图 = 一个画面"，格子必须撑满，否则一帧只占 1/4 或 1/9，中间全是灰条。
   * 0（自由尺寸的补位帧）原样保留。
   */
  single: { fixed: 1, label: '整幅' },
});

export function applyStrategy(tiers, strategy = 'native') {
  const s = STRATEGIES[strategy] ?? STRATEGIES.native;
  // 固定档：不管原来算出来是几档，全部压到同一档
  if (s.fixed) return tiers.map((t) => (Number(t) === 0 ? 0 : s.fixed));
  return tiers.map((t) => {
    let v = t + s.bump;
    if (s.floor) v = Math.max(s.floor, v);
    return Math.max(TIER_MIN, Math.min(TIER_MAX, v));
  });
}

export function createTiers({
  fps = 12, dtFrames = 12, smoothFrames = 6,
  thresholds = LEVEL_THRESHOLDS, hysteresis = HYSTERESIS,
} = {}) {
  const W = Math.max(1, dtFrames) / fps;             // 密度窗（秒）
  const alpha = 1 / Math.max(1, smoothFrames);       // 每帧一步的 EMA 系数
  const up = thresholds.map((v) => v * (1 + hysteresis));
  const down = thresholds.map((v) => v * (1 - hysteresis));

  const bounds = [];      // 已留下的帧的时刻（秒）
  let smoothed = 0;
  let level = 1;

  const countAtLeast = (val, arr) => {
    let k = 0;
    for (let i = 0; i < arr.length; i += 1) if (val >= arr[i]) k += 1;
    return k;
  };

  return {
    /** 记一个边界（帧被留下的时刻）。 */
    mark(t) {
      bounds.push(t);
    },

    /** 每帧调一次：更新密度与档位。**不含当前帧**（它还没被 mark）。 */
    tick(t) {
      const lo = t - W;
      let i = bounds.length - 1;
      let n = 0;
      while (i >= 0 && bounds[i] > lo) { n += 1; i -= 1; }
      const raw = n / W;
      smoothed += (raw - smoothed) * alpha;

      const val = smoothed;
      if (level < TIER_MAX && val > up[level - 1]) {
        level = 1 + countAtLeast(val, up);
      } else if (level > TIER_MIN && val < down[level - 2]) {
        level = 1 + countAtLeast(val, down);
      }
      level = Math.max(TIER_MIN, Math.min(TIER_MAX, level));

      // 窗口外的边界再也用不到（多留 1s 余量），别让数组无限长
      if (i > 64) bounds.splice(0, i - 1);
      return level;
    },

    levelAt() { return level; },

    get density() { return smoothed; },
    get bounds() { return bounds; },
    get widthSec() { return W; },
  };
}
