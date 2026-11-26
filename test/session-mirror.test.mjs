/**
 * session-mirror.test.mjs — 浮窗镜像主窗消息的判据层与核心（2026-11-26）。
 *
 * 这条线的风险不在"能不能显示"，而在四件看不见的事：
 *   ① 判据放宽 → 卡片按钮 / 插件自己的叫醒混进浮窗；
 *   ② 去重失效 → 回填把同一句灌两遍（重启 / 换绑都会触发）；
 *   ③ 水位推进错 → 用户在浮窗删掉的话被回填复活；
 *   ④ 写失败仍推水位 → 丢一条永远补不回来。
 *
 * `.31` 起 model 正文也走这条流（关窗也写、回填另用一条游标），多两个坑：
 *   ⑤ 旧条目没有 `mid` → 回填把 live 写过的正文再写一遍；
 *   ⑥ 回填的正文遮断启动补投 → 真没投出去的浮窗消息不补了。
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
import { markRelayInjectedId } from '../src/timer.js';
import {
  BACKFILL_LIMIT, MAX_TEXT, assistantTextOf, createSessionMirror, mirrorPaths, mirrorTextOf,
  pushAssistantText, readMirrorWatermark,
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

/** 模型正文事件：形状照真实会话日志（`data.message.content` 块数组）。 */
const assistantEvent = (seq, text, { at = NOW - 60_000 + seq } = {}) => ({
  type: 'assistant/message',
  seq,
  time: at,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
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

test('mirrorTextOf：图片引用附件对象；图文按原顺序；对象不在退回 [图片]', () => {
  const env = sandbox();
  const hex = 'a'.repeat(64);
  const objDir = join(env.DSH_HOME, 'attachments', 'v1', 'objects', hex.slice(0, 2));
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, hex), 'not-a-real-png-but-a-file', 'utf8');

  const img = (id) => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', width: 10, height: 10 } });
  const ev = (content) => ({ type: 'user/message', seq: 1, data: { content, source: { kind: 'user' } } });

  const both = mirrorTextOf(ev([img(`sha256:${hex}`), { type: 'text', text: '看图' }]), env);
  assert.match(both, /^!\[图片\]\(C:.*a{64}\)\n看图$/, '图片在前、正文在后，路径是附件对象');

  // 纯图片：一张 markdown，不再是 [图片] 占位
  assert.match(mirrorTextOf(ev([img(`sha256:${hex}`)]), env), /^!\[图片\]\(C:.*\)$/);

  // 对象不在 / 不是 sha256 存储：退回占位
  assert.equal(mirrorTextOf(ev([img(`sha256:${'b'.repeat(64)}`)]), env), '[图片]');
  assert.equal(mirrorTextOf(ev([img('attachment-123')]), env), '[图片]');
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

test('relay 代用户投的消息不镜像（live 与回填都跳过）', async () => {
  const env = sandbox();
  const relayId = 'relay-msg-0001';
  markRelayInjectedId(relayId, env);
  const ev = userEvent(9, '浮窗发的话');
  ev.data.id = relayId;

  const live = createSessionMirror({ env, now: () => NOW });
  assert.equal(live.onEvent('session-test', ev), false);
  assert.equal(chatEntries(env).length, 0, '窗口自己已经写过这条，不许镜像回灌');

  // 重启后回填：id 落在 relay-user-ids.json 里，也要跳过
  const bf = createSessionMirror({
    env, now: () => NOW, ctx: ctxWith(async () => ({ events: [ev] })),
  });
  const r = await bf.backfill({ sid: 'session-test' });
  assert.equal(r.written, 0);
  assert.equal(chatEntries(env).length, 0);
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

// ---------------------------------------------------------------- .31 模型正文

test('assistantTextOf：只拼 text 块 / 纯工具轮为空 / 超长截断', () => {
  const ev = (content) => ({ type: 'assistant/message', seq: 1, data: { message: { content } } });
  assert.equal(
    assistantTextOf(ev([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }])),
    '第一段\n第二段',
  );
  // reasoning / tool-call 不搬（真实日志里 203 条 assistant 有 50 条是纯工具轮）
  assert.equal(assistantTextOf(ev([{ type: 'reasoning', text: '想' }, { type: 'tool-call' }])), '');
  assert.equal(assistantTextOf(ev([{ type: 'text', text: '  ' }])), '');
  assert.equal(assistantTextOf({ type: 'user/message', data: {} }), '');
  assert.equal(assistantTextOf(null), '');

  const long = '字'.repeat(MAX_TEXT + 10);
  const clipped = assistantTextOf(ev([{ type: 'text', text: long }]));
  assert.equal(clipped.length, MAX_TEXT + 1);
  assert.ok(clipped.endsWith('…'));
});

test('onAssistant：窗没开也写，带 sid/at/mid/origin；同一 seq 不写第二遍', () => {
  const env = sandbox();
  const mirror = createSessionMirror({ env, now: () => NOW });
  const ev = assistantEvent(4, '模型回的话', { at: NOW - 4321 });

  assert.equal(mirror.onAssistant('session-test', ev).ok, true);
  assert.equal(mirror.onAssistant('session-test', ev).ok, false, '同一个 seq 第二次进来必须挡住');

  const entries = chatEntries(env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, 'assistant');
  assert.equal(entries[0].text, '模型回的话');
  assert.equal(entries[0].at, NOW - 4321, '时间戳用会话事件时间');
  assert.equal(entries[0].sid, 'session-test');
  assert.equal(entries[0].mid, 'session-test:4');
  assert.equal(entries[0].origin, 'dsh');
  assert.equal(readMirrorWatermark(env).sids['session-test'].assistantThroughSeq, 4);
});

test('onAssistant：say 覆盖过的正文不写第二遍，也不推错游标', () => {
  const env = sandbox();
  const mirror = createSessionMirror({ env, now: () => NOW });
  const ev = assistantEvent(6, '看这里\n\n后面还有解释', { at: NOW - 1000 });
  const r = mirror.onAssistant('session-test', ev, { said: { text: '看这里', at: NOW - 5000 } });
  assert.equal(r.ok, false);
  assert.equal(r.skip, 'said');
  assert.equal(chatEntries(env).length, 0, 'say 已经写过这句，不再来一条');
  assert.equal(readMirrorWatermark(env).sids['session-test'].assistantThroughSeq, 6, '跳过也要越过 seq');

  // 两分钟以外的不算覆盖（和 live 同口径）
  const far = assistantEvent(8, '看这里\n\n正文', { at: NOW - 400_000 });
  assert.equal(mirror.onAssistant('session-test', far, { said: { text: '看这里', at: NOW - 600_000 } }).ok, true);
});

test('onAssistant：空正文 / 没绑定 / 开关关掉都不写；空轮也推进游标', () => {
  const env = sandbox();
  const mirror = createSessionMirror({ env, now: () => NOW });
  assert.equal(mirror.onAssistant('session-test', assistantEvent(5, '')).ok, false);
  assert.equal(chatEntries(env).length, 0);
  assert.equal(readMirrorWatermark(env).sids['session-test'].assistantThroughSeq, 5, '空轮越过，别每次重扫');

  assert.equal(mirror.onAssistant(null, assistantEvent(6, 'hi')).ok, false);
  assert.equal(mirror.onAssistant('session-test', userEvent(7, 'hi')).ok, false);

  const offEnv = sandbox();
  const off = createSessionMirror({ env: offEnv, now: () => NOW, config: { users: false } });
  assert.equal(off.onAssistant('session-test', assistantEvent(9, 'hi')).ok, false);
  assert.equal(chatEntries(offEnv).length, 0);
});

test('backfill：模型正文走独立游标 —— 在最后一条 user 之前也补得到', async () => {
  const env = sandbox();
  // 旧版只有用户游标：live 时用户游标已被 seq 5 的 user 推走，assistant seq 2 当时窗没开
  mkdirSync(join(env.DSH_HOME, 'see-now'), { recursive: true });
  writeFileSync(mirrorPaths(env).watermark, JSON.stringify({
    v: 1, sids: { 'session-test': { throughSeq: 5, updated: NOW } },
  }), 'utf8');
  const events = [
    userEvent(1, '主窗第一句'),
    assistantEvent(2, '当时没窗，模型回的话', { at: NOW - 3000 }),
    userEvent(5, '主窗第二句'),
  ];
  const mirror = createSessionMirror({
    env, now: () => NOW, ctx: ctxWith(async () => ({ events })),
  });
  const r = await mirror.backfill({ sid: 'session-test' });
  assert.equal(r.written, 1);
  assert.equal(r.assistants, 1);
  assert.deepEqual(chatEntries(env).map((e) => [e.role, e.text]), [['assistant', '当时没窗，模型回的话']]);
  assert.equal(readMirrorWatermark(env).sids['session-test'].throughSeq, 5, '用户游标不动');
  assert.equal(readMirrorWatermark(env).sids['session-test'].assistantThroughSeq, 5);
});

test('backfill：旧 assistant 条目（没有 mid）同文 10 秒内不重复写', async () => {
  const env = sandbox();
  // 旧版 live 写在事件当口（at = Date.now），没有 mid / origin
  appendChat('assistant', '回一句', { env, sid: 'session-test', at: NOW - 500 });
  const events = [assistantEvent(2, '回一句', { at: NOW - 1000 })];
  const mirror = createSessionMirror({ env, now: () => NOW, ctx: ctxWith(async () => ({ events })) });
  const r = await mirror.backfill({ sid: 'session-test' });
  assert.equal(r.written, 0);
  assert.equal(chatEntries(env).length, 1);
  assert.equal(readMirrorWatermark(env).sids['session-test'].assistantThroughSeq, 2, '去重也要越过 seq');
});

test('backfill：被 say 覆盖的正文不重复写，不同内容照写', async () => {
  const env = sandbox();
  appendChat('assistant', '看这里', { env, sid: 'session-test', at: NOW - 3000 });   // say 气泡
  const events = [
    assistantEvent(2, '看这里\n\n后面还有正文', { at: NOW - 1000 }),
    assistantEvent(4, '另一句完全不同的回复', { at: NOW - 800 }),
  ];
  const mirror = createSessionMirror({ env, now: () => NOW, ctx: ctxWith(async () => ({ events })) });
  const r = await mirror.backfill({ sid: 'session-test' });
  assert.equal(r.written, 1);
  assert.deepEqual(chatEntries(env).map((e) => e.text), ['看这里', '另一句完全不同的回复']);
});

test('backfill：assistant 也只取最近 500 条', async () => {
  const env = sandbox();
  const events = [];
  for (let i = 1; i <= BACKFILL_LIMIT + 5; i += 1) {
    events.push(assistantEvent(i, `第${i}条回复`, { at: NOW - 1000 + i }));
  }
  const mirror = createSessionMirror({ env, now: () => NOW, ctx: ctxWith(async () => ({ events })) });
  const r = await mirror.backfill({ sid: 'session-test' });
  assert.equal(r.written, BACKFILL_LIMIT);
  const texts = chatEntries(env).map((e) => e.text);
  assert.equal(texts[0], '第6条回复', '最早 5 条被 500 上限挤掉');
  assert.equal(texts.at(-1), `第${BACKFILL_LIMIT + 5}条回复`);
});

test('backfill 幂等：模型正文连跑两次不重复；清游标后靠 mid 也挡住', async () => {
  const env = sandbox();
  const events = [assistantEvent(2, '只回一次', { at: NOW - 1000 })];
  const make = () => createSessionMirror({ env, now: () => NOW, ctx: ctxWith(async () => ({ events })) });

  assert.equal((await make().backfill({ sid: 'session-test' })).written, 1);
  assert.equal((await make().backfill({ sid: 'session-test' })).written, 0, '游标挡住第二次');

  writeFileSync(mirrorPaths(env).watermark, JSON.stringify({ v: 1, sids: {} }), 'utf8');
  assert.equal((await make().backfill({ sid: 'session-test' })).written, 0, 'mid 扫描挡住');
  assert.equal(chatEntries(env).length, 1);
});

test('pushAssistantText：窗关着也写、不朗读；窗开着才念；say 覆盖的不写不念', () => {
  const env = sandbox();
  const mirror = createSessionMirror({ env, now: () => NOW });
  const spoken = [];

  // 窗关着：必须写，但不朗读（关窗时排进语音队列只会在下次开窗补念旧话）
  const r1 = pushAssistantText(mirror, assistantEvent(4, '关窗时的话', { at: NOW - 1000 }), {
    sid: 'session-test', alive: false, speak: (t) => spoken.push(t),
  });
  assert.equal(r1.ok, true);
  assert.equal(chatEntries(env).length, 1, '窗关着也要写');
  assert.deepEqual(spoken, []);

  // 窗开着：写 + 念一次
  const r2 = pushAssistantText(mirror, assistantEvent(6, '开窗时的话', { at: NOW - 500 }), {
    sid: 'session-test', alive: true, speak: (t) => spoken.push(t),
  });
  assert.equal(r2.ok, true);
  assert.deepEqual(spoken, ['开窗时的话']);

  // say 已经写过这句：不写第二遍、也不念
  const r3 = pushAssistantText(mirror, assistantEvent(8, '看这里\n\n正文', { at: NOW - 200 }), {
    sid: 'session-test', alive: true, said: { text: '看这里', at: NOW - 1000 },
    speak: (t) => spoken.push(t),
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.skip, 'said');
  assert.equal(spoken.length, 1);
  assert.equal(chatEntries(env).length, 2);

  // 不是 assistant/message 一律不碰
  assert.equal(pushAssistantText(mirror, userEvent(10, 'hi'), { sid: 'session-test' }).ok, false);
});

test('live 写过的正文，重启后回填不再写一遍', async () => {
  const env = sandbox();
  const events = [
    userEvent(1, '问题', { at: NOW - 2000 }),
    assistantEvent(2, '回答', { at: NOW - 1000 }),
  ];
  const live = createSessionMirror({ env, now: () => NOW });
  assert.equal(live.onEvent('session-test', events[0]), true);
  assert.equal(live.onAssistant('session-test', events[1]).ok, true);
  assert.equal(chatEntries(env).length, 2);

  const restarted = createSessionMirror({
    env, now: () => NOW, ctx: ctxWith(async () => ({ events })),
  });
  const r = await restarted.backfill({ sid: 'session-test' });
  assert.equal(r.written, 0, '两条游标都挡住了');
  assert.deepEqual(chatEntries(env).map((e) => [e.role, e.text]), [['user', '问题'], ['assistant', '回答']]);
});

test('pendingStartupEntries：镜像的模型正文跳过但不停，浮窗的回复仍然停', () => {
  const raw = [
    { role: 'user', text: '浮窗这句', at: NOW },
    { role: 'assistant', text: '会话里的回复', origin: 'dsh', at: NOW + 1 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  assert.deepEqual(pendingStartupEntries(raw).map((e) => e.text), ['浮窗这句'],
    '镜像回复不是"这条浮窗消息有人回了"的证据');

  const raw2 = [
    { role: 'user', text: '浮窗这句', at: NOW },
    { role: 'assistant', text: '浮窗自己的回复', at: NOW + 1 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  assert.deepEqual(pendingStartupEntries(raw2), [], '真正的回复仍然停住补投');
});
