// retina —— 视网膜前端：不送"帧"，送"预测误差"。
//
// 为什么不是又一个抽帧器（2026-11-08，用户原话「0.25 秒截一次图，每次看三秒，
// 三秒的图片叠起来查阅不同的位置，减少噪音」）：
//   均匀抽 3 帧的做法有两个结构性错误：
//     ① 时间上均匀 ≠ 信息上均匀。静止的 20 秒和打斗的 2 秒拿到一样多的画面；
//     ② 固定节拍切窗，剪辑点落在窗中段时，一格里塞两个场景，描述必然混杂。
//   人眼不是这样工作的：视网膜神经节细胞的瞬变响应只对**变化**放电，恒定刺激被
//   适应掉（sensory adaptation）；上行视觉通路传的是预测误差（predictive coding），
//   不是像素复本。所以这里先做减法：
//
//     0.25s 采样 → 32×18 灰度 → 逐帧残差 → 误差曲线
//       ├─ 误差 < ε 的段：**不出图**（她"没看见"静止画面，这是对的）
//       └─ 误差峰：事件边界 / 注视点 bbox / 关键帧
//
// 三层分工：
//   retina   画面 → 事件（这里，纯本地、零模型调用）
//   audition 声音 → 语音/声音事件（audition.mjs）
//   watch    两者对齐 → 一条带证据等级的时间线（watch.mjs）
//
// 分辨率取向：缩到 32×18 不是为了省事，是为了让"一整屏的小变化"平均掉噪声、
// 只留下真正的结构性变化（人眼周边视野同理：低分辨率、高时间分辨率）。
// 需要看清细节时，再用 bbox 去原片 crop 高分辨率——这就是中央凹。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { swallow } from '../infra/swallow.mjs'

const execFileP = promisify(execFile)

/** 采样的默认参数。都能按"她此刻的状态"覆盖（见 watch.mjs 的调制）。 */
export const DEFAULTS = {
  fps: 4,             // 0.25s 一格
  cellW: 32,          // 残差网格宽（低分辨率=周边视野）
  cellH: 18,
  maxSec: 0,          // 0 = 整片；>0 只分析前 N 秒（长片保护）
  staticEps: 0.004,   // 低于这个平均残差 = 静止（约 1/255）
  cutEps: 0.06,       // 高于这个 = 硬切/场景突变（约 15/255）
  motionEps: 0.012,   // 高于这个 = 有动作（不是静止）
  minEvent: 0.5,      // 事件最短 0.5s（更短的并进邻居）
  maxEvent: 6,        // 事件最长 6s（再长就切，人的"现在"装不下）
  beatSec: 3,         // 事件内再切成 ≤3s 的"当下片"（知觉当下的量级）
  timeoutMs: 120_000,
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** ffprobe 时长（失败返回 0，调用方按"不知道"处理，绝不猜）。 */
export async function probeDur(file, { ffprobe = 'ffprobe', timeoutMs = 10_000 } = {}) {
  try {
    const { stdout } = await execFileP(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { timeout: timeoutMs })
    return Number(JSON.parse(stdout).format?.duration || 0)
  } catch { return 0 }
}

/**
 * 流式读低分辨率帧（2026-11-08）：**边解码边交付**，并且可以被 abort 掉。
 *
 * 为什么不再用 execFile 缓冲整段：那是"等解码完才拿到第一帧"。人看视频不是这样，
 * 而且收到视频后用户随时可能插话（"这是谁啊"）—— 这时必须能**立刻停**，
 * 把"已经看到的那几秒"交出去，而不是让他在后面等 ffmpeg 跑完。
 *
 * 中止语义：signal.abort → kill ffmpeg → 返回已经解出来的帧（partial: true）。
 * 超时同理（timedOut: true）。两者都会**保留部分结果**，不返回空。
 *
 * @param {string} file
 * @param {object} opts   同 readRaw（start/maxSec/fps/cellW/cellH/skipFrame/timeoutMs/ffmpeg）
 * @param {'gray'|'rgb24'} format
 * @param {{signal?:AbortSignal, onFrame?:(frames:Uint8Array[])=>void}} [ctl]
 * @returns {Promise<{w:number,h:number,fps:number,frames:Uint8Array[],dur:number,partial:boolean,stopReason:string}>}
 */
export function readRawStream(file, opts = {}, format = 'gray', { signal, onFrame } = {}) {
  const o = { ...DEFAULTS, ...opts }
  const ffmpeg = o.ffmpeg || 'ffmpeg'
  const w = o.cellW
  const h = o.cellH
  const args = ['-v', 'error']
  if (o.skipFrame) args.push('-skip_frame', 'nokey')
  if (Number(o.start) > 0) args.push('-ss', String(Number(o.start)))
  args.push('-i', file)
  if (o.maxSec > 0) args.push('-t', String(o.maxSec))
  args.push('-vf', `fps=${o.fps},scale=${w}:${h}:flags=area,format=${format}`, '-f', 'rawvideo', '-')
  const size = w * h * (format === 'rgb24' ? 3 : 1)

  return new Promise((resolve) => {
    const frames = []
    let buf = Buffer.alloc(0)
    let stopReason = ''
    let done = false
    let child = null
    const kill = (why) => { if (!stopReason) stopReason = why; try { child?.kill('SIGKILL') } catch { /* 已退出 */ } }
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { signal?.removeEventListener('abort', onAbort) } catch { /* ignore */ }
      resolve({ w, h, fps: o.fps, frames, dur: frames.length / o.fps, partial: Boolean(stopReason), stopReason })
    }
    const onAbort = () => kill('abort')
    const timer = setTimeout(() => kill('timeout'), Math.max(1000, Number(o.timeoutMs) || 120_000))

    if (signal) {
      if (signal.aborted) return finish()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try { child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return finish() }
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      const n = Math.floor(buf.length / size)
      if (!n) return
      for (let i = 0; i < n; i++) frames.push(new Uint8Array(buf.subarray(i * size, (i + 1) * size)))
      buf = buf.subarray(n * size)
      try { onFrame?.(frames) } catch { /* 回调不许拖垮解码 */ }
      if (stopReason) kill(stopReason)
    })
    child.stdout.on('error', finish)
    child.on('error', finish)     // ENOENT 等：old 版本会变成 unhandled error
    child.on('close', finish)
  })
}

