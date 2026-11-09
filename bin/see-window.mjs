#!/usr/bin/env node
/**
 * see-window.mjs — 手动开 / 关 / 查悬浮窗。
 *
 * 为什么要有它：插件的悬浮窗只有 `see_now({action:"watch"})` 这一条入口能拉起来。
 * 用户点了右上角 × 之后，如果模型没再调工具，就**再也没有任何办法把它叫回来** ——
 * 只能重启 DSH。issue #2 第 1 条说的就是这件事。
 *
 * ```bash
 * node bin/see-window.mjs            # 开（已经开着就什么都不做）
 * node bin/see-window.mjs --force    # 杀掉重开
 * node bin/see-window.mjs --status   # 只看状态，不动手
 * node bin/see-window.mjs --close    # 关掉
 * ```
 *
 * 装成 npm 包之后也可以 `npx dsh-see-window`；本仓没发 npm，用上面的 node 形式。
 */

import { closeWindow, openWindow, pidPath, windowAlive } from '../src/window.js';

const args = new Set(process.argv.slice(2));

function say(msg) { process.stdout.write(`${msg}\n`); }
function fail(msg) { process.stderr.write(`${msg}\n`); process.exitCode = 1; }

if (args.has('--status') || args.has('-s')) {
  const alive = windowAlive();
  say(alive ? `悬浮窗在跑（pid 文件：${pidPath()}）` : '悬浮窗没在跑');
  process.exit(alive ? 0 : 1);
}

if (args.has('--close') || args.has('-c')) {
  closeWindow();
  say('已关掉悬浮窗');
  process.exit(0);
}

const force = args.has('--force') || args.has('-f');
const r = await openWindow({ force });

if (r.ok) {
  say(r.already ? '悬浮窗已经开着了' : `悬浮窗已打开（${r.python ?? '未知解释器'}）`);
  process.exit(0);
}

// 失败要说清楚"下一步干什么"，不然用户看到的只是"点了没反应"
fail(`开不起来：${r.reason ?? '未知原因'}`);
if (r.reason === 'disabled') {
  fail('环境变量 DSH_SEE_NO_WINDOW=1 把窗口显式关掉了 —— 去掉它再试。');
}
fail('窗口自己的报错会追加到 ~/.dsh/see-now-window.log。');
