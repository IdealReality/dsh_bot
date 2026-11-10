// search-engines —— 搜索的**引擎层**（2026-11-08）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要有这一层：bing 的 cn 接口会把「多词中文 query」退化成首词
// ══════════════════════════════════════════════════════════════════════
// 实测（生产容器 dsh_bot，2026-11-08）：
//   「费曼 趣事 科学顽童 故事」      → 结果全是"费（汉语文字）_百度百科"
//   「醒来后脑子发懵 多久能恢复 早晨 认知」 → 结果全是《醒来》那部电视剧
//   「电池 保养 注意事项」           → 结果全是"电池（把化学能转化成电能的装置）"
// 而**同一条 query 打 so.com（360）**：费曼→"科学顽童费曼的故事"，电池→"电池日常保养指南"。
// 也就是说：bing 返回的"N 条结果"看着像成功，其实全是脏数据。原先的链路只在
// **长度=0** 时才换引擎，于是脏数据永远拦不住 —— 她拿"菠萝包是水果"当搜索结果回话。
//
// 这一层的三件事：
//   ① 多引擎（360 优先；bing 备；ddg 兜底，要代理）
//   ② **相关性打分** —— 结果里没有 query 的词就不算"搜到"
//   ③ 全脏时换短一点的写法再搜一次（不是无限重试，最多两个变体）
//
// 纯函数解析 + 打分，网络由调用方注入（web.mjs 的 httpGet 里有 curl/代理策略），
// 这样单测不用联网也能盯住"解析器被引擎改版打坏"这种静默故障。
import { swallow } from '../infra/swallow.mjs'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 引擎优先级（同分时 360 在前：中文长尾明显好于 bing）。 */
const PRIORITY = { 360: 0, bing: 1, ddg: 2, browser: 3 }

/** 相关性及格线：命中一半以上的词才算"对题"。 */
export const RELEVANT = 0.34

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return m } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return m } })
}

