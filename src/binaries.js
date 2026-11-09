/**
 * binaries.js — 找 ffmpeg 在哪。
 *
 * 为什么需要：DSH 桌面版把媒体工具装在 `~/.dsh/tools/ffmpeg/bin/`，**不进 PATH**
 * （和 dsh-video-storyboard 用的是同一份）。插件里写裸 `'ffmpeg'`，在 Windows 上
 * 可能刚好能用（OBS 之类会往 PATH 里塞），在 macOS 上就是 ENOENT —— 而这一个
 * ENOENT 会伪装成"插件坏了"。
 *
 * 优先级：
 *  1. 显式环境变量（DSH_FFMPEG_PATH / FFMPEG_PATH / DSH_FFMPEG_DIR）
 *  2. $DSH_HOME/tools/ffmpeg/bin/ffmpeg
 *  3. $DSH_HOME/bin/ffmpeg
 *  4. 裸 `ffmpeg`，交给 PATH —— 找不到时由 ffmpeg 自己报 ENOENT，错误信息原样保留
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exe = (platform) => (platform === 'win32' ? '.exe' : '');

/**
 * @param {{env?:NodeJS.ProcessEnv, platform?:NodeJS.Platform}} [opts]
 * @returns {{path:string, source:string}}
 */
export function resolveFfmpeg({ env = process.env, platform = process.platform } = {}) {
  const name = `ffmpeg${exe(platform)}`;
  const explicit = env.DSH_FFMPEG_PATH || env.FFMPEG_PATH || '';
  if (explicit) return { path: explicit, source: 'env' };

  const dir = env.DSH_FFMPEG_DIR;
  if (dir) return { path: join(dir, name), source: 'DSH_FFMPEG_DIR' };

  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  const candidates = [
    join(home, 'tools', 'ffmpeg', 'bin', name),
    join(home, 'bin', name),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return { path, source: path };
  }
  return { path: name, source: 'PATH' };
}
