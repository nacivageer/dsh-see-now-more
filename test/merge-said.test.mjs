import test from 'node:test';
import assert from 'node:assert/strict';

import { joinFragments, mergeSaid, mergeSpanMs, MERGE_MAX_CHARS, MERGE_MAX_LINES } from '../src/loop.js';

const line = (text) => ({ text });

test('mergeSaid：没超预算就全带，不丢句', () => {
  const lines = [line('第一句'), line('第二句'), line('第三句')];
  const r = mergeSaid(lines);
  assert.equal(r.text, '第一句 / 第二句 / 第三句');
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.lines, ['第一句', '第二句', '第三句']);
});

test('mergeSaid：超过句数上限时保最新的，丢最旧的', () => {
  const lines = Array.from({ length: 30 }, (_, i) => line(`第${i}句`));
  const r = mergeSaid(lines);
  assert.equal(r.lines.length, MERGE_MAX_LINES);
  assert.equal(r.dropped, 30 - MERGE_MAX_LINES);
  assert.equal(r.lines[0], '第18句');          // 30 - 12 = 18
  assert.equal(r.lines.at(-1), '第29句');
});

test('mergeSaid：超过字数预算时也保最新的', () => {
  // 每句 100 字 → 600 字预算只放得下 6 句
  const lines = Array.from({ length: 10 }, (_, i) => line(`${i}`.padStart(3, '0') + '甲'.repeat(97)));
  const r = mergeSaid(lines, { maxLines: 99, maxChars: MERGE_MAX_CHARS });
  const total = r.lines.join('').length;
  assert.ok(total <= MERGE_MAX_CHARS, `总字数 ${total} 超了 ${MERGE_MAX_CHARS}`);
  assert.equal(r.lines.at(-1).slice(0, 3), '009');
  assert.ok(r.dropped >= 4);
});

test('mergeSaid：单句就超预算时至少留这一句（不能返回空）', () => {
  const r = mergeSaid([line('甲'.repeat(1000))], { maxChars: 600 });
  assert.equal(r.lines.length, 1);
  assert.equal(r.dropped, 0);
});

test('mergeSaid：空串 / 空白不算一句', () => {
  const r = mergeSaid([line('  '), line(''), line('真话'), null]);
  assert.deepEqual(r.lines, ['真话']);
  assert.equal(r.dropped, 0);
});

test('mergeSaid：没有台词时返回空，调用方据此不叫', () => {
  const r = mergeSaid([]);
  assert.equal(r.text, '');
  assert.equal(r.lines.length, 0);
});

test('mergeSpanMs：从没叫过时以这批第一句为基准（不拿 0 当 1970 年）', () => {
  const now = 1_800_000_000_000;
  const firstT0 = now - 30_000;
  // 实报 bug：lastAudioWakeAt 初值 0 → now - 0 ≈ 1.79e12 毫秒 → 「1794843709 秒」
  assert.equal(mergeSpanMs(now, 0, firstT0), 30_000);
  assert.ok(mergeSpanMs(now, 0, firstT0) < 60_000);
});

test('mergeSpanMs：叫过就以叫醒时刻为基准', () => {
  const now = 1_800_000_000_000;
  assert.equal(mergeSpanMs(now, now - 120_000, now - 500_000), 120_000);
});

test('mergeSpanMs：时钟回拨也不会给出负数', () => {
  const now = 1_800_000_000_000;
  assert.equal(mergeSpanMs(now, now + 5_000, now), 0);
});

test('joinFragments：间隔不超过 600ms 的碎片拼回一句，t1 取后', () => {
  const r = joinFragments([
    { t0: 0, t1: 1000, text: '机会。' },
    { t0: 1200, t1: 2000, text: '能力量。' },
    { t0: 5000, t1: 6000, text: '下车。' },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].text, '机会。能力量。');
  assert.equal(r[0].t1, 2000);
  assert.equal(r[1].text, '下车。');
});

test('joinFragments：间隔超过阈值就分开（不同句不能拼）', () => {
  const r = joinFragments([
    { t0: 0, t1: 1000, text: '第一句。' },
    { t0: 2000, t1: 3000, text: '第二句。' },
  ]);
  assert.equal(r.length, 2);
});

test('joinFragments：空句直接丢掉，不影响拼接', () => {
  const r = joinFragments([
    { t0: 0, t1: 500, text: '甲' },
    { t0: 600, t1: 700, text: '  ' },
    { t0: 800, t1: 1200, text: '乙' },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, '甲乙');
});
