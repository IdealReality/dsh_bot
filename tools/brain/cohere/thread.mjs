// cohere/thread —— 哲学层：对话线程 / 意向性 / 承诺
//
// ══════════════════════════════════════════════════════════════════════
// 为什么"最近 24 条对话"不够
// ══════════════════════════════════════════════════════════════════════
// recent() 给的是**流水**：谁说了什么，按时间排。
// 流水里没有三样人聊天时必须有的东西：
//   ① 我们**在谈什么**（topic）—— 24 条里可以有三个话题，模型得自己挑
//   ② 他**要我做什么**（goal）—— 这是意向性，流水只有字面
//   ③ 我**已经问过什么 / 答应过什么**（open questions / commitments）
//
// 缺了 ②③，就会出现实测里那种回复：
//   「你要真有活儿，就说清楚是嘲讽哪条」——他上一句已经说清楚了；
//   「你到底想让我干嘛啊」——同一个问题在两轮里问了两遍。
//
// 这一层是**第一人称的**，不是数据库：它记录的是"我此刻认为我们在干什么"。
// 允许它错，也允许被下一句纠正（REPAIR 会覆盖 goal）—— 人的理解本来就这样。
//
// 落盘位置：~/.data/brain/cohere/<chat>.json（每会话一个，独立文件，
// 不用全局大 JSON —— 并发写两个会话时不会互相覆盖）。
import { readJson, mutateJson } from '../json.mjs'
import { dataPath } from '../../lib/paths.mjs'
import { swallow } from '../../lib/swallow.mjs'

const MAX_MOVES = 8
const MAX_Q = 6
const MAX_COMMIT = 6

// 文件名里不能有 ':' —— Windows 上会直接 ENOENT（锁建不出来 → mutateJson 返回 null）。
// 生产在 Linux 上冒号合法，但"在本机能跑、在开发机跑不了"是测试隔离最坏的形状。
// 与 brain/working 的命名对齐：qq:123 → qq_123.json。
const safeChat = (chatId) => String(chatId || 'qq:unknown').replace(/[^\w.@-]/g, '_')
const fileOf = (chatId) => dataPath('brain', 'cohere', safeChat(chatId) + '.json')

const empty = (chatId) => ({
  chat: String(chatId || ''),
  at: 0,
  topic: '',
  topics: [],
  goal: null,
  goalAt: 0,
  goalDone: false,
  open: [],
  myQuestions: [],
  commitments: [],
  moves: [],
  lastUserAt: 0,
  lastMeAt: 0,
  unanswered: false,
  stage: 'opening',
  turns: 0,
})

function hydrate(raw, chatId) {
  const st = { ...empty(chatId), ...(raw || {}) }
  st.topics = Array.isArray(st.topics) ? st.topics.slice(-10) : []
  st.open = Array.isArray(st.open) ? st.open.slice(-MAX_Q) : []
  st.myQuestions = Array.isArray(st.myQuestions) ? st.myQuestions.slice(-MAX_Q) : []
  st.commitments = Array.isArray(st.commitments) ? st.commitments.slice(-MAX_COMMIT) : []
  st.moves = Array.isArray(st.moves) ? st.moves.slice(-MAX_MOVES) : []
  st.goal = st.goal && typeof st.goal === 'object' ? st.goal : null
  st.turns = Number(st.turns) || 0
  st.at = Number(st.at) || 0
  return st
}

export function load(chatId) {
  try { return hydrate(readJson(fileOf(chatId), null), chatId) } catch { return empty(chatId) }
}

export function save(chatId, st) {
  try {
    return mutateJson(fileOf(chatId), empty(chatId), () => hydrate(st, chatId))
  } catch (e) {
    swallow(e, 'cohere:thread:save')
    return hydrate(st, chatId)
  }
}

const norm = (s) => String(s || '').replace(/[\s，,。.！!？?、；;：:~～…]/g, '').slice(0, 40)

/** 两句问话是不是"同一个问题"（用于检测重复追问）。 */
export function sameQuestion(a, b) {
  const x = norm(a), y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  const short = x.length < y.length ? x : y
  const long = x.length < y.length ? y : x
  if (short.length >= 4 && long.includes(short)) return true
  // 字符二元组重合 ≥ 0.6 视为同一个问题
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g }
  const A = grams(x), B = grams(y)
  if (!A.size || !B.size) return false
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / Math.min(A.size, B.size) >= 0.6
}

/**
 * 收下一条输入，更新"我认为我们在干什么"。
 * 纯状态转移，没有 LLM，没有随机。
 */
