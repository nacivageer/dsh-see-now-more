/**
 * lift/status.js — 黑听抬头的两行文案（留底 / 档位）。
 *
 * 为什么单独一个文件：这两行是 `see_now({action:"status"})` 里唯一能对账的地方，
 * 但它们的输入只有「runner 的采集账」和「lift 的档位账」，不需要碰采集、窗口或落盘。
 * 把格式化留在 `index.js` 里，测试就得为了两行字启动整个宿主。
 *
 * 纯函数：计数由调用方传进来，不读盘、不读配置。
 */

/**
 * 「留底」一行（黑听抬头的 P2-A）。
 *
 * 必须**分开说三件事**，不然「怎么取不到那一刻的画面」只能靠猜：
 *   - 关着（`lift.enabled:false`）→ 明确说配置项，别只写"没在留底"
 *   - 在留底 → 帧数 / 内存 / 窗口（验收第 1 条要的就是「留底中：N 帧 / ≈M MB」）
 *   - 没在采 → 为什么（没进仅监听 / 采集挂了，挂了的把错误原文带上）
 *
 * `stale`（最后一帧很久以前）也要说：帧还在、但已经不是"现在"了，
 * 那种状态下「瞥」拿到的会是几分钟前的画面 —— 必须看得见。
 */
export function liftLine(l) {
  // 关掉时一个字都不加（验收第 4 条：`lift.enabled:false` 之后 status 不显示留底，
  // 行为回到 P2-A 之前）。想确认配置有没有生效看 `status` 的 meta.lift。
  if (!l || !l.enabled) return null;
  if (!l.capturing) {
    return l.error
      ? `留底：没在采 —— ${l.error}`
      : '留底：没在采（进仅监听才留底；看画面时用不到它）';
  }
  const stale = l.stale ? `，最后一帧 ${l.ageSec}s 前（采集可能断了）` : '';
  return `留底中：${l.frames} 帧 / ≈${l.mb} MB`
    + `（最近 ${l.windowSec} 秒，${l.fps} fps${stale}）`;
}

/**
 * 「档位」一行（P2-B）：当前停在哪个档 + 今日各档计数。
 *
 * 用户问「它刚才叫得对不对」时，这行是唯一能对账的地方：档位说明"现在会不会打扰你"，
 * 计数说明"今天打扰了几次"。数字从 `lift.jsonl` 现算（按天切、重启不丢）——
 * 由调用方传 `counts`（`todayCounts()` 的结果），本文件不碰盘。
 */
export function liftGearLine(lp, l, counts) {
  const label = { alarm: '警觉', glance: '瞥', look: '看', chase: '追' };
  const now = lp?.lift?.level;
  const base = lp?.lift?.base ?? l?.level ?? 'glance';
  const cur = now === 'look' ? '看（抬头中）' : (label[base] ?? '瞥');
  const alarms = Number(lp?.lift?.alarms) || 0;
  const c = counts ?? {};
  return `档位：${cur}（基线 ${label[base] ?? base}）· 5 分钟警觉 ${alarms}`
    + ` · 今日 警觉 ${Number(c.alarm) || 0} · 瞥 ${Number(c.glance) || 0} · 看 ${Number(c.look) || 0}`;
}
