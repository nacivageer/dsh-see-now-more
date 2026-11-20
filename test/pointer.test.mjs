/**
 * `action:"pointer"` 的纯函数测试：参数校验、截断/夹取、开关。
 *
 * 不 spawn python——真画圈要靠 `scripts/pointer-smoke.mjs` 人工点验（屏幕上的东西断言不了）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_LABEL, MAX_RADIUS, MAX_WAIT_MS, MIN_RADIUS, MIN_WAIT_MS,
  pointAndWait, pointerEnabled, pointerScript, validatePointerArgs,
} from '../src/pointer.js';

function tmpEnv(cfg) {
  const home = mkdtempSync(join(tmpdir(), 'pointer-test-'));
  if (cfg) writeFileSync(join(home, 'see-now.json'), JSON.stringify(cfg), 'utf8');
  return { DSH_HOME: home };
}

test('合法参数原样通过，默认值补齐', () => {
  const r = validatePointerArgs({ x: 100, y: 200, label: ' 点这里 ' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, {
    x: 100, y: 200, label: '点这里', shape: 'circle', wait: 'click', waitMs: 20000, radius: 60,
  });
});

test('x / y 必填且是整数，负数拒绝', () => {
  assert.equal(validatePointerArgs({ label: 'a' }).ok, false);
  assert.equal(validatePointerArgs({ x: 1.5, y: 2, label: 'a' }).ok, false);
  assert.equal(validatePointerArgs({ x: -1, y: 2, label: 'a' }).reason, 'bad-args');
});

test('label 必填、超长截断', () => {
  assert.equal(validatePointerArgs({ x: 1, y: 1 }).ok, false);
  assert.equal(validatePointerArgs({ x: 1, y: 1, label: '   ' }).ok, false);
  const r = validatePointerArgs({ x: 1, y: 1, label: '字'.repeat(MAX_LABEL + 10) });
  assert.equal(r.args.label.length, MAX_LABEL);
});

test('shape / wait 只接受枚举', () => {
  assert.equal(validatePointerArgs({ x: 1, y: 1, label: 'a', shape: 'star' }).ok, false);
  assert.equal(validatePointerArgs({ x: 1, y: 1, label: 'a', wait: 'forever' }).ok, false);
});

test('waitMs / radius 被夹进上下限', () => {
  const lo = validatePointerArgs({ x: 1, y: 1, label: 'a', waitMs: 1, radius: 1 });
  assert.equal(lo.args.waitMs, MIN_WAIT_MS);
  assert.equal(lo.args.radius, MIN_RADIUS);
  const hi = validatePointerArgs({ x: 1, y: 1, label: 'a', waitMs: 1e9, radius: 999 });
  assert.equal(hi.args.waitMs, MAX_WAIT_MS);
  assert.equal(hi.args.radius, MAX_RADIUS);
});

test('开关默认关：没配置、配置里 false、env=1 才算开', () => {
  assert.equal(pointerEnabled(tmpEnv(null)), false);
  assert.equal(pointerEnabled(tmpEnv({ pointer: { enabled: false } })), false);
  assert.equal(pointerEnabled(tmpEnv({ pointer: { enabled: true } })), true);
  assert.equal(pointerEnabled({ DSH_HOME: tmpdir(), DSH_SEE_POINTER: '1' }), true);
});

test('没开时 pointAndWait 直接拒，且不去找 python', async () => {
  const r = await pointAndWait({ x: 10, y: 10, label: '点这里' }, { env: tmpEnv(null) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
});

test('圈图脚本就在悬浮窗脚本旁边', () => {
  // pointer.py 与 window.py 同目录（pick_region.py 的先例：同步不会覆盖我们自己的脚本）
  assert.match(pointerScript(), /examples[\\/]floating-chat[\\/]pointer\.py$/);
});
