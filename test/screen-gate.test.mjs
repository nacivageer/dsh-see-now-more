/**
 * screen-gate.test.mjs — 「屏幕读取总开关」（档 B）与「关窗后」四档。
 *
 * 这一条的性质和别的配置项不一样：它不是一个"改完下次生效"的调参，而是
 * **用户侧的硬闸**。所以测的不是"值存进去了没有"，而是三条：
 *
 * 1. 关掉之后 `watch` / `start` / `peek` 一律被拒，**连显式来源也不行**；
 * 2. **模型没有入口能打开它** —— 只有悬浮窗的设置卡；
 * 3. 没配 `onWindowClose` 时行为与 0.1.1-more.26 完全一致（默认收工）。
 *
 * `DSH_HOME` 指到临时目录：`createRunner()` 会读 `~/.dsh` 的调参，
 * 拒绝路径虽然不该碰采集，但 `status()` / `peek()` 会顺手读窗和留底的状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-gate-'));

const { createRunner, guardReason } = await import('../src/runner.js');
const { readTuning, TUNING_DEFAULTS, WINDOW_CLOSE_MODES } = await import('../src/tuning.js');
const { seeNowToolSpec } = await import('../src/tool-spec.js');

// ---------------------------------------------------------------- 纯函数

test('总开关：disabled 压过「显式来源」，也压过挂断与文件放完', () => {
  assert.equal(guardReason({ disabled: true }), 'disabled-by-user');
  // 这条是关键：显式来源能解开挂断，**不能**解开总开关 ——
  // 否则模型换个说法带上 src 就绕过去了，闸等于没有
  assert.equal(guardReason({ disabled: true, explicitSrc: true }), 'disabled-by-user');
  assert.equal(
    guardReason({ disabled: true, hungUp: true, fileEnded: true, explicitSrc: true }),
    'disabled-by-user',
  );
  // 不关时行为逐条不变（别为了新闸改坏老的三个）
  assert.equal(guardReason({}), null);
  assert.equal(guardReason({ explicitSrc: true }), null);
  assert.equal(guardReason({ hungUp: true }), 'hung-up');
  assert.equal(guardReason({ fileEnded: true }), 'file-ended');
});

// ---------------------------------------------------------------- runner

test('runner：默认开；关掉之后 watch / peek / start 全被拒，且不去开窗', async () => {
  const r = createRunner({ graceSec: 0, log: () => {} });
  assert.equal(r.enabled(), true);
  assert.equal(r.status().enabled, true);

  const out = r.setEnabled(false);
  assert.deepEqual({ enabled: out.enabled, wasEnabled: out.wasEnabled }, { enabled: false, wasEnabled: true });
  assert.equal(r.enabled(), false);
  assert.equal(r.status().running, false);
  // 同一个值再来一次不该报"改了"（1.5 秒轮询会反复撞到它）
  assert.equal(r.setEnabled(false).wasEnabled, false);

  const w = await r.watch({ seconds: 5 });
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'disabled-by-user');
  // 关键副作用检查：没去拉悬浮窗（否则等于"用户说别看，它还弹窗"）
  assert.equal(r.windowWasOpen(), false);

  assert.equal(r.peek(), null, '关掉之后 peek 不能给队列里剩的图 —— 那些图正是他不想给的');

  // 连显式来源也不行（与 hungUp 不同）
  const w2 = await r.watch({ seconds: 5, src: { kind: 'screen' } });
  assert.equal(w2.reason, 'disabled-by-user');

  const s = await r.start({ src: { kind: 'screen' } });
  assert.equal(s.blocked, 'disabled-by-user');
  assert.equal(s.source, null);

  // 打开之后恢复，且不会残留"关着"的判据
  r.setEnabled(true);
  assert.equal(r.enabled(), true);
  assert.equal(guardReason({ disabled: !r.enabled() }), null);
});

test('runner：本来就是关着的时候启动（配置里 enabled:false）', async () => {
  const r = createRunner({ graceSec: 0, enabled: false, log: () => {} });
  assert.equal(r.enabled(), false);
  assert.equal(r.status().enabled, false);
  const w = await r.watch({ seconds: 5 });
  assert.equal(w.reason, 'disabled-by-user');
  // `already` 不能回：回"已经在看了"会让模型以为还能接着看
  const s = await r.start({ src: { kind: 'screen' } });
  assert.equal(s.blocked, 'disabled-by-user');
  assert.equal(s.source, null);
});

test('runner：setAutoOpenWindow(false) 时 watch 不会自己把窗弹回来', async () => {
  /**
   * `ears` / `ghost` 档的核心承诺：窗收起之后不再自己弹。
   * 这里只验"不支窗"这一半 —— 真开窗要 spawn python，测试机上不能做
   * （`watch` 走到 `ensureWindow()` 之前就返回了，所以不会碰真进程）。
   */
  const r = createRunner({ graceSec: 0, log: () => {} });
  const out = r.setAutoOpenWindow(false);
  assert.deepEqual(out, { autoOpen: false });
  // 幂等：循环每一拍都会调一次，不能每拍都打一行日志
  assert.deepEqual(r.setAutoOpenWindow(false), { autoOpen: false });
  assert.deepEqual(r.setAutoOpenWindow(true), { autoOpen: true });
});

// ---------------------------------------------------------------- 配置

test('配置：enabled 默认 true，写成字符串要报错而不是静默当开', () => {
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-see-gate-cfg-')) };
  const miss = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };

  assert.equal(TUNING_DEFAULTS.enabled, true);
  assert.equal(readTuning({ env, readFile: miss }).enabled, true);

  // "false" 是字符串真值：必须报出来、并按默认（开）处理
  const bad = readTuning({ env, readFile: () => JSON.stringify({ enabled: 'false' }) });
  assert.equal(bad.enabled, true);
  assert.ok(bad.warnings.some((w) => w.includes('enabled')), '写成字符串必须留下一条警告');

  // 真布尔 false → 关，且没有警告
  const off = readTuning({ env, readFile: () => JSON.stringify({ enabled: false }) });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.warnings, []);
});

test('配置：onWindowClose 默认 stop（= 老行为），四档之外的值回默认并报一句', () => {
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-see-gate-close-')) };
  const miss = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };

  assert.deepEqual([...WINDOW_CLOSE_MODES], ['stop', 'ears', 'rise', 'ghost']);
  assert.equal(TUNING_DEFAULTS.onWindowClose, 'stop');
  // 没配过就是老行为 —— 验收第 9 条要的就是这个
  assert.equal(readTuning({ env, readFile: miss }).onWindowClose, 'stop');

  for (const mode of WINDOW_CLOSE_MODES) {
    const t = readTuning({ env, readFile: () => JSON.stringify({ onWindowClose: mode }) });
    assert.equal(t.onWindowClose, mode);
    assert.deepEqual(t.warnings, []);
  }

  const bad = readTuning({ env, readFile: () => JSON.stringify({ onWindowClose: 'quiet' }) });
  assert.equal(bad.onWindowClose, 'stop');
  assert.ok(bad.warnings.some((w) => w.includes('onWindowClose')));
});

// ---------------------------------------------------------------- 模型侧

test('工具描述里说清了「不是故障、重试没用、只有用户能开」', () => {
  const d = seeNowToolSpec().description;
  assert.ok(d.includes('disabled-by-user'), '模型得知道这个 reason 是什么');
  assert.ok(/Master switch/.test(d), '得有一句"这是用户侧总开关"');
  assert.ok(/retry/.test(d), '得说重试没用');
});
