/**
 * pack-stretch.test.mjs — 排布容差（`stretch` / `see-now.json` 的 `packStretch`）。
 *
 * 这条线的性质只有三条要紧，其余都是细节：
 *
 *  1. **默认一格都不裁**：`stretch = 0` 时每个格子必须是正方形（归一化 w === h），
 *     这才配得上"画布比例 = 源画面比例 → 裁切 0%"。破这条 = 每一张图都在悄悄丢边缘。
 *  2. **调高真的会裁，且上限是 23%**：`stretch = 0.3` 即最宽格 1.3:1，`cover` 裁掉
 *     `1 - 1/1.3 = 23%`。这条钉住"0.3 是什么"这个换算，别让以后的人以为它只是拉伸。
 *  3. **配置读得进来、写错退回默认并报出来**：`packStretch: 30`（把百分比当小数）
 *     必须变成一条 warn，而不是悄悄渲染成 30 倍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_STRETCH, STRETCH_MAX, solve, toRects } from '../src/pack.js';
import { composePacked } from '../src/sheet.js';
import { DEFAULTS } from '../src/pipeline.js';
import { TUNING_DEFAULTS, readTuning } from '../src/tuning.js';

/** 一段多档混排的序列 —— 全 1 档时任何 stretch 都不裁，量不出区别。 */
const MIXED = [3, 4, 3, 3, 4, 3];
const BUSY = [5, 6, 5, 7, 5, 6, 5, 5, 6];

/** 归一化格子 → 裁切比例（画布与源画面同比，正方形 = 0）。 */
function cropOf(cell) {
  const ar = cell.w / cell.h;
  return 1 - Math.min(ar, 1 / ar);
}

test('默认一格都不裁：每个格子都是正方形', () => {
  assert.equal(DEFAULT_STRETCH, 0, 'pack 的默认必须是 0');
  assert.equal(DEFAULTS.stretch, 0, 'pipeline 的默认必须是 0');
  assert.equal(TUNING_DEFAULTS.packStretch, 0, '配置的默认必须是 0');
  for (const seq of [MIXED, BUSY, [1, 1, 2, 3, 1, 2, 1, 1, 2], [1, 1, 1, 1]]) {
    const r = solve(seq, { binCost: 1000 });
    for (const c of r.cells) {
      assert.ok(Math.abs(c.w - c.h) < 1e-9,
        `tier=${c.t} 的格子 ${c.w.toFixed(3)}×${c.h.toFixed(3)} 不是正方形 —— 会裁画面`);
      assert.equal(cropOf(c), 0, `tier=${c.t} 裁了 ${(cropOf(c) * 100).toFixed(1)}%`);
    }
  }
});

test('stretch=0.3（老默认）真的会裁，且单格上限 23%', () => {
  const r = solve(BUSY, { binCost: 1000, stretch: 0.3 });
  const crops = r.cells.map(cropOf);
  const worst = Math.max(...crops);
  assert.ok(worst > 0.2, `应该有几格被裁到 20% 以上，实际最大 ${(worst * 100).toFixed(1)}%`);
  // 一行被拉成 1.3:1 的等高带时，最惨的那格正好是 1 - 1/1.3
  assert.ok(worst < 1 - 1 / 1.3 + 1e-6, `超过换算上限了：${(worst * 100).toFixed(1)}%`);
  // 而且不止一格 —— 这条用来记住"不是偶尔一格"。真正的比例看
  // `scripts/pack-crop-curve.mjs`（快场景 68% 的格子被切过），单条序列数不齐。
  assert.ok(crops.filter((c) => c > 0.01).length >= 2, `只切了 ${crops.filter((c) => c > 0.01).length} 格`);
});

test('stretch 越大越省张数，但同一段序列的帧一个都不能少', () => {
  const seq = BUSY;
  const n0 = solve(seq, { binCost: 1000, stretch: 0 });
  const n3 = solve(seq, { binCost: 1000, stretch: 0.3 });
  assert.equal(n0.cells.length, seq.length, '不裁的时候也必须排下全部帧');
  assert.equal(n3.cells.length, seq.length, '裁切不许丢帧');
  assert.ok(n3.bins <= n0.bins, `老行为不该比不裁更费图：${n3.bins} > ${n0.bins}`);
});

