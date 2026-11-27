/**
 * text-band.js — 条带几何 + 像素转换 + 配置校验（纯函数，P1 第 2 步）。
 *
 * 为什么单独一个文件：`src/pipeline.js` 的 `flushBand()` 也在算条带矩形。
 * 两处各算一遍迟早会漂 —— 这里出**唯一一份**几何，pipeline 与文字流都调它。
 *
 * 口径：
 *   - `y0/y1` 是高度比例，`inset` 是左右各让出的宽度比例（默认 0.10）；
 *   - **文字条带默认 `[0.80, 1.0]`，而 `preset:"subtitle"` 出的图仍是 `[0.84, 1.0]`**：
 *     2026-11-27 用 `BV1eS1czoEaD` p2 的真实画面实测，字幕顶部落在 0.80–0.82 之间，
 *     0.84 起会切掉字顶（严格命中 1/20，0.80 是 12/20；端到端入流 71→93、覆盖 48%→60%）；
 *   - `y0/y1` 是高度比例，`inset` 是左右各让出的宽度比例（默认 0.10）；
 *   - 左右让边是因为片子不会把字幕顶到画面两侧，那两条边本来就没字；
 *   - 行数/宽度都夹了下限，防止 1 像素的条带把 OCR 卡死。
 */

import { TEXT_DEFAULTS } from './text-events.js';

/** 条带与采样参数（`~/.dsh/see-now.json` 的 `text` 段按同名键覆盖） */
export const TEXT_BAND_DEFAULTS = Object.freeze({
  enabled: true,
  /**
   * `[y0, y1, inset]`。**比 `preset:"subtitle"` 的 `[0.84, 1.0, 0.10]` 高 0.04**：
   * 2026-11-27 实测字幕顶部会落在 0.80–0.82，从 0.84 起裁会切字顶（见文件头）。
   */
  band: Object.freeze([0.80, 1.0, 0.10]),
  /**
   * 每秒抽几帧送 OCR（`text.fps`）。1 = 原默认，2 是看视频字幕时的档。
   *
   * **不设成默认值**：视频场景下 2 fps 确实更好（1 fps 时 40% 的字幕只被采到 1 帧、
   * 确认率 27%；2 fps 配 `confirmGapMs 450` 后确认 78→152、未确认 112→76），但游戏和
   * 静态界面里字幕是断续的、底部那条多半是 UI 或血条，2 fps 等于白烧一倍 CPU。
   * 所以它该是个**按场景选的档**，出厂值留在 1。
   */
  fps: 1,
  /** OCR 前的放大倍数；血条是 4（16px 高的数字），宽条 2 起（实测再定） */
  scale: 2,
  lang: 'zh-Hans-CN',
  /** sidecar 画布高；不传就按条带高 × scale 算 */
  canvasH: 0,
  /**
   * 条带连续这么久没变化，就认为这块没有字幕，暂停 OCR（ms；0 = 不暂停）。
   *
   * 依据（2026-11-27，310 秒真实字幕视频、2 fps 采样）：字幕没换时条带变化率
   * p50/p90 都是 0.00%，换句时 7.3%/9.6%——判据分得干净；而视频里连续静默最长只有
   * 3.5 秒，所以 10 秒的阈值在视频场景永远不触发，只有游戏挂机 / 静态界面那种
   * 长时间不变的画面才会真的省下来。
   */
  pauseAfterMs: 10_000,
  /** 一次采样里「变了」的判据：通道差 > 32 的像素占比 ≥ 这个值 */
  diffRatio: 0.02,
});

