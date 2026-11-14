/**
 * bloodbar.js — 血条读数的纯逻辑与框选配置（黑听抬头血条线 P1a）。
 *
 * ## 为什么是「框内亮色占比」而不是「找白条两端」
 *
 * 2026-11-14 拍板：血条检测不写死任何游戏的坐标。用户框一块（只框血条本身），
 * 之后只算框内**亮色像素**占多少 —— 横条血条的填充比例就是这个数。换游戏、
 * 换 UI 缩放，重新框一次就行，坐标永远不进代码。
 *
 * 代价也写在这里：环形血条、纯数字血量、分段方块血条**不覆盖**；彩色（高饱和）
 * 血条也不认，只认低饱和、高亮度的白/浅色条。
 *
 * ## 两个东西
 *
 *   - `ratioFromRgba()`：纯函数，输入一帧 RGBA 像素，出 `{ ok, ratio, visible }`。
 *     合成帧就能穷举，不需要采集、不需要真机。
 *   - 框选配置：`~/.dsh/see-now/bloodbar.json`，与看图的 `region.json` **分开存**，
 *     互不覆盖（看图框整屏、血条框一条，本来就是两个东西）。
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { chatDir } from './chat.js';

/** 默认阈值：填充比例低于 30% 算「该瞥一眼」。 */
export const DEFAULT_THRESHOLD = 0.3;

/** 亮色判定：HSV 的 V 与 S。白条就是 V 高、S 低。 */
export const DEFAULT_BRIGHT_V = 0.55;
export const DEFAULT_MAX_SAT = 0.25;

/** 低于这个占比就当「框里没有血条」（过场 / 菜单 / 加载 / 框挪走了）。 */
export const DEFAULT_MIN_VISIBLE = 0.02;

/** 框选配置落盘位置（与 `region.json` 分开）。 */
export function bloodbarFile(env = process.env) {
  return join(chatDir(env), 'bloodbar.json');
}

/**
 * 读框选配置；没有 / 坏了都返回默认（`region: null` 表示还没框）。
 *
 * @returns {{region: {x:number,y:number,w:number,h:number}|null, threshold: number, at: number|null}}
 */
export function loadBloodbar(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(bloodbarFile(env), 'utf8'));
    const { x, y, w, h } = raw?.region ?? {};
    const region = [x, y, w, h].every((v) => Number.isInteger(v)) && w > 0 && h > 0 && x >= 0 && y >= 0
      ? { x, y, w, h }
      : null;
    const t = Number(raw?.threshold);
    return {
      region,
      threshold: Number.isFinite(t) && t > 0 && t < 1 ? t : DEFAULT_THRESHOLD,
      at: Number(raw?.at) || null,
    };
  } catch {
    return { region: null, threshold: DEFAULT_THRESHOLD, at: null };
  }
}

/** 存框选（保留原阈值；传了就用新值）。 */
export function saveBloodbar({ region, threshold }, env = process.env) {
  const prev = loadBloodbar(env);
  const path = bloodbarFile(env);
  mkdirSync(dirname(path), { recursive: true });
  const t = Number(threshold);
  writeFileSync(path, JSON.stringify({
    region,
    threshold: Number.isFinite(t) && t > 0 && t < 1 ? t : prev.threshold,
    at: Date.now(),
  }, null, 2), 'utf8');
  return path;
}

export function clearBloodbar(env = process.env) {
  try { unlinkSync(bloodbarFile(env)); return true; } catch { return false; }
}

/**
 * 一帧像素 → 亮色占比（`channels` 是 3 或 4）。
 *
 * 采集链路给的是 **RGB24**（`capture.js` 的 rawvideo），截图 / PNG 解码通常是 RGBA ——
 * 同一条算法两种通道都要能用。
 *
 * @param {Uint8Array|Buffer} pixels 长度至少 `width*height*channels`
 * @param {{width:number, height:number, channels?:3|4, threshold?:number, minVisible?:number,
 *          brightV?:number, maxSat?:number}} opts
 * @returns {{ok:true, ratio:number, visible:true, below:boolean, bright:number, total:number}
 *         | {ok:false, ratio:number|null, visible:false, reason:string, bright?:number, total?:number}}
 *   `ok:false` 的 `reason`：`bad-frame`（尺寸/像素对不上）/ `gone`（框里几乎没有亮色）。
 */
export function ratioFromPixels(pixels, {
  width, height, channels = 4,
  threshold = DEFAULT_THRESHOLD,
  minVisible = DEFAULT_MIN_VISIBLE,
  brightV = DEFAULT_BRIGHT_V,
  maxSat = DEFAULT_MAX_SAT,
} = {}) {
  const w = Number(width);
  const h = Number(height);
  const ch = Number(channels);
  const total = w * h;
  if (!pixels || !Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0
      || (ch !== 3 && ch !== 4)) {
    return { ok: false, ratio: null, visible: false, reason: 'bad-frame' };
  }
  if (pixels.length < total * ch) {
    return { ok: false, ratio: null, visible: false, reason: 'bad-frame', total };
  }

  const vFloor = 255 * brightV;
  let bright = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * ch;
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    const max = Math.max(r, g, b);
    if (max < vFloor) continue;
    const min = Math.min(r, g, b);
    if (max > 0 && (max - min) / max > maxSat) continue;
    bright += 1;
  }

  const ratio = bright / total;
  if (ratio < minVisible) {
    return { ok: false, ratio, visible: false, reason: 'gone', bright, total };
  }
  return {
    ok: true, ratio, visible: true, below: ratio < threshold, bright, total,
  };
}

/** RGBA 版本（`channels: 4`）。 */
export function ratioFromRgba(rgba, opts = {}) {
  return ratioFromPixels(rgba, { ...opts, channels: 4 });
}

/** RGB24 版本（采集链路用）。 */
export function ratioFromRgb(rgb, opts = {}) {
  return ratioFromPixels(rgb, { ...opts, channels: 3 });
}

/** `{x,y,w,h}` → `"x,y,w,h"`。 */
export function bloodbarText(region) {
  return region ? `${region.x},${region.y},${region.w},${region.h}` : null;
}

/**
 * `status` 里的一行。
 *
 * 没框过 → 提示怎么框；框过但还没接采集 → 明说「未采」，别让人以为在跑。
 *
 * @param {{region: object|null, threshold: number}} cfg
 * @param {{ratio:number, below:boolean}|null} reading
 */
export function bloodbarLine(cfg, reading = null) {
  if (!cfg || !cfg.region) return '血条：没框（调 `see_now({action:"bloodbar"})` 框一条）';
  const pct = (n) => `${Math.round(n * 100)}%`;
  const head = `血条：框 ${bloodbarText(cfg.region)}（阈值 ${pct(cfg.threshold)}）`;
  if (!reading) return `${head}· 未采（P1a 只框不算）`;
  if (reading.ok === false) return `${head}· 现在框里没有血条（${reading.reason}）`;
  return `${head}· 最近 ${pct(reading.ratio)}${reading.below ? '（低于阈值）' : ''}`;
}
