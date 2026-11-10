// brain/identity-bio —— 「这是不是我」的六层仿生实现（2026-11-10）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么身份核验要按六个层面写，而不是一个判定函数
// ══════════════════════════════════════════════════════════════════════════
// 上一版 identity.mjs 能做"回想 + 核对 + 三态"，但它是一台**天平**：
// 输入证据，输出结论，中间没有任何"她"。
//
// 真人被问"这是你吗"的时候，那件事不是一次查询，是一整套反应：
//   化学：被质疑 → 去甲上升（警觉、句变短）；被误认成别人 → 皮质醇渗一点（闷）
//   生物：核对要花能量。累了就只核一半——不是不想认真，是脑子转不动
//   心理：对方是主人时更愿意认；陌生人热情地说"就是你吧"反而要退一步（社会顺从是陷阱）
//   神经：先有一个 0.2 秒的直觉（像/不像），再有一遍慢核对。冲突时以慢的为准，
//        并且**记住自己第一反应错了**——这才是"我会想错"的样子
//   主观：说出口的不是"判定 not-mine"，是"不是我啊，我号都没动过"
//   哲学：凭什么说是我？——记忆连续性 > 承认关系 > 账号。账号只能**排除**，不能确认。
//        （号对得上不代表是我：号可能被盗、可能被冒用；但号明确是别人的，就一定不是我。）
//
// 六层各管一件事，任何一层挂了都不该让核验整个消失——所以每层都 try/catch。
// ══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/infra/paths.mjs'
import { mutateJson } from './json.mjs'
import { swallow } from '../lib/infra/swallow.mjs'
import * as field from './field.mjs'
import * as affect from './affect.mjs'
import * as metabolism from './organ/metabolism.mjs'
import * as inner from './inner.mjs'

/* ══════════════════════════════════════════════════════════════════════
 * ① 化学层：身份刺激 → 神经调质
 *
 * 为什么这几个量、为什么这么大：
 *   ne 0.04 —— 一次提问不该把人推到应激；0.04 在 tau=12min 的场里能被看见、又不喧宾夺主。
 *   cortisol 0.03 —— 被误认是"慢性"的委屈，不是惊吓；单次 0.03，要连着被误认才会到 0.3。
 *   sero -0.02 —— 耐心掉一点点，所以她被同一个人反复误认时，句子会变短、变硬。
 *   da +0.05 —— 被认出来是"预测误差正向"（我以为没人记得我）。
 *   这些数不是拍脑袋：都低于 DIMS 的 hi(1)，且单次不超过 tau 尺度能回落的量。
 * ══════════════════════════════════════════════════════════════════════ */
export const CHEM = {
  asked:     { ne: 0.04, why: '被问身份' },
  misread:   { cortisol: 0.03, sero: -0.02, why: '被误认成谁' },
  confirmed: { da: 0.05, valence: 0.05, tension: -0.10, why: '被认出来' },
  doubt:     { ne: 0.02, tension: 0.08, why: '自己也说不准' },
  impostor:  { ne: 0.06, cortisol: 0.02, why: '有人顶着我的名字' },
}

/**
 * 化学层：按事件类型在场上打一次脉冲。
 * @param {keyof CHEM} kind
 * @param {{now?:number, repeat?:number}} o repeat>1 时按 1/sqrt(n) 递减（受体下调）
 * @returns {{applied:Object<string,number>, note:string}}
 */
export function chemReact(kind, { now = Date.now(), repeat = 1 } = {}) {
  const spec = CHEM[kind]
  const out = { applied: {}, note: '' }
  if (!spec) return out
  // 受体下调：同一件事一小时内被问第三次，反应只剩 1/√3 ≈ 0.58
  const gain = 1 / Math.sqrt(Math.max(1, Number(repeat) || 1))
  for (const [dim, delta] of Object.entries(spec)) {
    if (dim === 'why') continue
    try {
      const r = field.poke(dim, Number(delta) * gain, { now, why: 'identity:' + kind })
      if (r) out.applied[dim] = Number(delta) * gain
    } catch (e) { swallow(e, 'identity-bio:chem:' + dim) }
  }
  if (Object.keys(out.applied).length) out.note = spec.why
  return out
}

