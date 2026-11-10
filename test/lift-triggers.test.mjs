/**
 * lift-triggers.js 的单测（P0，纯函数）。
 *
 * 重点不是"词表里每个词都命中"，而是四条边界：
 *   强/弱分档、同句 30 秒去重（含跨窗口）、会话内邀约不算、没命中不伪造档位。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchLiftTriggers, LIFT_DEDUPE_MS } from '../src/lift-triggers.js';

const u = (text, startMs, extra = {}) => ({ text, startMs, endMs: startMs + 2000, ...extra });

test('强词 → glance，理由里带命中的词', () => {
  for (const word of ['你看这个镜头', '你看，那边', '快看这个', '卧槽', '等一下，别动']) {
    const { level, hits } = matchLiftTriggers([u(word, 0)]);
    assert.equal(level, 'glance', word);
    assert.equal(hits.length, 1, word);
    assert.match(hits[0].reason, /强触发词/);
  }

  // 「你看这个」比「你看」更具体，理由应该写长的那个
  const { hits } = matchLiftTriggers([u('你看这个镜头', 0)]);
  assert.match(hits[0].reason, /你看这个/);
});

test('名字由调用方给：不传就不认，传了才算直呼', () => {
  const line = '梁月，这个交给你';
  assert.equal(matchLiftTriggers([u(line, 0)]).hits.length, 0);

  const { level, hits } = matchLiftTriggers([u(line, 0)], { names: ['梁月'] });
  assert.equal(level, 'glance');
  assert.match(hits[0].reason, /直呼名字「梁月」/);
});

test('单个惊叹词 → alarm；夹在句子中间的「啊」不算', () => {
  for (const line of ['啊？', '诶诶', '嗯……', '哦']) {
    const { level, hits } = matchLiftTriggers([u(line, 0)]);
    assert.equal(level, 'alarm', line);
    assert.equal(hits.length, 1, line);
  }

  assert.equal(matchLiftTriggers([u('今天天气啊挺不错的', 0)]).hits.length, 0);
});

test('无指代短问句 → alarm；带指代/人称的不算', () => {
  const { level, hits } = matchLiftTriggers([u('真的吗？', 0)]);
  assert.equal(level, 'alarm');
  assert.match(hits[0].reason, /短问句/);

  for (const line of ['这个？', '你说什么？', '他怎么了？']) {
    assert.equal(matchLiftTriggers([u(line, 0)]).hits.length, 0, line);
  }
});

test('会话内邀约不进小表：没有命中时 level 是 null，不是 alarm', () => {
  const { level, hits } = matchLiftTriggers([u('我的游戏已经开好了，你随时可以来。', 0)]);
  assert.equal(hits.length, 0);
  assert.equal(level, null);
});

test('同句 30 秒内只报一次，过了窗口可以再报', () => {
  const { hits } = matchLiftTriggers([
    u('你看这个', 0),
    u('你看这个', 20_000),
    u('你看这个', LIFT_DEDUPE_MS + 1000),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].startMs, 0);
  assert.equal(hits[1].startMs, LIFT_DEDUPE_MS + 1000);
});

test('跨窗口不重复报：上一轮的 hits 通过 seen 递回来', () => {
  const first = matchLiftTriggers([u('你看这个', 10_000)]);
  assert.equal(first.hits.length, 1);

  // 下一轮滑窗又带上了同一句（晚 5 秒进窗），加上一句新的
  const second = matchLiftTriggers(
    [u('你看这个', 10_000), u('快看那边', 15_000)],
    { seen: first.hits },
  );
  assert.equal(second.hits.length, 1);
  assert.equal(second.hits[0].startMs, 15_000);
});

test('一句话最多一条：强词和弱词同时出现时报强的', () => {
  const { level, hits } = matchLiftTriggers([u('你看这个，啊', 0)]);
  assert.equal(level, 'glance');
  assert.equal(hits.length, 1);
});

test('乱序输入按 startMs 排好再报', () => {
  const { hits } = matchLiftTriggers([
    u('快看这个', 50_000),
    u('你看这个', 10_000),
  ]);
  assert.deepEqual(hits.map((h) => h.startMs), [10_000, 50_000]);
});

test('跳过没有 startMs / 文本为空的条目，不猜时间', () => {
  const { hits } = matchLiftTriggers([
    { text: '你看这个' },
    { text: '   ', startMs: 1000 },
    u('快看', 2000),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].startMs, 2000);
});

test('空输入 / 非法输入返回空结果，不抛', () => {
  for (const input of [[], undefined, null, '不是数组']) {
    const r = matchLiftTriggers(input);
    assert.deepEqual(r, { level: null, hits: [] });
  }
});

test('词表可换：给 opts.words 就按它认，不读 see-now.json', () => {
  const { level } = matchLiftTriggers([u('注意，前面有东西', 0)], {
    words: { strong: ['注意'] },
  });
  assert.equal(level, 'glance');

  // 多字弱词默认不认，传进去才认
  assert.equal(matchLiftTriggers([u('哎哟', 0)]).hits.length, 0);
  assert.equal(matchLiftTriggers([u('哎哟', 0)], { words: { weak: ['哎哟'] } }).level, 'alarm');
});
