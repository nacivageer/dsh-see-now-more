/**
 * lift-log.js — 黑听抬头的落盘记录（P2-B 第 2 步）。
 *
 * 两个东西，都在 `$DSH_HOME/see-now/lift/` 下按**本地日期**分目录：
 *
 * ```
 * lift/2026-11-10/log.jsonl     一条命中一行（机读）
 * lift/2026-11-10/1794320557858.png   「瞥」的那一帧（人命名的：帧的墙上时间）
 * ```
 *
 * ## 为什么按天切
 *
 * 黑听一晚上，`lift.jsonl` 可以是几百行（警觉也记），单文件长到没有尽头，
 * 而 `status` 只关心「今天」。按天切让「今日计数」变成读一个短文件，
 * 也让过期清理变成删一个目录（保留 3 天，见 `pruneOld`）。
 *
 * ## 记录形状（机制文档定的字段，一个不多）
 *
 * ```json
 * {"at":1764320559000,"wall":1764320558311,"level":"glance","trigger":"word",
 *  "text":"你看这个","frameAt":1764320557858,"spoke":false,"reason":"强命中…"}
 * ```
 *
 * - `at`     写这条的时间（这次判定发生在什么时候）
 * - `wall`   那句话的时间（ASR 的 `t0`）—— 取帧、对时都用它
 * - `level`  四种之一；`trigger` 是 `word` / `name` / `pool` / `dialog` / `hold` / `probe`
 * - `frameAt` 真取到帧了才有（帧的墙上时间），没有就是 `null`
 * - `spoke`  有没有叫醒模型
 *
 * 写失败一律**静默返回 null**：记账坏了不能把黑听弄停（和 `missed.jsonl` 同一个口径）。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { chatDir } from './chat.js';
import { LIFT_LEVELS } from './tuning.js';

/** 保留几天（含今天）。`0` = 不清理。 */
export const LIFT_KEEP_DAYS = 3;

/** `status` 读今日计数的缓存时长（毫秒）：每拍读盘不值得，但也不能太旧。 */
const COUNT_CACHE_MS = 5000;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期键 `YYYY-MM-DD`（不是 UTC —— "今天"对用户是本地的今天）。 */
export function dayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `$DSH_HOME/see-now/lift` */
export function liftRoot(env = process.env) {
  return join(chatDir(env), 'lift');
}

/** 某天的目录；`day` 可以是日期键或任意毫秒时间戳。 */
export function dayDir(day, env = process.env) {
  return join(liftRoot(env), typeof day === 'string' ? day : dayKey(day));
}

/** 某天的记录文件。 */
export function logFile(day, env = process.env) {
  return join(dayDir(day, env), 'log.jsonl');
}

/** 「瞥」那一帧的落盘路径（用帧自己的时间戳命名，同一帧不会写两遍）。 */
export function frameFile(at, env = process.env) {
  return join(dayDir(Number(at) || Date.now(), env), `${Math.round(Number(at) || Date.now())}.png`);
}

const cache = new Map();   // `${DSH_HOME}|${day}` → { at, counts }

/**
 * 可选的时间戳字段（`wall` / `frameAt`）：**没有就是 null，不是 0**。
 *
 * `Number(null)` 是 0、`Number('')` 也是 0，直接 `Number.isFinite(Number(x))` 会把
 * 「那一刻的画面没了」写成 `frameAt:0` —— 验收第 5 条要的正是 `null`，0 会被读成
 * 「1970 年取到过一帧」。
 */
function timeOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 追加一条记录。
 *
 * @param {{at?:number, wall?:number|null, level?:string, trigger?:string, text?:string,
 *          frameAt?:number|null, spoke?:boolean, reason?:string}} rec
 * @param {{env?:object, now?:() => number}} [o]
 * @returns {object|null} 实际写下去的那一行（解析后），写失败 / 参数坏返回 null
 */
