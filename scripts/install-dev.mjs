#!/usr/bin/env node
/**
 * install-dev — 把本包同步进 DSH 的 desktop profile。
 *
 *   node scripts/install-dev.mjs            # 安装 / 同步
 *   node scripts/install-dev.mjs --check    # 只看状态，不改动
 *   node scripts/install-dev.mjs --remove   # 卸载
 *
 * 为什么必须手动做：desktop profile 由 Electron 应用独占管理，
 * `dsh plugin --profile desktop ...` 会被拒绝（"managed exclusively by the Electron application"）。
 *
 * 为什么复制而不是软链：Node 解析裸包名（`@deepseek-ai/dsh-tools`）用的是真实路径，
 * 软链会让它从源码目录向上找、找不到宿主的包。复制到 profile 的 node_modules 里，
 * 解析链才是 profiles/desktop/node_modules → profiles/node_modules。
 */

import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const MODULES = join(PROFILE_DIR, 'node_modules');
const PKG_NAME = 'dsh-see-now-more';
const LEGACY_NAME = 'dsh-see-now';

// `.tmp` 要跳过（调试产物、被占用的文件会让 cp 中途失败）；
// `debug` 是开发期的调试窗，**不进插件**（也故意不写进 package.json 的 files）。
const SKIP = new Set(['node_modules', '.git', 'test', '.tmp', '.backup', 'scripts', 'debug']);

const mode = process.argv.includes('--remove') ? 'remove'
  : process.argv.includes('--remove-legacy') ? 'remove-legacy'
  : process.argv.includes('--check') ? 'check' : 'install';

if (!existsSync(PROFILE_DIR)) {
  console.error(`profile 不存在：${PROFILE_DIR}`);
  process.exit(2);
}
const pkgPath = join(PROFILE_DIR, 'package.json');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

/**
 * 悬浮窗要的解释器：tkinter + Pillow + mss + numpy。
 * 顺序和 `src/window.js` 的 pythonCandidates 一致（环境变量 → see-window.json →
 * DSH 自带 runtime → PATH → 商店版），这样 `--check` 报的就是插件真正会用的那个。
 */
function configuredPython() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  try {
    return JSON.parse(readFileSync(join(home, 'see-window.json'), 'utf8'))?.python || null;
  } catch {
    return null;
  }
}

function runtimePythons() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const base = join(home, 'dsh-runtimes');
  const out = [];
  try {
    for (const name of readdirSync(base)) {
      for (const exe of ['pythonw.exe', 'python.exe']) {
        const p = join(base, name, 'dependencies', 'python', exe);
        if (existsSync(p)) out.push(p);
      }
    }
  } catch { /* 没有 dsh-runtimes */ }
  return out;
}

function checkPython() {
  const probe = 'import tkinter, PIL, mss, numpy';
  const candidates = [];
  for (const c of [process.env.DSH_SEE_PYTHON, process.env.DSH_FLOAT_PYTHON, configuredPython()]) {
    if (c) candidates.push(c);
  }
  candidates.push(...runtimePythons());
  if (process.platform === 'win32') candidates.push('pythonw.exe', 'python.exe');
  else candidates.push('python3', 'python');
  try {
    const dir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps');
    for (const name of readdirSync(dir)) {
      if (!/^PythonSoftwareFoundation\.Python\.\d/.test(name)) continue;
      for (const exe of ['pythonw.exe', 'python.exe']) candidates.push(join(dir, name, exe));
    }
  } catch { /* 没有商店版 */ }

  const seen = new Set();
  for (const py of candidates.filter(Boolean)) {
    if (seen.has(py)) continue;
    seen.add(py);
    const r = spawnSync(py, ['-c', probe], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
    if (r?.status === 0) return { ok: true, python: py };
  }
  return { ok: false, python: null };
}

/** ffmpeg：和 `src/binaries.js` 同一套顺序，最后才回落到 PATH。 */
function checkFfmpeg() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  for (const c of [process.env.DSH_FFMPEG_PATH, process.env.FFMPEG_PATH]) if (c) candidates.push(c);
  if (process.env.DSH_FFMPEG_DIR) candidates.push(join(process.env.DSH_FFMPEG_DIR, exe));
  candidates.push(join(home, 'tools', 'ffmpeg', 'bin', exe), 'ffmpeg');

  for (const f of candidates) {
    if ((f.includes('/') || f.includes('\\')) && !existsSync(f)) continue;
    const r = spawnSync(f, ['-version'], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
    if (r?.status === 0) return { ok: true, ffmpeg: f };
  }
  return { ok: false, ffmpeg: null };
}

async function editProfile({ add, name = PKG_NAME }) {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const hasDep = Object.hasOwn(pkg.dependencies ?? {}, name);

  if (add) {
    if (!hasDep) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(PROFILE_DIR, `package.json.bak-${stamp}-preseenow`);
      await writeFile(backup, await readFile(pkgPath), 'utf8');
      console.log(`已备份 package.json → ${backup}`);
    }
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: `file:${HERE.replace(/\\/g, '/')}` };
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.profile = pkg.dsh.profile ?? {};
    if (!bundles.includes(name)) pkg.dsh.profile.bundles = [...bundles, name];
  } else {
    if (pkg.dependencies) delete pkg.dependencies[name];
    if (pkg.dsh?.profile?.bundles) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== name);
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

