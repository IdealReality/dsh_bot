// wander —— 她自己"上网逛一圈"的执行体（2026-11-07）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么需要它
// ══════════════════════════════════════════════════════════════════════
// self.decide() 早就会选 browse（"想随便逛逛，看看有什么新鲜的"），
// body.browse 也早就有执行体 —— 但那个执行体只做了两件事：
//   syncFocus('web') + stimulate('explore')
// 也就是说：她"决定去逛"之后，**什么都没逛**。状态变了，世界没变。
//
// 用户的要求是"默认就会逛 B 站、会去网上搜东西"。对话里搜靠 look_up
// （底层 curl 在容器里不存在，2026-11-07 已改成 fetch）；主动逛靠这里。
//
// 形状：
//   · 没有关键词 → 刷 B 站热门（真正的"逛"：不是搜索，是碰运气）
//   · 有关键词 → 搜，挑第一条没看过的
//   · 只拉元信息 + 简介（不上字幕/热评 —— 那是 watch_video 的活，成本高）
//   · 记进看番账本时 **ok:false**：刷到 ≠ 看过。下一轮她不会冒充看过，
//     但 recentShows(onlyReal) 也不会被这些记录挤掉。
//   · 每日上限（默认 6）：她是住在别人机器里的，不能无限烧流量。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { swallow } from './swallow.mjs'
import { config } from './config.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 解析外部/磁盘 JSON：畸形输入只返回 null，绝不抛到 async 顶层。 */
const safeJson = (s) => { try { return JSON.parse(s) } catch { return null } }
import { searchVideos, popularVideos, videoInfo, playText, durText } from './bili-web.mjs'

const FILE = () => dataPath('web', 'wander.json')
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    return {
      day: String(j.day || ''),
      count: Number(j.count || 0),
      seen: Array.isArray(j.seen) ? j.seen.slice(-40) : [],
      last: j.last || null,
    }
  } catch { return { day: '', count: 0, seen: [], last: null } }
}

function save(st) {
  try {
    fs.mkdirSync(dataPath('web'), { recursive: true })
    const tmp = FILE() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(st))
    fs.renameSync(tmp, FILE())
  } catch (e) { swallow(e, 'wander:save') }
}

/**
 * 她可以在自己房间里看任何东西，但"逛到"的东西会写进记忆、可能被说起，
 * 所以**明显擦边/成人向的标题不进这一层**（不是审查她，是不把这类内容
 * 当成"今天的新鲜事"记下来）。实测热门/搜索里确实会出现这类条目。
 */
const BLOCKED = /(无码|裸露|露点|色情|约炮|裸聊|福利姬|自慰|做爱|性爱|成人视频|p站|P站|里番|本子)/

const allow = (v) => v && v.title && !BLOCKED.test(v.title + ' ' + (v.desc || ''))

/**
 * 用她自己的**偏好选题**（tools/bot.mjs feed）挑几条。
 *
 * feed 早就有"热门 + 关键词搜索 + 偏好命中（美食/猫咪/AI…）"的评分，
 * 而且会剔除 7 天内发过的。自己再写一套选题就是第四份"两条路线漂移"。
 * 走子进程调 CLI（它有 wbi 签名/凭据处理），失败就退回热门。
 */
async function feedPicks(n = 5) {
  try {
    const cli = new URL('../bot.mjs', import.meta.url)
    const { stdout } = await execFileAsync(process.execPath, [cli.pathname, 'feed', '--n', String(n), '--json'], {
      timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    })
    const txt = String(stdout || '')
    const at = txt.indexOf('{')
    if (at < 0) return []
    const j = safeJson(txt.slice(at))
    if (!j) return []
    return (j.items || []).map((v) => ({
      bvid: String(v.bvid || ''),
      title: String(v.title || ''),
      author: String(v.owner || ''),
      desc: String(v.desc || '').slice(0, 200),
      play: Number(v.play || 0),
      duration: String(durText(v.duration || '') || ''),
      url: 'https://www.bilibili.com/video/' + String(v.bvid || ''),
      why: String(v.why || ''),
    })).filter((v) => v.bvid)
  } catch { return [] }
}

/** 热门榜（真正的"逛"）。 */
export async function popular(n = 20) {
  return (await popularVideos(n)).filter(allow)
}

/** 搜索（与聊天里的 bili_search 同一个实现）。 */
export async function search(keyword, { order = 'totalrank' } = {}) {
  return (await searchVideos(keyword, { order, limit: 10 })).filter(allow)
}

/**
 * 从候选池里挑一条**没刷到过**的（纯函数，便于测试）。
 * 全刷过就退回第一条（热门榜会重复，重复的"逛"没有信息量，但总比空手好）。
 */
export function pickFresh(pool = [], seen = []) {
  const s = new Set(Array.isArray(seen) ? seen : [])
  const list = (Array.isArray(pool) ? pool : []).filter((v) => v && v.bvid)
  return list.find((v) => !s.has(v.bvid)) || list[0] || null
}

