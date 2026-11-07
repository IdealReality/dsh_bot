// 视听前端（retina/audition/watch）的离线回归。2026-11-08。
//
// 为什么需要：这一层是"她能不能真看见/听见"的地基，而它最容易的坏法是
// **看起来正常**（时间线有字、有一张图），实际事件切错了/图是空的/预算一超全丢。
// 这里只钉可测的物理事实：切点位置、静止/运动判定、图数与尺寸、无音轨时的措辞。
//
// 不用网络、不用 TTS、不调视觉模型 —— 素材全部 ffmpeg 现场合成。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-av-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
// 沙箱里没有 ASR venv。它是只读的（模型+解释器），可以显式指回真实数据目录，
// 否则"画外音"这条用例永远只能测到"ASR 没装好"。
if (!process.env.BOT_ASR_DATA_DIR && fs.existsSync('/home/dsh/.data/asr-venv/bin/python')) {
  process.env.BOT_ASR_DATA_DIR = '/home/dsh/.data'
}
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* ignore */ } })

const ROOT = path.resolve(import.meta.dirname, '..')
const { watchMedia } = await import('file:///' + path.join(ROOT, 'tools/lib/watch.mjs').replace(/\\/g, '/'))

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); return true } catch { return false } })()
if (!hasFfmpeg) { console.log('watch-av ✓ 跳过（这台机器没有 ffmpeg）'); process.exit(0) }

const results = []
async function ok(name, fn) {
  try { await fn(); results.push([true, name]) } catch (e) { results.push([false, name, e.message]) }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-av-src-'))
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 120_000 })

// ① 静止红 2s → 蓝底白方块横移 2s → 静止绿 2s（无音轨）
const A = path.join(dir, 'a.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=2',
  '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=2',
  '-f', 'lavfi', '-i', 'color=c=white:s=80x80:d=2',
  '-f', 'lavfi', '-i', 'color=c=green:s=640x360:d=2',
  '-filter_complex', '[1][2]overlay=x=100+120*t:y=140:shortest=1[mv];[0]trim=duration=2[r];[mv]trim=duration=2[b];[3]trim=duration=2[g];[r][b][g]concat=n=3:v=1:a=0[o]',
  '-map', '[o]', '-pix_fmt', 'yuv420p', '-r', '25', A])

// ② 快切：8 段 × 0.3s
const B = path.join(dir, 'b.mp4')
{
  const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan', 'magenta']
  const inputs = []
  const tags = []
  colors.forEach((c, i) => { inputs.push('-f', 'lavfi', '-i', `color=c=${c}:s=640x360:d=0.3`); tags.push(`[${i}]`) })
  ff([...inputs, '-filter_complex', `${tags.join('')}concat=n=${colors.length}:v=1:a=0[o]`, '-map', '[o]', '-pix_fmt', 'yuv420p', B])
}

// ③ 静止小字（白底黑字，字幕量级）
const C = path.join(dir, 'c.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=white:s=640x360:d=2',
  '-vf', "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='HELLO 2026':x=260:y=170:fontsize=20:fontcolor=black",
  '-pix_fmt', 'yuv420p', C])

// ④ 有音轨（正弦）+ 画面：
const D = path.join(dir, 'd.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', D])

await ok('事件切分：切点落在真实剪辑点，静止段判 static', async () => {
  const w = await watchMedia({ file: A }, { budgetMs: 40_000 })
  assert.ok(w.ok, 'watch 失败：' + w.why)
  const cuts = w.meta.visual.cuts
  assert.ok(cuts.length >= 2, '应至少两个切点，实际 ' + JSON.stringify(cuts))
  assert.ok(Math.abs(cuts[0] - 2) <= 0.5, '第一个切点应≈2.0s，实际 ' + cuts[0])
  assert.ok(Math.abs(cuts[cuts.length - 1] - 4) <= 0.5, '最后一个切点应≈4.0s，实际 ' + cuts[cuts.length - 1])
  const evs = w.meta.chosen
  assert.ok(evs.some((e) => !e.static), '应至少一个运动事件')
  assert.ok(/有动作|开始动/.test(w.timeline), '时间线要写出动作：' + w.timeline)
  assert.ok(w.frames.length >= 1 && w.frames.length <= 6, '图数 1~6，实际 ' + w.frames.length)
})

