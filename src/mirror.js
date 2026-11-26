/**
 * mirror.js — 把绑定会话里**用户在 DSH 主窗亲手打的字**同步进浮窗的聊天流。
 *
 * ## 为什么需要它
 *
 * `~/.dsh/see-now/chat.jsonl` 是浮窗气泡流的唯一来源，但写它的只有两处：
 * 窗口自己（`append_user`）和插件的 `mirrorAssistantText`。于是用户切回 DSH
 * 主窗聊天时，浮窗回看只有 assistant 半边 —— 像它一个人在自言自语。
 *
 * ## 做法（完整方案见 `docs/tasks/session-mirror-quote.md`）
 *
 * - **复用 `chat.jsonl`**，条目带 `origin:"dsh"`；四个消费者用
 *   `chat.js` 的 `isFloatUserEntry` 过滤，不新开第二条流。
 * - **`mid` = `<sid>:<seq>`**：实时与回填共用的去重键。启动时扫一遍
 *   `chat.jsonl` 尾部已有的 `mid`，补「写成功但水位没落盘」的崩溃窗口。
 * - **水位** `session-mirror.json`：只有 `appendChat` 成功后才推进；水位保证
 *   「用户在浮窗里删掉的条目不会被回填复活」，也保证回填幂等。
 *
 * ## 2026-11-26（.31）：模型正文也进来
 *
 * 只搬用户消息时，关窗一段再打开，回看是「只有我半边」—— 因为
 * `mirrorAssistantText` 在窗没开时直接跳过（`src/index.js`）。现在：
 *
 * - **live 不看窗**：绑定会话（未绑定时用事件所属会话）的 `assistant/message`
 *   正文照写，关窗也写；朗读仍只在窗开时（`src/index.js` 决定）。
 * - **回填 assistant** 用独立游标 `assistantThroughSeq`：用户游标被后面一条
 *   user 推走时，它前面那批「当时窗没开」的正文仍补得到。
 * - 旧条目没有 `mid`：回填前先按「同文且 ≤10s」与「已被 `say` 覆盖且 ≤120s」
 *   对 `chat.jsonl` 里已有的 assistant 条目去重。
 *
 * ## 边界（别扩）
 *
 * - 用户消息只认 `source.kind === "user"`（`isTypedUserMessage`）：卡片按钮、
 *   插件自己的叫醒、工具消息都不进。图片只写一行 `[图片]` 占位。
 * - assistant 只搬 `type:"text"` 的块；`reasoning` / `tool-call` 不进。
 * - 回填只取绑定会话、最近 500 条 / 30 天，跳过 fork 继承前缀。
 * - 失败只记 `mirror.log`，不重试、不弹窗、不影响实时镜像和工具调用。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendChat, chatDir, chatFile } from './chat.js';
import { isTypedUserMessage } from './human.js';
import { isRelayInjectedId, serviceOf } from './timer.js';

/** 镜像条目的来源标记；四个消费点靠它把「主窗说的」和「浮窗说的」分开。 */
export const MIRROR_ORIGIN = 'dsh';
/** 单条正文上限：和 assistant 镜像同一个口径。 */
export const MAX_TEXT = 3000;
/** 回填最多写多少条（再老的不在浮窗回看范围）。 */
export const BACKFILL_LIMIT = 500;
/** 回填最多往回看多久。 */
export const BACKFILL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 水位最多记多少个会话。 */
export const MAX_SIDS = 50;
/** 启动扫描 `chat.jsonl` 尾部多少行找已有 `mid`。 */
export const TAIL_LINES = 4000;

export function mirrorPaths(env = process.env) {
  const dir = chatDir(env);
  return {
    watermark: join(dir, 'session-mirror.json'),
    log: join(dir, 'mirror.log'),
  };
}

/**
 * 从一条 `user/message` 事件里取出要显示的文字。
 *
 * 事件形状（DSH `SessionEventMap`）：`user/message` 的 `data` 直接就是
 * `UserMessage`（`{id, content, source}`），没有 `message` 包一层；
 * 兼容包一层的实现，两种都认。
 *
 * 没有文字但有图片 → `[图片]`（不搬实体，点不开）；两者都没有 → 空串（跳过）。
 *
 * @param {object} event
 * @returns {string}
 */
