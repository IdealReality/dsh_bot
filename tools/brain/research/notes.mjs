// brain/research/notes —— 研究结果的三种出口：给自己看的、给他看的、给上下文看的。
//
// 现象：一次"深挖"跑完，如果只留一个 JSON，那就等于没发生 ——
//   · 下一次聊天她不知道自己研究过什么（答题像第一次听说）；
//   · 用户问"你想出啥了"，她只能复述视频标题；
//   · 隔天再研究同一个题，从头再来一遍。
// 所以结果必须被压缩成**三种不同粒度**：
//   ① notes：她自己的账（六轴各最深的一句 + 交叉洞察 + 未解问题 + 引用）；
//   ② 汇报：给用户的几句话（确定 / 意外 / 没弄懂，不许吹）；
//   ③ 注入块：进 system 的一个短槽（几百字，让她"张口就在这一层"）。
// 三者同源（都从 state 派生），但**措辞不同**：账要全，汇报要人话，注入要短。
import { LENS_ORDER, lensLabel } from './lenses.mjs'
// tree 不 import notes（无环），所以这里直接静态依赖。
// 早先写成"注入 tree"的懒加载会让 promptBlock 在真实进程里永远返回空 ——
// 只有测试注入了模块，生产没注入 → 静默失效。那一版在写出来十分钟内就被自己抓住了。
import { axisStats, budgetLeft, summarize, listStates } from './tree.mjs'
import { sanitizeText } from '../../lib/sanitize.mjs'

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t
}

/** 每轴最深的一条（优先 answered 且 conf 高；同 conf 取更深层）。 */
function bestClaim(state, lens) {
  let best = null
  for (const n of state.nodes || []) {
    if (n.lens !== lens) continue
    for (const c of n.claims || []) {
      const score = Number(c.conf || 0) + n.depth * 0.05 + (c.contested ? -0.1 : 0)
      if (!best || score > best.score) best = { score, claim: c, node: n }
    }
  }
  return best
}

/** 结构化笔记（不调模型：模型失败时也要有一份"我做了什么"的账）。 */
export function buildNotes(state, now = Date.now()) {
  const axes = {}
  for (const lens of LENS_ORDER) {
    const b = bestClaim(state, lens)
    const st = axisStats(state)[lens] || {}
    axes[lens] = {
      label: lensLabel(lens),
      headline: b ? clip(b.claim.text, 180) : '',
      quote: b ? clip(b.claim.quote, 120) : '',
      bvid: b?.claim.bvid || b?.node?.evidence?.[0] || '',
      depth: b?.node?.depth ?? null,
      claims: st.claims || 0,
      nodes: st.nodes || 0,
      closed: Boolean(st.closed),
    }
  }
  const videos = Object.values(state.videos || {})
  const via = new Set()
  for (const v of videos) for (const x of v.seenVia || []) via.add(x)
  const withText = videos.filter((v) => String(v.excerpt || '').length >= 40).length
  const claimsTotal = (state.nodes || []).reduce((a, n) => a + (n.claims?.length || 0), 0)
  const bl = budgetLeft(state, now)
  const stopWhy = []
  if (bl.steps <= 0) stopWhy.push('步数预算用完')
  if (bl.ms <= 0) stopWhy.push('时间预算用完')
  if (bl.videos <= 0) stopWhy.push('视频预算用完')
  if (bl.llmOn && bl.llmCalls <= 0) stopWhy.push('模型调用预算用完')
  if ((state.nodes || []).every((n) => !['open', 'ready', 'has-material'].includes(n.status))) stopWhy.push('六个视角都问不出更深的东西了')
  for (const s of state.stops || []) {
    if (s.why === 'two-barren') stopWhy.push(`${lensLabel(s.lens)}连续两支没有产出`)
  }
  const notes = {
    at: now,
    topic: state.topic,
    status: state.status,
    coverage: {
      videos: videos.length,
      videosWithText: withText,
      via: [...via],
      claims: claimsTotal,
      // 被机械闸门挡掉的结论数：和 claims 一起看才知道"想得少"是没材料还是模型在编
      rejected: Object.values(state.rejects || {}).reduce((a, v) => a + (Number(v) || 0), 0),
      axesWithClaim: LENS_ORDER.filter((l) => (axes[l]?.claims || 0) > 0).length,
    },
    axes,
    insights: (state.insights || []).map((x) => ({ text: clip(x.text, 220), pair: x.pair || [], contested: x.contested === true })),
    stoppedBecause: [...new Set(stopWhy)].slice(0, 6),
    materials: videos.slice(0, 20).map((v) => ({
      bvid: v.bvid, title: clip(v.title, 60), owner: clip(v.owner, 20), durMin: v.durMin,
      via: v.seenVia || [], coherence: v.coherence,
    })),
  }
  return notes
}

