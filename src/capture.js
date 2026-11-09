/**
 * capture.js — 唯一 spawn ffmpeg 的地方。**一根 rawvideo 管道**，不再切分片。
 *
 * 为什么不是「2 秒一片 + `-ss` 回抓」：分片必须关闭才能 seek，光这一条就是 2 秒固定延迟；
 * 每抓一帧还要 spawn 一次 ffmpeg（实测 135ms）。实时场景要的是「帧到手就判、判完就留」，
 * 所以直接 `-f rawvideo` 吐 rgb24，帧在内存里，留帧零成本。
 *
 * ## 三种源的实测（Windows 机 2560×1600 屏 / i9-12900HX，12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `ddagrab`（桌面复制 API） | 370 ms | **0.28 核** | 走 GPU，屏幕的原生路子 |
 * | `gdigrab`（GDI 抓屏） | 310 ms | 0.45 核 | 每帧先从 GDI 拷 2560×1600 BGRA = **16 MB** 再缩 |
 * | `obs`（OBS 虚拟摄像头） | 575 ms | 0.13 核 | 设备侧已经缩好了，最省 |
 * | `camera`（USB 摄像头） | **1450 ms** | 0.14 核 | 首帧慢是**硬件唤醒**，参数救不了 |
 * | Nikon Webcam Utility（客户端没开） | — | 0.80 核 | 只有 3.4 fps，等于卡死 |
 *
 * 结论：屏幕源**默认用 ddagrab**，跑不起来退回 gdigrab；设备源别停进程 —— 首帧延迟只能靠常驻摊掉。
 *
 * ## macOS（M 系列 / Retina，同样 12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `avfoundation` 屏幕 | **~700 ms** | **~0.16 核** | 起会话慢（AVCaptureSession 冷启动），稳态最省 |
 *
 * 两条 macOS 特有的坑，都写在对应函数里，别删：
 *
 * ① **`-framerate` 在 avfoundation 屏幕源上不压速**。实测 `-frames:v 30` 只用 0.73 秒
 *    （≈40fps），挂上 `-r 12` 才是 3.05 秒。少了这一条，管道会被帧灌满 ——
 *    开发时真被灌出过 **240 GB / 几分钟**的 raw 文件。所以屏幕源在 macOS 上必须挂 `-r`，
 *    而 Windows 的 ddagrab/gdigrab 已经按 fps 抓了，再挂就是白跑一趟。
 *
 * ② **没有「屏幕录制」权限时它不报错，只给你一片纯黑**。exit code 还是 0，
 *    帧数正常，字节数正常。所以探针除了看"有没有帧"，还要看"帧里有没有东西"。
 */

import { spawn } from 'node:child_process';

/** macOS 上屏幕设备的默认名字。`-list_devices` 里它永远是英文，相机才是本地化的。 */
export const DEFAULT_SCREEN_DEVICE = 'Capture screen 0';

/**
 * 纯黑帧的提示语。macOS 不会告诉你"权限没给"，只会默默给黑屏 ——
 * 这句是唯一能把人从"插件坏了"领到"系统设置"的路标。
 */
export const SCREEN_PERMISSION_HINT =
  'ffmpeg 没有「屏幕录制」权限：系统设置 → 隐私与安全性 → 屏幕录制，勾上跑 DSH 的那个 App（或终端），重启它再试。';

/**
 * 把采集失败归成能直接照着做的一类。
 *
 * 原来所有失败都只有一句 "ffmpeg exit 1"，用户分不清是没装 ffmpeg、没给权限，
 * 还是设备名不对（#6 的核心诉求）。判据只用 stderr 里的明文证据，不猜。
 *
 * @param {Error & {code?:string|number, stderrTail?:string|null}} error
 * @param {'spawn'|'exit'|'list'} stage
 */
export function captureErrorInfo(error, stage = 'exit') {
  if (error?.errorInfo) return error.errorInfo;
  const message = `${error?.message ?? error}\n${error?.stderrTail ?? ''}`;
  const category = error?.code === 'ENOENT' || /找不到 FFmpeg|spawn.*ENOENT/i.test(message)
    ? 'dependency-missing'
    : error instanceof RangeError ? 'invalid-input'
      : /permission denied|not authorized|operation not permitted|screen recording permission/i.test(message)
        ? 'permission-denied'
        : /device.*(?:not found|invalid)|invalid.*device|could not find.*device|video device.*not available/i.test(message)
          ? 'device-unavailable'
          : 'capture-failed';
  return {
    category,
    stage,
    code: error?.code ?? null,
    signal: error?.signal ?? null,
    stderrTail: error?.stderrTail ?? null,
  };
}

