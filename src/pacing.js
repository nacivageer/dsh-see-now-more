/**
 * pacing.js — 「上一句说了多长，下一句就隔多久」。
 *
 * 来自 2603.02655 的做法：下一次开口的时机由**上一句的估计时长**决定，而不是一个写死的常数。
 * 在 see-now 里，"开口"落在两层上：
 *   1. 叫醒模型（`wake`）—— 它被叫醒才会 `peek` 看图、才会 `say`；
 *   2. 真正出声（`spoken` 事件）—— 适配器开始播放的那一瞬。
 * 所以节奏要卡在**第 1 层**：上一句还在说 / 刚说完，就别急着叫下一轮。
 *
 * 为什么用文本估时长而不是问引擎要音频时长：
 * 声音是可插拔的适配器，核心拿不到统一接口；而中文按 5 字/秒、英文按 14 字/秒估，
 * 误差在 ±20% 以内，对"别抢话"这个目的足够。真去要时长反而会把核心和某个引擎绑死。
 */

/** 中文（含日文假名/韩文）每字时长。5.3 字/秒，接近日常解说语速。 */
export const SPEECH_MS_PER_CJK = 190;
/** 其它字符（英文/数字/标点）每字时长。约 14 字/秒。 */
export const SPEECH_MS_PER_OTHER = 70;
/** 开头那一下的固定开销（引擎起播、气口）。 */
export const SPEECH_LEAD_MS = 300;
/** 说完之后再留一点气口，别紧接着下一句。 */
export const SPEECH_TAIL_MS = 800;
/** 估到 20 秒就封顶：再长的多半是模型失控，不该把循环卡死半分钟。 */
export const SPEECH_MS_MAX = 20_000;
/** 少于这个就当没说话（"嗯。"这种）。 */
export const SPEECH_MS_MIN = 500;
/**
 * 跟随模式下，两次叫醒之间至少隔这么久。
 *
 * 上一句只有 2 秒时，`说完 + 0.8s` 会让下一轮在 3 秒内又被叫起来 —— 那是"连珠炮"，
 * 不是陪看。3 秒是"一口气换得过来"的下限；比旧节奏（normal 15s）密，但不会失控。
 */
export const SPEECH_FOLLOW_FLOOR_MS = 3000;

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const SPACE = /\s/;

/**
 * 按文本估一句要念多久（毫秒）。空文本返回 0，表示"这句不算数"。
 *
 * @param {string} text
 * @returns {number} 0 或 [SPEECH_MS_MIN, SPEECH_MS_MAX]
 */
export function estimateSpeechMs(text) {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK.test(ch)) cjk += 1;
    else if (SPACE.test(ch)) other += 0.3;
    else other += 1;
  }
  const raw = SPEECH_LEAD_MS + cjk * SPEECH_MS_PER_CJK + other * SPEECH_MS_PER_OTHER;
  return Math.round(Math.min(SPEECH_MS_MAX, Math.max(SPEECH_MS_MIN, raw)));
}

/**
 * 下一次**主动**叫醒最早能落在什么时刻（毫秒时间戳）。
 *
 * 三种口径（`~/.dsh/see-now.json` 的 `speechPacing`）：
 *   - `follow`（默认，对应 2603.02655 的做法）：上一次说完 + 气口。上一句短，
 *     下一轮就早；上一句长，就往后顺延。**不再是"从叫醒那一刻起算的固定间隔"**。
 *     仍然有 3 秒地板，防止连珠炮。
 *   - `guard`：旧间隔与"说完 + 气口"取更晚的那个 —— 只在上一句特别长时推迟，
 *     绝不比原来的节奏更密（不想变吵就用这个）。
 *   - `off`：纯旧行为，`lastWakeAt + minGapMs`。
 *
 * 没说过话（没有 `speechAt`）时，一律退回旧行为。
 *
 * @param {{lastWakeAt?:number, minGapMs?:number, speechAt?:number, speechMs?:number,
 *          tailMs?:number, mode?:'follow'|'guard'|'off', floorMs?:number}} o
 * @returns {number} 绝对时间戳；0 表示没有约束
 */
export function nextProactiveAt({
  lastWakeAt = 0, minGapMs = 0, speechAt = 0, speechMs = 0,
  tailMs = SPEECH_TAIL_MS, mode = 'follow', floorMs = SPEECH_FOLLOW_FLOOR_MS,
} = {}) {
  const wake = Number(lastWakeAt) > 0 ? Number(lastWakeAt) : 0;
  const base = wake + Math.max(0, Number(minGapMs) || 0);
  const said = Number(speechAt) > 0;
  if (!said || mode === 'off') return base;
  const afterSpeech = Number(speechAt) + Math.max(0, Number(speechMs) || 0) + Math.max(0, tailMs);
  if (mode === 'guard') return Math.max(base, afterSpeech);
  // follow：上一句说完 + 气口，但不早于上一次叫醒后 3 秒
  return Math.max(wake + Math.max(0, floorMs), afterSpeech);
}
