/**
 * chat.js — 和悬浮窗共用的那一条文本流（`chat.jsonl`）。
 *
 * 为什么是文件而不是别的：**阻塞期间宿主的输入框送不进这个调用**（实测宿主的消息
 * 是事后补写到会话文件里的）。而这个 jsonl 是我们自己 append 的，写盘即时 ——
 * 阻塞循环每 150ms 增量读一次就能看见。
 *
 * 和 watch 那边**分开一个文件**：`~/.dsh/see-now/chat.jsonl`。
 * 共用一个的话，两边的话会串进同一个窗，而且谁都不知道哪句是对谁说的。
 *
 * 只做四件事：写一条、增量读、判断"这句是不是用户刚说的"、记住"这条已经交给会话了"。
 * HTTP 服务一律不要 —— 悬浮窗本来就直接写文件，那个服务是给浏览器兜底和浏览器扩展上报位置用的，我们都不需要。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync,
         statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { emitSpeech } from './speech.js';

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh');
}

export function chatDir(env = process.env) {
  return join(dshHome(env), 'see-now');
}

export function chatFile(env = process.env) {
  return join(chatDir(env), 'chat.jsonl');
}

/**
 * 当前绑定的会话（`~/.dsh/see-now.json` 的 `session`，2 秒内共用一次读盘）。
 *
 * 为什么要在这里读：聊天流里的每一句都要带上"是哪个会话说的"，
 * 否则窗口没法按会话分组（2026-11-06 用户要求：主窗只显示当前会话，
 * 以前的会话进【历史记录】）。写入口只有 `appendChat` 一个，放这儿
 * 就不用改所有调用点。
 *
 * 读盘失败沿用上一个值：不能让一次坏文件把消息标成"无会话"。
 */
let boundAt = 0;
let boundSid = '';
export function boundSessionForChat() {
  const now = Date.now();
  if (now - boundAt < 2000) return boundSid;
  boundAt = now;
  try {
    const raw = readFileSync(join(dshHome(), 'see-now.json'), 'utf8');
    // 带 BOM 的 JSON 是 Windows 记事本/PowerShell 的默认产物，`JSON.parse` 直接抛
    boundSid = String(JSON.parse(raw.replace(/^\uFEFF/, ''))?.session ?? '');
  } catch {
    /* 保持上一个 */
  }
  return boundSid;
}