/** 分类 → 一句能照做的话。只给用户/模型看的，不参与判断。 */
export const CAPTURE_HINTS = Object.freeze({
  'dependency-missing': '没找到 ffmpeg：装一个，或用 DSH_FFMPEG_PATH 指到绝对路径。',
  'invalid-input': '参数不合法：region 必须是物理像素整数、宽高为正。',
  'permission-denied': SCREEN_PERMISSION_HINT,
  'device-unavailable': '设备名不对或没插上：换成可用的设备，或不传 device 用默认屏幕。',
  'capture-failed': '采集失败：看 stderrTail，那几行通常就是原因。',
});

/** 源描述 → 输入参数。纯函数，可单测。 */
export function sourceArgs(
  source = { kind: 'screen' },
  { engine = 'auto', fps = 12, platform = process.platform, pixelFormat = null } = {},
) {
  const s = source ?? {};
  const mac = platform === 'darwin';

  switch (s.kind) {
    case 'obs':
    case 'camera': {
      const fallback = s.kind === 'obs' ? 'OBS Virtual Camera' : 'HD Webcam';
      const device = s.device ?? fallback;
      if (mac) {
        // macOS 没有 dshow；OBS 虚拟摄像头/本机摄像头都以设备身份出现在 avfoundation 里，
        // 名字和索引都能用。`-framerate` 在这里是**设备侧采样率**，必须给。
        return ['-f', 'avfoundation', '-framerate', String(fps), '-i', `${device}:none`];
      }
      // **不要加 `-thread_queue_size`**：部分 ffmpeg build（gyan.dev 2026-10-29 full）
      // 会把放在 `-i` 前的它判成输出选项，直接报 "cannot be applied to input url"，
      // 设备源一帧都出不来（#17 用 bisect 定位）。dshow 的缓冲由 `-rtbufsize` 给，够用。
      return ['-rtbufsize', '256M', '-f', 'dshow', '-i', `video=${device}`];
    }
    case 'screen': {
      if (mac || s.engine === 'avfoundation' || engine === 'avfoundation') {
        // ① 屏幕合成不走 GPU 路径，只能靠 AVFoundation 推流；
        // ② `-capture_cursor` 必须显式给（默认值随系统版本变，不能靠）；
        // ③ 音频写 `none`，否则某些系统会去开麦克风，触发额外的权限弹窗；
        // ④ `-pixel_format` 不给就默认 yuv420p，而屏幕输入**不支持** yuv420p ——
        //    每进程刷一行 "not supported" 到 stderr。探针会挑一个设备真收的格式，
        //    顺手把那行噪音也消掉（否则真出错时被截断的 300 字里全是它）。
        const pf = s.pixelFormat ?? pixelFormat;
        return ['-f', 'avfoundation', '-framerate', String(fps),
          ...(pf ? ['-pixel_format', pf] : []),
          '-capture_cursor', s.mouse ? '1' : '0',
          '-i', `${s.device ?? DEFAULT_SCREEN_DEVICE}:none`];
      }
      // region 只能走 gdigrab：ddagrab 是 filter source，没有 `-offset_x`/`-video_size`
      // 这类输入侧参数，带 region 时给它会把偏移静默丢掉（抓到整屏，用户以为生效了）。
      const useDda = !s.region
        && (s.engine === 'ddagrab' || (s.engine !== 'gdigrab' && engine !== 'gdigrab'));
      if (!useDda) {
        // gdigrab 的 -framerate 是**设备侧**采样率，必须给，否则默认 29.97 白解码
        const region = s.region
          ? ['-offset_x', String(s.region.x), '-offset_y', String(s.region.y),
            '-video_size', `${s.region.w}x${s.region.h}`]
          : [];
        return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', ...region,
          '-i', s.desktop ?? 'desktop'];
      }
      // ddagrab 是 filter source，输入侧没有帧率参数
      return ['-f', 'lavfi', '-i', `ddagrab=framerate=${fps}:draw_mouse=${s.mouse ? 1 : 0}`];
    }
    case 'file':
      // `realtime` 才加 -re；离线跑要看的是「管线本身多快」，不能被播放速度骗了
      return [...(s.realtime ? ['-re'] : []), '-i', String(s.path)];
    case 'rtmp':
      return s.listen === false ? ['-i', String(s.url)] : ['-listen', '1', '-i', String(s.url)];
    default:
      throw new RangeError(`unknown source kind: ${s.kind}`);
  }
}

