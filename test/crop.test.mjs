/**
 * `action:"crop"` 的纯函数测试：region 校验、上下限、ffmpeg 参数形状。
 *
 * 不 spawn ffmpeg —— 真抓一块要靠真机（屏幕上的东西断言不了）；
 * 这里只守「参数不对就别去起进程」与「gdigrab 坐标别写反」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AREA, MAX_H, MAX_W, MIN_SIDE, cropArgs, validateCropRegion,
} from '../src/crop.js';

test('合法 region 通过，坐标与宽高原样保留', () => {
  const r = validateCropRegion('100,200,300,400');
  assert.equal(r.ok, true);
  assert.deepEqual(r.region, { x: 100, y: 200, w: 300, h: 400 });
});

test('坏写法 / 负数 / 零宽高拒绝', () => {
  assert.equal(validateCropRegion('').ok, false);
  assert.equal(validateCropRegion('a,b,c,d').ok, false);
  assert.equal(validateCropRegion('1,2,3').ok, false);
  assert.equal(validateCropRegion('-1,2,300,400').ok, false);
  assert.equal(validateCropRegion('1,2,0,400').ok, false);
  assert.equal(validateCropRegion(null).ok, false);
});

test('太小 / 太大 / 面积超限拒绝', () => {
  assert.equal(validateCropRegion(`10,10,${MIN_SIDE - 1},300`).ok, false);
  assert.equal(validateCropRegion(`0,0,${MAX_W + 1},100`).ok, false);
  assert.equal(validateCropRegion(`0,0,300,${MAX_H + 1}`).ok, false);
  // 宽 2000、高 2000 = 4,000,000 > 2,200,000
  assert.equal(validateCropRegion('0,0,2000,2000').ok, false);
  assert.equal(validateCropRegion('0,0,2000,1100').ok, true);
  assert.ok(2000 * 1100 <= MAX_AREA);
});

test('gdigrab 参数：块坐标进 -offset_x/-offset_y，一张 PNG 到 stdout', () => {
  const args = cropArgs({ x: 10, y: 20, w: 300, h: 200 });
  assert.equal(args[args.indexOf('-offset_x') + 1], '10');
  assert.equal(args[args.indexOf('-offset_y') + 1], '20');
  assert.equal(args[args.indexOf('-video_size') + 1], '300x200');
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.deepEqual(args.slice(-3), ['-vcodec', 'png', '-']);
});
