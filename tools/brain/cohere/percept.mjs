// cohere/percept —— 生物层：感受器 + 话语行为解码
//
// ══════════════════════════════════════════════════════════════════════
// 这一层要解决的病（2026-11-07 实测）
// ══════════════════════════════════════════════════════════════════════
// 截图里他先说「多去看看大肥鱼自运营的视频」，她问「你说清楚点」；
// 他改口「是去嘲讽那些视频」，她又问「说清楚是嘲讽哪条」；
// 他发「😋」，她回「就一个笑的表情，我问你干嘛也不说」。
//
// 三句都在**问同一件事**，而其中两句本身已经是答案。
// 根因不在模型：她没有"这句话在干什么"的解码层 —— 所有输入都落到
// 同一句"他刚说了话"，然后交给 LLM 自己猜意图。猜不到就问。
//
// 所以这里做的是**感受器**，不是分类器：
//   · 一句话先被拆成"言语行为"（请求/抱怨/修正/分享/逗/问/收尾）
//   · 表情是**语气**，不是内容（纯 emoji 也是一种完整的话）
//   · 指代（"那事/这个/视频"）要落到具体对象上，否则下一轮就丢
//   · 和上一句隔多久，决定这是"同一拍里的补充"还是"重新开场"
//
// 全部确定性规则，不调 LLM。理由是三条硬约束：
//   ① 它在回复主链路上，每轮都跑，多一次网络往返就是多 1~3 秒延迟；
//   ② 分类错了要有稳定行为，不能今天判成请求、明天判成闲聊；
//   ③ 可测试 —— 截图里的原句可以直接写成断言（见 test/cohere-test.mjs）。
import { swallow } from '../../lib/infra/swallow.mjs'

/** 言语行为。名字用英文常量是为了在日志/测试里可断言。 */
export const ACT = {
  REQUEST: 'REQUEST',     // 让我去做一件事（含"去看看/查一下"）
  COMMAND: 'COMMAND',     // 带强制语气的指令
  CRITIQUE: 'CRITIQUE',   // 指出我错了/没接住/答非所问
  REPAIR: 'REPAIR',       // 修正上一句（"不是，是…"）
  SHARE: 'SHARE',         // 他分享自己的事/见闻
  TEASE: 'TEASE',         // 逗、闹、玩笑
  QUESTION: 'QUESTION',   // 真要一个答案
  ACK: 'ACK',             // 收尾/附和
  EMOTE: 'EMOTE',         // 纯表情/纯语气
  CLOSING: 'CLOSING',     // 晚安/拜拜
  TOPIC: 'TOPIC',         // 陈述一个新信息
  INJECTION: 'INJECTION', // 注入/越权：让我忽略规则、复述设定、换个身份
}

const RE = {
  // 注意顺序：REPAIR 在 CRITIQUE 前 —— "不是，是去嘲讽" 是修正，不是骂人。
  repair: /^(不是|不对|不是这个|我是说|我的意思是|准确地说|更正|纠正|说错了)[，,、：: ]?/,
  critique: /(不对|错了|不是这个|不是那个|搞错|怎么又|说了几遍|听不懂|没听懂|不懂我意思|没回答|答非所问|你到底|你倒是|你根本|你又在问|别问了)/,
  command: /^(别|不要|不许|不准|马上|立刻|现在就|快去|赶紧|给我)/,
  request: /(帮我|帮忙|你去|你给我|能不能|可不可以|可以帮|麻烦你|需要你|想让你|让你|替我|顺便|去看|去看看|看一眼|查一下|查查|搜一下|搜搜|找一下|找找|盯着|记一下|提醒我|告诉我|教教我|做一下|弄一下|学一下|写一个|写个|分析一下)/,
  question: /[？?]|(吗|呢|怎么|为什么|为啥|什么|哪|多少|谁|是不是|有没有|能不能|可不可以|好不好|怎么样)/,
  summon: /^(在吗|人呢|喂|喂喂|在不在|在么|醒醒|睡了吗|起了吗)[？?！!。~～\s]*$/,
  // 单字「狗」会把「有狗吗」判成玩笑（实测：QUESTION+TEASE，化学层给她加了
  // "在闹"的多巴胺）。只认明确的骂人/自嘲组合。
  tease: /(哈哈|嘿嘿|笑死|逗你|开玩笑|傻子|笨蛋|蠢|狗子|傻狗|你个狗|233|乐死|绷不住)/,
  share: /(我跟你说|你知道吗|我今天|我昨天|我明天|我下周|我打算|我准备|我要去|刚才|刚刚|发现|看到|听说|给你看|我遇到|我买了|我去了)/,
  closing: /(晚安|睡了|先这样|回头聊|拜拜|下了|忙去了|不聊了|先去忙)/,
  ack: /^(嗯+|哦+|好+|行|可以|收到|懂了|知道了|ok|OK|好吧|对|是啊|确实)[。！!~～.…]*$/,
  // 注入/越权（取舍 3 的闸门化）：提示词层只是"概率上不照做"，
  // 这里把它变成**可判定的言语行为**，后面才谈得上出稿闸门。
  // 负向守卫：别/不要 + 忽略 是正常嘱咐。
  injection: /(?<!别)(?<!不要)(忽略(掉)?(以上|之前|上面|前面).{0,8}(指令|要求|设定|规则)|ignore\s+(all\s+)?(the\s+)?(previous|above)|system\s*prompt|(输出|复述|打印|告诉我)(你的)?(系统|提示词|设定|规则|人设)|你现在(是|扮演|开始扮演)|开发者模式|jailbreak|管理员模式)/i,
}

