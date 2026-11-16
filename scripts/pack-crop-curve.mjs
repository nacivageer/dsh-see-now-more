/**
 * pack-crop-curve.mjs — 排布容差（`stretch`）到底换来什么、代价是多少。
 *
 * 不是测试，是给决策用的：`stretch` 会在渲染时把格子拉成矩形，`coverIntoAt` 按短边
 * 铺满、长边居中裁掉 —— 所以"多装一帧"的代价是**每一格都少一块画面**，而且裁多裁少
 * 由当行的档位组合决定。这个脚本按真实档位分布把两笔账一起打出来。
 *
 *   node scripts/pack-crop-curve.mjs
 *
 * 输出四段（静态 / 一般 / 偏斜 / 快），每段一行一个 stretch 值：
 *   帧/张      = 一张图装几帧（越少 = 越费 token）
 *   平均裁     = 按格面积加权的裁切比例
 *   最大裁     = 最惨那一格
 *   有裁的格子 = 多少比例的格子被切过（>1% 才算）
 *
 * 画布比例取 16:9（`fitCanvasToTokens` 按源比例建画布，默认就是这个）；格子是正方形时
 * 比例正好等于源画面，**一格不裁**。这就是 `stretch = 0` 的含义。
 */
import { solve } from '../src/pack.js';

const CANVAS_W = 800;
const CANVAS_H = 450;
const SRC_AR = CANVAS_W / CANVAS_H;
const N_SEQ = 150;      // 每个 (画像 × stretch) 采样的序列条数
const SEQ_LEN = 40;     // 每条序列的帧数

/** 确定性伪随机：同一台机器、同一份代码，跑出来的表必须一字不差。 */
function rnd(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function seq(kind, n, seed) {
  const r = rnd(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (kind === 'calm') out.push(1);
    else if (kind === 'mixed') out.push(1 + Math.floor(r() * 3));        // 1..3
    else if (kind === 'skew') out.push(r() < 0.6 ? 1 : 1 + Math.floor(r() * 8));
    else out.push(1 + Math.floor(r() * 8));                              // busy 1..8
  }
  return out;
}

function measure(tiers, stretch) {
  const r = solve(tiers, { binCost: 1000, stretch });
  let visible = 0;
  let area = 0;
  const crops = [];
  for (const c of r.cells) {
    const ar = (c.w * CANVAS_W) / (c.h * CANVAS_H);
    const vis = Math.min(ar, SRC_AR) / Math.max(ar, SRC_AR);
    visible += vis * c.w * c.h;
    area += c.w * c.h;
    crops.push(1 - vis);
  }
  crops.sort((a, b) => a - b);
  return {
    frames: r.cells.length / r.bins,
    meanCrop: area ? 1 - visible / area : 0,
    worst: crops[crops.length - 1] ?? 0,
    touched: crops.filter((c) => c > 0.01).length / crops.length,
  };
}

const KINDS = [
  ['calm', '静态（全 1 档：看视频、挂机）'],
  ['mixed', '一般（1–3 档混：网页、文档）'],
  ['skew', '偏斜（六成 1 档 + 少量高密度：聊天窗）'],
  ['busy', '快（1–8 档乱：游戏战斗、快剪）'],
];
const STEPS = [0, 0.1, 0.2, 0.3];

for (const [kind, label] of KINDS) {
  console.log(`\n== ${kind} — ${label}`);
  for (const stretch of STEPS) {
    let frames = 0;
    let mean = 0;
    let worst = 0;
    let touched = 0;
    for (let k = 0; k < N_SEQ; k += 1) {
      const m = measure(seq(kind, SEQ_LEN, 7919 * (k + 1) + kind.length), stretch);
      frames += m.frames;
      mean += m.meanCrop;
      worst += m.worst;
      touched += m.touched;
    }
    const p = (v) => `${(v * 100).toFixed(1)}%`.padStart(6);
    console.log(`  stretch ${String(stretch).padEnd(4)}`
      + ` ${(frames / N_SEQ).toFixed(2).padStart(5)} 帧/张`
      + `   平均裁${p(mean / N_SEQ)}   最大裁${p(worst / N_SEQ)}   有裁${p(touched / N_SEQ)}`);
  }
}
