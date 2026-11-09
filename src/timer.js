/**
 * timer.js — 「钟」：定时跑 tick、该叫时叫醒模型。照搬 `dsh-watch-together/src/timer.js`。
 *
 * 职责只有两件：`startTicker`（起钟）、`wakeSession`（叫醒）。它不取图、不做判断。
 *
 * ## 为什么必须是插件自己起钟，而不是靠模型反复调工具
 *
 * 一开始 see-now 是"模型调 `watch(20s)` → 拿一张图 → 说话 → 再调一次"。
 * 实测这样跑不住：**模型拿到图、回完话就停了**，用户看到的是"它答一句就没下文了"。
 * 模型没有理由主动再调一次 —— 它不知道下一次该什么时候调。
 *
 * 所以钟必须在插件里：tick 每 2 秒敲一次（几乎不花钱），只有真的攒够一张图才叫醒。
 * 叫醒一次 = 往会话投一条消息 = 模型跑一轮，这才贵。
 *
 * ## 取服务必须容错
 *
 * cordis 的 `ctx` 是 Proxy：服务没在 `inject` 里声明时，`get` 陷阱**直接抛**
 * `cannot get property "x" without inject`。`?.` 只挡 null/undefined，**挡不住异常**。
 * 所以一律走 `ctx.get(name)`，再包一层 try。
 */

import { randomUUID } from 'node:crypto';

/**
 * 从 cordis 上下文里取一个**可选**服务（取不到返回 null，绝不抛）。
 */
export function serviceOf(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet) return viaGet;
    }
  } catch { /* 没有 get() / 服务没注册，往下走 */ }
  try {
    return ctx[name] ?? null;
  } catch {
    return null;      // Proxy 抛的那个 "without inject"，在这里收住
  }
}

/** 取 `sessionController`：先 `ctx.get()`，老环境才退回属性访问。 */
export function controllerOf(ctx) {
  return serviceOf(ctx, 'sessionController');
}

/** 唤醒用的消息：DSH 的 `followup()` 要的是一条 user 角色的消息（`MessageBase`） */
function followupMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    // 自定义 source.kind 是 DSH 文档里给插件用的形状
    source: { kind: 'see-now' },
  };
}

/**
 * 起钟。返回 dispose；`unref()` 保证它不阻止宿主退出。
 *
 * @param {{everyMs?:number, tick:()=>(void|Promise<void>), immediate?:boolean}} opts
 */
export function startTicker({ everyMs = 2000, tick, immediate = true } = {}) {
  let disposed = false;
  let running = false;

  const guard = async () => {
    if (disposed || running) return;   // 上一轮还没跑完就别叠上去
    running = true;
    try {
      await tick();
    } catch {
      /* 钟自己出问题不该把宿主带崩 */
    } finally {
      running = false;
    }
  };

  const timer = setInterval(guard, everyMs);
  timer.unref?.();
  if (immediate) void guard();

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

/**
 * 用户自己打的字该走哪条投递路径：`steer` 还是 `followup`。
 *
 * **`steer` 只在会话真的在跑回合时才是"插话"**。打在空闲会话上时，宿主会为这条
 * steer 起一个空回合、随即 `blocked` —— 话到不了模型，可 `agent.steer()` 并不抛，
 * `wakeSession()` 照样回 `ok:true`，于是窗口显示「已送达」、`relay.log` 写 `ok`，
 * 用户那边一点反应都没有（2026-11-08 实报的「已阻止」：窗绑 9a9ea198、当时在跑的
 * 是 f990629d，判据是会话日志里 turn/start → 撤销 → turn/end blocked，中间没有 step）。
 *
 * 所以判据只认「有正在跑的回合」：在跑就 steer（下一步插进去），
 * 不在跑 / 状态未知就 followup（正常起一轮；万一其实在忙，最多排到这一轮之后）。
 */
export function deliveryMode({ running } = {}) {
  return running === true ? 'steer' : 'followup';
}

/**
 * 把"叫醒"包起来：叫不醒就返回原因，**绝不抛**（不然又被 ticker 的 catch 吞掉）。
 *
 * 叫醒的写法是宿主定的（DSH 内置 schedule 插件就是范本）：
 *   1. `sessionController.resolveAgent(sessionId)` → `{ agent }`
 *   2. `agent.followup(message)` 排队下一轮并唤醒驱动器
 *   3. `sessions.flush(agent.session)` 确认真的落进会话（followup 只进收件箱）
 */
export async function wakeSession(ctx, { sessionId, text, steer = false } = {}) {
  const sc = controllerOf(ctx);
  if (!sc?.resolveAgent) return { ok: false, reason: 'no-session-controller' };
  if (!sessionId) return { ok: false, reason: 'no-session-id' };

  try {
    const resolved = await sc.resolveAgent(sessionId);
    if (!resolved || resolved.error || !resolved.agent) {
      const reason = resolved?.error?.message ?? resolved?.error ?? 'resolve-failed';
      return { ok: false, reason: String(reason).slice(0, 160) };
    }
    // `steer` = 下一**步**就交给模型（回合还在跑时等于插话，不排队）；
    // `followup` = 下一**回合**（模型正忙时排在后面）。窗口里的用户消息**不是永远走 steer**：
    // 只有会话真在跑回合时才能插话，判据见 `deliveryMode()`。
    const agent = resolved.agent;
    const msg = followupMessage(text);
    let via = 'followup';
    if (steer && typeof agent.steer === 'function') {
      agent.steer(msg);
      via = 'steer';
    } else {
      agent.followup(msg);
    }
    let flushed = null;
    try {
      const sessions = serviceOf(ctx, 'sessions');
      if (sessions?.flush && agent.session) flushed = await sessions.flush(agent.session);
    } catch { flushed = false; }
    return { ok: true, via, flushed };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * 叫醒失败要**看得见**：重试一次；还失败就写一条进悬浮窗。
 *
 * 以前这里是 `void wakeSession(...)`，返回 `{ok:false}` 也没人看 ——
 * 用户看到的现象就是"突然不理我了"（陪看那边实报过）。
 */
export async function wakeWithRetry({ ctx, sessionId, text, note = () => {}, appendMeta = null, steer = false }) {
  let r = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { r = await wakeSession(ctx, { sessionId, text, steer }); } catch (e) { r = { ok: false, reason: String(e?.message ?? e) }; }
    if (r?.ok) return r;
    if (attempt === 0) await new Promise((res) => setTimeout(res, 800));
  }
  const reason = String(r?.reason ?? 'unknown').slice(0, 120);
  try { appendMeta?.(`[看屏幕] 叫醒失败：${reason}`); } catch { /* 写不进流也要留日志 */ }
  note(`wake failed: ${reason}`);
  return r ?? { ok: false, reason: 'unreachable' };
}
