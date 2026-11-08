// web —— 她的上网工具（10-25）：全网瞎溜达的手脚。
//   node bot.mjs web search "关键词"        # 搜索（Bing 国内直连优先，DDG 走代理兜底）
//   node bot.mjs web fetch <url>            # 读网页正文（内网/外网都行，≤4000 字）
//   node bot.mjs web log                    # 翻她的上网日志（~/.data/web-log.md）
// 设计给 DSH 会话里的她直接调用：搜到→fetch→记 lore→写日记，是"自由活动"的底座。
// 每次搜索/访问都写 web-log.md —— 活动可审计。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'
import { sanitizeText } from '../lib/sanitize.mjs'
import { searchEngines, scoreItem, RELEVANT } from '../lib/search-engines.mjs'
import { dataPath, homePath, WORK_DIR } from '../lib/paths.mjs'
import { acquire } from '../lib/lock.mjs'
import { swallow } from '../lib/swallow.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const LOG = () => dataPath('web-log.md')
const PROXY = () => config().web?.proxy ?? config().browser?.proxy ?? ''
const CURL = () => (fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl')
/**
 * 容器里有没有 curl（2026-11-07 实测：生产容器 **没有 curl**）。
 * 病根：web search / web fetch 只用 execFileSync('curl')，而镜像里没有 curl
 * —— 于是"上网"这一层在生产上从来没成功过一次，而 look_up 一直在工具清单里。
 * Node 18+ 自带 fetch 直连能出网（实测 Bing RSS 200/345ms），curl 只在配代理时兜底。
 */
const HAS_CURL = (() => {
  try {
    if (fs.existsSync('C:/Windows/System32/curl.exe')) return true
    execFileSync('curl', ['--version'], { stdio: 'ignore', timeout: 2000 })
    return true
  } catch { return false }
})()
const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 异步取文本：fetch 优先（容器唯一可用路径），curl 兜底（本地/需要代理时）。
 *  fetch 失败**重试一次**：undici 的连接池会复用被对端悄悄关掉的闲置 socket，
 *  长驻进程（roam 就在 bot.mjs 里跑）第一次请求经常直接 "fetch failed" —— 见 lib/fetch-bytes.mjs 的同类记载。 */
async function httpGet(url, { proxy = false, timeout = 30000, headers = {} } = {}) {
  if (proxy && HAS_CURL && PROXY()) return curlGet(url, { proxy: true, timeout })
  const once = async () => {
    const r = await fetch(url, {
      headers: { 'user-agent': HTTP_UA, 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.text()
  }
  try {
    return await once()
  } catch (e) {
    if (HAS_CURL) return curlGet(url, { proxy, timeout })
    if (e?.name === 'AbortError' || /HTTP 4\d\d/.test(String(e?.message))) throw e   // 超时/被拒：重试也没用
    await new Promise((r) => setTimeout(r, 250))
    return await once()   // 坏 socket 已被 undici 摘掉，这一次走新连接
  }
}

function curlGet(url, { proxy = false, timeout = 30000 } = {}) {
  const args = ['-sS', '-L', '-m', String(Math.ceil(timeout / 1000)), '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', url]
  if (proxy) args.splice(1, 0, '-x', PROXY())
  try {
    return execFileSync(CURL(), args, { encoding: 'utf8', timeout: timeout + 5000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
  } catch (e) {
    throw new Error(`访问失败：${String(e.message).slice(0, 120)}`)
  }
}

function logWeb(kind, what) {
  try {
    const now = new Date()
    const day = now.toLocaleDateString('sv-SE')
    const time = now.toTimeString().slice(0, 5)
    const md = LOG()
    let content = ''
    try { content = fs.readFileSync(md, 'utf8') } catch (e) { swallow(e, 'web:logWeb') }
    if (!content.startsWith('# 理想的机械人 · 上网日志')) content = '# 理想的机械人 · 上网日志\n\n> 她在网上干过什么（搜索/访问/自我升级），按天记录（最新在上）。\n\n'
    if (!content.includes(`## ${day}\n`)) content = content.replace('# 理想的机械人 · 上网日志\n\n> 她在网上干过什么（搜索/访问/自我升级），按天记录（最新在上）。\n\n', `# 理想的机械人 · 上网日志\n\n> 她在网上干过什么（搜索/访问/自我升级），按天记录（最新在上）。\n\n## ${day}\n\n`)
    const at = content.indexOf(`## ${day}\n`) + `## ${day}\n\n`.length
    content = content.slice(0, at) + `- ${time} **${kind}** ${String(what).slice(0, 180)}\n` + content.slice(at)
    fs.mkdirSync(path.dirname(md), { recursive: true })
    fs.writeFileSync(md, content)
  } catch (e) { swallow(e, 'web:logWeb') }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** 搜索链：多引擎（引擎层）→ 内置浏览器开 SERP（360，过风控）→ 顶层浏览器结果也要过相关性关。
 *  两层的分工不变：引擎被墙/改版时浏览器层还能读 SERP；但"读到了脏数据"不算成功。 */
export async function searchSmart(kw) {
  kw = sanitizeText('search', kw)   // 出站硬脱敏（2026-11-03）：搜什么词也出得去
  const detail = await searchWeb(kw)
  let results = detail.results
  if (results.length) return results
  // 引擎**答了**只是全不对题 → 换浏览器读同一个 SERP 也是白搭，别白起一次 chromium。
  // 只有"试过的引擎全挂"（网络/风控）时，真浏览器才可能不一样。
  if (!detail.tried.length || detail.errors.length < detail.tried.length) return results
  try {
    const { browserRead, browserDetach, hasChromium } = await import('../lib/browser.mjs')
    if (!hasChromium()) return results   // 没有浏览器：上面 fetch 到多少就是多少，别去 spawn
    const p = await browserRead(`https://www.so.com/s?q=${encodeURIComponent(kw)}`, { waitMs: 6000, maxChars: 3000, links: true })
    const cand = []
    for (const l of (p.links || []).slice(0, 30)) {
      if (!/^https?:/.test(l.href) || /so\.com|360\.com|360kan|bing\.com|microsoft\.com/i.test(l.href)) continue
      const item = { title: String(l.text || '').slice(0, 80), url: l.href, snippet: '(经内置浏览器 SERP 读取，正文用 browse_page 读)' }
      if (scoreItem(kw, item) < RELEVANT) continue
      cand.push(item)
      if (cand.length >= 10) break
    }
    if (cand.length) {
      results = cand
      logWeb('搜索', `「${kw}」→ ${cand.length} 条（内置浏览器 SERP）`)
    }
  } catch (e) { swallow(e, 'web:searchBrowser') } finally {
    try { const m2 = await import('../lib/browser.mjs'); await m2.browserDetach() } catch (e2) { swallow(e2, 'web:searchDetach') }
  }
  return results
}

/** 搜索：多引擎 + 相关性打分（见 lib/search-engines.mjs）。
 *  @returns {Promise<{results:Array<{title,url,snippet,source,score}>, weak:boolean, tried:string[], all:number, errors:string[]}>}
 *  调用方要自己拿 `weak` 决定说不说"没搜到" —— 引擎说"N 条"但一条都不含 query 的词，等于没搜到。 */
export async function searchWeb(kw) {
  kw = sanitizeText('search', kw)   // 出站硬脱敏（2026-11-03）
  // DDG 只在"有 curl 且配了代理"时才值得打：容器里两者都没有，直连 fetch 会卡到超时（实测 12s/次）。
  const engines = HAS_CURL && PROXY() ? ['360', 'bing', 'ddg'] : ['360', 'bing']
  const out = await searchEngines(kw, { get: (url, opts) => httpGet(url, opts), engines })
  if (out.weak) {
    // 只有"最后真没结果"时才算失败；引擎平时正常答话时不该在日志里刷失败噪声。
    for (const e of out.errors) logWeb('搜索失败', `${kw} · ${e}`)
    logWeb('搜索', `「${kw}」→ 全脏，0 条（试过 ${out.tried.join('/')}，抓回 ${out.all} 条全不对题）`)
  } else {
    const srcs = [...new Set(out.results.map((r) => r.source))].join('+')
    logWeb('搜索', `「${kw}」→ ${out.results.length} 条（${srcs}${out.results.some((r) => r.variant) ? '·变体' : ''}）`)
  }
  return out
}

/** 读网页正文（内外网皆可；先直连后代理） */

/** 受限 headless 浏览器：渲染 JS 页面后取正文。
 *  服务在宿主机 3070，带 SSRF 防护（私网/回环一律拒绝）。 */
export async function browseWeb(url, opts = {}) {
  if (!/^https?:/.test(url)) throw new Error('只支持 http(s) 链接：' + url)
  const svc = process.env.BOT_BROWSER_URL || 'http://172.17.0.1:3070'
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30000)
  let r
  try {
    r = await fetch(svc + '/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, waitMs: opts.waitMs || 3000, maxChars: opts.maxChars || 8000 }),
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const d = await r.json()
  if (!d.ok) throw new Error('浏览器打不开：' + (d.error || 'unknown') + (d.blocked ? ' (' + d.blocked + ')' : ''))
  logWeb('浏览', url)
  const head = d.title ? d.title + '\n' + d.url + '\n\n' : ''
  return head + d.text + (d.truncated ? '\n\n[正文过长已截断]' : '')
}

export async function fetchWeb(url) {
  if (!/^https?:\/\//.test(url)) throw new Error('只支持 http(s) 链接：' + url)
  let html = ''
  try {
    html = await httpGet(url, { proxy: false, timeout: 25000 })
  } catch {
    html = await httpGet(url, { proxy: true, timeout: 40000 })
  }
  const text = htmlToText(html).slice(0, 4000)
  const shell = shellPageReason(text)
  if (shell) throw new Error(shell + `：${url}`)
  logWeb('访问', url)
  return text
}

/** 空壳页判定（正文没有、只有站点模板/登录墙）。返回原因，正常页返回 ''。
 *  10-26：她今天把同一个知乎落地页读了 11 次 —— 抓到的是"知乎，让每一次点击都充满意义…"，
 *  正文一个字没有。她以为"读完了没记住"，下一轮又去读同一页。 */
export function shellPageReason(text) {
  const s = String(text ?? '')
  const bare = s.replace(/\s+/g, '')
  const BOILER = [
    '知乎，让每一次点击都充满意义', '登录知乎', '登录后你可以', '扫码登录',
    '请开启JavaScript', '启用JavaScript', '您的浏览器不支持', '访问验证', '滑动验证',
    '该内容已被删除', '内容不存在', '404 Not Found', '页面不存在',
  ]
  const hit = BOILER.find((b) => s.includes(b))
  if (hit && bare.length < 900) return `这一页只抓到站点模板（含"${hit}"），没有正文 —— 换一个链接或直接搜关键字吧`
  if (bare.length < 200) return `这一页正文太少（${bare.length} 字），大概是空壳页/需要登录 —— 换个链接吧`
  return ''
}

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }

/** 她的自主漫游循环（--free）：每一轮她自己决定在网上干什么 —— 跟 bili-watch --free 同款哲学。
 *  行动类型：搜索 / 读网页 / 写小说片段 / 学习总结入库 / 自我升级（仅 web.selfUpgrade 开着）。
 *  每轮 LLM 出 JSON 计划 → 执行 → 写日志/记忆 → 休息 restMin → 下一轮。 */
async function roamLoop() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  console.log('🌐 自由上网模式启动：她自己决定逛什么、玩什么、学什么（Ctrl/面板关停）')
  let round = 0
  let lastResults = []   // 上轮搜到的链接 → 下一轮"读网页"的素材
  while (true) {
    const cfg = config()
    const roam = cfg.web?.roam ?? {}
    if (roam.enabled === false) { console.log('（web.roam.enabled 已关，收摊）'); return }
    round++
    try {
      // 素材：她是谁、最近见闻、兴趣、上一轮干了什么（从日志尾捞）
      const { buildMessages } = await import('../lib/persona.mjs')
      const { loreInterests, recent } = await import('../lib/memory.mjs')
      let lastDo = ''
      try {
        const logTail = fs.readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).slice(-3).join(' / ')
        lastDo = logTail.slice(0, 200)
      } catch (e) { swallow(e, 'web:sleep') }
      const built = buildMessages({ platform: 'qq', userText: '', chatId: 'qq:web-roam-self', userId: String(cfg.owner?.qq || ''), turnsToday: round })
      const msgs = [
        built[0],
        { role: 'user', content: '【自由上网 · 第 ' + round + ' 轮】你在网上，自己决定现在干什么。可选行动：'
          + '\n①搜索——搜一个你此刻好奇的关键词（query 字段）'
          + '\n②读网页——深读一个链接（url 字段，可以来自你上轮搜到的结果）'
          + '\n③写小说——写一段你的原创小说/小故事（topic 字段，30~200字正文放进 text）'
          + '\n④学习——把最近见闻沉淀成一条认识（topic+text，会自动入库记忆）'
          + (cfg.web?.selfUpgrade?.enabled === true
            ? '\n⑤自我升级——改自己的代码（query=目标文件相对路径，text=要做的修改描述）。**必须先想清楚为什么改**；系统会自动备份，你改完要跑测试。偶尔为之，别没事重构。'
            : '')
          + '\n手上的素材（自然地用）：\n- 兴趣：' + loreInterests(3).join('；').slice(0, 120)
          + '\n- 最近在忙：' + (recent('qq:web-roam-self', 3).map((m) => String(m.content).slice(0, 30)).join('；') || '刚上线')
          + '\n- 刚才在网上：' + (lastDo || '还没开始')
          + (lastResults.length ? '\n- 上轮搜到的链接（读网页可选这些）：\n' + lastResults.slice(0, 4).map((r) => '  · ' + r.title.slice(0, 30) + ' ' + r.url).join('\n') : '')
          + '\n只输出 JSON：{"action":"搜索|读网页|写小说|学习|自我升级","query":"…","url":"…","text":"…","why":"一句话原因"}' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 500, purpose: 'creative' })
      const m = String(resp ?? '').match(/\{[\s\S]*\}/)
      if (!m) { console.log('（这轮没出计划，歇会儿）'); await sleep(60000); continue }
      let plan; try { plan = JSON.parse(m[0]) } catch { await sleep(60000); continue }
      const act = String(plan.action || '搜索')
      console.log(`\n[roam #${round}] ${act}：${String(plan.why || plan.query || plan.topic || plan.url || '').slice(0, 60)}`)

      if (act === '搜索' && String(plan.query || '').trim()) {
        const rs = await searchSmart(String(plan.query).trim())   // searchWeb 内部已记日志
        for (const r of rs.slice(0, 5)) console.log('  ·', r.title, '—', r.url)
        lastResults = rs
        try { const { remember } = await import('../lib/memory.mjs'); remember('web', 'web:roam', cfg.identity?.name ?? 'dsh_bot', 'assistant', `（搜索了「${String(plan.query).slice(0, 40)}」，首选：${rs[0]?.title || ''}）`) } catch (e) { swallow(e, 'web:sleep') }      } else if (act === '读网页' && String(plan.url || '').trim()) {
        const url = String(plan.url).trim()
        let text = ''
        try {
          text = await browseSmart(url).catch(() => fetchWeb(url))   // 浏览器优先，curl 兜底
        } catch (e) {
          // 读不到就明确记一笔"别再来"，并把这条链接从下一轮候选里去掉 —— 否则她会一直读同一页空壳
          console.log('  ✗ ' + String(e.message).slice(0, 140))
          logWeb('读不到', url.slice(0, 70))
          lastResults = lastResults.filter((r) => r.url !== url)
          try {
            const { remember } = await import('../lib/memory.mjs')
            remember('web', 'web:roam', cfg.identity?.name ?? 'dsh_bot', 'assistant', `（这一页读不到正文，别再读它了：${url.slice(0, 60)}）`)
          } catch (e) { swallow(e, 'web:sleep') }
        }
        if (text) {
          console.log('  正文前 200 字：' + text.slice(0, 200).replace(/\n/g, ' '))
          // 读完顺手沉淀
          try {
            const { remember } = await import('../lib/memory.mjs')
            remember('web', 'web:roam', cfg.identity?.name ?? 'dsh_bot', 'assistant', `（读了 ${url}：${text.slice(0, 80)}）`)
          } catch (e) { swallow(e, 'web:sleep') }
        }
      } else if (act === '写小说' && String(plan.text || '').trim()) {
        const dir = path.join(WORK_DIR, 'creative')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `novel-${new Date().toLocaleDateString('sv-SE')}.md`)
        fs.appendFileSync(file, `\n## ${new Date().toTimeString().slice(0, 5)} ${String(plan.topic || '').slice(0, 30)}\n\n${String(plan.text).slice(0, 800)}\n`)
        console.log('  ✓ 存入', file)
        logWeb('写小说', String(plan.topic || '').slice(0, 40))
        try { const { remember } = await import('../lib/memory.mjs'); remember('web', 'web:roam', cfg.identity?.name ?? 'dsh_bot', 'assistant', `（写了小说片段：${String(plan.topic || '').slice(0, 30)}——${String(plan.text).slice(0, 60)}）`) } catch (e) { swallow(e, 'web:sleep') }
      } else if ((act === '学习' || act === '自我升级') && String(plan.text || '').trim()) {
        if (act === '自我升级') {
          if (cfg.web?.selfUpgrade?.enabled !== true) { console.log('  （自我升级未开启，这轮跳过）'); await sleep(60000); continue }
          doBackup()
          console.log('  🔒 已自动备份，升级内容：' + String(plan.text).slice(0, 100))
          logWeb('自我升级', String(plan.text).slice(0, 120))
          try { const { remember } = await import('../lib/memory.mjs'); remember('web', 'web:roam', cfg.identity?.name ?? 'dsh_bot', 'assistant', `（自我升级：${String(plan.text).slice(0, 80)}）`) } catch (e) { swallow(e, 'web:best-effort') }
          // 她在 DSH 会话里才能真正改文件 —— 这里的角色是"记账+备份"，实际修改由她会话执行
        } else {
          const { addLore } = await import('../lib/memory.mjs')
          addLore('学习', `${String(plan.topic || plan.why || '').slice(0, 40)}：${String(plan.text).slice(0, 120)}`)
          console.log('  ✓ 已入库记忆')
          logWeb('学习', String(plan.text).slice(0, 120))
        }
      } else {
        console.log('  （计划不完整，歇会儿）')
        await sleep(60000)
        continue
      }
      const restMin = Number(roam.restMin ?? 2)
      await sleep(restMin * 60_000 + Math.random() * 30_000)
    } catch (e) {
      console.log('[roam] 这轮出错：' + String(e.message).slice(0, 120) + '，歇 2 分钟再来')
      await sleep(120000)
    }
  }
}

function doBackup() {
  // 轻量备份：调 selfup 命令（同目录），避免重复实现
  try { execFileSync(process.execPath, [path.join(HERE, 'selfup.mjs'), 'backup'], { encoding: 'utf8', timeout: 120000, windowsHide: true }) } catch (e) { swallow(e, 'web:doBackup') }
}

/** 浏览器优先的读页：JS 渲染页走内置 chromium（tools/lib/browser.mjs），
 *  起不来/读不到再落回 curl 扒静态 —— 永远不比以前差。 */
export async function browseSmart(url, { device = 'auto', waitMs = 9000, maxChars = 8000, links = false } = {}) {
  try {
    const { browserRead, hasChromium } = await import('../lib/browser.mjs')
    if (!hasChromium()) throw new Error('no-chromium')   // 直接落回 fetch，不白起进程
    const p = await browserRead(url, { device, waitMs, maxChars, links })
    logWeb('浏览', `${url}（${p.device === 'pc' ? '电脑' : '手机'}·内置浏览器）`)
    const head = `${p.title}\n${p.url}\n[身份：${p.device === 'pc' ? '电脑' : '手机'}${p.more ? ' · 未完可续读' : ''}]\n\n`
    return head + p.text + (p.links?.length ? '\n\n—— 可点的链接 ——\n' + p.links.map((l) => `${l.text} → ${l.href}`).join('\n') : '')
  } catch (e) {
    swallow(e, 'web:browseSmart')
    return await fetchWeb(url)   // fetch 兜底（空壳页会在 shellPageReason 抛提示）
  } finally {
    try { const m = await import('../lib/browser.mjs'); await m.browserDetach() } catch (e) { swallow(e, 'web:browseDetach') }
  }
}

export async function run(argv = []) {
  const sub = argv[0] || 'help'
  const has = (n) => argv.includes(n)

  if (sub === 'roam' || has('--free')) {
    if (!acquire('web-roam')) { console.log('[web] 已有自由上网实例在跑，本次不重复启动'); return }
    await roamLoop(); return
  }

  if (sub === 'search') {
    const kw = argv.slice(1).join(' ').trim()
    if (!kw) { console.log('用法：web search "关键词"'); return }
    const rs = await searchSmart(kw)
    if (!rs.length) {
      console.log(`「${kw}」没搜到对题的结果：各引擎抓回来的页面里没有一条真跟你问的对得上。`
        + '\n（换个更具体的说法再搜一次；还是不行就直说不知道，别拿不相关的东西凑答案。）')
      return
    }
    console.log(`「${kw}」的搜索结果（${rs.length} 条）：`)
    for (const [i, r] of rs.entries()) {
      const snip = String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 110)
      console.log(`${i + 1}. ${r.title}\n   ${r.url}${snip ? '\n   ' + snip : ''}`)
    }
    return
  }

  if (sub === 'browse') {
    const url = argv[1]
    if (!url) { console.log('用法：web browse <url> [--pc|--mobile] [--wait 3000] [--chars 8000] [--links]'); return }
    const waitIdx = argv.indexOf('--wait')
    const waitMs = waitIdx > 0 ? Number(argv[waitIdx + 1]) || 3000 : 3000
    const charsIdx = argv.indexOf('--chars')
    const maxChars = charsIdx > 0 ? Number(argv[charsIdx + 1]) || 8000 : 8000
    const device = has('--mobile') ? 'mobile' : has('--pc') ? 'pc' : 'auto'
    console.log(await browseSmart(url, { waitMs, maxChars, device, links: has('--links') }))
    return
  }

  if (sub === 'fetch') {
    const url = argv[1]
    if (!url) { console.log('用法：web fetch <url>'); return }
    console.log(await fetchWeb(url))
    return
  }

  if (sub === 'log') {
    try { console.log(fs.readFileSync(LOG(), 'utf8')) } catch { console.log('（还没上过网）') }
    return
  }

  console.log('用法：web search "关键词" | web fetch <url> | web log | web roam --free（自由上网常驻）')
}

if (process.argv[1] && process.argv[1].endsWith('web.mjs')) {
  await run(process.argv.slice(2))
}
