/**
 * text-events.test.mjs — 屏幕文字事件流的闸门（P1 第 1 步）。
 *
 * 全是纯函数：喂内存里的行，不抓屏、不 OCR、不读 DSH_HOME、不碰鼠标。
 * 三条入流规则各一组；另把「确认税」（1 fps + 900 ms → 相邻两帧算两次、单帧不算；2 fps 下要第三帧）
 * 写成测试钉住——`confirmGapMs` 还是临时值，以后调它时会先撞到这几条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEXT_DEFAULTS,
  bigramSim,
  budgetLines,
  contentChars,
  createTextGate,
  normalizeLine,
} from '../src/text-events.js';

/* ---------- 归一化 ---------- */

test('normalizeLine：去空白 / 全角转半角 / 中英标点统一', () => {
  assert.equal(normalizeLine('Ｈｅｌｌｏ，世界！'), 'Hello,世界!');
  assert.equal(normalizeLine(' 你好　世界 '), '你好世界');
  assert.equal(normalizeLine('「测试」……'), '"测试"..');
  assert.equal(normalizeLine('（括号）、顿号。'), '(括号),顿号.');
  assert.equal(normalizeLine(null), '');
  assert.equal(normalizeLine(undefined), '');
  // 幂等：已经归一化的串再归一化不该再变
  const once = normalizeLine('Ａ Ｂ，Ｃ。');
  assert.equal(normalizeLine(once), once);
});

test('contentChars：标点不算字', () => {
  assert.equal(contentChars(normalizeLine('你好，世界！')), 4);
  assert.equal(contentChars(normalizeLine('……')), 0);
  assert.equal(contentChars(normalizeLine('a b-c')), 3);
  assert.equal(contentChars(''), 0);
});

/* ---------- 相似度 ---------- */

test('bigramSim：同一句 1、半句 0.5、认错一个字仍 ≥0.85', () => {
  assert.equal(bigramSim('你好世界', '你好世界'), 1);
  assert.equal(bigramSim('你好', '你好世界'), 0.5);              // 逐字出现的字幕，早版是半句
  assert.equal(bigramSim('好', '好'), 1);
  assert.equal(bigramSim('好', '吗'), 0);                        // 单字只跟自己相等
  assert.equal(bigramSim('', '任何'), 0);
  // 9 个字的句子里认错最后一个字：8 个 bigram 还剩 7 个
  assert.ok(bigramSim('这是第一句测试字幕', '这是第一句测试字慕') >= 0.85);
  assert.ok(bigramSim('今天天气真不错', '明天可能要下雨') < 0.85);
});

/* ---------- 三条入流规则 ---------- */

test('规则①：认到两次才入流，t0 取第一版的时间、t1 = 晚版 + 采样间隔', () => {
  const g = createTextGate();
  assert.equal(g.observe({ t: 0, text: '第一句字幕', conf: 0.9 }).kind, 'pending');
  assert.equal(g.stats().lines, 0);

  const r = g.observe({ t: 2000, text: '第一句字幕', conf: 0.9 });
  assert.equal(r.kind, 'confirmed');
  assert.equal(g.stats().lines, 1);

  const { lines, dropped } = g.between(0, 3000);
  assert.equal(dropped, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '第一句字幕');
  assert.equal(lines[0].t0, 0);         // 字幕出现的时刻，不是确认的时刻
  assert.equal(lines[0].t1, 3000);      // 2000 + sampleMs(1000)
  assert.equal(lines[0].seq, 1);
});