/**
 * 读低分辨率灰度帧序列（rawvideo，一次 ffmpeg 解码，不落盘）。
 * @returns {Promise<{w:number,h:number,fps:number,frames:Uint8Array[],dur:number,partial:boolean}>}
 */
export async function readRaw(file, opts = {}, format = 'gray') {
  const o = { ...DEFAULTS, ...opts }
  return readRawStream(file, o, format, { signal: o.signal })
}

/** 细节密度（平均梯度）：文字/纹理/边缘多 → 高。给"这段看不看得清"一个量。 */
export function detailScore(frame, w, h) {
  if (!frame || frame.length < w * h) return 0
  let s = 0
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      s += Math.abs(frame[y * w + x + 1] - frame[y * w + x])
      n++
    }
  }
  return n ? s / n / 255 : 0
}

/**
 * 灰度版残差（含时间适应）—— 没有色度通道时的回退路径。
 * 判据与 diffSeriesColor 的亮度部分一致：全屏同向且幅度小 → 光线在变，置 0。
 */
export function diffSeriesAdaptive(frames, { lightingEps = 0.15, uniformityMin = 0.72 } = {}) {
  const out = new Array(frames.length).fill(0)
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    let absSum = 0
    let signSum = 0
    for (let k = 0; k < a.length; k++) {
      const d = b[k] - a[k]
      absSum += Math.abs(d)
      signSum += d
    }
    const absMean = absSum / a.length / 255
    const uni = Math.abs(signSum) / (absSum + 1e-9)
    out[i] = (uni > uniformityMin && absMean < lightingEps) ? 0 : absMean
  }
  return out
}

/** 灰度序列 → 残差曲线（兼容旧调用）。 */
export function motionOf(luma) {
  return diffSeriesAdaptive(luma.frames)
}

/** RGB 序列 → 残差曲线（亮度 + 色度补检）。新代码走这条。 */
export function motionOfColor(rgb) {
  return diffSeriesColor(rgb.frames)
}

/** 灰度低分辨率序列（残差/hotspot 的经典通道）。 */
export async function readLuma(file, opts = {}) {
  return readRaw(file, opts, 'gray')
}

/** RGB 低分辨率序列（色度通道用；每帧 w*h*3 字节）。 */
export async function readRgb(file, opts = {}) {
  return readRaw(file, opts, 'rgb24')
}

/** RGB 帧 → 灰度帧（0.299/0.587/0.114）。 */
export function grayFromRgb(rgb, w, h) {
  const out = new Uint8Array(w * h)
  for (let p = 0, q = 0; q < out.length; p += 3, q++) {
    out[q] = (0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2]) | 0
  }
  return out
}

/**
 * 色度残差（人眼的三色通道）—— 2026-11-08 补。
 *
 * 为什么必须补：灰度残差分不清"淡蓝换成淡黄"和"光线慢慢变亮"——
 * 前者在亮度上几乎不动（uni≈1、lumMean 小），会被时间适应判成"光线在变"而漏掉。
 * 人眼不会漏：视锥对色相变化非常敏感，这正是"整屏换色"能被一眼看到的原因。
 *
 * 判据（保留原有亮度残差体系不动，只在"判成光线变化"时用色度补检）：
 *   lighting（全屏同向且 lum 幅度小）→ 若 chromaMean > chromaEps 则算事件
 *   否则仍然用亮度残差
 * 色度用两个对立色轴 R-G / G-B，除以 2 归一到 0~1，避免两通道叠加放大。
 */
export function diffSeriesColor(frames, { lightingEps = 0.15, uniformityMin = 0.72, chromaEps = 0.05 } = {}) {
  const out = new Array(frames.length).fill(0)
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    const nPix = a.length / 3
    let lumAbs = 0
    let lumSign = 0
    let chromaAbs = 0
    for (let p = 0; p < a.length; p += 3) {
      const rA = a[p]
      const gA = a[p + 1]
      const bA = a[p + 2]
      const rB = b[p]
      const gB = b[p + 1]
      const bB = b[p + 2]
      const lA = 0.299 * rA + 0.587 * gA + 0.114 * bA
      const lB = 0.299 * rB + 0.587 * gB + 0.114 * bB
      const dl = lB - lA
      lumAbs += Math.abs(dl)
      lumSign += dl
      chromaAbs += Math.abs((rB - gB) - (rA - gA)) + Math.abs((gB - bB) - (gA - bA))
    }
    const lumMean = lumAbs / nPix / 255
    const chromaMean = chromaAbs / nPix / 255 / 2
    const uni = Math.abs(lumSign) / (lumAbs + 1e-9)
    const lighting = uni > uniformityMin && lumMean < lightingEps
    out[i] = lighting ? (chromaMean > chromaEps ? chromaMean : 0) : lumMean
  }
  return out
}