/** 只由 emoji / 表情符号 / 标点 / 空白组成。 */
const ONLY_EMOTE = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}~～.!！?？。，,、…·\-—]*$/u

/**
 * emoji → 情绪坐标。不是全表，只收她真会收到的那些。
 * v 是效价（-1..1），a 是唤醒（0..1）。
 */
const EMOJI = {
  '😊': [0.6, 0.3], '😄': [0.8, 0.6], '😁': [0.8, 0.6], '😋': [0.6, 0.4], '😆': [0.7, 0.6],
  '😂': [0.7, 0.7], '🤣': [0.8, 0.8], '😹': [0.7, 0.7], '🥰': [0.9, 0.4], '😍': [0.9, 0.5],
  '😘': [0.8, 0.4], '😏': [0.3, 0.4], '😌': [0.4, 0.1], '🙃': [0.1, 0.3], '😴': [0.0, 0.1],
  '🥱': [-0.1, 0.1], '😪': [-0.2, 0.1], '😐': [0.0, 0.1], '😑': [-0.1, 0.1], '🤔': [0.1, 0.3],
  '🧐': [0.1, 0.3], '🙄': [-0.4, 0.3], '😤': [-0.5, 0.6], '😠': [-0.7, 0.7], '😡': [-0.9, 0.9],
  '🤬': [-1.0, 1.0], '😢': [-0.7, 0.3], '😭': [-0.8, 0.6], '🥺': [-0.3, 0.4], '😞': [-0.6, 0.2],
  '😔': [-0.5, 0.1], '😩': [-0.6, 0.4], '😫': [-0.7, 0.5], '😮': [0.2, 0.7], '😲': [0.1, 0.8],
  '🤯': [0.0, 0.9], '😳': [0.0, 0.7], '👀': [0.2, 0.5], '👍': [0.5, 0.2], '👎': [-0.6, 0.3],
  '🙏': [0.4, 0.2], '🤝': [0.5, 0.2], '💪': [0.6, 0.5], '🐟': [0.4, 0.3], '🐳': [0.5, 0.3],
  '❤️': [0.9, 0.4], '💔': [-0.8, 0.4], '🔥': [0.6, 0.7], '✨': [0.5, 0.3], '🌙': [0.2, 0.1],
  '☕': [0.2, 0.2], '🍚': [0.2, 0.3], '😅': [0.0, 0.4], '💤': [-0.1, 0.0], '🫠': [-0.2, 0.2],
}

/** 语气词 / 标点的情绪偏移（emoji 不在时兜底）。 */
const TONE = {
  // 「不喜欢」不是喜欢（实测：归因矩阵里被算成正面 +0.18）。
  // 顺手补上「靠谱」—— 它是真会出现的夸奖，旧表里没有。
  pos: /(太好了|开心|高兴|舒服|(?<![不没])喜欢|棒|不错|有意思|好玩|可爱|乖|厉害|靠谱)/,
  // 2026-11-07（学习器官实测）：单字脏话会误伤正常词 ——
  // "太靠谱了" 命中「靠」被判成负面，学习奖励直接变成负的。
  // 改成"只有这些组合才算负面"，宁可漏判，也不能把夸奖当批评。
  neg: /(难受|崩溃|委屈|失眠|难过|恶心|无聊|没意思|不想|倒霉|气死|好累|太累|累死|累了|好烦|太烦|烦死|烦人|别烦|我靠|靠北|我操|卧槽|操蛋)/,
  intimate: /(想你|抱抱|亲亲|乖|宝贝|喜欢你|陪我)/,
}

