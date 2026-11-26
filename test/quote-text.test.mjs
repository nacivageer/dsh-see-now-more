/**
 * quote-text.test.mjs — 引用编码 / 切分 / 预览（调 python 跑 `quote_text.py`）。
 *
 * 为什么用 python 而不是在 JS 里重写一份：编码必须和窗口实际发出去的那份逐字一致，
 * 重写一份测的是"我以为的规则"。没有 python 的机器 skip（和 window-python 同款）。
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

test('quote_text.py：编码 / 切分 / 预览（python 直跑）', { skip: !hasPython && '没有 python' }, () => {
  const code = [
    'import json, sys',
    "sys.path.insert(0, 'examples/floating-chat')",
    'import quote_text as q',
    'print(json.dumps({',
    "  'quote': q.format_quote_text('a\\nb'),",
    "  'crlf': q.format_quote_text('  a\\r\\n b  '),",
    "  'split': q.split_quote_blocks('> a\\n> b\\n\\n正文'),",
    "  'preview': q.quote_preview('a\\n  b'),",
    '}, ensure_ascii=False))',
  ].join('\n');
  const r = runPy(['-c', code]);
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.equal(got.quote, '> a\n> b');
  assert.equal(got.crlf, '> a\n>  b');
  assert.deepEqual(got.split, [['q', 'a\nb'], ['text', '\n正文']]);
  assert.equal(got.preview, 'a b');
});

test('scripts/check-quote.py：编码 / chip 几何 / 发送拼装 全过', { skip: !hasPython && '没有 python' }, () => {
  const r = runPy([join('scripts', 'check-quote.py')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
