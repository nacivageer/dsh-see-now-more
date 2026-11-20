#!/usr/bin/env node
/**
 * pointer-smoke — 人工点验用：画一个圈，等一个信号，把结果原样打出来。
 *
 *   node scripts/pointer-smoke.mjs --x 300 --y 300 --label 点这里 --wait click --wait-ms 8000
 *
 * 前提：`~/.dsh/see-now.json` 里 `"pointer": { "enabled": true }`，
 * 或者临时 `DSH_SEE_POINTER=1`（只影响这个进程）。
 *
 * 它不写任何文件、不改配置；屏幕上画的东西由 python 子进程退出时自己收掉。
 */
import { pointAndWait } from '../src/pointer.js';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  return process.argv[i + 1];
}

const payload = {
  x: Number(arg('x', 'NaN')),
  y: Number(arg('y', 'NaN')),
  label: arg('label', '点这里'),
  shape: arg('shape', 'circle'),
  wait: arg('wait', 'click'),
  waitMs: arg('wait-ms', undefined) === undefined ? undefined : Number(arg('wait-ms')),
  radius: arg('radius', undefined) === undefined ? undefined : Number(arg('radius')),
};

const r = await pointAndWait(payload, { log: (m) => console.error(m) });
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