/**
 * 条带矩形（像素）。**与 `src/pipeline.js` 里 `flushBand()` 的算法逐字一致**。
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function bandRect(width, height, band = TEXT_BAND_DEFAULTS.band) {
  const W = Math.max(1, Math.round(Number(width) || 0));
  const H = Math.max(1, Math.round(Number(height) || 0));
  const [y0, y1, insetRaw] = Array.isArray(band) && band.length >= 2 ? band : TEXT_BAND_DEFAULTS.band;
  const inset = Math.max(0, Math.min(0.4, Number(insetRaw) || 0));
  const x = Math.min(Math.round(W * inset), Math.max(0, W - 16));
  const w = Math.max(16, W - x * 2);
  const y = Math.max(0, Math.round(H * Number(y0)));
  const h = Math.max(8, Math.min(H - y, Math.round(H * (Number(y1) - Number(y0)))));
  return { x, y, w, h };
}

/**
 * 从 rgb24 里裁一块。整宽时一次连续拷贝，让过左右边之后每行一次 `copy`
 * （和 `pipeline.js` 的 `cropRect` 同一写法：1280×170 约 20 万字节，1 fps 下可忽略）。
 */
export function cropRgb24(buf, width, height, rect) {
  const { x, y, w, h } = rect;
  const stride = width * 3;
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let row = 0; row < h; row += 1) {
    const sy = Math.min(height - 1, Math.max(0, y + row));
    const sx = Math.max(0, Math.min(width, x));
    const sw = Math.min(w, width - sx);
    const src = sy * stride + sx * 3;
    const dst = row * w * 3;
    if (sw === w) buf.copy(out, dst, src, src + w * 3);
    else { out.fill(0, dst, dst + w * 3); buf.copy(out, dst, src, src + Math.max(0, sw) * 3); }
  }
  return out;
}

/**
 * rgb24 → BGRA（sidecar 的 stdin 只吃 BGRA，协议不变，转换放在 Node 这头）。
 *
 * 一帧 1280×170 = 21.8 万像素，循环一次约 1–2ms；1 fps 下不进热路径。
 */
export function rgb24ToBgra(rgb, width, height) {
  const n = width * height;
  const out = Buffer.allocUnsafe(n * 4);
  for (let i = 0, s = 0, d = 0; i < n; i += 1, s += 3, d += 4) {
    out[d] = rgb[s + 2];      // B
    out[d + 1] = rgb[s + 1];  // G
    out[d + 2] = rgb[s];      // R
    out[d + 3] = 255;         // A
  }
  return out;
}

/**
 * 两帧同尺寸 rgb24 里「变了」的像素占比（0–1）。
 *
 * 用途是**静默暂停**：字幕没换时条带几乎一个像素都不动（实测 p90 = 0.00%），
 * 换句时 7–10%。所以「占比 ≥ diffRatio」就是「字幕换句了」，不需要 OCR 也能判。
 *
 * 长度对不上（条带尺寸变了）时返回 1，即「当它变了」——宁可多读一次也别漏一句。
 */
export function rgbDiffRatio(a, b, pix = 32) {
  if (!a || !b || a.length !== b.length || a.length < 3) return 1;
  const threshold = pix * 3;
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > threshold) n += 1;
  }
  return n / (a.length / 3);
}

/**
 * 一步到位：原始帧 → 条带 BGRA（喂 sidecar 的那一坨）。
 * @returns {{bgra:Buffer, w:number, h:number, rect:object}}
 */
export function bandFromFrame(buf, width, height, band = TEXT_BAND_DEFAULTS.band) {
  const rect = bandRect(width, height, band);
  const rgb = cropRgb24(buf, width, height, rect);
  return { bgra: rgb24ToBgra(rgb, rect.w, rect.h), w: rect.w, h: rect.h, rect };
}

/* ---------- 收拾 OCR 原文 ---------- */

