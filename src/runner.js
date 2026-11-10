/**
 * runner.js — 常驻采集会话：start / watch / peek / stop。
 *
 * 和 pipeline.js 的分工：pipeline 只管「帧进、图出」，不碰进程；这里管**进程生命周期**
 * 和**取图语义**（阻塞到有图 / 立刻要 / 保持温热）。
 *
 * ## 三条刻意的设计
 *
 * ① **出图由采集侧自己攒、自己截**（pipeline 里做），`watch` 只是"取队列里那一张"。
 *    所以模型思考三秒不是延迟，只是让队列多一张。
 *
 * ② **停采集要留宽限期**。冷启动一次 400ms（屏幕）/ 1.7s（摄像头硬件唤醒），
 *    每次 watch 都停掉的话，连续看就是每次重付这笔钱。所以看完留 `graceSec` 秒，
 *    期间再来 watch 立刻就有帧；超时没人来才自己收工。
 *
 * ③ **取图永远走队列，不新建**。两张图同时在飞的时候，`take()` 给的是最早那张
 *    （时间顺序不能乱），新图挤掉旧图由 pipeline 的 queueDepth 负责。
 */

import { spawnFrames, pickScreenEngine, screenEngineWarning } from './capture.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPipeline } from './pipeline.js';
import { cellSize } from './layout.js';
import { chatWatcherShared, enterChatWait, markDelivered, markRelaySeen } from './chat.js';
import { noteInterjected } from './interject.js';
import { openWindow, pidStamp, windowAlive, setWindowHidden } from './window.js';
import { createListener } from './listen.js';
import {
  changedFraction, createLiftBuffer, LIFT_CAPTURE_FPS, LIFT_FPS, LIFT_HEIGHT, LIFT_KEEP_EVERY,
  LIFT_WIDTH, LIFT_WINDOW_SEC,
} from './lift-buffer.js';
import { frameFile, pruneOld } from './lift-log.js';
import { encodePng } from './png.js';

/**
 * 四档清晰度。数字是画布像素（**不含**底部音轨条），实际 token 见 src/tokens.js。
 *
 * **宽度全部向下对齐到 42**（800→798、1066→1050…）。原因和 storyboard 那边一样：
 * 800 会被 pad 到 812 = 19.3 格，白白多算一整列（20 列）；798 正好 19 列，
 * 面积只少 0.25%，token 每张省 11~24。这是整个插件里唯一**零代价**的降本点。
 *
 * **音轨条不额外收费**：条高取"这一档画面本来就没占满的那点行余量"
 * （450 高占 11 行、上界 462，白空 12px）—— 见 `sheet.js` 的 `stripHeight()`。
 * 所以这里写的 token 就是**带条之后**的实价。
 */
export const SIZES = Object.freeze({
  low: [798, 450],        // 222 token/张（12px 条）· 4 帧时每格 399×225 —— 看视频/场景够
  standard: [1050, 600],  // 392 token/张（30px 条）· 每格 525×300 —— 屏幕上的中号字能认
  high: [1260, 720],      // 560 token/张（36px 条）· 每格 630×360 —— 文件名/小字能认
  ultra: [1596, 900],     // 860 token/张（24px 条）· 单帧时几乎等于原屏 —— 真要读字才用
});
export const DEFAULT_QUALITY = 'low';

/**
 * 档位长边（`region` 模式用）。
 *
 * 为什么单独列一张表，而不是继续读 `SIZES[q][0]`：region 模式下 `width/height`
 * 的语义变成**单格**尺寸，只有长边才对应档位；`SIZES` 里的 798×450 是整张画布的
 * 尺寸（16:9），两者不能混用。
 *
 * **故意不跟着 42 对齐**：整屏模式对齐是因为画布一定被 pad 到 42 的整数倍；
 * region 的格子是 `cellSize()` 按区域比例算出来的（竖屏 9:16 → 800×450），
 * 本来就不是 42 的倍数，改了只会连带 2/4 帧拼图的尺寸，收益是个位数 token。
 */
export const LONG_EDGE = Object.freeze({
  low: 800, standard: 1066, high: 1280, ultra: 1600,
});

/**
 * 「逐帧 / 逐场景」模式的管线参数。
 *
 * - `maxFrames: 1` —— 留下 1 帧就立刻封箱（`checkFlush` 的 `frames.length >= maxFrames`），
 *   所以一张图永远只有一个画面。
 * - `strategy: 'single'` —— 档位固定压到 1，让这一帧**铺满整张画布**。
 *   不压的话，场景密集时密度档位会升到 2/3，一格只占 1/4、1/9，中间全是灰条。
 *
 * 这两个必须成对出现：只改 maxFrames 会得到"小格子 + 大片留白"，只改 strategy
 * 会得到"一张图里好几幅满幅图，装不下就被切开"。
 */
export const SCENE_OPTS = Object.freeze({ maxFrames: 1, strategy: 'single' });

/**
 * 三档节奏。**只影响"多久算一次画面变了"和"多久叫醒一次"**，不改出图口径。
 *
 * 为什么要有它：`cutAbs` 是全局常量，模型听见"省点钱"也只能嘴上答应 ——
 * 频率完全由插件定。用户实报"回复太密集"，说明缺一个能让这句话生效的旋钮。
 *
 * | 档 | cutAbs | 唤醒间隔 | 适合 |
 * |---|---|---|---|
 * | calm | 20 | 30s | 日常挂着看，只想知道"大场面变了没" |
 * | normal | 12 | 15s | 默认。滚网页/切窗口不会每下都留帧 |
 * | dense | 7 | 8s | 幻灯片、逐帧播报这种"每一刀都要"的 |
 * | game-economic | 80 | 20s | 全屏游戏 / 高速运动。靠 `pipeline` 把积分阈值也一起抬高 |
 *
 * 7 是能给的最低值（再低只有"只改亮度"那种肉眼都看不出的变化），
 * 但它对日常屏幕太敏感 —— 光标一停、窗口一换都能过线，所以不做默认。
 *
 * 80 看着离谱，其实是被内容逼的：动作游戏里每帧都有大位移，正常切点淹没在运动里。
 * 这一档同时把积分阈值从 144 抬到 1440（`integralSeconds` 3 → 30），
 * 否则"改画面"的门槛抬了、出帧密度却没降，还是会被叫到贴限速。
 */
export const PACES = Object.freeze({
  // 三档都带自适应兜底（`floorGapK`）：兜底间隔 = k × 近期出帧间隔，夹在 [floorMin, floorMax]。
  // 越省电的档兜底越长（calm k=3 / normal k=2 / dense k=1.2），因为省电档宁可漏也不要多。
  // normal 取 2 而不是 1.5：实测覆盖率 64.2→67.4（SHOT）/ 89.1→94.2（BBC），帧数只 +8~10%；
  // 1.5 能到 70.4 / 97.5，但 BBC 上每多 1 个点要花 83 帧（k=2 只要 47），是为最后几个点付溢价。
  // 想要全覆盖：给 normal 传 floorGapK: 1.5。
  // calm 刻意只抓大场面：关掉 6~20 分的弱切点，避免省电档反而变吵
  calm: { cutAbs: 20, wakeGapSec: 30, pipeline: { cutIsolatedAbs: 0, cutMcAbs: 0, floorGapK: 3, floorMin: 3, floorMax: 30 } },
  normal: { cutAbs: 12, wakeGapSec: 15, pipeline: { floorGapK: 2, floorMin: 2, floorMax: 20 } },
  dense: { cutAbs: 7, wakeGapSec: 8, pipeline: { floorGapK: 1.2, floorMin: 2, floorMax: 20 } },
  /**
   * 全屏动作游戏 / 高速运动画面（key 用 `game-economic`：目标就是"陪玩但别烧钱"）。
   *
   * 为什么需要单独一档：这类画面**每一帧都在动**，分数基线被抬高，切点门槛 12 等于"全是切点"，
   * 尖峰判据也救不回来（左右邻居同样高）。实测反馈（B 站用户「总在冬眠的熊」，打了一两个小时
   * 全屏动作游戏后自己调出来的值）：cutAbs 80、积分阈值约 1800、每张 6 帧、maxWait 120s，
   * 才从"顶着限速发请求 + 40 帧一张巨糊"变成"舒适"。
   *
   * 这里取比他**略保守**的一组（积分 1440 而不是 1800，每张 8 帧而不是 6），
   * 因为他的 40 帧/张是在 normal 档下被 maxWait 逼出来的，不是他真想要 6 帧。
   * `pipeline` 里的键会原样覆盖 `pipeline.js::DEFAULTS` 的同名项。
   */
  'game-economic': {
    cutAbs: 80,
    wakeGapSec: 20,
    pipeline: {
      integralSeconds: 30,
      maxFrames: 8,
      maxWaitSec: 60,
      silentFloorSec: 40,
      cutSpike: 1.5,
      cutSpikeAbs: 30,
      // 游戏画面每帧都在动：低分孤立 / 台阶 / mc 都会把运动误判成切点
      cutIsolatedAbs: 0,
      cutJumpAbs: 0,
      cutMcAbs: 0,
      floorGapK: 2,
      floorMin: 2,
      floorMax: 20,
    },
  },
});
export const DEFAULT_PACE = 'normal';

