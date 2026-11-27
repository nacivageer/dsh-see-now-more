/**
 * text-stream.test.mjs — 条带 OCR 的运行时（抽帧节流 / 喂闸门 / 失败姿态）。
 *
 * **不碰真 OCR**：`startOcrFn` 与 `resolveFn` 都是注入的，假引擎按脚本回行。
 * 这台机器现在没装 winrt（真引擎那三条测试因此 skip），所以这一层必须能在没有
 * OCR 的环境里把「起不来怎么办」「慢一帧怎么办」验完。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTextConfig } from '../src/text-band.js';
import { createTextStream } from '../src/text-stream.js';

const CFG = normalizeTextConfig({}).config;
const W = 1920;
const H = 1080;
const FRAME = Buffer.alloc(W * H * 3, 40);

function fakeOcr({ lines = ['你好世界'], delay = 0, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    startOcrFn: (opts) => {
      calls.push(opts);
      return {
        recognize: (frame) => {
          assert.equal(frame.length, 1536 * 216 * 4, '送进 sidecar 的必须是条带尺寸的 BGRA');
          if (fail) return Promise.reject(new Error(fail));
          if (!delay) return Promise.resolve({ lines, text: lines.join(' ') });
          return new Promise((res) => setTimeout(() => res({ lines, text: lines.join(' ') }), delay));
        },
        stop: () => {},
        done: new Promise(() => {}),      // 真进程活着时它永远不 settle
      };
    },
  };
}

const frameAt = (wall) => ({ t: wall / 1000, buf: FRAME, width: W, height: H, wall });

test('抽帧：只要 1 fps，11 帧 100ms 一帧只送 2 次 OCR', async () => {
  const f = fakeOcr();
  const s = createTextStream({ config: CFG, startOcrFn: f.startOcrFn, resolveFn: () => ({ ok: true, python: 'py' }) });
  // 一帧一个宏任务：真实链路上帧是异步到的，上一帧的 Promise 早回来了
  for (let i = 0; i < 11; i += 1) {
    s.onFrame(frameAt(1_000_000 + i * 100));
    await new Promise((r) => setImmediate(r));
  }
  await s.settled();
  assert.equal(s.status().sampled, 2);              // 0 和 1000ms 两次
  assert.equal(f.calls.length, 1);                  // sidecar 只起一次
  assert.equal(f.calls[0].mode, 'text');            // 走文本模式，不是血条那套多极性
  assert.equal(f.calls[0].w, 1536);
  assert.equal(f.calls[0].h, 216);
});

test('喂闸门：同一条字连续两秒 → 入流一条，t0 取第一次看到的时刻', async () => {
  const f = fakeOcr({ lines: ['这是一句字幕'] });
  const s = createTextStream({ config: CFG, startOcrFn: f.startOcrFn, resolveFn: () => ({ ok: true, python: 'py' }) });
  for (let i = 0; i < 3; i += 1) { s.onFrame(frameAt(2_000_000 + i * 1000)); await s.settled(); }
  const st = s.status().stats;
  assert.equal(st.lines, 1);
  const { lines } = s.between(0, Number.MAX_SAFE_INTEGER);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '这是一句字幕');
  assert.equal(lines[0].t0, 2_000_000);
  // 再读一次：同一条已经交付过，不许再来一遍
  assert.equal(s.between(0, Number.MAX_SAFE_INTEGER).lines.length, 0);
});

test('双语两行：同帧两行各自入流', async () => {
  const f = fakeOcr({ lines: ['上面那行', '下面这行'] });
  const s = createTextStream({ config: CFG, startOcrFn: f.startOcrFn, resolveFn: () => ({ ok: true, python: 'py' }) });
  for (let i = 0; i < 2; i += 1) { s.onFrame(frameAt(3_000_000 + i * 1000)); await s.settled(); }
  assert.equal(s.status().stats.lines, 2);
  const { lines } = s.between(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(lines.map((l) => l.text), ['上面那行', '下面这行']);
});

test('OCR 慢一帧：忙的时候丢帧，不排队', async () => {
  const f = fakeOcr({ delay: 60 });
  const s = createTextStream({ config: CFG, startOcrFn: f.startOcrFn, resolveFn: () => ({ ok: true, python: 'py' }) });
  s.onFrame(frameAt(4_000_000));                    // 这一帧在飞
  s.onFrame(frameAt(4_001_000));                    // 到了抽帧点，但上一帧没回来 → 丢
  assert.equal(s.status().busy, true);
  assert.equal(s.status().sampled, 1);
  await s.settled();
  assert.equal(s.status().busy, false);
});

test('失败姿态：没有 winrt → status 写原因，onFrame 不抛', async () => {
  let started = 0;
  const s = createTextStream({
    config: CFG,
    startOcrFn: () => { started += 1; throw new Error('不该被调用'); },
    resolveFn: () => ({ ok: false, reason: '没有能 import winrt 的 Python' }),
  });
  for (let i = 0; i < 3; i += 1) {
    assert.doesNotThrow(() => s.onFrame(frameAt(5_000_000 + i * 1000)));
  }
  const st = s.status();
  assert.equal(started, 0);                          // 探针不过就不起进程
  assert.equal(st.ocr.available, false);
  assert.match(st.ocr.why, /winrt/);
  assert.equal(st.sampled, 0);
});

test('失败姿态：识别抛错 → 记原因、停引擎、下一帧不炸', async () => {
  const f = fakeOcr({ fail: 'sidecar 退出' });
  const s = createTextStream({ config: CFG, startOcrFn: f.startOcrFn, resolveFn: () => ({ ok: true, python: 'py' }) });
  s.onFrame(frameAt(6_000_000));
  await s.settled();
  const st = s.status();
  assert.equal(st.ocr.available, false);
  assert.match(st.ocr.why, /sidecar 退出/);
  assert.doesNotThrow(() => s.onFrame(frameAt(6_001_000)));
});

test('覆盖率：分母是「采样到有字」的时长，不是总采样时长', async () => {
  const f = fakeOcr({ lines: ['这是有字的这一帧'] });
  const s = createTextStream({ config: CFG, startOcrFn: f.startOcrFn, resolveFn: () => ({ ok: true, python: 'py' }) });
  for (let i = 0; i < 4; i += 1) { s.onFrame(frameAt(8_000_000 + i * 1000)); await s.settled(); }
  const cov = s.status().coverage;
  assert.equal(cov.hasTextSec, 4);          // 4 帧 × 1 秒（每帧都有字）
  assert.ok(cov.coveredSec >= 2);           // 第 3 帧确认，事件盖住后两帧
  assert.ok(cov.pct > 0 && cov.pct <= 100);
});

test('覆盖率：一帧都没有字时是 null，不报 0% 也不报 100%', async () => {
  const f = fakeOcr({ lines: [] });
  const s = createTextStream({ config: CFG, startOcrFn: f.startOcrFn, resolveFn: () => ({ ok: true, python: 'py' }) });
  for (let i = 0; i < 3; i += 1) { s.onFrame(frameAt(9_000_000 + i * 1000)); await s.settled(); }
  const cov = s.status().coverage;
  assert.equal(cov.hasTextSec, 0);
  assert.equal(cov.pct, null);
});

test('关掉时一帧都不送', async () => {
  const f = fakeOcr();
  const s = createTextStream({
    config: normalizeTextConfig({ enabled: false }).config,
    startOcrFn: f.startOcrFn,
    resolveFn: () => ({ ok: true, python: 'py' }),
  });
  for (let i = 0; i < 5; i += 1) s.onFrame(frameAt(7_000_000 + i * 1000));
  await s.settled();
  assert.equal(s.status().sampled, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(s.status().enabled, false);
});

/** 造一帧：条带里前 20% 的像素改亮度（模拟「字幕换句」），其余不动 */
function frameWithBand(level) {
  const b = Buffer.from(FRAME);
  const x0 = 192;                        // bandRect(1920,1080,[0.8,1,0.1]).x
  const y0 = 864;                        // .y
  const w = 1536;                        // .w
  const h = 216;                         // .h
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + Math.floor(w * 0.2); x += 1) {
      const p = (y * W + x) * 3;
      b[p] = level; b[p + 1] = level; b[p + 2] = level;
    }
  }
  return b;
}