/** ddagrab 出来的帧还在 GPU 上，得先 hwdownload 再缩。 */
function isDda(source, engine, platform = process.platform) {
  if (source?.kind !== 'screen') return false;
  const e = source?.engine ?? engine;
  if (e === 'ddagrab') return true;
  // `auto` 在 Windows 上默认就是 ddagrab；macOS 上它不是候选，别给它套 hwdownload
  return e === 'auto' && platform !== 'darwin';
}

/**
 * 完整的采集命令。
 *
 * **`-r` 只在需要压速时才挂**：gdigrab/ddagrab 已经按 fps 抓了，再串一个 fps 滤镜是白跑一趟
 * （实测 12fps 下省 3–5% CPU）。但 avfoundation 的屏幕源不认 `-framerate` 当节流阀，
 * 必须靠输出侧 `-r` 把 40fps 压回 12fps —— 见文件头 macOS 坑 ①。
 */
export function captureArgs({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  fast = true, sws = 'area', platform = process.platform,
} = {}) {
  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
  const engineUsed = source?.engine ?? engine;
  if (fast) {
    // `-fflags nobuffer` 只对**直播式**输入有意义，而且它会把 `-re` 的文件回放直接堵死
    // （实测：加上它、配上 -re，4 秒一个字节都不出；去掉立刻 57MB）。
    if (source?.kind !== 'file') args.push('-fflags', 'nobuffer');
    args.push('-flags', 'low_delay');
    if (source?.kind === 'obs' || source?.kind === 'camera') {
      args.push('-probesize', '32', '-analyzeduration', '0');
    }
  }
  args.push(...sourceArgs(source, {
    engine, fps, platform,
    pixelFormat: source?.pixelFormat !== undefined
      ? source.pixelFormat
      : (platform === 'darwin' && source?.kind === 'screen' ? cachedFormat : null),
  }));
  args.push('-an', '-sn');

  const filters = [];
  if (isDda(source, engine, platform)) filters.push('hwdownload', 'format=bgra');
  // avfoundation 没有 gdigrab 那种 `-video_size` 局部抓取，裁剪只能在滤镜里做。
  // 坐标按**采集分辨率**算（Retina 上是逻辑分辨率的 2 倍），不做自动换算。
  if (source?.kind === 'screen' && (platform === 'darwin' || engineUsed === 'avfoundation') && source?.region) {
    const r = source.region;
    filters.push(`crop=${r.w}:${r.h}:${r.x}:${r.y}`);
  }
  filters.push(`scale=${width}:${height}:flags=${sws}`);
  args.push('-vf', filters.join(','));

  if (source?.kind !== 'screen' || (platform === 'darwin' || engineUsed === 'avfoundation')) {
    args.push('-r', String(fps));
  }
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return args;
}

