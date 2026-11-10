// identity 高压测试：并发丢更新 / 坏数据 / 时钟回拨 / 极端参数 / 性能 / 单层全挂
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ── 并发 worker 入口（必须在建临时目录之前：子进程沿用父进程的 BOT_DATA_DIR）──
if (process.argv.includes('--worker')) {
  if (!process.env.BOT_DATA_DIR) { console.error('worker 缺 BOT_DATA_DIR'); process.exit(2) }
  const BB = await import('../tools/brain/identity-bio.mjs')
  for (let i = 0; i < 25; i++) BB.record({ verdict: 'mine', now: Date.now() })
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-stress-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }
const now = Date.now()

const B = await import('../tools/brain/identity-bio.mjs')
const I = await import('../tools/brain/identity.mjs')
const field = await import('../tools/brain/field.mjs')

console.log('\n[并发：4 进程 × 25 次 record，一条都不能丢]')
{
  const before = B.state().asked
  const kids = []
  for (let i = 0; i < 4; i++) {
    kids.push(spawnSync(process.execPath, [import.meta.filename, '--worker'], { env: process.env, encoding: 'utf8', timeout: 60_000 }))
  }
  const failed = kids.filter((k) => k.status !== 0)
  const after = B.state().asked
  ok('4 个子进程全部正常退出', failed.length === 0, failed.map((k) => String(k.stderr || '').slice(0, 80)).join(' | '))
  ok('100 次写入全部记账（无丢更新）', after - before === 100, `${before} → ${after}，期望 +100`)
}

console.log('\n[坏数据：账本文件写成垃圾]')
{
  const f = path.join(tmp, 'brain', 'meta', 'identity.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '{ 这不是 JSON')
  ok('state() 不抛且给默认值', (() => { try { const s = B.state(); return s.asked === 0 && Array.isArray(s.recent) } catch { return false } })())
  ok('record() 能从坏文件恢复', (() => { try { B.record({ verdict: 'mine', now }); return B.state().asked >= 1 } catch { return false } })())
  fs.writeFileSync(f, '')
  ok('空文件也不炸', (() => { try { return B.state().asked === 0 } catch { return false } })())
}

console.log('\n[坏数据：化学场文件写成垃圾]')
{
  const f = path.join(tmp, 'brain', 'meta', 'field.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '###')
  ok('chemReact 不抛', (() => { try { B.chemReact('asked', { now }); return true } catch { return false } })())
  ok('chemState 不抛且数值有限', (() => { try { const c = B.chemState(now); return Object.values(c).every((v) => Number.isFinite(v)) } catch { return false } })())
}

console.log('\n[时钟回拨 / 极端参数]')
{
  const past = now - 30 * 86400_000
  ok('过去时间不炸', (() => { try { return !!B.record({ verdict: 'unknown', now: past }) } catch { return false } })())
  ok('未来时间不炸', (() => { try { return !!B.record({ verdict: 'unknown', now: now + 86400_000 }) } catch { return false } })())
  ok('askedRecently 不出负数', B.askedRecently(now) >= 0)
  ok('repeat=1e9 不产生 NaN', (() => {
    try {
      const before = Number(field.evolve(now)?.dims?.ne ?? 0)
      B.chemReact('asked', { now, repeat: 1e9 })
      const after = Number(field.evolve(now)?.dims?.ne ?? 0)
      return Number.isFinite(after) && Math.abs(after - before) < 0.001
    } catch { return false }
  })())
  ok('repeat=0 当 1 处理', (() => { try { B.chemReact('asked', { now, repeat: 0 }); return true } catch { return false } })())
  ok('judge 传 NaN 不炸', (() => { try { return !!B.judge({ memoryCount: NaN, threshold: NaN }) } catch { return false } })())
}

console.log('\n[输入边界]')
{
  const long = '是'.repeat(20000)
  ok('20k 字输入 fastPath 不炸', (() => { try { return B.fastPath(long, { name: '大肥鱼' }).verdict !== undefined } catch { return false } })())
  ok('null 输入不炸', (() => { try { return B.fastPath(null).verdict === null } catch { return false } })())
  ok('qualiaLine 空参不炸', (() => { try { return typeof B.qualiaLine() === 'string' } catch { return false } })())
  ok('psychBias 空参数默认 stranger', B.psychBias().threshold === 2)
}

console.log('\n[性能]')
{
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 500; i++) B.fastPath('这是你吗？我记得是你发的', { name: '大肥鱼', selfQQ: '1' })
  const fastMs = Number(process.hrtime.bigint() - t0) / 1e6
  ok('500 次快通路 < 100ms', fastMs < 100, fastMs.toFixed(1) + 'ms')

  const t1 = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) B.record({ verdict: 'unknown', now })
  const recMs = Number(process.hrtime.bigint() - t1) / 1e6
  ok('20 次记账 < 1500ms（带锁）', recMs < 1500, recMs.toFixed(1) + 'ms')
}

console.log('\n[单层全挂：核验不能整个消失]')
{
  // 记忆目录整个删掉 → recallOwn 必须返回空而不是抛
  fs.rmSync(path.join(tmp, 'brain', 'ep'), { recursive: true, force: true })
  ok('recallOwn 无记忆目录时返回空', (() => {
    try { const r = I.recallOwn('这是你吗', { platform: 'qq' }); return r.count === 0 && r.text === '' } catch { return false }
  })())

  const v = (() => { try { return I.verify('这是你吗', { platform: 'qq', chatId: 'qq:1', userId: '1', isGroup: false, isOwner: false }) } catch (e) { return { error: String(e) } } })()
  ok('verify 仍然返回结论（不抛）', v && !v.error && ['mine', 'not-mine', 'unknown'].includes(v.verdict), JSON.stringify(v).slice(0, 120))
  ok('verify 带体感（第一人称）', v && /体感：/.test(String(v.line || '')))
  ok('verify 的冲突字段是 null 或对象', v && (v.conflict === null || typeof v.conflict === 'object'))
}

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 高压测试全过')
process.exit(bad ? 1 : 0)
