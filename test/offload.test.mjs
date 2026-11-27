/**
 * offload.test.mjs — 图库自动省略（`~/.dsh/see-now.json` 的 `imageTrigger` / `imageKeep`）。
 *
 * 这条线有三块要紧，其余是细节：
 *
 *  1. **算得对不对**：`planOffload` 必须算出「哪些 seq 的第几张图该省略」。真正的
 *     `session.append('image/offload', …)` 会被宿主按当前 surface 严格校验（seq 还在 surface 上、
 *     index 严格递增、不能重复省略），算错一个就是硬错。
 *  2. **攒批**：涨到触发线才动手、一次省到留底 —— "每张都触发"不会报任何错，
 *     只会让前缀缓存每轮全废，所以必须有用例盯着。
 *  3. **退化**：宿主没有 `image/offload` 的解释器时只报数、不省略、不崩（`status` 说清楚）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFLOAD_DEFAULTS, OFFLOAD_THROTTLE_MS,
  alreadyOffloaded, applyOffload, createOffloadScheduler, imagesIn, isMissingCapability,
  offloadLine, planOffload, planOffloadWithTrigger, replaySurface,
} from '../src/offload.js';
import { TUNING_DEFAULTS, readTuning } from '../src/tuning.js';

const img = (id) => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${String(id).padStart(64, '0')}`, bytes: 1024 },
});

/** 一条 user/message；`surfaceOp` 传 'append' 或 replace 对象 */
const msg = (seq, images, surfaceOp = 'append') => ({
  type: 'user/message',
  seq,
  data: { role: 'user', content: images.map((v) => img(v)) },
  surfaceOp,
});

/** 一条 tool/result —— 本插件的图**从这里**进历史（工具返回值） */
const toolMsg = (seq, images, surfaceOp = 'append') => ({
  type: 'tool/result',
  seq,
  data: { message: { role: 'tool', content: images.map((v) => img(v)) } },
  surfaceOp,
});

/** 造 N 张、每条消息一张的连续历史 */
const chain = (n) => Array.from({ length: n }, (_, i) => msg(i + 1, [i + 1]));

const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- planOffload（留几张）

test('保留最近 N 张：前面的被省略，后面的不动', () => {
  const plan = planOffload([msg(1, [1]), msg(2, [2]), msg(3, [3]), msg(4, [4])], { keep: 2 });
  assert.equal(plan.total, 4);
  assert.equal(plan.offloading, 2);
  assert.equal(plan.kept, 2);
  assert.deepEqual(plan.targets, [
    { seq: 1, imageIndexes: [0] },
    { seq: 2, imageIndexes: [0] },
  ]);
});

test('一条消息里多张图：按 seq 分组，index 递增', () => {
  const plan = planOffload([msg(1, [1, 2, 3]), msg(2, [4, 5])], { keep: 1 });
  assert.deepEqual(plan.targets, [
    { seq: 1, imageIndexes: [0, 1, 2] },
    { seq: 2, imageIndexes: [0] },
  ]);
  assert.equal(plan.kept, 1);
});

test('keep 大于总数：一张都不省；keep=0：能省的全省', () => {
  assert.deepEqual(planOffload([msg(1, [1]), msg(2, [2])], { keep: 100 }).targets, []);
  const all = planOffload([msg(1, [1, 2]), msg(2, [3])], { keep: 0 });
  assert.equal(all.offloading, 3);
  assert.equal(all.kept, 0);
});

test('tool/result 里的图也算（宿主允许这两种载体）', () => {
  const events = [toolMsg(1, [1]), msg(2, [2])];
  assert.deepEqual(planOffload(events, { keep: 1 }).targets, [{ seq: 1, imageIndexes: [0] }]);
});

