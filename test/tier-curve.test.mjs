/**
 * tier-curve.test.mjs — 档位阈值表（`~/.dsh/see-now.json` 的 `tierCurve`）。
 *
 * 这条线只有四件要紧，其余都是细节：
 *
 *  1. **两套表的形状**：7 道、严格递增；中间五道 `perceptual` 更低（更早进小格子），
 *     两端反而更高（0.333 / 3.333 对 0.26 / 3.0）—— 所以它不是"整体变密"，别拿它当省图开关。
 *  2. **同一个密度，两套表给出不同档位**：这是"换了表真的换了东西"的唯一证据。
 *  3. **认不出的曲线名退回 docx**：包括 `constructor` 这类原型链上的名字（对象取属性会命中的坑）。
 *  4. **配置层**：默认 `docx`、`perceptual` 读得进来、上游第三个值 `custom` 没搬（退回 + warn）、
 *     `status` 那段字只在非默认时出现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVEL_THRESHOLDS, PERCEPTUAL_THRESHOLDS, TIER_CURVE_KEYS, TIER_CURVES,
  createTiers, thresholdsFor, tierCurveNote,
} from '../src/tiers.js';
import { DEFAULTS, createPipeline } from '../src/pipeline.js';
import { TUNING_DEFAULTS, readTuning } from '../src/tuning.js';

const isIncreasing = (arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]);

test('两套表都是 7 道严格递增；中间五道 perceptual 更低、两端更高', () => {
  for (const table of [LEVEL_THRESHOLDS, PERCEPTUAL_THRESHOLDS]) {
    assert.equal(table.length, 7, '七道阈值');
    assert.ok(isIncreasing(table), `必须严格递增：${table.join(', ')}`);
    assert.ok(Object.isFrozen(table), '阈值表要冻结，别让人就地改一行');
  }

  // 端点：perceptual 收在 3.0 秒 / 0.3 秒（帧/秒），旧表是 3.9 / 0.33
  assert.ok(PERCEPTUAL_THRESHOLDS[0] > LEVEL_THRESHOLDS[0],
    `低密度那头更保守：${PERCEPTUAL_THRESHOLDS[0]} 应大于 ${LEVEL_THRESHOLDS[0]}`);
  assert.ok(PERCEPTUAL_THRESHOLDS[6] > LEVEL_THRESHOLDS[6],
    `高档那头也更高：${PERCEPTUAL_THRESHOLDS[6]} 应大于 ${LEVEL_THRESHOLDS[6]}`);
  // 中间五道全是更低 —— 这是"同样的密度更早进小格子"的来源
  for (let i = 1; i <= 5; i += 1) {
    assert.ok(PERCEPTUAL_THRESHOLDS[i] < LEVEL_THRESHOLDS[i],
      `第 ${i + 1} 道应更低：${PERCEPTUAL_THRESHOLDS[i]} < ${LEVEL_THRESHOLDS[i]}`);
  }

  assert.deepEqual([...TIER_CURVE_KEYS], ['docx', 'perceptual']);
  assert.equal(TIER_CURVES.perceptual, PERCEPTUAL_THRESHOLDS);
});

test('thresholdsFor：认得的返回那套表，认不得的一律退回 docx', () => {
  assert.equal(thresholdsFor('docx'), LEVEL_THRESHOLDS);
  assert.equal(thresholdsFor('perceptual'), PERCEPTUAL_THRESHOLDS);
  // `custom` = 上游第三个值，故意没搬；其余是拼错 / 空值 / 原型链上的名字
  for (const bad of ['custom', 'PERCEPTUAL', 'perceptual ', '', undefined, null, 'constructor', 'toString', 123]) {
    assert.equal(thresholdsFor(bad), LEVEL_THRESHOLDS, `${JSON.stringify(bad)} 应退回 docx`);
  }
});

/**
 * 用一串固定间隔的边界把密度喂到 W 秒的窗口里（`smoothFrames: 1` = 不平滑，
 * `hysteresis: 0` = 档位就是阈值的纯函数），取**最后一个 tick** 的档位。
 * 结束时刻落在一次 mark 上，密度才是稳的（见下面两个用例的 W / 间隔）。
 */
function levelFor(thresholds, { fps = 12, dtFrames = 24, markEvery = 2, endSec = 8 } = {}) {
  const tiers = createTiers({ fps, dtFrames, smoothFrames: 1, thresholds, hysteresis: 0 });
  let nextMark = 0;
  const steps = Math.round(fps * endSec);
  for (let i = 0; i <= steps; i += 1) {
    const now = i / fps;
    while (nextMark <= now + 1e-9) {
      tiers.mark(nextMark);
      nextMark += markEvery;
    }
    tiers.tick(now);
  }
  return { level: tiers.levelAt(), density: tiers.density };
}

