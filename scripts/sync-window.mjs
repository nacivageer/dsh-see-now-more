#!/usr/bin/env node
/**
 * sync-window.mjs — 把上游的 `window.py` 同步进 `examples/floating-chat/`。
 *
 * ## 为什么要这个脚本，而不是拷一份了事
 *
 * 那个窗口脚本（3000 多行）**还在改**，而它只有一份真正的主副本 ——
 * 在 `dsh-watch-together` 里。直接拷进 see-now 就等于当场分叉：
 * 从今往后两边各自演化，改好的一边另一边看不见。
 *
 * 所以这里的定位是**构建步骤**，不是 fork：
 *   - 包内那份是**产物**，文件头带 GENERATED 标记，禁止手改
 *   - `prepack` 自动跑一次，发版永远不会带着空目录出去
 *   - 内容没变就不写（保留 mtime，不触发无谓的重新安装）
 *
 * 用 `--check` 只检查不写（接在 CI / 测试里报漂移）。
 *
 * ## 找不到上游怎么办
 *
 * 这不发生在开发机上，但会发生在「拿到一个 tarball、里面没有兄弟仓库」的时候。
 * 那时如果包内已有旧副本 → **警告放行**（有东西总比没有强）；
 * 两边都没有 → **报错退出 1**（发一个开不了窗的包出去比报错更糟）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = join('examples', 'floating-chat', 'window.py');
const DEST = join(ROOT, REL);

/** 插在 shebang 之后的一行标记。比较内容时会被剥掉，所以不会影响"是否变化"的判断。 */
const MARK = '# ⚠️ 本文件由 dsh-see-now/scripts/sync-window.mjs 生成，请勿手改（要改请改上游 dsh-watch-together）';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const quiet = args.has('--quiet');

function say(msg) {
  if (!quiet) process.stdout.write(`${msg}\n`);
}

/**
 * 上游在哪：和 `src/window.js` 的 `resolveScript()` 同一套思路，
 * 但**排除包内那份**（不然就是拿自己同步自己）。
 */
function findUpstream() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const candidates = [];

  // 1. 环境变量 / 配置显式指定
  if (process.env.DSH_SEE_WINDOW) {
    candidates.push({ p: process.env.DSH_SEE_WINDOW, from: 'DSH_SEE_WINDOW' });
  }
  for (const cfg of ['see-window.json', 'watch-window.json']) {
    try {
      const p = JSON.parse(readFileSync(join(home, cfg), 'utf8'))?.script;
      if (p) candidates.push({ p, from: `~/.dsh/${cfg}` });
    } catch { /* 没有这个配置 */ }
  }

  // 2. 开发仓库（同步的主要来源 —— 用户就在这儿改）
  candidates.push({
    p: join(ROOT, '..', 'dsh-watch-together', REL),
    from: '开发仓库',
  });

  // 3. 已安装的包（profile 里 / hoisted）
  const roots = [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')];
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      roots.push(join(home, 'profiles', name, 'node_modules'));
    }
  } catch { /* 没有 profiles */ }
  for (const root of roots) {
    candidates.push({ p: join(root, 'dsh-watch-together', REL), from: '已安装的 watch-together' });
  }

  for (const c of candidates) {
    if (c.p && existsSync(c.p)) return c;
  }
  return null;
}

/** 剥掉我们插的标记行，用来判断"上游到底变没变"。 */
function stripMark(text) {
  return text.split(/\r?\n/).filter((l) => l !== MARK).join('\n');
}

function withMark(text) {
  const lines = text.split(/\r?\n/);
  // shebang 后面插；没有 shebang 就顶到最前面
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, MARK);
  return lines.join('\n');
}

const upstream = findUpstream();

if (!upstream) {
  if (existsSync(DEST)) {
    say('[sync-window] 找不到上游，沿用包内已有那份（' +
      `${readFileSync(DEST, 'utf8').length} 字节）；如果你刚改了窗口，这次同步是无效的。`);
    process.exit(0);
  }
  process.stderr.write(
    '[sync-window] 找不到上游 window.py，而且包内也没有。\n' +
    '  要么装 dsh-watch-together，要么设 DSH_SEE_WINDOW 指到 window.py。\n' +
    '  发一个开不了窗的包出去更糟，所以这里直接失败。\n',
  );
  process.exit(1);
}

const src = readFileSync(upstream.p, 'utf8');
const want = withMark(src);
const have = existsSync(DEST) ? readFileSync(DEST, 'utf8') : null;
const same = have !== null && stripMark(have) === stripMark(want);

if (checkOnly) {
  if (same) {
    say(`[sync-window] 一致（${upstream.from}，${src.length} 字节）`);
    process.exit(0);
  }
  process.stderr.write(
    `[sync-window] 包内的 window.py 和上游不一致（上游：${upstream.from}）\n` +
    '  跑 `npm run sync:window` 或 `npm pack`（prepack 会自动同步）。\n',
  );
  process.exit(1);
}

if (same) {
  say(`[sync-window] 上游没变，跳过（${upstream.from}，${src.length} 字节）`);
} else {
  mkdirSync(dirname(DEST), { recursive: true });
  writeFileSync(DEST, want, 'utf8');
  say(`[sync-window] 已同步 ${src.length} 字节 ← ${upstream.from}`);
  say(`              ${DEST}`);
}

/**
 * **window.py 不是单独一个文件**：它 `import window_protocol`、跑 `mic.py`、
 * 贴同目录的 `mic-dsh.png`，0.2.11 起还把玻璃拆成了 `glass_*` 和
 * `window_widgets` 几个模块。只同步那个入口会得到一个「能装、装完起不来」的包
 * —— 用户看到的是 `ModuleNotFoundError: glass_geometry`，然后以为插件坏了。
 *
 * 这是 issue #2 第 3 条（spawn 失败静默）的一个真根因：包内那份 window.py
 * 在只装了 see-now、没装 watch-together 的机器上必崩。
 */
const ASSETS = [
  'mic-dsh.png', 'mic.py', 'window_protocol.py',
  'glass_geometry.py', 'glass_capture.py', 'glass_cpu.py', 'glass_gpu.py',
  'glass_window.py', 'glass_window_gpu.py', 'window_widgets.py',
];
const srcDir = dirname(upstream.p);
const destDir = dirname(DEST);
for (const name of ASSETS) {
  const from = join(srcDir, name);
  const to = join(destDir, name);
  if (!existsSync(from)) continue;
  let unchanged = false;
  try {
    const a = readFileSync(from);
    const b = existsSync(to) ? readFileSync(to) : null;
    unchanged = b !== null && a.equals(b);
  } catch { /* 读不出来就当它变了，重写一次 */ }
  if (unchanged) continue;
  copyFileSync(from, to);
  say(`[sync-window] 资源已同步 ${name}`);
}

/**
 * `pick_region.py`（自选区域）是 see-now **独有**的，上游没有，所以不进 ASSETS。
 * 这里只确认它还在：它丢了 = 发布版里「框一块」直接不可用，而且开发机上永远
 * 看得出来（源码里有），只有在用户机器上才炸。
 */
if (!existsSync(join(destDir, 'pick_region.py'))) {
  process.stderr.write('[sync-window] 包内缺少 pick_region.py（自选区域要用），不能发布\n');
  process.exit(1);
}
