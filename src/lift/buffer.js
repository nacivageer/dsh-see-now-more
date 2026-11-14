/**
 * lift-buffer.js — 黑听留底：最近 30 秒的缩略帧环形缓冲（P2-A）。
 *
 * ## 它解决什么
 *
 * 机制的默认档是「瞥」：听到「你看这个」→ 取**那句话那一刻**的画面、不叫醒、窗里落一行。
 * 没有留底就只能拿当前帧冒充，而那句话往往已经说完十几秒了 —— 机制文档明令禁止。
 * 所以缓冲是四档闭环的前置。
 *
 * ## 三条口径（2026-11-10 拍板）
 *
 * ① **帧在 Node 侧**，裸 RGB 存在环形数组里：按 epoch ms 二分取帧，取到的帧可以直接喂
 *    pipeline；内存好算（800×450×3 = 1.08 MB/帧，15 帧 ≈ 16 MB）。让 ffmpeg 吐 JPEG
 *    能省 95% 内存，但取帧时还得再解码一次，时间戳到「那一刻」的偏差反而更难压。
 *
 * ② **只留不拼、不落盘、不花 token**：这里没有 fs、没有 PNG、没有画布。谁要图谁自己拿
 *    `pickAt()` 的结果去拼 —— 缓冲层不猜用途。
 *
 * ③ **判「那个时刻还在不在」是取帧的一部分**：`pickAt(t0)` 返回 `deltaMs` 和失败原因
 *    （`too-old` / `too-new` / `empty`）。四档那边**不许**在 `ok:false` 时拿当前帧顶上，
 *    机制文档「风险」第一条就是这么写的。
 *
 * ## 时间轴
 *
 * 帧的 `at` 是**收到 ffmpeg 这一帧时的墙上时间**（epoch ms），和 ASR 的 `t0/t1` 同一个时钟 ——
 * 这是「按台词时间戳回取」能对上的唯一前提，别改成相对坐标。
 *
 * 0.5 fps 意味着两帧相隔 2 秒：`pickAt` 给的永远是最接近的那一帧，最坏偏差 1 秒。
 * 这个数字是采集帧率决定的，不是算法能补的；要更准只能抬 fps（代价：内存翻倍）。
 */

/** 留底帧率。0.5 fps × 30 秒 ≈ 15 帧（实测 ddagrab/gdigrab 都稳定 2.00s 一帧）。 */
export const LIFT_FPS = 0.5;

/**
 * **采集帧率 ≠ 留底帧率。**
 *
 * 直接让 ffmpeg 以 0.5 fps 抓屏在两种引擎上都不可靠（2026-11-10 实测，ffmpeg 6.0）：
 *
 * | 引擎 | 0.5 fps | 2 fps |
 * |---|---|---|
 * | gdigrab + region | **13 秒一帧不出，然后突发几十帧** | 0.50s 稳定 |
 * | gdigrab 整屏 | 2.00s（可用，但同上变体不稳） | 0.50s 稳定 |
 * | ddagrab | 静态屏上 12 秒只给 1–2 帧（变更驱动） | 1.7 fps |
 *
 * 所以采集侧固定跑 2 fps，Node 侧**每 `LIFT_KEEP_EVERY` 帧留一帧**，等效 0.5 fps。
 * 代价是多抓 4 倍的帧（gdigrab 2 fps ≈ 0.08 核，仍在"黑听才付"的预算里），
 * 换来的是**静止屏幕上也有稳定节拍** —— 没有它，静止画面 30 秒后 `pickAt` 会报
 * 「太新」，把「那一刻的画面还在」误判成「没了」。
 */
export const LIFT_CAPTURE_FPS = 2;

/** 采集帧 → 留底帧的抽稀比（2 fps ÷ 4 = 0.5 fps）。 */
export const LIFT_KEEP_EVERY = 4;

/** 留底窗口（秒）。池子 10 分钟、缓冲只有 30 秒 —— 这两条不要混。 */
export const LIFT_WINDOW_SEC = 30;

/**
 * 单帧尺寸：长边 800 / 16:9 → 800×450。
 *
 * **不跟 `SIZES.low`（798×450）对齐**：那个 798 是为了让出图画布正好 19 个 42px 格，
 * 这里不出图、没有网格成本。真到「瞥」要拼图时由 pipeline 那一侧自己缩。
 */
export const LIFT_WIDTH = 800;
export const LIFT_HEIGHT = 450;

/** 一帧裸 RGB 的字节数（1,080,000 ≈ 1.03 MiB）。 */
export const LIFT_FRAME_BYTES = LIFT_WIDTH * LIFT_HEIGHT * 3;

/**
 * 内存硬上限。理论占用 = 15 × 1.03 MiB ≈ 15.5 MiB；给到 48 MiB 是留给
 * 「fps 被调高 / 帧被中途换尺寸」这类非常规情况，超了就丢最旧的，绝不无界增长。
 */
