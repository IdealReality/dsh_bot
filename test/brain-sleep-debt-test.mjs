// brain-sleep-debt-test —— 睡眠债"还得够不够"（2026-11-08）
//
// 要防的事故：用户观察到「大肥鱼一直表达的都非常累」。
//   · 清醒累积：白天 0.02/h，深夜 23~6 点 0.05/h → 典型一天欠 0.69
//   · 真睡一次最多 effectiveH = 6.84h（480min × 0.855）
//   · 旧还债常量 9.4h ⇒ 一夜只清掉当前值的 48%，而 sleepDebt 上限是 1.0
//   → 不动点「醒来 0.48 / 睡前 1.0」，永远踩在 sense() 的 0.45 阈值之上，
//     于是每一轮 system prompt 的身体感都是「感觉缺觉，脑子发钝。」
//
// 这套测试盯三件事（都是行为，不读常量，改参数也不会假绿）：
//   ① 一夜睡完必须真的清干净（任何起点都 ≤0.15）
//   ② 一个正常长度的白天不该把她推到"缺觉"
//   ③ 真熬到二十小时以上**必须**还判得出困（防调过头，把"困"整个阉掉）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-sleepdebt-'))
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

const F = await import('../tools/brain/field.mjs')

const H = 3600_000
const EFFECTIVE_NIGHT_H = 6.84          // sleepstage: 480min × 0.855 效率
const TIRED = 0.45                      // field.sense()「缺觉，脑子发钝」的阈值
const debt = () => Number(F.snapshot().dims.sleepDebt || 0)

/** 按 organ/heartbeat.accrueSleepDebt 的速率，从 startMs 起清醒 hours 小时。 */
function awake(startMs, hours) {
  for (let i = 0; i < hours; i++) {
    const t = startMs + i * H
    const h = new Date(t).getHours()
    const rate = (h >= 0 && h < 6) || h >= 23 ? 0.05 : 0.02
    F.poke('sleepDebt', rate, { why: 'test:awake', now: t })
  }
  return startMs + hours * H
}

const setDebt = (v) => F.setDim('sleepDebt', v)

/* ── ① 一夜睡完真的清干净 ───────────────────────────────────────── */
const base = Date.now() - 12 * H
console.log('\n① 一夜（' + EFFECTIVE_NIGHT_H + 'h）之后还剩多少')
for (const start of [0.5, 0.92, 1]) {
  setDebt(start)
  F.repaySleep(EFFECTIVE_NIGHT_H, base)
  const after = debt()
  ok(`起点 ${start} → 醒来 ${after.toFixed(3)} ≤ 0.15`, after <= 0.15, `after=${after.toFixed(3)}`)
}

/* ── ② 稳态：醒来 → 正常白天 → 睡，连续 5 轮不该越滚越困 ─────────── */
console.log('\n② 稳态 5 轮（08:00 醒 → 14h 白天 → 睡 8h）')
setDebt(0.1)
let worstWake = 0
let worstAwake = 0
for (let cycle = 0; cycle < 5; cycle++) {
  const wokeAt = new Date()
  wokeAt.setHours(8, 0, 0, 0)
  const at = awake(wokeAt.getTime() + cycle * 24 * H, 14)
  worstAwake = Math.max(worstAwake, debt())
  F.repaySleep(EFFECTIVE_NIGHT_H, at)
  worstWake = Math.max(worstWake, debt())
}
ok('每轮醒来都在 0.15 以下', worstWake <= 0.15, `worstWake=${worstWake.toFixed(3)}`)
ok('14h 正常白天不会到「缺觉」', worstAwake < TIRED, `worstAwake=${worstAwake.toFixed(3)}`)
ok('连续 5 轮不往上爬', worstWake <= 0.15 && worstAwake < TIRED)

/* ── ③ 真熬夜必须还判得出困 ─────────────────────────────────────── */
console.log('\n③ 连熬 20h（08:00 → 次日 04:00）')
setDebt(0.1)
const at3 = awake(new Date(new Date().setHours(8, 0, 0, 0)).getTime(), 20)
ok('熬 20h 后越过「缺觉」线', debt() > TIRED, `debt=${debt().toFixed(3)}`)
const senseLong = String(F.sense())
ok('sense() 这时说缺觉', /缺觉/.test(senseLong), senseLong)

/* ── ④ 睡完之后 sense() 不该还挂着"缺觉" ─────────────────────────── */
setDebt(0.95)
F.repaySleep(EFFECTIVE_NIGHT_H, base + 30 * H)
const senseRested = String(F.sense())
ok('睡醒后 sense() 不再说缺觉', !/缺觉/.test(senseRested), senseRested)
ok('睡醒后是正面档（清爽/轻的）', /清爽|轻的/.test(senseRested), senseRested)

/* ── ⑤ 读表达读数不许偷偷改写节律状态 ───────────────────────────── */
// 同一个任务里查出来的第二个静默 bug：spinal.spinalState() 原来调 rhythm.asleep(now)
// 当谓词用 —— 那是**写操作**（记一次入睡）。于是每读一次表达读数就追加一条假 sleep，
// 把 lastSleep 重置成 now，真醒来时 awake() 算出"睡了 0.01 小时"。
console.log('\n⑤ spinalState 必须是纯读')
const P = await import('../tools/brain/paths.mjs')
const rhythm = await import('../tools/brain/rhythm.mjs')
const sleepstage = await import('../tools/brain/organ/sleepstage.mjs')
const spinal = await import('../tools/brain/spinal.mjs')

rhythm.asleep(base)
const r0 = fs.readFileSync(P.rhythmPath(), 'utf8')
spinal.spinalState({ now: base + 60_000 })
const r1 = fs.readFileSync(P.rhythmPath(), 'utf8')
ok('spinalState 不改写 rhythm.json', r0 === r1, r0 === r1 ? '' : 'lastSleep/history 被改写')

// 真睡着时它要能读到（旧写法 `asleep(now) === true` 恒为 false，这条永远不触发）
sleepstage.sleep(base + 2 * H)
const sp = spinal.spinalState({ now: base + 3 * H })
ok('真睡着时 spinal 报半梦半醒', /半梦半醒/.test(String(sp.note)), sp.note || '(空)')

console.log(bad ? `\n✗ ${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
