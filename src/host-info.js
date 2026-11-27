/**
 * host-info.js — 宿主坐标与「重启意图」的落盘（2026-11-27，`0.1.1-more.39`）。
 *
 * 悬浮窗要重启 DSH，先得知道**它当初是怎么起来的**：桌面端是 Electron，
 * `process.execPath` 就是 GUI 的 exe，`process.ppid` 是 Electron 主进程（Host 是它的子进程）。
 * 这些只有跑在 Host 里的插件知道，窗口猜不到 —— 所以每次插件启动写一份
 * `~/.dsh/see-now/host.json`，窗口侧只有 `examples/floating-chat/host_restart.py` 读它
 * （只认字段，不 import 本文件；两边共享的只有这份线格式）。
 *
 * 两件必须写死的事：
 * - **`ELECTRON_RUN_AS_NODE` 要剥掉**：Host 是带这个变量起的；窗口若原样继承，它拉起来的
 *   `DeepSeek Harness.exe` 会当 node 跑，没有面板。所以记录里带一份 `poison`，
 *   窗口按名单剥，而不是靠猜。
 * - **不写密钥**：env 只留 `DSH_HOME` / `DSH_PROFILE` / `DSH_PRIMARY_RUNTIME` 三个白名单键。
 *   这份文件是明文的，任何人 `cat` 一下都看得到。
 *
 * 重启流程里两边各写一半：
 *   窗口  → `restart.json`（requested / killing / launched / failed）
 *   插件  → 启动时把 `restart.json` 收敛成 done，并写一条回执到 chat.jsonl
 * 这样「谁在什么时候重启了、回来后是哪一版」不靠谁记得。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HOST_INFO_VERSION = 1;
export const HOST_INFO_FILE = 'host.json';
export const RESTART_FILE = 'restart.json';

/**
 * 子进程里必须去掉的环境变量。
 *
 * 只列实测会改行为的：`ELECTRON_RUN_AS_NODE=1` 会让 Electron 当 Node 跑（没有面板）；
 * 别的（`NODE_OPTIONS` 之类）留空就不列 —— 名单越长越容易过期。
 */
export const POISON_ENV = Object.freeze(['ELECTRON_RUN_AS_NODE']);

/** env 白名单：只记这三个，够窗口复现同一个用户目录，又不带任何凭据。 */
const ENV_KEYS = Object.freeze(['DSH_HOME', 'DSH_PROFILE', 'DSH_PRIMARY_RUNTIME']);

/** 读 JSON，容忍 BOM（PowerShell 5.1 的默认产物）；坏文件当不存在。 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 原子写：`.tmp` 再 rename。窗口可能在轮询，不能让它读到半行。 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * 组装一条宿主坐标记录。**纯函数**：进程信息由调用方给，测试才不用起真宿主。
 *
 * @param {{execPath?:string, hostPid?:number, appPid?:number, cwd?:string,
 *          argv?:string[], env?:object, version?:string, at?:number}} [o]
 */
export function hostRecord({
  execPath, hostPid, appPid, cwd, argv = [], env = {}, version = '?', at = Date.now(),
} = {}) {
  const kept = {};
  for (const key of ENV_KEYS) {
    const v = env?.[key];
    if (typeof v === 'string' && v.trim()) kept[key] = v.trim();
  }
  return {
    v: HOST_INFO_VERSION,
    at,
    // 拉起 GUI 用的 exe：桌面端就是 Electron 本身（不是 node，也不是 dsh 的 CLI）
    exe: typeof execPath === 'string' ? execPath : '',
    // Electron 主进程 = Host 的父进程；窗口杀它才会带着 Host 和渲染进程一起走
    appPid: Number.isInteger(appPid) && appPid > 0 ? appPid : null,
    hostPid: Number.isInteger(hostPid) && hostPid > 0 ? hostPid : null,
    cwd: typeof cwd === 'string' ? cwd : '',
    // argv 只作留痕（排查"当初怎么起的"），窗口拉起时一律不带参数
    argv: Array.isArray(argv) ? argv.map(String) : [],
    env: kept,
    poison: [...POISON_ENV],
    version: String(version ?? '?'),
  };
}

