/**
 * install-state.mjs — profile 里那份插件副本的「五态」判定。
 *
 * 来自下游评估 §2 的安全三件套（2026-11-17 落地）：extras 的补丁层用
 * `pristine/patched/absent/foreign/missing` 五态决定「能不能动、要不要拒绝」；
 * 我们的 `install-dev` 只有「装了/没装」，于是版本不一致、目录残缺、别人的同名包
 * 都只能靠人眼分辨。这里把它抽成纯函数，`--check` 与安装前检查共用。
 *
 * 五态：
 *   absent   目录不存在（没装）
 *   foreign  目录在，但 package.json 的 name 不是我们（别人的同名包 / 手放的目录）
 *   broken   是我们的名字，但入口或版本读不到（装到一半 / 被删了文件）
 *   stale    是我们的包，版本和源码不一致（跑的是旧代码）
 *   current  是我们的包，版本与源码一致
 *
 * 纯函数：不读盘、不抛。读盘与打印留给 `install-dev.mjs`。
 */

export const INSTALL_STATES = Object.freeze(['absent', 'foreign', 'broken', 'stale', 'current']);

export const DEFAULT_PKG_NAME = 'dsh-see-now-more';

/**
 * @param {{exists?:boolean, name?:string|null, version?:string|null,
 *          repoVersion?:string|null, entryExists?:boolean, expectedName?:string}} o
 * @returns {'absent'|'foreign'|'broken'|'stale'|'current'}
 */
export function classifyInstall({
  exists = false,
  name = null,
  version = null,
  repoVersion = null,
  entryExists = false,
  expectedName = DEFAULT_PKG_NAME,
} = {}) {
  if (!exists) return 'absent';
  if (name !== expectedName) return 'foreign';
  if (!entryExists || !version) return 'broken';
  return version === repoVersion ? 'current' : 'stale';
}

/** 人话解释（`--check` 与安装前拒绝时共用一句）。 */
export function describeInstall(state, { version = null, repoVersion = null } = {}) {
  switch (state) {
    case 'absent': return '没装（profile 里没有这份副本）';
    case 'foreign': return '目录在，但不是本包（name 对不上）——不覆盖，先确认它是什么';
    case 'broken': return '我们的包，但入口/版本读不到（装到一半或文件被删）——建议重装';
    case 'stale': return `跑的是旧代码（副本 ${version ?? '?'} / 源码 ${repoVersion ?? '?'}）——要 install + 重启`;
    case 'current': return '副本与源码一致';
    default: return `未知状态：${state}`;
  }
}
