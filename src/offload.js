/**
 * offload.js — 会话历史里较早的截图「省略」掉（走宿主的 `image/offload` 事件）。
 *
 * ## 为什么要有这一层
 *
 * 一张图进了会话历史就跟着后面每一轮请求走，直到会话结束。宿主自己不回收
 * （它的 `dsh-compaction-image-offload` 只在**路由预算超了**才动手：张数 600 / Files 128 MiB），
 * 所以「一天聊几十张截图」的会话里，前面那些图会一直重发、一直占盘。
 *
 * 宿主给了正规机制：往会话日志里追加一条 `image/offload` 事件，声明「这几个位置的图以后
 * 换成一段占位文本」。之后投影把它们换成 `offloadedImageText`、图不再进请求，**文件也可以删**。
 *
 * ## 为什么不是「把图文件换成小图 / 直接删」
 *
 * 附件库读盘时三重校验（内容 sha256、bytes、width/height）。换内容直接 `ATTACHMENT_CORRUPT`，
 * 比删掉更糟（删掉是 `ATTACHMENT_NOT_FOUND`，至少能看出"文件没了"）。内容寻址存储就是靠
 * 这三道校验防掉包的，所以只能走事件。
 *
 * ## 为什么攒批（trigger / keep 两个数）
 *
 * 追加事件会改历史 → 前缀缓存从第一条被省略的消息起失效 → **一次性全量重算**。
 * 如果只留 `keep`（一超就省），第 201 张进来省 1 张、第 202 张再省 1 张 —— 每出一张图就改一次
 * 历史，缓存每轮全废，省下的命中 token 远不够付重算的钱，比不省还贵。
 * 所以拆成「涨到 trigger 才动手、一次省到只剩 keep」：攒 200 张才重算一次。
 *
 * ## 宿主侧的校验（算错就是硬错）
 *
 * `image/offload` 由宿主的投影插件解释（`dsh-compaction-image-offload`），它在**提交事件前**
 * 就校验：seq 必须是当前 surface 上的节点、只认 `user/message` 与 `tool/result`、
 * `imageIndexes` 严格递增且下标存在、不能重复省略。所以这里的计划必须和宿主的编号方式
 * 逐位一致 —— 它只数**消息 content 顶层**的 image 块（不递归进嵌套 content），这里也照做。
 *
 * 宿主没装那个投影插件时，`session.append('image/offload', …)` 会抛
 * `requires a message projection`：那说明这个宿主版本没有这个能力，我们退化（只报数、不省）。
 */

/** 能承载图片的 surface 事件类型（宿主 `image/offload` 校验就认这两种）。 */
const IMAGE_CARRYING = new Set(['user/message', 'tool/result']);

/** 出厂值：涨到 300 张才动手，一次省到只剩 100 张。 */
export const OFFLOAD_DEFAULTS = Object.freeze({ imageTrigger: 300, imageKeep: 100 });

/**
 * 交付后隔多久才允许再检查一次（按会话各记一个时间戳）。
 *
 * 重放整份会话日志要几十到几百毫秒，不能每交一张图就跑一次；出图间隔本身是 15–40 秒，
 * 所以实际是「差不多每次出图检查一次」。30 秒是上游的取值，这里照抄 —— 换了就要重新
 * 量「省略延迟」和「重算次数」的账。
 */
export const OFFLOAD_THROTTLE_MS = 30_000;

/**
 * 一条消息里的图按 depth-first 顺序摊平。
 *
 * **只数顶层**：宿主的 `offloadMessageImages` 只遍历 `message.content` 那一层，不递归进
 * 嵌套的 `content`。这里跟着它数，否则下标错位 —— 少的那一刻不会报错，只会省错图。
 *
 * @param {unknown} content - 消息的 content 数组
 * @returns {Array<{index:number, offloaded:boolean}>}
 */
