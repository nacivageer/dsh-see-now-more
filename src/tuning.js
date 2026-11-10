/**
 * tuning.js — `~/.dsh/see-now.json`：用户自己的节奏参数。
 *
 * 为什么要这个文件：`MAX_AUTONOMOUS_WAKES`（8 次）和 `IDLE_STOP_MS`（3 分钟）
 * 原来写死在 `loop.js`，而**悬浮窗开着时「3 分钟没人说话」那条不判** ——
 * 于是 8 次叫醒就是实际的最长陪看时长（normal 档 15 秒一次 ≈ 2 分钟）。
 * 想让它多陪一会儿的用户只能改源码，或者每次开新会话先手动 `pace:"calm"`（#8）。
 *
 * 和 voice.json / tts.json / asr.json 一个套路：放 `$DSH_HOME`，不进 profile，
 * 所以 `dsh plugin update` 不会覆盖。**改完要重开 DSH**（启动时读一次，
 * 每帧读盘是拿帧率换便利，不划算）。
 *
 * 所有字段都可选；写错类型就退回默认值并记一条 warn —— 配置永远不该把插件弄挂。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 与 loop.js 的常量保持一致；这里放默认值是为了不形成反向依赖。 */
export const TUNING_DEFAULTS = Object.freeze({
  maxAutonomousWakes: 8,
  idleStopMin: 3,
  defaultPace: 'normal',
  // 「上一句说多久，就等多久再叫下一轮」（见 pacing.js）。false = 退回固定 8 秒。
  speechPacing: true,
  /**
   * 任务模式下 `missed.jsonl` 的「单图内部空窗」阈值（秒）。
   *
   * 一张图里两个 keep 隔多远才算"这里真的没画面"。**不能拿帧间距当空窗**：
   * 正常节拍是 2 帧/张、两帧隔 20 秒，静止时最稀到 30 秒（calm 的 `floorMax`）。
   * 取 60 = 正常间距上界的两倍 —— 再小会把正常节拍写成空档，再大则一分钟的空洞就漏了。
   * 依据：`scripts/spacing-probe.mjs`（真素材 120 秒：帧间距 p90 2 秒；
   * 静止屏幕 20–23 秒）。
   */
  missedGapSec: 60,
  /**
   * 起手用哪档感官：`both` = 视听都开，`vision` = 只看（2026-11-09 用户要求「三种模式各有入口」）。
   *
   * **只持久化前两档**：它们决定「开始看的时候要不要顺带起耳朵」。
   * `audio`（只听）是一次性动作（= `action:"listen"`），不落盘 —— 重开 DSH 时
   * 自动把耳朵拉起来，等于后台常驻一个抓回环的进程，不是用户要的。
   */
  mode: 'both',
  /**
   * 裸采集（没有常驻循环、也没有人取图）闲置多少分钟自动收工。0 = 关掉。
   *
   * 2026-11-09 用户要求（S1）：`action:"start"` 起完忘了 `stop`，ffmpeg 会一直抓到
   * DSH 退出 —— 实测一次 2 分钟空转 1600+ 帧。`idleStopMin` 那条线只管常驻循环。
   */
  idleCaptureMin: 5,
  /**
   * 亮度归一 + 黑边补偿（见 `cuts.js` 的 `normalizeScore`）。默认开。
   *
   * 关掉等于回到绝对分：夜戏/暗调影视剧的真切点只有约 5 分，门槛 12 够不着；
   * 2.39:1 的片子上下黑边把分数打了 75 折。**亮场（V ≥ REF_V）无黑边时它逐位不变**，
   * 所以留着不影响日常屏幕，只在暗场/宽银幕上起作用。
   */
  scoreNormalize: true,
});

