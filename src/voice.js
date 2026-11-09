/**
 * voice.js — 按路径挂一个外部声音适配器。**核心不内置任何引擎**。
 * 照搬 `dsh-watch-together/src/voice-adapter.js`，只做三件事：
 * 从配置读出"装哪个适配器"、dynamic import 它、记住 attach(api) 拿到的 detach。
 * 失败一律不抛 —— 声音是可选能力，装坏了最多没声音，不能让看屏幕起不来。
 *
 * ```json
 * // ~/.dsh/voice.json —— **和陪看共用同一份配置**
 * { "adapter": "D:/code/my-voice.mjs" }
 * ```
 *
 * 共用配置是有意的：用户装一个适配器，两个插件都能用。代价是同一时刻只该有一个在说话，
 * 所以两边都用同一个 `~/.dsh/tts.json` 音色，引擎串行由适配器自己保证。
 *
 * 适配器模块导出 `attach(api)`（或 default 导出同名函数），`api` 是
 * `{ onSpeech, speechSubscribers, emitSpeech, emitSpoken, lastSpeech }`。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { emitSpeech, emitSpoken, lastSpeech, onSpeech, speechSubscribers } from './speech.js';

/**
 * 已挂载的适配器：specifier → { detach, subscriptions }。
 *
 * subscriptions 是这个适配器通过 `onSpeech` 建立的订阅。适配器自己返回 detach 也好、
 * 没返回也好，卸载时都必须清掉；否则 `speechSubscribers()` 会一直 > 0，
 * 我们会一直等一个永远不会来的 `spoken`。
 *
 * @type {Map<string, {detach: Function|null, subscriptions: Set<Function>}>}
 */
const attached = new Map();

/** 正在挂载中的 specifier → Promise，避免并发重复 attach。 */
const pending = new Map();

/**
 * 读 `~/.dsh/voice.json` 里的 `adapter`，或者环境变量 `DSH_VOICE_ADAPTER`。
 * **只读"装哪个适配器"这一个字段** —— 音色、语速、引擎路径都是适配器自己的事。
 */
export function configuredVoiceAdapter(env = process.env) {
  const fromEnv = String(env.DSH_VOICE_ADAPTER ?? '').trim();
  if (fromEnv) return fromEnv;
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8'));
    const spec = String(cfg?.adapter ?? '').trim();
    if (spec) return spec;
  } catch { /* 没配就算了：这是可选能力 */ }
  return null;
}

/**
 * `voice.json` 里给适配器的 `options`（对象，可选）。
 *
 * **为什么加这个**：核心不内置引擎，引擎路径/模型目录该由用户决定；但以前除了
 * "用哪个适配器"没有任何透传入口，适配器只能把模型路径写死在自己代码里 ——
 * 用户换一个自己训的模型就得改别人的源码（2026-11-03 社区反馈原话：
 * "语音写死了一个地方去找那个模型，我明明自己搞过语音模型，能不能支持自定义"）。
 *
 * 现在 `{ "adapter": "...", "options": { "model": "D:/my/model" } }` 会原样交给
 * `attach(api, options)`。**老适配器不受影响**：它们本来就只接一个参数。
 */
export function configuredVoiceOptions(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8'));
    const opts = cfg?.options;
    return opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : null;
  } catch { return null; }
}

/** `D:/code/x.mjs`、`./x.mjs`、`/opt/x.mjs` 当路径；`my-voice-adapter` 当包名 */
function toImportSpecifier(spec) {
  const s = String(spec).trim();
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(s)) {
    return pathToFileURL(s).href;
  }
  return s;
}

/** 在 attach 期间给 onSpeech 加一层记录，失败时才能精确回滚。 */
function trackedApi(api, subscriptions) {
  return {
    ...api,
    onSpeech(handler, options) {
      const off = onSpeech(handler, options);
      let active = true;
      const trackedOff = () => {
        if (!active) return false;
        active = false;
        subscriptions.delete(trackedOff);
        return off();
      };
      subscriptions.add(trackedOff);
      return trackedOff;
    },
  };
}

/**
 * 最后一次挂载失败的原因。
 *
 * 为什么留着：`status` 要能回答"配了适配器为什么没声音"。没有这个字段，
 * 现场只能靠猜（"是不是没重启？"），而真实原因往往是 import 路径写错了、
 * 或者适配器 `attach` 里探测引擎时抛了。
 */
let lastError = null;

export function lastVoiceError() {
  return lastError;
}

/**
 * 挂载一个外部适配器。**核心只做 dynamic import，不内置任何引擎**。
 *
 * @param {string} spec 模块名或文件路径
 * @param {{ log?: (msg:string)=>void }} [o]
 * @returns {Promise<{ok:boolean, reason?:string, cached?:boolean, name?:string}>}
 */
