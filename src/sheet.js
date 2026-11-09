/**
 * sheet.js — 拼图：把已经抓好的帧按**可变矩形**贴到画布上，再烧编号。
 *
 * 零图像库：全部在 rawvideo RGB 缓冲上做。
 *
 * 为什么不用 ffmpeg 的 `tile` + `drawtext`：
 *  - drawtext 需要字体文件 + fontconfig + 平台相关的路径转义，装到别人机器上就得炸；
 *  - 我们只需要画 0-9 和一道横杠，用内置点阵字形更可控，且在低分辨率压缩后更抗糊。
 *
 * 布局约定（与 pack.js 一致）：
 *  - 每格按 cover 方式缩放裁切（不变形，溢出部分裁掉）—— 缩放发生在**取帧那一步**，
 *    这里只做搬运：抓回来的 buffer 尺寸就等于格子尺寸
 *  - 格子之间留 1px 缝（画布底色透出来），否则小格子会连成一片
 */



// 条带高度要算"这画面占了几行 patch" —— 从 tokens.js 拿常量，别在这里再写一遍 42。
import { IMAGE_CELL, IMAGE_DOWNSAMPLE, IMAGE_PATCH } from './tokens.js';
import { coverIntoAt } from './scale.js';

export const BACKGROUND = [18, 18, 20];
export const PAD_FILL = [42, 42, 46];
export const PAD_GLYPH = [110, 110, 116];
export const BADGE_FG = [255, 235, 59];
/** 背景色的字节模式：`buf.fill(Buffer)` 是原生循环填充，比逐像素循环快一个数量级。 */
const BACKGROUND_BUF = Buffer.from(BACKGROUND);
/** 格子之间的缝（像素）。1px 就够把相邻小格分开，再宽就吃掉画面。 */
export const SEAM = 1;

/** 5×7 点阵，只有 0-9 与时间码要用的 `:` `/`。scale 必须是整数，保证放大后边缘锐利。 */
export const DIGITS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
};

export const DIGIT_W = 5;
export const DIGIT_H = 7;

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
/** 在 RGB 画布上填一块矩形（支持 alpha 混合） */
export function fillRect(buf, width, height, x, y, w, h, color, alpha = 1) {
  const [r, g, b] = color;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py++) {
    let idx = (py * width + x0) * 3;
    for (let px = x0; px < x1; px++) {
      if (alpha >= 1) {
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b;
      } else {
        buf[idx] = clamp255(buf[idx] * (1 - alpha) + r * alpha);
        buf[idx + 1] = clamp255(buf[idx + 1] * (1 - alpha) + g * alpha);
        buf[idx + 2] = clamp255(buf[idx + 2] * (1 - alpha) + b * alpha);
      }
      idx += 3;
    }
  }
}

/**
 * 画一个 scale×scale 的实心方块（不做 alpha）。
 *
 * 这是点阵字唯一的写像素原语 —— 旧版每个点亮像素都调一次 `fillRect`，
 * 而 `fillRect` 每次要做 4 次 clamp + 2 次边界判断 + 内层循环，画一个两位数
 * 就要 200+ 次函数调用。实测一张 4 帧图的编号从 1.27ms 降到 0.22ms。
 */
function fillSquare(buf, width, height, x, y, size, r, g, b) {
  if (x < 0 || y < 0 || x + size > width || y + size > height) {
    // 画布边缘的编号会越界：退回带 clamp 的版本，**像素必须和旧实现一致**
    // （快路径直接 return 会少画一行描边，肉眼看不出来但逐字节对比会差）
    fillRect(buf, width, height, x, y, size, size, [r, g, b]);
    return;
  }
  for (let py = 0; py < size; py += 1) {
    let i = ((y + py) * width + x) * 3;
    for (let px = 0; px < size; px += 1) {
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
      i += 3;
    }
  }
}

/** 用点阵字形画一个字符串（0-9 与 `-` `:` `/`，空格只走位），返回实际占用尺寸 */
export function drawGlyphs(buf, width, height, text, x, y, scale, color) {
  const [r, g, b] = color;
  let cursor = x;
  for (const ch of String(text)) {
    if (ch === ' ') { cursor += (DIGIT_W + 1) * scale; continue; }
    if (ch === '-') {
      fillRect(buf, width, height, cursor, y + Math.floor(DIGIT_H * scale * 0.6),
        DIGIT_W * scale, Math.max(1, scale), color);
      cursor += (DIGIT_W + 1) * scale;
      continue;
    }
    const glyph = DIGITS[ch];
    if (!glyph) continue;
    for (let row = 0; row < DIGIT_H; row++) {
      const bits = glyph[row];
      for (let col = 0; col < DIGIT_W; col++) {
        if (bits[col] === '1') {
          fillSquare(buf, width, height, cursor + col * scale, y + row * scale, scale, r, g, b);
        }
      }
    }
    cursor += (DIGIT_W + 1) * scale;
  }
  return { width: cursor - x, height: DIGIT_H * scale };
}