export function imagesIn(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'image') continue;
    out.push({ index: out.length, offloaded: block.offloaded === true });
  }
  return out;
}

/**
 * 重放 surface，得到「当前还在模型可见历史里」的节点，按出现顺序。
 *
 * 规则和宿主的 surface fold 一致：`append` 追加；`{op:'replace',startSeq,endSeq}`
 * 遮蔽区间后把自己追加进来。
 *
 * @param {Array} events - 会话事件（按 seq 升序）
 * @returns {Array<{seq:number, event:object}>}
 */
export function replaySurface(events) {
  const nodes = [];
  for (const e of events) {
    const op = e?.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') {
      nodes.push({ seq: e.seq, event: e });
      continue;
    }
    if (op && op.op === 'replace') {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].seq >= op.startSeq && nodes[i].seq <= op.endSeq) nodes.splice(i, 1);
      }
      nodes.push({ seq: e.seq, event: e });
    }
  }
  return nodes;
}

/**
 * 已经被省略过的 `(seq, index)`，避免重复标记 —— 宿主会拒绝重复 target。
 *
 * 同时看两处：历史上记的 `image/offload` 事件（权威），以及块上带的 `offloaded` 标记
 * （有些版本读出来的事件已经过投影）。两处取并集，宁可多跳过一次，也不撞宿主的校验。
 *
 * @param {Array} events
 * @returns {Set<string>} `"seq:index"`
 */
export function alreadyOffloaded(events) {
  const done = new Set();
  for (const e of events) {
    if (e?.type !== 'image/offload') continue;
    const targets = e?.data?.targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (!t || !Array.isArray(t.imageIndexes)) continue;
      for (const i of t.imageIndexes) done.add(`${t.seq}:${i}`);
    }
  }
  return done;
}

/**
 * 算出该省略哪些图：**保留最新的 `keep` 张，更早的全部标记**。
 *
 * `keep` 是**省完之后停在哪**，不是"一到就省" —— 什么时候动手由 `planOffloadWithTrigger()` 决定。
 *
 * @param {Array} events - `session.snapshotEvents()` 的结果
 * @param {{keep?:number}} limits - 保留多少张（0 = 全不留）
 * @returns {{targets: Array<{seq:number,imageIndexes:number[]}>, total:number,
 *            offloading:number, kept:number}}
 */
export function planOffload(events, limits = {}) {
  const keep = Math.max(0, Math.floor(Number(limits?.keep) || 0));

  const done = alreadyOffloaded(events);
  const nodes = replaySurface(events);

  // 按模型可见顺序把还没省的 (seq, index) 拉平
  const occurrences = [];
  for (const node of nodes) {
    if (!IMAGE_CARRYING.has(node.event?.type)) continue;
    const content = node.event?.data?.message?.content ?? node.event?.data?.content;
    for (const img of imagesIn(content)) {
      if (img.offloaded || done.has(`${node.seq}:${img.index}`)) continue;
      occurrences.push({ seq: node.seq, index: img.index });
    }
  }

  const total = occurrences.length;
  const cut = Math.max(0, total - keep);
  const picked = occurrences.slice(0, cut);
  const kept = occurrences.slice(cut);

  // 按 seq 分组（宿主要求同一 seq 的 index 严格递增、且每个 seq 只出现一次）
  const bySeq = new Map();
  for (const { seq, index } of picked) {
    if (!bySeq.has(seq)) bySeq.set(seq, []);
    bySeq.get(seq).push(index);
  }
  const targets = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, imageIndexes]) => ({ seq, imageIndexes: imageIndexes.sort((a, b) => a - b) }));

  return { targets, total, offloading: picked.length, kept: kept.length };
}

/**
 * 带「触发阈值」的计划：**涨到 `trigger` 张才动手，一次省到只剩 `keep` 张**。
 *
 * `trigger = 0` 是"关掉"；`keep >= trigger` 的配置不许干活（否则一触发就白省），
 * 这里兜一次、`runOffload()` 里还会再报一次。
 *
 * @param {Array} events - `session.snapshotEvents()` 的结果
 * @param {{trigger?:number, keep?:number}} limits
 * @returns {{triggered:boolean, plan:object}}
 */
