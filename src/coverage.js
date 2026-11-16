/**
 * coverage.js — 覆盖率账：**人声时间里，有多少真的被转写盖住了**。
 *
 * 为什么要有它：以前只能报「累计 N 句」「帧数」「最后帧多久前」，报不出
 * 「这段到底听清了多少」。没有这本账，一段血条录像里「规则没触发」和
 * 「那一刻根本没听见」分不开——漏抬/误抬那三个数就算不出来。
 *
 * 口径（全部来自已有文件，不新增采集）：
 *   - 人声（speech）：`acoustic.json` 每格中频占比 ≥0.6（与 audioTrajectory 同一个 kindOf）
 *   - 有声（sound）：有声音但不以中频为主（音乐/音效）
 *   - 没测到（nodata）：那一格 loopback 没推数据
 *   - 有字：台词行 [t0,t1] 与时间窗的相交部分（先并区间再算，避免重复计数）
 *   - **覆盖率 = 有字时长 ∩ 人声时长 / 人声时长**
 *   - 像说话没字：≥1.2 秒的人声段里一个字都没落上
 *
 * 已知边界：`acoustic.json` 是**约 90 秒的滚动窗**，所以这本账只覆盖最近这段；
 * 算十分钟池子得先把声学格按分钟落盘（未做）。
 */

const HOP_DEFAULT = 0.5;          // 秒；acoustic.json 里有 hop 就用它
export const MIN_SPAN = 1.2;      // 秒；短于此的人声段不要求有字
export const SPEECH_MID = 0.6;    // 中频占比阈值，与 listen.js 的 audioTrajectory 同一口径

/** 一帧的中频占比（占 0–8k 全谱的比例，按三频带重新归一） */
export function midOf(r) {
  if (!r) return NaN;
  const lo = r[4], midRaw = r[5], hi = r[6];
  const sum = lo + midRaw + hi;
  return sum > 0.05 ? midRaw / sum : midRaw;
}

/** 帧 → 每格类别（单帧，不平滑；测单帧行为用它） */
export function kindOf(r) {
  if (!r) return 'nodata';
  if (Number(r[0]) <= -100) return 'silent';
  return midOf(r) >= SPEECH_MID ? 'speech' : 'sound';
}

/**
 * 帧 → 每格类别（**平滑后**，账要用这一版）。
 *
 * 为什么必须平滑：acoustic.json 是 ~50ms 一格，中频占比会逐帧在阈值上下跳，
 * 一段连续人声会被切成 0.1 秒的碎片 —— 实测「人声 15s」其实由几十个 0.1s 段拼成，
 * 覆盖率被算成 9%，而同一段音频在 listen.js 的 audioTrajectory 里是连着的。
 *
 * 用 ±0.5 秒的**均值**而不是中位数：中位数在「逐帧交替」这种抖动上会按奇偶翻面
 * （21 个样本 11:10 时，中间那个值每帧都变），实测只能修好一半；均值是连续的，
 * 而且中频占比本身是比例、取平均有意义。边界仍保持 50ms 精度。
 */
export function kindsOf(frames, hop) {
  const step = Number(hop) || HOP_DEFAULT;
  const win = Math.max(1, Math.round(0.5 / step));
  const mids = frames.map((r) => (r ? midOf(r) : NaN));
  const out = [];
  for (let i = 0; i < frames.length; i += 1) {
    const r = frames[i];
    if (!r) { out.push('nodata'); continue; }
    if (Number(r[0]) <= -100) { out.push('silent'); continue; }
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(frames.length - 1, i + win); j += 1) {
      if (Number.isFinite(mids[j])) { sum += mids[j]; n += 1; }
    }
    const avg = n ? sum / n : midOf(r);
    out.push(avg >= SPEECH_MID ? 'speech' : 'sound');
  }
  return out;
}

/** 把相邻同类帧并成段：[{kind, from, to}]（ms） */
export function spansOf(kinds, base, hopMs, i0, i1) {
  const out = [];
  let cur = null;
  for (let i = i0; i <= i1; i += 1) {
    const kind = kinds[i] ?? 'nodata';
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
 * @returns {null | {window:object, audio:object, text:object, coverage:number|null, speechButNoText:object}}
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

  const sp = spansOf(kindsOf(acoustic.frames, hop), base, hopMs, i0, i1);
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
