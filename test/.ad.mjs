// 数据体检：清理之后还有没有别的脏东西
import fs from 'node:fs'
import path from 'node:path'

const D = '/home/dsh/.data'
const now = Date.now()
const t = (x) => new Date(Number(x)).toLocaleString('zh-CN')

function listDir(rel) {
  try { return fs.readdirSync(path.join(D, rel)) } catch { return [] }
}
function jsonl(rel) {
  const p = path.join(D, rel)
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { __bad: l.slice(0, 80) } } })
}

console.log('=== ① working 目录（会话草稿）===')
for (const f of listDir('brain/working')) {
  const p = path.join(D, 'brain/working', f)
  const st = fs.statSync(p)
  let summary = ''
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const keys = Object.keys(j)
    summary = keys.join(',') + (Array.isArray(j.lines) ? ` lines=${j.lines.length}` : '') + (Array.isArray(j.turns) ? ` turns=${j.turns.length}` : '')
  } catch { summary = '(解析失败)' }
  console.log(`  ${f}  ${st.size}B  改于 ${t(st.mtimeMs)}  ${summary}`)
}

console.log('\n=== ② 打开中的分段 ===')
{
  const p = path.join(D, 'brain/seg/index.json')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  console.log('  open:', JSON.stringify(j.open))
  const segs = j.segments || []
  const chats = {}
  for (const s of segs) chats[s.chat] = (chats[s.chat] || 0) + 1
  console.log('  分段按 chat:', JSON.stringify(chats))
  const open = j.open && segs.find((s) => s.id === j.open)
  if (open) console.log('  open 段详情:', JSON.stringify(open).slice(0, 200))
}

console.log('\n=== ③ ep 数据质量 ===')
{
  const rows = jsonl('brain/ep/2026-11.jsonl')
  console.log('  总条数:', rows.length)
  const bad = rows.filter((r) => r.__bad)
  console.log('  解析失败:', bad.length)
  const empty = rows.filter((r) => !r.__bad && !String(r.gist || '').trim())
  console.log('  gist 为空:', empty.length)
  for (const r of empty.slice(0, 5)) console.log('     ', t(r.at), JSON.stringify(r).slice(0, 120))
  const short = rows.filter((r) => !r.__bad && String(r.gist || '').trim().length < 4)
  console.log('  gist < 4 字:', short.length)
  // 重复 gist（同一句话出现多次）
  const byGist = {}
  for (const r of rows) {
    const g = String(r.gist || '').trim()
    if (!g) continue
    byGist[g] = (byGist[g] || 0) + 1
  }
  const dups = Object.entries(byGist).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
  console.log('  重复 gist:', dups.length, '组')
  for (const [g, n] of dups.slice(0, 6)) console.log(`      ×${n}  ${g.slice(0, 50)}`)
  // 时间异常
  const future = rows.filter((r) => !r.__bad && Number(r.at) > now + 60_000)
  const old = rows.filter((r) => !r.__bad && Number(r.at) < Date.parse('2026-10-01'))
  console.log('  未来时间:', future.length, '| 早于 10-01:', old.length)
  // srcEv 来源分布
  const bySrc = {}
  for (const r of rows) {
    if (r.__bad) continue
    const k = String(r.srcEv || '(空)').split('_').slice(-2)[0]
    bySrc[k] = (bySrc[k] || 0) + 1
  }
  console.log('  srcEv 来源:', JSON.stringify(bySrc))
  // who 标成 owner 的（清理后再查一遍）
  const ownerTagged = rows.filter((r) => !r.__bad && (r.who?.others || []).some((o) => o.kind === 'owner'))
  console.log('  标成 owner 的:', ownerTagged.length, '条')
  const ownerIds = {}
  for (const r of ownerTagged) for (const o of (r.who.others || [])) if (o.kind === 'owner') ownerIds[o.id] = (ownerIds[o.id] || 0) + 1
  console.log('  这些 owner 的号:', JSON.stringify(ownerIds))
}

console.log('\n=== ④ 事件流与队列 ===')
{
  for (const rel of ['brain/inbox', 'brain/task', 'brain/intent']) {
    const fs2 = listDir(rel)
    console.log(`  ${rel}: ${fs2.length} 个文件 ${fs2.slice(0, 5).join(', ')}`)
  }
  for (const rel of ['brain/task/tasks.json', 'brain/intent/intents.json', 'brain/intent/journal.jsonl']) {
    const p = path.join(D, rel)
    if (!fs.existsSync(p)) { console.log(`  ${rel} (无)`); continue }
    const sz = fs.statSync(p).size
    console.log(`  ${rel}  ${sz}B`)
  }
}

console.log('\n=== ⑤ 关键账本条目数 ===')
for (const rel of ['facts.json', 'lore.json', 'promises.json', 'bond.json', 'roster.json',
  'brain/meta/identity.json', 'brain/meta/self-state.json', 'brain/meta/field.json',
  'brain/log/stream.jsonl', 'brain/log/claims.jsonl', 'brain/log/delivery.jsonl']) {
  const p = path.join(D, rel)
  if (!fs.existsSync(p)) { console.log(`  ${rel}  (无)`); continue }
  let n = ''
  try {
    const raw = fs.readFileSync(p, 'utf8')
    if (rel.endsWith('.jsonl')) n = raw.trim().split('\n').filter(Boolean).length + ' 行'
    else {
      const j = JSON.parse(raw)
      if (Array.isArray(j)) n = j.length + ' 项'
      else if (j.facts) n = Object.keys(j.facts).length + ' facts'
      else n = Object.keys(j).length + ' 键'
      if (j.decisions != null) n += ` decisions=${j.decisions}`
    }
  } catch { n = '(解析失败)' }
  console.log(`  ${rel}  ${n}`)
}
