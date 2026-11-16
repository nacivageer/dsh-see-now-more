/**
 * window-line.test.mjs — `windowLine()` 的可见性措辞。
 *
 * 2026-11-17 实见：用户手动关窗后进程已经不在了，status 还写「显示中」——
 * `hidden` 只是配置里的可见性，进程退出后没有意义。这一条守住「进程没了说没在跑」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { windowLine } from '../src/window.js';

const base = {
  pid: 48200, alive: true, heartbeatAgeSec: 1, heartbeatStale: false, hidden: false, disabled: false,
};

test('windowLine：活着 + 新鲜心跳 + 没藏 = 显示中', () => {
  assert.match(windowLine(base), /进程 48200 活着/);
  assert.match(windowLine(base), /显示中/);
});

test('windowLine：进程没了不许说显示中（用户手动关窗后的旧 bug）', () => {
  const line = windowLine({ ...base, alive: false, heartbeatAgeSec: 9, heartbeatStale: true });
  assert.match(line, /已经不在了/);
  assert.match(line, /没在跑/);
  assert.doesNotMatch(line, /显示中/);
});

test('windowLine：进程在但心跳过期 = 没在画，不是显示中', () => {
  const line = windowLine({ ...base, heartbeatAgeSec: 20, heartbeatStale: true });
  assert.match(line, /进程在但没在画/);
  assert.doesNotMatch(line, /显示中/);
});

test('windowLine：活着 + 藏起来 = 明说用户看不见', () => {
  assert.match(windowLine({ ...base, hidden: true }), /藏起来的/);
});

test('windowLine：没开过 / 被环境变量关掉', () => {
  assert.match(windowLine({ ...base, pid: null, alive: false, heartbeatAgeSec: null }), /没开过/);
  assert.match(windowLine({ ...base, disabled: true }), /DSH_SEE_NO_WINDOW/);
});
