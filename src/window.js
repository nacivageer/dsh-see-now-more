/**
 * window.js — 拉起那颗悬浮窗（Python + tkinter，无边框/置顶/液态玻璃）。
 *
 * ## 为什么借用 watch 那份脚本，而不是拷一份
 *
 * 那份 `window.py` 有 3000 多行，而且**还在改**（用户刚收尾完一轮视觉）。
 * 拷一份进来 = 从今往后两边各自演化，改好的一边另一边看不见。
 * 所以默认策略是「找到哪份用哪份」，按优先级：
 *
 *   1. `DSH_SEE_WINDOW` 环境变量        —— 显式指定
 *   2. `~/.dsh/see-window.json` 的 script
 *   3. `~/.dsh/watch-window.json` 的 script  —— 用户就在那儿维护
 *   4. profile 里装的 `dsh-watch-together/examples/floating-chat/window.py`
 *   5. 开发仓库里的 `../dsh-watch-together/examples/floating-chat/window.py`
 *
 * 真到要独立发版那天，把 window.py 拷进 `examples/floating-chat/` 并加进第 5 步即可。
 *
 * ## 两个必须分开的东西
 *
 * - **聊天记录**：靠 `DSH_VIDEO_CACHE_DIR` 传给子进程，指到 `~/.dsh/see-now`。
 *   不分开的话，see-now 的消息会和陪看的消息串进同一个窗。
 * - **pid 锁**：`~/.dsh/see-now-window.pid`。不分开的话，陪看的窗开着时我们就不敢开了。
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatDir, dshHome } from './chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包里自带的那份 —— 由 `scripts/sync-window.mjs` 从上游生成，是最后的兜底 */
export const PACKAGED = join(HERE, '..', 'examples', 'floating-chat', 'window.py');
const REL = join('examples', 'floating-chat', 'window.py');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function seeConfig() {
  return readJson(join(dshHome(), 'see-window.json'));
}

export function pidPath() {
  return join(dshHome(), 'see-now-window.pid');
}

/**
 * pid 文件的 mtime（毫秒；没有就 0）。
 *
 * 用来区分**"用户手动重开了窗"**和**"窗一直没关过"** —— 两者 `windowAlive()` 都是 true。
 * 重开窗会重写 pid 文件，mtime 一定变；残留进程不会。
 */
export function pidStamp() {
  try { return statSync(pidPath()).mtimeMs; } catch { return 0; }
}

/** 心跳文件：窗口每秒 touch 一次，用来区分"进程还在"和"窗口真的在画"。 */
function heartbeatPath() {
  return join(chatDir(), 'window-heartbeat');
}

/** 心跳多久算过期。窗口 1 秒写一次，6 秒足够容忍一次 GC 或短暂卡顿。 */
export const HEARTBEAT_STALE_SEC = 6;

/**
 * 窗口的**可见性**配置（`~/.dsh/watch-window.json` 的 `hidden`）。
 *
 * 这个文件是**两个窗共用**的（陪看和 see-now 读到同一份 geometry / name / hidden），
 * 由 Python 侧的 `_sync_visible()` 每 250ms 读一次 mtime，变了就 withdraw / deiconify。
 *
 * **踩过的坑**：插件以前从不碰它。用户在窗上点了「藏起来」（或者陪看那边藏过），
 * `hidden` 就一直是 `true` —— 之后 `watch` 一切正常、进程在、心跳在跳，**屏幕上什么都没有**。
 * 模型没有"显示"这条指令，只能读文件猜，于是它答"我这边只有读权限，发不了显示指令"
 * （2026-11-03 社区反馈，原话）。
 */
export function windowConfigPath(env = process.env) {
  return join(dshHome(env), 'watch-window.json');
}

/** 窗是不是被藏起来了。读不到就当没藏（不能因为一个坏文件把窗判成看不见）。 */
export function windowHidden(env = process.env) {
  return readJson(windowConfigPath(env)).hidden === true;
}

