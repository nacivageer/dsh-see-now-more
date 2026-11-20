/**
 * pointer.js — 在屏幕上圈一个位置，然后**停住等一个信号**（`see_now` 的 `action:"pointer"`）。
 *
 * 分工跟 `region.js` 一样：
 *   - `pointer.py`（Python）：只负责画和等，stdout 吐一行 JSON
 *   - 这里（Node）：开关、参数校验、额度、挑解释器、超时、把结果整成工具返回的形状
 *
 * ## 三个不
 *
 * - **不碰 `window.py`**：那颗悬浮窗是陪看项目共用的 489 KB 脚本，画圈另起一个一次性进程，
 *   退出即清屏，不留常驻覆盖层。
 * - **不用全局热键**：`RegisterHotKey` 会抢系统组合键、和输入法打架；覆盖层又是鼠标穿透的，
 *   收不到键盘事件。改成在 Python 侧轮询 `GetAsyncKeyState`，穿透不受影响。
 * - **不把「画面变了」当「做完了」**：`change` 只报「那个坐标上换了个窗口」。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dshHome } from './chat.js';
import { PACKAGED, hasTkinter, pythonCandidates } from './window.js';

/** 等信号的默认时长（毫秒）。 */
export const DEFAULT_WAIT_MS = 20_000;
/** 等信号的上限。必须明显小于 `TOOL_TIMEOUT_MS`（900s），否则整条调用会被宿主掐掉。 */
export const MAX_WAIT_MS = 120_000;
export const MIN_WAIT_MS = 1_000;
/** 圈的大小 / 判定范围上限。 */
export const MAX_RADIUS = 400;
export const MIN_RADIUS = 20;
/** 标签上限（超出截断，返回里标 truncated）。 */
export const MAX_LABEL = 40;
/** 同一会话一分钟内的调用上限（防刷屏）。 */
export const BUDGET_PER_MIN = 6;

const SHAPES = ['circle', 'arrow', 'box'];
const WAITS = ['click', 'change', 'none'];

export function pointerScript() {
  return join(PACKAGED, '..', 'pointer.py');
}

function readJson(p) {
  // BOM 必须剥：PowerShell 5.1 的 Set-Content 会带 BOM，JSON.parse 直接抛（window.js 里踩过）
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) ?? {}; } catch { return {}; }
}

/**
 * 开关：默认关。`DSH_SEE_POINTER=1` 只用于开发期临时打开。
 *
 * 这是 `write-guard` 的第一条硬约束，不是保守——它会在用户屏幕上画东西并阻塞一次调用，
 * 装完就该是关的，要用户明确说一次「开」。
 */
export function pointerEnabled(env = process.env) {
  if (String(env.DSH_SEE_POINTER ?? '') === '1') return true;
  const cfg = readJson(join(dshHome(env), 'see-now.json'));
  return cfg?.pointer?.enabled === true;
}

const recent = [];

function allowCall(now = Date.now()) {
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= BUDGET_PER_MIN) return false;
  recent.push(now);
  return true;
}

export function __resetPointerBudget() { recent.length = 0; }

/**
 * 参数校验。纯函数，单测直接打它。
 * @returns {{ok:true, args:object} | {ok:false, reason:string, detail:string}}
 */
export function validatePointerArgs(raw = {}) {
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return { ok: false, reason: 'bad-args', detail: 'x / y 必填，且要是整数（屏幕物理像素）' };
  }
  if (x < 0 || y < 0) {
    return { ok: false, reason: 'bad-args', detail: 'x / y 不能是负数（不支持主屏之外的坐标）' };
  }
  const label = String(raw.label ?? '').trim();
  if (!label) return { ok: false, reason: 'bad-args', detail: 'label 必填：不许画一个没话说的圈' };

  const shape = String(raw.shape ?? 'circle').toLowerCase();
  if (!SHAPES.includes(shape)) {
    return { ok: false, reason: 'bad-args', detail: `shape 只能是 ${SHAPES.join(' / ')}` };
  }
  const wait = String(raw.wait ?? 'click').toLowerCase();
  if (!WAITS.includes(wait)) {
    return { ok: false, reason: 'bad-args', detail: `wait 只能是 ${WAITS.join(' / ')}` };
  }
  let waitMs = raw.waitMs === undefined || raw.waitMs === null ? DEFAULT_WAIT_MS : Number(raw.waitMs);
  if (!Number.isFinite(waitMs)) return { ok: false, reason: 'bad-args', detail: 'waitMs 要是数字' };
  waitMs = Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, Math.round(waitMs)));

  let radius = raw.radius === undefined || raw.radius === null ? 60 : Number(raw.radius);
  if (!Number.isFinite(radius)) return { ok: false, reason: 'bad-args', detail: 'radius 要是数字' };
  radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.round(radius)));

  return {
    ok: true,
    args: { x, y, label: label.slice(0, MAX_LABEL), shape, wait, waitMs, radius },
  };
}

function runPy(python, script, args, timeoutMs, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...env, DSH_POINTER_ARGS: JSON.stringify(args) },
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
      finish({ result: { ok: true, signal: 'unknown', detail: `子进程 ${timeoutMs}ms 没回来，已收掉` } });
    }, timeoutMs + 5_000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ spawned: false, detail: String(e?.message ?? e) }));
    child.on('exit', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* 下面统一报 */ }
      if (msg?.event === 'error') {
        finish({ result: { ok: false, reason: msg.reason || 'failed', detail: msg.detail || '' } });
        return;
      }
      if (msg?.event === 'signal') {
        // 取消不算结果：与 region.js 的约定一致（ok:false + reason:'cancelled'），
        // 让模型看到的是「这次没拿到信号」，而不是一个 signal 字段。
        if (msg.signal === 'cancelled') {
          finish({ result: { ok: false, reason: 'cancelled' } });
          return;
        }
        finish({ result: { ok: true, ...msg } });
        return;
      }
      finish({
        result: {
          ok: false,
          reason: code === 2 ? 'cancelled' : 'failed',
          detail: (err || line || `退出码 ${code}`).slice(0, 400),
        },
      });
    });
  });
}

/**
 * 画一个圈，等一个信号。
 *
 * @param {{x:number,y:number,label:string,shape?:string,wait?:string,waitMs?:number,radius?:number}} raw
 * @returns {Promise<{ok:true, signal:string, inside?:boolean|null, hwnd?:number|null, elapsedMs?:number, truncated?:boolean}
 *                 | {ok:false, reason:string, detail?:string}>}
 */
export async function pointAndWait(raw = {}, { env = process.env, log = () => {} } = {}) {
  if (!pointerEnabled(env)) {
    return { ok: false, reason: 'disabled', detail: 'pointer 默认关：~/.dsh/see-now.json 里设 "pointer":{"enabled":true}' };
  }
  const v = validatePointerArgs(raw);
  if (!v.ok) return v;
  if (!allowCall()) {
    return { ok: false, reason: 'rate-limited', detail: `一分钟内最多 ${BUDGET_PER_MIN} 次` };
  }

  const script = pointerScript();
  if (!existsSync(script)) return { ok: false, reason: 'no-script', detail: script };

  const tried = [];
  for (const python of pythonCandidates()) {
    if (!hasTkinter(python)) { tried.push(`${python}（无 tkinter）`); continue; }
    log(`pointer: 用 ${python}`);
    const r = await runPy(python, script, v.args, v.args.waitMs, env);
    if (r.spawned === false) { tried.push(`${python}（${r.detail}）`); continue; }
    return r.result;
  }
  return { ok: false, reason: 'no-python', detail: tried.join(' / ') || '没有候选解释器' };
}
