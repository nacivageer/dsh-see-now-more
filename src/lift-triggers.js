/**
 * lift-triggers.js — 黑听抬头（lift）的触发层：从最近台词里挑出「这句值得瞥一眼」。
 *
 * 定位：**固定小表，是 L2 上下文判断的兜底，不是主触发器**。
 * 机制里模型自己按语境判"你可以看了"；小表只负责那些几乎不用理解上下文就能认出的句子：
 * 直呼名字、「你看这个」、「卧槽」、「等一下」。
 *
 * 设计取舍（P0 交接文 + `docs/tasks/see-now-listen-lift.md`）：
 *   - **误报比漏报贵**：抬头一次至少 222 token，还可能叫醒一轮模型。词表先窄后宽，
 *     宁漏勿滥。「我的游戏已经开好了」这种**会话内邀约**不进小表 —— 它由模型按上下文判，
 *     黑听触发认不出主语和对象。
 *   - **纯函数**：不读 `see-now.json`、不读时钟、不存状态。时间由 `utterance.startMs` 给，
 *     "跨窗口不重复报"靠调用方把上一轮 hits 通过 `opts.seen` 递回来。
 *   - 一句话最多报一条：强词优先于弱词，避免同一句报两次。
 *
 * 档位：P0 只判「要不要瞥」——强 → `glance`，弱 → `alarm`。`look` / `chase` 由接线那一棒
 * 按「最近 5 分钟有没有活跃对话」再升，不在这里判。
 */

/**
 * 强触发词（→ glance）。
 *
 * `你看这个` 单列是因为它比 `你看` 更明确，命中理由写出来也更有用；匹配按长度从长到短，
 * 所以它不会被 `你看` 抢走。**不要**加 `看这个`（"我看这个"是叙述，不是叫人看）。
 */
export const LIFT_STRONG_WORDS = Object.freeze([
  '你看这个',
  '你看',
  '快看',
  '卧槽',
  '等一下',
]);

/**
 * 弱触发词（→ alarm，只记一笔）：单个惊叹词。
 *
 * 只认"整句就是一个（或几个连着的）惊叹词"，比如「啊？」「诶诶」「嗯……」。
 * 出现在句子中间的「啊」不算 —— 那在口语里几乎每句都有，报了等于没报。
 */
export const LIFT_WEAK_WORDS = Object.freeze([
  '啊', '诶', '欸', '哎', '唉', '哦', '喔', '噢', '嗯', '唔', '咦', '嚯', '嘿',
]);

/** 词表整体（调用方可以只换其中一段，见 `opts.words`）。 */
export const LIFT_WORDS = Object.freeze({
  strong: LIFT_STRONG_WORDS,
  weak: LIFT_WEAK_WORDS,
});

/** 同一句话的默认去重窗口：30 秒内只报一次。 */
export const LIFT_DEDUPE_MS = 30_000;

/** 无指代短问句的长度上限（去掉标点后）。8 个字以内才像"条件反射"，再长就有内容了。 */
const SHORT_QUESTION_MAX = 8;

/**
 * 指代/人称。短问句里出现这些就不算"无指代" ——
 * 「这个？」「你说什么？」是有对象的，「真的？」「开始了？」才是条件反射。
 */
const DEIXIS_RE = /[这那谁啥哪你您我他她它]/;