async function report() {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const target = join(MODULES, PKG_NAME);
  const installed = existsSync(target);
  const registered = bundles.includes(PKG_NAME);
  console.log(`profile   : ${PROFILE_DIR}`);
  console.log(`${PKG_NAME}: ${installed ? '已安装' : '未安装'}  bundles ${registered ? '已注册' : '未注册'}`);
  console.log(`bundles 共 ${bundles.length} 项：${bundles.join(', ')}`);

  // 旧 fork / 上游都叫 dsh-see-now，和本包提供同一个 see_now 工具；两个同时在会打架。
  const legacyInstalled = existsSync(join(MODULES, LEGACY_NAME));
  const legacyRegistered = bundles.includes(LEGACY_NAME);
  if (legacyInstalled || legacyRegistered) {
    console.log(`\n⚠ 检测到旧包 ${LEGACY_NAME}（目录${legacyInstalled ? '在' : '不在'}、bundles ${legacyRegistered ? '已注册' : '未注册'}）：`
      + '它和本包提供同一个 see_now 工具。先跑 `node scripts/install-dev.mjs --remove-legacy`，再重启 DSH。');
  }

  // 悬浮窗 / 采集的运行时依赖。缺了不影响安装，但窗起不来、采不了图。
  const py = checkPython();
  const ff = checkFfmpeg();
  console.log('依赖');
  console.log(`  python  : ${py.ok ? `${py.python}  ✓ tkinter/Pillow/mss/numpy` : '✗ 没找到能 import tkinter/Pillow/mss/numpy 的解释器'}`);
  if (!py.ok) console.log('            → pip install Pillow mss numpy（装进 DSH 用来跑悬浮窗的那个 Python）');
  console.log(`  ffmpeg  : ${ff.ok ? `${ff.ffmpeg}  ✓` : '✗ 没找到（DSH 桌面版自带，检查 DSH_HOME/tools/ffmpeg/bin）'}`);

  /**
   * **版本对账。**
   *
   * 这一行是给"我这会话里怎么没有 see_now 这个工具"准备的：宿主启动时才组合插件树，
   * 组合的是 profile 里那份**副本**。副本落后（或者 `dsh.plugin.json` 和 `package.json`
   * 版本不一致）时，跑的就是旧代码 —— 而"新开一个会话"不会改变任何已加载的代码。
   */
  const repoVersion = (await readJson(join(HERE, 'package.json'))).version;
  let stale = null;
  if (installed) {
    const copyVersion = await readJson(join(target, 'package.json')).then((p) => p.version).catch(() => null);
    const copyManifest = await readJson(join(target, 'dsh.plugin.json')).then((p) => p.version).catch(() => null);
    console.log(`源码版本  : ${repoVersion}`);
    console.log(`副本版本  : ${copyVersion ?? '读不到'}`
      + `${copyVersion === repoVersion ? '  ✓ 一致' : '  ⚠️ 和源码不一致（跑的是旧代码）'}`);
    if (copyManifest !== null && copyManifest !== copyVersion) {
      console.log(`  ⚠️ 副本里 dsh.plugin.json 写的是 ${copyManifest} —— 和 package.json 不一致，插件管理器会按旧版本认它`);
    }
    if (copyVersion !== repoVersion) stale = { copyVersion };
  }
  if (stale) {
    console.log('\n→ 跑 `node scripts/install-dev.mjs` 同步，然后**重启 DSH Desktop**。');
    console.log('  （新开一个会话不够：插件树是进程启动时组合的，已加载的代码不会换。）');
  }
  return { installed, registered, stale };
}

if (mode === 'check') {
  await report();
  process.exit(0);
}

if (mode === 'remove') {
  await rm(join(MODULES, PKG_NAME), { recursive: true, force: true });
  await editProfile({ add: false });
  console.log('已卸载 see-now。重启 DSH 生效。');
  await report();
  process.exit(0);
}

if (mode === 'remove-legacy') {
  await rm(join(MODULES, LEGACY_NAME), { recursive: true, force: true });
  await editProfile({ add: false, name: LEGACY_NAME });
  console.log(`已移除旧包 ${LEGACY_NAME}（目录与 profile 登记都清了）。重启 DSH 生效。`);
  await report();
  process.exit(0);
}

await rm(join(MODULES, PKG_NAME), { recursive: true, force: true });
await cp(HERE, join(MODULES, PKG_NAME), {
  recursive: true,
  filter: (s) => !SKIP.has(s.split(/[\\/]/).pop()),
});
await editProfile({ add: true });
console.log('已安装。重启 DSH 生效，然后让模型调 `see_now({ action: "watch" })`。');
await report();