test('同一个密度，两套表给出不同档位（换表真的换东西）', () => {
  // 中等密度 0.5 帧/秒：docx 第 1 道 0.26 过、0.6 不过；perceptual 0.333 / 0.489 都过
  const docxMid = levelFor(LEVEL_THRESHOLDS);
  const percMid = levelFor(PERCEPTUAL_THRESHOLDS);
  assert.equal(docxMid.density, 0.5);
  assert.equal(percMid.density, 0.5);
  assert.equal(docxMid.level, 2, 'docx：0.5 帧/秒只够第 1 道');
  assert.equal(percMid.level, 3, 'perceptual：0.5 帧/秒够前两道 → 格子更小');

  // 低密度 0.3 帧/秒：docx 已经进 2 档，perceptual 还停在 1 档（端点收在里面）
  const docxLow = levelFor(LEVEL_THRESHOLDS, { dtFrames: 120, markEvery: 10 / 3, endSec: 20 });
  const percLow = levelFor(PERCEPTUAL_THRESHOLDS, { dtFrames: 120, markEvery: 10 / 3, endSec: 20 });
  assert.equal(docxLow.density, 0.3);
  assert.equal(docxLow.level, 2);
  assert.equal(percLow.level, 1, 'perceptual 在低密度那头更保守，不是整体变密');
});

test('配置层：默认 docx，perceptual 读得进来，custom / 拼错退回并 warn', () => {
  const env = { DSH_HOME: '/nonexistent-see-now-test' };
  assert.equal(TUNING_DEFAULTS.tierCurve, 'docx', '配置默认必须是 docx');
  assert.equal(DEFAULTS.tierCurve, 'docx', '管线的默认也必须是 docx');
  assert.equal(readTuning({ env }).tierCurve, 'docx', '没配过 = docx');

  for (const good of ['perceptual', ' perceptual ', 'docx']) {
    const r = readTuning({ env, readFile: () => JSON.stringify({ tierCurve: good }) });
    assert.equal(r.tierCurve, good.trim(), `${good} 应该被认出来`);
    assert.deepEqual(r.warnings, [], `${good} 不该有 warn`);
  }

  // `custom` 是上游第三个值，这一批故意没搬 —— 要报出来，不能悄悄当 docx
  for (const bad of ['custom', 'PERCEPTUAL', '', 123, null]) {
    const r = readTuning({ env, readFile: () => JSON.stringify({ tierCurve: bad }) });
    assert.equal(r.tierCurve, 'docx', `${JSON.stringify(bad)} 应该退回 docx`);
    assert.ok(r.warnings.some((w) => w.includes('tierCurve')), `${JSON.stringify(bad)} 应该有一条 warn`);
  }
});

test('端到端：同一条管线序列，perceptual 的格子真的更小（tierCurve 接到了 createTiers）', () => {
  // 每 0.5 秒整屏换一次颜色 → 密度约 2 帧/秒，正好落在两套表差一档的那条带上。
  // 这条只测**接线**（`createPipeline({tierCurve})` → `thresholdsFor` → `createTiers`），
  // 所以断言方向而不是具体档位；具体档位在 `scripts/sim.mjs` 的真素材 A/B 里看。
  const W = 320;
  const H = 180;
  const COLORS = [[200, 40, 40], [40, 200, 40], [40, 40, 200], [220, 220, 220]];
  const frame = (t) => {
    const rgb = COLORS[Math.floor(t * 2) % COLORS.length];
    const buf = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i += 1) {
      buf[i * 3] = rgb[0];
      buf[i * 3 + 1] = rgb[1];
      buf[i * 3 + 2] = rgb[2];
    }
    return buf;
  };
  const run = (tierCurve) => {
    const p = createPipeline({
      width: W, height: H, fps: 12, audioStrip: false, cutFutureDelay: 0, queueDepth: 0, tierCurve,
    });
    for (let k = 0; k < 12 * 12; k += 1) p.push({ t: k / 12, buf: frame(k / 12) });
    const frames = p.finish().sheets.flatMap((s) => s.frames);
    const tiers = frames.map((f) => f.tier);
    return { tiers, avg: tiers.reduce((a, b) => a + b, 0) / tiers.length };
  };
  const docx = run('docx');
  const perc = run('perceptual');
  assert.equal(perc.tiers.length, docx.tiers.length, '换阈值表只该改格子大小，不该改留几帧');
  assert.ok(perc.avg > docx.avg,
    `perceptual 平均档位应该更高：docx ${docx.avg.toFixed(2)} / perceptual ${perc.avg.toFixed(2)}`);
  assert.ok(perc.tiers.at(-1) > docx.tiers.at(-1),
    `稳态档位应该更高：docx ${docx.tiers.at(-1)} / perceptual ${perc.tiers.at(-1)}`);
});

test('status：默认 docx 不占字，非默认才报曲线名', () => {
  assert.equal(tierCurveNote('docx'), '');
  assert.equal(tierCurveNote(undefined), '');
  assert.equal(tierCurveNote(''), '');
  assert.match(tierCurveNote('perceptual'), /perceptual/);
});