test('只数 content 顶层：嵌套 content 里的图不算 —— 宿主就是这么编号的', () => {
  // 宿主的 `offloadMessageImages` 只看 message.content 这一层；这里多算一个下标，
  // append 时就会指到不存在的图（或指错图）。这个用例盯的就是"和宿主同一种数法"。
  const content = [
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { attachmentId: 'sha256:a' } },
    { type: 'tool-call', content: [{ type: 'image', attachment: { attachmentId: 'sha256:b' } }] },
    { type: 'image', attachment: { attachmentId: 'sha256:c' } },
  ];
  assert.deepEqual(imagesIn(content).map((x) => x.index), [0, 1]);
});

test('已经省略过的跳过，不会重复标记', () => {
  const events = [
    msg(1, [1]),
    msg(2, [2]),
    { type: 'image/offload', seq: 3, data: { targets: [{ seq: 1, imageIndexes: [0] }] } },
  ];
  const plan = planOffload(events, { keep: 1 });
  assert.equal(plan.total, 1); // seq1 已省，只剩 seq2
  assert.equal(plan.offloading, 0);
  assert.deepEqual([...alreadyOffloaded(events)], ['1:0']);
});

test('块上带 offloaded 标记的也跳过（有些版本的投影已经写进事件）', () => {
  const events = [{
    type: 'user/message',
    seq: 1,
    data: { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:x' }, offloaded: true }] },
    surfaceOp: 'append',
  }, msg(2, [2])];
  const plan = planOffload(events, { keep: 0 });
  assert.deepEqual(plan.targets, [{ seq: 2, imageIndexes: [0] }], '只剩没标的第 2 张');
});

test('被 replace 遮蔽的图不算进历史', () => {
  const events = [
    msg(1, [1]),
    msg(2, [2]),
    msg(3, [], { op: 'replace', startSeq: 1, endSeq: 1 }),
    msg(4, [3]),
  ];
  const plan = planOffload(events, { keep: 1 });
  assert.equal(plan.total, 2);
  assert.deepEqual(plan.targets, [{ seq: 2, imageIndexes: [0] }]);
  assert.deepEqual(replaySurface(events).map((n) => n.seq), [2, 3, 4]);
});

test('非 surface 事件（turn/*、compaction/*）直接忽略', () => {
  const events = [
    { type: 'compaction/start', seq: 1, data: {} },
    msg(2, [1]),
    { type: 'turn/start', seq: 3, data: {} },
  ];
  const plan = planOffload(events, { keep: 0 });
  assert.equal(plan.total, 1);
  assert.deepEqual(plan.targets, [{ seq: 2, imageIndexes: [0] }]);
});

// ---------------------------------------------------------------- 触发线 / 留底

test('触发线以下不动手：4 张 / 触发 5 留 2 → 不触发', () => {
  assert.equal(planOffloadWithTrigger(chain(4), { trigger: 5, keep: 2 }).triggered, false);
});

test('刚过留底数（3 张）也不动手 —— 这是"别每次都重算"的核心', () => {
  for (const n of [2, 3, 4]) {
    assert.equal(planOffloadWithTrigger(chain(n), { trigger: 5, keep: 2 }).triggered, false, `n=${n}`);
  }
});

test('涨到触发线才动手，一次省到留底：5 张 → 省 3 留 2', () => {
  const r = planOffloadWithTrigger(chain(5), { trigger: 5, keep: 2 });
  assert.equal(r.triggered, true);
  assert.equal(r.plan.offloading, 3);
  assert.equal(r.plan.kept, 2);
});

test('省完之后再攒到触发线才触发下一次（不会每张都触发）', () => {
  const events = [
    ...chain(5),
    {
      type: 'image/offload',
      seq: 6,
      data: { targets: chain(5).slice(0, 3).map((m) => ({ seq: m.seq, imageIndexes: [0] })) },
    },
  ];
  // 现在只剩 2 张：再加 2 张仍不触发（total=4），加到 3 张（total=5）才触发
  for (let extra = 0; extra <= 2; extra += 1) {
    const more = [...events, ...Array.from({ length: extra }, (_, i) => msg(100 + i, [100 + i]))];
    assert.equal(planOffloadWithTrigger(more, { trigger: 5, keep: 2 }).triggered, false, `extra=${extra}`);
  }
  const full = [...events, msg(200, [200]), msg(201, [201]), msg(202, [202])];
  const r = planOffloadWithTrigger(full, { trigger: 5, keep: 2 });
  assert.equal(r.triggered, true);
  assert.equal(r.plan.offloading, 3);
});

test('trigger=0：关掉，永不触发', () => {
  assert.equal(planOffloadWithTrigger(chain(5000), { trigger: 0, keep: 100 }).triggered, false);
});

test('keep >= trigger：不触发（配错了不许"一触发就白省"）', () => {
  assert.equal(planOffloadWithTrigger(chain(500), { trigger: 5, keep: 5 }).triggered, false);
  assert.equal(planOffloadWithTrigger(chain(500), { trigger: 5, keep: 9 }).triggered, false);
});

// ---------------------------------------------------------------- applyOffload

test('applyOffload：没有 targets 时什么都不写（不发空事件）', async () => {
  const appended = [];
  const r = await applyOffload({ append: (t, d) => appended.push([t, d]) }, [], null);
  assert.equal(r.ok, true);
  assert.equal(appended.length, 0);
});

test('applyOffload：写事件 + flush；flush 失败不算失败（事件已在内存里）', async () => {
  const appended = [];
  let flushed = 0;
  const r = await applyOffload(
    { append: (t, d) => appended.push([t, d]) },
    [{ seq: 1, imageIndexes: [0] }],
    { flush: async () => { flushed += 1; } },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(appended, [['image/offload', { targets: [{ seq: 1, imageIndexes: [0] }] }]]);
  assert.equal(flushed, 1);

  const r2 = await applyOffload({ append: () => {} }, [{ seq: 1, imageIndexes: [0] }],
    { flush: async () => { throw new Error('disk full'); } });
  assert.equal(r2.ok, true);
});

test('applyOffload：宿主的校验错误要变成 ok:false，不能炸穿调用方', async () => {
  const r = await applyOffload(
    { append: () => { throw new Error('image/offload: target seq 9 is not a current surface node'); } },
    [{ seq: 9, imageIndexes: [0] }],
    null,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /surface node/);
});

test('isMissingCapability：只认宿主"缺解释器"那一句', () => {
  assert.equal(isMissingCapability(
    'session event "image/offload" requires a message projection; load its owning plugin or supply its projection definition',
  ), true);
  assert.equal(isMissingCapability('image/offload: target seq 9 is not a current surface node'), false);
  assert.equal(isMissingCapability(''), false);
});

// ---------------------------------------------------------------- 调度器（交付后那一段）

/** 假上下文：一个会话、`append` 记账；`events` 就是它的会话日志 */
function fakeCtx({ events, append } = {}) {
  const written = [];
  const flushed = [];
  const session = {
    snapshotEvents: () => events,
    append: (type, data) => {
      written.push({ type, data });
      if (append) append(type, data);
    },
  };
  const ctx = {
    get(key) {
      if (key === 'sessionController') return { resolveAgent: async () => ({ agent: { session } }) };
      if (key === 'sessions') return { flush: async () => { flushed.push(1); } };
      return null;
    },
  };
  return { ctx, session, written, flushed };
}

test('交付后：排一个定时器，跑了就写 image/offload（5 张 → 省 3 留 2）', async () => {
  const { ctx, written } = fakeCtx({ events: chain(5) });
  const sched = createOffloadScheduler({ ctx, readConfig: () => ({ imageTrigger: 5, imageKeep: 2 }) });
  try {
    assert.deepEqual(sched.afterDelivery('session-A'), { scheduled: true });
    await tick();
    assert.equal(written.length, 1);
    assert.equal(written[0].type, 'image/offload');
    assert.deepEqual(written[0].data.targets, [
      { seq: 1, imageIndexes: [0] },
      { seq: 2, imageIndexes: [0] },
      { seq: 3, imageIndexes: [0] },
    ]);
    assert.equal(sched.state().capability, 'ok');
    assert.equal(sched.state().lastPlan.offloading, 3);
  } finally {
    sched.dispose();
  }
});

test('节流按会话记：同一会话 30 秒内只查一次，另一个会话照查', async () => {
  let clock = 1_000_000;
  const { ctx, written } = fakeCtx({ events: chain(5) });
  const sched = createOffloadScheduler({
    ctx, readConfig: () => ({ imageTrigger: 5, imageKeep: 2 }), now: () => clock,
  });
  try {
    assert.equal(sched.afterDelivery('A').scheduled, true);
    await tick();
    assert.equal(written.length, 1);

    clock += OFFLOAD_THROTTLE_MS - 1;
    assert.equal(sched.afterDelivery('A').scheduled, false, '同一会话还在节流窗口里');
    assert.equal(sched.afterDelivery('B').scheduled, true, '别的会话不受 A 的窗口影响');
    await tick();
    assert.equal(written.length, 2);

    clock += 1;
    assert.equal(sched.afterDelivery('A').scheduled, true, '窗口过了就能再查');
    await tick();
    assert.equal(written.length, 3);
  } finally {
    sched.dispose();
  }
});

test('trigger=0：交付后根本不排（关掉整件事）', async () => {
  const { ctx, written } = fakeCtx({ events: chain(50) });
  const sched = createOffloadScheduler({ ctx, readConfig: () => ({ imageTrigger: 0, imageKeep: 2 }) });
  try {
    assert.deepEqual(sched.afterDelivery('A'), { scheduled: false, reason: 'disabled' });
    await tick();
    assert.equal(written.length, 0);
  } finally {
    sched.dispose();
  }
});

test('宿主没有 image/offload：记成 missing，之后不再试、也不抛', async () => {
  const { ctx, written } = fakeCtx({
    events: chain(5),
    append: () => { throw new Error('session event "image/offload" requires a message projection; load its owning plugin or supply its projection definition'); },
  });
  const sched = createOffloadScheduler({ ctx, readConfig: () => ({ imageTrigger: 5, imageKeep: 2 }) });
  try {
    sched.afterDelivery('A');
    await tick();
    assert.equal(sched.state().capability, 'missing');
    assert.equal(written.length, 1, '第一次试过（宿主拒了）');

    const again = await sched.runNow('A');
    assert.deepEqual(again, { ok: false, skipped: 'no-capability' });
    assert.equal(written.length, 1, '知道没有能力之后不再写');
    // status 那行要能说清楚，而不是天天报一条失败
    const line = offloadLine({ sheets: 3, config: { imageTrigger: 5, imageKeep: 2 }, state: sched.state() });
    assert.match(line, /宿主没有 image\/offload/);
  } finally {
    sched.dispose();
  }
});

test('keep >= trigger：拒绝干活并留一句原因（配置写坏了要说出来）', async () => {
  const { ctx, written } = fakeCtx({ events: chain(50) });
  const sched = createOffloadScheduler({ ctx, readConfig: () => ({ imageTrigger: 5, imageKeep: 5 }) });
  try {
    const r = await sched.runNow('A');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'keep>=trigger');
    assert.equal(written.length, 0);
    assert.match(sched.state().lastError, /imageKeep/);
    assert.match(offloadLine({ sheets: 1, config: { imageTrigger: 5, imageKeep: 5 }, state: sched.state() }), /省略配置无效/);
  } finally {
    sched.dispose();
  }
});

test('dispose 之后不再写：还没跑的定时器要被清掉', async () => {
  const { ctx, written } = fakeCtx({ events: chain(5) });
  const sched = createOffloadScheduler({ ctx, readConfig: () => ({ imageTrigger: 5, imageKeep: 2 }) });
  sched.afterDelivery('A');
  sched.dispose();
  assert.deepEqual(sched.afterDelivery('A'), { scheduled: false, reason: 'disposed' });
  await tick();
  assert.equal(written.length, 0);
});

test('拿不到会话：不崩、不写，留一句原因', async () => {
  const ctx = {
    get(key) {
      if (key === 'sessionController') return { resolveAgent: async () => ({ error: new Error('session-404 不在了') }) };
      return null;
    },
  };
  const sched = createOffloadScheduler({ ctx, readConfig: () => ({ imageTrigger: 5, imageKeep: 2 }) });
  try {
    const r = await sched.runNow('A');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'resolve-failed');
    assert.match(sched.state().lastError, /不在了/);
  } finally {
    sched.dispose();
  }
});

