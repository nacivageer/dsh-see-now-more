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
  ratioFromRgba, ratioFromRgb, ratioFromPixels,
  loadBloodbar, saveBloodbar, clearBloodbar, bloodbarLine, bloodbarText,
  shouldGlance, DEFAULT_THRESHOLD, DEFAULT_GLANCE_COOLDOWN_MS,
  pushTrack, bloodbarBrief,
} from '../src/bloodbar.js';
import { readBloodbarOnce } from '../src/bloodbar-capture.js';

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
    '血条：框 1,2,3,4（阈值 30%）· 未采（调 `read:true` 读一次）',
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

test('RGB24 版本（采集链路）：半白半黑 → 0.5；彩色不认', () => {
  const rgb = new Uint8Array(10 * 4 * 3);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const o = (y * 10 + x) * 3;
      const v = x < 5 ? 255 : 30;
      rgb[o] = v; rgb[o + 1] = v; rgb[o + 2] = v;
    }
  }
  const half = ratioFromRgb(rgb, { width: 10, height: 4 });
  assert.equal(half.ok, true);
  assert.equal(half.ratio, 0.5);

  const red = new Uint8Array(4 * 2 * 3);
  for (let i = 0; i < 4 * 2; i += 1) { red[i * 3] = 255; }
  assert.equal(ratioFromRgb(red, { width: 4, height: 2 }).reason, 'gone');
});

test('通道数只认 3/4；其他一律 bad-frame', () => {
  const px = new Uint8Array(4 * 4 * 3).fill(255);
  assert.equal(ratioFromPixels(px, { width: 4, height: 4, channels: 2 }).reason, 'bad-frame');
  assert.equal(ratioFromPixels(px, { width: 4, height: 4, channels: 3 }).ok, true);
});

test('band 模式：上下暗边被剔除，只按亮行带里填了几列算', () => {
  // 40×20 的框：血条只占中间 10 行（y5..14），左半填充；上下 5 行是暗边。
  const f = frame(40, 20, (x, y) => (y >= 5 && y < 15 && x < 20 ? [255, 255, 255] : [30, 30, 30]));
  const full = ratioFromRgba(f, { width: 40, height: 20 });
  const band = ratioFromRgba(f, { width: 40, height: 20, mode: 'band' });
  assert.equal(full.ratio, 0.25, '全框占比被暗边稀释');
  assert.equal(band.ok, true);
  assert.equal(band.ratio, 0.5, '行带内左半填充');
  assert.deepEqual(band.band, { top: 5, bottom: 14, left: 0, right: 19 });
});

test('band 模式：数字在中间不影响左右端点', () => {
  // 满血白条带，中间 8 列被数字压掉下半（每列 50% 亮）——端点法仍判满。
  const f = frame(40, 20, (x, y) => {
    const inBand = y >= 5 && y < 15;
    if (!inBand) return [30, 30, 30];
    if (x >= 16 && x < 24 && y >= 10) return [20, 20, 20];
    return [255, 255, 255];
  });
  const band = ratioFromRgba(f, { width: 40, height: 20, mode: 'band' });
  assert.equal(band.ratio, 1, '数字列不碰左右端点，仍算满血');
});

test('band 模式：全暗 / 彩色 → gone', () => {
  const dark = frame(40, 20, () => [20, 20, 20]);
  assert.equal(ratioFromRgba(dark, { width: 40, height: 20, mode: 'band' }).reason, 'gone');
  const red = frame(40, 20, () => [255, 0, 0]);
  assert.equal(ratioFromRgba(red, { width: 40, height: 20, mode: 'band' }).reason, 'gone');
});

test('readBloodbarOnce：没框直接拒，不启动 ffmpeg', async () => {
  assert.equal((await readBloodbarOnce({})).reason, 'no-region');
  assert.equal((await readBloodbarOnce({ region: { x: 0, y: 0, w: 0, h: 0 } })).reason, 'no-region');
});

test('shouldGlance：够低 + 出冷却才记；不可见/满血/冷却中都不记', () => {
  const low = { ok: true, below: true, ratio: 0.2 };
  assert.equal(shouldGlance({ reading: low, now: 1_000_000, lastGlanceAt: 0 }), true);
  assert.equal(shouldGlance({ reading: low, now: 1_000_000, lastGlanceAt: 1_000_000 - 1000 }), false);
  assert.equal(
    shouldGlance({ reading: low, now: 1_000_000, lastGlanceAt: 1_000_000 - DEFAULT_GLANCE_COOLDOWN_MS }),
    true,
  );
  assert.equal(shouldGlance({ reading: { ok: true, below: false, ratio: 0.8 }, now: 1_000_000 }), false);
  assert.equal(shouldGlance({ reading: { ok: false, reason: 'gone', ratio: 0 }, now: 1_000_000 }), false);
  assert.equal(shouldGlance({ reading: null, now: 1_000_000 }), false);
});

