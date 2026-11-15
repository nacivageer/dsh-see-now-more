/**
 * capture-window.js — 按**窗口**抓画面（Windows Graphics Capture）。
 *
 * ## 为什么不是 ffmpeg
 *
 * ffmpeg 的两条屏幕路（`ddagrab` 走桌面复制、`gdigrab` 走 GDI）抓的都是**屏幕上的像素**：
 * 游戏窗口被浏览器/GUI 挡住，抓到的就是挡住它的东西；最小化更是什么都没有。
 * WGC 抓的是**窗口自己的表面**，跟屏幕合成无关，被遮挡照样有，而且不注入、不改游戏。
 *
 * ## 为什么是 Python sidecar 而不是 ffmpeg 滤镜
 *
 * ffmpeg 没有 WGC 输入。`windows-capture`（Rust 扩展）是现成的绑定，帧直接是
 * BGRA 的 numpy 数组。所以这里起一个 Python 子进程，**输出 rawvideo 到 stdout**，
 * 和 ffmpeg 那条路的字节形状完全一致 —— 读帧、背压、收尾全部复用 `spawnFrames`。
 *
 * ## 边界（写在代码里，别在真机上重新踩）
 *
 * - **只认非最小化的窗口**：最小化后窗口停止渲染，WGC 拿不到帧。
 * - **D3D 独占全屏抓不到**，要无边框窗口；独占全屏时那条路本来就该用 ddagrab 全屏。
 * - `--region` 收的是**屏幕物理像素**（和 `bloodbar.json` 同一套），
 *   sidecar 按窗口当前 rect 换算成窗口内坐标，所以窗口拖来拖去不用重框。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnFrames } from './capture.js';
import { pythonCandidates } from './window.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** sidecar 脚本（`py/wgc_capture.py`）。 */
export function wgcScript() {
  return join(dirname(HERE), 'py', 'wgc_capture.py');
}

/** 等第一帧的上限：WGC 起会话一般 <1s，给 6 秒。 */
export const WGC_FIRST_FRAME_MS = 6000;

/**
 * 找一个**真的能 import `windows_capture`** 的 Python。
 *
 * 不能只看命令存在：DSH 自带 runtime、商店版、PATH 上的 python 都可能没装这个包，
 * 而"装了没装"只有真跑一次才知道。结果缓存起来 —— 探一次要 ~0.5s。
 *
 * @returns {{ok:true, python:string, script:string} | {ok:false, reason:string, tried:string[]}}
 */
let cached = null;
export function resolveWgcPython({ env = process.env, force = false } = {}) {
  if (cached && !force) return cached;
  const script = wgcScript();
  if (!existsSync(script)) {
    cached = { ok: false, reason: `sidecar 不在：${script}`, tried: [] };
    return cached;
  }
  const tried = [];
  /**
   * 验的是「**sidecar 能不能跑**」，不是「包能不能裸 import」。
   *
   * `windows_capture/__init__.py` 顶层 `import cv2`（只为了 `imwrite`），
   * 没装 opencv 时裸 import 必挂 —— 而 sidecar 自己会塞一个 cv2 stub 绕过去。
   * 所以探针必须带上同样的 stub，否则会出现「探针说不支持、sidecar 其实能跑」的假阴性。
   */
  const probe = 'import sys,types;'
    + "m=types.ModuleType('cv2');m.imwrite=lambda *a,**k:False;sys.modules.setdefault('cv2',m);"
    + 'import windows_capture,numpy';
  for (const python of pythonCandidates()) {
    if (!python || tried.includes(python)) continue;
    tried.push(python);
    const r = spawnSync(python, ['-c', probe], {
      timeout: 15000, windowsHide: true, stdio: 'ignore', env,
    });
    if (r?.status === 0) {
      cached = { ok: true, python, script };
      return cached;
    }
  }
  cached = { ok: false, reason: '没有能 import windows_capture 的 Python（pip install windows-capture）', tried };
  return cached;
}

/**
 * 起一路按窗口抓的帧流。
 *
 * @param {{
 *   source: {kind:'window', title?:string, hwnd?:number},
 *   region: {x:number,y:number,w:number,h:number},
 *   fps?: number, python?: string, script?: string,
 *   onFrame?: Function, onStderr?: Function, onFirst?: Function,
 * }} o
 *   `region` 是**屏幕物理像素**，也是这一路输出的尺寸（固定，血条按它算比例）。
 * @returns {{stop:()=>void, done:Promise<object>}}
 */
export function spawnWindowFrames({
  source, region, fps = 1, python = null, script = null,
  onFrame, onStderr = null, onFirst = null,
} = {}) {
  const py = python ?? resolveWgcPython().python;
  if (!py) {
    const why = resolveWgcPython();
    throw new Error(why.reason ?? '没有可用的 Python（WGC 需要 windows-capture）');
  }
  const sc = script ?? wgcScript();
  const s = source ?? {};
  const argv = [py, sc, '--fps', String(fps)];
  if (s.hwnd) argv.push('--hwnd', String(s.hwnd));
  else if (s.title) argv.push('--title', String(s.title));
  else throw new Error('window 源要给 title 或 hwnd');
  if (region) {
    argv.push('--region', `${region.x},${region.y},${region.w},${region.h}`);
  }
  return spawnFrames({
    source: { kind: 'window', ...s },
    width: region?.w,
    height: region?.h,
    fps,
    channels: 4,
    pixFmt: 'bgra',
    argv,
    onFrame, onStderr, onFirst,
  });
}