/** 逐帧平均绝对残差（0~1）。motion[0]=0（没有前一帧）。 */
export function diffSeries(frames) {
  const out = new Array(frames.length).fill(0)
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    let s = 0
    for (let k = 0; k < a.length; k++) s += Math.abs(b[k] - a[k])
    out[i] = s / a.length / 255
  }
  return out
}

/** 中位数（不被单帧爆炸带偏的"典型水平"）。 */
function median(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 把误差曲线切成事件（预测误差突变处 = 事件边界），再在事件内切"当下片"。
 * 事件是语义单元（一个镜头/一个动作），beat 是 3 秒知觉窗。
 */
export function segment(motion, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const fps = o.fps
  const n = motion.length
  if (!n) return { events: [], cuts: [], meanErr: 0 }
  // 这条片子自己的"常态残差"（meanErr 用于诊断；不再用作硬切阈值 —— 见下）
  const base = median(motion.slice(1))
  // 硬切：绝对阈值 + 局部极大（一帧的残差明显高于前后帧）。
  // 早先用"≥ 本片中位数的 4 倍"，在**整片都在变**的素材上必然失效：
  // 10 段 × 0.3 秒的快切里几乎每帧都是切换，中位数被抬高 → 一个切点都不剩，
  // 整条被描述成"0-3.3s 有动作"（2026-11-08 实测）。局部极大没有这个盲区。
  const hards = []
  for (let i = 1; i < n; i++) {
    const v = motion[i]
    if (v < o.cutEps) continue
    const prev = motion[i - 1] || 0
    const next = i + 1 < n ? motion[i + 1] : 0
    if (v >= prev && v >= next) hards.push(i)
  }
  // 上限保护：整片高速运动时"每帧都是极大"，不设限会切出上百个事件。
  const MAX_CUTS = 40
  if (hards.length > MAX_CUTS) {
    const top = hards.map((i) => [i, motion[i]]).sort((a, b) => b[1] - a[1]).slice(0, MAX_CUTS).map((x) => x[0]).sort((a, b) => a - b)
    hards.length = 0
    hards.push(...top)
  }
  // 边界（帧号）→ 至少留 minEvent 秒，去掉贴边的重复切点。
  // 快切自适应（2026-11-08 实测）：10 段 × 0.3 秒的 MV 被 minEvent=0.5 合并成 1 段，
  // 时间线只剩"0-3.3s 有动作"。硬切密集（中位间隔 < 0.75 秒）时按 0.3 秒去重，
  // 慢片仍用 minEvent —— 否则一帧抖动就切一条，事件列表爆炸。
  const gaps = []
  for (let i = 1; i < hards.length; i++) gaps.push(hards[i] - hards[i - 1])
  const medGap = gaps.length ? median(gaps) : Infinity
  const fast = gaps.length >= 3 && medGap <= fps * 0.75
  const minFrames = Math.max(1, Math.round((fast ? Math.min(0.3, o.minEvent) : o.minEvent) * fps))
  const cuts = []
  for (const c of hards) {
    if (!cuts.length || c - cuts[cuts.length - 1] >= minFrames) cuts.push(c)
  }
  const bounds = [0, ...cuts, n]
  const events = []
  const stat = (i0, i1) => {
    // 边界帧（i0）的 motion 是"上一段到这一段"的切换量，不是本段内部的变化。
    // 把它算进来会让每个事件都带上一次切换的峰值 —— 实测把静止的绿段判成"有动作"。
    const a = i0 > 0 ? i0 + 1 : i0
    const seg = motion.slice(a, Math.max(a + 1, i1))
    const mean = seg.reduce((x, y) => x + y, 0) / seg.length
    let peak = 0
    let peakAt = i0 / fps
    for (let i = a; i < i1; i++) if (motion[i] > peak) { peak = motion[i]; peakAt = i / fps }
    return { err: mean, peak, peakAt, cutIn: i0 > 0 ? motion[i0] : 0 }
  }
  for (let k = 0; k < bounds.length - 1; k++) {
    const i0 = bounds[k]
    const i1 = bounds[k + 1]
    if (i1 <= i0) continue
    const s = stat(i0, i1)
    events.push({
      t0: i0 / fps,
      t1: i1 / fps,
      i0,
      i1,
      err: s.err,
      peak: s.peak,
      peakAt: s.peakAt,
      cutIn: s.cutIn,
      // 「静止」= 段内没变化，**而且**这一段不是快速剪辑里的一闪而过。
      // 为什么需要 cutIn + 时长两个条件（2026-11-08 两次踩坑）：
      //   · 只看段内残差：快切片每一段都"内部静止"，全被判 static → 整条只出一张图；
      //   · 再加上 cutIn：2 秒的绿色静止段因为"以硬切开始"也被判成非静止 → 白送一张图。
      // 所以：切进来但**持续够久**（≥1s）的段，仍然是"静止画面"。
      static: s.err < o.staticEps && s.peak < o.motionEps && (s.cutIn < o.cutEps || (i1 - i0) / fps >= 1),
      beats: beatsIn(i0, i1, fps, o.beatSec),
    })
  }
  // 长事件强制再切（人的"现在"装不下 6 秒以上）
  const split = []
  for (const e of events) {
    const maxFrames = Math.round(o.maxEvent * fps)
    if (e.i1 - e.i0 <= maxFrames) { split.push(e); continue }
    for (let a = e.i0; a < e.i1; a += maxFrames) {
      const b = Math.min(e.i1, a + maxFrames)
      const s = stat(a, b)
      split.push({
        t0: a / fps, t1: b / fps, i0: a, i1: b,
        err: s.err, peak: s.peak, peakAt: s.peakAt, cutIn: s.cutIn,
        static: s.err < o.staticEps && s.peak < o.motionEps && (s.cutIn < o.cutEps || (b - a) / fps >= 1),
        beats: beatsIn(a, b, fps, o.beatSec),
      })
    }
  }
  return { events: split, cuts: cuts.map((c) => c / fps), meanErr: base }
}

function beatsIn(i0, i1, fps, beatSec) {
  const per = Math.max(1, Math.round(beatSec * fps))
  const out = []
  for (let a = i0; a < i1; a += per) out.push({ t0: a / fps, t1: Math.min(i1, a + per) / fps })
  return out
}

/**
 * 注视点：残差**集中**的那块区域（中央凹该落在哪）。
 *
 * 早先按行列投影取 20% 能量 span，结果整帧轻微编码噪声会把 bbox 撑满全宽 ——
 * 而人眼恰恰不是"平均分配注意"，是"抑制均匀噪声、盯住集中变化"。
 * 所以先按均值做阈值（均匀噪声被压掉），只对超阈的格子求包围盒。
 * @returns {{x:number,y:number,w:number,h:number,global:boolean,mass:number}|null}
 *   global=true 表示变化铺满画面（整屏切换/光照突变），这时 crop 没有意义。
 */
export function hotspot(prev, cur, w, h) {
  const d = new Float32Array(w * h)
  let total = 0
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(cur[i] - prev[i])
    d[i] = v
    total += v
  }
  const mean = total / d.length
  if (mean < 1e-6) return null
  const thr = Math.max(mean * 1.8, 4)
  let minX = w, minY = h, maxX = -1, maxY = -1, hit = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[y * w + x] >= thr) {
        hit++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const mass = hit / d.length
  if (!hit || mass > 0.55) return { x: 0, y: 0, w: 1, h: 1, global: true, mass }
  // 扩展 1.4×（别把物体的上下文切掉），再夹回画面内
  const cx = (minX + maxX + 1) / 2 / w
  const cy = (minY + maxY + 1) / 2 / h
  const hw = clamp(((maxX - minX + 1) / w) * 0.7, 0.08, 1)
  const hh = clamp(((maxY - minY + 1) / h) * 0.7, 0.08, 1)
  const bx = clamp(cx - hw, 0, Math.max(0, 1 - hw * 2))
  const by = clamp(cy - hh, 0, Math.max(0, 1 - hh * 2))
  return { x: bx, y: by, w: Math.min(1 - bx, hw * 2), h: Math.min(1 - by, hh * 2), global: false, mass }
}