/** 中日韩统一表意文字 + 全角标点 + 中文标点：这些字符旁边的空格是 OCR 加的分词，不是原文 */
const CJK = /[\u2E80-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u;

/**
 * 收拾 WinRT 的中文输出。
 *
 * 实测（2026-11-27，`_scratch/band-test.mp4` 一帧）它把一句话吐成
 * `"我 们 得 先 回 去 ， 这 里 不 安 全 。"` —— 每个汉字之间一个空格。
 * 闸门的归一化本来就会去掉空白，所以**配对不受影响**；但交付给模型的原文
 * 带着这串空格又丑又贵（同一句话多出近一倍字符）。这里只在**空格旁边有汉字**时
 * 去掉空格，拉丁词之间的空格留着（`"Hello World"` 不许粘成 `"HelloWorld"`）。
 */
export function tidyOcrLine(text) {
  const s = String(text ?? '');
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== ' ' && ch !== '\t' && ch !== '\u3000') { out += ch; continue; }
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\u3000')) j += 1;
    const prev = out.slice(-1);
    const next = s[j] ?? '';
    if (prev && next && (CJK.test(prev) || CJK.test(next))) { i = j - 1; continue; }
    out += ' ';
    i = j - 1;
  }
  return out.trim();
}

/* ---------- 配置 ---------- */

/**
 * 采样间隔对应的「两次确认」最小间隔：**必须跟着 fps 缩**。
 *
 * 为什么不是固定 900：900 是 1 fps 下（间隔 1000 ms）调出来的，等于「必须隔一帧」。
 * 2 fps 的间隔只有 500 ms，固定 900 会让相邻两帧永远配不上对——实测 2 fps 配 900 时
 * 确认 102、未确认 173，比 1 fps 还差；配 450 才是确认 152、未确认 76。
 */
export function confirmGapFor(fps) {
  const f = Math.max(0.5, Number(fps) || 1);
  return Math.round(900 / f);
}

const isNum = (v) => Number.isFinite(Number(v));

/**
 * 读 `see-now.json` 的 `text` 段：**永远不抛**，写错就退回默认值并记一条 warn
 * （与 `tuning.js` 其余段同一姿势 —— 配置不该把插件弄挂）。
 *
 * @param {any} raw
 * @returns {{config:object, warnings:string[]}}
 */
