/**
 * P0 验收（交接文第 67–72 行）：一段 30 分钟的合成台词。
 *
 * 场景：黑听一部片子的 30 分钟，3 次「你看这个」是真正的叫人看；
 * 第 26 分钟的「我的游戏已经开好了」是**会话内邀约** —— 它不含词表项，
 * 也不该被小表当成黑听触发（留给模型按上下文判）。
 *
 * 两条断言就是验收原文：
 *   1. `matchLiftTriggers` 只报 3 次命中（不是 4 次）。
 *   2. `lift-pool.summary()` ≤300 字，且包含那 3 句。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiftPool, SUMMARY_MAX_CHARS } from '../src/lift-pool.js';
import { matchLiftTriggers } from '../src/lift-triggers.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 4, 0, 0);

/** 每 2 分钟一句，30 分钟共 15 句。 */
const SCRIPT = [
  [0, '这段音乐很稳。'],
  [2, '我们继续看后面的部分。'],
  [4, '画面里是海边的黄昏。'],
  [6, '现在的节奏比刚才慢一些。'],
  [8, '这里的对白听不太清。'],
  [10, '镜头切到了室内。'],
  [12, '外面开始下雨了。'],
  [14, '这段配乐很有层次。'],
  [16, '主角把灯关掉了。'],
  [18, '然后是一段很长的静场。'],
  [20, '你看这个镜头，有点意思。'],
  [22, '我们接着看下一段。'],
  [24, '你看这个转场，来得太快。'],
  [26, '我的游戏已经开好了，你随时可以来。'],
  [28, '你看这个光影，收得很漂亮。'],
];

const utterances = SCRIPT.map(([minute, text]) => ({
  text,
  startMs: T0 + minute * MIN,
  endMs: T0 + minute * MIN + 2000,
  confidence: 0.92,
}));

const TRIGGERED = SCRIPT.filter(([, text]) => text.includes('你看这个')).map(([minute, text]) => ({
  minute,
  text,
}));

test('验收 1：30 分钟合成台词只报 3 次命中，邀约那句不算', () => {
  const { level, hits } = matchLiftTriggers(utterances);

  assert.equal(hits.length, 3, `报了 ${hits.length} 次：${hits.map((h) => h.text).join(' / ')}`);
  assert.equal(level, 'glance');
  assert.deepEqual(hits.map((h) => h.startMs), TRIGGERED.map((t) => T0 + t.minute * MIN));
  assert.deepEqual(hits.map((h) => h.text), TRIGGERED.map((t) => t.text));

  for (const hit of hits) assert.match(hit.reason, /你看这个/);
  assert.ok(!hits.some((h) => h.text.includes('我的游戏已经开好了')));
});

test('验收 2：summary ≤300 字，且 3 句触发台词都在里面、按时间序', () => {
  const pool = createLiftPool();
  for (const utterance of utterances) {
    assert.equal(pool.push({
      at: utterance.startMs,
      wall: utterance.startMs,
      kind: 'speech',
      text: utterance.text,
      src: 'acceptance',
    }), true);
  }

  const text = pool.summary();
  assert.ok(text.length <= SUMMARY_MAX_CHARS, `摘要 ${text.length} 字，超过 ${SUMMARY_MAX_CHARS}`);

  let cursor = -1;
  for (const { text: line } of TRIGGERED) {
    const at = text.indexOf(line);
    assert.ok(at >= 0, `摘要里没有「${line}」：\n${text}`);
    assert.ok(at > cursor, `「${line}」没有按时间序：\n${text}`);
    cursor = at;
  }
});
