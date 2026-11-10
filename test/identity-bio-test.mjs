// identity-bio 六层单元测试（不联网、不碰真实数据）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-bio-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }

const B = await import('../tools/brain/identity-bio.mjs')
const field = await import('../tools/brain/field.mjs')
const now = Date.now()

console.log('\n[① 化学层]')
{
  const before = Number(field.evolve(now)?.dims?.ne ?? 0)
  const r = B.chemReact('asked', { now })
  const after = Number(field.evolve(now)?.dims?.ne ?? 0)
  ok('被问身份 → 去甲上升', after > before, `${before.toFixed(3)} → ${after.toFixed(3)}`)
  ok('返回值带 why', r.note === '被问身份', JSON.stringify(r.applied))

  // 受体下调：同一件事第三次只剩 1/√3
  const before2 = Number(field.evolve(now)?.dims?.ne ?? 0)
  B.chemReact('asked', { now, repeat: 3 })
  const after2 = Number(field.evolve(now)?.dims?.ne ?? 0)
  const gain = (after2 - before2) / 0.04
  ok('重复被问 → 增益按 1/√n 衰减', Math.abs(gain - 1 / Math.sqrt(3)) < 0.05, `gain=${gain.toFixed(3)}`)

  const c0 = Number(field.evolve(now)?.dims?.cortisol ?? 0)
  B.chemReact('misread', { now })
  ok('被误认 → 皮质醇上升', Number(field.evolve(now)?.dims?.cortisol ?? 0) > c0)
  ok('未知事件不炸', (() => { try { B.chemReact('nope'); return true } catch { return false } })())

  const cs = B.chemState(now)
  ok('chemState 七个量齐全', ['ne', 'cortisol', 'sero', 'da', 'fatigue', 'tension'].every((k) => Number.isFinite(cs[k])))
}

console.log('\n[② 生物层]')
{
  const g = B.metabolicGate(now)
  ok('门控返回 canDeep/cost', typeof g.canDeep === 'boolean' && g.cost > 0, JSON.stringify(g))
  ok('能量足时做深核对', g.canDeep === true, `cost=${g.cost}`)
  ok('记账不抛', (() => { try { B.metabolicSpend(g); return true } catch { return false } })())
  ok('记账空参也不抛', (() => { try { B.metabolicSpend(null); return true } catch { return false } })())

  // 三档门控（2026-11-10 第10遍）：单阈值会把"有点饿"写成"一直累"
  const mf = path.join(tmp, 'metabolism.json')
  const setE = (e) => { fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.writeFileSync(mf, JSON.stringify({ energy: e, pendingDigest: 0, lastTickAt: 0 })) }
  setE(0.10); const g1 = B.metabolicGate(now)
  setE(0.25); const g2 = B.metabolicGate(now)
  setE(0.90); const g3 = B.metabolicGate(now)
  ok('energy 0.10 → 只核号（none）', g1.depth === 'none' && g1.canDeep === false && g1.limit === 0, JSON.stringify(g1))
  ok('energy 0.25 → 浅查（shallow, 2 条）', g2.depth === 'shallow' && g2.canDeep === true && g2.limit === 2, JSON.stringify(g2))
  ok('energy 0.90 → 全量（full, 4 条）', g3.depth === 'full' && g3.limit === 4, JSON.stringify(g3))
  ok('三档成本递增', g1.cost < g2.cost && g2.cost <= g3.cost, `${g1.cost} / ${g2.cost} / ${g3.cost}`)
}

console.log('\n[③ 心理层]')
{
  const a = B.psychBias({ isOwner: true, text: '这是你吗' })
  const b = B.psychBias({ isOwner: false, isGroup: false, text: '这是你吗' })
  const c = B.psychBias({ isOwner: false, text: '就是你吧！肯定是你' })
  const d = B.psychBias({ isOwner: false, isGroup: true, text: '这是你吗' })
  ok('主人问 → 阈值 1', a.threshold === 1, JSON.stringify(a))
  ok('陌生人问 → 阈值 2', b.threshold === 2, JSON.stringify(b))
  ok('陌生人肯定句 → 阈值 3（社会顺从陷阱）', c.threshold === 3, JSON.stringify(c))
  ok('肯定句会带提醒', /冒充/.test(c.note))
  ok('群聊 → 阈值 2', d.threshold === 2)
}

