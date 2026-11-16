/**
 * coverage.test.mjs — 覆盖率账的纯逻辑（P0）。
 *
 * 合成帧就能覆盖：全人声有字 / 人声无字 / 没测到 / 非人声里落字 / 短段不算。
 * 不需要采集、不需要真机、不读 DSH_HOME（全部喂内存对象）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCoverage, coverageOf, kindOf, kindsOf, mergeIntervals, SPEECH_MID } from '../src/coverage.js';

/** 造一帧声学数据：db + 三频带占比（lo, mid, hi 落在 [4],[5],[6]） */
function frame({ db = -30, mid = 0.8 } = {}) {
  const rest = (1 - mid) / 2;
  return [db, 0, 0, 0, rest, mid, rest, 0];
}

/** 造一段声学序列：hop 秒一格 */
function acoustic(seq, { hop = 0.5, from = 1_000_000 } = {}) {
  return { from, hop, frames: seq };
}

test('kindOf：静音 / 人声 / 有声 / 没测到 四类分开', () => {
  assert.equal(kindOf(frame({ db: -110 })), 'silent');
  assert.equal(kindOf(frame({ mid: SPEECH_MID + 0.1 })), 'speech');
  assert.equal(kindOf(frame({ mid: SPEECH_MID - 0.1 })), 'sound');
  assert.equal(kindOf(null), 'nodata');
});

test('全人声 + 全覆盖 → 100%', () => {
  const a = acoustic(Array.from({ length: 20 }, () => frame()));   // 20 × 0.5s = 10s
  const t0 = a.from;
  const res = computeCoverage(a, [{ t0, t1: t0 + 10_000, text: '一二三四五' }]);
  assert.equal(res.audio.speechSec, 10);
  assert.equal(res.coverage, 100);
  assert.equal(res.speechButNoText.spans, 0);
});

test('人声一半有字 → 覆盖率 ~50%（连续人声不算「像说话没字」）', () => {
  const a = acoustic(Array.from({ length: 20 }, () => frame()));
  const t0 = a.from;
  const res = computeCoverage(a, [{ t0, t1: t0 + 5_000, text: '半段' }]);
  assert.equal(res.audio.speechSec, 10);
  assert.equal(res.text.coveredSec, 5);
  assert.equal(res.coverage, 50);
  // 整段人声**有字**（只是没盖满），按口径不算「像说话没字」
  assert.equal(res.speechButNoText.spans, 0);
});

test('人声被切成两段、只有前段有字 → 后段算「像说话没字」', () => {
  const seq = [
    ...Array.from({ length: 10 }, () => frame()),                       // 5s 人声（有字）
    frame({ db: -110 }),                                               // 0.5s 静音
    ...Array.from({ length: 9 }, () => frame()),                       // 4.5s 人声（没字）
  ];
  const a = acoustic(seq);
  const res = computeCoverage(a, [{ t0: a.from, t1: a.from + 5_000, text: '前段' }]);
  assert.equal(res.speechButNoText.spans, 1);
  assert.equal(res.speechButNoText.seconds, 4.5);
});

test('没测到（null 帧）单独计时，不算人声也不算有字', () => {
  const seq = [...Array.from({ length: 10 }, () => frame()), ...Array.from({ length: 10 }, () => null)];
  const a = acoustic(seq);
  const res = computeCoverage(a, []);
  assert.equal(res.audio.speechSec, 5);
  assert.equal(res.audio.nodataSec, 5);
  assert.equal(res.coverage, 0);
});

test('非人声里落的字单独计数，不抬覆盖率', () => {
  const a = acoustic(Array.from({ length: 20 }, () => frame({ mid: 0.2 })));  // 全是有声
  const t0 = a.from;
  const res = computeCoverage(a, [{ t0, t1: t0 + 10_000, text: '音乐里的歌词' }]);
  assert.equal(res.audio.speechSec, 0);
  assert.equal(res.coverage, null);          // 没有人声就不报覆盖率，别编一个 0%
  assert.equal(res.text.offSpeechSec, 10);
});

test('短于 1.2 秒的人声段不要求有字', () => {
  // 4 格人声（2s）+ 2 格静音 + 2 格人声（1s）
  const seq = [
    ...Array.from({ length: 4 }, () => frame()),
    ...Array.from({ length: 4 }, () => frame({ db: -110 })),
    ...Array.from({ length: 2 }, () => frame()),
  ];
  const a = acoustic(seq);
  const res = computeCoverage(a, []);
  assert.equal(res.speechButNoText.spans, 1);   // 只数 2s 那段
  assert.equal(res.speechButNoText.seconds, 2);
});

