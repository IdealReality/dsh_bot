// 扫描：她的数据里有没有测试/合成数据
import fs from 'node:fs'
import path from 'node:path'

const D = '/home/dsh/.data'
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')) } catch { return d } }
const now = Date.now()

// 测试/合成数据的关键词（宽口径，宁可多报让人看）
const KW = /(\btest\b|测试|探针|probe|dummy|fake|sample|示例|样例|lorem|foo ?bar|asdf|123456|乱码|placeholder|todo|hello world|占位)/i

function scanEpisodes() {
  const dir = path.join(D, 'brain', 'ep')
  const out = { files: [], total: 0, kw: [], suspicious: [], bySrc: {} }
  let names = []
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { return out }
  for (const f of names) {
    const p = path.join(dir, f)
    let lines = []
    try { lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) } catch { continue }
    out.files.push({ file: f, n: lines.length, sizeKb: Math.round(fs.statSync(p).size / 1024) })
    for (const l of lines) {
      let r = null
      try { r = JSON.parse(l) } catch { continue }
      out.total++
      const gist = String(r.gist || '') + ' ' + String(r.quote || '')
      const src = String(r.srcEv || '')
      const proc = src.split('_').slice(-2)[0] || '?'
      out.bySrc[proc] = (out.bySrc[proc] || 0) + 1
      if (KW.test(gist)) out.kw.push({ id: r.id, at: r.at, platform: r.where?.platform, clip: gist.slice(0, 70), src })
      // 合成痕迹：未来时间 / 整分钟落点 / srcEv 为空
      const at = Number(r.at || 0)
      const flags = []
      if (at > now + 60_000) flags.push('未来时间')
      if (at % 60_000 === 0) flags.push('整分钟')
      if (!src) flags.push('无srcEv')
      if (!r.where || !r.where.platform) flags.push('无platform')
      if (flags.length) out.suspicious.push({ id: r.id, at, flags, clip: gist.slice(0, 50) })
    }
  }
  return out
}

function scanJsonFiles() {
  const targets = ['facts.json', 'lore.json', 'promises.json', 'bonds.json', 'bond.json', 'roster.json',
    'inner.json', 'selfcon.json', 'replies-state.json', 'bili-own-engage.json', 'bili-actions.json',
    'web/wander.json', 'brain/meta/identity.json', 'brain/meta/self-state.json', 'brain/meta/field.json']
  const out = []
  for (const t of targets) {
    const p = path.join(D, t)
    if (!fs.existsSync(p)) { out.push({ file: t, exists: false }); continue }
    const size = fs.statSync(p).size
    let raw = ''
    try { raw = fs.readFileSync(p, 'utf8') } catch { }
    const hits = []
    const re = new RegExp(KW.source, 'gi')
    let m
    while ((m = re.exec(raw)) && hits.length < 6) {
      const a = Math.max(0, m.index - 40)
      hits.push(raw.slice(a, m.index + 40).replace(/\s+/g, ' '))
    }
    out.push({ file: t, exists: true, sizeKb: Math.round(size / 1024), kwHits: hits })
  }
  return out
}

const ep = scanEpisodes()
console.log('=== 记忆库 brain/ep ===')
for (const f of ep.files) console.log(`  ${f.file}  ${f.n} 条  ${f.sizeKb}KB`)
console.log('  合计', ep.total, '条')
console.log('  按写入进程:', JSON.stringify(ep.bySrc))
console.log('\n  命中测试关键词:', ep.kw.length, '条')
for (const h of ep.kw.slice(0, 15)) {
  console.log(`    ${new Date(h.at).toLocaleString('zh-CN')} [${h.platform}] ${h.clip}  (src=${h.src})`)
}
console.log('\n  可疑合成痕迹:', ep.suspicious.length, '条')
for (const s of ep.suspicious.slice(0, 12)) {
  console.log(`    ${new Date(s.at).toLocaleString('zh-CN')} ${s.flags.join('/')}  ${s.clip}`)
}

console.log('\n=== 其它数据文件 ===')
for (const f of scanJsonFiles()) {
  if (!f.exists) { console.log(`  ${f.file}  (不存在)`); continue }
  console.log(`  ${f.file}  ${f.sizeKb}KB  关键词 ${f.kwHits.length} 处`)
  for (const h of f.kwHits.slice(0, 3)) console.log(`      …${h}…`)
}
