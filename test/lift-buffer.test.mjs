/**
 * 留底缓冲（P2-A）的单元测试。
 *
 * 守的是「按 t0 取帧」的可信度：窗口边界、取帧容差、内存上限、时间戳单调。
 * 这几条错一条，「瞥」就会拿错帧、拿旧帧冒充现在，或者把内存吃穿 ——
 * 这三种都**不会在界面上显形**，只能靠测试拦住。
 *
 * 帧用 8×4（96 字节）的小尺寸：逻辑和 800×450 完全一样，没必要每条用例真塞 1 MB。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiftBuffer, frameBytes, LIFT_FPS } from '../src/lift-buffer.js';

const W = 8;
const H = 4;
const FRAME = frameBytes(W, H);
const T0 = 1_760_000_000_000;

const mk = (opts = {}) => createLiftBuffer({ width: W, height: H, ...opts });
const frame = (fill = 1) => Buffer.alloc(FRAME, fill);

test('空缓冲：stats 归零，取帧报 empty', () => {
  const b = mk();
  const st = b.stats();
  assert.equal(st.frames, 0);
  assert.equal(st.bytes, 0);
  assert.equal(st.mb, 0);
  assert.equal(st.pushed, 0);
  assert.equal(st.oldestAt, null);
  assert.deepEqual(b.pickAt(T0), { ok: false, reason: 'empty' });
  // 非法时间戳也归 empty，不许把 NaN 带进二分
  assert.deepEqual(b.pickAt('nope'), { ok: false, reason: 'empty' });
});

test('默认参数：0.5 fps / 30 秒窗 / 800×450', () => {
  const st = createLiftBuffer().stats();
  assert.equal(st.fps, LIFT_FPS);
  assert.equal(st.windowSec, 30);
  assert.deepEqual([st.width, st.height], [800, 450]);
});

test('15 帧（30 秒 × 0.5 fps）的账算得对', () => {
  const b = mk();
  for (let i = 0; i < 15; i += 1) assert.equal(b.push({ buf: frame(i), at: T0 + i * 2000 }), true);
  const st = b.stats();
  assert.equal(st.frames, 15);
  assert.equal(st.bytes, 15 * FRAME);
  assert.equal(st.spanSec, 28);          // 0 → 28 秒
  assert.equal(st.pushed, 15);
});

test('窗口：超过 30 秒的整段丢掉，只留窗口内那一段', () => {
  const b = mk();
  for (let i = 0; i < 40; i += 1) b.push({ buf: frame(i), at: T0 + i * 2000 });
  const st = b.stats();
  // 最新一帧在 78 秒；窗口 30 秒 → 留 48…78 秒，共 16 帧
  assert.equal(st.frames, 16);
  assert.equal(st.spanSec, 30);
  assert.equal(st.oldestAt, T0 + 48_000);
  assert.equal(st.newestAt, T0 + 78_000);
});

test('精确命中：delta 0，拿到的是那一帧本身', () => {
  const b = mk();
  b.push({ buf: frame(1), at: T0 });
  b.push({ buf: frame(2), at: T0 + 2000 });
  const r = b.pickAt(T0 + 2000);
  assert.equal(r.ok, true);
  assert.equal(r.deltaMs, 0);
  assert.equal(r.frame.buf[0], 2);
  assert.equal(r.frame.i, null);
});

test('两帧正中间：取较早那帧，delta 正好 ±1 秒（0.5 fps 的下界）', () => {
  const b = mk();
  b.push({ buf: frame(1), at: T0 });
  b.push({ buf: frame(2), at: T0 + 2000 });
  const r = b.pickAt(T0 + 1000);
  assert.equal(r.ok, true);
  assert.equal(r.deltaMs, -1000);
  assert.equal(r.frame.buf[0], 1);
});

test('太旧：那句话早于窗口起点要明确报 too-old（不许拿当前帧顶）', () => {
  const b = mk();
  b.push({ buf: frame(1), at: T0 });
  b.push({ buf: frame(2), at: T0 + 2000 });
  const r = b.pickAt(T0 - 10_000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-old');
  assert.equal(r.ageSec, 10);
});

test('太新：那个时刻比最新一帧还晚太多，报 too-new', () => {
  const b = mk();
  b.push({ buf: frame(1), at: T0 });
  b.push({ buf: frame(2), at: T0 + 2000 });
  const r = b.pickAt(T0 + 2000 + 10_000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-new');
  assert.equal(r.ageSec, 10);
});

test('窗口内但离得太远：传 maxDeltaMs 时能把它判成 far', () => {
  const b = mk();
  b.push({ buf: frame(1), at: T0 });
  b.push({ buf: frame(2), at: T0 + 2000 });
  const r = b.pickAt(T0 + 1000, { maxDeltaMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'far');
  assert.equal(Math.abs(r.deltaMs), 1000);
});

test('默认容差 1.5 秒：半帧距（1 秒）以内的都算「有那一刻」', () => {
  const b = mk();
  b.push({ buf: frame(1), at: T0 });
  b.push({ buf: frame(2), at: T0 + 2000 });
  assert.equal(b.pickAt(T0 + 1000).ok, true);
  // 再往外 0.6 秒就超出窗口边缘了（半帧距之外）
  assert.equal(b.pickAt(T0 + 2000 + 1600).reason, 'too-new');
});

test('坏帧不进账：长度不够 / 不是 Buffer 都拒收', () => {
  const b = mk();
  assert.equal(b.push({ buf: Buffer.alloc(FRAME - 1) }), false);
  assert.equal(b.push({ buf: 'rgb' }), false);
  assert.equal(b.push({}), false);
  assert.equal(b.stats().frames, 0);
});

test('只留这一帧自己的字节：socket chunk 的视图不会被整块钉住', () => {
  const b = mk();
  const big = Buffer.alloc(FRAME * 3, 9);
  b.push({ buf: big, at: T0 });
  assert.equal(b.stats().bytes, FRAME);
});

test('时间戳回退时夹住，数组永远按 at 升序（二分不能假定乱序）', () => {
  const b = mk();
  b.push({ buf: frame(1), at: T0 });
  b.push({ buf: frame(2), at: T0 - 5000 });
  const st = b.stats();
  assert.equal(st.frames, 2);
  assert.equal(st.newestAt, T0, '回退的时间戳被夹成最新那一帧的时刻');
  assert.equal(st.oldestAt, T0);
  // 之后正常的一帧仍然按序落进来，取帧不受影响
  b.push({ buf: frame(3), at: T0 + 2000 });
  assert.equal(b.stats().frames, 3);
  assert.equal(b.pickAt(T0 + 2000).frame.buf[0], 3);
});

test('内存上限：maxBytes 到了就丢最旧的，绝不无界增长', () => {
  const b = mk({ maxBytes: FRAME * 2 });
  for (let i = 0; i < 10; i += 1) b.push({ buf: frame(i), at: T0 + i * 2000 });
  const st = b.stats();
  assert.equal(st.frames, 2);
  assert.equal(st.bytes, FRAME * 2);
  assert.equal(st.newestAt, T0 + 18_000);
});

test('stale：最后一帧超过三个帧距就标出来（采集断了但帧还在）', () => {
  let now = T0 + 5000;
  const b = mk({ now: () => now });
  b.push({ buf: frame(1), at: T0 });
  assert.equal(b.stats().stale, false);
  now = T0 + 7000;
  assert.equal(b.stats().stale, true);
  assert.equal(b.stats().ageSec, 7);
});

test('clear：帧、字节、计数一起归零，取帧回到 empty', () => {
  const b = mk();
  for (let i = 0; i < 5; i += 1) b.push({ buf: frame(i), at: T0 + i * 2000 });
  b.clear();
  const st = b.stats();
  assert.equal(st.frames, 0);
  assert.equal(st.bytes, 0);
  assert.equal(st.pushed, 0);
  assert.deepEqual(b.pickAt(T0), { ok: false, reason: 'empty' });
});