/** 追加一条。`role` 只有两种：`assistant`（模型说的）和 `user`（用户打的/说的）。 */
export function appendChat(role, text, env = process.env) {  const t = String(text ?? '').trim();
  if (!t) return null;
  const file = chatFile(env);
  mkdirSync(chatDir(env), { recursive: true });
  const sid = boundSessionForChat();
  const entry = { role, text: t, at: Date.now() };
  if (sid) entry.sid = sid;
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * **投递回执**：`~/.dsh/see-now/delivered.jsonl`，一行一条 `{at, ok}`。
 *
 * 为什么要单独一个文件：`chat.jsonl` 是**只追加的对话记录**，而"这条最终投没投出去"
 * 是**事后才有的状态**（窗口发出去时还不知道）。回写原记录要改写文件，代价和风险都大；
 * 追加一份回执、窗口按 `at` 对账，简单且不会破坏对话顺序。
 *
 * 窗口据此把气泡时间戳左边的「● 发送中」换成「● 已送达」/「● 发送失败」
 * （2026-11-06 用户要求 ③）。
 */
export function deliveredFile(env = process.env) {
  return join(chatDir(env), 'delivered.jsonl');
}

/** 记一条回执。`at` 是用户消息在 `chat.jsonl` 里的时间戳（同一把钥匙）。 */
export function markDelivered(at, ok = true, env = process.env) {
  const key = Number(at);
  if (!Number.isFinite(key) || key <= 0) return;
  try {
    mkdirSync(chatDir(env), { recursive: true });
    appendFileSync(deliveredFile(env),
      `${JSON.stringify({ at: key, ok: Boolean(ok), t: Date.now() })}\n`, 'utf8');
  } catch { /* 回执写不进去不能影响投递本身 */ }
}

/**
 * **已经交给会话的那几条**（`relay-delivered.json`，按 `at` 去重）。
 *
 * 为什么必须落在 chat.js、而不是某个入口的闭包里：`chat.jsonl` 有三个消费者 ——
 * 阻塞的 `watch()`（`runner.js`）、常驻循环（`loop.js`）、relay（`index.js`）。
 * 任何一条把话交给模型之后都得记一笔，否则插件重载时 `replayUnanswered()` 会把
 * 「已经送到、但模型还没回字」的消息当成没人回，**再投一遍**（2026-11-08 实报：
 * watch 吃过的「打字看看」重启后被 relay 又投了一次）。
 *
 * 以前这个集合是 `index.js` apply 里的闭包变量，另外两条路根本碰不到它。
 * 键用 `at`（窗口写盘时打的时间戳，一条消息只有一个值），只留最近 200 条 ——
 * 启动补投只看 10 分钟内的，够用。
 */
export function relaySeenFile(env = process.env) {
  return join(chatDir(env), 'relay-delivered.json');
}

/** 每个 chatDir 一份内存镜像：读盘只读一次，写的时候顺手落盘。 */
const relaySeenCache = new Map();

function relaySeenSet(env) {
  const file = relaySeenFile(env);
  let set = relaySeenCache.get(file);
  if (set) return set;
  try { set = new Set(JSON.parse(readFileSync(file, 'utf8')).map(String)); }
  catch { set = new Set(); }
  relaySeenCache.set(file, set);
  return set;
}

/** 这一条是不是已经交给会话了（只认 `at`）。 */
export function relaySeenHas(at, env = process.env) {
  const key = String(at ?? '');
  if (!key) return false;
  return relaySeenSet(env).has(key);
}

/**
 * 记下"这一条已经交给会话了"。**投递成功就要记**，包括 watch 截断出图那条路
 * 和常驻循环那条路 —— 它们和 relay 用的是同一条 `chat.jsonl`。
 *
 * @returns {boolean} 是否真的写进去了（`at` 不合法时 false）
 */
export function markRelaySeen(at, env = process.env) {
  const key = String(at ?? '');
  if (!key || key === 'undefined' || key === 'null') return false;
  const set = relaySeenSet(env);
  if (!set.has(key)) set.add(key);
  // 内存和磁盘用同一条上限：只留最近 200 条（插入序就是时间序）。
  // 不裁内存的话，进程活久了「有没有投过」和「重启后还算不算投过」会给出两个答案。
  while (set.size > 200) set.delete(set.values().next().value);
  try {
    mkdirSync(chatDir(env), { recursive: true });
    writeFileSync(relaySeenFile(env), JSON.stringify([...set]), 'utf8');
    return true;
  } catch {
    return false;    // 记不住最多多投一次，不能挡住投递
  }
}

/**
 * **唯一出口**：往悬浮窗写一句"说给用户的话"，并且**一定经过语音播报**。
 *
 * 为什么必须收成一个入口（照搬陪看的教训）：以前有两条写盘的路 ——
 * 一条写+发声，一条只写。于是"补写的话"在窗口里看得见、却一点声都没有，
 * 用户第一反应就是"为什么你写的字没有声音"。凡是**说给用户的话**都走这里：
 * 写盘和发声是同一次调用的两个副作用，谁也离不开谁。
 *
 * `speak: false` 只留给**诊断行**（"窗没开起来"这类），那些是给眼睛看的，不该念出来。
 *
 * @param {'assistant'|'meta'} role
 * @param {string} text
 * @param {{speak?:boolean, env?:object}} [o]
 */
export function appendSpoken(role, text, { speak = true, env = process.env } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const entry = appendChat(role, clean, env);
  // 只有"说给用户的话"才记：`meta`（诊断行）不该被当成"你上一句说过什么"
  if (role === 'assistant') lastSaid = { text: clean, at: Date.now() };
  // `origin: 'chat'` 告诉展示层"这条已经在流里了，别再写第二遍"
  if (speak) emitSpeech({ at: null, text: clean, state: 'due', origin: 'chat' });
  return entry;
}

/**
 * 上一条**说给用户的话**（`{text, at}`；没说过是 null）。
 *
 * 为什么要有它：实时看屏幕时模型每 20~60 秒被叫醒一次，每次都在"现场想一句"，
 * 于是同一句感慨会被说两遍（实测「我先看一眼你屏幕上是什么」连着说了两次，
 * 用户当场就问"你为什么重复"）。把上一句带回给它，比让它自己回忆便宜也可靠 ——
 * 那个上下文可能已经被压缩掉了。
 */
let lastSaid = null;

/**
 * 「你上一句说过什么」，给工具结果和唤醒文案共用。
 *
 * 实时看屏幕是**同一个画面被反复看**：模型每次被叫醒都在现场想一句，
 * 于是同一句感慨会被说两遍（实测「我先看一眼你屏幕上是什么」连着说了两次）。
 * 把上一句带回来，比让它自己回忆可靠 —— 那段上下文可能已经被压缩掉了。
 *
 * 只写一份的原因：工具结果和循环唤醒是两条入口，各写一套就会出现
 * "watch 那条提醒了、peek 那条没提醒"这种只在某条路上复现的重复。
 *
 * @param {{maxAgeSec?:number, clipLen?:number}} [o]
 * @returns {string} 没有上一句（或太久以前）就是空串
 */
export function lastSaidNote({ maxAgeSec = 300, clipLen = 60 } = {}) {
  if (!lastSaid?.text) return '';
  const age = Math.round((Date.now() - lastSaid.at) / 1000);
  if (age > maxAgeSec) return '';
  const t = String(lastSaid.text).replace(/\s+/g, ' ').trim();
  const clip = t.length > clipLen ? `${t.slice(0, clipLen)}…` : t;
  return `\n（你上一句说的是「${clip}」，${age} 秒前 —— 别重复它。）`;
}

/** 最近一次 `say` 的原文与时间（镜像正文时用来去重：那句话已经进过窗了）。 */
export function lastSaidText() {
  return lastSaid ? { text: lastSaid.text, at: lastSaid.at } : null;
}

/**
 * **进程共享**的增量探测器。
 *
 * 为什么必须共享（照搬陪看的教训）：
 *   ① `makeChatWatcher()` 以"创建时的位置"为基线 —— 每次等待都新建一个的话，
 *      **模型思考期间**用户说的话会落在两次等待的缝隙里，谁都不报，永远丢掉；
 *   ② 阻塞等待和常驻循环都要看这条通道。各自建一个，同一条消息会被两边各吃一次
 *      （重复唤醒）；共享之后才谈得上"谁先用"。
 */
let sharedWatcher = null;
export function chatWatcherShared(env = process.env) {
  if (!sharedWatcher) sharedWatcher = makeChatWatcher(env);
  return sharedWatcher;
}

/**
 * 现在有几个地方**正阻塞着等用户说话**。
 *
 * 为什么必须有这个计数：聊天框是**一个消费型通道**，poll 一次就把它标成已读。
 * 阻塞等待和常驻循环共用同一个 watcher，谁先 poll 谁拿到。而循环那边拿到后走的是
 * `followup()` —— 会话正卡在工具调用里等结果时，投进去的消息要**等这一轮结束**才会被处理，
 * 所以它接不住"从等待里出来"这件事。实测（陪看 2026-10-31）：用户在悬浮窗说话，
 * 循环把话吃了、`followup` 排进去，等待里的 `poll()` 再也看不见它 ——
 * 表现就是"我在窗口里说话，它一动不动"。
 *
 * 所以：**有等待者时，循环不许碰这个通道**。
 */
let chatWaiters = 0;

/** 进入"我在等用户说话"的状态，返回退出函数（务必 finally 里调） */
export function enterChatWait() {
  chatWaiters += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    chatWaiters = Math.max(0, chatWaiters - 1);
  };
}