export const LIFT_MAX_BYTES = 48 * 1024 * 1024;

/**
 * `pickAt` 默认允许多大偏差才算「有那一刻的帧」。
 *
 * 0.5 fps 下最近的帧最远隔 1 秒（半个间隔），再加 0.5 秒采集合成的抖动 ——
 * 1.5 秒是「这一帧能代表那一刻」的上界。调用方要更严就自己传 `maxDeltaMs`，
 * 返回里的 `deltaMs` 永远是真实值，不粉饰。
 */
export const LIFT_PICK_TOLERANCE_MS = 1500;

export const LIFT_BUFFER_DEFAULTS = Object.freeze({
  fps: LIFT_FPS,
  windowSec: LIFT_WINDOW_SEC,
  width: LIFT_WIDTH,
  height: LIFT_HEIGHT,
  maxBytes: LIFT_MAX_BYTES,
  toleranceMs: LIFT_PICK_TOLERANCE_MS,
});

/** 帧的字节数（宽高给了就用给的：以后换尺寸时账还得算对）。 */
export function frameBytes(width = LIFT_WIDTH, height = LIFT_HEIGHT) {
  return width * height * 3;
}

/**
 * 建一个环形缓冲。**纯内存、无副作用、无定时器** —— 采集由 runner 管，
 * 这里只管「存、淘汰、按时间找」。
 *
 * @param {{fps?:number, windowSec?:number, width?:number, height?:number,
 *          maxBytes?:number, toleranceMs?:number, now?:()=>number}} [opts]
 */
