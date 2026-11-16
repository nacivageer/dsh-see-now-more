/**
 * coverage-ledger.js — 覆盖率账的**按分钟落盘**。
 *
 * 为什么要有它：`coverageOf()` 只算内存里最近 2000 条（十几分钟），DSH 一关就没了。
 * 复盘一局/一天时，最想回答的是「漏抬那一刻到底听没听见」—— 这需要一本跨小时的账。
 *
 * 落盘格式：`$DSH_HOME/see-now/coverage/<YYYY-MM-DD>.jsonl`，一行一段：
 *
 * ```json
 * {"day":"2026-11-17","minute":"04:03","sentSec":3,"speechSec":2.4,
 *  "textSec":0,"emptySegs":1,"segs":1}
 * ```
 *
 * ## 为什么一行是**增量**而不是该分钟的累计快照
 *
 * 快照要处理「重启后同一分钟又写一遍，后者把前者覆盖」的问题，得先回读旧账；
 * 增量不需要：同一分钟可以有多行，读的人按 `minute` 求和，断点、重试、崩溃都幂等。
 *
 * ## 归属哪一分钟：用**这段音频的开始时刻**
 *
 * 转写比声音晚 ~1 秒；按「转写完的时刻」分桶会把 10:00:00 说的话记进 10:00:01，
 * 跨分钟时与 lift 的 `wall`（同一把墙钟）错开。一段跨分钟就按时间比例拆成两行，
 * `segs` / `emptySegs` 这种**计数**只记在占时最长的那一分钟，避免重复计数。
 *
 * ## 失败姿态
 *
 * 写不进去只回调 `onError`（调用方记一次日志），**绝不抛**：账坏了不能让听停掉，
 * 和 `lift/log.js` / `missed.jsonl` 同一个口径。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dshHome } from './chat.js';
import { MIN_SPAN } from './coverage.js';

const pad2 = (n) => String(n).padStart(2, '0');
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

/** 本地日期键 `YYYY-MM-DD`（不是 UTC：凌晨时 `toISOString()` 会给出「昨天」）。 */
export function dayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地分钟键 `HH:MM`（与 lift 的 `wall` 同一把墙钟）。 */
export function minuteKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `$DSH_HOME/see-now/coverage` */
export function coverageRoot(env = process.env) {
  return join(dshHome(env), 'see-now', 'coverage');
}

/** 某天的台账文件；`day` 是日期键。 */
export function ledgerFile(day, env = process.env) {
  return join(coverageRoot(env), `${day}.jsonl`);
}

/** 下一个整分钟（本地时间）的毫秒时间戳。 */
function nextMinuteMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + 1).getTime();
}

/**
 * 一段送审音频 → 落盘行（可能跨分钟，所以返回数组）。
 *
 * @param {{t0?:number, at?:number, sentSec:number, speechSec?:number, gotText?:boolean}} entry
 *   `t0` 是这段音频**开始**的墙上时间；没有就退回 `at`（老调用/测试）。
 * @param {{minSpeechSec?:number}} [o] 「像说话没字」的语音长度门槛，默认与 `coverageOf` 一致
 * @returns {Array<{day:string, minute:string, sentSec:number, speechSec:number,
 *                  textSec:number, emptySegs:number, segs:number}>}
 */
export function ledgerRows(entry, { minSpeechSec = MIN_SPAN } = {}) {
  const sentSec = Math.max(0, Number(entry?.sentSec) || 0);
  if (!(sentSec > 0)) return [];
  // `0` = 转写器 VAD 说这段没人说话（不参与覆盖、也不算「像说话没字」）；
  // `null` = 没回传（不知道）→ 按段长兜底，并在注释里认下这个近似。
  const rawSpeech = entry?.speechSec;
  const hasSpeech = rawSpeech !== null && rawSpeech !== undefined
    && Number.isFinite(Number(rawSpeech));
  const speechSec = hasSpeech ? Math.max(0, Number(rawSpeech)) : sentSec;
  const gotText = entry?.gotText === true;
  const start = Number(entry?.t0 ?? entry?.at);
  if (!Number.isFinite(start) || start <= 0) return [];

  const durMs = Math.max(200, sentSec * 1000);
  const end = start + durMs;

  const slices = [];
  let cursor = start;
  // 600 片是防呆上限：正常一段最多 6 秒、只跨两分钟
  while (cursor < end && slices.length < 600) {
    const sliceEnd = Math.min(end, nextMinuteMs(cursor));
    if (!(sliceEnd > cursor)) break;
    slices.push({ from: cursor, to: sliceEnd });
    cursor = sliceEnd;
  }
  if (!slices.length) return [];

  const widest = slices.reduce((a, b) => ((b.to - b.from) > (a.to - a.from) ? b : a), slices[0]);
  return slices.map((s) => {
    const frac = (s.to - s.from) / durMs;
    return {
      day: dayKey(s.from),
      minute: minuteKey(s.from),
      sentSec: r3(sentSec * frac),
      speechSec: r3(speechSec * frac),
      // 出字就按整段语音算覆盖（`coverageOf()` 的同一口径：按段二值，不猜盖住了哪几秒）
      textSec: gotText ? r3(speechSec * frac) : 0,
      emptySegs: (!gotText && speechSec >= minSpeechSec && s === widest) ? 1 : 0,
      segs: s === widest ? 1 : 0,
    };
  });
}

/**
 * 把一段音频的账追加到当天的台账。
 *
 * @param {{t0?:number, at?:number, sentSec:number, speechSec?:number, gotText?:boolean}} entry
 * @param {{env?:object, onError?:(e:Error)=>void}} [o]
 * @returns {Array<object>} 实际写下去的行（写失败的行不在里面）
 */