test('确认税：单帧字幕进不来；1 fps 下相邻两帧就算「认到两次」，2 fps 下要第三帧', () => {
  // 只闪不到一秒：只有一帧，凑不出第二版
  const g = createTextGate();
  g.observe({ t: 0, text: '只闪一帧的字幕' });
  g.observe({ t: 6000, text: '后面换了一句完全不同的' });   // 推时间，让候选退休
  assert.equal(g.stats().lines, 0);
  assert.equal(g.stats().unconfirmed, 1);

  // 停一秒（两帧，间隔 1000 ≥ 900）：确认
  const g2 = createTextGate();
  for (const t of [0, 1000]) g2.observe({ t, text: '停一秒的字幕' });
  assert.equal(g2.stats().lines, 1);

  // 2 fps 下相邻两帧只隔 500 ms，不算两次；第三帧到了才算
  const g3 = createTextGate();
  for (const t of [0, 500]) g3.observe({ t, text: '2 fps 下相邻两帧' });
  assert.equal(g3.stats().lines, 0);
  g3.observe({ t: 1000, text: '2 fps 下相邻两帧' });
  assert.equal(g3.stats().lines, 1);
});

test('规则②：间隔够但相似度不够 → 不配对，两条都算未确认', () => {
  const g = createTextGate();
  g.observe({ t: 0, text: '今天天气真不错' });
  g.observe({ t: 2000, text: '明天可能要下雨' });
  assert.equal(g.stats().lines, 0);
  g.observe({ t: 7000, text: '再把时间推过去' });
  assert.equal(g.stats().lines, 0);
  assert.equal(g.stats().unconfirmed, 2);
});

test('规则③：两版取更完整的那版，不是较早那版', () => {
  const g = createTextGate();
  g.observe({ t: 0, text: '这是一句测试字幕', conf: 0.99 });
  g.observe({ t: 2000, text: '这是一句测试字幕啊', conf: 0.5 });
  const { lines } = g.between(0, 3000);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '这是一句测试字幕啊');   // 晚版更完整，字数优先
  assert.equal(lines[0].conf, 0.5);                   // conf 跟着被选中的那一版走
});

test('更完整版同字数时取 conf 高；conf 缺失当最低', () => {
  const g = createTextGate();
  g.observe({ t: 0, text: '这是第一句测试字幕', conf: 0.4 });
  g.observe({ t: 2000, text: '这是第一句测试字慕', conf: 0.9 });   // 认错一个字，字数相同
  const { lines } = g.between(0, 3000);
  assert.equal(lines[0].text, '这是第一句测试字慕');
  assert.equal(lines[0].conf, 0.9);

  const g2 = createTextGate();
  g2.observe({ t: 0, text: '这是第一句测试字幕' });               // 没有 conf
  const r = g2.observe({ t: 2000, text: '这是第一句测试字慕', conf: 0.9 });
  assert.equal(r.kind, 'confirmed');
  assert.equal(r.event.conf, 0.9);

  const g3 = createTextGate();
  g3.observe({ t: 0, text: '两版都没有置信度' });
  const r3 = g3.observe({ t: 2000, text: '两版都没有置信度' });
  assert.equal(r3.kind, 'confirmed');
  assert.equal(r3.event.conf, null);                              // 缺就是 null，不编一个 0
});

test('空行不计数；单字行与「……」按 minChars 挡下', () => {
  const g = createTextGate();
  assert.equal(g.observe({ t: 0, text: '好' }).kind, 'blocked');
  assert.equal(g.observe({ t: 1000, text: '……' }).kind, 'blocked');
  assert.equal(g.observe({ t: 2000, text: '   ' }).kind, 'empty');
  assert.equal(g.observe({ t: 3000, text: '' }).kind, 'empty');
  assert.equal(g.observe({ t: 4000 }).kind, 'empty');
  assert.equal(g.stats().blocked, 2);
  assert.equal(g.stats().lines, 0);
});

/* ---------- 同一行持续出现 ---------- */

test('字幕没换：延长 t1，不产生第二条事件', () => {
  const g = createTextGate();
  g.observe({ t: 0, text: '一直没换的字幕' });
  g.observe({ t: 2000, text: '一直没换的字幕' });      // 确认，t1 = 3000
  const r = g.observe({ t: 3000, text: '一直没换的字幕' });
  assert.equal(r.kind, 'extension');
  assert.equal(r.event.t1, 4000);
  assert.equal(g.stats().lines, 1);

  const { lines } = g.between(0, 5000);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].t1, 4000);
});

