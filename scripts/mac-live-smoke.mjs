// macOS 端到端冒烟：真实屏幕 → 打分 → 留帧 → 拼图 → 落 PNG
//
//   node scripts/mac-live-smoke.mjs          # 看 10 秒
//   SEC=30 node scripts/mac-live-smoke.mjs   # 看 30 秒
//   DSH_FFMPEG_PATH=/path/to/ffmpeg node scripts/mac-live-smoke.mjs
//
// 输出在 /tmp/see-now-*.png。**只验屏幕源**；摄像头/obs 分支没在真机上跑过。
import { spawnFrames, pickScreenEngine, screenEngineWarning, resetScreenEngineCache, captureArgs } from '../src/capture.js';
import { createPipeline } from '../src/pipeline.js';
import { resolveFfmpeg } from '../src/binaries.js';
import { writeFileSync } from 'node:fs';

const FF = process.env.DSH_FFMPEG_PATH || resolveFfmpeg().path;
const W = 800, H = 450, FPS = 12, SEC = Number(process.env.SEC || 10);

resetScreenEngineCache();
const engine = await pickScreenEngine({ ffmpegPath: FF });
console.log('engine =', engine, '| warning =', screenEngineWarning());
console.log('cmd =', captureArgs({ source: { kind: 'screen' }, width: 800, height: 450, fps: 12, ffmpegPath: FF, engine }).slice(1).join(' '));

const p = createPipeline({ width: W, height: H, fps: FPS });
let firstMs = null;
let frames = 0;
let sheets = 0;

const run = spawnFrames({
  source: { kind: 'screen' },
  width: W, height: H, fps: FPS, ffmpegPath: FF, engine,
  onFirst: (ms) => { firstMs = ms; },
  onFrame: (f) => { frames += 1; p.push(f); },
  onStderr: (s) => { if (process.env.DBG) process.stderr.write(s); },
});

const t0 = Date.now();
const timer = setInterval(() => {
  const s = p.take();
  if (!s) return;
  sheets += 1;
  const name = `/tmp/see-now-${String(sheets).padStart(2, '0')}.png`;
  writeFileSync(name, s.png);
  console.log(`sheet ${sheets}: ${name}  frames=${s.frames.length} t=${s.from?.toFixed?.(2)}..${s.to?.toFixed?.(2)} bytes=${s.png.length}`);
}, 250);

await new Promise((r) => setTimeout(r, SEC * 1000));
clearInterval(timer);
const s = p.take();
if (s) { sheets += 1; writeFileSync(`/tmp/see-now-${String(sheets).padStart(2, '0')}.png`, s.png); console.log(`sheet ${sheets}(tail): frames=${s.frames.length}`); }
run.stop();
const wall = (Date.now() - t0) / 1000;
console.log(JSON.stringify({ wall, frames, fps: +(frames / wall).toFixed(2), firstMs, sheets }, null, 1));