test('读会话日志抛错：变成 no-events，不往外抛（自动路径上没人接）', async () => {
  const ctx = {
    get(key) {
      if (key === 'sessionController') {
        return { resolveAgent: async () => ({ agent: { session: { snapshotEvents: () => { throw new Error('log 坏了'); } } } }) };
      }
      return null;
    },
  };
  const sched = createOffloadScheduler({ ctx, readConfig: () => ({ imageTrigger: 5, imageKeep: 2 }) });
  try {
    const r = await sched.runNow('A');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-events');
    assert.match(sched.state().lastError, /log 坏了/);
  } finally {
    sched.dispose();
  }
});

// ---------------------------------------------------------------- status 那行

test('offloadLine：没出过图且没事 → 不占字', () => {
  assert.equal(offloadLine(), '');
  assert.equal(offloadLine({ sheets: 0, config: { imageTrigger: 300, imageKeep: 100 }, state: {} }), '');
});

test('offloadLine：出过图就报数，并把省略状态说清楚', () => {
  const config = { imageTrigger: 300, imageKeep: 100 };
  const normal = offloadLine({ sheets: 12, config, state: { capability: 'unknown' } });
  assert.match(normal, /^图库：本次采集出 12 张/);
  assert.match(normal, /涨到 300 张省到 100 张/);

  assert.match(offloadLine({ sheets: 3, config: { imageTrigger: 0, imageKeep: 100 }, state: {} }), /省略关/);
  assert.match(
    offloadLine({ sheets: 3, config: { imageTrigger: 5, imageKeep: 5 }, state: {} }),
    /省略配置无效/,
  );
  const failed = offloadLine({ sheets: 3, config, state: { lastError: 'target seq 9 is not a current surface node' } });
  assert.match(failed, /上次失败/);
  assert.match(failed, /surface node/);
});

