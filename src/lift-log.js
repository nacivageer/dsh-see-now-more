/**
 * lift-log.js — 临时自检日志（P2-A 验收用）。
 *
 * 为什么要有它：`ctx.logger.info` 在 Desktop 里没有可读的落点（Electron 主进程控制台，
 * 打包后看不见），而验收第 2 条要的证据是「台词 t0 与取到的帧差多少毫秒」——
 * 只有这一行能给。纯文本、一行一条、写失败静默（记日志不许影响黑听）。
 *
 * **P2-B 接 `lift.jsonl` 时把这个文件删掉**：那边的记录是机读 JSON，这条只是取证用的。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chatDir } from './chat.js';

/**
 * 追加一行。
 * @param {string} text 已经拼好的内容（含 [lift] 前缀就按它原样写）
 * @returns {boolean} 写进去了没有
 */
export function appendLiftLog(text) {
  const line = String(text ?? '').trim();
  if (!line) return false;
  try {
    const dir = chatDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'lift.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
