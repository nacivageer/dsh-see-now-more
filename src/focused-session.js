/**
 * focused-session.js — 把「主窗（GUI）当前选中的会话」写给悬浮窗看。
 *
 * ## 为什么需要这条通道
 *
 * 悬浮窗的【关联变更】要按主窗**当前打开**的会话预填，但窗口是另一个进程，
 * 拿不到渲染层的内存状态。旧办法是直接扫 Electron 的 Local Storage 磁盘文件，
 * 有两个缺口：
 *
 * 1. **落盘是异步的**：渲染层 `localStorage.setItem` 同步写内存，Chromium 再异步
 *    写 leveldb。刚切完会话马上点开输入行，磁盘上还是上一个会话。
 * 2. **压缩后键不再是明文**：leveldb 把 `.log` 并成 `.ldb` 时键要做前缀压缩，
 *    `dsh.sessions.current` 可能只剩 `s.current`（本机 000515/000517.ldb 实测），
 *    按完整键名扫描的读取器直接返回空。
 *
 * 所以改成 **Client 半侧主动推**：它在渲染层读 `localStorage`（内存态、即时），
 * POST 到 Host，Host 落成这份小 JSON。窗口读文件，读不到才退回旧的 leveldb 判据。
 *
 * 文件放在 `~/.dsh/see-now/`（运行时状态），不碰 `see-now.json`（用户配置）。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { chatDir, dshHome } from './chat.js';

/** 文件名；窗口侧 `session_hint.py` 按同一个名字读。 */
export const CURRENT_SESSION_FILE = 'current-session.json';

/** 会话 ID 的形状；和 `session_hint.py` / 窗口 `_resolve_session` 同一口径。 */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 合法就返回去掉首尾空白的全 ID，否则空串。 */
export function normalizeSessionId(value) {
  const sid = typeof value === 'string' ? value.trim() : '';
  return SESSION_ID.test(sid) ? sid : '';
}

export function currentSessionPath(env = process.env) {
  return join(chatDir(env), CURRENT_SESSION_FILE);
}

/**
 * 写「主窗当前会话」；`sid` 为空 = 删掉（主窗没有选中会话）。
 *
 * 原子写：先写 `.tmp` 再 rename，窗口任何时刻读到的都是完整 JSON。
 * 失败只记日志 —— 这只是预填的辅助信息，不能因为它把开窗/绑定带崩。
 *
 * @returns {{changed:boolean, path:string, sessionId:string|null, error?:string}}
 */
export function writeCurrentSession(sid, { env = process.env, log = () => {} } = {}) {
  const id = normalizeSessionId(sid);
  const path = currentSessionPath(env);
  try {
    if (!id) {
      if (existsSync(path)) unlinkSync(path);
      return { changed: true, path, sessionId: null };
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessionId: id, at: Date.now() }), 'utf8');
    renameSync(tmp, path);
    return { changed: true, path, sessionId: id };
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`写 ${path} 失败：${error}`);
    return { changed: false, path, sessionId: id || null, error };
  }
}

/**
 * 这个会话在 `~/.dsh/sessions/<workspace>/session-…` 里存在吗？
 *
 * 绑定前核对一次，防止 localStorage 里的旧值（或别的前端）把窗绑到一个
 * 已经不存在的会话上 —— 那会让窗里打的字全部投递失败。
 */
export function sessionExists(sid, { env = process.env } = {}) {
  const id = normalizeSessionId(sid);
  if (!id) return false;
  const root = join(dshHome(env), 'sessions');
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, id))) return true;
    }
  } catch { /* 读不了 sessions/：当不存在，不绑 */ }
  return false;
}
