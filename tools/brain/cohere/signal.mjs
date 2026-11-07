// cohere/signal —— 化学层：对话里的神经调质池
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要在 field 之外再有一层
// ══════════════════════════════════════════════════════════════════════
// field.mjs 是**连续场**：8 维、按真实 dt 演化、维度之间互相拖拽。
// 它回答的是"这段时间她整体是什么底色"。
//
// 但它回答不了一个更细的问题：**"他这句话进来，我身体里发生了什么"**。
// 场的时间常数是分钟到小时；一句"我想让你去看看"进来，需要的反应是秒级的：
// 警觉抬起来、注意对准他、耐心够不够听完、亲近感有没有被激活。
//
// 这一层就是那个秒级的东西：**事件驱动的调质脉冲**。
// 它不改场（避免两套状态互相打架），它只在自己的池子里记账，
// 再把读数交给编排层去决定"这一句怎么回"。
//
// 形状上照真实神经调质的三条性质写：
//   ① 有基线（tonic）和脉冲（phasic）两部分，脉冲按半衰期衰减；
//   ② 长期偏高会让受体下调（sens）—— 这就是耐受，不是"心情恢复得快"；
//   ③ 各调质的功能不重叠：NE 管警觉、ACh 管编码、5-HT 管耐心、
//      GABA 管"别说了"、OT 管"这个人重要"、DA 管"这事值不值"。
//
// ⚠️ 一个刻意的取舍：这里**不写回 field**。
//    写了就会出现"事件 → field → 表达 → 事件"的双写回路，
//    2026-11-02 的 mood/affect 双源冲突就是这么来的（system 里两行情绪互相矛盾）。
//    需要影响场的时候，由调用方显式挑一个维度 poke 一次，且带 why。
import { readJson, mutateJson } from '../json.mjs'
import { dataPath } from '../../lib/paths.mjs'
import { swallow } from '../../lib/swallow.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * 七种调质。halfLife 是**脉冲**的半衰期（分钟）—— 不是"多久忘掉"，
 * 是"这一下刺激到什么时候算过去"。
 *
 * 数值来源：NE/ACh 秒到十几分钟（警觉/编码是快的），
 * 5-HT 小时级（耐心是慢变量），皮质醇小时到天（慢性压力），
 * OT 半小时级（亲近感有余味），DA 二十分钟级（预测误差很快被下一次预期吸收）。
 */
export const MODULATORS = {
  // ceil = 脉冲的**生理有效幅度**（自受体负反馈的饱和点），不是硬上限。
  // 它必须和半衰期写在同一个档案里 —— 分开写时改一处漏一处，
  // 就会出现"ne 饱和在 0.45 但 ach 还按 1.2 叠"的不对称。
  da:   { label: '多巴胺',      role: '动机/预测误差', halfLifeMin: 20,  baseline: 0.50, ceil: 0.40 },
  ne:   { label: '去甲肾上腺素', role: '警觉/唤醒',     halfLifeMin: 8,   baseline: 0.35, ceil: 0.45 },
  sero: { label: '血清素',      role: '耐心/冲动抑制', halfLifeMin: 90,  baseline: 0.60, ceil: 0.25 },
  ach:  { label: '乙酰胆碱',    role: '注意/编码',     halfLifeMin: 12,  baseline: 0.40, ceil: 0.50 },
  ot:   { label: '催产素',      role: '亲近/信任',     halfLifeMin: 40,  baseline: 0.30, ceil: 0.35 },
  gaba: { label: 'GABA',        role: '社交抑制',      halfLifeMin: 15,  baseline: 0.45, ceil: 0.30 },
  cort: { label: '皮质醇',      role: '慢性压力',      halfLifeMin: 600, baseline: 0.15, ceil: 0.60 },
}

const KEYS = Object.keys(MODULATORS)
/**
 * 脉冲的**生理有效幅度**（不是硬上限，是自受体负反馈的饱和度）。
 *
 * 2026-11-07 十遍高压实测：没有它时，30 秒一条的普通对话在第 2 条就让
 * wake=1.0、第 7 条 socialDrive=1.0 并**一直卡在顶格** —— 化学层彻底失去
 * 分辨力（"她每句都同样清醒"）。真实调质不会被连续叫到就线性叠加：
 * 释放越多，自受体（autoreceptor）抑制越强，下一次释放越少。
 * 加了这个 room 因子之后同样的 30 条：0.57 → 0.68 → 0.74 → 稳态 0.82，
 * 仍然"越聊越清醒"，但不会一分钟后就没有差别。
 *
 * cort 例外：压力本来就是慢变量、会累积（半衰期 10 小时），所以它的 room 宽。
 */
