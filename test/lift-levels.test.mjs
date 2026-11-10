/**
 * 判档（P2-B）的单元测试。
 *
 * 这张表就是机制文档「四档」的可执行版本：基线（`lift.level`）+ 活跃对话升一档 +
 * 蓄水池（5 分钟 3 次警觉）。**看/瞥分界错一次，用户不是被吵到就是觉得它聋** ——
 * 所以这里把每条规则的正反两面都钉住，而不是只测一个 happy path。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideLevel, levelRank, shouldFallback, LIFT_LEVEL_ORDER } from '../src/lift-levels.js';

const strong = (text = '你看这个') => ({ level: 'glance', text, startMs: 1 });
const weak = (text = '啊？') => ({ level: 'alarm', text, startMs: 2 });

test('没有命中：不伪造档位', () => {
  assert.deepEqual(decideLevel({ hits: [] }), { level: null, why: 'none', reason: '没有命中' });
  // 词表以外的 level（比如误传 look）不算命中
  assert.equal(decideLevel({ hits: [{ level: 'look' }] }).level, null);
  assert.equal(decideLevel({ hits: [null, undefined, {}] }).level, null);
});

test('强命中 + 基线 glance：没人说话只瞥，有人说话就升级成看', () => {
  assert.equal(decideLevel({ hits: [strong()], baseLevel: 'glance', active: false }).level, 'glance');
  const up = decideLevel({ hits: [strong()], baseLevel: 'glance', active: true });
  assert.equal(up.level, 'look');
  assert.equal(up.why, 'strong+dialog');
});

test('基线 alarm（最省模式）：安静只记账，有人说话也只升到瞥、不叫醒', () => {
  assert.equal(decideLevel({ hits: [strong()], baseLevel: 'alarm', active: false }).level, 'alarm');
  const up = decideLevel({ hits: [strong()], baseLevel: 'alarm', active: true });
  assert.equal(up.level, 'glance');
  assert.equal(up.why, 'strong+dialog');
});

test('基线 look：强命中原样叫醒，不再看有没有对话', () => {
  assert.equal(decideLevel({ hits: [strong()], baseLevel: 'look', active: false }).level, 'look');
  assert.equal(decideLevel({ hits: [strong()], baseLevel: 'look', active: true }).level, 'look');
});

test('基线 chase 在自动判定里等同 look（追只能模型发起）', () => {
  assert.equal(decideLevel({ hits: [strong()], baseLevel: 'chase', active: false }).level, 'look');
});

test('基线写错 → 退回默认 glance，不抛', () => {
  assert.equal(decideLevel({ hits: [strong()], baseLevel: 'nope' }).level, 'glance');
  assert.equal(decideLevel({ hits: [strong()], baseLevel: null }).level, 'glance');
});

test('弱命中：有人在说话也只记账（永远不叫醒）', () => {
  const r = decideLevel({ hits: [weak()], baseLevel: 'glance', active: true });
  assert.equal(r.level, 'alarm');
  assert.equal(r.why, 'weak');
});

test('蓄水池：5 分钟内第 3 次警觉升一次瞥，第 2 次不升', () => {
  assert.equal(decideLevel({ hits: [weak()], alarmsIn5min: 2 }).level, 'alarm');
  const r = decideLevel({ hits: [weak()], alarmsIn5min: 3 });
  assert.equal(r.level, 'glance');
  assert.equal(r.why, 'pool');
  assert.match(r.reason, /第 3 次/);
});

test('蓄水池：门槛可调，且不管基线', () => {
  assert.equal(decideLevel({ hits: [weak()], alarmsIn5min: 4, poolThreshold: 5 }).level, 'alarm');
  assert.equal(decideLevel({ hits: [weak()], alarmsIn5min: 5, poolThreshold: 5 }).level, 'glance');
  assert.equal(decideLevel({ hits: [weak()], baseLevel: 'alarm', alarmsIn5min: 9 }).level, 'glance');
});

test('一批里既有一句强命中又有弱命中：按最贵的那条判', () => {
  const r = decideLevel({ hits: [weak('啊？'), strong('快看')], baseLevel: 'glance', active: false });
  assert.equal(r.level, 'glance');
  assert.equal(r.why, 'strong');
});

test('档位序号：alarm < glance < look < chase，未知给 -1', () => {
  assert.deepEqual(LIFT_LEVEL_ORDER, ['alarm', 'glance', 'look', 'chase']);
  assert.ok(levelRank('alarm') < levelRank('glance'));
  assert.ok(levelRank('glance') < levelRank('look'));
  assert.ok(levelRank('look') < levelRank('chase'));
  assert.equal(levelRank('nope'), -1);
});

// ---- 抬头之后的回落（holdSec）----

const stillTrue = { ok: true, still: true };
const stillFalse = { ok: true, still: false };

test('回落：没抬头、或 holdSec=0 时不回', () => {
  assert.equal(shouldFallback({ holding: false, now: 10_000, since: 0, holdSec: 15, still: stillTrue }), false);
  assert.equal(shouldFallback({ holding: true, now: 10_000, since: 0, holdSec: 0, still: stillTrue }), false);
});

test('回落：安静时间没到不回', () => {
  assert.equal(shouldFallback({ holding: true, now: 10_000, since: 5_000, holdSec: 15, still: stillTrue }), false);
  assert.equal(shouldFallback({ holding: true, now: 21_000, since: 5_000, holdSec: 15, still: stillTrue }), true);
});

test('回落：画面还在动 / 判不了就不回', () => {
  assert.equal(shouldFallback({ holding: true, now: 60_000, since: 0, holdSec: 15, still: stillFalse }), false);
  assert.equal(shouldFallback({ holding: true, now: 60_000, since: 0, holdSec: 15, still: null }), false);
  assert.equal(shouldFallback({ holding: true, now: 60_000, since: 0, holdSec: 15, still: { ok: false, reason: 'too-few-frames' } }), false);
});

test('回落：三条都满足才回', () => {
  assert.equal(shouldFallback({ holding: true, now: 60_000, since: 0, holdSec: 15, still: stillTrue }), true);
});
