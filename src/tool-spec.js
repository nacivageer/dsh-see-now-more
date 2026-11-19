/**
 * tool-spec.js — `see_now` 的契约。
 *
 * **注意 `parameters` 的形状**：它是「属性名 → 值 schema」的映射，不是完整的 JSON Schema。
 * 写成 `{ type:'object', properties:{...} }` 会被宿主拒绝：
 * `unsupported JSON schema: parameters.type must be a value schema object`。
 * （`output.schema` 反而是完整 JSON Schema —— 两个形状不一样，别抄错。）
 *
 * 参数**写成什么样，模型就会怎么用**。所以：
 * - 决策类的规则留在 description（什么时候调、要不要等、`say` 必须带）；
 * - 单个参数的规则（默认值、取值范围、配对）留在那个参数上，别在 description 里复述；
 * - 枚举值走 `enum`，别只写在散文里 —— 宿主按 enum 校验，模型也直接看到候选；
 * - `default` 只是注释（宿主不替你填默认值），写出来是为了不用在句子里解释默认档。
 *
 * **体积是有预算的**：这份定义每一步都在宿主的工具前缀里重发，按 2026-11-17 的账，
 * 每 1,000 token ≈ 全历史 ¥1.4。`test/tool-spec.test.mjs` 里有一条上限断言挡着，
 * 加参数/加长文之前先看那一条。实测数据、档位推导过程属于 docs，不属于这里。
 */

/**
 * 这个工具**最长能被宿主挂多久**（毫秒）。
 *
 * 由宿主的 `dsh-tool-call-timeout-policy` 强制执行：到点不是"返回一张图"，
 * 而是整条调用变成 `tool call timed out after Nms`，并且 `exec.signal` 一起 abort。
 *
 * **必须明显大于 `seconds` 的默认值**：这里曾经写 120_000，而 `seconds` 默认 300 ——
 * 静止屏幕上第 120 秒必定超时（`index.js` 又把超时当"这一轮被取消"）。
 * 陪看那边是 900_000。
 */
export const TOOL_TIMEOUT_MS = 900_000;

/** `seconds` 的默认值：只是**上限**，攒够一张就提前返回。 */
export const DEFAULT_BLOCK_SEC = 300;

/** 工具名。注册日志、报错文案、测试都从这里取，别各处再写一遍字符串。 */
export const TOOL_NAME = 'see_now';

/**
 * `action` 的全部取值。
 *
 * 三处共用：`enum`（宿主校验 + 模型看到的候选）、`index.js` 认不出动作时的提示、
 * 单测（每个值都必须有分支）。少一个值的后果是实的：`lift` 一度只在 description
 * 里出现、不在这个列表里，于是 `index.js` 的兜底提示教模型「可用 watch / peek /
 * start / stop / status」—— 唤醒文案刚好在叫它调 `lift`。
 */
export const ACTION_VALUES = Object.freeze([
  'watch', 'peek', 'listen', 'lift', 'start', 'stop', 'status', 'window', 'region', 'bloodbar',
]);