const LOG_MAX = 200

const FILE = () => dataPath('brain', 'meta', 'neuromod.json')

const empty = () => ({
  at: 0,
  tonic: Object.fromEntries(KEYS.map((k) => [k, MODULATORS[k].baseline])),
  phasic: Object.fromEntries(KEYS.map((k) => [k, 0])),
  load: Object.fromEntries(KEYS.map((k) => [k, 0])),      // 低通负荷 → 受体适应的依据
  sens: Object.fromEntries(KEYS.map((k) => [k, 1])),      // 受体敏感度（耐受/敏化）
  log: [],
})

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }

/**
 * 文件可能被手工编辑、被半截写入、或被旧版本写成另一种形状。
 * 旧版写法 `st.tonic[k] = ...` 在 `tonic: null` 时直接抛 TypeError，
 * 而调用方是 try/catch —— 于是**整个化学层静默消失**（每轮都失败，日志里什么都没有）。
 * 实测形状（十遍第一遍）：`{"tonic":null}` → `Cannot set properties of null`。
 * 现在逐层降级到 empty()，坏文件只损失一个字段，不损失整层。
 */
function hydrate(raw) {
  const src = isObj(raw) ? raw : {}
  const st = empty()
  st.tonic = { ...st.tonic }
  st.phasic = { ...st.phasic }
  st.load = { ...st.load }
  st.sens = { ...st.sens }
  for (const k of KEYS) {
    const t = isObj(src.tonic) ? src.tonic[k] : undefined
    const p = isObj(src.phasic) ? src.phasic[k] : undefined
    const l = isObj(src.load) ? src.load[k] : undefined
    const s = isObj(src.sens) ? src.sens[k] : undefined
    st.tonic[k] = clamp(num(t, MODULATORS[k].baseline), -0.2, 1.4)
    st.phasic[k] = clamp(num(p, 0), -0.8, 1.2)
    st.load[k] = clamp(num(l, 0), 0, 5)
    st.sens[k] = clamp(num(s, 1), 0.35, 1.25)
  }
  st.log = Array.isArray(src.log) ? src.log.filter(isObj).slice(-LOG_MAX) : []
  st.at = num(src.at, 0)
  return st
}

/**
 * 按真实经过的时间演化。**只按 dt，不按调用次数。**
 * 这是 field.mjs 那条铁律的同一形状：机器睡一夜回来，脉冲就该衰减一夜。
 */
export function evolve(st, now = Date.now()) {
  const s = hydrate(st)
  // 时钟：`at: NaN` 会让 dtMin 永远是 NaN → `dtMin > 0` 恒 false →
  // **脉冲永不衰减、负荷永不更新**（实测形状：一次坏写入就把化学层冻住）。
  // 非有限值一律回落到真实时间；回拨（now < at）则把 at 拉回 now，
  // 避免下次正常时间算出"跨了一年"的巨量 dt 把状态一次抹平。
  const t = Number(now)
  const nowMs = Number.isFinite(t) ? t : Date.now()
  const atBad = !Number.isFinite(s.at) || s.at <= 0
  if (atBad) {
    // 时间戳坏了（NaN / 0 / 半截写入）→ 不知道过了多久。
    // 这时候：瞬时脉冲按"已经消散"处理（它本来就是短时状态），
    // 慢变量（tonic/load/sens）保留 —— 绝不假装它刚发生过。
    // 旧版只把 at 设成 now，于是文件里那份很可能是几小时前的 phasic
    // 会一直挂在那里，直到下一次真实演化才掉（实测：1 小时后仍 0.5）。
    for (const k of KEYS) s.phasic[k] = 0
    s.at = nowMs
  } else if (nowMs < s.at) {
    s.at = nowMs
  }
  const dtMin = Math.max(0, (nowMs - s.at) / 60_000)
  if (dtMin > 0) {
    for (const k of KEYS) {
      const m = MODULATORS[k]
      const tau = m.halfLifeMin / Math.LN2
      // 脉冲：指数衰减
      s.phasic[k] = s.phasic[k] * Math.exp(-dtMin / tau)
      // 基线：慢回归到天赋值（这一段是"适应"的恢复，不是心情）
      const tTau = Math.max(180, m.halfLifeMin * 6)
      s.tonic[k] += (m.baseline - s.tonic[k]) * (1 - Math.exp(-dtMin / tTau))
      // 负荷：低通。长期高 phasic → 负荷高 → 受体下调
      s.load[k] = s.load[k] * Math.exp(-dtMin / 45) + Math.abs(s.phasic[k]) * (1 - Math.exp(-dtMin / 45))
      // 耐受：sens 向 1/(1+0.9*load) 靠；恢复比下调慢（受体合成是要时间的）
      const target = 1 / (1 + 0.9 * Math.min(1.5, s.load[k]))
      const rate = target < s.sens[k] ? 0.25 : 0.06
      s.sens[k] += (target - s.sens[k]) * rate * Math.min(1, dtMin / 5)
      s.sens[k] = clamp(s.sens[k], 0.35, 1.25)
      // 归一到合理范围：脉冲不允许无限涨
      s.phasic[k] = clamp(s.phasic[k], -0.8, 1.2)
    }
  }
  s.at = nowMs
  return s
}