/**
 * 改可见性。**读-改-写整份文件**，不能只写 `{hidden:false}` ——
 * 那样会把 `script` / `geometry` / `name` 一起抹掉，下一次开窗就得重新找解释器。
 * 写法跟窗口那边（`write_config`）逐字节一致：`indent=2`、无尾随换行、`.json.tmp` 再 rename。
 *
 * @returns {{changed:boolean, hidden:boolean, error?:string}}
 */
export function setWindowHidden(hidden, { log = () => {}, env = process.env } = {}) {
  const path = windowConfigPath(env);
  const cfg = readJson(path);
  const want = Boolean(hidden);
  // 已经是目标状态就**不写**：多写一次会让 Python 侧多醒一轮，还会把 mtime 刷成"刚刚改过"
  if (Boolean(cfg.hidden) === want) return { changed: false, hidden: want };
  cfg.hidden = want;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`写 ${path} 失败：${error}`);
    return { changed: false, hidden: !want, error };
  }
  return { changed: true, hidden: want };
}

/**
 * 窗口的完整状态，一句话能说清"为什么我看不见它"。
 *
 * `status` / `watch` 都把它带给模型 —— 以前模型只能去读 pid 和心跳文件自己猜，
 * 猜错就说"只有读权限"。
 */
export function windowReport({ env = process.env } = {}) {
  let pid = null;
  try {
    const n = Number(readFileSync(pidPath(), 'utf8').trim());
    if (Number.isInteger(n) && n > 0) pid = n;
  } catch { /* 没开过 */ }
  let heartbeatAgeSec = null;
  try {
    heartbeatAgeSec = Math.max(0, Math.round((Date.now() - statSync(heartbeatPath()).mtimeMs) / 1000));
  } catch { /* 老窗口不写心跳 */ }
  const hidden = windowHidden(env);
  return {
    pid,
    alive: windowPidAlive(),
    heartbeatAgeSec,
    heartbeatStale: heartbeatAgeSec === null ? null : heartbeatAgeSec > HEARTBEAT_STALE_SEC,
    hidden,
    disabled: env.DSH_SEE_NO_WINDOW === '1',
  };
}

/** `windowReport()` → 一行中文。 */
export function windowLine(r = windowReport()) {
  if (r.disabled) return '窗口：被 DSH_SEE_NO_WINDOW=1 关掉了';
  const proc = r.alive ? `进程 ${r.pid} 活着` : r.pid ? `进程 ${r.pid} 已经不在了` : '没开过';
  const hb = r.heartbeatAgeSec === null ? '没心跳'
    : r.heartbeatStale ? `心跳 ${r.heartbeatAgeSec}s 前（过期）`
      : `心跳 ${r.heartbeatAgeSec}s 前`;
  const vis = r.hidden ? '**藏起来的（用户看不见）**' : '显示中';
  return `窗口：${proc} · ${hb} · ${vis}`;
}

function logPath() {
  return join(dshHome(), 'see-now-window.log');
}

/**
 * 已安装的 `dsh-watch-together` 里那份 window.py（可能有多份）。
 *
 * 坑：以前硬编码 `profiles/desktop`，但 profile 名不止一个（本机有 `desktop` 和 `web`），
 * 而且 npm 还可能把它 hoist 到 `profiles/node_modules`。所以这里**全扫**。
 * 用运行中的那份而不是仓库那份，是因为 DSH 实际加载的就是 profile 里的副本 ——
 * 测仓库版等于没测到真正分发的版本。
 */
