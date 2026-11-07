// learn 高压测试 —— 第一遍：并发 / 极端输入 / 性能 / 只读目录
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-stress-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }
const noThrow = (n, fn) => { try { fn(); ok(n, true) } catch (e) { ok(n, false, String(e && e.message)) } }

const S = await import('../tools/brain/learn/strategies.mjs')
const L = await import('../tools/brain/learn/index.mjs')
const R = await import('../tools/brain/learn/rpe.mjs')
const now = Date.now()

// ── 1. 极端输入 ──────────────────────────────────────────────────────
console.log('\n[极端输入]')
noThrow('pick(null)', () => S.pick(null))
noThrow('pick({})', () => S.pick({}))
noThrow('baseScores 空对象', () => S.baseScores({}))
noThrow('observeIncoming 全空', () => S.observeIncoming({}))
noThrow('recordUsed 未知策略', () => S.recordUsed('qq:x', 'not-a-strategy'))
noThrow('lexiconBlock 空 chat', () => L.lexiconBlock({ chatId: '' }))
noThrow('observe 超长文本', () => L.observe({ chatId: 'qq:long', text: '摸鱼'.repeat(5000), now }))
noThrow('observe null percept', () => L.observe({ chatId: 'qq:x', percept: null, text: '你好', now }))
{
  const nan = R.reinforce({ w: 0.5, mean: 0, sens: 1, n: 0 }, NaN)
  ok('NaN 奖励不污染权重', Number.isFinite(nan.arm.w) && Number.isFinite(nan.arm.mean), JSON.stringify(nan.arm))
  const big = R.reinforce({ w: 0.99, mean: 0.99, sens: 1.2, n: 9 }, 5)
  ok('越界奖励被钳住', big.arm.w <= 0.95 && big.arm.mean <= 1, JSON.stringify(big.arm))
  const neg = R.reinforce({ w: 0.06, mean: -0.9, sens: 0.35, n: 9 }, -5)
  ok('下界不被击穿', neg.arm.w >= 0.05 && neg.arm.mean >= -1, JSON.stringify(neg.arm))
}

// ── 2. 时间边界 ──────────────────────────────────────────────────────
console.log('\n[时间]')
{
  S.recordUsed('qq:t', 'humor', now)
  const back = S.observeIncoming({ chatId: 'qq:t', percept: {}, now: now - 60_000 })
  ok('时钟回拨不崩', back === null || Number.isFinite(back.rpe), JSON.stringify(back))
  S.recordUsed('qq:t2', 'humor', now)
  const edge = S.observeIncoming({ chatId: 'qq:t2', percept: {}, now: now + 29 * 60_000 })
  ok('资格迹 29 分钟仍有效', edge !== null, JSON.stringify(edge))
  S.recordUsed('qq:t3', 'humor', now)
  const over = S.observeIncoming({ chatId: 'qq:t3', percept: {}, now: now + 31 * 60_000 })
  ok('31 分钟失效', over === null)
  const rec = R.recover({ sens: 0.4 }, 10000)
  ok('极大恢复时长不发散', Number.isFinite(rec.sens) && rec.sens <= 1.25, String(rec.sens))
}

// ── 3. 性能 ──────────────────────────────────────────────────────────
console.log('\n[性能]')
{
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 200; i++) S.pick({ percept: { primary: 'TOPIC' }, signal: {}, intero: { capacity: 0.7 }, base: 'altruism' })
  const dt = Number(process.hrtime.bigint() - t0) / 1e6
  ok('pick ×200 < 500ms', dt < 500, dt.toFixed(1) + 'ms')
  const t1 = process.hrtime.bigint()
  for (let i = 0; i < 100; i++) L.observe({ chatId: 'qq:perf', text: '今天摸鱼摸得爽', now })
  const dt2 = Number(process.hrtime.bigint() - t1) / 1e6
  ok('observe ×100 < 1500ms', dt2 < 1500, dt2.toFixed(1) + 'ms')
  const st = path.join(tmp, 'brain', 'learn', 'strategies.json')
  const size = fs.statSync(st).size
  ok('100 次更新后状态文件 < 8KB', size < 8192, size + 'B')
}

// ── 4. 并发（子进程）────────────────────────────────────────────────
console.log('\n[并发]')
{
  const script = `
    process.env.BOT_DATA_DIR = ${JSON.stringify(tmp)};
    process.env.HOME = ${JSON.stringify(tmp)};
    process.env.USERPROFILE = ${JSON.stringify(tmp)};
    process.env.DSH_HOME = ${JSON.stringify(path.join(tmp, '.dsh'))};
    const S = await import(${JSON.stringify(pathToFileURL(path.resolve('tools/brain/learn/strategies.mjs')).href)});
    const N = 25;
    for (let i = 0; i < N; i++) {
      S.recordUsed('qq:race', 'humor', Date.now());
      S.observeIncoming({ chatId: 'qq:race', percept: { emoji: { valence: 0.6 } }, continued: true, now: Date.now() });
    }
    process.exit(0);
  `
  const jobs = Array.from({ length: 8 }, () => new Promise((res) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
    p.on('exit', (code) => res(code))
  }))
  const codes = await Promise.all(jobs)
  ok('8 个子进程全部正常退出', codes.every((c) => c === 0), JSON.stringify(codes))
  const st = S.load()
  const n = st.arm.humor.n
  // 每个子进程 25 轮：recordUsed +1，成功结算再 +1 → 上限 2N，正常应 ≥ N
  const total = 8 * 25
  ok('并发后使用计数无明显丢失', n >= total, `n=${n} 期望≥${total}（上限 ${total * 2}）`)
}

// ── 5. 只读目录 ─────────────────────────────────────────────────────
console.log('\n[只读]')
{
  const dir = path.join(tmp, 'brain', 'learn')
  const before = fs.readFileSync(path.join(dir, 'strategies.json'), 'utf8')
  try { fs.chmodSync(dir, 0o555) } catch { /* root 可能无视 */ }
  let threw = false
  try { S.recordUsed('qq:ro', 'humor', Date.now()); S.pick({ percept: { primary: 'TOPIC' }, base: 'altruism' }) } catch { threw = true }
  try { fs.chmodSync(dir, 0o755) } catch { /* ignore */ }
  ok('目录只读时不抛', threw === false)
  ok('只读期间数据没被破坏', fs.readFileSync(path.join(dir, 'strategies.json'), 'utf8').length >= before.length * 0.5)
}

console.log(bad ? `\n❌ learn-stress：${bad} 条断言失败` : '\n✅ learn-stress：全部通过')
process.exit(bad ? 1 : 0)
