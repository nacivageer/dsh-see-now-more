/**
 * coverage-ledger.test.mjs — 覆盖率账的按分钟落盘（P1）。
 *
 * 覆盖四件事：
 *  - 分分钟：一段跨分钟按比例拆两行，`segs` / `emptySegs` 这种计数只记一次；
 *  - 落盘 / 读回：按本地日期分文件，坏行跳过；
 *  - 对齐：同一分钟「有字没抬」「抬了没字」各算候选，台账外的抬升不判误抬；
 *  - 接线：`createListener().drain()` 真跑一遍（假转写器 + 假 wav），账真的落到了盘上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  alignLift, appendCoverage, coverageRoot, dayKey, ledgerFile, ledgerRows, liftMinute,
  minuteKey, readLedger, sumByMinute,
} from '../src/coverage-ledger.js';
import { createListener, unpackTranscription } from '../src/listen.js';

/** 临时 DSH_HOME（每个用例一份，互不污染）。 */
function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cov-ledger-'));
  mkdirSync(join(home, 'see-now'), { recursive: true });
  return home;
}

/** 一段 16 kHz 单声道 PCM16 WAV（静音也行 —— 转写器是假的）。 */
function wav(seconds = 2, rate = 16_000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

test('一分钟内的段只出一行，出字就按整段语音算覆盖', () => {
  const at = new Date(2026, 10, 17, 4, 3, 10).getTime();
  const rows = ledgerRows({ t0: at, sentSec: 3, speechSec: 2.4, gotText: true });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    day: '2026-11-17', minute: '04:03', sentSec: 3, speechSec: 2.4,
    textSec: 2.4, emptySegs: 0, segs: 1,
  });
});

test('跨分钟按时间比例拆两行：秒数相加等于原值，段计数只记一次', () => {
  const at = new Date(2026, 10, 17, 4, 3, 58).getTime();   // 距整分钟还有 2 秒
  const rows = ledgerRows({ t0: at, sentSec: 6, speechSec: 5, gotText: true });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.minute), ['04:03', '04:04']);
  assert.equal(rows.reduce((n, r) => n + r.sentSec, 0), 6);
  assert.equal(rows.reduce((n, r) => n + r.speechSec, 0), 5);
  assert.equal(rows.reduce((n, r) => n + r.textSec, 0), 5);
  assert.equal(rows.reduce((n, r) => n + r.segs, 0), 1);
  assert.deepEqual(rows.map((r) => r.segs), [0, 1]);        // 4 秒那段是「最长」
});

test('没出字且语音够长 → 记 1 段「像说话没字」，且只记在最长的那一分钟', () => {
  const at = new Date(2026, 10, 17, 4, 3, 58).getTime();
  const rows = ledgerRows({ t0: at, sentSec: 6, speechSec: 5, gotText: false });
  assert.deepEqual(rows.map((r) => r.emptySegs), [0, 1]);
  assert.equal(rows.reduce((n, r) => n + r.textSec, 0), 0);

  // 语音太短（<1.2s）不算「像说话没字」
  const short = ledgerRows({ t0: at, sentSec: 1, speechSec: 0.8, gotText: false });
  assert.equal(short.reduce((n, r) => n + r.emptySegs, 0), 0);
});

test('没有 speechSec 时退回段长（老调用/测试的形状）', () => {
  const at = new Date(2026, 10, 17, 4, 3, 10).getTime();
  const rows = ledgerRows({ at, sentSec: 3, gotText: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].speechSec, 3);
  assert.equal(rows[0].emptySegs, 1);
});

