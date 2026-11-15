/**
 * bloodbar-ratio-fixtures.test.mjs — 血条比例回归（2026-11-16 真机帧 + 真值表）。
 *
 * 这组是「读数准」的验收：真值来自游戏 UI 上印的 `当前/最大`，不是算法输出，
 * 所以它同时钉住了「条在哪、填充到哪、分母是条宽不是框宽」三件事。
 *
 * 2026-11-16 修的是：`band` 模式原来先找「最亮的一行」当条带，低血时白字数字
 * 比暗红条更亮，数字列被当成填充 —— 4.3% 读成 11%、4% 读成 25%。新做法见
 * `src/bloodbar.js` 里 `BAND_*` / `FILL_*` / `BAR_BG_*` 三段注释。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ratioFromRgb } from '../src/bloodbar.js';
import { decodePng } from './png-decode.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ratio-samples');

/** 真值：`当前/最大`（游戏 UI 同帧印的），见 fixtures 的 README。 */
const CASES = [
  ['2798-17638.png', 15.9],
  ['2798-17638-b.png', 15.9],
  ['2494-17638.png', 14.1],
  ['4177-16100.png', 25.9],
  ['10974-17638.png', 62.2],
  ['22515-22515.png', 100],
];

for (const [file, truth] of CASES) {
  test(`ratio-samples/${file}：真值 ${truth}%，误差 ≤3 点`, () => {
    const { width, height, data } = decodePng(readFileSync(join(DIR, file)));
    assert.equal(width, 421);
    assert.equal(height, 16);
    const r = ratioFromRgb(data, { width, height, mode: 'band' });
    assert.equal(r.ok, true, '框里有血条');
    const got = r.ratio * 100;
    assert.ok(
      Math.abs(got - truth) <= 3,
      `${file}: 真值 ${truth}%，实得 ${got.toFixed(2)}%`,
    );
  });
}

test('ratio-samples/unknown.png：只做负例 —— 能读就不能报 gone，但不对它算误差', () => {
  // 这一帧的真值当时没记下来（README 写明只当负例），所以只要求「别瞎报成没有血条」。
  const { width, height, data } = decodePng(readFileSync(join(DIR, 'unknown.png')));
  const r = ratioFromRgb(data, { width, height, mode: 'band' });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.ratio));
  assert.ok(r.ratio > 0 && r.ratio <= 1);
});
