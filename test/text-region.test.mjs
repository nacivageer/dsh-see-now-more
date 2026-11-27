/**
 * text-region.test.mjs — 字幕框（`~/.dsh/see-now.json` 的 `text.region`）。
 *
 * 这条线三件事要紧：
 *
 *  1. **换算**：`text.region` 存的是主屏像素 + 屏幕尺寸，文字流拿到的是"整屏缩到画布"的帧，
 *     所以 `fx = x / sw` 是唯一正确的换算法（采集不裁不补，`src/capture.js:215`）。
 *     换错一档就是读错地方 —— 认错字比不认字更难发现。
 *  2. **优先级与退化**：配了框按框、没配按条带；框写坏了（越界 / 缺 sw / 太小）退回条带并 warn。
 *  3. **不污染采集**：框字幕只写 `text.region`，`region.json`（watch 抓哪块）一个字都不动。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bandRect, normalizeTextConfig, rectFromRegion, sidecarSizeOf, textRectOf, textStatusLine,
} from '../src/text-band.js';
import { createTextStream } from '../src/text-stream.js';
import { saveTextRegion, clearTextRegion } from '../src/region.js';
import { seeNowToolSpec } from '../src/tool-spec.js';

const BOX = { x: 100, y: 200, w: 400, h: 100, sw: 2000, sh: 1000 };

// ---------------------------------------------------------------- 换算

test('rectFromRegion：像素按屏幕比例换成帧内矩形', () => {
  assert.deepEqual(rectFromRegion(1000, 500, BOX), { x: 50, y: 100, w: 200, h: 50 });
});

test('rectFromRegion：非 16:9 的屏幕也按两个轴各自的比例算（采集是 scale，不是 crop）', () => {
  // 3840×2160 屏、帧 798×450：x 比例 798/3840、y 比例 450/2160
  const box = { x: 1920, y: 1800, w: 960, h: 200, sw: 3840, sh: 2160 };
  const r = rectFromRegion(798, 450, box);
  assert.equal(r.x, Math.round((1920 / 3840) * 798));
  assert.equal(r.y, Math.round((1800 / 2160) * 450));
  assert.equal(r.w, Math.round(((1920 + 960) / 3840) * 798) - r.x);
  assert.equal(r.h, Math.round(((1800 + 200) / 2160) * 450) - r.y);
});

test('rectFromRegion：贴边的框夹在帧里；缺 sw/sh 或太小时给 null', () => {
  const out = rectFromRegion(800, 450, { x: 0, y: 960, w: 2000, h: 40, sw: 2000, sh: 1000 });
  assert.ok(out && out.x >= 0 && out.y >= 0);
  assert.ok(out.x + out.w <= 800 && out.y + out.h <= 450);
  assert.equal(out.x, 0);
  assert.equal(out.y + out.h, 450);
  assert.equal(rectFromRegion(800, 450, { x: 1, y: 1, w: 100, h: 20 }), null, '缺 sw/sh');
  assert.equal(rectFromRegion(800, 450, { x: 0, y: 0, w: 4, h: 4, sw: 2000, sh: 1000 }), null, '太小');
  assert.equal(rectFromRegion(800, 450, null), null);
});

test('textRectOf：有框用框、没框用条带；框算不出来退回条带', () => {
  const withBox = textRectOf({ region: BOX, band: [0.8, 1, 0.1] }, 1000, 500);
  assert.equal(withBox.kind, 'region');
  assert.deepEqual(withBox.rect, rectFromRegion(1000, 500, BOX));

  const noBox = textRectOf({ region: null, band: [0.8, 1, 0.1] }, 1000, 500);
  assert.equal(noBox.kind, 'band');
  assert.deepEqual(noBox.rect, bandRect(1000, 500, [0.8, 1, 0.1]));

  const broken = textRectOf({ region: { x: 0, y: 0, w: 4, h: 4, sw: 2000, sh: 1000 }, band: [0.8, 1, 0.1] }, 1000, 500);
  assert.equal(broken.kind, 'band', '框坏掉时退回条带，不能整个不读');
});

test('sidecarSizeOf 跟着字幕框走（尺寸变了 sidecar 会自动重启）', () => {
  const cfg = normalizeTextConfig({ region: BOX, scale: 2 }).config;
  const size = sidecarSizeOf(cfg, 1000, 500);
  assert.equal(size.w, 200);
  assert.equal(size.h, 50);
  assert.equal(size.canvasH, 100);
});

// ---------------------------------------------------------------- 配置

test('配置：好的框读得进来，坏的丢掉 + warn（退回条带）', () => {
  const ok = normalizeTextConfig({ region: BOX });
  assert.deepEqual(ok.config.region, BOX);
  assert.deepEqual(ok.warnings, []);

  const cases = [
    { x: 0, y: 0, w: 4, h: 4, sw: 2000, sh: 1000 },              // 太小
    { x: 1900, y: 0, w: 400, h: 100, sw: 2000, sh: 1000 },        // 越界
    { x: 0, y: 0, w: 400, h: 100 },                               // 缺 sw/sh
    { x: 0, y: 0, w: 400, h: 100, sw: 0, sh: 1000 },              // sw 非正
    'nope', 123, [],                                              // 形状不对
  ];
  for (const bad of cases) {
    const r = normalizeTextConfig({ region: bad });
    assert.equal(r.config.region, null, `${JSON.stringify(bad)} 应被丢掉`);
    assert.ok(r.warnings.some((w) => w.includes('text.region')), `${JSON.stringify(bad)} 应有一条 warn`);
  }
  // 不写 region 就是 null，老配置不受影响
  assert.equal(normalizeTextConfig({}).config.region, null);
  assert.deepEqual(normalizeTextConfig({}).warnings, []);
});

test('saveTextRegion / clearTextRegion：只动 text.region，别的键和解码都不坏', () => {
  const home = mkdtempSync(join(tmpdir(), 'seenow-textregion-'));
  const env = { DSH_HOME: home };
  const path = join(home, 'see-now.json');
  writeFileSync(path, JSON.stringify({
    mode: 'vision',
    session: 'session-x',
    text: { fps: 2, band: [0.8, 1, 0.1] },
  }), 'utf8');

  const saved = saveTextRegion(BOX, env);
  assert.equal(saved, path);
  const raw = readFileSync(path);
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '不能写 BOM（json.load 会炸）');
  const cfg = JSON.parse(raw.toString('utf8'));
  assert.equal(cfg.mode, 'vision', '别的键要留着');
  assert.deepEqual(cfg.text.band, [0.8, 1, 0.1], 'text 段里别的设置要留着');
  assert.equal(cfg.text.fps, 2);
  assert.deepEqual(cfg.text.region, BOX);

  assert.equal(saveTextRegion({ ...BOX, w: 2 }, env), null, '太小不写');
  assert.equal(saveTextRegion({ ...BOX, sw: 0 }, env), null);

  assert.equal(clearTextRegion(env), true);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.text.region, undefined);
  assert.equal(after.text.fps, 2, '清框不删别的 text 设置');
  assert.equal(clearTextRegion(env), false, '没框时清它是 no-op');
  assert.ok(existsSync(path));
});

// ---------------------------------------------------------------- 文字流

function fakeStream(cfgOverrides) {
  const got = [];
  const stream = createTextStream({
    config: normalizeTextConfig({ region: BOX, fps: 2, ...cfgOverrides }).config,
    resolveFn: () => ({ ok: true, python: 'fake-python' }),
    startOcrFn: () => ({
      recognize: async (bgra) => { got.push(bgra.length); return { lines: ['这一句是字幕'] }; },
      stop() {},
    }),
    log: () => {},
  });
  return { stream, got };
}

const frame = (w, h) => ({ t: 0, buf: Buffer.alloc(w * h * 3, 200), width: w, height: h, wall: 1000 });

test('文字流：配了框就只送框内那块像素给 OCR，status 报 region', async () => {
  const { stream, got } = fakeStream({});
  try {
    stream.onFrame(frame(1000, 500));
    await stream.settled();
    const rect = rectFromRegion(1000, 500, BOX);
    assert.deepEqual(got, [rect.w * rect.h * 4], '送进 OCR 的 BGRA 应该是框的尺寸');
    const st = stream.status();
    assert.equal(st.picked, 'region');
    assert.deepEqual(st.region, BOX);
  } finally {
    stream.stop();
  }
});

test('文字流：setRegion(null) 退回条带；setIntake(false) 一帧都不送', async () => {
  const { stream, got } = fakeStream({});
  try {
    stream.setRegion(null);
    stream.onFrame(frame(1000, 500));
    await stream.settled();
    const band = bandRect(1000, 500, [0.8, 1, 0.1]);
    assert.deepEqual(got, [band.w * band.h * 4]);

    stream.setIntake(false, { why: 'region 模式不读字幕' });
    stream.onFrame({ ...frame(1000, 500), wall: 5000 });
    await stream.settled();
    assert.equal(got.length, 1, '不喂帧时不该再送 OCR');
    const st = stream.status();
    assert.equal(st.accept, false);
    assert.match(st.why, /region 模式/);
  } finally {
    stream.stop();
  }
});

test('文字流：setRegionAllowed(false) 时配了框也按条带读（窗口 / 文件源不是屏幕坐标）', async () => {
  const { stream, got } = fakeStream({});
  try {
    stream.setRegionAllowed(false);
    stream.onFrame(frame(1000, 500));
    await stream.settled();
    const band = bandRect(1000, 500, [0.8, 1, 0.1]);
    assert.deepEqual(got, [band.w * band.h * 4]);
    assert.equal(stream.status().picked, 'band');
  } finally {
    stream.stop();
  }
});

// ---------------------------------------------------------------- status 行

test('status 行：字幕框 / 框不生效 / 不读 / 关着，四种说法不混', () => {
  const base = { enabled: true, fps: 1, scale: 2, stats: {}, ocr: { available: true }, band: [0.8, 1, 0.1] };

  const boxed = textStatusLine({ ...base, region: BOX });
  assert.match(boxed, /字幕框 100,200 400×100/);
  assert.match(boxed, /主屏 2000×1000/);

  const banded = textStatusLine({ ...base, region: null });
  assert.match(banded, /条带 80–100%/);

  const ignored = textStatusLine({ ...base, region: BOX, regionIgnored: true });
  assert.match(ignored, /字幕框只在整屏采集时生效/);

  const off = textStatusLine({ ...base, accept: false, why: 'region 模式不读字幕' });
  assert.match(off, /没在读：region 模式/);

  assert.match(textStatusLine({ ...base, enabled: false }), /屏幕文字：关/);
});

// ---------------------------------------------------------------- 字幕框那一路上采集

test('runner：配了字幕框就单独起一路原生采集，帧按整帧喂文字流', async () => {
  const { createRunner } = await import('../src/runner.js');
  const home = mkdtempSync(join(tmpdir(), 'seenow-boxcap-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const calls = [];
  const spawn = (opts) => {
    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    const h = {
      opts,
      done,
      sent: 0,
      stopped: false,
      push(n = 1) {
        for (let k = 0; k < n; k += 1) {
          h.sent += 1;
          opts.onFrame({ i: h.sent - 1, t: (h.sent - 1) / opts.fps, buf: Buffer.alloc(opts.width * opts.height * 3, 180) });
        }
      },
      stop() { h.stopped = true; resolveDone({ frames: h.sent, ms: 0, code: null }); },
    };
    calls.push(h);
    return h;
  };
  const runner = createRunner({ spawnCapture: spawn, mode: 'vision', log: () => {}, text: { region: BOX, fps: 2 }, graceSec: 0 });
  try {
    await runner.start({ src: { kind: 'screen', engine: 'gdigrab' }, audio: false });
    assert.equal(calls.length, 2, '应该有主采集 + 字幕框两路');
    const boxRun = calls.find((c) => c.opts.source?.region);
    assert.ok(boxRun, '字幕框那一路要带 region（原生分辨率，不从 watch 的帧里裁）');
    assert.deepEqual(
      { x: boxRun.opts.source.region.x, y: boxRun.opts.source.region.y, w: boxRun.opts.source.region.w, h: boxRun.opts.source.region.h },
      { x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h },
    );
    assert.equal(boxRun.opts.fps, 5, '供帧 5 fps（实际抽帧由文字流按 text.fps 节流）');
    assert.deepEqual([boxRun.opts.width, boxRun.opts.height], [BOX.w, BOX.h], '原生尺寸，不缩');

    boxRun.push(1);
    assert.equal(runner.status().text.picked, 'native', '这一路的帧是"整帧就是框"，不再二次裁');
  } finally {
    runner.stop();
    assert.equal(calls.find((c) => c.opts.source?.region).stopped, true, '收工要把它一起停');
    process.env.DSH_HOME = oldHome;
  }
});

// ---------------------------------------------------------------- schema

test('schema：`for` 只认 text，且没有把预算撑破', () => {
  const spec = seeNowToolSpec();
  assert.deepEqual(spec.parameters.for.enum, ['text']);
  assert.match(spec.parameters.for.description, /字幕/);
  const size = JSON.stringify({ name: spec.name, description: spec.description, parameters: spec.parameters }).length;
  assert.ok(size <= 7500, `schema ${size} 超过 7500（加 for 要同笔删够）`);
});
