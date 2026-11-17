/**
 * window-source.test.mjs — `source:"window"`（WGC 按窗口抓）的入口与探针解析。
 *
 * 背景（2026-11-17 定的口径）：
 *   - 窗口化游戏 + 常切到别的聊天窗 → 屏幕抓会拿到"挡住它的那个窗口"，必须按窗口抓；
 *   - 窗口最小化 → **不抓**（窗口停止渲染，WGC 只会等到超时）；
 *   - D3D 独占全屏 → 不用 WGC，改抓屏幕（这条靠首帧超时，测不了单测，见 runner 的注释）。
 *
 * 这里只测**能纯函数测的部分**：入口怎么造 source、探针那行 JSON 怎么解析。
 * 真的抓帧要真机（`py/wgc_capture.py --check/--size` 有单独的手工验证记录）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-window-'));
process.env.DSH_SEE_NO_WINDOW = '1';

const { __test } = await import('../src/index.js');
const { srcOf } = __test;
const { parseProbeLine, windowCaptureArgs } = await import('../src/capture-window.js');
const { seeNowToolSpec } = await import('../src/tool-spec.js');

test('source:"window" 不配 title 就明确报错，不许猜窗口', () => {
  const r = srcOf({ source: 'window' });
  assert.equal(r.src, null);
  assert.equal(r.reason, 'no-window-title');
  assert.match(r.error, /window:/);
});

test('source:"window" 配 title 造出 window 源，且不塞 gdigrab', () => {
  const r = srcOf({ source: 'window', window: '某个窗口' });
  assert.deepEqual(r.src, { kind: 'window', title: '某个窗口' });
  assert.equal(r.src.engine, undefined, '窗口源走 WGC，不该带 gdigrab 的 engine 覆盖');
});

test('window 源可以叠 region（屏幕物理像素；裁剪由 sidecar 换算）', () => {
  const r = srcOf({ source: 'window', window: '某个窗口', region: '10,20,300,200' });
  assert.equal(r.src.kind, 'window');
  assert.deepEqual(r.src.region, { x: 10, y: 20, w: 300, h: 200 });
  assert.equal(r.src.engine, undefined);
});

test('屏幕源叠 region 仍然强制 gdigrab（ddagrab 没有偏移参数）', () => {
  const r = srcOf({ source: 'screen', region: '10,20,300,200' });
  assert.equal(r.src.engine, 'gdigrab');
});

test('window:"off" 不是合法标题（它是血条那边的"回到抓屏幕"）', () => {
  const r = srcOf({ source: 'window', window: 'off' });
  assert.equal(r.src, null);
  assert.equal(r.reason, 'no-window-title');
});

test('未知 source 直接顶回来，别让 ffmpeg 去猜', () => {
  const r = srcOf({ source: 'desktop' });
  assert.equal(r.src, null);
  assert.equal(r.reason, 'bad-source');
  assert.match(r.error, /screen/);
});

test('region 不能配 obs / camera（file 会先在 path 那关被拦下）', () => {
  for (const kind of ['obs', 'camera']) {
    const r = srcOf({ source: kind, region: '1,2,3,4' });
    assert.equal(r.src, null, `${kind} 不该接受 region`);
    assert.match(r.error, /region 只能配/);
  }
});

test('schema 的 source 枚举包含 window，且默认仍是 screen', () => {
  const { parameters } = seeNowToolSpec();
  assert.ok(parameters.source.enum.includes('window'));
  assert.equal(parameters.source.default, 'screen');
  assert.ok(parameters.window, 'window 参数要还在（它现在同时服务 source:"window" 和血条）');
});

test('probe 那行 JSON 解析：正常 / 最小化 / 坏行', () => {  const ok = parseProbeLine('{"ok":true,"hwnd":264826,"title":"某个窗口","minimized":false,'
    + '"rect":{"x":1,"y":2,"w":1922,"h":1126}}');
  assert.deepEqual(ok, {
    ok: true, hwnd: 264826, title: '某个窗口', minimized: false,
    rect: { x: 1, y: 2, w: 1922, h: 1126 },
  });

  const mini = parseProbeLine('{"ok":false,"hwnd":1,"title":"t","minimized":true,"rect":null}');
  assert.equal(mini.minimized, true);
  assert.equal(mini.ok, false);
  assert.equal(mini.rect, null);

  assert.equal(parseProbeLine('ERR 找不到窗口：x'), null);
  assert.equal(parseProbeLine(''), null);
  assert.equal(parseProbeLine('{broken'), null);
});

test('sidecar 命令行：钩子只在明确要求时才带，参数顺序稳定', () => {
  const base = { python: 'py.exe', script: 'wgc_capture.py', source: { title: '某个窗口' }, fps: 10 };
  assert.deepEqual(windowCaptureArgs(base), ['py.exe', 'wgc_capture.py', '--fps', '10', '--title', '某个窗口']);

  const all = windowCaptureArgs({
    ...base, region: { x: 1, y: 2, w: 3, h: 4 }, size: [798, 450], dropFrames: true,
  });
  assert.deepEqual(all.slice(4), [
    '--title', '某个窗口', '--region', '1,2,3,4', '--size', '798x450', '--drop-frames',
  ]);

  // 没给标题/句柄要说清楚，不能拼出一条注定起不来的命令
  assert.throws(() => windowCaptureArgs({ ...base, source: {} }), /title 或 hwnd/);
});