/**
 * 编号的字号（点阵整数倍）。
 *
 * 交接文档的盲测结论：**scale 3 是可靠下限**，scale 2 会把 86 读成 88
 * （内置 5×7 点阵里 6 和 8 只差两个像素）。所以画布 800 宽也保底 3。
 * 上限 5 —— 再大就在小格上喧宾夺主。
 */
export function badgeScale(width) {
  return Math.max(3, Math.min(5, Math.round(width / 280)));
}

/**
 * 带描边的点阵字：先在 8 个方向画深色，再叠彩色，保证在亮/暗画面上都看得清。
 * 用于"小格子不画黑底"的编号 —— 黑底在小格上视觉噪音太大，但纯黄字在亮画面上会瞎。
 */
export function drawGlyphsOutlined(buf, width, height, text, x, y, scale, fg, outline = [0, 0, 0], dist = 1) {
  for (const [dx, dy] of [[-dist, 0], [dist, 0], [0, -dist], [0, dist],
    [-dist, -dist], [dist, -dist], [-dist, dist], [dist, dist]]) {
    drawGlyphs(buf, width, height, text, x + dx, y + dy, scale, outline);
  }
  drawGlyphs(buf, width, height, text, x, y, scale, fg);
}

/** 无底版编号：只有描边数字，不画黑框 */
export function drawBadgePlain(buf, width, height, x, y, label, scale) {
  const text = String(label);
  drawGlyphsOutlined(buf, width, height, text, x, y, scale, BADGE_FG, [0, 0, 0], Math.max(1, Math.round(scale / 2)));
  return { w: text.length * (DIGIT_W + 1) * scale, h: DIGIT_H * scale };
}

/** 空位：灰底 + 居中横杠，且绝对不编号 */
export function drawPadding(buf, width, height, x, y, cellW, cellH) {
  fillRect(buf, width, height, x, y, cellW, cellH, PAD_FILL);
  const barW = Math.max(6, Math.round(cellW * 0.32));
  const barH = Math.max(2, Math.round(cellH * 0.03));
  fillRect(buf, width, height,
    x + Math.round((cellW - barW) / 2), y + Math.round((cellH - barH) / 2),
    barW, barH, PAD_GLYPH);
}

/**
 * 把已经抓好的帧按**可变矩形**拼成一张画布。
 *
 * 与旧版 `composeSheet` 的区别：不再假设 cols×rows 的统一网格。矩形来自
 * `pack.toRects()`（归一化 → 像素），每格大小可以不同，格子之间留 1px 缝。
 *
 * 帧有两种给法，各自省掉一次搬运：
 *  - `{src, sw, sh}` —— **原始帧**（推荐）。这里直接 `coverIntoAt` 缩进画布的对应格子，
 *    不再"alloc 中间缓冲 → 缩进去 → blit 到画布"。
 *  - `{buffer, w, h}` —— 已经缩好的格子（region 模式、测试用）。走 `blit` 逐行拷贝。
 *
 * @param {{frames:Array<{src?:Buffer,sw?:number,sh?:number,buffer?:Buffer,w?:number,h?:number}|null>,
 *          rects:Array, width:number, height:number,
 *          burn?:'index'|'none', seam?:number, stripH?:number}} opts
 *        `stripH` > 0 时画布总高 = `height + stripH`，底部这几行留给 `drawAudioStrip` 就地画。
 * @returns {{buffer:Buffer,width:number,height:number,stripH:number}}
 */