/**
 * 今天想逛什么（2026-11-07 第二轮）。
 *
 * 只刷热门是"刷推荐流"，不是"她自己的兴趣"：人逛 B 站会带着
 * 最近挂在心上/常聊的东西去搜。这里用**只读**的方式取：
 *   ~/.data/brain/learn/lexicon.json —— 她和他这些天反复说的词
 *   （学说话时顺手记的，本来就只读、不外用）
 *
 * 不 import brain 模块：lib → brain 的静态反向依赖会被门禁拦，
 * 而这里只需要读一个 json。读不到就返回 null（退回刷热门）。
 *
 * @returns {string|null}
 */
export function interestKeyword({ now = Date.now() } = {}) {
  try {
    const j = safeJson(fs.readFileSync(dataPath('brain', 'learn', 'lexicon.json'), 'utf8'))
    if (!j) return null
    const chats = j?.chats || {}
    const rows = []
    for (const bucket of Object.values(chats)) {
      for (const [w, e] of Object.entries(bucket || {})) {
        const n = Number(e?.n || 0)
        const last = Number(e?.lastAt || 0)
        if (n < 4) continue
        if (now - last > 7 * 86400_000) continue
        if (w.length < 3 || w.length > 4) continue
        // lexicon 是**无分词**的字块统计，"B站上有吗" 会切出"站上有"这种垃圾。
        // 当搜索词之前必须过滤：含虚词/助词/代词的一律不要（实测搜出过不当内容）。
        if (/[的了是在我你他她它这那就也都还又要会能说看去来上下里吧呢啊嘛呀没不很太真好坏把被给对从到和与及或]/.test(w)) continue
        rows.push({ w, n, last })
      }
    }
    if (!rows.length) return null
    rows.sort((a, b) => (b.n - a.n) || (b.last - a.last))
    // 每天换一个（确定性：按天序号取模），别整天搜同一个词
    const day = Math.floor(now / 86400_000)
    const pool = rows.slice(0, 8)
    return pool[day % pool.length].w || null
  } catch { return null }
}

/** 当日额度（跨天自动归零）。纯函数。 */
export function tally(st = {}, cap = 6, now = Date.now()) {
  const day = today(now)
  const c = Math.max(0, Number(cap) || 0)
  const count = st && st.day === day ? Number(st.count || 0) : 0
  return { day, count, cap: c, allowed: count < c }
}

/**
 * 逛一圈。
 * @param {object} o
 * @param {string} [o.keyword] 给定就搜，不给就刷热门
 * @param {string} [o.why] 谁触发的（日志用）
 * @returns {Promise<{ok:boolean, why?:string, title?:string, bvid?:string, author?:string, desc?:string, url?:string}>}
 */
export async function wander({ keyword = '', why = 'self:browse', now = Date.now() } = {}) {
  const st = load()
  const cap = Math.max(0, Number(config().web?.wanderPerDay ?? 6))
  const t = tally(st, cap, now)
  if (!t.allowed) return { ok: false, why: '今天逛够了（' + t.cap + ' 次）' }

  // 选题顺序：显式关键词 → 她自己的偏好（feed）→ 最近常说的词 → 热门。
  // 前三种都是"有理由地逛"，最后一种才是真正的瞎逛。
  let pool = []
  let source = ''
  try {
    const kw0 = String(keyword || '').trim()
    if (kw0) {
      pool = await search(kw0)
      source = 'search:' + kw0
    } else {
      pool = await feedPicks(5)
      if (pool.length) source = 'feed'
      if (!pool.length) {
        const ik = interestKeyword({ now })
        if (ik) { pool = await search(ik); source = 'interest:' + ik }
      }
      if (!pool.length) { pool = await popular(20); source = 'popular' }
    }
  } catch (e) {
    swallow(e, 'wander:fetch')
    return { ok: false, why: '没连上 B 站：' + String(e?.message || e).slice(0, 60) }
  }
  // 挑一条没刷到过的（热门榜会重复，重复的"逛"没有信息量）
  const pick = pickFresh(pool, st.seen)
  if (!pick) return { ok: false, why: '这次没刷到东西' }
  // 热门榜的条目有时没有简介；补一次详情（1 次请求，失败就算了）
  let info = pick
  if (!info.desc || !info.author) {
    try { info = { ...pick, ...(await videoInfo(pick.bvid) || {}) } } catch (e) { swallow(e, 'wander:detail') }
  }

  st.count = t.count + 1
  st.day = t.day
  st.seen = [...st.seen.filter((x) => x !== pick.bvid), pick.bvid].slice(-40)
  st.last = { at: now, bvid: info.bvid, title: info.title, why }
  save(st)

  // 记进看番账本：**ok:false**（只刷到简介，不算看过）。
  // 这样下一轮她不会冒充看过，recentShows(onlyReal) 也不会被挤掉。
  try {
    const W = await import('./watchlog.mjs')
    W.record({
      show: info.title, title: info.title, bvid: info.bvid,
      plot: info.desc, feel: '', via: '在 B 站逛到的（只看了简介）', ok: false,
    })
  } catch (e) { swallow(e, 'wander:watchlog') }

  return {
    ok: true, title: info.title, bvid: info.bvid, author: info.author,
    desc: info.desc, url: info.url, play: info.play, playText: playText(info.play),
    keyword: source.startsWith('search:') ? source.slice(7) : '',
    source,
    firstToday: st.count === 1,
  }
}

/** 面板/诊断。 */
export function status() {
  const st = load()
  return { day: st.day, count: st.count, last: st.last, seen: st.seen.length }
}
