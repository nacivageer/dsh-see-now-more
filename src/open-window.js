/**
 * 左上角入口的 **Host 半侧**：注册两条路由。
 *
 *   POST /dsh-see-now-window/open     让悬浮窗可见（三种状态同一条路）
 *   POST /dsh-see-now-window/current  主窗当前选中的会话（Client 每 2 秒推一次，变了才发）
 *
 * 浏览器里那个按钮查不到路由时什么都做不了，所以 open 只做一件事：让悬浮窗可见。
 * 三种状态都是同一条路，理由在 `window.js` 的 `openWindow()` 里：
 *   1. 进程没起            → 拉起 python 悬浮窗
 *   2. 进程在、被用户藏了  → 取消隐藏（python 侧每 250ms 读一次标志）
 *   3. 进程在、心跳过期    → `openWindow()` 收掉旧的再开
 *
 * **顺序是先取消隐藏再开窗**：窗口启动时会读 `~/.dsh/watch-window.json` 的 `hidden`，
 * 带着旧值起来就是「开了但看不见」。
 *
 * 2026-11-27：`open` 的请求体带上 `sessionId`（Client 从渲染层读的当前会话），
 * Host 先把它写进 `~/.dsh/see-now.json` 的 `session` 再开窗 ——
 * **从哪个会话点开，悬浮窗就关联到哪个会话**。窗口开着时它每 2 秒重读这个文件，
 * 会自动换绑，不用重启。`current` 那条路顺便把同一个值写成
 * `~/.dsh/see-now/current-session.json`，给【关联变更】预填用（见 `focused-session.js`）。
 *
 * 为什么不用模块级 `export const inject = ['webServer']`：那会让整个插件在**没有 Web
 * 载体**的宿主里起不来（采集、听声音、see_now 工具一起陪葬）。入口按钮只是锦上添花，
 * 所以走 `ctx.inject(['webServer'], …)`：有就接上，没有就静默跳过，别的照常。
 */

import { normalizeSessionId, sessionExists, writeCurrentSession } from './focused-session.js';
import { writeBoundSession } from './tuning.js';
import { openWindow, setWindowHidden, windowHidden, windowReport } from './window.js';

/** 开窗路由。Client 半侧（`client.js`）按相对地址拼它。 */
export const OPEN_PATH = '/dsh-see-now-window/open';

/** 「主窗当前会话」上报路由（同一份地址表也写在 `client.js` 里）。 */
export const CURRENT_PATH = '/dsh-see-now-window/current';

/** 请求体上限：只有两个小字段，64KB 已经宽得离谱。 */
const MAX_BODY = 64 * 1024;

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function methodNotAllowed(response) {
  response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
  response.end('POST only');
}

/**
 * 读掉请求体并解析成对象。读不了 / 不是 JSON 对象 / 太大 → 空对象（调用方当没带）。
 *
 * 用异步迭代而不是 `request.on('data')`：HTTP handler 是 async 的，迭代写法
 * 不必自己管 `end` / `error` 的先后。测试里的假 request 没有迭代器，会落进
 * catch 返回 `{}` —— 这正是「没带 body」的语义。
 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) return {};
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch { return {}; }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function handleOpen(request, response, log) {
  if (request.method !== 'POST') { methodNotAllowed(response); return; }

  const body = await readJsonBody(request);
  const sid = normalizeSessionId(body?.sessionId);
  let boundOk = false;

  /**
   * 先登记再开窗：
   * - `current-session.json` 是【关联变更】的预填来源，开窗这一下也顺手更新；
   * - `see-now.json` 的 `session` 决定窗的绑定，新起的窗启动时就读它。
   *   **已经开着的窗**会在下一次轮询（≤2 秒）看到变化并自己换绑。
   *
   * 会话不存在就只登记不绑定：旧 localStorage 值可能指向一个手工删掉的目录，
   * 绑上去会让窗里的话全部投递失败。不存在的 id 也照样写进 current-session，
   * 窗口预填时会用 `_resolve_session` 再核一次并退回兜底。
   */
  if (sid) {
    writeCurrentSession(sid, { log });
    if (sessionExists(sid)) {
      const bound = writeBoundSession(sid, { log });
      boundOk = !bound.error;
    } else {
      log(`主窗会话 ${sid} 不在 sessions/ 里，跳过绑定`);
    }
  } else {
    log('open 没带 sessionId：只开窗，不改绑定');
  }

  try {
    const before = setWindowHidden(false, { log });
    const opened = await openWindow({ log });
    if (!opened?.ok) {
      sendJson(response, 200, {
        ok: false,
        code: opened?.reason === 'disabled' ? 'disabled' : 'open-failed',
        error: opened?.reason ? String(opened.reason) : '开窗失败，没给原因',
        bound: boundOk,
        session: sid || null,
      });
      return;
    }
    // 已活着的进程保留自己的可见状态，这里再确认一次（python 侧 250ms 内轮询到）。
    if (windowHidden()) setWindowHidden(false, { log });
    log(`window open (already=${Boolean(opened.already)}, unhidden=${Boolean(before?.changed)}, `
      + `bound=${boundOk})`);
    sendJson(response, 200, {
      ok: true,
      already: Boolean(opened.already),
      bound: boundOk,
      session: sid || null,
      window: windowReport(),
    });
  } catch (e) {
    sendJson(response, 500, { ok: false, error: String(e?.message ?? e) });
  }
}

async function handleCurrent(request, response, log) {
  if (request.method !== 'POST') { methodNotAllowed(response); return; }
  const body = await readJsonBody(request);
  const raw = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  const sid = normalizeSessionId(raw);
  // 空 = 主窗没有选中会话（归档 / 清空），把旧文件删掉，别让预填拿着一个旧 id。
  const result = writeCurrentSession(sid, { log });
  sendJson(response, 200, {
    ok: !result.error,
    sessionId: result.sessionId,
    ...(result.error ? { error: result.error } : {}),
  });
}

/**
 * 把两条路由挂到 Web 载体上（有才挂）。
 *
 * 回调里的 `webCtx` 只在 `webServer` 服务就绪时执行，所以不用自己判空；
 * `effect` 让路由跟着插件与服务的生命周期一起拆卸/重挂。
 *
 * @param {object} ctx 插件上下文
 * @param {{log?: (message: string) => void}} [options]
 */
export function registerOpenWindowRoute(ctx, { log = () => {} } = {}) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: (request, response) => handleOpen(request, response, log),
    }), `see-now-more: POST ${OPEN_PATH}`);
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CURRENT_PATH,
      handler: (request, response) => handleCurrent(request, response, log),
    }), `see-now-more: POST ${CURRENT_PATH}`);
    log(`route ${OPEN_PATH} registered`);
    log(`route ${CURRENT_PATH} registered`);
  });
}