/**
 * 「听声音」那一链的延迟参数（`see-now.json` 的 `listen` 段）。
 *
 * 这几个数决定"视频里说的话多久之后能变成台词"，是全链路唯一能调的地方：
 *
 * ```
 * 开口 ──silence/maxSeg 断句──▶ 落盘 ──pollMs──▶ 转写 ──▶ 台词可读
 *        └─ liveMin/liveStep：长句不等断句，先给一版临时台词
 * ```
 *
 * `live` 那组是 2026-11-04 加的：实测本地 paraformer 转 1.5 秒音频只要 140ms，
 * 而长句要等 `maxSeg`（3 秒）强切才动 —— **等断句的时间是转写本身的 20 倍**。
 */
export const LISTEN_DEFAULTS = Object.freeze({
  /** 长句「边说边出字幕」：说满 `liveMin` 秒就先转一版，整句落盘后覆盖它。 */
  live: true,
  /** 说满这么多秒才发第一版快照。1.0 秒的片段质量明显掉（实测丢一半），1.5 可用，1.8 稳。 */
  liveMin: 1.8,
  /** 之后每这么多秒刷新一次。**别低于 1.0** —— 转写服务是串行的，压太密只会互相排队。 */
  liveStep: 1.2,
  /** 静音多久算一句说完。0.35 是"人话气口"的下限，再低会把"第一个维/度是技术"切成两半。 */
  silence: 0.35,
  /** 一句话最长多少秒强切。长句靠 `live` 提前出字幕，这里不必再压。 */
  maxSeg: 3.0,
  /** Node 扫目录的间隔（毫秒）。直接计进延迟，200 → 100 净省 100ms。 */
  pollMs: 100,
});

/** 可用节奏。和 runner.js 的 PACES 同步，但不在模块层 import（避免环形依赖）。 */
export const PACES_KEYS = Object.freeze(['calm', 'normal', 'dense', 'game-economic']);

/**
 * 「黑听抬头」（lift）段的默认值（`see-now.json` 的 `lift` 段）。
 *
 * 四档的机读名（`lift.jsonl` 的 `level` 字段，和 `see-now-listen-lift.md` 一一对应）：
 *   alarm = 警觉（只记一笔）→ glance = 瞥（取 1 帧）→ look = 看（叫醒）→ chase = 追（连续看）
 *
 * `holdSec`：抬头之后多久自动回落。**起算点 = 最后一次语音/对话结束**，不是抬头那一刻
 * （否则长静音里的一次抬头会立刻回）。`0` = 关掉自动回落（一直保持到收工线）。
 */
export const LIFT_DEFAULTS = Object.freeze({
  enabled: true,
  level: 'glance',
  holdSec: 15,
});

/** 可用档位。顺序就是成本梯度，越往后越贵。 */
export const LIFT_LEVELS = Object.freeze(['alarm', 'glance', 'look', 'chase']);

