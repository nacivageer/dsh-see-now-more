#!/usr/bin/env node
/**
 * coverage.mjs — 覆盖率账的**命令行出口**（逻辑在 `src/coverage.js`，与 status 共用一份）。
 *
 * 用途：不开 DSH、不接 status 也能算一本账；诊断时能看完整字段（status 那行只有三个数）。
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

import { computeCoverage, MIN_SPAN, SPEECH_MID } from '../src/coverage.js';

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
  console.log(`像说话没字 ${res.speechButNoText.spans} 段 / ${res.speechButNoText.seconds}s（≥${MIN_SPAN}s 的人声段才算，中频阈值 ${SPEECH_MID}）`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