export function composePacked({
  frames, rects, width, height, burn = 'index', seam = SEAM, stripH = 0,
}) {
  if (!Array.isArray(rects)) throw new TypeError('rects must be an array');
  const totalH = height + stripH;
  // `allocUnsafe` + 一次模式填充：`Buffer.alloc` 的零填充对整张画布是白干，
  // 而逐像素写背景要 108 万次循环（实测 0.9ms）。`fill(Buffer)` 是原生循环填充。
  //
  // **整块都要填**（含底部音轨条那几行）：`allocUnsafe` 给的是未初始化内存，
  // 漏填一段就会把垃圾字节编码进 PNG。`drawAudioStrip` 之后会覆盖条区，但那是它的事。
  const buf = Buffer.allocUnsafe(width * totalH * 3);
  buf.fill(BACKGROUND_BUF);

  // 第一轮：贴画面。留 1px 缝（右/下），底色透出来就是分隔线。
  // 同时记一张**覆盖掩码**（整格算覆盖，含缝），后面用它找真正的空洞。
  //
  // **掩码只在真有空洞时才建**：4 帧 2×2、单帧铺满这类最常见的情况覆盖了整张画布，
  // 扫 36 万像素纯属白干。`covered >= 画布面积` 时不可能有洞。
  let covered = 0;
  for (let i = 0; i < rects.length; i += 1) covered += rects[i].pw * rects[i].ph;
  const mask = covered < width * height - 1 ? new Uint8Array(width * height) : null;
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    const frame = frames[i];
    const cw = Math.max(1, r.pw - seam);
    const ch = Math.max(1, r.ph - seam);
    if (mask) {
      const yEnd = Math.min(height, r.py + r.ph);
      const xStart = Math.max(0, r.px);
      const xEnd = Math.min(width, r.px + r.pw);
      for (let y = Math.max(0, r.py); y < yEnd; y += 1) {
        mask.fill(1, y * width + xStart, y * width + xEnd);
      }
    }
    if (!frame) {
      drawPadding(buf, width, height, r.px, r.py, cw, ch);
      continue;
    }
    // `{src,sw,sh}` = 原始帧，直接缩进画布：省一次中间缓冲分配 + 一次等大的 blit 拷贝
    if (frame.src) {
      coverIntoAt(frame.src, frame.sw, frame.sh, buf, width, r.px, r.py, cw, ch);
      continue;
    }
    if (frame.buffer) blit(buf, width, height, r.px, r.py, cw, ch, frame.buffer, frame.w ?? cw);
  }

  // **空洞铺灰条**：纯黑的空白看起来像渲染失败（"这图是不是没画完"）。
  //
  // 旧写法是"每一行最后一个格子的右边 + 画布底部"，只在**行是齐的**时候对。
  // 档位混排时会出现真空洞（实测：一行里 1 档 225 高、3 档 113 高，右下角空出一块黑），
  // 那种洞旧逻辑一条都盖不到。所以改成扫掩码：把**连续的、形状一致的**未覆盖段
  // 合成矩形再铺，横竖都对得上。
  if (mask) {
    let prevRuns = null;
    let prevY = 0;
    const flushRuns = (runs, y) => {
      if (!prevRuns) return;
      for (let k = 0; k < prevRuns.length; k += 1) {
        const [x, w] = prevRuns[k];
        drawPadding(buf, width, height, x, prevY, w, y - prevY);
      }
    };
    for (let y = 0; y < height; y += 1) {
      const runs = [];
      let x = 0;
      while (x < width) {
        if (mask[y * width + x]) { x += 1; continue; }
        const start = x;
        while (x < width && !mask[y * width + x]) x += 1;
        if (x - start > 8) runs.push([start, x - start]);   // 细缝不铺，免得整张全是噪点
      }
      const same = prevRuns && runs.length === prevRuns.length
        && runs.every((r, k) => r[0] === prevRuns[k][0] && r[1] === prevRuns[k][1]);
      if (!same) {
        flushRuns(prevRuns, y);
        prevRuns = runs;
        prevY = y;
      }
    }
    flushRuns(prevRuns, height);
  }

  // 第二轮：编号。**单独一轮**，否则后画的格子会盖掉前一格伸出来的描边。
  //
  // 两条规则：
  //   1. **6 档及以上（1/6…1/8）用 scale 2**：格子只有 100px 宽，scale 3 的两位数要占 1/3，
  //      缩到 2 才不压画面（这是用户明确要求的；大格仍用 3，保证盲测的"86 不会被读成 88"）。
  //   2. **积分假切点的格子不编号**：它不是"换镜头"，只是"这一段一直在变"，
  //      编号会让模型以为那是独立镜头。图上编号因此会跳号，清单里的 k= 和时间才是准的。
  if (burn !== 'none') {
    const base = badgeScale(width);
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i];
      if (!frames[i]) continue;
      if (r.via === 'mark') continue;
      const scale = Number(r.t) >= 6 ? Math.min(2, base) : base;
      drawBadgePlain(buf, width, height, r.px + 2, r.py + 1, r.index, scale);
    }
  }
  return { buffer: buf, width, height: totalH, stripH };
}

