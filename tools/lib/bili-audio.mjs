// bili-audio —— B站视频的声音：取音轨 → 通用听写（asr-core）。
//
// 2026-11-08 拆分：ASR 本体（解释器/设备降级/繁转简/VAD 兜底/成稿）已移到 asr-core.mjs ——
// 它跟 B站没有任何关系，QQ 视频、本地文件、浏览器里的视频都该共用同一只耳朵。
// 这个文件只剩 B站特有的部分：
//   ① 拿 cid / playurl（**优先复用调用方已经拿到的**，B站 playurl 限流 -412 很紧）
//   ② 按音质档位挑 dash 音轨，curl 带 Referer/UA 拉回
//   ③ 截时长、转 16k wav、交给 transcribe
//   ④ 把台词按进度点对齐（"40% 处画面里的人在说什么"）
//
// 对外 API 不变：hearVideo / asrReady / whyNoHear / asrDoctor。
// （debrief.mjs / binge.mjs / bili-audio-test.mjs 依赖这四个名字。）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { apiGet, makeHeaders } from './bili-api.mjs'
import { loadCred } from './cred.mjs'
import { dataPath } from './paths.mjs'
import {
  asrReady, asrPython, transcribe, coalesce, squashRepeats, mmss,
  whyNoHear, setHearWhy, asrDoctor, asrCfg,
} from './asr-core.mjs'

const execFileP = promisify(execFile)

// 对外重新导出：调用方/测试只认 bili-audio 这一个入口
export { asrReady, asrPython, whyNoHear, asrDoctor }

/** B站特有的两个旋钮（ASR 自己的旋钮在 asr-core.asrCfg）。 */
const CFG = () => ({
  maxMinutes: Number(process.env.BOT_ASR_MAX_MIN || 30),
  // 音质档位：0=最高(192k) 1=中(132k) 2=低(64k)。默认中档 —— 体积/识别率折中。
  quality: Number(process.env.BOT_ASR_QUALITY ?? 1),
})

// ── 取音轨 ────────────────────────────────────────────────────────────────

/**
 * 挑一条音频流。B站 dash.audio 通常是 [30280(192k), 30232(132k), 30216(64k)]。
 * 默认取中档：整条音频本来就不大（1 小时 ≈ 42MB → 27MB），
 * 但 64k 在嘈杂实录上识别率明显掉，所以不省这一档。
 */
function pickAudio(dash, quality) {
  const list = (dash?.audio || []).slice().sort((a, b) => Number(b.id) - Number(a.id))
  if (!list.length) return null
  const i = Math.max(0, Math.min(list.length - 1, Number(quality) || 0))
  return list[i]
}

/** 用 curl 把整条音轨拉下来（带 Referer/UA，B站 CDN 认这个）。 */
async function downloadAudio(url, out, ua) {
  await execFileP('curl', [
    '-sS', '-L', '--max-time', '600',
    '-H', 'Referer: https://www.bilibili.com/',
    '-H', `User-Agent: ${ua || 'Mozilla/5.0'}`,
    '-o', out, url,
  ], { timeout: 660_000 })
  const sz = (() => { try { return fs.statSync(out).size } catch { return 0 } })()
  return sz
}

/**
 * 听一条 B站视频的声音。
 *
 * @param {string} bvid
 * @param {object} [opts.playurl]  调用方已经拿到的 playurl 响应（省一次请求 → 少一次限流）
 * @param {{
 *   lang?: string,            // 转写语言，默认 zh
 *   quality?: number,         // 音质档位 0/1/2，默认 1（132k）
 *   maxMinutes?: number,      // 超过这个时长不整条转（默认 30）
 *   windowSec?: number,       // 成稿合并窗口，默认 30
 *   maxChars?: number,        // 稿子字数上限，默认 6000
 *   at?: number[],            // 想重点看的进度点（0~1）
 * }} opts
 * @returns {Promise<null | {
 *   text: string, segs: number, dur: number, sampled: number, via: string,
 *   bytes: number, device: object|null, vadFellBack: boolean,
 *   atPoints?: Array<{at:string, ratio:number, line:string, heard:boolean, why?:string}>,
 *   truncated: boolean, elapsed: number,
 * }>}
 */
