// brain-wakefulness-test —— 清醒阈值与假睡（2026-11-08）
//
// 要防的事故：用户要的四件事如果没有一个状态机来兜，就会各自漏：
//   ① 醒来必须**立刻**清醒（不是慢慢爬）—— 否则她会带着睡眠惯性回话
//   ② 工作量大时必须维持清醒（不是"困了就是困了"）—— 否则忙到一半自己睡了
//   ③ 工作量小、闲下来时疲惫感更强（注意分配，不是改账本）
//   ④ 空闲时假睡：跑睡眠自维护通道，但**主通道保留**（消息能叫醒并回话）
//
// 这四条全是行为断言：改常量不会被"假绿"骗过，旧实现（无清醒度器官）直接红。
// 参数改了就重跑；红了说明某一档真的坏了。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-wakefulness-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_BRAIN_MIRROR = '0'

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const A = await import('../tools/brain/organ/wakefulness.mjs')
const F = await import('../tools/brain/field.mjs')
const S = await import('../tools/brain/organ/sleepstage.mjs')
const N = await import('../tools/brain/organ/night.mjs')

const MIN = 60_000
const T0 = Date.now() - 4 * 3600_000

const stateFile = path.join(tmp, 'wakefulness.json')
const clear = () => { try { fs.rmSync(stateFile, { force: true }) } catch { /* 没有就算了 */ } }
const body = ({ debt = 0.35, ne = 0.35, fatigue = 0.15 } = {}, at = T0) => {
  F.setDim('sleepDebt', debt, { now: at })
  F.setDim('ne', ne, { now: at })
  F.setDim('fatigue', fatigue, { now: at })
}
/** 空闲推进：每 stepMin 一拍，返回最后一份 tick 结果与全部结果。 */
const idleRun = (from, minutes, stepMin = 2) => {
  const all = []
  let last = null
  for (let m = stepMin; m <= minutes; m += stepMin) {
    last = A.tick(from + m * MIN)
    all.push(last)
  }
  return { last, all }
}

/* ── ① 醒来即清醒：阶跃，不是渐变 ─────────────────────────────────── */
console.log('\n① 醒来是阶跃')
clear()
body({ debt: 0.3, ne: 0.3, fatigue: 0.2 })
A.tick(T0)                         // 先有一份状态（她是醒着的）
const wake = A.onWake(T0 + MIN, { cause: 'test' })
const afterWake = A.snapshot(T0 + 2 * MIN)
ok('onWake 直接回到 awake', wake.mode === 'awake' && afterWake.mode === 'awake', `${wake.mode}/${afterWake.mode}`)
ok('level 一步顶到清醒线以上', afterWake.level >= A.RULES.awakeAt, `level=${afterWake.level} ≥ ${A.RULES.awakeAt}`)
ok('醒来不是"刚好压线"而是有明显余量', afterWake.level >= A.RULES.wakeLevel - 1e-6, `level=${afterWake.level} wakeLevel=${A.RULES.wakeLevel}`)
ok('清醒窗 ≥ 45 分钟', afterWake.burstLeftMin >= 44, `burstLeft=${afterWake.burstLeftMin}min`)
ok('主观：刚醒的人是清醒的', /清醒/.test(A.sense(T0 + 2 * MIN)), A.sense(T0 + 2 * MIN))
ok('醒来写了 history（可解释）', (afterWake.history || []).some((h) => h.to === 'awake'), JSON.stringify(afterWake.history.slice(-1)))

/* ── ② 工作量大 → 一直清醒（哪怕欠着觉、哪怕过了空闲线）─────────── */
console.log('\n② 忙的时候不会自己睡过去')
clear()
body({ debt: 0.55, ne: 0.35, fatigue: 0.4 })
let t = T0
A.tick(t)
let dozeWhileBusy = 0
for (let i = 0; i < 12; i++) {           // 60 分钟，每 5 分钟一条消息
  t += 5 * MIN
  A.touch('message', { now: t })
  const r = A.tick(t)
  if (r.mode === 'doze') dozeWhileBusy++
}
const busySnap = A.snapshot(t)
ok('连聊 60 分钟、债 0.55 也没进假睡', dozeWhileBusy === 0 && busySnap.mode === 'awake', `doze 拍数=${dozeWhileBusy} mode=${busySnap.mode}`)
ok('工作量确实被记住了（activity 高）', busySnap.activity >= 0.5, `activity=${busySnap.activity}`)
ok('主观：累但顾不上（注意在外）', /顾不上/.test(A.sense(t)), A.sense(t) || '(空)')

