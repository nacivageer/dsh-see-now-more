import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripForSpeech, splitEmphasis } from '../src/speech.js';

test('stripForSpeech 保留加粗标记、去掉行内 code 的反引号', () => {
  assert.equal(stripForSpeech('**加粗** 和 `code`'), '**加粗** 和 code');
});

test('splitEmphasis 切出加粗段与普通段', () => {
  assert.deepEqual(splitEmphasis('前**重点**后'), [
    { text: '前', strong: false },
    { text: '重点', strong: true },
    { text: '后', strong: false },
  ]);
  assert.deepEqual(splitEmphasis('没有加粗'), [{ text: '没有加粗', strong: false }]);
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