export async function hearVideo(bvid, opts = {}) {
  // 失败原因写在这里，成功了就清空 —— **不允许静默返回 null**。
  setHearWhy('')
  const c = CFG()
  if (!asrReady()) { setHearWhy('ASR 没装好（ffmpeg 或 faster-whisper 缺）'); return null }

  const tmp = dataPath('asr', 'bili-' + crypto.createHash('sha1').update(String(bvid)).digest('hex').slice(0, 10))
  const m4a = path.join(tmp, 'a.m4a')
  const wav = path.join(tmp, 'a.wav')
  try {
    const cred = loadCred()
    const H = makeHeaders(cred)

    // ① view：拿 cid
    const v = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, H)
    const d = v?.data
    if (!d?.cid) { setHearWhy(`元信息读不到（code=${v?.code} ${v?.message || ''}）`); return null }

    // ② playurl：拿 dash 音轨。**优先复用调用方已经拿到的**（少一次请求 = 少一次限流）
    let pu = opts.playurl
    if (!pu || pu.code !== 0) {
      const u = new URL('https://api.bilibili.com/x/player/wbi/playurl')
      u.searchParams.set('bvid', bvid)
      u.searchParams.set('cid', String(d.cid))
      u.searchParams.set('qn', '16')          // 只要音频，视频清晰度无所谓
      u.searchParams.set('fnval', '16')
      pu = await apiGet(u.href, H)
    }
    if (pu?.code !== 0) { setHearWhy(`playurl 被拒（code=${pu?.code} ${pu?.message || ''}）`); return null }
    const stream = pickAudio(pu.data?.dash, opts.quality ?? c.quality)
    const url = String(stream?.baseUrl || stream?.base_url || '')
    if (!url) { setHearWhy('这条没有可用音轨（可能被版权限制）'); return null }

    // ③ 时长闸门：太长的片子整条转要等十几分钟，她不该卡在那儿。
    //    只取开头 maxMinutes 分钟，并在结果里**说清楚只转了前 N 分钟**。
    const dur = Number(pu.data?.dash?.duration || 0)
    const maxSeg = Math.max(1, Number(opts.maxMinutes ?? c.maxMinutes))
    const capSeconds = dur > maxSeg * 60 ? maxSeg * 60 : 0

    // ④ 下载
    fs.mkdirSync(tmp, { recursive: true })
    const bytes = await downloadAudio(url, m4a, H['user-agent'])
    if (!bytes || bytes < 16 * 1024) { setHearWhy(`音轨没下下来（只拿到 ${bytes || 0} 字节）`); return null }

    // ⑤ 转 16k 单声道 wav（whisper 要的就是这个）
    await execFileP('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', m4a,
      ...(capSeconds ? ['-t', String(capSeconds)] : []),
      '-ac', '1', '-ar', '16000', wav, '-y',
    ], { timeout: 180_000 })
    const wavSz = (() => { try { return fs.statSync(wav).size } catch { return 0 } })()
    if (wavSz < 32 * 1024) { setHearWhy('ffmpeg 转 wav 失败'); return null }

    // ⑥ 转写（通用的那一只耳朵）
    const r = await transcribe(wav, {
      lang: opts.lang,
      maxSeconds: 0,                 // 已经在 ffmpeg 里截过时长了
      timeoutMs: Math.max(120_000, (dur ? Math.min(dur, capSeconds || dur) : 600) * 4000),
    })
    if (!r || !Array.isArray(r.segs) || !r.segs.length) { setHearWhy('转写没有输出（模型或音频有问题）'); return null }

    // ⑦ 成稿
    const lines = coalesce(r.segs, r.dur || dur, opts.windowSec ?? 30)
    const maxChars = Number(opts.maxChars ?? 6000)
    let text = lines.map((l) => `[${l.at}] ${l.text}`).join('\n')
    let truncated = false
    if (text.length > maxChars) {
      // 砍掉的部分必须**说出来**，否则她把"前 4000 字"当成整集剧情
      text = text.slice(0, maxChars).trimEnd() + `\n（稿子到 ${Math.round(maxChars / 1000)} 千字为止，后面的没放进来）`
      truncated = true
    }

    // ⑧ 按进度点对齐（opts.at = [0.40, 0.75] 之类，和抽帧的位置一一对得上）
    //
    // 三条必须守的规矩（都是踩出来的）：
    //   ① 用 **heardTo**（真转写到哪）而不是 dur 去判断"覆盖没覆盖到"；
    //   ② 越界的点必须明说"没听到那里"，不许拿最近的一句冒充；
    //   ③ 同一句被多个点命中时照实标（说明覆盖率不足）。
    const heardTo = Number(r.heardTo || 0)
    const fullDur = Number(r.dur || dur || 0)
    let atPoints
    if (Array.isArray(opts.at) && opts.at.length && fullDur > 0) {
      atPoints = opts.at.map((ratio) => {
        const t = fullDur * Number(ratio)
        if (heardTo > 0 && t > heardTo + 1) {
          return {
            ratio: Number(ratio),
            at: mmss(t),
            line: '',
            heard: false,
            why: `只转写到 ${mmss(heardTo)}，这个位置没听到`,
          }
        }
        let hit = null
        for (const s of r.segs) {
          if (Number(s.start) <= t + 0.5) hit = s
          else break
        }
        return {
          ratio: Number(ratio),
          at: mmss(t),
          line: hit ? `[${mmss(hit.start)}] ${squashRepeats(hit.text, 2)}` : '',
          heard: Boolean(hit),
        }
      })
    }

    return {
      text,
      segs: r.segs.length,
      dur: Number(r.dur || dur || 0),
      // sampled = **真的转写到哪一秒**，不是音频总长。
      sampled: Number(r.heardTo || capSeconds || 0),
      via: `audio id=${stream?.id ?? '?'} ${stream?.codecs || ''}`.trim(),
      device: r.device || null,
      vadFellBack: Boolean(r.vadFellBack),
      bytes,
      atPoints,
      truncated,
      elapsed: r.elapsed,
    }
  } catch (e) {
    setHearWhy('异常：' + String(e?.message || e).slice(0, 160))
    return null
  } finally {
    // 音轨/转写不囤
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// asrCfg 也导出去：面板/日志要看"这台机器跑哪个模型、什么设备"
export { asrCfg }