/**
 * 写 `host.json`。返回 `{path, record}`。
 *
 * 调用点只有一处（`index.js` 注册工具成功之后）—— **放在工具注册成功之后**，
 * 于是「host.json 是新的」就等于「插件这一次起来了、工具注册过了」，
 * 窗口的自核不需要再去翻宿主的日志。
 */
export function writeHostInfo({ dir, version = '?', log = () => {}, now = Date.now() } = {}) {
  if (!dir) throw new Error('writeHostInfo 需要 dir');
  const record = hostRecord({
    execPath: process.execPath,
    hostPid: process.pid,
    appPid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv,
    env: process.env,
    version,
    at: now,
  });
  const path = join(dir, HOST_INFO_FILE);
  writeJsonAtomic(path, record);
  try { log?.(`宿主坐标：${path}（exe ${record.exe || '?'}，app ${record.appPid ?? '?'}）`); } catch { /* 日志失败不影响 */ }
  return { path, record };
}

/** 读 `restart.json`；不是"正在重启"的相位就返回 null。 */
export function readPendingRestart(dir) {
  const it = readJson(join(dir, RESTART_FILE));
  if (!it || typeof it !== 'object') return null;
  const phase = String(it.phase ?? '');
  if (!['requested', 'killing', 'launched'].includes(phase)) return null;
  return it;
}

/** 整份重启状态（status 用；没有就 null）。 */
export function readRestartState(dir) {
  const it = readJson(join(dir, RESTART_FILE));
  return it && typeof it === 'object' ? it : null;
}

/** 还没结束的相位：已经排着/在跑，就别再写一份盖掉它。 */
const LIVE_PHASES = new Set(['queued', 'requested', 'waiting-idle', 'killing', 'launched']);

/**
 * 模型排一次重启（2026-11-27）。
 *
 * **只写请求、不执行**：插件就住在要重启的那个进程里，它重启自己等于掐断当前回合；
 * 执行端是悬浮窗（`window.py` 的 `_watch_restart_requests`），它每 2 秒看一次 `queued`。
 * 回执由重启后的新宿主写（`finishRestart`），下一次 `status` 里读。
 *
 * @returns {{path:string, intent:object, already:boolean}}
 */
export function queueRestart({ dir, by = 'agent', session = null, version = '?', now = Date.now() } = {}) {
  if (!dir) throw new Error('queueRestart 需要 dir');
  const path = join(dir, RESTART_FILE);
  const prev = readJson(path);
  if (prev && LIVE_PHASES.has(String(prev.phase ?? ''))) {
    return { path, intent: prev, already: true };
  }
  const intent = {
    v: 1, at: now, by, phase: 'queued', session,
    fromVersion: version,
  };
  writeJsonAtomic(path, intent);
  return { path, intent, already: false };
}

/**
 * `restart.json` → status 里的一行。**纯函数**，`now` 由调用方给，测试才好固定。
 *
 * 没有记录返回 null（status 里就不多这一行）。
 */
export function restartLine(restart) {
  if (!restart || typeof restart !== 'object') return null;
  const phase = String(restart.phase ?? '');
  if (phase === 'queued') return '已排队（等这一轮跑完，由悬浮窗执行）';
  if (phase === 'waiting-idle') return '在等空闲（有回合在跑）';
  if (phase === 'requested' || phase === 'killing' || phase === 'launched') return `进行中（${phase}）`;
  if (phase === 'done') {
    const old = Number(restart.oldHostPid);
    const from = Number.isInteger(old) && old > 0 ? String(old) : '?';
    const sec = Number.isFinite(Number(restart.elapsedMs)) ? Math.round(Number(restart.elapsedMs) / 1000) : null;
    return `上次：v${restart.newVersion ?? '?'}（宿主 ${from} → ${restart.newHostPid ?? '?'}`
      + `${sec === null ? '' : `，${sec} 秒`}）`;
  }
  if (phase === 'launched-legacy') return '上次：DSH 已拉起，但旧版插件写不出回执';
  if (phase === 'failed') return `上次失败：${restart.reason ?? '原因未记'}`;
  return `相位 ${phase || '?'}`;
}

