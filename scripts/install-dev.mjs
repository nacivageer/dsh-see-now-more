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

import { cp, mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { classifyInstall, describeInstall } from './install-state.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const MODULES = join(PROFILE_DIR, 'node_modules');
const PKG_NAME = 'dsh-see-now-more';
const LEGACY_NAME = 'dsh-see-now';
/** 包外备份（不在 node_modules 里）：profile 重装/清目录不会带走它。 */
const BACKUP_ROOT = join(DSH_HOME, 'backups', PKG_NAME);
/** 安装标记：记版本/时间/来源/备份，`--check` 不必只靠猜。 */
const MARKER = join(PROFILE_DIR, '.see-now-more-install.json');
const KEEP_BACKUPS = 3;
/** 一次安装的临时目录（stage）与旧副本暂存（trash）。 */
const stageOf = (stamp) => join(MODULES, `${PKG_NAME}.staging-${stamp}`);
const trashOf = (stamp) => join(MODULES, `${PKG_NAME}.trash-${stamp}`);

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

/** 一次安装的临时后缀（带毫秒，避免和上一次的残留撞名）。 */
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

/** 读目标目录 + 源码版本，判五态。所有读盘失败都归一成 null，不抛。 */
async function targetInfo() {
  const target = join(MODULES, PKG_NAME);
  const exists = existsSync(target);
  const pkg = exists ? await readJson(join(target, 'package.json')).catch(() => null) : null;
  const manifest = exists ? await readJson(join(target, 'dsh.plugin.json')).catch(() => null) : null;
  const repoVersion = (await readJson(join(HERE, 'package.json')).catch(() => ({}))).version ?? null;
  const entryExists = existsSync(join(target, 'src', 'index.js'));
  const state = classifyInstall({
    exists,
    name: pkg?.name ?? null,
    version: pkg?.version ?? null,
    repoVersion,
    entryExists,
  });
  return {
    target, exists, pkg, manifest, entryExists, repoVersion,
    version: pkg?.version ?? null, state,
  };
}

/** 已有的包外备份（新 → 旧）。 */
async function backupsList() {
  try {
    return (await readdir(BACKUP_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 上次安装中途留下的 staging/trash。 */
async function leftovers() {
  try {
    const names = await readdir(MODULES);
    return names.filter((n) => n.startsWith(`${PKG_NAME}.staging-`) || n.startsWith(`${PKG_NAME}.trash-`));
  } catch {
    return [];
  }
}

/**
 * 把当前副本整体复制到**包外**（`$DSH_HOME/backups/<pkg>/<时间戳>/`），保留最近 KEEP_BACKUPS 份。
 *
 * 为什么要包外：`node_modules` 是 pnpm / profile 的地盘，重装或清缓存会把它整片带走；
 * 备份放在包外，坏装之后还能手工拿回来。每份带 `meta.json`（版本/来源/时间）。
 */
async function backupCurrent(info) {
  const dir = join(BACKUP_ROOT, stampNow());
  await mkdir(BACKUP_ROOT, { recursive: true });
  await cp(info.target, dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify({
    name: PKG_NAME, version: info.version, from: info.target, at: Date.now(),
  }, null, 2)}\n`, 'utf8');
  const dirs = await backupsList();
  for (const old of dirs.slice(KEEP_BACKUPS)) {
    await rm(join(BACKUP_ROOT, old), { recursive: true, force: true });
  }
  return dir;
}

/**
 * 原子替换：先 `cp` 到 stage（target 不动）→ target 改名躲开 → stage 改名顶上去 →
 * 删掉旧副本。中途任何一步失败都把旧副本改回来；stage 一定清掉。
 *
 * 和旧的「先 rm 再 cp」差在**失败时 target 还在**：cp 到一半断电只会剩一份 stage，
 * `--check` 能看见并提示重装，而不是留下半份插件让 DSH 起不来。
 */
async function installAtomic() {
  const info = await targetInfo();
  if (info.state === 'foreign') {
    console.error(`拒绝覆盖：${info.target} 不是本包（package.json name=${info.pkg?.name ?? '读不到'}）`);
    console.error('先确认那个目录是什么（或改名/删掉），再跑安装。');
    return { ok: false, state: info.state };
  }

  const stamp = stampNow();
  const stage = stageOf(stamp);
  const trash = trashOf(stamp);
  const backup = info.exists ? await backupCurrent(info) : null;
  try {
    await rm(stage, { recursive: true, force: true });
    await cp(HERE, stage, {
      recursive: true,
      filter: (s) => !SKIP.has(s.split(/[\\/]/).pop()),
    });
    const staged = await readJson(join(stage, 'package.json')).catch(() => null);
    if (staged?.name !== PKG_NAME) throw new Error(`stage 里不是本包：${staged?.name ?? '读不到 package.json'}`);

    let moved = false;
    if (info.exists) {
      await rename(info.target, trash);
      moved = true;
    }
    try {
      await rename(stage, info.target);
    } catch (e) {
      if (moved) {
        try { await rename(trash, info.target); } catch { /* 留给 --check 报 broken/残留 */ }
      }
      throw e;
    }
    if (moved) await rm(trash, { recursive: true, force: true });
    await writeFile(MARKER, `${JSON.stringify({
      name: PKG_NAME, version: staged.version, at: Date.now(), source: HERE, backup,
    }, null, 2)}\n`, 'utf8');
    return { ok: true, version: staged.version, backup, state: info.state };
  } catch (e) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

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

function probeModules(python, code) {
  if (!python) return null;
  try {
    const r = spawnSync(python, ['-c', code], { timeout: 15000, windowsHide: true, stdio: 'ignore' });
    return r?.status === 0;
  } catch {
    return null;
  }
}

/** `windows_capture` 顶层 import cv2（只为 imwrite）—— 探针要带同样的 stub，否则假阴性。 */
const WGC_PROBE = "import sys,types;m=types.ModuleType('cv2');m.imwrite=lambda *a,**k:False;"
  + "sys.modules.setdefault('cv2',m);import windows_capture";
/** 血条数字识别：WinRT 的 OCR / 位图 / 流 / 语言四个命名空间。 */
const OCR_PROBE = 'import winrt.windows.media.ocr, winrt.windows.graphics.imaging, '
  + 'winrt.windows.storage.streams, winrt.windows.globalization';

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
  const info = await targetInfo();
  const installed = info.exists;
  const registered = bundles.includes(PKG_NAME);
  console.log(`profile   : ${PROFILE_DIR}`);
  console.log(`${PKG_NAME}: ${installed ? '已安装' : '未安装'}  bundles ${registered ? '已注册' : '未注册'}`);
  console.log(`安装状态  : ${info.state} —— ${describeInstall(info.state, {
    version: info.version, repoVersion: info.repoVersion,
  })}`);
  const left = await leftovers();
  if (left.length) {
    console.log(`⚠ 残留     : ${left.join(', ')}（上次安装没跑完；重跑安装会清掉，别手改）`);
  }
  const bks = await backupsList();
  if (bks.length) {
    console.log(`包外备份  : ${bks[0]}（共 ${bks.length} 份，${BACKUP_ROOT}）`);
  }
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
   * 两条血条依赖都是**可选**：没有也能装、能采，只是能力降级。
   * 单列出来的理由是它们都装在 DSH 的 runtime python 里，**DSH 一升级就没了** ——
   * 2026-11-16 用户原话：「每次升级都得重新搞依赖」。这里报一次，比事后猜「为什么血条不对」便宜。
   */
  if (py.ok) {
    const wgc = probeModules(py.python, WGC_PROBE);
    const ocr = probeModules(py.python, OCR_PROBE);
    console.log(`  血条窗口抓: ${wgc ? '✓ windows-capture' : '✗ 没装（pip install windows-capture）—— 被遮挡时读不到'}`);
    console.log(`  血条数字  : ${ocr ? '✓ winrt（OCR 读 当前/最大）' : '✗ 没装（pip install winrt-runtime winrt-Windows.Media.Ocr …）—— 只有比例'}`);
  }

  /**
   * **版本对账。**
   *
   * 这一行是给"我这会话里怎么没有 see_now 这个工具"准备的：宿主启动时才组合插件树，
   * 组合的是 profile 里那份**副本**。副本落后（或者 `dsh.plugin.json` 和 `package.json`
   * 版本不一致）时，跑的就是旧代码 —— 而"新开一个会话"不会改变任何已加载的代码。
   */
  const repoVersion = info.repoVersion;
  let stale = null;
  if (installed) {
    console.log(`源码版本  : ${repoVersion}`);
    console.log(`副本版本  : ${info.version ?? '读不到'}`
      + `${info.state === 'current' ? '  ✓ 一致'
        : info.state === 'stale' ? '  ⚠️ 和源码不一致（跑的是旧代码）'
          : info.state === 'broken' ? '  ⚠️ 入口/版本读不到' : ''}`);
    if (info.manifest && info.manifest.version !== info.version) {
      console.log(`  ⚠️ 副本里 dsh.plugin.json 写的是 ${info.manifest.version} —— 和 package.json 不一致，插件管理器会按旧版本认它`);
    }
    if (info.state === 'stale') stale = { copyVersion: info.version };
  }
  if (stale) {
    console.log('\n→ 跑 `node scripts/install-dev.mjs` 同步，然后**重启 DSH Desktop**。');
    console.log('  （新开一个会话不够：插件树是进程启动时组合的，已加载的代码不会换。）');
  }
  return { installed, registered, stale, state: info.state };
}

if (mode === 'check') {
  await report();
  process.exit(0);
}

if (mode === 'remove') {
  await rm(join(MODULES, PKG_NAME), { recursive: true, force: true });
  await rm(MARKER, { force: true });
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

const installed = await installAtomic();
if (!installed.ok) {
  await report();
  process.exit(2);
}
await editProfile({ add: true });
// 新副本已经就位；上一次失败留下的 staging/trash 现在没用，清掉以免 --check 一直报
for (const name of await leftovers()) {
  await rm(join(MODULES, name), { recursive: true, force: true }).catch(() => {});
}
console.log(`已安装 ${installed.version}`
  + `${installed.backup ? `（旧副本备份：${installed.backup}）` : ''}。`
  + '重启 DSH 生效，然后让模型调 `see_now({ action: "watch" })`。');
await report();