export function ingest(chatId, p, now = Date.now()) {
  const st = load(chatId)
  st.turns += 1
  st.at = now
  st.lastUserAt = Number(p?.at) || now
  st.moves.push({
    role: 'user', act: p?.primary || '', at: st.lastUserAt,
    text: String(p?.text || '').slice(0, 120),
  })
  st.moves = st.moves.slice(-MAX_MOVES)

  // ── 话题 ────────────────────────────────────────────────────────────
  // 换话题的条件是**明确**的：要么他修正了目标，要么连续性判成 shift/new_session
  // 并且新句子里有具体指代。宁可保守 —— 频繁换 topic 会让"接上次话头"失效。
  const refText = p?.goal?.object || (p?.referents || [])[0] || ''
  const shift = p?.continuity === 'shift' || p?.continuity === 'new_session'
  // 同一拍里换话题：他连发两句不同的事（"多去看视频" → "看看你有多少余额"），
  // 旧版只在 shift/new_session 时换 topic，于是整段对话都挂着第一个话题，
  // frame 每轮都在说"在说：大肥鱼自运营的视频"。
  // 判据用**无重合**（不是"不一样"）：同一话题换个说法不该被当成换话题。
  const pRefs0 = Array.isArray(p?.referents) ? p.referents : []
  const topicHit = !st.topic || !refText
    || st.topic.includes(refText) || refText.includes(st.topic)
    || pRefs0.some((r) => st.topic.includes(r) || r.includes(st.topic))
  const fresh = !!refText && !topicHit
    && ['QUESTION', 'REQUEST', 'COMMAND', 'REPAIR', 'SHARE', 'TOPIC'].includes(p?.primary)
  if (refText && (!st.topic || shift || fresh)) {
    if (st.topic && st.topic !== refText) st.topics.push({ text: st.topic, at: st.at })
    st.topic = String(refText).slice(0, 40)
  } else if (refText && st.topic && !st.topic.includes(refText) && p?.primary === 'TOPIC') {
    // 陈述里出现新对象：作为子话题并入，不顶掉主话题
    st.topics.push({ text: String(refText).slice(0, 40), at: st.at })
    st.topics = st.topics.slice(-10)
  }

  // ── 目标（意向性）──────────────────────────────────────────────────
  // 他换了话题、又没给新任务 → 旧任务不再挂在本轮（否则每一轮都写着
  // "他要我做的：嘲讽视频"，即使他已经在问余额了）。
  if ((p?.continuity === 'shift' || p?.continuity === 'new_session') && !p?.needsAction && st.goal) {
    st.goal = null
    st.goalDone = false
  }
  // 已经做完的任务在**换话题**后就不该再出现在"我们到哪了"里
  if (st.goalDone && fresh) {
    st.goal = null
    st.goalDone = false
  }
  // REQUEST/COMMAND/REPAIR 是"他在给我任务"；REPAIR 优先，因为它是更正。
  if (p?.needsAction && p?.goal) {
    st.goal = {
      verb: String(p.goal.verb || '').slice(0, 20),
      object: String(p.goal.object || '').slice(0, 40),
      from: String(p.text || '').slice(0, 80),
      repaired: p.primary === 'REPAIR' || !!st.goal?.repaired && st.goal?.object !== p.goal.object,
    }
    st.goalAt = now
    st.goalDone = false
  }

  // ── 他问的 / 我问的 ────────────────────────────────────────────────
  if (p?.primary === 'QUESTION') {
    const q = String(p.text || '').slice(0, 80)
    if (q && !st.open.some((x) => sameQuestion(x.q, q))) st.open.push({ q, at: now })
    st.open = st.open.slice(-MAX_Q)
  }
  if (p?.primary === 'REPAIR' || p?.primary === 'CRITIQUE') st.stage = 'repairing'
  else if (p?.primary === 'CLOSING') st.stage = 'closing'
  else st.stage = 'talking'
  st.unanswered = ['REQUEST', 'COMMAND', 'QUESTION', 'CRITIQUE', 'REPAIR', 'SHARE', 'TEASE', 'EMOTE'].includes(p?.primary)

  return save(chatId, st)
}

/**
 * 生成之前给模型看的一小段"我们到哪了"。
 * 只写**指针**，不写摘要 —— 摘要会吃掉证据（86% 表情死在最后 20% 的根因）。
 */
