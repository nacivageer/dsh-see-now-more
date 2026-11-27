/**
 * feed-poll.test.mjs — ChatFeed 的增量读（调 python 跑 check-feed-poll.py）。
 *
 * 2026-11-27 从 `see-now-window.log` 里一条 `UnicodeDecodeError: 0x8b at position 0`
 * 追出来的：`poll()` 拿字节位置去文本模式 seek，而 chat.jsonl 会被删除 / 重命名会话、
 * 自动清理**整份重写**（`os.replace`）。旧位置落到新文件的多字节字符中间就抛异常，
 * 而异常发生在 `_pos` 赋值之前 —— 之后每次轮询撞同一颗地雷，一直卡到窗重启。
 * 用户看到的是「浮窗不再显示新消息」，不报错、不提示。
 *
 * 这条测试盯两个用户能看见的后果：半行不许丢、重写之后还得继续收。
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

test('scripts/check-feed-poll.py：半行不丢、整份重写后不卡死、清短重读',
  { skip: !hasPython && '没有 python' }, () => {
    const r = runPy([join('scripts', 'check-feed-poll.py')]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /all passed/);
  });
