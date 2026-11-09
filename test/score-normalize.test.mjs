/**
 * score-normalize.test.mjs — 亮度归一 + 黑边补偿（`cuts.js` 的 `normalizeScore`）。
 *
 * 两条最容易退化的性质，各用断言钉住：
 *  1. **亮场逐位不变**（gain = 1、无黑边 → 原样返回）。破这条 = 悄悄改了所有人的日常体验。
 *  2. **噪声地板**：低于地板的分数不许被放大。破这条 = 暗场静止画面自己切个不停。
 *
 * 第三条是黑边判据必须看"整窗"，只看当前帧会把片头黑场当成黑边。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAR_CAP, REF_V, SCAN_H, SCAN_W, barFraction, brightnessGain, createScorer, normalizeScore,
} from '../src/cuts.js';
import { DEFAULTS } from '../src/pipeline.js';
import { readTuning } from '../src/tuning.js';

const W = SCAN_W;
const H = SCAN_H;

/** 一帧 rgb24：上下各 `bar` 行纯黑，其余 `v` 灰度。 */
function frame({ v = 200, bar = 0, blue = 0 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    const black = y < bar || y >= H - bar;
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = black ? 0 : v;
      buf[i + 1] = black ? 0 : v;
      buf[i + 2] = black ? 0 : Math.min(255, v + blue);
    }
  }
  return buf;
}

// ---------------------------------------------------------------- 纯函数

test('normalizeScore：亮场（V ≥ REF_V）无黑边 → 原样返回，逐位相同', () => {
  for (const raw of [0, 1, 5.999, 6, 12, 12.7, 47.25, 255]) {
    assert.equal(normalizeScore(raw, { meanV: 160, barFrac: 0 }), raw, `raw=${raw}`);
    assert.equal(normalizeScore(raw, { meanV: 240, barFrac: 0 }), raw, `raw=${raw}`);
    assert.equal(normalizeScore(raw, { meanV: REF_V, barFrac: 0 }), raw, `raw=${raw}`);
  }
  // 没有亮度信息（第一帧）也必须是恒等，不许默认放大
  assert.equal(normalizeScore(12, {}), 12);
});

test('normalizeScore：暗场按 REF_V/meanV 放大，上限 1.85 倍', () => {
  // 96 是**这批标定素材自己的亮度**（真 PV 关键帧，12fps 网格）——取它当参考点，
  // 正常视频内容就是 gain 1，不会像 REF_V=160 那样把所有内容整体放大 1.67 倍。
  assert.equal(brightnessGain(80), 1.2);
  assert.equal(brightnessGain(REF_V), 1);
  assert.equal(brightnessGain(160), 1);
  assert.equal(brightnessGain(255), 1);
  // 上限 1.85：实测"把暗场拉回原亮度"最多需要 1.86 倍，3 倍会过冲成 2 倍敏感
  assert.equal(brightnessGain(40), 1.85);
  assert.equal(brightnessGain(10), 1.85);
  assert.equal(brightnessGain(0), 1, '全黑的 V=0 视为没有信息，不放大');
  assert.equal(normalizeScore(10, { meanV: 80 }), 12);
  assert.equal(normalizeScore(10, { meanV: 20 }), 18.5);
});

test('normalizeScore：黑边按占比除回来', () => {
  assert.equal(normalizeScore(10, { meanV: 200, barFrac: 0.25 }), 10 / 0.75);
  assert.equal(normalizeScore(8, { meanV: 200, barFrac: 0 }), 8);
  // 两个补偿相乘：暗场 ×1.2、黑边 25% → 10 * 1.2 / 0.75
  assert.ok(Math.abs(normalizeScore(10, { meanV: 80, barFrac: 0.25 }) - (12 / 0.75)) < 1e-9);
});

test('normalizeScore：噪声地板以下的分数不放大（最容易踩的坑）', () => {
  // 地板 2：实测静止暗场的编码噪声 raw 只有 0.00–0.13，留 15 倍余量。
  // 原先取 6 是为了挡"×3 的乘链"，但那样连它自己举的"暗场真切点约 5 分"都救不回。
  for (const raw of [0.4, 1, 1.99]) {
    assert.equal(normalizeScore(raw, { meanV: 40, barFrac: 0 }), raw, `raw=${raw} 不该被放大`);
  }
  assert.equal(normalizeScore(2, { meanV: 40 }), 3.7, '刚好到地板就参与放大');
});

test('normalizeScore：第一帧 / 0 / NaN 原样透传，不造出 -0 和 NaN', () => {
  assert.equal(normalizeScore(null, { meanV: 80 }), null);
  assert.equal(normalizeScore(undefined, { meanV: 80 }), undefined);
  assert.ok(Number.isNaN(normalizeScore(NaN, { meanV: 80 })));
  assert.equal(normalizeScore(0, { meanV: 20 }), 0);
});

// ---------------------------------------------------------------- 黑边判据

test('barFraction：上下连续黑边按占比返回，超过 BAR_CAP 视为整段黑场不补偿', () => {
  const h = 36;
  const sums = new Float32Array(h);
  const maxes = new Float32Array(h);
  // 上下各 4 行纯黑，其余行是亮的
  for (let y = 0; y < h; y += 1) {
    const dark = y < 4 || y >= h - 4;
    sums[y] = dark ? 0 : 64 * 200;
    maxes[y] = dark ? 0 : 200;
  }
  assert.equal(barFraction({ rowV: sums, rowVMax: maxes, frames: 1 }), +(8 / h).toFixed(3));
  // 上下各 8 行（16/36 = 0.44 > 0.35）→ 不做补偿
  for (let y = 0; y < h; y += 1) {
    const dark = y < 8 || y >= h - 8;
    sums[y] = dark ? 0 : 64 * 200;
    maxes[y] = dark ? 0 : 200;
  }
  assert.ok(16 / h > BAR_CAP);
  assert.equal(barFraction({ rowV: sums, rowVMax: maxes, frames: 1 }), 0);
});

