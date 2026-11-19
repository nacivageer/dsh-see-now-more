/**
 * voice-deepseek-tts.mjs — 用 DeepSeek 官方语音合成念 `say` 的声音适配器。
 *
 * 走开放平台的工具 API：`POST https://api.deepseek.com/v1/tools/tts`（Bearer key）。
 * **只认开放平台的 `sk-` key**，不认 chat.deepseek.com 的网页登录态 —— 两套账号。
 *
 * ```json
 * // ~/.dsh/voice.json
 * { "adapter": "C:/.../examples/voice-deepseek-tts.mjs",
 *   "options": { "apiKey": "sk-…", "voice_id": "stella" } }
 * ```
 *
 * key 取值顺序：`options.apiKey` → 环境变量 `DEEPSEEK_API_KEY`。没有 key 时 `attach`
 * 直接抛错（不会假装挂上），`status` 的「声音」行会写原因。
 *
 * 音色只有两个：`stella`（海星，女声，默认）与 `tide`（暗潮，男声）。
 * 计费 3 元/万字符（汉字算 2 个字符），按量计费，和模型对话的钱分开。
 *
 * 播放用 `ffplay`（`options.ffplay` 可指定）；合成结果先落临时 wav，念完删掉。
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const adapterName = 'deepseek-tts';

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_VOICE = 'stella';

function homeDir(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** key 在 options 里？还是环境变量？都没有就抛，让 status 有个说得清的理由。 */
function resolveKey(options = {}, env = process.env) {
  const fromOpt = String(options?.apiKey ?? '').trim();
  if (fromOpt) return fromOpt;
  const fromEnv = String(env.DEEPSEEK_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  // 有的会话会把 key 写进 asr.json / 别处；这里只额外看一眼 settings 里的 provider 配置，
  // 读不到就算了 —— 不猜路径。
  const cfg = readJson(join(homeDir(env), 'deepseek.json'));
  const fromCfg = String(cfg?.apiKey ?? '').trim();
  return fromCfg || '';
}

/** tts.json 的 voice 既可能是 edge 的名字，也可能是 stella/tide；只认后者。 */
function readVoice(env = process.env) {
  const raw = readJson(join(homeDir(env), 'tts.json'));
  const v = String(raw?.voice ?? '').trim();
  return v === 'stella' || v === 'tide' ? v : DEFAULT_VOICE;
}

export async function attach(api, options = {}) {
  const key = resolveKey(options);
  if (!key) {
    throw new Error('没有可用的 DeepSeek API key：设环境变量 DEEPSEEK_API_KEY（改完要重启 DSH），或填 ~/.dsh/voice.json 的 options.apiKey（热读，不用重启）');
  }
  const voiceId = String(options?.voice_id ?? '').trim() || readVoice();
  const base = String(options?.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const ffplay = String(options?.ffplay ?? process.env.DSH_FFPLAY ?? 'ffplay');

  let job = null;
  let alive = true;
  let seq = 0;

  const cleanup = (file) => { try { unlinkSync(file); } catch { /* 已经没了 */ } };

  const startOne = async (ev) => {
    const file = join(tmpdir(), `dsh-ds-tts-${process.pid}-${Date.now()}-${(seq += 1)}.wav`);
    job = { file, play: null };
    try {
      const res = await fetch(`${base}/v1/tools/tts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        // DeepSeek 的合成接口不收 SSML：加粗只能靠**停顿**表达（前后加逗号 + 破折号）
        body: JSON.stringify({
          text: String(ev.text).replace(/\*\*(.+?)\*\*/g, '，$1，'),
          voice_id: voiceId,
          format: 'wav',
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${detail.slice(0, 120)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('返回了空音频');
      writeFileSync(file, buf);
      if (!alive) { cleanup(file); return; }
      let play;
      try {
        play = spawn(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', file],
          { stdio: 'ignore', windowsHide: true });
      } catch {
        cleanup(file);
        job = null;
        return;
      }
      job.play = play;
      // ffplay 起来 = 马上出声
      try { api.emitSpoken({ text: ev.text, at: ev.at }); } catch { /* 上报失败不影响念 */ }
      const done = () => { cleanup(file); if (job?.play === play) job = null; };
      play.on('close', done);
      play.on('error', done);
    } catch {
      // 合成失败（没网 / 没余额 / 内容审核）：这句算跳过，别让展示层一直等
      try { api.emitSpeech({ text: ev.text, at: ev.at ?? null, state: 'skipped' }); } catch { /* 没人听 */ }
      cleanup(file);
      job = null;
    }
  };

  const off = api.onSpeech((ev) => {
    if (ev?.state !== 'due') return;
    const text = String(ev.text ?? '').trim();
    if (!text || !alive) return;
    if (job) {
      try { api.emitSpeech({ text, at: ev.at ?? null, state: 'skipped' }); } catch { /* 没人听也无所谓 */ }
      return;
    }
    void startOne({ text, at: ev.at ?? null });
  });

  return () => {
    alive = false;
    try { off?.(); } catch { /* 已经退订 */ }
    if (job) {
      try { job.play?.kill(); } catch { /* 已经没了 */ }
      cleanup(job.file);
      job = null;
    }
  };
}

export default attach;