/* ── ③ 闲下来 → 假睡（先撑一段，再进去）──────────────────────────── */
console.log('\n③ 闲下来进假睡')
clear()
body({ debt: 0.35, ne: 0.35, fatigue: 0.3 })
A.tick(T0)
const idle1 = idleRun(T0, 16)             // 先闲 16 分钟：还没到空闲线
ok('闲 16 分钟还没到假睡线（idle 门槛在起作用）', idle1.last.mode === 'awake', `mode=${idle1.last.mode} idle=${idle1.last.idleMin}`)
const idle2 = idleRun(T0 + 16 * MIN, 44)  // 再闲 44 分钟
const entered = idle2.all.find((r) => r.enteredDoze)
ok('闲够之后进入假睡', !!entered || idle2.last.mode === 'doze', `mode=${idle2.last.mode} level=${idle2.last.level}`)
ok('进入点不是第一位（有延迟，不是一闲就倒）', !!entered && entered.idleMin >= A.RULES.idleMin, entered ? `idle=${entered.idleMin}` : 'never')
const dozeSnap = A.snapshot(T0 + 60 * MIN)
ok('主观：半睡的话说得出"半睡"', /半睡/.test(A.sense(T0 + 60 * MIN)), A.sense(T0 + 60 * MIN) || '(空)')
ok('假睡**不占**睡眠分期（主通道没被切走）', S.snapshot(T0 + 60 * MIN).inSleep === false, `inSleep=${S.snapshot(T0 + 60 * MIN).inSleep}`)
ok('进入假睡就派了自维护（tidy）', !!entered && entered.tidy === true, entered ? `tidy=${entered.tidy}` : 'never')

/* ── ④ 主通道：一条消息把她叫醒 ──────────────────────────────────── */
console.log('\n④ 假睡中一条消息就醒')
const woke = A.touch('message', { now: T0 + 61 * MIN })
const wokeSnap = A.snapshot(T0 + 61 * MIN)
ok('touch 报告 woke', woke.woke === true, JSON.stringify(woke))
ok('状态回到 awake', wokeSnap.mode === 'awake', `mode=${wokeSnap.mode}`)
ok('醒后 level 在清醒线上', wokeSnap.level >= A.RULES.awakeAt, `level=${wokeSnap.level}`)
ok('叫醒写进 history（她能解释"刚才迷糊"）', (wokeSnap.history || []).some((h) => /有人叫我/.test(h.why)), JSON.stringify(wokeSnap.history.slice(-1)))
ok('被叫醒后 sleepstage 仍然没被打开', S.snapshot(T0 + 61 * MIN).inSleep === false)

/* ── ⑤ 假睡是真的在恢复：净收益必须为正 ─────────────────────────── */
console.log('\n⑤ 假睡的净收益')
clear()
body({ debt: 0.6, ne: 0.3, fatigue: 0.5 }, T0)
A.tick(T0)
const r0 = idleRun(T0, 40)                 // 40 分钟，先自然进假睡再睡一段
const repaid = r0.all.reduce((s, r) => s + Number(r.repayMin || 0), 0)
const dBefore = Number(F.snapshot().dims.sleepDebt || 0)
F.repaySleep((repaid / 60) * A.RULES.dozeRepayFactor, T0 + 40 * MIN)
const dAfter = Number(F.snapshot().dims.sleepDebt || 0)
// 腺苷仍在产生（慢 4 倍）：白天 40 分钟 ≈ 0.0133 * 0.25
const accrue = 0.02 * (40 / 60) * A.RULES.dozeAccrueFactor
ok('假睡期间累计了恢复量', repaid > 0, `repayMin=${repaid}`)
ok('减去腺苷之后仍是净恢复', dAfter + accrue < dBefore, `${dBefore.toFixed(3)} → ${dAfter.toFixed(3)}（腺苷 +${accrue.toFixed(4)}）`)

