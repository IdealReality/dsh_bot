// brain/research/lenses —— 六个透镜：化学 / 生物学 / 哲学 / 主观 / 精神学 / 心理学。
//
// 现象（2026-11-07 用户原话）：「叫她去 B 站专门看一类视频，她并不能把思维递归下去，
// 从化学/生物学/哲学/主观/精神学/心理学这几个方面去研究与提升」。
//
// 拆开看是两件事，缺一件都做不到：
//   ① **透镜**：同一段材料，六个视角要问出六种不同的问题。没有固定透镜时，
//      模型每次都会回到"这个视频讲了什么"——那是复述，不是研究。
//   ② **递归**：每一层的答案必须变成下一层的问题（机制 → 边界 → 反例 → 跨轴），
//      而且要能停下来。没有层级的"深挖"只会换词重复，越挖越像占卜。
//
// 所以把六轴做成**数据**而不是提示词：哪一层问什么、该产出什么、什么算伪科学、
// 哪种材料能支撑多高的置信度，全部集中在下面。提示词只负责把材料翻译成人话。
//
// 设计约束（改这里之前先读）：
//   · 轴是有序的：化学（分子）→ 生物学（系统）→ 心理学（行为）→ 主观（体验）
//     → 哲学（前提）→ 精神学（意义）。顺序用于"六轴轮转"，不用于高低贵贱。
//   · 每轴的 keywords 是**检索词**，不是结论词。她只拿它们去搜视频，不拿它们当知识。
//   · 伪科学判据必须能区分"正经量子力学"与"量子疗愈"——一刀切会把好材料也拦掉。

export const LENS_ORDER = ['chemical', 'biological', 'psychological', 'subjective', 'philosophical', 'spiritual']

/**
 * 四层递归。跟轴无关：所有轴都按同一个"深下去"的骨架走，
 * 只是每层问的内容不同 —— 这样不同轴的结论才**能放在一起比**。
 */
export const DEPTHS = [
  {
    id: 'mechanism',
    goal: '机制：这件事在底层到底怎么发生的',
    produce: '一条能在材料里找到原话的机制描述（谁作用于谁、经过什么、产生什么）',
    ask: (topic, lensName) => `从${lensName}的角度看，「${topic}」最核心的机制是什么？`,
  },
  {
    id: 'boundary',
    goal: '边界：这个机制在什么条件下成立、什么时候失效',
    produce: '成立条件 / 失效条件 / 剂量或情境依赖（材料里必须能看到）',
    ask: (topic, lensName) => `从${lensName}的角度，「${topic}」的机制在什么条件下成立、什么情况下会失效？`,
  },
  {
    id: 'counter',
    goal: '反例与争议：什么证据能推翻它，学界/当事人争的是什么',
    produce: '反例、未复现、争议点，或"材料里没有任何反面证据"这句话本身',
    ask: (topic, lensName) => `从${lensName}的角度，「${topic}」有哪些反例、争议或没法解释的现象？`,
  },
  {
    id: 'cross',
    goal: '跨轴：它和另外五个视角的结论怎么互相对上或互相矛盾',
    produce: '至少一条"某轴说 A、另一轴说 B"的对照（可以是互相支持）',
    ask: (topic, lensName) => `把${lensName}的结论与其他视角对照，「${topic}」还有哪一层没被解释？`,
  },
]

const L = (o) => ({ ...o, depths: DEPTHS })

