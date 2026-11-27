/**
 * host-info.test.mjs — 宿主坐标与重启回执（2026-11-27，`0.1.1-more.39`）。
 *
 * 这两件都是**窗口判断"能不能重启、回来的是不是新版本"的唯一依据**：
 *   - `host.json` 记的是 Electron 的 exe / appPid / hostPid，窗口不去进程表里猜；
 *   - `restart.json` 记的是「谁在什么时候重启了」，回执由新起来的插件收敛成 done。
 *
 * 三条最容易悄悄写错、又只能靠文件看出来的：**env 带进密钥**、**poison 名单漏掉
 * ELECTRON_RUN_AS_NODE**（拉起来是个 node、没有面板）、**同进程重载被当成重启完成**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  finishRestart, hostRecord, readJson, readPendingRestart, restartNotice, writeHostInfo,
} from '../src/host-info.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-host-info-'));

test('hostRecord：env 只留白名单，密钥进不去', () => {
  const r = hostRecord({
    execPath: 'C:\\App\\Harness.exe',
    hostPid: 42,
    appPid: 41,
    cwd: 'C:\\work',
    argv: ['Harness.exe', '--expose-internals'],
    env: {
      DSH_HOME: 'C:\\Users\\x\\.dsh',
      DSH_PROFILE: 'desktop',
      DEEPSEEK_API_KEY: 'sk-should-not-be-here',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:\\Windows',
    },
    version: '1.2.3',
    at: 1000,
  });
  assert.deepEqual(r.env, { DSH_HOME: 'C:\\Users\\x\\.dsh', DSH_PROFILE: 'desktop' });
  assert.ok(!JSON.stringify(r).includes('sk-should-not-be-here'), '密钥不能出现在记录里');
  assert.equal(r.exe, 'C:\\App\\Harness.exe');
  assert.equal(r.appPid, 41);
  assert.equal(r.hostPid, 42);
  assert.equal(r.version, '1.2.3');
});

test('hostRecord：ELECTRON_RUN_AS_NODE 在 poison 名单里（漏了会拉起一个 node）', () => {
  const r = hostRecord({});
  assert.ok(r.poison.includes('ELECTRON_RUN_AS_NODE'));
  // 空记录也不能有 null pid 混进来当 0 用
  assert.equal(r.appPid, null);
  assert.equal(r.hostPid, null);
});

test('writeHostInfo：落盘可读回，且不留 .tmp', () => {
  const dir = tmp();
  try {
    const { path, record } = writeHostInfo({ dir, version: '9.9.9', now: 1234 });
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(`${path}.tmp`), false);
    const back = readJson(path);
    assert.equal(back.version, '9.9.9');
    assert.equal(back.at, 1234);
    assert.equal(back.hostPid, process.pid, 'hostPid 是当前进程');
    assert.equal(back.appPid, process.ppid, 'appPid 是父进程（桌面端 = Electron 主进程）');
    assert.deepEqual(back, record);
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes('sk-'), '落盘内容里不该有 sk- 开头的串');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restartNotice：带版本、pid 迁移与用时', () => {
  const text = restartNotice(
    { by: 'window', oldHostPid: 111, at: 1_000_000 },
    { version: '0.1.1-more.39', hostPid: 222, now: 1_012_500 },
  );
  assert.match(text, /v0\.1\.1-more\.39/);
  assert.match(text, /窗发起/);
  assert.match(text, /111 → 222/);
  assert.match(text, /13 秒/);
  assert.match(text, /工具已注册/);
});

test('finishRestart：新进程收敛成 done，并把回执写进程名', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'restart.json'), JSON.stringify({
      v: 1, at: 1_000, by: 'window', phase: 'launched', oldHostPid: 111, oldAppPid: 110,
    }), 'utf8');
    const r = finishRestart({ dir, hostPid: 222, version: '0.1.1-more.39', now: 13_000 });
    assert.ok(r);
    assert.match(r.text, /111 → 222/);
    const back = readJson(join(dir, 'restart.json'));
    assert.equal(back.phase, 'done');
    assert.equal(back.newHostPid, 222);
    assert.equal(back.elapsedMs, 12_000);
    assert.equal(back.text, r.text);
    // 幂等：第二次读到 done 就不再回执
    assert.equal(finishRestart({ dir, hostPid: 333, version: 'x', now: 20_000 }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finishRestart：同一个 Host 进程不算重启（宿主内部重载）', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'restart.json'), JSON.stringify({
      phase: 'launched', at: 1_000, oldHostPid: 222,
    }), 'utf8');
    assert.equal(finishRestart({ dir, hostPid: 222, version: 'v', now: 2000 }), null);
    assert.equal(readJson(join(dir, 'restart.json')).phase, 'launched', '不能把没重启的标成完成');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPendingRestart：只认正在进行的三个相位，坏文件不炸', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'restart.json'), '{broken', 'utf8');
    assert.equal(readPendingRestart(dir), null);
    writeFileSync(join(dir, 'restart.json'), JSON.stringify({ phase: 'failed' }), 'utf8');
    assert.equal(readPendingRestart(dir), null);
    writeFileSync(join(dir, 'restart.json'), JSON.stringify({ phase: 'killing', oldHostPid: 1 }), 'utf8');
    assert.equal(readPendingRestart(dir).phase, 'killing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
