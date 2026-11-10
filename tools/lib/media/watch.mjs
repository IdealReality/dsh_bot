// watch —— 视听融合：把"视网膜的事件"和"耳朵的台词"对齐成一条时间线。
//
// 为什么需要这一层（2026-11-08，用户要求按人的方式处理，不要只看三张图）：
//   视觉和听觉各自给出的是**互不认识的两串时间**。
//   人之所以"看得懂"，一部分是因为跨通道对齐：同一时刻的画面变化 + 说话声，
//   被绑定成同一个事件（±200ms 的绑定窗；McGurk 现象就是这个窗口在起作用）。
//   所以这里不做"再抽一次帧"，只做三件事：
//     ① 选事件（显著性 + 时间覆盖），静止段不出图；
//     ② 出两种图：**拼贴**（一段的动作轨迹）和**注视图**（变化区域的高分辨率 crop）；
//     ③ 产出一条带证据等级的时间线 —— 模型看到的是"什么时候发生了什么"，
//        而不是"这是三张互不相干的图"。
//
// 输出只包含**可测的物理事实**（静止/运动/切换、方位、有无语音、台词原文）。
// 语义（"这是一个方块在滑动"）留给视觉模型，本地不编。
import fs from 'node:fs'
import path from 'node:path'
import { swallow } from '../infra/swallow.mjs'
import { httpGet } from '../infra/fetch-bytes.mjs'
import * as retina from './retina.mjs'
import * as audition from './audition.mjs'
import { sensoryGain, applyGain } from '../mind/sensory-gain.mjs'

