// metabolism —— 能量与消化（2026-11-03 · B3 仿生工程）
//
// 现象：零件都在但没连成闭环——binge 是进食、novelty 是食欲、REM 结算是消化，
//       但没有一条「血糖曲线」：没有地方回答「她的脑子现在还有多少电？
//       今天吃进去的东西消化了没有？」
// 生态位（别和现有维度撞）：
//   field.fatigue   管身体（短时恢复，聊久了乏）
//   field.sleepDebt 管睡眠债（长时，只增不减）
//   energy（本器官）管**认知资源**：想动脑的事消耗它，轻松的内容回充它，
//                   睡一觉回满；吃进去的信息不消化会积压。
// 生物学：进食-消化-供能。信息就是食物：
//   · 处理一条消息 = 消耗一小口（大脑占全身 20% 能耗，思考是烧糖的）
//   · binge 看完一集 = 进食（内容摄入，精神回充）**但要消化**——pendingDigest 积压
//   · REM = 消化时段：积压下降、消化产物回充能量（「学到了」）
//   · N3 = 修复时段：基础回充
//   · 清醒 = 净基础消耗（极慢，防止无限耗尽靠的是夜里回满）
// 措辞（M58 主观红线）：饿是第一人称的「脑子转不动」，积压是「脑子里堆着没消化的东西」。
import fs from 'node:fs'
import { dataPath } from '../../lib/paths.mjs'
import { swallow } from '../../lib/swallow.mjs'
import { updateJson, readJsonSafe } from '../../lib/atomic.mjs'
import * as sleepstage from './sleepstage.mjs'

const STATE_FILE = () => dataPath('metabolism.json')
// 每条消息的认知消耗。2026-11-08 从 0.004 下调到 0.0008：
//   实测一天 449 条消息 × 0.004 = 1.8 —— 血糖必被一拳打穿到 0，且她**从不看视频**（binge=0）
//   就没有任何回充路径，于是 field.sense() 每天都在说"脑子转不动了，饿得发慌"，
//   而那句话会进 system 当态度（历史上已经因为负面状态词污染过对话）。
//   0.0008 × 450 ≈ 0.36，和清醒基础代谢（16h ≈ 0.34）同量级，一觉 + 一两集能补回来。
// ══ 2026-11-08 第二次标定（第一次只改 SPEND 治了症状，收支仍然为负）════
// 实测（/tmp/_meta_sim.mjs：7 天，睡 01:00-08:00，450 条/天，无 binge）：
//   旧参数每天净 **-0.41** → 第 2 天见底，之后每天醒来只有 0.266，白天又归 0。
//   生产读数完全一致：{energy:0, messages:479, binges:0}，于是 sensory-gain
//   永远走 conserve（看视频只给 2 段/2 张），field.sense() 天天说"饿得发慌"。
// 根因不在消息消耗（那只是一半），而是**只有 N3 回充**：
//   清醒 15h ≈ -0.315、消息 450 条 ≈ -0.36，而 7h 睡眠里只有 N3(91min) 给 +0.227。
// 人类不是这么运转的：一整夜的 N1/N2/N3/REM 都在修复，N3 只是修得最多。
// 新口径（"不吃不喝的一天"收支持平，有 binge 才是盈余）：
//   清醒 17h ≈ -0.10，消息 450 条 ≈ -0.135；睡 7h ≈ +0.25 → 净 +0.015。
const SPEND_PER_MSG = 0.0003             // 450 条 ≈ -0.135
const EAT_PER_BINGE = 0.12    // 看完一集的进食回充
const DIGEST_PER_REM_MIN = 0.12          // REM 每分钟消化积压条数
const ENERGY_PER_DIGESTED = 0.01         // 每消化一条的回充（「学到了」）
const REST_PER_N3_MIN = 0.0018           // N3 每分钟修复（7h 睡眠中 N3≈91min → +0.164）
const AWAKE_BURN_PER_MIN = 0.00010       // 清醒基础代谢（17h ≈ 0.10）
/** 睡眠里每个阶段都在修复，N3 最多（见上面的标定推导）。 */
const SLEEP_RECHARGE_PER_MIN = { N1: 0.0001, N2: 0.00025, N3: REST_PER_N3_MIN, REM: 0.0004 }
const MAX_PENDING = 20

