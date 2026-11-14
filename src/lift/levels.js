/**
 * lift-levels.js — 黑听抬头的「判档」：一句话该按哪一档处理（P2-B 第 1 步）。
 *
 * 四档（机制文档 `see-now-listen-lift.md` 的「③ 抬头之后」）：
 *
 *   警觉 alarm   只记账：进池 + `lift.jsonl`，不取帧、不叫醒、不进窗
 *   瞥   glance  取 1 帧给人看，不叫醒
 *   看   look    叫醒模型（帧由模型自己按 t0 取）
 *   追   chase   只能模型在「看」之后自己发起 —— **本模块永远不会返回 chase**
 *
 * ## 两条规则，别混在一起
 *
 * 1. **基线**（`lift.level`，2026-11-10 拍板）：安静时按它走。默认 `glance`；
 *    设成 `alarm` 就是「最省模式」（安静只记账，有人说话最多瞥一眼）。
 * 2. **升档**：最近 5 分钟有活跃对话时，基线自动升一档（`alarm → glance`、`glance → look`，
 *    `look` 封顶）。**只有强命中才升** —— 弱命中（"啊？"）就算有人在说话也不该叫醒，
 *    那是机制表里「看 = 同一触发 + 活跃对话」的意思。
 *
 * 3. **蓄水池**：5 分钟内警觉累计 ≥3 次 → 升一次「瞥」（用第 3 次那条的时间戳取帧）。
 *    这是给「连续几声惊叹」准备的：单声不值得看，三声就有点事了。
 *
 * 纯函数：不读时钟、不读配置、不存状态。`alarmsIn5min` 由调用方数好传进来，
 * 这样「第 3 次触发升档」在单测里可以穷举。
 */

/** 四档机读名，顺序就是成本梯度。与 `tuning.js` 的 `LIFT_LEVELS` 同值。 */
export const LIFT_LEVEL_ORDER = Object.freeze(['alarm', 'glance', 'look', 'chase']);

/** 档位序号（`alarm` = 0）。 */
export const LIFT_LEVEL_RANK = Object.freeze({ alarm: 0, glance: 1, look: 2, chase: 3 });

/** 蓄水池规则：5 分钟内累计几次警觉升一次瞥。 */
export const POOL_RULE_COUNT = 3;

/** 蓄水池窗口（毫秒）。 */
export const POOL_RULE_WINDOW_MS = 5 * 60 * 1000;

/** 基线合法值；`chase` 在自动判定里等同 `look`（追只能模型发起）。 */
function normalizeBase(base) {
  return LIFT_LEVEL_ORDER.includes(base) ? base : 'glance';
}

/**
 * 判这一批命中的档位。
 *
 * @param {{
 *   hits?: Array<{level?:'alarm'|'glance', text?:string}>,
 *   baseLevel?: 'alarm'|'glance'|'look'|'chase',
 *   active?: boolean,
 *   alarmsIn5min?: number,
 *   poolThreshold?: number,
 * }} [o]
 *   `hits` 是 `matchLiftTriggers()` 的产物（只认 alarm / glance 两种）；
 *   `active` = 最近 5 分钟有活跃对话（用户说过话，或模型回合刚结束）；
 *   `alarmsIn5min` = **含这一批**在内的 5 分钟警觉次数。
 * @returns {{level:'alarm'|'glance'|'look'|null, why:'none'|'strong'|'strong+dialog'
 *            |'weak'|'pool', reason:string}}
 *   `why` 是给 `lift.jsonl` 与文案用的"为什么是这个档"，不是给人读的长句。
 */
export function decideLevel({
  hits = [],
  baseLevel = 'glance',
  active = false,
  alarmsIn5min = 0,
  poolThreshold = POOL_RULE_COUNT,
} = {}) {
  const list = Array.isArray(hits)
    ? hits.filter((h) => h && (h.level === 'alarm' || h.level === 'glance'))
    : [];
  if (!list.length) return { level: null, why: 'none', reason: '没有命中' };

  const strong = list.some((h) => h.level === 'glance');
  const base = normalizeBase(baseLevel);
  const count = Math.max(0, Math.floor(Number(alarmsIn5min) || 0));
  const need = Math.max(1, Math.floor(Number(poolThreshold) || POOL_RULE_COUNT));

  if (strong) {
    /**
     * 强命中：按基线走，有对话时升一档。
     *
     * `alarm` 基线下升一档是 **glance 而不是 look** —— 那是"最省模式"的承诺：
     * 有人说话也只瞥一眼，不打断。
     */
    if (base === 'alarm') {
      return active
        ? { level: 'glance', why: 'strong+dialog', reason: '强命中 + 最近 5 分钟有对话（基线 alarm 升一档）' }
        : { level: 'alarm', why: 'strong', reason: '强命中，但基线是 alarm 且没对话' };
    }
    if (base === 'look' || base === 'chase') {
      // 用户显式把基线调到「看」：强命中一律叫醒（不再等对话）
      return { level: 'look', why: 'strong', reason: '强命中（基线 look，直接叫醒）' };
    }
    return active
      ? { level: 'look', why: 'strong+dialog', reason: '强命中 + 最近 5 分钟有对话' }
      : { level: 'glance', why: 'strong', reason: '强命中，但最近 5 分钟没人说话' };
  }

  // 只有弱命中：不看基线、不看对话，先按警觉记；攒够了才升一次瞥
  if (count >= need) {
    return { level: 'glance', why: 'pool', reason: `5 分钟内第 ${count} 次警觉，攒够了` };
  }
  return { level: 'alarm', why: 'weak', reason: '弱命中（只记账）' };
}

/**
 * 档位序号（`alarm` = 0）。给"是否升档了"这类判断用。
 * @param {string} level
 * @returns {number}
 */
export function levelRank(level) {
  return LIFT_LEVEL_RANK[level] ?? -1;
}

/**
 * 「抬头之后该不该回落」（P2-B 的第 10 条验收）。
 *
 * 三条同时成立才回落：**在看**（`holding`）、**安静够久**（从最后一次语音/对话算）、
 * **画面不动**（`still()`）。少任何一条都不回 —— 宁可多看一会儿，也别在有人说话、
 * 画面还在动的时候把档位收回去。
 *
 * `holdSec = 0` = 用户关掉自动回落：一直看到收工线。
 *
 * @param {{holding?:boolean, now?:number, since?:number, holdSec?:number,
 *          still?:{ok:boolean, still:boolean}|null}} [o]
 * @returns {boolean}
 */
export function shouldFallback({ holding = false, now = 0, since = 0, holdSec = 15, still = null } = {}) {
  if (!holding) return false;
  const sec = Number(holdSec);
  if (!(sec > 0)) return false;                 // 0 / 负数 = 关掉
  if (!Number.isFinite(now) || !Number.isFinite(since)) return false;
  if (now - since < sec * 1000) return false;   // 还在安静计时里
  if (!still || still.ok !== true) return false; // 判不了画面 → 不动
  return still.still === true;                  // 画面还在动 → 不动
}