/** 把一格 rawvideo（尺寸必须等于 cellW×cellH）贴到画布上 */
/**
 * 把一张 RGB 图贴到目标缓冲区的 (x,y)，占 cellW×cellH。
 *
 * `srcW` 是**源图自己的行宽**。黑场格会取一张只占半格的小图（buffer 宽度就是 cellW/2），
 * 靠它才能按小图的行宽正确拷贝 —— 否则每行都会错位成斜的。
 */
export function blit(dst, dstW, dstH, x, y, cellW, cellH, src, srcW = cellW) {
  const need = srcW * cellH * 3;
  if (src.length < need) throw new RangeError(`frame buffer too small: ${src.length} < ${need}`);
  for (let row = 0; row < cellH; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dstH) continue;
    const sStart = row * srcW * 3;
    const dStart = (dy * dstW + x) * 3;
    src.copy(dst, dStart, sStart, sStart + cellW * 3);
  }
}

/* ---------------------------------------------------------------- 音频条带 */

/**
 * 条带配色。和 `dsh-video-storyboard` 逐字节一致 —— 两个插件的图会出现在同一个会话里，
 * 同一件事（响度）用同一个颜色，用户不用重新学一遍怎么看。
 */
export const STRIP_BG = [11, 11, 13];
export const STRIP_BAR = [63, 184, 175];
export const STRIP_SILENCE = [42, 42, 46];
export const STRIP_TICK = [255, 235, 59];
export const STRIP_SEP = [60, 60, 66];
/** 条带背景色的字节模式（`buf.fill` 用）。 */
const STRIP_BG_BUF = Buffer.from(STRIP_BG);

/**
 * 条带高度。**取"这画面本来就没用满的那点余量"**，不跨行。
 *
 * token 是阶梯函数：每 42px 一行。450 高的画面占 11 行（上界 462），下面**空着 12px 白算钱**。
 * 所以条的高度不该按宽度比例硬算（44px 会让总高 494 跨进第 12 行，每张多 20 token），
 * 而应该把这段余量用起来 —— 画面一点不少，条也有了，token 还是 11 行。
 *
 * | 画面高 | 占几行 | 行边界 | 免费余量 |
 * |---|---|---|---|
 * | 450 | 11 | 462 | **12** |
 * | 600 | 15 | 630 | 30 |
 * | 720 | 18 | 756 | 36 |
 * | 900 | 22 | 924 | 24 |
 *
 * 余量小于 10px（画面正好卡在行边界上）时退回按宽度算的 22px —— 那种情况条必然跨行，
 * 只能认；但要保证它至少看得清。
 */
export function stripHeight(width, frameHeight = 450) {
  const rows = Math.ceil(Math.ceil(Math.max(1, frameHeight) / IMAGE_PATCH) / IMAGE_DOWNSAMPLE);
  const room = rows * IMAGE_CELL - frameHeight;
  const cap = Math.max(22, Math.round(width * 0.055));
  if (room < 10) return Math.min(cap, 22);
  return Math.min(room, cap);
}

/**
 * 在图**底下**接一条音轨：响度柱 + 静音底 + 切点刻度。
 *
 * 三件事各自解决一个具体问题：
 *  - **响度柱**：只看图看不出"这段是安静的旁白还是配乐轰鸣"，而音量决定了该不该说话。
 *  - **静音灰块**：没人说话的地方铺一层深灰，柱子压在上面 —— 早先试过"静音不画柱子"，
 *    灰块变成一根根实心竖条把波形切断，很难读。
 *  - **切点刻度**（顶部黄色短线）：和宫格里的编号对应，一眼看出"这一刀切在第几格附近"。
 *
 * 图变高 = 画面占行后剩下的余量（450 余 12 → 总高 462，仍是 11 行）—— **token 不涨**。
 *
 * @param {{buffer:Buffer,width:number,height:number}} sheet composePacked 的产物
 * @param {{loudness?:{step:number,db:number[]}, cuts?:number[],
 *          window:{from:number,to:number}, stripH?:number}} opts
 */
export function addAudioStrip(sheet, opts) {
  const { buffer, width, height } = sheet;
  const stripH = opts.stripH ?? stripHeight(width, height);
  const out = Buffer.allocUnsafe(width * (height + stripH) * 3);
  buffer.copy(out, 0, 0, buffer.length);
  drawAudioStrip(out, width, height + stripH, height, { ...opts, stripH });
  return { buffer: out, width, height: height + stripH, stripH };
}

