/**
 * titles.js — DSH 会话标题 ⇄ 悬浮窗的双向同步。
 *
 * DSH 的标题是会话日志里最新的 `session/title` 事件（`source.kind` 为
 * `user` / `provider` / `fallback`，最新一条为准）。窗口原来只知道自己的
 * `session-titles.json`，于是：DSH 里改名窗口看不见，窗口里改名 DSH 不知道。
 *
 * 这里补两条边：
 *   ① **读**：`session/event` 里遇到 `session/title` → 写 `see-now/title-sync.json`
 *      镜像（窗口读它，不碰会话日志）；插件启动时用 `sessionQuery` 把
 *      `chat.jsonl` 里出现过的会话标题播种进来，历史列表不用逐个解压日志。
 *   ② **写**：轮询窗口写的 `see-now/title-request.json` → 调
 *      `ctx.sessionController.rename({sessionId, title})`。这是 DSH 自己的改名
 *      入口：写 `session/title` 事件、更新客户端 `title` 投影，左侧栏跟着变。
 *      **不要**直接往会话日志追加 zstd 帧 —— 日志是宿主持有的追加流，外面写会
 *      和它的压缩上下文打架，而且改了也进不了客户端的投影。
 *
 * 结果写 `title-request-result.json`（窗口 2.5 秒后读它判断"同步了 / 失败了 /
 * 排队了"）。请求处理完即删；插件重载后不会把同一个请求再改一遍。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { chatDir, chatFile } from './chat.js';

/** 镜像里最多留多少条（按 `at` 从新到旧）。 */
const MAX_TITLES = 300;
/** 窗口写完请求后，插件多久看一次。 */
const REQUEST_POLL_MS = 1000;

export function titlePaths(env = process.env) {
  const dir = chatDir(env);
  return {
    sync: join(dir, 'title-sync.json'),
    request: join(dir, 'title-request.json'),
    result: join(dir, 'title-request-result.json'),
    log: join(dir, 'title-sync.log'),
  };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** 读镜像：`{sid: {title, source, at}}`；坏文件当空的，不影响主流程。 */
export function readTitleSync(env = process.env) {
  const data = readJson(titlePaths(env).sync, null);
  const out = {};
  for (const [sid, v] of Object.entries(data?.titles ?? {})) {
    if (!v || typeof v !== 'object') continue;
    const title = String(v.title ?? '').trim();
    if (!title) continue;
    out[sid] = { title, source: String(v.source ?? ''), at: Number(v.at) || 0 };
  }
  return out;
}

function writeTitleSync(map, env) {
  const kept = Object.entries(map)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, MAX_TITLES);
  writeJson(titlePaths(env).sync, {
    v: 1,
    updated: Date.now(),
    titles: Object.fromEntries(kept),
  });
}

/** `chat.jsonl` 里出现过的会话 id（最近 4000 行，去重，保持出现顺序）。 */
export function chatSessionIds(env = process.env) {
  const out = new Set();
  try {
    const lines = readFileSync(chatFile(env), 'utf8').split('\n').slice(-4000);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const sid = JSON.parse(line)?.sid;
        if (sid) out.add(String(sid));
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 没有 chat.jsonl：还没人用过窗口 */ }
  return [...out];
}

/** 取服务：先 `ctx.get()`，老宿主退回属性访问且包 try。 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 老宿主没有 get */ }
  try {
    return ctx?.[key];
  } catch {
    return undefined;
  }
}

/**
 * @param {{ctx: object, log?: (m: string) => void}} o
 * @returns {{onEvent: (sid: string, event: object) => void, start: () => void,
 *            dispose: () => void, read: () => object}}
 */