export function mirrorTextOf(event) {
  const data = event?.data ?? event ?? {};
  const blocks = data.content ?? data.message?.content;
  if (!Array.isArray(blocks)) return '';
  const texts = [];
  let hasImage = false;
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (typeof b?.type === 'string' && b.type.startsWith('image')) hasImage = true;
  }
  let text = texts.join('\n').trim();
  if (!text && hasImage) text = '[图片]';
  if (!text) return '';
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** 去重键；没有合法 seq 时返回空串（调用方跳过）。 */
export function mirrorMid(sid, event) {
  const seq = Number(event?.seq);
  if (!sid || !Number.isFinite(seq) || seq < 0) return '';
  return `${sid}:${seq}`;
}

/** 比较用的正文：去掉所有空白（换行 / 空格差异不该算两条）。 */
export function normText(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/**
 * 从一条 `assistant/message` 事件里取出要显示的正文。
 *
 * 形状（真实会话日志，2026-11-26 核过）：`data.message.content` 是块数组，
 * 里面有 `reasoning` / `tool-call` / `text`；只拼 `text`。**纯工具轮没有正文**
 * （真实日志 203 条 assistant 里 50 条是这样），返回空串让调用方跳过。
 *
 * 截断口径与窗口里的历史一致：3000 字 + 省略号。
 *
 * @param {object} event
 * @returns {string}
 */
export function assistantTextOf(event) {
  if (event?.type !== 'assistant/message') return '';
  const data = event?.data ?? {};
  const blocks = data?.message?.content ?? data?.content;
  if (!Array.isArray(blocks)) return '';
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (text.length < 2) return '';
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * 这句正文是不是已经被 `say` 写过一遍了。
 *
 * 判据与 live 原来的实现同口径（`src/index.js` 2026-11-26 之前那段）：两分钟内
 * 说过的那句、且被正文原文包含 —— 那就只留 `say` 那条气泡，不写第二遍。
 *
 * @param {{text?:string, at?:number}|null} said
 * @param {string} text 候选正文
 * @param {number} at 候选事件时间
 * @param {number} nowMs 没有事件时间时的兜底
 */
export function saidCovers(said, text, at, nowMs = Date.now()) {
  if (!said?.text) return false;
  const when = Number(at) > 0 ? Number(at) : nowMs;
  if (Math.abs(when - (Number(said.at) || 0)) > 120_000) return false;
  const body = normText(text);
  const saidNorm = normText(said.text);
  return saidNorm.length > 0 && body.includes(saidNorm);
}

/** 事件里的消息 id（`user/message` 的 data 就是 MessageBase；兼容包一层的） */
function eventMessageId(event) {
  const d = event?.data ?? event ?? {};
  return String(d.id ?? d.message?.id ?? '');
}

/**
 * 这条用户消息是不是**浮窗 relay 代用户投的**（`source.kind:"user"`）。
 *
 * 必须跳：窗口自己已经把这句话写进 `chat.jsonl` 了，再镜像一遍就是重复气泡；
 * 重启后回填也要跳（relay 投过的 id 落盘在 `relay-user-ids.json`）。
 */
function isRelayInjected(event, env) {
  return isRelayInjectedId(eventMessageId(event), env);
}

/**
 * 读水位：`{v:1, sids:{sid:{throughSeq, updated}}}`。坏文件当空的 ——
 * 水位没了最多重扫一遍，`mid` 扫描会挡住重复条目。
 */
export function readMirrorWatermark(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(mirrorPaths(env).watermark, 'utf8'));
    const sids = {};
    for (const [sid, v] of Object.entries(raw?.sids ?? {})) {
      const u = Number(v?.throughSeq);
      const a = Number(v?.assistantThroughSeq);
      const hasU = Number.isFinite(u) && u >= 0;
      const hasA = Number.isFinite(a) && a >= 0;
      if (!sid || (!hasU && !hasA)) continue;
      sids[sid] = {
        throughSeq: hasU ? u : 0,
        assistantThroughSeq: hasA ? a : 0,
        updated: Number(v?.updated) || 0,
      };
    }
    return { v: 1, sids };
  } catch {
    return { v: 1, sids: {} };
  }
}

/** 扫 `chat.jsonl` 尾部（最近 `TAIL_LINES` 行）里已有的 `mid`。 */
export function scanTailMids(env = process.env) {
  const out = new Set();
  let raw = '';
  try { raw = readFileSync(chatFile(env), 'utf8'); } catch { return out; }
  const lines = raw.split('\n');
  const from = Math.max(0, lines.length - TAIL_LINES);
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.includes('"mid"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.mid) out.add(String(entry.mid));
    } catch { /* 半行 / 坏行跳过 */ }
  }
  return out;
}

