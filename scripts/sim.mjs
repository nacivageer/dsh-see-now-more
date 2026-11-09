#!/usr/bin/env node
/**
 * sim.mjs — 离线喂一个视频文件跑整条实时管线，把 sheet 落盘 + 打印时间轴。
 *
 *   node scripts/sim.mjs <video> [--out dir] [--max-sec N] [--key=value ...] [--area]
 *
 * 参数透传：`--dtFrames=24 --integralSeconds=3 --maxWaitSec=20 --strategy=full`
 * `--area`：打印每格的变化面积（Δ，相对上一格）和插话帧的 Δ —— 对账「图上的数和
 * 肉眼看到的变化」是否一致时用；不加这个开关时输出和以前完全一样。
 *
 * 为什么要有它：实时管线里"档位/截断"这两个判据必须用**真素材**标定，
 * 而屏幕采集没法回放。这个脚本用 `-r 12` 把文件当成 12fps 的直播流喂进来，
 * 除了没有真时间轴，其余和线上完全同一条代码路径。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnFrames } from '../src/capture.js';
import { createPipeline, DEFAULTS } from '../src/pipeline.js';

const NUM = new Set(['width', 'height', 'fps', 'cutAbs', 'cutSpike', 'cutMinGap',
  'integralSeconds', 'markMinGap', 'silentFloorSec', 'dtFrames', 'smoothFrames', 'dupMin', 'queueDepth',
  'maxWaitSec', 'flushGain', 'maxFrames', 'binCost', 'maxSec',
  'markBoost', 'floorBoost']);

const args = argv.slice(2);
const positional = [];
const opts = {};
let outDir = '.tmp/out';
let areaFlag = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const body = a.slice(2);
  const eq = body.indexOf('=');
  const k = eq >= 0 ? body.slice(0, eq) : body;
  let v = eq >= 0 ? body.slice(eq + 1) : undefined;
  // 只有 --out 允许用空格给值（路径里带 = 会麻烦）；其余一律 --k=v
  if (v === undefined && k === 'out' && i + 1 < args.length) v = args[++i];
  if (k === 'out') { outDir = v ?? outDir; continue; }
  // `--band=0.84,1,0.1` 或 `--band=auto`：字幕带（比例 / 自动定位），不是数字，单独拆
  if (k === 'band') {
    const raw = String(v ?? '');
    opts.band = raw === 'auto' ? 'auto' : raw.split(',').map(Number);
    continue;
  }
  // `--area`：布尔开关（`--area` / `--area=0` 都认）
  if (k === 'area') {
    areaFlag = !(v === '0' || v === 'false');
    continue;
  }
  opts[k] = NUM.has(k) ? Number(v) : v;
}
const file = positional[0];
if (!file) {
  console.error('usage: node scripts/sim.mjs <video> [--out dir] [--dtFrames=24 ...]');
  exit(2);
}
const maxSec = opts.maxSec ?? Infinity;
const interject = String(opts.interject ?? '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
const hits = [];
delete opts.interject;
delete opts.maxSec;

const name = basename(file, extname(file)).replace(/[^\w.-]+/g, '_');
mkdirSync(outDir, { recursive: true });

const p = createPipeline({ queueDepth: 0, ...opts });
const t0 = Date.now();
let lastReport = 0;

const run = spawnFrames({
  source: { kind: 'file', path: file },
  width: p.constants.width,
  height: p.constants.height,
  fps: p.constants.fps,
  onFrame: (f) => {
    if (f.t > maxSec) return;
    p.push(f);
    while (interject.length && f.t >= interject[0]) {
      interject.shift();
      const s = p.flushNow(f.t);
      hits.push({
        t: +f.t.toFixed(2),
        at: s ? s.to.toFixed(2) : null,
        frames: s ? s.frames.length : 0,
        why: s ? s.why : null,
        // 插话帧的 Δ 是那条路径自己补算的（绕过 keep），单独记下来才好对账
        areas: s ? s.frames.map((c) => c.area ?? null) : [],
      });
    }
    if (f.t - lastReport >= 10) {
      lastReport = f.t;
      const el = (Date.now() - t0) / 1000;
      process.stderr.write(`  ${f.t.toFixed(0)}s  ${el.toFixed(1)}s wall  x${(f.t / el).toFixed(1)}\n`);
    }
  },
});

const { frames, ms } = await run.done;
const { stats, sheets } = p.finish();
const wall = Date.now() - t0;

sheets.forEach((s, i) => {
  writeFileSync(join(outDir, `${name}-${String(i + 1).padStart(2, '0')}.png`), s.png);
});

const meta = {
  file: basename(file),
  params: { ...DEFAULTS, ...opts },
  video: { frames, sec: +(frames / p.constants.fps).toFixed(2), decodeMs: ms },
  wallMs: wall,
  speed: +(frames / p.constants.fps / (wall / 1000)).toFixed(2),
  stats,
  kept: p.log,
  interject: hits,
  sheets: sheets.map((s, i) => ({
    i: i + 1,
    from: +s.from.toFixed(2),
    to: +s.to.toFixed(2),
    span: +(s.to - s.from).toFixed(2),
    frames: s.frames.length,
    fill: +s.fill.toFixed(3),
    bins: s.bins,
    why: s.why,
    kb: Math.round(s.png.length / 1024),
    tokens: Math.round((p.constants.width * p.constants.height) / 1667),
    tiers: s.frames.map((f) => f.tier),
    cells: s.cells,
    times: s.frames.map((f) => f.t),
    vias: s.frames.map((f) => f.via),
    // Δ＝相对上一格的变化面积（0–1；null = 没有基准，比如整场的首格）
    areas: s.frames.map((f) => f.area ?? null),
  })),
};
writeFileSync(join(outDir, `${name}.json`), JSON.stringify(meta, null, 2));

const sec = frames / p.constants.fps || 1;
const avgFill = meta.sheets.length
  ? meta.sheets.reduce((a, s) => a + s.fill, 0) / meta.sheets.length : 0;
const perMin = meta.sheets.length / (sec / 60);
const secPerSheet = meta.sheets.length ? sec / meta.sheets.length : 0;
const tokens = Math.round((p.constants.width * p.constants.height) / 1667);
const tokPerMin = perMin * tokens;
const tokPerFrame = stats.kept ? (meta.sheets.length * tokens) / stats.kept : 0;
const motion = stats.scoreN ? stats.scoreSum / stats.scoreN : 0;

/** Δ 的显示口径和 `index.js` 的 `areaText` 保持一致：<0.1% 是噪声，整数位够了。 */
function fmtArea(a) {
  if (a === null || a === undefined) return '—';
  const pct = Math.min(100, a * 100);
  if (pct < 0.05) return '<0.1%';
  if (pct < 1) return `${pct.toFixed(2)}%`;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

console.log(`
${basename(file)}  ${meta.video.sec}s  ${frames} 帧  @${p.constants.fps}fps  · 运动强度 ${motion.toFixed(1)}`);
console.log(`  解码 ${(ms / 1000).toFixed(2)}s · 全流程 ${(wall / 1000).toFixed(2)}s · 速度 x${meta.speed}（1.0 = 实时）`);
console.log(`  留帧 ${stats.kept}（切点 ${stats.cuts} / 积分 ${stats.marks} / 兜底 ${stats.floors}）`);
console.log(`  出图 ${sheets.length} 张 · ${(stats.kept / sheets.length).toFixed(1)} 帧/张 · 平均 fill ${(avgFill * 100).toFixed(1)}% · ${secPerSheet.toFixed(1)} 秒一张 · ${perMin.toFixed(1)} 张/分`);
console.log(`  成本 ${tokens} token/张 · **${Math.round(tokPerMin)} token/分** · ${tokPerFrame.toFixed(0)} token/帧`);
console.log('  张  时间         帧数  档位              fill   原因   KB' + (areaFlag ? '   Δ（相对上一格）' : ''));
for (const s of meta.sheets) {
  const dl = areaFlag ? '  ' + s.areas.map(fmtArea).join(' / ') : '';
  console.log(`  ${String(s.i).padStart(2)}  ${s.from.toFixed(1)}–${s.to.toFixed(1)}s`.padEnd(18)
    + `${String(s.frames).padStart(3)}   ${s.tiers.join(',').padEnd(16)} ${(s.fill * 100).toFixed(0).padStart(4)}%  ${s.why.padEnd(5)} ${String(s.kb).padStart(4)}` + dl);
}
if (areaFlag && hits.length) {
  console.log('  插话  ' + hits.map((h) =>
    `${h.t}s ${h.frames}帧 Δ[${h.areas.map(fmtArea).join(' / ')}]`).join(' · '));
}
console.log(`  → ${outDir}/${name}-*.png`);
