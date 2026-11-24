/**
 * 开窗单飞（2026-11-25，抄上游 #75 的那条修）。
 *
 * 为什么测：`openWindow()` 的 pid 要 spawn 之后 700ms 才写，这段时间里
 * 三条调用路（左上角入口路由 / `watch` 的 `window show` / 循环的 `ensureWindow`）
 * 谁来问都是"没窗"。并发两次就 spawn 两个 pythonw，pid 文件只记得后一个 ——
 * 前一个变成收不掉的孤儿窗（2026-11-25 实测复现：两个真 pythonw）。
 *
 * 这里钉两件事：
 *   1. 在飞期间后到的调用**拿同一个 promise**；
 *   2. 结束后闸要放开（下一次能重新开，不会永远复用旧结果）。
 *
 * 第二条用**真 spawn 计数**验：临时脚本把 pid 写进一个文件，两次并发只该写一行。
 * 这台机器没有可用 python 时跳过那半段（别把环境当失败）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { openWindow, pidPath, probePython } from '../src/window.js';

const PY = process.platform === 'win32'
  ? (process.env.DSH_SEE_PYTHON || 'pythonw.exe')
  : 'python3';

/** 把 DSH_HOME 指到临时目录：pid / 日志 / 聊天流一律不碰真身。 */
function withTempHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'see-now-singleflight-'));
    const saved = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      return await fn(home);
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid); } catch { /* 已经没了 */ }
}

test('在飞期间后到的调用拿同一个 promise，结束后闸放开', withTempHome(async () => {
  const missing = join(tmpdir(), 'see-now-no-such-window.py');
  // 指一个不存在的脚本：`openWindowOnce` 在 spawn 之前就返回，测试不会弹窗。
  const a = openWindow({ script: missing });
  const b = openWindow({ script: missing });
  assert.equal(a, b, '两次并发调用没有共享同一个 promise（单飞闸没生效）');

  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, rb);
  assert.equal(ra.ok, false);
  assert.match(String(ra.reason), /指定的 script 不存在/);

  const c = openWindow({ script: missing });
  assert.notEqual(c, a, '闸没有在结束之后放开：下一次调用复用了旧结果');
  await c;
}));

test('并发两次只真的起一个进程（这台机器没有可用 python 就跳过）', withTempHome(async (home) => {
  const probe = probePython(PY, { timeoutMs: 20_000 });
  if (!probe.ok) return;                       // 环境没有 python：上面那条已经覆盖闸的语义

  const dir = join(home, 'probe');
  rmSync(dir, { recursive: true, force: true });
  const script = join(home, 'slow-window.py');
  const spawnLog = join(home, 'spawned.txt');
  writeFileSync(script, [
    'import os, time',
    `log = ${JSON.stringify(spawnLog)}`,
    'p = os.environ.get("PROBE_LOG") or log',
    'with open(p, "a", encoding="utf-8") as f:',
    '    f.write(str(os.getpid()) + "\\n")',
    'time.sleep(30)',
  ].join('\n'), 'utf8');

  const saved = process.env.PROBE_LOG;
  process.env.PROBE_LOG = spawnLog;
  let pid = 0;
  try {
    // settleMs 比进程存活判定短，两路都在"等它别退出"的同一拍里。
    const [ra, rb] = await Promise.all([
      openWindow({ script, settleMs: 900, log: () => {} }),
      openWindow({ script, settleMs: 900, log: () => {} }),
    ]);
    assert.equal(ra.ok, true, `开窗失败：${ra.reason ?? ''}`);
    assert.equal(rb.ok, true);
    assert.equal(ra.python, rb.python);

    const lines = existsSync(spawnLog)
      ? readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean)
      : [];
    assert.equal(lines.length, 1, `并发开窗起了 ${lines.length} 个进程（单飞没生效）`);

    pid = Number(readFileSync(pidPath(), 'utf8').trim());
    const alive = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', windowsHide: true });
    assert.match(String(alive.stdout), new RegExp(String(pid)), 'pid 文件没指向活着的进程');
  } finally {
    if (saved === undefined) delete process.env.PROBE_LOG;
    else process.env.PROBE_LOG = saved;
    if (process.platform === 'win32') {
      for (const line of (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n') : [])) {
        killTree(Number(line.trim()));
      }
    }
    killTree(pid);
  }
}));
