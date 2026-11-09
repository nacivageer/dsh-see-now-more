#!/usr/bin/env node
/**
 * bench-capture.mjs — 比采集方式的启动延迟、帧率、CPU。
 *
 *   node scripts/bench-capture.mjs <source> [--sec=5] [--w=800] [--h=450]
 *
 *   source: gdigrab | ddagrab | obs | webcam | nikon
 *
 * **参数直接复用 `src/capture.js` 的 `captureArgs()`**，量到的就是线上真跑的那条命令，
 * 不是一份平行实现。用 `-t N -benchmark` 让 ffmpeg 跑满 N 秒自己退出，
 * 从 stderr 读 utime/stime/rtime —— 拿的是 ffmpeg 进程真实的 CPU 时间。
 */

import { spawn } from 'node:child_process';
import { argv } from 'node:process';
import { captureArgs } from '../src/capture.js';

const args = argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const opt = {};
for (const a of args) {
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split('=');
  opt[k] = Number(v);
}
const sec = opt.sec ?? 5;
const W = opt.w ?? 800;
const H = opt.h ?? 450;
const FPS = opt.fps ?? 12;

const DEV = { obs: 'OBS Virtual Camera', webcam: 'HD Webcam', nikon: 'Nikon Webcam Utility' };
const src = DEV[source]
  ? { kind: source === 'obs' ? 'obs' : 'camera', device: DEV[source] }
  : { kind: 'screen', engine: source };

const TAIL = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
const full = captureArgs({ source: src, width: W, height: H, fps: FPS, engine: 'auto' });
const head = full.slice(1, full.length - TAIL.length);
const a = [...head, '-t', String(sec), '-benchmark', '-v', 'info', ...TAIL];

const child = spawn('ffmpeg', a, { stdio: ['ignore', 'pipe', 'pipe'] });
const need = W * H * 3;
let buf = Buffer.alloc(0);
let frames = 0;
let firstAt = 0;
const t0 = Date.now();
let err = '';

child.stdout.on('data', (d) => {
  if (!firstAt) firstAt = Date.now() - t0;
  buf = buf.length ? Buffer.concat([buf, d]) : d;
  const n = Math.floor(buf.length / need);
  if (n) {
    frames += n;
    buf = buf.subarray(n * need);
  }
});
child.stderr.on('data', (d) => { err += d; });

child.on('close', () => {
  const wall = Date.now() - t0;
  const m = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(err);
  const cpu = m ? Number(m[1]) + Number(m[2]) : 0;
  const rtime = m ? Number(m[3]) : wall / 1000;
  console.log(`${source.padEnd(9)} ${String(frames).padStart(3)} 帧 / ${(wall / 1000).toFixed(1)}s`
    + ` · 首帧 ${firstAt} ms · ${(frames / rtime).toFixed(1)} fps`
    + (cpu ? ` · CPU ${(cpu / rtime * 100).toFixed(0)}%（${(cpu / rtime).toFixed(2)} 核）` : '')
    + ` · ${(frames * need / (wall / 1000) / 1048576).toFixed(1)} MB/s`);
  if (!frames) console.log(`   ⚠ 一帧都没出来：${err.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
});
