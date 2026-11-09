#!/usr/bin/env node
/**
 * live-test.mjs — 拿**真源**（屏幕 / OBS 虚拟摄像头 / 摄像头）跑整条实时管线 N 秒。
 *
 *   node scripts/live-test.mjs screen --sec=20 [--engine=ddagrab|gdigrab] [--save]
 *   node scripts/live-test.mjs obs|camera --device="HD Webcam" --sec=20
 *
 * 和 sim.mjs 的区别：sim 喂文件（没有真时间轴、没有设备启动成本），这里走的就是线上那条路。
 * 默认**不落图**（屏幕/摄像头可能拍到私人内容）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnFrames, pickScreenEngine } from '../src/capture.js';
import { createPipeline } from '../src/pipeline.js';

const args = argv.slice(2);
const kind = args.find((a) => !a.startsWith('--'));
if (!kind) {
  console.error('usage: node scripts/live-test.mjs screen|obs|camera [--sec=20] [--engine=ddagrab] [--save]');
  exit(2);
}
const opt = {};
let save = false;
for (const a of args) {
  if (!a.startsWith('--')) continue;
  if (a === '--save') { save = true; continue; }
  const [k, v] = a.slice(2).split('=');
  opt[k] = v;
}
const sec = Number(opt.sec ?? 20);
const engine = opt.engine ?? 'auto';
const tProbe = Date.now();
const picked = kind === 'screen' && engine === 'auto' ? await pickScreenEngine() : engine;
const probeMs = kind === 'screen' && engine === 'auto' ? Date.now() - tProbe : 0;
const source = kind === 'screen' ? { kind: 'screen', engine: picked }
  : kind === 'obs' ? { kind: 'obs', device: opt.device }
    : { kind: 'camera', device: opt.device };

const p = createPipeline({ queueDepth: 0 });
let firstMs = null;
let counted = 0;
const t0 = Date.now();
const cpu0 = process.cpuUsage();

const run = spawnFrames({
  source,
  width: p.constants.width,
  height: p.constants.height,
  fps: p.constants.fps,
  engine: picked,
  onFirst: (ms) => { firstMs = ms; },
  onFrame: (f) => { counted += 1; p.push(f); },
  onStderr: (s) => { if (process.env.DSH_SEE_NOW_DEBUG) process.stderr.write(s); },
});

const timer = setTimeout(() => run.stop(), sec * 1000);
await run.done.catch((e) => { console.error(`采集挂了：${e.message}`); });
clearTimeout(timer);

const wall = (Date.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
const { stats, sheets } = p.finish();
const nodeCpu = (cpu.user + cpu.system) / 1e6;

console.log(`\n[${kind}${kind === 'screen' ? '/' + picked : ''}] ${wall.toFixed(1)}s` + (probeMs ? ` · 引擎探测 ${probeMs}ms` : ''));
console.log(`  首帧 ${firstMs ?? '—'} ms · 收到 ${counted} 帧 · 实测 ${(counted / wall).toFixed(1)} fps`
  + `（目标 ${p.constants.fps}）`);
console.log(`  留帧 ${stats.kept}（切点 ${stats.cuts} / 积分 ${stats.marks} / 兜底 ${stats.floors}）`
  + ` · 去重丢 ${stats.dupSkipped}`);
console.log(`  出图 ${sheets.length} 张 · 平均 fill ${(sheets.reduce((a, s) => a + s.fill, 0) / (sheets.length || 1) * 100).toFixed(0)}%`);
console.log(`  Node 侧 CPU ${nodeCpu.toFixed(2)}s / ${wall.toFixed(1)}s = ${(nodeCpu / wall * 100).toFixed(0)}%（${(nodeCpu / wall).toFixed(2)} 核）`);

if (save && sheets.length) {
  const dir = join('.tmp', 'live');
  mkdirSync(dir, { recursive: true });
  sheets.forEach((s, i) => writeFileSync(join(dir, `${kind}-${Date.now()}-${i + 1}.png`), s.png));
  console.log(`  图已写到 ${dir}`);
}