/**
 * `chat.jsonl` 里已有的 assistant 正文（按 `at` 升序），用于回填去重。
 *
 * 为什么必须看文件而不能只看水位：`.31` 之前的 assistant 条目没有 `mid`，
 * 而 `say` 写的气泡和模型正文是同一句话 —— 只看 `mid` 会把同一句写两遍。
 *
 * 只取尾部 `TAIL_LINES` 行：更早的条目不在窗口回看范围里，也不必为它扫全文件。
 *
 * @returns {{at:number, norm:string}[]}
 */
export function scanAssistantTexts(sid = '', env = process.env) {
  const out = [];
  let raw = '';
  try { raw = readFileSync(chatFile(env), 'utf8'); } catch { return out; }
  const lines = raw.split('\n');
  const from = Math.max(0, lines.length - TAIL_LINES);
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.includes('"assistant"')) continue;
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.role !== 'assistant') continue;
    if (sid && entry?.sid && entry.sid !== sid) continue;
    const at = Number(entry?.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    const text = entry?.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    out.push({ at, norm: normText(text) });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * 这条正文是不是已经以别的形式进过流了（旧版 live 条目 / `say` 气泡）。
 *
 * - 同文、10 秒内：旧版 live 写的同一条（它没带 `mid`，时间取写在当时的 `Date.now()`）；
 * - 已有条目是候选的一大部分、120 秒内：`say` 已经把那句话写过一遍（live 的判据是
 *   「包含」，这里再加一条「占比 ≥ 30%」，免得模型下一轮的长回复里顺带提了一句
 *   旧台词就被当成重复吞掉 —— 实测 1201 条 assistant 里这类包含对只有 1 对）。
 *
 * 两条都要求时间近，避免模型隔很久重复同一句话时被误吞。
 */
export function assistantAlreadyInStream(existing, text, at) {
  if (!Array.isArray(existing) || !existing.length) return false;
  const when = Number(at) || 0;
  const norm = normText(text);
  const near = 120_000;
  // `existing` 按 at 升序：跳过太早的
  let i = 0;
  while (i < existing.length && existing[i].at < when - near) i += 1;
  for (; i < existing.length && existing[i].at <= when + near; i += 1) {
    const e = existing[i];
    if (Math.abs(e.at - when) <= 10_000 && e.norm === norm) return true;
    if (e.norm.length >= 3 && norm.includes(e.norm) && e.norm.length / norm.length >= 0.3) return true;
  }
  return false;
}

/**
 * 接线的唯一实现：一条 `assistant/message` 交给镜像，并决定要不要朗读。
 *
 * 为什么单独成函数：`registerAll` 里那段闭包测不到，而「**窗关着也写、只在窗开时念**」
 * 恰恰是 `.31` 最容易被以后的重构改回去的一行（原来的 `if (!windowAlive()) return`
 * 就在那里）。把它钉成可测的纯接线。
 *
 * @param {{onAssistant?:Function}} mirror `createSessionMirror()` 的返回值
 * @param {object} event `assistant/message`
 * @param {{sid?:string, said?:{text:string,at:number}|null, alive?:boolean, speak?:Function}} [o]
 * @returns {{ok:boolean, text?:string, skip?:string}}
 */
export function pushAssistantText(mirror, event, { sid, said = null, alive = false, speak = null } = {}) {
  if (event?.type !== 'assistant/message' || typeof mirror?.onAssistant !== 'function') {
    return { ok: false };
  }
  const r = mirror.onAssistant(sid, event, { said });
  if (r?.ok && alive && typeof speak === 'function') {
    try { speak(r.text); } catch { /* 念不出来不影响记录 */ }
  }
  return r;
}

/**
 * @param {object} o
 * @param {object} o.ctx cordis 上下文（用来取可选的 `sessionQuery`）
 * @param {(msg:string)=>void} [o.log] 插件 logger
 * @param {object} [o.env] `DSH_HOME` 等（测试注入）
 * @param {()=>number} [o.now] 时钟（测试注入）
 * @param {{users?:boolean, backfill?:boolean}} [o.config] `see-now.json` 的 `mirror` 段
 */
export function createSessionMirror({
  ctx, log = () => {}, env = process.env, now = Date.now,
  config = { users: true, backfill: true },
} = {}) {
  const cfg = { users: config?.users !== false, backfill: config?.backfill !== false };
  /** 水位（内存 + 盘上） */
  const water = readMirrorWatermark(env);
  /** 已在 `chat.jsonl` 里的 mid（本进程写过的 + 启动扫到的） */
  const seen = scanTailMids(env);
  let disposed = false;

  const note = (m) => {
    try { log(m); } catch { /* logger 自己坏了也不能拖住镜像 */ }
    try {
      mkdirSync(chatDir(env), { recursive: true });
      appendFileSync(mirrorPaths(env).log, `${new Date(now()).toISOString()} ${m}\n`, 'utf8');
    } catch { /* 日志写不进去不影响镜像 */ }
  };

  const persistWater = () => {
    try {
      const sids = Object.entries(water.sids)
        .sort((a, b) => (Number(b[1]?.updated) || 0) - (Number(a[1]?.updated) || 0))
        .slice(0, MAX_SIDS);
      const out = { v: 1, sids: Object.fromEntries(sids) };
      const path = mirrorPaths(env).watermark;
      const tmp = `${path}.tmp`;
      mkdirSync(chatDir(env), { recursive: true });
      writeFileSync(tmp, JSON.stringify(out), 'utf8');
      renameSync(tmp, path);
      water.sids = out.sids;
      return true;
    } catch (e) {
      note(`水位写盘失败：${e?.message ?? e}`);
      return false;
    }
  };

  /**
   * 推进游标。用户与模型各一个（`throughSeq` / `assistantThroughSeq`）：
   * 共用一个的话，「assistant 在最后一条 user 之前、而且当时窗没开」的那批
   * 会被后面那条 user 推过去的游标永远挡在外面。
   */
  const advanceTo = (sid, key, seq, { persist = true } = {}) => {
    const n = Number(seq);
    if (!sid || !Number.isFinite(n) || n <= 0) return false;
    const cur = Number(water.sids[sid]?.[key]) || 0;
    if (n <= cur) return false;
    water.sids[sid] = { ...water.sids[sid], [key]: n, updated: now() };
    if (persist) persistWater();
    return true;
  };
  const advance = (sid, seq, opt) => advanceTo(sid, 'throughSeq', seq, opt);
  const advanceAssistant = (sid, seq, opt) => advanceTo(sid, 'assistantThroughSeq', seq, opt);

  /**
   * 写一条镜像条目。**写盘成功才推进水位**；失败返回 `{ok:false}`，
   * 由调用方决定停在哪。
   */
  const writeEvent = (sid, event, { persist = true } = {}) => {
    const text = mirrorTextOf(event);
    const seq = Number(event?.seq);
    if (!text) {
      // 没有可读正文（例如只有附件实体）：跳过，但水位要越过它，否则每次回填都重扫
      advance(sid, seq, { persist });
      return { ok: false, skip: true };
    }
    const mid = mirrorMid(sid, event);
    let entry = null;
    try {
      entry = appendChat('user', text, {
        sid,
        at: Number(event?.time) || now(),
        mid,
        origin: MIRROR_ORIGIN,
        env,
      });
    } catch (e) {
      note(`appendChat 抛错 ${mid || seq}：${e?.message ?? e}`);
      return { ok: false };
    }
    if (!entry) return { ok: false };
    if (mid) seen.add(mid);
    advance(sid, seq, { persist });
    return { ok: true, text };
  };

  /**
   * 实时镜像：`session/event` 钩子里调。返回是否真的写了一条。
   *
   * @param {string} sid 绑定会话 id
   * @param {object} event 会话事件（`user/message`）
   */
  const onEvent = (sid, event) => {
    if (disposed || !cfg.users) return false;
    const id = String(sid ?? '');
    if (!id || !isTypedUserMessage(event)) return false;
    if (isRelayInjected(event, env)) return false;
    const mid = mirrorMid(id, event);
    if (!mid) return false;
    if (seen.has(mid)) return false;
    const seq = Number(event?.seq);
    const cur = Number(water.sids[id]?.throughSeq) || 0;
    if (Number.isFinite(seq) && seq > 0 && seq <= cur) {
      seen.add(mid);
      return false;
    }
    const r = writeEvent(id, event);
    if (r.ok) note(`wrote ${mid}（${r.text.length} 字）`);
    else if (!r.skip) note(`写失败 ${mid}`);
    return r.ok;
  };

  /**
   * 写一条 assistant 正文（`role:"assistant"` + `mid` + `origin:"dsh"`）。
   *
   * 与用户条目同一份 `chat.jsonl`、同一个 `origin`：窗口按 `sid` 过滤、按 `at`
   * 排序，不新增流。写不进去只记日志。
   */
  const writeAssistant = (sid, event, text, mid) => {
    try {
      return appendChat('assistant', text, {
        sid,
        at: Number(event?.time) || now(),
        mid,
        origin: MIRROR_ORIGIN,
        env,
      });
    } catch (e) {
      note(`appendChat 抛错 ${mid}：${e?.message ?? e}`);
      return null;
    }
  };

  /**
   * 实时镜像模型正文：`session/event` 钩子里调（**窗没开也写**）。
   *
   * 与用户消息的区别：
   * - 不看窗：关窗那段也要有正文，否则重开窗就是「只有我半边」；
   * - `say` 已经写过的句子不写第二遍（`saidCovers`，与原来的 live 判据同口径）；
   * - **朗读不在这里**（`index.js` 决定，窗不开就不念）。
   *
   * @param {string} sid 绑定会话（未绑定时传事件所属会话）
   * @param {object} event `assistant/message`
   * @param {{said?:{text:string, at:number}|null}} [o] 最近一次 `say`（用来去重）
   * @returns {{ok:boolean, text?:string, skip?:string}}
   */
  const onAssistant = (sid, event, { said = null } = {}) => {
    if (disposed || !cfg.users) return { ok: false, skip: 'disabled' };
    const id = String(sid ?? '');
    if (!id || event?.type !== 'assistant/message') return { ok: false };
    const seq = Number(event?.seq);
    if (!Number.isFinite(seq) || seq <= 0) return { ok: false };
    const cur = Number(water.sids[id]?.assistantThroughSeq) || 0;
    if (seq <= cur) return { ok: false, skip: 'stale' };
    const text = assistantTextOf(event);
    if (!text) {
      advanceAssistant(id, seq);
      return { ok: false, skip: 'empty' };
    }
    if (saidCovers(said, text, Number(event?.time), now())) {
      advanceAssistant(id, seq);
      return { ok: false, skip: 'said' };
    }
    const mid = mirrorMid(id, event);
    if (!mid) {
      advanceAssistant(id, seq);
      return { ok: false, skip: 'no-mid' };
    }
    if (seen.has(mid)) {
      advanceAssistant(id, seq);
      return { ok: false, skip: 'seen' };
    }
    const entry = writeAssistant(id, event, text, mid);
    if (!entry) return { ok: false };
    seen.add(mid);
    advanceAssistant(id, seq);
    note(`assistant ${mid}（${text.length} 字）`);
    return { ok: true, text };
  };

  /**
   * 回填：读会话日志，把游标之后的消息补进 `chat.jsonl`。
   *
   * 两类各走一条游标：
   * - 用户：`user/message` + `source.kind=user`（`.29`）；
   * - 模型正文：`assistant/message` 的 `text` 块（`.31`）。
   *
   * 约束（任务书「触发、回填与配置」）：
   * - 跳过 `inheritedEventCount` 之前的 fork 继承前缀；
   * - 每类取最近 500 条 / 30 天内，按 seq 顺序写；
   * - 每条写成功才推进游标，失败停在失败那条之前；
   * - 扫完没有可写的也要把游标推到扫描到的最后一条 seq，避免每次重扫。
   *
   * @returns {Promise<{written:number, users?:number, assistants?:number, scanned?:number, ms?:number, error?:string, skipped?:string}>}
   */
  const backfill = async ({ sid, reason = 'manual' } = {}) => {
    if (disposed) return { written: 0, skipped: 'disposed' };
    if (!cfg.backfill || !cfg.users) return { written: 0, skipped: 'disabled' };
    const id = String(sid ?? '');
    if (!id) return { written: 0, skipped: 'no-sid' };
    const sq = serviceOf(ctx, 'sessionQuery');
    if (!sq?.readSession) {
      note('回填跳过：这个部署没有 sessionQuery');
      return { written: 0, skipped: 'no-service' };
    }
    const startedAt = Date.now();
    let res = null;
    try {
      res = await sq.readSession(id);
    } catch (e) {
      note(`回填失败 ${id.slice(0, 16)}：${e?.message ?? e}`);
      return { written: 0, error: String(e?.message ?? e) };
    }

    const events = Array.isArray(res?.events) ? res.events : [];
    const inherited = Number(res?.inheritedEventCount) || 0;
    const since = Number(water.sids[id]?.throughSeq) || 0;
    const sinceA = Number(water.sids[id]?.assistantThroughSeq) || 0;
    const cutoff = now() - BACKFILL_MAX_AGE_MS;

    const picked = [];
    const pickedA = [];
    let lastScanned = Math.max(since, sinceA);
    for (const ev of events) {
      const seq = Number(ev?.seq);
      if (!Number.isFinite(seq) || seq < inherited) continue;
      if (seq > lastScanned) lastScanned = seq;
      if (ev?.type === 'assistant/message') {
        if (seq <= sinceA) continue;
        if ((Number(ev?.time) || 0) < cutoff) continue;
        if (!assistantTextOf(ev)) continue;   // 纯工具轮没有正文，见 assistantTextOf
        pickedA.push(ev);
        continue;
      }
      if (!isTypedUserMessage(ev)) continue;
      if (isRelayInjected(ev, env)) continue;
      if (seq <= since) continue;
      if ((Number(ev?.time) || 0) < cutoff) continue;
      picked.push(ev);
    }

    // 两类各自截到最近 500 条，再合成一条按 seq 的顺序写（对话顺序不能颠倒）
    const tailUsers = picked.slice(-BACKFILL_LIMIT);
    const tailAssistant = pickedA.slice(-BACKFILL_LIMIT);
    const batch = [
      ...tailUsers.map((ev) => ({ kind: 'user', ev })),
      ...tailAssistant.map((ev) => ({ kind: 'assistant', ev })),
    ].sort((a, b) => (Number(a.ev?.seq) || 0) - (Number(b.ev?.seq) || 0));

    // 旧 assistant 条目（没有 mid）+ say 气泡：都是"同一句已经进过流"的证据
    const existingAssistant = tailAssistant.length ? scanAssistantTexts(id, env) : [];

    let written = 0;
    let writtenA = 0;
    let failed = false;
    for (const { kind, ev } of batch) {
      const seq = Number(ev?.seq);
      const mid = mirrorMid(id, ev);
      // 启动时扫到的已有 mid（写成功但游标没落盘的崩溃窗口）→ 跳过但把游标越过它
      if (mid && seen.has(mid)) {
        if (kind === 'user') advance(id, seq, { persist: false });
        else advanceAssistant(id, seq, { persist: false });
        continue;
      }
      if (kind === 'assistant') {
        const text = assistantTextOf(ev);
        if (assistantAlreadyInStream(existingAssistant, text, Number(ev?.time))) {
          advanceAssistant(id, seq, { persist: false });
          continue;
        }
        const entry = writeAssistant(id, ev, text, mid);
        if (entry) {
          written += 1;
          writtenA += 1;
          if (mid) seen.add(mid);
          advanceAssistant(id, seq, { persist: false });
          continue;
        }
        failed = true;
        note(`回填写失败 assistant ${id.slice(0, 16)} seq=${seq}`);
        break;
      }
      const r = writeEvent(id, ev, { persist: false });
      if (r.ok) { written += 1; continue; }
      if (r.skip) continue;
      failed = true;
      note(`回填写失败 ${id.slice(0, 16)} seq=${seq}`);
      break;
    }

    if (!failed) {
      advance(id, lastScanned, { persist: false });
      advanceAssistant(id, lastScanned, { persist: false });
    }
    persistWater();

    const ms = Date.now() - startedAt;
    note(`backfill ${id.slice(0, 16)} ${reason}: wrote ${written - writtenA} users`
      + ` + ${writtenA} assistant / ${tailUsers.length}+${tailAssistant.length}`
      + ` scanned ${events.length} ms=${ms}${failed ? ' failed' : ''}`);
    return { written, users: written - writtenA, assistants: writtenA, scanned: events.length, ms };
  };

  const dispose = () => { disposed = true; };

  return {
    onEvent,
    onAssistant,
    backfill,
    dispose,
    /** 仅测试 / 排查用 */
    status: () => ({
      users: cfg.users,
      backfill: cfg.backfill,
      seen: seen.size,
      watermark: Object.fromEntries(Object.entries(water.sids).map(([k, v]) => [k, v.throughSeq])),
      assistantWatermark: Object.fromEntries(Object.entries(water.sids)
        .map(([k, v]) => [k, v.assistantThroughSeq])),
    }),
  };
}
