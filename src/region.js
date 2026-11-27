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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { chatDir, dshHome } from './chat.js';
import { PACKAGED, hasTkinter, pythonCandidates } from './window.js';
import { tuningPath } from './tuning.js';

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
  // **只写四个数**：取框脚本现在会多吐 sw/sh（给字幕框用），但 region.json 的形状不能变
  const { x, y, w, h } = region ?? {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ x, y, w, h, at: Date.now() }, null, 2), 'utf8');
  return path;
}

export function clearRegion(env = process.env) {
  try { unlinkSync(regionFile(env)); return true; } catch { return false; }
}

/**
 * 字幕框（`~/.dsh/see-now.json` 的 `text.region`）—— **和 `region.json` 是两件事**。
 *
 * 为什么分开：`region.json` 决定 `watch` 抓哪块；字幕框只决定 OCR 从整屏帧的哪一块取字。
 * 混在一起的话，框完字幕之后 `watch` 就只截那一条了（当年 `subs-band.json` 那条提醒）。
 *
 * 形状 `{x,y,w,h,sw,sh}`：主屏物理像素 + 取框那一刻的主屏尺寸（换算帧内比例要用）。
 * 写盘走 read-modify-write + tmp/rename（和 `index.js` 的 `saveModePref` 同款），
 * **UTF-8 无 BOM** —— 窗口和插件都拿 `json.load` / `JSON.parse` 读它，BOM 会让两边都读不了。
 */
export function saveTextRegion(region, env = process.env) {
  const path = tuningPath(env);
  const x = Number(region?.x); const y = Number(region?.y);
  const w = Number(region?.w); const h = Number(region?.h);
  const sw = Number(region?.sw); const sh = Number(region?.sh);
  if (![x, y, w, h, sw, sh].every((v) => Number.isInteger(v)) || w < 8 || h < 8 || sw <= 0 || sh <= 0) {
    return null;
  }
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { cfg = {}; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  const text = cfg.text && typeof cfg.text === 'object' && !Array.isArray(cfg.text) ? { ...cfg.text } : {};
  text.region = { x, y, w, h, sw, sh };
  cfg.text = text;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmp, path);
  return path;
}

/** 去掉字幕框（`text.region` 删键，`text` 段里别的设置留着）。 */
export function clearTextRegion(env = process.env) {
  const path = tuningPath(env);
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { return false; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  if (!cfg.text || typeof cfg.text !== 'object' || !Object.hasOwn(cfg.text, 'region')) return false;
  delete cfg.text.region;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmp, path);
  return true;
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
export async function pickRegion({
  log = () => {}, timeoutMs = PICK_TIMEOUT_MS, env = process.env, save = saveRegion, hint = null,
} = {}) {
  const script = pickScript();
  if (!existsSync(script)) return { ok: false, reason: 'no-script', detail: script };

  const tried = [];
  for (const python of pythonCandidates()) {
    if (!hasTkinter(python)) { tried.push(`${python}（无 tkinter）`); continue; }

    const r = await runPicker(python, script, timeoutMs, env, save, hint);
    if (r.spawned === false) { tried.push(`${python}（${r.detail}）`); continue; }
    return r.result;
  }
  return { ok: false, reason: 'no-python', detail: tried.join(' / ') || '没有候选解释器' };
}

function runPicker(python, script, timeoutMs, env, save = saveRegion, hint = null) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // 取框窗顶部那行提示按用途变（框整屏看哪块 / 框血条），由调用方给；
        // 不给就用 pick_region.py 里的默认文案。
        env: { ...env, DSH_VIDEO_CACHE_DIR: chatDir(env), DSH_HOME: dshHome(env), ...(hint ? { DSH_PICK_HINT: hint } : {}) },
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
      let raw = null;
      try { raw = JSON.parse(line); } catch { /* 下面统一报 */ }
      const valid = raw && [raw.x, raw.y, raw.w, raw.h]
        .every((v) => Number.isInteger(v)) && raw.w > 0 && raw.h > 0;
      if (!valid) {
        finish({ result: { ok: false, reason: 'failed', detail: (err || line || `退出码 ${code}`).slice(0, 400) } });
        return;
      }
      // 取框脚本会顺带吐主屏物理尺寸（`sw/sh`）：字幕框要拿它把像素换算成帧内比例。
      // 老脚本没有这两个键 —— 缺了就当没给，走 region 那条路的调用方本来也用不到。
      const region = { x: raw.x, y: raw.y, w: raw.w, h: raw.h };
      if (Number.isInteger(raw.sw) && raw.sw > 0 && Number.isInteger(raw.sh) && raw.sh > 0) {
        region.sw = raw.sw;
        region.sh = raw.sh;
      }
      // 负坐标 = 框到主屏外面去了，gdigrab 不接受负 offset（见 pick_region.py 第 3 条）
      if (region.x < 0 || region.y < 0) {
        finish({ result: { ok: false, reason: 'failed', detail: '框到主屏外面了（负坐标），请在主屏里框' } });
        return;
      }
      save(region, env);
      finish({ result: { ok: true, region } });
    });
  });
}
