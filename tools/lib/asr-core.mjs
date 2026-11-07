// asr-core —— 通用「听懂声音」的核心：任意媒体 → 带时间码的分段台词。
//
// 从 bili-audio.mjs 抽出来的（2026-11-08）。抽的原因很直接：
// 原来这套能力焊死在 B站链路里（hearVideo 只认 bvid），QQ 收到的视频、本地文件、
// 以后别的通道全都用不上。而它本身跟 B站没有任何关系 —— 输入就是一个音频文件。
//
// 三层分工（不要合回去）：
//   asr-core      语音 → 文字（模型、设备、繁转简、VAD 失效兜底）
//   audition      媒体 → 听觉知觉（抽音轨、静音/有声、声音事件、时间线）
//   watch         视听融合（和 retina 的画面窗口对齐，产出给人看的时间线）
//
// 硬原则（沿用 bili-audio，都是踩出来的）：
//   1. 失败返回 null 并留下 whyNoHear()，**绝不编造台词**。
//   2. 「听到了哪一秒」用 heardTo，不是音频总长 —— 否则 VAD 短转会被当成听完整段。
//   3. 结果不囤：调用方用完就删。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

let lastHearWhy = ''

/** 上一次听写为什么没成（空串 = 成功）。调用方据此说实话，而不是「听了但没内容」。 */
export function whyNoHear() { return lastHearWhy }

/** 内部/外部设置失败原因（audition / bili-audio 共用一条口径）。 */
export function setHearWhy(msg) { lastHearWhy = String(msg || '') }

// ── 环境探测 ──────────────────────────────────────────────────────────────

/** ASR 数据目录（venv + 模型）。容器重建不丢的原因就是它放在 ~/.data。 */
export function asrDataDir() {
  if (process.env.BOT_ASR_DATA_DIR) return process.env.BOT_ASR_DATA_DIR
  const venv = process.env.BOT_ASR_VENV
  if (venv) return path.dirname(venv)
  return path.join(os.homedir(), '.data')
}

function asrVenvPython() {
  return path.join(asrDataDir(), 'asr-venv', 'bin', 'python')
}

/** pip 装的 CUDA 库不在 ld 搜索路径里，ctranslate2 会报 libcublas.so.12 找不到。 */
export function cudaLibPath() {
  const base = path.join(asrDataDir(), 'asr-venv', 'lib', 'python3.11', 'site-packages', 'nvidia')
  return [
    path.join(base, 'cublas', 'lib'),
    path.join(base, 'cudnn', 'lib'),
    path.join(base, 'cuda_nvrtc', 'lib'),
  ].join(':')
}

/** ASR 解释器：优先独立 venv，其次环境变量，最后系统 python。探不通就 null。 */
export function asrPython() {
  const cands = [
    process.env.BOT_ASR_PYTHON,
    asrVenvPython(),
    '/usr/bin/python3',
  ].filter(Boolean)
  for (const p of cands) {
    try {
      execFileSync(p, ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 20000 })
      return p
    } catch { /* 下一个 */ }
  }
  return null
}

/** ASR 可调项（环境变量覆盖；换机器不用改代码）。 */
export function asrCfg() {
  return {
    model: process.env.BOT_ASR_MODEL || 'small',
    // GPU RTF 0.071 / CPU 0.224（实测）—— 决定"多长的片子还值得整条转"
    maxMinutes: Number(process.env.BOT_ASR_MAX_MIN || 30),
    device: (process.env.BOT_ASR_DEVICE || 'auto').toLowerCase(),
  }
}

/** ffmpeg + faster-whisper 都在才认为这条链可用。 */
export function asrReady() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }) } catch { return false }
  return Boolean(asrPython())
}

// ── 转写 ──────────────────────────────────────────────────────────────────

