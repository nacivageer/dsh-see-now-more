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
import { spawnWindowFrames } from './capture-window.js';
import { ratioFromRgba } from './bloodbar.js';
import { resolveOcrPython, startOcr } from './ocr.js';

/** 等第一帧的上限：gdigrab 起进程 + 首帧一般 1–2 秒，给 8 秒足够。 */
export const READ_TIMEOUT_MS = 8000;

/**
 * 单次读也要数字：起一个一次性 OCR 进程认这一帧（约 0.7s，含 python 冷启动）。
 *
 * 失败**不影响**读数：返回 `{ok:false, why}`，调用方只报比例。
 * 这里不抛 —— 单次读的价值是「现在到底多少」，OCR 缺席不该让整次读失败。
 *
 * @returns {Promise<{ok:true, cur:number, max:number, text:string, ms:number}
 *                 | {ok:false, why:string}>}
 */
async function ocrFrame(buf, w, h, timeoutMs = 5000) {
  const probe = resolveOcrPython();
  if (!probe.ok) return { ok: false, why: probe.reason ?? 'no-winrt' };
  let o = null;
  try {
    o = startOcr({ w, h, python: probe.python, timeoutMs });
    const r = await o.recognize(buf);
    if (!r || !Number.isFinite(r.cur) || !Number.isFinite(r.max) || r.max <= 0) {
      return { ok: false, why: 'no-digits' };
    }
    return { ok: true, cur: r.cur, max: r.max, text: r.text ?? '', ms: r.ms ?? 0 };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  } finally {
    try { o?.stop(); } catch { /* 已经退了 */ }
    try { await o?.done; } catch { /* 上面已经处理过 */ }
  }
}

/** 把 OCR 结果并进 reading（只并数字，不动比例）。 */
function withOcr(reading, ocr) {
  if (!ocr?.ok) return { ...reading, ocr };
  return { ...reading, cur: ocr.cur, max: ocr.max, text: ocr.text, ocr };
}

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

  const reading = ratioFromRgba(buf, { width: w, height: h, threshold, mode: 'band' });
  return {
    ok: true,
    reading: withOcr(reading, reading.ok === true ? await ocrFrame(buf, w, h) : null),
    ms: Date.now() - t0,
  };
}

/**
 * 按**窗口**读一次（WGC）。形状与 `readBloodbarOnce` 一致，调用方不用分支。
 *
 * 为什么单次读也要单独一条：`read:true` 的价值就是「现在到底多少」，
 * 而窗口被挡住时 gdigrab 给的是遮挡物 —— 那种读数比没有更糟。
 *
 * @param {{window: string, region: {x:number,y:number,w:number,h:number}, threshold?: number,
 *          timeoutMs?: number}} o
 */
export async function readBloodbarWindowOnce({
  window: title, region, threshold, timeoutMs = READ_TIMEOUT_MS,
} = {}) {
  if (!region || !(Number(region.w) > 0) || !(Number(region.h) > 0)) {
    return { ok: false, reason: 'no-region' };
  }
  if (!title) return { ok: false, reason: 'no-window' };
  const w = Number(region.w);
  const h = Number(region.h);
  let buf = null;
  let failure = null;

  let run;
  try {
    run = spawnWindowFrames({
      source: { kind: 'window', title: String(title) },
      region: { x: Number(region.x), y: Number(region.y), w, h },
      fps: 2,
      onFrame: ({ buf: frame }) => { if (!buf) buf = Buffer.from(frame); },
      onStderr: (d) => {
        const line = String(d).trim();
        if (line && !failure) failure = line.slice(-300);
      },
    });
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', detail: String(e?.message ?? e) };
  }
  run.done.catch((e) => { failure = failure ?? String(e?.message ?? e); });

  const t0 = Date.now();
  while (!buf && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  try { run.stop(); } catch { /* 已经退了 */ }
  try { await run.done; } catch { /* 上面已经记过 */ }

  if (!buf) {
    return {
      ok: false,
      reason: 'no-frame',
      detail: failure ? String(failure).slice(0, 300) : null,
    };
  }
  const reading = ratioFromRgba(buf, { width: w, height: h, threshold, mode: 'band' });
  return {
    ok: true,
    reading: withOcr(reading, reading.ok === true ? await ocrFrame(buf, w, h) : null),
    ms: Date.now() - t0,
  };
}