function installedCopies(env = process.env) {
  const home = dshHome(env);
  const roots = [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')];
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      roots.push(join(home, 'profiles', name, 'node_modules'));
    }
  } catch { /* 没有 profiles 目录 */ }
  const out = [];
  for (const root of roots) {
    const p = join(root, 'dsh-watch-together', REL);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/**
 * 窗口脚本放哪（按优先级找第一份存在的）。
 *
 * | 顺序 | 来源 | 什么时候用 |
 * |---|---|---|
 * | 1 | `DSH_SEE_WINDOW` | 临时指定、调试 |
 * | 2 | `~/.dsh/see-window.json` 的 `script` | 持久配置 |
 * | 3 | `~/.dsh/watch-window.json` 的 `script` | 用户在陪看那边维护的那份 |
 * | 4 | 已安装的 watch-together | **用户装了就永远是最新的**，零重复 |
 * | 5 | 开发仓库 `../dsh-watch-together` | 一边改一边试 |
 * | 6 | 包内 `examples/floating-chat/window.py` | 用户没装 watch 时的兜底 |
 *
 * 导出是为了让 `--check` 能报清楚究竟用的是哪个。
 *
 * @param {{env?:object}} [o] — 传 env 是为了让测试不用改 process.env
 */
export function resolveScript({ env = process.env } = {}) {
  const explicit = env.DSH_SEE_WINDOW;
  if (explicit && existsSync(explicit)) return { script: explicit, from: 'DSH_SEE_WINDOW' };

  const seen = readJson(join(dshHome(env), 'see-window.json')).script;
  if (seen && existsSync(seen)) return { script: seen, from: '~/.dsh/see-window.json' };

  const watch = readJson(join(dshHome(env), 'watch-window.json')).script;
  if (watch && existsSync(watch)) return { script: watch, from: '~/.dsh/watch-window.json' };

  const installed = installedCopies(env);
  if (installed.length) return { script: installed[0], from: '已安装的 watch-together' };

  const repo = join(HERE, '..', '..', 'dsh-watch-together', REL);
  if (existsSync(repo)) return { script: repo, from: '开发仓库' };

  if (existsSync(PACKAGED)) return { script: PACKAGED, from: '包内' };
  return { script: null, from: null };
}

/**
 * 解释器候选：**必须有 tkinter**。
 *
 * 本机踩过的坑：`PATH` 上的 `pythonw.exe` / `python.exe` 都是 WorkBuddy managed 的，
 * **不带 tkinter**，spawn 之后立刻退（日志里刷了一排 "No module named 'tkinter'"）。
 * 真正能用的是商店版（`WindowsApps/PythonSoftwareFoundation.Python.3.13_.../python.exe`）。
 * 所以这里不能只按名字排，得**真跑一次 import** 验。
 */
const TK_PROBE = 'import tkinter';

/**
 * 这个解释器能不能 `import tkinter`？
 *
 * 导出来是为了可测 —— 本机踩过的坑就是"解释器名字对、但没有 tkinter"，
 * 光看路径判断不出来，只能真跑一次。
 */
export function hasTkinter(python) {
  const r = spawnSync(python, ['-c', TK_PROBE], {
    timeout: 8000, windowsHide: true, stdio: 'ignore',
  });
  return r?.status === 0;
}

/**
 * 商店版的真实路径。
 *
 * 坑：`WindowsApps\PythonSoftwareFoundation.Python.3.13_*` 下的 `python.exe` 是
 * **App Execution Alias（重解析点）**，`existsSync()` 对它返回 false，
 * 但 `readdirSync()` 能列出、直接 spawn 也能跑。所以这里只认目录列举，不再二次探测。
 */
function storePython() {
  const dir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps');
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!/^PythonSoftwareFoundation\.Python\.\d/.test(name)) continue;
      for (const exe of ['pythonw.exe', 'python.exe']) {
        out.push(join(dir, name, exe));
      }
    }
  } catch { /* 读不了目录就算了 */ }
  return out;
}