/**
 * 拼贴：把一段的连续帧压成一张网格图（看动作轨迹，一格 = 1/fps 秒）。
 *
 * 每格左上角写采样序号（0,1,2…）。加它是为了纠正一个实测误读：
 * 没有序号时，视觉模型会把"第二行更靠右"读成"物体在画面里往下走"（2026-11-08 实测：
 * 水平移动的方块被描述成"向左下方斜向滑动"）。序号把"换行"和"空间位移"分开。
 */
export async function renderTile(file, t0, dur, { cols = 4, rows = 3, cellW = 320, cellH = 180, label = true, out, ffmpeg = 'ffmpeg', timeoutMs = 30_000 } = {}) {
  const n = cols * rows
  const fps = Math.max(0.5, n / Math.max(0.2, dur))
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  const labelFilter = label
    ? `,drawtext=fontfile=${font}:text='%{eif\\:n\\:d}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=3`
    : ''
  await execFileP(ffmpeg, [
    '-v', 'error', '-y', '-ss', String(Math.max(0, t0)), '-t', String(Math.max(0.2, dur)),
    '-i', file,
    '-vf', `fps=${fps.toFixed(4)},scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2${labelFilter},tile=${cols}x${rows}:padding=2:margin=0`,
    '-frames:v', '1', '-q:v', '3', out,
  ], { timeout: timeoutMs })
  return fs.existsSync(out) ? out : null
}

