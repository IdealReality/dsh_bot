import fs from 'node:fs'
const D = '/home/dsh/.data'
const t = (x) => new Date(Number(x)).toLocaleString('zh-CN')
const rows = fs.readFileSync(D + '/brain/ep/2026-11.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const badIds = ['1', '999', 'owner']
const bad = rows.filter((r) => (r.who?.others || []).some((o) => o.kind === 'owner' && badIds.includes(String(o.id))))
console.log('异常的 owner 标记:', bad.length, '条\n')
for (const r of bad) {
  const o = (r.who.others || []).find((x) => x.kind === 'owner' && badIds.includes(String(x.id)))
  console.log(`${t(r.at)}  owner.id="${o.id}"  name="${o.name || ''}"`)
  console.log(`   platform=${r.where?.platform} chat=${r.where?.chat} scope=${r.scope} act=${r.act}`)
  console.log(`   gist: ${String(r.gist).slice(0, 90)}`)
  console.log(`   src: ${r.srcEv}`)
  console.log('')
}

console.log('=== working/qq_999000111.json ===')
try { console.log(fs.readFileSync(D + '/brain/working/qq_999000111.json', 'utf8')) } catch (e) { console.log(e.message) }

console.log('\n=== facts.json 键 ===')
{
  const j = JSON.parse(fs.readFileSync(D + '/facts.json', 'utf8'))
  const keys = Object.keys(j)
  console.log(keys.join(', '))
  const raw = JSON.stringify(j)
  for (const kw of ['房租', '热榜', 'probe', '测试', '999']) if (raw.includes(kw)) console.log('  含关键词:', kw)
}

console.log('\n=== lore.json 摘要 ===')
{
  const j = JSON.parse(fs.readFileSync(D + '/lore.json', 'utf8'))
  const arr = Array.isArray(j) ? j : (j.items || Object.values(j))
  console.log('条目:', arr.length)
  for (const x of arr.slice(0, 8)) console.log('  -', String(x.text || x.title || JSON.stringify(x)).slice(0, 60))
}