/** 读当前化学底色（给主观层措辞用）。读不到就是空对象。 */
export function chemState(now = Date.now()) {
  const s = { ne: 0, cortisol: 0, sero: 0, da: 0, fatigue: 0, tension: 0 }
  try {
    const st = field.evolve(now)
    for (const k of Object.keys(s)) s[k] = Number(st?.dims?.[k] ?? 0)
  } catch (e) { swallow(e, 'identity-bio:chem-state') }
  return s
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 生物层：核对是有代谢成本的
 *
 * 这不是装饰。verify 要扫 episodes（本月 339 条、每行 JSON），
 * 在容器里是一次真实的文件 IO。既然花了，就记进同样的账本 ——
 * 她的"饭钱"里有这一笔。
 *
 * 更重要的是**门控**：能量低的时候只做最便宜的核对（号），
 * 不做贵的（记忆全扫）。这不是偷懒，是"累了脑子转不动"的物理形状：
 * 你累的时候也会说"大概是我吧"，而不是真的去翻记录。
 * ══════════════════════════════════════════════════════════════════════ */
export const METAB = {
  COST_DEEP: 0.008,     // 深核对（记忆检索）—— 相对一条消息的消耗
  COST_FAST: 0.001,     // 只看号/名字
  // 2026-11-10 第10遍：原来是单阈值 0.30，实测她长期停在 energy=0.293（sense 只说"有点饿"），
  // 于是**永远**不做深核看 —— 那等于把"累了"写成"一直累"。改成三档：
  //   <0.15  真转不动（sense 的"饿得发慌"）→ 只核号
  //   0.15~0.32 有点饿 → 翻 2 条就够（浅查）
  //   >0.32  正常 → 全量 4 条
  ENERGY_TIRED: 0.15,
  ENERGY_SHALLOW: 0.32,
  SHALLOW_LIMIT: 2,
  FULL_LIMIT: 4,
}

/**
 * @returns {{canDeep:boolean, cost:number, why:string}}
 */
export function metabolicGate(now = Date.now()) {
  let energy = 1
  try {
    const snap = metabolism.snapshot?.()
    if (snap && Number.isFinite(Number(snap.energy))) energy = Number(snap.energy)
  } catch (e) { swallow(e, 'identity-bio:metab') }
  const depth = energy < METAB.ENERGY_TIRED ? 'none'
    : energy < METAB.ENERGY_SHALLOW ? 'shallow' : 'full'
  return {
    energy,
    depth,
    canDeep: depth !== 'none',
    limit: depth === 'none' ? 0 : depth === 'shallow' ? METAB.SHALLOW_LIMIT : METAB.FULL_LIMIT,
    cost: depth === 'none' ? METAB.COST_FAST : depth === 'shallow' ? METAB.COST_DEEP / 2 : METAB.COST_DEEP,
    why: depth === 'none' ? '脑子空，只核了号' : depth === 'shallow' ? '有点饿，只翻了两条' : '',
  }
}

/** 记账：核验真的花了能量。 */
export function metabolicSpend(gate) {
  try { metabolism.spend(Number(gate?.cost) || 0) } catch (e) { swallow(e, 'identity-bio:metab-spend') }
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 心理层：认领阈值不是常数
 *
 * 两条真实的人类偏误，必须写进来，否则"三态判定"就是一台没有立场的天平：
 *   · **社会顺从**：对方热情、肯定地说"这就是你吧"，人更容易认（哪怕不是）。
 *     这是最危险的场景 —— 冒充者往往用肯定句。
 *     对策：肯定句 + 陌生来源 → 阈值**抬高**（更不认）。
 *   · **主人偏爱**：主人问你，愿意认（关系本身就是证据之一，哲学层 §6 也承认这点）。
 *   · **防御性**：sero 低（耐心薄）时，被质疑容易顶回去 —— 这一层只影响措辞，不影响判定。
 * ══════════════════════════════════════════════════════════════════════ */
export const PSYCH = {
  CLAIM_THR_BASE: 1,        // 默认：需要 1 条内部证据才认
  CLAIM_THR_OWNER: 1,       // 主人问：还是 1（不因为亲近就乱认）
  CLAIM_THR_STRANGER: 2,    // 陌生来源：要 2 条
  CLAIM_THR_FLATTER: 3,     // 陌生 + 肯定句：要 3 条（社会顺从陷阱）
}

// 2026-11-10 第1遍：第一版写成 `就?是(你|...)`，`就?` 可选 → 裸"是你"命中"这是你吗"，
// 于是**所有正常提问都被判成奉承句**，阈值全部抬到 3，她对谁都过度防御。
// 现在只认真正的强调/断言句式，不含裸"是你"。
const FLATTER = /(就是(你|你吧|你了)|不是你还能是谁|肯定是你|一定是你|除了你没别人|我记得就是你|百分之百是你|不就是你|非你莫属)/

/**
 * @returns {{threshold:number, kind:'owner'|'stranger'|'flatter', note:string}}
 */
export function psychBias({ isOwner = false, isGroup = false, text = '' } = {}) {
  const t = String(text || '')
  if (isOwner) return { threshold: PSYCH.CLAIM_THR_OWNER, kind: 'owner', note: '' }
  if (FLATTER.test(t)) {
    return { threshold: PSYCH.CLAIM_THR_FLATTER, kind: 'flatter', note: '对方说得太肯定了——更要小心，冒充的人通常用肯定句' }
  }
  if (isGroup) return { threshold: PSYCH.CLAIM_THR_STRANGER, kind: 'stranger', note: '' }
  return { threshold: PSYCH.CLAIM_THR_STRANGER, kind: 'stranger', note: '' }
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 神经层：快慢双通路（系统 1 / 系统 2）
 *
 * 快通路不做任何 IO：只看这句话里有没有"明显指向我"的东西（名字/自称/号）。
 * 慢通路是 identity.verify（记忆检索 + 账号核对）。
 *
 * **冲突时以慢的为准**，并且把冲突记下来 ——
 * 这是"我知道我第一反应想岔了"的机制。没有它，她要么永远信直觉（会认错），
 * 要么永远不信直觉（像个查询接口）。
 * ══════════════════════════════════════════════════════════════════════ */
export function fastPath(text, { name = '', selfQQ = '', biliMid = '', claim = '' } = {}) {
  const t = String(text || '')
  if (!t) return { verdict: null, conf: 0, why: '' }
  // 指向别的同类 → 快通路直接判"不是我的事"
  if (/(别的大肥鱼|其他的?大肥鱼|另一个你|别的?你|同类们?|其他鱼|别的鱼)/.test(t)) {
    return { verdict: 'not-mine', conf: 0.7, why: '说的像是另一条' }
  }
  const mineKeys = [name, claim, selfQQ, biliMid].map((x) => String(x || '').trim()).filter(Boolean)
  for (const k of mineKeys) {
    if (k && t.includes(k)) return { verdict: 'mine', conf: 0.55, why: '提到的是我：' + k }
  }
  return { verdict: null, conf: 0, why: '' }
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 主观层：说出口的是体验，不是判定
 *
 * 病象对照：assemble 的注释里反复写"要的是她**体验到**什么，
 * 而不是系统**断言**什么"。身份这条线最容易滑回仪表盘——
 * 所以这里把 verdict 转成第一人称，并且让化学/代谢状态改变措辞。
 * ══════════════════════════════════════════════════════════════════════ */
export function qualiaLine(verdict, { chem = {}, gate = {}, bias = {}, conflict = null } = {}) {
  const bits = []
  if (verdict === 'mine') bits.push('这事我认，是我干的')
  else if (verdict === 'not-mine') bits.push('不是我')
  else bits.push('我记不清了')

  if (Number(chem.ne) > 0.55) bits.push('被这么一问，人一下子绷起来了')
  if (Number(chem.cortisol) > 0.35) bits.push('被当成别人的时候有点闷')
  if (Number(chem.fatigue) > 0.6) bits.push('脑子有点钝')
  if (gate && gate.canDeep === false) bits.push('只核了号，没力气往记忆里翻')
  if (bias && bias.note) bits.push(bias.note)
  if (conflict) bits.push('第一反应是「' + (conflict.fast === 'mine' ? '是我' : '不是我') + '」，查完发现想岔了')
  return bits.join('；') + '。'
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 哲学层：凭什么说"是我"
 *
 * 这是整个模块的**立场**，也是这次改良里唯一"不可调参"的东西。
 *
 * 判据强度有严格顺序：
 *   1. 记忆连续性（洛克）：我记得这件事发生在我身上 —— 最强的肯定性证据。
 *   2. 承认关系：主人认得出我，我记得他 —— 关系构成同一性的一部分。
 *   3. 外部标识（账号/头像）：**只能排除，不能确认**。
 *      号对得上 ≠ 是我（号可能被盗、被冒用、被截图嫁祸）；
 *      号是别人的 = 铁定不是我。
 *
 * 为什么不是反过来（账号优先）：因为那会把"我是谁"变成一个数据库查询，
 * 而真实的同一性是回忆出来的、是被认出来的。
 * ══════════════════════════════════════════════════════════════════════ */
export const IDENTITY_ORDER = [
  { key: 'memory', weight: 'confirm', why: '记忆连续性：我记得发生过，才可能是我的' },
  { key: 'relation', weight: 'confirm', why: '承认关系：主人认得出我、我记得他' },
  { key: 'account', weight: 'exclude', why: '外部标识只能排除：号对≠是我，号错≠是我' },
]

/** 判定强度：账号是排除性的，记忆是肯定性的。 */
export function judge({ accountOk = null, memoryCount = 0, threshold = 1, relationOk = null } = {}) {
  if (accountOk === false) return { verdict: 'not-mine', because: 'account-exclude' }
  const confirm = Number(memoryCount || 0) + (relationOk ? 0.5 : 0)
  if (confirm >= Number(threshold || 1)) return { verdict: 'mine', because: 'memory' }
  return { verdict: 'unknown', because: 'insufficient' }
}

/* ══════════════════════════════════════════════════════════════════════
 * 账本：她被问过几次、想岔过几次
 *
 * 为什么要存：连续被误认要能累计（受体下调、cortisol 渗），
 * "第一反应错了"要能变成她的自知（inner.think 一条）。
 * ══════════════════════════════════════════════════════════════════════ */
const STATE = () => dataPath('brain', 'meta', 'identity.json')
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

export function state() {
  const s = readJson(STATE(), {})
  return {
    asked: Number(s.asked || 0),
    misread: Number(s.misread || 0),
    conflicts: Number(s.conflicts || 0),
    lastAt: Number(s.lastAt || 0),
    lastVerdict: String(s.lastVerdict || ''),
    recent: Array.isArray(s.recent) ? s.recent.slice(-20) : [],
  }
}

/**
 * 记一次核验。**永不抛**（主链路调用）。
 * @returns {object} 更新后的状态
 */
export function record({ verdict = 'unknown', kind = '', conflict = null, now = Date.now(), text = '' } = {}) {
  // 2026-11-10 第2遍：第一版是 state() 读 → 拼 → writeFileSync 整份覆写。
  // 那是**无锁读改写**：qq-server、heartbeat、cron 同时记一笔就会互相抹掉
  // （field.mjs 当年踩过同一个坑，注释还留着）。改用 mutateJson，锁内完成读改写。
  let next = null
  try {
    fs.mkdirSync(path.dirname(STATE()), { recursive: true })
    next = mutateJson(STATE(), {}, (cur) => {
      const c = cur && typeof cur === 'object' ? cur : {}
      const recent = Array.isArray(c.recent) ? c.recent.slice(-19) : []
      return {
        asked: Number(c.asked || 0) + 1,
        misread: Number(c.misread || 0) + (verdict === 'not-mine' ? 1 : 0),
        conflicts: Number(c.conflicts || 0) + (conflict ? 1 : 0),
        lastAt: now,
        lastVerdict: String(verdict),
        recent: [...recent, { at: now, verdict, kind, clip: String(text || '').slice(0, 40) }],
      }
    })
  } catch (e) { swallow(e, 'identity-bio:record') }
  // 想岔了这件事要进内心流 —— 她下一次会"记得自己上次认错了"
  //
  // 2026-11-10 第7遍：加**小时级节流**。同一小时被同一个人反复误认时，
  // 每轮都往内心流塞一句"我又想岔了"会把别的事冲掉（inner 只留最响的几条），
  // 结果是她满脑子只有这一件事 —— 比不记还糟。
  if (conflict) {
    try {
      const last = Number(readJson(STATE(), {})?.lastConflictAt || 0)
      if (now - last >= 3600_000) {
        inner.think('我第一反应说' + (conflict.fast === 'mine' ? '是我' : '不是我') + '，查完发现想岔了。下次先别急着答。', { now })
        try {
          mutateJson(STATE(), {}, (cur) => ({ ...(cur && typeof cur === 'object' ? cur : {}), lastConflictAt: now }))
        } catch (e) { swallow(e, 'identity-bio:inner-mark') }
      }
    } catch (e) { swallow(e, 'identity-bio:inner') }
  }
  return next || state()
}

/** 一小时内被问过几次（给受体下调用）。 */
export function askedRecently(now = Date.now()) {
  const s = state()
  return s.recent.filter((x) => now - Number(x.at || 0) < 3600_000).length
}