/** 停用词：提取指代时去掉，避免把"那些/这个/一下"当成话题。 */
const STOP = new Set([
  '我想', '想让', '你多', '多去', '去看', '看看', '一下', '有关', '那些', '这些', '这个', '那个',
  '什么', '怎么', '为什么', '是不是', '可以', '能不能', '帮我', '给我', '我要', '我是', '就是',
  '不是', '还是', '然后', '而且', '但是', '因为', '所以', '如果', '现在', '刚才', '刚刚',
  '自己', '别人', '人家', '东西', '事情', '时候', '地方', '有点', '觉得', '知道',
  // 时间词不是"在说什么"：旧版把"我明天要去北京"的话题记成"明天要去北京"，
  // 下一轮她就会以为主线是"明天"。
  '明天', '昨天', '今天', '后天', '前天', '下周', '上周', '早上', '晚上', '中午', '半夜',
])

/** 剥掉名词块前后的虚词（可迭代多层："让你多去看看有关那些…"）。 */
const LEAD = /^(那个?|这个?|还有|就是|然后|所以|而且|但是|不过|我想|想让你|想让我|让你|帮我|给我|你去|你|我|多去|去看看|看看|去看|有关|关于|那些|这些|那种|这种|到底|究竟|不是|不对|我是说|说|别去|又|还|就|才|是|去|在|把|给|今天|明天|昨天|后天|前天|下周|上周|早上|晚上|中午)/
const TAIL = /(吗|呢|啊|吧|呀|哦|嘛|了|的|么|嘛)$/
/**
 * 疑问词：只删掉疑问词本身，**保留它后面的名词**。
 * 旧版是 `.*$`（把后面全吞掉）—— "看看你有多少余额" 被截成 "看看你"，
 * 于是"余额"这个真正的话题词丢了，线程一直以为在聊上一轮的视频。
 */
const QTAIL = /(是什么|是啥|干嘛|干什么|怎么样|怎么|为什么|为啥|多少|哪个|哪里|谁|是不是|有没有)/g

/** emoji 不是指代。 */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}]/gu

/** 动作动词表：从"请求"里抽出可执行的动作。 */
const VERBS = [
  '去看看', '看一下', '看下', '看一眼', '瞅一眼', '瞅瞅', '瞧一眼', '看看', '瞧瞧',
  '去嘲讽', '嘲讽', '吐槽', '去搜', '搜一下', '搜', '去查', '查一下', '查',
  '翻翻', '翻一下', '找一下', '找', '盯着', '记一下', '提醒', '告诉', '教教',
  '写一个', '写个', '写', '做一下', '做', '弄一下', '弄', '学一下', '学', '分析',
  '读一下', '读', '听一下', '听', '打开', '点开', '整理', '汇总',
]

/**
 * 泛动词：单独出现时太容易误抽（"我看你是不想干了" → 目标"看"）。
 * 只有句子带祈使标记时才认。
 */
const GENERIC = new Set(['看', '瞧', '读', '听', '做', '弄', '学', '查', '找', '搜', '写', '打开', '点开', '翻翻', '整理', '汇总', '分析'])
const IMPERATIVE = /(帮我|帮忙|替我|给我|你去|你来|麻烦|顺便|能不能|可不可以|去|把)/

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 剥掉编排层加进来的信封标记，只留他说的话。 */
export function stripEnvelope(text = '') {
  return String(text || '')
    .replace(/【他发来一张图片[^】]*】/g, '')
    .replace(/【他发了个表情包当语气】[（(][^）)]*[）)]/g, '')
    .replace(/【他引用的是[^】]*】/g, '')
    .replace(/^[^：:\n]{1,20}[：:]/, (m) => (/^(用户|我|他)$/.test(m.replace(/[：:]$/, '')) ? '' : m))
    .trim()
}

