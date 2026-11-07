// bili-web —— B 站的只读接口（搜索/热门/详情），给工具和"自己逛"共用
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要单独一个文件（2026-11-07）
// ══════════════════════════════════════════════════════════════════════
// 聊天里的 `bili_search` 工具和心跳里的 `wander` 需要**同一种东西**：
//   "按关键词找几条视频" / "看看现在热门有什么"
// 两处各写一份 fetch，就是下一个"两条路线漂移"（这个项目已经踩过三次）。
//
// 另一个实测：搜索接口 /x/web-interface/search/type 裸请求会 **HTTP 412**
// （B 站风控按 IP/UA 判），而热门接口不设防。先访问一次 www.bilibili.com
// 拿 buvid3/buvid4（Set-Cookie），再带 cookie 请求就能过 —— 这是页面本身
// 就这么做的事，不是破解。
//
// 统一出口：任何失败都抛 Error（调用方决定"如实说没查成"还是"静默"）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

let cache = { at: 0, cookie: '' }

/** 拿一次首页 cookie（30 分钟缓存）。拿不到就空着 —— 让请求自己去失败。 */
async function cookie() {
  if (cache.cookie && Date.now() - cache.at < 30 * 60_000) return cache.cookie
  try {
    const r = await fetch('https://www.bilibili.com/', {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(6000),
    })
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
    const c = list.map((x) => String(x).split(';')[0]).filter(Boolean).join('; ')
    if (c) cache = { at: Date.now(), cookie: c }
    return cache.cookie
  } catch { return cache.cookie }
}

/** 只读 GET（JSON）。失败抛错，code !== 0 也抛（B 站用 code 表达风控/参数错）。 */
export async function biliJson(path, params = {}, { timeout = 8000 } = {}) {
  const c = await cookie()
  const u = 'https://api.bilibili.com' + path + '?' + new URLSearchParams(params).toString()
  const r = await fetch(u, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      'accept-language': 'zh-CN,zh;q=0.9',
      ...(c ? { cookie: c } : {}),
    },
    signal: AbortSignal.timeout(timeout),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  if (!j || j.code !== 0) throw new Error(String(j?.message || ('code ' + j?.code)).slice(0, 80))
  return j.data
}

const clean = (x) => String(x || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim()

const durText = (d) => {
  const s = String(d || '')
  if (/^\d+:\d{2}(:\d{2})?$/.test(s)) return s
  const n = Number(d)
  if (!Number.isFinite(n) || n <= 0) return ''
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = Math.floor(n % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

const playText = (n) => {
  const x = Number(n || 0)
  if (x >= 1e8) return (x / 1e8).toFixed(1) + '亿'
  if (x >= 1e4) return (x / 1e4).toFixed(1) + '万'
  return String(x)
}

/**
 * 搜视频。
 * @param {string} keyword
 * @param {{order?:'totalrank'|'pubdate'|'click', limit?:number}} [o]
 * @returns {Promise<Array<{bvid,title,author,desc,play,duration,url}>>}
 */
export async function searchVideos(keyword, { order = 'totalrank', limit = 6 } = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) return []
  const d = await biliJson('/x/web-interface/search/type', { search_type: 'video', keyword: kw, page: 1, order })
  return (d?.result || [])
    .filter((v) => v && v.bvid)
    .slice(0, Math.max(1, limit))
    .map((v) => ({
      bvid: String(v.bvid),
      title: clean(v.title),
      author: clean(v.author),
      desc: clean(v.description).slice(0, 200),
      play: Number(v.play || 0),
      duration: durText(v.duration),
      url: 'https://www.bilibili.com/video/' + v.bvid,
    }))
}

/** 热门榜（不需要关键词的"逛"）。 */
export async function popularVideos(n = 20) {
  const d = await biliJson('/x/web-interface/popular', { ps: Math.max(1, Math.min(50, n)), pn: 1 })
  return (d?.list || [])
    .filter((v) => v && v.bvid)
    .map((v) => ({
      bvid: String(v.bvid),
      title: clean(v.title),
      author: clean(v.owner?.name),
      desc: clean(v.desc).slice(0, 200),
      play: Number(v.stat?.view || 0),
      duration: durText(v.duration),
      url: 'https://www.bilibili.com/video/' + v.bvid,
    }))
}

/** 一条视频的详细信息（标题/UP/简介/播放）—— 逛到之后补一句"这是什么"。 */
export async function videoInfo(bvid) {
  const d = await biliJson('/x/web-interface/view', { bvid: String(bvid || '') })
  if (!d) return null
  return {
    bvid: String(d.bvid || bvid),
    title: clean(d.title),
    author: clean(d.owner?.name),
    desc: clean(d.desc).slice(0, 300),
    play: Number(d.stat?.view || 0),
    duration: durText(d.duration),
    url: 'https://www.bilibili.com/video/' + String(d.bvid || bvid),
  }
}

export { playText, durText, clean as cleanBiliText }
