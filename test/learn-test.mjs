// learn（学习器官）测试 —— 2026-11-07
//
// 仿生学习的三条硬要求，每条都对应一个可能学坏的方向：
//   ① 学的是**预测误差**，不是奖励本身（一直好也不会无限膨胀）
//   ② 场景先验优先于学习（该认真时不会因为学过幽默就一直开玩笑）
//   ③ 有效但"不像她"的策略不该被采纳（哲学层 fits）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-learn-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }

const R = await import('../tools/brain/learn/rpe.mjs')
const S = await import('../tools/brain/learn/strategies.mjs')
const L = await import('../tools/brain/learn/index.mjs')

const now = Date.now()

console.log('\n[rpe 化学层]')
{
  const base = { w: 0.5, mean: 0, sens: 1, n: 0 }
  const good = R.reinforce(base, 0.8)
  ok('正奖励 → 权重上升', good.arm.w > base.w, `${base.w} → ${good.arm.w}`)
  ok('正奖励 → RPE 为正', good.rpe > 0, String(good.rpe))
  const badReward = R.reinforce(base, -0.8)
  ok('负奖励 → 权重下降', badReward.arm.w < base.w, `${base.w} → ${badReward.arm.w}`)
  // 耐受：连续同样奖励，增量越来越小
  let a = base, inc1 = 0, inc5 = 0
  for (let i = 0; i < 8; i++) {
    const before = a.w
    a = R.reinforce(a, 0.7).arm
    if (i === 0) inc1 = a.w - before
    if (i === 7) inc5 = a.w - before
  }
  ok('耐受：第 8 次增量小于第 1 次', inc5 < inc1, `${inc1.toFixed(4)} → ${inc5.toFixed(4)}`)
  ok('权重有界（≤0.95）', a.w <= 0.95, String(a.w))
  const h = R.habituate({ w: 0.5, mean: 0, sens: 1, n: 0 })
  ok('用过一次 → 敏感度下降', h.sens < 1, String(h.sens))
  const rec = R.recover({ sens: 0.4 }, 18)
  ok('18 小时 → 敏感度恢复过半', rec.sens > 0.5, String(rec.sens))
  ok('奖励公式：被夸 > 被骂', R.rewardOf({ praised: true }) > R.rewardOf({ scolded: true }))
}

console.log('\n[strategies 生物/哲学层]')
{
  const tease = S.baseScores({ percept: { primary: 'TEASE' }, signal: { eff: { ot: 0.4 } }, intero: { capacity: 0.7 } })
  ok('被逗 → 幽默先验最高', tease.humor >= Math.max(...Object.values(tease)), JSON.stringify(tease))
  const crit = S.baseScores({ percept: { primary: 'CRITIQUE' }, signal: {}, intero: {} })
  ok('被他挑错 → 合理化先验最高', crit.rationalization >= Math.max(...Object.values(crit)), JSON.stringify(crit))
  const task = S.baseScores({ percept: { primary: 'REQUEST', needsAction: true }, signal: { curiosity: 0.7, stressLoad: 0.2 }, intero: { capacity: 0.7 } })
  ok('给了具体的事 → 升华先验最高', task.sublimation >= Math.max(...Object.values(task)), JSON.stringify(task))

  // 无学习时：pick 应贴近 base
  const p0 = S.pick({ percept: { primary: 'TEASE' }, signal: {}, intero: { capacity: 0.7 }, base: 'humor' })
  ok('无学习 → 保持 base', p0 && p0.name === 'humor' && p0.switched === false, JSON.stringify(p0))

  // 学习：把 avoidance 拉到高权重，但在"被逗"的场景里不能翻盘（先验 3 分）
  for (let i = 0; i < 12; i++) S.observeIncoming({ chatId: 'qq:x', percept: null, continued: true, praised: true, now: now + i })
  S.recordUsed('qq:x', 'avoidance', now)
  // 用一次负反馈把 last 清掉，再单独强化 avoidance
  for (let i = 0; i < 10; i++) {
    S.recordUsed('qq:x', 'avoidance', now + i)
    S.observeIncoming({ chatId: 'qq:x', percept: { emoji: { valence: 0.9 } }, continued: true, praised: true, now: now + 100 + i })
  }
  const st = S.load()
  ok('avoidance 权重被强化', st.arm.avoidance.w > 0.5, String(st.arm.avoidance.w))
  const p1 = S.pick({ percept: { primary: 'TEASE' }, signal: {}, intero: { capacity: 0.7 }, base: 'humor' })
  ok('场景先验仍压过学习（被逗 → 幽默）', p1.name === 'humor', JSON.stringify(p1))
  // 在无强先验的场景（普通陈述）里，学习才有机会翻盘：
  // 先把 altruism 用连续负反馈压到地板，再看 pick 是否真的改选 avoidance。
  for (let i = 0; i < 14; i++) {
    S.recordUsed('qq:z', 'altruism', now + 200 + i)
    S.observeIncoming({ chatId: 'qq:z', percept: { emoji: { valence: -0.9 } }, continued: false, scolded: true, now: now + 201 + i })
  }
  const p2 = S.pick({ percept: { primary: 'TOPIC' }, signal: {}, intero: { capacity: 0.7 }, base: 'altruism' })
  // 期望：altruism 被负反馈压到地板后，弱场景不再默认选它；
  // 由"未被压低 + 高契合度"的策略接手（这里是 humor：默认权重 + fits 1.0）。
  ok('弱场景下学习改写选择（不再默认 altruism）', p2.name !== 'altruism' && p2.switched === true, JSON.stringify(p2))
}