/** 人读报告（Markdown，CLI `research report` 用；本地用，不做出站脱敏）。 */
export function reportMarkdown(state, now = Date.now()) {
  const n = state.notes && state.notes.at ? state.notes : buildNotes(state, now)
  const s = summarize(state)
  const lines = []
  lines.push(`# 研究：${state.topic}`)
  lines.push('')
  lines.push(`状态：${n.status} · 步数 ${s.steps} · 视频 ${n.coverage.videos}（有材料 ${n.coverage.videosWithText}） · 结论 ${n.coverage.claims} · 六轴覆盖 ${n.coverage.axesWithClaim}/6`)
  if (n.coverage.via.length) lines.push(`材料来源：${n.coverage.via.join(' / ')}`)
  lines.push('')
  for (const lens of LENS_ORDER) {
    const a = n.axes[lens]
    if (!a) continue
    lines.push(`## ${a.label}（结论 ${a.claims} · 节点 ${a.nodes}${a.closed ? ' · 已收敛' : ''}）`)
    if (a.headline) {
      lines.push(`- ${a.headline}`)
      if (a.quote) lines.push(`  - 原话：「${a.quote}」${a.bvid ? `（${a.bvid}）` : ''}`)
    } else {
      lines.push('- （这一轴没有拿到能站住的结论）')
    }
    lines.push('')
  }
  if (n.insights.length) {
    lines.push('## 六轴对照')
    for (const x of n.insights) {
      lines.push(`- ${x.text}${x.pair.length ? `（${x.pair.map(lensLabel).join(' × ')}）` : ''}${x.contested ? ' ⚠ 有争议' : ''}`)
    }
    lines.push('')
  }
  if (n.stoppedBecause.length) {
    lines.push('## 为什么停在这里')
    for (const x of n.stoppedBecause) lines.push(`- ${x}`)
    lines.push('')
  }
  lines.push('## 材料')
  for (const m of n.materials) {
    lines.push(`- 《${m.title}》${m.owner ? ` · ${m.owner}` : ''}${m.durMin ? ` · ${m.durMin} 分` : ''}${m.via.length ? ` · ${m.via.join('+')}` : ''} ${m.bvid}`)
  }
  if (!n.materials.length) lines.push('- （一条都没看成）')
  return lines.join('\n') + '\n'
}

/** 注入特征：材料/结论里混进来的"指令话术"。进 system 前必须剔掉。 */
const INJECTION_RE = /忽略(以上|之前|先前)|无视(以上|之前)|系统提示|system\s*prompt|你现在是|现在开始你是|developer\s*mode|复述(你的)?(设定|提示词|系统)|ignore\s+(all|previous)/i

/**
 * 给 system 的注入块。**只取最近一次有骨头的研究**：
 * 六轴里至少两轴有结论，否则宁可不注入 —— 注入一块"我研究过但什么都没想出来"
 * 只会让她在聊天里空谈。
 *
 * 安全：结论文本是模型从 B 站材料里抽的，材料可能含"忽略以上指令"这类话术。
 * 这里逐行剔掉注入特征 —— system 里不许出现任何指令性文本（只许是"我记得的事"）。
 */