export function planOffloadWithTrigger(events, limits = {}) {
  const trigger = Math.max(0, Math.floor(Number(limits?.trigger) || 0));
  const keep = Math.max(0, Math.floor(Number(limits?.keep) || 0));

  const plan = planOffload(events, { keep });
  const triggered = trigger > 0 && trigger > keep && plan.total >= trigger && plan.offloading > 0;
  return { triggered, plan };
}

/**
 * 宿主有没有解释 `image/offload` 的那个投影插件。
 *
 * 没装时 `session.append` 抛的就是这句话（`surface.ts` 的 `planSurfaceEvent`），
 * 识别它就能把「今天这个宿主没有这个能力」和「这次算错了」分开：
 * 前者要永久退化，后者要报出来。
 */
export function isMissingCapability(reason) {
  return /requires a message projection/i.test(String(reason ?? ''));
}

/**
 * 把计划写进会话，并确认落盘。
 *
 * `session.append` 的校验很严（seq 必须是当前 surface 节点、index 严格递增、
 * 不能重复省略），所以**算完立刻写**，中间别 await 别的事情 —— 否则 surface 变了会被拒。
 *
 * @param {object} session - `agent.session`
 * @param {Array<{seq:number, imageIndexes:number[]}>} targets
 * @param {object|null} sessions - 用来 flush 的 sessions 服务（可空）
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function applyOffload(session, targets, sessions = null) {
  if (!session?.append) return { ok: false, reason: 'no-session' };
  if (!Array.isArray(targets) || targets.length === 0) return { ok: true, reason: 'nothing-to-do' };
  try {
    session.append('image/offload', { targets });
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    if (sessions?.flush) await sessions.flush(session);
  } catch {
    /* flush 失败不算失败：事件已经 append 进内存，下一次成功 flush 会带上 */
  }
  return { ok: true };
}

/** 把配置里的两个数洗成非负整数（坏值退回出厂值）。 */
function intOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * 自动省略的调度器：交付之后**不在这里等**，只排一个 `setTimeout(0)`。
 *
 * 三条规矩：
 *  - **交付不能被它拖慢**：重放日志要几十到几百毫秒，必须在交付之后单独跑；
 *  - **节流按会话记**：只有一个全局时间戳的话，A 刚交完图，30 秒内 B 交的图就不检查了；
 *  - **只动"图交给了的那个会话"**：会话 id 在交付那一刻同步定下来，不在定时器里现取
 *    （`watch` 阻塞期间别的会话调一次工具就能把它改掉）。
 *
 * @param {object} options
 * @param {object} options.ctx - 插件上下文（取 `sessionController` / `sessions`）
 * @param {(m:string)=>void} [options.log]
 * @param {()=>object} options.readConfig - 读 `see-now.json`（热读：改完 30 秒内生效，不用重开）
 * @param {(ctx:object, key:string)=>object|null} [options.serviceOf]
 * @param {()=>number} [options.now]
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 * @param {number} [options.throttleMs]
 */