function text(s) {
  return decodeEntities(
    String(s)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(?:p|div|li|td|tr|h\d)>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

/** 只留字母/数字/汉字，用于跨分词空格比较（引擎会在标题里插空格：`科学顽童费曼 的 故事`）。 */
export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** query → 比对用词。连写整体也算一个词（"菠萝包 轻小说" ⇄ "菠萝包轻小说"）。 */
export function tokensOf(kw) {
  const parts = String(kw || '').trim().split(/[\s,，、+／\/|·]+/).filter(Boolean)
  const toks = new Set()
  for (const p of parts) if (p.length >= 2) toks.add(p)
  if (parts.length > 1) toks.add(parts.join(''))
  return [...toks]
}

/** 一个词在结果里的覆盖度：整体命中=1；长词退化成二元组覆盖率（`醒来后脑子发懵` ⇄ `意识朦胧…苏醒` 这种改写也能拿到部分分）。 */
export function tokenCover(token, hay) {
  const n = norm(token)
  if (!n || !hay) return 0
  if (hay.includes(n)) return 1
  if (n.length < 4) return 0            // 两三个字的词必须整体命中，fuzzy 会放开噪声
  let hit = 0
  let total = 0
  for (let i = 0; i + 1 < n.length; i++) {
    total++
    if (hay.includes(n.slice(i, i + 2))) hit++
  }
  return total ? hit / total : 0
}

/** 0~1：结果覆盖了多少 query 的词（长词权重 2）。 */
export function scoreItem(kw, item) {
  const toks = tokensOf(kw)
  if (!toks.length) return 0
  const hay = norm(`${item?.title || ''} ${item?.snippet || ''} ${item?.url || ''}`)
  if (!hay) return 0
  let hit = 0
  let total = 0
  for (const t of toks) {
    const w = t.length >= 4 ? 2 : 1
    total += w
    hit += w * tokenCover(t, hay)
  }
  return total ? hit / total : 0
}

/** 360 搜索：结果块是 <li class="res-list">，真实地址在 h3 里 a 的 data-mdurl，
 *  外层 href 是 so.com/link 跳转壳（不能给她看，也不能拿去 fetch）。 */
export function parse360(html) {
  const out = []
  for (const block of String(html || '').split('<li class="res-list"').slice(1)) {
    const h3 = (block.match(/<h3[^>]*class="res-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/) || [])[1]
    if (!h3) continue
    const url = decodeEntities((h3.match(/data-mdurl="([^"]+)"/) || [])[1] || '').trim()
    if (!/^https?:\/\//.test(url)) continue
    const title = text(h3).slice(0, 100)
    if (!title) continue
    const desc = (block.match(/<p[^>]*class="res-desc"[^>]*>([\s\S]*?)<\/p>/) || [])[1]
      || (block.match(/data-result-summary[^>]*>([\s\S]*?)<\//) || [])[1]
      || ''
    out.push({ title, url, snippet: text(desc).slice(0, 200) })
    if (out.length >= 10) break
  }
  return out
}

/** bing RSS：纯 <item>，天然没广告位。 */
export function parseBingRss(html) {
  const out = []
  for (const it of String(html || '').match(/<item>[\s\S]*?<\/item>/g) || []) {
    const title = text((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').slice(0, 100)
    const url = decodeEntities(((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim())
    const snippet = text((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '').slice(0, 200)
    if (title && /^https?:\/\//.test(url)) out.push({ title, url, snippet })
    if (out.length >= 12) break
  }
  return out
}

/** DDG html 版（要代理）。 */
export function parseDdg(html) {
  const out = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m
  const src = String(html || '')
  while ((m = re.exec(src)) && out.length < 10) {
    let url = decodeEntities(m[1])
    const uddg = url.match(/uddg=([^&]+)/)
    if (uddg) { try { url = decodeURIComponent(uddg[1]) } catch { /* 保留原样 */ } }
    if (!/^https?:\/\//.test(url)) continue
    out.push({ title: text(m[2]).slice(0, 100), url, snippet: text(m[3]).slice(0, 200) })
  }
  return out
}

export const ENGINES = {
  360: { url: (kw) => `https://www.so.com/s?q=${encodeURIComponent(kw)}`, parse: parse360, proxy: false },
  bing: { url: (kw) => `https://cn.bing.com/search?q=${encodeURIComponent(kw)}&format=rss`, parse: parseBingRss, proxy: false },
  ddg: { url: (kw) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(kw)}`, parse: parseDdg, proxy: true },
}

function urlKey(u) {
  try {
    const x = new URL(u)
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase()
  } catch { return String(u || '').toLowerCase() }
}

/** 同一条结果被两个引擎都给了 → 留高分的那条。 */
export function dedupe(items) {
  const seen = new Map()
  for (const it of items || []) {
    const k = urlKey(it.url)
    const prev = seen.get(k)
    if (!prev || (it.score || 0) > (prev.score || 0)) seen.set(k, it)
  }
  return [...seen.values()]
}

const NOISE = /(官网|官方网站|下载|app|推荐|最新|大全|是什么|怎么|如何|为什么)/gi

/** 全脏时的退路：去掉噪声词、只留前两个词、整串连写。最多两个变体，不做无限重试。 */
export function variantsOf(kw) {
  const s = String(kw || '').trim()
  const out = []
  const noNoise = s.replace(NOISE, ' ').replace(/\s+/g, ' ').trim()
  if (noNoise && noNoise !== s) out.push(noNoise)
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length > 2) out.push(parts.slice(0, 2).join(' '))
  if (parts.length > 1) out.push(parts.join(''))
  return out.filter((v, i) => v && v !== s && out.indexOf(v) === i).slice(0, 2)
}

/** 排序：分数高的在前；同分按引擎优先级（360 的中文长尾最好）。 */
function rank(items) {
  return [...(items || [])]
    .sort((a, b) => (b.score - a.score) || ((PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9)))
    .slice(0, 10)
}

/**
 * 多引擎搜索。
 * @param {string} kw
 * @param {{get:(url:string,opts?:object)=>Promise<string>}} deps
 * @returns {Promise<{results:Array, weak:boolean, tried:string[], all:number, errors:string[]}>}
 *   weak=true 表示"引擎有话要说，但说的都不是你要问的" —— 调用方必须如实说"没搜到"，不许拿脏数据当答案。
 */
export async function searchEngines(kw, { get, engines } = {}) {
  const q = String(kw || '').trim()
  if (!q) return { results: [], weak: true, tried: [], all: 0, errors: [] }
  if (typeof get !== 'function') throw new Error('searchEngines 需要注入 get()')
  // engines 由调用方按**它自己的能力**给（比如容器里没 curl、没代理，DDG 就是黑洞：
  // 直连 fetch 会一直卡到超时，实测把一次搜索从 2s 拉到 12s）。
  const ORDER = (Array.isArray(engines) && engines.length ? engines : ['360', 'bing', 'ddg']).filter((n) => ENGINES[n])
  const errors = []
  let pool = []

  const push = (items, source, against = q) => {
    for (const it of items || []) pool.push({ ...it, source, score: scoreItem(against, it) })
  }

  // 三家**并发**打（顺序打的时代最坏是 3×20s，加上变体会顶穿 look_up 的 90s 上限）：
  // 单家 12s 封顶，三家一共 ~12s。合并时按 ORDER 顺序 push，同分优先 360。
  const settled = await Promise.all(ORDER.map(async (name) => {
    const eng = ENGINES[name]
    try {
      const html = await get(eng.url(q), { proxy: !!eng.proxy, timeout: 12000 })
      return { name, items: eng.parse(String(html || '')) }
    } catch (e) {
      return { name, error: `${name} 失败：${String(e?.message || e).slice(0, 100)}` }
    }
  }))
  const tried = settled.map((s) => s.name)
  for (const s of settled) {
    if (s.error) errors.push(s.error)
    else push(s.items, s.name)
  }

  pool = dedupe(pool)
  let relevant = pool.filter((x) => x.score >= RELEVANT)

  if (!relevant.length) {
    // 全脏 → 换短写法再搜一次。变体的结果按**变体自身**打分（它就是这个意思的另一种说法），
    // 但乘 0.9，同样的对题程度下优先原句。
    for (const v of variantsOf(q)) {
      tried.push('360:' + v)
      try {
        const html = await get(ENGINES['360'].url(v), { timeout: 12000 })
        for (const it of ENGINES['360'].parse(String(html || ''))) {
          pool.push({ ...it, source: '360', variant: v, score: scoreItem(v, it) * 0.9 })
        }
      } catch (e) {
        errors.push(`360 变体失败（${v}）：${String(e?.message || e).slice(0, 80)}`)
        swallow(e, 'search:variant')
      }
    }
    pool = dedupe(pool)
    relevant = pool.filter((x) => x.score >= RELEVANT)
  }

  return { results: rank(relevant), weak: relevant.length === 0, tried, all: pool.length, errors }
}
