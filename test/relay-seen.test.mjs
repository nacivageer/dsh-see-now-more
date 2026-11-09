/**
 * relay 投递的两条回归（2026-11-08 实报）：
 *
 * ① `deliveryMode`：**只有会话真在跑回合时才 steer**。打在空闲会话上的 steer 会被
 *    宿主起成一个空回合、立刻 `blocked`，话到不了模型，回执却写 `ok`。
 * ② `relay-delivered.json`：三个消费者（watch / loop / relay）投完都要记一笔，
 *    否则插件重载时启动补投会把同一句再投一遍。
 *
 * 这两条错了都不会报错，只会让用户看到「已送达但没反应」和「我没说话它又醒了」，
 * 所以按行为测：判据 → 落盘 → 换一个模块实例（模拟插件重载）还认得。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { markRelaySeen, relaySeenHas, relaySeenFile } from '../src/chat.js';
import { deliveryMode } from '../src/timer.js';

/** 每个用例一份独立的 DSH_HOME：`relaySeenSet` 按 chatDir 缓存，不能互相串。 */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'see-now-seen-'));
  return { DSH_HOME: home };
}

test('deliveryMode：在跑回合才插话，空闲 / 未知一律排队', () => {
  assert.equal(deliveryMode({ running: true }), 'steer');
  assert.equal(deliveryMode({ running: false }), 'followup');
  // 状态未知（插件中途加载、还没见过 turn/start）不能赌，按空闲处理
  assert.equal(deliveryMode({}), 'followup');
  assert.equal(deliveryMode(), 'followup');
  assert.equal(deliveryMode({ running: 'running' }), 'followup', '只认布尔 true');
});

test('markRelaySeen：落盘、可查、重启（新模块实例）还认得', async () => {
  const env = sandbox();
  assert.equal(relaySeenHas('1794150309048', env), false, '没记过就是没记过');

  assert.equal(markRelaySeen('1794150309048', env), true);
  assert.equal(relaySeenHas('1794150309048', env), true);

  // 文件格式保持 relay 一直以来的样子：字符串数组
  const onDisk = JSON.parse(readFileSync(relaySeenFile(env), 'utf8'));
  assert.deepEqual(onDisk, ['1794150309048']);

  // 换一个模块实例 = 插件重载后重新读盘；磁盘上的记录必须还在
  const fresh = await import(`../src/chat.js?reload=${Date.now()}`);
  assert.equal(fresh.relaySeenHas('1794150309048', env), true);
  assert.equal(fresh.relaySeenHas('1794150309049', env), false);
});

test('markRelaySeen：没有 at 的不记（不能写进 "undefined" 把去重变成永真）', () => {
  const env = sandbox();
  assert.equal(markRelaySeen(undefined, env), false);
  assert.equal(markRelaySeen('', env), false);
  assert.equal(relaySeenHas(undefined, env), false);
});

test('relay-delivered.json 只留最近 200 条', () => {
  const env = sandbox();
  for (let i = 0; i < 205; i += 1) markRelaySeen(String(1794150000000 + i), env);
  const onDisk = JSON.parse(readFileSync(relaySeenFile(env), 'utf8'));
  assert.equal(onDisk.length, 200);
  assert.equal(onDisk[0], '1794150000005', '最早的 5 条该被挤掉');
  assert.equal(onDisk.at(-1), '1794150000204');
  assert.equal(relaySeenHas('1794150000000', env), false);
  assert.equal(relaySeenHas('1794150000204', env), true);
});
