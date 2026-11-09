#!/usr/bin/env node
/**
 * spacing-probe.mjs — 采一段真屏幕，把**同一批帧**同时喂给各档管线，量「一张图里相邻两帧隔多久」。
 *
 * 为什么要它：`missed.jsonl` 里「单图内部空窗」的阈值（`missedGapSec`）必须比**正常帧间距**
 * 明显大，否则每张图自己的帧间距都会被写成空档（第一版拿 3 秒判，就是这样报错的）。
 * 正常间距不是常数：`dense` 切点更密、`calm` 更稀，`floorGapK` 也不一样。
 *
 *   node scripts/spacing-probe.mjs [--sec=90] [--width=798] [--height=450] [--fps=12]
 *                                  [--paces=calm,normal,dense] [--json=path]
 *
 * 输出：每档的张数、帧/张、帧间距分位、建议阈值（2.5×p90，夹在 15–300 秒）。
 * 采集走和线上一样的 `spawnFrames`，参数取 `runner.js` 的 `PACES`（不复制一份，避免漂移）。
 */

import { writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { resolveFfmpeg } from '../src/binaries.js';
import { spawnFrames } from '../src/capture.js';
import { createPipeline } from '../src/pipeline.js';
import { PACES } from '../src/runner.js';

const numArg = (name, def) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  const n = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(n) ? n : def;
};
const strArg = (name) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

const sec = numArg('sec', 90);
const width = numArg('width', 798);
const height = numArg('height', 450);
const fps = numArg('fps', 12);
const jsonOut = strArg('json');
const file = strArg('file');
const names = (strArg('paces') ?? 'calm,normal,dense').split(',').filter(Boolean);

for (const n of names) {
  if (!PACES[n]) {
    console.error(`未知节奏：${n}（可选 ${Object.keys(PACES).join(' / ')}）`);
    process.exit(2);
  }
}

const runs = names.map((name) => {
  const pace = PACES[name];
  const pipe = createPipeline({
    width,
    height,
    fps,
    cutAbs: pace.cutAbs,
    ...(pace.pipeline ?? {}),
    audioStrip: false,
    queueDepth: 0,
  });
  return { name, pipe, sheets: [] };
});

const { path: ffmpegPath } = resolveFfmpeg();
let run = null;
run = spawnFrames({
  source: file ? { kind: 'file', path: file } : { kind: 'screen' },
  width,
  height,
  fps,
  ffmpegPath,
  onFrame: (f) => {
    if (f.t > sec) { run?.stop?.(); return; }
    for (const r of runs) {
      r.pipe.push(f);
      let s;
      while ((s = r.pipe.take())) r.sheets.push(s);
    }
  },
});

await run.done;
for (const r of runs) {
  try { r.pipe.finish(); } catch { /* 老版本没有 finish 也无妨 */ }
  let s;
  while ((s = r.pipe.take())) r.sheets.push(s);
}

const pct = (arr, q) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
};

const report = [];
for (const r of runs) {
  const intra = [];      // 同一张图里相邻两帧的间距
  const between = [];    // 上一张的 to → 这一张的 from
  for (let i = 0; i < r.sheets.length; i += 1) {
    const s = r.sheets[i];
    const ts = (s.frames ?? []).map((f) => f.t);
    for (let k = 1; k < ts.length; k += 1) intra.push(+(ts[k] - ts[k - 1]).toFixed(1));
    if (i > 0) between.push(+(s.from - r.sheets[i - 1].to).toFixed(1));
  }
  const framesPer = r.sheets.length ? r.sheets.reduce((a, s) => a + s.frames.length, 0) / r.sheets.length : 0;
  const spans = r.sheets.map((s) => +(s.to - s.from).toFixed(1));
  report.push({
    pace: r.name,
    cutAbs: PACES[r.name].cutAbs,
    sheets: r.sheets.length,
    framesPer: +framesPer.toFixed(1),
    intra: {
      n: intra.length,
      p50: pct(intra, 0.5),
      p90: pct(intra, 0.9),
      max: intra.length ? Math.max(...intra) : 0,
    },
    between: { p50: pct(between, 0.5), p90: pct(between, 0.9) },
    spanMax: spans.length ? Math.max(...spans) : 0,
  });
}

// 建议阈值：**2 × 设计上的最大正常间距**。
//
// 正常间距的上界是各档的 `floorMax`（兜底帧最迟多久来一次：calm 30 / normal 20 / dense 20），
// 实测还会略超一点（静止屏幕见过 23.4 秒）。阈值取它的两倍，既不会把正常节拍写成空档，
// 又能在"一张图里真有一分钟没画面"时报警。
const designMaxFloor = Math.max(...names.map((n) => PACES[n].pipeline?.floorMax ?? 20));
const measuredMax = Math.max(...report.map((r) => r.intra.max), 0);
const suggest = Math.max(30, Math.min(300, Math.ceil(2 * Math.max(designMaxFloor, measuredMax))));

console.log(`\n采了 ${sec} 秒 · ${width}×${height} @${fps}fps · ${file ? `素材 ${file}` : '实时屏幕'} · ffmpeg ${ffmpegPath}`);
console.log('节奏'.padEnd(10) + '张数'.padStart(4) + '帧/张'.padStart(7) + '帧间距 p50/p90/max'.padStart(22)
  + '张间空档 p50'.padStart(13) + '整张跨度 max'.padStart(13));
for (const r of report) {
  console.log(`${r.pace}(${r.cutAbs})`.padEnd(10)
    + String(r.sheets).padStart(4)
    + r.framesPer.toFixed(1).padStart(7)
    + `${r.intra.p50}/${r.intra.p90}/${r.intra.max}`.padStart(22)
    + String(r.between.p50).padStart(13)
    + `${r.spanMax}s`.padStart(13));
}
console.log(`\n建议 missedGapSec = ${suggest}（= 2 × max(设计上界 ${designMaxFloor}s, 实测最大 ${measuredMax}s)，夹在 30–300 秒）`);
console.log('现在的默认是 60：正常间距上界（calm 的 floorMax 30 秒）的两倍；阈值再大就只是让"一分钟没画面"漏掉。');

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ sec, width, height, fps, at: new Date().toISOString(), report, suggest }, null, 2));
  console.log(`\n明细 → ${jsonOut}`);
}