// 这段 python 走 -c 传参，不落盘成 .py（仓库里不多养脚本）。
const PY = String.raw`
import os, sys, json, time
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ['HF_HUB_DISABLE_XET'] = '1'
from faster_whisper import WhisperModel
wav, model_name, model_dir, lang, max_s, dev, ctype = sys.argv[1:8]
t0 = time.time()

# 设备/精度自动降级：Pascal(GTX 1050, CC 6.1) 会主动拒绝 float16，
# int8/float32 都行；换机器又可能反过来。写死任何一个都会在某个环境失败，
# 然后被上层当成"没听见"—— 又是静默失败。
cands = []
if dev == 'cuda':
    if ctype: cands.append(('cuda', ctype))
    cands += [('cuda', 'int8'), ('cuda', 'float32')]
elif dev == 'cpu':
    cands += [('cpu', 'int8'), ('cpu', 'float32')]
else:
    cands += [('cuda', 'int8'), ('cuda', 'float32'), ('cpu', 'int8'), ('cpu', 'float32')]

m = None
used = None
errs = []
for d, ct in cands:
    try:
        m = WhisperModel(model_name, device=d, compute_type=ct, download_root=model_dir)
        used = {'device': d, 'compute_type': ct}
        break
    except Exception as e:
        errs.append(f'{d}/{ct}: {str(e)[:120]}')
if m is None:
    print(json.dumps({'error': 'no usable device', 'tries': errs}, ensure_ascii=False))
    sys.exit(2)

def run(vad):
    segs, info = m.transcribe(
        wav, language=(lang or 'zh'), task='transcribe', beam_size=1, vad_filter=vad,
        initial_prompt='以下是普通话的句子，使用简体中文转写。',
        vad_parameters={'min_silence_duration_ms': 500} if vad else None,
        condition_on_previous_text=False,
    )
    return segs, info

# 繁转简：faster-whisper small 的中文只要音频够长就必然往繁体漂（实测 53 分钟片
# 65.5% 的字是繁体），initial_prompt 压不住。tw2s + 定向补 幺→么 实测全对。
import re as _re
try:
    import opencc
    _cc = opencc.OpenCC('tw2s')
except Exception:
    _cc = None
_YAO = _re.compile('幺')

def to_simplified(t):
    if not _cc or not t:
        return t
    return _YAO.sub('么', _cc.convert(t))

# VAD 的致命失效：纯音乐/音效密集的片子会被判成"几乎没语音"，只转开头。
# 判据：覆盖 < 60% 且时长 > 60 秒 → 关 VAD 重跑，取覆盖更全的那次。
segs, info = run(True)
segs = list(segs)
dur_all = float(info.duration or 0)
covered = (segs[-1].end - segs[0].start) if segs else 0
vadFellBack = False
if dur_all > 60 and covered < dur_all * 0.6:
    segs2, info2 = run(False)
    segs2 = list(segs2)
    covered2 = (segs2[-1].end - segs2[0].start) if segs2 else 0
    if covered2 > covered:
        segs, info, covered = segs2, info2, covered2
        vadFellBack = True
        dur_all = float(info.duration or dur_all)

cap = float(max_s)
out = []
for s in segs:
    if cap > 0 and s.end > cap:
        break
    t = to_simplified(s.text.strip())
    if t:
        out.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': t})
print(json.dumps({
    'dur': round(info.duration, 1),
    'lang': info.language,
    'n': len(out),
    'elapsed': round(time.time() - t0, 1),
    'device': used,
    'vadFellBack': vadFellBack,
    'heardTo': round(out[-1]['end'], 1) if out else 0,
    'segs': out,
}, ensure_ascii=False))
`

/**
 * 真正跑一次转写。
 * @param {string} wav 16k 单声道 wav
 * @param {{lang?:string, model?:string, maxSeconds?:number, device?:string, computeType?:string, timeoutMs?:number}} opts
 * @returns {Promise<null|{dur:number, segs:Array<{start:number,end:number,text:string}>, heardTo:number, elapsed:number, device:object, vadFellBack:boolean}>}
 */