export async function loadVoiceAdapter(spec, { log = () => {}, options = null } = {}) {
  const raw = String(spec ?? '').trim();
  if (!raw) { lastError = 'empty-specifier'; return { ok: false, reason: 'empty-specifier' }; }
  if (attached.has(raw)) return { ok: true, cached: true, name: raw };
  if (pending.has(raw)) return pending.get(raw);

  const work = (async () => {
    let mod = null;
    try {
      mod = await import(toImportSpecifier(raw));
    } catch (e) {
      const reason = `import failed: ${String(e?.message ?? e).slice(0, 200)}`;
      log(`[voice] ${raw}: ${reason}`);
      lastError = reason; return { ok: false, reason };
    }

    const attach = mod?.attach ?? mod?.default;
    if (typeof attach !== 'function') {
      const reason = 'module does not export attach(api) (or a default function)';
      log(`[voice] ${raw}: ${reason}`);
      lastError = reason; return { ok: false, reason };
    }

    const subscriptions = new Set();
    try {
      const detach = await attach(trackedApi({
        onSpeech, speechSubscribers, emitSpeech, emitSpoken, lastSpeech,
      }, subscriptions), options ?? {});
      attached.set(raw, {
        detach: typeof detach === 'function' ? detach : null,
        subscriptions,
      });
      // 模块没有自报名字时用路径末段 —— `attach.name` 永远是 "attach"，没有信息量
      const name = String(mod?.adapterName ?? raw).split(/[\\/]/).filter(Boolean).pop() || raw;
      log(`[voice] adapter attached: ${name}`);
      lastError = null;                       // 成功了就别再报旧错
      return { ok: true, name };
    } catch (e) {
      // attach 可能已经订阅后才抛。只返回失败还不够：那些订阅还挂在总线上，
      // 这里精确退订，不碰其他订阅者。
      for (const off of [...subscriptions]) {
        try { off(); } catch { /* 退订本身失败也要继续清 */ }
      }
      const reason = `attach failed: ${String(e?.message ?? e).slice(0, 200)}`;
      log(`[voice] ${raw}: ${reason}`);
      lastError = reason; return { ok: false, reason };
    }
  })();

  pending.set(raw, work);
  try {
    return await work;
  } finally {
    pending.delete(raw);
  }
}

/** 按配置挂载（没配就是 no-op）。**这是核心唯一碰声音的地方**。 */
export async function attachConfiguredVoice({ env = process.env, log = () => {} } = {}) {
  const spec = configuredVoiceAdapter(env);
  if (!spec) return { ok: false, reason: 'not-configured' };
  return loadVoiceAdapter(spec, { log, options: configuredVoiceOptions(env) });
}

/**
 * 当前配置的**指纹**：适配器路径 + `tts.json` 的**内容摘要**。
 *
 * 为什么需要指纹：适配器在 `attach` 那一刻把 `tts.json` 读进闭包，之后改文件它**看不见**。
 * 有了指纹，每次调用就能自己判断"配置变没变"，变了就重挂 —— 不用重启 DSH。
 * 核心在这里只看"变没变"，不解释内容：音色、语速都是适配器自己的事。
 *
 * 为什么用内容摘要而不是 mtime：mtime 的分辨率只到毫秒，同一毫秒内两次同长度的写入
 * 会被判成没变 —— 这个坑单测里当场踩到过。这个文件只有几十字节，读一遍比 stat 贵不了多少。
 */
export function voiceSignature(env = process.env) {
  const spec = configuredVoiceAdapter(env);
  if (!spec) return '';
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  let stamp = 'none';
  try {
    const buf = readFileSync(join(home, 'tts.json'));
    stamp = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch { /* 没有 tts.json：用适配器自己的默认值 */ }
  // `options` 也算进指纹：它是**挂载时**读进闭包的，改了不重挂就等于没改
  let opts = '';
  try { opts = JSON.stringify(configuredVoiceOptions(env) ?? null); } catch { opts = '?'; }
  return `${spec}|${stamp}|${opts}`;
}

/** 上一次成功挂载时的指纹。 */
let attachedSig = null;

/**
 * **每次调用都过一遍**的挂载检查。
 *
 * - 没配 → 什么都不做（声音是可选能力）；
 * - 已挂且指纹没变 → 一次 stat 的代价，立刻返回；
 * - 配置变了（换了适配器，或者改了 `tts.json`）→ 卸掉重挂。
 *
 * 放在工具入口而不是启动时，是为了"改完配置下一句就生效"。
 */
export async function ensureConfiguredVoice({ env = process.env, log = () => {} } = {}) {
  const sig = voiceSignature(env);
  if (!sig) return { ok: false, reason: 'not-configured' };
  if (attachedSig === sig && attached.size > 0) return { ok: true, cached: true };
  if (attached.size > 0) {
    log('[voice] 配置变了，重挂适配器');
    await detachAdapters();
  }
  const r = await attachConfiguredVoice({ env, log });
  if (r.ok) attachedSig = sig;
  return r;
}

/** 已挂载的适配器列表（排查用） */
export function attachedAdapters() {
  return [...attached.keys()];
}

/**
 * 全部卸载（测试/热重载用）。
 *
 * **只卸载适配器自己的订阅**，不调用 `__resetSpeech()`：其他订阅者可能还活着，
 * 一次热重载不该让它们一起消失。
 */
export async function detachAdapters() {
  for (const [, entry] of attached) {
    try { await entry.detach?.(); } catch { /* 卸不掉也继续 */ }
    for (const off of [...entry.subscriptions]) {
      try { off(); } catch { /* 已经退订 */ }
    }
  }
  attached.clear();
}
