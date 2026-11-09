/**
 * pipeline.js — 采集帧进来，出图出去。本包唯一有状态的地方。
 *
 * 一条链：
 *
 *   帧 → 打分 →（延迟一帧）切点判定 → 积分/兜底 → 留帧 → 档位 → pack.solve → 截断 → 出图
 *
 * 三个刻意的设计：
 *
 * ① **只延迟一帧**。切点判据要看"这一帧的分是不是尖峰"，需要前后各一个分，
 *    所以第 k 帧要到第 k+1 帧到手才判 —— 83ms，换来的是把"一拍二/手抖/粒子"挡在门外。
 *
 * ② **截断在采集侧，不在模型侧**。模型来问的时候图已经在队列里，模型思考 3 秒
 *    只是让队列多一张，不是延迟。
 *
 * ③ **档位数所有边界**（切点 + 积分 + 兜底），不是只数切点。一镜到底的素材没有切点，
 *    只数切点会让档位永远 1 档、一张图只放 4 帧。见 tiers.js 的推导。
 */

import { bgBorderChanged, bgKeep, changedArea, createScorer, scorePair } from './cuts.js';
import { createTiers, applyStrategy } from './tiers.js';
import { solve, toRects, splitOneBin } from './pack.js';
import { composePacked, drawAudioStrip, stripHeight } from './sheet.js';
import { encodePng } from './png.js';
import { gridRects } from './layout.js';

/**
 * 低分辨率找字幕行：在画面下部 45% 里隔几列抽一对相邻样本，数每行的「强边沿」。
 *
 * 判据的形状来自 bilibili 那条链：**先用便宜的分辨率判"有没有字、字在哪"，
 * 再回原分辨率裁那一块**。文字的特征是一横条上密集的明暗跳变；天空、渐变、
 * 阴影的边沿稀疏，HUD 边框只有 1–2 行。
 *
 * 两条阈值是拿《影之刃零》预告片的帧标出来的（缩放 1/4 后量）：
 *  - 一行字幕会在 **7 行连续**里每行都有边沿；草丛/石头/火光只有 1–2 行的碎边。
 *    所以下限取画面高度的 1.5%（900 高 ≈ 14 行，1/4 尺度 ≈ 3.5 行）。
 *  - 一行字幕的边沿数能到 58–79（399 宽的缩略图上），噪声行 < 10。
 *
 * **取最下面那一条**，不取最长：字幕永远在同一部片子里最靠下的文字带，
 * 画面里更忙的纹理通常在更上面（这里踩过一次：取"最长 run"直接锁到了角色身上）。
 *
 * 代价：约 400 行 × 320 列 = 12.8 万次采样，1596×900 的一帧 ~1ms，12fps 下可忽略。
 *
 * @returns {{top:number, rows:number}|null} 命中的行范围（像素），没字返回 null
 */
function detectTextBand(buf, width, height) {
  const yStart = Math.floor(height * 0.55)
  const stepX = Math.max(2, Math.round(width / 320))
  const cols = Math.max(1, Math.floor((width - stepX) / stepX))
  const minHits = Math.max(4, Math.round(cols * 0.06))
  const minRows = Math.max(10, Math.round(height * 0.015))
  const maxRows = Math.round(height * 0.20)
  const counts = new Uint16Array(height)
  for (let y = yStart; y < height; y += 1) {
    const base = y * width * 3
    let c = 0
    for (let x = stepX; x + stepX < width; x += stepX) {
      const i = base + x * 3
      const j = base + (x + stepX) * 3
      const l1 = (buf[i] * 77 + buf[i + 1] * 150 + buf[i + 2] * 29) >> 8
      const l2 = (buf[j] * 77 + buf[j + 1] * 150 + buf[j + 2] * 29) >> 8
      if (Math.abs(l1 - l2) > 26) c += 1
    }
    counts[y] = c
  }
  let best = null
  let runStart = -1
  for (let y = yStart; y <= height; y += 1) {
    const hit = y < height && counts[y] >= minHits
    if (hit && runStart < 0) runStart = y
    if (!hit && runStart >= 0) {
      const rows = y - runStart
      if (rows >= minRows && rows <= maxRows && (!best || runStart > best.top)) {
        best = { top: runStart, rows }
      }
      runStart = -1
    }
  }
  return best
}

/**
 * 两条带子是不是"同一句字幕"。
 *
 * 逐字节相等只在编码完全一致时命中（同一帧），而真实视频里两次拍到同一句台词，
 * 背景像素会因为压缩噪声差一两个灰阶 —— 实测同一句的两条带子逐字节比较永远不等，
 * 于是一句话占两行、白花 25% 的 token。
 *
 * 所以按采样均值判：每 7 个字节比一个，平均绝对差 ≤ 2.5 就算同一条。
 * 两句不同的话在字形位置上的差远大于这个数（实测 10 以上），不会误并。
 */
function stripSimilar(a, b) {
  if (a.length !== b.length) return false
  let sum = 0
  let n = 0
  for (let i = 0; i < a.length; i += 7) {
    sum += Math.abs(a[i] - b[i])
    n += 1
  }
  return n > 0 && sum / n <= 2.5
}

/**
 * 从 rgb24 缓冲里裁一块 `[x, x+cw) × [y, y+ch)`。
 *
 * 整宽时是一次连续拷贝；带左右让边之后就是每行一次 `copy`（144 行 × 3.8KB），
 * 12fps 下这点拷贝可以忽略，换来的是把"本来就没有字的边"一起扔掉。
 */
function cropRect(buf, width, height, x, y, cw, ch) {
  const stride = width * 3;
  const outStride = cw * 3;
  const out = Buffer.allocUnsafe(outStride * ch);
  out.fill(0);
  const yEnd = Math.max(0, Math.min(height, y + ch));
  const xByte = Math.max(0, Math.min(width, x)) * 3;
  const cwByte = Math.min(cw, width - x) * 3;
  for (let row = Math.max(0, y); row < yEnd; row += 1) {
    const from = row * stride + xByte;
    buf.copy(out, (row - y) * outStride, from, from + cwByte);
  }
  return out;
}