export async function transcribe(wav, opts = {}) {
  const py = asrPython()
  if (!py) { setHearWhy('没有可用的 ASR 解释器（faster-whisper 没装）'); return null }
  const c = asrCfg()
  const modelDir = process.env.BOT_ASR_MODEL_DIR || path.join(asrDataDir(), 'asr-models')
  const dev = String(opts.device || c.device || 'auto').toLowerCase()
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [cudaLibPath(), process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':'),
  }
  try {
    const { stdout } = await execFileP(py, [
      '-c', PY, wav, opts.model || c.model, modelDir,
      opts.lang || 'zh', String(opts.maxSeconds || 0), dev, String(opts.computeType || ''),
    ], { timeout: Number(opts.timeoutMs || 30 * 60_000), maxBuffer: 64 * 1024 * 1024, env, signal: opts.signal })
    // python 可能先打一堆进度/警告，JSON 在最后一行
    const lines = String(stdout || '').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim()
      if (!s.startsWith('{')) continue
      try {
        const j = JSON.parse(s)
        if (j.error) { setHearWhy(`没有可用设备：${JSON.stringify(j.tries).slice(0, 200)}`); return null }
        return j
      } catch { /* 往上继续找 */ }
    }
    setHearWhy('转写进程没有输出 JSON')
    return null
  } catch (e) {
    // 用户插话把转写掐了（2026-11-08）：这不是"听写坏了"，别把它记成设备/模型问题。
    if (opts.signal?.aborted || e?.name === 'AbortError') { setHearWhy('转写被打断'); return null }
    setHearWhy('转写异常：' + String(e?.message ?? e).slice(0, 160))
    return null
  }
}

// ── 成稿 ──────────────────────────────────────────────────────────────────

/** 秒 → mm:ss。 */
export function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 压掉「喵喵喵喵…」这种机械重复（ASR 对拟声词会逐字输出几百个）。 */
export function squashRepeats(text, maxRun = 3) {
  return String(text || '').replace(/([\u4e00-\u9fa5A-Za-z])\1{3,}/g, (m, ch) => {
    const n = m.length
    return ch + ch + ch + `…（重复${n}次）`
  })
}

/** 按等长时间窗合并分段（30 秒一窗），每窗一行带时间码，token 压到 1/8。 */
export function coalesce(segs, dur, windowSec = 30) {
  const win = Math.max(5, Number(windowSec) || 30)
  const buckets = new Map()
  for (const s of segs) {
    const k = Math.floor(Number(s.start) / win)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(s)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, arr]) => {
      const t0 = k * win
      const t1 = Math.min(dur || Infinity, t0 + win)
      const text = squashRepeats(arr.map((x) => x.text).join(' '))
      return { t0, t1, at: `${mmss(t0)}-${mmss(t1)}`, text }
    })
}

/** 把分段压成「mm:ss-mm:ss 台词」的行（audition 用，窗口可小到 3 秒）。 */
export function linesOf(segs, windowSec = 3) {
  return coalesce(segs, 0, windowSec).map((l) => `[${l.at}] ${l.text}`)
}

/** 自检：解释器 + ffmpeg + 模型能不能一起跑（selftest 用）。 */
export async function asrDoctor() {
  const py = asrPython()
  const out = { python: py, ffmpeg: false, model: null, ok: false, device: null, gpus: 0 }
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); out.ffmpeg = true } catch { /* */ }
  const c = asrCfg()
  out.model = c.model
  out.device = c.device
  if (py) {
    try {
      const r = execFileSync(py, ['-c', 'import ctranslate2;print(ctranslate2.get_cuda_device_count())'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
        env: { ...process.env, LD_LIBRARY_PATH: cudaLibPath() },
      })
      out.gpus = Number(String(r).trim()) || 0
    } catch { out.gpus = 0 }
  }
  out.ok = Boolean(py && out.ffmpeg)
  return out
}


