/**
 * hangup.test.mjs — 「关窗」立的硬闸，必须有一个显式的出口。
 *
 * 2026-11-19 对上游 release notes 时核出来的：`window` + `show:true` 只改了
 * `hidden`，没解除挂断；用户按提示再调裸 `watch` 仍被 `guardReason` 拦成
 * `hung-up`（只有显式传 source 能过）。这条守住"显式显示 = 出口"。
 *
 * `DSH_HOME` 指到临时目录：`createRunner()` 会读 `~/.dsh` 的调参，`hangUp()`
 * 还会顺带 teardown，不能碰真实的运行数据（同 runner-lift.test.mjs）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-hangup-'));

const { createRunner, guardReason } = await import('../src/runner.js');

test('clearHangUp：没有挂断时不报 changed', () => {
  const runner = createRunner({ log: () => {} });
  assert.equal(runner.isHungUp(), false);
  assert.deepEqual(runner.clearHangUp('测试'), { changed: false, hungUp: false });
});

test('clearHangUp：挂断之后解除，裸 watch 不再被 hung-up 拦', () => {
  const runner = createRunner({ log: () => {} });
  runner.hangUp();
  assert.equal(runner.isHungUp(), true);
  assert.equal(guardReason({ hungUp: true }), 'hung-up');

  const r = runner.clearHangUp('window show:true');
  assert.deepEqual(r, { changed: true, hungUp: false });
  assert.equal(runner.isHungUp(), false);
  assert.equal(guardReason({ hungUp: runner.isHungUp() }), null);
});
