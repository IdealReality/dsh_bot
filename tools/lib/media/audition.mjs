// audition —— 听觉前端：不问"音频多长"，问"什么时候有声音、是什么声音、谁在说话"。
//
// 为什么单独一层（2026-11-08）：
//   bili-audio 把"取流 + 转写"焊在 B站 bvid 上，QQ 视频、本地文件、以后的通道都用不到。
//   而人听一段视频的动作其实是三段、可分别验证的：
//     ① 抽音轨（外耳到耳蜗：把物理波形变成统一的 16k 单声道）
//     ② 有声/无声分段（耳蜗核 + VAD：静音不进入语言系统，省下的算力给有声段）
//     ③ 分成两路：
//          · 语音 → whisper（左半球/语言）→ 带时间码的台词
//          · 非语音 → 能量包络（右半球/环境声）→ 突发/持续/安静
//   三层分开之后，浏览器里的视频、QQ 视频、B站视频走同一套耳朵。
//
// 硬原则（沿用 bili-audio）：
//   · 失败返回 {ok:false, why}，**绝不编造台词**；
//   · "听到了哪一秒"用 heardTo，不是音频总长（VAD 短转不许当成听完）。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { swallow } from '../infra/swallow.mjs'
import { asrReady, transcribe, whyNoHear, setHearWhy, mmss, squashRepeats, asrCfg } from './asr-core.mjs'

const execFileP = promisify(execFile)

/**
 * 抽 16k 单声道 wav（whisper 的唯一输入形态）。
 * @returns {Promise<{wav:string, dur:number}|null>}
 */
export async function extractWav(file, { out, maxSec = 0, ffmpeg = 'ffmpeg', timeoutMs = 180_000 } = {}) {
  try {
    const args = ['-v', 'error', '-y', '-i', file, '-vn']
    if (maxSec > 0) args.push('-t', String(maxSec))
    args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out)
    await execFileP(ffmpeg, args, { timeout: timeoutMs })
    const st = fs.statSync(out)
    if (st.size < 1600) return null   // 0.05 秒都没有 → 视为没有音轨
    return { wav: out, bytes: st.size, dur: (st.size - 44) / 32000 }
  } catch {
    return null
  }
}

/**
 * 静音检测（人耳的"无声段不进语言系统"）。
 * @returns {Promise<{silences:Array<[number,number]>, dur:number}>}
 */
export async function silences(wav, { noiseDb = -38, minDur = 0.35, ffmpeg = 'ffmpeg', timeoutMs = 120_000 } = {}) {
  const out = { silences: [], dur: 0 }
  try {
    const { stderr } = await execFileP(ffmpeg, [
      '-hide_banner', '-i', wav,
      '-af', `silencedetect=n=${noiseDb}dB:d=${minDur}`,
      '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }).catch((e) => ({ stderr: String(e?.stderr || '') }))
    const txt = String(stderr || '')
    const d = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(txt)
    if (d) out.dur = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])
    let start = null
    for (const line of txt.split('\n')) {
      const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
      if (s) start = Math.max(0, Number(s[1]))
      const e = /silence_end:\s*([\d.]+)/.exec(line)
      if (e && start != null) { out.silences.push([start, Number(e[1])]); start = null }
    }
  } catch (e) { swallow(e, 'audition:silences') }
  return out
}

/** 从静音表反推"有声段"（人实际在听的部分）。 */
function voicedSpans(silences, dur) {
  const spans = []
  let cur = 0
  for (const [a, b] of silences) {
    if (a > cur) spans.push([cur, a])
    cur = Math.max(cur, b)
  }
  if (dur > cur) spans.push([cur, dur])
  return spans.filter(([a, b]) => b - a > 0.05)
}

