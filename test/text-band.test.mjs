/**
 * text-band.test.mjs — 条带几何 / 像素转换 / 配置校验（P1 第 2 步的纯函数部分）。
 *
 * 几何口径与 `src/pipeline.js` 的 `flushBand()` 一致：改这里就是改那条链的坐标，
 * 所以把 1080p / 4K 的绝对值钉死，别让它漂。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEXT_BAND_DEFAULTS,
  bandFromFrame,
  bandRect,
  cropRgb24,
  normalizeTextConfig,
  rgb24ToBgra,
  sidecarSizeOf,
  textStatusLine,
  tidyOcrLine,
} from '../src/text-band.js';

test('bandRect：1080p / 1440p / 4K 的底部 20%、左右各让 10%', () => {
  assert.deepEqual(bandRect(1920, 1080), { x: 192, y: 864, w: 1536, h: 216 });
  assert.deepEqual(bandRect(2560, 1440), { x: 256, y: 1152, w: 2048, h: 288 });
  assert.deepEqual(bandRect(3840, 2160), { x: 384, y: 1728, w: 3072, h: 432 });
});

test('bandRect：窄条也给下限（16 宽 / 8 高），不让 OCR 卡在 1 像素上', () => {
  const r = bandRect(40, 40, [0.9, 1, 0.10]);
  assert.ok(r.w >= 16);
  assert.ok(r.h >= 8);
  // 写坏的 band 退回默认，不抛
  assert.deepEqual(bandRect(1920, 1080, null), bandRect(1920, 1080));
});

test('cropRgb24：裁出来的像素与坐标对得上', () => {
  const W = 8;
  const H = 6;
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = x;
      buf[i + 1] = y;
      buf[i + 2] = 7;
    }
  }
  const out = cropRgb24(buf, W, H, { x: 2, y: 1, w: 3, h: 2 });
  assert.equal(out.length, 3 * 2 * 3);
  assert.deepEqual([...out.slice(0, 3)], [2, 1, 7]);      // 原图 (2,1)
  assert.deepEqual([...out.slice(3, 6)], [3, 1, 7]);      // 原图 (3,1)
  assert.deepEqual([...out.slice(9, 12)], [2, 2, 7]);     // 第二行 (2,2)
});

test('rgb24ToBgra：通道顺序是 B,G,R,A，且 A 恒 255', () => {
  const bgra = rgb24ToBgra(Buffer.from([10, 20, 30, 40, 50, 60]), 2, 1);
  assert.deepEqual([...bgra], [30, 20, 10, 255, 60, 50, 40, 255]);
});

test('bandFromFrame：尺寸与 bandRect 一致，长度是 w×h×4', () => {
  const buf = Buffer.alloc(1920 * 1080 * 3, 128);
  const b = bandFromFrame(buf, 1920, 1080);
  assert.equal(b.w, 1536);
  assert.equal(b.h, 216);
  assert.equal(b.bgra.length, 1536 * 216 * 4);
  assert.deepEqual(b.rect, bandRect(1920, 1080));
});

test('sidecarSizeOf：画布高默认 = 条带高 × 放大倍数', () => {
  assert.deepEqual(sidecarSizeOf({ ...TEXT_BAND_DEFAULTS }, 1920, 1080), {
    w: 1536, h: 216, scale: 2, canvasH: 432,
  });
  assert.equal(sidecarSizeOf({ ...TEXT_BAND_DEFAULTS, canvasH: 500 }, 1920, 1080).canvasH, 500);
});

test('normalizeTextConfig：默认值 / 写坏的值退回默认并记一条 warn', () => {
  const d = normalizeTextConfig(undefined);
  assert.equal(d.warnings.length, 0);
  assert.deepEqual(d.config.band, [0.8, 1, 0.1]);
  assert.equal(d.config.fps, 1);
  assert.equal(d.config.enabled, true);

  const bad = normalizeTextConfig({
    enabled: 'false',                       // 字符串不是布尔
    band: [0.9],                            // 太短
    fps: 99,
    scale: 9,
  });
  assert.equal(bad.config.enabled, true);
  assert.deepEqual(bad.config.band, [0.8, 1, 0.1]);
  assert.equal(bad.config.fps, 1);
  assert.equal(bad.config.scale, 2);
  assert.equal(bad.warnings.length, 4);

  const ok = normalizeTextConfig({ band: [0.66, 1], fps: 2, scale: 3, lang: 'ja-JP', minChars: 3 });
  assert.deepEqual(ok.config.band, [0.66, 1, 0]);
  assert.equal(ok.config.fps, 2);
  assert.equal(ok.config.scale, 3);
  assert.equal(ok.config.lang, 'ja-JP');
  assert.equal(ok.config.minChars, 3);
});

test('tidyOcrLine：中文之间的空格去掉，拉丁词之间的留着', () => {
  // 真机原文（2026-11-27，band-test.mp4 一帧）
  assert.equal(tidyOcrLine('我 们 得 先 回 去 ， 这 里 不 安 全 。'), '我们得先回去，这里不安全。');
  assert.equal(tidyOcrLine('Hello World'), 'Hello World');
  assert.equal(tidyOcrLine('用 Python 写 的'), '用Python写的');
  assert.equal(tidyOcrLine('  多余的   空白  '), '多余的空白');
  assert.equal(tidyOcrLine(''), '');
  assert.equal(tidyOcrLine(null), '');
});

test('textStatusLine：四个数都在，OCR 不可用时写原因', () => {
  const line = textStatusLine({
    enabled: true,
    band: [0.8, 1, 0.1],
    fps: 1,
    scale: 2,
    sampled: 12,
    ocr: { available: true, why: null },
    stats: { lines: 7, blocked: 1, unconfirmed: 3, deduped: 2 },
  });
  assert.match(line, /读数中/);
  assert.match(line, /入流 7 \/ 挡下 1 \/ 未确认 3 \/ 判重 2/);
  assert.match(line, /已送 OCR 12 帧/);

  const off = textStatusLine({
    enabled: true, band: [0.8, 1, 0.1], fps: 1, scale: 2, sampled: 0,
    ocr: { available: false, why: '没有能 import winrt 的 Python' },
    stats: {},
  });
  assert.match(off, /OCR 不可用（没有能 import winrt 的 Python）/);
  assert.match(off, /还没采到帧/);
  assert.match(textStatusLine(null), /没接/);
  assert.match(textStatusLine({ enabled: false }), /关/);
});
