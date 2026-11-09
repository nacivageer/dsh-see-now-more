/**
 * 版本号一致性单测（2026-11-09）。
 *
 * 为什么要测：版本号写死在 `package.json` 与 `dsh.plugin.json` 两处，发版时手改一处、
 * 忘另一处就会漂 —— 而漂了之后，`install-dev` 装进去的插件名和 npm/宿主看到的包名
 * 会对不上，报错还离现场很远。`CHANGELOG.md` 那条同理：0.2.0-more.1 曾经在
 * CHANGELOG 里完全不存在（本仓首个 tag 之前发现的）。
 *
 * 这三条都只读文件，不起进程、不碰网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const readJson = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));

const pkg = readJson('package.json');
const plugin = readJson('dsh.plugin.json');

test('package.json 与 dsh.plugin.json 的 version 一致', () => {
  assert.equal(plugin.version, pkg.version,
    `package.json 是 ${pkg.version}，dsh.plugin.json 是 ${plugin.version}：发版时两处都要改`);
});

test('package.json 与 dsh.plugin.json 的 name 一致', () => {
  assert.equal(plugin.name, pkg.name,
    `package.json 是 ${pkg.name}，dsh.plugin.json 是 ${plugin.name}`);
});

test('CHANGELOG.md 里有当前版本的条目', () => {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const heading = `## [${pkg.version}]`;
  assert.ok(changelog.includes(heading),
    `CHANGELOG.md 里找不到「${heading}」：发版时补一段，否则升级的人不知道改了什么`);
});
