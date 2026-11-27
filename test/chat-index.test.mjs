/**
 * chat-index.test.mjs — `chat.jsonl` 的「行→条目→会话索引」（调 python 跑 check-chat-index.py）。
 *
 * 2026-11-27 把这两跳从 `LiveGlass._chat_entries()` / `_chat_sessions()` 抽进 `chat_index.py`：
 * 它们在回顾列表每滚一格的路径上（真机 1.7 MB / 2236 行），口径却一直靠「开窗滚一下看看」
 * 来确认。抽出来之后用假数据直接跑，坏行 / meta / 没有 at / 没有 sid / 4000 行截尾
 * 都有确定答案。
 *
 * 和 window-math 那条一样：把脚本的结论带进 `node --test`，别让它变成「记得跑」。
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

test('scripts/check-chat-index.py：解析/聚合与旧实现等价 + 坏行与截尾口径 + 不许抄回去',
  { skip: !hasPython && '没有 python' }, () => {
    const r = runPy([join('scripts', 'check-chat-index.py')]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /all passed/);
  });
