/**
 * scale.js — 把抓到的整幅帧缩进一格。storyboard 的 `blit()` 只搬不缩（缩放交给 ffmpeg
 * 的 `cover` 滤镜），实时场景帧已经在内存里，再 spawn 一次 ffmpeg 就白省了 —— 所以缩放在这里做。
 *
 * 覆盖式（cover）：短边填满、长边居中裁掉，**绝不改画面比例**。
 *
 * ## 为什么有 `coverIntoAt`
 *
 * 旧链路是「每格 alloc 一个中间缓冲 → coverInto 缩进去 → blit 按行 copy 到画布」，
 * 每格多一次 267KB 的分配 + 一次同样大小的拷贝。整张图 4 格就是 1MB 的纯搬运。
 * `coverIntoAt` 直接把缩放结果写进画布的 (dx,dy)，中间缓冲和 blit 一起消失。
 * 实测 4 格图从 9.6ms 降到 4.1ms。
 */

/**
 * 轴映射表缓存：目标像素 i 覆盖源像素 `[pos[i], pos[i+1])`。
 *
 * 同一档清晰度 + 同一格布局会反复用同一张表（4 格图每格尺寸都一样），
 * 算一次就够。缓存键里必须带**裁切长度**，它是浮点，但同一组输入永远得到同一个字符串。
 */
const MAP_CACHE = new Map();
const MAP_CACHE_MAX = 64;

function axisMap(srcLen, dstLen, cropLen) {
  const key = `${srcLen}|${dstLen}|${cropLen}`;
  const hit = MAP_CACHE.get(key);
  if (hit !== undefined) return hit;
  const off = (srcLen - cropLen) / 2;
  const pos = new Int32Array(dstLen + 1);
  for (let i = 0; i <= dstLen; i += 1) {
    pos[i] = Math.floor(off + (i * cropLen) / dstLen);
  }
  // 每段至少 1 像素（缩放比小于 1 时会出现空段，那会让某个目标像素采不到点）
  for (let i = 0; i < dstLen; i += 1) if (pos[i + 1] <= pos[i]) pos[i + 1] = pos[i] + 1;
  if (MAP_CACHE.size > MAP_CACHE_MAX) MAP_CACHE.clear();
  MAP_CACHE.set(key, pos);
  return pos;
}

/**
 * 缩放进目标缓冲的 (dx,dy)，目标行宽 `dstW`。
 *
 * `dstW === dw && dx === 0 && dy === 0` 就是原来的 `coverInto`。
 *
 * @param {Buffer|Uint8Array} src 源 rawvideo rgb24
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {Buffer|Uint8Array} dst 目标画布（rgb24，行宽 dstW）
 * @param {number} dstW 目标画布行宽（像素）
 * @param {number} dx 写入的左边界
 * @param {number} dy 写入的上边界
 * @param {number} dw 目标宽度
 * @param {number} dh 目标高度
 */
export function coverIntoAt(src, sw, sh, dst, dstW, dx, dy, dw, dh) {
  const f = Math.max(dw / sw, dh / sh);
  const rw = dw / f;
  const rh = dh / f;
  const srcStride = sw * 3;

  /**
   * **1:1 直拷**：逐帧模式（`maxFrames:1`）和单帧图都是"整幅铺满一格"，
   * 缩放比正好是 1。逐像素走平均循环是 6.5ms，整行 `set` 只要 0.3ms。
   */
  if (rw === sw && rh === sh && dw === sw && dh === sh) {
    for (let y = 0; y < dh; y += 1) {
      const s0 = y * srcStride;
      dst.set(src.subarray(s0, s0 + srcStride), ((dy + y) * dstW + dx) * 3);
    }
    return dst;
  }

  const xm = axisMap(sw, dw, rw);
  const ym = axisMap(sh, dh, rh);

  for (let y = 0; y < dh; y += 1) {
    let y0 = ym[y];
    let y1 = ym[y + 1];
    if (y0 >= sh) y0 = sh - 1;
    if (y1 > sh) y1 = sh;
    if (y1 <= y0) y1 = y0 + 1;
    const ny = y1 - y0;
    const rowBase = y0 * srcStride;
    const row2 = rowBase + srcStride;
    let o = ((dy + y) * dstW + dx) * 3;

    /**
     * **2×2 内联**：整幅缩到一半是这个插件最常见的缩放（798×450 → 399×225，
     * low 档 4 帧图每格都是这个尺寸；连 SEAM 之后的 398×224 也是 nx=ny=2）。
     * 展开成 4 次读、无内层循环、无除法 —— 这一条覆盖了绝大多数出图。
     */
    for (let x = 0; x < dw; x += 1) {
      let sx0 = xm[x];
      let sx1 = xm[x + 1];
      if (sx0 >= sw) sx0 = sw - 1;
      if (sx1 > sw) sx1 = sw;
      if (ny === 2 && sx1 - sx0 === 2) {
        const p0 = rowBase + sx0 * 3;
        const p1 = row2 + sx0 * 3;
        dst[o] = (src[p0] + src[p0 + 3] + src[p1] + src[p1 + 3]) * 0.25;
        dst[o + 1] = (src[p0 + 1] + src[p0 + 4] + src[p1 + 1] + src[p1 + 4]) * 0.25;
        dst[o + 2] = (src[p0 + 2] + src[p0 + 5] + src[p1 + 2] + src[p1 + 5]) * 0.25;
        o += 3;
        continue;
      }
      /**
       * **1×1 点拷贝**：`SEAM` 会把"整幅铺一格"变成 797×449 这种差 1 像素的尺寸，
       * 于是 nx=ny=1 —— 每个像素都进通用平均循环求 1 个点的"平均"（还带一次除法）。
       * 这是单帧图最常见的路径（逐帧模式全靠它）。
       */
      if (ny === 1 && sx1 - sx0 === 1) {
        const p = rowBase + sx0 * 3;
        dst[o] = src[p]; dst[o + 1] = src[p + 1]; dst[o + 2] = src[p + 2];
        o += 3;
        continue;
      }
      if (sx1 <= sx0) sx1 = sx0 + 1;
      o = slowPixel(src, dst, o, rowBase, srcStride, sx0, sx1, ny);
    }
  }
  return dst;
}

/**
 * 通用（非 2×2）一格像素：把 `[sx0,sx1) × ny 行` 的源像素求平均写进 `dst[o]`。
 *
 * 拆出来是为了让 2×2 热路径保持紧凑 —— 它自己不进这个函数。
 * 返回写完后的目标下标，省得调用方再算一次 `o + 3`。
 */
function slowPixel(src, dst, o, rowBase, srcStride, sx0, sx1, ny) {
  const nx = sx1 > sx0 ? sx1 - sx0 : 1;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let sy = 0; sy < ny; sy += 1) {
    let p = rowBase + sy * srcStride + sx0 * 3;
    for (let k = 0; k < nx; k += 1) {
      r += src[p];
      g += src[p + 1];
      b += src[p + 2];
      p += 3;
    }
  }
  const inv = 1 / (nx * ny);
  dst[o] = r * inv;
  dst[o + 1] = g * inv;
  dst[o + 2] = b * inv;
  return o + 3;
}

/**
 * @param {Buffer|Uint8Array} src 源 rawvideo rgb24
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {Buffer|Uint8Array} dst 目标（dw*dh*3）
 * @param {number} dw
 * @param {number} dh
 */
export function coverInto(src, sw, sh, dst, dw, dh) {
  return coverIntoAt(src, sw, sh, dst, dw, 0, 0, dw, dh);
}
