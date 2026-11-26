/**
 * ocr.js — 血条数字识别（`py/ocr_sidecar.py` 的 Node 侧）。
 *
 * ## 为什么要有这一路
 *
 * 比例法是纯像素统计：条变成暗红（鸣潮低血）、数字压在白条上、右端装饰抢端点时都会错。
 * 2026-11-16 实测同一帧：屏幕 `882/20725 = 4.3%`，比例法给 **11%**。
 * 数字本身是画在条上的，读出来就是真值 —— 这是「读数准」的答案，也不再怕特效遮住条。
 *
 * ## 为什么是常驻子进程而不是一次一进程
 *
 * WinRT 只有 Python/.NET 有绑定，而 Python 冷启动 + import winrt 要几百毫秒。
 * 1 fps 下每帧起一个进程就是每秒白付一次启动；常驻一个、帧走 stdin 更省也更稳。
 * 帧尺寸在启动时定死（`--w/--h`），重框（换尺寸）就重起 —— 协议里没有逐帧头。
 *
 * ## 失败姿态
 *
 * **OCR 永远是可选的**：起不来（没装 winrt、没有中文识别器）就返回 `{ok:false, reason}`，
 * 采集照旧、比例照报，`status` 里写明「OCR 不可用」。这一路不许拖垮血条读数，
 * 更不许编数字 —— 读不出就是 `cur:null`。
 *
 * 注：`winrt` 装在 DSH 的 runtime python 里，**DSH 升级后要重装**
 * （和 `windows-capture` 同一个坑）。`status` 的 OCR 行就是给这件事留的自检。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshRuntimePythons, pythonCandidates } from './window.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** sidecar 脚本（`py/ocr_sidecar.py`）。 */
export function ocrScript() {
  return join(dirname(HERE), 'py', 'ocr_sidecar.py');
}

/** 一帧识别的上限：实测 12–92ms，给 3 秒是防卡死，不是等它慢。 */
export const OCR_TIMEOUT_MS = 3000;

/** 预处理参数：4× Lanczos + 240px 黑底画布（2026-11-16 实测，3× 丢位、6× 带噪）。 */
export const OCR_SCALE = 4;
export const OCR_CANVAS_H = 240;

const PROBE = 'import winrt.windows.media.ocr, winrt.windows.graphics.imaging, winrt.windows.storage.streams; print("ok")';

let cachedProbe = null;

/**
 * 找一个**真的能 import winrt** 的 Python。
 *
 * 只探 import、不探识别器：识别器缺失是 sidecar 启动时报的（`ocr ready` / `ERR`），
 * 两处都要能说人话。结果缓存 —— 探一次要 ~0.3s。
 *
 * @returns {{ok:true, python:string, script:string} | {ok:false, reason:string, tried:string[]}}
 */
export function resolveOcrPython({ env = process.env, force = false } = {}) {
  if (cachedProbe && !force) return cachedProbe;
  const script = ocrScript();
  if (!existsSync(script)) {
    cachedProbe = { ok: false, reason: `sidecar 不在：${script}`, tried: [] };
    return cachedProbe;
  }
  const tried = [];
  /**
   * 先试 DSH runtime 里的那份：`winrt` 就装在那儿（本文件头的注释），而 PATH 上的
   * `pythonw.exe` / `python.exe` 通常没有。顺序只影响 OCR —— `pythonCandidates()` 那份
   * 列表是开悬浮窗用的，别动它的顺序。
   */
  for (const python of [...dshRuntimePythons(env), ...pythonCandidates()]) {
    if (!python || tried.includes(python)) continue;
    tried.push(python);
    const r = spawnSyncProbe(python, env);
    if (r === true) {
      cachedProbe = { ok: true, python, script };
      return cachedProbe;
    }
  }
  cachedProbe = {
    ok: false,
    reason: '没有能 import winrt 的 Python（pip install winrt-runtime winrt-Windows.Media.Ocr …）',
    tried,
  };
  return cachedProbe;
}

function spawnSyncProbe(python, env) {
  try {
    // 同步探针：这里就在启动路径上，异步反而要等一轮事件循环
    const r = spawnSync(python, ['-c', PROBE], {
      timeout: 15000, windowsHide: true, stdio: 'ignore', env,
    });
    return r?.status === 0;
  } catch {
    return false;
  }
}