/** 高分辨率注视图（中央凹）：按归一化 bbox 裁原片再放大。 */
export async function renderCrop(file, at, box, { outW = 640, out, ffmpeg = 'ffmpeg', timeoutMs = 30_000 } = {}) {
  const b = box || { x: 0, y: 0, w: 1, h: 1 }
  const cx = clamp(b.x, 0, 0.999)
  const cy = clamp(b.y, 0, 0.999)
  const cw = clamp(b.w, 0.02, 1 - cx)
  const ch = clamp(b.h, 0.02, 1 - cy)
  await execFileP(ffmpeg, [
    '-v', 'error', '-y', '-ss', String(Math.max(0, at)), '-i', file,
    '-frames:v', '1',
    '-vf', `crop=iw*${cw.toFixed(4)}:ih*${ch.toFixed(4)}:iw*${cx.toFixed(4)}:ih*${cy.toFixed(4)},scale='min(${outW},iw*2)':-2:flags=lanczos`,
    '-q:v', '3', out,
  ], { timeout: timeoutMs })
  return fs.existsSync(out) ? out : null
}

/** 单张全帧（事件首帧 / 兜底）。不放大（省 token），但下限 960 —— 1080p 片子缩到 640 后
 * 12px 的字只剩 4px，OCR 必瞎；960 是"字还看得出"的最低档（2026-11-08 实测）。 */
export async function renderKey(file, at, { outW = 960, out, ffmpeg = 'ffmpeg', timeoutMs = 30_000 } = {}) {
  await execFileP(ffmpeg, [
    '-v', 'error', '-y', '-ss', String(Math.max(0, at)), '-i', file,
    '-frames:v', '1', '-vf', `scale='min(${outW},iw)':-2:flags=lanczos`, '-q:v', '3', out,
  ], { timeout: timeoutMs })
  return fs.existsSync(out) ? out : null
}

/**
 * 粗扫：全片 1Hz 残差曲线（只解关键帧，成本约细看的 1/10）。
 * 用途只有一个 —— 长视频里**找出值得细看的位置**，不做任何判断。
 * @returns {Promise<null|{dur:number, fps:number, truncated:boolean, points:Array<{t:number,err:number}>}>}
 */
export async function coarseScan(file, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const cap = Number(o.coarseMaxSec ?? 1800)
  try {
    const rgb = await readRgb(file, { ...o, fps: 1, skipFrame: true, start: 0, maxSec: cap })
    if (rgb.frames.length < 3) return null
    const motion = motionOfColor(rgb)
    return {
      dur: rgb.dur,
      fps: 1,
      truncated: cap > 0 && rgb.dur >= cap - 0.5,
      points: motion.map((v, i) => ({ t: i, err: v })),
    }
  } catch (e) { swallow(e, 'retina:coarse'); return null }
}

/**
 * 从粗扫曲线挑窗口（长视频只看这些段）。
 *
 * 仿生依据：人看长视频不是"从头看到尾"，也不是"均匀快进"——
 * 是**被高信息量的地方吸引**（说话、动作、切换），中间过渡段被跳过。
 * 所以：粗扫残差取局部峰 → 峰附近 ±1.5 秒成窗 → 重叠合并 → 均匀保底。
 * @param {{points:Array<{t:number,err:number}>}|null} coarse
 * @param {{dur:number, budgetSec:number, windowSec?:number, maxWindows?:number}} o
 * @returns {Array<{t0:number,t1:number}>}
 */
export function pickWindows(coarse, o = {}) {
  const dur = Math.max(0.3, Number(o.dur) || 0)
  const windowSec = Math.max(1, Number(o.windowSec) || 3)
  const budget = Math.max(windowSec, Number(o.budgetSec) || windowSec * 4)
  const K = Math.max(2, Math.min(Number(o.maxWindows) || 8, Math.floor(budget / windowSec)))
  const uniform = (n) => {
    const step = dur / n
    return Array.from({ length: n }, (_, i) => ({ t: Math.min(dur, i * step + step / 2), err: 0 }))
  }
  let picked = []
  if (coarse?.points?.length) {
    const peaks = coarse.points.slice(1)
      .filter((p) => Number(p.err) >= 0.008)
      .sort((a, b) => b.err - a.err)
    for (const p of peaks) {
      if (picked.length >= K) break
      if (picked.every((q) => Math.abs(q.t - p.t) >= windowSec)) picked.push(p)
    }
  }
  // 保底：至少 2 个均匀点（防止"全片只有一个高光"时其余时间完全没看）
  const need = Math.max(0, Math.min(2, K - picked.length))
  for (const u of uniform(need || 1)) {
    if (picked.length >= K) break
    if (picked.every((q) => Math.abs(q.t - u.t) >= windowSec)) picked.push(u)
  }
  if (!picked.length) picked = uniform(Math.min(K, 2))
  picked.sort((a, b) => a.t - b.t)
  // 成窗 + 合并重叠（重叠段重复解码没有意义）
  const wins = []
  for (const p of picked) {
    const t0 = Math.max(0, p.t - windowSec / 2)
    const t1 = Math.min(dur, p.t + windowSec / 2)
    const last = wins[wins.length - 1]
    if (last && t0 <= last.t1 + 0.4) { last.t1 = Math.max(last.t1, t1); continue }
    wins.push({ t0, t1 })
  }
  return wins
}

