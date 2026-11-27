/**
 * text-stream.js — 屏幕文字流的运行时（P1 第 2 步：条带 OCR）。
 *
 * 职责只有三件：
 *   1. **抽帧**：`onFrame()` 由 `pipeline.push()` 在每个**原始帧**上调用（不是 keep 帧 ——
 *      keep 会被去重挡掉，而"图不变、字幕可以变"正是要抓的那种情况）；
 *   2. **裁条带 → 送 sidecar**：`text-band.js` 切出底部条带、转 BGRA，另一个
 *      `--mode text` 的 `py/ocr_sidecar.py` 实例按行回文字；
 *   3. **喂闸门**：每行交给 `text-events.js` 的 `createTextGate()`，交付侧问
 *      `between()` 拿「上一张图到现在」的血位之后的行。
 *
 * 失败姿态（照 `ocr.js` 的规矩）：**OCR 永远可选**。没装 winrt / 没中文识别器 /
 * sidecar 起不来 → `status().ocr = {available:false, why}`，采集与出图照旧，
 * 一条都不许拖垮主链路，也不许编字。
 */

import { startOcr, resolveOcrPython } from './ocr.js';
import {
  bandRect, confirmGapFor, cropRgb24, rgb24ToBgra, rgbDiffRatio, sidecarSizeOf, tidyOcrLine,
} from './text-band.js';
import { createTextGate } from './text-events.js';
import { mergeIntervals } from './coverage.js';

/** 一帧条带的识别上限：宽条比血条慢（实测血条 12–92ms），给 5 秒防卡死 */
export const TEXT_OCR_TIMEOUT_MS = 5000;

/**
 * @param {{config:object, startOcrFn?:Function, resolveFn?:Function,
 *          log?:Function, now?:Function}} o
 */
