/**
 * text-events.js — 屏幕文字事件流：一行 OCR 结果 → **带时间码的文本事件**。
 *
 * 为什么要有它：图按「张 × 15 秒」收费（`docs/机制.md` §3 §4），画面没变的那十几秒
 * 钱照付，而这段时间里屏幕上的字我们一个都没读；`src/ocr.js` 那一路是血条数字专用的
 * （4× Lanczos、240px 画布、只为把 `4.3%` 读成 `882/20725`），屏幕上的字从来没进过上下文。
 * 于是「静默期漏字」既读不到也报不出。
 *
 * 这个文件只做**纯逻辑**（任务书 P1 第 1 步）：行 → 事件。不抓屏、不 OCR、不读写
 * `~/.dsh`、不落盘、不 import 任何运行时状态。采集侧往 `observe({t, text, conf})` 喂行，
 * 交付侧问 `between(from, to)` 要行——`from/to` 与 `attachLines` 的取数窗口同一把尺
 * （`src/runner.js:845-861`：上一张图的 `wallTo` → 这一张的 `wallTo`，两头各带 400/800 ms 重叠）。
 *
 * 三条入流规则（任务书 P1 §1）：
 *   ① 同一行要被认到两次，间隔 ≥ `confirmGapMs`（默认 900 ms，见下）；
 *   ② 两版归一化后的 bigram 相似度 ≥ `sim`（默认 0.85）；
 *   ③ 两版取**更完整**的那版（字数优先，同字数取 conf 高）——**不是**保留较早那版：
 *      逐字出现的字幕，早版是半句（「你好」→「你好世界」），留早版会系统性丢后半句。
 *
 * 确认税的账（`confirmGapMs` 默认 **900 ms**，2026-11-27 格定的**临时值**，最终值等 P1 第 2 步
 * 量到真实字幕的停留时长再定）：1 fps 采样下相邻两帧隔 1000 ms，够 900，所以停 1 秒的字幕能入流；
 * 只闪一帧（不到 1 秒）的仍然进 `unconfirmed`。任务书原文写 1.2 s——那个值在 1 fps 下等于「必须隔
 * 两帧」，2 秒以内的字幕一条都认不出（`_scratch/gate-sim.mjs` 的模拟：确认率 0%），所以先降下来。
 * 2 fps 采样时相邻帧只隔 500 ms，仍然要看到第三次才算「认到两次」。
 */

/** 默认值；`~/.dsh/see-now.json` 的 `text` 段按同名键覆盖 */
export const TEXT_DEFAULTS = {
  minChars: 2,          // 归一化后至少几个**文字**字符（标点不算）
  confirmGapMs: 900,    // 同一行两次被认到的最小间隔（临时值：1 fps 下 = 相邻两帧；最终值等 P1 第 2 步实测）
  sim: 0.85,            // 两版归一化 bigram 相似度门槛
  matchMaxMs: 4000,     // 隔这么久还没等到第二版，就按「未确认」退休
  repeatGapMs: 3000,    // 已确认的行：这段时间内再认到算同一行（延长 t1，不产生新事件）
  sampleMs: 1000,       // 采样间隔：t1 = 最后一次看到 + 这个值（1 fps）
  maxLines: 12,         // 每次交付的行数预算
  maxChars: 300,        // 每次交付的字数预算（归一化后的文字字符）
  keepMs: 15 * 60_000,  // 内存滚动窗（任务书：文字事件**不落盘**）
  maxEvents: 500,
};

/* ---------- 归一化 ---------- */

/**
 * 全角 ASCII（U+FF01–U+FF5E）之外的 CJK 标点。
 *
 * 为什么要手工对表：全角逗号句号在 U+FF0C / U+3002，前者能靠「减 0xFEE0」批量转，
 * 后者不在那个区间；「」『』“”之类更是另一段码位。不统一的话，「你好，世界」和
 * 「你好,世界」会被算成两条不同的行，闸门永远配不上对。
 */