/**
 * 逐帧读，**同步回调**。回调里做的事会直接变成对 ffmpeg 的背压 —— 这是刻意的：
 * 判帧、留帧、重排都在回调里跑完，绝不让帧在内存里越堆越多。
 *
 * @returns {{stop:()=>void, done:Promise<{frames:number, ms:number, code:number|null}>}}
 */export function spawnFrames({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  onFrame, onStderr = null, onFirst = null,
} = {}) {
  const args = captureArgs({ source, width, height, fps, ffmpegPath, engine }).slice(1);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const need = width * height * 3;
  /**
   * 拼帧缓冲：**一帧只分配一次、只拷贝一次**。
   *
   * 旧写法是 `Buffer.concat([pending, chunk])` —— pipe 每给 64KB 就拼一次，
   * 一帧 1.03MB 要拼 16 次，累计拷贝 ≈ 8.5MB/帧（100MB/s @12fps），全是白干。
   * 现在先 `allocUnsafe(need)` 再按需 `copy` 进来，一帧固定 1MB。
   */
  let acc = null;
  let filled = 0;
  let n = 0;
  const t0 = Date.now();
  let err = '';

  const deliver = (buf) => {
    const i = n;
    n += 1;
    if (i === 0) onFirst?.(Date.now() - t0);
    onFrame?.({ i, t: i / fps, buf });
  };

  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        // `filled` 填满就立刻交付并清零，所以这里 room 永远 > 0
        const room = need - filled;
        const take = chunk.length - off < room ? chunk.length - off : room;
        if (filled === 0 && take === need) {
          // 整帧刚好落在一个 chunk 里：零拷贝，直接给视图
          deliver(chunk.subarray(off, off + need));
          off += need;
          continue;
        }
        if (filled === 0) acc = Buffer.allocUnsafe(need);
        chunk.copy(acc, filled, off, off + take);
        filled += take;
        off += take;
        if (filled === need) { deliver(acc); acc = null; filled = 0; }
      }
    });
    child.stderr.on('data', (d) => {
      err = `${err}${d}`.slice(-4000);
      onStderr?.(String(d));
    });
    child.on('error', (e) => {
      // 常见于 ffmpeg 不在 PATH（ENOENT）—— 分类后上层能直接给出"装/指路径"的提示
      e.errorInfo = captureErrorInfo(e, 'spawn');
      reject(e);
    });
    child.on('close', (code) => {
      const secs = Math.round((Date.now() - t0) / 1000);
      // `code === null` = 被我们自己 SIGKILL 的（stop / 换清晰度 / 收工）。
      // 那是正常收尾，不是失败 —— 否则每次 stop 都往 lastError 里写一条假错误。
      if (code === null) {
        resolve({ frames: n, ms: Date.now() - t0, code });
        return;
      }
      /**
       * 屏幕采集**不存在"自然播完"**：源是活的屏幕，ffmpeg 只会在出错或源消失时自己退出。
       * 所以 code 非 0 一律是异常；code === 0 也不是收工（以前这里会静默 resolve，
       * 于是"采集中途停了"在上层看来跟正常停止一模一样，社区报的那种 141s/177s 中途退出
       * 就查不出原因）。
       *
       * 报错里必须带**跑了多久、收了多少帧** —— 只有 code 是定位不了的：
       * 12fps 下 141s/1686 帧说明是正常跑着跑着停的，而不是启动就崩。
       */
      const stderrTail = err.trim().slice(-1000) || null;
      /**
       * **文件源是有限的：放完就 code 0，那是正常收尾。**
       *
       * 这条以前缺失，后果不是"多一条日志"—— `runner` 的 `run.done.then()` 里才写
       * `endedSource`，走 reject 分支的话那个硬闸永远不生效，下一次 `watch` 会把
       * 同一个文件**从头再放一遍**（社区实报：24 秒解 1955 帧、刷几十张图、
       * 反复叫醒、关窗也停不干净）。`scripts/sim.mjs` 也因此在最后一步抛异常。
       */
      if (code === 0 && source?.kind === 'file') {
        resolve({ frames: n, ms: Date.now() - t0, code, ended: true });
        return;
      }
      if (code !== 0) {
        const error = new Error(`ffmpeg exit ${code}（运行 ${secs}s / ${n} 帧）`
          + `: ${err.trim().slice(-300) || '无 stderr'}`);
        error.code = code;
        error.stderrTail = stderrTail;
        error.errorInfo = captureErrorInfo(error, 'exit');
        const hint = CAPTURE_HINTS[error.errorInfo.category];
        if (hint) error.message += `\n  ↳ ${hint}`;
        reject(error);
        return;
      }
      const error = new Error(`ffmpeg 自己退出了（code 0，运行 ${secs}s / ${n} 帧）—— `
        + `屏幕源没了？独占全屏切换 / 显示器休眠 / 抓屏引擎掉线都会这样。`
        + ` stderr: ${err.trim().slice(-300) || '空'}`);
      error.stderrTail = stderrTail;
      error.errorInfo = captureErrorInfo(error, 'exit');
      reject(error);
    });
  });

  return {
    done,
    stop() {
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    },
  };
}

/* ---------------------------------------------------------------- 引擎探测 */

/**
 * 屏幕源用哪个引擎 —— **测一次、整个进程记住**。
 *
 * 为什么需要探测（Windows）：`ddagrab` 走桌面复制 API，独占全屏的游戏 / 部分远程桌面会把它挡住
 * （报 "Selected output not supported" 或者干脆不吐帧）。那种情况下不能哑着 ——
 * 退到 `gdigrab` 只是多花 0.17 核，画面照样能看。
 *
 * 代价是进程里第一次开屏幕要多 spawn 一次 ffmpeg（~400ms）。所以结果缓存，
 * 之后每次 start 都是 0 成本；本机这两种引擎的可用性不会在一次会话里变。
 *
 * macOS 没有备选引擎，但探针**仍然要跑**：它顺带替我们回答"屏幕录制权限给了没"。
 * 没权限的时候 ffmpeg 照样 exit 0、照样吐帧，只是全黑 —— 只有看平均像素才知道。
 */
let cachedEngine = null;
let cachedFormat = null;            // macOS 屏幕像素格式：'' = 用设备默认
let screenWarning = null;

