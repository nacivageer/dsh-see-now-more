/**
 * lift/index.js — 黑听抬头的编排（从 `loop.js` 的 `startLoop` 闭包里搬出来）。
 *
 * 只做「扫台词 → 判档 → 取帧 / 记账 / 叫醒 → 回落」这一段编排。它不碰采集、
 * 不碰窗口、不落盘、不起进程；所有外部动作都走端口（`senses` / `sinks` / `gate`），
 * 所以时间线测试用假时钟、假端口就能跑，不需要 DSH、ffmpeg、python 或窗口。
 *
 * ## 端口
 *
 * - `senses`：`recentLines(from, to)` / `frameAt(t0)` / `framePng(t0)` / `still()` /
 *   `turnEndAt()` / `lastUserSpokeAt()`
 * - `sinks`：`record(rec)` / `debug(text)` / `glance(text)` / `wake(text)` / `hint()` / `log(text)`
 * - `gate`：`canWake(now)` / `noteWake(now)` / `noteNoAnswer()`
 *
 * **退避线不归本模块**：`lastAudioWakeAt` / `unansweredListenWakes` 和 `maybeWakeFromAudio`
 * 共用，必须由 `startLoop` 持有并通过 `gate` 注入 —— 各开一条的话，同一拍能连着叫两次。
 *
 * ## 边界
 *
 * 不 import `loop.js` / `index.js` / `runner.js` / `window.js` / `client.js`，
 * 不读 `DSH_HOME`（`test/lift-seam.test.mjs` 守着）。
 */

import { createLiftPool } from './pool.js';
import { matchLiftTriggers } from './triggers.js';
import { decideLevel, shouldFallback } from './levels.js';

/**
 * 台词扫描窗口往回多留多久。
 *
 * ASR 是异步的：一句在 t1 结束，转写完成可能已经过了一两拍。只看 [上一拍, 现在]
 * 会把"迟到的定稿"漏掉 —— 漏掉的正是那句「你看这个」。重叠部分靠 t0 去重，
 * 不会让同一句进池两次、也不会重复报同一次抬头。
 */
const LIFT_SCAN_OVERLAP_MS = 10_000;

/**
 * 「活跃对话」的窗口（P2-B）：最近 5 分钟内用户说过话、或模型回合结束过，
 * 强命中就从「瞥」升成「看」。这是机制文档给的数，不是拍的。
 */
const LIFT_ACTIVE_MS = 5 * 60 * 1000;

/** 蓄水池窗口：5 分钟内的警觉次数（≥3 升一次瞥）。 */
const LIFT_POOL_WINDOW_MS = 5 * 60 * 1000;

/** `holdSec` 缺省 / 配错时用这个（机制文档定 15 秒）。 */
const LIFT_HOLD_DEFAULT_SEC = 15;

const noop = () => {};
const never = async () => false;

/**
 * 建一个 lift 编排实例。每个常驻循环一个，`stopLoop` 时应调 `reset()`。
 *
 * @param {{
 *   config?: { enabled?: boolean, level?: string, holdSec?: number },
 *   now?: () => number,
 *   senses?: object, sinks?: object, gate?: object,
 * }} [ports]
 */
