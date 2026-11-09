/**
 * 变化面积（Δ）的回归：`changedArea` 的口径 + 它有没有一路走到文本里。
 *
 * 为什么值得单独测：这个数是要**给读图方当判据用**的（「1% 的刷新」不该被说成
 * 「弹出卡片」）。口径错了不会报错，只会让模型把小的说大、把整页换掉说成小改 ——
 * 静默错误，只能靠数字对账。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { changedArea } from '../src/cuts.js';
import { createPipeline } from '../src/pipeline.js';
import { sheetText } from '../src/index.js';

const W = 320;
const H = 180;

function blank(fill = 0) {
  return Buffer.alloc(W * H * 3, fill);
}

/** 在 `buf` 上盖一块 `bw × bh` 的纯色块（起点 x/y）。 */
function paint(buf, x, y, bw, bh, value = 255) {
  for (let yy = y; yy < y + bh; yy += 1) {
    for (let xx = x; xx < x + bw; xx += 1) {
      const p = (yy * W + xx) * 3;
      buf[p] = value;
      buf[p + 1] = value;
      buf[p + 2] = value;
    }
  }
  return buf;
}

test('changedArea：同一张图是 0', () => {
  const a = blank(0);
  assert.equal(changedArea(a, a), 0);
  assert.equal(changedArea(a, Buffer.from(a)), 0);
});

test('changedArea：面积按像素算，不是按格子', () => {
  const a = blank(0);
  const b = Buffer.from(a);
  // 1% 的面积：320×180 的 1% = 576 像素，取 24×24
  paint(b, 10, 10, 24, 24);
  const got = changedArea(a, b);
  assert.ok(Math.abs(got - 576 / (W * H)) < 1e-9, `got ${got}`);
});

test('changedArea：低于阈值的改动不算，长度不一致不猜', () => {
  const a = blank(0);
  const b = Buffer.from(a);
  // 每像素差 5（< tau=12）：整屏都"变了"也不该记成面积
  b.fill(5);
  assert.equal(changedArea(a, b), 0);
  assert.equal(changedArea(a, Buffer.alloc(3)), null);
  assert.equal(changedArea(null, b), null);
});

/** 跑一条真管线，返回所有图里的格子（`queueDepth: 0` = 一张都不丢）。 */
function run(frames) {
  const p = createPipeline({
    width: W, height: H, fps: 12, audioStrip: false, queueDepth: 0,
    // 关掉未来帧确认：测试帧之间要一步到位，别让「等 0.5 秒再看」把帧卡在队列里
    cutFutureDelay: 0,
  });
  for (const { t, buf } of frames) p.push({ t, buf });
  const { stats, sheets } = p.finish();
  return { stats, sheets, cells: sheets.flatMap((s) => s.frames) };
}

test('管线：每格带 Δ，首格没有（没有上一张可比）', () => {
  const a = blank(0);
  const b = blank(255);
  const c = Buffer.from(b);
  // c 相对 **上一格（b）** 只改了 24×24 一小块（1% 的面积）
  paint(c, 100, 40, 24, 24, 0);

  const { cells } = run([
    { t: 0, buf: a },
    { t: 1, buf: b },
    // 第 40 秒才再喂一帧：中间没变化，走的是**兜底帧**（floor 不过去重闸）。
    // 小改动（1%）会被 dupMin 挡在 mark 外面 —— 那是既有行为，不在这条改动的范围里。
    { t: 40, buf: c },
  ]);
  assert.equal(cells.length, 3, `三帧都该留下，实得 ${cells.length}`);
  const areas = cells.map((f) => f.area);
  assert.equal(areas[0], null, '第一格没有基准');
  assert.ok(areas[1] > 0.99, `整屏换页应是 ~100%，实得 ${areas[1]}`);
  assert.ok(Math.abs(areas[2] - 576 / (W * H)) < 1e-9, `小改应是 1%，实得 ${areas[2]}`);
});

test('文本：Δ 出现在每格后面，且表头解释了口径', () => {
  const a = blank(0);
  const b = blank(255);
  const { sheets } = run([{ t: 0, buf: a }, { t: 1, buf: b }]);
  const text = sheetText(sheets[sheets.length - 1]);
  assert.match(text, /Δ＝相对上一格的画面变化面积/);
  // 第一格没有 Δ，第二格有
  const cells = text.split('\n').filter((l) => /^\s+\d+\.\s/.test(l));
  assert.ok(cells.length >= 2, `应有两格以上，实得 ${cells.length}`);
  assert.doesNotMatch(cells[0], /Δ/);
  assert.match(cells[1], /Δ(100%|99\.\d+%)/);
});