const PUNCT_MAP = new Map(Object.entries({
  '。': '.', '、': ',', '「': '"', '」': '"', '『': '"', '』': '"',
  '“': '"', '”': '"', '‘': "'", '’': "'", '《': '<', '》': '>',
  '〈': '<', '〉': '>', '…': '.', '—': '-', '–': '-', '·': '.',
  '〜': '~', '￥': '¥',
}));

const SPACE = /\s/u;

/**
 * 归一化：去空白 → 全角转半角 → 中英文标点统一。
 *
 * 只做这三件，**不改大小写**：字幕里的大小写是原文的一部分，OCR 认错大小写是第 2 步
 * 要量的事，不该在这里用一条静默的 lowercase 把它盖掉。
 */
export function normalizeLine(input) {
  if (input == null) return '';
  const s = String(input);
  let out = '';
  for (const ch of s) {
    if (SPACE.test(ch)) continue;
    const code = ch.codePointAt(0);
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (PUNCT_MAP.has(ch)) out += PUNCT_MAP.get(ch);
    else out += ch;
  }
  return out;
}

/** 归一化之后剩下的标点就是这一套 ASCII 符号 */
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~¥'.split(''));

/**
 * 归一化串里的**文字**字符数（标点不算）。
 *
 * `minChars` 与字数预算都用它：一屏「……」或「。。。」不算两行字，一个省略号也不该
 * 在「300 字」里占三个位置。
 */
export function contentChars(norm) {
  let n = 0;
  for (const ch of String(norm ?? '')) if (!ASCII_PUNCT.has(ch)) n += 1;
  return n;
}

/* ---------- 相似度 ---------- */

