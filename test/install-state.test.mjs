/**
 * install-state.test.mjs — profile 副本五态判定（extras 安全三件套之一）。
 *
 * 纯函数，不读盘：absent / foreign / broken / stale / current 各一条，
 * 外加「name 对但入口丢了」与「版本对但 name 不对」两个边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyInstall, describeInstall, INSTALL_STATES } from '../scripts/install-state.mjs';

const base = {
  exists: true,
  name: 'dsh-see-now-more',
  version: '0.1.1-more.14',
  repoVersion: '0.1.1-more.14',
  entryExists: true,
};

test('五态：absent / foreign / broken / stale / current', () => {
  assert.equal(classifyInstall({ ...base, exists: false }), 'absent');
  assert.equal(classifyInstall({ ...base, name: 'dsh-see-now' }), 'foreign');
  assert.equal(classifyInstall({ ...base, entryExists: false }), 'broken');
  assert.equal(classifyInstall({ ...base, version: '0.1.1-more.13' }), 'stale');
  assert.equal(classifyInstall(base), 'current');
  assert.deepEqual([...INSTALL_STATES].sort(), ['absent', 'broken', 'current', 'foreign', 'stale']);
});

test('版本读不到算 broken，不是 stale', () => {
  assert.equal(classifyInstall({ ...base, version: null }), 'broken');
  assert.equal(classifyInstall({ ...base, version: '' }), 'broken');
});

test('name 优先于版本：别人的同名包就是 foreign', () => {
  assert.equal(classifyInstall({ ...base, name: 'other', version: '0.0.1' }), 'foreign');
});

test('expectedName 可换（旧包卸载路径复用同一判定）', () => {
  assert.equal(classifyInstall({ ...base, name: 'dsh-see-now', expectedName: 'dsh-see-now' }), 'current');
  assert.equal(classifyInstall({ ...base, name: 'dsh-see-now', expectedName: 'dsh-see-now', version: '1.0.0' }), 'stale');
});

test('describeInstall 每种状态都有人话，不把状态码直接丢给用户', () => {
  for (const state of INSTALL_STATES) {
    const text = describeInstall(state);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 6, `${state} 的解释太短：${text}`);
    assert.ok(!text.includes('undefined'), `${state} 的解释里出现 undefined`);
  }
  assert.match(describeInstall('stale', { version: '0.1.1-more.13', repoVersion: '0.1.1-more.14' }), /0\.1\.1-more\.13/);
});