console.log('\n[observe 结算]')
{
  S.recordUsed('qq:a', 'humor', now)
  const r = S.observeIncoming({ chatId: 'qq:a', percept: { emoji: { valence: 0.8 } }, continued: true, now: now + 5000 })
  ok('同一会话的下一条 → 结算上一轮', r && r.name === 'humor' && Number.isFinite(r.rpe), JSON.stringify(r))
  const r2 = S.observeIncoming({ chatId: 'qq:a', percept: { emoji: { valence: 0.8 } }, now: now + 6000 })
  ok('结算后 last 清空（不重复计分）', r2 === null, String(r2))
  S.recordUsed('qq:b', 'humor', now)
  const r3 = S.observeIncoming({ chatId: 'qq:c', percept: {}, now: now + 7000 })
  ok('跨会话不归因', r3 === null, String(r3))
  S.recordUsed('qq:b', 'humor', now)
  const r4 = S.observeIncoming({ chatId: 'qq:b', percept: {}, now: now + 31 * 60_000 })
  ok('隔 31 分钟不归因（资格迹过期）', r4 === null, String(r4))
}

console.log('\n[lexicon 只读语料]')
{
  const chat = 'qq:lex'
  for (let i = 0; i < 4; i++) L.observe({ chatId: chat, text: '大肥鱼今天又摸鱼了', now: now + i })
  const blk = L.lexiconBlock({ chatId: chat, now: now + 100 })
  ok('≥4 次的词出现在提示里', blk.includes('摸鱼') || blk.includes('大肥鱼'), blk)
  const other = L.lexiconBlock({ chatId: 'qq:other', now: now + 100 })
  ok('会话隔离（别的会话看不到）', other === '', JSON.stringify(other))
  const stop = L.observe({ chatId: chat, text: '今天今天今天', now: now + 200 })
  ok('停用词不进语料', stop.words === 0, String(stop.words))
}

