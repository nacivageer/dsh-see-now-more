/**
 * 左上角入口的 **Host 半侧**：注册 `POST /dsh-see-now-window/open`。
 *
 * 浏览器里那个按钮查不到路由时什么都做不了，所以这里只做一件事：让悬浮窗可见。
 * 三种状态都是同一条路，理由在 `window.js` 的 `openWindow()` 里：
 *   1. 进程没起            → 拉起 python 悬浮窗
 *   2. 进程在、被用户藏了  → 取消隐藏（python 侧每 250ms 读一次标志）
 *   3. 进程在、心跳过期    → `openWindow()` 收掉旧的再开
 *
 * **顺序是先取消隐藏再开窗**：窗口启动时会读 `~/.dsh/watch-window.json` 的 `hidden`，
 * 带着旧值起来就是「开了但看不见」。
 *
 * 为什么不用模块级 `export const inject = ['webServer']`：那会让整个插件在**没有 Web
 * 载体**的宿主里起不来（采集、听声音、see_now 工具一起陪葬）。入口按钮只是锦上添花，
 * 所以走 `ctx.inject(['webServer'], …)`：有就接上，没有就静默跳过，别的照常。
 */

import { openWindow, setWindowHidden, windowHidden, windowReport } from './window.js';

/** 路由路径。Client 半侧（`client.js`）按相对地址拼它。 */
export const OPEN_PATH = '/dsh-see-now-window/open';

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * 把路由挂到 Web 载体上（有才挂）。
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
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
          response.end('POST only');
          return;
        }
        // 请求体没有意义（能做的只有开窗），但要把客户端发来的东西读掉才能关掉 socket。
        request.resume();

        try {
          const before = setWindowHidden(false, { log });
          const opened = await openWindow({ log });
          if (!opened?.ok) {
            sendJson(response, 200, {
              ok: false,
              code: opened?.reason === 'disabled' ? 'disabled' : 'open-failed',
              error: opened?.reason ? String(opened.reason) : '开窗失败，没给原因',
            });
            return;
          }
          // 已活着的进程保留自己的可见状态，这里再确认一次（python 侧 250ms 内轮询到）。
          if (windowHidden()) setWindowHidden(false, { log });
          log(`window open (already=${Boolean(opened.already)}, unhidden=${Boolean(before?.changed)})`);
          sendJson(response, 200, {
            ok: true,
            already: Boolean(opened.already),
            window: windowReport(),
          });
        } catch (e) {
          sendJson(response, 500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    }), `see-now-more: POST ${OPEN_PATH}`);
    log(`route ${OPEN_PATH} registered`);
  });
}
