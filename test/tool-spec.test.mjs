/**
 * `see_now` 工具契约单测（2026-11-17）。
 *
 * 为什么要测：`parameters` 是模型唯一能看到的说明书，它跟 `index.js` 的实际读取是两份
 * 各自演化的东西。2026-11-17 量账时一次查出三处漂移：
 *
 *   - `read`（血条读一次）在 `index.js` 里读、在 `action` 的散文里教模型传，却没在
 *     `parameters` 里声明 —— 宿主不拒未声明参数（编译出的对象没有 `additionalProperties:false`），
 *     所以它靠散文活着；描述的散文一压缩，这条路就断了；
 *   - `keep` / `t0` 是没有任何文档的别名（前者等价 `task`，后者等价 `since`）；
 *   - `lift` 在 description 里、也在唤醒文案里（`see_now({action:"lift", since:…})`），
 *     但 `action` 的取值列表和 `index.js` 的兜底提示都没有它。
 *
 * 另外压到 5.4k 字符（≈1.9k token）之后要**挡住回涨**：这份定义每一步都在宿主的工具前缀
 * 里重发，加长文之前先看 `SPEC_BUDGET_CHARS` 那条。
 *
 * 全部只读文件、不起进程、不碰网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seeNowToolSpec, ACTION_VALUES, TOOL_NAME } from '../src/tool-spec.js';
import { PACES, SIZES } from '../src/runner.js';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const INDEX = read('src', 'index.js');
const spec = seeNowToolSpec();
const declared = Object.keys(spec.parameters);

/** 模型侧体积上限（字符）。留出约 30% 余量：加参数要它自己带说明，长文请进 docs。 */
const SPEC_BUDGET_CHARS = 7500;

test('工具名只有一个真源', () => {
  assert.equal(spec.name, TOOL_NAME);
});

test('`index.js` 读到的每个参数都在 schema 里声明', () => {
  const used = new Set();
  for (const m of INDEX.matchAll(/args\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !declared.includes(k));
  assert.deepEqual(missing, [],
    `这些参数 index.js 会读、schema 里没有：${missing.join(', ')} —— `
    + '模型只能从散文里猜到它们，压缩描述时就会失联');
});

test('每个声明都有非空 description', () => {
  for (const [key, value] of Object.entries(spec.parameters)) {
    assert.ok(typeof value.description === 'string' && value.description.trim().length > 0,
      `参数 ${key} 没有 description：模型看到的是一个裸字段名`);
  }
});

test('action 的每个取值在 route 里都有分支（含 lift）', () => {
  assert.ok(ACTION_VALUES.includes('lift'),
    'lift 不在 ACTION_VALUES 里：唤醒文案会叫模型调一个「不存在」的动作');
  for (const value of ACTION_VALUES) {
    assert.ok(INDEX.includes(`action === '${value}'`),
      `action:"${value}" 出现在 schema 里，但 index.js 里没有 \`action === '${value}'\` 分支`);
  }
});

test('enum 的取值都在实现里存在', () => {
  assert.deepEqual(spec.parameters.action.enum, [...ACTION_VALUES],
    'action.enum 必须由 ACTION_VALUES 生成：两处手抄会漂');
  for (const value of spec.parameters.pace.enum) {
    assert.ok(Object.hasOwn(PACES, value), `pace 的 "${value}" 不在 PACES 里（跑起来会被静默忽略）`);
  }
  for (const value of spec.parameters.quality.enum) {
    assert.ok(Object.hasOwn(SIZES, value), `quality 的 "${value}" 不在 SIZES 里（跑起来会被静默忽略）`);
  }
});

test('默认值写在 schema 上，不靠散文解释', () => {
  assert.equal(spec.parameters.action.default, 'watch');
  assert.equal(spec.parameters.pace.default, 'normal');
  assert.equal(spec.parameters.quality.default, 'low');
  assert.equal(spec.parameters.source.default, 'screen');
  assert.equal(spec.parameters.seconds.default, 300);
  assert.equal(spec.parameters.minFrames.default, 1);
});

test('模型侧体积在预算内', () => {
  const size = JSON.stringify({ name: spec.name, description: spec.description, parameters: spec.parameters }).length;
  assert.ok(size <= SPEC_BUDGET_CHARS,
    `see_now 的定义 ${size} 字符，超过预算 ${SPEC_BUDGET_CHARS}：`
    + '这份文字每一步都在前缀里重发（每 1,000 token ≈ 全历史 ¥1.4），长文放 docs');
});