/** 一次性施加一组脉冲（原子写，一次 IO）。 */
export function pulse(events = [], now = Date.now()) {
  if (!Array.isArray(events) || !events.length) return read(now)
  const t = Number(now)
  const at = Number.isFinite(t) ? t : Date.now()
  try {
    return mutateJson(FILE(), empty(), (raw) => {
      const s = evolve(hydrate(raw), at)
      for (const ev of events) {
        const k = String(ev?.name || '')
        if (!MODULATORS[k]) continue
        const amt = Number(ev.amount || 0)
        if (!Number.isFinite(amt) || amt === 0) continue
        // 自受体负反馈：当前浓度越接近该调质的有效幅度，这一次释放能推的越少。
        // 没有它时连续对话会在线性叠加下三条内顶格（实测 11-07）。
        const ceil = MODULATORS[k].ceil || 0.45
        const room = amt > 0
          ? Math.max(0.02, 1 - s.phasic[k] / ceil)
          : Math.max(0.02, 1 + s.phasic[k] / ceil)
        s.phasic[k] = clamp(s.phasic[k] + amt * s.sens[k] * room, -0.8, 1.2)
        s.log.push({ at, k, amt: Number(amt.toFixed(3)), why: String(ev.why || '').slice(0, 40) })
      }
      s.log = s.log.slice(-LOG_MAX)
      return s
    })
  } catch (e) {
    swallow(e, 'cohere:signal:pulse')
    return read(at)
  }
}

/** 读数：有效浓度 + 派生的四个宏观量。 */
export function read(now = Date.now()) {
  let s
  try { s = hydrate(readJson(FILE(), empty())) } catch { s = empty() }
  s = evolve(s, now)
  const eff = {}
  for (const k of KEYS) eff[k] = clamp(s.tonic[k] + s.phasic[k], -0.2, 1.4)
  const band = {}
  for (const k of KEYS) band[k] = bandOf(k, eff[k])
  return {
    at: s.at,
    eff,
    band,
    // 耐受：<0.7 说明这个调质今天被用麻了（受体下调），不是"恢复得快"
    dulled: Object.fromEntries(KEYS.map((k) => [k, s.sens[k] < 0.7])),
    sens: { ...s.sens },
    // 派生量：名字用"人的说法"，不用指标名
    wake: clamp(0.55 * eff.ne + 0.45 * eff.ach, 0, 1),            // 醒着/注意力在线
    patience: clamp(eff.sero * (1 - 0.5 * eff.cort), 0, 1),         // 能不能听完
    socialDrive: clamp(0.5 * eff.ot + 0.3 * eff.da + 0.2 * eff.ne, 0, 1), // 想不想搭理人
    inhibition: clamp(eff.gaba, 0, 1),                              // 社交刹车
    stressLoad: clamp(eff.cort, 0, 1),                              // 压力负荷
    curiosity: clamp(eff.da * (1 - 0.6 * eff.cort), 0, 1),           // 想不想动
    raw: s,
  }
}