test('barFraction：只有边缘连续才算黑边，中间一道黑不算', () => {
  const h = 36;
  const sums = new Float32Array(h);
  const maxes = new Float32Array(h);
  for (let y = 0; y < h; y += 1) {
    sums[y] = 64 * 200;
    maxes[y] = 200;
  }
  for (let y = 10; y < 16; y += 1) {
    sums[y] = 0;
    maxes[y] = 0;
  }
  assert.equal(barFraction({ rowV: sums, rowVMax: maxes, frames: 1 }), 0);
  assert.equal(barFraction({}), 0, '缺参数不该抛');
});

// ---------------------------------------------------------------- 打分器接线

test('createScorer：亮场开关前后分数逐位相同', () => {
  const a = frame({ v: 200 });
  const b = frame({ v: 140, blue: 40 });
  const on = createScorer({ width: W, height: H, scoreNormalize: true });
  const off = createScorer({ width: W, height: H, scoreNormalize: false });
  on(a); off(a);
  const rOn = on(b);
  const rOff = off(b);
  assert.ok(rOff.score > 0, '这对帧应该真的在变');
  assert.equal(rOn.score, rOff.score, '亮场必须逐位相同（安全阀）');
  assert.equal(rOn.gain, 1);
  assert.equal(rOn.barFrac, 0);
});

test('createScorer：暗场同一对帧被放大', () => {
  const a = frame({ v: 60 });
  const b = frame({ v: 20, blue: 60 });
  const on = createScorer({ width: W, height: H, scoreNormalize: true });
  const off = createScorer({ width: W, height: H, scoreNormalize: false });
  on(a); off(a);
  const rOn = on(b);
  const rOff = off(b);
  assert.ok(rOn.gain > 1, `暗场 gain 应 >1，实际 ${rOn.gain}`);
  assert.equal(rOn.rawScore, rOff.score, 'rawScore 就是老口径的分数');
  assert.ok(rOn.score > rOff.score, `放大后应更高：on=${rOn.score} off=${rOff.score}`);
});

test('createScorer：黑边要"一直黑"—— 片头黑场不算黑边', () => {
  const scorer = createScorer({ width: W, height: H, scoreNormalize: true });
  const black = Buffer.alloc(W * H * 3);
  scorer(black);
  scorer(black);
  // 画面亮了：所有行都亮过，不该被当成黑边
  const lit = scorer(frame({ v: 200 }));
  assert.equal(lit.barFrac, 0);
  assert.equal(lit.gain, 1);
});

test('createScorer：真的带黑边时 barFrac 稳定，且分数按占比除回来', () => {
  const scorer = createScorer({ width: W, height: H, scoreNormalize: true });
  for (let i = 0; i < 3; i += 1) scorer(frame({ v: 200, bar: 4 }));
  const r = scorer(frame({ v: 150, bar: 4, blue: 50 }));
  assert.equal(r.barFrac, +(8 / H).toFixed(3));
  const expect = (r.rawScore * r.gain) / (1 - r.barFrac);
  assert.ok(Math.abs(r.score - expect) < 1e-6, `score=${r.score} expect=${expect}`);
});

// ---------------------------------------------------------------- 开关接线

test('开关默认开，且能从 tuning 关掉', () => {
  assert.equal(DEFAULTS.scoreNormalize, true, 'pipeline 默认必须是开');
  const env = { DSH_HOME: '/nonexistent-see-now-test' };
  assert.equal(readTuning({ env }).scoreNormalize, true, '没配过 = 默认开');
  const off = readTuning({ env, readFile: () => JSON.stringify({ scoreNormalize: false }) });
  assert.equal(off.scoreNormalize, false);
  assert.deepEqual(off.warnings, []);
  // `"false"` 是真值 —— 这种写法必须报出来，不能悄悄当"开"
  const bad = readTuning({ env, readFile: () => JSON.stringify({ scoreNormalize: 'false' }) });
  assert.equal(bad.scoreNormalize, true);
  assert.ok(bad.warnings.some((w) => w.includes('scoreNormalize')));
});

test('createScorer：黑边不吃进 meanV —— 否则 gain 和 /(1-bar) 重复补偿', () => {
  // 同一张亮画面，一帧无黑边、一帧上下各 8 行黑边。有效行的亮度一样，
  // 所以 meanV 必须基本相同（差 < 10）；修之前全帧平均会把 200 拉成 111，
  // gain 跟着从 1 涨到 1.85，再乘上 /(1-bar) —— 实测 letterbox 素材因此放大到 2.2 倍。
  const plain = createScorer({ width: W, height: H, scoreNormalize: true })(frame({ v: 80 }));
  const boxed = createScorer({ width: W, height: H, scoreNormalize: true })(frame({ v: 80, bar: 4 }));
  assert.ok(boxed.barFrac > 0, `黑边没认出来（barFrac=${boxed.barFrac}）`);
  assert.ok(Math.abs(boxed.meanV - plain.meanV) < 10,
    `带黑边的 meanV=${boxed.meanV.toFixed(1)}，无黑边 ${plain.meanV.toFixed(1)} —— 黑边被算进亮度了`);
});
