/**
 * listen.js — 把"视频里在说什么"接进来。
 *
 * ## 为什么需要它
 *
 * see-now 抓的是**屏幕**：`capture.js` 那条 ffmpeg 管道挂着 `-an`，一个音频字节都没有。
 * 所以模型看到的永远只有画面 —— 它不知道画面里的人在说什么、旁白讲到哪了。
 * `dsh-video-storyboard` 有 ASR，是因为它读的是文件、有音轨；实时看屏幕没有这条捷径。
 *
 * ## 这条链怎么分工
 *
 *    Python（py/listen.py）
 *      WASAPI loopback 抓系统输出 → 16k 单声道 → 按静音断句 → `seg-<epochMs>.wav`
 *    Node（这里）
 *      扫目录取 wav → canonicalizeWav → 宿主 speechToText / 本地 HTTP → `{t0,t1,text}`
 *
 * 采集放 Python、转写放 Node，不是随手分的：
 *   - 抓回环只能走 pyaudiowpatch（PortAudio 官方不暴露 loopback 设备，实测 sounddevice
 *     的 WASAPI host API 里只有麦克风），那是 Python 包；
 *   - 宿主 `speechToText` 是 Node 侧的服务，只能在 Node 里调。
 *
 * ## 时间码为什么用 epoch 毫秒
 *
 * WASAPI loopback **静音时不推送数据**（实测 3 秒静音 callback 触发 0 次），
 * 样本数累加出来的时间是错的。而墙上时间是真实世界在走 —— 所以文件名里带
 * 段首的 epoch 毫秒，Node 侧拿它跟画面帧的 wall clock 对齐，中间静音多久都不漂。
 *
 * ## 部署（三级降级，永远不让"看屏幕"起不来）
 *
 *   1. 宿主 `speechToText`（DSH 桌面版自带 SenseVoice）—— 社区用户零安装
 *   2. `~/.dsh/asr.json` 指的 OpenAI 兼容服务（本地 :8000 那种）
 *   3. 都没有 → 不起 Python、不出字幕，`status` 里说明原因，看画面一切照旧
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LISTEN_DEFAULTS } from './tuning.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LISTEN_SCRIPT = join(HERE, '..', 'py', 'listen.py');

/** 台词缓冲保留多久（毫秒）。看屏幕是长期会话，不修剪会一直涨。 */
const KEEP_MS = 180_000;
/** 连续失败几次就停（每 3 秒一句，坏一次不算坏，一直坏就别耗着了）。 */
const MAX_FAILS = 3;
/**
 * 失败到上限后隔多久重试。
 *
 * 30 秒是照着"本地服务冷启动"定的：模型加载实测要 20~30 秒，
 * 比这更短只是在它还没 ready 的时候反复打空。
 */
const RETRY_MS = 30_000;

/**
 * 把 ffmpeg/PortAudio 风格的 WAV 改写成宿主认的 **canonical** 形式。
 *
 * 宿主的 `validateWave()` 逐字节认死三条：`RIFF size === len - 8`、`data` 块
 * **必须正好在偏移 36**、`data size === len - 44`。而**管道写的 WAV 做不到前两条**
 * （长度回填不了，只能写 0xFFFFFFFF），ffmpeg 还会插一个 `LIST/INFO` 把 data 顶到 70。
 * 三条全灭 → 宿主抛 "Audio must be a canonical 16 kHz mono PCM16 WAV recording"，
 * 上层只看到一句 asr-failed，日志里毫无线索（2026-11-02 macOS 实报）。
 *
 * 这段和 `dsh-video-storyboard/src/storyboard/host-asr.js` 是同一套逻辑 ——
 * 两边都不想去依赖对方（see-now 对 storyboard 没有依赖），所以各自留一份。
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer} 44 字节头 + PCM
 */
export function canonicalizeWav(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（缺 RIFF/WAVE 头）');
  }
  let p = 12;
  let fmt = null;
  let payload = null;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('latin1', p, p + 4);
    const size = bytes.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'data') {
      const end = size === 0xFFFFFFFF ? bytes.length : Math.min(bytes.length, body + size);
      payload = bytes.subarray(body, end - ((end - body) & 1));
      break;
    }
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) fmt = bytes.subarray(body, body + 16);
    if (size === 0xFFFFFFFF || body + size > bytes.length) break;
    p = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV 里没有 fmt 块');
  if (!payload) throw new Error('WAV 里没有 data 块');

  const out = Buffer.alloc(44 + payload.length);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  fmt.copy(out, 20);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(payload.length, 40);
  payload.copy(out, 44);
  return out;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh');
}

// ------------------------------------------------------------------ 转写

/**
 * 宿主 `speechToText` 适配器。取法和 storyboard 一致：`ctx.get(name)`，
 * **不能写 `ctx.speechToText`** —— cordis 对未声明的服务在 get 陷阱里直接抛，`?.` 挡不住。
 *
 * @returns {null | ((wav:Buffer) => Promise<string>)}
 */
/**
 * 疑似幻觉：ASR 对着纯音乐吐出来的短词 / 重复串。
 *
 * 为什么判在文本层而不是音频层：实测同一套设备上，
 * BGM 段转出「嗯。」「啦啦啦。」「hello hello」（1-4 字、重复度极高），
 * 人声段转出 8-20 字的完整句子；而音频特征（300-3400Hz 占比、dB）
 * 会随系统音量和片源质量漂移 —— 同一个判据在 -25dB 的视频上 8/8 正确，
 * 在 -48dB 的视频上把 13 段真人讲解全杀了。字数与重复率不随音量变。
 */
const FILLER = new Set('嗯啊哦呃唉喔噢呀呢呗哈呵嘿喂唔'.split(''));
const EN_FILLER = new Set(['oh', 'o', 'ah', 'eh', 'hello', 'hi', 'yeah', 'haha', 'la', 'laa', 'wow']);

function isHallucination(text) {
  const s = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
  if (!s) return true;
  if (s.length <= 5 && EN_FILLER.has(s.toLowerCase())) return true;
  if (s.length <= 2 && [...s].every((c) => FILLER.has(c))) return true;
  const uniq = new Set(s).size;
  const repeat = 1 - uniq / s.length;
  return s.length <= 10 && repeat > 0.4;
}

export function hostTranscriber(ctx, { language = 'zh', timeoutMs = 30_000 } = {}) {
  let svc = null;
  try { svc = ctx?.get?.('speechToText') ?? null; } catch { svc = null; }
  if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') return null;

  /** 模型不会因为"服务在"就自动加载；先 prepare 再等它 ready（最多 5 秒，等不到就直接试）。 */
  async function providerId() {
    if (typeof svc.snapshot !== 'function') return undefined;
    const id = svc.snapshot()?.selection?.providerId;
    if (!id) return undefined;
    const view = () => svc.snapshot()?.providers?.find((v) => v.id === id);
    const phase = () => view()?.preparation?.phase;
    if (!phase() || phase() === 'ready' || phase() === 'standby') return id;
    if (typeof svc.prepare !== 'function') return id;
    try { svc.prepare(id); } catch { return id; }
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
      const p = phase();
      if (p === 'ready' || p === 'standby' || p === 'failed') return id;
    }
    return id;
  }

  return async function viaHost(wav) {
    const id = await providerId();
    const spec = svc.resolve({
      audio: new Uint8Array(wav), language, ...(id ? { providerId: id } : {}),
    });
    const r = await svc.transcribe(spec, AbortSignal.timeout(timeoutMs));
    return String(r?.text ?? '').trim();
  };
}

