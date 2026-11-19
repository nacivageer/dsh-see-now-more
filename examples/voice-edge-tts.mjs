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
 *
 * **加粗怎么念**：默认只放慢 12%（0.1.1-more.18 的行为），可以在 `options.emphasis` 里调：
 *
 * ```json
 * { "adapter": "C:/.../examples/voice-edge-tts.mjs",
 *   "options": { "python": "...", "emphasis": { "rate": "-12%", "pitch": "+15Hz", "pauseMs": 150 } } }
 * ```
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { splitEmphasis } from '../src/speech.js';
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

  // **加粗怎么念**：全部可调。默认值（2026-11-20 定）：
  // 非重点略微**加快**、重点放慢 20% + 音量抬一档、**不碰音高**、**不自动加停顿**。
  // 依据一（音色）：`--rate` 与 atempo 都不改音色（谱包络距离 0.0001 / 0.0012），
  //   而 `--pitch` 移调会改（+2 个半音 → 0.044，40 倍）——"像换了个人"就是它。
  // 依据二（对比）：真人重读不是"只把重点拉长"，是**把非重点压缩**再拉长重点
  //   （格 2026-11-20 的听感：「先别急着」该快、「输出」该重）。所以句内其它段
  //   不给 +0%，而是给一个略快的 baseRate —— 对比自己就出来了，不用逐句调。
  // 依据三（气口）：`|` 是**换气口**，不是逗号——150ms 左右，短到不把后半句切成独立一句。
  //   加粗段后面**不**自动插停顿（pauseMs 默认 0），否则「最辉煌｜的成就」会断词。
  //   { "rate": "-20%", "baseRate": "+8%", "pitch": "+0Hz", "volume": "+20%",
  //     "pauseMs": 0, "breathMs": 200 }
  // edge-tts 不支持 SSML，所以只能按段合成再拼接；参数分别落在每段的 `--rate` /
  // `--pitch` / `--volume` 和段后的静音上。
  const emp = {
    rate: typeof options?.emphasis?.rate === 'string' ? options.emphasis.rate : '-20%',
    baseRate: typeof options?.emphasis?.baseRate === 'string' ? options.emphasis.baseRate : '+8%',
    pitch: typeof options?.emphasis?.pitch === 'string' ? options.emphasis.pitch : '+0Hz',
    volume: typeof options?.emphasis?.volume === 'string' ? options.emphasis.volume : '+20%',
    pauseMs: Number.isFinite(Number(options?.emphasis?.pauseMs))
      ? Math.max(0, Math.min(600, Number(options.emphasis.pauseMs)))
      : 0,
    breathMs: Number.isFinite(Number(options?.emphasis?.breathMs))
      ? Math.max(0, Math.min(400, Number(options.emphasis.breathMs)))
      : 200,
  };

  const silenceCache = new Map();   // 每种时长只合成一次
  const silenceFor = (ms) => {
    const key = Math.round(ms);
    if (silenceCache.has(key)) return silenceCache.get(key);
    const f = join(tmpdir(), `dsh-say-sil-${process.pid}-${key}.mp3`);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(key / 1000),
      '-c:a', 'libmp3lame', '-b:a', '48k', f], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) throw new Error('silence failed');
    silenceCache.set(key, f);
    return f;
  };

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
  const job_synth = new Set();

  const cleanup = (file) => { try { unlinkSync(file); } catch { /* 已经没了 */ } };

  const runSynth = (text, rate, file, pitch = '+0Hz', volume = '+0%') => new Promise((resolve) => {
    let child;
    try {
      // `--rate=-12%` 必须用等号：写成 `--rate -12%` 时 argparse 会把 -12% 当选项
      child = spawn(python, ['-m', 'edge_tts', '--voice', cfg.voice, `--rate=${rate}`,
        `--pitch=${pitch}`, `--volume=${volume}`, '--text', text, '--write-media', file],
      { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve({ ok: false });
      return;
    }
    job_synth.add(child);
    child.on('close', (code) => { job_synth.delete(child); resolve({ ok: code === 0 }); });
    child.on('error', () => { job_synth.delete(child); resolve({ ok: false }); });
  });

  // edge 每段自己带 100–200ms 起止静音；两段拼起来就变成「的｜第」之间凭空多一个停顿。
  // 拼接前把首尾静音裁到 50ms（留一点，避免硬切）。
  const trimEdges = (file) => {
    const outF = file.replace(/\.mp3$/, '-trim.mp3');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,'
        + 'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse',
      '-c:a', 'libmp3lame', '-b:a', '48k', outF], { stdio: 'ignore', windowsHide: true });
    return r.status === 0 ? outF : file;
  };

  const startOne = async (ev) => {
    const stamp = `${process.pid}-${Date.now()}-${(seq += 1)}`;
    const file = join(tmpdir(), `dsh-say-${stamp}.mp3`);
    const job = { play: null, file, parts: [] };
    synth = job;

    // **加粗 = emp.rate / emp.pitch / emp.volume**；`‖` = 换气口（breathMs）。
    // 注意：`|` 会在 `stripForSpeech` 里被换成空格（表格那条规则），所以气口用 `‖`。
    // 换气口**不切段**：先把 `‖` 换成逗号让引擎自己吐一口气，合成完再把内部静音
    // 压到 breathMs —— 切段会让后半句"重新开口"（句尾下落 + 新的起音），
    // 就没有"弹簧按一下又弹回来"的连贯感了（格 2026-11-20 的判据）。
    const hadBreath = String(ev.text).includes('‖');
    const spoken = String(ev.text).replace(/‖/g, '，');
    const chunks = [spoken];
    try {
      const segs0 = splitEmphasis(spoken);
      if (segs0.length <= 1 && !hadBreath) {
        const r = await runSynth(spoken, '+0%', file);
        if (!r.ok) throw new Error('synth failed');
      } else {
        const clips = [];
        let n = 0;
        for (let i = 0; i < segs0.length; i += 1) {
          const part = join(tmpdir(), `dsh-say-${stamp}-${n += 1}.mp3`);
          job.parts.push(part);
          const r = await runSynth(segs0[i].text,
            segs0[i].strong ? emp.rate : emp.baseRate,
            part,
            segs0[i].strong ? emp.pitch : '+0Hz',
            segs0[i].strong ? emp.volume : '+0%');
          if (!r.ok) throw new Error('synth failed');
          const trimmed = trimEdges(part);
          if (trimmed !== part) job.parts.push(trimmed);
          clips.push(trimmed);
          // 加粗段后的自动停顿默认关（emp.pauseMs=0）：整句里凭空多一个气口会像逗号
          if (segs0[i].strong && emp.pauseMs > 0 && i < segs0.length - 1) {
            clips.push(silenceFor(emp.pauseMs));
          }
        }
        const list = join(tmpdir(), `dsh-say-${stamp}.txt`);
        job.parts.push(list);
        writeFileSync(list, clips.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
        // 裁过边 + 夹静音，编码参数不一定一致，统一重编码
        const concat = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '48k', file],
        { stdio: 'ignore', windowsHide: true });
        if (concat.status !== 0) throw new Error('concat failed');
      }
      // 换气口：把内部静音压到 breathMs（逗号那口"气"本来 300–400ms，太长就成逗号了）
      if (hadBreath) {
        const short = join(tmpdir(), `dsh-say-${stamp}-breath.mp3`);
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
          '-af', `silenceremove=stop_periods=-1:stop_duration=${(emp.breathMs / 1000).toFixed(2)}`
            + ':stop_threshold=-40dB:detection=peak',
          '-c:a', 'libmp3lame', '-b:a', '48k', short], { stdio: 'ignore', windowsHide: true });
        if (r.status === 0) {
          job.parts.push(short);
          copyFileSync(short, file);
        }
      }
      if (!alive) throw new Error('detached');
      let play;
      try {
        play = spawn(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', file],
          { stdio: 'ignore', windowsHide: true });
      } catch {
        throw new Error('play failed');
      }
      job.play = play;
      try { api.emitSpoken({ text: ev.text, at: ev.at }); } catch { /* 上报失败不影响念 */ }
      const done = () => {
        for (const f of [file, ...job.parts]) cleanup(f);
        if (synth === job) synth = null;
      };
      play.on('close', done);
      play.on('error', done);
    } catch {
      try { api.emitSpeech({ text: ev.text, at: ev.at ?? null, state: 'skipped' }); } catch { /* 没人听 */ }
      for (const f of [file, ...job.parts]) cleanup(f);
      if (synth === job) synth = null;
    }
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
    for (const c of [...job_synth]) { try { c.kill(); } catch { /* 已经没了 */ } }
    job_synth.clear();
    for (const f of silenceCache.values()) cleanup(f);
    silenceCache.clear();
    if (synth) {
      try { synth.play?.kill(); } catch { /* 已经没了 */ }
      for (const f of [synth.file, ...(synth.parts ?? [])]) cleanup(f);
      synth = null;
    }
  };
}

export default attach;
