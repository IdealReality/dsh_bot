// brain/learn/strategies —— 生物/精神层：策略库（哪种"接法"对她有效）
//
// ══════════════════════════════════════════════════════════════════════
// 与 AstrBot 那几个拟人插件的对照（2026-11-07 调研）
// ══════════════════════════════════════════════════════════════════════
// · `astrbot_plugin_self_learning`：从群聊挖"表达风格/黑话"，进审查队列后
//   以 few-shot 注入。学的是**语言表面**。
// · `astrbot_plugin_group_chat`：四态心流 + 在线 Q-learning + 离线蒸馏，
//   学的是**什么时候说话**（策略=发言/沉默/接话），奖励来自反馈。
//
// 两者都值得看，但直接搬会缺两样东西：
//   ① **学什么**：它们的策略是"动作"（说/不说、用哪种梗），没有"用哪种心理
//      姿势接"这一层。而人聊天时先决定姿势（顺着闹/认真接/先压住自己的情绪），
//      再决定措辞 —— 姿势错了，措辞再像也没用。
//   ② **谁在学**：Q 表没有价值观。人会拒绝"有效但不像我"的说法
//      （哲学层的自我一致性）；也会因为"这招用腻了"而主动换
//      （生物层的习惯化）。这两条在纯强化学习里都不存在。
//
// 所以这里的策略是 6 种**心理姿势**（与 psyche.DEFENSES 同一套名字），
// 每个带一个 `fits`（与"我是谁"的契合度，哲学层），选择分数 =
//   场景先验 + 学到的权重 × 契合度 × 受体敏感度
// 场景先验保证"该认真的时候不会因为学过幽默就一直开玩笑"。
import { readJson, mutateJson } from '../json.mjs'
import { BRAIN } from '../paths.mjs'
import path from 'node:path'
import { swallow } from '../../lib/infra/swallow.mjs'
import { reinforce, habituate, rewardOf, recover } from './rpe.mjs'

/** 六种姿势：label 给人看，fits 是"这像我吗"（0..1，哲学层）。 */
export const STRATEGIES = {
  humor:          { label: '幽默',   fits: 1.00, why: '把紧张转成能一起笑的东西' },
  sublimation:    { label: '升华',   fits: 0.95, why: '把情绪转成动作：去查、去做' },
  altruism:       { label: '利他',   fits: 1.00, why: '先接住他，再处理自己' },
  suppression:    { label: '压抑',   fits: 0.85, why: '知道有情绪，但先不拿出来' },
  rationalization:{ label: '合理化', fits: 0.80, why: '先认下问题，再解释' },
  avoidance:      { label: '回避',   fits: 0.55, why: '话短、不展开（能不用就不用）' },
}

const FILE = () => path.join(BRAIN(), 'learn', 'strategies.json')
const empty = () => ({
  at: 0,
  arm: Object.fromEntries(Object.keys(STRATEGIES).map((k) => [k, { w: 0.5, mean: 0, sens: 1, n: 0 }])),
  last: null,          // { chatId, name, at } —— 资格迹：等他的下一条来评分
  stats: { turns: 0, updates: 0, rewardSum: 0 },
})

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.arm = { ...empty().arm, ...(st.arm || {}) }
  for (const k of Object.keys(STRATEGIES)) {
    const a = st.arm[k] || {}
    st.arm[k] = {
      w: Math.max(0.05, Math.min(0.95, Number(a.w ?? 0.5))),
      mean: Math.max(-1, Math.min(1, Number(a.mean ?? 0))),
      sens: Math.max(0.35, Math.min(1.25, Number(a.sens ?? 1))),
      n: Number(a.n ?? 0),
    }
  }
  st.stats = { turns: 0, updates: 0, rewardSum: 0, ...(st.stats || {}) }
  return st
}

export function load() {
  try { return hydrate(readJson(FILE(), null)) } catch { return empty() }
}

function save(st) {
  try { return hydrate(mutateJson(FILE(), empty(), () => st)) } catch (e) { swallow(e, 'learn:save'); return hydrate(st) }
}

