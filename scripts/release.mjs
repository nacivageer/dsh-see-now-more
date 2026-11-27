#!/usr/bin/env node
/**
 * release.mjs — 发版六步里**机械的那部分**：验 → tag → push → Release → 装进 profile。
 *
 * 为什么要它（2026-11-27）：`docs/决策记录.md` 的六步一步不能少，但 2026-11-27 这一天
 * 打了 12 个 tag，每一步都是照抄 —— 抄错一次（`--amend` 带上别的 message、版本三处不齐）
 * 就要回头收拾。人在重复动作上的错误率和次数成正比，脚本不。
 *
 * 它**不生成** CHANGELOG 段、不改版本号、不写正文：那三件要人判断（这一版改了什么、
 * 参数/数字有没有落进 README 与 `src/tool-spec.js` —— 六步的第 1、2、3 步）。
 * 脚本只接手「已经写好、已经提交，接下来怎么把它变成远端的一个锚点」。
 *
 * ─── write-guard 六问（新增写能力前必须答，见 `~/.dsh/skills/write-guard`）───
 * 1. 改谁的状态：本仓 git（本地 tag）、远端 `main`（push）、GitHub 公开 Release（对外可见）。
 * 2. 关掉开关后还会不会自己跑：它不是模型可见工具，只能人手调；对应约束 = **默认 dry-run**，
 *    不加 `--go` 一个字节都不动。
 * 3. 失败/超时：任何一步非零、或回读对不上 → 停、打印「已完成 / 未知」、给恢复命令，**不重试**。
 *    `git-push.ps1` 自己会在直连 / 代理之间换一次，那是它的事，这里不叠第二层。
 * 4. 范围（白名单）：tag 必须匹配 `/^0\.1\.1-more\.\d+$/`；remote 必须指向
 *    `nacivageer/dsh-see-now-more`；分支必须是 `main`。没有 `--repo` / `--tag` / `--branch`。
 * 5. 结果不明：push 之后 `git ls-remote` 回读、Release 之后 `gh release view` 回读；
 *    回读失败就是「不知道」，不写成成功。
 * 6. 撤销：末尾打印三条撤销命令；**Release 一旦公开推出去就撤不回来**（别人可能已经收到
 *    Watch / RSS 通知），这一项标 irreversible。
 *
 * 双条件（约束 3）：`--go` **且** `~/.dsh/see-now-release.json` 里
 * `{"allow": true, "until": "YYYY-MM-DD", "repos": ["nacivageer/dsh-see-now-more"]}`，
 * `until` 未过期、且 `repos` 含本仓。缺 / 过期 / 写坏 / 没写范围 → 拒绝执行（fail-closed）。
 * 路径可用 `DSH_SEE_RELEASE_AUTH` 覆盖（给测试用）。
 *
 * **这份文件建一次、长期有效，不是每次发版的手续**（2026-11-27 更正）：发版这件事的许可在
 * 对话里 —— 人每次都在场、每次会说发哪个版本；文件管的是「哪个仓、到哪天为止」这种不该
 * 每次重问的东西。上一版让用户每次重建一份当天过期的文件，只增加了她的动作，没有增加
 * 任何真实约束（文件是她授权、命令是我跑，她重建多少次都不改变这一点）。
 *
 * 跑法：
 *   node scripts/release.mjs            # dry-run：验一遍前置条件、打印将要执行的命令
 *   node scripts/release.mjs --go       # 真发
 *   node scripts/release.mjs --simulate # 只打印命令，连 git 也不问（给测试 / 没网时看流程）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_RE = /^0\.1\.1-more\.\d+$/;
const REPO_RE = /nacivageer\/dsh-see-now-more/;
const BRANCH = 'main';

/* ---------------------------------------------------------------- 纯函数（可单测） */

export function parseArgs(argv) {
  const out = { go: false, simulate: false, help: false };
  for (const a of argv) {
    if (a === '--go') out.go = true;
    else if (a === '--simulate') out.simulate = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  // 两个都传时按「只想看流程」处理：simulate 不执行，go 就没有意义
  if (out.go && out.simulate) out.go = false;
  return out;
}

export function authPath(env = process.env) {
  return env.DSH_SEE_RELEASE_AUTH || join(homedir(), '.dsh', 'see-now-release.json');
}

/** 授权文件：`{allow: true, until: "YYYY-MM-DD"}`。fail-closed —— 读不到就是不许。 */
export function readAuth(path, today = new Date()) {
  if (!existsSync(path)) {
    return { ok: false, reason: `没有授权文件 ${path}` };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `授权文件不是合法 JSON：${e.message}` };
  }
  if (raw?.allow !== true) return { ok: false, reason: '授权文件里 allow 不是 true' };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw.until || ''));
  if (!m) return { ok: false, reason: '授权文件里 until 必须是 YYYY-MM-DD' };
  const until = new Date(`${raw.until}T23:59:59`);
  // `new Date('2027-02-31')` 会静默滚到 3 月 3 日 —— 打错的日子不该把授权悄悄延长到别的日期
  if (Number.isNaN(until.getTime())
      || until.getFullYear() !== Number(m[1])
      || until.getMonth() + 1 !== Number(m[2])
      || until.getDate() !== Number(m[3])) {
    return { ok: false, reason: `until 不是真实日期：${raw.until}` };
  }
  if (until < today) return { ok: false, reason: `授权已过期（until=${raw.until}）` };
  // 「范围」不是装饰：一个空着或指别处的授权文件，等于没有边界。**长期有效，
  // 不用每次发版重建** —— 发版这件事的许可在对话里（人每次都在场），文件管的是
  // 「哪个仓、到哪天为止」，那两样才是可以事先说清、不该每次重问的。
  const repos = Array.isArray(raw.repos) ? raw.repos.map(String).filter(Boolean) : [];
  if (!repos.length) {
    return { ok: false, reason: '授权文件没写范围：要一个非空的 repos 数组（例 ["nacivageer/dsh-see-now-more"]）' };
  }
  return { ok: true, reason: `授权到 ${raw.until}（范围 ${repos.join(', ')}）`, repos };
}