test('重叠的转写行不会重复计时间', () => {
  const a = acoustic(Array.from({ length: 20 }, () => frame()));
  const t0 = a.from;
  const res = computeCoverage(a, [
    { t0, t1: t0 + 6_000, text: '前半' },
    { t0: t0 + 4_000, t1: t0 + 10_000, text: '重叠段' },
  ]);
  assert.equal(res.text.coveredSec, 10);
  assert.equal(res.coverage, 100);
});

test('单帧毛刺不该把人声切成碎片（平滑后仍是一整段）', () => {
  // 50ms 一格，中频在阈值上下逐帧跳：真实回环音频就是这样，实测会把 15 秒人声切碎
  const seq = Array.from({ length: 100 }, (_, i) => frame({ mid: i % 2 ? 0.5 : 0.8 }));
  const kinds = kindsOf(seq, 0.05);
  const speech = kinds.filter((k) => k === 'speech').length;
  assert.ok(speech >= 95, `平滑后应几乎全是人声，实际 ${speech}/100`);

  const res = computeCoverage(acoustic(seq, { hop: 0.05 }), [
    { t0: 1_000_000, t1: 1_005_000, text: '一整段' },
  ]);
  assert.equal(res.speechButNoText.spans, 0);   // 不再碎成几十段
  assert.ok(res.coverage >= 95, `覆盖率应接近 100，实际 ${res.coverage}`);
});

test('真·音乐（中频一直低）不该被平滑成人声', () => {
  const seq = Array.from({ length: 40 }, () => frame({ mid: 0.2 }));
  assert.ok(kindsOf(seq, 0.05).every((k) => k === 'sound'));
});

test('coverageOf：出字秒数 / 送审语音秒数（没有语音时不报覆盖率）', () => {
  const now = 2_000_000;
  const entries = [
    { at: now - 30_000, sentSec: 3, speechSec: 2.6, gotText: true },
    { at: now - 20_000, sentSec: 3, speechSec: 2.4, gotText: false },   // 送出去了没出字
    { at: now - 10_000, sentSec: 3, speechSec: 2.0, gotText: true },
  ];
  const c = coverageOf(entries, { now });
  assert.equal(c.segs, 3);
  assert.equal(c.speechSec, 7);          // 2.6 + 2.4 + 2.0
  assert.equal(c.textSec, 4.6);
  assert.equal(c.ratio, 66);
  assert.equal(c.emptySegs, 1);          // 2.4s ≥ 1.2s 且没出字
  assert.equal(c.sentSec, 9);
});

test('coverageOf：窗口外的旧条目不算，没人说话时 ratio 为 null', () => {
  const now = 2_000_000;
  const old = [{ at: now - 20 * 60_000, sentSec: 5, speechSec: 5, gotText: true }];
  assert.equal(coverageOf(old, { now }).ratio, null);          // 10 分钟窗口外
  assert.equal(coverageOf([], { now }).ratio, null);
});

test('coverageOf：整段没出字 → 0%，别当成 null', () => {
  const now = 2_000_000;
  const c = coverageOf([{ at: now - 1_000, sentSec: 4, speechSec: 3.8, gotText: false }], { now });
  assert.equal(c.ratio, 0);
  assert.equal(c.emptySegs, 1);
});

test('coverageOf：VAD 回传 0 秒语音 = 没人说话（不进分母，也不算像说话没字）', () => {
  const now = 2_000_000;
  const c = coverageOf([
    { at: now - 2_000, sentSec: 6, speechSec: 0, gotText: false },   // 纯 BGM 段
    { at: now - 1_000, sentSec: 6, speechSec: 2.4, gotText: false }, // 真有人声、没出字
  ], { now });
  assert.equal(c.speechSec, 2.4);        // 0 秒那段不进分母
  assert.equal(c.emptySegs, 1);          // 只数真有人声那段
  assert.equal(c.ratio, 0);
});

test('coverageOf：speechSec 没回传（null）才退回段长', () => {
  const now = 2_000_000;
  const c = coverageOf([{ at: now - 1_000, sentSec: 4, gotText: false }], { now });
  assert.equal(c.speechSec, 4);
  assert.equal(c.emptySegs, 1);
});

test('mergeIntervals：乱序 + 相交都并成一段', () => {
  assert.deepEqual(
    mergeIntervals([{ from: 5, to: 9 }, { from: 1, to: 4 }, { from: 2, to: 6 }]),
    [{ from: 1, to: 9 }],
  );
});

test('时间窗外的转写行被裁掉', () => {
  const a = acoustic(Array.from({ length: 20 }, () => frame()));
  const t0 = a.from;
  const res = computeCoverage(a, [{ t0: t0 - 5_000, t1: t0 + 2_000, text: '跨窗' }], { from: t0, to: t0 + 10_000 });
  assert.equal(res.text.coveredSec, 2);   // 只算窗内那 2 秒
});