export const DEFAULTS = Object.freeze({
  // 798 而不是 800：宽度向下对齐 42（patch 格），面积只少 0.25%，每张省 11 token。
  // runner 总会显式传 SIZES 里的值，这三个只是单独用 pipeline（测试/离线）时的兜底。
  width: 798,
  height: 450,
  fps: 12,

  /**
   * 字幕带 `[y0, y1]`：画面高度的比例（0 = 顶）。设了就只出这一条。
   *
   * 为什么在**出图时裁**而不是采集时裁：采集侧裁剪要先拿到屏幕物理像素尺寸（region 那条路
   * 才需要），而这里的输入已经是档位尺寸的整帧 —— 底下这 14% 的行本来就在内存里，
   * 裁剪就是一次连续内存拷贝（1596×126×3 ≈ 600 KB）。
   *
   * **它省的是 token，不是清晰度**：清晰度由采集档位决定；一条带只花一张图的零头
   * （4 条 1596×126 叠起来 ≈ 456 token，一张 ultra 整屏是 860）。
   */
  band: null,

  /**
   * 切点：绝对值门槛 + 尖峰比 + 不应期。
   *
   * **25 → 15 → 7。** 25 是 storyboard 的口径（影视剪辑的硬切），实时屏幕这边差了一个数量级。
   * 同一条 12fps 链路上量"每 2 秒硬切一张照片"，门槛与命中数的关系：
   *
   * | 素材 | 换图那一帧的分 | 该有几刀 | 25 | 15 | **7** | 5 |
   * |---|---|---|---|---|---|---|
   * | 差异明显的照片 | 46.6~63.4 | 6 | 5 | 5 | 5 | 5 |
   * | 色调接近的照片 | 16.0~17.9 | 6 | **0** | 5 | 5 | 5 |
   * | 极相似（裁切差 8px） | 7.3~8.2 | 6 | **0** | **0** | 5 | 5 |
   * | 只改亮度 | 5.3 | 6 | 0 | 0 | 0 | 2 |
   * | 连续运动（合成片） | 峰值 11.7 / 中位 3.7 | 0 | 0 | 0 | **0** | 0 |
   * | 缓慢缩放 | 峰值 13.6 | 0 | 0 | 2 | 2 | 2 |
   * | 滚动网页 | 30~42 | — | 5 | 5 | 5 | 5 |
   * | 光标在静止画面移动 | 峰值 **0.7** | 0 | 0 | 0 | 0 | 0 |
   *
   * ## 默认取 12，而不是 7
   *
   * 7 能清掉全部 7 分以上的漏判，但那是**为了最难的素材**（7.3 分的极相似照片）定出来的。
   * 对日常屏幕它太敏感：切窗口、滚网页、点菜单都能过线，于是"每 8 秒叫一次"——
   * 用户实报"回复太密集、太烧钱"。
   *
   * 所以 7 改成**可选项**（`pace:"dense"`，见 runner.js 的 PACES），默认回到 12：
   * 幻灯片的正常切换（16 分以上）照抓，日常操作不再碎。
   *
   * ## 为什么不能"只留尖峰判据"（`cutAbs` 直接归零）
   *
   * 尖峰是**相对**的：`s > 2.5 × max(1, 前后帧)`。在低分区它同样成立 ——
   * 实测缓慢缩放那段有两帧 `s=13.6`、前后邻居只有 1.1 / 1.3，门槛算出来是 3.3，
   * **尖峰判据完全放行**。也就是说没有绝对地板的话，缓慢的持续运动会被切成一块块。
   * 地板负责区分"这是很大的变化"和"这只是动了一下"，尖峰负责区分"这是一下子"
   * 和"这是一直在动"。两个都要。
   *
   * 顺带一个反直觉的数：**光标移动只有 0.7 分**。静止桌面上真的什么都没有时，
   * 分数就是 0.00（屏幕采集近似无损）。所以地板不防光标 —— 它防的是持续运动。
   *
   * ## 漏判为什么不只是"少一帧"
   *
   * 判不出切点就落到积分，而积分是给**连续运动**标定的
   * （中等运动 4 分/帧 × 12fps × 3 秒 = 144）。幻灯片是"1 帧有值 + 23 帧归零"，
   * 每 2 秒只进账十几分 —— 要换 8~9 张照片才攒够一帧，看着就像"根本没反应"。
   */
  cutAbs: 12,
  cutSpike: 2.5,
  /**
   * 尖峰判据的**绝对地板**：`s` 除了要比前后两帧高 2.5 倍，还得够到这个数。
   *
   * 默认 0 = 不额外要求（行为和以前完全一致）。给 action 档用：那一档把倍率降到 1.5
   * （动作游戏里"前后两帧"本身就很高，2.5 倍根本凑不出来），倍率一松就必须靠绝对地板
   * 兜住噪声，否则满屏都是切点。
   */
  cutSpikeAbs: 0,
  cutMinGap: 0.4,

  /**
   * 运动补偿切点（mc）：整屏平移能被邻域吸收，换镜头不能。这是"运镜中切机位"的
   * 直接证据，不靠绝对分台阶。
   *
   * - `cutMcRadius` 默认 4：实测随机纹理平移 8 格时，radius=2 的 mc 高达 194，
   *   radius=4 只有 5；快速运镜因此不会被当成切点。
   * - `cutMcAbs` 默认 60：B 站游戏片里真切点 30.33s（abs 23.2 / mc 121）、
   *   39s（abs 35.5 / mc 68）能过；UI 面板变化（abs 6~12 / mc 10~18）不过。
   * - `cutMcMinScore` 是绝对分地板，挡住纯 UI 小变化；0 关闭整条路径。
   */
  cutMcRadius: 4,
  cutMcAbs: 60,
  cutMcMinScore: 6,
  /** 尖峰切点也要有 mc 覆盖，避免在真切换前 0.4s 的过渡帧先切一刀；0=不查。 */
  cutSpikeMcAbs: 20,

  /**
   * 相似构图/相似主体的弱切点。
   *
   * 这类切点整屏平均分只有 7~8（低于 cutAbs=12），但前后邻居接近 0 ——
   * 不是“运动”，而是孤立的一下子。给一个更低、但要求**更尖**的绝对地板：
   * 6 分以上、高于前后邻居 3 倍，且 mc 覆盖率 ≥8、变化包围盒 ≥20、包围盒填充率 ≥0.2。
   * 只改亮度（约 5.3 分）不会被误判；B 站 UI 小面板 mc 只有 1~18，bbox 虽大但很稀
   * （填充率 0.01~0.11），会被填充率挡掉；真正的相似构图主体占 20×10，填充率约 0.4。
   * 0 = 关闭。
   */
  cutIsolatedAbs: 6,
  cutIsolatedSpike: 3.0,
  cutIsolatedMcAbs: 8,
  cutIsolatedMcBBox: 20,
  cutIsolatedFill: 0.2,

  /**
   * 背景模型 / 前景运动抑制。
   * 稳定背景格被改掉的比例（bgStats 的 score，0–255）低于 `cutBgAbs`，
   * 且变化区域没有盖满有效画面高度（`mcSpanY / activeY < cutBgMaxSpanY`，上下黑边不计）时，
   * 视为手/勺子/遮挡物这类前景运动，不切。只在分数低于 `cutBgMaxScore`
   * 且不是孤立弱切点时启用；真正切镜头会把稳定背景整片换掉（几百），
   * 前景运动只换一部分（几十）。`cutBgMinCells` 太少时不可信，直接不启用；
   * `cutBgMaxChanged` 是绝对变化格数上限：稳定背景格很多时，比例低也可能已经是
   * 真切镜头（实测开箱视频 18.67s 比例 89/255，但变了约 700 格），这类不挡。
   */
  cutBgAbs: 100,
  cutBgMaxScore: 60,
  cutBgMinCells: 128,
  cutBgMaxChanged: 600,
  cutBgMaxSpanY: 0.85,
  cutBgWindow: 6,

  /**
   * 未来帧确认（只用于高分候选）：
   * 高分镜头可能把大面积前景运动当切点；等 `cutFutureDelay` 秒后，
   * 再看候选帧改掉的格子有多少还没回到参考背景（最近 `cutFutureRefWindow` 帧）。
   * 低于 `cutFutureKeep` 的判为短暂前景运动，不切。真正换镜头在新场景里稳定下来，
   * keep 很高；候选帧前的前景离开（画面回到旧背景）也会被 `bgKeep` 抓到。
   * 高分前景停住时，外圈通常还是旧背景（`bgBorderChanged`），
   * 背景变化不算整片且外圈几乎不动时也判为前景。
   * 0 = 关闭未来帧确认。
   */
  cutFutureDelay: 0.5,
  cutFutureMinScore: 60,
  cutFutureKeep: 100,
  cutFutureMinChanged: 64,
  cutFutureRefWindow: 24,
  /** 外圈变化低于这个值（0–255）且背景仍稳定时，判为停住的大面积前景。 */
  cutFutureBorderMax: 10,
  /** 低/中分候选若背景仍有一块没变，也做未来帧确认。 */
  cutFutureLowBgMax: 160,
  /** 低/中分候选的外圈被改掉多少（大面积前景盖到边缘）才值得未来确认。 */
  cutFutureLowBorderMin: 60,
  /** 稳定背景格数太少时，优先怀疑大面积前景，而不是整屏新场景。 */
  cutFutureLowStableMax: 700,
  /** 低/中分候选的 keep 门槛更宽：只有一部分旧背景回来就可能是前景/移动。 */
  cutFutureLowKeep: 210,
  /** 低分候选也要有参考背景模型才能做上面这次确认。 */
  cutFutureBuildMinScore: 12,

  /**
   * 运动中的切机位。
   *
   * 原 spike 要求 `s > 2.5 × max(前,后)`；机位切换前后都有人在动/镜头在摇时，
   * 前后分也很高，真切点反而被 2.5 倍卡掉（实测 117 分，前后 73/54，只到 1.6 倍）。
   * 这里额外允许“绝对分够高 + 比邻居高出一截”的台阶：
   *   0 = 关闭；默认 80 分、跳 12 分、至少 1.5 倍。
   */
  cutJumpAbs: 80,
  cutJumpMargin: 12,
  cutJumpRatio: 1.5,

  /**
   * 积分取帧（伪切点）：沿时间**累加画面变化量**，累够就录一帧、清零。
   *
   * 这就是 Storyboard 的算法，不是等间隔抽样。区别在于**阈值是固定的绝对值**：
   *
   *     need = REF_SCORE × fps × integralSeconds
   *
   * 画面动得快 → 每帧分高 → 很快累够 → 密集出帧；
   * 画面静止   → 每帧分趋近 0 → 永远累不够 → 一帧都不出。
   *
   * 早先这里是 `阈值 ∝ 平均变化量`（`motionExp` 那套），那样阈值永远跟着画面一起涨，
   * 结果**不管画面动得多快都是固定 N 秒一帧** —— 等于把积分退化成等间隔抽样，
   * 已经把 `motionExp` 删了。
   *
   * `integralSeconds` 的语义：**一段"中等强度"画面，攒够这么多秒才算一个采样点**。
   * 不是"每 N 秒取一帧"。
   */
  integralSeconds: 3,
  /** 两帧之间至少隔这么久 —— 这是"最快不超过半秒一帧"的**硬上限**，不是出帧节奏。 */
  markMinGap: 0.5,
  /** 画面完全静止时的兜底：这么久都没出帧就给一张，否则模型会一直拿到"没更新"。 */
  silentFloorSec: 20,
  /**
   * **按出帧节奏自适应**（比按活跃度更直接）：兜底 = clamp(k × 近期出帧间隔, floorMin, floorMax)。
   *
   * 为什么按间隔而不是按活跃度：分数高的地方本来就会连续出帧，低谷期才需要兜底；
   * 而"平时 2 秒一张、突然 8 秒没动静"正是该补一张的信号。
   * 静态画面下近期间隔会被拉长到 floorMax，等价于旧行为。
   *
   * 0 = 关闭（用固定 silentFloorSec）。
   */
  floorGapK: 0,
  /**
   * 自适应兜底的上下界（秒）。**必须给默认值**：`PACES` 里三档都显式传了，
   * 但直接 `createPipeline({floorGapK: 2})` 时它们是 undefined，
   * `Math.min(undefined, …)` 得到 NaN → `elapsed >= NaN` 永远 false →
   * **兜底帧一帧都不会出**（画面静止时就再也不给图了）。这种静默坏死最难查。
   */
  floorMin: 2,
  floorMax: 20,
  /** 和上一张留下的帧差小于这个分就不留（0–255 刻度，见 cuts.js）。 */
  dupMin: 8,

  /**
   * 打分口径：'abs' = 逐格 HSV 差均值（历史行为）；'mc' = 运动补偿后的"变了多少格"占比（×255）。
   *
   * mc 的用处是**把"整屏在动"和"换画面"分开**：游戏/高速画面里前者会把 abs 分数顶满，
   * 而 mc 只统计"邻域里找不到对应"的格子，运动被吸收掉。实测（storyboard 侧，同一判定）
   * 短视频 69.8→74.4、纪录片 86.1→89.4。
   *
   * 默认 'abs'：阈值（cutAbs / 积分 / 下限）都是按 abs 刻度标定的，切到 mc 需要重新标定。
   */
  scoreMode: 'abs',
  mcTau: 15,
  mcRadius: 2,
  /**
   * 亮度归一 + 黑边补偿（`cuts.js` 的 `normalizeScore`）：把绝对分换算到"参考亮度、
   * 无黑边"的刻度上，让 `cutAbs: 12` 在夜戏和亮画面里指的是同一件事。
   *
   * **默认开**，理由有证据：暗场真切点只有约 5 分（门槛 12 永远够不着），2.39:1 的片子
   * 加黑边后硬切命中数掉两成。亮场（V ≥ REF_V）gain 恒等于 1、无黑边时 barFrac = 0，
   * **逐位返回原分数** —— 也就是说这个开关对正常素材是 no-op。
   *
   * `false` = 完全回到没有它的行为（回滚通道，`~/.dsh/see-now.json` 的
   * `"scoreNormalize": false`）。只影响 `scoreMode: 'abs'`；`mc` 是另一套刻度，不动。
   */
  scoreNormalize: true,

  // 档位
  dtFrames: 12,
  smoothFrames: 6,
  strategy: 'native',
  /**
   * **积分假切点的档位加成**（照抄 storyboard 的 `MARK_BOOST`，但加了帧数门槛）。
   *
   * 真切点是"换镜头"，假切点是"这一段一直在变、攒够了才切"——后者没有硬边界，
   * 一帧代表不了多久，所以给**更小的格子**（档位数字越大格子越小，1/k²）。
   *
   * ## 为什么不能像 storyboard 那样无条件加
   *
   * storyboard 是批量出图，压小档位还有 `fillGaps` 补位；实时是逐帧追加，压小就散。
   * 实测同一段 30 秒素材：
   *
   * | 帧密度 | boost=2 | boost=0 |
   * |---|---|---|
   * | 稀（4.5 帧/张） | fill 63% | **fill 94%** |
   * | 密（5 帧/张）   | **1296 token/分 · 43/帧** | 1728 token/分 · 58/帧 |
   *
   * 帧稀的时候压档是白扔画布（格子小了一圈，帧数没多）；帧密的时候压档才真的
   * 多塞帧、省 token（每张 216 token 是固定的，塞 5 帧比塞 4 帧便宜 26%）。
   *
   * 所以加成只在"这张图有 `boostMinFrames` 帧以上"时才生效 —— 这个判断放在
   * `flush()` 里，因为那时才知道最终几张。
   */
  markBoost: 2,
  /** 兜底帧也压一档：它是"实在没东西可看，凑一张"，不该占大格子。 */
  floorBoost: 1,
  /** 满这么多帧才应用上面两项加成（帧太少时压档只会浪费画布）。 */
  boostMinFrames: 4,

  // 截断
  maxWaitSec: 15,
  flushGain: 0.015,
  maxFrames: 40,
  /**
   * 箱子代价。**实时场景必须远大于 1**：
   * storyboard 是批量出图，多开一张只是多花一张图（默认 222 token）；实时一次只发一张，
   * 「排成两张」等于把半张图扔掉。默认 1.02 会让「两个 1 档帧」直接判成两张各 100%
   * （实测：25 秒素材出 9 张，每张 1 帧）。给到 1000，DP 就只会往一个箱子里压。
   */
  binCost: 1000,
  /** 出图队列深度。0 = 不丢（离线跑用），线上是 1：宁可丢老画面，不给模型看十几秒前的事。 */
  queueDepth: 1,
  /** 只发一帧就截断。刚开/刚换清晰度时用：让模型马上拿到"现在是什么"，不用等攒满一张。 */
  oneShot: false,
  /**
   * 图底下那条音轨（响度柱 + 切点刻度）。
   *
   * `audio` 是取数回调 `{levels(wallFrom, wallTo) → {step, db[]}}`，由 runner 从
   * 听声音那条链接过来；没有它就只能画刻度、画不出柱子。`false` = 彻底不要。
   *
   * 代价：条高 = 画面占行后剩下的余量（450 余 12、600 余 30），**不跨行**所以 token 不涨。
   */
  audioStrip: true,
  audio: null,
});

