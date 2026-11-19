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
    rate: typeof options?.emphasis?.rate === 'string' ? options.emphasis.rate : '+0%',
    baseRate: typeof options?.emphasis?.baseRate === 'string' ? options.emphasis.baseRate : '+10%',
    pitch: typeof options?.emphasis?.pitch === 'string' ? options.emphasis.pitch : '+0Hz',
    volume: typeof options?.emphasis?.volume === 'string' ? options.emphasis.volume : '+15%',
    pauseMs: Number.isFinite(Number(options?.emphasis?.pauseMs))
      ? Math.max(0, Math.min(600, Number(options.emphasis.pauseMs)))
      : 0,
    absorbMax: Number.isFinite(Number(options?.emphasis?.absorbMax))
      ? Math.max(0, Math.min(8, Number(options.emphasis.absorbMax)))
      : 6,
    // 段与段之间的气口（毫秒，含两侧各留的 50ms）；200ms ≈ 1.1 倍速下两个字的间隔
    gapMs: Number.isFinite(Number(options?.emphasis?.gapMs))
      ? Math.max(100, Math.min(500, Number(options.emphasis.gapMs)))
      : 200,
    // 非重点段的音量（情绪预设会改它）
    baseVolume: typeof options?.emphasis?.baseVolume === 'string' ? options.emphasis.baseVolume : '+0%',
    // 整句短于这么多汉字就整句一次念（情绪短句不切段），0 = 关掉
    shortUtteranceMax: Number.isFinite(Number(options?.emphasis?.shortUtteranceMax))
      ? Math.max(0, Math.min(30, Number(options.emphasis.shortUtteranceMax)))
      : 8,
    // 加粗最多算几个汉字（超过就按普通念）
    maxStrongChars: Number.isFinite(Number(options?.emphasis?.maxStrongChars))
      ? Math.max(1, Math.min(8, Number(options.emphasis.maxStrongChars)))
      : 4,
    // 加粗段后面能并进来的尾巴字数（虚词，如「了」「的」），0 = 不并
    absorbTailMax: Number.isFinite(Number(options?.emphasis?.absorbTailMax))
      ? Math.max(0, Math.min(4, Number(options.emphasis.absorbTailMax)))
      : 2,
    breathMs: Number.isFinite(Number(options?.emphasis?.breathMs))
      ? Math.max(0, Math.min(400, Number(options.emphasis.breathMs)))
      : 200,
  };

  // 接缝重叠时长（秒）：0.05 ≈ 听不出，太长会吞字
  const seam = (Number.isFinite(Number(options?.emphasis?.seamMs))
    ? Math.max(10, Math.min(150, Number(options.emphasis.seamMs)))
    : 20) / 1000;

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
  // 拼接前把首尾静音裁到 50ms（留一点，避免硬切）。**句末的重点字可以硬切**（尾部 0ms），
  // 因为「忍不住叫出来」的尾音不能淡出、不能拖尾（格 2026-11-20）。
  const trimEdges = (file, tailKeepMs = 0.05) => {
    const outF = file.replace(/\.mp3$/, '-trim.mp3');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,'
        + `areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=${tailKeepMs},areverse`,
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
    // **情绪前缀**（2026-11-20）：`【急】哇，小心！` / `【柔】唉，没事的。`
    // 急 = 气口短、重点更快更响（像倒吸一口气后冲出来）；柔 = 气口长、整句更慢更轻。
    // 情绪短句本来就要"断"，所以带了前缀就不走"短句不切段"那条。
    const emoMatch = /^【(急|柔)】/.exec(String(ev.text).trim());
    const emo = emoMatch ? {
      急: { baseRate: '+15%', baseVolume: '+10%', volume: '+25%', gapMs: 140 },
      柔: { baseRate: '-8%', baseVolume: '-10%', volume: '-15%', gapMs: 320 },
    }[emoMatch[1]] : null;
    if (emo) {
      for (const [k, v] of Object.entries(emo)) {
        // 用户显式写了的键优先，情绪预设只补没写的
        const userSet = typeof options?.emphasis?.[k] !== 'undefined';
        if (v !== undefined && !userSet) emp[k] = v;
      }
      emp.shortUtteranceMax = 0;     // 情绪句要保留那个气口
    }
    const spoken = String(ev.text).replace(/^【(急|柔)】/, '').replace(/‖/g, '，');
    const chunks = [spoken];
    try {
      // **切段后别把标点甩到段首**：`‖` 变成逗号后常常正好落在段首（`\|再翻滚`），
      // edge 对「以逗号开头」的文本会合成不出音频（synth failed）。把段首标点挪到上一段末尾。
      const segs0 = splitEmphasis(spoken);
      for (let i = 1; i < segs0.length; i += 1) {
        const m = /^([，。、！？；：…]+)/.exec(segs0[i].text);
        if (m) {
          segs0[i - 1].text += m[1];
          segs0[i].text = segs0[i].text.slice(m[1].length);
        }
      }
      for (let i = segs0.length - 1; i > 0; i -= 1) {
        if (!segs0[i].text.trim()) { segs0[i - 1].text += segs0[i].text; segs0.splice(i, 1); }
      }
      // **切点别落在词中间**：接缝本身就是"换气"，落在「眼睛闪｜红光」这种地方很怪。
      // 加粗词前面若只剩一小截（≤ absorbMax 个汉字，默认 4），就把它并进重点段，
      // 让接缝退到上一个标点处——「眼睛闪红光」当成一个整体念。
      for (let i = 1; i < segs0.length; i += 1) {
        if (!segs0[i].strong || !segs0[i - 1].text) continue;
        const frag = (segs0[i - 1].text.match(/[^，。、！？；：…\s]+$/) ?? [''])[0];
        const cjk = [...frag].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
        if (cjk > 0 && cjk <= emp.absorbMax && frag !== segs0[i - 1].text.trim()) {
          segs0[i].text = frag + segs0[i].text;
          segs0[i - 1].text = segs0[i - 1].text.slice(0, -frag.length);
        }
      }
      for (let i = segs0.length - 1; i > 0; i -= 1) {
        if (!segs0[i - 1].text.trim()) segs0.splice(i - 1, 1);
      }
      // **尾巴上的虚词不能单独成段**：`没**无敌**了` 会把「了」甩到下一段，
      // 接缝正好落在「无敌｜了」中间——格 2026-11-20 实听（「它抬手完就没无敌…了」）。
      // 加粗段后面若只剩一两个字的虚词（了/的/吗/吧/呢…），并进重点段。
      for (let i = 0; i < segs0.length - 1; i += 1) {
        if (!segs0[i].strong) continue;
        const head = (segs0[i + 1].text.match(/^[^，。、！？；：…\s]+/) ?? [''])[0];
        const cjk = [...head].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
        if (cjk > 0 && cjk <= emp.absorbTailMax) {
          segs0[i].text += head;
          segs0[i + 1].text = segs0[i + 1].text.slice(head.length);
        }
      }
      for (let i = segs0.length - 1; i > 0; i -= 1) {
        // 纯标点的段（并入虚词后剩下的「。」）并回上一段，否则 edge 合成不出音频
        if (!segs0[i].text.trim() || /^[，。、！？；：…]+$/.test(segs0[i].text)) {
          segs0[i - 1].text += segs0[i].text;
          segs0.splice(i, 1);
        }
      }
      // **重点只标短词**（格 2026-11-20）：口头重音落在 1–3 个字上才有力；标成
      // 「伤害很高」这种长段，整段一起放慢会拖成一句、反而不像重点。超过上限就按普通念。
      const cjkLen = (s) => [...s].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
      for (const s of segs0) {
        if (s.strong && cjkLen(s.text) > emp.maxStrongChars) s.strong = false;
      }
      if (process.env.DSH_VOICE_DEBUG) console.error('[edge-tts] segs:', JSON.stringify(segs0.map((s) => (s.strong ? '*' : '') + s.text)));
      // 很短的整句（含情绪短句）不切段：`哇，小心！` 切成两截就成了两声，语气断了。
      const totalCjk = cjkLen(spoken);
      if ((segs0.length <= 1 || totalCjk <= emp.shortUtteranceMax) && !hadBreath) {
        const r = await runSynth(spoken.replace(/\*\*/g, ''), '+0%', file);
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
            segs0[i].strong ? emp.volume : emp.baseVolume);
          if (!r.ok) throw new Error('synth failed');
          const isFinalStrong = segs0[i].strong && i === segs0.length - 1;
          const trimmed = trimEdges(part, isFinalStrong ? 0 : 0.05);
          if (trimmed !== part) job.parts.push(trimmed);
          clips.push(trimmed);
          // 加粗段后的自动停顿默认关（emp.pauseMs=0）：整句里凭空多一个气口会像逗号
          if (segs0[i].strong && emp.pauseMs > 0 && i < segs0.length - 1) {
            clips.push(silenceFor(emp.pauseMs));
          }
        }
        // **接缝留出固定气口**：每段裁边后各留 50ms，中间再补 gapMs−100ms 的静音，
        // 让「在｜红」之间的空档约等于正常字间隔的 1.1 倍（1.1 倍速下约 200ms）。
        // 太少会被听成抢话（格 2026-11-20 实听），太多像顿号。
        if (clips.length === 1) {
          copyFileSync(clips[0], file);
        } else {
          const pad = Math.max(0, Math.round(emp.gapMs - 100));
          const gapClip = pad > 0 ? silenceFor(pad) : null;
          const seq = [];
          clips.forEach((c, i) => {
            seq.push(c);
            if (gapClip && i < clips.length - 1) seq.push(gapClip);
          });
          const list = join(tmpdir(), `dsh-say-${stamp}.txt`);
          job.parts.push(list);
          writeFileSync(list, seq.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
          const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '48k', file],
          { stdio: 'ignore', windowsHide: true });
          if (r.status !== 0) throw new Error('concat failed');
        }
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
    } catch (err) {
      if (process.env.DSH_VOICE_DEBUG) console.error('[edge-tts] say failed:', err);
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
