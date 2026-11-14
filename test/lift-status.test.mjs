/**
 * lift-status.test.mjs — 第 3 步的文案守卫：`liftLine` / `liftGearLine` 逐字不变。
 *
 * 这两行是 `see_now({action:"status"})` 的一部分，搬家时最容易顺手改一个字。
 * 测试把文案钉死在这里；以后真要改，就得同时改测试 —— 那一下是故意的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liftLine, liftGearLine } from '../src/lift/status.js';

test('liftLine：关着 / 没在采 / 在采 / 最后一帧太久', () => {
  assert.equal(liftLine(null), null);
  assert.equal(liftLine({ enabled: false }), null);
  assert.equal(liftLine({ enabled: true, capturing: false }),
    '留底：没在采（进仅监听才留底；看画面时用不到它）');
  assert.equal(liftLine({ enabled: true, capturing: false, error: 'ffmpeg 退出' }),
    '留底：没在采 —— ffmpeg 退出');
  assert.equal(
    liftLine({ enabled: true, capturing: true, frames: 12, mb: 3, windowSec: 30, fps: 0.5 }),
    '留底中：12 帧 / ≈3 MB（最近 30 秒，0.5 fps）',
  );
  assert.equal(
    liftLine({ enabled: true, capturing: true, frames: 12, mb: 3, windowSec: 30, fps: 0.5, stale: true, ageSec: 9 }),
    '留底中：12 帧 / ≈3 MB（最近 30 秒，0.5 fps，最后一帧 9s 前（采集可能断了））',
  );
});

test('liftGearLine：档位 / 基线 / 5 分钟警觉 / 今日计数', () => {
  assert.equal(
    liftGearLine(
      { lift: { level: 'look', base: 'glance', alarms: 2 } },
      { level: 'glance' },
      { alarm: 1, glance: 3, look: 0 },
    ),
    '档位：看（抬头中）（基线 瞥）· 5 分钟警觉 2 · 今日 警觉 1 · 瞥 3 · 看 0',
  );
});

test('liftGearLine：没抬头时按基线显示；计数缺省不崩', () => {
  assert.equal(
    liftGearLine({ lift: { level: null, base: 'alarm', alarms: 0 } }, {}, { alarm: 0, glance: 0, look: 0 }),
    '档位：警觉（基线 警觉）· 5 分钟警觉 0 · 今日 警觉 0 · 瞥 0 · 看 0',
  );
  assert.equal(
    liftGearLine(null, null, undefined),
    '档位：瞥（基线 瞥）· 5 分钟警觉 0 · 今日 警觉 0 · 瞥 0 · 看 0',
  );
});