/**
 * 一次完整分析（不碰模型、不落图）：给 watch.mjs 的"视网膜层"。
 *
 * 短于预算：整段分析（老行为）。
 * 长于预算：**粗扫选窗 + 逐窗细看**（2026-11-08）。理由：原来 `maxSec` 直接截前 120 秒，
 * 30 分钟的片子等于只看开头 —— 而开头往往是最不重要的部分（片头/寒暄）。
 * @param {object} [opts]
 * @param {number} [opts.budgetSec] 总共愿意看多少秒；给 0 表示看全片
 * @param {number} [opts.maxSec]    单窗硬上限（兼容旧调用：0..maxSec）
 * @returns {Promise<null|{dur,fps,w,h,nFrames,frames,motion,events,cuts,meanErr,segments,truncated}>}
 */
export async function analyze(file, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const signal = o.signal
  try {
    const dur = Number(o.dur) || (await probeDur(file)) || 0
    const budget = Number(o.budgetSec || 0)
    let windows
    if (budget > 0 && dur > budget) {
      const coarse = await coarseScan(file, o)
      windows = pickWindows(coarse, { dur, budgetSec: budget, windowSec: o.windowSec || 3, maxWindows: o.maxWindows || 8 })
    } else {
      windows = [{ t0: 0, t1: o.maxSec > 0 ? (dur ? Math.min(o.maxSec, dur) : o.maxSec) : dur }]
    }

    const frames = []
    const events = []
    const cuts = []
    const segments = []
    let nFrames = 0
    let meanErrSum = 0
    let fpsUsed = o.fps
    for (const w of windows) {
      // 用户插话时立刻停：已经解过的窗口留着（partial），后面的不再解。
      if (signal?.aborted) break
      const span = Math.max(0.3, w.t1 - w.t0)
      // 一次解码拿 RGB：色度残差和灰度残差共用同一批帧（避免解两遍）。
      const rgb = await readRgb(file, { ...o, start: w.t0, maxSec: span, skipFrame: false, signal })
      if (!rgb.frames.length) { if (signal?.aborted || rgb.stopReason) break; continue }
      const luma = {
        w: rgb.w, h: rgb.h, fps: rgb.fps, dur: rgb.dur,
        frames: rgb.frames.map((f) => grayFromRgb(f, rgb.w, rgb.h)),
      }
      let motion = motionOfColor(rgb)
      let seg = segment(motion, { ...o, fps: rgb.fps })
      // 单窗内的高切换自适应（只对短窗做，长片不做：多一次解码不划算）
      const gaps = []
      for (let i = 1; i < seg.cuts.length; i++) gaps.push(seg.cuts[i] - seg.cuts[i - 1])
      gaps.sort((a, b) => a - b)
      const medGapSec = gaps.length ? gaps[gaps.length >> 1] : Infinity
      const dense = seg.cuts.length >= 3 && medGapSec <= 3 / luma.fps
      const rate = seg.cuts.length / Math.max(0.5, luma.dur)
      const fps2 = Math.min(12, luma.fps * 2)
      if (!signal?.aborted && !rgb.partial && (dense || rate > 0.8) && fps2 > luma.fps && luma.dur <= 60) {
        const rgb2 = await readRgb(file, { ...o, start: w.t0, maxSec: span, fps: fps2, skipFrame: false, signal })
        if (rgb2.frames.length) {
          const m2 = motionOfColor(rgb2)
          const s2 = segment(m2, { ...o, fps: rgb2.fps })
          if (s2.cuts.length > seg.cuts.length) {
            luma.frames = rgb2.frames.map((f) => grayFromRgb(f, rgb2.w, rgb2.h))
            luma.fps = rgb2.fps
            motion = m2
            seg = s2
          }
        }
      }
      for (const e of seg.events) {
        // 细节密度：这段画面里"有多少可辨认的东西"（文字/纹理/边缘）。
        // 用它区分"快速运动但什么也看不清"和"慢动作但细节清楚"——
        // 人眼对这两种的可信度完全不同，模型也该知道。
        const di = Math.max(0, Math.min(luma.frames.length - 1, Math.round(e.peakAt * luma.fps)))
        events.push({
          ...e,
          t0: e.t0 + w.t0,
          t1: e.t1 + w.t0,
          peakAt: e.peakAt + w.t0,
          detail: detailScore(luma.frames[di], luma.w, luma.h),
          // 全局帧号：多窗口拼接后 hotspot 必须按它取帧（peakAt*fps 只对单窗成立）
          gpeak: nFrames + Math.round(e.peakAt * luma.fps),
          win: [w.t0, w.t1],
        })
      }
      cuts.push(...seg.cuts.map((c) => c + w.t0))
      frames.push(...luma.frames)
      nFrames += luma.frames.length
      meanErrSum += seg.meanErr
      fpsUsed = luma.fps
      // 实际覆盖到哪：正常 = 整窗；被 abort/超时截断 = 解到的那一段。
      // 这两个数决定时间线敢不敢说"这段我看过了"（没看不能说静止）。
      segments.push({ t0: w.t0, t1: Math.min(w.t1, w.t0 + Math.max(rgb.dur, 1 / rgb.fps)), partial: Boolean(rgb.partial) })
      // 增量印象（2026-11-08）：解完一个窗口就交付一次「已经看到的物理事实」。
      // 这是"边看边知道"的关键一步 —— 不再等整片 decode 完才有第一句话。
      if (typeof o.onProgress === 'function') {
        try {
          const evs = seg.events || []
          o.onProgress({
            t0: Number(w.t0.toFixed(2)),
            t1: Number(Math.min(w.t1, w.t0 + Math.max(rgb.dur, 1 / rgb.fps)).toFixed(2)),
            cuts: evs.filter((e) => Number(e.cutIn) > Number(o.cutEps ?? DEFAULTS.cutEps)).length,
            moved: evs.filter((e) => !e.static).length,
            peak: evs.reduce((mx, e) => Math.max(mx, Number(e.peak) || 0), 0),
            detail: Number(evs.length ? evs[evs.length - 1].detail : 0) || 0,
            partial: Boolean(rgb.partial),
            windowsDone: segments.length,
          })
        } catch { /* 回调不许拖垮解码 */ }
      }
      if (rgb.partial) break
    }
    if (!frames.length) return null
    const watchedTo = segments.length ? Math.max(...segments.map((s) => s.t1)) : 0
    const totalDur = Math.max(Number(dur) || 0, watchedTo, 0)
    return {
      dur: totalDur,
      watchedTo: Number(watchedTo.toFixed(2)),
      partial: Boolean(signal?.aborted) || segments.some((s) => s.partial),
      fps: fpsUsed,
      w: o.cellW,
      h: o.cellH,
      nFrames: frames.length,
      frames,
      motion: [],
      events,
      cuts,
      meanErr: segments.length ? meanErrSum / segments.length : 0,
      segments,
      truncated: segments.length > 1 && dur > 0 && segments.reduce((a, s) => a + (s.t1 - s.t0), 0) < dur * 0.6,
    }
  } catch (e) {
    swallow(e, 'retina:analyze')
    return null
  }
}

