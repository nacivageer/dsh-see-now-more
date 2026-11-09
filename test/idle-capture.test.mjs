/**
 * idle.js 的判据单测（2026-11-09 S1）。
 *
 * 只测"该不该收工"这一条判定 —— 真起 ffmpeg 去等 5 分钟不适合放进单测，
 * 那条路走真机（见本文件后续用例的实测记录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldIdleStop } from '../src/idle.js';

const LIMIT = 5 * 60_000;

test('没在采集：不收工（免得空转判定停掉别人的采集）', () => {
  assert.equal(shouldIdleStop({ running: false, idleMs: LIMIT * 10, limitMs: LIMIT }), false);
});

test('限值为 0 / 负数 / 缺失：这条线是关掉的', () => {
  for (const limitMs of [0, -1, undefined, null]) {
    assert.equal(shouldIdleStop({ running: true, idleMs: LIMIT * 10, limitMs }), false,
      `limitMs=${limitMs}`);
  }
});

test('常驻循环在跑：交给循环自己那条收工线，不双重管理', () => {
  assert.equal(shouldIdleStop({
    running: true, loopActive: true, idleMs: LIMIT * 10, limitMs: LIMIT,
  }), false);
});

test('队列里有没人取走的图：**照样收工**（裸采集的 pending 恒为 1，实测就是这么卡死的）', () => {
  assert.equal(shouldIdleStop({
    running: true, pending: 1, idleMs: LIMIT * 10, limitMs: LIMIT,
  }), true);
});

test('watch 正阻塞在等图：不能收工（那一轮就白等了）', () => {
  assert.equal(shouldIdleStop({
    running: true, watching: true, idleMs: LIMIT * 10, limitMs: LIMIT,
  }), false);
});

test('刚好到阈值就收工；差一秒都不收', () => {
  assert.equal(shouldIdleStop({ running: true, idleMs: LIMIT - 1, limitMs: LIMIT }), false);
  assert.equal(shouldIdleStop({ running: true, idleMs: LIMIT, limitMs: LIMIT }), true);
  assert.equal(shouldIdleStop({ running: true, idleMs: LIMIT + 1, limitMs: LIMIT }), true);
});

test('两种占用同时成立时，任意一个都能挡住收工', () => {
  const idle = LIMIT * 2;
  assert.equal(shouldIdleStop({ running: true, watching: true, idleMs: idle, limitMs: LIMIT }), false);
  assert.equal(shouldIdleStop({ running: true, loopActive: true, idleMs: idle, limitMs: LIMIT }), false);
  // 全都放手了才收
  assert.equal(shouldIdleStop({ running: true, idleMs: idle, limitMs: LIMIT }), true);
});