function dshHome(env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function tuningPath(env = process.env) {
  return join(dshHome(env), 'see-now.json');
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/**
 * `listen` 段。每项都夹在自己那段区间里，越界退回默认并记一条 warn ——
 * 写成 `"silence": "0.3"`（字符串）这种也必须能跑，配置不该把听声音弄停。
 */
function readListen(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = { ...LISTEN_DEFAULTS };
  const bad = [];

  if (src.live !== undefined) {
    if (typeof src.live === 'boolean') out.live = src.live;
    else bad.push('listen.live 只能是 true / false');
  }
  const num = (key, min, max) => {
    if (src[key] === undefined) return;
    const v = clampNum(src[key], min, max, out[key]);
    if (v !== out[key]) bad.push(`listen.${key} 必须在 ${min}–${max} 之间（秒）`);
    out[key] = v;
  };
  num('liveMin', 0.8, 6);
  num('liveStep', 0.4, 4);
  num('silence', 0.15, 1.5);
  num('maxSeg', 0.8, 15);

  if (src.pollMs !== undefined) {
    const v = clampInt(src.pollMs, 50, 1000, out.pollMs);
    if (v !== out.pollMs) bad.push('listen.pollMs 必须是 50–1000 的整数（毫秒）');
    out.pollMs = v;
  }
  // 快照间隔必须小于强切上限，否则一遍都发不出来
  if (out.live && out.liveStep > out.maxSeg) {
    bad.push('listen.liveStep 不能大于 maxSeg，已按 maxSeg 收窄');
    out.liveStep = out.maxSeg;
  }
  return { listen: out, warnings: bad };
}

/**
 * `lift` 段：黑听抬头的开关、默认档与回落时间。
 *
 * 这里只做「配置怎么读、越界怎么办」；机制本身（纯函数）在
 * `lift-pool.js` / `lift-triggers.js`。写成非法值时退回默认并记一条 warn ——
 * 配置不该把黑听弄停。
 */
function readLift(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = { ...LIFT_DEFAULTS };
  const bad = [];

  if (src.enabled !== undefined) {
    if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
    else bad.push('lift.enabled 只能是 true / false，已用默认 true');
  }

  if (src.level !== undefined) {
    const want = typeof src.level === 'string' ? src.level.trim() : '';
    if (LIFT_LEVELS.includes(want)) out.level = want;
    else bad.push(`lift.level 只能是 ${LIFT_LEVELS.join(' / ')}（警觉/瞥/看/追），已用默认 glance`);
  }

  if (src.holdSec !== undefined) {
    const v = clampInt(src.holdSec, 0, 600, LIFT_DEFAULTS.holdSec);
    // 比的是「原值有没有被接受」，不是「等不等于默认」—— 0 是合法值（关掉自动回落）
    if (Number(src.holdSec) !== v) {
      bad.push('lift.holdSec 必须是 0–600 的整数（秒，0 = 关掉自动回落），已用默认 15');
    }
    out.holdSec = v;
  }

  return { lift: out, warnings: bad };
}

/**
 * 绑定的会话 id（`session`）。
 *
 * 为什么要有它：`session/event` 钩子会把**每个会话**的模型正文都写进同一条
 * `chat.jsonl`，循环的 owner 又跟着"最近说话的那个会话"漂移 —— 于是悬浮窗里
 * 混着好几个会话的话，在窗里说的话也不一定投回原会话。
 *
 * 写上这个字段之后：窗里只出现这个会话的话，窗里打字的投递目标也钉死它。
 * 不写 = 维持旧行为（不绑定）。
 */
function readBoundSession(raw, warnings) {
  if (raw.session === undefined || raw.session === null) return null;
  if (typeof raw.session !== 'string' || !raw.session.trim()) {
    warnings.push('session 必须是非空的会话 id 字符串，已忽略（不绑定会话）');
    return null;
  }
  const session = raw.session.trim();
  if (!/^session-[0-9a-zA-Z-]+$/.test(session)) {
    warnings.push(`session 看着不像会话 id（应该形如 session-…），已按原样使用：${session}`);
  }
  return session;
}

/**
 * @param {{env?:NodeJS.ProcessEnv, readFile?:typeof readFileSync}} [opts]
 * @returns {{maxAutonomousWakes:number, idleStopMin:number, idleStopMs:number,
 *            defaultPace:string, session:string|null, path:string, warnings:string[]}}
 */
export function readTuning({ env = process.env, readFile = readFileSync } = {}) {
  const path = tuningPath(env);
  const warnings = [];
  let raw = {};
  try {
    raw = JSON.parse(readFile(path, 'utf8')) ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push('see-now.json 不是 JSON 对象，整份忽略');
      raw = {};
    }
  } catch (err) {
    // ENOENT 是正常的（没配过）；其它错误要说出来，否则用户改坏了也不知道
    if (err?.code !== 'ENOENT') warnings.push(`see-now.json 读不了：${err?.message ?? err}`);
    raw = {};
  }

  const maxAutonomousWakes = clampInt(
    raw.maxAutonomousWakes, 1, 200, TUNING_DEFAULTS.maxAutonomousWakes,
  );
  if (raw.maxAutonomousWakes !== undefined && maxAutonomousWakes === TUNING_DEFAULTS.maxAutonomousWakes) {
    const n = Number(raw.maxAutonomousWakes);
    if (!(Number.isInteger(n) && n >= 1 && n <= 200)) {
      warnings.push('maxAutonomousWakes 必须是 1–200 的整数，已用默认 8');
    }
  }

  // 0 = 关掉这条收工线（愿意一直陪着的人自己负责）
  const idleStopMin = clampInt(raw.idleStopMin, 0, 1440, TUNING_DEFAULTS.idleStopMin);
  if (raw.idleStopMin !== undefined && Number(raw.idleStopMin) !== idleStopMin) {
    warnings.push('idleStopMin 必须是 0–1440 的整数（分钟），已用默认 3');
  }

  let defaultPace = TUNING_DEFAULTS.defaultPace;
  if (typeof raw.defaultPace === 'string' && raw.defaultPace.trim()) {
    const want = raw.defaultPace.trim();
    if (PACES_KEYS.includes(want)) defaultPace = want;
    else warnings.push(`defaultPace 只能是 ${PACES_KEYS.join(' / ')}，已用默认 normal`);
  }

  // true / "follow" = 按上一句时长排；"guard" = 旧间隔与说完取更晚；false = 关掉
  let speechPacing = TUNING_DEFAULTS.speechPacing;
  if (raw.speechPacing !== undefined) {
    if (typeof raw.speechPacing === 'boolean') speechPacing = raw.speechPacing;
    else if (raw.speechPacing === 'guard') speechPacing = 'guard';
    else warnings.push('speechPacing 只能是 true / false / "guard"，已用默认 true');
  }

  const missedGapSec = clampInt(
    raw.missedGapSec, 5, 3600, TUNING_DEFAULTS.missedGapSec,
  );
  if (raw.missedGapSec !== undefined && missedGapSec === TUNING_DEFAULTS.missedGapSec) {
    const n = Number(raw.missedGapSec);
    if (!(Number.isInteger(n) && n >= 5 && n <= 3600)) {
      warnings.push('missedGapSec 必须是 5–3600 的整数（秒），已用默认 60');
    }
  }

  const listenCfg = readListen(raw.listen);
  warnings.push(...listenCfg.warnings);

  const liftCfg = readLift(raw.lift);
  warnings.push(...liftCfg.warnings);

  const session = readBoundSession(raw, warnings);

  /**
   * 感官模式：`see_now({mode})` 选过之后会写回这里，所以重开 DSH 沿用上次那档。
   * 写错（比如把一次性的 `audio` 写进配置）就退回默认并记一条 warn。
   */
  const idleCaptureMin = clampInt(
    raw.idleCaptureMin, 0, 240, TUNING_DEFAULTS.idleCaptureMin,
  );
  if (raw.idleCaptureMin !== undefined && Number(raw.idleCaptureMin) !== idleCaptureMin) {
    warnings.push(`idleCaptureMin 必须是 0–240 的整数（分钟，0 = 关掉），已用默认 ${TUNING_DEFAULTS.idleCaptureMin}`);
  }

  let mode = TUNING_DEFAULTS.mode;
  if (raw.mode !== undefined) {
    if (raw.mode === 'both' || raw.mode === 'vision') mode = raw.mode;
    else {
      warnings.push('mode 只能是 "both"（视听都开）/ "vision"（只看）'
        + '；"audio"（只听）是一次性动作、不写配置，已用默认 both');
    }
  }

  // 只认真正的布尔：写成 `0` / `"false"` 是最容易踩的坑 —— `"false"` 是真值，
  // 用户以为关掉了，实际一直开着。所以类型不对就报出来并回默认。
  let scoreNormalize = TUNING_DEFAULTS.scoreNormalize;
  if (raw.scoreNormalize !== undefined) {
    if (typeof raw.scoreNormalize === 'boolean') scoreNormalize = raw.scoreNormalize;
    else warnings.push('scoreNormalize 只能是 true / false，已用默认 true');
  }

  return {
    maxAutonomousWakes,
    idleStopMin,
    idleStopMs: idleStopMin * 60 * 1000,
    defaultPace,
    speechPacing,
    missedGapSec,
    session,
    mode,
    idleCaptureMin,
    scoreNormalize,
    listen: listenCfg.listen,
    lift: liftCfg.lift,
    path,
    warnings,
  };
}
