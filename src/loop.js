/**
 * loop.js — 常驻看屏幕：起钟、看有没有新图、到点叫醒模型。照搬 `watch-together/watch-loop.js` 的骨架。
 *
 * ## 为什么必须有这一层
 *
 * 最早这里是"模型调 `watch(20s)` → 拿一张图 → 回话 → 再调一次"。实测跑不住：
 * **模型拿到图、回完话就结束了**，用户看到"它答一句就没下文了"。
 * 模型没有理由主动再调一次 —— 它不知道下一次该什么时候调，也没人提醒它。
 *
 * 钟必须在插件里：
 *
 *   每 2 秒   本地判定（读一眼队列深度、窗还在不在），纯算术，几乎不花钱
 *   真该看时  叫醒模型（往会话投一条消息 = 模型跑一轮，这才贵）
 *
 * 用户看两小时 ≈ 几十次唤醒，不是几千次。
 *
 * ## 三个停下来的条件
 *
 * 1. **用户关掉悬浮窗** —— 那是"我不看了"最直接的意思。落一条 hangup，之后不再唤醒。
 * 2. **模型调 `stop`** —— 明确说不看了。
 * 3. **采集真的死了**（ffmpeg 退出、源断了）或**连续叫不醒**。
 *
 * ## 刻意不接 `exec.signal`
 *
 * 以前这里接的是工具调用的 signal，`aborted` 就停。那是**单次调用**的通知
 * （宿主类型注释：`abort signal shared by the step`），不是"一直看下去"这件事的状态。
 * 接上去的结果是：这一轮以任何方式结束，常驻循环就跟着死 —— 用户看到的就是
 * "它答一句就完了"。取消/超时的处理放在 `runner.watch()` 自己的等待循环里。
 */


import { startTicker, wakeWithRetry, deliveryMode } from './timer.js';import { windowAlive, windowPidAlive } from './window.js';
import { transcriptPath, transcriptRelPath } from './transcript.js';

import { appendSpoken, chatWatcherShared, chatWaiterCount, dshHome, lastSaidNote, markDelivered,
         markRelaySeen } from './chat.js';
import { noteInterjected } from './interject.js';
import { onSpeech, speechSubscribers } from './speech.js';
import { estimateSpeechMs, nextProactiveAt } from './pacing.js';
import { listenGap } from './listen.js';
import { appendLift, appendLiftDebug } from './lift/log.js';
import { createLift } from './lift/index.js';
import { bloodbarTailText, shouldGlance } from './bloodbar.js';

/**
 * 用户插话的"同一拍"判定（毫秒）。
 *
 * **不是冷却**：插话本身不做节流（人不会一秒钟发十条）。这 500ms 只用来挡住
 * "同一拍里连着来两条"——那种情况下面模型这一轮刚开头，`followup` 投进去
 * 必定变成排队消息。放回队里等下一拍再投，话不丢。
 */
const INTERJECT_GAP_MS = 500;

/**
 * 两张图之间至少隔这么久才叫醒模型。
 *
 * 动态画面 2~3 秒就出一张，按出图节奏叫，模型会每 3 秒说一句 —— 那是刷屏，不是陪看。
 * 8 秒是"不快于一口气说完两句话"的下限；真该说的时候（用户插话）不受这个限制。
 */
const WAKE_MIN_GAP_MS = 8000;

/**
 * 一次叫醒最多等多久（毫秒）。
 *
 * `sessions.flush()` 会等当前回合落定 —— 模型跑长回合时它能挂几分钟，
 * 而钟的 `running` 守卫会把后面的每一拍都挡掉：循环"活着但不动"（2026-11-10 实测，
 * 黑听时表现为台词一直进池、抬头却再也不发生）。超过这个时间就当这一拍没叫。
 */
const WAKE_TIMEOUT_MS = 10_000;
/**
 * 听到新台词时的最快唤醒间隔。
 *
 * 原来的口径是「攒够一张新图就叫」，配合 `pace` 的 15 秒，放视频时等于
 * 每小时 240 轮 —— 屏幕一直在动，但绝大多数时候没有任何值得说的事。
 * 现在的口径是「听到新台词才叫」，这个常量压它的频率上限。
 */
const LINE_WAKE_GAP_MS = 60_000;
/**
 * 完全没有台词时的兜底唤醒间隔。
 *
 * 为什么要有：纯画面、无配音的内容（信息全在画面上）永远不产生台词，
 * 只有台词门控的话它会被彻底漏掉。15 分钟报一次平安，成本可忽略。
 */
const IDLE_WAKE_MS = 15 * 60_000;
const TICK_MS = 2000;

/**
 * 「合并唤醒」的预算（2026-11-16 用户要求：「可以合并」）。
 *
 * 连续对白时原来是每 30 秒醒一次，一晚几百轮；合并后 2 分钟内的话攒成一条。
 * 但合并带来一个新风险：**一条唤醒可能无限长** —— 2 分钟按每 2–3 秒一句能到
 * 40–90 句、上千字，既费 token 也可能把窗口气泡撑爆。所以这里写死预算：
 * 单条最多 12 句 / 600 字，**超了从最旧的丢**（新台词更相关），并如实写「另有 N 句未列」。
 *
 * 配 `test/merge-said.test.mjs` 守着 —— 这两个数只能有意地改，不能被顺手调宽松。
 */
export const MERGE_WINDOW_MS = 120_000;
/** 说话停了（静音/没数据）且已经攒下至少 2 句 → 提前结账，别让尾巴等满 2 分钟。 */
export const MERGE_QUIET_FLUSH_MS = 20_000;
export const MERGE_MAX_LINES = 12;
export const MERGE_MAX_CHARS = 600;

/**
 * 相邻两句间隔小于这个值就当成**同一句**拼回去（毫秒）。
 *
 * 实测量出来的：`see-now/transcript/2026-11-17.jsonl` 里 61 句平均 8.9 个字，
 * 相邻间隔中位数 **0.2 秒**、60 个间隔里 35 个不到 0.5 秒 —— 断句器在 0.35 秒的
 * 气口就切，于是一句话被切成「机会。能力量。」「相信。虽然你可能会。」这种半截。
 * 参数侧已把 silence 放到 0.6 秒；这里再兜一层：**拼回去给模型看**。
 */
export const MERGE_JOIN_GAP_MS = 600;

/**
 * 把切碎的相邻台词拼回整句：间隔 ≤ `gapMs` 的连成一条（t0 取前、t1 取后）。
 *
 * @param {Array<{t0?:number,t1?:number,text?:string}>} lines 按时间正序
 * @returns {Array<{t0:number,t1:number,text:string}>}
 */
export function joinFragments(lines, { gapMs = MERGE_JOIN_GAP_MS } = {}) {
  const out = [];
  for (const l of lines ?? []) {
    const text = String(l?.text ?? '').trim();
    if (!text) continue;
    const t0 = Number(l?.t0) || 0;
    const t1 = Number(l?.t1) || t0;
    const spk = String(l?.spk ?? '').trim() || null;
    const prev = out[out.length - 1];
    // 说话人不同就不拼 —— 两个人快速接话时，拼起来会读成同一人在说
    if (prev && prev.spk === spk && t0 - prev.t1 <= gapMs) {
      prev.text += text;
      prev.t1 = Math.max(prev.t1, t1);
      continue;
    }
    out.push({ t0, t1, text, spk });
  }
  return out;
}

