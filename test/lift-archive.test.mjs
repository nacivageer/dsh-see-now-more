/**
 * lift-archive.test.mjs — 10 分钟低清留底（下游评估 §1 #1）。
 *
 * 不碰真机：给 800×450 的纯色帧，验「5 秒节流 / 长边 480 / PNG 落盘 / 索引原子写 /
 * 按时间回取 / 10 分钟淘汰 / clear」。
 *
 * 路径由 `root` 显式传入（`src/lift/**` 不读 DSH_HOME，见 lift-seam）——
 * 和 runner 里 `$DSH_HOME/see-now/lift/archive` 是同一个目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_EVERY_MS, ARCHIVE_LONG_EDGE, ARCHIVE_WINDOW_MS, archiveDayDir, archiveIndexFile,
  createLiftArchive, dayKey,
} from '../src/lift/archive.js';

const W = 800;
const H = 450;
const FRAME = W * H * 3;
const T0 = Date.UTC(2026, 10, 17, 4, 0, 0);

function mkWiki() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lift-archive-'));
  const root = join(home, 'see-now', 'lift', 'archive');
  return { home, root, arc: createLiftArchive({ root }) };
}

function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.toString('latin1', 12, 16), 'IHDR');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('push：5 秒节流、长边 480、文件与索引都写出来', () => {
  const { root, arc } = mkWiki();
  const frame = { buf: Buffer.alloc(FRAME, 0x40), width: W, height: H };

  assert.equal(arc.push({ ...frame, at: T0 }), true);
  assert.equal(arc.push({ ...frame, at: T0 + 1000 }), false, '不到 5 秒不落盘');
  assert.equal(arc.push({ ...frame, at: T0 + ARCHIVE_EVERY_MS }), true);

  const day = dayKey(T0);
  const rows = readFileSync(archiveIndexFile(root, day), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].at < rows[1].at, '索引按时间正序');

  const files = readdirSync(archiveDayDir(root, day));
  const pngs = files.filter((f) => f.endsWith('.png'));
  assert.equal(pngs.length, 2);
  assert.ok(!files.some((f) => f.includes('.tmp-')), '不许留 tmp');
  for (const f of pngs) {
    const [w, h] = pngSize(join(archiveDayDir(root, day), f));
    assert.equal(Math.max(w, h), ARCHIVE_LONG_EDGE);
    assert.equal(w / h, W / H);
  }

  const st = arc.stats();
  assert.equal(st.frames, 2);
  assert.equal(st.everySec, 5);
  assert.equal(st.windowSec, 600);
  assert.ok(st.mb >= 0);
});

test('findAt：容差内取最近一帧并标低清；容差外/没有时给明确 reason', () => {
  const { arc } = mkWiki();
  const buf = Buffer.alloc(FRAME, 0x80);
  arc.push({ buf, width: W, height: H, at: T0 });
  arc.push({ buf, width: W, height: H, at: T0 + 5000 });

  const hit = arc.findAt(T0 + 4000);
  assert.equal(hit.ok, true);
  assert.equal(hit.degraded, 'archive-low-res');
  assert.equal(hit.at, T0 + 5000);
  assert.equal(hit.deltaMs, 1000);
  assert.equal(hit.width, 480);
  assert.ok(existsSync(hit.path));

  const old = arc.findAt(T0 - 60_000);
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'too-old');

  const future = arc.findAt(T0 + 60_000);
  assert.equal(future.ok, false);
  assert.equal(future.reason, 'too-new');
});

test('10 分钟淘汰：旧帧文件与索引一起清掉，不越留越久', () => {
  const { root, arc } = mkWiki();
  const buf = Buffer.alloc(FRAME, 0x22);
  arc.push({ buf, width: W, height: H, at: T0 });
  const day = dayKey(T0);
  const first = join(archiveDayDir(root, day), `${T0}.png`);
  assert.ok(existsSync(first));

  arc.push({ buf, width: W, height: H, at: T0 + ARCHIVE_WINDOW_MS + 60_000 });
  assert.equal(existsSync(first), false, '超过 10 分钟的帧文件要删');
  assert.equal(arc.stats().frames, 1);
  assert.equal(arc.findAt(T0).ok, false);
});

test('clear：开始看画面/收工时整段清掉，不留上一场的帧', () => {
  const { root, arc } = mkWiki();
  arc.push({ buf: Buffer.alloc(FRAME, 0x11), width: W, height: H, at: T0 });
  arc.clear();
  assert.equal(arc.stats().frames, 0);
  assert.equal(arc.findAt(T0).ok, false);
  assert.equal(existsSync(archiveDayDir(root, dayKey(T0))), false);
});

test('坏帧/坏时间不抛也不落盘；没 root 直接拒绝建实例', () => {
  const { home, arc } = mkWiki();
  assert.equal(arc.push({}), false);
  assert.equal(arc.push({ buf: Buffer.alloc(10), width: 0, height: 0, at: T0 }), false);
  assert.equal(arc.push({ buf: Buffer.alloc(FRAME), width: W, height: H, at: 'x' }), false);
  assert.equal(arc.findAt('x').reason, 'bad-time');
  assert.throws(() => createLiftArchive({}), /需要 root/);
  rmSync(home, { recursive: true, force: true });
});