/**
 * 听一段媒体。
 *
 * @param {string} file 本地媒体路径（任意 ffmpeg 能解的容器）
 * @param {{maxSec?:number, lang?:string, outDir?:string, model?:string, timeoutMs?:number, speech?:boolean}} [opts]
 * @returns {Promise<{
 *   ok:boolean, why:string, dur:number, heardTo:number,
 *   segs:Array<{start:number,end:number,text:string}>,
 *   lines:string[], text:string,
 *   voicedRatio:number, speechRatio:number,
 *   silences:Array<[number,number]>, spans:Array<[number,number]>,
 *   events:Array<{t:number, kind:string, strength:number}>,
 *   device:object|null, elapsed:number,
 * }>}
 */
export async function listen(file, opts = {}) {
  const o = {
    maxSec: 0,
    lang: 'zh',
    model: process.env.BOT_ASR_MODEL,
    timeoutMs: 0,
    speech: true,
    outDir: null,
    ...opts,
  }
  const res = {
    ok: false, why: '', dur: 0, heardTo: 0, segs: [], lines: [], text: '',
    voicedRatio: 0, speechRatio: 0, silences: [], spans: [], events: [], device: null, elapsed: 0,
    textures: null,
  }
  const dir = o.outDir || fs.mkdtempSync('/tmp/bot-ear-')
  const own = !o.outDir
  const wav = path.join(dir, 'a.wav')
  // 中止（用户插话）：立刻收手，把已经拿到的部分（可能只有声音类型）交出去。
  // 之所以每个阶段都查一次，是因为 whisper 转写要几十秒 —— 等他插话才停就晚了。
  const aborted = () => Boolean(o.signal?.aborted)
  try {
    if (aborted()) { res.why = '被打断了（还没开始听）'; return res }
    const ex = await extractWav(file, { out: wav, maxSec: o.maxSec })
    if (!ex) { res.why = '没有音轨（或音轨短到没有内容）'; return res }
    res.dur = ex.dur > 0 ? ex.dur : 0

    // 有声段（VAD 的前置：先知道哪儿有声音）
    const sil = await silences(wav)
    if (!res.dur) res.dur = sil.dur || ex.dur
    res.silences = sil.silences
    res.spans = voicedSpans(sil.silences, res.dur)
    const voiced = res.spans.reduce((a, [x, y]) => a + (y - x), 0)
    res.voicedRatio = res.dur > 0 ? voiced / res.dur : 0
    // 突发：一段有声开始之前有 ≥0.4s 静音（"突然响了一下"）
    res.events = res.spans
      .map(([a]) => a)
      .filter((t) => t > 0.05 && res.silences.some(([x, y]) => Math.abs(y - t) < 0.05 && y - x >= 0.4))
      .map((t) => ({ t, kind: 'onset', strength: 1 }))

    // 先认"是什么声音"（纯本地、无模型）—— ASR 没装好也能给出一句
    res.textures = await texture(wav).catch(() => null)
    if (aborted()) { res.ok = true; res.why = '被打断了（只听到声音类型）'; return res }

    if (!o.speech) { res.ok = true; return res }
    if (!asrReady()) { res.why = 'ASR 没装好（ffmpeg 或 faster-whisper 缺）'; res.ok = true; return res }

    const cap = o.maxSec > 0 ? o.maxSec : 0
    const timeoutMs = o.timeoutMs || Math.max(120_000, Math.min(30 * 60_000, (cap || res.dur || 600) * 5000))
    const r = await transcribe(wav, { lang: o.lang, model: o.model, maxSeconds: 0, timeoutMs, signal: o.signal })
    if (aborted()) { res.ok = true; res.why = '被打断了（在转写）'; return res }
    if (!r) { res.why = whyNoHear() || '转写没有输出'; res.ok = true; return res }
    res.device = r.device || null
    res.elapsed = Number(r.elapsed || 0)
    res.heardTo = Number(r.heardTo || 0)
    res.segs = (r.segs || []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || '') })).filter((s) => s.text)
    const speechDur = res.segs.reduce((a, s) => a + Math.max(0, s.end - s.start), 0)
    res.speechRatio = res.dur > 0 ? Math.min(1, speechDur / res.dur) : 0
    // 3 秒一行的台词表（和视觉的"当下片"同尺度）
    res.lines = res.segs.length ? lineWindows(res.segs, 3) : []
    res.text = res.lines.join('\n')
    // 有声音但几乎没识别到语音 → 大概率是音乐/音效/噪声（不是"没人说话"）
    if (!res.segs.length && res.voicedRatio > 0.25) {
      res.events.push({ t: res.spans[0]?.[0] ?? 0, kind: 'non-speech', strength: Math.min(1, res.voicedRatio) })
    }
    res.ok = true
    return res
  } catch (e) {
    setHearWhy('audition 异常：' + String(e?.message ?? e).slice(0, 160))
    res.why = whyNoHear()
    return res
  } finally {
    if (own) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
}