/** 临时目录（调用方负责 rm）。 */
export function tmpDir(prefix = 'bot-eye-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ── 注视点显著性（人脸肤色 / 细节密集区）──────────────────────────────────
//
// 为什么要单独抽帧（2026-11-08）：残差网格是 32×18 —— 在那上面做不了肤色和人脸，
// 也看不清文字。人眼选注视点不是只看"哪在动"：静止画面里出现一张脸，注意力立刻过去；
// 字幕条也一样。所以这里在**中等分辨率**（默认 160×90）上另算一套显著性，
// 只给"出图选哪里"用，不参与事件切分（避免把整条链路的重心拽偏）。
//
// 诚实边界：这不是人脸识别，是**肤色连通区域**（YCbCr 经典范围）+ **细节密度**。
// 所以措辞只能是"像人脸/大片肤色"，不能断言"这是谁"。

/**
 * 抽一帧中等分辨率 RGB（一次 ffmpeg，~30ms）。
 * @returns {Promise<null|{w:number,h:number,rgb:Uint8Array}>}
 */
export async function readFrameRgb(file, at, { w = 160, h = 90, ffmpeg = 'ffmpeg', timeoutMs = 15_000 } = {}) {
  try {
    const { stdout } = await execFileP(ffmpeg, [
      '-v', 'error', '-ss', String(Math.max(0, Number(at) || 0)), '-i', file,
      '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', '-',
    ], { timeout: timeoutMs, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
    const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
    if (buf.length < w * h * 3) return null
    return { w, h, rgb: buf.subarray(0, w * h * 3) }
  } catch { return null }
}

/**
 * 在中等分辨率帧上找两类"不靠运动也值得看"的区域。
 *
 * @param {Uint8Array} rgb
 * @param {number} w
 * @param {number} h
 * @param {{gw?:number,gh?:number,skinRatio?:number,detailDensity?:number}} [o]
 * @returns {{
 *   skin: null|{box:{x:number,y:number,w:number,h:number}, ratio:number, cells:number},
 *   detail: null|{box:{x:number,y:number,w:number,h:number}, density:number},
 *   skinRatio:number, edgeMean:number,
 * }}
 */
export function detectSalient(rgb, w, h, { gw = 16, gh = 9, skinRatio = 0.35, detailDensity = 0.12 } = {}) {
  const out = { skin: null, detail: null, skinRatio: 0, edgeMean: 0 }
  if (!rgb || rgb.length < w * h * 3) return out
  const bw = Math.max(1, Math.floor(w / gw))
  const bh = Math.max(1, Math.floor(h / gh))
  let skinTotal = 0
  let edgeTotal = 0
  let nTotal = 0
  const cells = []
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      let skin = 0
      let edgeHi = 0
      let edgeSum = 0
      let n = 0
      for (let y = cy * bh; y < Math.min(h, (cy + 1) * bh); y++) {
        for (let x = cx * bw; x < Math.min(w, (cx + 1) * bw); x++) {
          const p = (y * w + x) * 3
          const r = rgb[p]
          const g = rgb[p + 1]
          const b = rgb[p + 2]
          const Y = 0.299 * r + 0.587 * g + 0.114 * b
          const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
          const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
          if (Y > 40 && Cb >= 77 && Cb <= 127 && Cr >= 133 && Cr <= 173) skin++
          // 简化梯度（右、下各一个邻居；越界按 0）
          const pr = x + 1 < w ? (y * w + x + 1) * 3 : p
          const pd = y + 1 < h ? ((y + 1) * w + x) * 3 : p
          const gx = Math.abs(rgb[pr] - r) + Math.abs(rgb[pr + 1] - g) + Math.abs(rgb[pr + 2] - b)
          const gy = Math.abs(rgb[pd] - r) + Math.abs(rgb[pd + 1] - g) + Math.abs(rgb[pd + 2] - b)
          const e = (gx + gy) / 3
          edgeSum += e
          if (e > 18) edgeHi++
          n++
        }
      }
      if (!n) continue
      const sr = skin / n
      const ed = edgeHi / n
      skinTotal += skin
      edgeTotal += edgeSum / n
      nTotal += n
      cells.push({ cx, cy, sr, ed })
    }
  }
  out.skinRatio = nTotal ? skinTotal / nTotal : 0
  out.edgeMean = cells.length ? edgeTotal / cells.length : 0
  const boxOf = (list, grow = 1.2) => {
    if (!list.length) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -1
    let y1 = -1
    for (const c of list) {
      if (c.cx < x0) x0 = c.cx
      if (c.cy < y0) y0 = c.cy
      if (c.cx > x1) x1 = c.cx
      if (c.cy > y1) y1 = c.cy
    }
    const cx0 = x0 / gw
    const cy0 = y0 / gh
    const cw = (x1 + 1 - x0) / gw
    const ch = (y1 + 1 - y0) / gh
    const hw = Math.min(1, cw * grow) / 2
    const hh = Math.min(1, ch * grow) / 2
    const mx = Math.min(1 - hw * 2, Math.max(0, cx0 + cw / 2 - hw))
    const my = Math.min(1 - hh * 2, Math.max(0, cy0 + ch / 2 - hh))
    return { x: mx, y: my, w: Math.min(1 - mx, hw * 2), h: Math.min(1 - my, hh * 2) }
  }
  const skinCells = cells.filter((c) => c.sr >= skinRatio)
  if (skinCells.length >= 2) {
    const box = boxOf(skinCells, 1.15)
    const area = box.w * box.h
    const edAvg = skinCells.reduce((a, c) => a + c.ed, 0) / skinCells.length
    // 两条排除（2026-11-08 实测）：木色/沙色桌面整屏落在肤色范围里（skinRatio=1.0），
    // 会被误判成"一张大脸"。真人的脸：①不会占满画面 ②有五官，边缘不会为零。
    const plausible = area <= 0.45 && edAvg >= 0.015
    const entry = { box, ratio: out.skinRatio, cells: skinCells.length, area, edge: edAvg }
    if (plausible) out.skin = entry
    else out.skinWeak = entry
  }
  const detailCells = cells.filter((c) => c.ed >= detailDensity)
  if (detailCells.length >= 2) {
    out.detail = { box: boxOf(detailCells, 1.1), density: detailCells.length / cells.length }
  }
  return out
}

// ── 人脸跟踪（口型近似）──────────────────────────────────────────────────
//
// 2026-11-08：为了判断"是谁在说话"，只靠"有声音+画面静不静"不够。
// 用 OpenCV 的 YuNet（232KB，装在人脸专用的小模型目录里）+ 5 个关键点：
//   脸框内帧间差 → faceMotion（整张脸动多少）
//   两嘴角之间的区域帧间差 → mouthMotion（说话时这里最活跃）
// **不做身份识别、不做表情判断**，只回答"说话的时候这张脸的嘴在不在动"。
//
// 依赖（容器）：/home/dsh/.data/asr-venv 里的 opencv-python-headless（5.0 起
// 没有 CascadeClassifier，所以走 DNN 的 FaceDetectorYN）+ yunet.onnx。
// 缺任何一样就把 facesReady() 判 false，整条链路静默降级（回到肤色+静止判断）。

const FACE_PY = () => process.env.BOT_FACE_PYTHON || '/home/dsh/.data/asr-venv/bin/python'
const FACE_MODEL = () => process.env.BOT_FACE_MODEL || '/home/dsh/.data/face-models/yunet.onnx'
const FACE_SCRIPT = () => process.env.BOT_FACE_SCRIPT || path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'face-track.py')

