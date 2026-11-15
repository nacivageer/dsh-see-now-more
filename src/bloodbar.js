/**
 * bloodbar.js — 血条读数的纯逻辑与框选配置（黑听抬头血条线 P1a）。
 *
 * ## 为什么是「框内亮色占比」而不是「找白条两端」
 *
 * 2026-11-14 拍板：血条检测不写死任何游戏的坐标。用户框一块（只框血条本身），
 * 之后只算框内**亮色像素**占多少 —— 横条血条的填充比例就是这个数。换游戏、
 * 换 UI 缩放，重新框一次就行，坐标永远不进代码。
 *
 * 代价也写在这里：环形血条、纯数字血量、分段方块血条**不覆盖**。
 * `band` 模式现在按「左端填充色 + 条背景」认条（2026-11-16 重写，见下面 `BAND_*` 注释），
 * 所以暗红/低饱和以外的填充也能读 —— 但条背景是高饱和色的 HUD 还没验过，
 * 换游戏要先拿真值帧回归（`test/fixtures/ratio-samples/` 就是这套回归）。
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

/**
 * **band 模式的条带定位（2026-11-16 重写）**：不再找「最亮的一行」。
 *
 * 旧做法在低血时必错：条变暗红、白字数字比条更亮，最亮行落在数字上，
 * 数字列被当成填充（真机 4.3% 读成 11%、4% 读成 25%）。新做法用**横向对比**：
 * 条带行是「左端亮（填充）、右端暗（未填充背景）」的那些行，边框/场景行没有这种对比。
 *
 * 左右窗口按框宽取比例，不写死像素：
 *   - 左端取 `max(2, min(8, 2% 框宽))` 列 —— 填充总是从左端开始；
 *   - 右端参考取 70%–85% 框宽 —— 对按「整条」框的框来说，这里通常是未填充区。
 *
 * 满血白条时右端也是亮的，左右对比会消失（`< 12`），这时退化成「左端足够亮」
 * （相对最亮行 80%），照样能定出条带。两者都不看绝对亮度阈值。
 */
export const BAND_EDGE_FRAC = 0.02;
export const BAND_RIGHT_START = 0.70;
export const BAND_RIGHT_END = 0.85;
export const BAND_CONTRAST_MIN = 6;
export const BAND_CONTRAST_SHARE = 0.35;
export const BAND_LEFT_FALLBACK_TRIGGER = 12;
export const BAND_LEFT_FALLBACK_SHARE = 0.8;

/**
 * 填充段（band 模式）：**按左端填充色找连续列**。
 *
 * 1. 先用「与左端填充色的最大通道差 ≤ 30」粗分一遍，拿到填充大概到哪结束；
 * 2. 在这之后找一个「平坦段」（相邻列中位色差 ≤ 8、至少 4 列）当**未填充背景色**；
 * 3. 再用「离填充色比离背景色更近」精分一遍，得到填充端点。
 *
 * 为什么不能只按「连续」扫：白条上的数字/中央菱形/分段刻度会把连续段打断
 * （100% 读成 23.8%）；而数字的后半截又常常是**白字压在暗底上**，跟填充同色，
 * 允许跨 2–3 列会把它接回填充里（62% 会读成 70%）。所以判定用「列内填充分数 +
 * 短窗口中位数」：孤立标记 2–3 列跨得过去，字块这种「一半列有白、一半列没有」
 * 的纹理过不去。
 */
export const FILL_COLOR_TOL = 30;
export const FILL_LOW_FRAC = 0.35;
export const FILL_BREAK_COLS = 8;
export const FILL_WINDOW_HALF = 4;
export const FILL_SMOOTH_MIN = 0.45;

/**
 * **条宽（分母）**：框里常带着右端的 `Lv.90` / 括号装饰（真机框 421px、条只有 ~333px）。
 * 旧代码拿框宽当分母，于是 62% 读成 49%、满血读成 79%。这里从右往左找**连续 10 列**
 * 都接近未填充背景色的那一段，它的右端就是条尾；背景段太短就按填充端点算（≈满条）。
 *
 * 填充色与背景色太像时（比如满血白条正好接上白色装饰）用高饱和判定认「没有背景段」。
 */