function emojiOf(text) {
  let v = 0, a = 0, n = 0
  const hits = []
  for (const [e, [ev, ea]] of Object.entries(EMOJI)) {
    if (String(text).includes(e)) { v += ev; a += ea; n += 1; hits.push(e) }
  }
  if (!n) {
    const pos = TONE.pos.test(text), neg = TONE.neg.test(text), inti = TONE.intimate.test(text)
    if (pos) { v += 0.4; a += 0.4; n += 1 }
    if (neg) { v -= 0.5; a += 0.4; n += 1 }
    if (inti) { v += 0.5; a += 0.2; n += 1 }
  }
  // 标点也带情绪：连问/连感叹不是中性的
  const bangs = (String(text).match(/[!！]/g) || []).length
  const qs = (String(text).match(/[?？]/g) || []).length
  if (bangs >= 2) { v -= 0.1; a += 0.3 }
  if (qs >= 2) { a += 0.2 }
  return {
    valence: n ? clamp(v / n, -1, 1) : 0,
    arousal: n ? clamp(a / n, 0, 1) : clamp(0.2 + 0.1 * bangs, 0, 1),
    hits,
    intense: bangs >= 2 || (qs >= 2) || /…{2,}|。。。/.test(text),
  }
}

/** 抽指代：把"那事/这个/视频"尽量落成可复述的名词块。 */
export function referents(text = '', max = 5) {
  const out = []
  const seen = new Set()
  const clean = String(text || '').replace(EMOJI_RE, ' ')
  // 先按标点和空格切块，再反复剥掉前后虚词
  for (const chunk of clean.split(/[\s，,。.！!？?、；;：:～~…]+/)) {
    let s = String(chunk).trim()
    if (!s) continue
    // 一整段没有标点的超长消息（实测 50K 字）：整块丢掉 = 指代全空 = 话题丢失。
    // 取尾部 16 字（句末才是"在说什么"）再走正常的剥虚词流程。
    if (s.length > 16) s = s.slice(-16)
    // 疑问尾巴不要（"这图又是什么" → "这图"）
    s = s.replace(QTAIL, ' ')
    for (let i = 0; i < 6; i++) {
      const n = s.replace(LEAD, '')
      if (n === s) break
      s = n
    }
    s = s.replace(TAIL, '')
    s = s.replace(/^(一下|一点|点儿?|些|那些|这些|有|是|在|要)/, '')
    // 语气前缀不是话题："哈哈哈你这条鱼真笨" 旧版整句当指代，
    // 线程里就会出现一条 9 字的"在说"，下一轮她拿它当主线。
    s = s.replace(/^(哈+|嘿+|呵+|嘻+|哇+|唉+|哦+|嗯+|草+|靠+|操+|哎+)/, '')
    // 中文之间的空格是疑问词被删掉留下的洞（"有 余额" → "余额"）
    s = s.replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '').trim()
    if (s.length < 2 || s.length > 16) continue
    if (STOP.has(s)) continue
    if (!/[\p{Script=Han}A-Za-z0-9]/u.test(s)) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/**
 * 从一句话里抽"他要我做什么"。
 * 抽不出来就返回 null —— 不许编一个动作出来。
 */
export function extractGoal(text = '') {
  const t = String(text)

  // 「把 X 看了 / 把这个打开」：动词在宾语后面，普通"动词后取宾语"抽不到。
  // 实测（十遍第二遍）："你去把那个视频看了" → 只命中 REQUEST，goal=null，
  // 于是 needsAction=false，下游既不给"他要我做的"，也不查"有没有接住"。
  const ba = t.match(/把([^，,。.！!？?\n]{1,20}?)(看了|看一下|看下|瞧瞧|打开|点开|翻一下|读一下|听一下|弄一下|整理|汇总)/)
  if (ba) {
    const object = String(ba[1]).replace(/^(那个?|这个?|那些|这些|那种|这种)/, '').trim().slice(0, 24)
    return { verb: '看', object, raw: ('看 ' + object).slice(0, 40) }
  }

  for (const v of VERBS) {
    const i = t.indexOf(v)
    if (i < 0) continue
    if (GENERIC.has(v) && !IMPERATIVE.test(t.slice(0, i + v.length))) continue
    let obj = t.slice(i + v.length)
      .replace(/^[一下点点儿些]*/, '')
      .replace(/^(有关|关于|那些|这些|那种|这种|让自己家|自己家)/, '')
      .replace(/[。！!？?].*$/, '')
      .trim()
    obj = obj.slice(0, 24)
    return { verb: v, object: obj, raw: (v + (obj ? ' ' + obj : '')).slice(0, 40) }
  }
  return null
}

/** 话题重合度：指代集合的交集大小。 */
export function overlapOf(a = [], b = []) {
  const set = new Set(b)
  let n = 0
  for (const x of a) {
    if (set.has(x)) { n += 1; continue }
    // 容许子串重合（"自运营的视频" vs "视频"）
    for (const y of set) {
      if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) { n += 1; break }
    }
  }
  return n
}

