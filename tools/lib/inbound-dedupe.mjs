// inbound-dedupe —— 入站去重（同一个 message_id 只处理一次）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么需要（2026-11-07 全链检查）
// ══════════════════════════════════════════════════════════════════════
// OneBot 的上报没有"恰好一次"保证：网关重启、网络重连、上报重试都会让同一条
// 消息被投递两次。而 qq-server 的队列是串行的，重复投递的后果不是"多回一条"——
// 是**她会对同一句话连续回两次**，第二次还会带着"我刚回过"的上下文，
// 读起来像失忆（"你刚说了啊"）。
//
// 去重键用 message_id（网关分配的稳定 id）。没有 id 的消息不去重（宁可重一次，
// 也不能把两条正常消息当成一条吞掉）。
//
// 窗口 10 分钟、上限 500 条：一张 Map 就够，不需要落盘 ——
// 跨进程重启后的重复投递极罕见，且那种情况下"重一回"比"维护一份持久去重表"便宜。
const seen = new Map()
const WINDOW_MS = 10 * 60_000
const MAX = 500

export function isDuplicate(evt, now = Date.now()) {
  const id = evt?.message_id
  if (id === undefined || id === null || id === '') return false
  const key = String(id)
  const prev = seen.get(key)
  if (prev && now - prev < WINDOW_MS) return true
  seen.set(key, now)
  if (seen.size > MAX) {
    for (const [k, at] of seen) {
      if (now - at > WINDOW_MS) seen.delete(k)
    }
    while (seen.size > MAX) seen.delete(seen.keys().next().value)
  }
  return false
}

/** 诊断用。 */
export function stats() {
  return { size: seen.size, windowMs: WINDOW_MS, max: MAX }
}