/** `~/.dsh/asr.json`（和 storyboard 共用同一份配置）：`{baseUrl, key, model, language}` */
export function asrConfig(env = process.env) {
  const home = dshHome(env);
  const cfg = readJson(join(home, 'asr.json'));
  const baseUrl = env.DSH_ASR_BASE_URL || cfg.baseUrl || '';
  if (!baseUrl) return null;
  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    key: env.DSH_ASR_KEY || cfg.key || '',
    model: env.DSH_ASR_MODEL || cfg.model || 'paraformer-zh-2024-03-09',
    language: env.DSH_ASR_LANGUAGE || cfg.language || 'zh',
    /**
     * `manage` 必须原样带出来 —— 它是"服务没起时怎么拉起"的唯一来源。
     * 早先这里只挑了 4 个字段，于是 `ensureService` 永远报"没写 manage.start"，
     * 服务永远不会被拉起（2026-11-04 排查"看不到字幕"时发现）。
     */
    manage: cfg.manage && typeof cfg.manage === 'object' ? cfg.manage : undefined,
  };
}

/** OpenAI 兼容 HTTP（see-now 自己不发请求给模型，只把音频丢给这个服务）。 */
export function httpTranscriber(cfg, { timeoutMs = 30_000, log = () => {} } = {}) {
  if (!cfg?.baseUrl) return null;
  return async function viaHttp(wav) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    form.append('model', cfg.model);
    form.append('response_format', 'json');
    form.append('language', cfg.language || 'zh');
    // 严格 VAD：服务端 silero VAD 判「这段没人说话」就直接返回空，
    // 不再走「VAD 全静音也整段解码一次」的兜底 —— 否则纯 BGM 会被转成「嗯」「啦啦啦」。
    form.append('vad_only', '1');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {},
        body: form,
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 120)}`);
      const j = await res.json();
      return String(j?.text ?? '').trim();
    } catch (e) {
      log(`转写失败：${e?.message ?? e}`);
      // **必须抛**。以前这里 `return ''`，于是上层看到的只是"这段没说话"：
      // 失败计数永远不涨、永远不停、status 里永远是"在听、0 句" ——
      // 服务根本没起的时候，界面上和"视频是默片"一模一样（2026-11-04 实报）。
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ------------------------------------------------------------------ 本地服务

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端点活着吗。2 秒超时 —— 本地服务要么秒回要么没起，等再久没意义。 */
export async function probeService(baseUrl, { timeoutMs = 2000 } = {}) {
  try {
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

/**
 * 本地转写服务没在跑就拉起来（按 `~/.dsh/asr.json` 的 `manage.start`）。
 *
 * 为什么必须有：那个服务是**空闲就退**的（`idleMs: 5000`），平时根本不在。
 * storyboard 有 `asr-lifecycle.js` 负责按需拉起，see-now 原来没有 ——
 * 表现就是"听得见、但一句台词都转不出来"，而界面上还显示"在听"。
 *
 * **只管拉、不管关**：服务自己有 idleMs，用完自己走。我们只保证"要用的时候它在"。
 */
export async function ensureService(cfg, { log = () => {}, waitMs = 60_000 } = {}) {
  const start = cfg?.manage?.start;
  if (!start) return { ok: false, reason: 'asr.json 里没写 manage.start' };
  if (await probeService(cfg.baseUrl)) return { ok: true, already: true };

  const cmd = Array.isArray(start) ? start.map(String) : [String(start)];
  const [exe, ...args] = cmd;
  log(`转写服务没在跑，拉起：${cmd.join(' ')}`);
  try {
    // 脚本目录当 cwd：很多服务按相对路径找模型
    const cwd = args[0] ? dirname(args[0]) : undefined;
    const child = spawn(exe, args, {
      detached: true, stdio: 'ignore', windowsHide: true, ...(cwd ? { cwd } : {}),
    });
    child.unref();
  } catch (e) {
    return { ok: false, reason: `起不来：${e?.message ?? e}` };
  }

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(1000);
    if (await probeService(cfg.baseUrl)) return { ok: true, waitedMs: waitMs - (until - Date.now()) };
  }
  return { ok: false, reason: `等了 ${Math.round(waitMs / 1000)} 秒还没就绪` };
}

/** 选一个能用的转写器。宿主优先 —— 社区用户那边不用装任何东西。 */
export function resolveTranscriber(ctx, { env = process.env, log = () => {} } = {}) {
  const host = hostTranscriber(ctx);
  if (host) return { kind: 'host', transcribe: host, label: '宿主 SenseVoice' };
  const cfg = asrConfig(env);
  const http = httpTranscriber(cfg, { log });
  if (http) return { kind: 'http', transcribe: http, label: `本地 ${cfg.baseUrl}` };
  return null;
}

// ------------------------------------------------------------------ 静音窗口

/**
 * 静音窗口文件的路径。**默认和陪看共用同一个文件**（`$DSH_HOME/watch/out/quiet-until.json`）。
 *
 * 共用的理由：这个文件回答的是"这台机器上现在有没有人在念话"，跟是哪个插件在念无关。
 * 陪看的 `bin/watch.mjs` 写它（防两个 SAPI 抢话），`mic.py` 读它（防麦克风听见自己），
 * 我们两边都要 —— 写自己那份的话，麦克风那条就漏了。
 */
export function quietFile(env = process.env) {
  return env.DSH_QUIET_FILE || join(dshHome(env), 'watch', 'out', 'quiet-until.json');
}

/**
 * 占住静音窗口：告诉采集"接下来这几秒我在念，别听"。
 *
 * ⚠️ 这不是"屏蔽自己"，是**闭嘴不听** —— 窗口内整段音频直接丢，代价是：
 * 如果用户正好在这几秒说话、或者视频里正好有人在说台词，那一段也没了。
 *
 * 为什么不真做回声消除（AEC）：回环抓的是**系统混音后的成品**，AI 的声音和视频的声音
 * 在同一个信号里线性叠加，要减干净得知道它播出的每一个样本、确切时刻、以及系统音量与
 * 重采样链 —— 差一点就是减不干净的残差，而 ASR 对残差比对人声更敏感（会吐出更怪的句子）。
 * `aec.py` 那套是给麦克风用的（电信号 vs 空气传播，两条不同路径），套到回环上不成立。
 *
 * 真正的"只抓视频、不抓自己"要**按进程分轨**（Windows 的 process loopback），
 * 只能抓浏览器/播放器的音频树，AI 从别的进程出来的声音根本进不来。那是另一件事，
 * 要写 COM（`ActivateAudioInterfaceAsync`），pyaudiowpatch 没有这个能力。
 *
 * @returns {number|null} 静音到什么时候（epoch ms）
 */
export function markSpeaking(text, { env = process.env, extraMs = 1200 } = {}) {
  const chars = String(text ?? '').trim().length;
  if (!chars) return null;
  // 中文约 4~5 字/秒，取 4 再乘 1.5 倍余量，加收尾 —— **宁可多静音，也别把自己的话变成台词**
  const ms = Math.ceil((chars / 4) * 1000 * 1.5) + extraMs;
  const until = Date.now() + ms;
  try {
    const p = quietFile(env);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ until, at: Date.now(), by: 'see-now' }), 'utf8');
  } catch { /* 写不了最多是"可能听见自己"，别让它影响念 */ }
  return until;
}

// ------------------------------------------------------------------ Python

const PY_PROBE = 'import pyaudiowpatch, numpy';

/** 这个解释器有没有抓回环要的两个包（真跑一次 import，名字像没用）。 */
export function canListen(python) {
  const r = spawnSync(python, ['-c', PY_PROBE], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
  return r?.status === 0;
}

/**
 * 找解释器。顺序：
 *   1. `DSH_SEE_PYTHON`（调试/临时）
 *   2. `~/.dsh/see-window.json` 的 `listenPython` / `python`
 *   3. PATH 上的 python3/python/pythonw（win32 顺序不同）
 *
 * 注意 **window.py 用的那个解释器未必有 pyaudiowpatch**（商店版 Python 往往没有），
 * 所以这里不看 tkinter，只看能不能 import。
 */
export function findListenPython({ env = process.env } = {}) {
  const cfg = readJson(join(dshHome(env), 'see-window.json'));
  const list = [
    env.DSH_SEE_PYTHON,
    cfg.listenPython,
    cfg.python,
    env.DSH_FLOAT_PYTHON,
    ...(process.platform === 'win32' ? ['python.exe', 'pythonw.exe'] : ['python3', 'python']),
  ].filter(Boolean);
  for (const py of [...new Set(list)]) {
    if (canListen(py)) return py;
  }
  return null;
}

// ------------------------------------------------------------------ 台词缓冲

/**
 * 台词缓冲。抽出来是为了可测 —— 时间窗过滤这种东西，靠"起个 Python 真录一段"
 * 是测不出边界（跨窗、超长、乱序）的。
 *
 * `t0/t1` 都是 epoch 毫秒。
 */
export function createLineBuffer({ keepMs = KEEP_MS } = {}) {
  let lines = [];
  const put = (t0, t1, t, partial) => {
    const entry = { t0, t1, text: t, partial };
    lines.push(entry);
    // 修剪：只留最近 keepMs。看屏幕是长期会话，两三小时不修剪就是几千条
    if (lines.length > 8) {
      const cut = Date.now() - keepMs;
      lines = lines.filter((l) => l.t1 >= cut);
    }
    return entry;
  };
  return {
    add(t0, t1, text) {
      const t = String(text ?? '').trim();
      if (!t) return null;
      return put(t0, t1, t);
    },
    /**
     * 写入/覆盖同一句的台词。
     *
     * 为什么需要覆盖：长句「边说边出」会先给一版 `partial` 快照，整句落盘后再给准确版。
     * 判据是 **t0 相同就是同一句**（t0 是句首的墙上时间，由 Python 侧那一段唯一决定）。
     *
     * 两条铁律：
     *  - **整句永远盖过快照**（`prev.partial === false && partial` 时不许覆盖）；
     *  - **快照不许把整句改回 partial**（同一句的迟到快照直接丢掉）。
     *
     * @param {{partial?:boolean}} [o]
     */
    upsert(t0, t1, text, { partial = false } = {}) {
      const t = String(text ?? '').trim();
      if (!t) return null;
      // 从后往前找：同一句的快照和整句都在尾部，比从头扫快
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t0 !== t0) continue;
        if (l.partial === false && partial) return l;
        l.t1 = t1;
        l.text = t;
        l.partial = partial;
        return l;
      }
      return put(t0, t1, t, partial);
    },
    /**
     * 取某段时间窗里的台词。**窗口按相交算**（`l.t1 >= from && l.t0 <= to`），
     * 跨窗的那句两边都算 —— 宁可让模型看到同一句两次（它只会觉得啰嗦），
     * 也不要漏掉（漏了它就完全不知道这段说了什么）。
     *
     * 超长时**从新往旧丢**：最近的话更相关。
     */
    between(fromMs, toMs, { maxChars = 1200 } = {}) {
      if (!lines.length) return [];
      const out = [];
      let chars = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t1 < fromMs || l.t0 > toMs) continue;
        if (chars + l.text.length > maxChars && out.length) break;
        out.push(l);
        chars += l.text.length;
      }
      return out.reverse();
    },
    /** 这句有没有**完整版**了（整句比快照准，有它就不必再转快照）。 */
    hasFinal(t0) {
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t0 === t0) return l.partial === false;
      }
      return false;
    },
    get size() { return lines.length; },
    get all() { return lines.slice(); },
  };
}

// ------------------------------------------------------------------ 声学指纹

/**
 * 读 `acoustic.json`（listen.py 的 `AcousticMeter` 写的）。
 *
 * 读失败一律返回 null —— 这层是"锦上添花"，不能因为它坏了让听声音整体失败。
 * 返回里带 `mtimeMs`：上层要判"还在不在更新"，不能拿最后一次成功的数据当现状。
 */
export function readAcoustic(dir) {
  try {
    const p = join(dir, 'acoustic.json');
    const st = statSync(p);
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(raw?.frames)) return null;
    return { ...raw, mtimeMs: st.mtimeMs };
  } catch { return null; }
}

/**
 * 声学指纹 → status 里那半句。**只陈述，不判断**。
 *
 * 三种状态必须分开，否则又会出现"看起来正常、其实没数据"：
 *   - 没有文件 → 空字符串（这层还没数据，不是没在听）
 *   - 停更 → 直接说停更（采集进程死了 / 设备被拔了）
 *   - 有数据 → 格数 + 节拍；**可信度不够就不报 BPM**，别把噪声的"伪节拍"当节奏说出去
 */
export function describeAcoustic(a) {
  if (!a) return '';
  if (Number(a.staleMs) > 12_000) return `；声学指纹停更 ${Math.round(Number(a.staleMs) / 1000)}s`;
  const conf = Number(a.conf);
  const beat = Number.isFinite(Number(a.bpm)) && Number.isFinite(conf) && conf >= 0.5
    ? `，节拍 ~${Math.round(Number(a.bpm))} BPM（可信 ${conf.toFixed(2)}）`
    : '，没测到稳定节拍';
  const gap = Number(a.gaps) ? `，缺 ${Number(a.gaps)} 格` : '';
  return `；声学指纹 ${Number(a.frames)} 格${beat}${gap}`;
}

/**
 * 声学轨迹：把最近一段时间压成「几段状态 + 往哪走」。
 *
 * 这是给「预测接下来会发生什么」用的**原料** —— 插件不做预测，它只摆出
 * 「刚才是什么、变了多久、现在在升还是在降」，预测和取舍交给模型。
 *
 * 状态只有三类，都能单帧判定、不依赖任何标定：
 *   - `silent`：静音（db ≤ −100）
 *   - `speech`：中频占比 ≥0.6（人声带突出）
 *   - `sound` ：有声音但不以中频为主（音乐 / 音效 / 环境声）
 *   - `nodata`：这一格没数据（loopback 没推）
 *
 * @returns {null | {segments:{kind:string,sec:number}[], trend:'up'|'down'|'flat',
 *                   tempo:{bpm:number,conf:number}|null, spanSec:number}}
 */
export function audioTrajectory(a, fromMs, toMs, { minSegSec = 0.8 } = {}) {
  const frames = a?.frames;
  const base = Number(a?.from);
  const hop = Number(a?.hop) || 0;
  if (!Array.isArray(frames) || !frames.length || !Number.isFinite(base) || !(hop > 0)) return null;
  const stepMs = hop * 1000;
  const i0 = Math.max(0, Math.ceil((fromMs - base) / stepMs));
  const i1 = Math.min(frames.length - 1, Math.floor((toMs - base) / stepMs));
  if (i1 - i0 < 10) return null;

  const kindOf = (r) => {
    if (!r) return 'nodata';
    const db = r[0];
    if (db <= -100) return 'silent';
    const lo = r[4];
    const midRaw = r[5];
    const hi = r[6];
    const sum = lo + midRaw + hi;
    const mid = sum > 0.05 ? midRaw / sum : midRaw;
    return mid >= 0.6 ? 'speech' : 'sound';
  };

  const raw = [];
  for (let i = i0; i <= i1; i += 1) {
    const k = kindOf(frames[i]);
    const last = raw[raw.length - 1];
    if (last && last.kind === k) last.sec += hop;
    else raw.push({ kind: k, sec: hop });
  }
  // 太碎的段并到前一段：0.3 秒的毛刺不该出现在"最近 60 秒"的叙述里
  const segments = [];
  for (const s of raw) {
    if (s.sec < minSegSec && segments.length) segments[segments.length - 1].sec += s.sec;
    else segments.push({ ...s });
  }
  // 吸收碎段之后，同类的段可能挨在一起（sound + 碎 nodata + sound）—— 再合一次，
  // 否则文案会出现「有声 8s → 有声 3s → 有声 6s」这种读起来像出错的句子（2026-11-08 实测）。
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && last.kind === s.kind) last.sec += s.sec;
    else merged.push({ ...s });
  }

  // 趋势：最后 10 秒前半段和后半段的 dB 中位数差 ≥3dB 才算"在升/在降"
  const tailN = Math.max(4, Math.round(10 / hop));
  const tail = frames.slice(Math.max(i0, i1 - tailN + 1), i1 + 1).filter(Boolean);
  const medDb = (arr) => {
    const v = arr.map((r) => r[0]).sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : -120;
  };
  let trend = 'flat';
  if (tail.length >= 8) {
    const half = Math.floor(tail.length / 2);
    const d = medDb(tail.slice(half)) - medDb(tail.slice(0, half));
    if (d >= 3) trend = 'up';
    else if (d <= -3) trend = 'down';
  }

  const tempo = Number.isFinite(Number(a.tempo?.bpm)) && Number(a.tempo?.conf) >= 0.5
    ? { bpm: Number(a.tempo.bpm), conf: Number(a.tempo.conf) } : null;
  return { segments: merged, trend, tempo, spanSec: (i1 - i0 + 1) * hop };
}

/**
 * 仅监听里两次唤醒之间的最小间隔。**没人理就越叫越稀**（20s → 300s）。
 *
 * 为什么不是定时：人的"黑听"是跟着声音走的 —— 有人开口就抬头，一直没动静就越来越懒得理。
 * `unanswered` = 上次叫醒之后既没人回话、模型也没做任何动作的连续次数。
 */
export function listenGap(unanswered = 0, { baseMs = 20_000, capMs = 300_000 } = {}) {
  return Math.min(capMs, Math.round(baseMs * 1.6 ** Math.max(0, unanswered)));
}

/**
 * 轨迹 → 一句话（给唤醒消息用）。只说形状，不下结论。
 *
 * 例：`静音 35s → 有声 12s → 人声突出 9s（持续中），音量在升`
 */
export function trajectoryText(traj) {
  if (!traj?.segments?.length) return '';
  const names = { silent: '静音', sound: '有声', speech: '人声突出', nodata: '没听到' };
  const segs = traj.segments.slice(-4);
  const body = segs.map((s, i) => {
    const name = names[s.kind] ?? s.kind;
    const tail = i === segs.length - 1 ? '（持续中）' : '';
    return `${name} ${Math.round(s.sec)}s${tail}`;
  }).join(' → ');
  const trend = traj.trend === 'up' ? '，音量在升'
    : traj.trend === 'down' ? '，音量在降' : '';
  return `${body}${trend}`;
}

/**
 * 声学事件 → status 尾巴。**一次都没有就什么都不加** —— 0 次不该占一行。
 *
 * 结尾必须写「只记录，未接唤醒」：不然看到"起节拍 3 次"会以为它已经会主动看你了。
 */
export function describeEvents(e) {
  const c = e?.counts;
  if (!c) return '';
  const total = (c.resume || 0) + (c.music || 0) + (c.voice || 0);
  if (!total) return '';
  const parts = [];
  if (c.resume) parts.push(`有声 ${c.resume}`);
  if (c.music) parts.push(`起节拍 ${c.music}`);
  if (c.voice) parts.push(`像说话没字 ${c.voice}`);
  const last = e.recent?.[e.recent.length - 1];
  const ago = last?.at ? `，最后一次 ${Math.round((Date.now() - last.at) / 1000)}s 前` : '';
  return `；声学事件 ${parts.join(' / ')}${ago}（仅监听时会据此叫醒模型）`;
}

/**
 * 把一段时间窗里的声学指纹聚成"一句话能用的几个数"。
 *
 * **口径（2026-11-07 定）：不往外报绝对响度。** dBFS 换片子、换系统音量之后没有参考意义，
 * 所以这里只留三样：`lo/mid/hi`（各频带占**本帧**能量的比例，与增益无关）、
 * `range`（dB 差，只用来判"平稳/起伏"）、有/没有一个稳定节拍。
 *
 * @param {{frames:Array, from:number, hop:number, tempo?:object}} a `acoustic.json` 原文
 * @returns {null | {frames:number, gaps:number, silence:boolean, lo:number, mid:number,
 *                   hi:number, range:number, bpm:number|null, conf:number|null,
 *                   span:number, window:number}}
 */
export function summarizeAcoustic(a, fromMs, toMs, { now = Date.now() } = {}) {
  const frames = a?.frames;
  const base = Number(a?.from);
  const hop = Number(a?.hop) || 0;
  if (!Array.isArray(frames) || !frames.length || !Number.isFinite(base) || !(hop > 0)) return null;
  if (!(toMs > fromMs)) return null;
  const stepMs = hop * 1000;
  const i0 = Math.max(0, Math.ceil((fromMs - base) / stepMs));
  const i1 = Math.min(frames.length - 1, Math.floor((toMs - base) / stepMs));
  if (i1 < i0) return null;
  const slice = frames.slice(i0, i1 + 1);
  const rows = slice.filter(Boolean);
  // 半秒都不到就别描述这段声音了 —— 几格的特征波动太大，说什么都是猜
  if (rows.length < 10) return null;
  const med = (k) => {
    const v = rows.map((r) => r[k]).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };
  const dbs = rows.map((r) => r[0]).sort((x, y) => x - y);
  const at = (q) => dbs[Math.min(dbs.length - 1, Math.round(q * (dbs.length - 1)))];
  const tempo = a.tempo ?? {};
  // 节拍是"最近 12 秒"的结论，不能拿去描述很久以前的窗口
  const fresh = Number.isFinite(Number(tempo.at)) && now - Number(tempo.at) < 15_000;
  /**
   * **重新归一化到三个可听频带**。
   *
   * 原始比值是"占 0–8k 全谱"的比例，里面有 40Hz 以下（哄隆隆、人耳听不到）和 6.8k 以上
   * （块平均降采样后是混叠）—— 拿它说"以低频为主"会永远差一截：实测那段 BGM 的
   * 原始 lo 是 0.28，归一化到可听频带是 0.93。占比只在三者之间比才有意义。
   */
  const lo = med(4);
  const mid = med(5);
  const hi = med(6);
  const sum = lo + mid + hi;
  const renorm = sum > 0.05 ? { lo: lo / sum, mid: mid / sum, hi: hi / sum } : { lo, mid, hi };
  return {
    frames: rows.length,
    gaps: slice.length - rows.length,
    // 用中位数判静音：一段里只有几声、其余全是静音时，90 分位会骗人
    silence: med(0) <= -100,
    lo: renorm.lo,
    mid: renorm.mid,
    hi: renorm.hi,
    range: Math.max(0, at(0.9) - at(0.1)),
    bpm: fresh && Number.isFinite(Number(tempo.bpm)) ? Number(tempo.bpm) : null,
    conf: fresh && Number.isFinite(Number(tempo.conf)) ? Number(tempo.conf) : null,
    span: rows.length * hop,
    window: (toMs - fromMs) / 1000,
  };
}

/**
 * 声学摘要 → sheet 底部那一段。**这是模型唯一能看见的声音描述。**
 *
 * 三条规矩：
 *  · 只描述"声音本身"，不冒充台词 —— 表头写清楚这是本地声学特征；
 *  · 不报绝对响度，只报占比与相对起伏；
 *  · 没数据就整块不出现 —— 空的「声音：」会让模型以为采集坏了，然后去猜。
 */
export function soundText(s) {
  if (!s) return '';
  const parts = [];
  if (s.silence) {
    parts.push('这段几乎没有声音（只收到静音）');
  } else {
    parts.push(s.bpm != null && s.conf != null && s.conf >= 0.5
      ? `连续节拍 ~${Math.round(s.bpm)} BPM（可信 ${s.conf.toFixed(2)}）`
      : '没有稳定节拍');
    const top = Math.max(s.lo, s.mid, s.hi);
    if (top >= 0.6) {
      const name = top === s.mid ? '以中频为主' : top === s.lo ? '以低频为主' : '以高频为主';
      parts.push(`${name}（${Math.round(top * 100)}%）`);
    } else if (top >= 0.4) {
      parts.push(`频带较平均（低 ${Math.round(s.lo * 100)}% / 中 ${Math.round(s.mid * 100)}%）`);
    }
    if (s.range >= 12) parts.push('响度起伏大');
    else if (s.range < 4 && s.frames >= 40) parts.push('响度平稳');
  }
  if (s.gaps > 0) parts.push(`有 ${s.gaps} 格没收到数据`);
  if (s.window && s.span < s.window - 3) {
    parts.push(`只覆盖最近 ${Math.round(s.span)}s`);
  }
  return `\n声音（本地声学特征，不是台词；只描述声音本身）：\n  ${parts.join('；')}`;
}

/**
 * 声学事件：从连续的声学指纹里挑出「值得看一眼」的跃变。
 *
 * **这一层只记录、不唤醒**（方案 C 的第一阶段）。阈值还没拿真实样本标过 ——
 * 先跑几天看误报率，够了再接到唤醒门控上。现在它只做三件事：
 *
 *   - `resume`：静音 ≥20 秒之后突然有声（恢复播放 / 会议开始）
 *   - `music`：节拍可信度从低跳到 ≥0.6 并持续 3 秒（开始放音乐）
 *   - `voice`：中频像说话、持续 ≥8 秒，但**一个字都没转出来**（外语、多人、ASR 挂了）
 *
 * 游戏里声音是常态，所以三条都只认**跃变**；同一类事件还有冷却，不然就变成刷屏。
 */
export function createAudioEvents({ log = () => {}, cooldownMs = 150_000, now = Date.now } = {}) {
  const counts = { resume: 0, music: 0, voice: 0 };
  const lastAt = { resume: 0, music: 0, voice: 0 };
  const recent = [];
  let lastAtMs = 0;
  let silentSec = 0;      // 连续静音了多久
  let midSec = 0;         // 连续「像说话」了多久
  let midLinesAtStart = null;
  let tempoHighSec = 0;
  let tempoWasHigh = false;

  function emit(kind, detail, at) {
    if (lastAt[kind] && at - lastAt[kind] < cooldownMs) return false;
    lastAt[kind] = at;
    counts[kind] += 1;
    recent.push({ kind, at, ...detail });
    if (recent.length > 20) recent.shift();
    const extra = detail?.bpm ? `（~${Math.round(detail.bpm)} BPM）` : '';
    log(`[listen] 声学事件 ${kind}${extra}`);
    return true;
  }

  /**
   * 喂一次（每 2 秒一次）。只看「上次到现在」新增的格子，不重复扫整段。
   *
   * @param {{frames:Array, from:number, hop:number, tempo?:object}} a `acoustic.json` 原文
   * @param {{lines?:number, at?:number}} o `lines` = 已转出的台词总数（判「有说话没转出字」）
   */
  function push(a, { lines = 0, at = now() } = {}) {
    const frames = a?.frames;
    if (!Array.isArray(frames) || !frames.length) return null;
    const base = Number(a.from) || 0;
    const hop = Number(a.hop) || 0.05;
    const stepMs = hop * 1000;
    const fromMs = lastAtMs || Math.max(base, at - 2000);
    lastAtMs = at;
    const i0 = Math.max(0, Math.ceil((fromMs - base) / stepMs));
    const i1 = Math.min(frames.length - 1, Math.floor((at - base) / stepMs));
    const elapsed = Math.max(0.2, Math.min(5, (at - fromMs) / 1000));
    if (i1 < i0) return null;
    const rows = frames.slice(i0, i1 + 1).filter(Boolean);
    const med = (k) => {
      const v = rows.map((r) => r[k]).sort((x, y) => x - y);
      return v[Math.floor(v.length / 2)];
    };

    // 没有格子 = 这一拍没听见（loopback 不推数据），按静音累计
    if (!rows.length) {
      silentSec += elapsed;
      midSec = 0;
      return null;
    }

    const silent = med(0) <= -100;
    const lo = med(4);
    const midRaw = med(5);
    const hi = med(6);
    const sum = lo + midRaw + hi;
    const mid = sum > 0.05 ? midRaw / sum : midRaw;   // 归一化到可听频带，和 B 层同一口径

    // ① 静音 → 有声
    let fired = null;
    if (silent) {
      silentSec += elapsed;
    } else {
      if (silentSec >= 20 && emit('resume', {}, at)) fired = 'resume';
      silentSec = 0;
    }

    // ② 节拍从低跳到高（持续 3 秒才算，避免一声鼓点就报）
    const tempo = a.tempo ?? {};
    const fresh = Number.isFinite(Number(tempo.at)) && at - Number(tempo.at) < 15_000;
    const conf = fresh && Number.isFinite(Number(tempo.conf)) ? Number(tempo.conf) : 0;
    if (conf >= 0.6) {
      tempoHighSec += elapsed;
      if (!tempoWasHigh && tempoHighSec >= 3) {
        tempoWasHigh = true;                       // 只报上升沿，之后一直高也不再报
        if (emit('music', { bpm: Number(tempo.bpm) || null }, at)) fired = fired ?? 'music';
      }
    } else {
      tempoHighSec = 0;
      tempoWasHigh = false;
    }

    // ③ 像说话，但一个字都没转出来
    if (!silent && mid >= 0.6) {
      if (midSec === 0) midLinesAtStart = lines;
      midSec += elapsed;
      if (midSec >= 8 && lines === midLinesAtStart) {
        if (emit('voice', {}, at)) fired = fired ?? 'voice';
        midSec = 0;
        midLinesAtStart = lines;
      }
    } else {
      midSec = 0;
      midLinesAtStart = null;
    }
    return fired;
  }

  /**
   * 这一拍**没有新数据**（没文件 / 文件停更）—— 按静音累计。
   *
   * 为什么需要：播放器暂停时 loopback 一个字节都不推，`acoustic.json` 根本不更新；
   * 只靠"格子里的静音"永远等不到 `resume`。对模型来说「没数据」和「安静」是同一件事，
   * 这里就按安静算（但状态行里两者仍然分得开：一个看 `gaps`，一个看 `staleMs`）。
   */
  function tick(elapsedSec = 2, at = now()) {
    lastAtMs = at;
    silentSec += Math.max(0.2, Math.min(5, elapsedSec));
    midSec = 0;
    midLinesAtStart = null;
  }

  function state() {
    return {
      counts: { ...counts },
      recent: recent.slice(-5).map((e) => ({ kind: e.kind, at: e.at, bpm: e.bpm ?? null })),
      silentSec: Math.round(silentSec),
      midSec: Math.round(midSec),
    };
  }

  return { push, tick, state };
}

// ------------------------------------------------------------------ 主体

/**
 * @param {object} o
 * @param {object|null} o.ctx        宿主 ctx（取 speechToText）
 * @param {string} [o.dir]           wav 落盘目录（默认 `~/.dsh/see-now/audio`）
 * @param {string} [o.python]        解释器（默认自动找）
 * @param {string} [o.script]        listen.py（默认包内那份）
 * @param {NodeJS.ProcessEnv} [o.env]
 */
export function createListener({
  ctx = null, dir = null, python = null, script = LISTEN_SCRIPT,
  /**
   * 延迟参数（`~/.dsh/see-now.json` 的 `listen` 段，见 tuning.js）。
   *
   * 分两半：`silence` / `maxSeg` / `live` 那组交给 Python 侧（它们决定"什么时候切一段"），
   * `pollMs` 留在这里（决定"多久扫一次目录"）。
   */
  listen = LISTEN_DEFAULTS,
  env = process.env, log = () => {}, pollMs = null,
  /**
   * 测试注入口：给一个转写器就完全不碰 `resolveTranscriber` / Python / 设备。
   * 线上永远不传 —— `drain()` 是这条链里最容易出错的地方（覆盖、去重、失败不退），
   * 不能只靠"起个真设备听一遍"来验。
   */
  transcriber: injected = null,
} = {}) {
  const audioDir = dir || join(dshHome(env), 'see-now', 'audio');
  const cfg = { ...LISTEN_DEFAULTS, ...(listen ?? {}) };
  // `pollMs` 显式传值时优先（老测试还在用），否则读配置
  const pollInterval = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0
    ? Number(pollMs) : cfg.pollMs;
  const buffer = createLineBuffer();
  let child = null;
  let timer = null;
  let busy = false;
  let fails = 0;
  let enabled = Boolean(injected);
  let reason = '没启动';
  let transcriber = injected;
  let lastSegAt = 0;
  let total = 0;
  /** 最近一句的延迟：从**句首**到**进了台词缓冲**（毫秒）。status 里直接看得见。 */
  let lastLineLagMs = null;
  /** 临时快照（`partial`）转成功过几次 —— 用来判断"边说边出"到底有没有在干活 */
  let partials = 0;
  /** live 文件去重：`name -> "size:mtime"`。同名覆盖是常态，内容变了才重转。 */
  const liveSeen = new Map();
  /** 音量条数据：`{step, from, db[]}`，Python 那边每秒原子重写一次 levels.json */
  let levels = null;
  let levelsAt = 0;
  /** 声学指纹：`{hop, from, frames[], tempo, gaps}`，Python 每 3 秒重写一份 90 秒环形缓冲 */
  let acoustic = null;
  let acousticAt = 0;
  /** 声学事件（C 层第一阶段：只记录，不唤醒） */
  const events = createAudioEvents({ log });
  /** 转写连续失败时的暂停截止时间（epoch ms）。见 drain 里的注释。 */
  let pausedUntil = 0;
  /** 最近一次转写错误（status 里要看得见，不能只进日志） */
  let lastError = null;
  /** 上次主动拉起本地服务的时刻（60 秒内不重复拉，免得起两个抢端口） */
  let lastEnsureAt = 0;
  /** 快照失败只记一次日志（成功一次就复位），别每拍刷屏 */
  let liveErrLogged = false;

  /**
   * 读声学指纹。2 秒一次就够 —— Python 侧 3 秒才重写一次，读更勤只是白扫盘。
   *
   * **和转写是两条独立的线**：纯音乐、或者转写服务根本没起，这里照样有数。
   * 它回答的是「这段是什么声音」，不是「谁在说话」。
   */
  function pollAcoustic() {
    if (Date.now() - acousticAt < 2000) return;
    acousticAt = Date.now();
    const a = readAcoustic(audioDir);
    // 没有文件 / 停更超过 6 秒 = 这一拍听不见（播放器暂停时 loopback 就是不推数据）
    if (!a || Date.now() - Number(a.mtimeMs) > 6000) {
      events.tick(2, Date.now());
      return;
    }
    acoustic = a;
    // C 层第一阶段：只记录候选事件，**不唤醒**（阈值还没标定）
    events.push(a, { lines: total, at: Date.now() });
  }

  function state() {
    // status 里要看得见 A 层活没活着 —— 用户问"它听见什么"时，先看这一行。
    // 自节流到 2 秒一次，反复调 status 也只是一次 stat + read。
    pollAcoustic();
    return {
      enabled,
      reason,
      backend: transcriber?.label ?? null,
      python: python ?? null,
      dir: audioDir,
      lines: buffer.size,
      total,
      lastSegAt: lastSegAt || null,
      /** 最近一句从**开口**到**台词可读**用了多久（毫秒）。调延迟就看这个数。 */
      lastLineLagMs,
      /** 正在说话时先给的那版临时台词转成功过几次（"边说边出"有没有在干活） */
      partials,
      /** 转写出过错就带上原因 —— "在听但没台词"必须能分清是没人说话还是转写挂了 */
      error: lastError,
      paused: pausedUntil > Date.now(),
      /** 生效的延迟参数：用户改 see-now.json 之后一眼能核对 */
      tuning: { ...cfg },
      /**
       * 声学指纹（A 层）。**没有文件就没有这一项**，不要编一个"0 格"出来 ——
       * 那和"采集没起来"长得一样，用户会去查错地方。
       */
      acoustic: acoustic ? {
        hop: Number(acoustic.hop) || 0,
        from: Number(acoustic.from) || null,
        frames: acoustic.frames.length,
        gaps: Number(acoustic.gaps?.count) || 0,
        bpm: acoustic.tempo?.bpm ?? null,
        conf: acoustic.tempo?.conf ?? null,
        /** 文件多久没更新了（Python 3 秒写一次；>12 秒就是停了） */
        staleMs: Math.max(0, Date.now() - (Number(acoustic.mtimeMs) || 0)),
      } : null,
      /**
       * 声学事件（C 层第一阶段）。**只记数，还没接进唤醒门控** ——
       * 现在看的是误报率，不是效果。跑几天再决定阈值。
       */
      audioEvents: events.state(),
    };
  }

  /**
   * 读音量序列（每秒最多读一次 —— Python 那边就是这么写的，读更勤只是白扫盘）。
   *
   * 这东西**和转写是两条独立的线**：转写要等一整句说完，音量条是即时的。
   * 所以哪怕转写服务挂了、或者全是纯音乐没人说话，音量条照样有。
   */
  function pollLevels() {
    if (Date.now() - levelsAt < 900) return;
    levelsAt = Date.now();
    try {
      const raw = JSON.parse(readFileSync(join(audioDir, 'levels.json'), 'utf8'));
      if (Array.isArray(raw?.db) && raw.db.length) levels = raw;
    } catch { /* 还没写出来 / 正在 rename，下一次再说 */ }
  }

  /**
   * 取某段时间窗的音量序列，**对齐到 `wallFrom`**（第一格就是这一秒的声音）。
   *
   * 返回的 `db` 长度按 `span/step` 算死 —— 画条时按列聚合，长度不对就整体错位
   * （图上的柱子比声音晚半秒，看着像卡带）。
   *
   * @returns {null | {step:number, db:number[]}}
   */
  function levelsBetween(wallFrom, wallTo, { maxPoints = 900 } = {}) {
    pollLevels();     // 自己读一次：转写那条线挂了（或者全是纯音乐）也照样有音量条
    if (!levels || !(wallTo > wallFrom)) return null;
    const stepMs = (Number(levels.step) || 0.1) * 1000;
    const span = wallTo - wallFrom;
    const n = Math.round(span / stepMs);
    if (n < 2) return null;
    const count = Math.min(n, maxPoints);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const t = wallFrom + (i * span) / count;
      const k = Math.round((t - levels.from) / stepMs);
      const v = k >= 0 && k < levels.db.length ? levels.db[k] : -120;
      out.push(Number.isFinite(v) ? v : -120);
    }
    return { step: span / count / 1000, db: out };
  }

  /**
   * 取某段时间窗的声学摘要（给 sheet 的「声音」那一段用）。
   *
   * 窗口按**相交**算，和台词一致：宁可让模型看到同一段声音两次，也不要漏。
   * 没有文件 / 窗口里没有数据就返回 null —— 上层据此整块不出现。
   */
  function acousticBetween(fromMs, toMs) {
    pollAcoustic();
    if (!acoustic) return null;
    return summarizeAcoustic(acoustic, fromMs, toMs);
  }

  /** 最近一段的声学轨迹（仅监听里判断"值不值得看"的原料）。 */
  function trajectoryBetween(fromMs, toMs) {
    pollAcoustic();
    if (!acoustic) return null;
    return audioTrajectory(acoustic, fromMs, toMs);
  }

  /**
   * 扫目录，处理没见过的 wav。**一次一条，串行** —— 本地 paraformer 是单线程的
   * （实测 3 个并发总共 530ms ≈ 串行 522ms），并发打进去只会互相排队。
   *
   * 两类文件：
   *  - `seg-<t0>.wav` —— 一句完整的（静音断句 / maxSeg 强切），**准的**；
   *  - `live-<t0>.wav` —— 长句说到一半的快照，**同名覆盖**，只是让字幕早几秒出现。
   *
   * 顺序是 **先 seg 后 live**：seg 落盘意味着这句已经说完，对应的 live 文件马上会被
   * Python 删掉；先转 seg 能避免"白转一次马上被覆盖的快照"。
   */
  async function drain() {
    if (busy || !transcriber) return;
    /**
     * **连续失败不 stop，只暂停**。
     *
     * 以前是"3 次就收工"，可最常见的那种失败（本地服务没起 / 正在冷启动 30 秒）
     * 完全会自己好起来 —— 那时候把整条链停掉，等于永久放弃。而且停掉会连带
     * kill 采集进程，音量条也没了。
     *
     * 暂停期间**不删文件**（留着等重试），到点先重新探活/拉起服务。
     */
    if (pausedUntil) {
      if (Date.now() < pausedUntil) return;
      pausedUntil = 0;
      fails = 0;
      ensureService(asrConfig(env), { log }).catch(() => {});
    }
    busy = true;
    try {
      pollLevels();       // 音量条和转写共用这一拍，但它自己节流到 1 秒一次
      let names = [];
      try { names = readdirSync(audioDir); } catch { names = []; }
      let segs = names
        .filter((n) => /^seg-\d+\.wav$/.test(n))
        .sort((a, b) => Number(a.slice(4, -4)) - Number(b.slice(4, -4)));
      // 转写长期不通时目录会堆 —— 只留最新的 40 段，老的直接扔
      if (segs.length > 40) {
        for (const old of segs.slice(0, segs.length - 40)) {
          try { unlinkSync(join(audioDir, old)); } catch { /* 删不掉算了 */ }
        }
        segs = segs.slice(-40);
      }
      const lives = names.filter((n) => /^live-\d+\.wav$/.test(n));
      if (env.DSH_SEE_NOW_DEBUG) {
        log(`[listen] drain: 目录里 ${names.length} 个文件，整句 ${segs.length} / 快照 ${lives.length}`);
      }

      for (const name of segs) {
        const path = join(audioDir, name);
        let wav = null;
        try {
          // Python 侧是「写 .tmp 再 rename」，所以这里看到的都是完整的；
          // 但如果是老版本/被手动塞进来的，size 为 0 就跳过，别拿去转写。
          if (statSync(path).size < 1024) continue;
          wav = readFileSync(path);
        } catch { continue; }
        const t0 = Number(name.slice(4, -4));
        let text = '';
        try {
          text = await transcriber.transcribe(canonicalizeWav(wav));
          fails = 0;
          lastError = null;
        } catch (e) {
          fails += 1;
          lastError = String(e?.message ?? e);
          log(`转写出错（${fails}/${MAX_FAILS}）：${lastError}`);
          /**
           * **第一次失败就顺手把本地服务拉起来**（不 await，不挡这条链）。
           *
           * `asr.json` 的 `manage.idleMs` 常配成几秒 —— 视频安静一会儿服务就自己睡了，
           * 再说话时第一个请求必然 `fetch failed`。等失败 3 次才动手（旧逻辑）要白丢
           * 30 秒字幕；这里第一次就 spawn。60 秒内不重复拉，免得起了两个抢端口。
           */
          if (transcriber?.kind === 'http' && Date.now() - lastEnsureAt > 60_000) {
            lastEnsureAt = Date.now();
            ensureService(asrConfig(env), { log }).catch(() => {});
          }
          if (fails >= MAX_FAILS) {
            pausedUntil = Date.now() + RETRY_MS;
            reason = `在听（音量条还在），但转写连续失败：${lastError}`;
          }
          continue;      // **不删文件** —— 服务起来之后这些段还要用
        }
        // 处理完就删：目录是工作区，不是档案。留着会几小时涨到几千个文件。
        try { unlinkSync(path); } catch { /* 删不掉就下次再说 */ }
        // 这句已经有准的了，它的临时快照（还没转的）不必再转
        liveSeen.delete(`live-${t0}.wav`);
        if (!text) continue;
        // 文本层幻觉过滤：整句
        if (isHallucination(text)) { log(`[listen] 丢弃疑似幻觉：${JSON.stringify(text)}`); continue; }
        const dur = Math.max(0.2, (wav.length - 44) / 2 / 16_000);
        const t1 = t0 + Math.round(dur * 1000);
        // **upsert**：同一句如果先出过快照，这里用整句结果把它盖掉
        buffer.upsert(t0, t1, text, { partial: false });
        lastSegAt = Date.now();
        lastLineLagMs = lastSegAt - t0;
        total += 1;
      }

      /**
       * 长句快照：只转**内容变过**的（Python 侧同名覆盖，size/mtime 一起变）。
       * 失败**不计入 `fails`** —— 它只是"提前给一版"，挂了不该把主链路暂停 30 秒。
       */
      if (!cfg.live) {
        for (const n of lives) { try { unlinkSync(join(audioDir, n)); } catch { /* 算了 */ } }
      } else {
        for (const name of lives) {
          const path = join(audioDir, name);
          const t0 = Number(name.slice(5, -4));
          // 整句已经转出来了（Python 删文件失败 / 被占用）：这个快照没用，清掉
          if (buffer.hasFinal(t0)) {
            liveSeen.delete(name);
            try { unlinkSync(path); } catch { /* 占着就下次 */ }
            continue;
          }
          let st = null;
          try { st = statSync(path); } catch { continue; }
          if (st.size < 1024) continue;
          const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
          if (liveSeen.get(name) === stamp) continue;
          liveSeen.set(name, stamp);
          let wav = null;
          try { wav = readFileSync(path); } catch { continue; }
          let text = '';
          try {
            text = await transcriber.transcribe(canonicalizeWav(wav));
            liveErrLogged = false;
          } catch (e) {
            // 快照失败**不计入 `fails`**（它只是"提前给一版"，挂了不该把主链路暂停），
            // 但也不能完全静默 —— "临时字幕为什么一直不出现"时这是唯一线索。
            if (!liveErrLogged) {
              liveErrLogged = true;
              log(`[listen] 快照转写失败（不影响整句）：${e?.message ?? e}`);
            }
            continue;
          }
          if (!text) continue;
          // 文本层幻觉过滤：快照（临时字幕）
          if (isHallucination(text)) { liveSeen.delete(name); continue; }
          const dur = Math.max(0.2, (wav.length - 44) / 2 / 16_000);
          const t1 = t0 + Math.round(dur * 1000);
          const before = buffer.all.length;
          const line = buffer.upsert(t0, t1, text, { partial: true });
          if (line && buffer.all.length > before) {
            partials += 1;
            lastLineLagMs = Date.now() - t0;
          }
        }
        // 目录里可能残留上一句的快照（Python 删失败/被占用），别让它一直重转
        if (liveSeen.size > 32) {
          const keep = new Set(lives);
          for (const k of liveSeen.keys()) if (!keep.has(k)) liveSeen.delete(k);
        }
      }
    } finally {
      busy = false;
    }
  }

  /**
   * 起采集。**幂等**，失败只记状态不抛 —— 音频是加分项，装不上最多没字幕。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function start() {
    if (child) return { ok: true, reason: 'already' };
    if (env.DSH_SEE_AUDIO === '0') {
      reason = '被 DSH_SEE_AUDIO=0 关掉了';
      enabled = false;
      return { ok: false, reason };
    }
    transcriber = injected ?? resolveTranscriber(ctx, { env, log });
    if (!transcriber) {
      reason = '没有可用的转写服务（宿主没有 speechToText，也没有 ~/.dsh/asr.json）';
      enabled = false;
      return { ok: false, reason };
    }
    /**
     * 走 HTTP 就先确认本地服务在不在。
     *
     * **不 await**：服务冷启动要 20~30 秒，挡在这里会让"开始看"变成一个几十秒的空转。
     * 采集和音量条先跑，转写在后台等它就绪 —— 期间的段不删，起来之后照常处理。
     */
    if (transcriber.kind === 'http') {
      ensureService(asrConfig(env), { log })
        .then((r) => { if (!r.ok) log(`转写服务没起来：${r.reason}`); })
        .catch(() => { /* 已经在里面兜过了 */ });
    }
    if (!existsSync(script)) {
      reason = `找不到 listen.py（${script}）`;
      enabled = false;
      return { ok: false, reason };
    }
    python ??= findListenPython({ env });
    if (!python) {
      reason = '没有能用的 Python（要 `pip install pyaudiowpatch numpy`，'
        + '或把解释器路径写进 ~/.dsh/see-window.json 的 listenPython）';
      enabled = false;
      return { ok: false, reason };
    }

    mkdirSync(audioDir, { recursive: true });
    try {
      // 断句与快照参数全部透传给 Python —— 它们是"什么时候切一段"的唯一决定者
      child = spawn(python, [
        script, '--out', audioDir,
        '--silence', String(cfg.silence),
        '--max-seg', String(cfg.maxSeg),
        ...(cfg.live ? ['--live-min', String(cfg.liveMin), '--live-step', String(cfg.liveStep)] : ['--live', '0']),
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...env, DSH_VIDEO_CACHE_DIR: join(dshHome(env), 'see-now') },
      });
    } catch (e) {
      reason = `起不来：${e?.message ?? e}`;
      enabled = false;
      child = null;
      return { ok: false, reason };
    }

    child.stdout?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(0, 400)}`);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(-400)}`);
    });
    child.on('exit', (code) => {
      const wasEnabled = enabled;
      child = null;
      enabled = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (wasEnabled) {
        reason = `采集进程退出了（code=${code}）`;
        log(reason);
      }
    });

    // 等它把设备打开：不确认就报"在听"，用户会以为功能开了其实一句都没录（踩过）
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 4000);
      const onData = (d) => {
        if (!String(d).includes('"event": "device"')) return;
        clearTimeout(t);
        child?.stdout?.off('data', onData);
        resolve(true);
      };
      child?.stdout?.on('data', onData);
      child?.once('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (!ok) {
      stop('回环设备没打开（没有可用的 WASAPI loopback？）');
      reason = '回环设备没打开 —— 这台机器抓不到系统输出的声音';
      return { ok: false, reason };
    }

    enabled = true;
    reason = '在听';
    timer = setInterval(() => {
      // 声学指纹和事件**不依赖转写**：转写服务挂了，这里照样要转 ——
      // 所以它必须在 drain() 之前、并且不受 drain 的 busy 闸影响。
      pollAcoustic();
      // 这里**不能静默吞**：drain 里的意外（权限、编码、表单构造）如果被 `.catch(() => {})`
      // 吃掉，表现就是"在听、但永远没台词"，日志里一条线索都没有。
      drain().catch((e) => log(`[listen] drain 出错：${e?.message ?? e}`));
    }, pollInterval);
    timer.unref?.();
    return { ok: true };
  }

  function stop(why = null) {
    if (timer) { clearInterval(timer); timer = null; }
    if (child) {
      try { child.kill(); } catch { /* 已经没了 */ }
      child = null;
    }
    enabled = false;
    reason = why || '停了';
  }

  /**
   * 取某段时间窗里的台词（见 `createLineBuffer().between`）。
   */
  function between(fromMs, toMs, opts) {
    return buffer.between(fromMs, toMs, opts);
  }

  /**
   * 等"正在飞的那一段"落定（最多 `maxMs`）。
   *
   * ## 为什么这个函数比整个 ASR 链路都值钱
   *
   * `attachLines()` 取台词的窗口是「**上一张图的 wallTo → 这一张的 wallTo**」。
   * 那么：图在 15.0 秒生成，而 14.8 秒那句话要 15.35 秒才转完 —— 它**赶不上这张图**，
   * 被推到下一张。下一张 15 秒后才出，于是这套台词在用户眼里晚了整整 15 秒，
   * 而 ASR 链路本身只用 0.7 秒。**边界效应才是"字幕比画面晚十几秒"的主因。**
   *
   * 出图前等最多 300ms（通常 100~200ms 就够：pollMs 100 + 转写 180），
   * 把这段边界吃掉。代价是出图晚不到 0.3 秒，远小于解说延迟的 3.71s 上限。
   *
   * **积压时不参与等待**：`seg` 排到 3 个以上说明转写服务跟不上，等只会拖慢出图。
   *
   * @returns {Promise<boolean>} true = 手上已经清空（没有在飞的段）
   */
  async function settle(maxMs = 300) {
    if (!transcriber) return false;
    const until = Date.now() + maxMs;
    for (;;) {
      let names = [];
      try { names = readdirSync(audioDir); } catch { names = []; }
      let queued = 0;
      for (const n of names) if (n.startsWith('seg-')) queued += 1;
      if (queued > 3) return false;          // 积压：等也等不来
      if (!busy && queued === 0) return true;
      if (Date.now() >= until) return false;
      await sleep(25);
    }
  }

  return { start, stop, state, between, levelsBetween, acousticBetween, trajectoryBetween, drain, settle };
}