/**
 * 回执文案。**纯函数**：时间、pid、版本都由调用方给，测试才好固定。
 *
 * @param {{by?:string, oldHostPid?:number, at?:number}} intent
 * @param {{version:string, hostPid:number, now?:number}} o
 */
export function restartNotice(intent, { version, hostPid, now = Date.now() } = {}) {
  const old = Number(intent?.oldHostPid);
  const from = Number.isInteger(old) && old > 0 ? String(old) : '?';
  const started = Number(intent?.at);
  const sec = Number.isFinite(started) && started > 0
    ? Math.max(0, Math.round((now - started) / 1000))
    : null;
  const who = intent?.by === 'window' ? '窗发起' : intent?.by === 'agent' ? '会话发起' : '重启';
  return `已回到 v${version}（${who}，宿主 ${from} → ${hostPid}${sec === null ? '' : `，用时 ${sec} 秒`}）`
    + ' · 工具已注册 · 采集未开（要 watch 才起）';
}

/**
 * 插件启动时的收敛：有「正在重启」的意图、而且**不是同一个 Host 进程**，
 * 就写回执、把 intent 标成 done。返回 `null` 表示这次启动与重启无关。
 *
 * 幂等：同一份 intent 只认一次（写完相位就变了），窗口重启窗自己不会重复弹。
 *
 * @returns {{text:string, intent:object, path:string}|null}
 */
export function finishRestart({ dir, hostPid = process.pid, version = '?', now = Date.now(), log = () => {} } = {}) {
  const intent = readPendingRestart(dir);
  if (!intent) return null;
  if (Number(intent.oldHostPid) === Number(hostPid)) {
    // 同一个进程又加载了一次（宿主内部重载）：不是重启，别把它标成完成
    return null;
  }
  const text = restartNotice(intent, { version, hostPid, now });
  const path = join(dir, RESTART_FILE);
  try {
    writeJsonAtomic(path, {
      ...intent,
      phase: 'done',
      newHostPid: hostPid,
      newVersion: version,
      doneAt: now,
      elapsedMs: Number.isFinite(Number(intent.at)) ? Math.max(0, now - Number(intent.at)) : null,
      text,
    });
  } catch (e) {
    try { log?.(`回执写不进 ${path}：${e?.message ?? e}`); } catch { /* 不影响主流程 */ }
  }
  return { text, intent, path };
}

/**
 * 把回执送进会话时用的那一句。**纯函数**。
 *
 * 为什么要送：重启完成后，回执原先只写进 `chat.jsonl` 和 `restart.json` ——
 * 窗里看得见、模型看不见，得靠下一次主动 `status` 去要（2026-11-27 格指出：
 * 「你居然不是自动从窗里收回执的吗」）。闭环应该是重启回来的这一版**自己说一句**。
 */
export function restartWakeText(receipt) {
  const t = String(receipt ?? '').trim();
  return `（看屏幕 · 系统回执）${t || '重启完成'}\n`
    + '这条是悬浮窗写的回执，不用再调 `status` 核对；要继续刚才没做完的事就接着做。';
}

/** `host.json` 的年龄（秒）。窗口用它判断坐标是不是上次开机留下的。 */
export function hostInfoAgeSec(path, now = Date.now()) {
  try { return Math.max(0, (now - statSync(path).mtimeMs) / 1000); } catch { return null; }
}
