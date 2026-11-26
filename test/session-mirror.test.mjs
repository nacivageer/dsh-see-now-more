/**
 * session-mirror.test.mjs — 浮窗镜像主窗用户消息的判据层与核心（2026-11-26）。
 *
 * 这条线的风险不在"能不能显示"，而在四件看不见的事：
 *   ① 判据放宽 → 卡片按钮 / 插件自己的叫醒混进浮窗；
 *   ② 去重失效 → 回填把同一句灌两遍（重启 / 换绑都会触发）；
 *   ③ 水位推进错 → 用户在浮窗删掉的话被回填复活；
 *   ④ 写失败仍推水位 → 丢一条永远补不回来。
 *
 * 所以这里全部按**落盘结果**测：读 `chat.jsonl` 的条目、读 `session-mirror.json`
 * 的水位，不测内部变量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendChat, chatFile, isFloatUserEntry, pendingStartupEntries } from '../src/chat.js';
import { isTypedUserMessage } from '../src/human.js';
import {
  BACKFILL_LIMIT, MAX_TEXT, createSessionMirror, mirrorPaths, mirrorTextOf, readMirrorWatermark,
} from '../src/mirror.js';

const NOW = 1_800_000_000_000;

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'see-now-mirror-'));
  return { DSH_HOME: home };
}

function chatEntries(env) {
  try {
    return readFileSync(chatFile(env), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const userEvent = (seq, text, { at = NOW - 60_000 + seq, kind = 'user' } = {}) => ({
  type: 'user/message',
  seq,
  time: at,
  data: { id: `m${seq}`, content: [{ type: 'text', text }], source: { kind } },
});

const ctxWith = (readSession) => ({
  get: (key) => (key === 'sessionQuery' ? { readSession } : null),
});

test('isTypedUserMessage：只认用户亲手打的，卡片 / 插件 / 模型都不算', () => {
  assert.equal(isTypedUserMessage(userEvent(1, 'hi')), true);
  // 少数宿主不带 data 包一层
  assert.equal(isTypedUserMessage({ type: 'user/message', source: { kind: 'user' } }), true);
  for (const kind of ['action-cards', 'see-now', 'model', 'tool', '']) {
    assert.equal(isTypedUserMessage(userEvent(1, 'hi', { kind })), false, `kind=${kind}`);
  }
  assert.equal(isTypedUserMessage({ type: 'user/message', data: { source: {} } }), false, '没有 kind');
  // 类型不对 / 形状不全一律 false，不抛
  assert.equal(isTypedUserMessage({ ...userEvent(1, 'hi'), type: 'assistant/message' }), false);
  for (const ev of [null, undefined, {}, { type: 'user/message' }, { type: 'user/message', data: null }]) {
    assert.equal(isTypedUserMessage(ev), false);
  }
});

test('isFloatUserEntry：origin=dsh 的镜像条目不是"浮窗里说的"', () => {
  assert.equal(isFloatUserEntry({ role: 'user', text: 'x' }), true);
  assert.equal(isFloatUserEntry({ role: 'user', text: 'x', origin: 'dsh' }), false);
  assert.equal(isFloatUserEntry({ role: 'assistant', origin: 'dsh' }), false);
  assert.equal(isFloatUserEntry(null), false);
});

test('mirrorTextOf：多块拼接 / 只有图片写 [图片] / 空跳过 / 超长截断', () => {
  const ev = (content) => ({ type: 'user/message', seq: 1, data: { content, source: { kind: 'user' } } });
  assert.equal(mirrorTextOf(ev([{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }])), '第一行\n第二行');
  assert.equal(mirrorTextOf(ev([{ type: 'image', source: {} }])), '[图片]');
  assert.equal(mirrorTextOf(ev([{ type: 'text', text: '  ' }, { type: 'image' }])), '[图片]');
  assert.equal(mirrorTextOf(ev([{ type: 'text', text: '   ' }])), '');
  assert.equal(mirrorTextOf(ev([])), '');
  assert.equal(mirrorTextOf(null), '');

  const long = '字'.repeat(MAX_TEXT + 10);
  const clipped = mirrorTextOf(ev([{ type: 'text', text: long }]));
  assert.equal(clipped.length, MAX_TEXT + 1, '截到 3000 再加一个省略号');
  assert.ok(clipped.endsWith('…'));
});

test('appendChat：sid / at / mid / origin 原样落盘，旧调用不受影响', () => {
  const env = sandbox();
  const entry = appendChat('user', ' 主窗的话 ', {
    sid: 'session-test', at: NOW - 5, mid: 'session-test:7', origin: 'dsh', env,
  });
  assert.equal(entry.text, '主窗的话');
  const [onDisk] = chatEntries(env);
  assert.deepEqual(onDisk, { role: 'user', text: '主窗的话', at: NOW - 5, sid: 'session-test', mid: 'session-test:7', origin: 'dsh' });
  // 空文本不写
  assert.equal(appendChat('user', '   ', { env }), null);
});

test('pendingStartupEntries：镜像条目跳过但不停，浮窗消息才补投', () => {
  const raw = [
    { role: 'user', text: '主窗旧话', origin: 'dsh', at: NOW },
    { role: 'assistant', text: '回一句', at: NOW },
    { role: 'user', text: '主窗又说', origin: 'dsh', at: NOW },
    { role: 'user', text: '浮窗这句', at: NOW },
    { role: 'notice', text: '提示', at: NOW },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';

  assert.deepEqual(pendingStartupEntries(raw).map((e) => e.text), ['浮窗这句']);
  // 早于 cutoff 的浮窗消息不投（10 分钟窗口）
  const old = JSON.stringify({ role: 'user', text: '十分钟前', at: NOW - 11 * 60 * 1000 });
  assert.deepEqual(pendingStartupEntries(`${old}\n`, { cutoff: NOW - 10 * 60 * 1000 }), []);
});

test('onEvent：写入一条带 origin/mid 的条目；重复事件不写第二遍', () => {
  const env = sandbox();
  const mirror = createSessionMirror({ env, now: () => NOW });
  const ev = userEvent(7, '同步测试 A', { at: NOW - 1234 });

  assert.equal(mirror.onEvent('session-test', ev), true);
  assert.equal(mirror.onEvent('session-test', ev), false, '同一个 mid 第二次进来必须挡住');

  const entries = chatEntries(env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[0].text, '同步测试 A');
  assert.equal(entries[0].at, NOW - 1234, '时间戳用会话事件时间，不用收到时间');
  assert.equal(entries[0].sid, 'session-test');
  assert.equal(entries[0].mid, 'session-test:7');
  assert.equal(entries[0].origin, 'dsh');

  assert.equal(readMirrorWatermark(env).sids['session-test'].throughSeq, 7);
});

test('onEvent：非用户消息 / 没绑定 / 开关关掉都不写', () => {
  const env = sandbox();
  const mirror = createSessionMirror({ env, now: () => NOW });
  assert.equal(mirror.onEvent('session-test', userEvent(1, 'hi', { kind: 'action-cards' })), false);
  assert.equal(mirror.onEvent(null, userEvent(1, 'hi')), false);
  assert.equal(mirror.onEvent('session-test', { type: 'assistant/message', seq: 2, data: {} }), false);
  assert.equal(chatEntries(env).length, 0);

  const offEnv = sandbox();
  const off = createSessionMirror({ env: offEnv, now: () => NOW, config: { users: false, backfill: false } });
  assert.equal(off.onEvent('session-test', userEvent(1, 'hi')), false);
  assert.equal(chatEntries(offEnv).length, 0);
});

test('onEvent：写盘失败不推水位（下一拍还能重试）', () => {
  const home = mkdtempSync(join(tmpdir(), 'see-now-mirror-broken-'));
  // 把 see-now 目录占成文件：mkdir / append 必失败
  writeFileSync(join(home, 'see-now'), 'not a dir', 'utf8');
  const env = { DSH_HOME: home };
  const mirror = createSessionMirror({ env, now: () => NOW });
  assert.equal(mirror.onEvent('session-test', userEvent(3, '写不进去')), false);
  assert.equal(readMirrorWatermark(env).sids['session-test'], undefined, '失败不许推水位');
});

test('backfill：跳过 fork 继承前缀 / 卡片 / 旧消息 / 水位之前的，按 seq 写入', async () => {
  const env = sandbox();
  const events = [
    userEvent(0, '继承前缀', { at: NOW - 1000 }),       // seq < inheritedEventCount
    userEvent(1, '继承前缀2', { at: NOW - 1000 }),
    userEvent(2, '旧消息', { at: NOW - 40 * 24 * 3600 * 1000 }), // 30 天外
    userEvent(3, '卡片', { at: NOW - 1000, kind: 'action-cards' }),
    { type: 'assistant/message', seq: 4, time: NOW - 1000, data: { message: { content: [] } } },
    userEvent(5, '第一句', { at: NOW - 2000 }),
    userEvent(6, '第二句', { at: NOW - 1000 }),
  ];
  const mirror = createSessionMirror({
    env, now: () => NOW,
    ctx: ctxWith(async () => ({ events, inheritedEventCount: 2 })),
  });
  const r = await mirror.backfill({ sid: 'session-test', reason: 'test' });
  assert.equal(r.written, 2);
  assert.deepEqual(chatEntries(env).map((e) => e.text), ['第一句', '第二句']);
  assert.equal(readMirrorWatermark(env).sids['session-test'].throughSeq, 6);
});

test('backfill：扫完没有可写的也把水位推到最后一条 seq（避免每次重扫）', async () => {
  const env = sandbox();
  const events = [
    { type: 'assistant/message', seq: 8, time: NOW, data: {} },
    { type: 'tool/result', seq: 9, time: NOW, data: {} },
  ];
  const mirror = createSessionMirror({ env, now: () => NOW, ctx: ctxWith(async () => ({ events })) });
  await mirror.backfill({ sid: 'session-test' });
  assert.equal(chatEntries(env).length, 0);
  assert.equal(readMirrorWatermark(env).sids['session-test'].throughSeq, 9);
});

test('backfill 幂等：连跑两次不重复；启动扫 chat.jsonl 尾部 mid 也挡住重复', async () => {
  const env = sandbox();
  const events = [userEvent(1, '一'), userEvent(2, '二')];
  const make = () => createSessionMirror({ env, now: () => NOW, ctx: ctxWith(async () => ({ events })) });

  const first = make();
  assert.equal((await first.backfill({ sid: 'session-test' })).written, 2);
  assert.equal((await make().backfill({ sid: 'session-test' })).written, 0, '水位挡住第二次');

  // 模拟「写成功但水位没落盘」：水位清零，靠启动扫 mid 挡住
  writeFileSync(mirrorPaths(env).watermark, JSON.stringify({ v: 1, sids: {} }), 'utf8');
  const again = make();
  assert.equal((await again.backfill({ sid: 'session-test' })).written, 0);
  assert.equal(chatEntries(env).length, 2);
});

test('backfill：只回填最近 500 条（更早的跳过，但水位照常越过）', async () => {
  const env = sandbox();
  const events = [];
  for (let i = 1; i <= BACKFILL_LIMIT + 5; i += 1) events.push(userEvent(i, `第${i}条`, { at: NOW - 1000 + i }));
  const mirror = createSessionMirror({ env, now: () => NOW, ctx: ctxWith(async () => ({ events })) });
  const r = await mirror.backfill({ sid: 'session-test' });
  assert.equal(r.written, BACKFILL_LIMIT);
  const texts = chatEntries(env).map((e) => e.text);
  assert.equal(texts[0], '第6条', '最早 5 条被 500 上限挤掉');
  assert.equal(texts.at(-1), `第${BACKFILL_LIMIT + 5}条`);
  assert.equal(readMirrorWatermark(env).sids['session-test'].throughSeq, BACKFILL_LIMIT + 5);
});

test('backfill：没有 sessionQuery / 会话读失败 → 只记日志，不抛、不动水位', async () => {
  const env = sandbox();
  const noService = createSessionMirror({ env, now: () => NOW, ctx: {} });
  assert.deepEqual(await noService.backfill({ sid: 'session-test' }), { written: 0, skipped: 'no-service' });

  const boom = createSessionMirror({
    env, now: () => NOW, ctx: ctxWith(async () => { throw new Error('读盘失败'); }),
  });
  const r = await boom.backfill({ sid: 'session-test' });
  assert.equal(r.written, 0);
  assert.match(r.error, /读盘失败/);
  assert.equal(readMirrorWatermark(env).sids['session-test'], undefined);
});

test('水位文件最多记 50 个会话（按最近更新排）', () => {
  const env = sandbox();
  let t = NOW;
  const mirror = createSessionMirror({ env, now: () => (t += 1) });
  for (let i = 0; i < 55; i += 1) mirror.onEvent(`session-${i}`, userEvent(i + 1, `第${i}句`));
  const sids = readMirrorWatermark(env).sids;
  assert.equal(Object.keys(sids).length, 50);
  assert.equal(sids['session-0'], undefined, '最早的 5 个被挤掉');
  assert.ok(sids['session-54']);
});
