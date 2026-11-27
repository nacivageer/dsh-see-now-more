/**
 * band-region.test.mjs — 字幕条带图认字幕框（`preset:"subtitle"` + `text.region`）。
 *
 * 任务书：`docs/tasks/subtitle-preset-region.md`。这里测的是**裁哪一块**：
 * 框 → 按框的像素矩形；没框 / 框坏 / 框太矮 → 退回默认带，且原因不许吞掉。
 * 叠图（最多 4 条、带内差分）不在这条测试的范围里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';

// 真机口径：4K 主屏上的字幕框 + ultra 档帧（1596×900）
const W = 1596;
const H = 900;
const BOX = { x: 844, y: 1695, w: 2296, h: 379, sw: 3840, sh: 2160 };
const DEFAULT_BAND = [0.84, 1.0, 0.10];

/** 一帧假画面：只要长度对，字幕带路径不看内容（它只裁不判）。 */
function frame(seed = 0) {
  const buf = Buffer.alloc(W * H * 3, 0);
  for (let i = 0; i < 48; i += 1) buf[i] = (seed + i) & 0xff;
  return buf;
}

function sheetOf(band) {
  const p = createPipeline({ width: W, height: H, fps: 12, band });
  p.push({ t: 0, buf: frame() });
  return p.flushNow(1, 'user');
}

test('认字幕框：4K 上的框换算到 1596×900 帧，图只含那一行', () => {
  const s = sheetOf({ region: BOX, fallback: DEFAULT_BAND });
  assert.equal(s.w, 954, '框宽 2296/3840 × 1596');
  assert.equal(s.h, 158, '框高 379/2160 × 900');
  assert.deepEqual(s.regionRect, { x: 351, y: 706, w: 954, h: 158 });
  assert.equal(s.bandNote, undefined, '换算成功时不该有兜底说明');
});

test('没有字幕框：行为与改动前一致（默认带的宽高，不让边不额外让）', () => {
  const s = sheetOf(DEFAULT_BAND);
  assert.equal(s.w, 1276, '1596 左右各让 10%');
  assert.equal(s.h, 144, '900 的 16%');
  assert.equal(s.regionRect, undefined, '没框就没有像素矩形');
});

test('框在帧内太矮：退回默认带，并把原因写出来（不许静默）', () => {
  // 30px 的框 / 2160 × 900 ≈ 12px 高，低于 16px 下限
  const tiny = { x: 844, y: 1695, w: 400, h: 30, sw: 3840, sh: 2160 };
  const s = sheetOf({ region: tiny, fallback: DEFAULT_BAND });
  assert.equal(s.w, 1276, '退回默认带');
  assert.equal(s.h, 144);
  assert.match(String(s.bandNote), /px 高/, '原因要能被复述，不能只返回一张"看起来正常"的图');
});

test('框坏掉（缺 sw/sh）：退回默认带，不抛', () => {
  const s = sheetOf({ region: { x: 0, y: 0, w: 100, h: 100 }, fallback: DEFAULT_BAND });
  assert.equal(s.w, 1276);
  assert.match(String(s.bandNote), /换算不出/);
});
