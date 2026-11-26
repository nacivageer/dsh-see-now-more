/**
 * text-deliver.test.mjs — P1 第 3 步的交付侧：水位去重 + 「屏幕文字」块。
 *
 * 两个纯函数：`unreadSince()`（水位之后的行）与 `textLinesText()`（渲染成块）。
 * 三处交付点（唤醒消息 / `watch` / `peek`）共用同一个水位，这里守的就是那条：
 * **同一条字不许在唤醒里给一次、图里再给一次**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unreadSince } from '../src/text-events.js';
import { textLinesText } from '../src/index.js';

const line = (seq, t0, text) => ({ seq, t0, t1: t0 + 2000, text, conf: null });

test('unreadSince：水位之后才给，水位取 max(seq)（t0 顺序里 seq 可能对调）', () => {
  const all = [line(2, 1000, '第二条先确认'), line(3, 900, '第三条后确认')];
  const a = unreadSince(all, 1);
  assert.deepEqual(a.lines.map((l) => l.seq), [2, 3]);
  assert.equal(a.seq, 3);

  // 同一批再问一次：一条都不给（这就是"唤醒给过、watch 不再给"）
  const b = unreadSince(all, a.seq);
  assert.equal(b.lines.length, 0);
  assert.equal(b.seq, 3);
  assert.equal(b.skipped, 2);

  // 水位高于所有 seq 时不许倒退
  assert.equal(unreadSince(all, 9).seq, 9);
  // 新的一条
  assert.deepEqual(unreadSince([...all, line(4, 3000, '新的')], 3).lines.map((l) => l.seq), [4]);
});

test('textLinesText：真有几行才出现，带 #格子 / 时钟 / 相对秒', () => {
  const sheet = {
    frames: [{ t: 10, wall: 1_700_000_000_000 }, { t: 12, wall: 1_700_000_002_000 }],
    textLines: [
      { seq: 1, t0: 1_700_000_001_000, text: '我们得先回去' },
      { seq: 2, t0: 1_700_000_003_000, text: '天快黑了' },
    ],
    textStats: { seq: 2, dropped: 0 },
  };
  const out = textLinesText(sheet);
  assert.match(out, /屏幕文字/);
  assert.match(out, /#1 .*我们得先回去/);
  assert.match(out, /#2 .*天快黑了/);
  assert.match(out, /文字水位 2/);

  // 没有行就一个字都不加（空标题会让模型以为 OCR 坏了）
  assert.equal(textLinesText({ frames: [], textLines: [] }), '');
  assert.equal(textLinesText({}), '');
  assert.equal(textLinesText(null), '');
});

test('textLinesText：预算丢了的行如实报数', () => {
  const sheet = {
    frames: [{ t: 0, wall: 1_700_000_000_000 }],
    textLines: [{ seq: 5, t0: 1_700_000_000_500, text: '只列最新的一条' }],
    textStats: { seq: 8, dropped: 3 },
  };
  const out = textLinesText(sheet);
  assert.match(out, /另有 3 行未列/);
  assert.match(out, /文字水位 8/);
});