/** 从 remote URL 里取出 `owner/repo`（https / ssh 两种写法都认）。 */
export function repoOf(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function validateVersion(version, pluginVersion) {
  if (!VERSION_RE.test(String(version || ''))) {
    return { ok: false, reason: `版本号不在白名单形状里（要 0.1.1-more.N）：${version}` };
  }
  if (pluginVersion !== undefined && pluginVersion !== version) {
    return { ok: false, reason: `dsh.plugin.json 是 ${pluginVersion}，package.json 是 ${version}` };
  }
  return { ok: true, tag: `v${version}` };
}

/** 从 CHANGELOG 取某版本那一段（到下一个 `## [` 为止）。取不到 / 空段 → null。 */
export function changelogSection(text, version) {
  const lines = String(text).split(/\r?\n/);
  const head = `## [${version}]`;
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## [')) { end = i; break; }
  }
  // 只有标题没有正文 = 变更说明还没写，别拿它去发 Release（六步第 3 步没做完）
  if (!lines.slice(start + 1, end).join('').trim()) return null;
  return lines.slice(start, end).join('\n').trim();
}

/** 要跑的命令清单（顺序就是六步里剩下的那几步）。纯函数，方便测。 */
export function buildSteps({ version, notesFile, homedir: home = homedir() }) {
  const tag = `v${version}`;
  return [
    { name: 'node --test', cmd: process.execPath, args: ['--test'] },
    { name: 'selftest-ui.py', cmd: 'python', args: [join('scripts', 'selftest-ui.py')] },
    { name: `git tag ${tag}`, cmd: 'git', args: ['tag', '-a', tag, '-m', `release ${tag}`] },
    {
      name: 'git-push.ps1 -TagAtHead',
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        join(home, '.dsh', 'tools', 'git-push.ps1'), '-TagAtHead'],
    },
    {
      name: `gh release create ${tag}`,
      cmd: 'gh',
      args: ['release', 'create', tag, '--prerelease', '--title', tag, '--notes-file', notesFile],
    },
    { name: 'install-dev.mjs', cmd: process.execPath, args: [join('scripts', 'install-dev.mjs')] },
  ];
}

/* ---------------------------------------------------------------- 执行侧 */

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return {
    code: r.error ? -1 : (r.status ?? -1),
    out: (r.stdout || '') + (r.stderr || ''),
    error: r.error,
  };
}

