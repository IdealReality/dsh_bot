// cohere/intero —— 主观层：内感受 + 注意力的优先仲裁
//
// ══════════════════════════════════════════════════════════════════════
// 这一层修的是什么（2026-11-07 实测）
// ══════════════════════════════════════════════════════════════════════
// 装配出来的 system 里有一行：
//     【此刻】我啥都不太想干，就想窝着发会儿呆，脑子实在转不动。
// 于是那一轮的回复是「别让我猜」「我这边躺着犯困」。
//
// 问题不在"她累了"（那是真的）。问题在于**她把静息态直接当成了对话态度**。
// 人不是这样的：半夜三点困得要死，朋友发消息过来，第一反应还是"你先说"——
// 累改变的是**说话的量和速度**，不是"要不要接住你"。
//
// 生理上这叫**社会在场效应**：有人对你说话，NE/ACh 会抬一下，注意力转向声源。
// 这不是意志，是反射。这一层就把它写出来：
//   · capacity（还有多少余量组织语言）
//   · socialPriority vs restPriority（把资源给谁）
//   · 仲裁结果**只能调整语气**，不能取消"接住"这个动作
//
// 另外补一个"人可以不准确"的能力：内感受本来就有一半是解释，不是读数。
// 所以这里会有一小部分概率把"累"读成"烦"、把"空"读成"没意思"。
// 这是刻意的：一个永远准确知道自己状态的系统，不是人，是仪表盘。
// （比例固定、可复现 —— 用时间的确定性哈希，不用 Math.random，测试才稳。）
import { swallow } from '../../lib/infra/swallow.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 确定性伪随机：同一个 chatId + 分钟数，结果稳定。 */
function hash01(seed) {
  let h = 2166136261
  const s = String(seed)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

/**
 * 在场句的变体（2026-11-07 十遍后系统化）。
 *
 * 一个状态只有一种说法 = 每轮 system 里都是同一句 = 模型会把它当台词复述。
 * 三类说法语义相同，按 chatId + 5 分钟窗口确定性选择：
 * 同一个人同一段时间内稳定（不会一会儿一个说法），换个人/换半个小时后换一种。
 */
const PRESENT_LINES = [
  '他这会儿在跟我说话，我把手里的事先放一放。',
  '他在叫我，我先听他把话说完。',
  '有人跟我说话，手头的事先搁一下。',
  '他来了，我先把注意力给他。',
]

const TIRED_LINES = {
  low: ['身上有点乏，不碍事。', '有点撑不住，但听得见。', '身子发沉，说话短点。'],
  mid: ['有点乏，还行。', '不算精神，能聊。', '身上一般，不耽误说话。'],
}

/** 误读的几种形状。都只说"像什么"，不确诊。 */
const MISREAD = {
  tired_as_annoyed: '说不上是累还是有点烦，反正不太想多解释',
  tired_as_empty: '不困，就是提不起劲，像心里空了一块',
  wired_as_ok: '明明没睡够，这会儿反倒精神，怪',
  fine_as_low: '身上没毛病，但就是高兴不起来',
}

/**
 * 此刻的身体与心理余量。
 *
 * @param {object} o
 * @param {object} [o.percept]  percept.decode 的结果（有 = 他刚说话）
 * @param {object} [o.signal]   signal.read 的结果
 * @param {string} [o.chatId]
 * @param {number} [o.now]
 */
export function feel(o = {}) {
  const now = Number(o.now) || Date.now()
  const p = o.percept || null
  let st = null
  try {
    const F = o.field || null
    st = F ? F.evolve(now) : null
  } catch (e) { swallow(e, 'cohere:intero:field') }

  // 生理读数（field 已经做了第一人称化，这里不重复造一套表述）
  let depth = 0.6, patience = 0.6, irritability = 0.25, voice = 0.6
  let bodyLine = ''
  try {
    if (st) {
      const F = o.field
      depth = F.cognitiveDepth(st)
      patience = F.patience(st)
      irritability = F.irritability(st)
      voice = F.voiceReadiness(st)
      const s = F.sense(st)
      bodyLine = Array.isArray(s) ? String(s[0] || '') : String(s || '')
    }
  } catch (e) { swallow(e, 'cohere:intero:sense') }

  const sig = o.signal || { wake: 0.4, patience: 0.6, socialDrive: 0.4, inhibition: 0.45, stressLoad: 0.2, curiosity: 0.4 }
  const urgency = Number(p?.urgency || 0)
  // 压力有两个来源：连续场（这段时间的底色）与调质账本（这一句话的瞬态）。
  // 只要场读得到就以场为主（55/45）—— 否则 system 里会出现
  // 【此刻】说"心里压着一层"、身体感说"没什么压力"这种自相矛盾的两句。
  const fieldCort = st && Number.isFinite(Number(st.dims?.cortisol)) ? Number(st.dims.cortisol) : null
  const stressLoad = fieldCort != null
    ? clamp(0.55 * fieldCort + 0.45 * Number(sig.stressLoad ?? 0.2), 0, 1)
    : Number(sig.stressLoad ?? 0.2)

  // field 读不到（新装机/文件损坏/测试环境）时不许整块沉默：
  // 体感是"她还能不能组织语言"的唯一输入，缺了它 cohere 就只剩一张空表。
  // 用调质读数兜一句 —— 说法保持模糊，不假装有精确的身体读数。
  if (!bodyLine) {
    bodyLine = sig.wake > 0.62 ? '人还算清醒' : sig.wake < 0.32 ? '脑子有点钝' : '身上没什么特别的感觉'
    if (sig.socialDrive > 0.62) bodyLine += '，想跟人说两句'
    else if (sig.socialDrive < 0.28) bodyLine += '，不太想理人'
    bodyLine += '。'
  }

  // ── 仲裁：社交在场 vs 静息 ─────────────────────────────────────────
  // 这不是"她想不想"，是"这一分钟的资源给谁"。
  // 亲近（ot）+ 被叫到（ne/wake）+ 他着急（urgency）都会把天平往他那边推。
  // 慢性压力（cort）会削弱社交动机 —— 压着事的人更容易敷衍，这是真的，允许它发生一两次。
  const socialPriority = clamp(
    0.38 * sig.socialDrive + 0.22 * sig.wake + 0.28 * urgency + 0.18 * (1 - stressLoad) + (p && p.isGroup ? (p.directed === false ? -0.13 : -0.08) : 0.08),
    0, 1
  )
  const restPriority = clamp(0.45 * (1 - depth) + 0.25 * (1 - voice) + 0.18 * irritability, 0, 1)
  const giveToSocial = !p ? false : socialPriority >= restPriority - 0.05

  // ── 余量：被叫到会临时抬一点（社会在场效应）────────────────────────
  // 关键写法：**抬的是"能组织语言"的余量，不是"累不累"**。
  // 所以下面的 tone 会变短、变慢，但 mustAcknowledge 永远是 true。
  const bump = p ? (giveToSocial ? 0.12 : 0.05) * (1 - 0.4 * (1 - depth)) : 0
  const capacity = clamp(0.35 * depth + 0.25 * voice + 0.2 * patience + 0.2 * sig.wake + bump, 0.12, 1)

  // ── 误读：一小部分时间，她给自己的状态一个错误的解释 ───────────────
  // 只在"确实有生理底子"时误读，不能凭空造一个坏心情（那是随机情绪，不是内感受）。
  let misread = null
  const seed = hash01(`${o.chatId || 'x'}:${Math.floor(now / 60000)}`)
  const tired = (1 - depth) > 0.55
  const wired = sig.wake > 0.72
  if (tired && irritability > 0.35 && seed < 0.22) misread = MISREAD.tired_as_annoyed
  else if (tired && seed > 0.86) misread = MISREAD.tired_as_empty
  else if (wired && depth < 0.4 && seed > 0.9) misread = MISREAD.wired_as_ok
  else if (!tired && sig.stressLoad > 0.5 && seed > 0.88) misread = MISREAD.fine_as_low

  // ── 语气档：只允许影响"怎么说"，不允许影响"要不要接" ───────────────
  let tone = 'normal'
  if (capacity < 0.3) tone = 'short'
  else if (giveToSocial && socialPriority > 0.62) tone = 'warm'
  else if (irritability > 0.55 && sig.patience < 0.45) tone = 'guarded'

  return {
    at: now,
    bodyLine,
    capacity: Number(capacity.toFixed(3)),
    stressLoad: Number(stressLoad.toFixed(3)),
    depth: Number(depth.toFixed(3)),
    patience: Number(patience.toFixed(3)),
    irritability: Number(irritability.toFixed(3)),
    socialPriority: Number(socialPriority.toFixed(3)),
    restPriority: Number(restPriority.toFixed(3)),
    giveToSocial,
    tone,
    misread,
    // 硬契约：只要他在说话，就必须接住。没有任何参数能把它关掉。
    mustAcknowledge: !!p,
  }
}

/**
 * 渲染成给模型的一段（第一人称、短）。
 * 原则：**说状态，不说指令**。写"我有点乏"，不写"你要简短回复"。
 */
export function block(f = {}, o = {}) {
  if (!f || !f.bodyLine) return ''
  const seed = `${o.chatId || 'x'}:${Math.floor((Number(o.now) || Number(f.at) || Date.now()) / 300000)}`
  const pick = (arr, salt = '') => arr[Math.min(arr.length - 1, Math.floor(hash01(seed + salt) * arr.length))]
  const bits = []
  // 顺序是刻意的：**先说"他来了"，再说身体**。
  // 实测旧顺序（身体在前）时，模型抓着"缺觉/脑子发钝"不放，
  // 写出"别让我猜""我躺着犯困"—— 后半句的"先放一放"被前半句淹掉。
  // 人被打招呼时先转过去，身体的乏是在这个前提下才浮现的，不是反过来。
  if (f.giveToSocial) bits.push(pick(PRESENT_LINES, 'p'))
  // 有人在场时，身体描述降成一句轻的 —— 除非真疼/真饿/真发烧。
  // 理由：完整身体句（"感觉缺觉，脑子发钝"）会被模型拿去当开场白，
  // 修了四轮 system 提示仍会漏出来（实测自说自话复核连续两次拦不住）。
  // 人也是这样：朋友来消息时不会先报体征，除非真的难受。
  const urgent = /(疼|痛|饿|烧|发冷|心慌|喘不上)/.test(String(f.bodyLine || ''))
  // 2026-11-07 十遍第四遍实测：旧版在"有人在说话"时**恒定**写"身上有点乏，不碍事"，
  // 200 次采样 200 条一模一样 —— 无区分度的注入等于没有信息，而且每一轮都在
  // 把"乏"塞给模型（她于是每轮都想说累）。人的做法是：真乏才提一句，
  // 状态正常时根本不报体征。所以按余量分档，余量够就**不说身体**。
  if (!f.giveToSocial || urgent) bits.push(f.bodyLine)
  else {
    const c = Number(f.capacity || 0)
    if (c < 0.34) bits.push(pick(TIRED_LINES.low, 'l'))
    else if (c < 0.5) bits.push(pick(TIRED_LINES.mid, 'm'))
  }
  if (f.misread) bits.push(f.misread + '。')
  if (!f.giveToSocial && f.capacity < 0.3) bits.push('脑子确实不太转得动，话会短一点，但听得见。')
  if (f.tone === 'guarded') bits.push('有点烦，说话会冲，尽量别拿这个冲他。')
  return '【身上的感觉】' + bits.join('')
}

/** 一句话摘要（日志/面板）。 */
export function line(f = {}) {
  const bits = [`余量${Math.round((f.capacity || 0) * 100)}`]
  if (f.tone && f.tone !== 'normal') bits.push(f.tone)
  if (f.giveToSocial) bits.push('社交优先')
  if (f.misread) bits.push('误读')
  return bits.join('·')
}
