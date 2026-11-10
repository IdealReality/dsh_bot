// inbound-seq —— 入站序号：判断"这一轮生成期间，他是不是又说了新的"
//
// ══════════════════════════════════════════════════════════════════════
// 为什么需要（2026-11-07 实测）
// ══════════════════════════════════════════════════════════════════════
// 一条消息要经过：下载图片/抽视频帧 → 接话判断（可能停顿 1~5 秒）
// → 装配 → LLM（3~10 秒）→ 发送。全程 5~15 秒。
//
// 他连发两条（第二条没被合并时），第一条的流程还在跑，第二条已经进来了。
// 第一条最后发出去的那句话用的是**旧语境**——它不知道第二条说了什么。
// 表现就是：她答的是上一句，而他已经说到下一件事了。
//
// 做法：每条入站消息领一个单调序号；在两个"语境可能已过期"的位置检查：
//   ① 停顿之后（还没开始生成）——直接让位，省一次 LLM；
//   ② 生成之后（还没发出去）——丢弃，别发出一句对不上号的话。
//
// 窗口是 8 秒：超过 8 秒不算"连发"，那是两段独立的对话，旧回复照发。
// 这个判断必须是**进程内**的：所有平台（qq/微信/抖音）都进同一个宿主进程。

let seq = 0
let lastAt = 0
// 2026-11-07 十遍第八遍：序号必须**按会话**记。
// 旧版是进程级单例 —— 群里有人说话会把私聊正在生成的那条判成"过期"并丢掉，
// 两个通道（qq/微信）之间也一样。表现是"她有时不回我，但群里她明明回了"。
const byKey = new Map()   // key → { seq, at }

/** 一条消息到达：领号并记录时间。key 用 chatId（平台:会话）。 */
export function markInbound(now = Date.now(), key = '') {
  const k = String(key || '')
  lastAt = now
  const n = ++seq
  byKey.set(k, { seq: n, at: now })
  return n
}

/**
 * 这条是否已经过期（**同一会话**期间有更新的消息，且在连发窗口内）。
 * @param {number} mySeq
 * @param {number} [windowMs]
 * @param {number} [now]
 * @param {string} [key] 会话 key；给了就只看这个会话
 */
export function isStale(mySeq, windowMs = 8000, now = Date.now(), key = '') {
  const k = String(key || '')
  if (!k) return mySeq !== seq && now - lastAt < windowMs
  const cur = byKey.get(k)
  if (!cur) return false
  return mySeq !== cur.seq && now - cur.at < windowMs
}

/** 诊断用。 */
export function current(key = '') {
  if (key) return byKey.get(String(key)) || { seq: 0, at: 0 }
  return { seq, lastAt, sessions: byKey.size }
}