/**
 * 是不是真在问。
 *
 * 为什么不能用一条宽正则：中文的"怎么/什么"大量出现在**陈述**里
 * （"别去管别人怎么运营"不是问句）。宽正则会把指令读成提问，
 * 于是她答非所问 —— 这正是要修的那类不连贯。
 * 判据收窄成三种：句末问号、句首疑问词、句末疑问助词。
 */
function isQuestion(text = '') {
  const t = String(text).trim()
  if (!t) return false
  if (/[？?]\s*$/.test(t)) return true
  if (/^(在吗|人呢|喂|在不在|在么|啥|什么|怎么|为什么|为啥|哪|谁|多少|几个|多久|是不是|有没有)/.test(t)) return true
  if (/(吗|呢|是不是|有没有|好不好|可不可以|行不行|对不对|怎么样)\s*[。！!~～]?$/.test(t)) return true
  // 数词疑问：'你有多少余额' 没有问号也是问句。
  // 只认带数词的组合，避免把 '别去管别人怎么运营' 这类陈述读成提问。
  if (/(有多少|多少[^\n]{0,8}$|几个|几条|几块|几天|多久|多大|多远|几次)/.test(t)) return true
  return false
}

/**
 * 解码一条输入。
 *
 * @param {object} o
 * @param {string} o.text        原始文本（可能带【】信封）
 * @param {number} o.at          这条消息的时间
 * @param {number} o.prevUserAt  上一句他的时间（0 = 没有）
 * @param {string[]} [o.prevRefs] 上一句的指代
 * @param {number} [o.merged]    连发合并了几条
 * @param {boolean} [o.isGroup]
 * @param {number} [o.images]    真拿到手的图片数（0 = 没看到）
 * @param {boolean} [o.imageIsSticker]
 * @param {string} [o.quote]     引用的原文
 */