// ── 状态读写（2026-11-08 重写：不再用进程内缓存 + 整表覆盖）──────────────
// 旧实现的病：readState 有 10 秒进程内缓存，saveState 用 `() => s` 无条件覆盖。
// qq-server / 心跳 / nightwork 是**三个进程**，各自缓存 0.35 或 0（取决于谁先读），
// 于是"刚迁移到 0.35"会在几秒后被另一个进程的旧缓存值覆盖回去（实测 0.35 → 0.199 → 0）。
// 现在：所有写入走 updateJson 的锁内读-改-写，读也直接读盘（文件 < 300B，开销可忽略）。
const emptyState = () => ({
  energy: 1.0, pendingDigest: 0, lastTickAt: 0,
  stats: { messages: 0, binges: 0, digested: 0 },
})

function hydrateState(raw) {
  const s = { ...emptyState(), ...(raw || {}) }
  s.energy = Number(s.energy) || 0
  s.pendingDigest = Number(s.pendingDigest) || 0
  s.stats = { ...emptyState().stats, ...(s.stats || {}) }
  return s
}

function readState() {
  return hydrateState(readJsonSafe(STATE_FILE(), null))
}

/**
 * 锁内读-改-写。拿不到锁就放弃这次更新（宁可少记一条，也别覆盖别人的写入）。
 * @returns {object|null} 写入后的状态
 */
function mutateState(fn, opts = {}) {
  try {
    const r = updateJson(STATE_FILE(), (cur) => {
      const s = hydrateState(cur)
      fn(s)
      return s
    }, { fallback: null, waitMs: opts.waitMs ?? 1500 })
    return r?.ok ? hydrateState(r.value) : null
  } catch (e) { swallow(e, 'metabolism:mutate'); return null }
}

/** 认知消耗（消息处理时调——大脑思考是烧糖的）。 */
export function spend(x = SPEND_PER_MSG, now = Date.now()) {
  mutateState((s) => {
    s.energy = Math.max(0, s.energy - Number(x))
    s.stats.messages++
  })
}

/** 进食（binge 成功调）：精神回充 + 内容积压（要消化）。 */
export function eat(x = EAT_PER_BINGE, now = Date.now()) {
  mutateState((s) => {
    s.energy = Math.min(1, s.energy + Number(x))
    s.pendingDigest = Math.min(MAX_PENDING, s.pendingDigest + 1)
    s.stats.binges++
  })
}

/**
 * 心跳 tick：按睡眠分期驱动消化/修复/基础代谢。
 * @returns {{stage:string, energy:number, pending:number}|null}
 */
export function tick(now = Date.now()) {
  let out = null
  mutateState((s) => {
    const last = Number(s.lastTickAt || 0)
    s.lastTickAt = now
    if (!last || now <= last) return
    const dtMin = Math.min(60, (now - last) / 60_000)   // 防大步长跳变（重启/停机）
    if (dtMin < 0.1) return
    const st = sleepstage.currentStage(now)
    let stage = 'awake'
    if (st.stage === 'REM') {
      stage = 'REM'
      // 消化：积压下降 + 回充
      const digested = Math.min(s.pendingDigest, DIGEST_PER_REM_MIN * dtMin)
      if (digested > 0) {
        s.pendingDigest = Math.max(0, s.pendingDigest - digested)
        s.energy = Math.min(1, s.energy + digested * ENERGY_PER_DIGESTED)
        s.stats.digested += digested
      }
      // REM 同时也是修复时段（只是修的是情绪强度，不是结构）——见文件头。
      s.energy = Math.min(1, s.energy + (SLEEP_RECHARGE_PER_MIN.REM || 0) * dtMin)
    } else if (st.stage) {
      // 睡眠的每一个阶段都在修复（2026-11-08 修）：旧代码只给 N3 回充、
      // 浅睡还按 0.3 倍继续消耗 —— 7 小时睡眠净回充被压到 0.227，
      // 抵不过一天 -0.675，于是第 2 天起 energy 恒为 0。
      // N3 仍然修得最多（0.0018/min），N2 次之，N1 几乎不修。
      stage = st.stage
      const rate = SLEEP_RECHARGE_PER_MIN[st.stage] || 0
      s.energy = Math.min(1, s.energy + rate * dtMin)
    } else {
      s.energy = Math.max(0, s.energy - AWAKE_BURN_PER_MIN * dtMin)
    }
    out = { stage, energy: Number(s.energy.toFixed(3)), pending: Number(s.pendingDigest.toFixed(2)) }
  })
  return out
}

