/**
 * 左上角入口的两条 Host 路由（2026-11-10 建；2026-11-27 加 `current`）。
 *
 * 为什么测：
 * 1. 入口由**三处**共同决定能不能出现 —— `package.json` 的 `dsh.client`、`./client`
 *    导出里的 `client.js`、以及 `client.js` 自己注册的模块 id。任何一处写错，
 *    宿主什么都不报，界面上就是**没有按钮**。这三处只能靠测试钉住。
 * 2. Host 路由是「有 webServer 才挂」：没有 Web 载体的宿主必须安静跳过，
 *    不能因为少一个服务把整个插件带崩。
 * 3. 2026-11-27 起 `open` 会先按请求体里的 `sessionId` 改绑，`current` 写预填用的
 *    小文件 —— 这两条只碰临时 `DSH_HOME`，不会弹窗。
 *
 * POST `/open` 的真实开窗被 `DSH_SEE_NO_WINDOW=1` 短路，所以不会 spawn；
 * 绑定/预填的落盘发生在短路之前，正好能验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CURRENT_PATH, OPEN_PATH, registerOpenWindowRoute } from '../src/open-window.js';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SID = 'session-aaaaaaaa-1111-2222-3333-444444444444';

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

/** 假 request：带不给 body 的（模拟 GET / 空 POST）或一段 JSON 的。 */
function fakeRequest({ method = 'POST', body } = {}) {
  const buf = body === undefined ? null : Buffer.from(body);
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (buf) yield buf;
    },
  };
}

function routeFor(ctx, path) {
  const route = ctx.routes.find((r) => r.path === path);
  assert.ok(route, `没有挂 ${path}`);
  return route;
}

/** 在临时 DSH_HOME 里跑 fn，返回它读到的路径。 */
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'see-now-open-'));
  const saved = { home: process.env.DSH_HOME, disabled: process.env.DSH_SEE_NO_WINDOW };
  process.env.DSH_HOME = home;
  process.env.DSH_SEE_NO_WINDOW = '1';
  try {
    return await fn(home);
  } finally {
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home;
    if (saved.disabled === undefined) delete process.env.DSH_SEE_NO_WINDOW;
    else process.env.DSH_SEE_NO_WINDOW = saved.disabled;
    rmSync(home, { recursive: true, force: true });
  }
}

test('有 webServer 时挂 open / current 两条 exact 路由', () => {
  const ctx = fakeCtx();
  registerOpenWindowRoute(ctx, { log: () => {} });

  assert.deepEqual(ctx.injected, [['webServer']]);
  assert.equal(ctx.routes.length, 2);
  for (const [path, wanted] of [[OPEN_PATH, '/dsh-see-now-window/open'],
    [CURRENT_PATH, '/dsh-see-now-window/current']]) {
    const route = routeFor(ctx, path);
    assert.equal(route.kind, 'exact');
    assert.equal(typeof route.handler, 'function');
    assert.equal(path, wanted);
  }
});

test('没有 webServer 时静默跳过：不挂路由、不抛错', () => {
  const ctx = fakeCtx({ hasWeb: false });
  assert.doesNotThrow(() => registerOpenWindowRoute(ctx, { log: () => {} }));
  assert.equal(ctx.routes.length, 0);
});

test('两条路由都只收 POST：GET 回 405 且不碰窗口', async () => {
  const ctx = fakeCtx();
  registerOpenWindowRoute(ctx, { log: () => {} });
  for (const path of [OPEN_PATH, CURRENT_PATH]) {
    const res = fakeResponse();
    await routeFor(ctx, path).handler({ method: 'GET', resume() {} }, res);
    assert.equal(res.status, 405, path);
    assert.equal(res.headers.allow, 'POST');
    assert.equal(res.body, 'POST only');
  }
});