/**
 * 这批台词从"第一句"到"现在"过了多久（毫秒）。
 *
 * 单独抽出来是因为踩过：`lastAudioWakeAt` 的初值是 `0`（"从没叫过"），
 * 直接 `now - 0` 会得到 1794843709 秒那种"上次叫醒在 1970 年"的跨度
 * （2026-11-16 实报，第一句合并唤醒就写着「这 1794843709 秒里」）。
 * 没叫过时以**这批第一句**为基准。
 */
export function mergeSpanMs(now, lastWakeAt, firstT0) {
  const base = Number(lastWakeAt) || Number(firstT0) || Number(now);
  return Math.max(0, Number(now) - base);
}

/**
 * 把一段台词压成一条唤醒正文：**先保最新的**，到预算就停。
 *
 * @param {Array<{text?: string}>} lines 按时间正序
 * @returns {{lines: string[], text: string, dropped: number}}
 */
export function mergeSaid(lines, { maxLines = MERGE_MAX_LINES, maxChars = MERGE_MAX_CHARS } = {}) {
  const all = (lines ?? [])
    .map((l) => ({
      text: String(l?.text ?? '').trim(),
      spk: String(l?.spk ?? '').trim() || null,
    }))
    .filter((x) => x.text);
  const picked = [];
  let chars = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const { text: t, spk } = all[i];
    // 有编号就带上前缀，读的人一眼知道换人了
    const shown = spk ? `${spk}: ${t}` : t;
    if (picked.length >= maxLines) break;
    // 至少留一句：哪怕单句就超预算，也不能返回空
    if (picked.length && chars + shown.length > maxChars) break;
    picked.push(shown);
    chars += shown.length;
  }
  picked.reverse();
  return { lines: picked, text: picked.join(' / '), dropped: all.length - picked.length };
}


/**
 * 台词全文落盘（2026-11-16 用户选方案 2：“落盘 + 摘要”）。
 *
 * 唤醒里只带 12 句摘要（省常驻 token），**没列出来的句子不丢**——
 * 按天写进 `$DSH_HOME/see-now/transcript/<YYYY-MM-DD>.jsonl`，唤醒末尾给路径。
 * 想要"听全"就按需读文件：读取只在那一刻花 token，不占每条唤醒。
 */
export { transcriptEntry, transcriptPath, transcriptRelPath, writeTranscript } from './transcript.js';

/** 连续这么多次叫不醒就停：会话没了还每 8 秒烧一次模型，是最贵的失败模式 */
const WAKE_FAILS_MAX = 2;

/** 没开悬浮窗、用户又这么久没说话 → 认为没人看，收工 */
export const IDLE_STOP_MS = 3 * 60 * 1000;
/** 连续这么多次自动唤醒都没有用户搭理 → 收工（防"窗开着但人走了"/模型自己读图循环） */
export const MAX_AUTONOMOUS_WAKES = 8;

/**
 * 该不该因为「没人在看」收工 —— 抽成纯函数，好测也好读。
 *
 * 社区实报「装上后卡读图循环」：常驻循环原来**只有"采集停了"一个退出条件**，
 * 屏幕一直动（放视频、刷网页）就会每 15 秒叫醒模型一次，永远不停。
 */
/**
 * 判到 idle 之后该干什么。
 *
 * `stop` = 彻底收工（窗都没了，留着循环只是白烧）；`listen` = 只停采集、**留着耳朵**。
 *
 * 社区实报 2026-11-03：窗开着、循环因为连续叫不醒收工，用户之后在窗里打的字
 * 没有任何人读 —— 可那扇窗还摆在屏幕上，他当然以为自己在跟它说话。
 */
export function idleAction({ idle = false, windowOpen = false } = {}) {
  if (!idle) return 'continue';
  return windowOpen ? 'listen' : 'stop';
}

export function shouldGoIdle({
  wakesSinceUser = 0, now = Date.now(), lastUserAt = now, windowOpen = false,
  maxWakes = MAX_AUTONOMOUS_WAKES, idleStopMs = IDLE_STOP_MS,
} = {}) {
  // 两条线都能由 ~/.dsh/see-now.json 覆盖（#8）：写死的 8 次在悬浮窗开着时
  // 就是实际的最长陪看时长，想陪久一点的人只能改源码。
  if (maxWakes > 0 && wakesSinceUser >= maxWakes) return true;
  // 悬浮窗开着 = 有人在陪看，中途不说话是正常的，只靠"叫太多次"兜底
  // idleStopMs <= 0 = 用户主动关掉这条（愿意一直陪着）
  if (!windowOpen && idleStopMs > 0 && now - lastUserAt > idleStopMs) return true;
  return false;
}

/**
 * 窗"看起来没了"要连续这么多拍才认（一拍 2 秒）。
 *
 * 心跳本来是 6 秒算过期，用来决定"要不要重开窗"是合适的；但机器睡一觉醒来、
 * 或者窗口主线程被 DWM/抓屏拖住几秒，心跳一样会过期，而用户什么都没做。
 */
export const WINDOW_GONE_TICKS = 3;

/**
 * 窗"没了"该怎么判 —— 抽成纯函数，好测也好读。
 *
 * **为什么不能直接 `!windowAlive()` 就挂断**：`windowAlive()` 回答的是
 * "这窗还能用吗"（心跳 6 秒过期就算不能用，宁可重开一个），而这里要回答的是
 * **"用户是不是不看了"**。两个问题共用一个判据的后果是单向的：
 *   - `index.js` 的 `onStop` 看到 `window-closed` 会落一条挂断说明，内容是
 *     "用户关掉了悬浮窗 —— 用户关它就是在说「不看了」……不要再调 see_now"；
 *   - 还会 `runner.hangUp()`，之后 `watch` 一律被硬闸拦（`guardReason`）。
 * 也就是说：**一次心跳抖动 = 这个会话再也回不来**，用户看到的就是"它自己结束了"。
 * 实测复现：pid 指向活着的进程、只把心跳文件的 mtime 往前拨 8 秒，
 * 循环第一拍就 `window-closed`。
 *
 * @returns {'closed'|'stalled'|null}
 *   - `closed`：进程真没了（用户关的，或它崩了）→ 照旧停 + 挂断
 *   - `stalled`：进程还在、只是心跳断了 → 连续够多拍才停，**且不挂断**，
 *     下一条 `watch` 能自己把窗重开起来
 */
export function windowVerdict({ wasOpen = false, alive = false, pidAlive = false, goneTicks = 0 } = {}) {
  if (!wasOpen || alive) return null;
  if (!pidAlive) return 'closed';
  return goneTicks >= WINDOW_GONE_TICKS ? 'stalled' : null;
}

/**
 * 关窗说明。**不投 followup**（那会进排队消息区），由 `runner.note()` 挂着，
 * 下一次工具结果带走 —— 和陪看的 `markHungUp` 同一个路子。
 */
export const HANGUP_NOTE = '[看屏幕·挂断] 悬浮窗被关掉了 —— 用户关它就是在说「不看了」。\n'
  + '采集已经停，不会再出图。**不要再自动调 see_now**，也不要再说话。\n'
  + '只回一句短的（用 `say`，否则他看不到），比如"好，先停在这儿"。\n'
  + '他明确说要看时有三条路：① `see_now({action:"window", show:true})` 开回窗并解除挂断，再 `watch`；'
  + '② 他自己把窗点开；③ 本地视频 `watch` 带 `source:"file"`。';

