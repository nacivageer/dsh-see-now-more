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
 * ## 边界（别扩）
 *
 * - 只认 `source.kind === "user"`（`isTypedUserMessage`）：卡片按钮、插件自己的
 *   叫醒、工具消息都不进。图片只写一行 `[图片]` 占位。
 * - 回填只取绑定会话、最近 500 条 / 30 天，跳过 fork 继承前缀。
 * - 失败只记 `mirror.log`，不重试、不弹窗、不影响实时镜像和工具调用。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendChat, chatDir, chatFile } from './chat.js';
import { isTypedUserMessage } from './human.js';
import { serviceOf } from './timer.js';

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

/**
 * 读水位：`{v:1, sids:{sid:{throughSeq, updated}}}`。坏文件当空的 ——
 * 水位没了最多重扫一遍，`mid` 扫描会挡住重复条目。
 */
export function readMirrorWatermark(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(mirrorPaths(env).watermark, 'utf8'));
    const sids = {};
    for (const [sid, v] of Object.entries(raw?.sids ?? {})) {
      const seq = Number(v?.throughSeq);
      if (!sid || !Number.isFinite(seq) || seq < 0) continue;
      sids[sid] = { throughSeq: seq, updated: Number(v?.updated) || 0 };
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

  const advance = (sid, seq, { persist = true } = {}) => {
    const n = Number(seq);
    if (!sid || !Number.isFinite(n) || n <= 0) return false;
    const cur = Number(water.sids[sid]?.throughSeq) || 0;
    if (n <= cur) return false;
    water.sids[sid] = { throughSeq: n, updated: now() };
    if (persist) persistWater();
    return true;
  };

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
   * 回填：读会话日志，把水位之后的用户消息补进 `chat.jsonl`。
   *
   * 约束（任务书「触发、回填与配置」）：
   * - 只取 `type=user/message` + `source.kind=user`；
   * - 跳过 `inheritedEventCount` 之前的 fork 继承前缀；
   * - 取最近 500 条 / 30 天内；每条写成功才推进水位，失败停在失败那条之前；
   * - 扫完没有可写的也要把水位推到扫描到的最后一条 seq，避免每次重扫。
   *
   * @returns {Promise<{written:number, scanned?:number, ms?:number, error?:string, skipped?:string}>}
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
    const cutoff = now() - BACKFILL_MAX_AGE_MS;

    const picked = [];
    let lastScanned = since;
    for (const ev of events) {
      const seq = Number(ev?.seq);
      if (!Number.isFinite(seq) || seq < inherited) continue;
      if (seq > lastScanned) lastScanned = seq;
      if (!isTypedUserMessage(ev)) continue;
      if (seq <= since) continue;
      if ((Number(ev?.time) || 0) < cutoff) continue;
      picked.push(ev);
    }

    const tail = picked.slice(-BACKFILL_LIMIT);
    let written = 0;
    let failed = false;
    for (const ev of tail) {
      // 启动时扫到的已有 mid（写成功但水位没落盘的崩溃窗口）→ 跳过但把水位越过它
      const mid = mirrorMid(id, ev);
      if (mid && seen.has(mid)) {
        advance(id, Number(ev?.seq), { persist: false });
        continue;
      }
      const r = writeEvent(id, ev, { persist: false });
      if (r.ok) { written += 1; continue; }
      if (r.skip) continue;
      failed = true;
      note(`回填写失败 ${id.slice(0, 16)} seq=${ev?.seq}`);
      break;
    }

    if (!failed) advance(id, lastScanned, { persist: false });
    persistWater();

    const ms = Date.now() - startedAt;
    note(`backfill ${id.slice(0, 16)} ${reason}: wrote ${written}/${picked.length}`
      + ` scanned ${events.length} ms=${ms}${failed ? ' failed' : ''}`);
    return { written, scanned: events.length, ms };
  };

  const dispose = () => { disposed = true; };

  return {
    onEvent,
    backfill,
    dispose,
    /** 仅测试 / 排查用 */
    status: () => ({
      users: cfg.users,
      backfill: cfg.backfill,
      seen: seen.size,
      watermark: Object.fromEntries(Object.entries(water.sids).map(([k, v]) => [k, v.throughSeq])),
    }),
  };
}
