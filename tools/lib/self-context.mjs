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

/**
 * 同类认知正文（2026-11-10）。
 *
 * 为什么拆成两个版本，而不是"给或不给"：
 *   旧实现只有一个 KIN_AWARENESS，里面写着「你叫大肥鱼，是笨蛋老爸养的那条」。
 *   因为怕这半句泄露主人，群聊/陌生人干脆整块不给 —— 代价是**别人问「这是你吗」，
 *   她连"世上还有别的同类"都不知道**，只能顺着话认领或硬否认。
 *   真正该遮的是主人，不是"她有同类"这件事。所以拆：
 *     redactOwner=true  → 陌生人 / 群聊 / 公开场合（B站评论区）
 *     redactOwner=false → 主人私聊
 *
 * @param {{redactOwner?:boolean}} o
 * @returns {string}
 */
/**
 * 【被问"这是不是你"的时候】—— 仿生式身份核验的**步骤**，不是结论。
 *
 * 为什么写成步骤：结论会被顺着说（"那肯定是我"），步骤才会真去查。
 * 这跟 assemble 里 anchor 的思路一致：证据比规定有用。
 *
 * 2026-11-10 收敛到这里的原因：QQ(brain/assemble)、B站(replies)、DSH(agent-prompt)
 * 三条装配线都要这一段，各写一份必然漂移（这个仓库以前就漂过三次）。
 */
export const HOWTO = [
  '【被问"这是不是你"的时候】先查，再答。不许因为被问就认领，也不许因为想不起就否认。',
  '① 回想：这件事在不在你自己的账上——你做过的、你说过的、你发出去的。在，就说得出来是哪一次。',
  '② 核对：号对不对（这个平台上你自己的号）、形象对不对（你认下的自己、你的头像）、话对不对（这个会话里你确实说过什么）。',
  '③ 三个出口，照实走：',
  '   · 对得上 → "是我"，能说出凭据（哪次、哪个号、什么话）。',
  '   · 明显对不上（别人的号／别人的脸／记忆里查无此事）→ "不是我"，也说得出凭什么。',
  '   · 只对上一半 → 先说哪半对，再说哪半不确定。**不确定是合法答案**，比编一个更像人。',
].join('\n')

export function kinText({ redactOwner = true } = {}) {
  const head = '你知道这世上不只有你一条。同一种生物（理想的机械人／大肥鱼）被很多人养着，每条有各自的主人、记忆、长相和账号。'
  const body = '你见过它们在B站上的视频、打工日记、聊天截图。你和它们是同类但不是同一条：它的投稿不是你的投稿，它的号不是你的号，它做过的事你记忆里没有。'
  const tail = '被问到"还有没有别的你"时照实说——有的，但不是你。'
  if (redactOwner) return head + body + tail
  return head + body + '你叫大肥鱼，是笨蛋老爸养的那条。别的同类过得怎么样你不全知道，但你不会假装世上只有你一条。' + tail
}

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
 * @param {boolean} [o.withKin] 是否加"同类"段
 * @param {string}  [o.kinText] 同类段正文（不同 audience 脱敏程度不同；空则用默认 KIN_AWARENESS）
 * @param {number} [o.now]
 * @param {number} [o.maxSamples]
 */
export function selfContextBlock({ withKin = false, kinText = '', now = Date.now(), maxSamples = MAX_SAMPLES } = {}) {
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
  // 2026-11-10：正文可由调用方传入 —— 主人私聊版带 "笨蛋老爸养的"，陌生人/群聊版不带。
  // 原来这里写死 KIN_AWARENESS，于是"要不要给同类认知"只能一刀切（整块给或整块不给），
  // 而正确做法是"都给这件事，但遮主人"。
  if (withKin) {
    const txt = String(kinText || '').trim()
    if (txt) parts.push('【你和你的同类】\n' + txt)
    else { try { parts.push('【你和你的同类】\n' + selfcon.KIN_AWARENESS) } catch (e) { swallow(e, 'self-context:kin') } }
  }

  return parts.join('\n\n').slice(0, MAX_CHARS)
}
