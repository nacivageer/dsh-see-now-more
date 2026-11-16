/**
 * capability.test.mjs — 能力状态的固定枚举（下游评估 §1 #4）。
 *
 * 纯函数：每个能力把 `runner.state()` 里已有的子对象翻成一个词 + 原因。
 * 这里穷举每个能力的 ready / degraded / disabled / unavailable / pending / skipped，
 * 并守住一条：词必须在枚举里，原因不许是 `undefined`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_STATES, audioCapability, bloodbarCapability, capability, capabilityLine,
  liftCapability, ocrCapability, visionCapability, windowCapability,
} from '../src/capability.js';

const STATES = new Set(CAPABILITY_STATES);

function check(cap, expected) {
  assert.ok(STATES.has(cap.state), `状态不在枚举里：${cap.state}`);
  assert.equal(cap.state, expected);
  assert.ok(cap.reason === null || (typeof cap.reason === 'string' && cap.reason.length > 0));
  assert.ok(!String(cap.reason).includes('undefined'));
  return cap;
}

test('capability：未知状态直接抛，不静默放过', () => {
  assert.throws(() => capability('ok'), /未知能力状态/);
  assert.deepEqual(capability('ready', '  x  '), { state: 'ready', reason: 'x' });
  assert.deepEqual(capability('disabled'), { state: 'disabled', reason: null });
});

test('vision：没开是 disabled、启动中是 pending、出错/缺帧是 degraded', () => {
  check(visionCapability({ running: false, frames: 0 }), 'disabled');
  check(visionCapability({ running: false, frames: 0, lastError: 'ffmpeg 起不来' }), 'degraded');
  check(visionCapability({ running: true, frames: 0 }), 'pending');
  check(visionCapability({ running: true, frames: 12 }), 'ready');
  check(visionCapability({ running: true, frames: 12, lastError: '写盘失败' }), 'degraded');
});

test('audio：缺服务是 unavailable，没启动是 disabled，暂停/出错是 degraded', () => {
  check(audioCapability({ enabled: false, reason: '没启动' }), 'disabled');
  check(audioCapability({ enabled: false, reason: '没有可用的转写服务' }), 'unavailable');
  check(audioCapability({ enabled: false, reason: '回环设备没打开' }), 'unavailable');
  check(audioCapability({ enabled: true }), 'ready');
  check(audioCapability({ enabled: true, paused: true, reason: '转写连续失败：HTTP 500' }), 'degraded');
  check(audioCapability({ enabled: true, error: '转写超时' }), 'degraded');
});

test('lift：没进仅监听是 disabled，没起采是 pending，stale 是 degraded', () => {
  check(liftCapability({ enabled: false }), 'disabled');
  check(liftCapability({ enabled: true, wanted: false, capturing: false }), 'disabled');
  check(liftCapability({ enabled: true, wanted: true, capturing: false }), 'pending');
  check(liftCapability({ enabled: true, wanted: true, capturing: true, frames: 0 }), 'pending');
  check(liftCapability({ enabled: true, wanted: true, capturing: true, frames: 15, stale: false }), 'ready');
  check(liftCapability({ enabled: true, wanted: true, capturing: true, frames: 15, stale: true }), 'degraded');
  check(liftCapability({ enabled: true, wanted: true, capturing: true, frames: 5, error: 'ffmpeg 退出' }), 'degraded');
});

test('bloodbar：没框/没进仅监听是 disabled，没读数/没起采是 pending，读不到是 degraded', () => {
  check(bloodbarCapability({ enabled: false }), 'disabled');
  check(bloodbarCapability({ enabled: true, wanted: false, capturing: false }), 'disabled');
  check(bloodbarCapability({ enabled: true, wanted: true, capturing: false }), 'pending');
  check(bloodbarCapability({ enabled: true, wanted: true, capturing: true, reading: null }), 'pending');
  check(bloodbarCapability({ enabled: true, wanted: true, capturing: true, reading: { ok: false, reason: '框里没有血条' } }), 'degraded');
  check(bloodbarCapability({ enabled: true, wanted: true, capturing: true, reading: { ok: true, ratio: 0.5 } }), 'ready');
  check(bloodbarCapability({ enabled: true, wanted: true, capturing: true, reading: { ok: true }, error: '采集失败' }), 'degraded');
});

test('ocr：血条没框/没在采是 skipped，缺 winrt 是 unavailable，sidecar 没起是 pending', () => {
  check(ocrCapability({ available: false, ready: false, why: '缺 winrt' }, { bloodbarEnabled: false }), 'skipped');
  check(ocrCapability({ available: false, ready: false, why: '缺 winrt' }, { bloodbarEnabled: true, bloodbarWanted: false }), 'skipped');
  check(ocrCapability({ available: false, ready: false, why: '缺 winrt' }, { bloodbarEnabled: true }), 'unavailable');
  check(ocrCapability({ available: true, ready: false, why: 'OCR 起不来' }, { bloodbarEnabled: true }), 'degraded');
  check(ocrCapability({ available: true, ready: false, why: null }, { bloodbarEnabled: true }), 'pending');
  check(ocrCapability({ available: true, ready: true, why: null }, { bloodbarEnabled: true }), 'ready');
});

test('window：开着是 ready，起不来是 unavailable，没开是 disabled', () => {
  check(windowCapability({ ok: true }), 'ready');
  check(windowCapability({ ok: false, reason: '没有带 tkinter 的 python' }), 'unavailable');
  check(windowCapability({ ok: null }), 'disabled');
  check(windowCapability(null), 'disabled');
});

test('枚举就是这六个词，顺序即文档', () => {
  assert.deepEqual([...CAPABILITY_STATES], ['ready', 'degraded', 'disabled', 'unavailable', 'pending', 'skipped']);
});

test('capabilityLine：ready 不带原因；非 ready 带原因；长原因截断', () => {
  const line = capabilityLine({
    vision: { state: 'ready', reason: null },
    audio: { state: 'degraded', reason: '转写连续失败，暂停中' },
    lift: { state: 'disabled', reason: '只在仅监听时留底' },
    ocr: { state: 'skipped', reason: '血条没框，用不到数字识别' },
    window: { state: 'ready', reason: null },
  });
  assert.match(line, /^视觉 ready/);
  assert.match(line, /听觉 degraded（转写连续失败，暂停中）/);
  assert.match(line, /数字 skipped（血条没框/);
  assert.doesNotMatch(line, /视觉 ready（/);

  assert.equal(capabilityLine(null), '');
  const long = capabilityLine({ vision: { state: 'degraded', reason: 'x'.repeat(100) } }, { maxReason: 10 });
  assert.match(long, /…/);
  assert.ok(long.length < 40, `截断后还太长：${long}`);
});