/**
 * 起一个常驻循环。
 *
 * @param {object} o
 * @param {object} o.ctx 宿主上下文（叫醒要用）
 * @param {string} o.sessionId **起循环时的那个会话** —— 只是兜底（见 `getTargetSession`）。
 * @param {() => string|null} [o.getSessionId] 兜底（起循环时还没拿到 id 的情况）
 * @param {() => string|null} [o.getTargetSession] **每次叫醒前现取**投递目标，一般是
 *   `boundSessionNow()`（`~/.dsh/see-now.json` 的 `session`）。见下面「循环跟着窗口走」。
 * @param {object} o.runner createRunner() 的返回值
 * @param {(m:string)=>void} [o.log]
 * @param {(reason:string)=>void} [o.onStop] 停下来时回调（落挂断说明之类）
 * @param {number} [o.wakeMinGapSec] 两张图之间的最小叫醒间隔
 * @returns {{dispose:()=>void, state:()=>object, stopped:()=>boolean}}
 */
export function startLoop({
  ctx, sessionId = null, getSessionId = () => null, getTargetSession = null, runner,
  log = () => {}, onStop = () => {}, wakeMinGapSec = WAKE_MIN_GAP_MS / 1000,
  /**
   * 这条会话此刻是不是真的在跑回合（`index.js` 从 `turnStates` 现取）。
   * 用户插话只在"真在跑"时走 `steer`；打在空闲会话上的 steer 会起空回合被 blocked。
   */
  turnRunning = () => false,
  /**
   * 这条会话的模型上一回合**结束**在什么时候（`index.js` 从 `turnStates` 现取）。
   * 「活跃对话」判定用：刚回合过 = 人还在旁边 → 强命中可以从「瞥」升成「看」。
   */
  lastTurnEndAt = () => 0,
  // 逐帧模式：唤醒文案要说"换画面了，说一句这是什么"，而不是"有新画面了"。
  scene = false,
  /**
   * 起循环时就已经处在「仅监听」。
   *
   * **必须在造循环时就定好模式**：先造 active 循环、再调 `enterListen()` 会有一个竞态 ——
   * 第一拍可能先跑，看到"采集没在跑"就判成 `capture-stopped` 把循环杀了
   * （2026-11-08 实踩：`listen` 之后 status 是「已停（capture-stopped）」）。
   */
  listen: startInListen = false,
  // `~/.dsh/see-now.json` 的节奏参数（readTuning()）；不传就用写死的默认值。
  tuning = null,
} = {}) {
  let disposed = false;
  // 初始化为"刚叫过"而不是 0：否则 `idleDue` 在首拍恒真，
  // 一启动就会先兜底叫一次 —— 用户什么都没发生就被叫了，体验像 bug。
  let lastWakeAt = Date.now();
  /** 上次叫醒时「听了多少句台词」（listen.total 是单调递增的累计值）。 */
  let lastLineTotal = 0;
  let wakeFailures = 0;
  let consecutiveFails = 0;
  let wakeCount = 0;
  let stopReason = null;
  /**
   * 上一句真正出声的时刻与估计时长（见 pacing.js）。
   *
   * 只认 `spoken`（适配器开始播放的那一瞬）：`due` 是"打算念"，离真出声还隔着合成，
   * 拿它当起点会把等待算短。没有声音适配器时永远收不到 `spoken`，节奏就退回旧的 8 秒。
   */
  let lastSpeechAt = 0;
  let lastSpeechMs = 0;
  /**
   * 节奏口径（`~/.dsh/see-now.json` 的 speechPacing）：
   *   true / 'follow'（默认）= 上一句说多久，下一句就隔多久；
   *   'guard' = 旧间隔与"说完+气口"取更晚，只在长句时推迟；
   *   false = 关掉，纯固定间隔。
   */
  const pacingMode = (() => {
    const v = tuning?.speechPacing;
    if (v === false) return 'off';
    return v === 'guard' ? 'guard' : 'follow';
  })();
  const followSpeech = pacingMode !== 'off';
  const offSpeech = onSpeech((e) => {
    if (!followSpeech) return;
    const state = e?.state;
    // 有声音适配器：等 `spoken`（真正开始播放）。没有声音：`due` 就是"这话已经给用户看了"，
    // 按它算，免得没装语音的用户被同一句文字刷屏。
    if (state !== 'spoken' && !(state === 'due' && speechSubscribers() === 0)) return;
    const ms = estimateSpeechMs(e.text);
    if (!ms) return;
    lastSpeechAt = Date.now();
    lastSpeechMs = ms;
  }, { voice: false });
  /** 起循环时的会话（兜底值；真正投递目标见 `resolveTarget`） */
  const owner = sessionId ?? getSessionId() ?? null;
  /**
   * **循环跟着窗口走**（2026-11-06 用户要求）。
   *
   * 投递目标 = 窗口**现在**绑定的那个会话，每拍现取。以前这里用"起循环时定下的
   * `owner`"，于是换会话之后循环还一直投旧会话；而 relay 有「有常驻循环就让开」的闸，
   * 它让着循环、一句日志都不写 —— 用户侧就是"我在窗里打了字，它一声不响"（实报）。
   *
   * 兜底：取不到绑定（没有 `see-now.json` / 读盘失败）时退回 `owner`。
   * 换目标时写一行日志 + 一行灰字进窗，不静默改口。
   */
  let target = owner;
  const targetLabel = (sid) => (sid ? String(sid).replace(/^session-/, '').slice(0, 8) : '无');
  const resolveTarget = () => {
    let next = null;
    try { next = getTargetSession?.() ?? null; } catch { next = null; }
    if (!next || next === target) return target;
    const from = target;
    target = next;
    log(`投递会话变更：${targetLabel(from)} → ${targetLabel(next)}（循环跟着窗口换绑）`);
    try {
      appendSpoken('meta', `（窗口换绑到 ${targetLabel(next)}，接着看。）`, { speak: false });
    } catch { /* 写不进不影响投递 */ }
    return target;
  };
  /**
   * 目标会话**此刻正跑着一轮**吗。
   *
   * 跑着的话，任何叫醒都只能以"排队消息"的形式等这一轮结束 —— 等模型看见它，
   * 内容已经是几分钟前的了，模型还得为它回一整轮（用户侧看到的就是
   * "一堆过期唤醒，每条都要回一句『太晚了，不看』"）。2026-11-16 实测：
   * 23:07 / 23:08 / 23:13 三条仅监听唤醒分别在 23:13–23:17 才弹进来。
   *
   * 所以这种时候**不叫**，改落一条待领说明（`runner.note`），
   * 让模型下一次工具结果顺手带走 —— 既不排队，也不丢信息。
   */
  const targetBusy = () => {
    const to = resolveTarget();
    if (!to) return false;
    try { return Boolean(turnRunning(to)); } catch { return false; }
  };
  /** 把"本来想叫醒"的一句话落成待领说明，等下一次工具结果带走。 */
  const parkAsNote = (text) => {
    try { runner.note?.(text); } catch { /* 记不进就算了 */ }
    log(`[listen] 目标会话正忙，改记待领说明（${String(text).slice(0, 70)}）`);
  };
  /** 上一张已经叫过的图（`#序号` 或 `p脉冲`），同一张永不重复叫 */
  let lastKey = null;
  /** pending 0→1 的脉冲计数：拿不到出图序号时靠它认"新的一张" */
  let pendingPulse = 0;
  let lastPending = 0;
  /** 采集停掉之后已经过了几拍 —— 用来给"队列里剩下的图"一个播报窗口，然后收工 */
  let deadTicks = 0;
  let lastWakeOk = null;
  /**
   * 「没人在看」的收工线（判据见 `shouldGoIdle`）。
   *
   * 社区实报「装上后会卡读图循环」—— 因为常驻循环**只有"采集停了"一个退出条件**。
   * 只要屏幕一直在动（放视频、刷网页），它就会每 `wakeMinGapSec` 叫一次模型、
   * 模型看一眼图回一句、下一张再叫一次，**永远不停**。用户什么都没问，会话却在
   * 一轮一轮读图。
   *
   * 两条收工线，互为兜底：
   *   - `IDLE_STOP_MS`：**没开悬浮窗**（没人看那个小窗）且用户超过 3 分钟没说话 → 停。
   *     悬浮窗开着就不判 —— 那是陪看场景，2 小时的电影中途不说话是正常的。
   *   - `MAX_AUTONOMOUS_WAKES`：连续叫了这么多次都没人搭理 → 停。
   */
  let lastUserAt = Date.now();
  let wakesSinceUser = 0;
  /** 窗"看起来没了"连续几拍（判据见 `windowVerdict`） */
  let windowGoneTicks = 0;

  /**
   * 自己盯 chat.jsonl 里的新用户消息。
   *
   * **不能靠 `pendingInterjected()`**：那个东西在提醒过一次之后就被标记成"念过了"，
   * 于是用户再说一句它也看不见。而且常驻模式下 `runner.watch()` 早就返回了 ——
   * 那里面的插话检测根本没机会跑。所以循环必须自己有一双眼睛。
   */
  const pollChat = chatWatcherShared();
  /**
   * 还没被处理掉的插话（一次只处理一条，剩下的留着下一拍）。
   *
   * 存 `{text, at}` 而不是纯文本：`at` 是这条消息在 `chat.jsonl` 里的键，
   * 投递成功/失败后要拿它写回执（窗口据此显示「发送中 / 已送达」）。
   */
  const queue = [];

  /**
   * `active` = 正常干活；`listen` = **只听不说话**。
   *
   * 为什么需要这个状态（社区实报 2026-11-03）：悬浮窗开着、但循环因为"连续叫不醒"
   * 已经收工，于是用户之后在窗里打的字**没有任何人读**。可那扇窗还明晃晃摆在屏幕上，
   * 用户当然以为自己在跟它说话。
   *
   * 收工 ≠ 拆掉耳朵。这里让循环停掉采集（省资源），但**留着 ticker 继续盯 chat.jsonl**：
   * 一旦有人开口，立刻回到 active 去唤醒模型。采集不自动重启 —— 模型要看图会调 `peek`，
   * 那时才启动，用户的 region / 清晰度设置才不会被冲掉。
   */
  let mode = startInListen ? 'listen' : 'active';
  /**
   * 用户分配了「盯着」任务的模式（`watch({task:"…"})`）。
   *
   * 和自主模式的区别只有一条：**不收工、不降级**。用户说"我走开一会儿，你帮我看着"，
   * 那这就是一份托付 —— 看到他说"我回来了"为止，不能因为"没人说话"自己先溜了。
   */
  let pinned = false;
  /**
   * 采集是**我们自己为了进只听模式停掉的**。
   *
   * 没有这个标志的话，退出只听后的第一拍就会看到 `!alive` —— 那本来是我们主动停的，
   * 却会被下面 ② 判成 `capture-stopped`，于是用户刚说一句话，循环整个收工。
   */
  let pausedByListen = startInListen;

  const enterListen = () => {
    if (mode === 'listen' || disposed) return;
    mode = 'listen';
    pausedByListen = true;
    log('进入仅监听：停画面，但耳朵留着');
    // **只停画面**：耳朵留着，才有「听到东西 → 判断值不值得看」这条路
    try { runner.stopVision('仅监听'); } catch { /* 已经停了 */ }
    try {
      appendSpoken('meta', '（先只听着，画面先不看了。听到值得看的我会自己抬眼看。）', { speak: false });
    } catch { /* 写不进不影响听 */ }
  };
  /** 自己抬眼看：停着的画面重新拉起来（模型决定"值得看"时调用）。 */
  const leaveListen = () => {
    if (mode !== 'listen') return false;
    mode = 'active';
    pausedByListen = false;
    log('离开仅监听：重新开始看画面');
    return true;
  };

  /**
   * 仅监听的音频门控状态。
   *
   * `lastAudioKind` 是上一段"叫醒过"的声音形状 —— **同形状不重复叫**：
   * 一段 135 BPM 的歌放半小时，不该每两分钟叫你一次。
   */
  let lastAudioKind = null;
  let lastAudioWakeAt = 0;
  /**
   * 已经报过的最新一句台词的 `t0`（毫秒）。
   *
   * **不能用 `lastAudioWakeAt` 兼这个用**：叫醒那一刻之后才有句开始（t0 落在叫醒之前）
   * 的台词会被漏掉；而初值 0 又会让"从没叫过"被算成"上次叫醒在 1970 年"
   * —— 2026-11-16 实报：合并唤醒第一句写成「这 1794843709 秒里听见 1 句」。
   */
  let lastHeardT0 = 0;
  let unansweredListenWakes = 0;
  /** 攒台词时上一次记过的句数（只在变化时写日志，免得每 2 秒刷一行）。 */
  let lastMergePending = 0;
  /**
   * 黑听抬头的编排（判档 / 取帧 / 记账 / 叫醒）在 `src/lift/index.js`。
   *
   * 这里只留端口接线：`startLoop` 拥有共享退避线（`lastAudioWakeAt` /
   * `unansweredListenWakes`）和窗口 sink，`createLift` 只问「能不能叫」——
   * 退避线各开一条的话，同一拍能连着叫两次。
   */
  /**
   * 最近一次**用户真的说了话**的时刻（毫秒；0 = 还没说过）。
   *
   * **不能用 `lastUserAt`**：那个在循环启动时初始化成 `Date.now()`，拿它判「活跃对话」
   * 会让"刚进仅监听"之后的 5 分钟内每一次强命中都算有人陪 → 一律叫醒。
   * 这里只在真的收到用户消息时更新。
   */
  let lastUserSpokeAt = 0;
  /** 上一次写心跳的时间（毫秒）：60 秒一条，落在 `lift/debug.log`。 */
  let lastHeartbeatAt = 0;
  /** 任务模式里已经记进 `missed.jsonl` 的出图序号（每张图只记一次） */
  let lastMissedSeq = 0;
  /** 血条（P1c）：上一次因为低血记「瞥」的时刻（冷却用；0 = 还没记过）。 */
  let lastBloodbarGlanceAt = 0;

  const lift = createLift({
    config: {
      enabled: tuning?.lift?.enabled !== false,
      level: tuning?.lift?.level ?? 'glance',
      holdSec: tuning?.lift?.holdSec,
    },
    now: () => Date.now(),
    senses: {
      recentLines: (from, to) => runner.recentLines?.(from, to) ?? [],
      frameAt: (t0) => runner.frameAt?.(t0) ?? { ok: false, reason: 'no-frame' },
      framePng: (t0) => runner.framePng?.(t0) ?? { ok: false, reason: 'no-frame' },
      still: () => { try { return runner.still?.() ?? null; } catch { return null; } },
      turnEndAt: () => {
        try {
          const sid = getTargetSession?.() ?? sessionId;
          return Number(lastTurnEndAt?.(sid)) || 0;
        } catch {
          return 0;
        }
      },
      lastUserSpokeAt: () => lastUserSpokeAt,
    },
    sinks: {
      record: (rec) => appendLift(rec),
      debug: (text) => appendLiftDebug(text),
      glance: (text) => { try { appendSpoken('meta', text, { speak: false }); } catch { /* 窗不在也能记账 */ } },
      // 唤醒文案末尾带一行血条读数：**只报告，不唤**（P2 的取舍，见 bloodbarTail）
      wake: (text) => wake(`${text}${bloodbarTail()}`),
      hint: () => lastSaidHint(),
      log,
    },
    gate: {
      canWake: (at) => at - lastAudioWakeAt >= listenGap(unansweredListenWakes),
      noteWake: (at) => { lastAudioWakeAt = at; unansweredListenWakes += 1; },
      noteNoAnswer: () => { unansweredListenWakes = Math.max(0, unansweredListenWakes - 1); },
    },
  });

  /**
   * 血条读数的一句话（P2：**只报告，不唤**）。
   *
   * 2026-11-15 定：血条不是触发器。低血不叫醒模型，只在**本来就发生的唤醒**里
   * 把事实写出来（此刻 x%、30 秒前多少、近 60 秒区间、上次低血什么时候），
   * 要不要 `watch` 看一眼由模型自己决定。理由：那种「一个人操控多个角色、
   * 战斗中随时把另一个切到前台」的游戏里，切人 / 奶妈 / 免死
   * 都会让「某个角色掉到 30%」只出现一小会 —— 按阈值唤只会反复白瞥。
   *
   * 没有读数（没框 / 没在采 / 框里没有血条）时返回空串，**不写「血条正常」**。
   */
  function bloodbarTail() {
    let note = null;
    try { note = runner.bloodbarNote?.() ?? null; } catch { note = null; }
    return bloodbarTailText(note);
  }

  /**
   * 血条低了就记一条「瞥」（P1c）。
   *
   * 只记账 + 窗内一行灰字：**不出图、不叫醒**。血条那条窄带本身没有场景可看，
   * 就算取一帧也只能看到一条白条；真要判断"还有没有翻盘空间"，等模型被别的东西
   * 叫醒之后再 `watch`。阈值与冷却都在 `shouldGlance()` 里（纯函数，单测过）。
   */
  function maybeGlanceBloodbar() {
    let st = null;
    try { st = runner.status()?.bloodbar ?? null; } catch { st = null; }
    if (!st?.reading) return;
    const now = Date.now();
    if (!shouldGlance({ reading: st.reading, now, lastGlanceAt: lastBloodbarGlanceAt })) return;
    lastBloodbarGlanceAt = now;
    const pct = Math.round(st.reading.ratio * 100);
    const limit = Math.round((st.threshold ?? 0.3) * 100);
    const clock = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
    try {
      appendLift({
        at: now, wall: st.reading.at, level: 'glance', trigger: 'bloodbar',
        text: `血量 ${pct}%`, frameAt: null, spoke: false,
        reason: `血条 ${pct}% 低于阈值 ${limit}%`,
      });
    } catch { /* 记账失败不影响听 */ }
    try {
      appendSpoken('meta', `🩸 ${clock} 血量 ${pct}%（阈值 ${limit}%），可以瞥一眼`, { speak: false });
    } catch { /* 窗不在也能记账 */ }
  }

  /**
   * 「值不值得抬头」：插件只摆事实（最近 60 秒的轨迹），**预测和取舍交给模型**。
   *
   * 为什么是轨迹而不是一句"有声音"：人要判断"之后会发生什么"，得先知道
   * 「刚才静音了 30 秒、现在节拍刚起来、音量还在升」——这三件事合起来才有预测价值。
   */
  async function maybeWakeFromAudio() {
    const now = Date.now();
    let traj = null;
    try { traj = runner.trajectory?.(now - 60_000, now) ?? null; } catch { traj = null; }
    const seg = traj?.segments?.[traj.segments.length - 1];
    if (!seg) return;
    /**
     * **只认新台词**（2026-11-16 用户要求：「这种意义不大的唤醒还不如省掉算了」）。
     *
     * 以前只要声音形状变了（人声突出 → 有声 → 起节拍）就叫一轮，唤醒里除了
     * "有声音"什么都没给 —— 模型只能抬眼看图才知道发生了什么，等于花一轮 token
     * 换一句"我不知道该看什么"。暂停游戏时的 BGM + 人群低语正好是重灾区：
     * 声学层判「人声突出」没错，但它不是"值得打扰的消息"。
     *
     * 现在的口径：**只有转出定稿台词才叫**；纯音乐/音效/环境声不叫，
     * 但照样记 `lastAudioKind`（之后从这类声音转成说话还能正常叫一次）。
     */
    let rawFresh = [];
    try {
      rawFresh = (runner.recentLines?.(now - 300_000, now) ?? [])
        .filter((l) => l && l.partial === false && String(l.text ?? '').trim()
          && Number(l.t0) > lastHeardT0);
    } catch { rawFresh = []; }
    if (!rawFresh.length) {
      if (seg.kind !== lastAudioKind) {
        lastAudioKind = seg.kind;
        log(`[listen] 声音变了（${seg.kind}）但没听见新台词，不叫醒`);
      }
      return;
    }
    /**
     * 断句器切得太碎（实测：相邻间隔中位数 0.2 秒、平均一句 8.9 个字），
     * 先按 `joinFragments` 把半截话拼回整句，再进摘要/落盘 ——
     * 否则模型看到的是「机会。能力量。」这种读不懂的碎片。
     */
    const fresh = joinFragments(rawFresh);
    /**
     * **合并**（2026-11-16 用户要求「可以合并」）：有新台词也不立刻叫，
     * 等攒够 `MERGE_WINDOW_MS`，或者说话停了（静音 + 至少 2 句）再结账。
     * 一条唤醒最多带 `MERGE_MAX_LINES` 句 / `MERGE_MAX_CHARS` 字（见 mergeSaid）。
     *
     * 时间窗从**这批台词的第一句**算起，不从 `lastAudioWakeAt` 算 ——
     * 后者初值是 0（"从没叫过"），直接相减会得到 1794843709 秒那种数。
     */
    const merged = mergeSaid(fresh);
    const firstT0 = Number(rawFresh[0]?.t0) || now;
    const spanMs = mergeSpanMs(now, lastAudioWakeAt, firstT0);
    const quiet = seg.kind === 'silent' || seg.kind === 'nodata';
    const dueByWindow = spanMs >= MERGE_WINDOW_MS;
    const dueByQuiet = quiet && spanMs >= MERGE_QUIET_FLUSH_MS
      && (merged.lines.length >= 2 || spanMs >= 45_000);
    if (!dueByWindow && !dueByQuiet) {
      if (fresh.length !== lastMergePending) {
        lastMergePending = fresh.length;
        log(`[listen] 攒台词 ${fresh.length} 句（这批已 ${Math.round(spanMs / 1000)}s）`);
      }
      lastAudioKind = seg.kind;
      return;
    }
    // 被退避挡掉的这一拍**不**加 unanswered —— 那不是"叫了没人理"
    if (now - lastAudioWakeAt < listenGap(unansweredListenWakes)) return;

    lastMergePending = 0;
    lastAudioKind = seg.kind;
    lastAudioWakeAt = now;
    lastHeardT0 = Math.max(lastHeardT0, Number(rawFresh[rawFresh.length - 1]?.t0) || 0);
    unansweredListenWakes += 1;
    const clock = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
    const spanSec = Math.max(1, Math.round(spanMs / 1000));
    const when = spanSec >= 30 ? `这 ${spanSec} 秒里` : '刚刚';
    const dropped = merged.dropped
      ? `\n（只列最新的 ${merged.lines.length} 句，另有 ${merged.dropped} 句未列；`
        + `全文 ${transcriptRelPath(now).replace(/\\/g, '/')}）` : '';
    const text = `[仅监听] ${clock} · ${when}听见 ${fresh.length} 句：\n`
      + `${merged.text}${dropped}\n`
      + (fresh.some((l) => l.spk) ? '（S1/S2 是按声纹聚出来的编号，不是名字）\n' : '')
      + '值得看就 `see_now({action:"watch"})` 看 2–3 张；不值得就什么都别做，我继续听。'
      + lastSaidHint()
      + bloodbarTail();
    if (targetBusy()) {
      parkAsNote(`[黑听·待领] ${clock} ${when}听见 ${fresh.length} 句：${merged.text}`);
      unansweredListenWakes = Math.max(0, unansweredListenWakes - 1);
      return;
    }
    const ok = await wake(text);
    if (!ok) unansweredListenWakes = Math.max(0, unansweredListenWakes - 1);
  }

  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    log(`循环停了：${reason}`);
    // 自动收工要在窗口里留一行灰字，不然用户只会觉得"它突然哑了"
    if (reason === 'idle') {
      try { appendSpoken('meta', '（有一阵没人说话了，我先停一停；要看再说一声。）', { speak: false }); } catch { /* 写不进不影响停 */ }
    }
    try { onStop(reason); } catch { /* 停不下来也要停 */ }
    dispose();
  };

  /** 上一句说过什么（给唤醒文案用）：别让它在同一个屏幕上把同一句感慨说两遍 */
  function lastSaidHint() {
    return lastSaidNote({ maxAgeSec: 300, clipLen: 70 });
  }

  async function wake(text, { cooldownMs = WAKE_MIN_GAP_MS, steer = false } = {}) {
    const to = resolveTarget();
    if (!to) {
      // 没有目标就给个明确说法：静默返回会让"叫不醒"看起来像采集坏了
      log('没有可投递的会话（窗口没绑定），这一拍不叫');
      return false;
    }
    // `steer` 只是"允许插话"；真的插不插话看目标会话有没有在跑回合 ——
    // 打在空闲会话上的 steer 会起一个空回合、立刻 blocked（见 deliveryMode 的注释）。
    const mode = steer ? deliveryMode({ running: turnRunning(to) }) : 'followup';
    lastWakeAt = Date.now();
    /**
     * **叫醒必须有上限**（2026-11-10 实测）：`wakeWithRetry` 里 `sessions.flush()` 会等
     * 当前回合落定 —— 模型正在跑长回合时它能挂几分钟。而钟是有 `running` 守卫的：
     * 一拍挂住，后面每一拍都被挡掉，整个循环就"活着但不动"了（黑听时表现是：
     * 台词一直进池，抬头却再也不发生）。
     *
     * 超时不算"叫不醒"（不动 `consecutiveFails`）：宿主慢不等于会话没了。
     */
    const settled = await Promise.race([
      wakeWithRetry({
        ctx, sessionId: to, text, log, steer: mode === 'steer',
        appendMeta: (m) => appendSpoken('meta', m, { speak: false }),
      }).then((r) => ({ r })).catch((e) => ({ r: { ok: false, reason: String(e?.message ?? e) } })),
      new Promise((res) => {
        const t = setTimeout(() => res({ timeout: true }), WAKE_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    if (settled.timeout) {
      log(`叫醒超时（宿主 ${WAKE_TIMEOUT_MS}ms 没回），这一拍放过 —— 那条消息可能稍后仍会送达`);
      return false;
    }
    const r = settled.r;
    lastWakeOk = Boolean(r?.ok);
    if (r?.ok) {
      wakeCount += 1;
      consecutiveFails = 0;
      return true;
    }
    wakeFailures += 1;
    consecutiveFails += 1;
    if (consecutiveFails >= WAKE_FAILS_MAX) {
      // 会话可能已经关了：再叫下去只是每 8 秒白烧一次模型
      stop('wake-failed');
    }
    return false;
  }

  const ticker = startTicker({
    everyMs: TICK_MS,
    /**
     * 钟抛错不再静默：打包后的 Desktop 里没有控制台，这类故障的表现只是"它不动了"。
     * 落一行带栈到 `lift/debug.log`，排查时第一眼就能看到。
     */
    onError: (e) => appendLiftDebug(`tick 抛错：${e?.stack ?? e}`),
    tick: async () => {
      if (disposed) return;

      // 心跳：每 60 秒一行。没有它「钟还在不在敲」只能靠猜（2026-11-10 实测的坑）。
      const beat = Date.now();
      if (beat - lastHeartbeatAt >= 60_000) {
        lastHeartbeatAt = beat;
        /**
         * `lines` / `asr` 是 2026-11-10 加的第二把尺：黑听时"新台词一点记录都没有"，
         * 光看心跳分不清是钟停了还是**转写根本没出整句**（本地 ASR 服务会休眠，
         * 第一次请求失败后这一句就丢了）。`lines` 不涨 = 台词没进缓冲，与判档无关。
         */
        let asr = null;
        try { asr = runner.status()?.listen ?? null; } catch { asr = null; }
        const ls = lift.status();
        appendLiftDebug(`心跳 mode=${mode} queue=${queue.length} lift=${ls.level ?? '-'}`
          + ` alarms=${ls.alarms} lines=${asr?.total ?? '?'}`
          + (asr?.error ? ` asr-err=${String(asr.error).slice(0, 60)}` : '')
          + (asr?.paused ? ' asr-paused' : ''));
      }

      // ⓪ 有阻塞等待者时**不许碰这条通道**。
      //    工具调用正卡在 `watch()` 里等用户说话，poll 是消费型的 —— 我们一吃，
      //    那边的等待就永远看不见这句话，用户侧表现是"我在窗口里说话，它一动不动"。
      //    等待者拿到话会直接返回工具结果，那才是唯一能把人从阻塞里叫出来的路。
      const waiting = chatWaiterCount() > 0;
      const fresh = waiting ? [] : pollChat();
      for (const e of fresh) {
        if (e?.role === 'user' && String(e.text ?? '').trim()) {
          queue.push({ text: String(e.text).trim(), at: Number(e?.at) || 0 });
          lastUserAt = Date.now();
          lastUserSpokeAt = lastUserAt;
          wakesSinceUser = 0;
        }
      }

      // ① 窗被关掉 = 用户不想看了。**先判这个**：窗都没了，出图也没人在看。
      //    只在"窗确实开过"之后才判 —— 窗开不起来（没有 python）时不该被当成用户关窗。
      //    **进程没了才算关**；只是心跳过期（睡醒、主线程卡住）只累加拍数，
      //    够数才当成没了，而且不挂断（理由见 `windowVerdict`）。
      const wasOpen = runner.windowWasOpen();
      const winAlive = wasOpen ? windowAlive() : false;
      if (!wasOpen || winAlive) {
        windowGoneTicks = 0;
      } else {
        windowGoneTicks += 1;
        const verdict = windowVerdict({
          wasOpen, alive: winAlive, pidAlive: windowPidAlive(), goneTicks: windowGoneTicks,
        });
        if (verdict === 'closed') { stop('window-closed'); return; }
        if (verdict === 'stalled') { stop('window-stalled'); return; }
      }

      // ①.5 只听模式：**必须排在窗口判断之后**（否则窗关了也发现不了），
      //      也必须排在采集判断之前（我们已经主动停了采集，那里会误判成 capture-stopped）。
      //      这一拍除了"听"什么都不做。
      if (mode === 'listen') {
        if (!queue.length) {
          // 没人说话：先看台词里有没有人在叫人，再看声音形状值不值得抬头
          await lift.tick();
          maybeGlanceBloodbar();
          await maybeWakeFromAudio();
          return;
        }
        mode = 'active';
        wakesSinceUser = 0;
        consecutiveFails = 0;
        lastUserAt = Date.now();
        lastUserSpokeAt = lastUserAt;
        deadTicks = 0;
        unansweredListenWakes = 0;
        log('窗口里有人说话 —— 退出仅监听');
        // 采集不在这里重启：模型要图会调 peek，那条路会按用户原来的 region/清晰度起管道。
      }

      // ② 采集自己停了（源断了、ffmpeg 挂了）。
      //    **续命放在这之前**：静态画面下 60 秒不出图，宽限期会把采集收走，
      //    那时 `!running` 是"没人来取"而不是"坏了"，不能当成停。
      const st = runner.status();
      const alive = runner.touch?.() ?? st.running;
      /**
       * 采集已经停了：**最多再给两拍**把队列里剩下的图报出来，然后收工。
       *
       * 以前这里是 `!alive && !st.pending` —— 只要还有没取走的图就永远不自杀。
       * 文件回放一次能塞几十张进去，循环就被这些"永远取不完"的 pending 吊住，
       * 模型每拍被叫醒一次，用户看到的就是"一直弹有新画面、关窗都停不干净"。
       */
      if (alive) {
        deadTicks = 0;
        // 采集回来了（模型 peek 会把管道重新拉起来），暂停标记到此为止
        pausedByListen = false;
      } else if (!pausedByListen) {
        deadTicks += 1;
        if (!st.pending || deadTicks > 2) { stop('capture-stopped'); return; }
      }

      /**
       * 采集已经停了：**只允许第一拍把已经攒好的那张报出去**，之后不再产生唤醒。
       *
       * 社区实报：capture-stopped 之后还连收几条「有新画面了」，而且文案里
       * 「上一句 say N 秒前」的 N 越来越大 —— 因为 `lastSaidNote()` 是拿 `Date.now()`
       * 实时算的，采集都没了还在造新提词，那句话当然是"过期"的。
       * 队列里剩下的图仍然能 `peek` 到（那条路不经过这里），所以不报不会丢东西。
       */
      if (!alive && deadTicks > 1) return;

      // ③ 有人在阻塞等的时候，整条叫醒路径都让开 —— 那一轮本来就还没结束，
      //    `followup` 投进去只会排队到这一轮之后，纯属插队无效还容易串话。
      if (waiting) return;

      // ④ 用户插话 —— **优先于一切**，不等攒满一张、不看队列深度，
      //    **也不受自动唤醒的冷却限制**。
      //
      //    3 秒冷却本来是给"机器自己叫醒"防刷屏用的。套在人的输入上就是画蛇添足：
      //    你说完一句、3 秒内又补一句，第二句被静默吞掉，用户侧的感受是"它聋了"，
      //    然后那句话以"排队消息"的形式堆在宿主里 —— 比不叫醒还糟。
      //
      //    唯一的例外是**同一拍连发**（500ms 内刚叫醒过）。那种情况下面必然在排队，
      //    放回队里等下一拍，不丢。
      if (queue.length) {
        if (Date.now() - lastWakeAt < INTERJECT_GAP_MS) return;
        // 没有投递目标时**不许把话从队列里吃掉**：留在队列里，下一拍有了目标再投。
        // （以前 wake 失败也会丢掉这条，那是另一个坑；这里至少别为"没绑定"丢话。）
        if (!resolveTarget()) return;
        const said = queue.shift();
        noteInterjected(said.text);     // 记待回执：没带 say 回的话下一轮会被顶
        const text = `[看屏幕·用户插话] 「${said.text}」\n`
          + '**先说话，再干活** —— 用 `say` 回他（普通回复他一个字都看不到，也不会被念）。'
          + '要同时看一眼就调 `see_now({action:"peek"})`，图马上给你。';
        const ok = await wake(text, { steer: true });
        markDelivered(said.at, ok);     // 窗口据此把「发送中」换成「已送达 / 发送失败」
        // 交给了会话就记一笔：插件重载时 relay 的启动补投不许再把这一条投一遍
        if (ok) markRelaySeen(said.at);
        return;
      }

      // ④.5 没人在看就收工（社区实报「卡读图循环」的止血线，判据见 shouldGoIdle）
      //      **但窗还开着的时候只降级、不收工** —— 那扇窗还在屏幕上，用户随时可能打字，
      //      把循环整个拆掉等于把他的输入扔进黑洞（见 mode 的说明）。
      // 装了「盯着」任务就不收工：用户走开时说"帮我看着"，那就得一直看到他说够了。
      if (!pinned) {
        const winOpenNow = windowAlive();
        const act = idleAction({
          idle: shouldGoIdle({
            wakesSinceUser, lastUserAt, windowOpen: winOpenNow,
            maxWakes: tuning?.maxAutonomousWakes,
            idleStopMs: tuning?.idleStopMs,
          }),
          windowOpen: winOpenNow,
        });
        if (act === 'listen') { enterListen(); return; }
        if (act === 'stop') { stop('idle'); return; }
      }

      // ⑤ 攒够一张**新的**图了 —— 这才是常态唤醒。
      // **必须按出图序号判重**：以前只看 `pending > 0`，而模型要是没调 `peek`
      // （比如它直接回了一句话），pending 一直是 1 —— 于是每 3 秒叫一次，
      // 一路叫到用户把它关掉。`pending` 只说明"队列里有一张"，不说明"是新的"。
      const pending = Number(st.pending) || 0;
      if (pending > 0 && lastPending === 0) pendingPulse += 1;
      lastPending = pending;
      const sheetSeq = Number(st.sheets ?? st.stats?.sheets ?? 0);
      /**
       * 任务模式：每出一张图记一行「错过了什么」。
       * 放在 `key` 判重**之前** —— 图堆在队列里没人取时 key 不变，但用户确实错过了。
       */
      if (pinned && sheetSeq > lastMissedSeq) {
        lastMissedSeq = sheetSeq;
        try { runner.noteMissed?.(); } catch { /* 记录失败不影响叫醒 */ }
      }
      const key = pending > 0 ? (sheetSeq > 0 ? `#${sheetSeq}` : `p${pendingPulse}`) : null;
      if (!key || key === lastKey) return;

      // ⑤.0 **值不值得叫**：台词是主信号，兜底是保险丝。
      //
      // 原来的口径是「攒够一张新图就叫」——放视频时屏幕一直在动，于是每 15 秒叫一次，
      // 一小时 240 轮，绝大多数时候没有任何值得说的事，成本全烧在轮次上。
      // 现在：听到新台词才叫（最快 LINE_WAKE_GAP_MS 一次，间隔不够时不消费这句话，
      // 到点了再叫）；一句话都没听到时每 IDLE_WAKE_MS 兜底叫一次，
      // 防止「纯画面、无配音」的内容被彻底漏掉。
      if (!scene) {
        const nowMs = Date.now();
        const lineTotal = Number(st.listen?.total ?? 0);
        const freshLine = lineTotal > lastLineTotal;
        const lineGapOk = nowMs - lastWakeAt >= LINE_WAKE_GAP_MS;
        const idleDue = lastWakeAt === 0 || nowMs - lastWakeAt >= IDLE_WAKE_MS;
        if (freshLine && lineGapOk) {
          lastLineTotal = lineTotal;
        } else if (!idleDue) {
          return;
        }
      }
      // ⑤.1 节奏：既不能比 wakeMinGapSec 更密，也不能在上一句还没说完时插嘴。
      //      "上一句说多久，就等多久"——上一句 6 秒，下一次最早在说完之后（+气口），
      //      而不是从"叫醒那一刻"起算的固定 8 秒。
      const nextAt = nextProactiveAt({
        lastWakeAt,
        minGapMs: Math.max(0, wakeMinGapSec) * 1000,
        speechAt: followSpeech ? lastSpeechAt : 0,
        speechMs: followSpeech ? lastSpeechMs : 0,
        mode: pacingMode,
      });
      if (Date.now() < nextAt) return;   // 下一拍再来

      // 叫醒了才算"这张已经叫过"。**失败不能记账**：记了的话下一拍看到 key 没变
      // 就不再重试，连续失败计数永远到不了上限 —— 于是"叫不醒"既不会重试也不会停。
      const text = scene
        ? '[看屏幕·逐场景] 换画面了。\n'
          + '调 `see_now({action:"peek"})` 拿这一张（逐帧模式下它只有一帧、铺满整张图），'
          + '然后用 `say` **一句话**说清现在是什么场景 —— 用户要的就是"换一次说一次"，别省略。\n'
          + '一句话就行：说清画面里是什么，不要展开成段落，也不要重复上一句。'
          + lastSaidHint()
        : `[看屏幕] 有新画面了（这一张攒了 ${st.secondsSinceWake ?? '?'} 秒）。\n`
          + '调 `see_now({action:"peek"})` 拿图看一眼，然后：值得说就用 `say` 说一句，'
          + '不值得说就什么都别做（沉默是允许的，别为了刷存在感而说话）。'
          + lastSaidHint();
      const ok = await wake(text);
      if (ok) {
        lastKey = key;
        wakesSinceUser += 1;
        // 每次**成功**叫醒都留一行（含计数）：这是 #69 那条线的另一半证据 ——
        // 「续命」行前面必须能看到 1..N 次叫醒，不然"清零"清的是什么就无从判断。
        try { appendLiftDebug(`叫醒 #${wakesSinceUser}（本轮连续 ${wakesSinceUser} 次没人理）`); } catch { /* 记不上不挡路 */ }
      }
    },
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    ticker.dispose();
    try { lift.reset(); } catch { /* 状态清不掉也要停 */ }
    try { offSpeech(); } catch { /* 已经退订 */ }
  }

  return {
    dispose,
    stopped: () => stopReason !== null,
    /** 进/出仅监听（`see_now({action:"listen"})` 用；离开时要模型自己 `watch`） */
    enterListen() { enterListen(); return mode; },
    leaveListen() { return leaveListen(); },
    /**
     * 用户分配了「盯着」任务（`watch({task:"..."})`）：这一轮不看闲不闲，看到他说够为止。
     */
    setPinned(v) { pinned = Boolean(v); return pinned; },
    pinned: () => pinned,
    /** 现在有没有可投递的会话 —— relay 靠它决定"这一拍要不要接管" */
    hasTarget: () => Boolean(resolveTarget()),
    /**
     * **用户在会话里说话 = 人在**（上游 0.2.4 / issue #69）。
     *
     * 循环原来只盯悬浮窗那条 `chat.jsonl`：用户切回 DSH 主聊天窗聊十几分钟，它一个字都
     * 看不见，照样按「连续 N 次叫醒没人理」收工 —— 采集停了、人还在，agent 却被反复空叫醒。
     *
     * 判据（`human.js` 的 `isHumanMessage`）由调用方给：**只认人发的**，
     * 插件自己投的 `kind: 'see-now'` 提词不能算，否则 `wakesSinceUser` 永远归零。
     *
     * 只续**本循环的投递目标**那个会话：别的会话里的对话不该给这条命续命。
     * 目标还没定（`resolveTarget()` 为 null）时也照收 —— 宁可多陪一会儿，不要在
     * "刚开循环还没绑定会话"的那几秒里把用户的发言全丢掉。
     *
     * @param {string|null} [sid] 事件发生所在会话
     * @returns {boolean} 这次有没有真的记上（false = 不是本循环的会话）
     */
    noteUserSpoke(sid = null) {
      const to = resolveTarget();
      if (to && sid && sid !== to) {
        // 不是本循环的会话也要留痕：不然"宿主的形状对了、但绑定的是别的会话"
        // 这件事在日志里表现为"什么都没发生"，分不清是没接上还是被过滤。
        try { appendLiftDebug(`续命跳过 sid=${targetLabel(sid)}（本循环=${targetLabel(to)}）`); } catch { /* 记不上不挡路 */ }
        return false;
      }
      // **两处都写**：`log()` 只进宿主 logger（桌面版没落盘、看不见），
      // `appendLiftDebug` 写 `~/.dsh/see-now/lift/debug.log` —— 那才是能翻的证据。
      if (wakesSinceUser > 0) {
        log(`用户在会话 ${targetLabel(sid)} 说话 —— 续命，${wakesSinceUser} 次空叫醒清零`);
      }
      try {
        appendLiftDebug(`续命 sid=${targetLabel(sid)} 清零 ${wakesSinceUser} 次空叫醒`);
      } catch { /* 记不上不挡路 */ }
      lastUserAt = Date.now();
      lastUserSpokeAt = lastUserAt;
      wakesSinceUser = 0;
      return true;
    },
    state: () => ({
      stopped: stopReason !== null,
      // 'active' 在正常看；'listen' = 只剩耳朵（采集停了，但窗里打字仍然收得到）
      mode,
      /** 是否处在用户分配的「盯着」任务里（这种时候不收工） */
      pinned,
      reason: stopReason,
      /**
       * 黑听抬头的档位（P2-B）：`look` = 抬头看着（还没到 `holdSec`）；
       * `null` = 没抬头，按基线。`alarms` 是 5 分钟内的警觉次数（蓄水池）。
       */
      lift: lift.status(),
      // 当前投递目标（跟着窗口绑定走，见 `resolveTarget`）
      session: resolveTarget(),
      wakes: wakeCount,
      /** 本轮「连续叫醒没人理」的当前值（#69 的判据就是它被清零） */
      wakesSinceUser,
      wakeFailures,
      lastWakeAt: lastWakeAt || null,
      lastWakeOk,
      lastSheet: lastKey,
      // 节奏诊断：下一次主动唤醒最早落在什么时候、为什么被推迟
      lastSpeechMs: lastSpeechMs || null,
      nextWakeAt: nextProactiveAt({
        lastWakeAt,
        minGapMs: Math.max(0, wakeMinGapSec) * 1000,
        speechAt: followSpeech ? lastSpeechAt : 0,
        speechMs: followSpeech ? lastSpeechMs : 0,
        mode: pacingMode,
      }) || null,
    }),
  };
}