export function resetScreenEngineCache() {
  cachedEngine = null;
  cachedFormat = null;
  screenWarning = null;
}

/** 上一次探测留下的警告（目前只有"没有屏幕录制权限"这一类）。 */
export function screenEngineWarning() {
  return screenWarning;
}

/** 抽样求均值就够了，不用全量遍历 6912 字节 × 每帧。 */
function meanOf(buf) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 97) {
    sum += buf[i];
    n += 1;
  }
  return n ? sum / n : 0;
}

export function pickScreenEngine({
  ffmpegPath = 'ffmpeg', fps = 12, timeoutMs = 2500, platform = process.platform,
} = {}) {
  if (cachedEngine) return Promise.resolve(cachedEngine);
  if (platform === 'darwin') return probeAvfoundation({ ffmpegPath, fps, timeoutMs });
  if (platform !== 'win32') {
    return Promise.reject(new RangeError(
      `屏幕采集还没接 ${platform}：Windows 走 ddagrab/gdigrab，macOS 走 avfoundation，Linux 需要 x11grab 或 PipeWire，还没做。`,
    ));
  }
  return probeDdagrab({ ffmpegPath, fps, timeoutMs });
}

/** macOS：探一次 avfoundation，同时判黑屏（= 没权限）。 */
/**
 * macOS：探一次 avfoundation —— 一次回答三个问题。
 *
 * ① 能不能出帧（ffmpeg 在不在、设备名对不对）；
 * ② **哪个像素格式设备真收**（默认的 yuv420p 屏幕输入不支持，必须自己试）；
 * ③ 画面是不是全黑（= 系统没给「屏幕录制」权限，ffmpeg 自己不会报）。
 *
 * 顺序是**按实测 CPU 从省到费**排的（本机 12fps→800×450：nv12 0.14 核 ≈ uyvy422 0.15 ≈
 * 设备默认 0.14，bgr0 0.23）。格式不对时 ffmpeg 会很快报错退出，所以串行试不会拖慢。
 */
async function probeAvfoundation({ ffmpegPath, fps, timeoutMs }) {
  const W = 64;                      // 探针只取 1 帧，尺寸越小越快
  const H = 36;
  const formats = ['nv12', 'uyvy422', 'bgr0', null];
  for (const pf of formats) {
    const shot = await grabOneFrame({ ffmpegPath, fps, width: W, height: H, pixelFormat: pf, timeoutMs });
    if (!shot.got) continue;
    cachedEngine = 'avfoundation';
    cachedFormat = pf ?? '';
    // 拿到帧但全是黑的 → 有采集会话、没画面，这就是 macOS 的"没权限"的样子。
    screenWarning = meanOf(shot.buf) < 1 ? SCREEN_PERMISSION_HINT : null;
    return 'avfoundation';
  }
  // 一帧都没拿到：启动层面的问题（ffmpeg 不在、设备名不对），留给 start 报错。
  cachedEngine = 'avfoundation';
  cachedFormat = '';
  screenWarning = null;
  return 'avfoundation';
}

/** 单帧探针。拿到满一帧就提前 resolve，不等 close。 */
function grabOneFrame({ ffmpegPath, fps, width, height, pixelFormat, timeoutMs }) {
  const args = captureArgs({
    source: { kind: 'screen', engine: 'avfoundation', pixelFormat: pixelFormat ?? '' },
    width, height, fps, ffmpegPath, engine: 'avfoundation',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');
  const need = width * height * 3;

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve({ got: buf.length >= need, buf: buf.subarray(0, need) });
    };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= need) { clearTimeout(timer); finish(); }
    });
    child.on('error', () => { clearTimeout(timer); finish(); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
}

/** Windows：探 ddagrab，不行退 gdigrab。 */
function probeDdagrab({ ffmpegPath, fps, timeoutMs }) {
  const W = 64;
  const H = 36;                     // 探针只取 1 帧，尺寸越小越快
  const args = captureArgs({
    source: { kind: 'screen', engine: 'ddagrab' }, width: W, height: H, fps, ffmpegPath, engine: 'ddagrab',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let got = 0;
    const done = (engine) => {
      cachedEngine = engine;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve(engine);
    };
    const timer = setTimeout(() => done('gdigrab'), timeoutMs);
    child.stdout.on('data', (d) => {
      got += d.length;
      if (got >= W * H * 3) { clearTimeout(timer); done('ddagrab'); }
    });
    child.on('error', () => { clearTimeout(timer); done('gdigrab'); });
    child.on('close', () => { clearTimeout(timer); if (!got) done('gdigrab'); });
  });
}