/** 身体感（field.sense 调，第一人称；永不抛错）。 */
export function sense() {
  try {
    const s = readState()
    const bits = []
    const e = Number(s.energy)
    if (e < 0.15) bits.push('脑子转不动了，饿得发慌')
    else if (e < 0.3) bits.push('有点饿了，想问题都费劲')
    else if (e < 0.5) bits.push('脑子有点空，想吃点什么轻松的')
    const p = Number(s.pendingDigest)
    if (p >= 8) bits.push('脑子里堆了一堆没消化的东西，胀')
    else if (p >= 3) bits.push('白天看的东西还没消化完，有点撑')
    return bits.join('；')
  } catch { return '' }
}

/**
 * 一次性标定迁移（2026-11-08）：把旧标定磨到 0 的电量拉回可用区间。
 *
 * 为什么需要它：这不是"给她补血"，是**旧参数算出来的 0 本身是错的**。
 * 旧口径下无 binge 的普通日程每天净 -0.41（实测 7 天模拟），第 2 天必然见底，
 * 之后一直显示 0 —— 她会永远说"饿得发慌"、永远走省电姿态看视频。
 * 修标定不会自动把历史欠账变回来（新参数下每天只 +0.015），所以给一次性迁移。
 *
 * 三条判据同时成立才动，避免掩盖真实的"她确实饿了"：
 *   · energy ≤ 0.02（已经见底）
 *   · stats.messages ≥ 100（长期运行，不是刚装）
 *   · 没有迁移过（幂等）
 */
export function recalibrate(now = Date.now(), { floor = 0.35, force = false } = {}) {
  let res = { changed: false, why: 'error' }
  mutateState((s) => {
    const st = s.stats
    if (st.recalibrated && !force) { res = { changed: false, why: 'already', energy: Number(s.energy) }; return }
    if (Number(s.energy) > 0.02 && !force) { res = { changed: false, why: 'not-empty', energy: Number(s.energy) }; return }
    if (Number(st.messages || 0) < 100 && !force) { res = { changed: false, why: 'too-new', energy: Number(s.energy) }; return }
    const before = Number(s.energy)
    s.energy = Math.max(before, Number(floor) || 0.35)
    s.lastTickAt = now
    st.recalibrated = '2026-11-08'
    res = { changed: true, before, energy: Number(s.energy), why: '标定修复（旧参数每天净 -0.41，见文件头推导）' }
  })
  return res
}

/** 面板/diagnose 全貌。 */
export function snapshot() {
  try {
    const s = readState()
    return {
      energy: Number(Number(s.energy).toFixed(3)),
      pendingDigest: Number(Number(s.pendingDigest).toFixed(2)),
      ...s.stats,
    }
  } catch { return null }
}

/** LLM 的代谢状态接口（2026-11-03）：血糖和消化状况怎么影响说话。
 *  energy 低 = 想问题费劲（回答变短变直）；pendingDigest 高 = 脑子里胀（不想接收新信息）。
 *  纯读（缓存内），永不抛错。 */
export function llmState() {
  try {
    const s = readState()
    const e = Number(s.energy), p = Number(s.pendingDigest) || 0
    const out = {}
    if (e < 0.2) out.temperature = -0.2
    else if (e < 0.35) out.temperature = -0.1
    if (e < 0.2) out.note = "脑子转不动了，硬要想的话会打结，别强迫自己说漂亮话"
    else if (e < 0.35) out.note = "有点饿了，不太想动脑子，说话想省力气"
    if (p >= 10) out.note = (out.note ? out.note + "；" : "") + "脑子里堆了好多没消化的东西，胀，别再往里塞新东西了"
    else if (p >= 5) out.note = (out.note ? out.note + "；" : "") + "白天看的东西还没消化完，有点撑"
    return Object.keys(out).length ? out : null
  } catch { return null }
}
