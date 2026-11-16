import test from 'node:test';
import assert from 'node:assert/strict';

import { cosine, createSpeakerTracker, normalizeVec, resolveSpeaker, SPEAKER_MAX } from '../src/speaker.js';
import { unpackTranscription } from '../src/listen.js';

/** 造一个 128 维向量：`seed` 决定方向，`noise` 加一点扰动 */
function vec(seed, noise = 0) {
  const out = [];
  for (let i = 0; i < 128; i += 1) {
    const base = Math.sin((i + 1) * seed * 0.37);
    out.push(base + (noise ? Math.sin(i * 1.7 + noise) * 0.05 : 0));
  }
  return out;
}

test('normalizeVec：长度归一，零向量返回空', () => {
  const v = normalizeVec([3, 4]);
  assert.deepEqual(v.map((x) => Math.round(x * 100) / 100), [0.6, 0.8]);
  assert.deepEqual(normalizeVec([0, 0]), []);
});

test('cosine：同向为 1，正交为 0，长度不符返回 -1', () => {
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100) / 100, 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), -1);
});

test('同一人的多句归同一个号', () => {
  const t = createSpeakerTracker();
  const a = vec(1);
  assert.equal(t.assign(a), 'S1');
  assert.equal(t.assign(vec(1, 1)), 'S1');
  assert.equal(t.assign(vec(1, 2)), 'S1');
  assert.equal(t.size(), 1);
});

test('明显不同的人：第一次只挂候选，第二次才开号（延迟开号）', () => {
  const t = createSpeakerTracker();
  assert.equal(t.assign(vec(1)), 'S1');
  assert.equal(t.assign(vec(2)), null, '新声音第一次出现不该立刻开号');
  assert.equal(t.assign(vec(2)), 'S2', '同一个人第二次出现才建成 S2');
  assert.equal(t.size(), 2);
});

test('向量太短 / 为空时返回 null（不硬塞编号）', () => {
  const t = createSpeakerTracker({ minDim: 64 });
  assert.equal(t.assign([]), null);
  assert.equal(t.assign(new Array(16).fill(0.1)), null);
  assert.equal(t.assign(null), null);
  assert.equal(t.size(), 0);
});

test('超过上限后归给最像的那个，不无限开号', () => {
  const t = createSpeakerTracker({ maxSpeakers: 2 });
  t.assign(vec(1));
  t.assign(vec(2)); t.assign(vec(2));
  t.assign(vec(3)); t.assign(vec(3));
  assert.equal(t.size(), 2);
});

test('默认上限是 6', () => {
  assert.equal(SPEAKER_MAX, 6);
});

test('resolveSpeaker：够长的句子用声纹；新声音要出现两次才开号', () => {
  const tracker = createSpeakerTracker();
  const a = resolveSpeaker({ emb: vec(1), durSec: 3, t0: 1000, last: null, tracker });
  assert.equal(a, 'S1');
  // 第一次听到 B：还没开号，按"最近一句是 A"处理 → 继承 S1
  const b1 = resolveSpeaker({ emb: vec(2), durSec: 3, t0: 5000, last: { t1: 4000, spk: a }, tracker });
  assert.equal(b1, 'S1');
  // 第二次听到 B：开 S2
  const b2 = resolveSpeaker({ emb: vec(2), durSec: 3, t0: 9000, last: { t1: 8000, spk: 'S1' }, tracker });
  assert.equal(b2, 'S2');
});

test('resolveSpeaker：短句沿用上一句的号，不自己开新号', () => {
  const tracker = createSpeakerTracker();
  const spk = resolveSpeaker({ emb: vec(9), durSec: 0.8, t0: 2000, last: { t1: 1500, spk: 'S1' }, tracker });
  assert.equal(spk, 'S1');
  assert.equal(tracker.size(), 0);   // 短句根本没进聚类
});

test('resolveSpeaker：短句但离上一句太远 → 不给号（不硬猜）', () => {
  const tracker = createSpeakerTracker();
  const spk = resolveSpeaker({ emb: vec(9), durSec: 0.8, t0: 20000, last: { t1: 1500, spk: 'S1' }, tracker });
  assert.equal(spk, null);
});

test('resolveSpeaker：没有声纹、也没有上一句 → null', () => {
  const tracker = createSpeakerTracker();
  assert.equal(resolveSpeaker({ emb: null, durSec: 3, t0: 1000, last: null, tracker }), null);
});

test('unpackTranscription：字符串也认，且带上"说话长度"', () => {
  assert.deepEqual(
    unpackTranscription({ text: ' 甲 ', emb: [1, 2], speechSec: 1.2 }),
    { text: '甲', emb: [1, 2], speechSec: 1.2 },
  );
  assert.deepEqual(unpackTranscription('乙'), { text: '乙', emb: null, speechSec: null });
});
