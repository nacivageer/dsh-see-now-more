/**
 * 左上角入口的两条守卫（2026-11-10，入口从 `dsh-see-now-launcher` 合并进本包）。
 *
 * 为什么测：
 * 1. 入口由**三处**共同决定能不能出现 —— `package.json` 的 `dsh.client`、`./client`
 *    导出里的 `client.js`、以及 `client.js` 自己注册的模块 id。任何一处写错，
 *    宿主什么都不报，界面上就是**没有按钮**。这三处只能靠测试钉住。
 * 2. Host 路由是「有 webServer 才挂」：没有 Web 载体的宿主必须安静跳过，
 *    不能因为少一个服务把整个插件带崩。
 *
 * 这里**只测 GET 分支**（405）：POST 会真的去 spawn 悬浮窗，测试不能弹窗到用户脸上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPEN_PATH, registerOpenWindowRoute } from '../src/open-window.js';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 收集路由的假上下文；`hasWeb:false` 模拟没有 Web 载体的宿主。 */
function fakeCtx({ hasWeb = true } = {}) {
  const routes = [];
  const injected = [];
  return {
    routes,
    injected,
    inject(deps, cb) {
      injected.push(deps);
      if (!hasWeb) return;
      cb({
        webServer: {
          register(route) { routes.push(route); return () => {}; },
        },
        effect(fn) { fn(); },
      });
    },
  };
}

function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

test('有 webServer 时挂一条 exact 路由，路径就是 OPEN_PATH', () => {
  const ctx = fakeCtx();
  registerOpenWindowRoute(ctx, { log: () => {} });

  assert.deepEqual(ctx.injected, [['webServer']]);
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].kind, 'exact');
  assert.equal(ctx.routes[0].path, OPEN_PATH);
  assert.equal(typeof ctx.routes[0].handler, 'function');
  assert.equal(OPEN_PATH, '/dsh-see-now-window/open');
});

test('没有 webServer 时静默跳过：不挂路由、不抛错', () => {
  const ctx = fakeCtx({ hasWeb: false });
  assert.doesNotThrow(() => registerOpenWindowRoute(ctx, { log: () => {} }));
  assert.equal(ctx.routes.length, 0);
});

test('路由只收 POST：GET 回 405 且不碰窗口', async () => {
  const ctx = fakeCtx();
  registerOpenWindowRoute(ctx, { log: () => {} });
  const res = fakeResponse();
  await ctx.routes[0].handler({ method: 'GET', resume() {} }, res);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
  assert.equal(res.body, 'POST only');
});

test('POST：DSH_SEE_NO_WINDOW=1 时回 disabled，且全程不碰真实 ~/.dsh', async () => {
  const home = mkdtempSync(join(tmpdir(), 'see-now-open-'));
  const saved = { home: process.env.DSH_HOME, disabled: process.env.DSH_SEE_NO_WINDOW };
  process.env.DSH_HOME = home;
  process.env.DSH_SEE_NO_WINDOW = '1';
  try {
    const ctx = fakeCtx();
    registerOpenWindowRoute(ctx, { log: () => {} });
    const res = fakeResponse();
    // POST 会走「先取消隐藏、再开窗」：取消隐藏写的是临时 DSH_HOME 里的
    // watch-window.json，开窗被 DSH_SEE_NO_WINDOW 短路 —— 不会 spawn，也不会弹窗。
    await ctx.routes[0].handler({ method: 'POST', resume() {} }, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'disabled');
  } finally {
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home;
    if (saved.disabled === undefined) delete process.env.DSH_SEE_NO_WINDOW;
    else process.env.DSH_SEE_NO_WINDOW = saved.disabled;
    rmSync(home, { recursive: true, force: true });
  }
});

test('manifest 三处齐了才有按钮：dsh.client + ./client 导出 + 文件清单', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.equal(pkg.exports['./client'], './client.js');
  assert.ok(pkg.files.includes('client.js'), 'files 里没有 client.js：发布/拷贝时会漏掉按钮');
  assert.ok(existsSync(join(ROOT, 'client.js')));
});

test('client.js 注册的模块 id 与包名一致', () => {
  const text = readFileSync(join(ROOT, 'client.js'), 'utf8');
  assert.match(text, new RegExp(`id:\\s*'${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
    'client.js 的 id 和包名不一致：宿主会把它当成另一个模块，按钮不出现');
});