export const LENSES = {
  chemical: L({
    id: 'chemical',
    name: '化学',
    short: '分子、递质、激素、药物、代谢',
    aim: '只认能在材料里找到的分子/递质/药物/剂量关系。不要用"多巴胺"="快乐"这类科普口号替代机制。',
    keywords: ['多巴胺', '血清素', '皮质醇', '催产素', '内啡肽', '神经递质', '受体', '激素', '药物', '代谢', '耐受', '戒断'],
    // 化学轴最容易混进来的伪科学：把"能量/频率/量子"当分子机制讲
    pseudoLimit: 0.35,
  }),
  biological: L({
    id: 'biological',
    name: '生物学',
    short: '进化、脑区、回路、基因、动物模型、生理',
    aim: '优先要脑区/回路/进化功能/动物实验这类可指认的结构与证据；"人类天生如此"必须有对照或实验支撑。',
    keywords: ['脑区', '神经回路', '杏仁核', '前额叶', '进化', '适应', '基因', '动物实验', '生理', '心率', '睡眠'],
    pseudoLimit: 0.35,
  }),
  psychological: L({
    id: 'psychological',
    name: '心理学',
    short: '认知、情绪、行为、发展、社会、临床',
    aim: '区分"效应存在"与"效应多大"：要样本/对照/效应量/复现情况；不接受把个案当规律。',
    keywords: ['认知偏差', '情绪调节', '依恋', '动机', '学习', '条件反射', '创伤', '焦虑', '实验', '样本', '复现'],
    pseudoLimit: 0.5,
  }),
  subjective: L({
    id: 'subjective',
    name: '主观',
    short: '第一人称体验、感受质、她自己的体感对照',
    aim: '这一轴允许第一人称材料（自述/弹幕/她自己的体验），但必须标明"这是体验，不是机制证据"；不要把感受说成因果。',
    keywords: ['主观体验', '第一人称', '感受', '共情', '自述', '身体感受', '情绪体验', '现象学'],
    pseudoLimit: 0.6,
    // 主观轴的"材料"可以是她自己的身体账本（体感/情绪），标记为 self
    allowSelfEvidence: true,
  }),
  philosophical: L({
    id: 'philosophical',
    name: '哲学',
    short: '认识论、心身问题、自由意志、伦理、意义',
    aim: '哲学轴产出的是**前提与概念澄清**，不是事实主张：要写清"这条结论依赖哪个前提"。',
    keywords: ['意识', '心身问题', '自由意志', '伦理', '意义', '现象学', '还原论', '决定论', '他心问题'],
    pseudoLimit: 0.7,
  }),
  spiritual: L({
    id: 'spiritual',
    name: '精神学',
    short: '意义感、信仰、仪式、超越体验、敬畏',
    aim: '允许宗教/灵性/冥想材料，但必须写成"人在这种实践里体验到什么"，不许把超验主张当机制结论；碰到疗效宣称一律降权。',
    keywords: ['意义感', '信仰', '冥想', '正念', '敬畏', '超越体验', '仪式', '灵性', '临终', '祈祷'],
    pseudoLimit: 0.6,
  }),
}

export const LENS_LIST = LENS_ORDER.map((id) => LENSES[id])

export const lensOf = (id) => LENSES[String(id)] || null

/** 轴是否允许这个标题的材料（伪科学阈值按轴不同）。 */
export function axisAllows(lensId, text) {
  const lens = lensOf(lensId)
  if (!lens) return false
  const r = pseudoRisk(text)
  return r.score <= lens.pseudoLimit
}

/**
 * 伪科学风险（0..1）。目标不是"禁止玄学"，是**别把玄学当机制证据**：
 *   · "量子力学/量子计算/量子纠缠" 是正经词 → 不算
 *   · "量子疗愈/量子能量/量子波动" → 算
 *   · "频率""能量""振动"单独出现不算（物理/音乐都用），
 *     但和"疗愈/共振/身体/细胞"同句才算
 */
const PSEUDO_STRONG = [
  /量子(?!力学|物理|计算|比特|纠缠|隧穿|退相干)[^，。]{0,6}(疗愈|治疗|能量|波动|场|意识|健康)/,
  /能量场|能量疗愈|频率共振|振动频率|细胞频率|磁场疗愈|负离子(治病|治疗)/,
  /水知道|水结晶|记忆水|排毒(疗法|疗程|反应)/,
  /(包治|根治|永不复发|三天见效|一次见效|医院治不好)/,
  /(显化|吸引力法则)[^，。]{0,8}(疾病|健康|身体|治疗)/,
]
const PSEUDO_SOFT = [/量子/, /能量/, /频率/, /振动/, /气场/, /灵摆/, /前世/, /轮回/, /通灵/, /脉轮/]