export function normalizeTextConfig(raw) {
  const warnings = [];
  const out = {
    ...TEXT_BAND_DEFAULTS,
    band: [...TEXT_BAND_DEFAULTS.band],
    ...TEXT_DEFAULTS,
  };
  if (raw === undefined) return { config: out, warnings };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('text 段不是对象，整段忽略（用默认：底部 0.80–1.0、左右 10%、1 fps、2×）');
    return { config: out, warnings };
  }

  if (raw.enabled !== undefined) {
    // 只认真正的布尔：`"false"` 是真值，用户以为关了、其实一直开着（折叠气泡那个坑同款）
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else warnings.push(`text.enabled 只能是 true / false（收到 ${JSON.stringify(raw.enabled)}），已用默认 true`);
  }

  if (raw.band !== undefined) {
    const b = Array.isArray(raw.band) ? raw.band.map(Number) : null;
    if (b && b.length >= 2 && b.every(isNum)
      && b[0] >= 0 && b[1] <= 1 && b[1] - b[0] > 0.01
      && (b.length < 3 || (b[2] >= 0 && b[2] <= 0.4))) {
      out.band = [b[0], b[1], b.length >= 3 ? b[2] : 0];
    } else {
      warnings.push('text.band 要写成 [y0, y1, insetX]（0 ≤ y0 < y1 ≤ 1，y1-y0 > 0.01，insetX 0–0.4），'
        + '已用默认 [0.8, 1, 0.1]');
    }
  }

  if (raw.fps !== undefined) {
    const n = Number(raw.fps);
    if (isNum(n) && n >= 0.5 && n <= 5) out.fps = n;
    else warnings.push(`text.fps 只能是 0.5–5（收到 ${JSON.stringify(raw.fps)}），已用默认 2`);
  }

  // 确认间隔**默认跟着采样率走**（900 / fps）：用户只该调「读字幕」一个档，
  // 不该被要求同时记得把 confirmGapMs 也改小——实测忘了改会让 2 fps 比 1 fps 还差。
  if (raw.confirmGapMs === undefined) out.confirmGapMs = confirmGapFor(out.fps);

  if (raw.pauseAfterMs !== undefined) {
    const n = Number(raw.pauseAfterMs);
    if (isNum(n) && n >= 0) out.pauseAfterMs = n;
    else warnings.push(`text.pauseAfterMs 要是毫秒数、0 = 不暂停（收到 ${JSON.stringify(raw.pauseAfterMs)}），已用默认 ${TEXT_BAND_DEFAULTS.pauseAfterMs}`);
  }
  if (raw.diffRatio !== undefined) {
    const n = Number(raw.diffRatio);
    if (isNum(n) && n > 0 && n <= 1) out.diffRatio = n;
    else warnings.push(`text.diffRatio 要是 0–1 的比例（收到 ${JSON.stringify(raw.diffRatio)}），已用默认 ${TEXT_BAND_DEFAULTS.diffRatio}`);
  }

  if (raw.scale !== undefined) {
    const n = Math.round(Number(raw.scale));
    if (Number.isInteger(n) && n >= 1 && n <= 4) out.scale = n;
    else warnings.push(`text.scale 只能是 1–4 的整数（收到 ${JSON.stringify(raw.scale)}），已用默认 2`);
  }

  if (raw.lang !== undefined) {
    if (typeof raw.lang === 'string' && raw.lang.trim()) out.lang = raw.lang.trim();
    else warnings.push('text.lang 要是识别器语言标签（如 "zh-Hans-CN"），已用默认');
  }

  // 闸门那几个数原样透传（越界由 createTextGate 自己收口），只做类型检查
  for (const key of ['minChars', 'maxLines', 'maxChars', 'confirmGapMs', 'sim']) {
    if (raw[key] === undefined) continue;
    const n = Number(raw[key]);
    if (isNum(n) && n >= 0) out[key] = n;
    else warnings.push(`text.${key} 要是非负数（收到 ${JSON.stringify(raw[key])}），已用默认 ${TEXT_DEFAULTS[key]}`);
  }

  return { config: out, warnings };
}

/** 从配置算出 sidecar 的启动尺寸（条带尺寸 × 放大后由它自己算，这里只给输入尺寸与画布） */export function sidecarSizeOf(config, width, height) {
  const rect = bandRect(width, height, config.band);
  const canvasH = config.canvasH > 0 ? config.canvasH : Math.round(rect.h * config.scale);
  return { w: rect.w, h: rect.h, scale: config.scale, canvasH };
}

/**
 * `status` 里那一行（纯函数：只吃 `text-stream.js` 的 `status()` 返回值）。
 *
 * 为什么把四个数写出来：任务书第 2 步的验收就是这四个数（入流 / 挡下 / 未确认 / 判重）。
 * "字怎么没进来"时，第一眼看的是「有没有送帧」和「OCR 可用不可用」——两者的修法完全不同。
 */
export function textStatusLine(t) {
  if (!t) return '屏幕文字：没接（text 段关掉或没传）';
  if (t.enabled === false) return '屏幕文字：关（see-now.json 的 text.enabled = false）';
  const s = t.stats ?? {};
  const ocr = t.ocr ?? {};
  const pct = (x) => Math.round(Number(x) * 100);
  return '屏幕文字：'
    + (ocr.available ? '读数中' : `OCR 不可用（${ocr.why ?? '原因未知'}）`)
    + ` · 条带 ${pct(t.band?.[0])}–${pct(t.band?.[1])}%（左右各让 ${pct(t.band?.[2])}%）`
    + ` · ${t.fps} fps ×${t.scale}`
    + ` · 入流 ${s.lines ?? 0} / 挡下 ${s.blocked ?? 0} / 未确认 ${s.unconfirmed ?? 0} / 判重 ${s.deduped ?? 0}`
    + (t.sampled ? ` · 已送 OCR ${t.sampled} 帧` : ' · 还没采到帧');
}
