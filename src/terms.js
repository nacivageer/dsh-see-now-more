/**
 * terms.js — 台词的后处理替换表（`~/.dsh/see-now/terms.json`）。
 *
 * 为什么需要：sherpa 的 paraformer 不支持热词，专名会稳定地听错
 * （实测：心之集域→心之极玉、生者→生物、乘务员→王无源/陈务元）。
 * 与其等换模型，不如先做一层**确定性替换**：便宜、可审计、错也只错在表里。
 *
 * 两条纪律：
 * 1. **长串优先**（"心之极玉" 先于 "极玉"），否则短串会先把长串拆掉；
 * 2. 左侧至少两个字 —— 单字替换会把正常句子改坏，收益远小于风险。
 */

/** 默认规则文件：`$DSH_HOME/see-now/terms.json`。 */
export const TERM_MAX_RULES = 200;
/** 单字规则不接（`生`→`身` 这种，改对了是运气，改错了是灾难）。 */
export const TERM_MIN_FROM = 2;

/**
 * 读规则。支持两种写法：`[{from,to}, …]` 或 `{rules:[…]}`。
 * 文件不存在 / 解析失败 → 空表（没有术语表也该照常听）。
 *
 * @param {string} path
 * @returns {Array<{from:string,to:string}>} 已按 `from` 长度倒序
 */
export function loadTermRules(path, { readFile = null } = {}) {
  if (!path || typeof readFile !== 'function') return [];
  let raw = null;
  try { raw = readFile(path, 'utf8'); } catch { return []; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rules) ? parsed.rules : []);
  const rules = [];
  for (const r of list.slice(0, TERM_MAX_RULES)) {
    const from = String(r?.from ?? '');
    const to = String(r?.to ?? '');
    if (from.length < TERM_MIN_FROM || !to || from === to) continue;
    rules.push({ from, to });
  }
  return rules.sort((a, b) => b.from.length - a.from.length);
}

/**
 * 把一条台词过一遍规则表。**只做字面替换**，不做模糊匹配 —— 宁可漏改，不要改错。
 */
export function applyTerms(text, rules) {
  let out = String(text ?? '');
  if (!out || !Array.isArray(rules) || !rules.length) return out;
  for (const { from, to } of rules) {
    if (!from || !to || from === to) continue;
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}
