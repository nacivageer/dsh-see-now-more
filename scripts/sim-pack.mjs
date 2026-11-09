/**
 * sim-pack.mjs — 观察装箱在真实权重分布下每张图装了什么、浪费多少。
 *
 * 不是测试，是给决策用的：看 4×4 独占这一档到底贵不贵。
 */
import { layoutBatch, sizeForWeight, freeSlots, SLOTS_PER_SHEET } from '../src/pack.js';

/** 把一串权重按"塞不下就 flush"切成一张张 */
function packAll(weights, { allowFull = true } = {}) {
  const sheets = [];
  let cur = [];
  for (const w of weights) {
    let size = sizeForWeight(w);
    if (!allowFull && size === 4) size = 2;
    if (cur.length > 0 && layoutBatch([...cur, size]) === null) {
      sheets.push(cur);
      cur = [];
    }
    cur.push(size);
  }
  if (cur.length) sheets.push(cur);
  return sheets;
}

function summarize(label, weights, opts) {
  const sheets = packAll(weights, opts);
  let usedSlots = 0;
  let frames = 0;
  const spread = new Map();
  for (const s of sheets) {
    frames += s.length;
    usedSlots += s.reduce((n, x) => n + x * x, 0);
    const key = s.map((x) => x).sort().join('+');
    spread.set(key, (spread.get(key) ?? 0) + 1);
  }
  const util = usedSlots / (sheets.length * SLOTS_PER_SHEET);
  console.log(`${label}`);
  console.log(`  ${frames} 帧 → ${sheets.length} 张，槽位利用率 ${(util * 100).toFixed(1)}%，` +
    `平均 ${(frames / sheets.length).toFixed(1)} 帧/张`);
  const top = [...spread.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(`  最常见的组合: ${top.map(([k, n]) => `${k}×${n}`).join('  ')}`);
  return { sheets: sheets.length, frames, util };
}

// ① 只有小帧（画面一直微动）
summarize('全是轻微变化（w=0.25，1×1）', Array.from({ length: 160 }, () => 0.25));

// ② 小帧为主 + 偶发中帧
{
  const ws = [];
  for (let i = 0; i < 200; i++) ws.push(i % 12 === 11 ? 0.5 : 0.25);
  summarize('轻微为主，每 12 帧一个中帧（w=0.5）', ws);
}

// ③ 混入场景切换（w=1.0 → 4×4 独占）
{
  const ws = [];
  for (let i = 0; i < 200; i++) {
    if (i % 20 === 19) ws.push(1.0);
    else if (i % 6 === 5) ws.push(0.5);
    else ws.push(0.25);
  }
  summarize('含场景切换 w=1.0（4×4 独占整张）', ws);
  summarize('同上，但 1.0 降级成 2×2', ws, { allowFull: false });
}

// ④ 全是场景切换（极端）
summarize('全是场景切换（w=1.0）', Array.from({ length: 40 }, () => 1.0));
summarize('全是场景切换，降级成 2×2', Array.from({ length: 40 }, () => 1.0), { allowFull: false });

console.log('\n--- 一张 4×4 独占的图值不值 ---');
const one = layoutBatch([4]);
console.log(`1 帧独占: 384 token / 1 帧 = 384 token/帧，画面 ${4 * 4} 槽`);
const four = layoutBatch([2, 2, 2, 2]);
console.log(`4 帧 2×2 : 384 token / 4 帧 = 96 token/帧，每帧 ${2 * 2} 槽`);
const small = layoutBatch(Array.from({ length: 16 }, () => 1));
console.log(`16 帧 1×1: 384 token / 16 帧 = 24 token/帧，每帧 1 槽`);
console.log(`(独占一张的单帧成本是 16 宫格的 ${(384 / 24).toFixed(0)} 倍)`);

console.log('\n--- 塞不下时还剩多少空槽 ---');
for (const cur of [[2, 2, 2, 2], [2, 2, 2, 1, 1, 1, 1], [2, 2], [1, 1, 1]]) {
  const r = layoutBatch(cur);
  const used = cur.reduce((n, s) => n + s * s, 0);
  console.log(`  已装 ${JSON.stringify(cur)} 用 ${used}/16 槽，剩余 ${freeSlots(cur)} 槽` +
    (r ? '' : ' ← 这批本身就不合法'));
}