test('speechSec 为 0 = VAD 说没人说话：不算语音、不算「像说话没字」', () => {
  const at = new Date(2026, 10, 17, 4, 3, 10).getTime();
  const rows = ledgerRows({ t0: at, sentSec: 6, speechSec: 0, gotText: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sentSec, 6);      // 送出去多长仍然照记
  assert.equal(rows[0].speechSec, 0);
  assert.equal(rows[0].textSec, 0);
  assert.equal(rows[0].emptySegs, 0);
  assert.equal(rows[0].segs, 1);
});

test('unpackTranscription：0 与「没回传」必须分开', () => {
  assert.equal(unpackTranscription({ text: '' }).speechSec, null);
  assert.equal(unpackTranscription({ text: '', speechSec: 0 }).speechSec, 0);
  assert.equal(unpackTranscription({ text: '', speechSec: 2.4 }).speechSec, 2.4);
});

test('落盘按本地日期分文件；读回来能按分钟求和', () => {
  const home = tmpHome();
  const at = new Date(2026, 10, 17, 4, 3, 10).getTime();
  const written = appendCoverage({ t0: at, sentSec: 3, speechSec: 2.4, gotText: true }, { env: { DSH_HOME: home } });
  appendCoverage({ t0: at + 5_000, sentSec: 3, speechSec: 2.4, gotText: false }, { env: { DSH_HOME: home } });

  assert.equal(written.length, 1);
  assert.equal(ledgerFile('2026-11-17', { DSH_HOME: home }),
    join(coverageRoot({ DSH_HOME: home }), '2026-11-17.jsonl'));
  const rows = readLedger('2026-11-17', { env: { DSH_HOME: home } });
  assert.equal(rows.length, 2);

  const minutes = sumByMinute(rows);
  assert.equal(minutes.length, 1);
  assert.equal(minutes[0].minute, '04:03');
  assert.equal(minutes[0].speechSec, 4.8);
  assert.equal(minutes[0].textSec, 2.4);
  assert.equal(minutes[0].emptySegs, 1);
  assert.equal(minutes[0].segs, 2);
  assert.equal(minutes[0].ratio, 50);
});

test('坏行跳过，别的日期/形状不对的行不算进今天的账', () => {
  const home = tmpHome();
  const file = ledgerFile('2026-11-17', { DSH_HOME: home });
  mkdirSync(coverageRoot({ DSH_HOME: home }), { recursive: true });
  writeFileSync(file, [
    'not json',
    JSON.stringify({ day: '2026-11-17', minute: '04:03', sentSec: 3, speechSec: 2.4, textSec: 2.4, emptySegs: 0, segs: 1 }),
    JSON.stringify({ day: '2026-11-16', minute: '04:04', sentSec: 3, speechSec: 3, textSec: 3, emptySegs: 0, segs: 1 }),
    JSON.stringify({ minute: 'nope', sentSec: 1 }),
    '',
  ].join('\n'), 'utf8');
  const rows = readLedger('2026-11-17', { env: { DSH_HOME: home } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minute, '04:03');
});

test('写不进去只回调 onError，不抛（账坏了不能让听停掉）', () => {
  const home = tmpHome();
  // 把 coverage 占成一个普通文件：mkdirSync 会 EEXIST
  writeFileSync(join(home, 'see-now', 'coverage'), 'not a dir', 'utf8');
  const errors = [];
  const at = new Date(2026, 10, 17, 4, 3, 10).getTime();
  const written = appendCoverage({ t0: at, sentSec: 3, gotText: true }, {
    env: { DSH_HOME: home }, onError: (e) => errors.push(e),
  });
  assert.deepEqual(written, []);
  assert.equal(errors.length, 1);
});

test('对齐：有字没抬 = 漏抬候选；抬了没字 = 误抬候选；台账外的抬升不算误抬', () => {
  const minutes = sumByMinute([
    { day: '2026-11-17', minute: '04:03', sentSec: 3, speechSec: 2.4, textSec: 2.4, emptySegs: 0, segs: 1 },
    { day: '2026-11-17', minute: '04:04', sentSec: 3, speechSec: 2.4, textSec: 0, emptySegs: 1, segs: 1 },
    { day: '2026-11-17', minute: '04:05', sentSec: 3, speechSec: 2.4, textSec: 2.4, emptySegs: 0, segs: 1 },
  ]);
  const t = (hh, mm) => new Date(2026, 10, 17, hh, mm, 10).getTime();
  const lifts = [
    { at: t(4, 3) + 1_000, wall: t(4, 3), level: 'alarm', spoke: true },   // 04:03 有字也抬了
    { at: t(4, 4) + 1_000, wall: t(4, 4), level: 'glance', spoke: false }, // 04:04 没字却抬了
    { at: t(3, 59) + 1_000, wall: t(3, 59), level: 'alarm', spoke: true }, // 台账外
  ];
  const res = alignLift(minutes, lifts);
  assert.deepEqual(res.missing.map((m) => m.minute), ['04:05']);
  assert.deepEqual(res.falseAlarm.map((m) => m.minute), ['04:04']);
  assert.deepEqual(res.totals, { lift: 3, spoke: 2, missing: 1, falseAlarm: 1, unmatched: 1 });
  assert.equal(res.minutes.find((m) => m.minute === '04:03').lifts, 1);
});

test('lift 的分钟优先用 wall（那句话的时间），没有才退回 at', () => {
  const wall = new Date(2026, 10, 17, 4, 3, 10).getTime();
  assert.equal(liftMinute({ wall, at: wall + 3_600_000 }), '04:03');
  assert.equal(liftMinute({ wall: null, at: wall }), '04:03');
  assert.equal(liftMinute({}), null);
});

test('本地日期/分钟（不是 UTC：toISOString 在凌晨会差一天）', () => {
  const d = new Date(2026, 0, 2, 0, 7, 0);
  assert.equal(dayKey(d.getTime()), '2026-01-02');
  assert.equal(minuteKey(d.getTime()), '00:07');
});

test('接线：drain 处理完一段，账真的落到 $DSH_HOME/see-now/coverage 下', async () => {
  const home = tmpHome();
  const dir = join(home, 'see-now', 'audio');
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 3_000;
  writeFileSync(join(dir, `seg-${t0}.wav`), wav(2));

  const transcriber = {
    kind: 'test',
    label: '假转写器',
    async transcribe() { return { text: '今天天气不错', emb: null, speechSec: 1.6 }; },
  };
  const listener = createListener({
    dir,
    env: { DSH_HOME: home },
    transcriber,
    log: () => {},
  });
  await listener.drain();

  const rows = readLedger(dayKey(t0), { env: { DSH_HOME: home } });
  const total = rows.reduce((n, r) => n + r.speechSec, 0);
  assert.equal(rows.reduce((n, r) => n + r.segs, 0), 1, '一段只记一次');
  assert.ok(Math.abs(total - 1.6) < 1e-6, `语音秒数应约 1.6，实际 ${total}`);
  assert.equal(rows.reduce((n, r) => n + r.textSec, 0), 1.6);
  assert.equal(rows.reduce((n, r) => n + r.emptySegs, 0), 0);
  // 同时确认台账文件真的是 jsonl（一行一对象）
  for (const line of readFileSync(ledgerFile(dayKey(t0), { DSH_HOME: home }), 'utf8').trim().split('\n')) {
    assert.equal(typeof JSON.parse(line).minute, 'string');
  }
});
