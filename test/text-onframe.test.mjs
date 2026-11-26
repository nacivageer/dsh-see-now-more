/**
 * text-onframe.test.mjs — 管线把**每一帧原始画面**都交给文字流（P1 第 2 步的挂钩）。
 *
 * 为什么要单独测：任务书的硬要求是「在 `pipeline.push()` 的原始帧上 1 fps 抽一帧」，
 * 不能只喂 keep 帧（keep 会被去重挡掉，而"图不变、字幕可以变"正是要抓的那种）。
 * 这条测试直接数 `onFrame` 被调了几次 —— 少一次就是丢字。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';

const W = 160;
const H = 90;

function frame(seed) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 7 + seed * 13) & 0xff;
  return buf;
}

test('push 每帧都调 onFrame，且参数带 width/height/wall', () => {
  const seen = [];
  const p = createPipeline({
    width: W, height: H, fps: 12,
    onFrame: (f) => seen.push(f),
  });
  for (let i = 0; i < 10; i += 1) p.push({ t: i / 12, buf: frame(i) });
  assert.equal(seen.length, 10);
  const f = seen[0];
  assert.equal(f.width, W);
  assert.equal(f.height, H);
  assert.equal(f.buf.length, W * H * 3);
  assert.ok(Number.isFinite(f.wall) && f.wall > 1e12, 'wall 必须是 epoch ms（闸门与台词同一把尺）');
});

test('onFrame 抛异常不许弄挂出图', () => {
  const p = createPipeline({
    width: W, height: H, fps: 12,
    onFrame: () => { throw new Error('文字流炸了'); },
  });
  for (let i = 0; i < 5; i += 1) assert.doesNotThrow(() => p.push({ t: i / 12, buf: frame(i + 3) }));
  assert.equal(p.stats.frames, 5);
});

test('没给 onFrame 时行为不变', () => {
  const p = createPipeline({ width: W, height: H, fps: 12 });
  for (let i = 0; i < 5; i += 1) p.push({ t: i / 12, buf: frame(i + 5) });
  assert.equal(p.stats.frames, 5);
});