/** 参数签名：key 排序后拼串，`{a:1,b:2}` 与 `{b:2,a:1}` 视为同一个。 */
function optsSig(o) {
  return Object.keys(o ?? {}).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join('|');
}

/**
 * 采集源的**身份**：只算「换一根管道才有意义」的那几个字段。
 *
 * **故意不含 `engine`**：`start()` 会把探测出来的引擎写进 `lastSource`
 * （屏幕源是 `ddagrab`），而调用方传进来的 `{kind:'screen'}` 没有这个键 ——
 * 算进去就会变成"每次 watch 都以为换了源"，白白重启采集。
 * `region` 也不在这里：它有自己的比较（`regionChanged`），两条路不能混。
 */
function srcSig(s) {
  if (!s) return null;
  return [s.kind ?? '', s.path ?? '', s.url ?? '', s.device ?? '', s.realtime === true ? 'rt' : ''].join('|');
}

/**
 * 「这一条 watch 该不该被硬闸拦下」的**纯函数**（好测，也好读）。
 *
 * 三条规矩：
 * - 用户关过窗（`hungUp`）→ 除非他显式说了要看什么，否则不重开。
 * - 文件放完了（`fileEnded`）→ 同上，文件回放是一次性的，不能自动重播。
 * - 显式传了来源 = 用户明确要求 → 一律放行。
 */
/**
 * 挂断之后该不该因为"窗被重新打开"而解除。
 *
 * **不能只看 `windowAlive()`**：残留进程（用户关了但进程没死、或者测试机上本来就有窗口）
 * 同样让它为 true，那样就会把窗重新弹出来 —— 正是社区实报的"关掉又弹出来"。
 * 判据必须是"pid 文件在挂断之后被**重写过**"，那才代表有人主动开了窗。
 */
export function resumeFromReopen({ hungUp = false, winAlive = false, pidNow = 0, pidAtHangUp = 0 } = {}) {
  return Boolean(hungUp && winAlive && pidNow > pidAtHangUp);
}

export function guardReason({ hungUp = false, fileEnded = false, explicitSrc = false } = {}) {
  if (explicitSrc) return null;
  if (hungUp) return 'hung-up';
  if (fileEnded) return 'file-ended';
  return null;
}