// ── 声音纹理（不听人话，只认"这是什么声音"）─────────────────────────────
//
// 2026-11-08：以前这一层只会说"有声音但不是人话（音乐/环境声）"——等于没听。
// 用 ffmpeg 自带的 astats（每 0.1 秒一帧：RMS、Entropy）就能分出四类，
// 而且零依赖、零模型：
//   silence  rms < -45dB
//   burst    相对前一帧跃升 ≥10dB（掌声、敲击、玻璃碎这类瞬态）
//   noise    Entropy ≥ 0.65（宽带噪声：风声、电流声、嘈杂环境）
//   tonal    其余（有音高：音乐、持续音）
// 再按时间聚合：密集 burst = 掌声/密集响声；单个 burst = 突然一声响；
// 持续 tonal = 有音乐；持续 noise = 环境噪声。
//
// 边界：分不出"玻璃碎"和"关门"，只分"瞬态/持续、噪声性/调性"——
// 措辞必须留余地（"像是掌声""像有音乐"），不许断言具体来源。

const TEX_KINDS = { silence: '静', burst: '瞬态', noise: '噪声', tonal: '调性' }

/** 把每帧分类结果聚合成段（允许 1 帧抖动）。 */
function aggregateKinds(rows, frameSec) {
  const segs = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const last = segs[segs.length - 1]
    if (last && last.kind === r.kind && r.t - last.t1 <= frameSec * 1.6) { last.t1 = +(r.t + frameSec).toFixed(2); continue }
    segs.push({ t0: r.t, t1: +(r.t + frameSec).toFixed(2), kind: r.kind, level: r.rms })
  }
  return segs
}

/** 从段序列给一句总括。 */
function summarize(segs, dur) {
  const live = segs.filter((s) => s.kind !== 'silence')
  if (!live.length) return { summary: 'silence', why: '整段没有明显声音' }
  const bursts = segs.filter((s) => s.kind === 'burst')
  const burstDur = bursts.reduce((a, s) => a + (s.t1 - s.t0), 0)
  if (bursts.length >= 3 && burstDur / Math.max(0.5, dur) < 0.35 && bursts.length / Math.max(1, dur) >= 1) {
    return { summary: 'claps', why: `${bursts.length} 次密集瞬态（像掌声/密集响声）` }
  }
  if (bursts.length >= 1 && bursts.length <= 2) return { summary: 'hit', why: `突然一声响（${bursts.length} 次）` }
  const tonal = segs.filter((s) => s.kind === 'tonal').reduce((a, s) => a + (s.t1 - s.t0), 0)
  const noise = segs.filter((s) => s.kind === 'noise').reduce((a, s) => a + (s.t1 - s.t0), 0)
  if (tonal >= noise && tonal / Math.max(0.5, dur) >= 0.3) return { summary: 'music', why: '有持续的调性声音（像音乐/背景音）' }
  if (noise / Math.max(0.5, dur) >= 0.3) return { summary: 'noise', why: '有持续的噪声（像环境音）' }
  return { summary: 'mixed', why: '有声音，但说不清是什么' }
}

/**
 * 听"声音本身是什么"。纯本地、无模型。
 * @param {string} wav 16k 单声道 wav
 * @returns {Promise<{ok:boolean, why:string, frameSec:number, frames:number, segments:Array,
 *   summary:string, kinds:object, dur:number}>}
 */
