/**
 * human-message.test.mjs — 「这条会话事件算不算人说话」（上游 0.2.4 / #69 的判据）。
 *
 * 这条线的全部风险都在**误判**上，两头都是坏的：
 *
 *   - 把插件自己投的提词（`kind: 'see-now'`）算成人说话 → `wakesSinceUser` 永远归零，
 *     「连续 N 次叫醒没人理」那条兜底线等于没写，循环会一直空叫；
 *   - 把真正的用户消息漏掉 → 用户在主窗口聊了十几分钟，循环照样收工（修之前的样子）。
 *
 * 所以下面把宿主可能发出来的几种 `source.kind` 逐个钉住，并且**明确断言探针/脚本
 * （没有 source）不算** —— 宁可少续命一次，也不要把机器生成的文字当成人。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isHumanMessage, isSelfMessage } from '../src/human.js';

const msg = (kind, extra = {}) => ({
  type: 'user/message',
  data: { source: kind === undefined ? {} : { kind }, ...extra },
});

test('宿主 UI / 卡片按钮发出的消息算人', () => {
  assert.equal(isHumanMessage(msg('user')), true, 'ACP bridge 的 user');
  assert.equal(isHumanMessage(msg('action-cards')), true, '用户点了卡片按钮');
});

test('插件自己投的提词不算人（这条是防回归的重点）', () => {
  assert.equal(isHumanMessage(msg('see-now')), false);
  assert.equal(isSelfMessage(msg('see-now')), true, '反过来也要认得出是自己');
});

test('其它 kind 一律不算：机器生成的东西不许给人续命', () => {
  for (const kind of ['assistant', 'tool', 'scheduler', 'relay', 'test', '']) {
    assert.equal(isHumanMessage(msg(kind)), false, `kind=${kind}`);
  }
  // 没有 source（探针 / 脚本注进来的）也不算
  assert.equal(isHumanMessage(msg(undefined)), false);
});

test('类型不对不算：别的会话事件就算带 source.kind=user 也不认', () => {
  for (const type of ['assistant/message', 'session/title', 'session/turn-end', '']) {
    assert.equal(isHumanMessage({ ...msg('user'), type }), false, `type=${type}`);
  }
});

test('事件形状不全时不许抛', () => {
  for (const ev of [null, undefined, {}, { type: 'user/message' }, { type: 'user/message', data: null }]) {
    assert.equal(isHumanMessage(ev), false);
  }
  // 字段在顶层（少数宿主实现不带 data 包一层）也认
  assert.equal(isHumanMessage({ type: 'user/message', source: { kind: 'user' } }), true);
});
