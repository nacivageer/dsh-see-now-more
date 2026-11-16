#!/usr/bin/env node
/**
 * coverage.mjs — 覆盖率账的两个口径，一个脚本看。
 *
 * ## 两个口径不要混
 *
 * - **主口径**（status 与 `--ledger` 用）：`coverageOf()` —— 出字秒数 / 送进 ASR 的语音秒数。
 * - **诊断口径**（不加参数时）：`computeCoverage()` —— 按中频占比判「人声」，BGM 和对话
 *   混在一起时会把真对话判成「有声」（实测对话帧均值 0.27–0.44 < 0.6），
 *   **不适合当覆盖率报给人看**，只用来解释「这段声音是什么构成」。
 *
 * ## 用途
 *
 *   node scripts/coverage.mjs --ledger            # 今天的按分钟账 + 与 lift 对齐
 *   node scripts/coverage.mjs --ledger --minutes 30   # 只看台账末尾 30 分钟
 *   node scripts/coverage.mjs --ledger --json     # 机器可读
 *   node scripts/coverage.mjs                     # 声学滚动窗全段（诊断）
 *   node scripts/coverage.mjs --minutes 3         # 诊断口径的最近 3 分钟
 *   node scripts/coverage.mjs --from … --to …     # 诊断口径的指定窗口
 *
 * `--ledger` 读 `$DSH_HOME/see-now/coverage/<本地日期>.jsonl`（一行一段、按分钟求和），
 * 并读 `$DSH_HOME/see-now/lift/<本地日期>/log.jsonl` 对齐：
 * 同一分钟「有字却没抬」= 漏抬候选，「抬了但那分钟没出字」= 误抬候选。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  computeCoverage, kindsOf, spansOf, MIN_SPAN, SPEECH_MID,
} from '../src/coverage.js';
import {
  alignLift, ledgerFile, minuteKey, readLedger, sumByMinute,
} from '../src/coverage-ledger.js';
import { readDay } from '../src/lift/log.js';

const HOP_DEFAULT = 0.5;   // 秒；acoustic.json 里有 hop 就用它

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function readLines(p) {
  if (!existsSync(p)) return [];
  const out = [];
  // 记事本/PowerShell 写出来的文件可能带 BOM；第一行别因此被当成坏行
  for (const raw of readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch { /* 半行忽略 */ }
  }
  return out;
}

const hm = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** 按 `size` 分钟分块（只在有账的块上输出）。 */
function blocksOf(minutes, size = 5) {
  const map = new Map();
  for (const m of minutes) {
    const [h, mm] = m.minute.split(':').map(Number);
    const at = h * 60 + mm;
    const key = Math.floor(at / size) * size;
    const acc = map.get(key) ?? {
      from: key, to: key + size - 1, sentSec: 0, speechSec: 0, textSec: 0, emptySegs: 0, segs: 0,
    };
    acc.sentSec += m.sentSec;
    acc.speechSec += m.speechSec;
    acc.textSec += m.textSec;
    acc.emptySegs += m.emptySegs;
    acc.segs += m.segs;
    map.set(key, acc);
  }
  return [...map.values()].sort((a, b) => a.from - b.from);
}

function totalOf(minutes) {
  const t = { sentSec: 0, speechSec: 0, textSec: 0, emptySegs: 0, segs: 0 };
  for (const m of minutes) {
    t.sentSec += m.sentSec;
    t.speechSec += m.speechSec;
    t.textSec += m.textSec;
    t.emptySegs += m.emptySegs;
    t.segs += m.segs;
  }
  t.ratio = t.speechSec >= 1 ? Math.round((100 * t.textSec) / t.speechSec) : null;
  return t;
}

/**
 * 台账模式（主口径）。读盘失败/没账都返回 2，错误信息说清"要看什么"。
 */
