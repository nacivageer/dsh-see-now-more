import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripForSpeech } from '../src/speech.js';

test('stripForSpeech 去掉加粗与行内 code 的标记', () => {
  assert.equal(stripForSpeech('**加粗** 和 `code`'), '加粗 和 code');
});

test('stripForSpeech 把代码块换成一句提示', () => {
  const src = '前\n```js\nconst a = 1;\n```\n后';
  const out = stripForSpeech(src);
  assert.ok(out.includes('（这里有一段代码）'), out);
  assert.ok(!out.includes('const a'), out);
});

test('stripForSpeech 链接只留文字、列表去前缀', () => {
  assert.equal(stripForSpeech('- [文档](https://x.y)'), '文档');
});

test('stripForSpeech 空输入安全', () => {
  assert.equal(stripForSpeech(''), '');
  assert.equal(stripForSpeech(null), '');
});
