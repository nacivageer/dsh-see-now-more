/**
 * lift-timeline.test.mjs — 黑听抬头编排的「时间线」测试（模块化第 2 步）。
 *
 * 用假时钟 + 假端口驱动 `createLift`，按事件表走一遍四档、蓄水池、回落、退避。
 * 不设 `DSH_HOME`、不需要 ffmpeg / python / 窗口 —— 这正是把编排搬出 `startLoop`
 * 的目的：以前这段只能启动整个循环才跑得到，现在纯函数级可测。
 *
 * 断言的是**行为**（记了什么、取没取帧、叫没叫醒、档位落在哪），不锁内部实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLift } from '../src/lift/index.js';

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

/**
 * 一套最小端口。所有外部动作都收进数组，测试结尾直接数次数。
 *
 * @param {{config?: object, state?: object}} [opts]
 */
function makeHarness(opts = {}) {
  let clock = T0;
  const recs = [];
  const debugs = [];
  const glances = [];
  const wakes = [];
  const pngCalls = [];
  const gateCalls = { noteWake: 0, noteNoAnswer: 0 };

  const state = {
    lines: [],
    still: { ok: true, still: true },
    canWake: true,
    wakeOk: true,
    turnEndAt: 0,
    lastUserSpokeAt: 0,
    png: null,
    ...(opts.state ?? {}),
  };

  const lift = createLift({
    config: { enabled: true, level: 'glance', holdSec: 15, ...(opts.config ?? {}) },
    now: () => clock,
    senses: {
      recentLines: () => state.lines,
      frameAt: () => ({ ok: true }),
      framePng: (t0) => {
        pngCalls.push(t0);
        return state.png ?? { ok: true, at: t0, path: 'f.png', deltaMs: 120 };
      },
      still: () => state.still,
      turnEndAt: () => state.turnEndAt,
      lastUserSpokeAt: () => state.lastUserSpokeAt,
    },
    sinks: {
      record: (r) => recs.push(r),
      debug: (s) => debugs.push(s),
      glance: (s) => glances.push(s),
      wake: async (text) => { wakes.push(text); return state.wakeOk; },
      hint: () => '',
      log: () => {},
    },
    gate: {
      canWake: () => state.canWake,
      noteWake: () => { gateCalls.noteWake += 1; },
      noteNoAnswer: () => { gateCalls.noteNoAnswer += 1; },
    },
  });

  return {
    lift,
    state,
    recs,
    debugs,
    glances,
    wakes,
    pngCalls,
    gateCalls,
    tick: () => lift.tick(),
    advance: (ms) => { clock += ms; },
  };
}

/** 造一句定稿台词（`partial:false` 才认定稿）。 */
function line(t0, text) {
  return { t0, t1: t0 + 1200, text, partial: false };
}

test('弱命中 + 无对话 → 警觉：只记账，不取帧、不叫醒、不进窗', async () => {
  const h = makeHarness();
  h.state.lines = [line(T0, '诶诶')];

  await h.tick();

  assert.equal(h.recs.length, 1);
  assert.equal(h.recs[0].level, 'alarm');
  assert.equal(h.recs[0].trigger, 'weak');
  assert.equal(h.recs[0].frameAt, null);
  assert.equal(h.recs[0].spoke, false);
  assert.equal(h.pngCalls.length, 0);
  assert.equal(h.glances.length, 0);
  assert.equal(h.wakes.length, 0);
  assert.deepEqual(h.lift.status(), { level: null, base: 'glance', alarms: 1, holdingSince: null });
});

test('强命中 + 无对话 → 瞥：取一帧、落窗内 meta，不叫醒', async () => {
  const h = makeHarness();
  h.state.lines = [line(T0, '你看这个')];

  await h.tick();

  assert.equal(h.recs.length, 1);
  assert.equal(h.recs[0].level, 'glance');
  assert.equal(h.recs[0].trigger, 'word');
  assert.equal(h.recs[0].frameAt, T0);
  assert.equal(h.recs[0].spoke, false);
  assert.equal(h.pngCalls.length, 1);
  assert.equal(h.glances.length, 1);
  assert.match(h.glances[0], /瞥了一眼/);
  assert.equal(h.wakes.length, 0);
  assert.equal(h.lift.status().level, null);
});

