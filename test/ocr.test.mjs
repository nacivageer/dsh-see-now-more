/**
 * ocr.test.mjs — 数字识别这一路（Python sidecar 协议 + 简报口径）。
 *
 * 这条测试**依赖真实的 winrt + Windows OCR**（这台机器上装了）：它验的是
 * 「帧从 Node 写进 stdin、JSON 一行回来、数字对得上」这条链，而不是某个 mock。
 * 没有 winrt 的机器上整组跳过 —— 那是环境缺依赖，不是代码坏了
 * （`status` 会写「OCR 不可用」，别把跳过当通过）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bloodbarBrief, pushTrack } from '../src/bloodbar.js';
import { resolveOcrPython, startOcr } from '../src/ocr.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'bloodbar-2798x17638.bgra');
const W = 421;
const H = 16;

const probe = resolveOcrPython();
const skip = probe.ok ? false : `没有能 import winrt 的 Python（${probe.reason}）`;

test('ocr：sidecar 真跑一帧，认出血条数字', { skip }, async () => {
  const frame = readFileSync(FIXTURE);
  assert.equal(frame.length, W * H * 4, 'fixture 必须是 421×16 的 BGRA');

  const o = startOcr({ w: W, h: H, python: probe.python });
  try {
    const out = await o.recognize(frame);
    assert.equal(out.cur, 2798);
    assert.equal(out.max, 17638);
    assert.match(out.text, /2798/);
    assert.ok(out.ms >= 0);
  } finally {
    o.stop();
    await o.done.catch(() => {});
  }
});

test('ocr：帧不够长直接拒，不许拿半帧去认', { skip }, async () => {
  const o = startOcr({ w: W, h: H, python: probe.python });
  try {
    await assert.rejects(() => o.recognize(Buffer.alloc(100)), /帧太小/);
  } finally {
    o.stop();
    await o.done.catch(() => {});
  }
});

test('ocr 数字进简报：同一帧的比例与数字不会错位', () => {
  const now = 1_000_000;
  const reading = { ok: true, ratio: 0.15, at: now, cur: 2798, max: 17638 };
  const brief = bloodbarBrief({ track: pushTrack([], reading), threshold: 0.3, now });
  assert.match(brief.text, /2798\/17638/);
  assert.equal(brief.ratio, 2798 / 17638);
});
