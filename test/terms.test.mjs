import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTerms, loadTermRules, TERM_MIN_FROM } from '../src/terms.js';

const readOf = (text) => () => text;

test('applyTerms：按表替换，没命中就原样返回', () => {
  const rules = [{ from: '心之极玉', to: '心之集域' }];
  assert.equal(applyTerms('这是心之极玉的727天', rules), '这是心之集域的727天');
  assert.equal(applyTerms('没有错字的一句', rules), '没有错字的一句');
  assert.equal(applyTerms('', rules), '');
  assert.equal(applyTerms('甲', null), '甲');
});

test('applyTerms：长串优先，短串不会先拆掉长串', () => {
  const rules = loadTermRules('/x', {
    readFile: readOf(JSON.stringify([
      { from: '极玉', to: '坏掉' },
      { from: '心之极玉', to: '心之集域' },
    ])),
  });
  assert.equal(applyTerms('心之极玉', rules), '心之集域');
});

test('loadTermRules：单字规则、空 to、from===to 都被丢掉', () => {
  const rules = loadTermRules('/x', {
    readFile: readOf(JSON.stringify([
      { from: '生', to: '身' },
      { from: '甲乙', to: '' },
      { from: '丙丁', to: '丙丁' },
      { from: '丽丽', to: '莉莉' },
    ])),
  });
  assert.deepEqual(rules.map((r) => r.from), ['丽丽']);
  assert.ok(TERM_MIN_FROM >= 2);
});

test('loadTermRules：文件不存在 / 坏 JSON / 空表都返回空数组，不抛', () => {
  assert.deepEqual(loadTermRules('/nope', { readFile: () => { throw new Error('ENOENT'); } }), []);
  assert.deepEqual(loadTermRules('/bad', { readFile: readOf('{oops') }), []);
  assert.deepEqual(loadTermRules('/empty', { readFile: readOf('{"rules":[]}') }), []);
});

test('loadTermRules：直接给数组也认', () => {
  const rules = loadTermRules('/x', { readFile: readOf(JSON.stringify([{ from: '甲甲', to: '乙乙' }])) });
  assert.equal(rules.length, 1);
});