export function createLift({ config = {}, now = () => Date.now(), senses = {}, sinks = {}, gate = {} } = {}) {
  const log = sinks.log ?? noop;
  const record = sinks.record ?? noop;
  const debug = sinks.debug ?? noop;
  const glance = sinks.glance ?? noop;
  const wake = sinks.wake ?? never;
  const hint = sinks.hint ?? (() => '');
  const canWake = gate.canWake ?? (() => true);
  const noteWake = gate.noteWake ?? noop;
  const noteNoAnswer = gate.noteNoAnswer ?? noop;

  /** 仅监听时的警觉池（10 分钟台词）。**每个循环一个**，不与其他会话共用。 */
  let liftPool = createLiftPool();
  /** 上次扫台词的时间：扫描窗口从它往回多留 `LIFT_SCAN_OVERLAP_MS`。 */
  let lastLiftScanAt = now();
  /** 已经进过池的台词 `t0`（重叠扫描时防重放；只留最近一批）。 */
  const liftPushedT0 = new Set();
  /** 上一轮报过的抬头 hits：跨拍/跨窗口去重（`matchLiftTriggers` 的 `seen`）。 */
  let liftSeen = [];
  /** 最近一次有台词（音频时间，`wall`）的时刻；`holdSec` 的起算点之一。 */
  let lastLiftVoiceAt = 0;
  /** 最近 5 分钟的警觉时刻（蓄水池）：`Date.now()` 的数组，升过一次瞥就清空。 */
  let liftAlarmTimes = [];
  /** 当前抬头档位：`'look'` = 抬头看着（在 `holdSec` 里）；`null` = 没抬头。 */
  let liftLevelNow = null;
  /** 这一次抬头的起点：`holdSec` 的兜底下限（防一条老台词把计时拉回去）。 */
  let liftHoldFrom = 0;

  /** 模型上一回合结束的时刻（取不到就是 0）。活跃对话判定用。 */
  function liftTurnEndAt() {
    try {
      return Number(senses.turnEndAt?.()) || 0;
    } catch {
      return 0;
    }
  }

  /** 用户最后一次真的说话的时刻（取不到就是 0）。 */
  function lastUserSpokeAt() {
    try {
      return Number(senses.lastUserSpokeAt?.()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 「最近 5 分钟有活跃对话」：用户说过话 **或** 模型回合结束过，取更晚的那个。
   *
   * 只有它为真，强命中才从「瞥」升成「看」—— 这是"人在旁边"与"人已经走了"的分界。
   */
  function liftDialogActive(at) {
    const latest = Math.max(lastUserSpokeAt(), liftTurnEndAt());
    return latest > 0 && at - latest <= LIFT_ACTIVE_MS;
  }

  /**
   * 抬头之后的自动回落（P2-B）：`holdSec` 到点 **且画面不动** → 回「警觉」。
   *
   * 起算点是「最后一次语音/对话结束」而不是抬头那一刻，所以一直有人在说话、
   * 画面一直在动的时候永远不回。判据在 `shouldFallback()`（纯函数，单测过）。
   */
  function maybeFallBackFromLift(at) {
    if (liftLevelNow !== 'look') return;
    const raw = Number(config.holdSec);
    const holdSec = Number.isFinite(raw) && raw >= 0 ? raw : LIFT_HOLD_DEFAULT_SEC;
    let still = null;
    try { still = senses.still?.() ?? null; } catch { still = null; }
    const since = Math.max(lastLiftVoiceAt, lastUserSpokeAt(), liftTurnEndAt(), liftHoldFrom);
    if (!shouldFallback({ holding: true, now: at, since, holdSec, still })) return;

    liftLevelNow = null;
    liftHoldFrom = 0;
    record({
      at, wall: since, level: 'alarm', trigger: 'hold', text: '', frameAt: null,
      spoke: false, reason: `安静 ${holdSec}s 且画面不动，回落`,
    });
    log(`[lift] 回落：安静 ${holdSec}s 且画面不动`);
  }

  /**
   * 台词触发：定稿台词进池 → **判档** → 按档做事（P2-B 的四档）。
   *
   * 判档在 `lift-levels.js`（纯函数，穷举测过）；这里只负责把判档要的"上下文"凑出来：
   * 最近 5 分钟有没有活跃对话、5 分钟内警觉了几次、现在是不是已经抬着头。
   *
   * 四档各自的产物：
   *   - 警觉：`lift.jsonl` 一行；不取帧、不叫醒、不进窗
   *   - 瞥：取一帧 → PNG 落盘 + 窗内一行 meta + `lift.jsonl`；**不叫醒**
   *   - 看：叫醒（文案带时间码 / 台词 / 摘要 / 取帧入口）；`lift.jsonl` 记 `spoke:true`
   *   - 追：插件不做（模型自己调 `watch`）
   *
   * 和 `maybeWakeFromAudio` 的分工：那条负责"声音形状变了"，这条负责"话里在叫人"。
   * 台词更具体，所以这一拍先判它；**两条共用同一条 `listenGap` 退避线**（由 `gate` 注入）。
   *
   * 只认定稿（`partial === false`）：快照是"还在说"的中间版本，先报一次、定稿再报一次，
   * 等于同一句话抬头两回。
   */
  async function tick() {
    if (config.enabled === false) return;

    const at = now();
    const lines = senses.recentLines?.(lastLiftScanAt - LIFT_SCAN_OVERLAP_MS, at) ?? [];
    lastLiftScanAt = at;

    const finals = lines
      .filter((l) => l && l.partial === false && typeof l.text === 'string' && l.text.trim())
      .sort((a, b) => Number(a.t0) - Number(b.t0));
    const fresh = finals.filter((l) => !liftPushedT0.has(l.t0));

    for (const line of fresh) {
      liftPushedT0.add(line.t0);
      liftPool.push({
        at,
        wall: Number(line.t0),
        kind: 'speech',
        text: line.text.trim(),
        src: 'listen',
      });
    }
    // 重叠扫描只需要挡住"最近这几拍的重放"，不必留整场
    while (liftPushedT0.size > 200) liftPushedT0.delete(liftPushedT0.values().next().value);

    // 有台词 = 有人在说话：`holdSec` 的计时从头算（哪怕这一拍没有新命中）
    if (fresh.length) {
      lastLiftVoiceAt = Math.max(lastLiftVoiceAt, Number(fresh[fresh.length - 1].t0) || 0, at);
    }

    // 回落**每拍都判**：静音之后的那几拍才正是该回的时候
    maybeFallBackFromLift(at);

    /**
     * 有台词的那几拍落一行扫描账（P2-B 的常驻诊断，2026-11-10 实测要的）。
     *
     * 「钟在敲但什么都没记」在打包后的 Desktop 里没法复现也没法查：心跳只证明钟在敲，
     * 分不清是 ASR 没出整句（`lines=0`）、整句被过滤（`finals=0`）、还是扫描窗口没吃到
     * （`fresh=0`）。这几行只在窗口里有台词时写，正常一小时几十行。
     */
    if (lines.length) {
      debug(`lift-scan lines=${lines.length} finals=${finals.length} fresh=${fresh.length}`);
    }
    if (!fresh.length) return;

    const { hits } = matchLiftTriggers(
      fresh.map((l) => ({ text: l.text.trim(), startMs: Number(l.t0), endMs: Number(l.t1) })),
      { seen: liftSeen },
    );
    if (!hits.length) {
      /**
       * 有整句、却没命中：把**这两句的前 40 字**写进 `debug.log`（2026-11-11 拍板要的）。
       *
       * 没有它，「有 fresh 但没记录」永远分不清是**转写错了**还是**词表漏了** ——
       * 2026-11-10 晚就卡在这里：同一句「你看这个」转写有时是「你看这个。」、有时
       * 干脆没有强触发词，而日志只剩一个 `fresh=1`。
       *
       * 代价要明说：`debug.log` 从此会留下**没命中**的台词片段（命中句本来就进
       * `lift.jsonl`）。只写这一种情况、只写 40 字、只在有整句时写。
       */
      const sample = fresh.slice(-2)
        .map((l) => String(l.text).replace(/\s+/g, ' ').trim().slice(0, 40))
        .join(' / ');
      debug(`lift-miss fresh=${fresh.length} text=${sample}`);
      return;
    }
    liftSeen = [...hits, ...liftSeen].slice(0, 8);

    const t0 = Number(hits[0].startMs);
    const strong = hits.some((h) => h.level === 'glance');
    /** 之前的警觉次数（不含这一批）。 */
    const priorAlarms = liftAlarmTimes.filter((t) => at - t <= LIFT_POOL_WINDOW_MS).length;

    const decision = decideLevel({
      hits,
      baseLevel: config.level ?? 'glance',
      active: liftDialogActive(at),
      alarmsIn5min: priorAlarms + (strong ? 0 : 1),
    });

    // 蓄水池记账：这一批是警觉就记一笔；升过一次瞥就清空重攒
    if (decision.level === 'alarm') liftAlarmTimes.push(at);
    else if (decision.why === 'pool') liftAlarmTimes.length = 0;
    liftAlarmTimes = liftAlarmTimes.filter((t) => at - t <= LIFT_POOL_WINDOW_MS);

    // 已经抬着头（看之后还在 holdSec 里）：不重复叫，也不再记一条
    if (liftLevelNow === 'look') {
      log(`[lift] 命中「${hits[0].text}」，但已经在抬头看着，不重复叫`);
      return;
    }

    const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

    if (decision.level === 'alarm') {
      record({
        at, wall: t0, level: 'alarm', trigger: strong ? 'word' : 'weak', text: hits[0].text,
        frameAt: null, spoke: false, reason: decision.reason,
      });
      log(`[lift] 警觉：${hits[0].text}（${decision.reason}）`);
      return;
    }

    // 瞥 / 看都要那一刻的帧；取不到就明说「没了」，绝不拿现在顶
    const png = senses.framePng?.(t0) ?? { ok: false, reason: 'no-frame' };
    const frameNote = png.ok
      ? (png.degraded === 'archive-low-res' ? '（30 秒缓冲已滑走，用的是 10 分钟低清留底）' : '')
      : `（帧没取到：${png.reason}）`;

    if (decision.level === 'glance') {
      record({
        at, wall: t0, level: 'glance', trigger: decision.why === 'pool' ? 'pool' : 'word',
        text: hits[0].text, frameAt: png.ok ? png.at : null, spoke: false,
        reason: `${decision.reason}${frameNote}`,
      });
      glance(
        `👀 ${clock(t0)} 听到「${hits[0].text}」，瞥了一眼${png.ok ? '' : '（那一刻的画面已滑走）'}`,
      );
      log(`[lift] 瞥：${hits[0].text}（${decision.reason}）`
        + (png.ok ? `，帧 ${png.path}` : `，帧没取到（${png.reason}）`));
      return;
    }

    // 看：叫醒。被退避挡掉的这一拍**不**记"叫了没人理"
    if (!canWake(at)) return;
    noteWake(at);

    record({
      at, wall: t0, level: 'look', trigger: 'dialog', text: hits[0].text,
      frameAt: png.ok ? png.at : null, spoke: true, reason: `${decision.reason}${frameNote}`,
    });

    const frameLine = png.ok
      ? `那一刻的画面：\`see_now({action:"lift", since:${t0}})\``
        + `（帧时间 ${clock(png.at)}，与台词差 ${png.deltaMs} ms）`
      : '那一刻的画面：**没了** —— 比 30 秒缓冲还早。只能按文字判断，别拿现在顶。';
    const summary = liftPool.summaryDetail();
    /**
     * 文案里写的是**摘要实际覆盖**的那一段，不是池子的十分钟：
     * 300 字装不下整个窗口时，摘要按时间取代表句（首尾必留），
     * 但仍然可能只覆盖其中几分钟 —— 不写实际跨度就是谎报（2026-11-17 改）。
     */
    const summaryBlock = summary.text
      ? `最近十分钟的台词（实际覆盖 ${clock(summary.from)}–${clock(summary.to)}，`
        + `${summary.lines} 句${summary.speech > summary.lines ? `，窗口内共 ${summary.speech} 句` : ''}）：\n`
        + `${summary.text}\n`
      : '最近十分钟没有可读的台词（只有声音/环境音）。\n';
    const text = `[黑听] ${clock(at)} · 听到「${hits[0].text}」（${hits[0].reason}）—— 最近 5 分钟有对话，抬头看一眼。\n`
      + `${frameLine}\n`
      + summaryBlock
      + '值得细看就 `see_now({action:"watch"})`；不值得就什么都别做，我继续听。'
      + hint();
    const ok = await wake(text);
    // 叫醒尝试也记一笔：醒来没醒只有这里有账（默认一晚上几条）
    debug(`lift-wake ok=${ok} t0=${t0}`);
    if (!ok) {
      noteNoAnswer();
      return;
    }
    liftLevelNow = 'look';
    liftHoldFrom = at;
  }

  /** 供 `see_now({action:"lift"})` 用；内部转 `senses.frameAt`。 */
  function frameAt(t0) {
    return senses.frameAt?.(t0) ?? { ok: false, reason: 'no-frame' };
  }

  /** `state().lift` / status 的两行文案共用。 */
  function status() {
    return {
      level: liftLevelNow,
      base: config.level ?? 'glance',
      alarms: liftAlarmTimes.length,
      holdingSince: liftHoldFrom || null,
    };
  }

  /** 收工 / 重建循环时清干净：上一场的 `liftSeen`、池、档位不能串到下一场。 */
  function reset() {
    liftPool.clear();
    liftPushedT0.clear();
    liftSeen = [];
    liftAlarmTimes = [];
    liftLevelNow = null;
    liftHoldFrom = 0;
    lastLiftVoiceAt = 0;
    lastLiftScanAt = now();
  }

  return { tick, frameAt, status, reset };
}
