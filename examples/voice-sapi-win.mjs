/**
 * voice-sapi-win.mjs — Windows 自带 SAPI（`System.Speech`）的声音适配器。
 *
 * 核心（voice.js）不内置任何引擎，只 dynamic import 一个模块并调 `attach(api)`。
 * 这个文件把「该念了」翻译成一次 PowerShell + `SpeechSynthesizer.Speak()`。
 *
 * 装 上：
 *
 * ```json
 * // ~/.dsh/voice.json
 * { "adapter": "C:/.../see-now-more/examples/voice-sapi-win.mjs" }
 * ```
 *
 * 设置页的「声音」那一行会自动写这份配置。
 *
 * 音色（可选，和 dsh-watch-together 共用同一份 `~/.dsh/tts.json`）：
 *
 * ```json
 * { "voice": "Microsoft Huihui Desktop", "rate": 0 }
 * ```
 *
 * `rate` 两种写法都收：`-10..10` 当 SAPI 原生语速；其它值按「每分钟词数」折算
 * （例如 mac 那边的 `185` 会折成 0）。本机中文音色一般是 `Microsoft Huihui Desktop`。
 *
 * ## 和 mac 版一样的三条设计
 *
 * ① **不排队，正在念就丢掉新的** —— 看屏幕时"等它念完"比漏一句更糟。
 * ② **`spoken` 在进程起来的瞬间发**，不等念完（展示层是"字跟着声音走"）。
 * ③ **detach 要杀进程** —— 关窗就闭嘴，别让声音拖在人已经走了之后。
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { splitEmphasis } from '../src/speech.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const adapterName = 'sapi-win';

const DEFAULTS = Object.freeze({ voice: '', rate: 0 });

function readTtsConfig(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const raw = JSON.parse(readFileSync(join(home, 'tts.json'), 'utf8'));
    const out = { ...DEFAULTS };
    if (typeof raw?.voice === 'string' && raw.voice.trim()) out.voice = raw.voice.trim();
    if (Number.isFinite(raw?.rate)) out.rate = Number(raw.rate);
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

/** tts.json 的 rate → SAPI 的 -10..10（容忍 mac 那种"每分钟词数"）。 */
function toSapiRate(rate) {
  if (!Number.isFinite(rate)) return 0;
  const r = Math.abs(rate) <= 10 ? rate : Math.round((rate - 185) / 15);
  return Math.max(-10, Math.min(10, r));
}

const PS_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:DSH_SAY_VOICE) { try { $s.SelectVoice($env:DSH_SAY_VOICE) } catch { } }',
  'try { $s.Rate = [int]$env:DSH_SAY_RATE } catch { }',
  // SpeakSsml 才支持 <emphasis>（重读）；纯文本走 Speak 会被当标记念出来
  'if ($env:DSH_SAY_SSML) { $s.SpeakSsml($env:DSH_SAY_SSML) } else { $s.Speak($env:DSH_SAY_TEXT) }',
].join('; ');

/**
 * 语音标记 → SSML（2026-11-20 重写）：
 *
 * - `**顺**` → `<prosody rate="+0%" volume="loud">顺</prosody>`，其余部分各套一段
 *   `<prosody rate="+10%">`：**非重点快 10%、重点回到原速**，跟 edge 那套对比一样，
 *   但 SAPI 是一次合成，所以能精确落到「顺」而不切断「顺时针」——edge 做不到的那件事。
 *   （实测 `rate="+10%"` 有效：同一句 5.42s → 4.87s。）
 * - `‖` → `<break time="200ms"/>`：换气口，SAPI 自己就能精确插。
 * - `X~` → 把 X 套进 `<prosody rate="x-slow">`：拖音。
 */
export function toSsml(text, { baseRate = '+10%', strongRate = '+0%', strongVolume = 'loud' } = {}) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 标记与 edge 档一致（2026-11-20）：`〔…〕` = 重读段（SAPI 也是一次合成，能精确到字），
  // `**加粗**` 只管气泡排版，这里先剥掉；`‖` = 换气口（<break>）；`X~` = 拖音。
  const plain = String(text).replace(/\*\*/g, '');
  const body = plain.split('‖').map((chunk) => {
    const m = /〔([^〕]+)〕/.exec(chunk);
    const slowTilde = (s) => esc(s).replace(/([^，。、！？；：…\s])~/g, '<prosody rate="x-slow">$1</prosody>');
    if (!m) return `<prosody rate="${baseRate}">${slowTilde(chunk)}</prosody>`;
    const i = chunk.indexOf('〔');
    const j = chunk.indexOf('〕');
    const pre = chunk.slice(0, i);
    const emph = chunk.slice(i + 1, j);
    const suf = chunk.slice(j + 1);
    return (pre ? `<prosody rate="${baseRate}">${slowTilde(pre)}</prosody>` : '')
      + `<prosody rate="${strongRate}" volume="${strongVolume}">${esc(emph)}</prosody>`
      + (suf ? `<prosody rate="${baseRate}">${slowTilde(suf)}</prosody>` : '');
  }).join('<break time="200ms"/>');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">${body}</speak>`;
}
export async function attach(api, options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('`System.Speech` 只在 Windows 上可用（macOS 用 voice-say-mac.mjs）');
  }
  // 探一次：没装 .NET 语音组件的机器要有个说得清的理由，别装作挂上了
  const probe = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech'],
    { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  if (probe.status !== 0) throw new Error('PowerShell 里加载不了 System.Speech（本机缺少语音组件？）');

  const cfg = { ...readTtsConfig(), ...(options && typeof options === 'object' ? options : {}) };
  const rate = toSapiRate(cfg.rate);
  let current = null;
  let alive = true;

  const speakOne = (ev) => {
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        {
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...process.env,
            DSH_SAY_TEXT: ev.text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/‖/g, '，').replace(/~/g, ''),
            DSH_SAY_SSML: /\*\*.+?\*\*|‖|~/.test(ev.text) ? toSsml(ev.text) : '',
            DSH_SAY_VOICE: cfg.voice || '',
            DSH_SAY_RATE: String(rate),
          },
        });
    } catch {
      return;
    }
    current = child;
    // 进程起来了 = 马上就出声，此刻上报才对得上展示层
    try { api.emitSpoken({ text: ev.text, at: ev.at }); } catch { /* 上报失败不影响念 */ }

    const done = () => { if (current === child) current = null; };
    child.on('close', done);
    child.on('error', done);
  };

  const off = api.onSpeech((ev) => {
    if (ev?.state !== 'due') return;
    const text = String(ev.text ?? '').trim();
    if (!text || !alive) return;
    if (current) {
      try { api.emitSpeech({ text, at: ev.at ?? null, state: 'skipped' }); } catch { /* 没人听也无所谓 */ }
      return;
    }
    speakOne({ text, at: ev.at ?? null });
  });

  return () => {
    alive = false;
    try { off?.(); } catch { /* 已经退订 */ }
    if (current) {
      try { current.kill(); } catch { /* 已经没了 */ }
      current = null;
    }
  };
}

export default attach;