await ok('无音轨：时间线不许说"安静"（没听不等于安静）', async () => {
  const w = await watchMedia({ file: A }, { budgetMs: 40_000 })
  assert.ok(/没听成/.test(w.timeline), '要明说没听成：' + w.timeline)
  assert.ok(!/声音：安静/.test(w.timeline), '没有音轨时不许写安静：' + w.timeline)
})

await ok('快切：多个短镜头要切出来，而不是并成一整段', async () => {
  const w = await watchMedia({ file: B }, { budgetMs: 40_000 })
  assert.ok(w.ok, 'watch 失败：' + w.why)
  assert.ok(w.meta.visual.events >= 3, `8 段快切至少要切出 3 段，实际 ${w.meta.visual.events}`)
  assert.ok(w.meta.visual.cuts.length >= 2, '切点数：' + w.meta.visual.cuts.length)
})

await ok('静止小字：给的是不放大、足够大的整帧（不是缩到 640 糊掉）', async () => {
  const w = await watchMedia({ file: C }, { budgetMs: 40_000 })
  assert.ok(w.ok && w.frames.length >= 1, '应出一张图')
  const dim = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', w.frames[0]], { timeout: 15_000 }).toString().trim()
  const [wpx] = dim.split(',').map(Number)
  // 可能是整帧（600~960，不放大），也可能是文字区的注视图（crop 后 2× 放大，最小 320）。
  // 两种都能读字；要防的是"缩到 640 以下还糊成一团"。
  assert.ok(wpx >= 320 && wpx <= 1280, '图宽应在 320~1280，实际 ' + wpx)
})

await ok('预算：耳朵来不及时不拖死整条，画面照样交付', async () => {
  const t0 = Date.now()
  const w = await watchMedia({ file: D }, { budgetMs: 1200 })
  const ms = Date.now() - t0
  assert.ok(w.ok, '不应整条失败：' + w.why)
  assert.ok(ms < 12_000, '必须在预算附近返回，实际 ' + ms + 'ms')
  assert.ok(w.frames.length >= 1, '至少一张图')
  // 纹理层（纯本地、极快）通常能在耳朵超时前给出结论：有噪声/有音乐也算"写出来了"
  assert.ok(/没来得及听|没听成|没有人话|有噪声|有音乐/.test(w.timeline), '声音状态要写出来：' + w.timeline)
})

await ok('maxFrames 上限：要求 1 张就只给 1 张', async () => {
  const w = await watchMedia({ file: A }, { budgetMs: 40_000, maxFrames: 1 })
  assert.equal(w.frames.length, 1)
})

// ⑦ 长视频（60 秒）只给 20 秒预算：要抽看多段、铺开在不同时间，且"没看"必须写出来。
const G = path.join(dir, 'g.mp4')
{
  const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange']
  const inputs = []
  const tags = []
  colors.forEach((c, i) => {
    inputs.push('-f', 'lavfi', '-i', `color=c=${c}:s=320x180:d=10`)
    inputs.push('-f', 'lavfi', '-i', 'color=c=white:s=40x40:d=10')
    tags.push(`[s${i}]`)
  })
  const filters = colors.map((c, i) => `[${i * 2}][${i * 2 + 1}]overlay=x=30+${20 + i * 10}*t:y=70:shortest=1[s${i}]`).join(';')
  ff([...inputs, '-filter_complex', `${filters};${tags.join('')}concat=n=${colors.length}:v=1:a=0[o]`,
    '-map', '[o]', '-pix_fmt', 'yuv420p', G])
}

await ok('长视频：按预算抽看多段，没抽到的区间要如实写', async () => {
  const w = await watchMedia({ file: G }, { maxAnalyzeSec: 20, windowSec: 3, budgetMs: 80_000, gain: false })
  assert.ok(w.ok, 'watch 失败：' + w.why)
  assert.ok(/长片/.test(w.note || ''), 'note 要说明是抽看：' + w.note)
  assert.ok(/没抽到/.test(w.timeline), '时间线要写出没看的部分：' + w.timeline.slice(0, 200))
  const ts = w.meta.chosen.map((c) => c.t0)
  assert.ok(ts.length >= 2, '至少选中两段：' + JSON.stringify(ts))
  assert.ok(Math.max(...ts) - Math.min(...ts) > 15, '抽看位置要铺开而不是全挤在开头：' + JSON.stringify(ts))
  assert.ok(!/0\.0-10\.0s｜静止/.test(w.timeline), '没抽到的开头不许写成"静止"')
})

