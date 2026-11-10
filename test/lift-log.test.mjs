/**
 * 记账（P2-B）的单元测试：`lift.jsonl` 追加、按天切、今日计数、过期清理。
 *
 * 全部写进临时 `DSH_HOME`（`chatDir()` 跟着环境变量走），不碰真实的 `~/.dsh`。
 * 日期一律用本地时区的固定时刻构造 —— `dayKey()` 按本地日期算，用 `Date.UTC`
 * 写测试在东八区会跨天。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendLift, dayKey, dayDir, frameFile, liftRoot, logFile, pruneOld, readDay, resetCountCache,
  todayCounts,
} from '../src/lift-log.js';

/** 本地时间 2026-11-10 12:00（避免 UTC 构造在东八区跨天）。 */
const T = new Date(2026, 10, 10, 12, 0, 0).getTime();
const DAY = dayKey(T);
const freshEnv = () => ({ DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-lift-log-')) });

test('appendLift：写到 lift/<日期>/log.jsonl，字段归一', () => {
  const env = freshEnv();
  resetCountCache();
  const row = appendLift({
    at: T,
    wall: T - 500,
    level: 'glance',
    trigger: 'word',
    text: '  你看这个  ',
    frameAt: T - 480,
    spoke: false,
    reason: '强命中',
  }, { env, now: () => T });

  assert.equal(row.level, 'glance');
  assert.equal(row.text, '你看这个', '首尾空白要去掉');
  assert.equal(row.wall, T - 500);
  assert.equal(row.spoke, false);

  const file = logFile(DAY, env);
  assert.equal(file, join(liftRoot(env), DAY, 'log.jsonl'));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).frameAt, T - 480);
});

test('appendLift：档位不合法就拒收（不写半条垃圾行）', () => {
  const env = freshEnv();
  assert.equal(appendLift({ at: T, level: 'nope' }, { env }), null);
  assert.equal(appendLift(null, { env }), null);
  assert.equal(existsSync(logFile(DAY, env)), false);
});

test('appendLift：没取到帧就是 frameAt:null，不许写成 0', () => {
  // 0 会被读成「1970 年取到过一帧」；验收第 5 条要的是明确的 null。
  const env = freshEnv();
  resetCountCache();
  const row = appendLift({
    at: T, wall: null, level: 'alarm', trigger: 'hold', frameAt: null,
  }, { env, now: () => T });
  assert.equal(row.frameAt, null);
  assert.equal(row.wall, null);

  const row2 = appendLift({
    at: T + 1, wall: T, level: 'glance', trigger: 'word', frameAt: 0,
    // 显式给了 0（比如调用方算错了）也当 0 —— 别把用户真给的值改掉
  }, { env, now: () => T });
  assert.equal(row2.frameAt, 0);
  assert.equal(row2.wall, T);
});

test('readDay：坏行跳过，好行照读', () => {
  const env = freshEnv();
  mkdirSync(dayDir(DAY, env), { recursive: true });
  writeFileSync(logFile(DAY, env), [
    JSON.stringify({ at: T, level: 'alarm', trigger: 'word', text: '啊' }),
    '{不是 json',
    JSON.stringify({ at: T + 1, level: 'look', trigger: 'dialog', text: '你看这个' }),
    JSON.stringify({ at: T + 2, level: 'bogus' }),
    '',
  ].join('\n'), 'utf8');

  const rows = readDay(DAY, { env });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.level), ['alarm', 'look']);
});

test('todayCounts：按档计数，写一条之后缓存立刻失效', () => {
  const env = freshEnv();
  resetCountCache();
  appendLift({ at: T, level: 'alarm', trigger: 'word' }, { env });
  appendLift({ at: T + 1, level: 'glance', trigger: 'word' }, { env });
  assert.deepEqual(todayCounts({ env, now: () => T + 2 }), { alarm: 1, glance: 1, look: 0, chase: 0, total: 2 });

  appendLift({ at: T + 3, level: 'look', trigger: 'dialog' }, { env });
  const after = todayCounts({ env, now: () => T + 4 });
  assert.equal(after.look, 1);
  assert.equal(after.total, 3);
});

test('todayCounts：没有文件时是四个 0，不抛', () => {
  const env = freshEnv();
  resetCountCache();
  assert.deepEqual(todayCounts({ env, now: () => T }), { alarm: 0, glance: 0, look: 0, chase: 0, total: 0 });
});

test('frameFile：按帧自己的时间戳命名，落在同一天目录里', () => {
  const env = freshEnv();
  assert.equal(frameFile(T, env), join(liftRoot(env), DAY, `${T}.png`));
});

test('pruneOld：只删 3 天前的日期目录，别的东西不动', () => {
  const env = freshEnv();
  const root = liftRoot(env);
  for (const d of ['2026-11-01', '2026-11-07', '2026-11-09', DAY, 'not-a-date']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  const removed = pruneOld({ env, now: () => T, keepDays: 3 });
  assert.equal(removed, 1, '只该删 11-01');
  assert.equal(existsSync(join(root, '2026-11-01')), false);
  assert.equal(existsSync(join(root, '2026-11-07')), true, '刚好第 3 天要留着');
  assert.equal(existsSync(join(root, DAY)), true);
  assert.equal(existsSync(join(root, 'not-a-date')), true, '不认识的名字不删');
});

test('pruneOld：keepDays = 0 时什么都不删', () => {
  const env = freshEnv();
  mkdirSync(join(liftRoot(env), '2020-01-01'), { recursive: true });
  assert.equal(pruneOld({ env, now: () => T, keepDays: 0 }), 0);
  assert.equal(existsSync(join(liftRoot(env), '2020-01-01')), true);
});