console.log('\n[置信与迟滞]')
{
  // 这一段的断言要看"绝对证据量"，必须从干净状态开始（前面的段落会改同一份 json）
  fs.rmSync(path.join(tmp, 'brain', 'learn', 'strategies.json'), { force: true })
  // 系统性改造：证据置信（n/(n+4)）+ 按先验强度分档的迟滞
  ok('置信度 n=0 → 0', S.confidenceOf(0) === 0, String(S.confidenceOf(0)))
  ok('置信度 n=4 → 0.5', Math.abs(S.confidenceOf(4) - 0.5) < 1e-9, String(S.confidenceOf(4)))
  ok('置信度 n=20 → 20/24', Math.abs(S.confidenceOf(20) - 20 / 24) < 1e-9, String(S.confidenceOf(20)))
  ok('置信度单调', S.confidenceOf(1) < S.confidenceOf(5) && S.confidenceOf(5) < S.confidenceOf(50))

  const chat = 'qq:conf'
  const one = (() => {
    S.recordUsed(chat, 'humor', now)
    S.observeIncoming({ chatId: chat, percept: { emoji: { valence: 0.9 } }, continued: true, praised: true, now: now + 1000 })
    return S.pick({ percept: { primary: 'TOPIC' }, signal: {}, intero: {}, base: 'altruism' })
  })()
  ok('1 次夸奖不足以改写先验', one.name === 'altruism' && one.why !== 'evidence', JSON.stringify(one))

  for (let i = 0; i < 80; i++) {
    const t = now + 10000 + i * 60000
    S.recordUsed(chat, 'humor', t)
    S.observeIncoming({ chatId: chat, percept: { emoji: { valence: 0.9 } }, continued: true, praised: true, now: t + 30000 })
  }
  const many = S.pick({ percept: { primary: 'TOPIC' }, signal: {}, intero: {}, base: 'altruism' })
  ok('证据够多 → 改写（why=evidence）', many.name === 'humor' && many.why === 'evidence', JSON.stringify(many))

  // 强先验（他在挑错 → rationalization 3.5）需要 0.35 的证据优势
  const strong = S.pick({ percept: { primary: 'CRITIQUE' }, signal: {}, intero: { capacity: 0.7 }, base: 'rationalization' })
  ok('强先验场景不被历史偏好改写', strong.name === 'rationalization' && strong.why === 'prior', JSON.stringify(strong))
  ok('pick 会说明为什么没改', typeof (one.why || '') === 'string' && ['prior', 'hysteresis', 'evidence'].includes(one.why), String(one.why))
}

console.log('\n[归因与选择]')
{
  // 十遍第六遍：奖励误判与"越有效越不会被选"两个反向问题
  const P = await import('../tools/brain/cohere/percept.mjs')
  const rw = (text) => {
    S.recordUsed('qq:attr', 'humor', now)
    return L.observe({ chatId: 'qq:attr', percept: P.decode({ text, at: now }), text, now: now + 1000 })?.scored?.reward
  }
  ok('真提问"这是啥意思啊"不当作指责', Math.abs(rw('这是啥意思啊')) < 0.05, String(rw('这是啥意思啊')))
  ok('"我不喜欢"不算夸奖', Math.abs(rw('我不喜欢这个')) < 0.05, String(rw('我不喜欢这个')))
  ok('反问"这不对吗"不当作指责', Math.abs(rw('这不对吗')) < 0.05, String(rw('这不对吗')))
  ok('"你什么意思"仍是负面', rw('你什么意思') < -0.2, String(rw('你什么意思')))

  // 反复被强化的姿势必须能改写静态选择（旧版会因耐受输给没试过的策略）
  for (let i = 0; i < 120; i++) {
    const t = now + i * 60000
    S.recordUsed('qq:attr', 'humor', t)
    S.observeIncoming({ chatId: 'qq:attr', percept: { emoji: { valence: 0.9 } }, continued: true, praised: true, now: t + 30000 })
  }
  const sw = S.pick({ percept: { primary: 'TOPIC' }, signal: {}, intero: {}, base: 'altruism' })
  ok('被强化的姿势能改写选择', sw?.name === 'humor' && sw.switched === true, JSON.stringify(sw))
  const st = S.status()
  ok('未用过的姿势保持中性（0.5）', st.arms.find((a) => a.name === 'sublimation')?.w === 0.5, JSON.stringify(st.arms.find((a) => a.name === 'sublimation')))
}

console.log('\n[坏文件]')
{
  const dir = path.join(tmp, 'brain', 'learn')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'strategies.json'), '{broken')
  fs.writeFileSync(path.join(dir, 'lexicon.json'), 'nope')
  let threw = false
  try { S.pick({ percept: { primary: 'TOPIC' }, base: 'altruism' }); S.status(); L.lexiconBlock({ chatId: 'qq:x' }) } catch { threw = true }
  ok('坏状态文件不抛', threw === false)
  ok('坏文件后仍有可用默认臂', Object.keys(S.load().arm).length === 6, String(Object.keys(S.load().arm).length))
}

console.log(bad ? `\n❌ learn：${bad} 条断言失败` : '\n✅ learn：全部通过')
process.exit(bad ? 1 : 0)
