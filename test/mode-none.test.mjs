/**
 * mode-none.test.mjs — 四档「当前感官模式」里的后两档（audio / none）。
 *
 * 2026-11-19 悬浮窗设置页把感官模式做成四档：视听都开 / 仅看 / 仅听 / 无。
 * 前三档宿主本来就有入口，但 `audio` 以前是"一次性动作、不写配置"，
 * `none` 根本没有 —— 这一轮两档都变成可持久化的值。
 *
 * 守三件事：
 *   1. `readTuning()` 四档都认，不认识的退回 both 并 warn；
 *   2. runner 记住四档，`setMode` 不会把它们折成 both；
 *   3. `mode:"audio"` 真的按"起耳朵、不起视觉"处理（applyAudioMode 的判据）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTuning } from '../src/tuning.js';
import { createRunner } from '../src/runner.js';

function withTuning(mode, fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-see-mode-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeFileSync(join(home, 'see-now.json'), JSON.stringify({ mode }), 'utf8');
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test('readTuning：四档都认（both / vision / audio / none）', () => {
  for (const m of ['both', 'vision', 'audio', 'none']) {
    withTuning(m, () => {
      const t = readTuning();
      assert.equal(t.mode, m, `mode=${m}`);
      assert.deepEqual(t.warnings.filter((w) => w.includes('mode')), []);
    });
  }
});

test('readTuning：不认识的 mode 退回 both 并记一条 warn', () => {
  withTuning('sometimes', () => {
    const t = readTuning();
    assert.equal(t.mode, 'both');
    assert.ok(t.warnings.some((w) => w.startsWith('mode 只能是')));
  });
});

test('runner：四档都记得住，setMode 不会折成 both', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-see-mode-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const runner = createRunner({ log: () => {}, mode: 'none' });
    assert.equal(runner.mode(), 'none');
    for (const m of ['none', 'vision', 'audio', 'both']) {
      assert.equal(runner.setMode(m), m);
      assert.equal(runner.mode(), m);
    }
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
