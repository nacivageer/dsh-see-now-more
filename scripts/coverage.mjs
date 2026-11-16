#!/usr/bin/env node
/**
 * coverage.mjs — 覆盖率账：**人声时间里，有多少真的被转写盖住了**。
 *
 * 为什么要有它：现在只能报「累计 N 句」「帧数」「最后帧多久前」，报不出
 * 「这段到底听清了多少」。没有这本账，一段血条录像里「规则没触发」和
 * 「那一刻根本没听见」分不开——漏抬/误抬那三个数就算不出来。
 *
 * 口径（全部来自已有文件，不新增采集）：
 *   - 人声（speech）：`acoustic.json` 每格中频占比 ≥0.6
 *   - 有声（sound）：有声音但不以中频为主（音乐/音效）
 *   - 没测到（nodata）：那一格 loopback 没推数据
 *   - 有字：台词行 [t0,t1] 与时间窗的相交部分（先并区间再算，避免重复计数）
 *   - **覆盖率 = 有字时长 ∩ 人声时长 / 人声时长**
 *   - 像说话没字：≥1.2 秒的人声段里一个字都没落上
 *
 * 已知边界：`acoustic.json` 是**约 90 秒的滚动窗**（实测 1879 格 × 0.05s），
 * 所以这本账只能算最近这段；要算十分钟池子得先把声学格按分钟落盘（未做）。
 *
 * 用法：
 *   node scripts/coverage.mjs                        # 滚动窗全段
 *   node scripts/coverage.mjs --minutes 3
 *   node scripts/coverage.mjs --from 1794854000000 --to 1794854800000
 *   node scripts/coverage.mjs --json                 # 机器可读
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HOP_DEFAULT = 0.5;          // 秒；acoustic.json 里有 hop 就用它
export const MIN_SPAN = 1.2;      // 秒；短于此的人声段不要求有字
export const SPEECH_MID = 0.6;    // 中频占比阈值，与 listen.js 的 audioTrajectory 同一口径

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function readLines(p) {
  if (!existsSync(p)) return [];
  const out = [];
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch { /* 半行忽略 */ }
  }
  return out;
}

/** 帧 → 每格类别（与 listen.js 的 kindOf 完全一致，别各写一套） */
export function kindOf(r) {
  if (!r) return 'nodata';
  const db = r[0];
  if (db <= -100) return 'silent';
  const lo = r[4], midRaw = r[5], hi = r[6];
  const sum = lo + midRaw + hi;
  const mid = sum > 0.05 ? midRaw / sum : midRaw;
  return mid >= SPEECH_MID ? 'speech' : 'sound';
}

/** 把相邻同类帧并成段：[{kind, from, to}]（ms） */
export function spansOf(frames, base, hopMs, i0, i1) {
  const out = [];
  let cur = null;
  for (let i = i0; i <= i1; i += 1) {
    const kind = kindOf(frames[i]);
    const from = base + i * hopMs;
    const to = from + hopMs;
    if (cur && cur.kind === kind) cur.to = to;
    else { cur = { kind, from, to }; out.push(cur); }
  }
  return out;
}

