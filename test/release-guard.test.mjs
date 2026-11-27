/**
 * release-guard.test.mjs — 发版脚本的护栏（`scripts/release.mjs`）。
 *
 * 这个脚本会打 tag、推远端、建**公开** Release，所以护栏必须自己先有测试：
 *   - 版本号白名单（`0.1.1-more.N`，别的一律不发）；
 *   - 授权文件 fail-closed（缺 / 写坏 / 过期 / allow 不是 true → 拒绝）；
 *   - 默认 dry-run（没有 `--go` 一个字节都不动）；
 *   - `--simulate` 只打印命令。
 *
 * 这些用例都**不会**碰真实的 git / gh：拒绝路径在读授权那一刻就退出了，
 * simulate 路径连 git 都不问。唯一的外部依赖是仓库里的 package.json / CHANGELOG.md。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  authPath, buildSteps, changelogSection, readAuth, validateVersion,
} from '../scripts/release.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VER = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [join('scripts', 'release.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
}

function tmpAuth(json) {
  const dir = mkdtempSync(join(tmpdir(), 'see-release-'));
  const p = join(dir, 'auth.json');
  writeFileSync(p, typeof json === 'string' ? json : JSON.stringify(json), 'utf8');
  return { path: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('validateVersion：只认 0.1.1-more.N，且三处必须同值', () => {
  assert.equal(validateVersion('0.1.1-more.46').ok, true);
  assert.equal(validateVersion('0.1.1-more.46', '0.1.1-more.46').ok, true);
  for (const bad of ['0.2.0', '0.1.1', '0.1.1-more', '0.1.1-more.46-alpha',
    '0.1.1-more.x', 'v0.1.1-more.46', '', null, undefined]) {
    assert.equal(validateVersion(bad).ok, false, `应拒绝：${bad}`);
  }
  const mm = validateVersion('0.1.1-more.46', '0.1.1-more.45');
  assert.equal(mm.ok, false);
  assert.match(mm.reason, /dsh\.plugin\.json/);
});

test('readAuth：缺 / 坏 / allow 非 true / 过期 都拒绝，合法的放行', () => {
  const today = new Date('2026-11-27T12:00:00');
  assert.equal(readAuth('/definitely/not/here.json', today).ok, false);

  const broken = tmpAuth('{not json');
  try { assert.equal(readAuth(broken.path, today).ok, false); } finally { broken.cleanup(); }

  for (const [label, json] of [
    ['allow=false', { allow: false, until: '2027-01-31' }],
    ['没有 until', { allow: true }],
    ['until 形状不对', { allow: true, until: '2027/1/31' }],
    ['until 不存在', { allow: true, until: '2027-02-31' }],
    ['已过期', { allow: true, until: '2026-11-26' }],
  ]) {
    const t = tmpAuth(json);
    try {
      assert.equal(readAuth(t.path, today).ok, false, `${label} 应被拒绝`);
    } finally { t.cleanup(); }
  }

  const okAuth = tmpAuth({ allow: true, until: '2027-01-31' });
  try {
    const r = readAuth(okAuth.path, today);
    assert.equal(r.ok, true);
    assert.match(r.reason, /2027-01-31/);
  } finally { okAuth.cleanup(); }
});

test('authPath：默认在 ~/.dsh，可被 DSH_SEE_RELEASE_AUTH 覆盖（测试用）', () => {
  assert.match(authPath({}), /see-now-release\.json$/);
  assert.equal(authPath({ DSH_SEE_RELEASE_AUTH: 'C:/x/y.json' }), 'C:/x/y.json');
});

test('changelogSection：取到本版、止于下一个二级标题、空段当没有', () => {
  const text = [
    '# Changelog', '',
    '## [0.1.1-more.46] - 2026-11-27', '', '### Added — 新东西', '- 一条说明', '',
    '## [0.1.1-more.45] - 2026-11-27', '', '- 旧的一行', '',
  ].join('\n');
  const body = changelogSection(text, '0.1.1-more.46');
  assert.ok(body.includes('一条说明'));
  assert.ok(!body.includes('旧的一行'), '不能把下一个版本的内容带进来');
  assert.equal(changelogSection(text, '0.1.1-more.99'), null);
  assert.equal(changelogSection('## [0.1.1-more.46] - 2026-11-27\n\n', '0.1.1-more.46'), null);
});

test('buildSteps：六步里的四件事，顺序与参数都对得上（prerelease / TagAtHead）', () => {
  const steps = buildSteps({ version: '0.1.1-more.46', notesFile: '/tmp/n.md', homedir: 'C:/Users/x' });
  const names = steps.map((s) => s.name);
  assert.equal(steps.length, 6);
  assert.match(names[0], /node --test/);
  assert.match(names[1], /selftest-ui/);
  assert.match(names[2], /git tag v0\.1\.1-more\.46/);
  assert.match(names[3], /git-push\.ps1 -TagAtHead/);
  assert.match(names[4], /gh release create v0\.1\.1-more\.46/);
  assert.match(names[5], /install-dev/);

  const gh = steps[4].args;
  assert.ok(gh.includes('--prerelease'), '带 -more.N 的版本必须标 prerelease');
  assert.ok(gh.includes('/tmp/n.md'));
  const push = steps[3].args;
  assert.ok(push.some((a) => a.endsWith(join('.dsh', 'tools', 'git-push.ps1'))),
    `push 步骤要指向 ~/.dsh/tools/git-push.ps1，实际：${push.join(' ')}`);
  // 白名单：没有让调用方指定仓库 / 分支 / tag 形状的入口
  for (const s of steps) {
    assert.ok(!s.args.includes('--repo'), '不允许指定别的仓库');
    assert.ok(!s.args.includes('--branch'), '不允许指定别的分支');
  }
});

test('CLI 默认 dry-run：缺授权文件就拒绝（STOP），一个字节都不动', () => {
  const r = runCli([], { DSH_SEE_RELEASE_AUTH: join(tmpdir(), 'nope-see-release.json') });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /STOP/);
  assert.match(r.stdout, /授权文件/);
  // 没有 --go 时不许出现任何「已开始执行」的行
  assert.ok(!/^\s*\[1\/6\]/m.test(r.stdout), 'dry-run 不该开始执行步骤');
});

test('CLI：授权过期 → 拒绝，并说清 until', () => {
  const t = tmpAuth({ allow: true, until: '2020-01-01' });
  try {
    const r = runCli([], { DSH_SEE_RELEASE_AUTH: t.path });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /已过期/);
    assert.match(r.stdout, /2020-01-01/);
  } finally { t.cleanup(); }
});

test('CLI --simulate：只打印命令，不跑 git、不问授权', () => {
  const r = runCli(['--simulate'], { DSH_SEE_RELEASE_AUTH: join(tmpdir(), 'nope-see-release.json') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /simulate/);
  assert.match(r.stdout, /git tag -a v0\.1\.1-more\./);
  assert.match(r.stdout, /gh release create/);
  assert.match(r.stdout, /install-dev\.mjs/);
  assert.ok(!/^\s*\[1\/6\]/m.test(r.stdout), 'simulate 不该开始执行步骤');
});

test('CLI 参数：不认识的参数直接退 2，不当成 --go', () => {
  const r = runCli(['--force'], { DSH_SEE_RELEASE_AUTH: join(tmpdir(), 'nope-see-release.json') });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /不认识的参数/);
});

test('版本线守卫：package.json 的版本必须在白名单形状里（否则脚本永远发不出去）', () => {
  const v = validateVersion(VER);
  assert.equal(v.ok, true, `package.json 现在是 ${VER}`);
});
