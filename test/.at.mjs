import fs from 'node:fs'
const P = '/home/dsh/.data/brain/ep/2026-11.jsonl'
const rows = fs.readFileSync(P, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const fake = rows.filter((r) => /99900011[12]|99900022[12]/.test(JSON.stringify(r)))
const t = (x) => new Date(Number(x)).toLocaleString('zh-CN')

let ownerTagged = 0
const byDay = {}
for (const r of fake) {
  const others = r.who?.others || []
  if (others.some((o) => o.kind === 'owner')) ownerTagged++
  const d = new Date(Number(r.at)).toLocaleDateString('zh-CN')
  byDay[d] = (byDay[d] || 0) + 1
}
console.log('测试号条目', fake.length, '条 / 总', rows.length, '条 →', (fake.length / rows.length * 100).toFixed(1) + '%')
console.log('其中被标成 owner（"主人"）的:', ownerTagged, '条  ← 最有害的一类')
console.log('时间分布:', JSON.stringify(byDay))

// 会不会被召回：真实主人私聊时 recall private 全见
console.log('\n如果主人现在问「你记得我吗 / 帮我记的房租」，这些记忆会被召回：')
const risky = fake.filter((r) => /房租|谢谢你|帮我|记得/.test(String(r.gist || '')))
for (const r of risky.slice(0, 6)) console.log('  ', t(r.at), '|', String(r.gist).slice(0, 55))

console.log('\n最后一条测试数据:', t(fake.slice(-1)[0]?.at || 0))
console.log('最近 3 天有新的吗:', fake.filter((r) => Date.now() - Number(r.at) < 3 * 86400_000).length, '条')