export function frame(chatId, now = Date.now(), p = null, o = {}) {
  const st = load(chatId)
  const lines = []
  // 群聊里没有"他要我做的"这回事：说话的是某个群友，他的请求不等于主人的请求。
  // 旧版把私聊线程原样搬进群聊，她会把某人的一句闲聊当成"我的任务"。
  const isGroup = !!o.isGroup
  // 他这一轮只是给了个语气/收尾 → 旧任务不该成为本轮的"必须回应项"。
  const light = p && ['EMOTE', 'ACK', 'CLOSING', 'TEASE'].includes(p.primary)
  if (st.topic) lines.push('在说：' + st.topic)
  // 他这一句问的可能是另一件事（"看看你有多少余额"）——
  // 这时必须把"他要我做的"降级，否则模型会继续拿上一轮的任务当本轮任务
  // （实测 11-07：他问余额，她答完还要补一句"又是查余额又是嘲讽的，你到底想让我干嘛"）。
  const pRefs = Array.isArray(p?.referents) ? p.referents : []
  const goalRelated = !p || !pRefs.length
    || ['REQUEST', 'REPAIR', 'COMMAND'].includes(p.primary)
    || pRefs.some((r) => st.goal?.object && (r.includes(st.goal.object.slice(0, 4)) || st.goal.object.includes(r.slice(0, 4))))
  if (st.goal && !light && !isGroup) {
    const g = `${st.goal.verb}${st.goal.object ? '「' + st.goal.object + '」' : ''}`
    if (st.goalDone) lines.push(`他之前让我${g}（已经做过了）`)
    else if (goalRelated) lines.push(`他要我做的：${g}`)
    else lines.push(`他之前让我${g}（还没做，但这句先不聊这个）`)
  }
  if (p && p.primary === 'QUESTION' && pRefs.length && !(st.topic || '').includes(pRefs[0])) {
    lines.push('他这句问的是：' + pRefs[0])
  }
  const asked = st.myQuestions.slice(-2).map((x) => x.q).filter(Boolean)
  if (asked.length) lines.push('我已经问回去过：' + asked.map((q) => '「' + String(q).slice(0, 24) + '」').join('、') + '（同一件事不许再问第二遍）')
  const open = st.open.slice(-2).map((x) => x.q)
  if (open.length && st.unanswered) lines.push('他问的、我还没答：' + open.map((q) => '「' + String(q).slice(0, 30) + '」').join('、'))
  const cm = st.commitments.filter((c) => !c.done).slice(-2)
  if (cm.length && !isGroup) lines.push('我答应过还没做：' + cm.map((c) => String(c.what).slice(0, 24)).join('；'))
  if (!lines.length) return ''
  return '【我们这场对话到哪了】\n' + lines.map((l) => '· ' + l).join('\n')
}

/**
 * 纯读复核：这一句有什么问题。**不写盘。**
 *
 * 拆出来是因为复核会在一轮里跑两次（初稿一次、重写稿一次），
 * 而记账只能发生一次 —— 否则同一句话会在 moves 里出现两条，
 * 下一轮她会"记得自己说过两遍"，那正好是我们想消灭的东西。
 */
