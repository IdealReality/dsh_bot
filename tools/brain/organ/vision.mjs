// organ/vision —— 看视频的器官（2026-11-08 器官化）
//
// ══════════════════════════════════════════════════════════════════════
// 现象：能力都在，但没有"器官"
// ══════════════════════════════════════════════════════════════════════
// 看视频这件事散在四个文件里：retina（预测误差/事件切分/出图）、audition（听）、
// watch（视听对齐）、videoframe（QQ 段适配）。每个都能单独跑，但没有任何地方
// 回答下面这些**关于眼睛本身**的问题：
//   · 今天看了几次？几次没看成？为什么没看成？
//   · 平均一次要看多久（这直接决定她能不能在看的同时聊天）？
//   · 最近一次只覆盖了整片的百分之多少（长片抽看 / 被打断）？
//   · 耳朵（whisper）现在可用吗？
// 于是"看不成"永远只是一行日志，攒不成体感；她也从没在**看的过程中**说出过
// 任何东西 —— 只能等整片 decode 完再开口。
//
// 生物学对应：视觉不是一条管道，是一个器官 —— 有适应、有注视、有疲劳，
// 也有"这次看得清不清"的自我评估。
//
// ══════════════════════════════════════════════════════════════════════
// 契约（与 pain/vitals/metabolism 同一家族）
// ══════════════════════════════════════════════════════════════════════
//   look(input, opts)  看一次（门面）：调 watch，记器官状态，透传 onImpression
//   read()             最近一次观看的读数
//   sense()            第一人称体感（多数时候空 —— 器官不该整天喊累）
//   llmState()         表达参数（看不清/只看了开头时收着说）
//   snapshot()         体检读数（成功率 / 平均耗时 / 最近失败原因）
//   phrase(imp)        增量印象 → 一句**可测事实**（不含语义）
//
// 只记录、不决策：要不要说、要不要再看一遍，是行为层的事。
import { dataPath } from '../../lib/paths.mjs'
import { mutateJson } from '../json.mjs'
import { swallow } from '../../lib/swallow.mjs'
import * as watch from '../../lib/watch.mjs'
import * as audition from '../../lib/audition.mjs'

const VISION_PATH = () => dataPath('brain', 'meta', 'vision.json')
const DAY = 86_400_000

const empty = () => ({
  at: 0,
  stats: { looks: 0, ok: 0, fail: 0, interrupt: 0, totalMs: 0, lastFailWhy: '', lastFailAt: 0 },
  last: null,
})

function read() {
  try {
    const s = mutateJson(VISION_PATH(), empty(), (cur) => cur)
    return { ...empty(), ...(s || {}), stats: { ...empty().stats, ...(s?.stats || {}) } }
  } catch { return empty() }
}

function record(r, ms) {
  try {
    mutateJson(VISION_PATH(), empty(), (s) => {
      const st = { ...empty().stats, ...(s?.stats || {}) }
      st.looks++
      st.totalMs += ms
      if (r?.ok) st.ok++
      else st.fail++
      if (r?.interrupted) st.interrupt++
      if (!r?.ok && r?.why) { st.lastFailWhy = String(r.why).slice(0, 120); st.lastFailAt = Date.now() }
      s.stats = st
      const dur = Number(r?.dur) || 0
      s.last = {
        at: Date.now(), ms,
        ok: Boolean(r?.ok),
        interrupted: Boolean(r?.interrupted),
        dur,
        seenTo: Number(r?.seenTo) || 0,
        // 覆盖比例：整片都看了 = 1；长片抽看/被打断 = 实际看到的那部分
        coverage: dur > 0 ? Number((Math.min(dur, Number(r?.seenTo) || dur) / dur).toFixed(2)) : null,
        frames: Array.isArray(r?.frames) ? r.frames.length : 0,
        events: Number(r?.meta?.visual?.events) || 0,
        heard: r?.meta?.audio?.ok ? Number(r.meta.audio.segs) || 0 : null,
        profile: r?.meta?.gain?.profile || null,
        gainWhy: String(r?.meta?.gain?.why || '').slice(0, 120),
        why: String(r?.why || '').slice(0, 120),
      }
      s.at = Date.now()
      return s
    })
  } catch (e) { swallow(e, 'vision:record') }
}

/**
 * 看一次。**唯一入口** —— videoframe 也走这里，避免两套记账。
 *
 * @param {{file?:string, url?:string}} input
 * @param {object} [opts] 见 watch.DEFAULTS；额外支持 onImpression(imp)
 * @returns {Promise<object>} watch 的返回体（失败也返回，不抛）
 */
