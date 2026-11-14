/**
 * lift-seam.test.mjs — 模块化第 4 步：`src/lift/**` 的静态边界。
 *
 * 抽成模块的意义是「能脱离 DSH / ffmpeg / python / 窗口运行」，那就不能靠自觉：
 * 一旦有人从 `lift/index.js` 里 import 回 `loop.js` 或 `runner.js`，测试会在这一条上红。
 *
 * 边界（任务书第 4 步）：
 *   - 不从 `../loop.js` / `../index.js` / `../runner.js` / `../window.js` / `../client.js` import；
 *   - 不 import `node:child_process`（模块不起进程）；
 *   - 不直接读 `DSH_HOME`（落盘/配置归 runner 与 lift-log，模块只收端口）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../src/lift/', import.meta.url));

const FORBIDDEN = [
  { re: /(?:from|import)\s+['"]\.\.\/(loop|index|runner|window|client)\.js['"]/, why: '反向 import 宿主模块' },
  { re: /import\(\s*['"]\.\.\/(loop|index|runner|window|client)\.js['"]/, why: '反向动态 import 宿主模块' },
  { re: /(?:from|import)\s+['"]node:child_process['"]/, why: '模块不起进程' },
  { re: /(?:from|import)\s+['"]child_process['"]/, why: '模块不起进程' },
  { re: /DSH_HOME/, why: '不直接读 DSH_HOME（走端口）' },
];

function liftFiles() {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));
}

test('src/lift 下至少有一个模块（防目录被误删后测试空转）', () => {
  assert.ok(liftFiles().length > 0);
});

test('src/lift/** 不越界 import、不起进程、不直接读 DSH_HOME', () => {
  const files = liftFiles();
  const offences = [];

  for (const { name, text } of files) {
    for (const { re, why } of FORBIDDEN) {
      // 允许在注释里提这些名字（说明边界时本来就会写），只查真正的 import / 使用行
      const lines = text.split('\n');
      lines.forEach((src, i) => {
        if (/^\s*(\*|\/\/)/.test(src)) return;
        if (re.test(src)) offences.push(`${name}:${i + 1} ${why} → ${src.trim()}`);
      });
    }
  }

  assert.deepEqual(offences, [], offences.join('\n'));
});
