/**
 * settings-card.test.mjs — 设置卡文字不许越界（调 python 跑 check-settings-card.py）。
 *
 * 那卡片是自绘 Canvas：文字不折行、不省略，越过右边界就被截断。这个测试离屏画一遍卡
 * （withdrawn 的 Tk 根，不显示窗口、不碰鼠标），按窗口最窄那一档量每个 text item。
 * 没有 python / 没有 Tk / 没有桌面时 skip —— 那是环境缺，不是回归。
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
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

const probe = runPy(['-c', 'import sys; print(sys.version_info[0])']);
const hasPython = !probe.error && probe.status === 0;

test('scripts/check-settings-card.py：最窄卡片里没有文字被右边界截断',
  { skip: !hasPython && '没有 python' }, (t) => {
    const r = runPy([join('scripts', 'check-settings-card.py')]);
    if (r.status === 2) {
      t.skip('没有 Tk / 没有桌面');
      return;
    }
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /all passed/);
  });
