/**
 * window-math.test.mjs — 窗口落位与滚轮（调 python 跑 check-window-math.py）。
 *
 * 2026-11-27 把「对话框/设置卡落位 + 滚轮换算」从 `window.py` 抽进 `window_math.py`：
 * 那几行在 `LiveGlass` 里一字不差抄过好几份，只改一处、其余几份不跟着变就是 bug
 * （`.45` 前后两次假红都源自"同一个公式有两份"）。抽出来之后是纯整数运算，
 * 不开窗、不要 Tk —— 没有桌面环境的机器上也能跑（`check-settings-card.py` 那种只能 SKIP）。
 *
 * 这里只做一件事：把脚本的结论带进 `node --test`，别让它变成又一个「记得跑」。
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

test('scripts/check-window-math.py：抽取前后等价（旧公式当参照）+ 滚轮口径 + 不许抄回去',
  { skip: !hasPython && '没有 python' }, () => {
    const r = runPy([join('scripts', 'check-window-math.py')]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /all passed/);
  });
