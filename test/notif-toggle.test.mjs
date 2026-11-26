/**
 * notif-toggle.test.mjs — 折叠态「新消息」气泡的开关（调 python 跑 check-notif-toggle.py）。
 *
 * 为什么用 python 而不是在 JS 里重写一份：开关的判据、设置页那一行的点击、收回气泡时
 * 的窗高都长在 `window.py` 里；在 JS 里重写测的是"我以为的规则"。没有 python 的机器
 * skip（和 quote-text.test.mjs 同款）。不碰 Tk、不碰鼠标、不读写 ~/.dsh。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY = process.platform === 'win32' ? 'python' : 'python3';

function runPy(args) {
  return spawnSync(PY, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    // Windows 上 python 默认按 GBK 写 stdout，中文会变成乱码；强制 UTF-8
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

const probe = runPy(['-c', 'import sys; print(sys.version_info[0])']);
const hasPython = !probe.error && probe.status === 0;

test('scripts/check-notif-toggle.py：默认开 / false 才关 / 点一下写盘 / 收回气泡',
  { skip: !hasPython && '没有 python' }, () => {
    const r = runPy([join('scripts', 'check-notif-toggle.py')]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /all passed/);
  });