export function appendLift(rec, { env = process.env, now = () => Date.now() } = {}) {
  if (!rec || typeof rec !== 'object') return null;
  const at = Number(rec.at) || now();
  const level = LIFT_LEVELS.includes(rec.level) ? rec.level : null;
  if (!level) return null;

  const row = {
    at,
    wall: timeOrNull(rec.wall),
    level,
    trigger: typeof rec.trigger === 'string' && rec.trigger.trim() ? rec.trigger.trim().slice(0, 40) : 'unknown',
    text: typeof rec.text === 'string' ? rec.text.trim().slice(0, 200) : '',
    frameAt: timeOrNull(rec.frameAt),
    spoke: rec.spoke === true,
    reason: typeof rec.reason === 'string' ? rec.reason.trim().slice(0, 200) : '',
  };

  try {
    mkdirSync(dayDir(at, env), { recursive: true });
    appendFileSync(logFile(at, env), `${JSON.stringify(row)}\n`, 'utf8');
    cache.delete(`${env.DSH_HOME ?? ''}|${dayKey(at)}`);
    return row;
  } catch {
    return null;
  }
}

/**
 * 读某天的记录。坏行跳过（手工改过、写到一半断电都不能让读的人挂）。
 * @param {string|number} day 日期键或时间戳
 * @returns {Array<object>}
 */
export function readDay(day, { env = process.env } = {}) {
  let text = '';
  try {
    text = readFileSync(logFile(day, env), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object' && LIFT_LEVELS.includes(row.level)) out.push(row);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 今日各档次数（`status` 用）。5 秒缓存，写一条就失效。
 * @returns {{alarm:number, glance:number, look:number, chase:number, total:number}}
 */
export function todayCounts({ env = process.env, now = () => Date.now() } = {}) {
  const t = Number(now()) || Date.now();
  const day = dayKey(t);
  const key = `${env.DSH_HOME ?? ''}|${day}`;
  const hit = cache.get(key);
  if (hit && t - hit.at < COUNT_CACHE_MS) return hit.counts;

  const counts = { alarm: 0, glance: 0, look: 0, chase: 0, total: 0 };
  for (const row of readDay(day, { env })) {
    if (counts[row.level] !== undefined) counts[row.level] += 1;
    counts.total += 1;
  }
  cache.set(key, { at: t, counts });
  return counts;
}

/** 测试用：把计数缓存清掉（进程里改过文件时）。 */
export function resetCountCache() {
  cache.clear();
}

/**
 * 删掉过期日期目录。在**启动时**和每次写记录前顺手调一次都行（幂等、便宜）。
 *
 * 只删名字长得像 `YYYY-MM-DD` 的目录 —— `lift/` 下将来可能有别的东西（比如手放的图），
 * 不能为了清理把不认识的东西一起删了。
 *
 * @param {{env?:object, now?:() => number, keepDays?:number}} [o]
 * @returns {number} 删了几个目录
 */
export function pruneOld({ env = process.env, now = () => Date.now(), keepDays = LIFT_KEEP_DAYS } = {}) {
  const days = Math.max(0, Math.floor(Number(keepDays) || 0));
  if (!days) return 0;
  const root = liftRoot(env);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = new Date(Number(now()) - days * 24 * 3600 * 1000);
  const cutoffKey = dayKey(cutoff.getTime());
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
    // 日期键是定长 `YYYY-MM-DD`，字符串比较等价于按日期比较
    if (e.name >= cutoffKey) continue;
    try {
      rmSync(join(root, e.name), { recursive: true, force: true });
      removed += 1;
    } catch { /* 被占用就下次再删 */ }
  }
  return removed;
}

/* 到这里为止是给四档用的全部出口；`lift.log` 那行临时取证已经并进 `log.jsonl`。 */

/**
 * 调试落点：`$DSH_HOME/see-now/lift/debug.log`，一行一条纯文本。
 *
 * 为什么需要：打包后的 Desktop 里 `ctx.logger.info` 看不见，而"循环活着但什么都不做"
 * 这种故障只在日志里有线索（tick 抛异常、心跳停在几点）。**只写关键事件**：
 * tick 抛错、每 60 秒一条心跳 —— 正常运行时一天几 KB。
 */
export function appendLiftDebug(text, env = process.env) {
  const line = String(text ?? '').trim();
  if (!line) return false;
  try {
    const dir = liftRoot(env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
