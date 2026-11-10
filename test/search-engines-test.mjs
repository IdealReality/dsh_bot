// search-engines —— 搜索引擎层（2026-11-08）
//
// 这里不联网：盯的是那些"网络好好的也不会被发现"的错。
//   · 360 的真实地址在 data-mdurl，外层 href 是 so.com/link 跳转壳 —— 抓错字段=给她一堆假链接
//   · bing 对多词中文 query 会退化成首词（"费曼 趣事…" → 全是"费"的百科），
//     这类结果必须被打低分，否则等于"看着搜到了、其实全脏"
//   · 全脏时必须换短写法再搜一次，且最多两次（不许无限重试）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-search-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const S = await import('../tools/lib/bili/search-engines.mjs')

// ── 真实 360 结果块（2026-11-08 实测抓取，属性顺序照抄） ──────────────────
const SO_BLOCK = `<ul class="result"><li class="res-list" data-result-type="normal" data-result-pos="1"><h3 class="res-title " >
<a  href="https://www.so.com/link?m=ubUYPPpYU1WVixuHA6PhQpF88DEa3AEMuef%2F1L1j" data-mdurl="http://www.sfacg.com/app/"  rel="noopener" data-res='{"tp":12}'  target="_blank"><em>菠萝包轻小说</em>-SF轻小说国内最大轻小说原创网站</a></h3>
<p class="res-desc"><span class="gray g-c-gray">2026年10月31日&nbsp;-&nbsp;</span><span data-result-summary>提供最新最全的<em>轻小说</em>网站,言情小说,玄幻小说</span></p><p class="g-linkinfo"><cite><a href="https://www.so.com/link?m=x" class="g-linkinfo-a">www.sfacg.com</a></cite></p></li><li class="res-list" data-result-type="normal" data-result-pos="2"><h3 class="res-title " >
<a  href="https://www.so.com/link?m=zzz" target="_blank">没有 data-mdurl 的广告位</a></h3><p class="res-desc">广告</p></li></ul>`

const SO_MANY = [1, 2, 3, 4]
  .map((n) => SO_BLOCK.replace('data-mdurl="http://www.sfacg.com/app/"', `data-mdurl="http://www.sfacg.com/app${n}/"`))
  .join('')

const BING_JUNK = `<?xml version="1.0"?><rss><channel>
<item><title>费（汉语文字）_百度百科</title><link>https://baike.baidu.com/item/%E8%B4%B9/1870256</link><description>费，汉语文字</description></item>
<item><title>费的意思,费的解释</title><link>https://www.guoxuedashi.net/zidian/fei.html</link><description>汉语国学</description></item>
</channel></rss>`

const BING_OK = `<?xml version="1.0"?><rss><channel>
<item><title>菠萝包轻小说-SF轻小说国内最大轻小说原创网站</title><link>https://www.sfacg.com/app/</link><description>最新最全的轻小说网站</description></item>
</channel></rss>`

console.log('\n[360 解析]')
{
  const r = S.parse360(SO_BLOCK)
  ok('只取有 data-mdurl 的条目', r.length === 1, 'got ' + r.length)
  ok('真实地址来自 data-mdurl', r[0].url === 'http://www.sfacg.com/app/', r[0].url)
  ok('不暴露 so.com 跳转壳', !r.some((x) => x.url.includes('so.com/link')))
  ok('标题去掉 <em> 标签', r[0].title.startsWith('菠萝包轻小说-SF轻小说'), r[0].title)
  ok('摘要取 res-desc 并解码 &nbsp;', r[0].snippet.includes('提供最新最全的轻小说网站'), r[0].snippet)
  ok('空 html 不崩', S.parse360('').length === 0 && S.parse360(null).length === 0)
}

console.log('\n[bing 解析]')
{
  const j = S.parseBingRss(BING_JUNK)
  ok('junk 也能解析出 2 条（引擎确实有返回）', j.length === 2, String(j.length))
  const g = S.parseBingRss(BING_OK)
  ok('正常条目：标题/链接', g[0].url === 'https://www.sfacg.com/app/' && g[0].title.includes('菠萝包轻小说'))
  ok('缺 <item> 的空壳 → 0 条', S.parseBingRss('<html>验证</html>').length === 0)
}

console.log('\n[相关性打分]')
{
  const kw = '费曼 趣事 科学顽童 故事'
  ok('bing 首词退化结果 → 0 分（脏）', S.scoreItem(kw, { title: '费（汉语文字）_百度百科' }) === 0,
    String(S.scoreItem(kw, { title: '费（汉语文字）_百度百科' })))
  const good = S.scoreItem(kw, { title: '科学顽童费曼的故事.doc - 360文库' })
  ok('360 对题结果 ≥ 及格线', good >= S.RELEVANT, String(good))
  ok('引擎插的空格不影响匹配', S.scoreItem('菠萝包 轻小说', { title: '菠萝包 轻小说 官网' }) > 0.9,
    String(S.scoreItem('菠萝包 轻小说', { title: '菠萝包 轻小说 官网' })))
  ok('连写整体也算一个词', S.tokensOf('菠萝包 轻小说').includes('菠萝包轻小说'))
  ok('无 query → 0 分不崩', S.scoreItem('', { title: 'x' }) === 0)

  // 改写型 query：二元组能给部分分，但不足以算"搜到"（否则又回到"脏数据当结果"）
  const fuzzy = S.scoreItem('醒来后脑子发懵 多久能恢复', { title: '意识朦胧状态多久能苏醒_39问医生' })
  ok('改写页拿到部分分', fuzzy > 0 && fuzzy < S.RELEVANT, String(fuzzy))
  ok('两字词不放宽（否则 bing 首词退化又进来了）', S.tokenCover('费曼', S.norm('费（汉语文字）')) === 0)
}

