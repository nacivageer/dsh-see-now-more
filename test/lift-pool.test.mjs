/**
 * lift-pool.js 的单测（P0，纯函数）。
 *
 * 这里只测池子的三条契约：窗口内留下、超限丢最老、摘要 ≤300 字且按时间序。
 * 不上真实采集 —— 池子是纯数据，喂进去什么就该算什么。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLiftPool, POOL_MAX, POOL_WINDOW_MS, SUMMARY_MAX_CHARS,
} from '../src/lift/pool.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 4, 0, 0);

const speech = (at, text) => ({ at, wall: at, kind: 'speech', text, src: 'test' });

test('push：合法条目进池，非 speech 不留 text，畸形条目拒绝且不抛', () => {
  const pool = createLiftPool();

  assert.equal(pool.push(speech(T0, '第一句')), true);
  assert.equal(pool.push({ at: T0 + 1000, kind: 'music', text: '不该留下' }), true);

  // 定稿是空串 = 这段没听出字，不占摘要
  assert.equal(pool.push({ at: T0 + 2000, kind: 'speech', text: '   ' }), false);
  assert.equal(pool.push({ kind: 'speech', text: '没有时间' }), false);
  assert.equal(pool.push({ at: T0 + 3000, kind: 'nope', text: '未知类型' }), false);
  assert.equal(pool.push(null), false);
  assert.equal(pool.push('不是对象'), false);

  assert.equal(pool.size(), 2);
  const s = pool.summary();
  assert.match(s, /第一句/);
  assert.doesNotMatch(s, /不该留下/);
});

test('10 分钟窗口：刚好 10 分钟的留着，老一秒就淘汰', () => {
  const pool = createLiftPool();
  pool.push(speech(T0, '很久以前'));
  pool.push(speech(T0 + 10 * MIN, '正好十分钟'));

  // 边界含等号：窗口是「最近 10 分钟」
  assert.match(pool.summary(), /很久以前/);
  assert.match(pool.summary(), /正好十分钟/);

  pool.push(speech(T0 + 10 * MIN + 1, '再晚一秒'));
  assert.doesNotMatch(pool.summary(), /很久以前/);
  assert.match(pool.summary(), /正好十分钟/);
});

test('200 条上限：超了丢最老的', () => {
  const pool = createLiftPool();
  const n = POOL_MAX + 1;
  for (let i = 0; i < n; i += 1) {
    pool.push(speech(T0 + i, `第${String(i).padStart(3, '0')}句`));
  }

  assert.equal(pool.size(), POOL_MAX);
  const s = pool.summary({ maxChars: 100_000 });
  assert.doesNotMatch(s, /第000句/);
  assert.match(s, /第001句/);
  assert.match(s, /第200句/);
});

test('乱序 push：按 at 排好，摘要不会把后到的旧句放最后', () => {
  const pool = createLiftPool();
  pool.push(speech(T0 + 5000, '后一句'));
  pool.push(speech(T0 + 1000, '前一句'));

  const s = pool.summary();
  assert.ok(s.indexOf('前一句') < s.indexOf('后一句'), s);
});

test('summary 默认硬上限 300 字，且按时间铺开（首尾都在，不是只剩最后几秒）', () => {
  const pool = createLiftPool();
  const lines = 80;
  for (let i = 0; i < lines; i += 1) {
    // 一句 12 字 × 80 句，一定装不下 300
    pool.push(speech(T0 + i * 1000, `这是第${String(i).padStart(2, '0')}句很长的台词`));
  }

  const s = pool.summary();
  assert.ok(s.length <= SUMMARY_MAX_CHARS, `摘要 ${s.length} 字，超过 ${SUMMARY_MAX_CHARS}`);
  assert.ok(s.length > 0);
  // 首尾都要在：窗口最早那句决定实际覆盖的起点，最新一句是刚落下的上下文
  assert.match(s, /这是第00句/);
  assert.match(s, /这是第79句/);

  const d = pool.summaryDetail();
  assert.equal(d.from, T0);
  assert.equal(d.to, T0 + 79_000);
  assert.equal(d.speech, 80);
  assert.ok(d.lines >= 3 && d.lines < 80, `摘了 ${d.lines} 句，应当是按时间铺开的子集`);
  assert.ok(d.text.length <= SUMMARY_MAX_CHARS);
});

test('summaryDetail：实际覆盖的是有台词的那段，窗口起点不等于摘要起点', () => {
  const pool = createLiftPool();
  pool.push(speech(T0 + 8 * MIN, '后段一'));
  pool.push(speech(T0 + 8 * MIN + 30_000, '后段二'));
  pool.push(speech(T0 + 9 * MIN, '后段三'));
  pool.push({ at: T0 + 9 * MIN + 10_000, wall: T0 + 9 * MIN + 10_000, kind: 'music' });

  const d = pool.summaryDetail();
  assert.equal(d.from, T0 + 8 * MIN);
  assert.equal(d.to, T0 + 9 * MIN);
  assert.equal(d.windowFrom, T0 - 50_000);   // 最新一条（音乐）往前 10 分钟
  assert.equal(d.windowTo, T0 + 9 * MIN + 10_000);
  assert.equal(d.lines, 3);
  assert.equal(d.speech, 3);
  assert.match(d.text, /后段一/);
  assert.match(d.text, /后段三/);
  assert.doesNotMatch(d.text, /后段二.*后段一/);   // 时间序，不是倒序
});

test('summaryDetail：只有声音没有台词时，文本为空但窗口仍报出来', () => {
  const pool = createLiftPool();
  pool.push({ at: T0, kind: 'music' });
  const d = pool.summaryDetail();
  assert.equal(d.text, '');
  assert.equal(d.from, null);
  assert.equal(d.to, null);
  assert.equal(d.speech, 0);
  assert.equal(d.windowTo, T0);
});

test('summaryDetail：极小时只留最新一句并硬截，不超 maxChars', () => {
  const pool = createLiftPool();
  pool.push(speech(T0, '第一句非常非常长的台词'));
  pool.push(speech(T0 + 1000, '最新一句也非常非常长的台词'));
  const d = pool.summaryDetail({ maxChars: 12 });
  assert.ok(d.text.length <= 12, `实际 ${d.text.length} 字`);
  assert.equal(d.lines, 1);
  assert.match(d.text, /最新/);
});

test('summary：maxChars 可调，极小时硬截且不超限', () => {
  const pool = createLiftPool();
  pool.push(speech(T0, '一句非常非常长的台词用来测试硬上限'));

  assert.ok(pool.summary({ maxChars: 12 }).length <= 12);
  assert.equal(pool.summary({ maxChars: 0 }), '');
  assert.equal(pool.summary({ maxChars: -5 }), '');
});

test('summary：since 之前的台词不出现', () => {
  const pool = createLiftPool();
  pool.push(speech(T0, '很早的一句'));
  pool.push(speech(T0 + 60_000, '中间的一句'));
  pool.push(speech(T0 + 120_000, '最后的一句'));

  const s = pool.summary({ since: T0 + 60_000 });
  assert.doesNotMatch(s, /很早的一句/);
  assert.match(s, /中间的一句/);
  assert.match(s, /最后的一句/);
});

test('around：默认前后 5 秒，按时间正序，超上限时留最靠近的', () => {
  const pool = createLiftPool();
  pool.push(speech(T0 - 60_000, '一分钟前'));
  pool.push(speech(T0 - 2000, '两秒前'));
  pool.push(speech(T0, '当下'));
  pool.push(speech(T0 + 3000, '三秒后'));
  pool.push(speech(T0 + 60_000, '一分钟后'));

  const near = pool.around(T0);
  assert.deepEqual(near.map((e) => e.text), ['两秒前', '当下', '三秒后']);

  assert.deepEqual(pool.around(T0, { windowMs: 0 }).map((e) => e.text), ['当下']);
  assert.deepEqual(pool.around(T0, { windowMs: 0, max: 1 }).map((e) => e.text), ['当下']);

  // 25 条都在 5 秒内，取 3 条：留离 T0 最近的
  const dense = createLiftPool();
  for (let i = -12; i <= 12; i += 1) {
    dense.push(speech(T0 + i * 100, `偏${i}`));
  }
  const picked = dense.around(T0, { max: 3 });
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.map((e) => e.text), ['偏-1', '偏0', '偏1']);
});

test('around：时间不是数字时返回空数组，不抛', () => {
  const pool = createLiftPool();
  pool.push(speech(T0, '一句'));
  assert.deepEqual(pool.around(undefined), []);
  assert.deepEqual(pool.around('abc'), []);
});

test('clear：清空之后 size 归零、摘要为空', () => {
  const pool = createLiftPool();
  pool.push(speech(T0, '一句'));
  pool.clear();
  assert.equal(pool.size(), 0);
  assert.equal(pool.summary(), '');
});

test('空池：summary 是空串，不是占位文案', () => {
  const pool = createLiftPool();
  assert.equal(pool.summary(), '');
  assert.equal(pool.size(), 0);
});

test('POOL_WINDOW_MS 就是 10 分钟（接线方按这个数解释池子）', () => {
  assert.equal(POOL_WINDOW_MS, 10 * 60 * 1000);
});