export function inspect(chatId, reply, p, now = Date.now()) {
  const st = load(chatId)
  const text = String(reply || '')
  const issues = []

  // ① 我是不是又问了同一个问题
  const qs = text.match(/[^。！!？?\n]{2,30}[？?]/g) || []
  for (const q of qs) {
    if (st.myQuestions.slice(-3).some((x) => sameQuestion(x.q, q))) {
      issues.push({ type: 'repeat_question', detail: q.slice(0, 40) })
      break
    }
  }
  // ② 他要的动作有没有被接住
  if (st.goal && !st.goalDone && p) {
    const g = (st.goal.object || st.goal.verb || '')
    const ack = /(好|行|可以|这就|我去|我看看|马上|懂了|明白|收到|听你的)/.test(text)
    const touched = g && (text.includes(g.slice(0, 4)) || text.includes(String(st.goal.verb || '')))
    if (!ack && !touched && (p.needsAction || p.primary === 'CRITIQUE' || p.primary === 'REPAIR')) {
      issues.push({ type: 'dodge', detail: `他要「${g.slice(0, 20)}」，这句没接` })
    }
  }

  // ③ 把内部状态当成回复主体（"我这会儿还想写点东西 / 我躺着犯困"）
  const head = text.slice(0, 40)
  if (/(我这会儿|我这边|我正|我还在|我现在).{0,12}(写|躺着|犯困|困|发呆|歇|睡|忙|不想动)|(脑子|人).{0,6}(转不动|钝|糊)/.test(head)) {
    issues.push({ type: 'self_absorption', detail: head.slice(0, 30) })
  }

  // ④ 反过来质问用户（"你到底想让我干嘛 / 说清楚 / 别让我猜"）
  if (/(你到底想让我干嘛|你到底要干嘛|说清楚(点|是)?|别让我猜|说了几遍|你倒是|你又在问)/.test(text)) {
    issues.push({ type: 'scold', detail: text.slice(0, 40) })
  }

  // ⑤ 时间前缀泄漏（" [刚刚] xxx"）—— 这是上下文标注被当她自己的话学走了
  if (/^\s*[\[［]\s*(\d+\s*(秒|分钟|小时|天)\s*前|刚刚|昨天|前天|上周)/.test(text)) {
    issues.push({ type: 'time_prefix', detail: text.slice(0, 20) })
  }

  // ⑥ 承诺：从她真说出去的话里记账（不新增一套正则，只收最明确的几种）
  const cm = text.match(/(我(?:这就|这就去|马上|等会|回头|待会)(?:去)?[^。！!？?\n]{0,18})/g) || []
  for (const what of cm) {
    const w = what.trim()
    if (w.length < 3) continue
    if (st.commitments.some((c) => sameQuestion(c.what, w))) continue
    issues.push({ type: 'commitment', detail: w.slice(0, 30) })
  }

  return issues
}

/**
 * 她这句话真发出去了：记账。
 * 注意顺序：**先 inspect，再写**。inspect 用的是写之前的状态（那才是"我说这句时的语境"）。
 */
export function after(chatId, reply, p, now = Date.now()) {
  const text = String(reply || '')
  const issues = inspect(chatId, text, p, now)
  const st = load(chatId)

  st.at = now
  st.lastMeAt = now
  st.moves.push({ role: 'me', act: 'reply', at: now, text: text.slice(0, 120) })
  st.moves = st.moves.slice(-MAX_MOVES)

  // ① 我问出去的问题要留档：下一轮问同一句就是"重复追问"
  const qs = text.match(/[^。！!？?\n]{2,30}[？?]/g) || []
  if (qs.length) {
    st.myQuestions.push({ q: qs[qs.length - 1].slice(0, 60), at: now })
    st.myQuestions = st.myQuestions.slice(-MAX_Q)
  }

  // ② 他给的动作被接住了就销账
  if (st.goal && !st.goalDone) {
    const g = st.goal.object || ''
    const ack = /(好|行|可以|这就|我去|我看看|马上|懂了|明白|收到|听你的)/.test(text)
    const touched = g && (text.includes(g.slice(0, 4)) || text.includes(String(st.goal.verb || '')))
    if (ack || touched) st.goalDone = true
  }

  // ③ 她自己的承诺落账
  const cm = text.match(/(我(?:这就|这就去|马上|等会|回头|待会)(?:去)?[^。！!？?\n]{0,18})/g) || []
  for (const what of cm) {
    const w = what.trim()
    if (w.length < 3) continue
    if (!st.commitments.some((c) => sameQuestion(c.what, w))) {
      st.commitments.push({ what: w.slice(0, 40), at: now, done: false })
    }
  }
  st.commitments = st.commitments.slice(-MAX_COMMIT)

  // ④ 他这句被接住了：不再挂"未答"，并把已答的问题从清单里**移除**。
  // 旧版只把 unanswered 置 false，open 数组一直留着 —— 四轮之后 frame 会写
  // "他问的、我还没答：看看你有多少余额"，而那句早就答过了，于是她重复回答。
  if (text.trim().length >= 4 && !/^\s*[\[［]/.test(text)) {
    st.unanswered = false
    st.open = []
  }

  // ⑤ 承诺销账：她说"看完/弄完/搞定了"就把对应的那条勾掉。
  // 旧版 commitments 只进不出，frame 会永远写"我答应过还没做：我这就去看看"。
  // 完成的说法是开放的（"扒完了/翻了一遍/弄好了"），不能只列几个动词 ——
  // 但"完"字本身太宽（完美/完蛋），所以只认"完了/完成"和明确的搞定类。
  const DONE_RE = /(完[了成]|搞定|弄好|做好了|弄好了)/
  if (DONE_RE.test(text)) {
    for (const c of st.commitments) {
      if (c.done) continue
      const key = String(c.what || '').replace(/^我(?:这就|这就去|马上|等会|回头|待会)(?:去)?/, '').replace(/^去/, '').slice(0, 4)
      const verb = key.slice(0, 1)
      if (!key || text.includes(key) || (verb && text.includes(verb))) c.done = true
    }
  }
  // 承诺也会过期：人不会记着一个月前那句"我这就去看看"。
  const COMMIT_TTL = 30 * 86400_000
  st.commitments = st.commitments.filter((c) => c.done || !c.at || now - c.at < COMMIT_TTL)

  save(chatId, st)
  return issues.filter((x) => x.type !== 'commitment')
}

export function status(chatId) {
  const st = load(chatId)
  return {
    topic: st.topic, goal: st.goal, goalDone: st.goalDone,
    unreplied: st.unanswered, stage: st.stage, turns: st.turns,
    open: st.open.slice(-3), myQuestions: st.myQuestions.slice(-3),
    commitments: st.commitments.filter((c) => !c.done),
  }
}
