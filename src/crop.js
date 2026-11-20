/**
 * crop.js — 原生 1:1 截一块（`action:"crop"`）。
 *
 * 为什么另起一条：`watch` 的帧会被缩到画布（low 798 / high 1260 宽），4K 屏上
 * 小字和桌面图标在这个尺寸下读不出来。`crop` 只抓 region 那一块，一根 PNG 管道，
 * 不缩小、不拼图、不落盘。
 *
 * 为什么不走 Python：ffmpeg 已经是硬依赖（血条抓屏也用它），gdigrab 的
 * `-offset_x / -offset_y / -video_size` 正好就是块坐标——少一个解释器，也少一条
 * 「哪个 python 有 mss」的排查路径。
 *
 * 坐标口径与 `region` / `pointer` 相同：**主屏物理像素**。块内 (u,v) 的屏幕坐标
 * 就是 `(x+u, y+v)`，所以 crop 的结果可以直接用来算 `pointer` 的 x/y。
 */

import { spawn } from 'node:child_process';

import { resolveFfmpeg } from './binaries.js';
import { parseRegion } from './layout.js';

/** 一块最多多大：按 42px 一格算约 1.3k token，再大就该用 watch 看整屏。 */
export const MAX_AREA = 2_200_000;
export const MAX_W = 3840;
export const MAX_H = 2160;
export const MIN_SIDE = 32;
export const CROP_TIMEOUT_MS = 20_000;

/**
 * 校验 `region:"x,y,w,h"`。纯函数，单测直接打它。
 *
 * @returns {{ok:true, region:{x:number,y:number,w:number,h:number}}
 *          | {ok:false, reason:string, detail:string}}
 */
export function validateCropRegion(raw) {
  const region = parseRegion(raw);
  if (!region) {
    return { ok: false, reason: 'bad-args', detail: 'region 要写成 "x,y,w,h"（四个非负整数，w/h > 0）' };
  }
  const { w, h } = region;
  if (w < MIN_SIDE || h < MIN_SIDE) {
    return { ok: false, reason: 'bad-args', detail: `宽高至少 ${MIN_SIDE}px` };
  }
  if (w > MAX_W || h > MAX_H) {
    return { ok: false, reason: 'bad-args', detail: `宽高最多 ${MAX_W}×${MAX_H}` };
  }
  if (w * h > MAX_AREA) {
    return { ok: false, reason: 'bad-args', detail: `一块最多 ${MAX_AREA} 像素` };
  }
  return { ok: true, region };
}

/** ffmpeg 参数：只抓这一块、只出一帧、PNG 走 stdout。 */
export function cropArgs({ x, y, w, h }) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-draw_mouse', '0',
    '-offset_x', String(x), '-offset_y', String(y),
    '-video_size', `${w}x${h}`,
    '-framerate', '5',
    '-i', 'desktop',
    '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  ];
}

/**
 * 抓一块原生 PNG。
 *
 * @returns {Promise<{ok:true, png:Buffer, region:object, width:number, height:number, ms:number}
 *                 | {ok:false, reason:string, detail?:string, region?:object}>}
 */
export function captureCrop(region, {
  env = process.env, timeoutMs = CROP_TIMEOUT_MS, log = () => {},
} = {}) {
  const { path: ffmpegPath } = resolveFfmpeg({ env });
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(ffmpegPath, cropArgs(region), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, reason: 'no-ffmpeg', detail: String(e?.message ?? e) });
      return;
    }
    const chunks = [];
    let err = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      finish({ ok: false, reason: 'timeout', detail: `${timeoutMs}ms 没回来`, region });
    }, timeoutMs);

    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, reason: 'no-ffmpeg', detail: String(e?.message ?? e) }));
    child.on('close', (code) => {
      const png = Buffer.concat(chunks);
      if (code !== 0) {
        finish({
          ok: false, reason: 'ffmpeg-failed',
          detail: (err.trim() || `退出码 ${code}`).slice(0, 400), region,
        });
        return;
      }
      if (png.length < 8 || png[0] !== 0x89 || png.toString('ascii', 1, 4) !== 'PNG') {
        finish({
          ok: false, reason: 'ffmpeg-failed',
          detail: `没拿到 PNG（${png.length} 字节）：${err.trim().slice(0, 200)}`, region,
        });
        return;
      }
      log(`crop ${region.w}x${region.h}+${region.x}+${region.y} → ${png.length} 字节`);
      finish({ ok: true, png, region, width: region.w, height: region.h, ms: Date.now() - t0 });
    });
  });
}