/* ---------------------------------------------- P2：读数简报（只报告，不唤） */

test('pushTrack：只收真读数，不去改入参，过期滑走', () => {
  const t0 = [{ at: 1_000, ratio: 0.5 }];
  const t1 = pushTrack(t0, { ok: true, ratio: 0.4, at: 1_200 });
  assert.equal(t0.length, 1, '入参不能被改');
  assert.equal(t1.length, 2);
  assert.deepEqual(t1[1], { at: 1_200, ratio: 0.4 });

  // 框里没有血条（gone）不是「0 血」，不能进轨迹
  assert.equal(pushTrack(t0, { ok: false, reason: 'gone', at: 2_000 }).length, 1);
  assert.equal(pushTrack(t0, { ok: true, ratio: 0.4 }).length, 1, '没有 at 的读数不收');
  assert.equal(pushTrack([], { ok: false, at: 1 }).length, 0);

  // 3 分钟窗口：新的一条来了，老的全滑走
  const t2 = pushTrack(t1, { ok: true, ratio: 0.3, at: 1_200 + 180_001 }, { keepMs: 180_000 });
  assert.deepEqual(t2, [{ at: 181_201, ratio: 0.3 }]);
});

test('bloodbarBrief：没读数就返回 null —— 不编「血条正常」', () => {
  assert.equal(bloodbarBrief({ track: [] }), null);
  assert.equal(bloodbarBrief({}), null);
  assert.equal(bloodbarBrief({ track: [{ at: NaN, ratio: 0.5 }] }), null);
});

test('bloodbarBrief：正常血条 → 带阈值，不标「低于」', () => {
  const now = 1_000_000;
  const b = bloodbarBrief({ track: [{ at: now - 40_000, ratio: 0.9 }, { at: now, ratio: 0.92 }], threshold: 0.3, now });
  assert.equal(b.below, false);
  assert.equal(b.ratio, 0.92);
  assert.match(b.text, /^血条 92%（阈值 30%）/);
});

test('bloodbarBrief：低血 → 标出「低于阈值」，并给 30 秒前与近 60 秒区间', () => {
  const now = 1_000_000;
  const track = [
    { at: now - 70_000, ratio: 0.95 },
    { at: now - 60_000, ratio: 0.8 },
    { at: now - 30_000, ratio: 0.7 },
    { at: now, ratio: 0.64 },
  ];
  const b = bloodbarBrief({ track, threshold: 0.7, now, lastBelowAt: now });
  assert.equal(b.below, true);
  assert.match(b.text, /^血条 64%（低于阈值 70%）/);
  assert.match(b.text, /30 秒前 70%/);
  assert.match(b.text, /近 60 秒 64%–80%/);
  assert.match(b.text, /上次低血 \d{2}:\d{2}:\d{2}/);
});

test('bloodbarBrief：读数旧了要说清楚 —— 免得把十分钟前的 64% 当成现在', () => {
  const now = 1_000_000;
  const b = bloodbarBrief({ track: [{ at: now - 42_000, ratio: 0.64 }], now });
  assert.match(b.text, /42 秒前的读数/);
  // 新鲜的读数不加这句
  const fresh = bloodbarBrief({ track: [{ at: now - 2_000, ratio: 0.64 }], now });
  assert.doesNotMatch(fresh.text, /秒前的读数/);
});

test('bloodbarLine：带上「上次低血」时刻', () => {
  const cfg = { region: { x: 1, y: 2, w: 3, h: 4 }, threshold: 0.3 };
  const at = new Date(2026, 10, 15, 12, 28, 31).getTime();
  const line = bloodbarLine(cfg, { ok: true, ratio: 0.64, below: true }, { lastBelowAt: at });
  assert.match(line, /最近 64%（低于阈值）/);
  assert.match(line, /上次低血 12:28:31/);
  // 没传 → 不出现（旧行为不变）
  assert.doesNotMatch(bloodbarLine(cfg, { ok: true, ratio: 0.64, below: false }), /上次低血/);
});
