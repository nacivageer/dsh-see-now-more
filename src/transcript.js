/**
 * transcript.js — 台词全文按天落盘（`$DSH_HOME/see-now/transcript/<YYYY-MM-DD>.jsonl`）。
 *
 * 为什么单独一个模块：写的人有两个（`listen.js` 逐句追加、`loop.js` 的合并唤醒也要确保
 * 有落盘），被两边同时 import 就不该再让 `loop ↔ listen` 互相依赖。
 *
 * 2026-11-17 改：**逐句追加**，不再等唤醒批量写。上一版只在叫醒时整批落盘，
 * 于是"读文件算 CER"经常缺最近一两分钟 —— 而那时句子还在内存里。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dshHome } from './chat.js';

/** 相对路径（`see-now/transcript/<date>.jsonl`），唤醒文案里要给用户看这个。 */
export function transcriptRelPath(at = Date.now()) {
  const d = new Date(at);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;
  return join('see-now', 'transcript', `${ymd}.jsonl`);
}

export function transcriptPath(env = process.env, at = Date.now()) {
  return join(dshHome(env), transcriptRelPath(at));
}

/** 一行台词 → 落盘记录（空白句不收）。 */
export function transcriptEntry(l) {
  const text = String(l?.text ?? '').trim();
  if (!text) return null;
  const spk = String(l?.spk ?? '').trim() || null;
  return {
    t0: Number(l?.t0) || 0,
    t1: Number(l?.t1) || 0,
    text,
    ...(spk ? { spk } : {}),
  };
}

/** 把一批台词追加进当天文件；写不进去不影响听。返回写入条数。 */
export function writeTranscript(lines, at = Date.now(), env = process.env) {
  try {
    const rows = (lines ?? []).map(transcriptEntry).filter(Boolean);
    if (!rows.length) return 0;
    const p = transcriptPath(env, at);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    return rows.length;
  } catch {
    return 0;
  }
}