export async function texture(wav, { frameSec = 0.1, ffmpeg = 'ffmpeg', timeoutMs = 120_000 } = {}) {
  const n = Math.max(160, Math.round(16000 * Math.max(0.05, frameSec)))
  const out = { ok: false, why: '', frameSec, frames: 0, segments: [], summary: 'unknown', kinds: {}, dur: 0, levels: [] }
  try {
    const { stdout } = await execFileP(ffmpeg, [
      '-v', 'error', '-i', wav,
      '-af', `asetnsamples=n=${n},astats=metadata=1:reset=1,ametadata=print:file=-`,
      '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    let cur = null
    const raws = []
    for (const raw of String(stdout || '').split('\n')) {
      const line = raw.trim()
      if (line.startsWith('frame:')) { if (cur) raws.push(cur); cur = {}; continue }
      const m = /^lavfi\.astats\.Overall\.(\w+)=(-?[\d.]+)$/.exec(line)
      if (!m) continue
      if (!cur) cur = {}
      cur[m[1]] = Number(m[2])
    }
    if (cur) raws.push(cur)
    if (!raws.length) { out.why = 'astats 没有输出'; return out }

    // 先收集全部帧，再按"局部峰"判瞬态。
    // 踩过的坑（2026-11-08）：用"相对上一帧跃升 ≥10dB"会把**每一段的第一个非静音帧**
    // 都判成 burst（prevLive 从 -96 起跳），于是正弦/白噪也被总结成"突然一声响"。
    // 真正的瞬态是**局部峰**：这一帧明显高于前后邻居。
    const rmsArr = raws.map((r) => (Number.isFinite(r.RMS_level) ? r.RMS_level : -96))
    const entArr = raws.map((r) => (Number.isFinite(r.Entropy) ? r.Entropy : 0))
    const rows = []
    for (let i = 0; i < raws.length; i++) {
      const rms = rmsArr[i]
      const ent = entArr[i]
      const prev = i > 0 ? rmsArr[i - 1] : -96
      const next = i + 1 < rmsArr.length ? rmsArr[i + 1] : -96
      const peak = rms - Math.max(prev, next)
      let kind
      if (rms < -45) kind = 'silence'
      else if (i > 0 && peak >= 8) kind = 'burst'
      else if (ent >= 0.65) kind = 'noise'
      else kind = 'tonal'
      rows.push({ t: +(i * frameSec).toFixed(2), rms, entropy: ent, kind })
    }
    out.frames = rows.length
    out.dur = +(rows.length * frameSec).toFixed(2)
    // 响度曲线（0.1 秒一点）：跨通道注意力要用它——"有动静"的时段画面更值得看。
    out.levels = rows.map((r) => ({ t: r.t, rms: r.rms }))
    out.segments = aggregateKinds(rows, frameSec)
    const kinds = {}
    for (const s of out.segments) kinds[s.kind] = (kinds[s.kind] || 0) + (s.t1 - s.t0)
    out.kinds = kinds
    const sum = summarize(out.segments, out.dur)
    out.summary = sum.summary
    out.why = sum.why
    out.ok = true
    return out
  } catch (e) {
    out.why = 'texture 异常：' + String(e?.message ?? e).slice(0, 120)
    return out
  }
}

/** 把分段按窗口压成「[mm:ss-mm:ss] 台词」（同窗口内多句合并、压重复）。 */
export function lineWindows(segs, windowSec = 3) {
  const win = Math.max(1, Number(windowSec) || 3)
  const buckets = new Map()
  for (const s of segs) {
    const k = Math.floor(Number(s.start) / win)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(s)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, arr]) => {
    const t0 = k * win
    const t1 = Math.min(...arr.map((x) => x.end).concat(t0 + win))
    return `[${mmss(t0)}-${mmss(t1)}] ${squashRepeats(arr.map((x) => x.text).join(' '))}`
  })
}

/** 当前能否听（给编排层决定要不要试）。 */
export function audioReady() { return asrReady() }

/** 自检信息。 */
export function audioInfo() {
  const c = asrCfg()
  return { ready: asrReady(), model: c.model, device: c.device, maxMinutes: c.maxMinutes }
}