export const BAR_BG_FLAT_STEP = 8;
/** 平坦段至少这么长才算背景：数字的字块（1–3px 笔画）不会长到 8 列。 */
export const BAR_BG_FLAT_MIN = 8;
/**
 * 「背景」要离填充色多远才算数。25 是量出来的：
 *   - 白条与数字之间的白缝只差 ~5，必须排除（否则把字缝当未填充段）；
 *   - 真机低血的暗红填充 (98,52,55) 与未填充背景 (58,57,68) 差 **40**，得认。
 */
export const BAR_BG_MIN_DIST = 25;
export const BAR_BG_MAX_SAT = 0.25;
export const BAR_BG_TOL = 14;
export const BAR_BG_RUN = 10;

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
   * **band 模式（血条用）**：先横向对比定条带行，再按左端填充色量填充、按未填充背景量条宽。
   *
   * 为什么不用全框占比（2026-11-14 实测）：框高 36px 里血条只占中间 ~23px，
   * 上下是暗边，全框占比被稀释到 37%；数字又是黑的，再挖掉一块 —— 屏幕上是
   * 90.7%，读数只有 37%。行带把上下暗边剔掉，列判定让数字只影响它自己那几列。
   *
   * 为什么不找「最亮行」（2026-11-16 真机）：低血时条变暗红、白字数字更亮，
   * 最亮行落在数字上，数字列成了填充 → 4.3% 读成 11%、4% 读成 25%。见上面
   * `BAND_*` 常量那段的注释。
   */
  if (mode === 'band') {
    let brightTotal = 0;
    for (let i = 0; i < total; i += 1) if (isBright(i)) brightTotal += 1;
    const gone = (ratio = 0) => ({
      ok: false, ratio, visible: false, reason: 'gone', bright: brightTotal, total,
    });
    /**
     * **不再用「亮行占比」挡框里没有血条**：低血暗红条一个亮像素都没有（数字也可能是
     * 中灰的 (117,119,132)），而 `Lv.90` 的白字又会把亮行数抬起来 —— 这条旧判据
     * 两头都不准。下面用「条带内有颜色结构 + 找得到填充段」判断，全暗/纯色帧会卡住。
     */

    const pixel = (x, y) => {
      const o = (y * w + x) * ch;
      return [pixels[o], pixels[o + 1], pixels[o + 2]];
    };
    const medianOf = (values) => {
      const s = [...values].sort((a, b) => a - b);
      return s[s.length >> 1];
    };
    const medianColor = (colors) => [
      medianOf(colors.map((c) => c[0])),
      medianOf(colors.map((c) => c[1])),
      medianOf(colors.map((c) => c[2])),
    ];
    const diffOf = (a, b) => Math.max(
      Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]),
    );
    const satOf = (c) => {
      const mx = Math.max(...c);
      return mx === 0 ? 0 : (mx - Math.min(...c)) / mx;
    };

    /* ---- 1. 条带行：左端亮 / 右端暗 ---- */
    const edgeCols = Math.max(2, Math.min(8, Math.round(w * BAND_EDGE_FRAC)));
    const refStart = Math.min(w - 1, Math.floor(w * BAND_RIGHT_START));
    const refEnd = Math.min(w, Math.max(refStart + 1, Math.floor(w * BAND_RIGHT_END)));
    const rowLeft = new Array(h);
    const rowRight = new Array(h);
    for (let y = 0; y < h; y += 1) {
      let lv = 0;
      let rv = 0;
      for (let x = 0; x < Math.min(edgeCols, w); x += 1) lv += Math.max(...pixel(x, y));
      for (let x = refStart; x < refEnd; x += 1) rv += Math.max(...pixel(x, y));
      rowLeft[y] = lv / Math.min(edgeCols, w);
      rowRight[y] = rv / Math.max(1, refEnd - refStart);
    }
    let maxLeft = 0;
    let maxContrast = 0;
    for (let y = 0; y < h; y += 1) {
      maxLeft = Math.max(maxLeft, rowLeft[y]);
      maxContrast = Math.max(maxContrast, rowLeft[y] - rowRight[y]);
    }
    /**
     * 满血白条时右端也是亮的（左右对比趋近 0），改用「左端相对最亮行」定条带；
     * 两种判据都不看绝对亮度，只比同一行/同一列之间的相对关系。
     */
    const useContrast = maxContrast >= BAND_LEFT_FALLBACK_TRIGGER;
    const contrastFloor = Math.max(BAND_CONTRAST_MIN, maxContrast * BAND_CONTRAST_SHARE);
    const inBand = (y) => (useContrast
      ? rowLeft[y] - rowRight[y] >= contrastFloor
      : rowLeft[y] >= maxLeft * BAND_LEFT_FALLBACK_SHARE);
    let anchor = -1;
    let anchorScore = -Infinity;
    for (let y = 0; y < h; y += 1) {
      if (!inBand(y)) continue;
      const score = useContrast ? rowLeft[y] - rowRight[y] : rowLeft[y];
      if (score > anchorScore) { anchor = y; anchorScore = score; }
    }
    if (anchor < 0) return gone();
    let top = anchor;
    let bottom = anchor;
    while (top > 0 && inBand(top - 1)) top -= 1;
    while (bottom < h - 1 && inBand(bottom + 1)) bottom += 1;
    const bandH = bottom - top + 1;

    /* ---- 2. 列中位色：整条判定的公共底稿 ---- */
    const colmed = new Array(w);
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let x = 0; x < w; x += 1) {
      const colors = [];
      for (let y = top; y <= bottom; y += 1) {
        const c = pixel(x, y);
        colors.push(c);
        for (let i = 0; i < 3; i += 1) { lo[i] = Math.min(lo[i], c[i]); hi[i] = Math.max(hi[i], c[i]); }
      }
      colmed[x] = medianColor(colors);
    }
    // 带内几乎一个颜色（全暗场景、纯色底）→ 不是血条，别硬报
    if (diffOf(lo, hi) < 12) return gone();

    const fillColor = medianColor(colmed.slice(0, Math.min(edgeCols, w)));

    /**
     * 一列的填充分数扫描：短窗口中位数 ≥ `FILL_SMOOTH_MIN` 才算「填充列」，
     * 连续 `FILL_BREAK_COLS` 列原始分数 < `FILL_LOW_FRAC` 就收尾。
     *
     * 短窗口是给「孤立标记」留的桥：2–3 列的中央菱形/分段刻度跨得过去；
     * 而数字后半截那种「一半列是白字、一半列是暗底」的纹理，中位数压不到线上。
     */
    const scanFill = (frac) => {
      const win = [];
      let start = -1;
      let end = -1;
      let lows = 0;
      for (let x = 0; x < w; x += 1) {
        win.length = 0;
        for (let i = Math.max(0, x - FILL_WINDOW_HALF); i <= Math.min(w - 1, x + FILL_WINDOW_HALF); i += 1) {
          win.push(frac[i]);
        }
        if (frac[x] < FILL_LOW_FRAC) {
          lows += 1;
          if (lows >= FILL_BREAK_COLS && end >= 0) break;
        } else {
          lows = 0;
        }
        if (medianOf(win) >= FILL_SMOOTH_MIN) {
          if (start < 0) start = x;
          end = x;
        }
      }
      return { start, end };
    };

    /* ---- 3. 粗分填充（与左端填充色的距离） ---- */
    const roughFrac = new Float64Array(w);
    for (let x = 0; x < w; x += 1) {
      let c = 0;
      for (let y = top; y <= bottom; y += 1) {
        if (diffOf(pixel(x, y), fillColor) <= FILL_COLOR_TOL) c += 1;
      }
      roughFrac[x] = c / bandH;
    }
    let rough = scanFill(roughFrac);

    /**
     * 填充右侧的「未填充背景色」：找第一段平坦的列中位色（相邻列差 ≤ 8、至少 4 列），
     * 且颜色要和填充色明显不同（否则只是数字之间的白缝）。
     */
    const findBackground = (from) => {
      let start = Math.max(0, from);
      const accept = (a, b) => {
        if (b - a < BAR_BG_FLAT_MIN) return null;
        const c = medianColor(colmed.slice(a, b));
        return diffOf(c, fillColor) > BAR_BG_MIN_DIST ? c : null;
      };
      for (let x = start; x < w - 1; x += 1) {
        if (diffOf(colmed[x], colmed[x + 1]) <= BAR_BG_FLAT_STEP) continue;
        const got = accept(start, x + 1);
        if (got) return got;
        start = x + 1;
      }
      return accept(start, w);
    };

    /* ---- 4. 细分填充 + 条宽 ---- */
    let fillStart = rough.start;
    let fillEnd = rough.end;
    let barRight = -1;
    if (fillEnd >= 0) {
      const bg = findBackground(rough.end + 1);
      // 填充后面直接是装饰/底板（满血白条常见）→ 没有可测的未填充段，按满条算
      if (!bg || satOf(bg) > BAR_BG_MAX_SAT) {
        barRight = fillEnd;
      } else {
        const fineFrac = new Float64Array(w);
        for (let x = 0; x < w; x += 1) {
          let c = 0;
          for (let y = top; y <= bottom; y += 1) {
            const px = pixel(x, y);
            if (diffOf(px, fillColor) < diffOf(px, bg)) c += 1;
          }
          fineFrac[x] = c / bandH;
        }
        const fine = scanFill(fineFrac);
        if (fine.start >= 0 && fine.end >= 0) {
          fillStart = fine.start;
          fillEnd = fine.end;
        }
        // 条尾：从右往左找连续 BAR_BG_RUN 列都接近背景色的一段
        barRight = fillEnd;
        for (let x = w - BAR_BG_RUN; x >= 0; x -= 1) {
          let ok = true;
          for (let c = x; c < x + BAR_BG_RUN; c += 1) {
            if (diffOf(colmed[c], bg) > BAR_BG_TOL) { ok = false; break; }
          }
          if (ok) { barRight = x + BAR_BG_RUN - 1; break; }
        }
      }
    }

    /* ---- 5. 兜底：老亮色法（亮条时它准，只在上面认不出填充时接管） ---- */
    if (fillStart < 0 || fillEnd < 0) {
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
      if (left < 0) return gone();
      const legacyRatio = (right - left + 1) / (w - left);
      if (legacyRatio < minVisible) return gone(legacyRatio);
      return {
        ok: true, ratio: legacyRatio, visible: true, below: legacyRatio < threshold,
        bright: brightTotal, total, band: { top, bottom, left, right, legacy: true },
      };
    }

    if (barRight < fillEnd) barRight = fillEnd;
    const ratio = (fillEnd - fillStart + 1) / Math.max(1, barRight - fillStart + 1);
    if (ratio < minVisible) return gone(ratio);
    return {
      ok: true, ratio, visible: true, below: ratio < threshold,
      bright: brightTotal, total, band: { top, bottom, left: fillStart, right: fillEnd, barRight },
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
   * 一条读数「以哪个数为准」：**条的比例**。
   *
   * 2026-11-16 定（用户拍板）：**不拿数字当主读数**。理由在需求本身——
   * 换一个游戏，HUD 上不一定印数字（环形条、纯色条、分段条都没有），
   * 而「框内填充占多少」是跨游戏通用的。数字只能当**附注**：
   * 它读对时能佐证，读错时不该带偏主读数（真机见过 `2494/17638` 认成 `9/17638`）。
   */
  const value = (p) => p.ratio;
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
  const text = `血条 ${pct(shown)}${hp ? `（条上数字 ${hp}）` : ''}`
    + `（${below ? `低于阈值 ${pct(threshold)}` : `阈值 ${pct(threshold)}`}）`
    + (age > staleMs ? ` · ${Math.round(age / 1000)} 秒前的读数` : '')
    + (tail.length ? ` · ${tail.join('，')}` : '');
  return { text, below, ratio: shown, at: last.at, hp };
}

/**
 * 唤醒文案末尾要追加的那一行（`loop.js` 的 `bloodbarTail()` 用）。
 *
 * 单独抽成纯函数是为了能单测：**没有读数时必须返回空串**——
 * 宁可少一行，也不许写「血条正常」（那是编的）。
 *
 * @param {{text:string}|null} note `runner.bloodbarNote()` 的返回
 * @returns {string} `\n🩸 血条 64%…`，或 `''`
 */
export function bloodbarTailText(note) {
  if (!note || typeof note.text !== 'string' || !note.text) return '';
  return `\n🩸 ${note.text}（要不要看一眼你自己定，不用为它单独开画面）`;
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
    ? `（条上数字 ${reading.cur}/${reading.max}）` : '';
  return `${head}· 最近 ${pct(reading.ratio)}${hp}${reading.below ? '（低于阈值）' : ''}${low}${ocrNote}`;
}