/** 有几个等待者（给循环判断"这条通道现在归谁"） */
export function chatWaiterCount() {
  return chatWaiters;
}

/**
 * 增量 watcher：只看上次之后新写进来的字节。
 *
 * **不许整份重读**：一场两小时几千条，每 150ms 全解析一遍会把 CPU 吃满。
 * 末尾可能是半行（写盘还没写完），读不全就留到下一次。
 *
 * @returns {() => Array<{role:string,text:string,at:number}>} 每次调用返回"上次之后的新条目"
 */
export function makeChatWatcher(env = process.env) {
  const file = chatFile(env);
  let off = 0;
  let primed = false;

  return function poll() {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // 文件还不存在：**也要 prime 在 0 位**，否则用户的第一句话会创建这个文件，
      // 而那时 `primed` 还是 false → 直接把整份（就那一句）当历史跳过。
      // 这是实测踩到的：第一次插话永远听不见。
      if (!primed) { primed = true; off = 0; }
      return [];
    }
    if (!primed) {
      // 文件存在：只记位置，不把历史消息当成"刚说的"
      off = size;
      primed = true;
      return [];
    }
    if (size <= off) { off = Math.min(off, size); return []; }
    const len = size - off;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = openSync(file, 'r');
      readSync(fd, buf, 0, len, off);
    } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }

    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return [];                 // 只有半行，等下一次
    off += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');

    const out = [];
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out;
  };
}
