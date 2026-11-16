/**
 * speaker.js — 在线说话人聚类（把每句的声纹归成 S1 / S2 / S3 …）。
 *
 * 输入是转写服务回的 `spk_emb`（L2 归一化后的 512 维，见 `H:\asr-local\server-sherpa.py`），
 * 输出是一个编号。**这里不猜名字**：名字要靠画面字幕或用户映射，编号只保证"同一人同一个号"。
 *
 * 为什么是"只增不改"的在线聚类，而不是离线 diarization：
 * 实时链路没有"整段音频"可回看，只能一句一句来。代价是两个人音色接近时会并号，
 * 所以阈值和上限都做成可调常量，配 `test/speaker.test.mjs` 守着。
 */

/** 余弦到质心超过这个值就认作同一人。0.6 是 eres2net 上的经验起点（偏保守：宁可分号也不要乱并）。 */
export const SPEAKER_MATCH = 0.6;
/** 最多开几个号。满了以后"最像谁就归谁"——宁可偶尔串号，也不要无限开新号。 */
export const SPEAKER_MAX = 6;
/** 向量长度下限：短于这个的说法不靠谱（实测 1–2 秒的「嗯。」相似度能在 0.6–0.8 乱跳）。 */
export const SPEAKER_MIN_DIM = 64;
/**
 * 只信**说得够多**的音频算出来的声纹（秒）。
 *
 * 2026-11-17 实报：13 句对白聚出了 S1–S6 六个号，因为那批句子大多只有 1–2 秒。
 * 后来发现更狠的一类：6 秒的片子里只有 0.3 秒人声（其余是环境声/静音），
 * 按"文件长度"判断会让杂音算出的垃圾向量独立成群 —— 所以这个门槛量的必须是
 * **说话长度**（服务端 VAD 各段时间之和），不是切片长度。
 */
export const SPEAKER_MIN_SEC = 1.2;
/** 相邻两句间隔小于这个值，就认为"还在同一个人说话"（短句沿用上一句的号）。 */
export const SPEAKER_CONTINUE_GAP_MS = 8000;

export function normalizeVec(vec) {
  const arr = (vec ?? []).map(Number);
  if (!arr.length) return [];
  let norm = 0;
  for (const x of arr) norm += x * x;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) return [];
  return arr.map((x) => x / norm);
}

export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return -1;
  return dot / Math.sqrt(na * nb);
}

/**
 * 造一个追踪器。`assign(emb)` 返回 `'S1' | 'S2' …`；向量不可用时返回 `null`
 * （调用方据此保留"没有说话人信息"，而不是硬塞一个号）。
 */
export function createSpeakerTracker({
  threshold = SPEAKER_MATCH, maxSpeakers = SPEAKER_MAX, minDim = SPEAKER_MIN_DIM,
} = {}) {
  /** @type {Array<{id:string, vec:number[], n:number}>} */
  const centroids = [];
  /**
   * **延迟开号**（2026-11-17 改）：新声音第一次出现时不立刻建簇，先挂在这里；
   * 下一次又出现一个"像它、但不像任何已有簇"的向量，才真的开号。
   *
   * 为什么：实测一场单人独白里，偶尔一句向量漂移就开出一个 S3/S4，
   * 而真正的换人通常不止一句。晚一句开号，比反复造人便宜得多。
   */
  let pending = null;
  return {
    assign(raw) {
      const vec = normalizeVec(raw);
      if (vec.length < minDim) return null;
      let best = -1;
      let bestCos = -1;
      for (let i = 0; i < centroids.length; i += 1) {
        const c = cosine(vec, centroids[i].vec);
        if (c > bestCos) { bestCos = c; best = i; }
      }
      if (best >= 0 && bestCos >= threshold) {
        const c = centroids[best];
        // 滑动平均更新质心（历史权重随样本数增长，新样本不会把质心拽走）
        const merged = vec.map((x, i) => (c.vec[i] * c.n + x) / (c.n + 1));
        c.vec = normalizeVec(merged);
        c.n += 1;
        return c.id;
      }
      // 第一个说话人不必等：没有"前任"可以参考，直接开 S1
      if (!centroids.length) {
        centroids.push({ id: 'S1', vec, n: 1 });
        pending = null;
        return 'S1';
      }
      // 不像任何已有簇：先看它像不像"上一次的候选"
      if (pending && cosine(vec, pending) >= threshold) {
        pending = null;
        if (centroids.length >= maxSpeakers) {
          return best >= 0 ? centroids[best].id : null;
        }
        const id = `S${centroids.length + 1}`;
        centroids.push({ id, vec, n: 1 });
        return id;
      }
      pending = vec;
      return null;                 // 第一次见：不给号，等它再出现一次
    },
    size() { return centroids.length; },
    /** 复位的不是"清空世界"，只是回到没有待定候选的状态。 */
    reset() { centroids.length = 0; pending = null; },
  };
}

/**
 * 给一句台词定编号：**够长才信声纹，短句沿用上一句**。
 *
 * @param {{emb:number[]|null, durSec:number, t0:number, last?:{t1:number,spk:string|null}|null,
 *          tracker:ReturnType<typeof createSpeakerTracker>}} o
 * @returns {string|null}
 */
export function resolveSpeaker({
  emb, durSec, t0, last = null, tracker,
  minSec = SPEAKER_MIN_SEC, gapMs = SPEAKER_CONTINUE_GAP_MS,
}) {
  if (emb && Number(durSec) >= minSec && tracker) {
    const spk = tracker.assign(emb);
    if (spk) return spk;
  }
  if (last?.spk && Number(t0) - Number(last.t1) <= gapMs) return last.spk;
  return null;
}