// ⑧ 渐亮：全屏缓慢变亮是"光线在变"，不是"画面在动"（视网膜时间适应）。
const H = path.join(dir, 'h.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=3',
  '-vf', "geq=lum='255*T/3':cb=128:cr=128", '-pix_fmt', 'yuv420p', H])

await ok('渐亮：整屏缓慢变亮要判成光线变化，不是动作', async () => {
  const w = await watchMedia({ file: H }, { budgetMs: 40_000, gain: false })
  assert.ok(w.ok, 'watch 失败：' + w.why)
  assert.ok(!/有动作|开始动/.test(w.timeline), '渐亮不该被写成动作：' + w.timeline)
  assert.ok(/静止|没动/.test(w.timeline), '应判静止/没动：' + w.timeline)
})

// ⑨ 换色：淡蓝→淡黄——亮度几乎不变（灰度看不见），必须靠色度通道检出。
const I = path.join(dir, 'i.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=0xc8dcff:s=320x180:d=1.5',
  '-f', 'lavfi', '-i', 'color=c=0xfffac8:s=320x180:d=1.5',
  '-filter_complex', '[0][1]concat=n=2:v=1:a=0[o]', '-map', '[o]', '-pix_fmt', 'yuv420p', I])

// ⑩ 静止画面里的一张脸：没有任何运动，也要被注视（显著性）。
const J = path.join(dir, 'j.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=0x101820:s=320x180:d=2',
  '-vf', 'drawbox=x=125:y=45:w=70:h=95:color=0xe0ac69:t=fill,drawbox=x=142:y=75:w=8:h=6:color=black:t=fill,drawbox=x=170:y=75:w=8:h=6:color=black:t=fill',
  '-pix_fmt', 'yuv420p', J])

await ok('显著性：静止人脸要被注视，且不许说成"有动作"', async () => {
  const w = await watchMedia({ file: J }, { budgetMs: 40_000, gain: false })
  assert.ok(w.ok, 'watch 失败：' + w.why)
  assert.ok(w.meta.chosen.some((c) => c.sal?.skin), '应识别出肤色区：' + JSON.stringify(w.meta.chosen.map((c) => c.sal)))
  assert.ok(/像人脸/.test(w.timeline), '时间线要标注像人脸：' + w.timeline)
  assert.ok(w.meta.chosen.some((c) => c.crop), '静止的脸也要出注视图')
  assert.ok(!/有动作/.test(w.timeline), '静止画面不许说有动作：' + w.timeline)
})

await ok('换色：亮度几乎不变的整屏换色要靠色度看见', async () => {
  const w = await watchMedia({ file: I }, { budgetMs: 40_000, gain: false })
  assert.ok(w.ok, 'watch 失败：' + w.why)
  assert.ok(w.meta.visual.cuts.length >= 1, '应检出换色切点：' + JSON.stringify(w.meta.visual.cuts))
  assert.ok(w.meta.chosen.length >= 2, '两段都要被选中：' + JSON.stringify(w.meta.chosen.map((c) => c.t0)))
  assert.ok(/切换后静止/.test(w.timeline), '时间线要写切换后静止：' + w.timeline)
})

// ⑪ 声音纹理：掌声 ≠ "有声音但不是人话"。
const K = path.join(dir, 'k.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=0x101820:s=320x180:d=2',
  '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.3),0.03),random(0)*2-1,0)':s=16000:d=2",
  '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', K])

await ok('声音纹理：掌声要认成掌声/密集响声，不是"有声音但没人话"', async () => {
  const w = await watchMedia({ file: K }, { budgetMs: 80_000, gain: false })
  assert.ok(w.ok, 'watch 失败：' + w.why)
  const tex = w.meta.audio?.textures
  assert.ok(tex && ['claps', 'hit'].includes(tex.summary), '纹理结论应为掌声/瞬态：' + JSON.stringify(tex))
  // ASR 能跑时（容器里有），时间线要说出声音类型；ASR 不可用时只校验纹理层
  if (w.meta.audio?.ok && !(w.meta.audio.segs > 0)) {
    assert.ok(/掌声|密集响声|一声响/.test(w.timeline), '时间线没说清声音类型：' + w.timeline)
  }
})

