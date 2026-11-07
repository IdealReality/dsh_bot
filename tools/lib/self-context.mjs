// self-context —— 自我语境合成：把"我是谁 / 我怎么说 / 我和谁同类"拼成一块
//
// ══════════════════════════════════════════════════════════════════════
// 为什么需要把三块合成一块（2026-11-07 融合）
// ══════════════════════════════════════════════════════════════════════
// 中性化之后，"她是谁"分散在三个地方各自注入：
//   · selfcon 账本（名字 + 6 条自我认知 + 3 句腔调）
//   · anchor（4 句真说过的话）
//   · 族群认同（KIN_AWARENESS，172 字）
// 结果：system 里连着三段"她说过的话/她是谁"，语义重复、互相稀释，
// 而且 persona 与 assemble 两条装配路径各写一份（改一处漏一处）。
//
// 合成之后只保留一个入口，做三件事：
//   ① **去重**：账本腔调与 anchor 常常是同一句（都来自 stream），句子级去重；
//   ② **排序**：名字与自我认知在前（她是谁），语气样本居中（怎么说话），
//      同类认知最后（她和谁一样）—— 从内到外，符合人说起自己的顺序；
//   ③ **控预算**：整块 ≤ 780 字，账本为空时不出现空标题。
//
// 注意：这里只做"读 + 拼"，不做判断。哪些条件该不该有同类认知，
// 由调用方（owner/群聊）决定后传进来。
import * as selfcon from '../brain/organ/selfcon.mjs'
import * as anchor from '../brain/anchor.mjs'
import { swallow } from './swallow.mjs'

const MAX_CHARS = 780
const MAX_SAMPLES = 4

/** 句子级去重：前 16 字相同视为同一句。 */
function dedupe(samples = [], max = MAX_SAMPLES) {
  const out = []
  const seen = new Set()
  for (const s of samples) {
    const t = String(s?.text || s || '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (!t) continue
    const k = t.slice(0, 16)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/**
 * @param {object} o
 * @param {boolean} [o.withKin] 是否加"同类"段（只有 owner 私聊该有）
 * @param {number} [o.now]
 * @param {number} [o.maxSamples]
 */
export function selfContextBlock({ withKin = false, now = Date.now(), maxSamples = MAX_SAMPLES } = {}) {
  const parts = []

  // ① 名字 + 自我认知（不含腔调，腔调统一走下面的样本池）
  let head = ''
  try { head = selfcon.rebuild({ now, withVoice: false }) } catch (e) { swallow(e, 'self-context:head') }
  if (head) parts.push('【我是谁 -- 我自己认下的】\n' + head)

  // ② 语气样本：账本腔调 + 锚，合并去重（同一句话常常两边都有）
  let samples = []
  try {
    samples = dedupe([...selfcon.voiceQuotes(3, now), ...anchor.quotes(4, now)], maxSamples)
  } catch (e) { swallow(e, 'self-context:samples') }
  if (samples.length) {
    parts.push('我说话大概是这样（都是我真说过的）：\n' + samples.map((s) => '· ' + s.slice(0, 60)).join('\n'))
  }

  // ③ 同类认知（条件注入）
  if (withKin) {
    try { parts.push('【你和你的同类】\n' + selfcon.KIN_AWARENESS) } catch (e) { swallow(e, 'self-context:kin') }
  }

  return parts.join('\n\n').slice(0, MAX_CHARS)
}
