/**
 * voice-edge-tts.mjs — 用微软在线语音（`edge-tts`）念 `say` 的声音适配器。
 *
 * 比 SAPI 自然得多（例如 `zh-CN-XiaoxiaoNeural`），代价是**要联网**、且需要
 * 一个装了 `edge-tts` 的 Python（见下）。断网时这条会哑，`status` 的「声音」行会报原因。
 *
 * ```json
 * // ~/.dsh/voice.json
 * { "adapter": "C:/.../examples/voice-edge-tts.mjs", "options": { "python": "H:/asr-local/.venv/Scripts/python.exe" } }
 * ```
 *
 * 设置页的「声音」行会自动写 `adapter`；`options.python` 不写时按这个顺序找：
 * `DSH_TTS_PYTHON` 环境变量 → `~/.dsh/see-window.json` 的 `listenPython` → `python`。
 *
 * 音色：`~/.dsh/tts.json` 的 `voice`（默认 `zh-CN-XiaoxiaoNeural`）。可用列表：
 * `python -m edge_tts --list-voices | findstr zh-CN`。
 *
 * 流程：先 `edge-tts` 合成一个临时 mp3，再由 `ffplay -nodisp -autoexit` 播放。
 * ffplay 起来的那一刻才发 `spoken`（展示层"字跟着声音走"），念完删临时文件。
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const adapterName = 'edge-tts';

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

function homeDir(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

function readTtsConfig(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(join(homeDir(env), 'tts.json'), 'utf8'));
    return {
      voice: typeof raw?.voice === 'string' && raw.voice.trim() ? raw.voice.trim() : DEFAULT_VOICE,
    };
  } catch {
    return { voice: DEFAULT_VOICE };
  }
}

/** python 从哪来：options → 环境变量 → see-window.json 的 listenPython → PATH 里的 python。 */
function resolvePython(options = {}, env = process.env) {
  const fromOpt = String(options?.python ?? '').trim();
  if (fromOpt) return fromOpt;
  const fromEnv = String(env.DSH_TTS_PYTHON ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const win = JSON.parse(readFileSync(join(homeDir(env), 'see-window.json'), 'utf8'));
    const listen = String(win?.listenPython ?? '').trim();
    if (listen) return listen;
  } catch { /* 没配就用 PATH */ }
  return 'python';
}

export async function attach(api, options = {}) {
  const python = resolvePython(options);
  const ffplay = String(options?.ffplay ?? process.env.DSH_FFPLAY ?? 'ffplay');
  const cfg = readTtsConfig();

  // 探一次：python 里没有 edge_tts 就直说，别让用户以为是"没声音"
  const probe = spawnSync(python, ['-c', 'import edge_tts'], {
    stdio: 'ignore', windowsHide: true, timeout: 20000,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`找不到可用的 edge-tts（${python} -c "import edge_tts" 失败）：装进那个 Python，或用 options.python 指定`);
  }

  let synth = null;     // 正在合成/播放的那一条：{ synth, play, file }
  let alive = true;
  let seq = 0;

  const cleanup = (file) => { try { unlinkSync(file); } catch { /* 已经没了 */ } };

  const startOne = (ev) => {
    const file = join(tmpdir(), `dsh-say-${process.pid}-${Date.now()}-${(seq += 1)}.mp3`);
    let child;
    try {
      child = spawn(python, ['-m', 'edge_tts', '--voice', cfg.voice, '--text', ev.text,
        '--write-media', file], { stdio: 'ignore', windowsHide: true });
    } catch {
      return;
    }
    const job = { synth: child, play: null, file };
    synth = job;

    child.on('close', (code) => {
      if (!alive) { cleanup(file); return; }
      if (code !== 0) {
        // 合成失败（多半是断网）：这句算跳过，别让展示层一直等
        try { api.emitSpeech({ text: ev.text, at: ev.at ?? null, state: 'skipped' }); } catch { /* 没人听 */ }
        if (synth === job) synth = null;
        cleanup(file);
        return;
      }
      let play;
      try {
        play = spawn(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', file],
          { stdio: 'ignore', windowsHide: true });
      } catch {
        if (synth === job) synth = null;
        cleanup(file);
        return;
      }
      job.play = play;
      // ffplay 起来 = 马上出声
      try { api.emitSpoken({ text: ev.text, at: ev.at }); } catch { /* 上报失败不影响念 */ }
      const done = () => {
        if (synth === job) synth = null;
        cleanup(file);
      };
      play.on('close', done);
      play.on('error', done);
    });
    child.on('error', () => {
      if (synth === job) synth = null;
      cleanup(file);
    });
  };

  const off = api.onSpeech((ev) => {
    if (ev?.state !== 'due') return;
    const text = String(ev.text ?? '').trim();
    if (!text || !alive) return;
    if (synth) {
      try { api.emitSpeech({ text, at: ev.at ?? null, state: 'skipped' }); } catch { /* 没人听也无所谓 */ }
      return;
    }
    startOne({ text, at: ev.at ?? null });
  });

  return () => {
    alive = false;
    try { off?.(); } catch { /* 已经退订 */ }
    if (synth) {
      try { synth.synth?.kill(); } catch { /* 已经没了 */ }
      try { synth.play?.kill(); } catch { /* 已经没了 */ }
      cleanup(synth.file);
      synth = null;
    }
  };
}

export default attach;