/**
 * 场景先验（生物学层）：不看学到的权重，只看"这一轮他做了什么、她什么状态"。
 * 与 psyche 的静态规则同源，但这里必须能**打分**（不是 if 链），
 * 否则学习和先验没法相加。
 */
export function baseScores({ percept: p = {}, signal: s = {}, intero: f = {} } = {}) {
  const sc = { humor: 0, sublimation: 0, altruism: 0.8, suppression: 0, rationalization: 0, avoidance: 0 }
  const intimacy = Number(s.eff?.ot ?? 0.3)
  const stress = Number(s.stressLoad ?? 0.2)
  const patience = Number(s.patience ?? 0.6)
  if (p.primary === 'TEASE' || (p.emoji && p.emoji.valence > 0.4 && p.primary === 'EMOTE')) sc.humor += 3
  if (p.needsAction && Number(s.curiosity ?? 0.4) > 0.3 && stress < 0.6) sc.sublimation += 3
  if (p.primary === 'CRITIQUE' || p.primary === 'REPAIR') sc.rationalization += 3.5
  if (intimacy > 0.55 && patience > 0.35) sc.altruism += 1.5
  if (stress > 0.62 && patience < 0.35 && intimacy < 0.4) sc.avoidance += 2.5
  if (Number(f.capacity ?? 1) < 0.35) sc.suppression += 1.5
  return sc
}

/**
 * 选一个姿势。
 *
 * @param {object} o { percept, signal, intero, base }
 * @param {string} [o.base] 静态规则给的选择；学到的分数必须**明显超过**它才切换
 * @returns {{name:string, score:number, base:number, learned:number, switched:boolean}|null}
 */
/**
 * 证据的置信度：n 次观测 → 0..1（贝叶斯式收缩）。
 *
 * 没有它时，1 次夸奖就能把一个姿势的 w 从 0.5 推到 0.56，而"0.56 的绝对权重"
 * 在旧公式里等价于"已经确定有效"。人不是这样从一次互动里学出偏好的 ——
 * 4 次之后置信度才到一半，20 次到 0.83。
 */
export const confidenceOf = (n) => {
  const x = Math.max(0, Number(n) || 0)
  return x / (x + 4)
}

/** 一个姿势此刻的"学习分量"（0..1，0.5 = 没证据）。 */
export function learnedOf(st, name) {
  const a = st?.arm?.[name]
  const def = STRATEGIES[name]
  if (!a || !def) return 0.5
  return 0.5 + (a.w - 0.5) * def.fits * confidenceOf(a.n)
}

export function pick(o = {}) {
  o = o || {}   // pick(null) 也要能用
  const st = load()
  const now = Date.now()
  // 按真实经过的小时恢复敏感度（受体合成）
  if (st.at && now > st.at) {
    const h = (now - st.at) / 3600_000
    if (h > 0.5) {
      for (const k of Object.keys(st.arm)) st.arm[k] = recover(st.arm[k], h)
      st.at = now
      save(st)   // 受体恢复要落盘，否则每次都被当成"刚恢复过"
    }
  }
  const base = String(o.base || '')
  const sc = baseScores(o)
  let best = null
  for (const [name, def] of Object.entries(STRATEGIES)) {
    // 2026-11-07（十遍第六遍 + 之后的系统性改造）：
    // ① 旧式 `w * fits * sens` 会让"被反复强化到 w=0.95 的姿势"因耐受输给没用过的策略
    //    —— 受体下调影响的是学得多快，不是让偏好消失；
    // ② 改成"相对中性偏了多少"后仍然太容易：1 次夸奖就把 w 推到 0.56，
    //    在绝对尺度上像是"已经确定有效"。现在再乘证据置信度（n/(n+4)）。
    const learned = learnedOf(st, name)
    const score = Number((sc[name] + learned * 2.2).toFixed(3))
    if (!best || score > best.score) best = { name, score, base: sc[name], learned: Number(learned.toFixed(3)), switched: false }
  }
  if (!best) return null
  best.why = 'prior'

  // 迟滞：先验负责"基线选谁"，学习只负责"是否改写"。
  // 2026-11-07 取舍 1 的改造：旧版阈值一律 0.2，两个后果都不好 ——
  //   · 弱先验场景（默认 altruism 0.8）学习很难生效；
  //   · 强先验场景（他在挑错 → rationalization 3.5）只要攒够 0.2 就能被改写，
  //     "该认真的时候因为学过玩笑就一直玩笑"。
  // 现在按**先验强度**分档：强先验要 0.35 的证据优势才肯让位，弱先验 0.15 就行。
  // 并且把"为什么没改"写进返回值（why），面板/日志能看出是证据不足还是先验锁定。
  if (base && STRATEGIES[base] && best.name !== base) {
    const baseLearned = learnedOf(st, base)
    const gap = best.learned - baseLearned
    const strongPrior = Number(sc[base] || 0) >= 2
    const need = strongPrior ? 0.35 : 0.15
    if (gap < need) {
      return {
        name: base,
        score: Number((sc[base] + baseLearned * 2.2).toFixed(3)),
        base: sc[base],
        learned: Number(baseLearned.toFixed(3)),
        switched: false,
        why: strongPrior ? 'prior' : 'hysteresis',
        gap: Number(gap.toFixed(3)),
        need,
      }
    }
    best.switched = true
    best.why = 'evidence'
    best.gap = Number(gap.toFixed(3))
    best.need = need
  }
  return best
}

