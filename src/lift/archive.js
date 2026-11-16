/**
 * lift/archive.js — 10 分钟的**低清留底**（下游评估 §1 #1 的「跨 30 秒回看」）。
 *
 * ## 为什么不是把 30 秒缓冲直接加大
 *
 * 30 秒缓冲是 0.5 fps 的**裸 RGB**（800×450×3 ≈ 1.03 MiB/帧）。10 分钟 = 300 帧
 * ≈ 309 MiB，全放内存不现实。所以：
 *
 * - **30 秒缓冲不动**：精确帧（`pickAt`）还是走内存，偏差 ≤1 秒；
 * - **另加一条磁盘低清环**：每 5 秒留一帧，长边 480 的 PNG（约 10–20 KB），10 分钟
 *   约 120 帧、几 MB；按天分目录，`frames.jsonl` 当目录（catalog），查询只读命中文件。
 * - 超出 30 秒的 `framePng` 回退到这里，返回 `degraded:'archive-low-res'` ——
 *   调用方必须知道这是低清，不许假装和精确帧一样。
 *
 * ## 原子写（extras 的安全三件套）
 *
 * PNG 先写 `.tmp-<pid>` 再 `rename`；索引整份重写也是 tmp → rename。崩溃最多留下一张
 * 孤儿 PNG（`findAt` 找不到索引就看不见它，prune 会清），不会出现「索引指向不存在的图」。
 *
 * ## 纯靠时间，不读时钟
 *
 * 所有时间来自 `push({at})` / `findAt(t0)`；`now` 只在清理旧日期目录时用。
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { coverInto } from '../scale.js';
import { encodePng } from '../png.js';

/** 保留多久（毫秒）：和池子的十分钟对齐。 */
export const ARCHIVE_WINDOW_MS = 10 * 60 * 1000;
/** 每隔多久留一帧（毫秒）：1 帧/5 秒。 */
export const ARCHIVE_EVERY_MS = 5000;
/** 低清帧的长边（像素）：480×270（16:9）或按源比例。 */
export const ARCHIVE_LONG_EDGE = 480;
/** 回取容差：5 秒一帧，最近帧最远差 2.5 秒。 */
export const ARCHIVE_TOLERANCE_MS = 2500;
/** 日期目录保留几天（今天 + 昨天就够跨零点查询）。 */
export const ARCHIVE_KEEP_DAYS = 2;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期键（和 `lift/log.js` 同一把尺）。 */
export function dayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 某天的低清帧目录。
 *
 * `root` 由 runner 给（`$DSH_HOME/see-now/lift/archive`）—— `src/lift/**` 不直接读
 * `DSH_HOME`（`test/lift-seam.test.mjs` 守着），这里只当一个纯 store。
 */
export function archiveDayDir(root, day) {
  return join(root, day);
}

/** 某天的索引文件。 */
export function archiveIndexFile(root, day) {
  return join(archiveDayDir(root, day), 'frames.jsonl');
}

