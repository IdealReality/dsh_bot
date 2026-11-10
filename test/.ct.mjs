// 精确盘点测试数据的影响面
import fs from 'node:fs'
import path from 'node:path'

const D = '/home/dsh/.data'
const FAKE = ['999000111', '999000222', 'learn-probe']
const hit = (s) => FAKE.some((f) => String(s).includes(f))
const t = (x) => new Date(Number(x)).toLocaleString('zh-CN')

function countJsonl(rel) {
  const p = path.join(D, rel)
  if (!fs.existsSync(p)) return null
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
  const bad = lines.filter((l) => hit(l))
  return { file: rel, total: lines.length, fake: bad.length, samples: bad.slice(0, 3).map((l) => l.slice(0, 150)) }
}

console.log('=== JSONL 文件 ===')
for (const f of ['brain/ep/2026-11.jsonl', 'brain/log/delivery.jsonl', 'brain/log/stream.jsonl',
  'brain/log/claims.jsonl', 'brain/seg/closed.jsonl', 'audit/unsent.jsonl', 'sent-log.json']) {
  const r = countJsonl(f)
  if (!r) { console.log(`  ${f}  (不存在)`); continue }
  console.log(`  ${f}  总 ${r.total} 条，含假号 ${r.fake} 条`)
  for (const s of r.samples) console.log(`      ${s}`)
}

console.log('\n=== ep 里假号条目的细节 ===')
{
  const p = path.join(D, 'brain/ep/2026-11.jsonl')
  const rows = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const bad = rows.filter((r) => hit(JSON.stringify(r)))
  console.log(`  共 ${bad.length} 条（总 ${rows.length}）`)
  const byWho = {}
  for (const r of bad) {
    const k = r.who?.others?.[0]?.id || r.where?.chat || '?'
    byWho[k] = (byWho[k] || 0) + 1
  }
  console.log('  按对象:', JSON.stringify(byWho))
  for (const r of bad.slice(0, 8)) {
    console.log(`    ${t(r.at)} [${r.where?.platform}] ${String(r.gist).slice(0, 60)}`)
  }
}

console.log('\n=== JSON 文件细节 ===')
for (const f of ['roster.json', 'bond.json', 'brain/cohere/qq_999000111.json', 'brain/cohere/qq_learn-probe.json',
  'brain/meta/attention.json', 'brain/seg/index.json', 'brain/learn/lexicon.json', 'sent-at.json']) {
  const p = path.join(D, f)
  if (!fs.existsSync(p)) { console.log(`  ${f}  (不存在)`); continue }
  const size = fs.statSync(p).size
  let raw = ''
  try { raw = fs.readFileSync(p, 'utf8') } catch { }
  const n = (raw.match(/999000111|999000222|learn-probe/g) || []).length
  console.log(`  ${f}  ${(size / 1024).toFixed(1)}KB  假号出现 ${n} 次`)
  if (f === 'bond.json') console.log('     内容:', raw.replace(/\s+/g, ' ').slice(0, 300))
  if (f.includes('qq_999000111') || f.includes('learn-probe')) console.log('     内容:', raw.replace(/\s+/g, ' ').slice(0, 220))
}

console.log('\n=== 影响判断 ===')
console.log('  roster  → 她会"认识" probe / probe2 这两个人')
console.log('  bond    → 对这两个号有信任度/亲近度记账')
console.log('  cohere  → 有和 probe 的连贯性线程')
console.log('  lexicon → 学了测试期间的用词')
console.log('  ep      → 记忆里有和 probe 的"经历"，会被 recall 召回')