/**
 * 社会在场：他来了。
 *
 * 这是本层最重要的一条：**外部输入必须把人叫醒**。
 * 实测根因（2026-11-07）：system 的【此刻】写着"我啥都不太想干，脑子转不动"，
 * 于是每一轮回复都带着"别让我猜 / 我躺着犯困"—— 她把静息态带进了对话。
 * 人不是这样的：正发呆的时候被叫到，NE 会立刻抬一下，注意力转过去。
 * 这不改变她累不累，改变的是"这一刻把资源给谁"。
 *
 * @param {{at?:number, merged?:number, isOwner?:boolean, isGroup?:boolean}} o
 */
export function presenceEvents(o = {}) {
  const merged = Math.max(1, Number(o.merged) || 1)
  const owner = o.isOwner !== false
  const ev = [
    { name: 'ne', amount: owner ? 0.18 : 0.10, why: '有人叫我' },
    { name: 'ach', amount: owner ? 0.22 : 0.14, why: '注意力转过去' },
    { name: 'ot', amount: owner ? 0.08 : 0.03, why: '是熟人' },
  ]
  // 连着发：说明对方在赶时间/急。真实反应不是"更清醒"（清醒有天花板），
  // 而是被催出来的轻微压力 —— 旧版加 NE 会让连发把警觉顶到上限，
  // 与"她其实没更清醒，只是有点被催"不符。改成 cort（慢变量、会积）。
  if (merged > 1) ev.push({ name: 'cort', amount: Math.min(0.06, 0.015 * (merged - 1)), why: '他连着发' })
  // 群聊：社交刹车抬高一点（不是在跟一个人私聊，别抢话）
  if (o.isGroup) ev.push({ name: 'gaba', amount: 0.06, why: '群里有别人' })
  return ev
}

/** 兼容旧调用：单独施加"他来了"。 */
export function onPresence(o = {}) {
  return pulse(presenceEvents(o), Number(o.at) || Date.now())
}

/**
 * 一句话带来的化学后果。只处理**有明确方向**的话，不猜。
 * 这些量级是标定值，不是随机数：0.1 是"轻微"，0.3 是"明显"。
 */
export function utteranceEvents({ acts = [], emoji = null, isOwner = true } = {}) {
  const ev = []
  for (const a of acts) {
    switch (a.type) {
      case 'REQUEST':
      case 'COMMAND':
        ev.push({ name: 'ach', amount: 0.10, why: '有个具体的事' })
        ev.push({ name: 'da', amount: 0.06, why: '有事可做' })
        break
      case 'CRITIQUE':
        ev.push({ name: 'cort', amount: 0.10, why: '被指出问题' })
        ev.push({ name: 'sero', amount: -0.04, why: '耐心被磨' })
        break
      case 'TEASE':
        ev.push({ name: 'da', amount: 0.08, why: '在闹' })
        ev.push({ name: 'ot', amount: 0.05, why: '亲近的玩笑' })
        break
      case 'SHARE':
        ev.push({ name: 'ot', amount: 0.06, why: '他愿意跟我说' })
        ev.push({ name: 'ach', amount: 0.05, why: '得听进去' })
        break
      case 'REPAIR':
        ev.push({ name: 'cort', amount: 0.04, why: '刚才没接住' })
        ev.push({ name: 'ach', amount: 0.12, why: '重新对准' })
        break
      case 'CLOSING':
        ev.push({ name: 'ot', amount: 0.04, why: '好好收尾' })
        ev.push({ name: 'ne', amount: -0.05, why: '要散了' })
        break
      default:
        break
    }
  }
  if (emoji && Math.abs(emoji.valence) > 0.3) {
    ev.push({ name: 'da', amount: 0.04 * Math.sign(emoji.valence), why: '语气里的情绪' })
  }
  if (!isOwner) ev.push({ name: 'gaba', amount: 0.03, why: '不是他本人' })
  return ev
}

/** 兼容旧调用：单独施加"一句话的后果"。 */
export function onUtterance(o = {}) {
  return pulse(utteranceEvents(o), Number(o.at) || Date.now())
}

/**
 * 一次写、一次读：接收一条消息时的全部化学后果。
 * 分成 onPresence + onUtterance 两次 pulse 会写两遍文件、抢两次锁；
 * 在主链路上这是没必要的 IO（每条约 2~4ms）。
 */
