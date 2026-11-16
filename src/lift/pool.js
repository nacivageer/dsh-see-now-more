/**
 * lift-pool.js — 黑听抬头（lift）的滚动池：最近 10 分钟的台词与声音事件。
 *
 * 为什么要有它：抬头叫醒模型时，模型看到的是一张**此刻**的画面，而触发它的那句话
 * 可能已经过去十几秒。唤醒文案必须能带上「刚才都听到了什么」，否则模型只能猜。
 * 池子就是这份"刚才"的来源 —— 它只在内存里滚，不落盘（`lift.jsonl` 是 P2 的事）。
 *
 * 三条硬约束（P0 交接文定的）：
 *   1. 只留最近 10 分钟、最多 200 条；超了丢最老的。
 *   2. **纯数据**：无 IO、无 timers、不读时钟。时间一律由 `entry.at` / `entry.wall` 给，
 *      窗口的参照点取"池里最新的那条"，不是 `Date.now()` —— 这样单测完全可重复。
 *   3. `summary()` 是唤醒文案的一部分，300 字是硬上限（按字符算，一个中文一个字）。
 *      字数不够装下整个窗口时**按时间铺开取代表句**（首尾必留），不只会剩最后几十秒；
 *      `summaryDetail()` 同时给「实际覆盖到哪两秒 / 窗口内共几句」，文案不许再谎报十分钟。
 *
 * 条目形状：
 *   { at, wall, kind, text?, acoustic?, src }
 *     at       这条**进池**的毫秒时间戳（调用方时钟）。排序与淘汰用它。
 *     wall     这段声音**实际发生**的毫秒时间戳。ASR 有延迟时 wall 早于 at；
 *              缺省 = at。摘要显示与 `around()` 回取用它（触发词带的是音频时间）。
 *     kind     `speech` / `sound` / `music` / `voice`。
 *     text     只有 `kind === 'speech'` 时有；必须是 ASR **定稿**，不接"还在说…"的快照。
 *     acoustic 声学数字（可选，原样透传，池子不解释它）。
 *     src      来源标签（可选，比如 `listen` / `loop`），只用于排查。
 */

/** 滚动窗口：10 分钟。 */
export const POOL_WINDOW_MS = 10 * 60 * 1000;

/** 条数上限：200 条。正常说话 10 分钟远到不了，纯粹防异常输入把内存吃满。 */
export const POOL_MAX = 200;

/** 唤醒文案摘要的默认上限（字符数）。 */
export const SUMMARY_MAX_CHARS = 300;

/** `around()` 默认取前后各 5 秒 —— 一句话的长度量级。 */
export const AROUND_WINDOW_MS = 5000;

export const LIFT_KINDS = Object.freeze(['speech', 'sound', 'music', 'voice']);

const KIND_SET = new Set(LIFT_KINDS);

const pad2 = (n) => String(n).padStart(2, '0');

/** 毫秒时间戳 → `HH:MM:SS`（本机时区，给唤醒文案读的）。 */
function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 校验并归一化一条输入。返回 null = 这条不该进池。
 *
 * 为什么是"丢掉"而不是"抛错"：池子的写入方是采集/ASR 那条链，一条畸形事件
 * 不该把整个循环弄挂；但也不能悄悄存一个没有时间的条目（排序会错）。
 * 空的 speech（定稿是空串）同样丢掉 —— 那说明这段没听出字，不该占唤醒文案的字数。
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  if (!KIND_SET.has(raw.kind)) return null;

  const wallRaw = Number(raw.wall);
  const wall = Number.isFinite(wallRaw) ? wallRaw : at;

  const text = raw.kind === 'speech' && typeof raw.text === 'string' ? raw.text.trim() : '';
  if (raw.kind === 'speech' && !text) return null;

  return {
    at,
    wall,
    kind: raw.kind,
    text,
    acoustic: raw.acoustic && typeof raw.acoustic === 'object' ? raw.acoustic : null,
    src: typeof raw.src === 'string' && raw.src ? raw.src : null,
  };
}

/**
 * 建一个独立的池子。
 *
 * 单例（本文件底部导出的 `push` / `summary` / `around`）给接线用；要单测或者
 * 同时开两路黑听，就自己 `createLiftPool()`，互不干扰。
 */
