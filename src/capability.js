/**
 * capability.js — 能力状态的**一套词**（下游评估 §1 #4 的「不确定性口径」）。
 *
 * 以前 status 里每个能力自己发明词：`enabled` / `ok` / `available` / `ready` / `why` /
 * `stale` / `没在采`…… 单看某个字段要猜「现在能不能用、为什么」。这里把它们归成
 * 六个状态，`state().capabilities` 每个能力只报一个词 + 一句原因：
 *
 *   ready        现在能用
 *   degraded     能用，但有缺口（转写暂停 / 帧过期 / 读不到数字）
 *   disabled     被关掉了（没开 watch、没框血条、没进仅监听）
 *   unavailable  依赖/硬件不在，想用也用不了（没转写服务、没 winrt、窗起不来）
 *   pending      正在起，还没有第一个结果（采集刚起 / sidecar 未就绪）
 *   skipped      这个模式下用不到（血条没框时的数字识别）
 *
 * 纯函数：吃 `runner.state()` 里已有的那几个子对象，不读盘、不读时钟。
 */

export const CAPABILITY_STATES = Object.freeze([
  'ready', 'degraded', 'disabled', 'unavailable', 'pending', 'skipped',
]);

const STATE_SET = new Set(CAPABILITY_STATES);

const reasonOf = (s) => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t ? t.slice(0, 160) : null;
};

/** 造一个能力状态；状态词不在枚举里就直接抛（内部写错不能静默）。 */
export function capability(state, reason = null) {
  if (!STATE_SET.has(state)) throw new Error(`未知能力状态：${state}`);
  return { state, reason: reasonOf(reason) };
}

/** 视觉采集（watch / 常驻循环）。 */
export function visionCapability({ running = false, frames = 0, lastError = null } = {}) {
  if (!running) {
    return lastError
      ? capability('degraded', lastError)
      : capability('disabled', '没在采（调 watch 开始）');
  }
  if (lastError) return capability('degraded', lastError);
  if (!(Number(frames) > 0)) return capability('pending', '已启动，还没收到第一帧');
  return capability('ready');
}

/** 听觉（回环采集 + 转写）。 */
export function audioCapability(listen = {}) {
  const reason = reasonOf(listen.reason);
  if (listen.error) return capability('degraded', listen.error);
  if (listen.paused) return capability('degraded', reason ?? '转写连续失败，暂停中');
  if (!listen.enabled) {
    const missing = /没有|缺|抓不到|没打开|找不到/.test(reason ?? '');
    return capability(missing ? 'unavailable' : 'disabled', reason ?? '没启动');
  }
  return capability('ready');
}

/** 黑听留底（30 秒环形缓冲 + 10 分钟低清环）。 */
export function liftCapability(lift = {}) {
  if (!lift.enabled) return capability('disabled', '只在仅监听时留底');
  if (lift.wanted === false) return capability('disabled', '没在仅监听，留底不跑');
  if (lift.error) return capability('degraded', lift.error);
  if (!lift.capturing) return capability('pending', '正在起留底采集');
  if (lift.stale) return capability('degraded', '留底超过 10 秒没有新帧');
  if (!(Number(lift.frames) > 0)) return capability('pending', '还没收到第一帧');
  return capability('ready');
}

/** 血条采集（比例那一路）。 */
export function bloodbarCapability(bb = {}) {
  if (!bb.enabled) return capability('disabled', '没框血条');
  if (bb.wanted === false) return capability('disabled', '没在仅监听，血条不采');
  if (bb.error) return capability('degraded', bb.error);
  if (!bb.capturing) return capability('pending', '正在起血条采集');
  if (!bb.reading) return capability('pending', '还没读到第一帧');
  if (bb.reading.ok === false) return capability('degraded', bb.reading.reason ?? '框里没有血条');
  return capability('ready');
}

/**
 * 血条数字识别（Windows OCR）。
 *
 * 血条没框、或没在仅监听时它是 `skipped` —— 这不是「不可用」，只是这个模式下用不到；
 * 混成 unavailable 会让人去重装一个本来没问题的依赖（2026-11-16 就误报过一次）。
 */
export function ocrCapability(ocr = {}, { bloodbarEnabled = false, bloodbarWanted = true } = {}) {
  if (!bloodbarEnabled) return capability('skipped', '血条没框，用不到数字识别');
  if (bloodbarWanted === false) return capability('skipped', '血条没在采，用不到数字识别');
  if (ocr.available === false) return capability('unavailable', ocr.why ?? '缺 winrt');
  if (ocr.why) return capability('degraded', ocr.why);
  if (!ocr.ready) return capability('pending', 'OCR sidecar 还没就绪');
  return capability('ready');
}

/** 悬浮窗。 */
export function windowCapability(win = {}) {
  if (win?.ok === true) return capability('ready');
  if (win?.ok === false) return capability('unavailable', win.reason ?? '窗起不来');
  return capability('disabled', '窗没开');
}

/** status 里那几个短标签（一个能力一个词，顺序固定）。 */
export const CAPABILITY_LABELS = Object.freeze({
  vision: '视觉',
  audio: '听觉',
  lift: '留底',
  bloodbar: '血条',
  ocr: '数字',
  window: '窗',
});

/**
 * `state().capabilities` → status 里的一行。
 *
 * 只给别人看「现在能不能用」；ready 不带原因（原因只给非 ready，省 token），
 * 原因截到 `maxReason` 字，避免一行被长错误撑爆。
 *
 * @param {object} caps
 * @param {{labels?:object, maxReason?:number}} [o]
 * @returns {string}
 */
export function capabilityLine(caps, { labels = CAPABILITY_LABELS, maxReason = 40 } = {}) {
  if (!caps || typeof caps !== 'object') return '';
  const parts = [];
  for (const [key, label] of Object.entries(labels)) {
    const c = caps[key];
    if (!c || !STATE_SET.has(c.state)) continue;
    let part = `${label} ${c.state}`;
    if (c.state !== 'ready' && c.reason) {
      const why = String(c.reason).replace(/\s+/g, ' ').trim();
      part += `（${why.length > maxReason ? `${why.slice(0, maxReason)}…` : why}）`;
    }
    parts.push(part);
  }
  return parts.join(' · ');
}