test('静默暂停：条带连续没变化就到点停读，有变化立刻恢复', async () => {
  const f = fakeOcr({ lines: ['你好世界'] });
  const s = createTextStream({
    config: { ...CFG, pauseAfterMs: 3000, diffRatio: 0.02 },
    startOcrFn: f.startOcrFn,
    resolveFn: () => ({ ok: true, python: 'py' }),
  });
  const same = frameWithBand(40);
  for (let i = 0; i < 6; i += 1) {
    s.onFrame({ t: i, buf: same, width: W, height: H, wall: 5_000_000 + i * 1000 });
    await s.settled();
  }
  const st = s.status();
  assert.equal(st.paused, true, '3 秒没变化应暂停');
  assert.ok(st.sampled <= 4, `暂停后不该再送 OCR，实得 ${st.sampled}`);

  // 条带变了（字幕换句）→ 恢复
  s.onFrame({ t: 7, buf: frameWithBand(200), width: W, height: H, wall: 5_000_000 + 7 * 1000 });
  await s.settled();
  assert.equal(s.status().paused, false, '有变化应恢复');
  assert.ok(s.status().sampled > st.sampled, '恢复后应重新送 OCR');
});

test('静默暂停：pauseAfterMs = 0 时永不暂停（老行为）', async () => {
  const f = fakeOcr({ lines: ['你好世界'] });
  const s = createTextStream({
    config: { ...CFG, pauseAfterMs: 0 },
    startOcrFn: f.startOcrFn,
    resolveFn: () => ({ ok: true, python: 'py' }),
  });
  const same = frameWithBand(40);
  for (let i = 0; i < 6; i += 1) {
    s.onFrame({ t: i, buf: same, width: W, height: H, wall: 6_000_000 + i * 1000 });
    await s.settled();
  }
  assert.equal(s.status().paused, false);
  assert.ok(s.status().sampled >= 5, `不该停，实得 ${s.status().sampled}`);
});

test('setFps 2：500ms 间隔的两帧也能确认（确认间隔跟着缩到 450）', async () => {
  const f = fakeOcr({ lines: ['你好世界'] });
  const s = createTextStream({
    config: CFG,
    startOcrFn: f.startOcrFn,
    resolveFn: () => ({ ok: true, python: 'py' }),
  });
  s.setFps(2);
  assert.equal(s.status().fps, 2);
  s.onFrame({ t: 0, buf: FRAME, width: W, height: H, wall: 8_000_000 });
  await s.settled();
  s.onFrame({ t: 0.5, buf: FRAME, width: W, height: H, wall: 8_000_500 });
  await s.settled();
  assert.equal(s.status().stats.lines, 1, '500ms 间隔在 2 fps 下应能确认（1 fps 的 900 会挡掉）');
});