export function createLiftPool({ windowMs = POOL_WINDOW_MS, max = POOL_MAX } = {}) {
  const span = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Number(windowMs) : POOL_WINDOW_MS;
  const cap = Number.isInteger(Number(max)) && Number(max) > 0 ? Number(max) : POOL_MAX;

  /** @type {Array<{at:number,wall:number,kind:string,text:string,acoustic:object|null,src:string|null}>} */
  const entries = [];
  /** 池里最新一条的 at：滚动窗口的参照点，避免读时钟。 */
  let newestAt = -Infinity;

  function prune() {
    if (!entries.length) return;
    const floor = newestAt - span;
    const firstAlive = entries.findIndex((e) => e.at >= floor);
    if (firstAlive > 0) entries.splice(0, firstAlive);
    else if (firstAlive === -1) entries.length = 0;
    if (entries.length > cap) entries.splice(0, entries.length - cap);
  }

  /**
   * 记一条。收下返回 true，畸形条目返回 false（不抛）。
   * @param {{at:number, wall?:number, kind:string, text?:string, acoustic?:object, src?:string}} entry
   */
  function push(entry) {
    const norm = normalize(entry);
    if (!norm) return false;
    entries.push(norm);
    // 按 at 稳定排序：ASR 补交的旧条目会插到前面，而不是把窗口搅乱
    entries.sort((a, b) => a.at - b.at);
    if (norm.at > newestAt) newestAt = norm.at;
    prune();
    return true;
  }

  /**
   * 唤醒文案用的摘要：最近一段时间的**台词**，按时间正序，一行一句。
   *
   * - `since` 缺省 = 池子最新时间 − 10 分钟（用 `wall` 判，因为那是"这句话什么时候说的"）。
   * - 全装得下就全留；装不下时按**时间**把有台词的那一段切成若干份，每份取离中点最近的一句，
   *   首尾（窗口里最早/最新的一句）必留，保证 300 字覆盖整段而不是只剩最近几十秒。
   * - `maxChars` 仍是硬上限：代表句拼起来还超，就从中间往两头删；两行都放不下时
   *   只留最新一句并硬截。
   * - 只写台词。纯声音/音乐不在摘要里凑字数（它们的价值在 `around()` 和声学字段里）。
   *
   * @param {{since?:number, maxChars?:number}} [opts]
   * @returns {string}
   */
  function summary(opts) {
    return summaryDetail(opts).text;
  }

  /**
   * 同 `summary()`，但把「这段摘要到底覆盖了什么」一起交出来（唤醒文案要写实际跨度，
   * 不能拿池子的 10 分钟冒充摘要的跨度）。
   *
   * @param {{since?:number, maxChars?:number}} [opts]
   * @returns {{text:string, lines:number, chars:number, from:number|null, to:number|null,
   *            windowFrom:number|null, windowTo:number|null, speech:number}}
   *   `lines` = 摘要里留了几句；`speech` = 窗口内一共几句台词；
   *   `from`/`to` = 留下的第一句/最后一句的时间（墙钟）；`windowFrom`/`windowTo` = 池子窗口。
   */
  function summaryDetail({ since, maxChars = SUMMARY_MAX_CHARS } = {}) {
    prune();
    const limit = Math.floor(Number(maxChars));
    const empty = {
      text: '', lines: 0, chars: 0, from: null, to: null,
      windowFrom: null, windowTo: null, speech: 0,
    };
    if (!Number.isFinite(limit) || limit <= 0) return empty;
    if (!entries.length) return empty;

    const from = Number.isFinite(Number(since)) ? Number(since) : newestAt - span;
    const speech = entries
      .filter((e) => e.kind === 'speech' && e.text && e.wall >= from)
      .sort((a, b) => a.wall - b.wall);
    if (!speech.length) return { ...empty, windowFrom: from, windowTo: newestAt };

    const lineOf = (e) => `${clock(e.wall)} ${e.text}`;
    const costOf = (list) => list.reduce((n, e, i) => n + lineOf(e).length + (i ? 1 : 0), 0);
    let kept = speech;
    if (costOf(speech) > limit) {
      // 目标行数按平均行长估；首尾两句单独占掉两个名额，剩下的才分箱
      const avg = costOf(speech) / speech.length;
      const slots = Math.max(3, Math.floor(limit / Math.max(1, avg)));
      const target = Math.max(1, Math.min(speech.length, slots - 2));
      /**
       * 分箱铺在**有台词的那一段**上，不是整个池子窗口：
       * 窗口前 8 分钟没人说话时，按窗口分箱会把预算浪费在空箱上（实测 80 句挤在
       * 最后 79 秒，只挑出 4 句、83 字）。实际跨度由首尾两句报给文案，不会谎报十分钟。
       */
      const start = speech[0].wall;
      const end = speech[speech.length - 1].wall;
      const width = Math.max(1, end - start);
      const picked = new Map();
      const add = (e) => picked.set(`${e.wall}|${e.text}`, e);
      // 首尾必留：`from`/`to` 报的就是这两句，删了就会谎报跨度
      add(speech[0]);
      add(speech[speech.length - 1]);
      for (let b = 0; b < target; b += 1) {
        const lo = start + (width * b) / target;
        const hi = start + (width * (b + 1)) / target;
        const mid = (lo + hi) / 2;
        let best = null;
        let bestD = Infinity;
        for (const e of speech) {
          if (e.wall < lo) continue;
          if (b === target - 1 ? e.wall > hi : e.wall >= hi) continue;
          const d = Math.abs(e.wall - mid);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (best) add(best);
      }
      kept = [...picked.values()].sort((a, b) => a.wall - b.wall);
      while (costOf(kept) > limit && kept.length > 2) {
        // 从中间删：保住首尾（跨度）和最新一句（上下文）
        kept.splice(Math.floor(kept.length / 2), 1);
      }
      if (costOf(kept) > limit) kept = [speech[speech.length - 1]];
    }

    const text = kept.map(lineOf).join('\n').slice(0, limit);
    return {
      text,
      lines: kept.length,
      chars: text.length,
      from: kept[0].wall,
      to: kept[kept.length - 1].wall,
      windowFrom: from,
      windowTo: newestAt,
      speech: speech.length,
    };
  }

  /**
   * 某个时间点附近的条目（"那句话还在不在缓冲里"）。
   *
   * @param {number} timeMs 音频时间（和 `utterance.startMs` 同一把尺）
   * @param {{windowMs?:number, max?:number}} [opts] 默认前后各 5 秒、最多 20 条
   * @returns {Array<object>} 按时间正序的副本；超上限时留最靠近 timeMs 的
   */
  function around(timeMs, { windowMs: near = AROUND_WINDOW_MS, max: take = 20 } = {}) {
    prune();
    const t = Number(timeMs);
    if (!Number.isFinite(t)) return [];
    const reach = Number.isFinite(Number(near)) && Number(near) >= 0 ? Number(near) : AROUND_WINDOW_MS;
    const limit = Number.isInteger(Number(take)) && Number(take) > 0 ? Number(take) : 20;

    return entries
      .filter((e) => Math.abs(e.wall - t) <= reach)
      .sort((a, b) => Math.abs(a.wall - t) - Math.abs(b.wall - t))
      .slice(0, limit)
      .sort((a, b) => a.wall - b.wall)
      .map((e) => ({ ...e }));
  }

  /** 当前条数（已按窗口/上限裁过）。 */
  function size() {
    prune();
    return entries.length;
  }

  /** 清空（收工时调用；不落盘，所以没有"软清空"这一说）。 */
  function clear() {
    entries.length = 0;
    newestAt = -Infinity;
  }

  return { push, summary, summaryDetail, around, size, clear };
}

/** 插件里共享的那一个池子（接线那一棒直接用导出的函数，不必自己建）。 */
const defaultPool = createLiftPool();

export const push = (entry) => defaultPool.push(entry);
export const summary = (opts) => defaultPool.summary(opts);
export const summaryDetail = (opts) => defaultPool.summaryDetail(opts);
export const around = (timeMs, opts) => defaultPool.around(timeMs, opts);
export const size = () => defaultPool.size();
export const clear = () => defaultPool.clear();