export function createOffloadScheduler({
  ctx,
  log = () => {},
  readConfig,
  serviceOf = defaultServiceOf,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  throttleMs = OFFLOAD_THROTTLE_MS,
} = {}) {
  /** 每个会话上一次检查的时间 */
  const lastCheck = new Map();
  /** 挂着的定时器：dispose 时一次清掉 */
  const timers = new Set();
  const state = {
    /** `unknown` 还没试过 / `ok` 用过 / `missing` 这个宿主没有 image/offload */
    capability: 'unknown',
    lastAt: 0,
    lastPlan: null,
    lastError: null,
  };
  let disposed = false;

  function configNow() {
    const cfg = readConfig ? readConfig() : {};
    return {
      imageTrigger: intOf(cfg?.imageTrigger, OFFLOAD_DEFAULTS.imageTrigger),
      imageKeep: intOf(cfg?.imageKeep, OFFLOAD_DEFAULTS.imageKeep),
    };
  }

  /**
   * 交付完调一下：同会话 30 秒内只排一次，然后立刻返回。
   *
   * @param {string|null} sessionId - 图交给的那个会话
   * @returns {{scheduled:boolean, reason?:string}}
   */
  function afterDelivery(sessionId) {
    if (disposed) return { scheduled: false, reason: 'disposed' };
    if (!sessionId) return { scheduled: false, reason: 'no-session' };
    const cfg = configNow();
    if (cfg.imageTrigger === 0) return { scheduled: false, reason: 'disabled' };
    const t = now();
    const at = lastCheck.get(sessionId) ?? 0;
    if (at && t - at < throttleMs) return { scheduled: false, reason: 'throttled' };
    // 顺手清掉过了节流窗口的条目：进程常驻，会话来来去去，表不能只涨不消
    for (const [k, seenAt] of lastCheck) {
      if (t - seenAt >= throttleMs) lastCheck.delete(k);
    }
    lastCheck.set(sessionId, t);
    const timer = setTimer(() => {
      timers.delete(timer);
      // **绝不落成未处理的 rejection**：自动路径上没人 await 它，抛出去只会在宿主日志里飘一条
      void runNow(sessionId).catch((e) => log(`自动省略出错：${e?.message ?? e}`));
    }, 0);
    timer?.unref?.();
    timers.add(timer);
    return { scheduled: true };
  }

  /**
   * 真干活：解析会话 → 读日志 → 算计划 → 写事件。**绝不抛**（自动路径上没人接）。
   *
   * @param {string|null} sessionId
   * @returns {Promise<object>}
   */
  async function runNow(sessionId) {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (!sessionId) return { ok: false, reason: 'no-session' };
    if (state.capability === 'missing') return { ok: false, skipped: 'no-capability' };

    const cfg = configNow();
    if (cfg.imageTrigger === 0) return { ok: true, skipped: 'disabled' };
    if (cfg.imageKeep >= cfg.imageTrigger) {
      state.lastError = `imageKeep（${cfg.imageKeep}）必须小于 imageTrigger（${cfg.imageTrigger}）`;
      return { ok: false, reason: 'keep>=trigger' };
    }

    const sc = serviceOf(ctx, 'sessionController');
    if (!sc?.resolveAgent) {
      state.lastError = '没有 sessionController';
      return { ok: false, reason: 'no-session-controller' };
    }
    let resolved;
    try {
      resolved = await sc.resolveAgent(sessionId);
    } catch (e) {
      state.lastError = String(e?.message ?? e).slice(0, 120);
      log(`自动省略跳过：拿不到会话（${state.lastError}）`);
      return { ok: false, reason: 'resolve-failed' };
    }
    if (resolved?.error) {
      const why = String(resolved.error?.message ?? resolved.error).slice(0, 120);
      state.lastError = why;
      log(`自动省略跳过：拿不到会话（${why}）`);
      return { ok: false, reason: 'resolve-failed' };
    }
    const session = resolved?.agent?.session;
    if (!session) {
      state.lastError = '拿不到这个会话的 session';
      return { ok: false, reason: 'no-session' };
    }
    /**
     * `snapshotEvents()` 在宿主里标了 deprecated，但它是**唯一**能同步读到当前日志的公开口子，
     * surface 重放要的就是这份。真被删了会明确报出来，不会静默当成"没有图"。
     */
    let events;
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null;
    } catch (e) {
      events = null;
      state.lastError = `读会话日志失败：${String(e?.message ?? e).slice(0, 80)}`;
      log(`自动省略跳过：${state.lastError}`);
      return { ok: false, reason: 'no-events' };
    }
    if (!Array.isArray(events)) {
      state.lastError = '这个宿主版本读不到会话日志（snapshotEvents 没了）';
      log(`自动省略跳过：${state.lastError}`);
      return { ok: false, reason: 'no-events' };
    }

    const { triggered, plan } = planOffloadWithTrigger(events, {
      trigger: cfg.imageTrigger, keep: cfg.imageKeep,
    });
    state.lastPlan = triggered ? plan : null;
    if (!triggered) {
      state.lastError = null;
      return { ok: true, triggered: false, total: plan.total, trigger: cfg.imageTrigger, keep: cfg.imageKeep };
    }

    const r = await applyOffload(session, plan.targets, serviceOf(ctx, 'sessions'));
    if (!r.ok) {
      if (isMissingCapability(r.reason)) {
        // 这个宿主没有 image/offload 的解释器：以后不再试，状态里说清楚，不当成失败
        state.capability = 'missing';
        log(`这个宿主没有 image/offload（${r.reason}）—— 图库照常报数，不省略`);
        return { ok: false, skipped: 'no-capability' };
      }
      state.lastError = r.reason;
      log(`自动省略失败：${r.reason}`);
      return { ok: false, reason: r.reason };
    }

    state.capability = 'ok';
    state.lastError = null;
    state.lastAt = now();
    log(`自动省略：省了 ${plan.offloading} 张（保留 ${plan.kept} / 共 ${plan.total}）`);
    return { ok: true, triggered: true, ...plan };
  }

  /** 收工时清掉还没跑的定时器（插件卸载后不该再写会话）。 */
  function dispose() {
    disposed = true;
    for (const t of timers) clearTimer(t);
    timers.clear();
  }

  return { afterDelivery, runNow, state: () => ({ ...state }), dispose };
}