/** 同目录 tmp → rename，崩溃不留半份。 */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readIndex(root, day) {
  let text = '';
  try {
    text = readFileSync(archiveIndexFile(root, day), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (!row || !Number.isFinite(Number(row.at)) || typeof row.file !== 'string') continue;
      const dir = archiveDayDir(root, day);
      out.push({
        day,
        at: Number(row.at),
        file: row.file,
        path: join(dir, row.file),
        w: Math.max(1, Number(row.w) || 0),
        h: Math.max(1, Number(row.h) || 0),
        bytes: Math.max(0, Number(row.bytes) || 0),
      });
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 建一个低清留底。一个 runner 一个。
 *
 * @param {{root:string, windowMs?:number, everyMs?:number, longEdge?:number,
 *          toleranceMs?:number, keepDays?:number, now?:()=>number}} [o]
 */
export function createLiftArchive({
  root,
  windowMs = ARCHIVE_WINDOW_MS,
  everyMs = ARCHIVE_EVERY_MS,
  longEdge = ARCHIVE_LONG_EDGE,
  toleranceMs = ARCHIVE_TOLERANCE_MS,
  keepDays = ARCHIVE_KEEP_DAYS,
  now = () => Date.now(),
} = {}) {
  if (!root || typeof root !== 'string') throw new Error('createLiftArchive 需要 root（由 runner 给路径）');
  const span = Number(windowMs) > 0 ? Number(windowMs) : ARCHIVE_WINDOW_MS;
  const every = Number(everyMs) > 0 ? Number(everyMs) : ARCHIVE_EVERY_MS;
  const edge = Number(longEdge) > 0 ? Number(longEdge) : ARCHIVE_LONG_EDGE;
  const tol = Number(toleranceMs) >= 0 ? Number(toleranceMs) : ARCHIVE_TOLERANCE_MS;
  const keep = Number.isFinite(Number(keepDays)) ? Math.max(0, Number(keepDays)) : ARCHIVE_KEEP_DAYS;

  /** @type {Array<{day:string,at:number,file:string,path:string,w:number,h:number,bytes:number}>} */
  let entries = [];
  const loaded = new Set();
  let lastAt = 0;
  let lastError = null;
  let lastPruneDay = '';

  function pruneDays(at) {
    const day = dayKey(at);
    if (day === lastPruneDay) return;
    lastPruneDay = day;
    const cutoff = dayKey(at - keep * 24 * 3600 * 1000);
    let names = [];
    try { names = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
      if (e.name >= cutoff) continue;
      try { rmSync(join(root, e.name), { recursive: true, force: true }); } catch { /* 占用就下次 */ }
    }
  }

  function ensureDay(at) {
    const day = dayKey(at);
    if (!loaded.has(day)) {
      loaded.add(day);
      entries.push(...readIndex(root, day));
    }
    pruneDays(at);
  }

  /** 跨零点也要能看到前一天的帧。 */
  function ensureNear(at) {
    ensureDay(at);
    const prev = dayKey(at - span);
    if (prev !== dayKey(at)) ensureDay(at - span);
  }

  function writeIndex(day) {
    const rows = entries
      .filter((e) => e.day === day)
      .sort((a, b) => a.at - b.at)
      .map((e) => JSON.stringify({ at: e.at, file: e.file, w: e.w, h: e.h, bytes: e.bytes }));
    try {
      mkdirSync(archiveDayDir(root, day), { recursive: true });
      writeAtomic(archiveIndexFile(root, day), rows.length ? `${rows.join('\n')}\n` : '');
    } catch (e) {
      lastError = `索引写失败：${e?.message ?? e}`;
    }
  }

  /** 淘汰超过窗口的帧；删文件 + 重写受影响日期的索引。 */
  function prune(at) {
    const cutoff = at - span;
    const dead = entries.filter((e) => e.at < cutoff);
    if (!dead.length) return;
    const days = new Set(dead.map((e) => e.day));
    entries = entries.filter((e) => e.at >= cutoff);
    for (const e of dead) {
      try { rmSync(e.path, { force: true }); } catch { /* 删不掉下次再删 */ }
    }
    for (const day of days) writeIndex(day);
  }

  /**
   * 记一帧（按 `everyMs` 节流）。收下返回 true；节流/坏帧返回 false，不抛。
   *
   * @param {{buf:Buffer, width:number, height:number, at:number}} frame
   */
  function push({ buf, width, height, at } = {}) {
    if (!buf || !(Number(width) > 0) || !(Number(height) > 0) || !Number.isFinite(Number(at))) return false;
    const t = Number(at);
    if (t - lastAt < every) return false;
    lastAt = t;
    try {
      ensureNear(t);
      prune(t);
      const scale = Math.min(1, edge / Math.max(Number(width), Number(height)));
      const dw = Math.max(1, Math.round(Number(width) * scale));
      const dh = Math.max(1, Math.round(Number(height) * scale));
      const small = Buffer.alloc(dw * dh * 3);
      coverInto(buf, Number(width), Number(height), small, dw, dh);
      const png = encodePng(small, dw, dh, { level: 3 });
      const day = dayKey(t);
      const dir = archiveDayDir(root, day);
      mkdirSync(dir, { recursive: true });
      const file = `${Math.round(t)}.png`;
      const full = join(dir, file);
      const tmp = `${full}.tmp-${process.pid}`;
      writeFileSync(tmp, png);
      renameSync(tmp, full);
      entries.push({ day, at: t, file, path: full, w: dw, h: dh, bytes: png.length });
      writeIndex(day);
      return true;
    } catch (e) {
      lastError = `低清留底写失败：${e?.message ?? e}`;
      return false;
    }
  }

  /**
   * 找 `t0` 附近最近的一帧（低清）。
   * @param {number} t0
   * @param {{toleranceMs?:number}} [o]
   * @returns {{ok:true,path:string,at:number,deltaMs:number,width:number,height:number,
   *            degraded:'archive-low-res'}|{ok:false,reason:string}}
   */
  function findAt(t0, { toleranceMs: near = tol } = {}) {
    const t = Number(t0);
    if (!Number.isFinite(t)) return { ok: false, reason: 'bad-time' };
    try {
      ensureNear(t);
    } catch (e) {
      lastError = `低清留底读失败：${e?.message ?? e}`;
      return { ok: false, reason: 'read-failed' };
    }
    const reach = Number.isFinite(Number(near)) && Number(near) >= 0 ? Number(near) : tol;
    let best = null;
    for (const e of entries) {
      const d = Math.abs(e.at - t);
      if (d > reach) continue;
      if (!best || d < best.d) best = { e, d };
    }
    if (!best) {
      const newest = entries.reduce((n, e) => Math.max(n, e.at), 0);
      return { ok: false, reason: t > newest ? 'too-new' : 'too-old' };
    }
    if (!existsSync(best.e.path)) {
      // 索引在、文件没了（手工删/半次崩溃）：从内存移除，别一直指着一个空路径
      entries = entries.filter((e) => e !== best.e);
      writeIndex(best.e.day);
      return { ok: false, reason: 'missing-file' };
    }
    return {
      ok: true,
      path: best.e.path,
      at: best.e.at,
      deltaMs: Math.round(best.d),
      width: best.e.w,
      height: best.e.h,
      degraded: 'archive-low-res',
    };
  }

  /** status 用：帧数 / 跨度 / 体积 / 参数。 */
  function stats() {
    const sorted = [...entries].sort((a, b) => a.at - b.at);
    const bytes = sorted.reduce((n, e) => n + (Number(e.bytes) || 0), 0);
    const newest = sorted.length ? sorted[sorted.length - 1].at : null;
    const oldest = sorted.length ? sorted[0].at : null;
    return {
      frames: sorted.length,
      spanSec: oldest != null && newest != null ? Math.round((newest - oldest) / 1000) : 0,
      mb: +(bytes / (1024 * 1024)).toFixed(1),
      windowSec: Math.round(span / 1000),
      everySec: +(every / 1000).toFixed(1),
      longEdge: edge,
      toleranceMs: tol,
      oldestAt: oldest,
      newestAt: newest,
      dir: root,
      error: lastError,
    };
  }

  /** 停留底（开始看画面 / 收工）时清掉：上一场的帧不许冒充现在。 */
  function clear() {
    for (const day of loaded) {
      try { rmSync(archiveDayDir(root, day), { recursive: true, force: true }); } catch { /* 占用就下次 */ }
    }
    entries = [];
    loaded.clear();
    lastAt = 0;
  }

  return { push, findAt, stats, clear };
}