test('强命中 + 最近有对话 → 看：叫醒一次，record 记 spoke:true，档位变 look', async () => {
  const h = makeHarness();
  h.state.lastUserSpokeAt = T0 - 60_000;
  h.state.lines = [line(T0, '你看这个')];

  await h.tick();

  assert.equal(h.recs.length, 1);
  assert.equal(h.recs[0].level, 'look');
  assert.equal(h.recs[0].trigger, 'dialog');
  assert.equal(h.recs[0].spoke, true);
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0], /最近十分钟的台词/);
  assert.equal(h.gateCalls.noteWake, 1);
  assert.deepEqual(h.lift.status(), { level: 'look', base: 'glance', alarms: 0, holdingSince: T0 });
});

test('5 分钟内第 3 次警觉 → 升一次瞥（trigger:"pool"）', async () => {
  const h = makeHarness();
  const texts = ['诶', '欸', '哎'];

  for (let i = 0; i < texts.length; i += 1) {
    h.state.lines = [line(T0 + i * 1000, texts[i])];
    await h.tick();
  }

  assert.deepEqual(h.recs.map((r) => r.level), ['alarm', 'alarm', 'glance']);
  assert.deepEqual(h.recs.map((r) => r.trigger), ['weak', 'weak', 'pool']);
  assert.equal(h.pngCalls.length, 1, '只有升档那一次取帧');
  assert.equal(h.wakes.length, 0);
});

test('holdSec 到点且画面不动 → 回落到警觉，档位清空', async () => {
  const h = makeHarness();
  h.state.lastUserSpokeAt = T0 - 1000;
  h.state.lines = [line(T0, '你看这个')];
  await h.tick();
  assert.equal(h.lift.status().level, 'look');

  h.advance(16_000);
  h.state.lines = [];
  await h.tick();

  const last = h.recs.at(-1);
  assert.equal(last.level, 'alarm');
  assert.equal(last.trigger, 'hold');
  assert.equal(last.spoke, false);
  assert.equal(h.lift.status().level, null);
  assert.equal(h.lift.status().holdingSince, null);
});

test('同一 t0 被重复扫描 → 只记一次', async () => {
  const h = makeHarness();
  h.state.lines = [line(T0, '你看这个')];

  await h.tick();
  await h.tick();

  assert.equal(h.recs.length, 1);
  assert.equal(h.pngCalls.length, 1);
});

test('gate.canWake=false → 「看」这一拍不叫醒、不记账、不增退避计数', async () => {
  const h = makeHarness();
  h.state.lastUserSpokeAt = T0 - 60_000;
  h.state.canWake = false;
  h.state.lines = [line(T0, '你看这个')];

  await h.tick();

  assert.equal(h.wakes.length, 0);
  assert.equal(h.recs.length, 0);
  assert.equal(h.gateCalls.noteWake, 0);
  assert.equal(h.gateCalls.noteNoAnswer, 0);
  assert.equal(h.lift.status().level, null);
});

test('framePng 失败 → record 带原因、frameAt 为 null，不拿当前帧顶', async () => {
  const h = makeHarness();
  h.state.png = { ok: false, reason: 'too-old' };
  h.state.lines = [line(T0, '你看这个')];

  await h.tick();

  assert.equal(h.recs.length, 1);
  assert.equal(h.recs[0].frameAt, null);
  assert.match(h.recs[0].reason, /帧没取到：too-old/);
  assert.equal(h.wakes.length, 0);
});

test('enabled:false → tick 什么都不做', async () => {
  const h = makeHarness({ config: { enabled: false } });
  h.state.lines = [line(T0, '你看这个')];

  await h.tick();

  assert.equal(h.recs.length, 0);
  assert.equal(h.pngCalls.length, 0);
  assert.equal(h.wakes.length, 0);
});

test('没有命中整句 → 记 lift-miss，不进池、不取帧', async () => {
  const h = makeHarness();
  h.state.lines = [line(T0, '外面开始下雨了')];

  await h.tick();

  assert.equal(h.recs.length, 0);
  assert.equal(h.pngCalls.length, 0);
  assert.ok(h.debugs.some((s) => s.startsWith('lift-miss')), h.debugs.join('\n'));
});
