/**
 * pipeline-integral.test.mjs — 积分阈值不能跟着采集 fps 漂。
 *
 * 2026-11-19 对上游 0.2.3 时量出来的：累加的是**绝对差**，同一段素材的 Σscore
 * 基本与 fps 无关；阈值乘实际 fps 会让 8fps 那条路（`source:"window"`）低 1/3，
 * 同样的画面多留 33% 的帧（testsrc2 30 秒：12fps 12 格 / 8fps 16 格）。
 *
 * 这里用一个刚好卡在两条阈值之间的画面来守：总 Σscore 约 108，旧写法 8fps 的
 * 阈值是 96（会多留一格），12fps 是 144（不留）；改成基准 12fps 之后两边一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { INTEGRAL_BASE_FPS, REF_SCORE, createPipeline, integralNeedFor } from '../src/pipeline.js';

const W = 320;
const H = 180;

/** 60×100 的白块以 45px/s 横移：慢速、无切点，攒分只走积分那条路。 */
function frame(t) {
  const b = Buffer.alloc(W * H * 3, 0);
  const pos = Math.round(45 * t);
  for (let y = 40; y < 140; y += 1) {
    for (let x = pos; x < pos + 60; x += 1) {
      if (x < 0 || x >= W) continue;
      const p = (y * W + x) * 3;
      b[p] = 255;
      b[p + 1] = 255;
      b[p + 2] = 255;
    }
  }
  return b;
}

function run(fps, integralSeconds = 3) {
  const p = createPipeline({
    width: W, height: H, fps, audioStrip: false, cutFutureDelay: 0, queueDepth: 0, integralSeconds,
  });
  const n = Math.round(fps * 10);
  for (let k = 0; k < n; k += 1) p.push({ t: k / fps, buf: frame(k / fps) });
  const { stats, sheets } = p.finish();
  return { cells: sheets.flatMap((s) => s.frames).length, marks: stats.marks, sum: stats.scoreSum };
}

test('积分阈值按基准 fps 算：integralNeedFor 与采集 fps 无关', () => {
  assert.equal(INTEGRAL_BASE_FPS, 12);
  assert.equal(integralNeedFor(3), REF_SCORE * 12 * 3);
  assert.equal(integralNeedFor(1.5), REF_SCORE * 12 * 1.5);
  assert.equal(integralNeedFor(), integralNeedFor(3));
});

test('同一段画面在 8fps 与 12fps 下留的帧数一致（阈值不漂）', () => {
  const a = run(8);
  const b = run(12);
  assert.equal(a.marks, b.marks, `8fps marks=${a.marks} / 12fps marks=${b.marks}`);
  assert.equal(a.cells, b.cells, `8fps cells=${a.cells} / 12fps cells=${b.cells}`);
});
