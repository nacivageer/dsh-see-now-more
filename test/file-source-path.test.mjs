/**
 * file-source-path.test.mjs — `source:"file"` 的 path 只收**本机文件的绝对路径**。
 *
 * 病：path 原样进了 `ffmpeg -i`。ffmpeg 把 `http:` / `tcp:` / `concat:` 这类前缀当协议，
 * 于是模型给一个 URL，ffmpeg 就真的去连；给一个目录、一个不存在的路径，报出来的也是
 * ffmpeg 的一堆 stderr，而不是一句能照做的话。
 *
 * 修的规矩（两层）：
 *   - 工具入口（`srcOf`）：绝对路径、存在、是普通文件，否则明确报错，不起采集；
 *     Windows 上 `\\…` 开头的（网络 / 设备路径）在 stat 之前就拒掉；
 *   - 采集参数（`sourceArgs`）：文件源一律带 `-protocol_whitelist file`，入口漏了也连不出去。
 *
 * 本仓改动（相对上游 0.2.2 的同名测试）：本仓没有 `test/ffmpeg.mjs` 这个夹具，
 * ffmpeg 走 `src/binaries.js` 的 `resolveFfmpeg` 自己找；其余断言逐条照搬。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpeg } from '../src/binaries.js';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-filepath-'));
process.env.DSH_SEE_NO_WINDOW = '1';

const { __test } = await import('../src/index.js');
const { srcOf } = __test;
const { sourceArgs } = await import('../src/capture.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-see-filepath-src-'));
const clip = join(dir, 'clip.mp4');
writeFileSync(clip, 'not really a video'); // 入口只看"是不是普通文件"，不解码
const sub = join(dir, 'a-folder');
mkdirSync(sub);

/** 断言这组参数被入口拒掉：不给 src、带一句说明、reason 是 bad-path */
function rejected(args, why) {
  const r = srcOf(args);
  assert.equal(r.src, null, `${why}：不该构造出 source`);
  assert.equal(typeof r.error, 'string', `${why}：要有一句说明`);
  assert.equal(r.reason, 'bad-path', why);
  return r;
}

test('协议 URL 不收（http / tcp / concat）', () => {
  rejected({ source: 'file', path: 'http://127.0.0.1:1/x.mp4' }, 'http');
  rejected({ source: 'file', path: 'tcp://127.0.0.1:1' }, 'tcp');
  rejected({ source: 'file', path: `concat:${clip}|${clip}` }, 'concat');
});

test('没给 path、相对路径、不存在、是目录：都明确报错', () => {
  rejected({ source: 'file' }, '没给 path');
  rejected({ source: 'file', path: '' }, '空串');
  rejected({ source: 'file', path: 'clip.mp4' }, '相对路径');
  // stat 失败和「不是普通文件」分开说：前者带错误码，后者不说成「不存在」
  assert.match(rejected({ source: 'file', path: join(dir, 'missing.mp4') }, '不存在').error, /不存在或无法访问（ENOENT）/);
  assert.match(rejected({ source: 'file', path: sub }, '目录').error, /不是普通文件/);
});

test('Windows：UNC 网络路径 / 设备路径在 stat 之前就拒掉', { skip: process.platform !== 'win32' && '只在 Windows 上有这类路径' }, () => {
  rejected({ source: 'file', path: '\\\\192.0.2.1\\share\\clip.mp4' }, 'UNC');
  rejected({ source: 'file', path: '//192.0.2.1/share/clip.mp4' }, '正斜杠 UNC');
});

test('本机文件的绝对路径照常放行，realtime 也带上', () => {
  const r = srcOf({ source: 'file', path: clip, realtime: true });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.src, { kind: 'file', path: clip, realtime: true });
});

test('别的 source 不受影响（不看 path）', () => {
  assert.deepEqual(srcOf({ source: 'screen', path: 'http://127.0.0.1:1/x' }).src, { kind: 'screen' });
  assert.equal(srcOf({}).src, null);
});

test('文件源的 ffmpeg 参数带 -protocol_whitelist file（紧挨着 -i）', () => {
  const args = sourceArgs({ kind: 'file', path: clip, realtime: true });
  const i = args.indexOf('-i');
  assert.deepEqual(args.slice(i - 2), ['-protocol_whitelist', 'file', '-i', clip]);
});

test('ffmpeg 真的拒掉白名单外的协议（不去连）', (t) => {
  const { path } = resolveFfmpeg();
  const usable = path.includes('\\') || path.includes('/') ? existsSync(path) : true;
  if (!usable) { t.skip('没有 ffmpeg，跳过'); return; }
  // 端口 1 上没人听；白名单生效时 ffmpeg 根本不会去连，直接报 not on whitelist
  const r = spawnSync(path, ['-hide_banner', '-v', 'error',
    ...sourceArgs({ kind: 'file', path: 'http://127.0.0.1:1/x.mp4' }), '-f', 'null', '-'],
  { encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not on whitelist/);
});
