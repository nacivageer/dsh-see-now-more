#!/usr/bin/env node
/**
 * scripts/lift-buffer-probe.mjs — P2-A 的实测脚本（验收 #1 / #2 / #3 / #5）。
 *
 * 它跑的是**真那一路**：`runner.listenOnly({audio:false})` → 0.5 fps 真抓屏 → 环形缓冲，
 * 和 Desktop 里跑的是同一份代码。**不拉 ASR**（`audio:false`）：这里量的是留底本身的
 * 内存与 CPU；ASR 的占用跟这一棒无关，混进来只会让归因变糊。
 *
 * 用法：
 *   node scripts/lift-buffer-probe.mjs                # 2 分钟快速自查
 *   node scripts/lift-buffer-probe.mjs --minutes 30   # 30 分钟黑听长跑（验收用的那组数）
 *
 * 尾段那个「实测」小表就是给任务文档抄的。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **必须先隔离 DSH_HOME**：`runner.stop()` 会顺带 `listener.stop()`，它读
 * `~/.dsh/see-now/audio/listen.pid` 然后 taskkill —— 不隔离的话，这个脚本会把
 * 你 Desktop 里正在听的那只 python 杀掉（真事，测试里踩过一次）。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-lift-probe-'));

const { createRunner } = await import('../src/runner.js');
const { resolveFfmpeg } = await import('../src/binaries.js');
const { LIFT_FPS, LIFT_WINDOW_SEC } = await import('../src/lift-buffer.js');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const minutes = Math.max(0.2, Number(arg('minutes', 2)) || 2);
const ffmpegPath = arg('ffmpeg', resolveFfmpeg().path);
/** `--region x,y,w,h`：验「框过一块的人，瞥到的也是那块」（尺寸按区域比例算）。 */
const regionArg = arg('region', null);
const region = regionArg
  ? (() => {
    const [x, y, w, h] = String(regionArg).split(',').map(Number);
    return { x, y, w, h };
  })()
  : undefined;

const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;

/** 问一次 PowerShell（拿 ffmpeg 的 CPU / 存活）。拿不到就返回 null，不猜。 */
function ps(script) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    const t = String(out).trim();
    return t === '' ? null : t;
  } catch { return null; }
}

function cpuSec(pid) {
  if (!pid) return null;
  const t = ps(`$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.TotalProcessorTime.TotalSeconds }`);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function isAlive(pid) {
  if (!pid) return false;
  return ps(`if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'yes' }`) === 'yes';
}

const log = (m) => console.log(`[probe] ${m}`);
const runner = createRunner({ ffmpegPath, log, mode: 'vision' });

const r = await runner.listenOnly({ audio: false, region });
if (!r?.lift?.ok) {
  console.error('[probe] 留底没起来：', JSON.stringify(r?.lift ?? r, null, 2));
  runner.stop();
  process.exit(1);
}
const pid = runner.status().lift.pid;
log(`留底已起（ffmpeg pid ${pid}），跑 ${minutes} 分钟`);

const t0 = Date.now();
let peakRss = 0;
let peakBytes = 0;
let firstCpu = null;
let firstCpuAt = 0;
let lastCpu = null;
let lastCpuAt = 0;

async function sample() {
  const st = runner.status().lift;
  const rss = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, rss);
  peakBytes = Math.max(peakBytes, st.bytes ?? 0);
  const cpu = cpuSec(pid);
  if (cpu !== null) {
    if (firstCpu === null) { firstCpu = cpu; firstCpuAt = Date.now(); }
    lastCpu = cpu;
    lastCpuAt = Date.now();
  }
  return { st, rss };
}

while (Date.now() < t0 + minutes * 60_000) {
  await new Promise((res) => setTimeout(res, Math.min(30_000, Math.max(1000, t0 + minutes * 60_000 - Date.now()))));
  const { st, rss } = await sample();
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(`  ${String(el).padStart(4)}s · ${st.frames} 帧 / ${st.mb} MB · span ${st.spanSec}s`
    + ` · age ${st.ageSec}s · RSS ${mb(rss)} MB`);
}

const st = runner.status().lift;
/** 验收 #2：按「10 秒前那一刻」回取。10 秒稳稳在 30 秒窗口里。 */
const tTest = Date.now() - 10_000;
const got = runner.frameAt(tTest);
runner.stop();
const gone = !isAlive(pid);
const after = runner.status().lift;

const cores = (firstCpu !== null && lastCpu !== null && lastCpuAt > firstCpuAt)
  ? (lastCpu - firstCpu) / ((lastCpuAt - firstCpuAt) / 1000)
  : null;

console.log('\n===== 实测 =====');
console.log(`时长：${minutes} 分钟 · ${LIFT_FPS} fps · ${LIFT_WINDOW_SEC} 秒窗 · ${st.size?.[0]}×${st.size?.[1]}`);
console.log(`帧数：${st.frames} 帧（span ${st.spanSec}s，约 ${LIFT_FPS * LIFT_WINDOW_SEC} 帧是目标）`);
console.log(`缓冲内存：${st.mb} MB（峰值 ${mb(peakBytes)} MB，单帧 ${mb(st.bytes / Math.max(1, st.frames))} MB）`);
console.log(`进程 RSS 峰值：${mb(peakRss)} MB（含 node 自身；留底自己那份就是上面的缓冲）`);
console.log(cores === null
  ? 'ffmpeg CPU：没拿到（非 Windows 或 PowerShell 不可用）'
  : `ffmpeg CPU：${cores.toFixed(2)} 核（${LIFT_FPS} fps 抓屏那一路，${(lastCpuAt - firstCpuAt) / 1000}s 采样）`);
console.log(got.ok
  ? `按 t0 取帧：t0 = 10 秒前 → 偏差 ${got.deltaMs} ms（${Math.abs(got.deltaMs) <= 1000 ? '✓ ≤1 秒' : '✗ 超过 1 秒'}）`
  : `按 t0 取帧：✗ ${got.reason}`);
console.log(`stop 后：缓冲 ${after.frames} 帧 ${after.frames === 0 ? '✓ 已清空' : '✗ 没清'}`,
  `· ffmpeg ${gone ? '✓ 已退出' : '✗ 还活着'}`);

process.exit(got.ok && after.frames === 0 && gone ? 0 : 1);