console.log('\n[多引擎编排]')
{
  // ① 360 命中 → 不再打 bing/ddg
  const calls = []
  const fakeGet = (url) => {
    calls.push(url)
    if (url.startsWith('https://www.so.com/')) return Promise.resolve(SO_MANY)
    if (url.includes('bing.com')) return Promise.resolve(BING_JUNK)
    return Promise.reject(new Error('should not reach ddg'))
  }
  const a = await S.searchEngines('菠萝包 轻小说', { get: fakeGet })
  ok('360 命中 → weak=false', a.weak === false)
  ok('三家并发都打（不再顺序短路）', calls.length === 3, String(calls.length))
  ok('360 的地址在最前', calls[0].startsWith('https://www.so.com/'), calls[0].slice(0, 40))
  ok('结果带引擎来源', a.results[0].source === '360', a.results[0].source)
  ok('结果带分数', a.results[0].score >= S.RELEVANT, String(a.results[0].score))

  // ② 只有脏数据 → weak=true，并且换短写法再搜（tried 里出现变体）
  const calls2 = []
  const fakeJunk = (url) => {
    calls2.push(decodeURIComponent(url))
    if (url.includes('bing.com')) return Promise.resolve(BING_JUNK)
    if (url.startsWith('https://www.so.com/')) return Promise.resolve(BING_JUNK)
    return Promise.reject(new Error('fetch failed'))
  }
  const b = await S.searchEngines('费曼 趣事 科学顽童 故事', { get: fakeJunk })
  ok('全脏 → weak=true（不许当搜到）', b.weak === true && b.results.length === 0)
  ok('打过 ddg（前三家都试了）', calls2.some((u) => u.includes('duckduckgo')), calls2.join(' | ').slice(0, 160))
  ok('全脏后换短写法再搜一次', b.tried.some((t) => t.startsWith('360:')), b.tried.join(' | '))
  ok('变体不超过两条', b.tried.filter((t) => t.startsWith('360:')).length <= 2, b.tried.join(' | '))

  // ③ 单个引擎抛错不拖垮整条链
  const c = await S.searchEngines('菠萝包 轻小说', {
    get: (url) => {
      if (url.startsWith('https://www.so.com/')) return Promise.reject(new Error('HTTP 503'))
      return Promise.resolve(BING_OK)
    },
  })
  ok('360 挂了 → bing 顶上', c.weak === false && c.results[0].source === 'bing', JSON.stringify(c.results[0] || {}))

  // ④ 引擎全挂 → 空结果、不抛
  const d = await S.searchEngines('随便什么', { get: () => Promise.reject(new Error('ENETUNREACH')) })
  ok('全挂 → weak=true 且不抛', d.weak === true && d.results.length === 0)
  ok('全挂但记下了试过谁', d.tried.includes('360') && d.tried.includes('bing') && d.tried.includes('ddg'), d.tried.join(' | '))

  // ⑤ 空 query 不打网络
  let touched = 0
  const e = await S.searchEngines('   ', { get: () => { touched++; return Promise.resolve('') } })
  ok('空 query → 0 条且不打网络', e.results.length === 0 && touched === 0)

  // ⑥ 原句全脏、变体（短写法）搜到了 → 结果按变体打分，并标上 variant
  const f = await S.searchEngines('菠萝包 轻小说 官网', {
    get: (url) => {
      const q = decodeURIComponent(url).replace(/^.*[?&]q=/, '').replace(/&.*$/, '')
      if (q === '菠萝包 轻小说 官网') return Promise.resolve(BING_JUNK)
      if (q === '菠萝包 轻小说') return Promise.resolve(SO_MANY)
      return Promise.reject(new Error('nope'))
    },
  })
  ok('变体搜到 → weak=false', f.weak === false, JSON.stringify(f.tried))
  ok('结果标了 variant', f.results.length > 0 && !!f.results[0].variant, JSON.stringify(f.results[0] || {}))
  ok('变体检索确实发生了', f.tried.includes('360:菠萝包 轻小说'), f.tried.join(' | '))

  // ⑦ 引擎错误被收集（而不是吞掉）
  const g = await S.searchEngines('任意', { get: () => Promise.reject(new Error('HTTP 503')) })
  ok('错误进 errors（weak 时才落日志）', g.errors.length >= 3 && g.errors[0].includes('503'), g.errors.join(' | ').slice(0, 120))

  // ⑧ 调用方可以按自己的能力裁掉引擎（容器里没代理时 DDG 是黑洞，别白等超时）
  const h = []
  await S.searchEngines('菠萝包 轻小说', {
    engines: ['360', 'bing'],
    get: (url) => { h.push(url); return Promise.resolve(SO_MANY) },
  })
  ok('只打允许的引擎', h.length === 2 && !h.some((u) => u.includes('duckduckgo')), h.join(' | ').slice(0, 120))
}

console.log('\n[去重与排序]')
{
  const dup = S.dedupe([
    { title: 'a', url: 'https://www.sfacg.com/app/', snippet: '', score: 0.3, source: '360' },
    { title: 'a2', url: 'https://sfacg.com/app', snippet: '', score: 0.9, source: 'bing' },
    { title: 'b', url: 'https://book.sfacg.com/List/', snippet: '', score: 0.5, source: '360' },
  ])
  ok('同一条只留一条', dup.length === 2, String(dup.length))
  ok('留高分那条', dup.find((x) => x.url.includes('app'))?.score === 0.9)
}

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)
