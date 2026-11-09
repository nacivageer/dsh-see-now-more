/**
 * region 模式与插话帧的 Δ（变化面积）回归。
 *
 * 为什么单独测：`frame-area.test.mjs` 那 5 条只走普通 `flush()`（pack 路径）。
 * 另外两条路**都不经过 `keep()` 的常规位置**：
 *   - region 走 `flushRegion()`，Δ 是 `keep()` 算好后透传；
 *   - 插话走 `flushNow()`，Δ 是那条路径**自己补算**的（它绕过了 keep）。
 * 透传漏字段、补算用错基准，都不会报错，只会让读图方拿到「最该说清楚的那一格没有数」。
 *
 * 口径：Δ = 相对**上一张留下的帧**的变化像素占比（不是相邻帧，不是格子）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';
import { sheetText } from '../src/index.js';

const W = 320;
const H = 180;
/** region 模式：`width/height` 是**单格**尺寸（长边 = 档位长边），不是画布。 */
const RW = 32;
const RH = 24;
const REGION = { x: 0, y: 0, w: RW, h: RH };

function blank(w, h, fill = 0) {
  return Buffer.alloc(w * h * 3, fill);
}

/** 在 `buf` 上盖一块 `bw × bh` 的纯色块（起点 x/y，按 `w` 像素宽寻址）。 */
function paint(buf, w, x, y, bw, bh, value = 255) {
  for (let yy = y; yy < y + bh; yy += 1) {
    for (let xx = x; xx < x + bw; xx += 1) {
      const p = (yy * w + xx) * 3;
      buf[p] = value;
      buf[p + 1] = value;
      buf[p + 2] = value;
    }
  }
  return buf;
}

/** 普通路径的管线。`maxWaitSec` 拉大：测试要控制「在哪一步出图」，不能让时间自己触发。 */
function mk(opts = {}) {
  return createPipeline({
    width: W, height: H, fps: 12, audioStrip: false, queueDepth: 0,
    cutFutureDelay: 0, maxWaitSec: 1000,
    ...opts,
  });
}

/** region 路径的管线（单格几何）。 */
function mkRegion(opts = {}) {
  return createPipeline({
    region: REGION, width: RW, height: RH, fps: 12, audioStrip: false, queueDepth: 0,
    cutFutureDelay: 0, maxWaitSec: 1000,
    // 兜底帧门槛压低：测试帧之间隔 0.5–1 秒，靠 floor 保证「第二帧一定被留下」。
    silentFloorSec: 0.5,
    ...opts,
  });
}

const frac = (px, w = W, h = H) => px / (w * h);

// ───────────────────────────── region ─────────────────────────────

test('region：两帧一图，Δ 按像素面积给，首格没有基准', () => {
  const p = mkRegion();
  const a = blank(RW, RH, 0);
  const b = blank(RW, RH, 255);
  p.push({ t: 0, buf: a });
  p.push({ t: 1, buf: b });

  const { sheets } = p.finish();
  assert.equal(sheets.length, 1, '两帧应合成一张');
  const s = sheets[0];
  assert.equal(s.frames.length, 2);
  assert.equal(s.frames[0].area, null, '首格没有上一张可比');
  assert.ok(Math.abs(s.frames[1].area - 1) < 1e-9, `整屏换应是 1，实得 ${s.frames[1].area}`);
  // 单格几何：每格就是 region 的尺寸，不是被二次缩放过的
  assert.equal(s.cells[0].pw, RW);
  assert.equal(s.cells[0].ph, RH);
});

test('region：小改按像素算（不是按格子，也不是按画布）', () => {
  const p = mkRegion();
  const a = blank(RW, RH, 0);
  const b = Buffer.from(a);
  paint(b, RW, 2, 2, 6, 4);          // 6×4 = 24 像素
  p.push({ t: 0, buf: a });
  p.push({ t: 1, buf: b });

  const { sheets } = p.finish();
  const got = sheets[0].frames[1].area;
  assert.ok(Math.abs(got - 24 / (RW * RH)) < 1e-9, `应是 24/(${RW}×${RH})，实得 ${got}`);
});

test('region：新管线（换框后重建）首格没有旧基准', () => {
  const p = mkRegion();
  const a = blank(RW, RH, 0);
  p.push({ t: 0, buf: a });
  const s = p.flushNow(0.5);
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].area, null, '换了框就是新管线，不该拿旧区域的面积硬算');
});

