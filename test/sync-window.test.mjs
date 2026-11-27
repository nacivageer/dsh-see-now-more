/**
 * sync-window.test.mjs — `check:window` 必须能说「我没法判断」。
 *
 * 为什么要有它：2026-11-27 实测 `npm run check:window` 在开发机上永远报「一致」——
 * 它把 `~/.dsh/see-window.json` 的 `script`（也就是本仓的 `window.py`）当成了上游，
 * 于是拿文件跟它自己比。假绿的闸门比没有闸门更坏：`CONTRIBUTING` 还教人用它。
 *
 * 验三件事：
 *   1. 上游候选就是本仓文件 → exit 2（没判断 ≠ 通过），并且不说「一致」；
 *   2. 真有另一份上游且内容不同 → exit 1（这条保证 exit 2 不是把真检查也弄瞎了）；
 *   3. `window.py` 文件头的标记说的是「本仓已分叉」，不再是「请勿手改」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WINPY = join(ROOT, 'examples', 'floating-chat', 'window.py');

function check(env) {
  return spawnSync(process.execPath, [join('scripts', 'sync-window.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    // DSH_HOME 指到空的临时目录：别让本机 profile 里的已安装副本混进候选
    env: { ...process.env, DSH_HOME: mkdtempSync(join(tmpdir(), 'seenow-home-')), ...env },
  });
}

test('上游候选指向本仓文件时报「无法判断」（exit 2），不许报「一致」', () => {
  const r = check({ DSH_SEE_WINDOW: WINPY });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr + r.stdout, /没有可比的上游/);
  assert.doesNotMatch(r.stdout, /一致/, '自比自不能报一致');
});

test('真有一份别的上游且内容不同时，仍然报不一致（exit 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seenow-up-'));
  const other = join(dir, 'window.py');
  writeFileSync(other, '#!/usr/bin/env python3\nprint("upstream")\n', 'utf8');
  const r = check({ DSH_SEE_WINDOW: other });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /不一致/);
});

test('window.py 文件头讲的是本仓已分叉，不是「请勿手改」', () => {
  const head = readFileSync(WINPY, 'utf8').split(/\r?\n/).slice(0, 3).join('\n');
  assert.match(head, /本仓已分叉/, '文件头还写着「别改这里」—— 实际改动全落在这个文件上');
  assert.doesNotMatch(head, /请勿手改/);
});
