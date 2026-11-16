import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transcriptEntry, transcriptPath, transcriptRelPath, writeTranscript } from '../src/loop.js';

test('transcriptEntry：空白句不进文件，时间戳归一成数字', () => {
  assert.equal(transcriptEntry({ t0: 1, t1: 2, text: '   ' }), null);
  assert.equal(transcriptEntry(null), null);
  assert.deepEqual(transcriptEntry({ t0: '5', t1: '9', text: ' 甲 ' }), { t0: 5, t1: 9, text: '甲' });
});

test('transcriptRelPath：按本地日期一天一个文件', () => {
  const at = new Date(2026, 10, 16, 23, 59, 0).getTime();   // 本地 2026-11-16 23:59
  const rel = transcriptRelPath(at).split('\\').join('/');
  assert.match(rel, /^see-now\/transcript\/2026-11-16\.jsonl$/);
});

test('writeTranscript：追加不覆盖，两批都在同一个文件里', () => {
  const home = mkdtempSync(join(tmpdir(), 'see-now-tr-'));
  try {
    const env = { DSH_HOME: home };
    const at = Date.now();
    assert.equal(writeTranscript([{ t0: 1, t1: 2, text: '甲' }], at, env), 1);
    assert.equal(writeTranscript([{ t0: 3, t1: 4, text: '乙' }, { t0: 5, t1: 6, text: ' ' }], at, env), 1);
    const rows = readFileSync(transcriptPath(env, at), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.text), ['甲', '乙']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeTranscript：没有可写的句子就不建文件', () => {
  const home = mkdtempSync(join(tmpdir(), 'see-now-tr-'));
  try {
    const env = { DSH_HOME: home };
    const at = Date.now();
    assert.equal(writeTranscript([], at, env), 0);
    assert.throws(() => readFileSync(transcriptPath(env, at), 'utf8'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