test('双语字幕：先出现的那行活得比后出现的久，也不会被拆成两条事件', () => {
  // 上下两行同时在场时，先出现的那行可以比后出现的活得久（t1 反超）。
  // 若按「最新一条已过期就收手」，后来这一行会被当成新事件再入一次流。
  const g = createTextGate();
  const top = '上面那行一直在';
  const low = '下面那行';
  for (let t = 0; t <= 12_000; t += 1000) {
    g.observe({ t, text: top });
    if (t >= 2000 && t <= 5000) g.observe({ t: t + 1, text: low });
  }
  assert.equal(g.stats().lines, 2);
  const { lines } = g.between(0, 20_000);
  assert.equal(lines.length, 2);
  const topLine = lines.find((l) => l.text === top);
  assert.ok(topLine, '一直没换的那行必须在');
  assert.equal(topLine.t1, 13_000);          // 每来一帧都往后延
});

/* ---------- 跨 sheet 去重 ---------- */

test('跨 sheet 去重：两张图的窗口重叠 400/800 ms，同一条字只给一次', () => {
  const g = createTextGate();
  g.observe({ t: 19_000, text: '重叠区里的那句字幕' });
  g.observe({ t: 21_000, text: '重叠区里的那句字幕' });      // t0=19000 t1=22000
  const a = g.between(0, 20_000);
  assert.equal(a.lines.length, 1);
  const b = g.between(19_500, 40_000);                       // 与上一窗重叠 500 ms
  assert.equal(b.lines.length, 0);
  assert.equal(g.stats().deduped, 1);
});

/* ---------- 交付预算 ---------- */

test('预算：14 条只给最新 12 条，从旧的丢', () => {
  const g = createTextGate();
  for (let k = 0; k < 14; k += 1) {
    const t = k * 20_000;
    g.observe({ t, text: `${k}号字幕内容` });
    g.observe({ t: t + 2000, text: `${k}号字幕内容` });
  }
  const { lines, dropped } = g.between(0, 1_000_000);
  assert.equal(lines.length, TEXT_DEFAULTS.maxLines);
  assert.equal(dropped, 2);
  assert.equal(g.stats().dropped, 2);
  assert.equal(lines[0].text, '2号字幕内容');    // 第 0、1 条被丢
  assert.equal(lines[11].text, '13号字幕内容');
});

test('预算：字数超了也从旧的丢，一行就超预算时仍然保留它', () => {
  const g = createTextGate({ maxLines: 99, maxChars: 10 });
  for (let k = 0; k < 5; k += 1) {
    const t = k * 20_000;
    g.observe({ t, text: `${k}abcdefg` });      // 8 个字
    g.observe({ t: t + 2000, text: `${k}abcdefg` });
  }
  const a = g.between(0, 1_000_000);
  assert.equal(a.lines.length, 1);               // 8 + 8 > 10，只装得下一条
  assert.equal(a.dropped, 4);

  const b = budgetLines([{ text: '一行就超过预算的一整句字幕' }], { maxLines: 12, maxChars: 5 });
  assert.equal(b.lines.length, 1);               // 不做截断，宁可超一次预算
  assert.equal(b.dropped, 0);
});

/* ---------- 账 ---------- */

test('stats：六个键与 meta.textStats 同形，seq 单调', () => {
  const g = createTextGate();
  assert.deepEqual(
    Object.keys(g.stats()).sort(),
    ['blocked', 'deduped', 'dropped', 'lines', 'seq', 'unconfirmed'],
  );
  g.observe({ t: 0, text: '第一句字幕' });
  g.observe({ t: 2000, text: '第一句字幕' });
  g.observe({ t: 20_000, text: '第二句字幕' });
  g.observe({ t: 22_000, text: '第二句字幕' });
  const s = g.stats();
  assert.equal(s.lines, 2);
  assert.equal(s.seq, 2);
  const { lines } = g.between(0, 30_000);
  assert.deepEqual(lines.map((l) => l.seq), [1, 2]);
});
