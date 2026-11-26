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

/** 插话末尾那段固定要求（无引用 / 有引用两条路共用，保证「没有引用时逐字不变」）。 */
const INSTRUCTION = '\n**先说话，再干活** —— 先回这一句。普通回复从 2026-11-26 起也会镜像进悬浮窗'
  + '（能看见、但不会念），只有 `say` 会念出来；想让她听见就在下一次调用带 `say`：'
  + '`see_now({ action:"watch", say: "…" })`，'
  + '要同时看一眼直接加在**同一次调用**里（`say` 在采集**之前**就写进流，字先出、画面后到）。';

/** 引用块上限：窗口已经限 4000，这里再兜一层（防绕过窗口直接投递）。 */
const QUOTE_MAX = 4000;

/**
 * 切开头的引用块：`> ` 行原样保留（要给 DSH 的 `quoteRule` 渲染），
 * 后面的正文用于「插话说明」。没有引用块返回 null。
 *
 * 只认**开头**的连续 `^ {0,3}>` 行：用户消息里正文中间的 `>` 不该被当成引用头，
 * 那会把它整个搬走、插话说明变空。
 */
export function splitLeadingQuote(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const quote = [];
  let i = 0;
  while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
    quote.push(lines[i]);
    i += 1;
  }
  if (!quote.length) return null;
  return {
    quote: quote.join('\n').slice(0, QUOTE_MAX),
    rest: lines.slice(i).join('\n').trim(),
  };
}

/**
 * 浮窗正文里的**本地图片 markdown**：`![图片](C:\…\x.png)`。
 *
 * 2026-11-26：主窗不解析本地路径的 Markdown 图片（安全限制），会在气泡里显示成
 * 一行路径。relay 投递前把本地图拆出来、读成图片内容块；网络图不搬（没法保证
 * 内网可访问，也可能很大）。
 *
 * @param {string} text
 * @returns {{text:string, images:Array<{path:string, raw:string}>}}
 */
export function splitImageMarkdown(text) {
  const src = String(text ?? '');
  const images = [];
  let out = '';
  let last = 0;
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(src))) {
    const path = m[1];
    if (/^[a-z]+:\/\//i.test(path)) continue;   // http(s) / file:// 不搬
    images.push({ path, raw: m[0] });
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
  }
  if (!images.length) return { text: src, images: [] };
  out += src.slice(last);
  return { text: out.replace(/[ \t]+\n/g, '\n').trim(), images };
}

/**
 * 浮窗消息投给会话时，**用户原话**单独发一条（`source.kind:"user"`）。
 *
 * 2026-11-26 用户要求：浮窗发的话要在 DSH 主窗显示成**用户的聊天气泡**，而不是
 * 「收到执行请求」触发卡；只有这样引用块才会按 Markdown 渲染。原话保持逐字不变
 * （`> ` 引用块、图片 Markdown 都不动）。
 */
export function relayUserText(text) {
  return String(text ?? '').trim();
}

/**
 * 投给会话时，用户那条消息的**正文**（2026-11-26 `.33`）。
 *
 * 浮窗发**纯图**（拆完 markdown 没有正文）时不再补 `[图片]`：主窗里图片自己就在，
 * 多一行 `[图片]` 只是噪音，还排在图片上面。没有图时才退回原话（历史行为）。
 *
 * 说明那条（`relayInstruction`）仍用 `[图片]` 占位 —— 否则它会写成
 * 「引用了一段内容，见上一条」，读起来像引用而不是一张图。
 *
 * @param {{text?:string, images?:unknown[], fallback?:string}} [o]
 * @returns {string}
 */
export function relaySendText({ text = '', images = [], fallback = '' } = {}) {
  const body = String(text ?? '');
  if (body.trim()) return body;
  return Array.isArray(images) && images.length ? '' : String(fallback ?? '');
}

/**
 * 紧跟原话之后的**说明**（`source.kind:"see-now"`）：为什么必须用 `say` 回。
 *
 * 单独一条而不是塞进原话里：塞进去会让一大段插件指令变成用户的聊天气泡内容。
 * 这条仍会以「触发卡」形式出现在主窗，但它不是用户的话。
 *
 * @param {string} text 用户原话
 * @param {{at?:number|null}} [o]
 */
export function relayInstruction(text, { at = null } = {}) {
  const said = String(text ?? '').trim();
  const q = splitLeadingQuote(said);
  const body = q ? q.rest : said;
  // 待回执记正文（不是整段引用）
  noteInterjected(q ? (body || '引用了一段内容') : said, at ? { at } : undefined);
  const when = at != null && Number.isFinite(Number(at))
    ? ` @${new Date(Number(at)).toTimeString().slice(0, 8)}`
    : '';
  const hint = body ? `「${clip(body, 200)}」` : '（引用了一段内容，见上一条）';
  return `[看屏幕·用户插话${when}] ${hint}${INSTRUCTION}`;
}

/**
 * 插话交给模型的那一段话（**工具结果里用**，不用于会话投递）。
 *   ① **先说话再干活** —— 正文从 `.31` 起也会镜像进悬浮窗，但**不会念**；只有 `say` 会念；
 *   ② **`say` 和取图可以同一次调用** —— `say` 在取图**之前**就写进流，字先出、画面后到；
 *   ③ 一段话，不是一屏话。
 *
 * 2026-11-26：带引用时**引用块原样放最前**、不参与 200 字截断 —— 否则 DSH 主窗
 * 只看到 `[看屏幕·用户插话] 「> …」`，长引用还会被截掉，等于只在浮窗里有效。
 *
 * @param {string} text 用户原话（可能以 `> ` 引用块开头）
 * @param {{at?:number|null}} [o] `at` 是收到的墙钟时刻（写进抬头，便于对时）
 */
export function interjectNote(text, { at = null } = {}) {
  const said = String(text ?? '').trim();
  const q = splitLeadingQuote(said);
  const body = q ? q.rest : said;
  // 待回执记的是**正文**：否则「未回应」提醒里会复读四千字引用
  noteInterjected(q ? (body || '引用了一段内容') : said, at ? { at } : undefined);
  const when = at != null && Number.isFinite(Number(at))
    ? ` @${new Date(Number(at)).toTimeString().slice(0, 8)}`
    : '';
  if (!q) {
    return `[看屏幕·用户插话${when}] 「${clip(said, 200)}」${INSTRUCTION}`;
  }
  const explain = body || '用户引用了一段内容（见上方引用块）';
  return `${q.quote}\n\n[看屏幕·用户插话${when}] 「${clip(explain, 200)}」${INSTRUCTION}`;
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