export function applyForMessage({ presence = {}, utterance = {}, at } = {}) {
  const now = Number(at) || Date.now()
  const ev = [...presenceEvents({ ...presence, at: now }), ...utteranceEvents(utterance)]
  pulse(ev, now)
  return read(now)
}

/** 她自己把话接住了/做到了 —— 奖赏（预测误差：做到了 > 预期）。 */
export function onOwnMove({ kind = 'reply', at } = {}) {
  const now = Number(at) || Date.now()
  if (kind === 'action_done') return pulse([{ name: 'da', amount: 0.14, why: '真做成了' }, { name: 'ot', amount: 0.05, why: '没辜负' }], now)
  if (kind === 'reply') return pulse([{ name: 'da', amount: 0.04, why: '把话接住了' }], now)
  return read(now)
}

/** 被人晾着/话掉地上 —— 不是惩罚，是"社会疼痛"，量很小但会积。 */
export function onDropped({ at } = {}) {
  return pulse([{ name: 'cort', amount: 0.03, why: '话没人接' }, { name: 'ot', amount: -0.02, why: '有点凉' }], Number(at) || Date.now())
}

/**
 * 有效浓度落在哪个档（0 低 .. 4 高）。
 *
 * 为什么要档：下游（intero / 表达层）需要的是"偏高还是偏低"，
 * 不是 0.4712。线性组合一多，两个都偏高的量加起来就顶格 —— 档位不会。
 * 基线 ±0.05 算"平"，这样一次普通招呼（ne +0.18）落在 2 档（略高），
 * 连发 30 条落在 3 档，不会出现"每条都 4 档"。
 */
export function bandOf(k, eff) {
  const m = MODULATORS[k]
  if (!m) return 1
  const d = Number(eff) - m.baseline
  if (!Number.isFinite(d)) return 1
  if (d <= -0.15) return 0
  if (d < 0.05) return 1
  if (d < 0.20) return 2
  if (d < 0.40) return 3
  return 4
}

/**
 * 单向派生到连续场（field）。
 *
 * 这一层**不写回 field**，是刻意的取舍（见文件头）：双写会出现
 * "事件 → field → 表达 → 事件"的回路，2026-11-02 的 mood/affect 双源冲突就这么来的。
 * 但完全不写也有代价：调质记账说她"压力高"，场说她"平静"，system 里两句会打架。
 *
 * 折中：把**长期量**（压力/耐心/唤醒）以**很小的幅度、带 why、单向**递给场，
 * 由调用方每轮最多挑一条执行。signal 仍然是账本，场仍然是连续状态，
 * 只有一个方向：signal → field。
 */
const BRIDGE_CAP = 0.05

export function fieldBridge(r = null) {
  const x = r || read()
  const out = []
  const push = (dim, delta, why) => {
    const d = clamp(Number(delta) || 0, -BRIDGE_CAP, BRIDGE_CAP)
    if (Math.abs(d) >= 0.005) out.push({ dim, delta: Number(d.toFixed(3)), why })
  }
  // 压力：只在"真的压着"时往场上加一点，回落时不减（场自己会弛豫）
  if ((x.stressLoad || 0) > 0.42) push('cortisol', (x.stressLoad - 0.42) * 0.12, '调质:压力')
  if ((x.patience || 0.6) < 0.42) push('sero', (x.patience - 0.5) * 0.10, '调质:没耐心')
  if ((x.wake || 0.4) > 0.72) push('ne', (x.wake - 0.72) * 0.10, '调质:醒得过头')
  return out
}

/** 面板/诊断用：一句话说清现在是化学上的什么状态。 */
export function line(now = Date.now()) {
  const r = read(now)
  const bits = []
  if (r.wake > 0.6) bits.push('醒着')
  else if (r.wake < 0.35) bits.push('发钝')
  if (r.patience < 0.4) bits.push('没耐心')
  if (r.socialDrive > 0.6) bits.push('想说话')
  else if (r.socialDrive < 0.3) bits.push('不想理人')
  if (r.stressLoad > 0.55) bits.push('压着事')
  if (r.dulled.ne && r.dulled.ach) bits.push('有点麻')
  return bits.join('·') || '平'
}