export function createTextStream({
  config,
  startOcrFn = startOcr,
  resolveFn = resolveOcrPython,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const cfg = config;
  const gate = createTextGate({
    minChars: cfg.minChars,
    maxLines: cfg.maxLines,
    maxChars: cfg.maxChars,
    confirmGapMs: cfg.confirmGapMs,
    sim: cfg.sim,
    sampleMs: Math.round(1000 / Math.max(0.5, Number(cfg.fps) || 1)),
  });

  let ocr = null;
  let ocrKey = '';        // w×h×scale×lang：条带尺寸变了就得重起（协议里没有逐帧头）
  let why = null;         // 非空 = OCR 不可用/已退出，status 里照抄
  let retryAt = 0;        // 失败之后一分钟后才允许再起进程（别变成每秒敲一次门）
  let busy = false;       // 上一帧还没回来：丢帧，不排队（排队的字幕是旧字幕）
  let sampled = 0;        // 真正送进 OCR 的帧数
  let inFlight = null;    // 最近一个未完成的 Promise（测试等它）
  let lastSampleAt = 0;   // 抽帧节流（wall）
  /**
   * 静默暂停（`text.pauseAfterMs`）：条带连续这么久没变化就认为没字幕，不再送 OCR。
   *
   * 判据不靠 OCR、只比条带像素（`rgbDiffRatio`）：实测字幕没换时变化率 p90 = 0.00%，
   * 换句时 7–10%，两档分得很开。视频场景里最长静默只有 3.5 秒，所以 10 秒阈值在
   * 看视频时永远不会触发；省的是游戏挂机 / 静态界面那种几分钟不动的画面。
   */
  let lastBandRgb = null;
  let quietMs = 0;
  let paused = false;
  const pauseAfterMs = Math.max(0, Number(cfg.pauseAfterMs) || 0);
  /**
   * 覆盖率的两本账（P1 第 3 步）。口径与 `coverage.js` 同一形状：
   *   - 分母 = **采样到「有字」的时长**（OCR 回了至少一行的那几帧，各算一个采样间隔）；
   *   - 分子 = 这些时长里被**入流事件**盖住的部分。
   * 不写「0 token」也不写「100%」：没采到字的时候是 null，不是满分。
   */
  const textSpans = [];   // 采样到有字的区间 [{from,to}]（epoch ms）
  const eventSpans = [];  // 已确认事件的区间

  const intervalMs0 = Math.round(1000 / Math.max(0.5, Number(cfg.fps) || 1));
  let intervalMs = intervalMs0;

  function ensureOcr(w, h) {
    if (retryAt && now() < retryAt) return null;      // 刚失败过：一分钟内不再敲门
    const size = sidecarSizeOf(cfg, w, h);
    const key = `${size.w}x${size.h}/${size.scale}/${cfg.lang}`;
    if (ocr && ocrKey === key) return ocr;
    if (ocr) { try { ocr.stop(); } catch { /* 已经退了 */ } ocr = null; }
    const probe = resolveFn();
    if (!probe?.ok) {
      why = `OCR 不可用：${probe?.reason ?? '没有可用的 Python'}`;
      retryAt = now() + 60_000;
      return null;
    }
    try {
      const o = startOcrFn({
        w: size.w, h: size.h, scale: size.scale, canvasH: size.canvasH,
        lang: cfg.lang, mode: 'text', python: probe.python, timeoutMs: TEXT_OCR_TIMEOUT_MS,
        onStderr: (s) => { if (/ERR|Traceback/.test(s)) why = `OCR 报错：${s.trim().slice(0, 200)}`; },
      });
      o.done?.then(() => {
        if (ocr === o) { ocr = null; why = why ?? 'OCR 退出'; retryAt = now() + 60_000; }
      }, (e) => {
        if (ocr === o) { ocr = null; why = `OCR 退出：${e?.message ?? e}`; retryAt = now() + 60_000; }
      });
      ocr = o;
      ocrKey = key;
      why = null;
      retryAt = 0;
      return o;
    } catch (e) {
      why = `OCR 起不来：${e?.message ?? e}`;
      retryAt = now() + 60_000;
      return null;
    }
  }

  /**
   * 喂一帧原始画面。**每帧都会被调用**，节流在这里做（`fps` 默认 1）。
   *
   * `t` 是相对秒（管线时钟），`wall` 是 epoch ms（闸门与台词共用同一个时钟）。
   */
  function onFrame({ t, buf, width, height, wall }) {
    if (!cfg.enabled) return;
    if (!buf || !width || !height) return;
    const w = Number(wall) || now();
    if (lastSampleAt && w - lastSampleAt < intervalMs - 5) return;   // 节流（留 5ms 容差给抖动）
    lastSampleAt = w;
    if (busy) return;                                               // 上一帧还没回来
    let rgb;
    let band;
    try {
      const rect = bandRect(width, height, cfg.band);
      rgb = cropRgb24(buf, width, height, rect);
      band = { bgra: rgb24ToBgra(rgb, rect.w, rect.h), w: rect.w, h: rect.h, rect };
    } catch (e) {
      why = `条带裁剪失败：${e?.message ?? e}`;
      return;
    }
    // 静默暂停：条带跟上一次采样比，没变就不 OCR（判据见 lastBandRgb 的注释）
    let changed = true;
    if (lastBandRgb && lastBandRgb.length === rgb.length) {
      changed = rgbDiffRatio(lastBandRgb, rgb) >= (Number(cfg.diffRatio) || 0.02);
    }
    lastBandRgb = rgb;
    if (changed) {
      if (paused) {
        paused = false;
        log(`屏幕文字：条带又有变化，恢复 OCR（静默 ${Math.round(quietMs / 1000)}s）`);
      }
      quietMs = 0;
    } else {
      quietMs += intervalMs;
      if (pauseAfterMs > 0 && quietMs >= pauseAfterMs) {
        if (!paused) {
          paused = true;
          log(`屏幕文字：条带 ${Math.round(quietMs / 1000)}s 没变化，暂停 OCR（有变化自动恢复）`);
        }
        return;
      }
    }
    const engine = ensureOcr(width, height);
    if (!engine) return;
    busy = true;
    sampled += 1;
    const at = w;
    inFlight = engine.recognize(band.bgra)
      .then((out) => {
        const lines = Array.isArray(out?.lines) ? out.lines : (out?.text ? [out.text] : []);
        if (lines.length) {
          textSpans.push({ from: at, to: at + intervalMs });
          prune(textSpans, at);
        }
        for (const raw of lines) {
          // WinRT 的中文是一字一空格吐出来的（见 `text-band.js` 的 `tidyOcrLine`）
          const text = tidyOcrLine(raw);
          if (!text) continue;
          // `conf` 现在是 null：`py/ocr_sidecar.py` 不吐置信度，WinRT 的 OcrLine 也没有
          const r = gate.observe({ t: at, text, conf: null });
          if (r.kind === 'confirmed' && r.event) {
            eventSpans.push({ from: r.event.t0, to: r.event.t1 });
            prune(eventSpans, at);
          }
        }
        return lines;
      })
      .catch((e) => {
        why = `OCR 识别失败：${e?.message ?? e}`;
        retryAt = now() + 60_000;
        // 进程真的没了就别再往上写帧：下一步 status 会说原因，采集不受影响
        if (ocr) { try { ocr.stop(); } catch { /* 已经退了 */ } ocr = null; ocrKey = ''; }
        return [];
      })
      .finally(() => { busy = false; });
    inFlight.catch(() => {});
  }

  /** 滚动窗：只留最近 10 分钟（文字事件不落盘，这本账也一样） */
  function prune(arr, now) {
    while (arr.length && arr[0].to < now - 10 * 60_000) arr.shift();
  }

  const overlap = (a, b) => Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));

  /**
   * 屏幕文字覆盖率（P1 第 3 步的账）。
   *
   * **分母 = 采样到「有字的时长」**（不是总采样时长）：OCR 那一帧什么都没认出来，
   * 说明屏幕上真的没字，不该拉低覆盖率。和 `coverage.js` 同一个形状，
   * 报数时必须连分母一起说 —— 单说一个百分比是没法对账的。
   */
  function coverage() {
    const has = mergeIntervals(textSpans);
    const ev = mergeIntervals(eventSpans);
    const hasMs = has.reduce((n, s) => n + (s.to - s.from), 0);
    const covMs = Math.min(hasMs, has.reduce(
      (n, s) => n + ev.reduce((m, e) => m + overlap(s, e), 0), 0,
    ));
    return {
      hasTextSec: +(hasMs / 1000).toFixed(1),
      coveredSec: +(covMs / 1000).toFixed(1),
      pct: hasMs >= 1000 ? Math.round((100 * covMs) / hasMs) : null,
    };
  }

  /** 交付点：`from → to` 之间还没交付过的行（预算在里面） */
  function between(from, to) {
    return gate.between(from, to);
  }

  /** `status` 里那一行 + 账（六个数与 `meta.textStats` 同形） */
  function status() {
    return {
      enabled: cfg.enabled,
      band: cfg.band,
      fps: cfg.fps,
      lang: cfg.lang,
      scale: cfg.scale,
      sampled,
      busy,
      /** 静默暂停中：条带连续 `pauseAfterMs` 没变化，没在送 OCR */
      paused,
      quietSec: +(quietMs / 1000).toFixed(1),
      ocr: { available: Boolean(ocr) && !why, why },
      stats: gate.stats(),
      /** 覆盖率账：`{hasTextSec, coveredSec, pct}`（pct 的分母就是 hasTextSec） */
      coverage: coverage(),
    };
  }

  function stop() {
    const o = ocr;
    ocr = null;
    ocrKey = '';
    lastBandRgb = null;
    quietMs = 0;
    paused = false;
    try { o?.stop(); } catch { /* 已经退了 */ }
  }

  /**
   * 运行期开关（`see-now.json` 的 `text.enabled`，1.5 秒轮询调进来）。
   *
   * 关掉时把 sidecar 停了、闸门里的字**留着**（再打开时同一段字幕还在窗口里）；
   * 打开时下一帧会懒起 sidecar。A/B 靠它：不用重启，开 / 关两段能背靠背跑。
   */
  function setEnabled(on) {
    cfg.enabled = Boolean(on);
    if (!cfg.enabled) stop();
    // 重新打开时清掉基准帧：否则第一帧会跟「关掉之前那一帧」比，判成没变化白白静默
    else { lastBandRgb = null; quietMs = 0; paused = false; }
    return cfg.enabled;
  }

  /**
   * 运行期改采样率（设置页「读字幕模式」用）：1 fps = 省，2 fps = 高确认率。
   *
   * **只动闸门参数、不重建**：`intervalMs` 变了节流跟着变，`sampleMs` / `confirmGapMs`
   * 一起重算（`confirmGapFor`——固定 900 会让 2 fps 的相邻两帧永远配不上对）；
   * 已经攒下的 pending 和 events 全留着，切档不该把前面的字清掉。
   */
  function setFps(next) {
    const f = Number(next);
    if (!(Number.isFinite(f) && f >= 0.5 && f <= 5)) return cfg.fps;
    cfg.fps = f;
    intervalMs = Math.round(1000 / f);
    gate.retune({ sampleMs: intervalMs, confirmGapMs: confirmGapFor(f) });
    return cfg.fps;
  }

  return {
    onFrame,
    between,
    status,
    stop,
    setEnabled,
    setFps,
    /** 测试用：等手上这一帧识别完 */
    settled: () => inFlight ?? Promise.resolve(),
  };
}