function ledgerReport({ home, env, day, lastN, asJson }) {
  const file = ledgerFile(day, env);
  const rows = readLedger(day, { env });
  if (!rows.length) {
    console.error(`没有台账：${file}`);
    console.error('（新版插件装好、重启、听过一段之后才会有；也可以用 --date 指定日期）');
    return 2;
  }
  let minutes = sumByMinute(rows);
  if (lastN > 0 && minutes.length > lastN) minutes = minutes.slice(-lastN);

  const lifts = readDay(day, { env });
  const align = alignLift(minutes, lifts);
  const total = totalOf(minutes);

  if (asJson) {
    console.log(JSON.stringify({
      day,
      ledger: file,
      minutes,
      total,
      lift: {
        file: join(home, 'see-now', 'lift', day, 'log.jsonl'),
        totals: align.totals,
        missing: align.missing.map((m) => ({ minute: m.minute, speechSec: m.speechSec, textSec: m.textSec, segs: m.segs })),
        falseAlarm: align.falseAlarm.map((m) => ({ minute: m.minute, lifts: m.lifts, levels: m.levels })),
      },
    }, null, 1));
    return 0;
  }

  console.log(`账 ${day} · ${file}${lastN > 0 ? ` · 末尾 ${minutes.length} 分钟` : ''}`);
  for (const b of blocksOf(minutes)) {
    const pct = b.speechSec >= 1 ? `${Math.round((100 * b.textSec) / b.speechSec)}%` : '—';
    console.log(`${hm(b.from)}–${hm(b.to)}  语音 ${b.speechSec.toFixed(1)}s · 出字 ${b.textSec.toFixed(1)}s`
      + ` · 覆盖 ${pct} · 段 ${b.segs} · 像说话没字 ${b.emptySegs}`);
  }
  console.log(`合计：语音 ${total.speechSec.toFixed(1)}s · 出字 ${total.textSec.toFixed(1)}s`
    + ` · 覆盖 ${total.ratio == null ? '—' : `${total.ratio}%`} · 段 ${total.segs}`
    + ` · 像说话没字 ${total.emptySegs}`);
  if (total.speechSec === 0 && total.segs > 0) {
    // 0 秒语音不是"账坏了"：转写器的 VAD 明确说这些段里没人说话（纯 BGM / 环境音）。
    // 这正是最容易被误读成"听不见"的一种状态，单独说一句。
    console.log('（这一段里转写器的 VAD 判所有段都没人说话；不是没回传，也不是账坏了）');
  }

  if (!align.totals.lift) {
    console.log(`抬升：今天没有 lift 记录（${join(home, 'see-now', 'lift', day, 'log.jsonl')}）`);
    return 0;
  }

  console.log(`抬升：${align.totals.lift} 次（叫醒 ${align.totals.spoke}）`
    + ` · 漏抬候选 ${align.totals.missing} 分钟 · 误抬候选 ${align.totals.falseAlarm} 分钟`
    + (align.totals.unmatched ? ` · 没对上分钟的 ${align.totals.unmatched} 次（窗口外或台账里没有，不计误抬）` : ''));

  if (align.missing.length) {
    const byMinute = new Map();
    for (const l of readLines(join(home, 'see-now', 'transcript', `${day}.jsonl`))) {
      const k = minuteKey(Number(l.t0));
      if (!byMinute.has(k)) byMinute.set(k, []);
      byMinute.get(k).push(l.text);
    }
    for (const m of align.missing.slice(-20)) {
      const preview = (byMinute.get(m.minute) ?? []).join(' / ').slice(0, 24);
      console.log(`  漏抬 ${m.minute}  语音 ${m.speechSec.toFixed(1)}s/出字 ${m.textSec.toFixed(1)}s`
        + `  ← ${preview || '（台词文件里没有这一分钟）'}`);
    }
    if (align.missing.length > 20) console.log(`  …… 还有 ${align.missing.length - 20} 分钟`);
  }
  for (const m of align.falseAlarm.slice(-20)) {
    console.log(`  误抬 ${m.minute}  抬 ${m.lifts} 次（${m.levels.join('/') || '—'}），这一分钟没出字`);
  }
  if (align.falseAlarm.length > 20) console.log(`  …… 还有 ${align.falseAlarm.length - 20} 分钟`);
  return 0;
}

function main() {
  const i = (name, fb = null) => {
    const k = process.argv.indexOf(`--${name}`);
    return k >= 0 && process.argv[k + 1] ? process.argv[k + 1] : fb;
  };
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  // **本地日期，不是 UTC**：`toISOString()` 在北京时间凌晨会给出「昨天」，
  // 于是读不到当天的 transcript、账面上变成 lines: 0（2026-11-17 03:4x 实测）。
  const today = i('date', new Date().toLocaleDateString('sv-SE'));
  const env = { ...process.env, DSH_HOME: home };

  if (process.argv.includes('--ledger')) {
    return ledgerReport({
      home, env, day: today, lastN: Math.max(0, Math.floor(Number(i('minutes', 0)) || 0)),
      asJson: process.argv.includes('--json'),
    });
  }

  const dir = i('audio', join(home, 'see-now', 'audio'));
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
  if (process.argv.includes('--spans')) {
    // 诊断用：把每段声音和人声旁边的字摊开，看「没盖住」是因为没人声还是错位
    const lines = readLines(transcriptPath)
      .filter((l) => Number(l.t1) >= res.window.from && Number(l.t0) <= res.window.to)
      .sort((a, b) => a.t0 - b.t0);
    const hopMs2 = (Number(acoustic.hop) || HOP_DEFAULT) * 1000;
    const i0 = Math.max(0, Math.ceil((res.window.from - Number(acoustic.from)) / hopMs2));
    const i1 = Math.min(acoustic.frames.length - 1, Math.floor((res.window.to - Number(acoustic.from)) / hopMs2));
    const sp = spansOf(kindsOf(acoustic.frames, Number(acoustic.hop) || HOP_DEFAULT), Number(acoustic.from), hopMs2, i0, i1);
    const t = (ms) => new Date(ms).toLocaleTimeString();
    for (const s of sp) {
      if (s.kind === 'silent') continue;
      const hit = lines.filter((l) => Number(l.t1) > s.from && Number(l.t0) < s.to);
      console.log(`${t(s.from)}–${t(s.to)} ${s.kind.padEnd(7)} ${((s.to - s.from) / 1000).toFixed(1)}s`
        + (hit.length ? `  ← 字：${hit.map((l) => l.text.slice(0, 14)).join(' / ')}` : ''));
    }
    for (const l of lines) console.log(`字 ${t(Number(l.t0))}–${t(Number(l.t1))} ${l.text.slice(0, 30)}`);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 1));
    return 0;
  }
  const pct = res.coverage == null ? '—' : `${res.coverage}%`;
  console.log(`窗口 ${new Date(res.window.from).toLocaleTimeString()}–${new Date(res.window.to).toLocaleTimeString()}（${res.window.seconds}s）`);
  console.log(`人声 ${res.audio.speechSec}s / 有声 ${res.audio.soundSec}s / 静音 ${res.audio.silentSec}s / 没测到 ${res.audio.nodataSec}s`);
  console.log(`覆盖 ${pct}（人声里被字盖住 ${res.text.coveredSec}s）· 转写 ${res.text.lines} 句 ${res.text.chars} 字 · 落在非人声 ${res.text.offSpeechSec}s`);
  console.log(`像说话没字 ${res.speechButNoText.spans} 段 / ${res.speechButNoText.seconds}s（≥${MIN_SPAN}s 的人声段才算，中频阈值 ${SPEECH_MID}）`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
