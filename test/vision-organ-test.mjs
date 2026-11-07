// vision-organ-test —— 视觉器官（2026-11-08 器官化）
//
// 判据都是行为级的，不看实现：
//   ① 看得成的账：look 成功后 stats.ok+1、last.coverage=1
//   ② 看不成的账：坏文件 → ok=false、stats.fail+1、lastFailWhy 有原因（且不抛）
//   ③ 增量印象：解完窗口就有回调（不是等整片）——且第一个印象的时间戳 ≈ 第一个窗口
//   ④ phrase：静止/有动作/换镜头/没解完 四种说法都必须可测、不含语义
//   ⑤ 体感与表达：最近一次没看成 → sense() 说没看成、llmState() 禁止编内容；
//      把 last.at 推到 7 小时前 → 两者都安静（器官不该整天喊累）
//   ⑥ 耳朵可用性透传：snapshot().ear 是布尔（ASR 装没装都不许抛）
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-vision-'))
process.env.BOT_DATA_DIR = path.join(SANDBOX, '.data')
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
process.env.DSH_HOME = path.join(SANDBOX, '.dsh')

const vision = await import('../tools/brain/organ/vision.mjs')
const { dataPath } = await import('../tools/lib/paths.mjs')
const { mutateJson } = await import('../tools/brain/json.mjs')

const VISION_JSON = () => dataPath('brain', 'meta', 'vision.json')

// 3 秒素材：前半静止、后半有运动（判据只看"有没有动"，不看语义）
const MP4 = path.join(SANDBOX, 'clip.mp4')
execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=0x101820:s=320x180:d=1.5',
  '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1.5',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
  '-pix_fmt', 'yuv420p', MP4,
], { timeout: 30_000 })

// ── ① 看得成 ──
{
  const seen = []
  const r = await vision.look({ file: MP4 }, { gain: false, budgetMs: 60_000, onImpression: (p) => seen.push(p) })
  assert.equal(r.ok, true, '正常视频应看得成：' + r.why)
  const s = vision.snapshot()
  assert.equal(s.looks, 1, 'look 记一次')
  assert.equal(s.ok, 1, 'ok 记一次')
  assert.equal(s.last.coverage, 1, '整片都看了 → coverage=1（实得 ' + s.last.coverage + '）')
  assert.equal(s.last.profile, 'off', 'gain:false 要如实记成 off')
  assert.equal(typeof s.ear, 'boolean', 'ear 必须是布尔')
  console.log('  ✓ 看得成：stats.ok=1 / coverage=1 / ear=' + s.ear)

  // ── ③ 增量印象：窗口一解完就回调 ──
  assert.ok(seen.length >= 1, '至少要有一个增量印象（实际 ' + seen.length + '）')
  const p = seen[0]
  assert.equal(typeof p.t0, 'number')
  assert.equal(typeof p.t1, 'number')
  assert.ok(p.t1 > p.t0, '印象区间要有长度')
  assert.ok(p.t1 <= r.dur + 0.5, '第一个印象不该越过整片（' + p.t1 + ' vs ' + r.dur + '）')
  console.log('  ✓ 增量印象：' + seen.length + ' 条，首条 ' + p.t0 + '-' + p.t1 + 's')
}

// ── ② 看不成的账（坏文件不许抛）──
{
  const bad = path.join(SANDBOX, 'nope.mp4')
  const r = await vision.look({ file: bad }, { gain: false, budgetMs: 5000 })
  assert.equal(r.ok, false, '坏文件必须 ok=false')
  const s = vision.snapshot()
  assert.equal(s.looks, 2)
  assert.equal(s.fail, 1, '失败要记账')
  assert.ok(String(s.lastFailWhy).length > 0, '失败原因不许为空')
  console.log('  ✓ 看不成的账：fail=1 / why="' + s.lastFailWhy + '"')
}

// ── ⑤ 体感与表达（基于"最近一次没看成"）──
{
  assert.ok(/没看成/.test(vision.sense()), 'sense 要说没看成：' + vision.sense())
  const ls = vision.llmState()
  assert.ok(ls && /别编/.test(ls.note), 'llmState 要禁止编内容：' + JSON.stringify(ls))

  // 推到 7 小时前：器官安静（不久坐成性格）
  mutateJson(VISION_JSON(), () => ({}), (cur) => {
    cur.last = { ...(cur.last || {}), at: Date.now() - 7 * 3600_000 }
    return cur
  })
  assert.equal(vision.sense(), '', '7 小时后不该再喊眼睛不舒服（实得 "' + vision.sense() + '"）')
  assert.equal(vision.llmState(), null, '7 小时后不再干预表达')
  console.log('  ✓ 体感/表达：失败时会说，7 小时后安静')
}

// ── ④ phrase：四种说法，全是不含语义的物理事实 ──
{
  const a = vision.phrase({ t0: 0, t1: 3, moved: 0, cuts: 0 })
  const b = vision.phrase({ t0: 3, t1: 6, moved: 2, cuts: 0, detail: 0.09 })
  const c = vision.phrase({ t0: 6, t1: 9, moved: 1, cuts: 1 })
  const d = vision.phrase({ t0: 9, t1: 12, moved: 0, cuts: 0, partial: true })
  assert.ok(/静止/.test(a), '静止：' + a)
  assert.ok(/有动作/.test(b) && /细节清楚/.test(b), '有动作+细节：' + b)
  assert.ok(/换了镜头/.test(c), '换镜头：' + c)
  assert.ok(/还没看清/.test(d), '没解完：' + d)
  console.log('  ✓ phrase：' + [a, b, c, d].join(' | '))
}

console.log('vision-organ-test: 6 组断言全过（记账/增量印象/失败/体感/表达/phrase）')