/**
 * 在**已经分配到最终高度**的画布底部就地画音轨条。
 *
 * 和 `addAudioStrip` 的区别只有"谁分配缓冲"：`composePacked` 给的 `stripH` 已经把这段
 * 高度预留出来了，这里直接往底部写 —— 省一次 1.1MB 的分配和一次等大的整图拷贝。
 *
 * @param {Buffer} buf 画布（rgb24，行宽 width，总高 totalH）
 * @param {number} width
 * @param {number} totalH 含条的总高
 * @param {number} frameH 画面区高度（= totalH - stripH）
 * @param {{loudness?:{step:number,db:number[]}, cuts?:number[], window:{from:number,to:number},
 *          stripH?:number}} opts
 */
export function drawAudioStrip(buf, width, totalH, frameH, opts) {
  const { loudness, cuts = [], window: win } = opts;
  const stripH = opts.stripH ?? (totalH - frameH);
  if (!(stripH > 0)) return 0;
  const base = frameH * width * 3;
  // 底部整块铺背景：一次原生填充，替代逐像素循环
  buf.fill(STRIP_BG_BUF, base, width * totalH * 3);

  const db = loudness?.db ?? [];
  const span = Math.max(0.001, win.to - win.from);
  const t2x = (t) => Math.round(((t - win.from) / span) * (width - 1));

  // 静音铺底：整格都是背景色，柱子压上去之后只在柱顶上方露出来。
  // **按连续段合并成矩形** —— 旧写法每列都写 stripH 个像素（600×12 = 7200 次），
  // 而静音段通常是一整片，合并之后只有几次 fillRect。
  let runStart = -1;
  for (let x = 0; x <= width; x += 1) {
    const silent = x < width && (!db.length
      || (db[Math.min(db.length - 1, Math.floor((x / width) * db.length))] ?? -120) <= -55);
    if (silent) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      fillRect(buf, width, totalH, runStart, frameH, x - runStart, stripH, STRIP_SILENCE);
      runStart = -1;
    }
  }

  if (db.length > 1) {
    // 归一化：参照上限取 97 分位、下限至少 hi-12dB。
    // 不这么做的话，"全程恒定响度"的素材（测试音、压得很平的成片）会被归一化成一条贴底细线，
    // 看起来像坏了（storyboard 那边实测过）。
    const audible = db.filter((v) => v > -70).sort((a, b) => a - b);
    const hi = audible.length ? audible[Math.floor(audible.length * 0.97)] : -10;
    const lo = Math.min(audible.length ? audible[Math.floor(audible.length * 0.1)] : -60, hi - 12);
    const range = Math.max(6, hi - lo);
    const [br, bg2, bb] = STRIP_BAR;
    for (let x = 0; x < width; x += 1) {
      // 每一列取它覆盖的那几个采样点的峰值 —— 600 列里丢细节就等于作弊
      const i0 = Math.floor((x / width) * db.length);
      const i1 = Math.max(i0 + 1, Math.ceil(((x + 1) / width) * db.length));
      let peak = -120;
      for (let i = i0; i < i1 && i < db.length; i += 1) peak = peak > db[i] ? peak : db[i];
      const norm = Math.max(0, Math.min(1, (peak - lo) / range));
      const barH = Math.round(norm * (stripH - 3));
      for (let y = 0; y < barH; y += 1) {
        const i = ((frameH + stripH - 1 - y) * width + x) * 3;
        buf[i] = br; buf[i + 1] = bg2; buf[i + 2] = bb;
      }
    }
  }

  // 切点刻度：顶部短竖线（黄）
  const tickH = Math.max(3, Math.round(stripH * 0.35));
  for (const t of cuts) {
    if (t < win.from || t > win.to) continue;
    const x = Math.max(0, Math.min(width - 1, t2x(t)));
    for (let y = 0; y < tickH; y += 1) {
      const i = ((frameH + y) * width + x) * 3;
      buf[i] = STRIP_TICK[0]; buf[i + 1] = STRIP_TICK[1]; buf[i + 2] = STRIP_TICK[2];
    }
  }

  // 和宫格之间的分隔线
  for (let x = 0; x < width; x += 1) {
    const i = (frameH * width + x) * 3;
    buf[i] = STRIP_SEP[0]; buf[i + 1] = STRIP_SEP[1]; buf[i + 2] = STRIP_SEP[2];
  }
  return stripH;
}

