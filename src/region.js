/**
 * region.js — 让用户**框**一块屏幕给 AI 看，而不是让模型猜 `x,y,w,h`。
 *
 * `region:"x,y,w,h"` 这条参数（PR #9）本身没问题，问题是**谁来量这四个数**。
 * 让人去截图软件里量像素是不现实的，所以这里起一个全屏取框窗（`pick_region.py`，
 * 和悬浮窗共用同一个带 tkinter 的 python），拖一下松手，坐标直接落盘。
 *
 * 两个文件，职责分开：
 *   - `pick_region.py`（Python）：只负责交互，stdout 吐一行 JSON
 *   - 这里（Node）：找解释器、跑它、校验坐标、写 `~/.dsh/see-now/region.json`
 *
 * **落盘的意义**：选过之后 `watch` 默认就用它，模型不用每轮再传一遍数字；
 * 要退出就传 `region:"off"`（或 `action:"region", clear:true`）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { chatDir, dshHome } from './chat.js';
import { PACKAGED, hasTkinter, pythonCandidates } from './window.js';

/** 取框窗最多挂多久（用户可能去接杯水）。到点就收掉，不留一个全屏黑罩子在屏幕上。 */
export const PICK_TIMEOUT_MS = 180_000;

export function regionFile(env = process.env) {
  return join(chatDir(env), 'region.json');
}

/** 落盘的那块区域；没有 / 坏了都返回 null（坏文件不能把 watch 一起拖死）。 */
export function loadRegion(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(regionFile(env), 'utf8'));
    const { x, y, w, h } = raw ?? {};
    if ([x, y, w, h].every((v) => Number.isInteger(v)) && w > 0 && h > 0 && x >= 0 && y >= 0) {
      return { x, y, w, h };
    }
  } catch { /* 没选过 */ }
  return null;
}

export function saveRegion(region, env = process.env) {
  const path = regionFile(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...region, at: Date.now() }, null, 2), 'utf8');
  return path;
}

export function clearRegion(env = process.env) {
  try { unlinkSync(regionFile(env)); return true; } catch { return false; }
}

/** `{x,y,w,h}` → `"x,y,w,h"`（工具参数、gdigrab 都用这个形状）。 */
export function regionText(region) {
  return region ? `${region.x},${region.y},${region.w},${region.h}` : null;
}

/** 取框脚本在哪。包内的那份由 `scripts/sync-window.mjs` 一起带上（见它的 ASSETS）。 */
export function pickScript() {
  return join(PACKAGED, '..', 'pick_region.py');
}

/**
 * 起取框窗，等用户拖完。
 *
 * @returns {Promise<{ok:true, region:{x:number,y:number,w:number,h:number}}|{ok:false, reason:string, detail?:string}>}
 *   `reason`: `cancelled`（用户 Esc / 右键）/ `timeout` / `no-python` / `no-script` / `failed`
 */
export async function pickRegion({ log = () => {}, timeoutMs = PICK_TIMEOUT_MS, env = process.env } = {}) {
  const script = pickScript();
  if (!existsSync(script)) return { ok: false, reason: 'no-script', detail: script };

  const tried = [];
  for (const python of pythonCandidates()) {
    if (!hasTkinter(python)) { tried.push(`${python}（无 tkinter）`); continue; }

    const r = await runPicker(python, script, timeoutMs, env);
    if (r.spawned === false) { tried.push(`${python}（${r.detail}）`); continue; }
    return r.result;
  }
  return { ok: false, reason: 'no-python', detail: tried.join(' / ') || '没有候选解释器' };
}

function runPicker(python, script, timeoutMs, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...env, DSH_VIDEO_CACHE_DIR: chatDir(env), DSH_HOME: dshHome(env) },
      });
    } catch (e) {
      resolve({ spawned: false, detail: String(e?.message ?? e) });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      finish({ result: { ok: false, reason: 'timeout', detail: `等了 ${Math.round(timeoutMs / 1000)} 秒没框完` } });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ spawned: false, detail: String(e?.message ?? e) }));
    child.on('exit', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      if (code === 2 || (!line && code === 0)) {
        finish({ result: { ok: false, reason: 'cancelled' } });
        return;
      }
      let region = null;
      try { region = JSON.parse(line); } catch { /* 下面统一报 */ }
      const valid = region && [region.x, region.y, region.w, region.h]
        .every((v) => Number.isInteger(v)) && region.w > 0 && region.h > 0;
      if (!valid) {
        finish({ result: { ok: false, reason: 'failed', detail: (err || line || `退出码 ${code}`).slice(0, 400) } });
        return;
      }
      // 负坐标 = 框到主屏外面去了，gdigrab 不接受负 offset（见 pick_region.py 第 3 条）
      if (region.x < 0 || region.y < 0) {
        finish({ result: { ok: false, reason: 'failed', detail: '框到主屏外面了（负坐标），请在主屏里框' } });
        return;
      }
      saveRegion(region, env);
      finish({ result: { ok: true, region } });
    });
  });
}