/** 把区间并起来，返回并集（输入可乱序、可重叠） */
export function mergeIntervals(list) {
  const sorted = list.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from);
  const merged = [];
  for (const x of sorted) {
    const last = merged[merged.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else merged.push({ ...x });
  }
  return merged;
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * 算一本账。
 * @param {{from:number, hop:number, frames:Array}} acoustic
 * @param {Array<{t0:number,t1:number,text:string}>} transcriptLines
 * @param {{from?:number, to?:number, minSpan?:number}} opts
 */
export function computeCoverage(acoustic, transcriptLines, { from, to, minSpan = MIN_SPAN } = {}) {
  const base = Number(acoustic.from);
  const hop = Number(acoustic.hop) || HOP_DEFAULT;
  const hopMs = hop * 1000;
  const fileEnd = base + acoustic.frames.length * hopMs;
  const winTo = Number.isFinite(to) ? to : fileEnd;
  const winFrom = Number.isFinite(from) ? from : base;
  const i0 = Math.max(0, Math.ceil((winFrom - base) / hopMs));
  const i1 = Math.min(acoustic.frames.length - 1, Math.floor((winTo - base) / hopMs));
  if (i1 < i0) return null;

  const sp = spansOf(acoustic.frames, base, hopMs, i0, i1);
  const dur = (k) => sp.filter((s) => s.kind === k).reduce((n, s) => n + (s.to - s.from), 0) / 1000;
  const speechSpans = sp.filter((s) => s.kind === 'speech');

  const lines = (transcriptLines || [])
    .filter((l) => Number(l.t1) >= winFrom && Number(l.t0) <= winTo)
    .map((l) => ({
      from: Math.max(Number(l.t0), winFrom),
      to: Math.min(Number(l.t1), winTo),
      text: l.text || '',
    }));
  const textUnion = mergeIntervals(lines);

  const covered = textUnion.reduce((n, x) => {
    let sum = 0;
    for (const s of speechSpans) sum += overlap(x.from, x.to, s.from, s.to);
    return n + sum;
  }, 0) / 1000;

  const speechSec = dur('speech');
  const offSpeech = textUnion.reduce((n, x) => {
    let sum = 0;
    for (const s of sp) if (s.kind !== 'speech') sum += overlap(x.from, x.to, s.from, s.to);
    return n + sum;
  }, 0) / 1000;

  const longSpans = speechSpans.filter((s) => (s.to - s.from) >= minSpan * 1000);
  const emptySpans = longSpans.filter((s) => !lines.some((l) => overlap(l.from, l.to, s.from, s.to) > 0));
  const emptySec = emptySpans.reduce((n, s) => n + (s.to - s.from), 0) / 1000;

  return {
    window: { from: winFrom, to: winTo, seconds: Math.round((winTo - winFrom) / 1000) },
    audio: {
      speechSec: +speechSec.toFixed(1),
      soundSec: +dur('sound').toFixed(1),
      silentSec: +dur('silent').toFixed(1),
      nodataSec: +dur('nodata').toFixed(1),
    },
    text: {
      lines: lines.length,
      chars: lines.reduce((n, l) => n + (l.text || '').length, 0),
      coveredSec: +covered.toFixed(1),
      offSpeechSec: +offSpeech.toFixed(1),
    },
    coverage: speechSec >= 1 ? +(100 * covered / speechSec).toFixed(0) : null,
    speechButNoText: { spans: emptySpans.length, seconds: +emptySec.toFixed(1) },
  };
}

function main() {
  const i = (name, fb = null) => {
    const k = process.argv.indexOf(`--${name}`);
    return k >= 0 && process.argv[k + 1] ? process.argv[k + 1] : fb;
  };
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const dir = i('audio', join(home, 'see-now', 'audio'));
  const today = new Date().toISOString().slice(0, 10);
  const transcriptPath = i('transcript', join(home, 'see-now', 'transcript', `${today}.jsonl`));

  const acoustic = readJson(join(dir, 'acoustic.json'));
  if (!acoustic || !Array.isArray(acoustic.frames) || !acoustic.frames.length) {
    console.error(`没有声学指纹：${join(dir, 'acoustic.json')}（听觉没在跑过？）`);
    return 2;
  }
  const base = Number(acoustic.from);
  const hopMs = (Number(acoustic.hop) || HOP_DEFAULT) * 1000;
  const fileEnd = base + acoustic.frames.length * hopMs;
  const minutes = Number(i('minutes', 0));
  const to = Number(i('to', Math.min(Date.now(), fileEnd)));
  const from = Number(i('from', minutes ? Math.max(base, to - minutes * 60_000) : base));

  const res = computeCoverage(acoustic, readLines(transcriptPath), { from, to });
  if (!res) {
    console.error(`时间窗里没有声学帧：${from}..${to}`);
    return 2;
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 1));
    return 0;
  }
  const pct = res.coverage == null ? '—' : `${res.coverage}%`;
  console.log(`窗口 ${new Date(res.window.from).toLocaleTimeString()}–${new Date(res.window.to).toLocaleTimeString()}（${res.window.seconds}s）`);
  console.log(`人声 ${res.audio.speechSec}s / 有声 ${res.audio.soundSec}s / 静音 ${res.audio.silentSec}s / 没测到 ${res.audio.nodataSec}s`);
  console.log(`覆盖 ${pct}（人声里被字盖住 ${res.text.coveredSec}s）· 转写 ${res.text.lines} 句 ${res.text.chars} 字 · 落在非人声 ${res.text.offSpeechSec}s`);
  console.log(`像说话没字 ${res.speechButNoText.spans} 段 / ${res.speechButNoText.seconds}s（≥${MIN_SPAN}s 的人声段才算）`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