let _faceReady = null
/** 人脸跟踪能不能用（python + cv2 + 模型 + 脚本都在）。缓存一次。 */
export function facesReady() {
  if (_faceReady !== null) return _faceReady
  try {
    _faceReady = fs.existsSync(FACE_PY()) && fs.existsSync(FACE_MODEL()) && fs.existsSync(FACE_SCRIPT())
  } catch { _faceReady = false }
  return _faceReady
}

/**
 * 人脸时间线（每 1/fps 秒一行）。
 * @returns {Promise<null|{fps:number, frames:Array<{t:number, faces:Array}>}>}
 */
export async function faces(file, { fps = 2, maxSec = 0, timeoutMs = 90_000 } = {}) {
  if (!facesReady()) return null
  try {
    const { stdout } = await execFileP(FACE_PY(), [FACE_SCRIPT(), file, String(fps), String(maxSec), FACE_MODEL()], {
      timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    })
    const lines = String(stdout || '').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim()
      if (!l.startsWith('{')) continue
      try { return JSON.parse(l) } catch { /* 继续找 */ }
    }
    return null
  } catch (e) { swallow(e, 'retina:faces'); return null }
}

/** 抽帧 + 检测（一次调用）。 */
export async function inspectSalient(file, at, opts = {}) {
  const fr = await readFrameRgb(file, at, opts)
  if (!fr) return null
  return { at: Number(at) || 0, ...detectSalient(fr.rgb, fr.w, fr.h, opts) }
}
