/**
 * relay-image.test.mjs — 浮窗图片投进会话时**只能是附件引用**（2026-11-26 事故的守门测试）。
 *
 * 事故现场：浮窗把图读成 base64，拼成 `{type:'image', data, mimeType}` 投进会话。
 * 合法形状只有 `{type:'image', attachment:{attachmentId,…}}`，而 `agent.followup()`
 * 这条路上没有任何准入校验 —— 投进去什么样就存什么样。于是那条会话在下一次请求时
 * 于 DeepSeek adapter 里读 `block.attachment.width` 抛 TypeError，被兜底包成
 * `TRANSPORT`（界面文案「DeepSeek Messages transport failed」）：5 次重试全废，
 * 坏块留在**持久历史**里，之后每一轮连纯文本都失败，会话被锁死。
 *
 * 所以这里钉两件事：
 *   ① 浮窗的本地图要先 `attachments.saveImage()` 换成引用，投出去的是引用；
 *   ② 内联 base64 形状**必须投递失败**，绝不能静默塞进会话（宁可让用户看到发送失败）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRelayImages } from '../src/index.js';
import { relaySendText } from '../src/interject.js';
import { wakeSession } from '../src/timer.js';

/** 1x1 透明 PNG，够用来当"一个磁盘上的图" */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const REF = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  width: 1,
  height: 1,
  bytes: PNG.length,
  name: 'shot.png',
};

function pngOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'see-now-relay-'));
  const path = join(dir, 'shot.png');
  writeFileSync(path, PNG);
  return path;
}

/** 只认 attachments 的假 ctx：`serviceOf` 先走 `ctx.get()` */
function ctxWithAttachments(saveImage) {
  const svc = saveImage === undefined ? null : { saveImage };
  return { get: (name) => (name === 'attachments' ? svc : undefined) };
}

/** 假 ctx：sessionController 给出一个能接消息的 agent，并记下投了什么 */
function ctxWithAgent() {
  const seen = [];
  const agent = { session: {}, followup: (msg) => { seen.push(msg); }, steer: (msg) => { seen.push(msg); } };
  return {
    seen,
    ctx: { get: (name) => (name === 'sessionController' ? { resolveAgent: async () => ({ agent }) } : undefined) },
  };
}

test('浮窗本地图先存附件库，投出去的是 attachment 引用', async () => {
  const path = pngOnDisk();
  let saved = null;
  const ctx = ctxWithAttachments(async (input) => { saved = input; return REF; });

  const out = await loadRelayImages({ ctx, text: `看图\n![图片](${path})`, log: () => {} });

  assert.equal(out.text, '看图', '图片 markdown 要从正文里摘掉');
  assert.equal(out.images.length, 1);
  assert.deepEqual(out.images[0], { attachment: REF }, '交出去的是引用，不是字节');
  assert.ok(saved?.data instanceof Uint8Array, 'saveImage 收到的是字节，不是 base64 字符串');
  assert.equal(saved.mediaType, 'image/png');
  assert.equal(saved.name, 'shot.png');
});

test('没有附件服务：退回原 markdown，绝不投内联 base64', async () => {
  const path = pngOnDisk();
  const out = await loadRelayImages({ ctx: ctxWithAttachments(undefined), text: `看图 ![图片](${path})`, log: () => {} });

  assert.equal(out.images.length, 0, '没有引用就不许有图片块');
  assert.match(out.text, /!\[图片\]\(/, '路径要留在正文里，模型还能自己读');
});

test('saveImage 失败：同样退回原 markdown，不许抛穿投递', async () => {
  const path = pngOnDisk();
  const ctx = ctxWithAttachments(async () => { throw new Error('IMAGES_TOO_LARGE'); });
  const out = await loadRelayImages({ ctx, text: `![图片](${path})`, log: () => {} });

  assert.equal(out.images.length, 0);
  assert.match(out.text, /!\[图片\]\(/);
});

test('超过 4MB 的图也交给 saveImage —— 归一化是 DSH 的事，4MB 是旧门槛', async () => {
  // 2026-11-27：原来的 4MB 是内联 base64 时代的保守值；现在 DSH 的附件库会把源图缩到
  // 2048² 像素 / ≤4MB（源图准入 50MB），插件不该先把它挡掉。手机照片常见 5–10MB。
  const dir = mkdtempSync(join(tmpdir(), 'see-now-relay-big-'));
  const path = join(dir, 'big.png');
  writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1, 7));
  let saved = null;
  const ctx = ctxWithAttachments(async (input) => { saved = input; return REF; });

  const out = await loadRelayImages({ ctx, text: `看图\n![图片](${path})`, log: () => {} });

  assert.ok(saved, '4MB 以上必须走到 saveImage，让 DSH 归一化');
  assert.equal(saved.data.byteLength, 4 * 1024 * 1024 + 1);
  assert.deepEqual(out.images, [{ attachment: REF }]);
  assert.equal(out.text, '看图');
});

test('followup 投出去的是 {type:"image", attachment}，一个字节都不带', async () => {
  const { ctx, seen } = ctxWithAgent();
  const r = await wakeSession(ctx, { sessionId: 'sid', text: '看图', images: [{ attachment: REF }] });

  assert.equal(r.ok, true);
  const images = seen[0].content.filter((part) => part.type === 'image');
  assert.deepEqual(images, [{ type: 'image', attachment: REF }]);
  for (const part of seen[0].content) {
    assert.equal(part.data, undefined, '内容块里不许出现内联字节');
    assert.equal(part.mimeType, undefined, '也不许出现线格式之外的键');
  }
});

test('内联 base64 形状投不进去 —— 这条就是 2026-11-26 事故的守门测试', async () => {
  const { ctx, seen } = ctxWithAgent();
  const r = await wakeSession(ctx, {
    sessionId: 'sid',
    text: '看看这张图',
    images: [{ data: PNG.toString('base64'), mimeType: 'image/png' }],
  });

  assert.equal(r.ok, false, '必须失败，不能"投成功了但是会话废了"');
  assert.match(String(r.reason), /附件引用/);
  assert.equal(seen.length, 0, '坏块一条都不许进会话');
});

test('relaySendText：纯图补 [图片]（可搜可引用），有字就照旧', () => {
  const img = [{ attachment: REF }];
  // 图文混排：正文照旧
  assert.equal(relaySendText({ text: '看图', images: img, fallback: '![图片](p)' }), '看图');
  // 纯图：补一行 `[图片]` —— `.34` 回退 `.33` 的留空，否则这条消息在主窗没有文字可搜
  assert.equal(relaySendText({ text: '', images: img, fallback: '![图片](C:\\x.png)' }), '[图片]');
  // 没图：沿用原话（历史行为）
  assert.equal(relaySendText({ text: '', images: [], fallback: '原话' }), '原话');
  // 拆完只剩空白也算纯图
  assert.equal(relaySendText({ text: '   ', images: img, fallback: 'x' }), '[图片]');
});

test('图片排在文字前面 —— 和浮窗原文顺序一致，[图片] 落在图下方', async () => {
  const { ctx, seen } = ctxWithAgent();
  await wakeSession(ctx, { sessionId: 'sid', text: '[图片]', images: [{ attachment: REF }] });
  assert.deepEqual(seen[0].content.map((p) => p.type), ['image', 'text']);
});
