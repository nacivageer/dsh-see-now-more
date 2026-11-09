/**
 * layout.js — region 模式（只抓一块竖屏区域）的几何计算。
 *
 * 为什么单独成模块：`pack.js` 的 DP 是按「归一化方形容器 + 正方形格子」设计的，
 * 格子像素比例恒等于画布比例（见 pack.js 文件头）。region 模式下要的是
 * 「每格 = region 的比例、整图尽量接近 1:1」，这是两套几何，硬塞进 DP 会把
 * 现有 16:9 路径一起改坏。所以这里只放纯函数，pipeline 在 region 分支里调用。
 *
 * 三个结论来自 2026-11-03 的实测（debug/dpi-probe.mjs）：
 *   - gdigrab 的 -offset_x/-offset_y 在 150% 缩放下按**物理像素**解释
 *     （全屏 2560×1600×3 字节；region 与全屏同位置逐字节相等，exactRatio=1.0）
 *   - 所以 region 坐标可以直接用 `desktop_control windows` 给的物理像素矩形
 *   - 格子尺寸由「长边 = 档位长边」定，输出比例与 region 一致 → ffmpeg 的
 *     `scale=w:h` 是等比缩放，不需要 force_original_aspect_ratio
 */

/** 单格短边下限：再小就认不出画面（跟 pack.js 的 1/24 同一量级）。 */
export const MIN_CELL = 16;

/**
 * 解析 `"x,y,w,h"`（也接受空格、分号、`x` 分隔）。
 *
 * **严格**：必须是 4 个非负整数，宽高必须 > 0。任何不合法的输入返回 `null`，
 * 由调用方明确报错 —— 不能静默退化成「抓全屏」，那会让用户以为 region 生效了。
 *
 * @param {unknown} raw
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function parseRegion(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(/[,;\sxX]+/).filter(Boolean);
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((v) => !Number.isFinite(v) || !Number.isInteger(v))) return null;
  const [x, y, w, h] = nums;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * 单格像素尺寸：**长边 = 档位长边**，短边按 region 宽高比算。
 *
 * 这条是档位语义的保证 —— 同一个 quality 下，一帧的长边永远是同一个数，
 * 不管这张图最后拼了几帧。不能改成「整图长边 = 档位长边」，那会让单帧清晰度
 * 跟着帧数飘（2 帧清楚、4 帧糊），正是这次要修的毛病。
 *
 * @param {number} longEdge 档位长边（low 800 / standard 1066 / high 1280 / ultra 1600）
 * @param {{w:number,h:number}} region
 * @returns {[number, number]} [宽, 高]
 */
export function cellSize(longEdge, region) {
  const edge = Math.max(MIN_CELL, Math.round(Number(longEdge) || 0));
  const ratio = region.w / region.h;                 // 宽/高
  let w;
  let h;
  if (ratio >= 1) { w = edge; h = Math.round(edge / ratio); }
  else { h = edge; w = Math.round(edge * ratio); }
  return [Math.max(MIN_CELL, w), Math.max(MIN_CELL, h)];
}

/**
 * n 帧、单格宽高比 aspectCell（宽/高）→ 选让整图最接近 1:1 的 (cols, rows)。
 *
 * 为什么按 1:1 选：模型按**长边**缩放图像，长宽比越极端，短边被压得越狠。
 * 同样 token 预算下正方形最划算。竖屏 9:16 的验算：
 *
 * | n | 排列 | 整图比例 | 结论 |
 * |---|---|---|---|
 * | 1 | 1×1 | 0.563 | — |
 * | 2 | 2×1 | **1.125** | 最佳 |
 * | 3 | 3×1 | 1.688 | 比 2×2(0.563) 好 |
 * | 4 | 2×2 | **0.563** | 4 帧必须 2×2 |
 * | 6 | 3×2 | 0.844 | 只做对照（region 模式到不了 6） |
 *
 * 最后一排装不满要**重罚**：空格是纯浪费（灰底既难看又白占 token）。
 * 权重 1.0 是实测调出来的 —— 0.35 的时候 4 帧竖屏会选 3×2（比例 0.75 比 2×2 的 0.5
 * 更接近 1），代价是留两个空格、白扔 1/3 面积。改成 1.0 之后 2×2 才胜出：
 *
 *   2×2 → |ln 0.5| = 0.693
 *   3×2 → |ln 0.75| + 1.0×(2/4) = 0.288 + 0.5 = 0.788  ← 输在空格上
 *
 * @param {number} n 帧数（>=1）
 * @param {number} aspectCell 单格 宽/高
 * @returns {{cols:number, rows:number, ratio:number, score:number, holes:number}}
 */
export function gridPlan(n, aspectCell) {
  const count = Math.max(1, Math.floor(Number(n) || 1));
  const aspect = Number(aspectCell) > 0 ? Number(aspectCell) : 1;
  // 正方格时「方向」这个概念本身不存在（转置等于不变），方向判据必须**跳过** ——
  // 否则会拿一个无意义的比较去决定横排还是竖排。跳过之后按「列数多」定死一条：
  // 这是**任意选择**（和 pack.js 的行流式一致），不是从 1:1 目标推导出来的。
  const squarish = Math.abs(aspect - 1) < 1e-9;

  /** a 是否优于 b */
  const better = (a, b) => {
    if (Math.abs(a.score - b.score) > 1e-12) return a.score < b.score;
    if (!squarish) {
      // |ln 0.5| === |ln 2|：横排和竖排常常等距。判据是「整图方向必须和单格同向」——
      // 竖屏单格拼成横向长条等于把画面转置了，那是物理错误，不是调参偏好。
      const aSame = (a.ratio >= 1) === (aspect >= 1);
      const bSame = (b.ratio >= 1) === (aspect >= 1);
      if (aSame !== bSame) return aSame;
    }
    return a.cols > b.cols;
  };

  let best = null;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const width = cols * aspect;                     // 以「格高」为单位
    const ratio = width / rows;
    const holes = cols * rows - count;
    const score = Math.abs(Math.log(ratio)) + (holes / count);
    const cand = { cols, rows, ratio, score, holes };
    if (!best || better(cand, best)) best = cand;
  }
  return best;
}

/**
 * region 模式下出图时用：一帧一格，按 gridPlan 摆成网格。
 * 源帧尺寸 === 单格尺寸，所以每个 rect 都是整格，不需要 cover 缩放。
 *
 * @param {number} n
 * @param {number} cellW
 * @param {number} cellH
 * @param {number} aspectCell
 */
export function gridRects(n, cellW, cellH, aspectCell) {
  const { cols, rows } = gridPlan(n, aspectCell);
  const rects = [];
  for (let i = 0; i < n; i += 1) {
    rects.push({
      index: i + 1,
      px: (i % cols) * cellW,
      py: Math.floor(i / cols) * cellH,
      pw: cellW,
      ph: cellH,
      bin: 0,
      seq: i,
    });
  }
  return { cols, rows, width: cols * cellW, height: rows * cellH, rects };
}