function tail(text, n = 20) {
  const lines = String(text || '').trimEnd().split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function refuse(lines) {
  for (const l of [].concat(lines)) console.log(`STOP  ${l}`);
  process.exit(1);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log('node scripts/release.mjs [--go] [--simulate]   （默认 dry-run，见文件头）');
    return;
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8'));
  const version = pkg.version;
  const v = validateVersion(version, plugin.version);
  if (!v.ok) refuse([v.reason, '（版本号 / 三处对齐是第 2、3 步，脚本不改它们）']);
  const tag = v.tag;

  const changelog = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (!changelog) refuse([`CHANGELOG.md 里没有 [${version}] 那一段，或者只有标题`, '（六步第 3 步没做完）']);

  const auth = readAuth(authPath());
  console.log(`gate  version   ${version}  (tag ${tag})`);
  console.log(`gate  changelog ${changelog.split(/\r?\n/).length} 行正文`);
  console.log(`gate  auth      ${auth.ok ? 'ok' : 'REFUSED'} — ${auth.reason}`);

  // simulate：不碰 git / gh，只把命令打出来（给测试和「先看看流程」用）
  const notesFile = join(ROOT, '.tmp', `release-notes-${version}.md`);
  const steps = buildSteps({ version, notesFile });
  if (args.simulate) {
    console.log('\n-- simulate：下面这些不会被执行 --');
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}  ->  ${s.cmd} ${s.args.join(' ')}`));
    console.log(`\nnotes: ${notesFile}`);
    return;
  }

  if (!auth.ok) {
    refuse([
      auth.reason,
      `建 ${authPath()} ：{"allow": true, "until": "2027-11-27", "repos": ["nacivageer/dsh-see-now-more"]}`,
      '（建一次就够：这份文件管「哪个仓、到哪天」，不管「这一次发不发」；发不发在对话里定）',
    ]);
  }

  // 前置条件：树干净、在 main、remote 是本仓、tag 不存在
  const st = run('git', ['status', '--porcelain']);
  if (st.code !== 0) refuse(['git status 都跑不了：', tail(st.out, 5)]);
  if (st.out.trim()) refuse(['工作树不干净，先把改动提交或收进 .tmp：', tail(st.out, 8)]);

  const br = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (br.out.trim() !== BRANCH) refuse([`当前分支是 ${br.out.trim()}，发版只允许 ${BRANCH}`]);

  const remote = run('git', ['remote', 'get-url', 'origin']);
  if (!REPO_RE.test(remote.out)) refuse([`origin 不是本仓：${remote.out.trim()}`]);
  const repo = repoOf(remote.out);
  if (!repo || !auth.repos.includes(repo)) {
    refuse([
      `授权文件的 repos 里没有 ${repo || remote.out.trim()}`,
      `文件里写的是：${auth.repos.join(', ')}`,
    ]);
  }

  const exists = run('git', ['tag', '-l', tag]);
  if (exists.out.trim()) refuse([`本地已经有 ${tag}，别再打一次（版本号要往前走）`]);

  console.log(`gate  git       ${BRANCH} / clean / origin ok / ${tag} 不存在`);

  if (!args.go) {
    console.log('\n-- dry-run：没有 --go，一个字节都没动 --');
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}`));
    console.log('\n真发：node scripts/release.mjs --go');
    return;
  }

  // 落一份 Release 正文（也是证据），再开始动
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  writeFileSync(notesFile, `${changelog}\n`, 'utf8');
  console.log(`notes ${notesFile}`);

  const done = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    console.log(`\n[${i + 1}/${steps.length}] ${s.name}`);
    const r = run(s.cmd, s.args, { timeout: 15 * 60_000 });
    if (r.code !== 0) {
      console.log(tail(r.out));
      console.log('\nSTOP  这一步没成。**不重试、不换路径**（write-guard 约束 4）。');
      console.log(`已完成：${done.length ? done.join(' -> ') : '（无）'}`);
      console.log(`未知：${s.name} 之后全部没做`);
      console.log('\n恢复（按顺序看，别跳）：');
      if (done.some((d) => d.startsWith('git tag'))) {
        console.log(`  git tag -d ${tag}                      # 本地 tag 收掉，改完重来`);
      }
      console.log('  上面的输出就是原因；改完重跑 node scripts/release.mjs --go');
      console.log('  如果只是想看远端到哪一步了：git ls-remote --tags origin | grep ' + tag);
      if (s.name.startsWith('selftest')) {
        console.log('  selftest 退出码 2 = 悬浮窗没开：开窗后重跑，或手动走六步');
      }
      process.exit(1);
    }
    done.push(s.name);
    if (s.name.startsWith('node --test')) console.log(tail(r.out, 6));
    else console.log(tail(r.out, 4) || 'ok');
  }

  // 回读：把「发出了」和「生效了」分开记
  console.log('\n-- 回读 --');
  const ls = run('git', ['ls-remote', '--tags', 'origin', tag]);
  const remoteOk = ls.code === 0 && ls.out.includes(`refs/tags/${tag}`);
  console.log(`${remoteOk ? 'ok   ' : 'UNKNOWN'} remote tag  ${remoteOk ? '在' : ls.out.trim() || '没读到'}`);

  const rel = run('gh', ['release', 'view', tag, '--json', 'tagName,isPrerelease']);
  let relOk = false;
  let prerelease = null;
  try {
    const j = JSON.parse(rel.out);
    relOk = j.tagName === tag;
    prerelease = j.isPrerelease;
  } catch { /* 下面的 UNKNOWN 就是答案 */ }
  console.log(`${relOk ? 'ok   ' : 'UNKNOWN'} release     ${relOk ? `${tag} prerelease=${prerelease}` : '没读到（自己去页面上核）'}`);

  console.log(`\n完成：${tag}（${done.length} 步）`);
  console.log('\n窗进程还跑着旧代码：window.py 是启动时读进内存的，这一版改过就要重开');
  console.log('  node bin/see-window.mjs --force   # 没碰 window.py 就不用；宿主侧 JS 变了要重启 DSH');
  console.log('撤销（Release 已经公开推出去，撤不回别人收到的通知）：');
  console.log(`  gh release delete ${tag} --yes`);
  console.log(`  git push origin :refs/tags/${tag}`);
  console.log(`  git tag -d ${tag}`);
  process.exit(relOk && remoteOk ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (e) {
    console.error(`release crashed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}
