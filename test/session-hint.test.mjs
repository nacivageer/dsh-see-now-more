/**
 * session_hint.py —— 【关联变更】预填要读「DSH 主窗当前会话」。
 *
 * 2026-11-20 实报：输入框预填了一个从没用过的空会话（`4c36066b`），而主窗当时开的是
 * `b5a28c79`。根因是预填按「当前绑定之后新建的会话」猜，空会话永远最新。
 * 之后首选读渲染层的选中状态；2026-11-27 又加了第一来源：插件从渲染层直接推过来的
 * `current-session.json`（`localStorage` 是内存态，没有 leveldb 的落盘延迟/压缩丢键）。
 *
 * 这里钉住两层来源的优先级、leveldb 的解析规则，以及「最新一条键记录是权威」。
 * 纯 Python 标准库，不起窗口、不碰网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PY = process.env.DSH_SEE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const HINT_DIR = join(import.meta.dirname, '..', 'examples', 'floating-chat');
const NO_CACHE = join(tmpdir(), 'dsh-hint-no-such-cache');

/** 在 session_hint 的目录里跑一段 Python，返回 stdout（去尾空白）。 */
function py(code, env = {}) {
  const prelude = [
    'import sys',
    `sys.path.insert(0, r"${HINT_DIR}")`,
    'import session_hint',
  ].join('\n');
  const base = { ...process.env };
  delete base.DSH_HOME;
  return execFileSync(PY, ['-c', `${prelude}\n${code}`], {
    encoding: 'utf8', timeout: 30_000,
    // 不传时指向一个不存在的目录：别让测试读到本机真实的 see-now/current-session.json
    env: { ...base, DSH_VIDEO_CACHE_DIR: NO_CACHE, ...env },
  }).trim();
}

/** 跑一次 session_hint.current_session(<dir>)。 */
function currentSession(leveldb, env = {}) {
  return py(`print(session_hint.current_session(r"${leveldb}"))`, env);
}

const sidA = 'session-aaaaaaaa-1111-2222-3333-444444444444';
const sidB = 'session-bbbbbbbb-5555-6666-7777-888888888888';

/** 造一段像 leveldb WAL 的字节：键 + 二进制 + 值（解析只认「键后 400 字节内」）。 */
function wal(...pairs) {
  const parts = [];
  for (const [key, sid] of pairs) {
    parts.push(Buffer.from('\x00\x01junk'), Buffer.from(key), Buffer.from('\x00\x02'),
      Buffer.from(JSON.stringify({ sessionId: sid })), Buffer.from('\x00\x03'));
  }
  return Buffer.concat(parts);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-hint-'));
}

test('同一个日志里后写的那次切换算数', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '000001.log'), wal(
      ['dsh.sessions.current', sidA],
      ['dsh.sessions.current', sidB],
    ));
    assert.equal(currentSession(dir), sidB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多个文件按 mtime 新的优先', () => {
  const dir = tempDir();
  try {
    const oldFile = join(dir, '000001.log');
    const newFile = join(dir, '000002.ldb');
    writeFileSync(oldFile, wal(['dsh.sessions.current', sidA]));
    writeFileSync(newFile, wal(['dsh.sessions.current', sidB]));
    const past = new Date(Date.now() - 60_000);
    utimesSync(oldFile, past, past);
    assert.equal(currentSession(dir), sidB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有这个键 / 目录不存在 = 空串（调用方退回旧判据）', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '000001.log'), Buffer.from('dsh.conversation.other {"draft":1}'));
    assert.equal(currentSession(dir), '');
    assert.equal(currentSession(join(dir, 'no-such-dir')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只认整段 UUID，不吸前缀相同的别的东西', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '000001.log'), Buffer.concat([
      Buffer.from('dsh.sessions.current'),
      Buffer.from('{"sessionId":"session-not-a-uuid"}'),
    ]));
    assert.equal(currentSession(dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('最新的键记录是权威：值不是会话 id（主窗清空选择）就空串，不往前翻旧记录', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '000001.log'), Buffer.concat([
      wal(['dsh.sessions.current', sidA]),
      Buffer.from('dsh.sessions.current\x00\x02{}'),
    ]));
    assert.equal(currentSession(dir), '', '前面的 sidA 是已取消的旧选择，不能填回来');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('插件推来的 current-session.json 优先于 Local Storage', () => {
  const dir = tempDir();
  const cache = join(dir, 'cache');
  try {
    writeFileSync(join(dir, '000001.log'), wal(['dsh.sessions.current', sidA]));
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'current-session.json'),
      JSON.stringify({ sessionId: sidB, at: Date.now() }));
    assert.equal(currentSession(dir, { DSH_VIDEO_CACHE_DIR: cache }), sidB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('推来的文件坏了 / 不是完整 id：退回 Local Storage', () => {
  const dir = tempDir();
  const cache = join(dir, 'cache');
  try {
    writeFileSync(join(dir, '000001.log'), wal(['dsh.sessions.current', sidA]));
    mkdirSync(cache, { recursive: true });
    const file = join(cache, 'current-session.json');

    writeFileSync(file, '{not json', 'utf8');
    assert.equal(currentSession(dir, { DSH_VIDEO_CACHE_DIR: cache }), sidA);

    writeFileSync(file, JSON.stringify({ sessionId: 'session-short' }), 'utf8');
    assert.equal(currentSession(dir, { DSH_VIDEO_CACHE_DIR: cache }), sidA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefill：主窗当前会话优先，拿不到才用兜底', () => {
  const out = JSON.parse(py([
    'import json',
    `same = "${sidA}"`,
    `other = "${sidB}"`,
    'print(json.dumps({',
    '  "same": session_hint.prefill(same, "deadbeef"),',
    '  "other": session_hint.prefill(other, ""),',
    '  "fallback": session_hint.prefill("", "deadbeef"),',
    '}))',
  ].join('\n')));
  assert.equal(out.same, 'aaaaaaaa', '主窗就是绑定会话：也填它（对齐当前窗，确定是无操作）');
  assert.equal(out.other, 'bbbbbbbb', '主窗切到别的会话：预填它，兜底不参与');
  assert.equal(out.fallback, 'deadbeef', '读不到主窗会话：退回旧判据的候选');
});
