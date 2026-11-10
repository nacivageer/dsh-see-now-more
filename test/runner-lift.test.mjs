/**
 * 黑听留底接进 runner 之后的生命周期（P2-A）。
 *
 * 这里用**假采集**（`spawnCapture`）而不是真 ffmpeg：要验的是「什么时候起、什么时候停、
 * 停了之后还取不取得到」，不是采集本身（那是 `capture.js` 的事）。
 *
 * `DSH_HOME` 指到临时目录：`runner.stop()` 会顺带 `listener.stop()`，它读
 * `~/.dsh/see-now/audio/listen.pid` 并 taskkill —— 不隔离的话，在这台机器上跑一次测试
 * 会把 Desktop 里正在听的那只 python 杀掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-lift-'));

const { createRunner } = await import('../src/runner.js');

const W = 800;
const H = 450;
const FRAME = W * H * 3;

/** 假采集：记录每次 spawn 的参数，按需手动喂帧。 */
function fakeCapture() {
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
          opts.onFrame({ i: h.sent - 1, t: (h.sent - 1) / opts.fps, buf: Buffer.alloc(FRAME, h.sent) });
        }
      },
      stop() {
        h.stopped = true;
        resolveDone({ frames: h.sent, ms: 0, code: null });
      },
    };
    calls.push(h);
    return h;
  };
  return { calls, spawn };
}

const mk = (cap, lift = { enabled: true }) => createRunner({
  lift,
  spawnCapture: cap.spawn,
  mode: 'vision',        // 别让 start() 顺手把耳朵拉起来（那条路会 spawn python）
  log: () => {},
});

test('仅监听：2 fps 采集 + 每 4 帧留 1 帧，按 t0 取得到帧，状态里有帧数与内存', async () => {
  const cap = fakeCapture();
  const runner = mk(cap);

  const r = await runner.listenOnly({ audio: false, region: null });
  assert.equal(r.lift.ok, true);
  assert.equal(cap.calls.length, 1);
  // 采集 2 fps、留底 0.5 fps：直接以 0.5 fps 抓屏在 gdigrab/ddagrab 上都不稳（见 lift-buffer.js）
  assert.equal(cap.calls[0].opts.fps, 2);
  assert.deepEqual([cap.calls[0].opts.width, cap.calls[0].opts.height], [W, H]);

  const st = runner.status().lift;
  assert.equal(st.enabled, true);
  assert.equal(st.capturing, true);
  assert.equal(st.frames, 0);
  assert.equal(st.windowSec, 30);
  assert.equal(st.fps, 0.5, '对外报的是留底帧率，不是采集帧率');

  const t0 = Date.now();
  // i = 0 那一帧留下来；i = 1/2/3 被抽掉（4 帧才留 1 帧）
  cap.calls[0].push(4);
  const got = runner.frameAt(t0);
  assert.equal(got.ok, true);
  assert.ok(Math.abs(got.deltaMs) <= 1000, `偏差 ${got.deltaMs}ms 超过 1 秒`);
  assert.equal(got.frame.buf.length, FRAME);

  const after = runner.status().lift;
  assert.equal(after.frames, 1, '4 帧采集只该留 1 帧');
  assert.equal(after.bytes, FRAME);
  assert.ok(after.mb > 0);

  // 幂等：再进一次仅监听不会起第二路采集
  await runner.listenOnly({ audio: false, region: null });
  assert.equal(cap.calls.length, 1);

  runner.stop();
  assert.equal(cap.calls[0].stopped, true);
  const stopped = runner.status().lift;
  assert.equal(stopped.capturing, false);
  assert.equal(stopped.frames, 0, '收工后缓冲必须清空');
  assert.equal(runner.frameAt(t0).reason, 'empty');
});

test('lift.enabled=false：一路都不起，取帧明确报 disabled', async () => {
  const cap = fakeCapture();
  const runner = mk(cap, { enabled: false });

  const r = await runner.listenOnly({ audio: false, region: null });
  assert.equal(cap.calls.length, 0, '关了就不许烧 CPU');
  assert.equal(r.lift.enabled, false);
  assert.equal(runner.status().lift.enabled, false);
  assert.deepEqual(runner.frameAt(Date.now()), { ok: false, reason: 'disabled' });

  runner.stop();
});

test('开始看画面：留底那一路停掉、缓冲清空（上一场的帧不许冒充现在）', async () => {
  const cap = fakeCapture();
  const runner = mk(cap);

  await runner.listenOnly({ audio: false, region: null });
  cap.calls[0].push(8);                 // 8 帧采集 → 留 2 帧
  assert.equal(runner.status().lift.frames, 2);

  await runner.start({ src: { kind: 'file', path: 'C:/tmp/lift-test.mp4' } });
  assert.equal(cap.calls[0].stopped, true, '留底那一路必须被停');
  const st = runner.status();
  assert.equal(st.running, true);
  assert.equal(st.lift.capturing, false);
  assert.equal(st.lift.frames, 0);
  assert.equal(cap.calls[1].opts.fps, 12, '看画面这条走的还是原来的帧率');
  assert.equal(runner.frameAt(Date.now()).reason, 'empty');

  runner.stop();
});

test('stopVision 只停画面：留底接着跑（进仅监听那条路不许把缓冲重启一遍）', async () => {
  const cap = fakeCapture();
  const runner = mk(cap);

  await runner.listenOnly({ audio: false, region: null });
  cap.calls[0].push(4);                 // 留 1 帧
  runner.stopVision('模型进仅监听');
  assert.equal(cap.calls[0].stopped, false);
  assert.equal(runner.status().lift.frames, 1);

  runner.stop();
});