/** 去掉标点、空白、符号，只留下文字与数字（中英文都适用）。 */
function bare(text) {
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 去重用的句子指纹：文字与数字，英文忽略大小写。 */
function fingerprint(text) {
  return bare(text).toLowerCase();
}

/**
 * 一句台词 → 一条命中（或 null）。强词 → glance；弱词/短问句 → alarm。
 *
 * @param {string} text
 * @param {{names:string[], strong:string[], weak:Set<string>}} table
 * @returns {null | {level:'alarm'|'glance', reason:string}}
 */
function matchOne(text, table) {
  const line = text.trim();
  if (!line) return null;

  // ① 直呼名字：最强信号。名字由调用方给，模块里不硬编码任何人的名字。
  for (const name of table.names) {
    if (name && line.includes(name)) return { level: 'glance', reason: `直呼名字「${name}」` };
  }

  // ② 强词：长的先试，理由才写得具体（「你看这个」优先于「你看」）
  const strong = [...table.strong].filter((w) => typeof w === 'string' && w.trim()).sort(
    (a, b) => b.length - a.length,
  );
  for (const word of strong) {
    if (line.includes(word)) return { level: 'glance', reason: `强触发词「${word}」` };
  }

  const body = bare(line);
  if (!body) return null;

  // ③ 单个惊叹词：整句只由弱词字符组成，且别太长（「啊」「诶诶」「嗯……」）
  if (body.length <= 4) {
    const chars = [...body];
    const interjection = table.weak.has(body)
      || (chars.every((ch) => table.weak.has(ch)) && chars.some((ch) => table.weak.has(ch)));
    if (interjection) return { level: 'alarm', reason: `弱触发词「${body}」（单惊叹词）` };
  }

  // ④ 无指代短问句：「真的？」「开始了？」——问号结尾、够短、没有指代/人称
  if (/[？?]\s*$/.test(line) && body.length <= SHORT_QUESTION_MAX && !DEIXIS_RE.test(body)) {
    return { level: 'alarm', reason: `无指代短问句「${line}」` };
  }

  return null;
}

/**
 * 从最近台词里匹配抬头触发。
 *
 * @param {Array<{text:string, startMs:number, endMs?:number, confidence?:number}>} utterances
 *   `startMs` 是音频时间（毫秒），和 `lift-pool` 的 `wall` 同一把尺。
 *   缺 `startMs` 或文本为空的条目直接跳过（排不了序，也没法去重）。
 * @param {{dedupeMs?:number, seen?:Array<{text:string, startMs:number}>, names?:string[],
 *          words?:{strong?:string[], weak?:string[]}}} [opts]
 *   `seen`：上一轮（或上一个窗口）已经报过的 hits。跨窗口续传同一批台词时，
 *           把旧结果递进来，就不会同一句报两次。
 * @returns {{level:'alarm'|'glance'|null, hits:Array<{text:string, startMs:number,
 *            reason:string, level:'alarm'|'glance'}>}}
 *   `level` 是这批命中的**最贵档**：有 glance 就是 glance，只有弱命中就是 alarm，
 *   没有命中是 null（不伪造一个档位）。
 */
export function matchLiftTriggers(utterances, opts = {}) {
  const {
    dedupeMs = LIFT_DEDUPE_MS,
    seen = [],
    names = [],
    words = LIFT_WORDS,
  } = opts ?? {};

  const table = {
    names: Array.isArray(names)
      ? names.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
      : [],
    strong: Array.isArray(words?.strong) ? words.strong : LIFT_STRONG_WORDS,
    // 弱词按"整句只由这些字组成"认，所以这里要的是字符集合
    weak: new Set(
      (Array.isArray(words?.weak) ? words.weak : LIFT_WEAK_WORDS)
        .filter((w) => typeof w === 'string' && w.trim())
        .map((w) => w.trim()),
    ),
  };

  const window = Number.isFinite(Number(dedupeMs)) && Number(dedupeMs) >= 0
    ? Number(dedupeMs) : LIFT_DEDUPE_MS;

  const list = Array.isArray(utterances) ? utterances : [];
  const ordered = list
    .filter((u) => u && typeof u.text === 'string' && u.text.trim()
      && Number.isFinite(Number(u.startMs)))
    .map((u) => ({ text: u.text.trim(), startMs: Number(u.startMs) }))
    .sort((a, b) => a.startMs - b.startMs);

  const prior = Array.isArray(seen)
    ? seen.filter((h) => h && typeof h.text === 'string' && Number.isFinite(Number(h.startMs)))
    : [];

  /** @type {Array<{text:string, startMs:number, reason:string, level:'alarm'|'glance'}>} */
  const hits = [];

  for (const utterance of ordered) {
    const found = matchOne(utterance.text, table);
    if (!found) continue;

    // 同句去重：文字相同且时间差在窗口内 → 只报一次。
    // 拿 hits 和 seen 一起比，所以把上一窗口的结果传进来就能"跨窗口不重复报"。
    const key = fingerprint(utterance.text);
    const duplicate = [...hits, ...prior].some(
      (h) => fingerprint(h.text) === key
        && Math.abs(Number(h.startMs) - utterance.startMs) <= window,
    );
    if (duplicate) continue;

    hits.push({
      text: utterance.text,
      startMs: utterance.startMs,
      reason: found.reason,
      level: found.level,
    });
  }

  const level = hits.some((h) => h.level === 'glance') ? 'glance'
    : hits.length ? 'alarm' : null;

  return { level, hits };
}