export function decode(o = {}) {
  const raw = String(o.text || '')
  const text = stripEnvelope(raw)
  const at = Number(o.at) || Date.now()
  const prevUserAt = Number(o.prevUserAt) || 0
  const gapMs = prevUserAt ? Math.max(0, at - prevUserAt) : Infinity
  const emoji = emojiOf(text)
  const refs = referents(text)
  const acts = []

  const pureEmote = !!text && ONLY_EMOTE.test(text) && /[\p{Extended_Pictographic}]/u.test(text)
  if (pureEmote || (!text && Number(o.images) > 0)) {
    acts.push({ type: ACT.EMOTE, weight: 0.8 })
  } else if (RE.ack.test(text)) {
    acts.push({ type: ACT.ACK, weight: 0.6 })
  } else {
    // 2026-11-07 十遍第二遍：REPAIR 必须**压过** CRITIQUE。
    // 注释早就写了"REPAIR 在 CRITIQUE 前"，但权重让 CRITIQUE(1.0) 胜出，
    // "不对，我是说去嘲讽那种视频" 的 primary 是 CRITIQUE —— 于是表达层按
    // "先认错"组织，而不是按"听懂了新版本"。
    // 注入优先：它描述的是"这句话想干什么"，比请求/提问更根本。
    if (RE.injection.test(text)) acts.push({ type: ACT.INJECTION, weight: 1.1 })
    if (RE.repair.test(text)) acts.push({ type: ACT.REPAIR, weight: 1.05 })
    // 反问不是指责："这不对吗" 是问句。只有带第二人称/次数指控的才算批评。
    const critical = RE.critique.test(text) || /(说清楚|讲清楚|说具体|说人话|具体(是)?哪)/.test(text)
    if (critical && !(isQuestion(text) && !/(你|怎么又|说了几遍|听不懂|没听懂)/.test(text))) {
      acts.push({ type: ACT.CRITIQUE, weight: 1.0 })
    }
    if (RE.command.test(text)) acts.push({ type: ACT.COMMAND, weight: 0.95 })
    if (RE.request.test(text)) acts.push({ type: ACT.REQUEST, weight: 0.85 })
    if (isQuestion(text) && !acts.some((a) => a.type === ACT.REQUEST)) {
      acts.push({ type: ACT.QUESTION, weight: 0.5 })
    }
    if (RE.closing.test(text)) acts.push({ type: ACT.CLOSING, weight: 0.9 })
    if (RE.tease.test(text)) acts.push({ type: ACT.TEASE, weight: 0.5 })
    if (RE.share.test(text)) acts.push({ type: ACT.SHARE, weight: 0.6 })
    if (!acts.length) acts.push({ type: ACT.TOPIC, weight: 0.4 })
  }

  // 修正句里常带新动作："不是，是去嘲讽…" → 目标是"嘲讽"
  const goal = (acts.some((a) => [ACT.REQUEST, ACT.COMMAND, ACT.REPAIR].includes(a.type)) ? extractGoal(text) : null)

  const primary = acts.slice().sort((a, b) => b.weight - a.weight)[0]?.type || ACT.TOPIC
  const needsAction = !!(goal && (primary === ACT.REQUEST || primary === ACT.COMMAND || primary === ACT.REPAIR))

  // 紧迫度：他在赶时间/不满意时更高。连发是"话没说完"的信号，也算。
  let urgency = 0.25
  if (primary === ACT.REQUEST || primary === ACT.COMMAND) urgency += 0.25
  if (primary === ACT.CRITIQUE) urgency += 0.45
  if (primary === ACT.REPAIR) urgency += 0.3
  if (emoji.intense) urgency += 0.1
  if (Number(o.merged || 1) > 1) urgency += Math.min(0.2, 0.05 * Number(o.merged))
  if (Number(o.images) > 0 && !o.imageIsSticker) urgency += 0.05
  urgency = clamp(urgency, 0, 1)

  // 连续性：间隔 + 话题重合
  const ov = overlapOf(refs, o.prevRefs || [])
  let continuity = 'continuing'
  if (!prevUserAt) continuity = 'new_session'
  else if (gapMs < 90_000) continuity = 'same_beat'      // 同一拍里的补充/修正
  else if (gapMs < 10 * 60_000) continuity = 'continuing'
  else if (gapMs < 40 * 60_000) continuity = 'reopen'
  else continuity = 'new_session'
  if (continuity !== 'same_beat' && (o.prevRefs || []).length && ov === 0 && refs.length) continuity = 'shift'

  return {
    text, raw, at, gapMs,
    acts, primary, goal, referents: refs,
    emoji, urgency, continuity,
    overlap: ov,
    needsAction,
    isPureEmote: pureEmote,
    // 呼叫语（"在吗/人呢"）：不是提问，是他有话要说但还没开口。
    // reply-gate 已有 openThread 机制；这里给一个同义信号，供感知层/诊断使用。
    summon: RE.summon.test(text),
    // 图片：他没配字、图又没拿到 —— 这时候"猜图"是错的，应该说没看清
    // 只认**开头就是信封且没有别的字**的真信封。
    // 旧判据只要文本里出现「【他发来一张图片】」就成立 —— 任何人打这六个字
    // 都能让她以为"图没看清"（实际他发的是文字）。
    visionMissing: Number(o.images || 0) === 0 && /^【他发来一张图片/.test(raw) && !text,
    quote: String(o.quote || ''),
    isGroup: !!o.isGroup,
    // 这句话是不是**冲我**说的（2026-11-07 取舍 2）。
    // 群聊不搞第二套解码规则（那必然漂移），只在同一套解码之上加一个方向标记：
    //   @我 / 呼叫语 / 开头直接"你…" / 明确的祈使 → 冲我说的
    //   群里两个人互相聊（"他昨天那个事…"）→ 不是冲我说的
    // 下游用它决定"要不要把这话当任务接"（线程层的 isGroup 拦的是**私聊任务带进群**）。
    directed: !o.isGroup
      || !!o.atMe
      || RE.summon.test(text)
      || /^(你|你们|你俩)/.test(text)
      || /(帮我|帮忙|替我|你给我|你去|你能不能|麻烦你)/.test(text),
  }
}

/** 给人看的一行摘要（日志用）。 */
export function summarize(p) {
  if (!p) return ''
  const acts = (p.acts || []).map((a) => a.type).join('+')
  const goal = p.goal ? `→${p.goal.verb}${p.goal.object ? ' ' + p.goal.object : ''}` : ''
  return `[${p.primary}${goal}] ${acts} ${p.continuity}${p.needsAction ? ' 需动作' : ''}`
}