export function appendCoverage(entry, { env = process.env, onError = null } = {}) {
  let rows = [];
  try {
    rows = ledgerRows(entry);
  } catch (e) {
    onError?.(e);
    return [];
  }
  if (!rows.length) return [];

  try {
    mkdirSync(coverageRoot(env), { recursive: true });
  } catch (e) {
    onError?.(e);
    return [];
  }

  const written = [];
  for (const row of rows) {
    try {
      appendFileSync(ledgerFile(row.day, env), `${JSON.stringify(row)}\n`, 'utf8');
      written.push(row);
    } catch (e) {
      onError?.(e);
    }
  }
  return written;
}

/** 一行台账的字段归一：坏行返回 null，别让读的人自己防。 */
function normalizeRow(row, day) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.minute !== 'string' || !/^\d{2}:\d{2}$/.test(row.minute)) return null;
  if (row.day && row.day !== day) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    day,
    minute: row.minute,
    sentSec: n(row.sentSec),
    speechSec: n(row.speechSec),
    textSec: n(row.textSec),
    emptySegs: Math.max(0, Math.round(n(row.emptySegs))),
    segs: Math.max(0, Math.round(n(row.segs))),
  };
}

/**
 * 读某天的台账。坏行跳过 —— 手工改过、写到一半断电都不能让读的人挂。
 *
 * @param {string} day 日期键 `YYYY-MM-DD`
 * @returns {Array<object>}
 */
export function readLedger(day, { env = process.env } = {}) {
  let text = '';
  try {
    // 记事本/PowerShell 写出来的文件可能带 BOM；第一行别因此被当成坏行
    text = readFileSync(ledgerFile(day, env), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = normalizeRow(JSON.parse(s), day);
      if (row) out.push(row);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 台账行 → 按分钟合计（`minute` 升序）。
 *
 * @param {Array<object>} rows
 * @returns {Array<{day:string, minute:string, sentSec:number, speechSec:number,
 *                  textSec:number, emptySegs:number, segs:number, ratio:number|null}>}
 */
export function sumByMinute(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = `${row.day ?? ''} ${row.minute}`;
    const acc = map.get(key) ?? {
      day: row.day ?? '', minute: row.minute, sentSec: 0, speechSec: 0, textSec: 0, emptySegs: 0, segs: 0,
    };
    acc.sentSec += Number(row.sentSec) || 0;
    acc.speechSec += Number(row.speechSec) || 0;
    acc.textSec += Number(row.textSec) || 0;
    acc.emptySegs += Number(row.emptySegs) || 0;
    acc.segs += Number(row.segs) || 0;
    map.set(key, acc);
  }
  return [...map.values()]
    .sort((a, b) => (a.day === b.day ? a.minute.localeCompare(b.minute) : a.day.localeCompare(b.day)))
    .map((m) => ({
      ...m,
      sentSec: r3(m.sentSec),
      speechSec: r3(m.speechSec),
      textSec: r3(m.textSec),
      ratio: m.speechSec >= 1 ? Math.round((100 * m.textSec) / m.speechSec) : null,
    }));
}

/** 一条 lift 记录落在哪一分钟：优先 `wall`（那句话的时间），没有才用 `at`。 */
export function liftMinute(row) {
  const t = row?.wall ?? row?.at;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? minuteKey(n) : null;
}

/**
 * 台账与抬起事件对齐：同一分钟内「有字却没抬」= 漏抬候选，
 * 「抬了但那分钟没出字」= 误抬候选。
 *
 * 台账里**完全没有**这一分钟（比如台账刚上线、或那段时间没在听）不判误抬，
 * 单独放进 `unmatched`：缺失是"不知道"，不是"没台词"。
 *
 * @param {Array<object>} minutes `sumByMinute()` 的结果
 * @param {Array<object>} lifts   `lift/<day>/log.jsonl` 的行
 */
export function alignLift(minutes, lifts) {
  const byKey = new Map();
  for (const m of minutes || []) {
    byKey.set(`${m.day} ${m.minute}`, { ...m, lifts: 0, spoke: 0, levels: [] });
  }

  const totals = { lift: 0, spoke: 0 };
  const unmatched = [];
  for (const row of lifts || []) {
    totals.lift += 1;
    if (row?.spoke === true) totals.spoke += 1;
    // 和 `liftMinute()` 取同一个时间戳，别让「算分钟用 wall、算日期用 at」错开
    const t = Number(row?.wall ?? row?.at);
    if (!Number.isFinite(t) || t <= 0) { unmatched.push(row); continue; }
    const key = `${dayKey(t)} ${minuteKey(t)}`;
    const hit = byKey.get(key);
    if (!hit) { unmatched.push(row); continue; }
    hit.lifts += 1;
    if (row.spoke === true) hit.spoke += 1;
    if (row.level && !hit.levels.includes(row.level)) hit.levels.push(row.level);
  }

  const all = [...byKey.values()]
    .sort((a, b) => (a.day === b.day ? a.minute.localeCompare(b.minute) : a.day.localeCompare(b.day)));
  // 「有字」= 这一分钟里至少有一段出了字（textSec > 0）
  const missing = all.filter((m) => m.textSec > 0 && m.lifts === 0);
  const falseAlarm = all.filter((m) => m.lifts > 0 && m.textSec === 0);

  return {
    minutes: all,
    missing,
    falseAlarm,
    totals: {
      ...totals,
      missing: missing.length,
      falseAlarm: falseAlarm.length,
      unmatched: unmatched.length,
    },
    unmatched,
  };
}
