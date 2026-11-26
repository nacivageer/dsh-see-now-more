/**
 * human.js — 「这条会话事件算不算**人**说了一句话」。
 *
 * ## 为什么需要它（上游 0.2.4 / issue #69）
 *
 * 常驻循环原来只盯悬浮窗那条 `chat.jsonl`：用户切回 DSH 主聊天窗跟 agent 聊十几分钟，
 * 它一个字都看不见，照样按「连续 N 次叫醒没人理」收工 —— 采集停了，人还在，agent 却被
 * 反复空叫醒。反过来，把「有人说话」放宽成"任何 user 消息"，插件自己投的提词也会命中，
 * 于是 `wakesSinceUser` 永远归零，那条兜底线等于没写。
 *
 * ## 判据
 *
 * - 类型必须是 `user/message`；
 * - `source.kind` 只能是 `user`（宿主 UI / ACP bridge 发的）或 `action-cards`
 *   （用户点了卡片按钮，也算人的动作）；
 * - **必须排除 `see-now`**：那是本插件自己的叫醒 / 提词，`timer.js` 的 `userMessage()` 带的。
 *
 * 探针和脚本注进来的消息（没有 `source`）一律**不算** —— 宁可少续命一次，也不要把
 * 机器生成的文字当成人在看。
 */

/**
 * @param {{type?:string, data?:{source?:{kind?:string}}, source?:{kind?:string}}} event
 * @returns {boolean}
 */
export function isHumanMessage(event) {
  if (!event || event.type !== 'user/message') return false;
  const src = event.data?.source ?? event.source;
  const kind = src?.kind;
  return kind === 'user' || kind === 'action-cards';
}

/**
 * 用户在宿主里**亲手打**的一条消息（浮窗镜像只认这一种）。
 *
 * 和 `isHumanMessage` 故意分开：后者把 `action-cards`（点卡片按钮）也算成
 * "人的动作"，用来给常驻循环续命；镜像进浮窗的只能是真正的用户文字 ——
 * 卡片按钮没有可读正文，混进来就是一条空气泡。两个判据各有单测，不许合并。
 *
 * `source.kind === 'user'` 同时覆盖宿主 UI 和 ACP bridge（`user-rpc` 的 kind 也是 `user`）。
 *
 * @param {{type?:string, data?:{source?:{kind?:string}}, source?:{kind?:string}}} event
 * @returns {boolean}
 */
export function isTypedUserMessage(event) {
  if (!event || event.type !== 'user/message') return false;
  const src = event.data?.source ?? event.source;
  return src?.kind === 'user';
}

/**
 * 这条消息是不是**本插件自己**投进去的（`see-now` 唤醒 / 提词）。
 *
 * 只给测试和排查用：真跑时 `isHumanMessage` 已经把这类挡在外面，留一个正名字
 * 是为了让"为什么不算"这件事在测试里可读。
 */
export function isSelfMessage(event) {
  if (!event || event.type !== 'user/message') return false;
  const src = event.data?.source ?? event.source;
  return src?.kind === 'see-now';
}