export function createRunner({
  ffmpegPath = 'ffmpeg', log = () => {}, graceSec = 60, ctx = null,
  /** 「听声音」的延迟参数（`~/.dsh/see-now.json` 的 `listen` 段，见 tuning.js） */
  listen = null,
  /** `missed.jsonl` 的单图内部空窗阈值（秒，`see-now.json` 的 `missedGapSec`，默认 90） */
  missedGapSec = 90,
  /**
   * 起手用哪一档感官模式：`"both"`（默认，视听都开）/ `"vision"`（只看）。
   * 来自 `~/.dsh/see-now.json` 的 `mode`，所以重开 DSH 后沿用上次的选择 —— 见 `setMode()`。
   */
  mode = 'both',
  /**
   * 亮度归一 + 黑边补偿（`~/.dsh/see-now.json` 的 `scoreNormalize`，默认开）。
   *
   * **必须进 `createPipeline` 的 opts，不能只在这里拦** —— `scripts/sim.mjs` 走的是
   * 管线本身，开关停在 runner 层的话离线就没法做 A/B，标定做不了。
   * 调用方显式传 `opts.scoreNormalize` 时以调用方为准。
   */
  scoreNormalize = true,
  /**
   * 黑听抬头（`see-now.json` 的 `lift` 段）。这一棒只用 `enabled`：
   * 它决定「仅监听时要不要留底」；`level` / `holdSec` 留给四档闭环。
   */
  lift = null,
  /**
   * 采集函数（默认 `capture.js` 的 `spawnFrames`）。**只为测试**：留底那一路和 `start()`
   * 都从这里起，测试可以塞一个假采集，不必真的开屏 —— 否则每个生命周期用例都要跑 ffmpeg。
   */
  spawnCapture = spawnFrames,
} = {}) {
  let pipeline = null;   // 当前（或刚停的）引擎 —— 停采集后仍留着，好把队列里剩的图发完
  let running = false;
  let run = null;
  let source = null;
  let startedAt = 0;
  let frames = 0;
  let lastError = null;
  let stoppedAt = 0;
  let graceTimer = null;
  let busy = false;
  let quality = DEFAULT_QUALITY;

  /**
   * 听声音（视频里在说什么）。**可选能力**：装不上（没有 pyaudiowpatch、没有转写服务、
   * 这台机器没有回环设备）就只是没字幕，看图一切照旧 —— 绝不能让"看屏幕"起不来。
   *
   * 为什么在 runner 里而不是在工具层：它的生命周期和采集是同一个 ——
   * 开始看就开听，收工就停，中途换清晰度/换 region 也不用重启（音频跟画面无关）。
   */
  const listener = createListener({ ctx, log, listen });

  /* ------------------------------------------------------------ 黑听留底（P2-A） */
  /**
   * 「瞥」要有画面可给：仅监听时后台以 0.5 fps 采一路，只留最近 30 秒的缩略帧
   * （环形缓冲本身在 `lift-buffer.js`，这里只管采集进程的生死）。
   *
   * 三条边界，都不是随手定的：
   *
   * ① **不进 pipeline**：这些帧是给「按 t0 回取」用的，不是给模型看图用的 ——
   *    不拼图、不落盘、不花 token。喂给 pipeline 的话队列/出图/唤醒全会被它搅乱。
   * ② **与看画面互斥**：`start()` 一进来就停掉并清空（两路同时抓屏是白烧 CPU，而且
   *    上一场的帧留着只会让「瞥」拿旧画面冒充现在）。
   * ③ **起不来不嚎**：留底是可选能力，失败只记进 status 的 `lift.error`；听声音照旧。
   */
  const liftOn = lift?.enabled !== false;
  /** 环形缓冲实例：懒建（没进过仅监听就不占内存），停的时候 `clear` 而不销毁。 */
  let liftBuf = null;
  /** 留底那一路的采集句柄。null = 没在采。 */
  let liftRun = null;
  /** 这一次留底抓的是哪个源（重试要沿用，不能中途换地方）。 */
  let liftSrc = null;
  let liftError = null;
  let liftStartedAt = 0;
  /** 本次留底一共收到多少帧（含滑出窗口的）：`0 帧` 和 `15 帧` 是两种问题。 */
  let liftFrames = 0;
  /** 用户**想要**留底吗（进仅监听 = 要，开始看画面 / 收工 = 不要）。重试看它。 */
  let liftWanted = false;
  let liftStarting = false;
  let liftRetry = null;
  let liftRetries = 0;

  const liftBuffer = () => (liftBuf ??= createLiftBuffer({
    windowSec: LIFT_WINDOW_SEC, fps: LIFT_FPS, width: LIFT_WIDTH, height: LIFT_HEIGHT,
  }));

  /**
   * 留底抓什么。
   *
   * 屏幕源沿用上一次的 region（框过一块的人，瞥到的也该是那一块）；`obs` / `camera`
   * 就沿用那个设备。**文件源不沿用** —— 回放的文件不会因为黑听继续往前走，
   * 用户此刻在屏幕上看什么才是「那一刻的画面」。
   */
  function liftSource(regionArg) {
    const prev = lastSource ?? source;
    if (prev && (prev.kind === 'obs' || prev.kind === 'camera')) return { ...prev };
    const region = regionArg !== undefined
      ? regionArg
      : (prev?.kind === 'screen' ? prev.region ?? null : null);
    if (region) return { kind: 'screen', region: { ...region }, engine: 'gdigrab' };
    return { kind: 'screen' };
  }

  function scheduleLiftRetry(why) {
    if (!liftWanted || liftRetry) return;
    if (liftRetries >= 3) {
      log(`留底：${why}，重试 3 次仍不行 —— 先停着（重新进仅监听会再试）`);
      return;
    }
    liftRetries += 1;
    const wait = 3000 * liftRetries;
    liftRetry = setTimeout(() => {
      liftRetry = null;
      if (liftWanted) void startLiftCapture({ src: liftSrc });
    }, wait);
    liftRetry.unref?.();
    log(`留底：${why}，${wait / 1000}s 后重试（第 ${liftRetries} 次）`);
  }

  async function startLiftCapture({ region = undefined, src: fixedSrc = null } = {}) {
    if (!liftOn) return { enabled: false, ok: false, reason: 'disabled' };
    if (liftRun || liftStarting) return { enabled: true, ok: true, reason: 'already' };
    liftWanted = true;
    liftStarting = true;
    try {
      // 顺手清掉 3 天前的留底图谱（幂等、便宜；失败不影响采集）
      try { pruneOld(); } catch { /* 清不掉就下次 */ }
      const src = fixedSrc ?? liftSource(region);
      /**
       * **刻意不走 `pickScreenEngine()`**。
       *
       * 它给的是 ddagrab（桌面复制 API），而 ddagrab 是「桌面有变化才出帧」的路子：
       * 静止屏幕上 12 秒只给 1–2 帧（2026-11-10 实测）。留底要的是**固定节拍** ——
       * 没有帧进来，「那一刻还在不在」就会被误判成「没了」。gdigrab 在 2 fps 下实测
       * 0.50s 一帧，整屏和 region 都一样稳；顺带省掉一次 400ms 的探测 spawn。
       */
      const engine = process.platform === 'darwin' ? 'avfoundation' : 'gdigrab';
      if (!liftWanted) return { enabled: true, ok: false, reason: 'stopped' };
      const buf = liftBuffer();
      /**
       * 尺寸：整屏 800×450；**框过一块时按那块的比例算**（`cellSize`，和看画面时同一套），
       * 否则竖屏区域会被拉成 16:9 —— 「瞥」一眼看到的形状是错的，比糊更误导。
       */
      const [w, h] = src.region ? cellSize(LIFT_WIDTH, src.region) : [LIFT_WIDTH, LIFT_HEIGHT];
      const run = spawnCapture({
        source: src,
        width: w,
        height: h,
        fps: LIFT_CAPTURE_FPS,
        ffmpegPath,
        engine,
        onFrame: (f) => {
          /**
           * 抽稀：2 fps 采集 → 0.5 fps 留底。**按帧号取模，不按时间** ——
           * 丢一两帧不会让相位漂；`i` 缺失（测试里的假采集）时全留。
           */
          const idx = Number.isFinite(f?.i) ? f.i : 0;
          if (idx % LIFT_KEEP_EVERY !== 0) return;
          liftFrames += 1;
          try {
            /**
             * 帧时间是**收到这一帧的墙上时间**（epoch ms）—— 和 ASR 的 `t0/t1` 同一个时钟。
             * 别改成 `i / fps`：那会假设 ffmpeg 严格按 2 秒节拍吐帧，实测 ddagrab
             * 在显示器休眠/全屏切换后会有几百毫秒的漂移，按它算反而对不上台词。
             */
            buf.push({ buf: f.buf, width: w, height: h, at: Date.now(), i: f.i ?? null });
          } catch (e) {
            // 一帧坏了不能让整条留底停摆（与 `start()` 里 push 兜底同一个口径）
            liftError = `留底：收帧失败（${e?.message ?? e}）`;
          }
        },
        onStderr: (s) => { if (process.env.DSH_SEE_NOW_DEBUG) log(String(s).trim()); },
      });
      liftRun = run;
      liftSrc = src;
      liftStartedAt = Date.now();
      liftError = null;
      liftRetries = 0;
      const where = src.region ? `region ${src.region.w}×${src.region.h}` : '整屏';
      log(`留底：开始（${w}×${h}，采 ${LIFT_CAPTURE_FPS}fps → 留 ${LIFT_FPS}fps，${where}）`);
      run.done.then((r) => {
        if (liftRun !== run) return;             // 我们自己停的，不是故障
        liftRun = null;
        if (r?.frames) log(`留底：ffmpeg 退出（${r.frames} 帧 / ${Math.round(r.ms / 1000)}s）`);
        scheduleLiftRetry('ffmpeg 退出');
      }).catch((e) => {
        if (liftRun !== run) return;
        liftRun = null;
        liftError = `留底采集：${e?.message ?? e}`;
        log(liftError);
        scheduleLiftRetry('采集失败');
      });
      return { enabled: true, ok: true, engine, source: src };
    } finally {
      liftStarting = false;
    }
  }

  /**
   * 停留底。
   *
   * `clear` 由调用方按语义给：**开始看画面 / 收工要清**（那些帧是上一场的，留着会冒充
   * 现在）；采集自己挂了不算 —— 那时旧帧还在时间窗里，`pickAt` 会照实说「太旧」。
   */
  function stopLiftCapture({ clear = false, why = '' } = {}) {
    const was = Boolean(liftRun);
    liftWanted = false;
    if (liftRetry) { clearTimeout(liftRetry); liftRetry = null; }
    const run = liftRun;
    liftRun = null;
    run?.stop();
    liftFrames = 0;
    liftStartedAt = 0;
    if (clear && liftBuf) liftBuf.clear();
    if (was && why) log(`留底：停（${why}）`);
    return { ok: true };
  }

  /**
   * 「瞥」的那一帧 → PNG 落盘（P2-B）。
   *
   * 为什么落盘：窗里要「点开能看那一帧」，而环形缓冲 30 秒后就滑走了 ——
   * 不落盘就等于没有。落在 `$DSH_HOME/see-now/lift/<日期>/<帧时间戳>.png`，
   * 文件名用帧自己的时间戳（同一帧不会写两遍），3 天后由 `pruneOld` 清掉。
   *
   * 这是**缓冲不落盘**之外的另一件事：缓冲是 16 MB 内存里的滚动窗口，这是用户要看的那一张。
   *
   * @param {number} t0 epoch ms（台词 `t0`）
   * @returns {{ok:true, path:string, at:number, deltaMs:number, size:[number,number]}
   *          |{ok:false, reason:string}}
   */
  function framePng(t0, opts) {
    if (!liftOn) return { ok: false, reason: 'disabled' };
    const got = liftBuffer().pickAt(t0, opts);
    if (!got.ok) return got;
    const { frame } = got;
    try {
      const path = frameFile(frame.at);
      mkdirSync(dirname(path), { recursive: true });
      // level 3：800×450 的截图压到 3 档大约 40–70 KB，比 6 档快一倍、体积只大一点
      writeFileSync(path, encodePng(frame.buf, frame.width, frame.height, { level: 3 }));
      return { ok: true, path, at: frame.at, deltaMs: got.deltaMs, size: [frame.width, frame.height] };
    } catch (e) {
      return { ok: false, reason: 'write-failed', error: String(e?.message ?? e) };
    }
  }

  /**
   * 「画面动没动」：拿缓冲里**最后两帧**比像素（P2-B 的 `holdSec` 回落要用）。
   *
   * 为什么不能拿「没新台词」判：纯音乐、默片、暂停后字幕跳变 —— 静音时画面照样在动，
   * 那种情况回落就是错的。反过来，两帧全等才是真的"没什么可看的了"。
   *
   * @param {{stride?:number, maxChangedFrac?:number}} [o]
   * @returns {{ok:true, still:boolean, changedFrac:number, at:number, prevAt:number, gapSec:number}
   *          |{ok:false, reason:string}}
   */
  function still({ stride = 97, maxChangedFrac = 0.005 } = {}) {
    if (!liftOn) return { ok: false, reason: 'disabled' };
    const [prev, last] = liftBuffer().recent(2);
    if (!prev || !last) return { ok: false, reason: 'too-few-frames' };
    if (prev.width !== last.width || prev.height !== last.height) {
      return { ok: false, reason: 'size-changed' };
    }
    const frac = changedFraction(prev.buf, last.buf, { stride });
    return {
      ok: true,
      still: frac <= maxChangedFrac,
      changedFrac: Math.round(frac * 10000) / 10000,
      at: last.at,
      prevAt: prev.at,
      gapSec: Math.round((last.at - prev.at) / 1000),
    };
  }

  /** status 用的账本。没开留底时只给 `enabled:false`，不去建缓冲实例。 */
  function liftStatus() {    if (!liftOn) return { enabled: false, capturing: false };
    const st = liftBuffer().stats();
    return {
      enabled: true,
      level: lift?.level ?? 'glance',
      capturing: Boolean(liftRun),
      /** 留底那一路 ffmpeg 的 pid（测量 CPU、确认进程收干净都要它） */
      pid: liftRun?.pid ?? null,
      frames: st.frames,
      mb: st.mb,
      bytes: st.bytes,
      spanSec: st.spanSec,
      ageSec: st.ageSec,
      stale: st.stale,
      fps: LIFT_FPS,
      windowSec: LIFT_WINDOW_SEC,
      // 实际尺寸（region 模式下不是 800×450，见 lift-buffer 的 stats）
      size: [st.width, st.height],
      framesSeen: liftFrames,
      sinceSec: liftStartedAt ? Math.round((Date.now() - liftStartedAt) / 1000) : 0,
      error: liftError,
    };
  }

  /**
   * 上一张图的时间窗末尾（epoch ms）。台词按"上一张到现在"取，
   * 不能按这一张自己的 from/to —— 静止屏幕上两张之间隔 60 秒，中间说的话会整段漏掉。
   */
  let lastSheetWallTo = 0;

  /**
   * 把这段时间窗里的台词和「声音」挂到 sheet 上。
   *
   * 两条都**没有就不加** —— 模型看到空的「台词：」「声音：」标题只会以为转写坏了，然后去猜。
   *
   * 声音用的是同一个时间窗：分开算的话两段会漂几百毫秒，模型对不上"这句配那段声音"。
   */
  function attachLines(sheet) {
    if (!sheet) return sheet;
    const to = sheet.wallTo ?? Date.now();
    /**
     * 第一张图是"此刻"（往往只有 1 帧），时间窗只有一个点 —— 直接照它取，
     * 用户第一眼永远看不到任何台词（那句话还没说完/还没转写）。
     * 所以首次往回多看 20 秒：反正缓冲里本来就只有这么久的东西。
     */
    const from = lastSheetWallTo || Math.min(sheet.wallFrom ?? to, to - 20_000);
    const got = listener.between(from - 400, to + 800);
    // 声音（A 层的产物）：纯音乐/无台词的时候，这是唯一能说明"刚才发生了什么"的东西
    const snd = listener.acousticBetween(from, to + 800);
    if (snd) sheet.sound = snd;
    if (to > lastSheetWallTo) lastSheetWallTo = to;
    if (got.length) sheet.lines = got;
    return sheet;
  }
  /**
   * 建当前管线时用的**调用方参数**（不含 oneShot）。
   *
   * 为什么需要：分辨率换了可以看 `quality`，但"逐帧模式"换的是管线参数
   * （`maxFrames` / `strategy`）—— 那些是建管线时定死的，运行中改不了。
   * 于是 watch 每次比一下签名，变了就重开：`{}` 和 `{maxFrames:1,strategy:'single'}`
   * 是两套完全不同的出图口径，不能在同一根管线上混着跑。
   */
  let runOpts = {};
  // 共享一个 watcher：每做一个新的会重新 prime（只记位置不读旧消息），
  // 那模型思考期间用户说的话就永远看不见了。
  const chatPoll = chatWatcherShared();
  let windowState = null;
  let windowPending = null;
  /**
   * 这一次会话里**窗真的开起来过**没有。
   *
   * 循环靠它区分两件完全不同的事：
   *   - 窗开过、现在没了 → **用户关掉了**，该停下来（那是"我不看了"）
   *   - 窗从来没开起来（没有带 tkinter 的 python）→ 不该当成用户关窗，继续看
   * 没有这个标记的话，第一种情况永远检不出、第二种情况会误判成挂断。
   */
  let windowOpened = false;

  /**
   * 待领的说明（挂断那一条）。
   *
   * **为什么不写进 chat.jsonl**：窗被关掉之后，写进那条流的字没有任何人会看到；
   * 模型也拿不到，于是它继续调 `watch` —— 实测会连写两条挂断说明（相隔 96ms），
   * 模型却在说"我还在看"。
   *
   * 正确的路子和陪看一样：落在这里，下一次工具结果把它带走。
   */
  let pendingNote = null;
  /**
   * 用户"关窗挂断"过没有。
   *
   * 关窗之后再被叫醒一次，`watch` 会**重新把窗开起来**、把采集重启 ——
   * 用户看到的是"关不掉，只能卸载插件"（社区实报）。所以这里是个硬闸：
   * 挂断之后只有**显式指定来源**（用户说了要看什么）才允许重新开始。
   */
  let hungUp = false;
  /** 挂断时 pid 文件的 mtime；用来识别"用户又手动把窗开回来了" */
  let hungUpStamp = 0;
  /** 最近一次的采集源（teardown 会把 `source` 清空，但事后判断还需要它） */
  let lastSource = null;
  /**
   * 已经放完的文件源。**文件回放是一次性的**：放完就结束，不能自动重播。
   *
   * 以前 `watch` 会在 `stopped` 时用 `prevSrc` 自动重启，而文件源重启就是
   * "从头再放一遍"，于是 24 秒解 1955 帧、出一堆图、把模型反复叫醒，
   * 关窗也停不下来（社区实报的那条）。
   */
  let endedSource = null;

  function teardown(why) {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    run?.stop();
    run = null;
    running = false;
    source = null;
    stoppedAt = Date.now();
    // 留底跟着收工：`stop` 之后「取那一刻」不该再拿到上一场的帧（验收第 5 条）
    stopLiftCapture({ clear: true });
    // 采集收工，声音也一起停：一个抓回环的进程常驻在后台，用户是看不见的
    listener.stop('采集收工');
    if (why) log(`收工：${why}`);
  }

  /** 停采集，但留一个宽限期 —— 这期间再来 watch 不用重新热启动 */
  function armGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    if (graceSec <= 0) { teardown('grace=0'); return; }
    graceTimer = setTimeout(() => teardown(`${graceSec}s 没人来`), graceSec * 1000);
    graceTimer.unref?.();
  }

  /**
   * 续命（常驻循环每拍调一次）。
   *
   * **不加这个，循环会被宽限期饿死**：一次 `watch` 结束后留 60 秒宽限，时间一到采集收工，
   * 而静止屏幕上 60 秒内又不会出新图 —— 循环下一拍看到 `!running && !pending`，
   * 就判定"采集自己停了"并自杀。用户安安静静看文档时，这个"常驻循环"最多活 60 秒。
   *
   * 只续"还在跑"的采集：ffmpeg 真死了不能靠它诈尸。
   */
  function touch() {
    if (!running) return false;
    armGrace();
    return true;
  }

  /**
   * 感官模式（**记忆态**，只活在这个进程里）：`both` = 视听都开，`vision` = 只看。
   *
   * 2026-11-09：以前 `start()` 一定把声学侧车拉起来，于是状态行只可能绿（视觉 + 听觉）
   * 或灰，橙色那档永远亮不起来。现在三种模式各有入口
   * （`see_now({mode:"both" | "vision" | "audio"})`），这里只记住前两档 —— 它们决定
   * 「开始看的时候要不要顺带起耳朵」；`audio`（只听）是**动作**，走 `action:"listen"`
   * 那条路（进来会 `setMode('both')`，因为耳朵已经开了）。
   *
   * 初值来自 `~/.dsh/see-now.json` 的 `mode`，所以重开 DSH 后沿用上次的选择。
   */
  let modeWanted = mode === 'vision' ? 'vision' : 'both';

  /**
   * 「最后一次有人要用图」的时刻 / 正在等图的数量（2026-11-09 空闲自动收工用，见 idle.js）。
   *
   * 只由 `start` / `watch` / `peek` 刷新 —— `status` 不算：模型每轮 ping 一下状态
   * 不等于在用它看到的画面，拿它续命会让"空转"变成永远。
   */
  let lastUseAt = Date.now();
  let watchUntil = 0;
  const noteUse = () => { lastUseAt = Date.now(); };

  /** 切模式并把耳朵的状态同步过去（`see_now({mode})` 与 `start({audio})` 都走这里）。 */
  function setMode(next) {
    modeWanted = next === 'vision' ? 'vision' : 'both';
    applyAudioMode();
    return modeWanted;
  }

  /**
   * 按当前模式起/停耳朵。起是**不等**的（等它会把"开始看"顶慢 1~4 秒）。
   *
   * **失败要重试**：切档（视觉 → 听觉）时上一只 `listen.py` 刚被 kill，WASAPI 回环
   * 还没被系统放掉，新进程立刻开设备会失败（2026-11-09 实测：`mode:"audio"` 报
   * 「回环设备没打开」，收工再起就正常）。所以失败后隔 0.6s / 1.2s 再试两次，
   * 中途切回 vision 就停手。
   */
  function applyAudioMode(attempt = 0) {
    if (modeWanted === 'vision') {
      if (listener.state().enabled) listener.stop('只要视觉，关掉耳朵');
      return;
    }
    listener.start()
      .then((r) => {
        if (r?.ok) return;
        if (attempt < 2 && modeWanted !== 'vision') {
          const wait = 600 * (attempt + 1);
          log(`听声音没开（${r?.reason ?? '未知'}），${wait}ms 后重试`);
          const t = setTimeout(() => {
            if (modeWanted !== 'vision') applyAudioMode(attempt + 1);
          }, wait);
          t.unref?.();
          return;
        }
        log(`听声音没开：${r?.reason ?? '未知'}`);
      })
      .catch((e) => log(`听声音没开：${e?.message ?? e}`));
  }

  async function start({ src = { kind: 'screen' }, opts = {}, quality: q = null, audio = null } = {}) {
    noteUse();
    if (audio === true || audio === false) modeWanted = audio ? 'both' : 'vision';
    if (running) {
      // 已经在看时改主意也要立刻生效：以前这里直接 return，`audio:false` 得先 stop 再看一次
      applyAudioMode();
      return { already: true, source, audio: modeWanted === 'both', mode: modeWanted };
    }
    // 走到这里就是"明确要开始看"（watch 的自动重启已经在前面被硬闸挡住了）。
    hungUp = false;
    endedSource = null;
    /**
     * 开始看画面 = 留底那一路必须停。
     *
     * 两个理由：① 两路同时抓屏是白烧 CPU（这棒的原则是黑听才付这笔钱）；
     * ② 那 15 帧是上一场「只听」时的画面，留着只会让「瞥」拿旧画面冒充现在。
     * **放在 running 的早退之后**：已经在看时再调 start 不该把别人的缓冲清掉。
     */
    stopLiftCapture({ clear: true, why: '开始看画面' });
    // **窗被用户关掉之后，这里必须复位**：`windowState` 缓存着 `{ok:true}`，
    // `windowOpened` 也还是 true —— 不复位的话下一次 watch 会（a）不再开窗，
    // （b）循环立刻又把"窗没了"判成用户关窗，落第二条挂断说明。
    if (!windowAlive()) { windowState = null; windowOpened = false; }
    let engine = src.engine ?? 'auto';
    if (src.kind === 'screen' && engine === 'auto') engine = await pickScreenEngine({ ffmpegPath });
    const size = SIZES[q] ?? SIZES[DEFAULT_QUALITY];
    /**
     * region 模式：`width/height` 是**单格**尺寸（长边 = 档位长边），不是画布。
     *
     * 采集侧按单格抓、出图时再按实际帧数拼（2 帧 2×1 / 4 帧 2×2）——
     * 这样 2 帧不会浪费半张画布；而且 ffmpeg 的 `scale=w:h` 与 region 同比例，
     * 属于等比缩放，不变形。
     */
    const longEdge = LONG_EDGE[q] ?? LONG_EDGE[DEFAULT_QUALITY];
    const [w, h] = src.region ? cellSize(longEdge, src.region) : size;
    const regionOpts = src.region ? {
      region: src.region,
      // 硬上限 4（6 帧要 3×2 或 6×1，后者长宽比 3.4 —— 今天实测糊掉的就是它）；
      // 期望 2（竖屏 2 帧并排 = 1.125，最接近 1:1）。
      // 逐帧模式（`maxFrames: 1`）下两个都收敛到 1，保持「一张图一个画面」。
      // **上限钉死 4**：0.0.8 的 action 档会往 opts 里塞 `maxFrames: 8`，region 不能
      // 继承它 —— 上限只该由 region 自己说，不能靠 preferFrames 去掩盖。
      maxFrames: Math.min(4, Math.max(1, Number(opts.maxFrames) || 4)),
      preferFrames: Math.min(Math.max(1, Number(opts.maxFrames) || 4), 2),
      /**
       * **region 不出音轨条**。那里的画布是"一小块窗口"（竖屏 9:16 时 800×450、
       * 更窄的可能只有 200 宽），按宽度比例算的条会吃掉 10% 以上的画面，
       * 而 region 的用途是"把这块看清楚"，不是看视频节奏。
       */
      audioStrip: false,
    } : {};
    // oneShot 由调用方（watch）决定：**只有换清晰度**时置 true（缓冲区刚扔，等攒满等于白等一个窗口）
    const p = createPipeline({
      ...opts, width: w, height: h, ...regionOpts,
      // 音量条：直接问听声音那条链要 —— 那边已经在算 RMS 了（断句要用），
      // 这里只是把它按时间窗取出来画成柱子，**不额外解码一次音频**。
      audio: { levels: (a, b) => listener.levelsBetween(a, b) },
      scoreNormalize: opts.scoreNormalize ?? scoreNormalize,
    });
    // 记下"这次建管线用的调用方参数"（不含 oneShot）——watch 靠它发现"模式变了"。
    runOpts = { ...opts };
    delete runOpts.oneShot;
    const s = { ...src, engine };
    quality = q ?? DEFAULT_QUALITY;
    frames = 0;
    lastError = null;
    pipeline = p;
    running = true;
    source = s;
    lastSource = s;
    startedAt = Date.now();
    run = spawnCapture({
      source: s,
      width: p.constants.width,
      height: p.constants.height,
      fps: p.constants.fps,
      ffmpegPath,
      engine,
      onFrame: (f) => {
        frames += 1;
        // 一帧解码就抛 = 整条管线停摆，这里必须兜住：宁可少一帧，不能让采集线程炸掉
        try { p.push(f); } catch (e) { lastError = `push: ${e?.message ?? e}`; }
      },
      onStderr: (s2) => { if (process.env.DSH_SEE_NOW_DEBUG) log(s2.trim()); },
    });
    run.done.then((r) => {
      if (pipeline === p) {
        // **文件正常放完（`ended`）不是错误** —— 别写进 lastError，status 里会显示成故障
        if (!r?.ended) lastError ??= `ffmpeg 退出（${r.frames} 帧 / ${Math.round(r.ms / 1000)}s）`;
        // 文件源放完 = 这一次看完了。记下来，别让下一条 watch 又从头放一遍。
        if (s.kind === 'file') endedSource = s;
        teardown('ffmpeg-exit');
      }
    }).catch((e) => {
      lastError = `ffmpeg: ${e?.message ?? e}`;
      if (pipeline === p) teardown('ffmpeg-error');
    });
    log(`开始看 ${s.kind}${engine && engine !== 'auto' ? `/${engine}` : ''} @${w}×${h}${s.region ? ` region=${s.region.x},${s.region.y},${s.region.w},${s.region.h}` : ''}`);
    /**
     * 声音并行起，**不 await**：它要等 Python 起来 + 打开回环设备（1~4 秒），
     * 挡在前面会让"开始看"从 0.4 秒变成一个明显能感觉到的卡顿。
     * 起不来只是没字幕 —— 记一条日志，看画面照旧。
     * `audio:false`（单开视觉）时这里反过来：已经在听的耳朵要停掉，见 `applyAudioMode()`。
     */
    applyAudioMode();
    // macOS 没给屏幕录制权限时，采集本身是"成功"的，只是画面全黑 ——
    // 探针已经试出来了，这里把它带回去，让模型（和用户）知道该去系统设置，而不是以为插件坏了。
    const warning = s.kind === 'screen' ? screenEngineWarning() : null;
    if (warning) log(`⚠️ ${warning}`);
    return { started: true, source: s, engine, quality, params: p.constants, warning,
             audio: modeWanted === 'both', mode: modeWanted };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 把悬浮窗支起来（幂等）。**只在真要阻塞的时候调** —— 没在等就没必要弹窗。
   * 开不起来不算失败：模型照样能 watch，只是用户只能等下一轮。
   *
   * 注意是 await：要真跑一次 `import tkinter` 验解释器、再等 700ms 看它有没有退出，
   * 不然会拿到一个"成功"但其实早就退了的窗（pid 指向死进程）。
   */
  async function ensureWindow() {
    if (windowState?.ok) return windowState;
    if (windowPending) return windowPending;
    windowPending = openWindow({ log }).then((st) => {
      windowState = st;
      if (st.ok) {
        windowOpened = true;
        log(st.already ? '悬浮窗已开着' : `悬浮窗已开（${st.from}）`);
        /**
         * **自己开出来的窗必须是看得见的。**
         *
         * `hidden` 是磁盘上的粘性状态：用户上一次点了「藏起来」，这个窗就会带着
         * `hidden:true` 启动 —— 进程活着、心跳在跳、画面一个字都不出（2026-11-03 实报）。
         * 只在这一刻清掉它（`already` 说明窗是原来那个，用户可能正故意藏着，不动）。
         */
        if (!st.already) setWindowHidden(false, { log });
      } else {
        log(`悬浮窗没开起来：${st.reason}`);
      }
      return st;
    }).finally(() => { windowPending = null; });
    return windowPending;
  }

  /**
   * **只停画面，留着耳朵**（仅监听模式）。
   *
   * 和 `stop()` 的唯一区别：不调 `listener.stop()`。眼睛一关、耳朵还在，
   * 模型才有东西可判断「这段值不值得看」——这是"黑听 → 抬头"那套的前提。
   */
  function stopVision(why = '仅监听') {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    run?.stop();
    run = null;
    running = false;
    source = null;
    stoppedAt = Date.now();
    log(`停画面（${why}），耳朵还开着`);
    return { ok: true, running, listening: listener.state().enabled };
  }

  /**
   * 只起耳朵、不抓画面。幂等：已经在听就返回 `already`。
   *
   * **顺便把留底那一路拉起来**（`lift.enabled` 关着时跳过）：黑听要有「那一刻的画面」
   * 可给，靠的就是它。留底只在耳朵真起来了之后才起 —— 没耳朵就没有触发，
   * 采一路画面纯属白烧 CPU。
   *
   * @param {{region?:{x:number,y:number,w:number,h:number}|null, audio?:boolean}} [o]
   *   `region` 只在**这一场没看过画面**（没有 `lastSource`）时才用得上：框过一块的人，
   *   瞥到的也该是那一块。`audio:false` 只给测试和测量用（不拉 ASR 进程）。
   */
  async function listenOnly({ region = undefined, audio = true } = {}) {
    // 用户明确要耳朵了：把「只看」那个记忆态改回来，否则之后 watch 还是没声
    if (audio) modeWanted = 'both';
    const r = audio ? await listener.start() : { ok: true, enabled: false, skipped: true };
    if (audio && !r?.ok) log(`听声音没开：${r.reason}`);
    const lifted = r?.ok
      ? await startLiftCapture({ region })
      : { enabled: liftOn, ok: false, reason: 'no-audio' };
    return { ...r, lift: lifted };
  }

  /** 上一张记进 `missed.jsonl` 的结束时间（秒，从采集起点算）；空档标记用 */
  let lastMissedTo = null;

  /**
   * 任务模式下的「错过了什么」：每出一张图记一行，**不消费队列、不叫醒模型**。
   *
   * 为什么需要：任务模式名义上"一直盯着"，但队列只留一张、出图序号不变时门控也不叫，
   * 真走开十分钟，中间的过程全被顶掉（2026-11-08 实测：44 秒里 3 张图、0 次叫醒，
   * 回来只能看到最后一张）。
   *
   * 记录在 `~/.dsh/see-now/missed.jsonl`，一行一张图：时间、帧数、为什么出图、
   * 这段时间的台词、声音摘要；**两张之间没有图的区间再记一行 `kind:"gap"`**
   * （只有起止秒数，不花 token）——读的人不用自己算"哪里漏了"。
   * 用户回来说一声，模型读它汇总 —— 全程 0 token。
   */
  function noteMissed() {
    try {
      const s = pipeline?.peek?.() ?? null;
      if (!s) return null;
      attachLines(s);      // 把台词和声音挂上（只读不消费）
      const from = Number.isFinite(s.from) ? +s.from.toFixed(1) : null;
      const to = Number.isFinite(s.to) ? +s.to.toFixed(1) : null;
      const recs = [];
      const clock = () => new Date().toTimeString().slice(0, 8);
      const pushGap = (a, b, minSec = 3) => {
        if (!Number.isFinite(a) || !Number.isFinite(b) || b - a <= minSec) return;
        recs.push({
          at: Date.now(), clock: clock(), kind: 'gap',
          from: +a.toFixed(1), to: +b.toFixed(1), sec: +(b - a).toFixed(1),
        });
      };
      /**
       * 帧时间戳：**一张图里也可能夹着空窗** —— 静止画面里前后两个 keep 可以隔半分钟，
       * 拼出来的一张图时间跨度就到分钟级（2026-11-08 长跑实测：一张图跨 347 秒）。
       * 只比「上一张的 to ↔ 这一张的 from」会把这种内部空窗整段吞掉，所以按帧逐个过。
       *
       * **但帧间距不等于空窗**：正常节拍就是一张 2 帧、两帧隔 20 秒（2026-11-08 复验，
       * 每张 20–40 秒），拿 3 秒去判会把每张自己的间距也写成空档。内部空窗只在
       * 明显超过正常节拍时才算；阈值走 `missedGapSec`（默认 90 ≈ 四个正常间隔，
       * dense 档切得密可以调小）。
       */
      const ts = (s.frames ?? []).map((f) => Number(f?.t)).filter(Number.isFinite);
      // 空档标记：上一张结束 → 这一张第一帧。3 秒以内的不算，免得噪声。
      if (lastMissedTo !== null) pushGap(lastMissedTo, ts.length ? ts[0] : from);
      for (let i = 1; i < ts.length; i += 1) pushGap(ts[i - 1], ts[i], missedGapSec);
      recs.push({
        at: Date.now(),
        clock: new Date().toTimeString().slice(0, 8),
        frames: s.frames?.length ?? 0,
        why: s.why ?? null,
        from,
        to,
        lines: (s.lines ?? []).map((l) => l.text).slice(-12),
        sound: s.sound ?? null,
      });
      if (to !== null) lastMissedTo = Math.max(lastMissedTo ?? -Infinity, to);
      mkdirSync(join(homedir(), '.dsh', 'see-now'), { recursive: true });
      appendFileSync(join(homedir(), '.dsh', 'see-now', 'missed.jsonl'),
        recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      return recs[recs.length - 1];
    } catch { return null; }
  }

  /** 接下一个新任务时清空上一轮记录。 */
  function clearMissed() {
    lastMissedTo = null;
    try {
      mkdirSync(join(homedir(), '.dsh', 'see-now'), { recursive: true });
      writeFileSync(join(homedir(), '.dsh', 'see-now', 'missed.jsonl'), '', 'utf8');
    } catch { /* 写不了就算了 */ }
  }

  return {
    start,
    stopVision,
    listenOnly,
    setMode,
    mode: () => modeWanted,
    noteMissed,
    clearMissed,
    /** 最近一段的声学轨迹（仅监听的唤醒文案用） */
    trajectory: (a, b) => listener.trajectoryBetween(a, b),
    /**
     * 最近一段的台词（仅监听的抬头触发用）。
     *
     * **只读**：`between` 不消费缓冲，和出图时 `attachLines` 读的是同一份数据。
     * 给 4000 字上限是为了 ASR 积压时别从新往旧丢 —— 一拍只有 2 秒的台词，
     * 正常远到不了；真到 4000 字说明已经堵了，那时丢谁都是丢。
     */
    recentLines: (a, b) => listener.between(a, b, { maxChars: 4000 }),
    /**
     * 「`t0` 那一刻」的帧（P2-A 只做内部接口，四档闭环来调）。
     *
     * 返回 `{ok:true, frame, deltaMs}` 或
     * `{ok:false, reason:'disabled'|'empty'|'too-old'|'too-new'|'far'}`。
     * **`ok:false` 时调用方不许拿当前帧顶上** —— 机制文档「风险」第一条：
     * 只报文字 + 说明「那一刻的画面没了」，比给一张假的强。
     *
     * @param {number} t0 epoch ms（ASR 的 `line.t0`）
     * @param {{maxDeltaMs?:number}} [opts] 不传就用缓冲的默认容差（1.5 秒）
     */
    frameAt(t0, opts) {
      if (!liftOn) return { ok: false, reason: 'disabled' };
      return liftBuffer().pickAt(t0, opts);
    },
    /**
     * 「瞥」那一帧 → PNG 落盘（P2-B）。返回 `{ok, path, at, deltaMs, size}`；
     * `ok:false` 的 reason 与 `frameAt` 同一套（`too-old` / `too-new` / …）。
     */
    framePng,
    /**
     * 「画面动没动」（P2-B 的 `holdSec` 回落用）。拿缓冲里最后两帧比像素；
     * 帧不够（刚进仅监听）时 `ok:false`，**调用方按"判不了"处理，别当成静**。
     */
    still,
    /** 留底账本（status 已经带了，这里给脚本/测试一个直读口） */
    lift: () => liftStatus(),
    stop() { teardown('手动'); return { stopped: true }; },
    /**
     * 用户关掉了悬浮窗 = 明确表示"不看了"。
     *
     * 只 `stop()` 不够：下一条 `watch` 看到 `stopped` 会立刻重启采集并把窗**重新开起来**，
     * 用户体感就是"关掉又弹出来，除非卸载插件"（社区实报）。这里立一个硬闸，
     * 直到有人显式指定来源为止。
     */
    hangUp() {
      hungUp = true;
      // 记下挂断那一刻的 pid 文件时间：之后只有它变了才说明窗被**重开过**
      // （见 start() 里的解除逻辑）。
      hungUpStamp = pidStamp();
      teardown('用户关窗');
      return { hungUp: true };
    },
    /** 挂断状态（测试和状态页用） */
    isHungUp() { return hungUp; },
    /** 有没有一个"已经放完、不能自动重播"的文件源 */
    endedFile() { return endedSource ? { ...endedSource } : null; },
    /** 这一轮开过窗没有（循环判"用户关窗"用） */
    windowWasOpen() { return windowOpened; },

    /**
     * 阻塞等一张图。
     *
     * `quality` 换了就**重启采集**（分辨率是采集侧定死的，改不了）：
     * 分辨率在采集那一层就定死了，所以换清晰度 = 换一根管道。重启一次 ~400ms，
     * 但换完只发一帧就把"现在是什么"给出去，不用再等攒满一张。
     *
     * @param {{seconds?:number, minFrames?:number, src?:object, quality?:string, opts?:object,
     *          signal?:AbortSignal|null, eagerMs?:number}} o
     * @returns {Promise<{ok:boolean, reason?:string, sheet?:object, waited:number}>}
     */
    async watch({
      seconds = 300, minFrames = 1, src: reqSrc = null, quality: q = null, opts = {},
      /**
       * 耳朵要不要开：`null` = 按记忆态（上次 `start` 选的），`false` = 单开视觉。
       * 冷启动、换源、换清晰度重开采集时都带着它走下去，别让"重开一次"把耳朵偷偷拉起来。
       */
      audio = null,
      /**
       * 只看屏幕上的某一块：`{x,y,w,h}` 用这块，`null` 显式取消，`undefined` 不干预。
       *
       * **跟 `src` 分开传**：region 不算"显式来源"。下面那道挂断硬闸是给
       * "用户关掉了窗，别再自动弹出来"用的 —— 换一块看并不等于他重新要求看，
       * 不能借这个由头把闸打开（那条路最后就是"关不掉，只能卸载"）。
       */
      region = undefined,
      // 宿主给的取消信号。**必须在这里看**：不看的话用户按了停止，这个调用还要挂到封顶
      // （陪看那边专门写过这条：`signal` 是"这一轮被取消了"的唯一通知）。
      signal = null,
      // 冷启动时"先给此刻"的宽限：等第一帧最多这么久，等到就立刻出图。
      eagerMs = 3000,
    } = {}) {
      // 有人正等着图：这段时间不能被空闲收工掐掉（见 idle.js）。
      // 用时间戳而不是计数器 —— `watch` 是返回对象里的方法，没有 finally 可挂；
      // 时间戳会自己过期（按这次最多等多久算），提前 return 也不会漏。
      noteUse();
      watchUntil = Date.now() + Math.max(1, Number(seconds) || 300) * 1000 + 5000;
      /**
       * 三个"不许自动重开"的硬闸。都来自社区实报：
       * 「回放会解 1955 帧、攒一堆唤醒、一直弹有新画面，关窗也停不干净，得卸载才行」。
       *
       * 共同原因是 `watch` 在 `stopped` 时会**自动重启采集**，而重启对文件源意味着
       * 从头再放一遍，对关过窗的用户意味着"我刚关掉它又弹出来了"。
       * 所以：只有**显式传了来源**（用户明确说要看什么）才允许清闸重开。
       */
      const explicitSrc = Boolean(reqSrc && reqSrc.kind);

      /**
       * region 落到"这次要抓的那个源"上。
       *
       * 不传 `src` 时按上一次的源走；上一次是**文件回放**就不套屏幕区域
       * （region 是 gdigrab 的输入侧参数，对文件没有意义）。
       */
      let src = reqSrc;
      if (region !== undefined) {
        const prevKind = (source ?? lastSource)?.kind ?? 'screen';
        if (src === null && prevKind === 'file') {
          // 放着，让下面按文件继续；region 被忽略，调用方（index.js）会说明
        } else if (src === null || src.kind === 'screen') {
          src = { ...(src ?? { kind: 'screen' }) };
          if (region) {
            src.region = region;
            // ddagrab 没有 -offset_x：带 region 必须走 gdigrab（见 capture.js）
            src.engine = 'gdigrab';
          } else {
            delete src.region;
            if (!reqSrc) delete src.engine;
          }
        }
      }

      // **手动重开窗 = 用户又想看了**，挂断的前提（"窗没了"）已经不成立。
      // 社区实报：关窗后跑 `bin/see-window.mjs --force` 把窗拉回来，再看就永远被拒 ——
      // 因为 `hungUp` 是**本进程内存里的一个变量**，而那个脚本是另一个 node 进程，
      // 它只杀/重开 python 窗口，碰不到这里。重启 DSH 能恢复也正是因为它重置了这个值。
      // 所以判据改成看事实：窗活着就不是"用户关掉了"。
      if (resumeFromReopen({
        hungUp, winAlive: windowAlive(), pidNow: pidStamp(), pidAtHangUp: hungUpStamp,
      })) {
        hungUp = false;
        log('悬浮窗被重新打开过 —— 解除挂断，继续看。');
      }

      /**
       * `fileEnded` 只在**采集已经停了**的时候才算数。
       *
       * 为什么：文件还在播（`running` 为真）时，`watch` 走的是"接着等下一张"，
       * 根本不是重播；这时候拦下来就是"看个视频，第二次 `watch` 就说文件放完了"。
       * 真正的重播是"采集停了 + 不带 path 再 watch"—— 那一下才会 spawn 一根新管道、
       * 从第 0 秒重来（社区实报的 24 秒解 1955 帧）。
       */
      const blocked = guardReason({
        hungUp, fileEnded: Boolean(endedSource) && !running, explicitSrc,
      });
      if (blocked === 'hung-up') return { ok: false, reason: 'hung-up', waited: 0 };
      if (blocked === 'file-ended') {
        return { ok: false, reason: 'file-ended', waited: 0, path: endedSource?.path };
      }
      if (explicitSrc) { hungUp = false; endedSource = null; }

      if (busy) return { ok: false, reason: 'busy', waited: 0 };
      busy = true;
      const t0 = Date.now();
      try {
        const prevSrc = source ?? lastSource;
        const switching = Boolean(pipeline) && q && SIZES[q] && q !== quality;
        /**
         * region 变了（窗口挪了 / 换了窗口 / **取消掉**）也必须重开：`-offset_x` 是建管道时
         * 定死的，不重开的话新 region 会被**静默忽略** —— 用户以为框住了，其实还在抓老地方。
         *
         * "一边有一边没有"也算变了：以前只比四个数字，于是 `region:"off"` 这种
         * **撤回**永远不触发重开 —— 用户点了取消，画面还在抓那一小块。
         */
        const a = prevSrc?.region ?? null;
        const b = src?.region ?? null;
        const regionChanged = Boolean(pipeline)
          && Boolean(a || b)
          && (a?.x !== b?.x || a?.y !== b?.y || a?.w !== b?.w || a?.h !== b?.h);
        // 管线参数变了（常规 ↔ 逐帧）：这两套口径建管线时就定死了，只能重开。
        const modeChanged = Boolean(pipeline) && optsSig(runOpts) !== optsSig(opts);
        /**
         * **要不要重开采集**：`pipeline` 不为空**不等于**采集还在跑。
         *
         * `teardown()` 故意留着 `pipeline`（好把队列里剩下的图发完），于是宽限期到点、
         * 或者模型 `stop` 之后，`pipeline` 还在但 `running` 已经是 false ——
         * 只看 `!pipeline` 就会"跳过启动、直接等一张永远不会来的图"，等到封顶才回一句
         * "没看成"。用户看到的是"第一次能看，第二次就不行了"。
         */
        const stopped = Boolean(pipeline) && !running;
        /**
         * **换了一个源（另一个文件 / 另一台设备）也必须重开**。
         *
         * 以前只看 `!pipeline / stopped / 清晰度 / 模式 / region`，于是"正在放 A 片子，
         * 用户说看 B"这条路上，`start()` 会看到 `running` 直接返回 `already`，
         * 新路径被**静默丢掉** —— 模型以为切过去了，画面还是 A（2026-11-06 真机排查时发现）。
         */
        const effectiveSrc = src ?? prevSrc ?? { kind: 'screen' };
        const srcChanged = Boolean(pipeline) && Boolean(lastSource)
          && srcSig(effectiveSrc) !== srcSig(lastSource);
        // **冷启动**（手上没有管线，或采集已经停了）才 eager。换清晰度不算 —— 那条路已经用 oneShot 了。
        const cold = !pipeline || stopped;
        if (!pipeline || stopped || switching || modeChanged || regionChanged || srcChanged) {
          if (pipeline) {
            teardown(stopped ? '采集已停，重开'
              : switching ? `换清晰度 ${quality} → ${q}`
                : srcChanged ? `换源 ${lastSource?.path ?? effectiveSrc.path ?? effectiveSrc.kind}`
                  : regionChanged ? 'region 变了，重开' : '换模式（逐帧 / 常规）');
          }
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
          await start({
            src: effectiveSrc,
            // 只有**换清晰度**才 oneShot：那一下缓冲区刚被扔掉，等攒满一张就等于白等一整个窗口。
            // 普通的第一次 watch 不 oneShot —— 模型要的是"这 20 秒"，不是"此刻"。
            opts: { ...opts, oneShot: switching },
            quality: q,
            audio,
          });
        } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

        // 真要阻塞了才支窗（第一次起进程 ~1.5s，之后是空操作）
        const win = await ensureWindow();

        /**
         * 取一条用户插话（没有就 null）。
         *
         * 只写一份：冷启动的 eager 和正常等待**都要先看插话**，各写一套就会出现
         * "eager 那段把话吃了但没带上"这种只在首帧复现的丢话。
         */
        const pollUser = () => {
          const said = chatPoll().filter((e) => e.role === 'user');
          if (!said.length) return null;
          return {
            text: said.map((e) => e.text).join(' / ').slice(0, 800),
            // 回执的钥匙：窗口按 `at` 对账（`delivered.jsonl`），这里必须原样带上
            ats: said.map((e) => e.at).filter((a) => Number(a) > 0),
          };
        };

        /** 用这句话截断出图（插话优先于一切：不等判据、不排队） */
        const interjectNow = async (said) => {
          const text = said.text;
          /**
           * **这条话是经这个工具结果交给模型的 —— 到这里就是送达了，回执必须落盘。**
           *
           * 漏掉的后果（2026-11-08 实报「图2」）：窗里那颗「● 发送中」永远是橙的，
           * 因为阻塞等待是三个消费者之一，而只有常驻循环（`loop.js`）和 relay
           * （`index.js`）写回执，这条一直没写。窗口只能按"没有回执"猜，
           * 于是用户明明已经看到回复了，气泡还挂着「发送中」。
           */
          for (const at of said.ats) {
            markDelivered(at, true);
            // **同时记进 relay 的去重表**：这条话已经随工具结果进会话了，插件重载时
            // `replayUnanswered()` 不许再把它当"没人回"补投一遍（2026-11-08 实报重复投递）。
            markRelaySeen(at);
          }
          // 记一条待回执：下一轮工具结果里如果还没带 `say`，就把「你还没回她」顶出来。
          // 模型很可能先去取图了，回来时那段话已经不在上下文最前面（陪看那边实报过）。
          noteInterjected(text);
          // 刚开采集时可能一帧都还没到（-probe 那几百毫秒）—— 用户问"这是什么"，
          // 空着手回去等于没看。最多等 0.8s 让第一帧到，再截断。
          for (let i = 0; i < 8 && pipeline && !pipeline.hasFrame; i += 1) await sleep(100);
          const now = pipeline?.flushNow(null, 'user');
          const waited = (Date.now() - t0) / 1000;
          return now
            ? { ok: true, sheet: attachLines(now), waited, quality, userText: text }
            : { ok: false, reason: 'user-no-frame', waited, userText: text };
        };

        const deadline = t0 + Math.max(2, seconds) * 1000;
        // **登记成"我在等用户说话"**：常驻循环也盯这条通道，它一旦先把话吃掉，
        // 就会走 `followup` 投进会话 —— 而会话正卡在这个工具调用里等结果，
        // 那条消息要等这一轮结束才处理，**接不住"从等待里出来"**。
        // 用户看到的就是"我在窗口里说话，它一动不动"（陪看那边实报过）。
        //
        // 冷启动的 eager 也算"在等"：那 3 秒里用户说的话同样不能被循环吃掉。
        const leaveChan = enterChatWait();
        try {
          /**
           * **冷启动先给此刻**。
           *
           * 静止屏幕上第一条要等 30~60 秒（兜底帧 20 秒一个，攒 3 帧才封箱）——
           * 用户说"看看我屏幕"，等一分钟才回话，体感就是"它没反应"。
           * 所以冷启动时第一帧到手就发，多花一张图（216 token），换"1 秒内给反应"。
           *
           * 只在冷启动生效：管温着的时候再 eager，就退化成"每帧一张图"了。
           * **插话优先**：这 3 秒里用户说话了，就按插话走（体感上他是在追问）。
           */
          if (cold && minFrames <= 1 && eagerMs > 0) {
            const eagerUntil = Date.now() + eagerMs;
            while (Date.now() < eagerUntil && !signal?.aborted) {
              const said = pollUser();
              if (said) return await interjectNow(said);
              if (pipeline?.hasFrame) {
                const first = pipeline.flushNow(null, 'first');
                if (first) {
                  return {
                    ok: true, sheet: attachLines(first), waited: (Date.now() - t0) / 1000,
                    quality, windowOpen: win.ok, first: true,
                  };
                }
              }
              await sleep(60);
            }
          }

          while (Date.now() < deadline) {
            // 宿主取消了这一轮（用户按停止 / 超时策略）就立刻收工，别继续挂着
            if (signal?.aborted) {
              return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
            }
            // **插话优先于一切**：用户说话了就立刻截断，不等判据、不排队
            const said = pollUser();
            if (said) return await interjectNow(said);
            const s = pipeline?.take();
            if (s) {
              // **正常返回也要过 minFrames**。以前只有超时分支检查，于是
              // `minFrames: 5` 在队列先到的路径上会被无视，照样交一张 1 帧的图
              // （issue #1 的复现：`{ ok: true, frames: 1 }`）。
              // 不够就丢掉这一张接着等 —— 到点还没攒够，会走下面的 no-change 提示。
              if (s.frames.length >= minFrames) {
                /**
                 * **出图前等最多 300ms，让"最后一句话"赶上这张图。**
                 *
                 * 台词的取数窗口是「上一张的 wallTo → 这一张的 wallTo」。差几百毫秒
                 * 没转完的那句会被推到下一张 —— 那就是十几秒，而 ASR 本身只有 0.7 秒。
                 * 只有这条正常返回路径等；`peek`（后台唤醒）和插话要快，不等。
                 */
                await listener.settle(300);
                return {
                  ok: true, sheet: attachLines(s), waited: (Date.now() - t0) / 1000, quality, windowOpen: win.ok,
                };
              }
            }
            if (!running && !pipeline?.pending) break;   // 采集停了，队列也空了
            await sleep(120);
          }
        } finally {
          leaveChan();
        }
        // 到点了：手上攒的半张也算数（用户已经在等），但不够 minFrames 就不给
        const last = pipeline?.flushNow(null, 'timeout');
        if (last && last.frames.length >= minFrames) {
          return { ok: true, sheet: attachLines(last), waited: (Date.now() - t0) / 1000, partial: true, quality };
        }
        return {
          ok: false,
          reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
          waited: (Date.now() - t0) / 1000,
          error: lastError,
        };
      } finally {
        busy = false;
        if (pipeline) armGrace();
      }
    },

    /**
     * 取走**已经拼好的那一张**（后台唤醒走这条）。
     *
     * 语义是 "grab the sheet that already piled up" —— 模型被"有新画面了"叫醒时，
     * 要的就是那张攒好的图，不该再等、也不该换一张。
     *
     * **不能走 `flushNow()`**：那是插话用的，会把 `sheets` 整个清空、再把"此刻那一帧"
     * 塞成一张新图。结果是队列里攒好的多帧摘要被一张单帧替换掉 —— 复现见 issue #1：
     * `queued [0,2,4]` → 调完 peek 变成 `[5.92]`、`pending 0`。
     * 队列空就老实返回 null（调用方会提示"下一张还在攒"），
     * 想看"此刻"请走 `watch`。
     *
     * 顺便支窗（**不等它**）：走 peek 路线的会话没有 watch 的阻塞点，
     * 不在这里开窗的话，用户永远没有可以打字的入口，也就没有"关窗 = 不看了"。
     */
    peek() {
      noteUse();
      const queued = pipeline?.take() ?? null;
      if (running) armGrace();
      if (!windowState?.ok && !windowPending) void ensureWindow();
      return attachLines(queued);
    },

    /** 常驻循环每拍续命（见 touch 的注释） */
    touch,

    /** 落一条说明，等下一次工具结果带走（挂断那一条走这里） */
    note(text) {
      const t = String(text ?? '').trim();
      if (t) pendingNote = t;
      return pendingNote;
    },

    /** 取走说明（取完就没了：同一句话不该每一轮都念一遍） */
    takeNote() {
      const n = pendingNote;
      pendingNote = null;
      return n;
    },

    status() {
      return {
        running,
        source,
        lastSource,
        hungUp,
        endedFile: endedSource?.path ?? null,
        quality,
        size: SIZES[quality],
        frames,
        since: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
        lastError,
        idleSec: stoppedAt ? Math.round((Date.now() - stoppedAt) / 1000) : 0,
        // 距「最后一次有人要用图」多久（空闲自动收工就是拿它比阈值）
        sinceUseSec: running ? Math.round((Date.now() - lastUseAt) / 1000) : 0,
        // 有 watch 正阻塞在等图：收工判定要放过它
        watching: Date.now() < watchUntil,
        stats: pipeline?.stats ?? null,
        pending: pipeline?.pending ?? 0,
        // 出图序号（单调递增）：常驻循环靠它保证"同一张图只叫醒一次"。
        // `pending` 只说明"队列里有"，不说明"是不是新的一张"—— 模型不取的话它一直是 1。
        sheets: pipeline?.stats?.sheets ?? 0,
        // 本批第一帧到现在多久：唤醒文案里要说"攒了多久"，不然模型不知道这段时间有多长
        secondsSinceWake: pipeline?.secondsSinceWake ?? null,
        // 这一轮开过窗没有（循环靠它区分"用户关了窗" 和 "窗压根没开起来"）
        windowOpened,
        // 开窗结果与失败原因：**"它在看但我什么都看不到"时第一个要看的就是 reason**
        // （没有带 tkinter 的 python 是最常见的一种，那时窗根本不会出现）
        window: { ok: windowState?.ok ?? null, reason: windowState?.reason ?? null, script: windowState?.from ?? null },
        // 有没有待领的说明（挂断那条）—— status 里看得见，才不会"明明写了没人读"
        notePending: Boolean(pendingNote),
        // 听声音的状态。"它好像没听见台词"时第一个要看的就是它：
        // enabled=false 的 reason 会直接说是缺服务、缺 Python、还是抓不到回环设备
        listen: listener.state(),
        // 黑听留底：帧数 / 内存 / 最后一帧多久以前（采集断了但帧还在时，status 必须看得出来）
        lift: liftStatus(),
      };
    },
  };
}
