/**
 * interject.js — 用户插话的**两个半边**：怎么交给模型，和它到底回了没有。
 * 照搬 `dsh-watch-together/src/interject.js` 的核心思路。
 *
 * ## 为什么必须强调"用 say 回"
 *
 * 模型对用户插话的普通回复，**在悬浮窗里一个字都看不到**（也不会被念）——
 * 只有 `say` 会进那条流。所以"先想再看"在用户侧等于全程沉默：
 * 实报过"叫了它一声，它没理我"，而模型其实是回了，只是回在了用户看不见的地方。
 *
 * 措辞散开就会出问题（某个入口忘了说该怎么说），所以这里只有一份。
 *
 * ## 为什么还要记"回没回"
 *
 * 光在插话那一刻说一遍不够：模型可能去取图了，回来时那段话已经不在上下文最前面。
 * 于是记一条**待回执**：下一次工具结果里如果还没带 `say`，就把"你还没回她"顶出来，
 * 直到它回了为止。过期（3 分钟）就自己丢掉。
 */

/** 待回执最多挂这么久：过了就当这句话已经不需要回应了，别再念叨 */
const PENDING_TTL_MS = 180_000;

/**
 * 同一条插话最多提醒几次。
 *
 * **只在第一次说**：以前只要这次没带 `say` 就每一轮都顶一遍，而模型可能只是在取图 ——
 * 于是它连着被念三次，用户看到的是一条话被当成三件事处理。说一次就够。
 */
const REMIND_MAX = 1;

/** 现在挂着的那句插话（`{ text, at, reminded }`） */
let pending = null;

/** 记下"用户刚说了这句话，还没人回" */
export function noteInterjected(text, { at = Date.now() } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 同一句话（正文相同、3 分钟内）重复记：**原样返回**，不重置计时也不清提醒次数 ——
  // 否则"模型没回"→"用户又说一遍"→"重新提醒"会变成无限循环
  if (pending && pending.text === t && at - pending.at < PENDING_TTL_MS) return pending;
  pending = { text: t, at, reminded: 0 };
  return pending;
}

/** 明确表示"已经回过了"（模型这次带了 `say`） */
export function clearInterjected() {
  pending = null;
}

/** 现在还有没有没回的插话（过期就自动清掉） */
export function pendingInterjected(now = Date.now()) {
  if (!pending) return null;
  if (now - pending.at > PENDING_TTL_MS) { pending = null; return null; }
  return pending;
}

const clip = (s, n = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 插话交给模型的那一段话。三条都是踩出来的：
 *   ① **先说话再干活** —— 普通回复悬浮窗里看不见、也不会被念，只有 `say` 会；
 *   ② **`say` 和取图可以同一次调用** —— `say` 在取图**之前**就写进流，字先出、画面后到；
 *   ③ 一段话，不是一屏话。
 *
 * @param {string} text 用户原话
 * @param {{at?:number|null}} [o] `at` 是收到的墙钟时刻（写进抬头，便于对时）
 */
export function interjectNote(text, { at = null } = {}) {
  const said = String(text ?? '').trim();
  noteInterjected(said, at ? { at } : undefined);
  const when = Number.isFinite(Number(at))
    ? ` @${new Date(Number(at)).toTimeString().slice(0, 8)}`
    : '';
  return `[看屏幕·用户插话${when}] 「${clip(said, 200)}」`
    + '\n**先说话，再干活** —— 先回这一句。普通回复悬浮窗里一个字都看不到（也不会被念），只有 `say` 会进那条流。'
    + '下一次调用必须带 `say`：`see_now({ action:"watch", say: "…" })`，'
    + '要同时看一眼直接加在**同一次调用**里（`say` 在采集**之前**就写进流，字先出、画面后到）。';
}

/**
 * 工具结果末尾的"你还没回她"。
 *
 * @param {{answered?:boolean, now?:number}} [o] `answered` = 这次调用带了 `say`
 * @returns {string} 没有待回执 / 已回 → 空串
 */
export function replyReminder({ answered = false, now = Date.now() } = {}) {
  if (answered) { clearInterjected(); return ''; }
  const p = pendingInterjected(now);
  if (!p) return '';
  if (p.reminded >= REMIND_MAX) return '';
  p.reminded += 1;
  return `\n[未回应] 用户刚说「${clip(p.text)}」，你还没回 —— 用 \`say\` 回一句。`;
}

/** 仅测试用 */
export function __resetInterject() {
  pending = null;
}