export function pythonCandidates() {
  const cfg = seeConfig();
  const list = [];
  for (const c of [process.env.DSH_SEE_PYTHON, cfg.python, process.env.DSH_FLOAT_PYTHON]) {
    if (c) list.push(c);
  }
  if (process.platform === 'win32') {
    list.push('pythonw.exe', 'python.exe', ...storePython());
  } else {
    list.push('python3', 'python');
  }
  // 去重但保序
  return [...new Set(list.filter(Boolean))];
}

/** pid 文件指向的那个进程还在不在。**不看心跳**，见 `windowPidAlive` 的注释。 */
export function windowPidAlive() {
  if (process.env.DSH_SEE_NO_WINDOW === '1') return false;
  let pid = 0;
  try { pid = Number(readFileSync(pidPath(), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return true;
}

/**
 * 上次开的那个还活着吗？（**"这窗还能用吗"**，决定要不要重开）
 *
 * **不能只看 pid**：pid 会被系统复用，进程也可能活着但界面卡死、或者是一张全透明的空窗。
 * 那种情况下这里一直返回 true，于是**再也不重开**，用户体感是"点了没反应"
 * （issue #2 第 3 条）。所以加一层心跳：窗口每秒 touch 一个文件，过期就当它死了。
 *
 * 没有心跳文件时**不判死**：老版本窗口不写心跳，误杀会让它每次都被重开。
 *
 * **别拿它回答"用户是不是不想看了"**：心跳 6 秒过期太容易了（机器睡一觉、
 * 主线程卡一下都算），而那个判断的代价是单向的。那个问题用 `windowPidAlive()` + 拍数，
 * 见 `loop.js` 的 `windowVerdict()`。
 */
export function windowAlive() {
  if (!windowPidAlive()) return false;
  try {
    const hb = statSync(heartbeatPath());
    if ((Date.now() - hb.mtimeMs) / 1000 > HEARTBEAT_STALE_SEC) return false;
  } catch { /* 没有心跳文件：兼容老窗口，继续信任 pid */ }
  return true;
}

/**
 * 开窗（幂等）。
 *
 * 三步都要做，少一步就会得到一个"看起来成功、其实早就退了"的窗：
 *   1. 真跑一次 `import tkinter` 验解释器（managed python 没有，会立刻退）
 *   2. spawn 之后等 700ms，看它有没有自己退出（脚本报错退出也是退）
 *   3. **确认活着才写 pid** —— 否则 pid 文件指向死进程，`windowAlive()` 永远 false
 *
 * `script` 传了就**跳过 resolveScript()**，测试靠这个把自己钉在一个注定失败的脚本上 ——
 * 否则一旦那个脚本不存在，回退链会摸到真的 window.py，测试当场把窗弹到用户脸上（踩过）。
 *
 * @returns {{ok:boolean, script?:string, python?:string, from?:string, reason?:string, already?:boolean}}
 */
export async function openWindow({ force = false, log = () => {}, settleMs = 700, script: forced = null } = {}) {
  if (process.env.DSH_SEE_NO_WINDOW === '1') return { ok: false, reason: 'disabled' };
  if (!force && windowAlive()) return { ok: true, already: true };

  // force、或者 pid 还在但心跳过期（进程卡死/是空窗）才会走到这儿：
  // 先把上一次那个进程收掉，否则会叠出两个窗口，而用户只看得见一个。
  try {
    const old = Number(readFileSync(pidPath(), 'utf8').trim());
    if (Number.isInteger(old) && old > 0 && old !== process.pid) {
      try { process.kill(old); } catch { /* 已经没了 */ }
    }
  } catch { /* 没有 pid 文件，正常首次启动 */ }

  const { script, from } = forced
    ? { script: forced, from: '调用方指定' }
    : resolveScript();
  if (!script) {
    return { ok: false, reason: '找不到 window.py（设 DSH_SEE_WINDOW，或写 ~/.dsh/see-window.json）' };
  }
  if (forced && !existsSync(forced)) {
    return { ok: false, reason: `指定的 script 不存在：${forced}`, script: forced, from };
  }

  const tried = [];
  /** 所有候选解释器上缺的包（去重后一次性报出来）—— 必须声明在循环外，否则末尾拼 reason 时看不到 */
  const missing = new Set();
  for (const python of pythonCandidates()) {
    if (!hasTkinter(python)) { tried.push(`${python}（无 tkinter）`); continue; }

    let errFd = 'ignore';
    try { errFd = openSync(logPath(), 'a'); } catch { /* 打不开日志就丢掉 */ }

    let child;
    try {
      child = spawn(python, [script], {
        stdio: ['ignore', errFd, errFd],
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          // 关键：窗口按这个目录找 chat.jsonl，指到我们自己的目录，
          // 既不会读到陪看的消息，也不会把我们的消息写进陪看那条流
          DSH_VIDEO_CACHE_DIR: chatDir(),
        },
      });
    } catch (e) {
      tried.push(`${python}（spawn 失败：${e?.message ?? e}）`);
      if (typeof errFd === 'number') { try { closeSync(errFd); } catch { /* 已关 */ } }
      continue;
    }

    const dead = await waitExit(child, settleMs);
    if (typeof errFd === 'number') { try { closeSync(errFd); } catch { /* 已关 */ } }
    if (dead) {
      // code=1 且是"立刻退出"：八成是缺包。探测一次，把包名带进错误信息。
      const miss = dead.code === 1 ? missingPkgs(python) : [];
      for (const m of miss) missing.add(m);
      tried.push(`${python}（启动后 ${settleMs}ms 内退出，code=${dead.code}`
        + `${miss.length ? `，缺 ${miss.join('/')}` : ''}）`);
      log(`[window] ${python} 启动后立即退出，换下一个`);
      continue;
    }

    child.unref?.();
    try { writeFileSync(pidPath(), String(child.pid ?? ''), 'utf8'); } catch { /* 写不了只是会多开一次 */ }
    return { ok: true, script, from, python };
  }

  let reason = `没有能用的解释器（要带 tkinter）：${tried.join(' / ') || '一个候选都没有'}`;
  if (missing.size) {
    const pkgs = [...missing].join(' ');
    reason += `\n缺 Python 包：${pkgs}。装一下：`
      + `python -m pip install ${pkgs}`
      + `（用上面那句报错里的那个 python；装完把窗关掉重开）。`;
  }
  return { ok: false, reason, script, missing: [...missing] };
}

/**
 * 窗口脚本需要这三个包。**缺任何一个都会让 python 在 700ms 内退出、code=1**，
 * 而插件这边只看得到 exit code —— 社区实报"只报 code=1，不知道要装什么"。
 * 所以启动全失败之后跑一次探测，把缺的包名换成 pip 命令一起报出去。
 */
const DEPS_PROBE = [
  'miss = []',
  'for mod, pkg in (("PIL", "Pillow"), ("mss", "mss"), ("numpy", "numpy")):',
  '    try:',
  '        __import__(mod)',
  '    except Exception:',
  '        miss.append(pkg)',
  'print(",".join(miss))',
].join('\n');

function missingPkgs(python) {
  try {
    const r = spawnSync(python, ['-c', DEPS_PROBE], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    const out = String(r.stdout ?? '').trim();
    return out ? out.split(',') : [];
  } catch { return []; }
}

/** 等最多 `ms`；进程先退出就返回 {code}，否则返回 null（还活着）。 */
function waitExit(child, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), ms);
    child.once('exit', (code, signal) => finish({ code: code ?? signal }));
    child.once('error', (e) => finish({ code: `error:${e?.message ?? e}` }));
  });
}

/** 关窗（读 pid 杀掉；用户自己点 × 的话这里什么也不用做） */
export function closeWindow() {
  try {
    const pid = Number(readFileSync(pidPath(), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid);
  } catch { /* 已经没了 */ }
  try { unlinkSync(pidPath()); } catch { /* 本来就没有 */ }
}
