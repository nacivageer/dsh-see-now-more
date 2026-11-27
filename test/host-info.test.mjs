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
  finishRestart, hostRecord, queueRestart, readJson, readPendingRestart, restartLine, restartNotice,
  restartWakeText, writeHostInfo,
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

test('queueRestart：写 queued、不覆盖正在进行的相位（否则窗口的执行态会被打回排队）', () => {
  const dir = tmp();
  try {
    const r1 = queueRestart({ dir, session: 's1', version: '0.1.1-more.39', now: 1000 });
    assert.equal(r1.already, false);
    assert.equal(r1.intent.phase, 'queued');
    assert.equal(r1.intent.by, 'agent');
    assert.equal(readJson(join(dir, 'restart.json')).phase, 'queued');

    const r2 = queueRestart({ dir, now: 2000 });
    assert.equal(r2.already, true, '已经在排的不能再写一份');
    assert.equal(r2.intent.at, 1000, '原有请求的时间不能被我盖掉');

    writeFileSync(join(dir, 'restart.json'), JSON.stringify({ phase: 'killing', at: 5 }), 'utf8');
    assert.equal(queueRestart({ dir, now: 3000 }).already, true, '执行中也不能插队');

    writeFileSync(join(dir, 'restart.json'), JSON.stringify({ phase: 'done' }), 'utf8');
    assert.equal(queueRestart({ dir, now: 4000 }).already, false, '上一轮结束之后可以再排');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queued 不能被当成"重启正在进行"：宿主启动时不能凭它写回执', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'restart.json'), JSON.stringify({ phase: 'queued', at: 1, by: 'agent' }), 'utf8');
    assert.equal(readPendingRestart(dir), null);
    assert.equal(finishRestart({ dir, hostPid: 999, version: 'v', now: 2000 }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restartLine：status 里那行的四种形状', () => {
  assert.equal(restartLine(null), null);
  assert.match(restartLine({ phase: 'queued' }), /已排队/);
  assert.match(restartLine({ phase: 'waiting-idle' }), /等空闲/);
  assert.equal(restartLine({
    phase: 'done', oldHostPid: 111, newHostPid: 222, newVersion: '0.1.1-more.39', elapsedMs: 14011,
  }), '上次：v0.1.1-more.39（宿主 111 → 222，14 秒）');
  assert.match(restartLine({ phase: 'done', oldHostPid: null, newHostPid: 222, newVersion: 'v' }), /宿主 \? → 222/);
  assert.match(restartLine({ phase: 'failed', reason: '宿主没回来' }), /上次失败：宿主没回来/);
});

test('restartNotice：模型排的重启要写成「会话发起」，不能冒充窗', () => {
  const text = restartNotice({ by: 'agent', oldHostPid: 111, at: 0 }, { version: 'v', hostPid: 222, now: 1000 });
  assert.match(text, /会话发起/);
  assert.ok(!text.includes('窗发起'));
});

test('restartWakeText：回执要自己走进会话，并明说不用再查 status', () => {
  const text = restartWakeText('已回到 v0.1.1-more.39（会话发起，宿主 1 → 2，用时 3 秒）');
  assert.match(text, /系统回执/);
  assert.match(text, /v0\.1\.1-more\.39/);
  assert.match(text, /不用再调 `status`/);
  // 空回执也不能吐一句没主语的话
  assert.match(restartWakeText(''), /重启完成/);
});
