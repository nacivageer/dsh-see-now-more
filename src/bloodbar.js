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

/**
 * band 模式下「这一列算填充」的门槛：行带内亮像素占列高的比例。
 *
 * 用 0.2 而不是 0.5：数字「17222/18980」的黑笔画每列仍留白底，0.5 会把数字区
 * 整段判成空档；0.2 只挡真正没东西的列。
 */
export const DEFAULT_COL_FILL = 0.2;

/** 行带扩展的阈值：行亮 >= 最亮行 × 这个比例才算「条内的行」。 */
export const BAND_ROW_RATIO = 0.8;

/**
 * 填充端点判定（band 模式）：列亮比例 >= 这个值才算「填充段」。
 *
 * 2026-11-14 在云鸣潮血条上量的分布：填充 0.94–0.97 / 数字 0.47 /
 * 未填充区 0.41 / 右端装饰括号 0.56–0.80。取 0.9 一条线，只有真正填满的白列过线；
 * 数字只影响中间，端点取「第一个」和「最后一个」过线的列。
 */
export const DEFAULT_STRONG_FILL = 0.9;

/**
 * band 模式的「填充结束」判据：连续 `GAP_COLS` 列低于 `GAP_RATIO` 就算到头。
 *
 * 2026-11-16 实测：血条右端有 `Lv.90` 白字/括号，亮度足够过 `strongFill`，
 * 取「最后一个强填充列」会把 69% 读成 99.8%。装饰与填充之间隔着几十列暗槽，
 * 所以按「连续暗」判，而不是按「最右的亮」。
 */
export const DEFAULT_GAP_RATIO = 0.5;
export const DEFAULT_GAP_COLS = 6;

/** 框选配置落盘位置（与 `region.json` 分开）。 */
export function bloodbarFile(env = process.env) {
  return join(chatDir(env), 'bloodbar.json');
}

/**
 * 读框选配置；没有 / 坏了都返回默认（`region: null` 表示还没框）。
 *
 * `window` 是**可选的窗口标题子串**：配了就走 WGC 按窗口抓（被遮挡也能读），
 * 不配就走 gdigrab 抓屏幕。两种配置共用同一个 region（屏幕物理像素）。
 *
 * @returns {{region: {x:number,y:number,w:number,h:number}|null, threshold: number,
 *            window: string|null, at: number|null}}
 */
export function loadBloodbar(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(bloodbarFile(env), 'utf8'));
    const { x, y, w, h } = raw?.region ?? {};
    const region = [x, y, w, h].every((v) => Number.isInteger(v)) && w > 0 && h > 0 && x >= 0 && y >= 0
      ? { x, y, w, h }
      : null;
    const t = Number(raw?.threshold);
    const win = typeof raw?.window === 'string' && raw.window.trim() ? raw.window.trim() : null;
    return {
      region,
      threshold: Number.isFinite(t) && t > 0 && t < 1 ? t : DEFAULT_THRESHOLD,
      window: win,
      at: Number(raw?.at) || null,
    };
  } catch {
    return { region: null, threshold: DEFAULT_THRESHOLD, window: null, at: null };
  }
}

/**
 * 存框选（保留原阈值与窗口；传了就用新值）。
 *
 * `window` 三种写法：不传 = 保持原样；`null` / 空串 = 取消（回到抓屏幕）；字符串 = 按这个窗口抓。
 */