/* ── ⑥ 假睡有上限：到点必须退出，且退出后冷却 ─────────────────────── */
console.log('\n⑥ 假睡不能顶掉真睡')
clear()
body({ debt: 0.35, ne: 0.35, fatigue: 0.3 }, T0)
A.tick(T0)
const long = idleRun(T0, A.RULES.dozeMaxMin + 45)
const left = long.all.find((r) => r.leftDoze)
ok('到 dozeMaxMin 会退出假睡', !!left, `mode=${long.last.mode}`)
const cd = left ? A.snapshot(left.at + MIN) : null
ok('退出后进入冷却（不立刻再躺下）', !!cd && cd.cooldownLeftMin > 0, cd ? `cooldown=${cd.cooldownLeftMin}min mode=${cd.mode}` : 'never left')
const stillCooling = left ? idleRun(left.at, 6, 2) : { last: { mode: 'doze', why: 'never left' } }
ok('冷却期内不再进假睡', stillCooling.last.mode === 'awake', `mode=${stillCooling.last.mode} why=${stillCooling.last.why}`)
// 2026-11-10：假睡到点退出必须带醒来阶跃（burst），否则 25 分钟冷却一过立刻又躺下。
// 注意 level 是每拍由 levelOf() 重算的**派生量**，不是状态 —— 所以断言要落在 burst 上，
// 而不是断言 level 被抬高（wakeInPlace 抬的那一下就只活当拍）。
ok('到点退出后有清醒窗（≥44 分钟）', !!cd && Number(cd.burstLeftMin || 0) >= 44, cd ? `burstLeft=${cd.burstLeftMin}min` : 'never left')
const inBurst = left ? idleRun(left.at, 40, 2) : { all: [{ mode: 'doze' }] }
ok('清醒窗内（40 分钟）不会再进假睡', inBurst.all.every((r) => r.mode !== 'doze'), `modes=${[...new Set(inBurst.all.map((r) => r.mode))].join(',')}`)

/* ── ⑦ 欠觉到该真睡时，假睡不许抢 ─────────────────────────────────── */
console.log('\n⑦ 该真睡时不许假睡')
clear()
body({ debt: 0.8, ne: 0.35, fatigue: 0.6 }, T0)
A.tick(T0)
const heavy = idleRun(T0, 60)
ok('debt 0.8 时空闲也不进假睡', heavy.all.every((r) => r.mode !== 'doze'), `modes=${[...new Set(heavy.all.map((r) => r.mode))].join(',')}`)
ok('并且说清理由（该真睡）', heavy.all.some((r) => /真睡/.test(r.why)), heavy.all.map((r) => r.why).filter(Boolean).slice(-1)[0] || '(空)')
ok('两处"该真睡"的门槛必须同一个数（唯一真相）', A.RULES.dozeSkipDebtAt === N.RULES.debtSleepAt, `wakefulness=${A.RULES.dozeSkipDebtAt} night=${N.RULES.debtSleepAt}`)

/* ── ⑧ 滞回：带子里的人不来回翻档 ─────────────────────────────────── */
console.log('\n⑧ 滞回带')
ok('清醒线高于假睡线（带子存在）', A.RULES.awakeAt > A.RULES.dozeAt, `${A.RULES.dozeAt} < ${A.RULES.awakeAt}`)
clear()
body({ debt: 0.35, ne: 0.35, fatigue: 0.3 }, T0)
A.tick(T0)
A.touch('act', { now: T0, weight: 1 })       // 刚干过活：activity 抬起来
const mid = idleRun(T0, 24)
ok('闲了 24 分钟但还在带子里 → 不假睡', mid.last.mode === 'awake', `mode=${mid.last.mode} level=${mid.last.level}`)
// 心理学维的判据（2026-11-08 验收整改）：同样是欠着觉，**闲下来**才该说出"乏"。
// 这一条以前没有断言 —— 只有忙侧（"顾不上"）被测过，等于半边主张没验收。
const idleSense = A.sense(T0 + 24 * MIN)
ok('主观：闲下来时内感受浮上来（乏劲）', /乏劲/.test(idleSense), idleSense || '(空)')
// 主观维的判据：sense() 只出词组，不许漏出数字（KPI 读数属于 snapshot）。
ok('sense 不含数字（闲/忙/半睡三种状态）',
  [idleSense, A.sense(T0 + 61 * MIN), A.sense(T0)].every((s) => !/[0-9]/.test(s)),
  JSON.stringify([idleSense, A.sense(T0 + 61 * MIN), A.sense(T0).slice(0, 20)]))