// ⑫ 音画一致性：有说话声但画面完全没动 → 标"像画外音"。
//    依赖本机 TTS（172.17.0.1:9880）；不可达就跳过（不算失败）。
{
  let ttsOk = false
  const say = path.join(dir, 'say.wav')
  try {
    const r0 = await fetch('http://172.17.0.1:9880/tts?text=' + encodeURIComponent('你看这个画面我说话呢'), { signal: AbortSignal.timeout(20_000) })
    if (r0.ok) { fs.writeFileSync(say, Buffer.from(await r0.arrayBuffer())); ttsOk = true }
  } catch { /* 无 TTS */ }
  if (ttsOk) {
    const L = path.join(dir, 'l.mp4')
    ff(['-f', 'lavfi', '-i', 'color=c=0x101820:s=320x180:d=3', '-i', say,
      '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', L])
    await ok('音画一致性：说话但画面没动 → 标像画外音', async () => {
      const w = await watchMedia({ file: L }, { budgetMs: 80_000, gain: false })
      assert.ok(w.ok, 'watch 失败：' + w.why)
      assert.ok(/画外音/.test(w.timeline), '应标画外音：' + w.timeline)
    })
  } else {
    console.log('  (跳过画外音用例：TTS 不可达)')
  }
}

// ⑬ 说话归属：靠人脸跟踪判断"是不是画面里那张脸在说"（依赖 YuNet + TTS，缺了就跳过）。
{
  const FACE = '/home/dsh/.data/stickers/设定图/new-issue-08-001.png'
  let ready = false
  const { facesReady } = await import('file:///' + path.join(ROOT, 'tools/lib/retina.mjs').replace(/\\/g, '/'))
  try { ready = facesReady() && fs.existsSync(FACE) } catch { ready = false }
  if (ready) {
    const say = path.join(dir, 'spk.wav')
    let ttsOk = false
    try {
      const r0 = await fetch('http://172.17.0.1:9880/tts?text=' + encodeURIComponent('这句话是我在说，你听清楚了吗'), { signal: AbortSignal.timeout(20_000) })
      if (r0.ok) { fs.writeFileSync(say, Buffer.from(await r0.arrayBuffer())); ttsOk = true }
    } catch { /* 无 TTS */ }
    if (ttsOk) {
      const M = path.join(dir, 'mv.mp4')
      ff(['-loop', '1', '-i', FACE, '-t', '3',
        '-vf', "scale=640:640:force_original_aspect_ratio=decrease,pad=800:800:(ow-iw)/2:(oh-ih)/2:color=0x101820,crop=640:640:x='80+60*sin(t*3)':y=80",
        '-pix_fmt', 'yuv420p', '-r', '25', '-an', M])
      const M2 = path.join(dir, 'mv2.mp4')
      ff(['-i', M, '-i', say, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', M2])
      await ok('说话归属：脸在动 → 像在说话；黑屏说话 → 画外音', async () => {
        const wA = await watchMedia({ file: M2 }, { budgetMs: 90_000, gain: false })
        assert.ok(wA.ok, 'watch 失败：' + wA.why)
        assert.ok(/像在说话/.test(wA.timeline), '脸动+说话应判像在说话：' + wA.timeline.slice(0, 200))
        const N = path.join(dir, 'blk.mp4')
        ff(['-f', 'lavfi', '-i', 'color=c=0x101820:s=320x180:d=3', '-i', say,
          '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', N])
        const wB = await watchMedia({ file: N }, { budgetMs: 90_000, gain: false })
        assert.ok(/画外音/.test(wB.timeline), '黑屏+说话应判画外音：' + wB.timeline.slice(0, 200))
      })
    } else console.log('  (跳过说话归属：TTS 不可达)')
  } else console.log('  (跳过说话归属：人脸模型/脚本不在)')
}

const bad = results.filter(([o]) => !o)
for (const [o, n, m] of results) console.log((o ? '✓ ' : '✗ ') + n + (o ? '' : ' — ' + m))
if (bad.length) process.exit(1)
console.log('watch-av ✓ 全部通过')
process.exit(0)