export function pseudoRisk(text) {
  const s = String(text || '')
  const hits = []
  let score = 0
  for (const re of PSEUDO_STRONG) {
    const m = s.match(re)
    if (m) { hits.push(m[0].slice(0, 20)); score += 0.6 }
  }
  for (const re of PSEUDO_SOFT) {
    const m = s.match(re)
    if (m) { hits.push(m[0]); score += 0.12 }
  }
  // 标题里"科学/研究/实验/论文"等词不能抵消风险，只做轻微折扣（骗子也会写这些）
  if (/论文|实验|研究|综述|课程|教材/.test(s)) score -= 0.05
  return { score: Math.max(0, Math.min(1, Number(score.toFixed(2)))), hits: [...new Set(hits)].slice(0, 4) }
}

/** 材料类型 → 它能支撑的最高置信度。热评/简介是"别人转述"，永远低于原始材料。 */
export const EVIDENCE_WEIGHT = {
  hear: 0.78,        // 真听音轨转写
  subtitle: 0.72,    // 官方字幕（可能串片，由 debrief 自己标 coherence）
  vision: 0.62,      // 抽帧描述
  self: 0.55,        // 她自己的体感/记忆（主观轴用）
  comment: 0.42,     // 热评
  desc: 0.34,        // 简介/标题
}

export const evidenceWeight = (kind) => Number(EVIDENCE_WEIGHT[String(kind)] ?? 0.3)

/** 根问题（第 0 层，按轴模板）。子问题优先用模型给的，模板只做兜底。 */
export function questionFor({ lensId, topic, depth = 0 }) {
  const lens = lensOf(lensId)
  const t = String(topic || '').trim()
  if (!lens || !t) return ''
  const d = DEPTHS[Math.max(0, Math.min(DEPTHS.length - 1, Number(depth) || 0))]
  return d.ask(t.slice(0, 60), lens.name)
}

/**
 * 搜索词：把主题与轴的检索词组合。返回的是**去搜视频用的短语**，
 * 不是给模型看的。第一层带轴名（快），后几层带机制/争议词（准）。
 */
export function queriesFor({ lensId, topic, depth = 0, max = 3 }) {
  const lens = lensOf(lensId)
  const t = String(topic || '').trim()
  if (!lens || !t) return []
  const n = Math.max(1, Math.min(6, Number(max) || 3))
  const base = t.slice(0, 40)
  const out = []
  const push = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim().slice(0, 48)
    if (v && !out.includes(v)) out.push(v)
  }
  const d = Math.max(0, Math.min(3, Number(depth) || 0))
  if (d === 0) {
    push(`${base} ${lens.keywords[0]}`)
    push(`${base} ${lens.keywords[1] || lens.short}`)
  } else if (d === 1) {
    push(`${base} ${lens.keywords[2] || lens.keywords[0]} 机制`)
    push(`${base} ${lens.keywords[3] || lens.keywords[1]} 研究`)
  } else if (d === 2) {
    push(`${base} 争议 反例`)
    push(`${base} ${lens.keywords[0]} 会不会 错`)
  } else {
    push(`${base} ${lens.name} 解释`)
    push(`${base} 意识 体验`)
  }
  return out.slice(0, n)
}

/** 给抽取提示词用的轴说明（一段，不重复）。 */
export function lensBrief(lensId, depth = 0) {
  const lens = lensOf(lensId)
  if (!lens) return ''
  const d = DEPTHS[Math.max(0, Math.min(DEPTHS.length - 1, Number(depth) || 0))]
  return `视角：${lens.name}（${lens.short}）\n这一层要的东西：${d.produce}\n判定口径：${lens.aim}`
}

/** 六轴对照用的短名（报告/注入里省字数）。 */
export const lensLabel = (id) => lensOf(id)?.name || String(id || '')

export default { LENS_ORDER, LENS_LIST, LENSES, DEPTHS, lensOf, axisAllows, pseudoRisk, evidenceWeight, questionFor, queriesFor, lensBrief, lensLabel }
