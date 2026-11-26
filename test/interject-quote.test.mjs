/**
 * interject-quote.test.mjs — 带引用的插话怎么交给模型（2026-11-26）。
 *
 * 三个不能破的边界：
 *   ① **没有引用时输出逐字不变** —— 这条几乎是所有浮窗消息共用的说明文字；
 *   ② 引用块原样放最前、**不参与 200 字截断** —— 否则 DSH 主窗只看到一行
 *      `[看屏幕·用户插话] 「> …」`，长引用仍被截掉，等于只在浮窗里有效；
 *   ③ 待回执记的是**正文**，不是整段引用 —— 否则「你还没回」会复读四千字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { interjectNote, splitLeadingQuote, pendingInterjected, __resetInterject } from '../src/interject.js';

// 旧实现（2026-11-26 之前）在没有引用时的完整输出 —— 逐字锁死，防回归。
const OLD_PLAIN = '[看屏幕·用户插话] 「你好」'
  + '\n**先说话，再干活** —— 先回这一句。普通回复悬浮窗里一个字都看不到（也不会被念），只有 `say` 会进那条流。'
  + '下一次调用必须带 `say`：`see_now({ action:"watch", say: "…" })`，'
  + '要同时看一眼直接加在**同一次调用**里（`say` 在采集**之前**就写进流，字先出、画面后到）。';

test('没有引用：输出与旧实现逐字一致', () => {
  __resetInterject();
  assert.equal(interjectNote('你好'), OLD_PLAIN);
  assert.equal(pendingInterjected().text, '你好');
});

test('有引用：引用块原样放最前，说明里的「」只放正文', () => {
  __resetInterject();
  const out = interjectNote('> a\n> b\n\n问题');
  assert.ok(out.startsWith('> a\n> b\n\n[看屏幕·用户插话] 「问题」'), out.slice(0, 80));
  assert.ok(out.endsWith('画面后到）。'));
  assert.equal(pendingInterjected().text, '问题', '待回执只记正文');
});

test('引用不参与 200 字截断；正文仍截到 200', () => {
  __resetInterject();
  const quoted = `> ${'引'.repeat(500)}`;
  const body = '字'.repeat(300);
  const out = interjectNote(`${quoted}\n\n${body}`);
  assert.ok(out.startsWith(`${quoted}\n\n[看屏幕·用户插话]`), '整段引用原样保留');
  assert.ok(out.includes(`「${'字'.repeat(200)}…」`), '正文截到 200 并加省略号');

  // 引用块本身有 4000 兜底（窗口上限也是 4000）
  __resetInterject();
  const huge = `> ${'超'.repeat(5000)}`;
  const out2 = interjectNote(`${huge}\n\n正文`);
  const quotePart = out2.split('\n\n[看屏幕·用户插话]')[0];
  assert.equal(quotePart.length, 4000, '引用的 4000 上限生效');
});

test('只引用不打字：说明写成「用户引用了一段内容」', () => {
  __resetInterject();
  const out = interjectNote('> a\n> b');
  assert.ok(out.startsWith('> a\n> b\n\n[看屏幕·用户插话] 「用户引用了一段内容（见上方引用块）」'));
  assert.equal(pendingInterjected().text, '引用了一段内容');
});

test('splitLeadingQuote：只认开头的引用块，正文中间的 > 不搬走', () => {
  assert.equal(splitLeadingQuote('普通消息'), null);
  assert.deepEqual(splitLeadingQuote('> a\n> b\n\n正文'), { quote: '> a\n> b', rest: '正文' });
  // 4 个前导空格不是引用行（DSH quoteRule 上限 3 个）
  assert.equal(splitLeadingQuote('    > a'), null);
  // 正文里的 > 保持在正文里
  const got = splitLeadingQuote('> a\n\n看这个 > 符号');
  assert.equal(got.quote, '> a');
  assert.equal(got.rest, '看这个 > 符号');
});
