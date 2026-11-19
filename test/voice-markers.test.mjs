/**
 * SAPI / DeepSeek 适配器的语音标记解析（2026-11-20）。
 *
 * 为什么测：`say` 的契约在 `tool-spec.js`，标记却由每个适配器各自兑现。2026-11-20
 * 查出一处失配 —— SAPI 的 SSML 触发条件只有 `**` / `‖` / `~`，单独一个 `〔顺〕`
 * 不触发 SSML，重读静默失效；`【急】` 还会原样进合成文本。这里把两个适配器的
 * 「文本 → 要念的东西」钉住，避免下次改标记时又只有一边跟上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareSpeech, toSsml } from '../examples/voice-sapi-win.mjs';
import { textForTts } from '../examples/voice-deepseek-tts.mjs';

test('SAPI：〔…〕 与 【…】 都是重读段，且单独出现就触发 SSML', () => {
  for (const marker of ['〔顺〕', '【顺】']) {
    const p = prepareSpeech(`要一直${marker}时针搅拌药水`);
    assert.match(p.ssml, /<prosody rate="\+0%" volume="loud">顺<\/prosody>/);
    assert.match(p.ssml, /rate="\+10%">要一直<\/prosody>/);
    assert.equal(p.text, '要一直顺时针搅拌药水');
  }
});

test('SAPI：换气口与拖音仍然进 SSML', () => {
  const p = prepareSpeech('你知道…的成就‖是什么吗？');
  assert.match(p.ssml, /<break time="200ms"\/>/);
  assert.equal(p.text, '你知道…的成就，是什么吗？');

  const t = prepareSpeech('哎呀~这里这么黑~');
  assert.match(t.ssml, /rate="x-slow"/);
  assert.equal(t.text, '哎呀这里这么黑');
});

test('SAPI：情绪前缀只改语速，并从正文里剥掉', () => {
  const fast = prepareSpeech('【急】哇，小心！');
  assert.equal(fast.text, '哇，小心！');
  assert.match(fast.ssml, /rate="\+15%"/);
  assert.ok(!fast.ssml.includes('【'));

  const soft = prepareSpeech('【柔】唉，没事的。');
  assert.equal(soft.text, '唉，没事的。');
  assert.match(soft.ssml, /rate="-8%"/);
});

test('SAPI：没有标记时不生成 SSML（走 Speak 那条纯文本路径）', () => {
  const p = prepareSpeech('普通的一句话');
  assert.equal(p.ssml, '');
  assert.equal(p.text, '普通的一句话');
});

test('SAPI：toSsml 把加粗直接剥掉（加粗只排版）', () => {
  const ssml = toSsml('**重点**和普通');
  assert.ok(!ssml.includes('**'));
  assert.match(ssml, /重点和普通/);
});

test('DeepSeek：送合成前剥掉所有标记，加粗不再折成停顿', () => {
  assert.equal(textForTts('要一直〔顺〕时针‖然后~'), '要一直顺时针，然后');
  assert.equal(textForTts('要一直【顺】时针'), '要一直顺时针');
  assert.equal(textForTts('【急】哇，小心！'), '哇，小心！');
  assert.equal(textForTts('**重点**'), '重点');
});