export function createTitleSync({ ctx, log = () => {} }) {
  const paths = titlePaths();
  const map = readTitleSync();
  let timer = null;
  let disposed = false;

  /** 插件 logger 只在开发者工具里，这里再落一份文件，排查"为什么没同步"时直接看它。 */
  const note = (m) => {
    log(m);
    try {
      mkdirSync(dirname(paths.log), { recursive: true });
      appendFileSync(paths.log, `${new Date().toISOString()} ${m}\n`, 'utf8');
    } catch { /* 日志写不进去不能影响同步本身 */ }
  };

  /**
   * 记一条标题。**值没变就不写盘**（标题事件会随每轮自动生成更新）。
   * @returns {boolean} 是否真的变了
   */
  const remember = (sid, title, source, { save = true } = {}) => {
    sid = String(sid ?? '');
    title = String(title ?? '').trim();
    if (!sid || !title) return false;
    const cur = map[sid];
    const kind = String(source ?? '');
    if (cur && cur.title === title && cur.source === kind) return false;
    map[sid] = { title, source: kind, at: Date.now() };
    if (save) {
      try { writeTitleSync(map); } catch (e) { note(`镜像写失败：${e?.message ?? e}`); }
    }
    return true;
  };

  /** 用 DSH 的会话查询服务把已知会话的标题灌进来（窗口历史列表靠它，不用解压日志）。 */
  const seed = async () => {
    const ids = chatSessionIds();
    if (!ids.length) return;
    const sq = serviceOf(ctx, 'sessionQuery');
    if (!sq?.readTitleSnapshots) {
      note('播种跳过：这个部署没有 sessionQuery 服务');
      return;
    }
    try {
      const results = await sq.readTitleSnapshots(ids);
      let n = 0;
      ids.forEach((sid, i) => {
        const r = results?.[i];
        if (!r || r.status !== 'fulfilled') return;
        const snap = r.value?.title;
        if (!snap?.title) return;
        if (remember(sid, snap.title, snap.source?.kind, { save: false })) n++;
      });
      if (n) writeTitleSync(map);
      note(`播种 ${n} 条标题（${ids.length} 个会话）`);
    } catch (e) {
      note(`播种失败：${e?.message ?? e}`);
    }
  };

  /** 处理一条窗口写回的改名请求；处理完（成败都）删掉请求，防插件重载后重复改。 */
  const applyRequest = async () => {
    if (disposed) return;
    const req = readJson(paths.request, null);
    if (!req || !req.sid || typeof req.title !== 'string') return;
    try { unlinkSync(paths.request); } catch { /* 别人已删 */ }
    const id = Number(req.id) || 0;
    const title = req.title.trim();
    if (!title) {
      writeJson(paths.result, { id, ok: false, error: '空标题（DSH 没有删除标题的接口）', at: Date.now() });
      return;
    }
    const sc = serviceOf(ctx, 'sessionController');
    if (!sc?.rename) {
      writeJson(paths.result, { id, ok: false, error: 'sessionController 不可用', at: Date.now() });
      note('写回失败：没有 sessionController');
      return;
    }
    try {
      const res = await sc.rename({ sessionId: req.sid, title });
      const accepted = String(res?.title ?? title);
      writeJson(paths.result, { id, ok: true, title: accepted, at: Date.now() });
      note(`写回 DSH：${String(req.sid).slice(0, 16)} → ${accepted}`);
    } catch (e) {
      const err = String(e?.message ?? e);
      writeJson(paths.result, { id, ok: false, error: err, at: Date.now() });
      note(`写回失败：${String(req.sid).slice(0, 16)}：${err}`);
    }
  };

  /** 会话事件里的 `session/title`（绑定与非绑定会话都记，历史列表要用）。 */
  const onEvent = (sid, event) => {
    if (disposed || event?.type !== 'session/title') return;
    const d = event.data ?? {};
    if (remember(sid, d.title, d.source?.kind)) {
      note(`标题：${String(sid).slice(0, 16)} → ${String(d.title).slice(0, 40)}`
        + `（${d.source?.kind ?? '?'}）`);
    }
  };

  const start = () => {
    void seed().catch(() => {});
    void applyRequest();
    timer = setInterval(() => { void applyRequest(); }, REQUEST_POLL_MS);
    if (typeof timer?.unref === 'function') timer.unref();
  };

  const dispose = () => {
    disposed = true;
    if (timer) { clearInterval(timer); timer = null; }
  };

  return { onEvent, start, dispose, read: () => ({ ...map }) };
}
