/**
 * focused-session.js + tuning.writeBoundSession —— 「主窗当前会话」落盘与绑定写回。
 *
 * 这两份文件是两个进程之间的契约：Host 写、悬浮窗（Python）读。测试只碰临时
 * DSH_HOME，不读真实配置、不弹窗。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  currentSessionPath, normalizeSessionId, sessionExists, writeCurrentSession,
} from '../src/focused-session.js';
import { writeBoundSession } from '../src/tuning.js';

const SID = 'session-aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'session-bbbbbbbb-5555-6666-7777-888888888888';

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'see-now-focus-'));
  return {
    home,
    env: { DSH_HOME: home },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('会话 ID 只认完整 UUID 形状：短 ID / 前缀 / 乱码一律空串', () => {
  assert.equal(normalizeSessionId(SID), SID);
  assert.equal(normalizeSessionId(`  ${SID}  `), SID);
  assert.equal(normalizeSessionId(SID.slice(0, 12)), '');
  assert.equal(normalizeSessionId('session-not-a-uuid'), '');
  assert.equal(normalizeSessionId(''), '');
  assert.equal(normalizeSessionId(null), '');
  assert.equal(normalizeSessionId(42), '');
});

test('写当前会话：原子落盘，带 sessionId 与 at', () => {
  const t = tempHome();
  try {
    const r = writeCurrentSession(SID, { env: t.env });
    assert.equal(r.changed, true);
    assert.equal(r.sessionId, SID);
    const raw = JSON.parse(readFileSync(currentSessionPath(t.env), 'utf8'));
    assert.equal(raw.sessionId, SID);
    assert.ok(Number.isFinite(raw.at) && raw.at > 0);
  } finally { t.cleanup(); }
});

test('当前会话为空 = 删掉旧文件（主窗清空选择）', () => {
  const t = tempHome();
  try {
    writeCurrentSession(SID, { env: t.env });
    const file = currentSessionPath(t.env);
    assert.ok(readFileSync(file, 'utf8').includes(SID));
    const r = writeCurrentSession('', { env: t.env });
    assert.equal(r.sessionId, null);
    assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/);
    // 文件本来就不在也不算失败
    assert.doesNotThrow(() => writeCurrentSession('', { env: t.env }));
  } finally { t.cleanup(); }
});

test('sessionExists：扫 sessions/<workspace>/<session-id>', () => {
  const t = tempHome();
  try {
    assert.equal(sessionExists(SID, { env: t.env }), false);
    mkdirSync(join(t.home, 'sessions', '--workspace--', SID), { recursive: true });
    assert.equal(sessionExists(SID, { env: t.env }), true);
    assert.equal(sessionExists(OTHER, { env: t.env }), false);
    assert.equal(sessionExists('nonsense', { env: t.env }), false);
  } finally { t.cleanup(); }
});

test('写绑定：设 session 且保留别的键；同值不重写', () => {
  const t = tempHome();
  try {
    const path = join(t.home, 'see-now.json');
    // 带 BOM 的 UTF-8 是 Windows 记事本 / PowerShell 的默认产物，必须能读
    writeFileSync(path, '\uFEFF' + JSON.stringify({
      idleStopMin: 10, mode: 'none', listen: { silence: 0.6 },
    }, null, 2), 'utf8');

    const r = writeBoundSession(SID, { env: t.env });
    assert.equal(r.changed, true);
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(cfg.session, SID);
    assert.equal(cfg.idleStopMin, 10, '别的键不能被抹掉');
    assert.equal(cfg.mode, 'none');
    assert.deepEqual(cfg.listen, { silence: 0.6 });

    const again = writeBoundSession(SID, { env: t.env });
    assert.equal(again.changed, false, '同一个会话不重写，避免无谓的 mtime 抖动');

    writeBoundSession(OTHER, { env: t.env });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).session, OTHER);
  } finally { t.cleanup(); }
});

test('写绑定：文件不存在 / 内容是数组也能从空对象开始', () => {
  const t = tempHome();
  try {
    const path = join(t.home, 'see-now.json');
    writeBoundSession(SID, { env: t.env });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).session, SID);

    writeFileSync(path, '[]', 'utf8');
    writeBoundSession(OTHER, { env: t.env });
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(Array.isArray(cfg), false);
    assert.equal(cfg.session, OTHER);
  } finally { t.cleanup(); }
});