test('端到端：源画面描一圈边框，裁切会把边框吃掉（不裁则每格四周都在）', () => {
  // 光验 w/h 不够 —— 真正决定"看到什么"的是 coverIntoAt。这里造一张带 12px 洋红边框的
  // 16:9 源图，走完 solve → toRects → composePacked，再去读**画出来的像素**。
  const SW = 320;
  const SH = 180;
  const B = 12;
  const src = Buffer.alloc(SW * SH * 3);
  for (let y = 0; y < SH; y += 1) {
    for (let x = 0; x < SW; x += 1) {
      const edge = x < B || y < B || x >= SW - B || y >= SH - B;
      const i = (y * SW + x) * 3;
      src[i] = edge ? 255 : 40;
      src[i + 1] = edge ? 0 : 40;
      src[i + 2] = edge ? 200 : 40;
    }
  }
  const isPink = (buf, w, x, y) => {
    const i = (y * w + x) * 3;
    return buf[i] > 150 && buf[i + 1] < 90 && buf[i + 2] > 120;
  };
  const W = 800;
  const H = 450;
  const edgePink = (stretch) => {
    const plan = solve(BUSY, { binCost: 1000, stretch });
    const rects = toRects(plan.cells.filter((c) => c.bin === 0), { width: W, height: H });
    const sheet = composePacked({
      frames: rects.map(() => ({ src, sw: SW, sh: SH })),
      rects, width: W, height: H, burn: 'none',
    });
    const keep = [];
    for (const r of rects) {
      const my = r.py + Math.floor(r.ph / 2);
      keep.push(isPink(sheet.buffer, W, r.px + 1, my) && isPink(sheet.buffer, W, r.px + r.pw - 2, my));
    }
    return keep;
  };
  const none = edgePink(0);
  assert.ok(none.every(Boolean), `不裁时每格左右边框都该在：${none.map(Number).join('')}`);
  const old = edgePink(0.3);
  assert.ok(old.filter(Boolean).length < old.length,
    `stretch=0.3 应该有格子丢掉左右边框：${old.map(Number).join('')}`);
});

test('静态场景（全 1 档）任何 stretch 都不裁 —— 看视频/挂机不受影响', () => {
  const seq = [1, 1, 1, 1, 1, 1, 1, 1];
  for (const stretch of [0, 0.1, 0.2, 0.3]) {
    const r = solve(seq, { binCost: 1000, stretch });
    assert.equal(Math.max(...r.cells.map(cropOf)), 0, `stretch=${stretch} 全 1 档不该裁`);
    assert.equal(r.bins, r.cells.length / 4, '4 帧一张这条老性质不能变');
  }
});

test('配置：packStretch 读得进来，越界 / 写错退回默认并记 warn', () => {
  const env = { DSH_HOME: '/nonexistent-see-now-test' };
  assert.equal(readTuning({ env }).packStretch, 0, '没配过 = 一格都不裁');

  const ok = readTuning({ env, readFile: () => JSON.stringify({ packStretch: 0.2 }) });
  assert.equal(ok.packStretch, 0.2);
  assert.deepEqual(ok.warnings, []);

  // 把百分比当小数写（30 而不是 0.3）是最自然的手滑
  for (const bad of [30, -0.1, 'abc', 0.31]) {
    const r = readTuning({ env, readFile: () => JSON.stringify({ packStretch: bad }) });
    assert.equal(r.packStretch, TUNING_DEFAULTS.packStretch, `${bad} 应该退回默认`);
    assert.ok(r.warnings.some((w) => w.includes('packStretch')), `${bad} 应该有一条 warn`);
  }

  // 上限就是老默认；多给一点也不许越过
  assert.equal(STRETCH_MAX, 0.3);
});