const DEFAULTS = {
  windowSec: 3,        // "当下"的量级（知觉当下 2~3s）
  fps: 4,              // 采样率（0.25s 一格）；由 sensory-gain 按身体状态调
  maxEvents: 4,        // 最多描述几个事件
  maxFrames: 4,        // 最多出几张图（拼贴+注视图）—— 4 张 ≈ 一段 3 秒窗口的完整证据，
                       // 再多是重复信息，还挤占聊天上下文（2026-11-08）
  maxAnalyzeSec: 120,  // 视觉分析上限（4Hz 全片解码；超长片只分析开头并明说）
  maxAudioSec: 180,    // 听写上限
  budgetMs: 45_000,    // 整条预算：聊天不能等太久
  outDir: null,
  gain: null,          // true/对象 = 用器官状态调参；false = 固定参数（测试用）
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function where(box) {
  if (!box || box.global) return '整屏'
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const hx = cx < 0.34 ? '左' : cx > 0.66 ? '右' : '中'
  const hy = cy < 0.34 ? '上' : cy > 0.66 ? '下' : '中'
  if (hx === '中' && hy === '中') return '画面中部'
  if (hx === '中') return `画面${hy}方`
  if (hy === '中') return `画面${hx}侧`
  return `画面${hy}${hx}`
}

const fmt = (t) => (Math.round(Number(t) * 10) / 10).toFixed(1)

/**
 * 一段区间里"听起来是什么"（不看人话，只看纹理）。
 * 措辞留余地：我们只分瞬态/持续、噪声性/调性，分不出"玻璃碎"和"关门"。
 */
function soundText(textures, a, b) {
  if (!textures || !textures.ok || !Array.isArray(textures.segments) || !textures.segments.length) {
    return '有声音但不是人话（音乐/环境声）'
  }
  const inside = textures.segments.filter((s) => s.kind !== 'silence' && s.t1 > a && s.t0 < b)
  if (!inside.length) return '有声音但很轻'
  const dur = (s) => s.t1 - s.t0
  const bursts = inside.filter((s) => s.kind === 'burst')
  const span = Math.max(0.5, b - a)
  if (bursts.length >= 2 && bursts.length / span >= 1) return '像是掌声/密集响声'
  if (bursts.length === 1) return '突然一声响'
  const tonal = inside.filter((s) => s.kind === 'tonal').reduce((x, s) => x + dur(s), 0)
  const noise = inside.filter((s) => s.kind === 'noise').reduce((x, s) => x + dur(s), 0)
  if (tonal >= noise) return '有音乐/持续的声音（没人说话）'
  return '有噪声（像环境音）'
}

/** 一个事件在时间线上的一行（只写可测事实）。audOk=false 时不写"安静"（没听不等于安静）。 */
function eventLine(ev, box, speech, audOk = true, salNote = '', textures = null, faceMotion = null) {
  const bits = []
  if (ev.static) bits.push(ev.cutIn > 0.08 ? '切换后静止' : '静止（没有变化）')
  else {
    const pace = ev.peak > 0.08 ? '动得很快' : ev.peak > 0.03 ? '动得不快' : ''
    const det = Number.isFinite(ev.detail)
      ? (ev.detail > 0.06 ? '细节清楚' : ev.detail < 0.015 ? '没什么细节' : '')
      : ''
    const tail = [pace, det].filter(Boolean).join('、')
    if (ev.cutIn > 0.08) bits.push(`切换后开始动（变化在${where(box)}${tail ? '，' + tail : ''}）`)
    else bits.push(`有动作（变化在${where(box)}${box && !box.global ? '，见注视图' : ''}${tail ? '，' + tail : ''}）`)
  }
  const extra = salNote ? `；${salNote}` : ''
  if (!audOk) return `${fmt(ev.t0)}-${fmt(ev.t1)}s｜${bits.join('，')}${extra}`
  const said = speech.filter((s) => s.end > ev.t0 && s.start < ev.t1)
  let sound = '安静'
  if (said.length) {
    sound = `他说「${said.map((s) => s.text).join(' ')}」`
    // 说话归属：先看那张脸的嘴在不在动（YuNet 跟踪），没有跟踪数据才退回"画面静不静"。
    if (faceMotion != null && faceMotion > 0.01) sound += '（画面里那张脸在动，像在说话）'
    else if (faceMotion != null) sound += '（那张脸没动，像画外音/旁白）'
    else if (ev.static) sound += '（画面没动，像画外音）'
  }
  else if (ev.voiced) sound = soundText(textures, ev.t0, ev.t1)
  return `${fmt(ev.t0)}-${fmt(ev.t1)}s｜${bits.join('，')}｜声音：${sound}${extra}`
}

/**
 * 事件打分：变化越强越重要；有语音的抬一档；切换点略有加成；
 * **响的时段也抬一档**（跨通道注意力：人听到动静会往那边看）。
 */
function scoreOf(ev, speech, loud = -96) {
  const talk = speech.some((s) => s.end > ev.t0 && s.start < ev.t1)
  return ev.peak * 12
    + (ev.static ? 0 : 0.4)
    + (talk ? 0.8 : 0)
    + (ev.cutIn > 0.08 ? 0.15 : 0)
    + (loud > -30 ? 0.35 : 0)
}

/** 选事件：先按时间分桶保证覆盖，再按分数补齐。 */
function chooseEvents(events, speech, maxEvents, loudAt = () => -96) {
  // "值得看"不等于"段内在动"：整屏换色后静止的段（cutIn 高、段内不动）也是新画面 ——
  // 淡蓝换淡黄这种变化在灰度上没有残差，只有色度能看见（2026-11-08）。
  const live = events.filter((e) => !e.static || e.cutIn >= 0.06)
  const pool = live.length ? live : events
  if (!pool.length) return []
  const scored = pool.map((e) => ({ e, s: scoreOf(e, speech, loudAt(e.t0, e.t1)) })).sort((a, b) => b.s - a.s)
  const t0 = Math.min(...pool.map((e) => e.t0))
  const t1 = Math.max(...pool.map((e) => e.t1))
  const span = Math.max(0.5, t1 - t0)
  const buckets = new Map()
  for (const { e, s } of scored) {
    const k = Math.min(maxEvents - 1, Math.floor(((e.t0 + e.t1) / 2 - t0) / span * maxEvents))
    if (!buckets.has(k)) buckets.set(k, { e, s })
  }
  const picked = [...buckets.values()].sort((a, b) => a.e.t0 - b.e.t0).map((x) => x.e)
  for (const { e } of scored) {
    if (picked.length >= maxEvents) break
    if (!picked.includes(e)) picked.push(e)
  }
  // 开场画面永远保留：人看视频**总归看到了第一眼**，哪怕之后一直静止。
  // 不保留的话，"淡蓝→淡黄"这种片子只会描述后半段，她会以为整条都是黄的。
  const first = events[0]
  if (first && !picked.includes(first)) picked.unshift(first)
  return picked.sort((a, b) => a.t0 - b.t0).slice(0, maxEvents)
}

/** 把某事件的帧喂给 hotspot，得到注视框（取峰值帧）。 */
function boxFor(analysis, ev) {
  if (!analysis) return null
  // 多窗口分析时 peakAt*fps 只对单窗成立 —— 用事件自带的全局帧号 gpeak。
  const gi = Number.isFinite(ev.gpeak) ? ev.gpeak : Math.round(ev.peakAt * analysis.fps)
  const i = clamp(gi, 1, analysis.nFrames - 1)
  try { return retina.hotspot(analysis.frames[i - 1], analysis.frames[i], analysis.w, analysis.h) } catch { return null }
}

/**
 * 看一段媒体（本地文件或 http URL）。
 *
 * @param {{file?:string, url?:string}} input
 * @param {object} [opts] 见 DEFAULTS
 * @returns {Promise<{
 *   ok:boolean, why:string, dur:number,
 *   frames:string[], timeline:string, note:string,
 *   meta:object, cleanup:()=>void,
 * }>}
 */
export async function watchMedia(input, opts = {}) {
  // 先按器官状态定"看片姿态"（省电/警觉/有闲心/日常），再合并调用方显式参数。
  // 顺序很重要：显式参数必须赢（测试/手动覆盖不能被情绪悄悄改掉）。
  let gain = null
  try {
    if (opts.gain !== false) gain = opts.gain || await sensoryGain()
  } catch { gain = null }
  const o = applyGain({ ...DEFAULTS, ...opts }, gain, opts)
  const dir = o.outDir || retina.tmpDir('bot-watch-')
  const own = !o.outDir
  const cleanup = () => { if (own) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } } }
  const fail = (why) => ({ ok: false, why, dur: 0, frames: [], timeline: '', note: '', meta: {}, cleanup })

  let file = input?.file ? String(input.file) : ''
  try {
    if (!file && input?.url) {
      let buf
      try {
        buf = await httpGet(String(input.url), { timeoutMs: Math.min(30_000, o.budgetMs), signal: o.signal })
      } catch (e) {
        // 下载就被打断（55MB 在回环上也要几秒）：不能等它下完。
        if (o.signal?.aborted || e?.name === 'AbortError') {
          return {
            ok: false, why: '被打断了，还没看到画面', interrupted: true, dur: 0,
            frames: [], timeline: '',
            note: '【他发来一段视频，你刚点开他就插话了——你还没看到画面。别装看过：先说"我正要看"】',
            meta: { interrupted: true }, cleanup,
          }
        }
        throw e
      }
      if (buf.length < 2000) return fail(`视频太小（${buf.length}B），可能不是可播的文件`)
      file = path.join(dir, 'input.mp4')
      fs.writeFileSync(file, buf)
    }
    if (!file || !fs.existsSync(file)) return fail('没有拿到可读的文件')

    const dur = Math.min(
      (await retina.probeDur(file)) || 0,
      1e9,
    )
    // 预算而不是硬截断：长视频由 retina 粗扫选窗（2026-11-08）。
    // 以前这里是 maxSec: min(120, dur) → 30 分钟的片子只看开头 120 秒。
    const analyzeBudget = o.maxAnalyzeSec > 0 ? o.maxAnalyzeSec : 0

    // 视觉与听觉各自独立计时：视觉（ffmpeg 解码）通常 1~2 秒，听觉（whisper）慢得多。
    // 旧写法用 Promise.all 一起等，一旦整体超预算就把**视觉也丢掉了** ——
    // 明明画面已经解好，却因为耳朵慢而整条判失败。现在谁先好谁留下。
    const t0 = Date.now()
    const deadline = t0 + o.budgetMs
    const withTimeout = (p, ms) => Promise.race([
      p,
      new Promise((r) => setTimeout(() => r(null), Math.max(200, ms))),
    ])
    const visP = retina.analyze(file, { dur, budgetSec: analyzeBudget, fps: o.fps, windowSec: o.windowSec, signal: o.signal, onProgress: o.onProgress }).catch((e) => { swallow(e, 'watch:retina'); return null })
    const audP = audition.listen(file, { maxSec: o.maxAudioSec, signal: o.signal }).catch((e) => { swallow(e, 'watch:audition'); return null })
    const vis = await withTimeout(visP, deadline - Date.now())
    // 被打断时不再等耳朵：whisper 可能要几十秒，而他已经开口了。
    // 视觉自己会在 abort 后立刻返回已解的帧（retina.readRawStream 的 partial），
    // 所以这里花的是"已经解到的那一段"，不是白等。
    const aud = (o.signal && o.signal.aborted) ? null : await withTimeout(audP, deadline - Date.now())
    if (!aud) swallow(new Error('听觉超出剩余预算，先交付画面'), 'watch:budget')
    const elapsed = Date.now() - t0

    // 被他插话打断（或解码超时截断）：只交付"已经看到的那一段"，并且**说清楚没看完**。
    const interrupted = Boolean(o.signal?.aborted) || Boolean(vis?.partial)
    const frames = []          // 送模型的图（顺序即"第 N 张"）
    const lines = []
    // fps/maxEvents/... 是被 body 状态调过的（省电/警觉/有闲心），记下来才能复盘
    // "她这次为什么只看两段"——不许出现"参数不明地变了"。
    const meta = {
      dur, elapsed, events: [], chosen: [], frames: [], audio: null, visual: null, interrupted,
      gain: gain ? { profile: gain.profile, why: gain.why, fps: o.fps, maxEvents: o.maxEvents, maxFrames: o.maxFrames } : { profile: 'off' },
    }

    if (!vis) {
      // 刚点开就被插话：一帧都还没解出来。这不是"文件坏了"，别这么说。
      if (o.signal?.aborted) {
        return {
          ok: false,
          why: '被打断了，还没看到画面',
          interrupted: true,
          dur,
          frames: [],
          timeline: '',
          note: '【他发来一段视频，你刚点开他就插话了——你还没看到画面。别装看过：先说"我正要看"】',
          meta, cleanup,
        }
      }
      return {
        ok: false,
        why: '画面没解出来（ffmpeg 读不了这个文件）',
        dur,
        frames: [],
        timeline: '',
        note: '【他发来一段视频，但画面没能解开——你没看成。别装看过，直接问他视频里是什么】',
        meta, cleanup,
      }
    }

    const speech = (aud && Array.isArray(aud.segs)) ? aud.segs : []
    // 人脸跟踪（口型近似）：只在依赖齐的时候跑；拿不到就整条降级，不阻塞
    let faceTl = null
    try {
      if (!interrupted && retina.facesReady()) faceTl = await retina.faces(file, { fps: 2, maxSec: Math.min(dur || 60, 60) })
    } catch { faceTl = null }
    if (faceTl) meta.faces = { frames: faceTl.frames.length, hits: faceTl.frames.filter((f) => f.faces && f.faces.length).length }
    const faceMotionIn = (a, b) => {
      if (!faceTl || !Array.isArray(faceTl.frames) || !faceTl.frames.length) return null
      const vals = []
      for (const f of faceTl.frames) {
        if (f.t >= a - 0.1 && f.t < b && Array.isArray(f.faces) && f.faces.length) vals.push(Number(f.faces[0].faceMotion) || 0)
      }
      return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null
    }
    // 响度曲线（0.1s 一点）→ "这一段有多响"
    const levels = (aud?.textures && Array.isArray(aud.textures.levels)) ? aud.textures.levels : null
    const loudAt = (a, b) => {
      if (!levels || !levels.length) return -96
      let sum = 0
      let n = 0
      for (const l of levels) if (l.t >= a - 0.05 && l.t < b) { sum += l.rms; n++ }
      return n ? sum / n : -96
    }
    const chosen = chooseEvents(vis.events, speech, o.maxEvents, loudAt)
    meta.visual = { dur: vis.dur, fps: vis.fps, events: vis.events.length, cuts: vis.cuts, meanErr: vis.meanErr }
    meta.audio = aud && {
      ok: aud.ok, why: aud.why, dur: aud.dur, heardTo: aud.heardTo, segs: aud.segs.length,
      voicedRatio: aud.voicedRatio, speechRatio: aud.speechRatio, device: aud.device, elapsed: aud.elapsed,
      lines: aud.lines,
      textures: aud.textures ? { summary: aud.textures.summary, why: aud.textures.why, segments: aud.textures.segments.length } : null,
    }

    // 出图：注视图（高分辨率）优先，其次拼贴（动作轨迹），最后全帧兜底。
    // 图有上限（maxFrames），但**描述没有上限**：被选中但没出图的事件仍要进时间线，
    // 否则"这段有动作"只剩一句含糊的"没细看"（2026-11-08 实测：60 秒片子只挑出 2 段）。
    const outDir = path.join(dir, 'frames')
    fs.mkdirSync(outDir, { recursive: true })
    const add = (p) => { if (p && !frames.includes(p)) frames.push(p) }
    for (let idx = 0; idx < chosen.length; idx++) {
      const ev = chosen[idx]
      // 注视点优先级：像人脸 > 有运动 > 有密集细节（文字/纹理）。
      // 人眼就是这样：静止画面里出现脸，注意力立刻过去，哪怕一点没动。
      const sal = await retina.inspectSalient(file, ev.static ? ev.t0 + 0.1 : ev.peakAt).catch(() => null)
      let box = boxFor(vis, ev)
      let salNote = ''
      if (sal?.skin) { box = sal.skin.box; salNote = '画面里有像人脸的肤色区' }
      else if (sal?.detail && (!box || box.global)) { box = sal.detail.box; salNote = '有密集细节（可能是文字/纹理）' }
      let crop = null
      let tile = null
      if (frames.length < o.maxFrames) {
        // 扫视抑制的粗版：切换帧常带运动模糊/黑帧，人眼在跳视期间本来就看不清。
        // 段内没有真实运动（peak 很低，只有 cutIn）时，取切换后 0.25 秒的稳定帧。
        const cropAt = ev.peak < 0.012 ? Math.min(Math.max(ev.t0 + 0.25, ev.t0), Math.max(ev.t0, ev.t1 - 0.05)) : ev.peakAt
        // 静止段也能有注视点（人脸/文字不需要动）
        if (box && !box.global && (!ev.static || salNote)) {
          crop = await retina.renderCrop(file, cropAt, box, { out: path.join(outDir, `e${idx + 1}-crop.jpg`) }).catch(() => null)
        }
        if (!ev.static && ev.t1 - ev.t0 >= 0.9) {
          const span = Math.min(o.windowSec, ev.t1 - ev.t0)
          tile = await retina.renderTile(file, ev.t0, span, { out: path.join(outDir, `e${idx + 1}-tile.jpg`) }).catch(() => null)
        }
        // 预算内优先保住"注视图 + 拼贴"，兜底帧只在没有任何图时用
        if (crop) add(crop)
        if (tile && frames.length < o.maxFrames) add(tile)
        if (!crop && !tile && frames.length < o.maxFrames) {
          const key = await retina.renderKey(file, ev.static ? ev.t0 : ev.peakAt, { out: path.join(outDir, `e${idx + 1}-key.jpg`) }).catch(() => null)
          if (key) add(key)
        }
      }
      meta.chosen.push({
        t0: ev.t0, t1: ev.t1, static: ev.static, peak: ev.peak, peakAt: ev.peakAt, box,
        crop: Boolean(crop), tile: Boolean(tile), imaged: Boolean(crop || tile),
        sal: sal ? { skin: Boolean(sal.skin), detail: Boolean(sal.detail), skinRatio: sal.skinRatio } : null,
        salNote,
      })
    }
    // 全是静止事件：只给一张全帧，明确写"画面没动"
    if (!frames.length) {
      const key = await retina.renderKey(file, 0, { out: path.join(outDir, 'first.jpg') }).catch(() => null)
      if (key) add(key)
    }

    // ── 时间线 ────────────────────────────────────────────────────────────
    // 覆盖整条片子：选中的事件逐行细说，没选中的空档也要有一句 —— 否则
    // "0-3s 有动作" 会让模型以为视频只有 3 秒（人不会把没注意的段落当成不存在）。
    const voicedAt = (a, b) => (aud?.spans || []).some(([x, y]) => y > a && x < b)
    const speechIn = (a, b) => speech.filter((s) => s.end > a && s.start < b)
    const audOk = Boolean(aud && aud.ok)
    // 哪些时间段真的被抽看了（长视频只抽几段）。没抽到的区间**不许**说成"静止"——
    // "没看"和"看了是静止的"是两件事，混在一起就是编造。
    const segs = (vis.segments && vis.segments.length) ? vis.segments : [{ t0: 0, t1: vis.dur }]
    // 空档要拆开写：被抽看的片段里"静止"是事实，没抽到的片段"没看"也是事实 ——
    // 把 0-8.5s（根本没抽）写成"静止（没有变化）"，就是拿没看冒充看过。
    const coveredLine = (a, b) => {
      const inner = (vis.events || []).filter((e) => e.t1 > a + 0.01 && e.t0 < b - 0.01)
      const anyMotion = inner.some((e) => !e.static)
      const part = anyMotion ? '有动作（这段没细看，没出图）' : '静止（没有变化）'
      if (!audOk) return `${fmt(a)}-${fmt(b)}s｜${part}`
      const said = speechIn(a, b)
      const snd = said.length ? `他说「${said.map((x) => x.text).join(' ')}」`
        : voicedAt(a, b) ? soundText(aud?.textures, a, b) : '安静'
      return `${fmt(a)}-${fmt(b)}s｜${part}｜声音：${snd}`
    }
    const gapLines = (a, b) => {
      if (b - a < 0.15) return []
      const covers = segs.filter((s) => s.t1 > a && s.t0 < b).sort((x, y) => x.t0 - y.t0)
      if (!covers.length) return [`${fmt(a)}-${fmt(b)}s｜没抽到（这段没看）`]
      const out = []
      let cur = a
      for (const s of covers) {
        const s0 = Math.max(a, s.t0)
        const s1 = Math.min(b, s.t1)
        if (s0 > cur + 0.15) out.push(`${fmt(cur)}-${fmt(s0)}s｜没抽到（这段没看）`)
        if (s1 > s0 + 0.15) out.push(coveredLine(s0, s1))
        cur = Math.max(cur, s1)
      }
      if (b > cur + 0.15) out.push(`${fmt(cur)}-${fmt(b)}s｜没抽到（这段没看）`)
      return out
    }
    let cursor = 0
    for (const ev of [...chosen].sort((x, y) => x.t0 - y.t0)) {
      for (const l of gapLines(cursor, ev.t0)) lines.push(l)
      const m = meta.chosen.find((c) => Math.abs(c.t0 - ev.t0) < 1e-6)
      lines.push(eventLine({ ...ev, voiced: voicedAt(ev.t0, ev.t1) }, m?.box || boxFor(vis, ev), speech, audOk, m?.salNote || '', aud?.textures || null, faceMotionIn(ev.t0, ev.t1)))
      cursor = Math.max(cursor, ev.t1)
    }
    // 被打断时时间线只写到**真的看到的位置**：后面没解码，不许写"静止"。
    const seenTo = interrupted ? Math.min(vis.dur, Number(vis.watchedTo) || 0) : vis.dur
    for (const l of gapLines(cursor, seenTo)) lines.push(l)
    if (interrupted) lines.push(`（看到 ${fmt(seenTo)} 秒时被打断了，后面的没看）`)
    if (aud && aud.lines && aud.lines.length) {
      lines.push('完整台词：' + aud.lines.join(' / '))
    } else if (aud && aud.ok && !aud.segs.length && aud.voicedRatio > 0.25) {
      lines.push('声音：' + (aud.textures?.ok ? aud.textures.why : '整段有声音但没有人话'))
    } else if (aud && !aud.ok) {
      lines.push(`声音：没听成（${aud.why || '未知原因'}）`)
    }
    if (!aud) lines.push(interrupted ? '声音：没来得及听（他插话了，先答他）' : '声音：没来得及听（超出时间预算）')
    if (vis.truncated && !interrupted) {
      const coveredSec = segs.reduce((a, s) => a + (s.t1 - s.t0), 0)
      lines.push(`（${Math.round(dur)} 秒的片子抽看了 ${segs.length} 段共 ${Math.round(coveredSec)} 秒，其余没看）`)
    }

    const sec = Math.round(dur * 10) / 10
    const heard = aud?.ok && aud.segs.length ? `听清 ${aud.segs.length} 句`
      : (interrupted ? '没来得及听' : '没听到人话')
    const moved = meta.chosen.filter((c) => !c.static).length
    const note = `【他发来一段 ${sec} 秒的视频：你按 0.25 秒一格采样，切成 ${vis.events.length} 段，`
      + `${moved ? `${moved} 段有动作` : '画面基本没动'}，${heard}。下面是时间线和对应画面】`
      + (interrupted ? `（⚠ 他中途插话了，你只看到 ${fmt(seenTo)} 秒：先说已经看到的，剩下的说"还没看完"）` : '')
      + (vis.truncated && !interrupted ? `（这是长片：只抽看了 ${segs.length} 段，不是全片）` : '')
      + '（拼贴图是按时间从左上到右下排的连续采样，格角数字是采样序号（每格 0.25 秒）；'
      + '换行只是排版，不代表物体在画面里上下移动；注视图是变化区域的高分辨率裁剪）'

    return {
      ok: true,
      why: '',
      dur,
      interrupted,
      seenTo: Number(seenTo.toFixed(2)),
      frames,
      timeline: lines.join('\n'),
      note,
      meta,
      cleanup,
    }
  } catch (e) {
    swallow(e, 'watch:panic')
    return fail('看视频的过程出错了：' + String(e?.message ?? e).slice(0, 80))
  }
}

/** 给测试/诊断：只跑视觉或只听声音。 */
export { retina, audition }
