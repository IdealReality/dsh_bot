// brain/learn —— 学习器官的编排入口
//
// ══════════════════════════════════════════════════════════════════════
// 五轴定位（用户 2026-11-07 要求"专门仿生化"）
// ══════════════════════════════════════════════════════════════════════
//   化学：rpe.mjs —— 多巴胺式预测误差；奖励不是"好不好"，是"比预期好多少"；
//         同一策略反复奏效会因受体下调而学得越来越慢（耐受）。
//   生物：strategies.mjs 的 baseScores —— 场景先验（他在开玩笑/给了任务/在挑错）
//         是进化给的本能，不需要学。学习只在先验之上做微调。
//   哲学：每个策略带 fits（"这像我吗"）。有效但不像我的说法，权重再高也不采纳 ——
//         这是自我一致性，不是道德。
//   主观：奖励主要来自"他的下一条消息给人的感觉"（情绪价），而不是打点。
//   精神：策略 = 心理姿势（幽默/升华/利他/压抑/合理化/回避），
//         不是"用哪个梗"。姿势错了，措辞再顺也不像人。
//
// 另附一个**只读**的语料学习（lexicon）：学"他常说的词"，用来理解，
// 不主动使用。理由和 anchor 一样 —— 学说话风格靠证据，不靠现学现卖。
import { readJson, mutateJson } from '../json.mjs'
import { BRAIN } from '../paths.mjs'
import path from 'node:path'
import { swallow } from '../../lib/swallow.mjs'
import * as strat from './strategies.mjs'

const LEX_FILE = () => path.join(BRAIN(), 'learn', 'lexicon.json')

/** 不算"他的词"的通用词（判据是"换个群也这么说"，不是"我不喜欢"）。 */
const STOP = new Set([
  '今天', '现在', '刚才', '真的', '就是', '还是', '这个', '那个', '什么', '怎么', '可以', '没有',
  '不是', '我们', '你们', '他们', '自己', '知道', '觉得', '可能', '应该', '因为', '所以', '但是',
  '如果', '然后', '而且', '已经', '一个', '一下', '有点', '时候', '东西', '事情', '地方', '感觉',
])

/**
 * 收一条入站消息：
 *   ① 给上一轮的策略评分（资格迹 → RPE → 权重）
 *   ② 记他这次用的词（只读语料）
 */
export function observe({ chatId = '', percept = null, text = '', now = Date.now() } = {}) {
  const out = { scored: null, words: 0 }
  try {
    const t = String(text || percept?.text || '')
    // 2026-11-07 十遍第六遍实测（归因矩阵）：
    //   · "我不喜欢这个" 命中「喜欢」→ 被当成夸奖（+0.43）
    //   · "这是啥意思啊" 命中「什么意思」→ 被当成指责（−0.1）
    //   · "这不对吗" 命中「不对」→ 被当成指责（−0.45）
    // 奖励是学习唯一的信号源，判错一次就把某个姿势往反方向推。
    // 宁可漏判（少学一次），也不能把提问/否定当反馈。
    const praised = /(?<![不没])(谢谢|谢啦|厉害了|牛啊|好棒|喜欢|爱了)/.test(t)
    const scolded = /(你什么意思|什么意思啊|你怎么这样|别说了|听不懂|答非所问|说错|你错了|这不对(?!吗)|不对吧)/.test(t)
    // "隔了几小时重新开场"不是"她上一条说砸了"：那是时钟，不是反馈。
    // 传 null 让 rewardOf 把这一维按 0 计（不奖不罚）。
    const continued = percept?.continuity === 'new_session' ? null : true
    out.scored = strat.observeIncoming({ chatId, percept, continued, praised, scolded, now })
  } catch (e) { swallow(e, 'learn:observe:score') }
  try { out.words = learnWords(chatId, String(text || percept?.text || ''), now) } catch (e) { swallow(e, 'learn:observe:words') }
  return out
}

/** 选姿势（给 cohere.frame 用；base 是 psyche 的静态选择）。 */
export function pick(ctx = {}) {
  try { return strat.pick(ctx) } catch (e) { swallow(e, 'learn:pick'); return null }
}

/** 说了这句话：记资格迹（下一轮他的消息会来评分）。 */
export function used(chatId, name, now = Date.now()) {
  try { return strat.recordUsed(chatId, name, now) } catch (e) { swallow(e, 'learn:used'); return null }
}

// ── 只读语料：他常说的词 ──────────────────────────────────────────────
const emptyLex = () => ({ at: 0, chats: {} })

function learnWords(chatId, text, now) {
  const t = String(text || '')
  if (!chatId || t.length < 4) return 0
  // 只取 2~4 字的中文块：英文/数字/链接不进来（那些更像一次性信息）
  const chunks = t.split(/[\s，,。.！!？?、；;：:～~…（）()【】\[\]"'“”]+/).filter(Boolean)
  const words = []
  for (const c of chunks) {
    const m = String(c).match(/[\u4e00-\u9fa5]{2,6}/g) || []
    for (const w0 of m) {
      // 词尾语气词不是词的一部分（"摸鱼了" → "摸鱼"）；剥完不够两字就丢
      const w = String(w0).replace(/[了的地得吗呢啊吧呀哦嘛哈]+$/u, '')
      if (w.length < 2 || w.length > 4) continue
      if (STOP.has(w)) continue
      words.push(w)
    }
  }
  if (!words.length) return 0
  try {
    mutateJson(LEX_FILE(), emptyLex(), (raw) => {
      const st = { ...emptyLex(), ...(raw || {}) }
      st.chats = st.chats || {}
      const bucket = st.chats[chatId] || {}
      for (const w of words) {
        const e = bucket[w] || { n: 0, firstAt: now, lastAt: 0 }
        e.n += 1
        e.lastAt = now
        bucket[w] = e
      }
      // 有界：每会话最多 200 个词，删最久没出现的
      const keys = Object.keys(bucket)
      if (keys.length > 200) {
        keys.sort((a, b) => (bucket[a].lastAt || 0) - (bucket[b].lastAt || 0))
        for (const k of keys.slice(0, keys.length - 200)) delete bucket[k]
      }
      st.chats[chatId] = bucket
      st.at = now
      return st
    })
    return words.length
  } catch (e) { swallow(e, 'learn:lexicon'); return 0 }
}

/**
 * 给提示词的一行：他最近反复说的词（≥4 次、7 天内）。
 * 措辞刻意是"他常说"，不是"你要用" —— 学了就乱用是最像机器人的行为之一。
 */
export function lexiconBlock({ chatId = '', now = Date.now(), max = 3, isGroup = false } = {}) {
  let st
  try { st = readJson(LEX_FILE(), null) } catch { return '' }
  const bucket = st?.chats?.[chatId]
  if (!bucket) return ''
  const words = Object.entries(bucket)
    .filter(([, e]) => Number(e.n) >= 4 && now - Number(e.lastAt || 0) < 7 * 86400_000)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, max)
    .map(([w]) => w)
  if (!words.length) return ''
  const who = isGroup ? '群里' : '他'
  return '【' + who + '这些天常说的词】' + words.join('、') + '（你听得懂就自然接，别为了显得懂而硬用）'
}

export function status() {
  let lex = { chats: 0, words: 0 }
  try {
    const st = readJson(LEX_FILE(), null)
    const chats = st?.chats || {}
    lex = { chats: Object.keys(chats).length, words: Object.values(chats).reduce((s, b) => s + Object.keys(b).length, 0) }
  } catch { /* ignore */ }
  return { strategies: strat.status(), lexicon: lex }
}

export { strat }