// ---------------------------------------------------------------- 配置层

test('配置层：默认 300 / 100，读得进来，坏值退回并 warn', () => {
  const env = { DSH_HOME: '/nonexistent-see-now-test' };
  assert.equal(OFFLOAD_DEFAULTS.imageTrigger, 300);
  assert.equal(OFFLOAD_DEFAULTS.imageKeep, 100);
  assert.equal(TUNING_DEFAULTS.imageTrigger, 300, '配置默认必须是 300');
  assert.equal(TUNING_DEFAULTS.imageKeep, 100, '配置默认必须是 100');

  const dflt = readTuning({ env });
  assert.equal(dflt.imageTrigger, 300);
  assert.equal(dflt.imageKeep, 100);

  const good = readTuning({ env, readFile: () => JSON.stringify({ imageTrigger: 5, imageKeep: 2 }) });
  assert.equal(good.imageTrigger, 5);
  assert.equal(good.imageKeep, 2);
  assert.deepEqual(good.warnings, []);

  const off = readTuning({ env, readFile: () => JSON.stringify({ imageTrigger: 0 }) });
  assert.equal(off.imageTrigger, 0, '0 = 关掉，必须读得进来');

  for (const bad of [{ imageTrigger: -1 }, { imageTrigger: '很多' }, { imageTrigger: 5000 }, { imageKeep: -3 }]) {
    const r = readTuning({ env, readFile: () => JSON.stringify(bad) });
    assert.ok(r.warnings.some((w) => w.includes('image')), `${JSON.stringify(bad)} 应该有一条 warn`);
  }

  const invalid = readTuning({ env, readFile: () => JSON.stringify({ imageTrigger: 10, imageKeep: 10 }) });
  assert.equal(invalid.imageTrigger, 10, '不夹配置：报出来，不悄悄改数');
  assert.equal(invalid.imageKeep, 10);
  assert.ok(invalid.warnings.some((w) => w.includes('imageKeep')), 'keep >= trigger 要 warn');
});
