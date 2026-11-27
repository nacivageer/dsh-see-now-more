/**
 * history-scroll.test.mjs — 回顾列表滚动（调 python 跑 check-history-scroll.py）。
 *
 * 那两条契约长在 `window.py` 里（`_chat_entries()` 的解析缓存、`_hist_wheel()` 的
 * delta 换算与合并重画）：`chat.jsonl` 真机 1.7 MB，每滚一格重画前都会被整份解析两遍，
 * 一滚近百毫秒 —— 「内容多了滚动卡手」就是这个。这里按**读文件次数**验，不靠计时。
 * 不需要 Tk；没有 python 的机器 skip。
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

test('scripts/check-history-scroll.py：解析只做一次 / 缓存会失效 / 滚轮按 delta 走、连发合并',
  { skip: !hasPython && '没有 python' }, () => {
    const r = runPy([join('scripts', 'check-history-scroll.py')]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /all passed/);
  });