function bigramCounts(s) {
  const out = new Map();
  if (s.length === 1) { out.set(s, 1); return out; }
  for (let i = 0; i + 1 < s.length; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/**
 * 归一化后的 bigram 相似度（Sørensen–Dice，多重集）。
 *
 * 用 Dice 而不是「编辑距离 / 长度」：字幕的常见形态是「同一句被 OCR 认错一个字」，
 * 编辑距离对短句很敏感（6 个字错 1 个 = 0.17 的相似度），而 bigram 只丢 2 个相邻对，
 * 剩下 3 个还在。0.85 这个门槛因此能放过「认错一个字」，挡下「换了一句话」。
 */
export function bigramSim(a, b) {
  const x = normalizeLine(a);
  const y = normalizeLine(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // 单字行只跟自己相等：一个字的 bigram 只有它自己，跟任何别的字都没有重合度可言
  if (x.length === 1 || y.length === 1) return 0;
  const A = bigramCounts(x);
  const B = bigramCounts(y);
  let inter = 0;
  let nA = 0;
  let nB = 0;
  for (const [g, c] of A) {
    nA += c;
    const d = B.get(g);
    if (d) inter += Math.min(c, d);
  }
  for (const c of B.values()) nB += c;
  return (2 * inter) / (nA + nB);
}

/* ---------- 交付预算 ---------- */

/**
 * 预算：一次交付 **≤ maxLines 行 / ≤ maxChars 字**，超出从**旧**的丢。
 *
 * 从旧丢是因为「刚才屏幕上那句」比「十秒前那句」更可能被问到；丢掉的条数由调用方写成
 * 「另有 N 行」——不写的话模型会以为字幕就到这里为止。
 *
 * 一行就超字数时仍然保留它（`kept.length` 那个判断）：这里不做截断，宁可超一次预算，
 * 也不要交给用户半句话。
 */
export function budgetLines(lines, { maxLines = TEXT_DEFAULTS.maxLines, maxChars = TEXT_DEFAULTS.maxChars } = {}) {
  const kept = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const e = lines[i];
    if (kept.length >= maxLines) break;
    const n = contentChars(normalizeLine(e.text));
    if (kept.length && chars + n > maxChars) break;
    kept.push(e);
    chars += n;
  }
  kept.reverse();
  return { lines: kept, chars, dropped: lines.length - kept.length };
}

/* ---------- 闸门 ---------- */

/**
 * 建一个闸门。所有参数可覆盖，默认值见 `TEXT_DEFAULTS`。
 *
 * 状态全在闭包里（内存滚动窗，不落盘）；`stats()` 返回的六个键就是任务书要的
 * `meta.textStats` 形状：`{ lines, blocked, unconfirmed, deduped, dropped, seq }`。
 */
export function createTextGate(options = {}) {
  const o = { ...TEXT_DEFAULTS, ...options };

  let seq = 0;               // 事件水位：交付侧拿它做「只补未读」
  const events = [];         // 已确认，按 t0 递增
  const pending = [];        // 候选：只认到一次
  const seen = new Map();    // 交付去重键 → t0（跨 sheet 的 ±400/800 ms 重叠靠它挡）
  const stat = { lines: 0, blocked: 0, unconfirmed: 0, deduped: 0, dropped: 0, seq: 0 };

  /** 交付去重键：同一条字 + t0 对齐到 0.5 s */
  const keyOf = (e) => `${e.norm}@${Math.floor(e.t0 / 500)}`;
  /** 对外只给 TextEvent 的公开字段，`norm` 是内部对表用的 */
  const view = (e) => ({ t0: e.t0, t1: e.t1, text: e.text, conf: e.conf, seq: e.seq });

  /** 归一化后更完整的那个：字数优先，同字数取 conf 高；打平留新的 */
  function fuller(a, b) {
    const ca = contentChars(a.norm);
    const cb = contentChars(b.norm);
    if (ca !== cb) return ca > cb ? a : b;
    const fa = Number.isFinite(a.conf) ? a.conf : -Infinity;
    const fb = Number.isFinite(b.conf) ? b.conf : -Infinity;
    if (fa !== fb) return fa > fb ? a : b;
    return b;
  }

  /** 过期候选退休：按「见过一次、没等到第二次」记 unconfirmed */
  function retire(now) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (now - pending[i].t > o.matchMaxMs) {
        pending.splice(i, 1);
        stat.unconfirmed += 1;
      }
    }
  }

  /** 同一行的其它候选一并清掉，否则它过一会儿还会跟同一行再配一次对 */
  function dropSimilar(norm) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i];
      if (p.norm === norm || bigramSim(p.norm, norm) >= o.sim) pending.splice(i, 1);
    }
  }

  function prune(now) {
    while (events.length && events[0].t1 < now - o.keepMs) events.shift();
    while (events.length > o.maxEvents) events.shift();
    for (const [k, t0] of seen) if (t0 < now - o.keepMs) seen.delete(k);
  }

  /**
   * 喂一行。
   *
   * @param {{t:number, text:string, conf?:number|null}} row `t` 是 epoch ms，与帧的 `wall` 同一时钟
   * @returns {{kind:'invalid'|'empty'|'blocked'|'pending'|'confirmed'|'extension', event?:object, extended?:number}}
   */
  function observe({ t, text, conf } = {}) {
    const now = Number(t);
    if (!Number.isFinite(now)) return { kind: 'invalid' };
    const norm = normalizeLine(text);
    // 空行不计数：OCR 每秒都会交一屏空白，算进 blocked 会把闸门的账泡烂
    if (!norm) return { kind: 'empty' };
    retire(now);
    if (contentChars(norm) < o.minChars) {
      stat.blocked += 1;
      return { kind: 'blocked' };
    }
    const c = conf == null ? null : (Number.isFinite(Number(conf)) ? Number(conf) : null);
    const raw = String(text).trim();

    // ① 还是同一行（字幕没换）：延长 t1，不产生新事件
    //
    // 只回看最后几条、且**不按 t1 提前收手**：双语字幕是上下两行，先出现的那行可以
    // 比后出现的活得久（t1 反超），按「最新一条已经过期」就 break 会漏掉它，那一行便会
    // 以新事件的身份再进一次流（t0 不同、去重键不同，重复交付）。
    const back = Math.max(0, events.length - 8);
    for (let i = events.length - 1; i >= back; i -= 1) {
      const e = events[i];
      if (now - e.t1 > o.repeatGapMs) continue;
      if (bigramSim(e.norm, norm) < o.sim) continue;
      const before = e.t1;
      e.t1 = Math.max(e.t1, now + o.sampleMs);
      // 还没交付过的行，允许被更完整的晚版顶掉；交付过的就不动，避免同一行两个版本
      const cand = { text: raw, norm, conf: c };
      if (fuller(cand, e) === cand && !seen.has(keyOf(e))) {
        e.text = cand.text;
        e.norm = cand.norm;
        e.conf = cand.conf;
      }
      dropSimilar(norm);
      return { kind: 'extension', event: view(e), extended: e.t1 - before };
    }

    // ② 凑够两次：间隔够、相似度够，才入流
    let hit = null;
    for (const p of pending) {
      const gap = now - p.t;
      if (gap < o.confirmGapMs || gap > o.matchMaxMs) continue;
      const s = bigramSim(p.norm, norm);
      if (s < o.sim) continue;
      if (!hit || s > hit.s) hit = { p, s };
    }
    if (hit) {
      const idx = pending.indexOf(hit.p);
      if (idx >= 0) pending.splice(idx, 1);
      const win = fuller(hit.p, { text: raw, norm, conf: c });
      seq += 1;
      const ev = {
        // t0 是**第一版**的时间（字幕出现的时刻），确认只推迟入流，不改时间码
        t0: Math.min(hit.p.t, now),
        t1: Math.max(hit.p.t, now) + o.sampleMs,
        text: win.text,
        conf: win.conf,
        norm: win.norm,
        seq,
      };
      events.push(ev);
      stat.lines = seq;
      stat.seq = seq;
      dropSimilar(norm);
      prune(now);
      return { kind: 'confirmed', event: view(ev) };
    }

    // ③ 新候选
    pending.push({ t: now, text: raw, norm, conf: c });
    return { kind: 'pending' };
  }

  /**
   * 取一个时间窗里的行（交付点：唤醒消息 / `watch` / `peek` 都走这里）。
   *
   * 窗口与 `attachLines` 同一把尺（上一张 `wallTo` → 这一张 `wallTo`）。重叠段里同一条字
   * 只给**第一次**——两张图的窗口有 400/800 ms 重叠，不去重的话同一句会在两张图里各出现
   * 一次，模型会以为用户说了两遍。
   *
   * 返回按 `t0`（字幕出现时刻）排序；**`seq` 在这个顺序里不保证递增**：同一帧的两行字
   * （双语字幕）OCR 的先后每次可能翻面，确认顺序跟着翻，`seq` 就会在相邻两条上对调。
   * 水位取 `max(seq)` 没问题，但别拿「最后一条的 seq」当水位。
   *
   * **有副作用**：调用即把命中的行标成「已交付」并累加预算丢掉的条数。只想看一眼（status、
   * 排障）别用它——看一次就把行吃掉了。
   *
   * @returns {{lines: object[], dropped: number}} `dropped` = 这一窗被预算丢掉的条数（写「另有 N 行」）
   */
  function between(from, to) {
    const lo = Number.isFinite(Number(from)) ? Number(from) : -Infinity;
    const hi = Number.isFinite(Number(to)) ? Number(to) : Infinity;
    const hits = events
      .filter((e) => e.t1 >= lo && e.t0 <= hi)
      .sort((a, b) => a.t0 - b.t0);
    const fresh = [];
    for (const e of hits) {
      const k = keyOf(e);
      if (seen.has(k)) {
        stat.deduped += 1;
        continue;
      }
      // 被预算丢掉的那些也记成已看：它们属于这一窗，不该在下一窗以「新行」出现
      seen.set(k, e.t0);
      fresh.push(view(e));
    }
    const b = budgetLines(fresh, o);
    stat.dropped += b.dropped;
    return { lines: b.lines, dropped: b.dropped };
  }

  /** 六个数：与 `meta.textStats` 同形 */
  function stats() {
    return { ...stat };
  }

  return { observe, between, stats };
}
