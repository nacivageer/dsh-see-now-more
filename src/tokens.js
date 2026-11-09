/**
 * tokens.js — 宿主图像 token 估算（与 dsh-llm-deepseek 的 patch 网格口径一致）。
 *
 * 为什么单独抽出来：
 *   - 旧代码/文档里的 384、218 是不同年代的口径，已经过期；
 *   - 画布该多大、能塞几帧，应该由“token 预算 + 最小格边”算，而不是继续写死；
 *   - 计费是阶梯函数：1066×600=407，而 1036×583 只要 366。差 1.5% 的像素，
 *     可能差一整行/列，不能靠“像素÷1650”这种线性估算。
 *
 * 公式（官方《图像理解 · Token 用量》，服务端 v41）：
 *   - 先按 14px patch 向上对齐；
 *   - 每轴 3:1 降采样 → 一个 token 格 = 42×42 px；
 *   - 每行多带 1 个分隔 token，整张再加 2 个框架 token：
 *       tokens = rows × (cols + 1) + 2
 *   - 小于 544×544 的图计费时会被放大到该面积；超过 1024 token 会按长宽比
 *     缩到能塞进预算的最大网格。
 *
 * 例：800×450 → 11×21+2 = 233；1066×600 → 15×27+2 = 407。
 */

export const IMAGE_PATCH = 14;
export const IMAGE_DOWNSAMPLE = 3;
/** 一个 token 格覆盖的像素边长（14×3）。 */
export const IMAGE_CELL = IMAGE_PATCH * IMAGE_DOWNSAMPLE;
/** 单张图 token 上限（宿主实际最大 994）。 */
export const IMAGE_TOKEN_CAP = 1024;
/** 计费地板：小于这个面积的图按该面积收费。 */
export const IMAGE_UPSCALE_AREA = 544 * 544;

const intDiv = (v, d) => Math.floor(v / d);
const ceilDiv = (v, d) => Math.floor((v + d - 1) / d);
const padToPatch = (px) => ceilDiv(px, IMAGE_PATCH) * IMAGE_PATCH;
/** patch 对齐后，这一轴有多少个 token 格。 */
const gridCells = (padded) => ceilDiv(intDiv(padded, IMAGE_PATCH), IMAGE_DOWNSAMPLE);
const gridTokens = (rows, cols) => rows * (cols + 1) + 2;

/** 一次对齐 → 投影；塞得下就原样，塞不下就解出最大网格。 */
function projectSize(W, H, cap) {
  const tw = gridTokens(gridCells(padToPatch(H)), gridCells(padToPatch(W)));
  if (tw <= cap) return { W, H, tokens: tw };

  const aspect = H / W;
  const idealW = Math.sqrt((cap - 2) / aspect + 0.25) - 0.5;
  let solvedW = Math.trunc(idealW);
  let solvedH = Math.trunc(idealW * aspect);
  if (solvedW < 1) {
    solvedW = 1;
    solvedH = intDiv(cap - 2, 2);
  } else if (solvedH < 1) {
    solvedH = 1;
    solvedW = intDiv(cap - 2, solvedH) - 1;
  }
  const scale = Math.min((solvedW * IMAGE_CELL) / W, (solvedH * IMAGE_CELL) / H);
  const bw = Math.trunc((W * scale) / IMAGE_PATCH) * IMAGE_PATCH;
  const bh = Math.trunc((H * scale) / IMAGE_PATCH) * IMAGE_PATCH;
  return { W: bw, H: bh, tokens: gridTokens(gridCells(bh), gridCells(bw)) };
}

/**
 * 像素尺寸 → 估算 token。
 *
 * @param {number} w 像素宽
 * @param {number} h 像素高
 * @returns {number} 整数 token（≤ 1024；无效尺寸返回 0）
 */
export function imageTokens(w, h) {
  let W = Math.round(Number(w) || 0);
  let H = Math.round(Number(h) || 0);
  if (W <= 0 || H <= 0) return 0;

  // 地板：计费时先按面积放大，发送时不会真的放大
  const px = W * H;
  if (px < IMAGE_UPSCALE_AREA) {
    const scale = Math.sqrt(IMAGE_UPSCALE_AREA / px);
    W = Math.max(1, Math.trunc(W * scale));
    H = Math.max(1, Math.trunc(H * scale));
  }

  let cur = projectSize(W, H, IMAGE_TOKEN_CAP);
  // 缩完再投影可能又变，迭代到不动点（宿主同样最多 10 轮）
  for (let i = 0; i < 10; i += 1) {
    const next = projectSize(cur.W, cur.H, IMAGE_TOKEN_CAP);
    if (next.tokens === cur.tokens && next.W === cur.W && next.H === cur.H) {
      return cur.tokens;
    }
    cur = next;
  }
  return cur.tokens;
}

/**
 * 在 token 预算内找最大的 16:9（或指定比例）画布。
 *
 * 尺寸按 14px patch 步进，而不是连续浮点：token 是阶梯函数，
 * 1036×583(366) 比 1066×600(407) 便宜 41 token，画布却只小 1.5%。
 *
 * @param {number} aspect 宽/高
 * @param {{maxTokens?:number, maxSide?:number, minWidth?:number, step?:number}} opts
 * @returns {{width:number,height:number,tokens:number}|null}
 */
export function fitCanvasToTokens(aspect, opts = {}) {
  const a = Math.max(0.2, Math.min(5, Number(aspect) || 16 / 9));
  const maxTokens = Math.max(1, Number(opts.maxTokens) || 384);
  const maxSide = Math.max(64, Number(opts.maxSide) || 1300);
  const minWidth = Math.max(64, Number(opts.minWidth) || 544);
  const step = Math.max(2, Number(opts.step) || IMAGE_PATCH);

  let best = null;
  for (let w = Math.ceil(minWidth / step) * step; w <= maxSide; w += step) {
    const h = Math.round(w / a);
    if (h <= 0 || h > maxSide) continue;
    const tokens = imageTokens(w, h);
    if (tokens <= 0 || tokens > maxTokens) continue;
    if (!best || w * h > best.width * best.height) {
      best = { width: w, height: h, tokens };
    }
  }
  return best;
}