/**
 * 参考强度（0–255 刻度）：一段"中等强度"画面每帧的变化分。
 *
 * 标定自本机素材（`scripts/sim.mjs` 打印的"运动强度"就是它）：
 *   真屏幕静止      0（完全不动，分数就是 0）
 *   合成动画素材    4.4 / 5.5
 *   网页滚动、视频  8–20（估计，下同）
 *   快速切窗口      40+
 *
 * 所以取 4：轻微运动能出帧，完全静止仍然出不了 —— 这才是积分该有的样子。
 * （取 8 时那两支素材要 4.4 秒才够一个采样点，实测 30 秒只出 3 帧，太稀。）
 */
export const REF_SCORE = 4;

export function createPipeline(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { width, height, fps } = o;

  /**
   * region 模式（只抓一块竖屏窗口）：`o.region` 存在时走一套独立的几何。
   *
   * 此时 `width/height` 的语义变成**单格尺寸**（runner 用 layout.cellSize 按
   * 「长边 = 档位长边」算好后传进来），不是整张画布的尺寸 —— 画布尺寸要等
   * 出图时按实际帧数（2 帧 2×1 / 4 帧 2×2）才算得出来。
   * 为 null 时整条老路径（pack 的 DP + coverInto + 16:9 常量）一行不变。
   */
  const regionAspect = o.region ? o.region.w / o.region.h : null;

  const scorer = createScorer({
    width, height, scoreMode: o.scoreMode, mcTau: o.mcTau, mcRadius: o.mcRadius,
    gateMcRadius: o.cutMcRadius, bgWindow: o.cutBgWindow, bgModel: o.cutFutureDelay > 0,
    bgRefWindow: o.cutFutureDelay > 0 ? o.cutFutureRefWindow : 0,
    futureMinScore: o.cutFutureDelay > 0
      ? Math.min(o.cutFutureMinScore, o.cutFutureBuildMinScore)
      : o.cutFutureMinScore,
    scoreNormalize: o.scoreNormalize,
  });
  const tiers = createTiers({
    fps, dtFrames: o.dtFrames, smoothFrames: o.smoothFrames,
  });

  let q = [];                  // 待判的帧（未来帧确认时最多 ~delay*fps 帧）
  let lastScore = null;
  let acc = 0;                 // 积分累加
  let lastCut = -Infinity;
  let lastBound = -Infinity;
  /** 近期"出帧间隔"的滑动平均（按节奏自适应兜底用） */
  let gapEwma = 0;
  let lastKeepT = null;
  let lastSeen = null;         // 最近解出来的一帧（插话时如果本张是空的，拿它兜底）
  let sheetStart = 0;          // 本张第一帧的时刻（maxWaitSec 从这儿算）

  let lastKeptHsv = null;      // 上一张留下来的帧（去重基准）
  /** 上一张留下来的**原始像素**，算「相对上一格变了多少面积」用（不复用 hsv 那套：那是 64×36 的格子）。 */
  let lastKeptBuf = null;
  /** 字幕带模式下，上一条真正出过的带子（跨批去重基准，见 flushBand）。 */
  let lastBandStrip = null;
  let frames = [];             // 本张待发
  let sheets = [];
  /**
   * 切点时刻（相对秒）。只在图上画刻度用 —— `log` 里也有，但那个是离线标定用的全量记录，
   * 长期跑会一直涨；这里只留切点，几百个顶天了。
   */
  const cutTimes = [];
  const log = [];              // 每一帧为什么留下（离线标定用）

  const stats = {
    frames: 0, kept: 0, cuts: 0, marks: 0, floors: 0, dupSkipped: 0,
    sheets: 0,
    scoreSum: 0, scoreN: 0, scoreMax: 0,
    /** 多箱兜底触发次数（>0 说明调用方没切干净，画面会被丢帧而不是糊掉） */
    overflow: 0,
  };

  /**
   * 积分阈值：**固定的绝对值**，不随画面变化。
   *
   *     need = REF_SCORE × fps × integralSeconds
   *
   * REF_SCORE 是「中等强度画面每帧的变化分」（8 是标定出来的中位数，0–255 刻度）。
   * 于是一段中等画面要攒 integralSeconds 秒才够一个采样点；画面比它动得快就更快累够，
   * 比它静就永远累不够 —— 这才是"运动多给几帧"，而不是固定 N 秒一帧。
   */
  function integralNeed() {
    return REF_SCORE * fps * o.integralSeconds;
  }

  function keep(entry, via) {
    // 去重：和**上一张留下来的帧**太像就不留。一镜到底的素材没有切点，积分会被
    // 雨点/树叶/传感器噪声推着一直触发，25 秒能留 9 张几乎一样的画面。
    // cut / floor 不过这道闸：切点本来就是新画面，floor 是兜底不能吞。
    let dup = null;
    if (lastKeptHsv && entry.hsv) dup = scorePair(lastKeptHsv, entry.hsv);
    if (dup !== null && dup < o.dupMin && via !== 'cut' && via !== 'floor') {
      stats.dupSkipped += 1;
      return false;
    }
    tiers.mark(entry.t);
    const lv = tiers.levelAt();
    // 这里**只按密度给档位**，不加假切点加成 —— 加成要等出图时按最终帧数决定
    // （见 DEFAULTS.markBoost 的实测表）。keep 阶段用它判断"装不装得下"，
    // 用不带加成（更大）的档位是保守的：判装不下而实际装得下，顶多多开一张，不会丢帧。
    const tier = applyStrategy([lv], o.strategy)[0];
    if (frames.length === 0) sheetStart = entry.t;
    /**
     * **变化面积**：相对上一张留下来的帧，不是相对相邻帧。
     *
     * 相邻帧只隔一个采样周期（12fps 时 83ms），静止画面上它接近 0，说明不了
     * 「这一格相对上一格变了多少」；一张图里格子隔几秒，那个差才是读图方要的。
     * 代价也不一样：相邻帧每帧都要算（12 次/秒），这里只算留下来的帧（一张图 3–8 次）。
     *
     * 拿不到上一张（本场第一帧）或尺寸变了（换档）就不给数，见 `changedArea`。
     */
    const area = lastKeptBuf ? changedArea(lastKeptBuf, entry.buf) : null;
    frames.push({ t: entry.t, buf: entry.buf, tier, via, level: lv, wall: entry.wall, area });
    lastKeptBuf = entry.buf;
    if (entry.hsv) {
      lastKeptHsv ??= new Float32Array(entry.hsv.length);
      lastKeptHsv.set(entry.hsv);

    }
    log.push({
      t: +entry.t.toFixed(2), via, level: lv, tier, score: +(entry.score ?? 0).toFixed(1),
      dup: dup === null ? null : +dup.toFixed(1),
      /**
       * 补偿的中间量。**标定必须看得见它**：只看到 `score` 就分不清"切点多是因为门槛低"
       * 还是"因为 gain 把分数顶上去了"，而这两个的修法完全不同。
       */
      raw: entry.raw === null || entry.raw === undefined ? null : +entry.raw.toFixed(1),
      gain: entry.gain === undefined ? null : +entry.gain.toFixed(2),
      bar: entry.bar === undefined ? null : entry.bar,
    });
    lastBound = entry.t;
    if (via === 'cut') cutTimes.push(+entry.t.toFixed(2));
    if (lastKeepT !== null) {
      const g = entry.t - lastKeepT;
      gapEwma = gapEwma === 0 ? g : gapEwma + (g - gapEwma) * 0.3;
    }
    lastKeepT = entry.t;
    stats.kept += 1;
    if (via === 'cut') stats.cuts += 1;
    else if (via === 'mark') stats.marks += 1;
    else if (via === 'floor') stats.floors += 1;
    // 一次性：留下第一帧就立刻发，不等判据
    if (o.oneShot && frames.length === 1) { o.oneShot = false; flush(entry.t, 'oneshot'); return true; }
    checkFlush(entry.t);
    return true;
  }

  /**
   * 当前这批帧的排布预案。
   *
   * **必须和 `flush()` 用同一个档位口径**（都走 `seqOf`）。早先用 `f.tier`（不带加成）
   * 判断容量，结果是"第 4 帧一到就判装不下 → 提前封箱"，加成永远追不上，
   * 实测帧密场景还是 4 帧/张、token/分一点没省。
   */
  function plan() {
    return solve(seqOf(frames), { binCost: o.binCost });
  }

  function checkFlush(t) {
    if (frames.length === 0) return;

    /**
     * region 模式：不走 pack 的装箱判定 —— 那套是为「一张图塞多帧、格子随密度变小」
     * 设计的，竖屏一格一帧用不上，硬套还会因为 `bins > 1` 误触发截断。
     *
     * 这里只决定**几张出一张图**：
     *   硬上限 4 —— 6 帧就要 3×2 或 6×1，后者长宽比 3.4，今天实测就是它糊掉的；
     *   期望 2   —— 竖屏 2 帧并排 = 1.125，最接近 1:1。
     *
     * `regionAspect === null` 时这段**不可达**，普通路径一个字节不动。
     */
    if (regionAspect) {
      const cap = Math.max(1, Number(o.maxFrames) || 4);
      const prefer = Math.min(cap, Math.max(1, Number(o.preferFrames) || 2));
      if (frames.length >= cap) { flush(t, 'cap'); return; }
      if (frames.length >= prefer) { flush(t, 'prefer'); return; }
      // 只有一帧时等兜底。**region 单独封顶 30 秒**：0.0.8 的 action 档把
      // `maxWaitSec` 设到 60，×2 = 120 秒 —— 拿这个抓「用户想让我看的东西」，
      // 举着不动两分钟才给一张图就废了。30 秒够判断静止，普通路径的 maxWaitSec 不动。
      const singleWait = Math.min(30, o.maxWaitSec * 2);
      if (frames.length === 1 && t - sheetStart >= singleWait) { flush(t, 'time'); return; }
      return;
    }

    const p = plan();

    // 硬：装不下了。**从末尾退到真装得下为止**，退出来的留给下一张（保序、不丢帧）。
    //
    // 旧写法是"退一帧"，实测也是对的 —— 因为它依赖 `boostMinFrames=4` 与
    // "4 个 1 档装得进一张"刚好咬住（见 `splitOneBin` 的注释）。这里换成显式规则：
    // 不依赖那两个数字，改加成参数也不会静默交出一张糊图。
    if (p.bins > 1) {
      const segs = splitOneBin(seqOf(frames), { binCost: o.binCost });
      const keep = segs[0].length;
      const carry = frames.slice(keep);
      if (carry.length === 0) { flush(t, 'full'); return; }   // 兜底：不该发生
      frames = frames.slice(0, keep);
      flush(t, 'full');
      frames = carry;                  // 下一张的起点
      sheetStart = frames[0].t;
      lastBound = frames[frames.length - 1].t;
      return;
    }

    const last = p.cells[p.cells.length - 1];
    const cellArea = last ? last.w * last.h : 1;

    // 软：这一帧只占得到 1.5% 了（7 档 2.04% / 8 档 1.56%），再塞就是碎格
    if (frames.length >= 2 && cellArea < o.flushGain) {
      flush(t, 'crumb');
      return;
    }

    // 时间：从**这一张的第一帧**算起，不是从上一张算起。
    // 从上一张算的话，一张刚 flush 完 12 秒后来的那一帧会立刻被单独发出去（实测 3 张单帧图）。
    // 只有一帧时不按时间发：静态画面下等于每 15 秒扔一张单帧图（222 token 换一个没变）。
    // 等下一帧（兜底帧最晚 20 秒到）再走这张，两帧还能并排铺一半。
    // 单帧也有封顶：等满两倍 maxWait 还没等到第二帧，那就是没人来看了，发出去收工。
    //
    // **门槛是 3 帧不是 2 帧**：一张图固定 222 token，2 帧等于每帧 121 token，
    // 4 帧只有 58 —— 差一倍。少发一张、等第三帧，性价比直接翻倍（实测 0273 这类
    // 静止素材 2 帧/张 → 3 帧/张，token/帧 116 → 78）。
    if (frames.length >= 3 && t - sheetStart >= o.maxWaitSec) {
      flush(t, 'time');
      return;
    }
    /**
     * **两帧也要有时间出口**。
     *
     * 静止画面只有兜底帧：第一帧在 0s、第二个兜底帧在 20s，若继续等第三帧，
     * 首图会拖到 40s（README 写的是“静止 20 秒给一张”）。这里到 `maxWaitSec`
     * 就发两帧：token/帧比三帧贵，但“一直不回来”比贵更不能接受。
     */
    if (frames.length >= 2 && t - sheetStart >= o.maxWaitSec) {
      flush(t, 'time');
      return;
    }
    if (frames.length === 1 && t - sheetStart >= o.maxWaitSec * 2) {
      flush(t, 'time');
      return;
    }

    if (frames.length >= o.maxFrames) flush(t, 'cap');
  }

  /**
   * 给一张已经拼好的图接上音轨条（响度柱 + 切点刻度）。
   *
   * **尺寸必须恒定**：只要 `audioStrip` 没关就画，哪怕这一刻还没有音量数据
   * （刚启动、或者用户根本没开音频）。否则同一档清晰度的图会时高时低，
   * 模型那边的 token 预算就没法估了 —— 而省下这 20 token 远比"尺寸不可预测"不值。
   * 没有响度时条上只剩切点刻度，那也是有用的信息。
   *
   * 时间轴：条上的 x 用 `from..to`（相对秒，和格子里烧的编号同一套），
   * 响度序列用 `wall` 去取 —— 音频只有墙上时间，`t` 掉帧会漂。
   */
  /**
   * 这一档要不要画音轨条，以及它有多高。
   *
   * **region 模式永远不加条**：那里的画布是"一小块窗口"（竖屏时 800×450、更窄的只有 200 宽），
   * 按宽度比例算的条会吃掉 10% 以上，而 region 的用途是"把这块看清"，不是看视频节奏。
   */
  function stripHeightFor() {
    if (o.audioStrip === false || regionAspect) return 0;
    return stripHeight(width, height);
  }

  /** 取这一张时间窗里的响度与切点（没有音频链路时只返回切点）。 */
  function audioOf(first, last) {
    const lv = (first.wall && last.wall && o.audio?.levels)
      ? o.audio.levels(first.wall, last.wall)
      : null;
    const cuts = cutTimes.filter((c) => c >= first.t && c <= last.t);
    return { loudness: lv, cuts, window: { from: first.t, to: last.t } };
  }

  /**
   * region 模式的出图：一帧一格，按 `gridRects` 摆成网格（2 帧 2×1 / 4 帧 2×2）。
   *
   * **源帧尺寸 === 单格尺寸**：采集时 ffmpeg 的 `scale=cellW:cellH` 已经按 region
   * 的比例等比缩放好了，所以这里把 `buf` **直接搬进格子**。
   * 绝不能再做一次 cover / scale —— 那会把「不拉伸」这个验收直接毁掉
   * （coverInto 是保持比例的裁边，喂进来的正好同比例，裁掉的就是画面本身）。
   */
  function flushRegion(batch, t, why) {
    const n = batch.length;
    const g = gridRects(n, width, height, regionAspect);
    const cells = batch.map((f) => ({ buffer: f.buf, w: width, h: height }));
    const img = composePacked({
      frames: cells, rects: g.rects, width: g.width, height: g.height, burn: 'index',
    });
    const png = encodePng(img.buffer, img.width, img.height, { level: 3 });
    if (o.queueDepth > 0 && sheets.length >= o.queueDepth) sheets.shift();
    const sheet = {
      at: t,
      from: batch[0].t,
      to: batch[n - 1].t,
      png,
      w: img.width,
      h: img.height,
      fill: 1,
      area: 1,
      bins: 1,
      why,
      strip: img.stripH ?? 0,
      wallFrom: batch[0].wall ?? null,
      wallTo: batch[n - 1].wall ?? null,
      frames: batch.map((f) => ({
        t: +f.t.toFixed(2), tier: 1, level: f.level, via: f.via, wall: f.wall ?? null,
        area: f.area ?? null,
      })),
      cells: g.rects.map((r) => ({ px: r.px, py: r.py, pw: r.pw, ph: r.ph, tier: 1 })),
    };
    sheets.push(sheet);
    stats.sheets += 1;
    return sheet;
  }

  /**
   * 字幕带参数：`[y0, y1, insetX?]`（高度比例，第三个是左右各让出的比例），
   * 或者 `'auto'` —— 每帧先**低分辨率找文本行**再裁（见 `detectTextBand`）。
   *
   * **为什么要让左右**：正常片子不会让字幕顶到画面两侧，左右各留 10% 是通行做法
   * （一行太长就按停顿分段）。把这两条空边一起裁掉，宽度从 1596 掉到 1277，
   * token 少 18%，而字幕一个像素都没少 —— 收的是本来就没有字的边。
   */
  function bandOf() {
    const b = o.band
    if (b === 'auto') return { auto: true, inset: 0.10 }
    if (!Array.isArray(b) || b.length < 2) return null
    const [y0, y1, insetX = 0] = b.map(Number)
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null
    if (y0 < 0 || y1 > 1 || y1 - y0 <= 0.01) return null
    const inset = Math.max(0, Math.min(0.4, Number.isFinite(insetX) ? insetX : 0))
    return { y0, y1, inset }
  }

  /** 字幕带是否生效。 */
  function bandOn() {
    return bandOf() !== null
  }

  /**
   * 字幕带的出图：每帧只留底部一条，按时间**从上到下叠**成一张长条图。
   *
   * 为什么不并排：一条字幕是横向长条，并排会拼出一张又宽又扁的图，
   * 读起来和一整屏没区别；竖着叠才是"一句话一行"，从上往下就是时间顺序。
   * 左右各让 `inset`（默认 10%），那两条边本来就没有字。
   *
   * `auto` 模式下先低分辨率找文本行（只留真有字的帧），再按找到的范围裁高分辨率原图 ——
   * 和 bilibili 那条链一样：**低分辨率判有没有、在哪，高分辨率只用来读字**。
   */
  function flushBand(batch, t, why) {
    const cfg = bandOf()
    const auto = cfg.auto === true
    const inset = cfg.inset
    const x0 = Math.min(Math.round(width * inset), width - 16)
    const bandW = Math.max(16, width - x0 * 2)
    /**
     * **同样的字幕只留一条**：兜底帧是固定节拍（2.5 秒），一句台词挂 4 秒就会被拍两次。
     *
     * 判据是整条逐字节相等 —— 只有画面完全静止时才会命中（视频里字幕背后的景一直在动，
     * 几乎不会）。留着是因为它零成本（一次几百 KB 的 memcmp），命中的那些
     * （静态截图、暂停的画面、UI 界面）能实打实省掉一行。
     */
    const picks = []
    let top = 0
    let rows = 0
    if (auto) {
      // 先定位：所有帧的文本行取并集，一张图里的每条带子必须同高才好对齐
      let lo = Infinity
      let hi = -1
      for (const f of batch) {
        const d = detectTextBand(f.buf, width, height)
        if (!d) continue // 这一帧没有字幕，直接不进图
        picks.push({ f, d })
        if (d.top < lo) lo = d.top
        if (d.top + d.rows > hi) hi = d.top + d.rows
      }
      if (!picks.length) return null // 整批都没有字：不出图，也没什么可看
      // 上下各留 20% 的余量（描边、下伸部），再把高度夹到画面的 4%–22%
      const pad = Math.round((hi - lo) * 0.2) + 4
      top = Math.max(0, lo - pad)
      rows = Math.min(height - top, Math.max(Math.round(height * 0.04), Math.min(Math.round(height * 0.22), hi - lo + pad * 2)))
    } else {
      top = Math.max(0, Math.round(height * cfg.y0))
      rows = Math.max(8, Math.min(height - top, Math.round(height * (cfg.y1 - cfg.y0))))
      for (const f of batch) picks.push({ f })
    }
    /**
     * **带内差分：没变的那一条不占行**。
     *
     * 原先靠"兜底帧 2.5 秒一拍 + 逐字节去重"，两个毛病：
     *  - 视频里字幕背后的景一直在动，逐字节永远不相等 → 同一句话占两行；
     *  - 反过来，站桩对话 / AVG 里画面完全不动，而"字没变"本来就不该再占一行。
     *
     * 改成和**上一条留下的带子**比（跨批比，不是只在批内比）：差到阈值以内就算同一条。
     * 于是——静止无字 → 一条都不出；AVG 换一行 → 只出一条；忙场景 → 和以前一样多，
     * 只是把重复的压掉了。判"有没有字"仍不归它管（那件事像素启发式做不到）。
     */
    const strips = []
    for (const { f } of picks) {
      const buf = cropRect(f.buf, width, height, x0, top, bandW, rows)
      const prev = strips.length ? strips[strips.length - 1].buffer : lastBandStrip
      if (prev && stripSimilar(prev, buf)) continue
      strips.push({ buffer: buf, w: bandW, h: rows, f })
    }
    if (!strips.length) return null
    lastBandStrip = strips[strips.length - 1].buffer
    const n = strips.length
    // 每格少 1px 由 composePacked 的 `seam` 吃掉，正好当分隔线 —— 这里不额外留间距。
    const outH = rows * n
    const cells = strips.map((s) => ({ buffer: s.buffer, w: s.w, h: s.h }))
    const rects = cells.map((c, i) => ({
      index: i + 1, px: 0, py: i * rows, pw: bandW, ph: rows, bin: 0, seq: i,
    }))
    const img = composePacked({ frames: cells, rects, width: bandW, height: outH, burn: 'index' })
    const png = encodePng(img.buffer, img.width, img.height, { level: 3 })
    // 队列深度：模型没跟上时丢最旧的（和整屏同一条规矩）
    if (o.queueDepth > 0 && sheets.length >= o.queueDepth) sheets.shift()
    const sheet = {
      at: t,
      from: strips[0].f.t,
      to: strips[n - 1].f.t,
      png,
      w: img.width,
      h: img.height,
      fill: 1,
      area: 1,
      bins: 1,
      why,
      band: [+(top / height).toFixed(3), +((top + rows) / height).toFixed(3), inset],
      strip: 0,
      wallFrom: strips[0].f.wall ?? null,
      wallTo: strips[n - 1].f.wall ?? null,
      frames: strips.map(({ f }) => ({
        t: +f.t.toFixed(2), tier: 1, level: f.level, via: f.via, wall: f.wall ?? null,
        area: f.area ?? null,
      })),
      cells: rects.map((r) => ({ px: r.px, py: r.py, pw: r.pw, ph: r.ph, tier: 1 })),
    }
    sheets.push(sheet)
    stats.sheets += 1
    return sheet
  }

  function flush(t, why) {
    if (!frames.length) return;
    const batch = frames;
    frames = [];
    // 字幕带模式：只出画面底部那一条，按时间从上到下叠。也不走 pack 的 DP。
    if (bandOn()) return flushBand(batch, t, why);
    // region 模式：一帧一格，不走 pack 的 DP（也不做任何二次缩放）
    // **必须 return** —— `flushNow()` 靠这个返回值拿图，返回 undefined 会让它
    // 清空了 sheets 却交不出图（插话时用户什么都看不到）。
    if (regionAspect) return flushRegion(batch, t, why);
    const seq = seqOf(batch);
    const p = solve(seq, { binCost: o.binCost });
    if (!p.cells.length) return;
    /**
     * **一张图只画一个箱子**。`solve` 允许跨箱（DP 里封箱是要付 `binCost` 的），
     * 而 `cells` 会带上所有箱的格子、只靠 `bin` 字段区分 —— 不过滤就画，
     * 第二箱的 y 从 0 重新开始，直接盖在第一箱上。
     *
     * 正常情况下调用方已经保证单箱（`checkFlush` / `finish` 都先切过），
     * 这里是最后一道闸：宁可少画几帧，也不能交一张糊在一起的图。
     */
    const kept = p.cells.filter((c) => c.bin === 0);
    const used = batch.slice(0, kept.length);
    if (used.length < batch.length) stats.overflow += 1;
    const rects = toRects(kept, { width, height, gutter: 0 });
    /**
     * 帧直接以 `{src, sw, sh}` 交给 `composePacked`：它内部用 `coverIntoAt`
     * 把每一帧缩进画布的对应格子。
     *
     * 旧链路是「每格 alloc 中间缓冲 → coverInto → blit 到画布」，等于每格多做
     * 一次 267KB 的分配和一次同样大小的拷贝；4 格图纯搬运就是 1MB。现在零中间缓冲。
     */
    const cells = used.map((f) => ({ src: f.buf, sw: width, sh: height }));
    const stripH = stripHeightFor();
    const img = composePacked({
      frames: cells, rects, width, height, burn: 'index', stripH,
    });
    // 音轨条：响度 + 切点刻度。**画布已经预留好高度**，这里是就地填底部，
    // 不再额外分配 + 拷贝一整张图（省 1.1MB/张）。
    if (stripH) drawAudioStrip(img.buffer, img.width, img.height, height, audioOf(used[0], used[used.length - 1]));
    const png = encodePng(img.buffer, img.width, img.height, { level: 3 });
    // 占用率按**这张图上真有的格子**算：单箱时与 `p.area / p.bins` 完全等价
    const area = kept.reduce((acc, c) => acc + c.w * c.h, 0);

    // 队列深度：模型没跟上时丢最旧的 —— 宁可丢老画面，不给模型看十几秒前的事
    if (o.queueDepth > 0 && sheets.length >= o.queueDepth) sheets.shift();
    sheets.push({
      at: t,
      from: used[0].t,
      to: used[used.length - 1].t,
      png,
      w: img.width,
      h: img.height,
      fill: area,
      area,
      bins: 1,
      why,
      strip: img.stripH ?? 0,
      // 台词对齐用的墙上时间窗（epoch ms）。`from/to` 是相对秒，掉帧会漂；这两个不会。
      wallFrom: used[0].wall ?? null,
      wallTo: used[used.length - 1].wall ?? null,
      frames: used.map((f, i) => ({
        t: +f.t.toFixed(2), tier: seq[i], level: f.level, via: f.via, wall: f.wall ?? null,
        area: f.area ?? null,
      })),
      cells: rects.map((r) => ({ px: r.px, py: r.py, pw: r.pw, ph: r.ph, tier: r.t })),
    });
    stats.sheets += 1;
    return sheets[sheets.length - 1];
  }

  /**
   * 出图时的真实档位序列：**在这里**才应用假切点加成。
   *
   * 为什么拖到这一步：加成该不该生效取决于"这张图最后有几帧"，而 `keep()` 那一刻
   * 根本不知道后面还会不会来帧。帧少时压档只会把画布压空（实测 fill 94% → 63%），
   * 帧多时压档才真的省 token（每张固定 216，5 帧比 4 帧便宜 26%）。
   */
  function seqOf(batch) {
    const on = batch.length >= Math.max(1, Number(o.boostMinFrames) || 4);
    // `Number(raw) || 0` 不是多余的：命令行 `--markBoost=0` 传进来是字符串 "0"，
    // `lv + "0"` 会变成 "10" 再被 clamp 成 8 档（实测把整张图打成 64 格碎格）。
    const boostFor = (via) => {
      if (!on) return 0;
      const raw = via === 'mark' ? o.markBoost : via === 'floor' ? o.floorBoost : 0;
      return Math.max(0, Number(raw) || 0);
    };
    return batch.map((f) => applyStrategy([Math.min(8, f.level + boostFor(f.via))], o.strategy)[0]);
  }

  /** 停住的大面积前景：外圈还是旧背景，且背景变化不到整片。 */
  function stillForeground(entry) {
    const guardY = entry.guardY ?? entry.activeY ?? 0;
    if (!entry.futureModel
      || !(guardY >= 0.25)
      || entry.bg === null
      || entry.bg <= 0
      || entry.bg >= 220) return false;
    const border = bgBorderChanged(entry.futureModel, entry.hsv, guardY);
    return border !== null && border.score < o.cutFutureBorderMax;
  }

  /** 低/中分但背景还有一块没被换掉、外圈也没动：可能是大手/产品挡住，也可能是真切。 */
  function lowAmbiguousFuture(entry) {
    if (o.cutFutureDelay <= 0
      || o.cutBgAbs <= 0
      || entry.score === null
      || entry.score >= o.cutFutureMinScore
      || !entry.futureModel
      || entry.bg === null
      || entry.bg <= 0
      || entry.bg >= o.cutFutureLowBgMax
      || (entry.bgStable ?? 0) > o.cutFutureLowStableMax) return false;
    const guardY = entry.guardY ?? entry.activeY ?? 0;
    if (!(guardY >= 0.25)) return false;
    // 外圈也被改变：可能是整屏前景，也可能是真切；只对这种情况做未来确认。
    const border = bgBorderChanged(entry.futureModel, entry.hsv, guardY);
    return border !== null && border.score >= o.cutFutureLowBorderMin;
  }

  function decide(entry, nextScore, nextMc = null, future = null) {
    const s = entry.score;
    if (s === null) { keep(entry, 'start'); return; }

    const px = entry.prev ?? 0;
    const nx = nextScore ?? 0;
    const base = Math.max(1, px, nx);
    const mcOkForSpike = o.cutMcAbs <= 0 || o.cutSpikeMcAbs <= 0
      || (entry.mc ?? 0) >= o.cutSpikeMcAbs;
    const spike = nextScore === null
      || (s > o.cutSpike * base && s >= o.cutSpikeAbs && mcOkForSpike);
    // 运动中的切机位：前后都在动时 spike 的 2.5 倍凑不出来，改用“台阶”
    const jump = s - base;
    const step = o.cutJumpAbs > 0
      && s >= o.cutAbs
      && s >= o.cutJumpAbs
      && jump >= o.cutJumpMargin
      && s >= o.cutJumpRatio * base;
    // 运动补偿：整屏在动但邻域里找得到对应 → 运镜；找不到对应 → 换镜头。
    // 半径 4 的 mc 比“绝对台阶”更直接：真实运动切机位 abs 只有 23 也能过。
    const mc = entry.mc ?? 0;
    const mcBox = entry.mcBox ?? 0;
    const mcFill = entry.mcFill ?? 0;
    const mcCut = o.cutMcAbs > 0
      && s >= o.cutMcMinScore
      && mc >= o.cutMcAbs;
    // 相似构图/相似主体的弱切点：低于 cutAbs，但几乎孤立
    const isolated = o.cutIsolatedAbs > 0
      && nextScore !== null
      && (o.cutMcAbs <= 0 || nextMc === null || nextMc < o.cutMcAbs)
      && (o.cutIsolatedMcAbs <= 0 || mc >= o.cutIsolatedMcAbs)
      && (o.cutIsolatedMcBBox <= 0 || mcBox >= o.cutIsolatedMcBBox)
      && (o.cutIsolatedFill <= 0 || mcFill >= o.cutIsolatedFill)
      && s >= o.cutIsolatedAbs
      && s < o.cutAbs
      && s > o.cutIsolatedSpike * base;
    // 前景运动不是切镜头：稳定背景大部分还在，且变化区域没盖满高度。
    // 只看低/中分事件；孤立弱切点另有区域门槛，不在这里误伤。
    const bg = entry.bg;
    const guardY = entry.guardY ?? entry.activeY ?? 0;
    const fgMotion = o.cutBgAbs > 0
      && s < o.cutBgMaxScore
      && !isolated
      && (o.cutBgMinCells <= 0 || (entry.bgStable ?? 0) >= o.cutBgMinCells)
      && bg !== null
      && bg > 0
      && bg < o.cutBgAbs
      && (o.cutBgMaxChanged <= 0 || (entry.bgChanged ?? 0) <= o.cutBgMaxChanged)
      && guardY >= 0.25
      && (o.cutBgMaxSpanY <= 0
        || (guardY > 0
          ? (entry.mcSpanY ?? 1) / guardY
          : (entry.mcSpanY ?? 1)) < o.cutBgMaxSpanY);
    // 高分候选不能只靠当前帧：等 0.5 秒，看候选帧改掉的稳定背景有没有回来。
    // 大面积前景运动离开/移开 -> keep 低；真正换镜头 -> 新场景还在，keep 高。
    let futureFg = false;
    const lowFuture = lowAmbiguousFuture(entry);
    if (o.cutFutureDelay > 0
      && entry.futureModel
      && (s >= o.cutFutureMinScore || lowFuture)) {
      const fk = future && future.hsv
        ? bgKeep(entry.futureModel, entry.hsv, future.hsv)
        : null;
      const rk = entry.prevHsv
        ? bgKeep(entry.futureModel, entry.prevHsv, entry.hsv)
        : null;
      const keepLimit = lowFuture ? o.cutFutureLowKeep : o.cutFutureKeep;
      const gone = (r) => r && r.score !== null
        && r.changed >= o.cutFutureMinChanged
        && r.score < keepLimit;
      // 前景停住时外圈通常还是旧背景：背景变化不算整片，外圈几乎没动，
      // 就不要等未来帧回来。真正换镜头 bg 很高，不会被这条挡住。
      futureFg = gone(fk)
        || (!lowFuture && gone(rk))
        || (s >= o.cutFutureMinScore && stillForeground(entry));
    }
    if (entry.t - lastCut >= o.cutMinGap
      && !fgMotion
      && !futureFg
      && (mcCut || (s >= o.cutAbs && (spike || step)) || isolated)) {
      lastCut = entry.t;
      acc = 0;                      // 切点之后重新攒（那一帧的分属于跨刀，不算运动）
      keep(entry, 'cut');
      return;
    }

    acc += s;
    if (acc >= integralNeed() && entry.t - lastBound >= o.markMinGap) {
      // 只有**真的录进去**才清零。被去重挡掉时保留累积值 —— 否则这一段的运动量
      // 白攒了，下一个采样点要重新等一整轮（实测会让出帧间隔凭空翻倍）。
      if (keep(entry, 'mark')) { acc = 0; return; }
      /**
       * **被去重挡掉时不能直接 return**（2026-11-08 长跑实锤）。
       *
       * 静止画面里那点微小变化（光标闪、时钟跳、状态灯）每帧都在攒积分：攒够了
       * 就被 mark 拿走、又因为和上一张太像被去重挡回。以前这里 return，于是
       * 下面的 floor 兜底永远轮不到 —— 实测 347 秒一张图都没留下，而记录里
       * 那张图的时间跨度就是这个空洞（`missed.jsonl` 的 gap 行看不见）。
       * 落到下面继续走 floor 判据。
       */
    }
    let floorSec = o.silentFloorSec;
    if (o.floorGapK > 0 && gapEwma > 0) {
      floorSec = Math.min(o.floorMax, Math.max(o.floorMin, o.floorGapK * gapEwma));
    }
    if (entry.t - lastBound >= floorSec) keep(entry, 'floor');
  }

  return {
    /** 喂一帧。`buf` 必须是 width*height*3 的 rgb24。 */
    push({ t, buf }) {
      stats.frames += 1;
      tiers.tick(t);
      const r = scorer(buf);
      const s = r.score;
      if (s !== null) { stats.scoreSum += s; stats.scoreN += 1; if (s > stats.scoreMax) stats.scoreMax = s; }
      // `wall` 是这一帧被处理时的墙上时间（epoch ms）。台词（ASR）只有时间码没有帧号，
      // 对齐只能靠同一个时钟 —— `t` 是"第几秒"，掉帧就漂，不能拿来对字幕。
      const entry = {
        t, buf, score: s, raw: r.rawScore, gain: r.gain, bar: r.barFrac, mc: r.mcScore, mcBox: r.mcBox, mcFill: r.mcFill, mcSpanY: r.mcSpanY, activeY: r.activeY, guardY: r.guardY, bg: r.bgScore, bgStable: r.bgStable, bgChanged: r.bgChanged, bgModel: r.bgModel, futureModel: r.futureModel, prevHsv: r.prevHsv, prev: lastScore, hsv: Float32Array.from(r.hsv), wall: Date.now(),
      };
      lastSeen = entry;
      lastScore = s;
      q.push(entry);
      while (q.length >= 2) {
        const front = q[0];
        if (front.score === null) {
          decide(front, q[1].score, q[1].mc, null);
          q.shift();
          continue;
        }
        const needFuture = o.cutFutureDelay > 0
          && ((front.score >= o.cutFutureMinScore && !stillForeground(front))
            || lowAmbiguousFuture(front));
        const future = o.cutFutureDelay > 0
          ? q.find((e) => e !== front && e.t - front.t >= o.cutFutureDelay) ?? null
          : null;
        if (needFuture && !future) break;
        decide(front, q[1].score, q[1].mc, future);
        q.shift();
      }
      /**
       * 静态画面兜底：整屏完全不动时，`decide()` 不会留下任何新帧（floor 帧也被去重挡掉），
       * 于是 `checkFlush` 永远等不到下一次 keep —— 一张图的时间跨度会被拉到分钟级
       * （2026-11-08 实测：347 秒一张、中间一个画面都没有，`missed.jsonl` 里看不见）。
       *
       * 帧本身是 12fps 连续进来的，所以在每帧末尾问一次"这一批是不是到期了"。
       * 只在有帧时问；空批次没事可发（`flush` 自己也会挡）。
       */
      if (frames.length) checkFlush(t);
    },

    /** 流结束：把还剩的那一帧判掉，再把最后一张发出去。 */
    finish() {
      while (q.length) {
        const front = q[0];
        const future = o.cutFutureDelay > 0
          ? q.find((e) => e !== front && e.t - front.t >= o.cutFutureDelay) ?? null
          : null;
        decide(front, q.length > 1 ? q[1].score : null, q.length > 1 ? q[1].mc : null, future);
        q.shift();
      }
      // 收尾这批也要**一段一箱**：多箱多半出现在最后（帧都攒在尾部），
      // 直接发就会把两箱画到一张画布上。
      let guard = 0;
      while (frames.length && guard < 64) {
        guard += 1;
        const segs = splitOneBin(seqOf(frames), { binCost: o.binCost });
        if (segs.length <= 1) { flush(lastBound, 'end'); break; }
        const keep = segs[0].length;
        const carry = frames.slice(keep);
        frames = frames.slice(0, keep);
        flush(frames[frames.length - 1].t, 'end');
        frames = carry;
      }
      return { stats, sheets };
    },

    /**
     * **立刻截断出图**。用户插话走这条：不等判据，也不排队。
     *
     * 本张是空的（刚发完）就把「最近解出来的那一帧」塞进去 —— 用户问的是现在屏幕上是什么，
     * 给一张空图或者十几秒前的图都不对。
     *
     * @returns {object|null} 这一张（同时清空队列，插话永远拿最新的）
     */
    flushNow(t = null, why = 'user') {
      // **永远把「此刻那一帧」补进去**，不只是本张为空时。
      // 用户问的是"现在屏幕上是什么"，只给他攒了半张的旧帧不对（实测插话在 30s，
      // 图里最后一帧是 26.5s，差了三秒多）。
      if (lastSeen && (!frames.length || lastSeen.t > frames[frames.length - 1].t + 1e-6)) {
        const lv = tiers.levelAt();
        tiers.mark(lastSeen.t);
        if (!frames.length) sheetStart = lastSeen.t;
        /**
         * 插话帧也补上变化面积：这条路径**绕过了 `keep()`**，不补就是"最该说清楚的那一格
         * 反而没有数"。基准仍是上一张留下来的帧 —— 用户问的是"跟刚才比变了什么"。
         */
        const area = lastKeptBuf ? changedArea(lastKeptBuf, lastSeen.buf) : null;
        if (lastSeen.buf) lastKeptBuf = lastSeen.buf;
        frames.push({
          t: lastSeen.t, buf: lastSeen.buf, via: why === 'user' ? 'user' : 'now', level: lv,
          tier: applyStrategy([lv], o.strategy)[0],
          area,
          // 「此刻那一帧」也要带 wall —— 漏了它，`sheet.wallTo` 会是 null，
          // 台词就按 `Date.now()` 兜底，时间窗对不上（实测最后一张的台词取不到）
          wall: lastSeen.wall ?? Date.now(),
        });
      }
      // 装不下就从**最老的**开始丢：插话要的是最新画面，老的让位
      if (regionAspect) {
        // region 模式没有"装箱"这回事（一帧一格），只按硬上限截断。
        // **不能调 plan()**：`plan()` 是 pack 的 DP，在 region 模式下算出来的
        // bins 没有意义，误判会白丢帧。
        const cap = Math.max(1, Number(o.maxFrames) || 4);
        while (frames.length > cap) {
          frames.shift();
          sheetStart = frames[0].t;
        }
      } else {
        while (frames.length > 1 && plan().bins > 1) {
          frames.shift();
          sheetStart = frames[0].t;
        }
      }
      if (!frames.length) return null;
      const at = t ?? frames[frames.length - 1].t;
      const made = flush(at, why);
      sheets.length = 0;
      return made ?? null;
    },

    /** 取走队列里最老的一张（阻塞语义由调用方实现）。 */
    take() {
      return sheets.shift() ?? null;
    },

    peek() {
      return sheets[0] ?? null;
    },

    /** 手上有没有"最近解出来的那一帧"（插话时先看这个，别急着给空手） */
    get hasFrame() { return lastSeen !== null; },

    /** 本批第一帧到现在多久（唤醒文案要说"这段时间有多长"） */
    get secondsSinceWake() {
      if (frames.length && lastSeen !== null) return +(lastSeen.t - sheetStart).toFixed(1);
      // 兜底：本批已经 flush 成一张、累加器是空的 —— 队列里那张就是「这一张」，
      // 用它自己的时间窗。没有这行，唤醒文案会显示成「攒了 ? 秒」（2026-11-08 实报）。
      const s = sheets[sheets.length - 1];
      if (s && Number.isFinite(s.from) && Number.isFinite(s.to)) {
        if (s.to > s.from) return +(s.to - s.from).toFixed(1);
        // 单帧兜底图（静止画面 30 秒一张）from === to：报它等了多久更有意义，
        // 报 0 秒等于告诉模型"这一张攒了 0 秒"，比 ? 秒还费解。
        if (Number.isFinite(s.at)) return +Math.max(0.1, s.at - s.from).toFixed(1);
        return 0;
      }
      return null;
    },

    get pending() { return sheets.length; },
    get log() { return log; },
    get stats() { return stats; },
    get tiers() { return tiers; },
    constants: o,
  };
}
