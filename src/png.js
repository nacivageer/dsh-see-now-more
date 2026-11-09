/**
 * png.js — 纯 JS 的 PNG 编码，不 spawn ffmpeg。
 *
 * 为什么要有它：storyboard 的 `encodePngBuffer` 走 ffmpeg，实测 147 ms，
 * 其中 **95.5 ms 是进程启动**（`ffmpeg -version` 什么都不做就要这么久）。
 * 实时看视频要每隔几秒出一张图，这笔固定成本不能每次付。
 *
 * PNG 本身很简单：签名 + IHDR + IDAT(zlib) + IEND，每块带 CRC32。
 * 只有一件事必须做对 —— **扫描线每行前面要加一个滤波类型字节**，
 * 忘了它就会得到一张错行的图，而且是"看起来像图但内容是斜的"那种错。
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个 PNG 块：长度(4) + 类型(4) + 数据 + CRC(4)，CRC 覆盖「类型+数据」。 */
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * RGB 原始像素 → PNG 字节。
 *
 * @param {Buffer|Uint8Array} rgb 长度必须是 width*height*3（rgb24，与 ffmpeg rawvideo 一致）
 * @param {number} width
 * @param {number} height
 * @param {{level?: number}} [opts] level 1–9，默认 6；实时场景用 1 能快一倍且体积差别不大
 */
export function encodePng(rgb, width, height, { level = 6 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`bad size ${width}x${height}`);
  }
  const need = width * height * 3;
  if (!rgb || rgb.length < need) {
    throw new RangeError(`rgb too small: ${rgb?.length ?? 0} < ${need}`);
  }

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;                       // 滤波类型 0 = None，省事且对照片类内容影响很小
    rgb.copy
      ? rgb.copy(raw, rowStart + 1, y * stride, y * stride + stride)
      : raw.set(rgb.subarray(y * stride, y * stride + stride), rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 2;    // 颜色类型 2 = truecolor RGB
  ihdr[10] = 0;   // 压缩方法
  ihdr[11] = 0;   // 滤波方法
  ihdr[12] = 0;   // 隔行 0 = 非隔行

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 一张测试卡：4×4 十六个不同色相。**验证"图真的到了模型那里"**用 ——
 * 模型如果描述得出"十六个彩色方块、四行四列"，就说明整条链路通了，
 * 而不是只收到一条文本。
 */
export function testCard(width = 320, height = 180) {
  const rgb = Buffer.alloc(width * height * 3);
  const cols = 4;
  const rows = 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cx = Math.min(cols - 1, Math.floor((x / width) * cols));
      const cy = Math.min(rows - 1, Math.floor((y / height) * rows));
      const i = cy * cols + cx;
      // 用色相环均匀取 16 个色，保证相邻块对比明显
      const [r, g, b] = hslToRgb(i / 16, 0.72, 0.55);
      // 每块内侧留 2px 深色缝，方便一眼数出格子
      const inner = (x % Math.floor(width / cols)) > 1 && (y % Math.floor(height / rows)) > 1;
      const p = (y * width + x) * 3;
      rgb[p] = inner ? r : 18;
      rgb[p + 1] = inner ? g : 18;
      rgb[p + 2] = inner ? b : 20;
    }
  }
  return { rgb, width, height };
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
