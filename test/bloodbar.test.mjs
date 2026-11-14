/**
 * bloodbar.test.mjs — 血条读数纯逻辑（P1a）。
 *
 * 合成帧就能覆盖：满血 / 半血 / 没有血条 / 彩色条（不认）/ 尺寸错。
 * 不需要采集、不需要真机、不设 DSH_HOME（框选配置那几条用临时目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ratioFromRgba, loadBloodbar, saveBloodbar, clearBloodbar, bloodbarLine, bloodbarText,
  DEFAULT_THRESHOLD,
} from '../src/bloodbar.js';

/** 造一帧 RGBA：`paint(x, y)` 返回 `[r,g,b,a?]`。 */
function frame(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      const o = (y * width + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return rgba;
}

const WHITE = () => [255, 255, 255];
const BLACK = () => [0, 0, 0];
const DARK = () => [30, 30, 30];

test('满血：框内全白 → ratio 1，不低于阈值', () => {
  const r = ratioFromRgba(frame(10, 4, WHITE), { width: 10, height: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.visible, true);
  assert.equal(r.ratio, 1);
  assert.equal(r.below, false);
  assert.equal(r.total, 40);
  assert.equal(r.bright, 40);
});

test('半血：左半白、右半深灰 → ratio 0.5', () => {
  const r = ratioFromRgba(frame(10, 4, (x) => (x < 5 ? WHITE() : DARK())), { width: 10, height: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.ratio, 0.5);
  assert.equal(r.below, false);
});

test('阈值：ratio 0.5、阈值 0.6 → below 为真', () => {
  const r = ratioFromRgba(frame(10, 4, (x) => (x < 5 ? WHITE() : DARK())), {
    width: 10, height: 4, threshold: 0.6,
  });
  assert.equal(r.below, true);
});

test('没有血条：全黑 → ok:false / gone，不冒充 0 血', () => {
  const r = ratioFromRgba(frame(10, 4, BLACK), { width: 10, height: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.visible, false);
  assert.equal(r.reason, 'gone');
  assert.equal(r.ratio, 0);
});

test('彩色条不认：纯红饱和度高 → gone（只认低饱和亮色）', () => {
  const r = ratioFromRgba(frame(10, 4, () => [255, 0, 0]), { width: 10, height: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gone');
});

test('中灰算亮色（低饱和），深灰不算', () => {
  const mid = ratioFromRgba(frame(4, 2, () => [200, 200, 200]), { width: 4, height: 2 });
  assert.equal(mid.ratio, 1);
  const dark = ratioFromRgba(frame(4, 2, () => [100, 100, 100]), { width: 4, height: 2 });
  assert.equal(dark.ok, false);
});

test('尺寸/像素对不上 → bad-frame，不越界读', () => {
  assert.equal(ratioFromRgba(new Uint8Array(10), { width: 10, height: 4 }).reason, 'bad-frame');
  assert.equal(ratioFromRgba(null, { width: 10, height: 4 }).reason, 'bad-frame');
  assert.equal(ratioFromRgba(new Uint8Array(40), { width: 0, height: 4 }).reason, 'bad-frame');
});

test('框选配置：存 / 读 / 清（临时 DSH_HOME）', () => {
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-bloodbar-')) };
  try {
    assert.deepEqual(loadBloodbar(env), { region: null, threshold: DEFAULT_THRESHOLD, at: null });

    saveBloodbar({ region: { x: 1, y: 2, w: 30, h: 6 } }, env);
    const got = loadBloodbar(env);
    assert.deepEqual(got.region, { x: 1, y: 2, w: 30, h: 6 });
    assert.equal(got.threshold, DEFAULT_THRESHOLD);
    assert.ok(got.at > 0);

    saveBloodbar({ region: { x: 5, y: 6, w: 20, h: 4 }, threshold: 0.4 }, env);
    const got2 = loadBloodbar(env);
    assert.deepEqual(got2.region, { x: 5, y: 6, w: 20, h: 4 });
    assert.equal(got2.threshold, 0.4);

    // 再存但不传阈值 → 保留原阈值
    saveBloodbar({ region: { x: 7, y: 8, w: 10, h: 2 } }, env);
    assert.equal(loadBloodbar(env).threshold, 0.4);

    assert.equal(clearBloodbar(env), true);
    assert.equal(loadBloodbar(env).region, null);
  } finally {
    rmSync(env.DSH_HOME, { recursive: true, force: true });
  }
});

test('bloodbarLine：没框 / 未采 / 有读数 / 框里没有血条', () => {
  assert.match(bloodbarLine({ region: null, threshold: 0.3 }), /没框/);
  assert.equal(
    bloodbarLine({ region: { x: 1, y: 2, w: 3, h: 4 }, threshold: 0.3 }),
    '血条：框 1,2,3,4（阈值 30%）· 未采（P1a 只框不算）',
  );
  assert.equal(
    bloodbarLine({ region: { x: 1, y: 2, w: 3, h: 4 }, threshold: 0.3 }, { ok: true, ratio: 0.62, below: false }),
    '血条：框 1,2,3,4（阈值 30%）· 最近 62%',
  );
  assert.equal(
    bloodbarLine({ region: { x: 1, y: 2, w: 3, h: 4 }, threshold: 0.3 }, { ok: true, ratio: 0.2, below: true }),
    '血条：框 1,2,3,4（阈值 30%）· 最近 20%（低于阈值）',
  );
  assert.match(
    bloodbarLine({ region: { x: 1, y: 2, w: 3, h: 4 }, threshold: 0.3 }, { ok: false, reason: 'gone' }),
    /现在框里没有血条/,
  );
  assert.equal(bloodbarText({ x: 1, y: 2, w: 3, h: 4 }), '1,2,3,4');
});