/**
 * 起一个常驻 OCR 进程。
 *
 * @param {{w:number, h:number, python?:string, script?:string, scale?:number,
 *          canvasH?:number, lang?:string, timeoutMs?:number,
 *          onStderr?:Function, onReady?:Function}} o
 * @returns {{recognize:(buf:Buffer)=>Promise<{text:string,cur:number|null,max:number|null,ms:number}|null>,
 *            stop:()=>void, done:Promise<object>, python:string}}
 */
export function startOcr({
  w, h, python = null, script = null, scale = OCR_SCALE, canvasH = OCR_CANVAS_H,
  lang = 'zh-Hans-CN', timeoutMs = OCR_TIMEOUT_MS, onStderr = null, onReady = null,
  /** `bars`（默认，血条数字，多极性）/ `text`（字幕条带，只跑一遍 plain、按行返回） */
  mode = 'bars',
} = {}) {
  const py = python ?? resolveOcrPython().python;
  if (!py) throw new Error(resolveOcrPython().reason ?? '没有可用的 Python（OCR 需要 winrt）');
  const sc = script ?? ocrScript();
  const W = Number(w);
  const H = Number(h);
  if (!(W > 0) || !(H > 0)) throw new Error(`OCR 帧尺寸不对：${w}x${h}`);

  const child = spawn(py, [
    sc, '--w', String(W), '--h', String(H),
    '--scale', String(scale), '--canvas-h', String(canvasH), '--lang', String(lang),
    // 只在要文本模式时补一个参数：血条那条链的 argv 一个字节都不变
    ...(mode === 'text' ? ['--mode', 'text'] : []),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = [];
  let bufText = '';
  let dead = null;         // 一旦非空：不再写帧，所有等待都 reject
  let ready = false;
  let frames = 0;

  const fail = (err) => {
    if (!dead) dead = err;
    while (pending.length) {
      const p = pending.shift();
      clearTimeout(p.timer);
      p.reject(dead);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    bufText += chunk;
    let nl = bufText.indexOf('\n');
    while (nl >= 0) {
      const line = bufText.slice(0, nl).trim();
      bufText = bufText.slice(nl + 1);
      nl = bufText.indexOf('\n');
      if (!line) continue;
      const p = pending.shift();
      if (!p) continue;
      clearTimeout(p.timer);
      let out = null;
      try { out = JSON.parse(line); } catch { out = { error: 'bad-json' }; }
      if (out && out.error) p.reject(new Error(String(out.error)));
      else p.resolve(out);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    const text = String(d);
    if (!ready && text.includes('ocr ready')) {
      ready = true;
      onReady?.();
    }
    onStderr?.(text);
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => { fail(e); reject(e); });
    child.on('close', (code, signal) => {
      const err = new Error(`OCR sidecar 退出（code=${code}${signal ? `, ${signal}` : ''}）`);
      fail(err);
      if (code === 0) resolve({ code, frames });
      else reject(err);
    });
  });
  done.catch(() => {});   // 没有 await 的地方也不许冒出未处理的 rejection

  /** 丢帧比排队更对：血条读的是"现在"，积压三帧的识别结果没有意义。 */
  function recognize(frame) {
    if (dead) return Promise.reject(dead);
    if (!frame || frame.length < W * H * 4) {
      return Promise.reject(new Error(`OCR 帧太小：${frame?.length ?? 0} < ${W * H * 4}`));
    }
    if (pending.length > 2) {
      const dropped = pending.pop();
      clearTimeout(dropped.timer);
      dropped.reject(new Error('ocr-busy'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = pending.findIndex((p) => p.timer === timer);
        if (i >= 0) pending.splice(i, 1);
        reject(new Error('ocr-timeout'));
      }, timeoutMs);
      pending.push({ resolve, reject, timer });
      frames += 1;
      try {
        child.stdin.write(frame);
      } catch (e) {
        const i = pending.findIndex((p) => p.timer === timer);
        if (i >= 0) pending.splice(i, 1);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function stop() {
    try { child.stdin.end(); } catch { /* 已经关了 */ }
    const t = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } }, 1500);
    t.unref?.();
  }

  return { recognize, stop, done, python: py, get ready() { return ready; } };
}
