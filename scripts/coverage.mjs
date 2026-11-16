#!/usr/bin/env node
/**
 * coverage.mjs — **诊断口径**的覆盖率：按声学指纹把人声/有声/静音分开看声音构成。
 *
 * 注意两个口径不要混：
 *   - status 那行用的是 `coverageOf()`：**出字秒数 / 送进 ASR 的语音秒数**（主口径）；
 *   - 这个脚本用的是 `computeCoverage()`：按中频占比判「人声」，BGM 和对话混在一起时
 *     会把真对话判成「有声」（实测对话帧均值 0.27–0.44 < 0.6），所以它**不适合**当
 *     覆盖率报给人看，只用来解释「这段声音是什么构成」。
 *
 * 用途：不开 DSH 也能看声音构成；诊断时能看完整字段。
 *
 * 用法：
 *   node scripts/coverage.mjs                        # 声学滚动窗全段
 *   node scripts/coverage.mjs --minutes 3
 *   node scripts/coverage.mjs --from 1794854000000 --to 1794854800000
 *   node scripts/coverage.mjs --json                 # 机器可读
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { computeCoverage, kindsOf, spansOf, MIN_SPAN, SPEECH_MID } from '../src/coverage.js';

const HOP_DEFAULT = 0.5;   // 秒；acoustic.json 里有 hop 就用它

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

function main() {
  const i = (name, fb = null) => {
    const k = process.argv.indexOf(`--${name}`);
    return k >= 0 && process.argv[k + 1] ? process.argv[k + 1] : fb;
  };
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const dir = i('audio', join(home, 'see-now', 'audio'));
  // **本地日期，不是 UTC**：`toISOString()` 在北京时间凌晨会给出「昨天」，
  // 于是读不到当天的 transcript、账面上变成 lines: 0（2026-11-17 03:4x 实测）。
  const today = i('date', new Date().toLocaleDateString('sv-SE'));
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
    const hopMs = (Number(acoustic.hop) || HOP_DEFAULT) * 1000;
    const i0 = Math.max(0, Math.ceil((res.window.from - Number(acoustic.from)) / hopMs));
    const i1 = Math.min(acoustic.frames.length - 1, Math.floor((res.window.to - Number(acoustic.from)) / hopMs));
    const sp = spansOf(kindsOf(acoustic.frames, Number(acoustic.hop) || HOP_DEFAULT), Number(acoustic.from), hopMs, i0, i1);
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