export function seeNowToolSpec() {
  return {
    name: TOOL_NAME,
    description:
      'See what is on the user\'s screen **now**, as one image made of several frames, and talk to them '
      + 'through the floating window. Frames are picked by how much the picture changes, so a still screen '
      + 'costs almost nothing.\n\n'
      + '- `action:"watch"` (default) is the normal way to watch: the first call returns the current screen '
      + 'in about a second, then blocks until a sheet is ready (15–40s while the screen changes, longer when '
      + 'it is still) or the user types in the floating window. **Call it again right after you reply** — the '
      + 'blocking call IS the pause; the conversation never ends between sheets. Do not end your turn while '
      + 'the user is still watching.\n'
      + '- If you stop calling `watch`, capture keeps running and you get woken when a sheet piles up (then '
      + '`peek`). Everything stops when the user closes the floating window, and that note is final — do not '
      + 'call `see_now` again until the user asks.\n'
      + '- **`say` is the only text the user sees and hears at the moment you say it**; your normal reply is '
      + 'appended to the window log afterwards, never spoken. Never claim the conversation is not recorded '
      + '— it is.\n'
      + '- They watch the same screen over and over: do not narrate, do not repeat yourself, silence is a '
      + 'good answer.\n'
      + '- If you cannot read something (small text, a filename, a menu), do not guess — call again with '
      + '`quality:"high"`.\n'
      + '- A `台词` block in the result is machine-transcribed speech from that window: homophones happen '
      + '(never quote it as exact), and a missing block does not mean the video was silent.\n\n'
      + '**Not for recorded video or a series** — the `bilibili` skill reads the whole file, its subtitles '
      + 'and its comments; this tool samples a few frames a minute.',
    parameters: {
      action: {
        type: 'string',
        enum: [...ACTION_VALUES],
        default: 'watch',
        description: 'Which entry point.\n'
          + '- `watch` (default) — keep watching; this is the one you need most of the time.\n'
          + '- `peek` — take the sheet that already piled up, without waiting (use it after a 唤醒).\n'
          + '- `status` — loop / sound / window / capability state, as text.\n'
          + '- `listen` — **只留耳朵**：停画面、音频不停。用户说「先只听 / 黑听」时用；之后插件会用'
          + '「最近 60 秒声音轨迹」叫你，你自己判断要不要 `watch` 抬眼。\n'
          + '- `lift` — 取 `since` 那一刻的单帧，只在仅监听时（唤醒文案会给你 `t0`）。\n'
          + '- `window` — 配合 `show` 显示或隐藏悬浮窗。\n'
          + '- `region` — 让用户拖一块框，之后 `watch` 默认只看那块。\n'
          + '- `bloodbar` — 让用户框**自己角色**那条常驻 UI 的血条（敌人血条只在交战时出现，别框）；'
          + '`read:true` 读一次比例。进仅监听后每秒读一次，'
          + '但读数只写进唤醒文案、`watch` 结果和 `status`，**低血不会叫醒你**。\n'
          + '- `start` / `stop` — 显式开关采集（平时 `watch` / `stop` 就够）。',
      },
      say: {
        type: 'string',
        description: '用户此刻唯一看得见也听得见的话：一条气泡 + 朗读一次。一次说 2–3 句，'
          + '别为了补一句再调一次。**加粗**的地方会被重读（气泡里也是粗体）：想让人听到'
          + '强调就加粗一处，别整句加。句中想换气就写 `‖`（很短的一顿，不是逗号）。',
      },
      seconds: {
        type: 'integer',
        default: DEFAULT_BLOCK_SEC,
        description: 'With `watch`: 阻塞等待的上限秒数（默认 300，封顶 860）。平时不用传 —— '
          + '攒够一张就提前返回；上限只在画面静止时起作用，那时就该一直挂着，而不是结束回合。',
      },
      minFrames: {
        type: 'integer',
        default: 1,
        description: 'With `watch`: 少于这么多帧就不返回（默认 1）。1 帧和 4 帧一样贵，'
          + '画面基本不动时调高能省 token。',
      },
      quality: {
        type: 'string',
        enum: ['low', 'standard', 'high', 'ultra'],
        default: 'low',
        description: '"low"（默认，≈222 token/张）/ "standard"（≈392）/ "high"（≈560，文件名可读）/ '
          + '"ultra"（≈860，单帧近原屏）。读不清就升档、别猜；改档会重开采集（≈0.6s）并立刻返回'
          + '当前画面一张，之后保持该档。',
      },
      region: {
        type: 'string',
        description: '只抓一块矩形，格式 "x,y,w,h"（屏幕物理像素）。通常不用你填 —— 用户说"框这块"'
          + '就调 `{action:"region"}`，他拖完自动存盘，之后 `watch` 默认用它；`"off"` 取消、回整屏。'
          + '配 `source:"window"` 时表示窗口内的那一块（仍按屏幕像素写）。\n'
          + '限制（要如实告诉用户）：抓的是屏幕上此刻的像素，被别的窗口挡住就只看到遮挡物；'
          + '抓不到后台 / 最小化窗口；只支持主屏。带区域时帧不再缩小，token 更贵，要省就降 `quality`。',
      },
      pace: {
        type: 'string',
        enum: ['calm', 'normal', 'dense', 'game-economic'],
        default: 'normal',
        description: '多久算换一次画面、多久叫醒你一次。粘性，不传就保持当前档。\n'
          + '- 用户说**「太密了 / 回复太频繁 / 省点钱 / 慢一点」** → `calm`：这是唯一真能降开销的'
          + '旋钮，口头答应没用。\n'
          + '- 用户说**「漏了 / 不灵敏 / 太迟钝」** → `dense`（费钱，只在演示或快画面时用）。\n'
          + '- 动作游戏且嫌糊 / 太频繁 → `game-economic`：出帧按运动量攒、每张最多 8 帧，'
          + '只适合动作游戏 —— 访谈、口播、看剧、快剪视频会漏掉大半镜头。\n'
          + '文件回放（看视频）自动按 dense 的切点门槛；屏幕采集照当前档。',
      },
      scene: {
        type: 'boolean',
        description: '**逐帧播报**，默认关、粘性。开了之后每留下一个画面就单独给一张满幅图，'
          + '每换一次画面叫你一次，你回一句 `say`。只在用户明确说「每换一个场景就告诉我 / '
          + '每翻一页说一句 / 逐帧播报 / 一个画面一张图」时开：每次唤醒 = 一张图 + 一轮往返，很贵，也吵。',
      },
      preset: {
        type: 'string',
        enum: ['subtitle'],
        description: '换的是**拿屏幕的哪一块**，不是清晰度：`"subtitle"` = 只取底部 16% 那条'
          + '（左右各裁 10%），按时间从上到下叠成一张长条图，最多 4 条，默认 quality "ultra"。'
          + '用户在看带字幕的对话 / 影视时用 —— 整屏 4 帧会把 32px 的字缩成 5px，只能靠猜。'
          + '代价：条带以上的画面你看不到，别猜那里发生了什么。`preset:""` 或不传即关闭。'
          + '它不改采集引擎：帧仍来自你给的那个源（屏幕 / 窗口），被别的窗口压住就只看到压住它的东西 —— '
          + '要稳就用 `source:"window"`。',
      },
      task: {
        type: 'string',
        description: 'With `watch`: 用户分配了「盯着」的任务（"我走开一会儿，你帮我看着"）时填一句描述。'
          + '填了循环不停工、不降级，直到用户说「我回来了」；期间每张图记一行到 '
          + '`~/.dsh/see-now/missed.jsonl`（两张之间的空档另记 `kind:"gap"`），回来时读它汇报错过了什么。',
      },
      mode: {
        type: 'string',
        enum: ['both', 'vision', 'audio'],
        description: '三档感官：`both` 视听都开 / `vision` 只看（画面、不起耳朵）/ `audio` 只听'
          + '（= `action:"listen"`，不返回图）。`both` / `vision` 写回 `~/.dsh/see-now.json` 的 `mode`，'
          + '重开 DSH 沿用；`audio` 一次性。不传 = 保持当前档。',
      },
      audio: {
        type: 'boolean',
        description: '旧开关，别名：`false` = `mode:"vision"`，`true` = `mode:"both"`。新调用用 `mode`。',
      },
      source: {
        type: 'string',
        enum: ['screen', 'obs', 'camera', 'file', 'window'],
        default: 'screen',
        description: '"screen"（默认，整屏）/ "window"（**按窗口抓**，配 `window` 给标题：窗口化游戏、'
          + '常切到别的窗口、或那一路画面会被压住时用它 —— 抓的是窗口表面，被遮挡照样有）/ "obs" / '
          + '"camera" / "file"（配 `path` 回放视频，调试用）。改它会重开采集；窗口最小化抓不到，'
          + 'D3D 独占全屏会自动改抓屏幕。',
      },
      path: {
        type: 'string',
        description: 'With `source:"file"`: 视频的绝对路径。',
      },
      realtime: {
        type: 'boolean',
        description: 'With `source:"file"`: 按 1x 播放，而不是能多快就多快。',
      },
      window: {
        type: 'string',
        description: '窗口标题里的一段（不用全名），配 `source:"window"` 或 `action:"bloodbar"` 用。\n'
          + '- `source:"window"`：按这个窗口抓画面 —— 窗口化游戏、常切到别的窗口、窗会被别的窗口压住时用它，'
          + '抓的是窗口表面，被遮挡照样有。窗口最小化抓不到；D3D 独占全屏会自动改抓屏幕。\n'
          + '- `bloodbar`：抓血条的方式。不传 = 按屏幕抓（`gdigrab`）—— 悬浮窗或别的窗口压到血条上，'
          + '读到的就是压住它的那块；玩全屏游戏、或窗可能压住血条时传标题走 WGC。`"off"` 回到抓屏幕。',
      },
      show: {
        type: 'boolean',
        description: 'With `window`: true = 显示悬浮窗，false = 藏起来（采集照常，但 `say` 也看不见）。'
          + '不传只报状态。**结果是「窗是藏着的」时，用户看不到你说的话** —— 先显示再说话。',
      },
      since: {
        type: 'number',
        description: 'With `lift`: epoch 毫秒 —— 用"[黑听]"唤醒文案里给的 `t0`。返回那一刻的单帧'
          + '（≈222 token）；比 10 分钟留底更早就明确回「没了」，不要拿当前帧冒充。',
      },
      read: {
        type: 'boolean',
        description: 'With `bloodbar`: true = 当场读一次血条比例（不弹框）。',
      },
      threshold: {
        type: 'number',
        default: 0.3,
        description: 'With `bloodbar`: 低于这个比例算「低血」（0–1，默认 0.3）。只影响报告措辞，'
          + '不触发任何叫醒。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          images: { type: 'array', items: { type: 'json' } },
          meta: { type: 'json' },
        },
      },
      render(args, value) {
        return [
          ...(value.images ?? []).map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe() {
      return false;   // 会话里只有一个采集进程，并发跑会把两张图交错
    },
  };
}
