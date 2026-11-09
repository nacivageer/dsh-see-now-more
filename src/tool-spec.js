/**
 * tool-spec.js — `see_now` 的契约。
 *
 * **注意 `parameters` 的形状**：它是「属性名 → 值 schema」的映射，不是完整的 JSON Schema。
 * 写成 `{ type:'object', properties:{...} }` 会被宿主拒绝：
 * `unsupported JSON schema: parameters.type must be a value schema object`。
 * （`output.schema` 反而是完整 JSON Schema —— 两个形状不一样，别抄错。）
 *
 * 参数**写成什么样，模型就会怎么用**。所以 description 里要把"什么时候调、等多久"说清楚，
 * 而不是罗列字段。
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

export function seeNowToolSpec() {
  return {
    name: TOOL_NAME,
    description:
      'Watch what is on the user\'s screen **live** and get back one image made of several frames. '
      + 'Frames are picked by how much the picture changes, so a static screen costs almost nothing '
      + 'while a busy one gives you more frames.\n\n'
      + 'How to use it:\n'
      + '- `see_now({action:"watch"})` — **blocking call; this is the normal way to watch.** The first '
      + 'call returns the current screen in about a second; after that it blocks until a sheet is ready '
      + '(15–40s when the screen is changing, longer when it is static) or the user types in the floating '
      + 'window, then returns that sheet. **Call it again right after you reply** — the blocking call IS '
      + 'the pause; the conversation never ends between sheets. Do not end your turn while the user is '
      + 'still watching.\n'
      + '- `see_now({action:"peek"})` — grab the sheet that already piled up, without waiting. Use this '
      + 'when the plugin wakes you ("有新画面了"), because then you are not inside a `watch` any more.\n'
      + '- `see_now({action:"status"})` — is it still watching, is the loop alive, is sound attached, '
      + 'and is the floating window actually visible.\n'
      + '- `see_now({action:"window", show:true})` — bring the floating window back when the user cannot see '
      + 'it (it can be left hidden from an earlier run). `show:false` hides it again. **Whenever a result '
      + 'or `status` says the window is hidden, the user is seeing nothing you say** — fix it with this '
      + 'before you say anything else.\n'
      + '- `see_now({action:"stop"})`.\n\n'
      + 'Safety net: if you ever stop calling `watch`, the plugin still keeps capturing and will wake '
      + 'you with a short note when a new sheet fills up (then `peek`). It also stops everything the '
      + 'moment the user closes the floating window, and tells you so — when that note appears, do NOT '
      + 'call `see_now` again until the user asks.\n\n'
      + '**`say` is the ONLY thing the user sees and hears at the moment you say it.** Your normal reply '
      + 'text is appended to the floating window\'s log afterwards (so the record of the conversation is '
      + 'complete), but it is never spoken and never shows up as a bubble at the right time — only `say` '
      + 'does. So whenever the user might be waiting, watching, or has just typed something, put what you '
      + 'want to tell them in `say` on the same call. '
      + 'One `say` = one bubble = one spoken utterance, so put two or three sentences in it rather than '
      + 'splitting them across calls. Never tell the user their conversation "is not recorded" — it is.\n\n'
      + '**They are looking at the same screen as you, over and over.** So: do not narrate everything, '
      + 'do not repeat the sentence you already said (the tool result reminds you of it), and silence is '
      + 'a perfectly good answer — there is no quota. Say something when it actually changed or when it '
      + 'is worth pointing at.\n\n'
      + 'The image is returned as a tool result (not pushed into the chat), so just read it. '
      + 'Frames are numbered 1..n in time order; the text lists each frame\'s timestamp and pixel size. '
      + 'Do NOT poll faster than every ~10 seconds — nothing new arrives that fast, and each image costs tokens.\n\n'
      + '**Sound.** When the machine can hear what is playing (system audio → speech-to-text), the text '
      + 'also carries a transcript block (it starts with `台词`): what was said during that window, with '
      + 'timestamps in the same coordinate system as the frames. Use it to follow dialogue and narration '
      + 'instead of guessing from faces. Two caveats: it is **machine-transcribed** (homophones happen — '
      + 'never quote it as an exact line), and it only appears when audio capture is available; if the '
      + 'block is missing, just work from the pictures and do not claim the video was silent.\n\n'
      + 'If you cannot read something (small text, filenames, a menu), do NOT guess: call again with '
      + '`quality:"high"` and you get one sharp frame of the current screen in about half a second.\n\n'
      + '**When NOT to use this.** This is for what is happening on screen **now** — live streams, the user '
      + 'playing a game, something they are doing in an app. For a recorded video or a whole series you want '
      + 'reviewed, use the `bilibili` skill instead: it reads the full file, its subtitles and its comments, '
      + 'while this tool only samples a few frames a minute. The user has said this explicitly (2026-11-06): '
      + '看视频/电影走 bilibili 技能，直播和游戏才走 see-now。',
    parameters: {
      action: {
        type: 'string',
        description: 'watch (default) | peek | listen | start | stop | status | window | region\n'
          + '- `listen` — **只留耳朵**：停画面、音频不停、常驻循环继续跑。用户说「先只听 / 黑听」时用。'
          + '之后听到值得看的东西，插件会用一条带「最近 60 秒声音轨迹」的消息叫你，'
          + '你自己判断要不要 `watch` 抬眼；判断不值得就什么都不做。',
      },
      task: {
        type: 'string',
        description: 'With action:"watch": 用户分配了一个「盯着」的任务（"我走开一会儿，你帮我看着"）时填一句任务描述。'
          + '填了之后循环**不会因为闲下来自己收工或降级**——一直看到用户说「我回来了」为止。'
          + '期间每出一张图会往 `~/.dsh/see-now/missed.jsonl` 记一行（时间/帧数/台词/声音，不叫醒、不花 token），'
          + '两张之间没有图的区间另记一行（`kind:"gap"`，只有起止秒数），'
          + '用户回来时你读这个文件就能汇报"错过了什么"，然后 `stop` 或 `listen` 结束任务。',
      },
      region: {
        type: 'string',
        description: '只抓屏幕上的**一块矩形**（手机竖屏通话、某个播放器窗口之类）。'
          + '格式 "x,y,w,h"，屏幕物理像素。**通常不用你填**：让用户说"框这块"就调 '
          + '`see_now({action:"region"})`，屏幕上会变暗、他自己拖一个框，坐标自动存下来，'
          + '之后每次 `watch` 默认就是那块（存到 `~/.dsh/see-now/region.json`）。\n'
          + '传 `region:"off"` 取消，回到整屏。\n'
          + '限制（要如实告诉用户）：抓的是**屏幕上正在显示的像素** —— 这块被别的窗口挡住就只看到挡住它的东西；'
          + '没接 OBS，抓不到后台/最小化窗口；只支持主屏。\n'
          + '带上区域后：强制 gdigrab（ddagrab 没有偏移参数）、按区域比例出图（竖屏出竖屏）、'
          + '每帧长边 = 档位长边、一张默认 2 帧最多 4 帧。token 会比全屏贵（帧不再被缩小）：'
          + 'low 档 2 帧约 345 token、4 帧约 872（普通全屏 4 帧是 233）；要省钱就降 `quality`。',
      },
      show: {
        type: 'boolean',
        description: 'With action:"window": true = 让悬浮窗显示出来（用户看不见窗时用），false = 藏起来'
          + '（采集照常，只是一句 `say` 也看不见）。不传就只报状态，什么都不改。',
      },
      source: {
        type: 'string',
        description: 'Where to capture from: "screen" (whole desktop, default), "obs" (OBS virtual camera), '
          + '"camera" (first webcam). Only matters on the first call of a session. '
          + 'Use "file" together with path to replay a local video instead of a live source (debugging).',
      },
      path: {
        type: 'string',
        description: 'With source:"file": absolute path of a video to replay.',
      },
      realtime: {
        type: 'boolean',
        description: 'With source:"file": replay at 1x speed instead of as fast as ffmpeg can decode.',
      },
      pace: {
        type: 'string',
        description: '"calm" | "normal"（默认）| "dense" | "game-economic" —— 控制**多久算换一次画面、多久叫醒你一次**。\n'
          + '用户说**"太密了 / 回复太频繁 / 省点钱 / 慢一点 / 别老说话"**时，立刻传 `pace:"calm"`'
          + '（20 分以上才算换画面，最多 30 秒叫一次）。这是唯一能真的降低开销的旋钮 —— '
          + '口头答应"我少说点"不会改变出图频率。\n'
          + '用户抱怨**"漏了 / 不灵敏 / 太迟钝"**时传 `pace:"dense"`（7 分就算换，最多 8 秒一次，贵）。\n'
          + '用户在**打游戏、看高速运动画面**，抱怨"发得太频繁 / 一张图糊得看不清 / 顶到限速"时，'
          + '传 `pace:"game-economic"`：切点门槛抬到 80、出帧按 30 秒运动量攒、每张最多 8 帧、最多 20 秒叫一次。'
          + '这一档只适合**动作游戏**。实测代价：同一段 137 秒的射击游戏，normal 出 95 帧、action 只出 11 帧；'
          + '而在一段快剪视频上覆盖率只有 12.7%（normal 67%）。所以**不适合访谈/口播/播放器看剧/快剪视频**'
          + '（那些内容会半天没反应或漏掉大半镜头，要切回 normal）。\n'
          + '粘性，一直生效到下次再改；改它要重开采集（约 0.5 秒）。不传就是保持当前档。\n'
          + '**看视频 / 影视剧**已经自动用 dense 的切点门槛（文件回放时生效，实测 27 段短视频上 cutAbs=7 的切点 F1 是 56.8%，'
          + '默认 12 只有 51.9% —— 12fps 采样本来就会吃掉一部分快切）；直播/录屏仍是默认档。',
      },
      scene: {
        type: 'boolean',
        description: '**逐帧 / 逐场景模式**，默认关。'
          + '打开后：每留下一个画面就单独给你一张**满幅**图（一张图 = 一个场景，不再拼格），'
          + '并且每换一次画面就叫你一次，你回一句 `say` 说清那是什么。'
          + '`scene:true` 打开，`scene:false` 关掉；**它是粘性的**，一直生效到这轮看完，'
          + '不用每次 watch 都传。\n'
          + '**什么时候才该打开**：用户明确说要"每换一个场景就告诉我"、"每翻一页说一句这是什么"、'
          + '"逐帧播报"、"一个画面一张图"这类要求时。'
          + '**平时一律不要开** —— 每次唤醒 = 一张图 + 一轮模型往返，'
          + '画面每 2 秒换一次就是每分钟 30 次唤醒，很贵，而且用户会嫌你话太多。'
          + '用户没明确这么说，就别传这个参数。',
      },
      say: {
        type: 'string',
        description: 'What you say to the user — **this is the only text they can see and hear**. '
          + 'It goes into their floating window as one bubble and is spoken aloud once. '
          + 'Your normal reply never reaches them. Put two or three sentences in a single `say` '
          + 'instead of calling again just to add more.',
      },
      seconds: {
        type: 'integer',
        description: 'With action:"watch": the **upper bound** of the blocking wait, in seconds (default 300, '
          + 'capped at 860). You normally do not need to touch this: it returns early the moment a sheet '
          + 'fills up (every 15–40s when the screen is changing) or the user types in the floating window. '
          + 'The ceiling only matters when the screen is static — then you simply stay blocked instead of '
          + 'ending your turn, which is exactly right: the blocking call IS the pause.',
      },
      minFrames: {
        type: 'integer',
        description: 'With action:"watch": do not bother returning an image with fewer frames than this '
          + '(default 1). A 1-frame image costs the same as a 4-frame one, so raising this saves tokens '
          + 'when the screen is mostly static.',
      },
      quality: {
        type: 'string',
        description: 'How sharp the image is. "low" (default, 798×462 = 450px of frames + a 12px audio '
          + 'strip, ≈222 tokens) — 4 frames are 399×225 each, enough for faces/scenes/video but small text '
          + 'is unreadable. '
          + '"standard" (1050×630, ≈392 tokens) — 525×300 per frame, medium text readable. '
          + '"high" (1260×756, ≈560 tokens) — 630×360 per frame, filenames readable. '
          + '"ultra" (1596×924, ≈860 tokens) — a single frame is nearly the real screen; use it only '
          + 'when "high" is still not enough.\n'
          + 'Switch it UP as soon as you cannot read something — do not guess from a blurry image. '
          + 'Changing quality restarts the capture (~0.6s) and immediately returns ONE frame of the current '
          + 'screen, so you get the sharp view right away; the following calls stay at that quality.',
      },
      mode: {
        type: 'string',
        enum: ['both', 'vision', 'audio'],
        description: '**Senses mode — one entry per combination** (the user picks a mode, you map it here). '
          + '`"both"` = 视听都开 (picture + ears). `"vision"` = 只看 (picture, no ears — the orange '
          + '「仅开启视觉」 light; same as `audio:false`). `"audio"` = 只听 (no picture, ears only — same as '
          + '`action:"listen"`, which does NOT wait for an image). '
          + '`both` / `vision` are **persisted** to `~/.dsh/see-now.json` `mode`, so the next DSH start '
          + 'uses the same one; `audio` is one-off and never persisted. '
          + 'Omit = keep the current mode. Combine with `watch` / `start` (or nothing, which means watch).',
      },
      audio: {
        type: 'boolean',
        description: 'Older single switch, kept as an alias: `false` = `mode:"vision"`, `true` = `mode:"both"`. '
          + 'New calls should use `mode` (it has a name for 只听 too). '
          + 'Ears = system audio -> transcript; the floating window shows the result as the orange dot '
          + '「仅开启视觉」 vs green「实时视觉 + 听觉」。',
      },
      preset: {
        type: 'string',
        enum: ['subtitle'],
        description: 'A viewing mode that changes **what part of the screen you get**, not how sharp it is. '
          + '`"subtitle"` = only the bottom 16% band (subtitles / dialogue captions), with 10% cropped off the '
          + 'left and right (captions never run edge to edge), stacked newest-last '
          + 'into one tall strip image, up to 4 lines per image, default quality "ultra". '
          + 'Use it when the user is watching dialogue with captions: full-screen frames at 4-per-image shrink '
          + 'a 32px caption to ~5px and you end up guessing, while the band keeps it at ~20px for ~1/8 of the '
          + 'tokens. You get no context above the band — say so instead of describing the scene. '
          + 'Turn it off with `preset:""` (or by not passing it next time).',
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