console.log('\n[④ 神经层]')
{
  const f1 = B.fastPath('别的大肥鱼也在B站吗', { name: '大肥鱼' })
  const f2 = B.fastPath('大肥鱼你回来了', { name: '大肥鱼' })
  const f3 = B.fastPath('今天吃什么', { name: '大肥鱼' })
  const f4 = B.fastPath('这号 2516074295 是谁', { selfQQ: '2516074295' })
  ok('指向别的同类 → 快判不是我的事', f1.verdict === 'not-mine', JSON.stringify(f1))
  ok('提到我的名字 → 快判像我的', f2.verdict === 'mine', JSON.stringify(f2))
  ok('无关的话 → 快通路不下结论', f3.verdict === null, JSON.stringify(f3))
  ok('提到我的号 → 快判像我的', f4.verdict === 'mine')
  ok('空输入不炸', B.fastPath('').verdict === null)
  ok('空配置不炸', (() => { try { B.fastPath('随便说', {}); return true } catch { return false } })())
}

console.log('\n[⑤ 主观层]')
{
  const q1 = B.qualiaLine('not-mine', { chem: {}, gate: { canDeep: true }, bias: {}, conflict: null })
  const q2 = B.qualiaLine('unknown', { chem: { fatigue: 0.8 }, gate: { canDeep: false }, bias: {}, conflict: null })
  const q3 = B.qualiaLine('mine', { chem: { ne: 0.7 }, gate: { canDeep: true }, bias: {}, conflict: { fast: 'not-mine', slow: 'mine' } })
  ok('不是我的事 → 第一人称否认', /不是我/.test(q1))
  ok('累的时候说出"脑子钝/没力气"', /脑子有点钝|只核了号/.test(q2), q2)
  ok('冲突时说"第一反应想岔了"', /第一反应/.test(q3), q3)
  ok('不出现判定词（not-mine）', !/not-mine|unknown/.test(q1 + q2 + q3))
}

console.log('\n[⑥ 哲学层]')
{
  ok('账号明确是别人的 → 排除性否定', B.judge({ accountOk: false, memoryCount: 5 }).verdict === 'not-mine')
  ok('账号对得上 ≠ 是我（不能确认）', B.judge({ accountOk: true, memoryCount: 0, threshold: 1 }).verdict === 'unknown')
  ok('记忆有 1 条 → 认', B.judge({ accountOk: null, memoryCount: 1, threshold: 1 }).verdict === 'mine')
  ok('阈值 3 时 2 条不够', B.judge({ memoryCount: 2, threshold: 3 }).verdict === 'unknown')
  ok('主人关系算半条', B.judge({ memoryCount: 1, threshold: 1, relationOk: true }).verdict === 'mine')
  ok('判据顺序：账号只排除', B.IDENTITY_ORDER.find((x) => x.key === 'account').weight === 'exclude')
  ok('判据顺序：记忆是确认', B.IDENTITY_ORDER.find((x) => x.key === 'memory').weight === 'confirm')
}

console.log('\n[账本]')
{
  const s0 = B.state()
  B.record({ verdict: 'unknown', kind: 'doubt', now })
  const s1 = B.state()
  ok('asked 自增', s1.asked === s0.asked + 1, `${s0.asked} → ${s1.asked}`)
  ok('recent 有记录', s1.recent.length > 0)
  ok('recent 上限 20', (() => { for (let i = 0; i < 30; i++) B.record({ verdict: 'mine', now }); return B.state().recent.length <= 20 })())
  ok('conflict 计数', (() => { const b = B.state().conflicts; B.record({ verdict: 'mine', conflict: { fast: 'not-mine', slow: 'mine' }, now }); return B.state().conflicts === b + 1 })())
  ok('askedRecently 有界', (() => { const n = B.askedRecently(now); return n >= 0 && n <= 60 })())
}

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ identity-bio 六层全过')
process.exit(bad ? 1 : 0)