export async function look(input, opts = {}) {
  const t0 = Date.now()
  const onImpression = typeof opts.onImpression === 'function' ? opts.onImpression : null
  const o = onImpression
    ? {
      ...opts,
      // 增量印象：每解完一个窗口就把「已经看到的物理事实」吐出去。
      // 这就是"边看边知道"——不再等整片 decode 完才有第一句话。
      onProgress: (p) => { try { onImpression(p) } catch { /* 回调不许影响观看 */ } },
    }
    : opts
  let r = null
  try {
    r = await watch.watchMedia(input, o)
  } catch (e) {
    swallow(e, 'vision:look')
    r = {
      ok: false, why: '看视频的过程出错了：' + String(e?.message ?? e).slice(0, 80),
      dur: 0, frames: [], timeline: '', note: '', meta: {}, cleanup: () => {},
    }
  }
  record(r, Date.now() - t0)
  return r
}

function shortWhy(why) {
  const s = String(why || '')
  if (/打断/.test(s)) return '把你打断了'
  if (/没有拿到可读的文件|没能打开|打不开/.test(s)) return '打不开'
  if (/太小/.test(s)) return '文件不像视频'
  if (/没有音轨/.test(s)) return '没有声音'
  if (/预算/.test(s)) return '时间不够'
  return s.slice(0, 24) || '原因不明'
}

/** 第一人称体感。只描述"最近这一眼"，且 6 小时后自然消失（不久坐成性格）。 */
export function sense() {
  try {
    const s = read()
    const l = s.last
    if (!l || !l.at || Date.now() - l.at > 6 * 3600_000) return ''
    if (!l.ok) {
      if (l.interrupted) return ''            // 被打断不是眼睛的问题
      return '刚才那段视频没看成（' + shortWhy(l.why) + '）'
    }
    const bits = []
    if (l.coverage !== null && l.coverage < 0.6) bits.push('只看了前面一段，后面还没看')
    if (l.heard === 0) bits.push('画面看到了，声音里没听出人话')
    if (l.ms > 20_000) bits.push('这段看得有点费劲')
    return bits.join('；')
  } catch { return '' }
}

/** 表达参数：最近一次看得不全时，说话别装作看全了。 */
export function llmState() {
  try {
    const s = read()
    const l = s.last
    if (!l || !l.at || Date.now() - l.at > 30 * 60_000) return null
    if (!l.ok && !l.interrupted) return { note: '刚才那段视频没看成（' + shortWhy(l.why) + '），别编里面是什么' }
    if (l.coverage !== null && l.coverage < 0.5) return { note: '那段视频你只看到前面一小段，后面没看，别当成看完了' }
    if (l.heard === 0 && l.ok) return { note: '画面你看到了，但没听清人话' }
    return null
  } catch { return null }
}

/** 体检读数。 */
export function snapshot() {
  try {
    const s = read()
    const st = s.stats
    const looks = Number(st.looks) || 0
    return {
      at: s.at || 0,
      looks,
      ok: Number(st.ok) || 0,
      fail: Number(st.fail) || 0,
      interrupted: Number(st.interrupt) || 0,
      okRate: looks ? Number((st.ok / looks).toFixed(2)) : null,
      avgMs: looks ? Math.round(st.totalMs / looks) : null,
      lastFailWhy: st.lastFailWhy || '',
      last: s.last,
      ear: (() => { try { return audition.audioReady() } catch { return false } })(),
      today: looks > 0 && Date.now() - (s.last?.at || 0) < DAY,
    }
  } catch { return null }
}

const fmt = (t) => (Math.round(Number(t) * 10) / 10).toFixed(1)

/**
 * 增量印象 → 一句可测事实。**不含语义**（"一个方块在滑"留给视觉模型）。
 * @param {{t0:number,t1:number,moved?:number,cuts?:number,peak?:number,detail?:number,partial?:boolean}} p
 */
export function phrase(p = {}) {
  const head = `${fmt(p.t0)}-${fmt(p.t1)}s`
  const moved = Number(p.moved) || 0
  const cuts = Number(p.cuts) || 0
  if (p.partial && !moved && !cuts) return `${head}｜还没看清（这段没解完）`
  if (cuts > 0) return `${head}｜换了镜头${moved ? '，画面在动' : ''}`
  if (moved > 0) {
    const det = Number(p.detail)
    return `${head}｜有动作${Number.isFinite(det) ? (det > 0.06 ? '，细节清楚' : det < 0.015 ? '，没什么细节' : '') : ''}`
  }
  return `${head}｜静止（没有变化）`
}
