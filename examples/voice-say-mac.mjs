/**
 * voice-say-mac.mjs — macOS 自带 `say` 的声音适配器。
 *
 * 核心（voice.js）不内置任何引擎，只 dynamic import 一个模块并调 `attach(api)`。
 * 这个文件就是那个模块：把「该念了」翻译成一次 `say` 调用。
 *
 * 装上：
 *
 * ```json
 * // ~/.dsh/voice.json
 * { "adapter": "/绝对路径/examples/voice-say-mac.mjs" }
 * ```
 *
 * 音色（可选，和 dsh-watch-together 共用同一份）：
 *
 * ```json
 * // ~/.dsh/tts.json
 * { "voice": "Tingting", "rate": 185 }
 * ```
 *
 * 不写就是这个默认值。`say -v '?' | grep zh_` 可以列出本机所有中文音色。
 *
 * ## 三条刻意的设计
 *
 * ① **不排队，正在念就丢掉新的**。`say` 同时起两个进程会抢音频设备，听起来像结巴；
 *    而"等着一句一句念"在看屏幕这件事上更糟 —— 等它念完，画面早就过去了。
 *    丢掉时发 `skipped`，让展示层知道这句不算数。
 *
 * ② **`spoken` 在进程起来的瞬间发，不等念完**。展示层的规矩是"字跟着声音走"，
 *    所以要在出声**之前或同时**上报。等 exit 再报，字会比声音晚一整句。
 *
 * ③ **detach 要杀进程**。关掉悬浮窗时正在念的那句必须立刻停，否则人已经关窗了，
 *    声音还在继续说 —— 那是这个插件最容易显得"没礼貌"的地方。
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const adapterName = 'say-mac';

const DEFAULTS = Object.freeze({ voice: 'Tingting', rate: 185 });

function readTtsConfig(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const raw = JSON.parse(readFileSync(join(home, 'tts.json'), 'utf8'));
    const out = { ...DEFAULTS };
    if (typeof raw?.voice === 'string' && raw.voice.trim()) out.voice = raw.voice.trim();
    if (Number.isFinite(raw?.rate)) out.rate = Math.max(80, Math.min(400, Number(raw.rate)));
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function attach(api) {
  // 先验一下 `say` 在不在：不在就别装作挂上了，让 status 有一个说得清的理由
  const probe = spawnSync('say', ['-v', '?'], { stdio: 'ignore' });
  if (probe.status !== 0) throw new Error('`say` 不可用（这个适配器只能在 macOS 上用）');

  const cfg = readTtsConfig();
  let current = null;          // 正在念的 child_process
  let alive = true;

  const speakOne = (ev) => {
    const args = [];
    if (cfg.voice) args.push('-v', cfg.voice);
    if (cfg.rate) args.push('-r', String(cfg.rate));
    args.push(ev.text);

    let child;
    try {
      child = spawn('say', args, { stdio: 'ignore' });
    } catch {
      return;
    }
    current = child;
    // 进程起来了 = 马上就要出声，此刻上报才对得上展示层的规矩
    try { api.emitSpoken({ text: ev.text, at: ev.at }); } catch { /* 上报失败不影响念 */ }

    const done = () => { if (current === child) current = null; };
    child.on('close', done);
    child.on('error', done);
  };

  const off = api.onSpeech((ev) => {
    if (ev?.state !== 'due') return;          // 只认"该念了"，spoken/skipped 是我们自己发的
    const text = String(ev.text ?? '').trim();
    if (!text || !alive) return;
    if (current) {
      // 上一句还没念完：这句直接丢，别让它变成积压的弹幕
      try { api.emitSpeech({ text, at: ev.at ?? null, state: 'skipped' }); } catch { /* 没人听也无所谓 */ }
      return;
    }
    speakOne({ text, at: ev.at ?? null });
  });

  return () => {
    alive = false;
    try { off?.(); } catch { /* 已经退订 */ }
    if (current) {
      try { current.kill('SIGTERM'); } catch { /* 已经没了 */ }
      current = null;
    }
  };
}

export default attach;