/**
 * 单事务更新：load 必须发生在锁内。
 * 旧写法 `const st = load(); ...; save(st)` 在 8 进程并发下丢了 97% 的更新
 * （实测 n=5，期望 200）—— 因为 save 虽然加锁，但写回的是锁外读到的旧快照。
 */
function mutate(fn) {
  try {
    return mutateJson(FILE(), empty(), (raw) => {
      const st = hydrate(raw)
      fn(st)
      return st
    })
  } catch (e) { swallow(e, 'learn:mutate'); return null }
}

/** 说了这句话：记资格迹 + 受体下调（耐受）。 */
export function recordUsed(chatId, name, now = Date.now()) {
  if (!STRATEGIES[name]) return null
  return mutate((st) => {
    st.arm[name] = habituate(st.arm[name])
    st.last = { chatId, name, at: now }
    st.at = now
  })
}

/**
 * 他的下一条来了：给上一轮的姿势评分并强化。
 *
 * @param {object} o { chatId, percept, continued, praised, scolded, now }
 * @returns {{name:string, reward:number, rpe:number}|null}
 */
export function observeIncoming({ chatId, percept = null, continued = true, praised = false, scolded = false, now = Date.now() } = {}) {
  let result = null
  mutate((st) => {
    const last = st.last
    if (!last || !STRATEGIES[last.name]) return
  // 只评"同一段对话"：隔了几小时的重新开场，无法归因到上一条的说法
    if (last.chatId && chatId && last.chatId !== chatId) return
    if (now - Number(last.at || 0) > 30 * 60_000) { st.last = null; return }

    const reward = rewardOf({ nextPercept: percept, continued, praised, scolded })
    const r = reinforce(st.arm[last.name], reward)
    st.arm[last.name] = r.arm
    st.stats.updates += 1
    st.stats.rewardSum = Number((st.stats.rewardSum + reward).toFixed(3))
    st.stats.turns += 1
    st.last = null
    st.at = now
    result = { name: last.name, reward: Number(reward.toFixed(3)), rpe: r.rpe }
  })
  return result
}

/** 这一轮开始时 +1（统计用，不做学习）。 */
export function tick(now = Date.now()) {
  const st = load()
  st.stats.turns += 1
  st.at = now
  return save(st)
}

/** 面板/诊断：六种姿势的当前权重。 */
export function status() {
  const st = load()
  return {
    at: st.at,
    arms: Object.entries(st.arm).map(([k, a]) => ({
      name: k, label: STRATEGIES[k].label,
      w: Number(a.w.toFixed(3)), mean: Number(a.mean.toFixed(3)),
      sens: Number(a.sens.toFixed(3)), n: a.n,
      conf: Number(confidenceOf(a.n).toFixed(2)),
      learned: Number(learnedOf(st, k).toFixed(3)),
    })).sort((x, y) => y.w - x.w),
    last: st.last,
    stats: st.stats,
  }
}