test('POST /open：DSH_SEE_NO_WINDOW=1 时回 disabled，且不因空 body 写配置', async () => {
  await withTempHome(async (home) => {
    const ctx = fakeCtx();
    registerOpenWindowRoute(ctx, { log: () => {} });
    const res = fakeResponse();
    // POST 会走「先取消隐藏、再开窗」：取消隐藏写的是临时 DSH_HOME 里的
    // watch-window.json，开窗被 DSH_SEE_NO_WINDOW 短路 —— 不会 spawn，也不会弹窗。
    await routeFor(ctx, OPEN_PATH).handler(fakeRequest(), res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'disabled');
    assert.equal(body.bound, false);
    assert.equal(existsSync(join(home, 'see-now.json')), false);
    assert.equal(existsSync(join(home, 'see-now', 'current-session.json')), false);
  });
});

test('POST /open 带 sessionId：先登记预填、写绑定，再走开窗（被 disabled 短路）', async () => {
  await withTempHome(async (home) => {
    // 绑定前会核对会话目录存在
    mkdirSync(join(home, 'sessions', '--workspace--', SID), { recursive: true });
    const ctx = fakeCtx();
    registerOpenWindowRoute(ctx, { log: () => {} });
    const res = fakeResponse();
    await routeFor(ctx, OPEN_PATH).handler(fakeRequest({ body: JSON.stringify({ sessionId: SID }) }), res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'disabled');
    assert.equal(body.bound, true);
    assert.equal(body.session, SID);

    const cfg = JSON.parse(readFileSync(join(home, 'see-now.json'), 'utf8'));
    assert.equal(cfg.session, SID);
    const current = JSON.parse(readFileSync(join(home, 'see-now', 'current-session.json'), 'utf8'));
    assert.equal(current.sessionId, SID);
  });
});

test('POST /open 带一个不存在的会话：只登记预填，不改绑定', async () => {
  await withTempHome(async (home) => {
    const ctx = fakeCtx();
    registerOpenWindowRoute(ctx, { log: () => {} });
    const res = fakeResponse();
    await routeFor(ctx, OPEN_PATH).handler(fakeRequest({ body: JSON.stringify({ sessionId: SID }) }), res);
    assert.equal(JSON.parse(res.body).bound, false, '会话不存在就不能报 bound');
    assert.equal(existsSync(join(home, 'see-now.json')), false, '不存在的会话不该被绑上');
    const current = JSON.parse(readFileSync(join(home, 'see-now', 'current-session.json'), 'utf8'));
    assert.equal(current.sessionId, SID, '预填文件仍可写；窗口侧会再核一次目录');
  });
});

test('POST /current：写预填文件；空 sessionId = 删掉旧文件', async () => {
  await withTempHome(async (home) => {
    const ctx = fakeCtx();
    registerOpenWindowRoute(ctx, { log: () => {} });
    const route = routeFor(ctx, CURRENT_PATH);
    const file = join(home, 'see-now', 'current-session.json');

    const res = fakeResponse();
    await route.handler(fakeRequest({ body: JSON.stringify({ sessionId: SID }) }), res);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).sessionId, SID);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionId, SID);

    const cleared = fakeResponse();
    await route.handler(fakeRequest({ body: '{}' }), cleared);
    assert.equal(cleared.status, 200);
    assert.equal(JSON.parse(cleared.body).sessionId, null);
    assert.equal(existsSync(file), false, '主窗没有选中会话时，旧文件不能留着');
  });
});

test('manifest 三处齐了才有按钮：dsh.client + ./client 导出 + 文件清单', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.equal(pkg.exports['./client'], './client.js');
  assert.ok(pkg.files.includes('client.js'), 'files 里没有 client.js：发布/拷贝时会漏掉按钮');
  assert.ok(existsSync(join(ROOT, 'client.js')));
});

test('client.js 注册的模块 id 与包名一致，且两条路由的地址一致', () => {
  const text = readFileSync(join(ROOT, 'client.js'), 'utf8');
  assert.match(text, new RegExp(`id:\\s*'${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
    'client.js 的 id 和包名不一致：宿主会把它当成另一个模块，按钮不出现');
  assert.ok(text.includes(`'${OPEN_PATH.slice(1)}'`), 'client.js 里的开窗路径和 Host 不一致');
  assert.ok(text.includes(`'${CURRENT_PATH.slice(1)}'`), 'client.js 里的当前会话路径和 Host 不一致');
  assert.ok(text.includes("'dsh.sessions.current'"), 'client.js 要读 DSH 持久化选中会话的那个键');
});
