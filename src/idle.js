/**
 * idle.js — 「裸采集闲置自动收工」的判据（2026-11-09 用户要求 S1）。
 *
 * ## 解决的是什么
 *
 * `see_now({action:"start"})` 只起采集、不建常驻循环。循环那条线有自己的收工线
 * （`idleStopMin` / `maxAutonomousWakes`），**裸采集一条都没有** —— 模型 `start` 完
 * 忘了 `stop`，ffmpeg 就一直抓到 DSH 退出。实测过一次：2 分钟空转 1600+ 帧，
 * 屏幕一直被观看，而没有任何人在用那些帧。
 *
 * ## 判据为什么是这几条
 *
 * 只有「采集在跑 + 没人在用」才收工。可能"在用"的两种情况：
 *   - `loopActive`：常驻循环在跑 → 它自己那条收工线说了算，别双重管理；
 *   - `watching`：`watch` 正阻塞着等图（静止屏幕可能等几十秒）→ 这时候停采集，
 *     那一轮就白等了。
 *
 * **`pending` 不算占用**（2026-11-09 实测改的）：一开始拿"队列里有没人取走的图"当占用
 * 信号，结果裸采集的队列永远是 1 张（没人来取，图就一直躺着），于是**一次都没收工**。
 * 单人取图这套里"有人在等"只体现为 `watch` 在跑；躺着没人取的图是**结果**，不是需求。
 *
 * `idleMs` 从"最后一次有人要用图"算起（`start` / `watch` / `peek` 都会刷新），
 * 而不是从采集开始算 —— 一直在看的采集不该被收工。
 *
 * `limitMs <= 0` = 关掉这条线（用户配置里写 0）。
 */

/**
 * @param {{running?:boolean, loopActive?:boolean,
 *          watching?:boolean, idleMs?:number, limitMs?:number}} o
 * @returns {boolean} 该不该收工
 */
export function shouldIdleStop({
  running = false,
  loopActive = false,
  watching = false,
  idleMs = 0,
  limitMs = 0,
} = {}) {
  if (!(limitMs > 0)) return false;      // 0 / 负数 / NaN = 关掉
  if (!running) return false;
  if (loopActive) return false;
  if (watching) return false;
  return Number(idleMs) >= Number(limitMs);
}