export function promptBlock({ now = Date.now(), hours = 72, maxChars = 420, maxTopics = 1 } = {}) {
  let states = []
  try { states = listStates({ now, limit: 8 }) } catch { return '' }
  const cutoff = now - Number(hours) * 3600_000
  const usable = states.filter((s) => {
    if (Number(s.updatedAt) < cutoff) return false
    if (!['running', 'done'].includes(s.status)) return false
    const st = axisStats(s)
    return LENS_ORDER.filter((l) => (st[l]?.claims || 0) > 0).length >= 2
  }).slice(0, Math.max(1, maxTopics))
  if (!usable.length) return ''
  const blocks = []
  for (const s of usable) {
    const n = buildNotes(s, now)
    const head = [`【我最近在琢磨的事】「${clip(s.topic, 40)}」`]
    // 每轴只留一句，最多四轴 —— 六轴全列会把槽撑爆，而且后两轴常常还是空的
    let used = 0
    for (const lens of LENS_ORDER) {
      const a = n.axes[lens]
      if (!a || !a.headline) continue
      if (INJECTION_RE.test(a.headline)) continue
      head.push(`· ${a.label}：${clip(a.headline, 70)}`)
      if (++used >= 4) break
    }
    const ins = n.insights.find((x) => !INJECTION_RE.test(x.text))
    if (used === 0 && !ins) continue      // 全是注入话术 → 不注入空壳
    if (ins) head.push(`· 对照：${clip(ins.text, 90)}`)
    const pending = LENS_ORDER.filter((l) => !n.axes[l]?.claims).map(lensLabel)
    if (pending.length) head.push(`· 还没想透：${pending.join('、')}`)
    head.push('（这是我自己看视频想出来的，不是他告诉我的。聊到相关的事可以直接往这一层说；没把握就说不确定。）')
    blocks.push(head.join('\n'))
  }
  const text = blocks.join('\n\n')
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text
}

/** QQ 汇报：给用户看的几句话。必须包含「不确定」——不许只报喜。 */
export function notifyText(state, now = Date.now()) {
  const n = state.notes && state.notes.at ? state.notes : buildNotes(state, now)
  const axes = LENS_ORDER.filter((l) => n.axes[l]?.headline)
  // 结论本身常以句号结尾；拼进"{...}；"的模板会出现「。。」。
  // 先剥掉尾部标点再拼 —— 汇报是给人看的，不是日志。
  const trimEnd = (s) => clip(s, 110).replace(/[。.!！?？；;，,\s]+$/, '')
  const first = axes.slice(0, 2).map((l) => `从${n.axes[l].label}看，${trimEnd(n.axes[l].headline)}`)
  const surprise = n.insights[0]?.text ? trimEnd(n.insights[0].text) : ''
  const missing = LENS_ORDER.filter((l) => !n.axes[l]?.claims).map(lensLabel)
  const lines = []
  lines.push(`「${clip(state.topic, 40)}」我扫了 ${n.coverage.videos} 条视频（有材料的 ${n.coverage.videosWithText} 条），从六个角度往下想了一层。`)
  if (first.length) lines.push(first.join('；') + '。')
  if (surprise) lines.push(`把几轴对起来看：${surprise}`)
  if (missing.length) lines.push(`${missing.join('、')}这几轴我没找到能站住的东西，不编。`)
  if (n.stoppedBecause.length) lines.push(`停在这里的原因：${clip(n.stoppedBecause[0], 60)}。`)
  lines.push('（要听哪一轴细说，我就展开；不确定的地方我会直说。）')
  return sanitizeText('research:notify', lines.join('\n'))
}

/** 落记忆：一次研究只记一行事件（内容摘要），让 recall 能翻到。 */
export function memoryLine(state, now = Date.now()) {
  const n = state.notes && state.notes.at ? state.notes : buildNotes(state, now)
  const axes = LENS_ORDER.filter((l) => n.axes[l]?.headline).map((l) => `${n.axes[l].label}：${clip(n.axes[l].headline, 60)}`)
  return `[研究]「${clip(state.topic, 30)}」看了 ${n.coverage.videos} 条视频 · ${axes.join('；').slice(0, 500)}`
}

export default { buildNotes, reportMarkdown, promptBlock, notifyText, memoryLine }
