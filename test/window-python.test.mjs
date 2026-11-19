/**
 * window-python.test.mjs — 解释器探测与「刚开窗」宽限。
 *
 * 2026-11-19 实报：钉在 DSH 托管 runtime 上的 python 有 tkinter、没有 mss；插件只要
 * `import tkinter` 就放它过去，`window.py` 一启动先弹一个**阻塞的 MessageBox**，于是
 * 700ms 的存活判定等到的是"还在跑" —— 写 pid、当成功、不换下一个候选。用户只看到
 * 缺包报错，而机器上明明有装齐的 Python。
 *
 * 同一天还实见第二个：窗刚开、还没开始写心跳，常驻循环数够拍数就 `window-stalled`
 * 停掉。这两条都是纯判定逻辑，所以固定在这里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HEARTBEAT_STALE_SEC, WINDOW_START_GRACE_SEC, probePython, resolveScript, windowAlive,
} from '../src/window.js';

const PY = process.platform === 'win32'
  ? (process.env.DSH_SEE_PYTHON || 'pythonw.exe')
  : 'python3';

test('probePython：四个包都在时 ok，缺的包按 pip 名报', () => {
  const r = probePython(PY, { timeoutMs: 20_000 });
  if (r.missing.includes('(解释器跑不起来)')) {
    // 这台机器没有 PATH python：只证明它把"跑不起来"报出来了，别把环境当失败
    assert.equal(r.ok, false);
    assert.ok(r.reason);
    return;
  }
  assert.equal(r.ok, r.missing.length === 0);
  for (const name of r.missing) {
    assert.ok(['tkinter', 'mss', 'numpy', 'Pillow'].includes(name), `未知缺包名：${name}`);
  }
});

test('probePython：解释器不存在 = ok:false，不是抛错', () => {
  const r = probePython('dsh-see-no-such-python-xyz');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['(解释器跑不起来)']);
  assert.ok(r.reason);
});

test('windowAlive：刚写 pid 的窗在宽限内算活着（哪怕心跳已经过期）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-see-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    mkdirSync(join(home, 'see-now'), { recursive: true });
    const pidFile = join(home, 'see-now-window.pid');
    const hb = join(home, 'see-now', 'window-heartbeat');
    writeFileSync(pidFile, String(process.pid), 'utf8');
    writeFileSync(hb, '', 'utf8');
    // 心跳是过期的（窗口刚启动、还没开始写）：宽限期内仍然算活着
    const stale = new Date(Date.now() - (HEARTBEAT_STALE_SEC + 5) * 1000);
    utimesSync(hb, stale, stale);
    assert.equal(windowAlive(), true, '刚开窗心跳未起也要算活着');

    // 宽限过去、心跳又一直过期 → 才算死
    const old = new Date(Date.now() - (WINDOW_START_GRACE_SEC + 10) * 1000);
    utimesSync(pidFile, old, old);
    assert.equal(windowAlive(), false);

    // 心跳新鲜就照旧算活着
    writeFileSync(hb, '', 'utf8');
    assert.equal(windowAlive(), true);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveScript：带 BOM 的 see-window.json 也要认（PowerShell 5.1 默认会写 BOM）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-see-'));
  try {
    const script = join(home, 'window.py');
    writeFileSync(script, '# fake window\n', 'utf8');
    writeFileSync(join(home, 'see-window.json'), '\uFEFF' + JSON.stringify({ script }), 'utf8');
    const r = resolveScript({ env: { ...process.env, DSH_HOME: home } });
    assert.equal(r.from, '~/.dsh/see-window.json');
    assert.equal(r.script, script);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