export function createLiftBuffer({
  fps = LIFT_FPS,
  windowSec = LIFT_WINDOW_SEC,
  width = LIFT_WIDTH,
  height = LIFT_HEIGHT,
  maxBytes = LIFT_MAX_BYTES,
  toleranceMs = LIFT_PICK_TOLERANCE_MS,
  now = () => Date.now(),
} = {}) {
  const frameMs = 1000 / fps;
  const windowMs = windowSec * 1000;
  /** 按 `at` 升序。只在这个数组尾巴追加、从头淘汰 —— 不排序、不插队。 */
  const items = [];
  let bytes = 0;
  /** 收到过多少帧（含已被淘汰的）：用来区分「从来没采到」和「采到了但滑出窗口」。 */
  let pushed = 0;

  function dropHead(n = 1) {
    const cut = items.splice(0, n);
    for (const f of cut) bytes -= f.buf.length;
  }

  /**
   * 放一帧。**先淘汰再追加**，所以任何时刻 `stats()` 都在窗口内。
   *
   * @param {{buf:Buffer, width?:number, height?:number, at?:number, i?:number}} frame
   * @returns {boolean} 收了没有（尺寸不对 / 已经不是 Buffer 就 false —— 采集侧不许把坏帧塞进来）
   */
  function push({ buf, width: w = width, height: h = height, at = now(), i = null } = {}) {
    const need = frameBytes(w, h);
    if (!Buffer.isBuffer(buf) || buf.length < need) return false;
    // 只留这一帧自己的那段：`spawnFrames` 的零拷贝路径给的是 socket chunk 的视图，
    // 不切的话会把整个 chunk 一起钉在内存里。
    const keep = buf.length === need ? buf : buf.subarray(0, need);
    const atMs = Math.max(Number(at) || 0, items.length ? items[items.length - 1].at : 0);
    items.push({ at: atMs, buf: keep, width: w, height: h, i });
    bytes += keep.length;
    pushed += 1;

    // ① 时间窗：比最新一帧早出一个窗口的，整段丢掉
    const cutoff = atMs - windowMs;
    let expired = 0;
    while (expired < items.length && items[expired].at < cutoff) expired += 1;
    if (expired) dropHead(expired);

    // ② 帧数上限：0.5 fps × 30 秒 = 15，给 2 帧余量（时间戳抖动不会把窗口撑破）
    const cap = Math.ceil(windowSec * fps) + 2;
    if (items.length > cap) dropHead(items.length - cap);

    // ③ 内存上限：非常规配置（fps 调高 / 尺寸换大）时的兜底
    while (items.length > 1 && bytes > maxBytes) dropHead(1);
    return true;
  }

  /** 二分找最接近 `t` 的那一帧的下标（items 非空）。 */
  function nearestIndex(t) {
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].at < t) lo = mid + 1;
      else hi = mid;
    }
    // lo 是第一个 >= t 的；比较它和前一个谁更近
    if (lo > 0 && Math.abs(items[lo - 1].at - t) <= Math.abs(items[lo].at - t)) return lo - 1;
    return lo;
  }

  /**
   * 取「`t0` 那一刻」的帧。
   *
   * 失败原因是**给调用方看的判据**，不是错误码：
   *   - `empty`   还没采到任何帧（刚进仅监听 / ffmpeg 没起来）
   *   - `too-old` 那句话早于窗口起点 → 画面已经没了，只能报文字
   *   - `too-new` 那个时刻比最新一帧还晚太多（采集断了 / 时钟漂了）
   *   - `far`     在窗口内，但最近的一帧也隔得太远（帧率被调过？）
   *
   * @param {number} t0 epoch ms（ASR 的 `line.t0`）
   * @param {{maxDeltaMs?:number}} [opts]
   * @returns {{ok:true, frame:{at:number,buf:Buffer,width:number,height:number,i:number|null},
   *            deltaMs:number}
   *          |{ok:false, reason:'empty'|'too-old'|'too-new'|'far',
   *            oldestAt?:number, newestAt?:number, deltaMs?:number, ageSec?:number}}
   */
  function pickAt(t0, { maxDeltaMs = toleranceMs } = {}) {
    const t = Number(t0);
    if (!Number.isFinite(t)) return { ok: false, reason: 'empty' };
    if (!items.length) return { ok: false, reason: 'empty' };

    const oldestAt = items[0].at;
    const newestAt = items[items.length - 1].at;
    // 窗口两侧各放宽半个帧距：`t0` 落在两帧中间时它仍然「在缓冲里」
    const half = frameMs / 2;
    if (t < oldestAt - half) {
      return { ok: false, reason: 'too-old', oldestAt, newestAt, ageSec: +((oldestAt - t) / 1000).toFixed(1) };
    }
    if (t > newestAt + half) {
      return { ok: false, reason: 'too-new', oldestAt, newestAt, ageSec: +((t - newestAt) / 1000).toFixed(1) };
    }

    const idx = nearestIndex(t);
    const frame = items[idx];
    const deltaMs = Math.round(frame.at - t);
    if (Math.abs(deltaMs) > maxDeltaMs) {
      return { ok: false, reason: 'far', oldestAt, newestAt, deltaMs };
    }
    return { ok: true, frame, deltaMs };
  }

  /** 清空（退出仅监听 / stop 时必须调：留着上一场的画面只会让下一场拿到别人的帧）。 */
  function clear() {
    items.length = 0;
    bytes = 0;
    pushed = 0;
  }

  /**
   * 最近 n 帧（按时间升序，最后一个是新的）。
   *
   * 给「画面不动」判定用：拿最后两帧比像素。返回的是**帧引用的数组拷贝**，
   * 外面不能拿它改缓冲（`items` 本身不出去）。
   */
  function recent(n = 1) {
    const k = Math.max(0, Math.min(items.length, Math.floor(Number(n) || 0)));
    return items.slice(items.length - k);
  }

  /**
   * 账本。`ageSec` 是「最后一帧是多久以前」—— 采集断了的时候，帧还在但已经没有现在了，
   * 状态行必须能看出来（`stale` 就是给状态行用的）。
   */
  function stats() {
    const at = now();
    const newest = items.length ? items[items.length - 1] : null;
    const newestAt = newest?.at ?? null;
    const oldestAt = items.length ? items[0].at : null;
    const ageSec = newestAt === null ? null : Math.max(0, Math.round((at - newestAt) / 1000));
    return {
      frames: items.length,
      bytes,
      mb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
      spanSec: oldestAt === null ? 0 : Math.round((newestAt - oldestAt) / 1000),
      oldestAt,
      newestAt,
      ageSec,
      stale: ageSec !== null && ageSec > Math.round((frameMs / 1000) * 3),
      pushed,
      fps,
      windowSec,
      // 尺寸以**实际收到的最新一帧**为准：region 模式下宽高是按区域比例算的，
      // 拿构造参数报出来会骗人。
      width: newest?.width ?? width,
      height: newest?.height ?? height,
    };
  }

  return { push, pickAt, clear, recent, stats };
}

/**
 * 两帧「变了多少」：按固定步长采样，返回变化点占比 0–1。
 *
 * 为什么采样而不是全量：800×450×3 = 1.08 MB，全量比一遍每 2 秒一次不划算；
 * 步长 97（质数，避开"每行开头"这类周期性对齐）取 ~11k 个点，足够判「画面在不在动」。
 *
 * **阈值 8 是刻意的**：屏幕截图里 ±1~2 的抖动（视频压缩、光标反锯齿）不该算"在动"。
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {{stride?:number, threshold?:number}} [o]
 * @returns {number} 0 = 完全一样，1 = 每个采样点都变了（非 Buffer / 空缓冲也按 1 算，宁严勿松）
 */
export function changedFraction(a, b, { stride = 97, threshold = 8 } = {}) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return 1;
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  const step = Math.max(1, Math.floor(Number(stride) || 97));
  const gate = Math.max(0, Number(threshold) || 0);
  let seen = 0;
  let changed = 0;
  for (let i = 0; i < n; i += step) {
    seen += 1;
    if (Math.abs(a[i] - b[i]) > gate) changed += 1;
  }
  return seen ? changed / seen : 1;
}