export function saveBloodbar({ region, threshold, window: win } = {}, env = process.env) {
  const prev = loadBloodbar(env);
  const path = bloodbarFile(env);
  mkdirSync(dirname(path), { recursive: true });
  const t = Number(threshold);
  const nextWin = win === undefined
    ? prev.window
    : (typeof win === 'string' && win.trim() ? win.trim() : null);
  writeFileSync(path, JSON.stringify({
    region,
    threshold: Number.isFinite(t) && t > 0 && t < 1 ? t : prev.threshold,
    window: nextWin,
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
  /** `full` = 全框亮色占比（旧口径）；`band` = 找亮行带 + 扫描填充长度（血条用）。 */
  mode = 'full',
  colFill = DEFAULT_COL_FILL,
  strongFill = DEFAULT_STRONG_FILL,
  /** band 端点扫描：低于这个列亮比例算「暗列」，连续 `gapCols` 列就判定填充结束。 */
  gapRatio = DEFAULT_GAP_RATIO,
  gapCols = DEFAULT_GAP_COLS,
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
  const isBright = (i) => {
    const o = i * ch;
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    const max = Math.max(r, g, b);
    if (max < vFloor) return false;
    const min = Math.min(r, g, b);
    return max === 0 ? false : (max - min) / max <= maxSat;
  };

  /**
   * **band 模式（血条用）**：先在框内找出「亮行带」，再在带内按列判填充。
   *
   * 为什么不用全框占比（2026-11-14 实测）：框高 36px 里血条只占中间 ~23px，
   * 上下是暗边，全框占比被稀释到 37%；数字又是黑的，再挖掉一块 —— 屏幕上是
   * 90.7%，读数只有 37%。行带把上下暗边剔掉，列判定让数字只影响它自己那几列。
   */
  if (mode === 'band') {
    const rowCount = new Array(h).fill(0);
    let brightTotal = 0;
    for (let y = 0; y < h; y += 1) {
      let c = 0;
      for (let x = 0; x < w; x += 1) if (isBright(y * w + x)) c += 1;
      rowCount[y] = c;
      brightTotal += c;
    }
    const maxRow = Math.max(...rowCount);
    // 最亮的一行连框宽的 10% 都不到 → 框里没有血条（过场 / 菜单 / 框挪走了）
    if (maxRow < Math.max(1, w * 0.1)) {
      return { ok: false, ratio: 0, visible: false, reason: 'gone', bright: brightTotal, total };
    }
    const peak = rowCount.indexOf(maxRow);
    let top = peak;
    let bottom = peak;
    /**
     * 行带只取**接近最亮行**的连续段（0.8），不取 0.5。
     *
     * 2026-11-14 实测：框里条只占中间 20 行，但条上下还有场景/边框的亮行，
     * 用 0.5 会把整框 32 行都算进带里 —— 右侧未填充区因此每列都有 41% 亮，
     * 被当成填充，读数 96.8% 而屏幕是 90.7%。0.8 只留条本身那十几二十行。
     */
    while (top > 0 && rowCount[top - 1] >= maxRow * 0.8) top -= 1;
    while (bottom < h - 1 && rowCount[bottom + 1] >= maxRow * 0.8) bottom += 1;
    const bandH = bottom - top + 1;
    /**
     * 填充端点：**从左往右扫，遇到连续 `gapCols` 列低于 `gapRatio` 就停**。
     *
     * 不能取「最后一个强填充列」（2026-11-16 实测踩到）：血条右端常有装饰——
     * `Lv.90` 的白字、右括号——它们的亮度足够过 `strongFill`，`right` 直接被拉到框边，
     * **69% 读成 99.8%**。装饰和填充之间隔着几十列真正的暗槽，连续暗列才是边界。
     *
     * 数字区不能触发停止：白底被笔画压到 0.4–0.8，`gapRatio=0.5` 只让"确实越来越暗"
     * 的那一段计数；`gapCols=6` 是给单个粗笔画留的余量。
     */
    const colRatio = new Array(w);
    for (let x = 0; x < w; x += 1) {
      let c = 0;
      for (let y = top; y <= bottom; y += 1) if (isBright(y * w + x)) c += 1;
      colRatio[x] = c / bandH;
    }
    let left = -1;
    let right = -1;
    let gap = 0;
    for (let x = 0; x < w; x += 1) {
      if (colRatio[x] >= strongFill) {
        if (left < 0) left = x;
        right = x;
        gap = 0;
      } else if (left >= 0 && colRatio[x] < gapRatio) {
        gap += 1;
        if (gap >= gapCols) break;
      }
    }
    if (left < 0) {
      return { ok: false, ratio: 0, visible: false, reason: 'gone', bright: brightTotal, total };
    }
    const ratio = (right - left + 1) / (w - left);
    if (ratio < minVisible) {
      return { ok: false, ratio, visible: false, reason: 'gone', bright: brightTotal, total };
    }
    return {
      ok: true, ratio, visible: true, below: ratio < threshold,
      bright: brightTotal, total, band: { top, bottom, left, right },
    };
  }

  let bright = 0;
  for (let i = 0; i < total; i += 1) if (isBright(i)) bright += 1;

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

/** 同一次低血不要每拍都记：默认 30 秒一条。 */
export const DEFAULT_GLANCE_COOLDOWN_MS = 30_000;

/**
 * 这一拍要不要因为血条低了记一条 glance（P1c）。
 *
 * 纯函数：只看读数、时间与上次记账时刻，不碰采集、不碰文件。三条同时成立才记：
 *   1. 读数是好的（`ok:true`，不是"框里没有血条"）；
 *   2. 低于阈值（`below:true`，比例已经从上面算好）；
 *   3. 出了冷却（同一次掉血一晚上只该记一次，而不是每 2 秒一条）。
 *
 * @param {{reading: {ok:boolean, below?:boolean, ratio?:number}|null, now:number,
 *          lastGlanceAt?:number, cooldownMs?:number}} o
 * @returns {boolean}
 */
export function shouldGlance({ reading, now, lastGlanceAt = 0, cooldownMs = DEFAULT_GLANCE_COOLDOWN_MS } = {}) {
  if (!reading || reading.ok !== true || reading.below !== true) return false;
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(lastGlanceAt) || lastGlanceAt < 0) lastGlanceAt = 0;
  return now - lastGlanceAt >= cooldownMs;
}

/** 读数轨迹保留多久：3 分钟（1 fps 采集最多 180 条）。 */
export const DEFAULT_TRACK_MS = 180_000;

/**
 * 往轨迹里塞一条读数（纯函数：返回新数组，不改入参）。
 *
 * 为什么只留比例和时刻：这是给「简报」用的，不是给复盘用的。
 * 复盘要整帧去 `lift/` 找；这里只要「刚才多少、现在多少」。
 *
 * @param {Array<{at:number, ratio:number}>} track
 * @param {{ok?:boolean, ratio?:number, at?:number}|null} reading
 * @param {{keepMs?:number}} [o]
 * @returns {Array<{at:number, ratio:number}>} 新数组（入参不动）
 */
export function pushTrack(track, reading, { keepMs = DEFAULT_TRACK_MS } = {}) {
  const pts = Array.isArray(track) ? track : [];
  if (!reading || reading.ok !== true || !Number.isFinite(reading.ratio)) return pts;
  const at = Number(reading.at);
  if (!Number.isFinite(at) || at <= 0) return pts;
  const next = pts.filter((p) => Number.isFinite(p?.at) && at - p.at <= keepMs);
  const point = { at, ratio: reading.ratio };
  /**
   * OCR 的 `当前/最大` 跟着同一条点走（2026-11-16 加）。
   *
   * 不另开一份轨迹：**比例和数字必须是同一帧的**，分两份存就会在简报里错配
   * （比例是十秒前的、数字是刚才的）。数字读不出时这条点就只有比例。
   */
  if (Number.isFinite(reading.cur) && Number.isFinite(reading.max) && reading.max > 0) {
    point.cur = reading.cur;
    point.max = reading.max;
  }
  next.push(point);
  return next;
}

/**
 * 一行「血条现状」，用于**唤醒文案与工具结果**（P2 起：只报告读数，不触发唤醒）。
 *
 * 只摆事实：此刻多少、30 秒前多少、近 60 秒区间、上次低于阈值是什么时候。
 * **判断留给模型**——它决定要不要 `see_now({action:"watch"})` 去看一眼。
 *
 * 为什么带「多久之前的读数」：血条那一路只在仅监听时采，开始看画面就停了。
 * 不写清楚，模型会把十分钟前的 64% 当成现在的 64%。
 *
 * @param {{track?: Array<{at:number, ratio:number}>, threshold?: number, now?: number,
 *          lastBelowAt?: number, staleMs?: number}} [o]
 * @returns {{text:string, below:boolean, ratio:number, at:number}|null} 没读数 → null（不报告）
 */
export function bloodbarBrief({
  track = [], threshold = DEFAULT_THRESHOLD, now = Date.now(),
  lastBelowAt = 0, staleMs = 15_000,
} = {}) {
  const pts = (Array.isArray(track) ? track : [])
    .filter((p) => Number.isFinite(p?.at) && Number.isFinite(p?.ratio));
  const last = pts[pts.length - 1];
  if (!last) return null;
  const pct = (n) => `${Math.round(n * 100)}%`;
  const clock = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

  /**
   * 一条读数「以哪个数为准」：**OCR 的 `当前/最大` 优先，比例是兜底**。
   *
   * 为什么不是反过来：比例是像素统计，暗红条、白字压条、装饰抢端点都会偏
   * （2026-11-16 同帧实测：屏幕 4.3%，比例法 11%）。数字是画在条上的原文，
   * 读出来就是真值。读不出数字时才退回比例 —— 那时它就是唯一读数。
   */
  const value = (p) => (Number.isFinite(p?.cur) && Number.isFinite(p?.max) && p.max > 0
    ? p.cur / p.max
    : p.ratio);
  const hp = Number.isFinite(last.cur) && Number.isFinite(last.max) && last.max > 0
    ? `${last.cur}/${last.max}`
    : null;

  const shown = value(last);
  const below = shown < threshold;

  const tail = [];
  const before = [...pts].reverse().find((p) => last.at - p.at >= 30_000);
  if (before) tail.push(`30 秒前 ${pct(value(before))}`);
  const recent = pts.filter((p) => last.at - p.at <= 60_000);
  if (recent.length > 2) {
    const vals = recent.map(value);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    tail.push(lo === hi ? `近 60 秒都是 ${pct(lo)}` : `近 60 秒 ${pct(lo)}–${pct(hi)}`);
  }
  if (lastBelowAt) tail.push(`上次低血 ${clock(lastBelowAt)}`);

  const age = Math.max(0, now - last.at);
  const text = `血条 ${pct(shown)}${hp ? `（${hp}）` : ''}`
    + `（${below ? `低于阈值 ${pct(threshold)}` : `阈值 ${pct(threshold)}`}）`
    + (age > staleMs ? ` · ${Math.round(age / 1000)} 秒前的读数` : '')
    + (tail.length ? ` · ${tail.join('，')}` : '');
  return { text, below, ratio: shown, at: last.at, hp };
}

/**
 * `status` 里的一行。
 *
 * 没框过 → 提示怎么框；框过但还没接采集 → 明说「未采」，别让人以为在跑。
 *
 * @param {{region: object|null, threshold: number}} cfg
 * @param {{ratio:number, below:boolean}|null} reading
 * @param {{lastBelowAt?: number}} [o] 最近一次低于阈值的时刻（毫秒；0 = 从没低过）
 */
export function bloodbarLine(cfg, reading = null, { lastBelowAt = 0, ocr = null } = {}) {
  if (!cfg || !cfg.region) return '血条：没框（调 `see_now({action:"bloodbar"})` 框一条）';
  const pct = (n) => `${Math.round(n * 100)}%`;
  const head = `血条：框 ${bloodbarText(cfg.region)}（阈值 ${pct(cfg.threshold)}）`
    + `${cfg.window ? ` · 窗口「${cfg.window}」（被遮挡也读）` : ''}`;
  const low = lastBelowAt
    ? ` · 上次低血 ${new Date(lastBelowAt).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '';
  /**
   * OCR 那一行是**升级自检**：`winrt` 装在 DSH 的 runtime python 里，
   * DSH 一升级就可能没了（和 `windows-capture` 同一个坑）。没装时这里直接说，
   * 不指望谁记得。
   */
  const ocrNote = ocr === false
    ? ' · OCR 不可用（缺 winrt，读数退回比例）'
    : '';
  if (!reading) return `${head}· 未采（调 \`read:true\` 读一次）${low}${ocrNote}`;
  if (reading.ok === false) return `${head}· 现在框里没有血条（${reading.reason}）${low}${ocrNote}`;
  const hp = Number.isFinite(reading.cur) && Number.isFinite(reading.max) && reading.max > 0
    ? `（${reading.cur}/${reading.max}）` : '';
  return `${head}· 最近 ${pct(reading.ratio)}${hp}${reading.below ? '（低于阈值）' : ''}${low}${ocrNote}`;
}
