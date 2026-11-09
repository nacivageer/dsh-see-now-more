/**
 * listen-kill.test.mjs — 结束采集进程（issue #61 / #62）。
 *
 * 病一（#61）：Windows 上 `spawn(python, …)` 的 pid 是 **venv launcher**，
 *   `child.kill()` 只杀它，真正在录音的基座解释器活着 —— 麦克风灯一直亮。
 * 病二（#62）：关窗走 `hangUp()` 时 `child` 引用可能在 teardown 之前就丢了，
 *   连 pid 都拿不到，只能靠 Python 自己写的 pid 文件兜底。
 *
 * 这两条都不适合在单测里真起进程，所以把"怎么杀"和"pid 文件怎么读"抽成纯函数，
 * 用假的 `run` / `kill` 断言**发出去的到底是什么命令**。真进程那条路在
 * `scripts/` 之外由手工验（见提交说明）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { killListenTree, readListenPid, PID_FILE } from '../src/listen.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-see-pid-'));

function pidFile(content) {
  const p = join(dir, `${Math.random().toString(36).slice(2)}-${PID_FILE}`);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

// ---- pid 文件 ----

test('pid 文件：规则内的能读出来', () => {
  assert.equal(readListenPid(pidFile({ pid: 4321, script: 'listen.py', at: Date.now() })), 4321);
});

test('pid 文件：脏文件一律当没有（不抛）', () => {
  assert.equal(readListenPid(join(dir, '不存在.pid')), null, '文件没了 → null');
  assert.equal(readListenPid(pidFile('{不是 json')), null);
  assert.equal(readListenPid(pidFile({ pid: 0, script: 'listen.py' })), null, 'pid 0 不是进程');
  assert.equal(readListenPid(pidFile({ pid: 12.5, script: 'listen.py' })), null, '非整数不行');
  assert.equal(readListenPid(pidFile({ pid: 99, script: 'window.py' })), null,
    '只认 listen.py：别的脚本的 pid 文件不能拿来杀');
  assert.equal(readListenPid(pidFile({ pid: 99, script: 'listen.py', at: Date.now() - 7 * 3600 * 1000 })), null,
    '7 小时前的记录不可信（pid 可能已经被复用）');
});

// ---- Windows：先验身份，再杀树 ----

test('Windows：pid 映像名是 python 才 taskkill /T /F', () => {
  const calls = [];
  const fakeRun = (cmd, args) => {
    calls.push([cmd, args.join(' ')]);
    if (cmd === 'tasklist') return { status: 0, stdout: '"python.exe","4321","Console","1","12,345 K"\r\n' };
    return { status: 0, stdout: '' };
  };
  assert.equal(killListenTree(4321, { platform: 'win32', run: fakeRun }), 'killed');
  assert.deepEqual(calls, [
    ['tasklist', '/FI PID eq 4321 /FO CSV /NH'],
    ['taskkill', '/PID 4321 /T /F'],
  ]);
});

test('Windows：pid 被别的程序复用了 → 不杀', () => {
  const calls = [];
  const fakeRun = (cmd, args) => {
    calls.push(cmd);
    return { status: 0, stdout: '"chrome.exe","4321","Console","1","1 K"\r\n' };
  };
  assert.equal(killListenTree(4321, { platform: 'win32', run: fakeRun }), 'skipped');
  assert.deepEqual(calls, ['tasklist'], '身份不对就只问一次，不许 taskkill');
});

test('Windows：进程已经没了 / taskkill 失败 → skipped，不抛', () => {
  assert.equal(killListenTree(4321, {
    platform: 'win32', run: (cmd) => (cmd === 'tasklist' ? { status: 0, stdout: 'INFO: 没有运行的任务\r\n' } : { status: 1 }),
  }), 'skipped');

  assert.equal(killListenTree(4321, {
    platform: 'win32',
    run: (cmd) => (cmd === 'tasklist'
      ? { status: 0, stdout: '"python.exe","4321",\r\n' }
      : { status: 1, stdout: '拒绝访问' }),
  }), 'skipped');
});

// ---- 其它平台 ----

test('非 Windows：直接 SIGTERM（listen.py 自己接了这个信号收尾）', () => {
  const got = [];
  assert.equal(killListenTree(777, { platform: 'linux', kill: (pid, sig) => { got.push([pid, sig]); } }), 'killed');
  assert.deepEqual(got, [[777, 'SIGTERM']]);

  assert.equal(killListenTree(778, {
    platform: 'linux', kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
  }), 'gone');
});

test('pid 不合法：什么都不做', () => {
  let called = false;
  const run = () => { called = true; return { status: 0, stdout: '' }; };
  for (const bad of [0, -1, null, undefined, 'abc', 1.5, NaN]) {
    assert.equal(killListenTree(bad, { platform: 'win32', run }), 'gone');
  }
  assert.equal(called, false, '连 tasklist 都不该跑');
});
