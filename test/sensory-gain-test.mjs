// sensory-gain 的细胞→组织回归（2026-11-08）。
//
// 这个组织只做一件事：把已有器官的读数翻译成看片参数。测试要钉的是
// **翻译规则本身**和**两条安全边界**：
//   ① 显式参数永远赢（手动/测试不能被情绪悄悄改）；
//   ② 器官读不到 → 回 normal，不许抛错、不许把视频看成"不可用"。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-gain-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* ignore */ } })

const ROOT = path.resolve(import.meta.dirname, '..')
const { sensoryGain, applyGain, PROFILES } = await import('file:///' + path.join(ROOT, 'tools/lib/sensory-gain.mjs').replace(/\\/g, '/'))

const results = []
async function ok(name, fn) {
  try { await fn(); results.push([true, name]) } catch (e) { results.push([false, name, e.message]) }
}

await ok('省电：脑力见底或血糖低 → 2Hz / 2 段 / 2 张', async () => {
  const g = await sensoryGain({ factors: { depth: 0.2, patience: 0.5, irritability: 0.2, ne: 0.4, energy: 0.6 } })
  assert.equal(g.profile, 'conserve')
  assert.equal(g.fps, 2)
  assert.equal(g.maxEvents, 2)
  assert.equal(g.maxFrames, 2)
  assert.ok(/省电/.test(g.why), g.why)

  const g2 = await sensoryGain({ factors: { depth: 0.8, energy: 0.1, ne: 0.3, irritability: 0.1 } })
  assert.equal(g2.profile, 'conserve', '血糖低也要省电')
})

await ok('警觉：唤醒高或烦躁高 → 加密采样但只看关键', async () => {
  const a = await sensoryGain({ factors: { depth: 0.7, energy: 0.7, irritability: 0.2, ne: 0.85 } })
  assert.equal(a.profile, 'alert')
  assert.equal(a.fps, 8)
  assert.equal(a.maxEvents, 3)
  const b = await sensoryGain({ factors: { depth: 0.7, energy: 0.7, irritability: 0.75, ne: 0.4 } })
  assert.equal(b.profile, 'alert', '烦躁也算警觉档')
})

await ok('有闲心：脑力+血糖足且不烦 → 看得更多（5 段/5 张）', async () => {
  const g = await sensoryGain({ factors: { depth: 0.85, energy: 0.7, irritability: 0.15, ne: 0.5 } })
  assert.equal(g.profile, 'relaxed')
  assert.equal(g.maxEvents, 5)
  assert.ok(g.maxFrames >= 4)
})

await ok('日常：中间状态 → 4Hz/4 段/4 张', async () => {
  const g = await sensoryGain({ factors: { depth: 0.6, energy: 0.45, irritability: 0.3, ne: 0.5 } })
  assert.equal(g.profile, 'normal')
  assert.deepEqual([g.fps, g.maxEvents, g.maxFrames], [4, 4, 4])
})

await ok('器官读不到 → 回 normal，不抛错（身体感坏不该连视频都看不成）', async () => {
  const g = await sensoryGain({ field: null, metabolism: null })
  assert.ok(PROFILES[g.profile], 'profile 必须是四档之一')
  assert.equal(g.fps, PROFILES[g.profile].fps)
  assert.ok(typeof g.why === 'string' && g.why.length > 0)
})

await ok('applyGain：调用方显式给的参数永远赢', () => {
  const base = { fps: 4, maxEvents: 4, maxFrames: 4, maxAnalyzeSec: 120, maxAudioSec: 180 }
  const g = { ...PROFILES.conserve, profile: 'conserve', why: 'x', factors: {} }
  // 真实调用形态：watch 先 {...DEFAULTS, ...opts} 合并，再用 opts 判断"显式给了没"
  const merged = { ...base, fps: 12, maxFrames: 1 }
  const out = applyGain(merged, g, { fps: 12, maxFrames: 1 })
  assert.equal(out.fps, 12, '显式 fps 不许被覆盖')
  assert.equal(out.maxFrames, 1, '显式 maxFrames 不许被覆盖')
  assert.equal(out.maxEvents, 2, '没显式给的照旧用增益')
  assert.equal(applyGain(base, null, {}).fps, 4, 'gain=null 原样返回')
})

const bad = results.filter(([o]) => !o)
for (const [o, n, m] of results) console.log((o ? '✓ ' : '✗ ') + n + (o ? '' : ' — ' + m))
if (bad.length) process.exit(1)
console.log('sensory-gain ✓ 全部通过')
process.exit(0)