test('region + 插话：走 flushRegion 时插话帧也带 Δ', () => {
  const p = mkRegion();
  const a = blank(RW, RH, 0);
  const b = Buffer.from(a);
  paint(b, RW, 2, 2, 6, 4, 255);      // a→b：24 像素
  const c = Buffer.from(b);
  paint(c, RW, 20, 10, 4, 8, 255);    // b→c：32 像素
  p.push({ t: 0, buf: a });
  p.push({ t: 1, buf: b });
  p.push({ t: 1.5, buf: c });

  const s = p.flushNow(1.5);
  // region 攒满 2 帧就先出图了（preferFrames），插话拿到的是「此刻那一帧」
  assert.equal(s.frames.length, 1, 'region 下插话时上一张已经发出');
  const cell = s.frames.find((f) => f.via === 'user');
  assert.ok(cell, '插话帧应标 via=user');
  assert.ok(Math.abs(cell.area - 32 / (RW * RH)) < 1e-9, `应是 b→c 的 32px，实得 ${cell.area}`);
  assert.equal(s.cells.length, s.frames.length);
});

// ───────────────────────────── 插话帧 ─────────────────────────────

test('插话帧：Δ 相对上一张留下的帧补算（绕过 keep 的那条路也有数）', () => {
  const p = mk({ silentFloorSec: 0.5 });
  const a = blank(W, H, 0);
  const b = Buffer.from(a);
  paint(b, W, 10, 10, 24, 24);        // a→b：576 像素（1%）
  const c = Buffer.from(b);
  paint(c, W, 100, 40, 24, 24, 255);  // b→c：另一块 576 像素（画白：那里原先是黑的）
  p.push({ t: 0, buf: a });
  p.push({ t: 1, buf: b });
  p.push({ t: 1.5, buf: c });

  const s = p.flushNow(1.5);
  assert.equal(s.frames.length, 3, '两帧已攒 + 插话帧应都在这张里');
  assert.equal(s.why, 'user');
  const cell = s.frames.find((f) => f.via === 'user');
  assert.ok(cell, '插话帧应标 via=user');
  // 基准是 b（上一张留下的帧），不是相邻帧、也不是 0
  assert.ok(Math.abs(cell.area - frac(576)) < 1e-9, `应是 b→c 的 576px，实得 ${cell.area}`);
  // 前面的格子照样有数
  assert.equal(s.frames[0].area, null);
  assert.ok(Math.abs(s.frames[1].area - frac(576)) < 1e-9);
});

test('插话帧：没有上一张时给 null，不是 0', () => {
  const p = mk();
  const a = blank(W, H, 0);
  p.push({ t: 0, buf: a });

  const s = p.flushNow(0.5);
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].area, null);
  assert.equal(s.why, 'user');
});

test('插话帧成为下一张的基准：跨图 Δ 接着算', () => {
  const p = mk();
  const a = blank(W, H, 0);
  const b = Buffer.from(a);
  paint(b, W, 10, 10, 24, 24);        // a→b：576 像素
  const c = Buffer.from(b);
  paint(c, W, 200, 100, 48, 24, 128); // b→c：1152 像素（2%，且和 a 也差）
  p.push({ t: 0, buf: a });
  p.push({ t: 1, buf: b });
  p.flushNow(1);                       // 第一张出图，b 成为「上一张留下的帧」

  p.push({ t: 2, buf: c });
  const s = p.flushNow(2);
  const cell = s.frames.find((f) => f.via === 'user');
  assert.ok(cell, '插话帧应标 via=user');
  assert.ok(Math.abs(cell.area - frac(1152)) < 1e-9, `应是 b→c 的 1152px，实得 ${cell.area}`);
});

// ───────────────────────────── 文本 ─────────────────────────────

test('文本：插话图带 Δ 说明与「用户插话截断的」', () => {
  const p = mk({ silentFloorSec: 0.5 });
  const a = blank(W, H, 0);
  const b = Buffer.from(a);
  paint(b, W, 10, 10, 24, 24);
  p.push({ t: 0, buf: a });
  p.push({ t: 1, buf: b });
  p.push({ t: 1.5, buf: Buffer.from(b) });

  const s = p.flushNow(1.5);
  const text = sheetText(s);
  assert.match(text, /Δ＝相对上一格的画面变化面积/);
  assert.match(text, /用户插话截断的/);
  const cells = text.split('\n').filter((l) => /^\s+\d+\.\s/.test(l));
  assert.ok(cells.length === 3, `应有三格，实得 ${cells.length}`);
  assert.doesNotMatch(cells[0], /Δ/);
  assert.match(cells[2], /· Δ/);
});