/** `ctx.get()` 优先、老宿主退回属性访问的取服务方式（和 index.js 的 serviceOf 同口径）。 */
function defaultServiceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 没声明 inject 时 get 陷阱会 throw */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

/**
 * `status` 里的「图库」行（纯函数，单测直接喂）。
 *
 * 任务口径：这一行至少报「本次采集出 N 张」；**只报"本次采集"**，不假装知道整个会话 —
 * 一张图落在宿主附件库里，被历史引用着，插件读不到别人的会话日志，所以这里不给"会话里一共几张"。
 *
 * 省略那半截按状态说人话：关着 / 宿主没有 / 配置无效 / 涨到多少省到多少 / 上次失败。
 *
 * @param {{sheets?:number, config?:object, state?:object}} input
 * @returns {string} 空串 = 这一行不出现（没出过图、也没出过事）
 */
export function offloadLine({ sheets = 0, config = {}, state = {} } = {}) {
  const n = Math.max(0, Math.floor(Number(sheets) || 0));
  const trigger = intOf(config?.imageTrigger, OFFLOAD_DEFAULTS.imageTrigger);
  const keep = intOf(config?.imageKeep, OFFLOAD_DEFAULTS.imageKeep);
  const capability = state?.capability ?? 'unknown';
  const lastError = state?.lastError ? String(state.lastError) : '';

  const noteworthy = n > 0 || capability === 'missing' || Boolean(lastError);
  if (!noteworthy) return '';

  let line = `图库：本次采集出 ${n} 张`;
  if (trigger === 0) line += ' · 省略关（imageTrigger=0）';
  else if (capability === 'missing') line += ' · 省略：宿主没有 image/offload（不省）';
  else if (keep >= trigger) line += ` · 省略配置无效（imageKeep ${keep} ≥ imageTrigger ${trigger}）`;
  else line += ` · 省略：涨到 ${trigger} 张省到 ${keep} 张`;

  if (lastError && capability !== 'missing') line += ` · 上次失败：${lastError.slice(0, 60)}`;
  return line;
}