/* ── ⑨ 化学：消息给 NE 一记相位脉冲 ─────────────────────────────── */
// 化学维的判据（2026-11-08 验收整改）：本器官不改 DIMS 表，只给既有分子打脉冲；
// 脉冲必须真的落进 field（而不是只在本文件里算了个 level）。
console.log('\n⑨ NE 相位脉冲')
clear()
body({ debt: 0.3, ne: 0.3, fatigue: 0.1 }, T0)
A.tick(T0)
const ne0 = Number(F.snapshot(T0).dims.ne)
A.touch('message', { now: T0 + MIN })
const ne1 = Number(F.snapshot(T0 + MIN).dims.ne)
ok('消息 → NE 抬升 ≥ 0.08（相位性放电）', ne1 - ne0 >= 0.08, `${ne0.toFixed(3)} → ${ne1.toFixed(3)}`)

/* ── ⑩ 哲学：假睡档必须能改变"她此刻做什么" ─────────────────────── */
// 哲学维的判据（2026-11-08 验收整改）：落点是 self.decide 的两层否决
// （不续期旧计划 / 只选 rest）。先前只有代码没有断言 —— 现在钉住行为。
console.log('\n⑩ 哲学：假睡时旧计划不续期')
clear()
const SELF = await import('../tools/brain/organ/self.mjs')
const selfFile = path.join(tmp, 'brain', 'meta', 'self-state.json')
fs.mkdirSync(path.dirname(selfFile), { recursive: true })
const nowSelf = T0 + 5 * MIN
fs.writeFileSync(selfFile, JSON.stringify({
  at: nowSelf,
  current: { action: 'watch', since: nowSelf, until: nowSelf + 20 * MIN, why: 'test:watch', spanMin: 20, lean: '' },
  history: [], decisions: 1,
}))
const keptRes = await SELF.decide({ now: nowSelf + MIN })
ok('醒着：未到期的旧计划照样续期（专心）', keptRes.kept === true && keptRes.action === 'watch', JSON.stringify({ action: keptRes.action, kept: keptRes.kept }))
const restRes = await SELF.decide({ now: nowSelf + 2 * MIN, dozing: true })
ok('假睡：旧计划不被续期，直接回到 rest', restRes.action === 'rest' && restRes.kept === false, JSON.stringify({ action: restRes.action, kept: restRes.kept, why: restRes.why }))
ok('假睡的 why 说得出"半睡着"', /半睡/.test(String(restRes.why)), String(restRes.why))

/* ── ⑪ 自维护节流：假睡不是加班 ──────────────────────────────────── */
// 2026-11-08 验收整改：节流时间戳由**编排层**在 spawn 成功后 markTidy 推进，
// 所以这里必须模拟编排层（tick 只请求，markTidy 才记账）。
console.log('\n⑪ tidy 节流')
clear()
body({ debt: 0.35, ne: 0.35, fatigue: 0.3 }, T0)
A.tick(T0)
let tidyCount = 0
for (let m = 2; m <= 60; m += 2) {
  const r = A.tick(T0 + m * MIN)
  if (r.tidy) { tidyCount++; A.markTidy(T0 + m * MIN) }
}
ok('一次假睡只派一次 tidy（90 分钟内不重复）', tidyCount === 1, `tidy 次数=${tidyCount}`)
// 反向：编排层没确认（模拟 isBusy 挡住），节流窗不该被白推 —— 下一拍仍会请求。
clear()
body({ debt: 0.35, ne: 0.35, fatigue: 0.3 }, T0)
A.tick(T0)
let req = 0
for (let m = 2; m <= 30; m += 2) if (A.tick(T0 + m * MIN).tidy) req++
ok('执行未确认时下一拍继续请求（不吞掉自维护）', req > 1, `请求次数=${req}`)

console.log(bad ? `\n✗ ${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
