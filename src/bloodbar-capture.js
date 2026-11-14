/**
 * bloodbar-capture.js — 抓一次框内、算一次血条比例（P1b 的单次读数）。
 *
 * 为什么单独一个文件：`bloodbar.js` 是纯函数（不 import 采集），采集这一侧要起
 * ffmpeg 子进程，两者混在一起就没法在无 ffmpeg 的环境里单测。这里只做一件事：
 * **抓一帧 RGB24 → 交给 `ratioFromRgb`**，不落盘、不出图、不叫醒。
 *
 * 常驻低帧率采集（P1c）会复用 `spawnFrames`，但那是另一条生命周期，先不塞进来。
 */

import { spawnFrames } from './capture.js';
import { ratioFromRgba } from './bloodbar.js';

/** 等第一帧的上限：gdigrab 起进程 + 首帧一般 1–2 秒，给 8 秒足够。 */
export const READ_TIMEOUT_MS = 8000;

/**
 * 抓一帧框内像素并算亮色占比。
 *
 * @param {{region: {x:number,y:number,w:number,h:number}, threshold?: number,
 *          ffmpegPath?: string, timeoutMs?: number}} opts
 * @returns {Promise<{ok:true, reading:object, ms:number}
 *   | {ok:false, reason:string, detail?:string|null}>}
 *   `reason`: `no-region` / `spawn-failed` / `no-frame` / `capture-failed`
 */
export async function readBloodbarOnce({
  region, threshold, ffmpegPath = 'ffmpeg', timeoutMs = READ_TIMEOUT_MS,
} = {}) {
  if (!region || !(Number(region.w) > 0) || !(Number(region.h) > 0)) {
    return { ok: false, reason: 'no-region' };
  }
  const w = Number(region.w);
  const h = Number(region.h);
  let buf = null;

  let run;
  try {
    run = spawnFrames({
      source: { kind: 'screen', region },
      width: w, height: h, fps: 2, ffmpegPath,
      // gdigrab 原生 bgr0：输出 BGRA 零转换（rgb24 那条在本机会报
      // "Function not implemented"）。亮色判定只看 max/min，BGR 与 RGB 等价。
      channels: 4, pixFmt: 'bgra',
      onFrame: ({ buf: frame }) => { if (!buf) buf = Buffer.from(frame); },
    });
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', detail: String(e?.message ?? e) };
  }

  let failure = null;
  run.done.catch((e) => { failure = e; });

  const t0 = Date.now();
  while (!buf && !failure && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  try { run.stop(); } catch { /* 已经退了 */ }
  try { await run.done; } catch { /* 上面已经记过 */ }

  if (!buf) {
    return {
      ok: false,
      reason: failure ? 'capture-failed' : 'no-frame',
      detail: failure ? String(failure.message ?? failure).slice(0, 300) : null,
    };
  }

  return {
    ok: true,
    reading: ratioFromRgba(buf, { width: w, height: h, threshold }),
    ms: Date.now() - t0,
  };
}
