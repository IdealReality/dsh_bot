// 清理测试号数据：先备份，再精确删除，只动含假号的记录
import fs from 'node:fs'
import path from 'node:path'

const D = '/home/dsh/.data'
const FAKE = /999000111|999000222|learn-probe/
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const BK = path.join(D, '_testclean-backup-' + TS)
fs.mkdirSync(BK, { recursive: true })

const log = []
const say = (s) => { console.log(s); log.push(s) }
const writeAtomic = (p, s) => {
  const t = p + '.tmp-clean'
  fs.writeFileSync(t, s)
  fs.renameSync(t, p)
}
const backup = (rel) => {
  const src = path.join(D, rel)
  if (!fs.existsSync(src)) return false
  const dst = path.join(BK, rel.replace(/\//g, '__'))
  fs.copyFileSync(src, dst)
  return true
}

// ── ① JSONL：按行过滤 ──────────────────────────────────────
say('=== ① JSONL ===')
for (const rel of ['brain/ep/2026-11.jsonl', 'brain/log/stream.jsonl', 'brain/log/claims.jsonl',
  'brain/log/delivery.jsonl', 'brain/seg/closed.jsonl', 'audit/unsent.jsonl']) {
  const p = path.join(D, rel)
  if (!fs.existsSync(p)) { say(`  ${rel}  (不存在，跳过)`); continue }
  backup(rel)
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  const keep = lines.filter((l) => !(l.trim() && FAKE.test(l)))
  const removed = lines.filter((l) => l.trim() && FAKE.test(l)).length
  writeAtomic(p, keep.join('\n'))
  say(`  ${rel}  ${lines.filter((l) => l.trim()).length} → ${keep.filter((l) => l.trim()).length} 行（删 ${removed}）`)
}

// ── ② seg/index.json：过滤 segments 数组 ────────────────────
say('\n=== ② 分段索引 ===')
{
  const rel = 'brain/seg/index.json'
  const p = path.join(D, rel)
  if (fs.existsSync(p)) {
    backup(rel)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const segs = Array.isArray(j.segments) ? j.segments : []
    const keep = segs.filter((s) => !FAKE.test(JSON.stringify(s)))
    const removedIds = segs.filter((s) => FAKE.test(JSON.stringify(s))).map((s) => s.id)
    j.segments = keep
    writeAtomic(p, JSON.stringify(j))
    say(`  ${rel}  segments ${segs.length} → ${keep.length}（删 ${removedIds.length}：${removedIds.join(',')}）`)
  }
}

// ── ③ 以 chat/id 为 key 的 JSON ───────────────────────────
say('\n=== ③ 键值型 JSON ===')
const keyed = [
  { rel: 'roster.json', get: (j) => j.people, del: 'people' },
  { rel: 'bond.json', get: (j) => j.people, del: 'people' },
  { rel: 'sent-log.json', get: (j) => j, del: null },
  { rel: 'sent-at.json', get: (j) => j, del: null },
]
for (const { rel, get, del } of keyed) {
  const p = path.join(D, rel)
  if (!fs.existsSync(p)) { say(`  ${rel}  (不存在)`); continue }
  backup(rel)
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  const obj = get(j)
  if (!obj || typeof obj !== 'object') { say(`  ${rel}  结构不认识，跳过`); continue }
  const keys = Object.keys(obj)
  const bad = keys.filter((k) => FAKE.test(k))
  for (const k of bad) delete obj[k]
  writeAtomic(p, JSON.stringify(del ? j : obj, null, 1))
  say(`  ${rel}  ${keys.length} → ${keys.length - bad.length} 个键（删 ${bad.length}：${bad.join(',') || '无'}）`)
}

// ── ④ lexicon：chats 里的假号 ──────────────────────────────
say('\n=== ④ 用词库 ===')
{
  const rel = 'brain/learn/lexicon.json'
  const p = path.join(D, rel)
  if (fs.existsSync(p)) {
    backup(rel)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const c = j.chats || {}
    const keys = Object.keys(c)
    const bad = keys.filter((k) => FAKE.test(k) || FAKE.test(JSON.stringify(c[k])))
    for (const k of bad) delete c[k]
    j.chats = c
    writeAtomic(p, JSON.stringify(j))
    say(`  ${rel}  chats ${keys.length} → ${keys.length - bad.length}（删 ${bad.length}：${bad.join(',') || '无'}）`)
  }
}

// ── ⑤ attention.json：inbox 里的假号 ──────────────────────
say('\n=== ⑤ 注意力队列 ===')
{
  const rel = 'brain/meta/attention.json'
  const p = path.join(D, rel)
  if (fs.existsSync(p)) {
    backup(rel)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const before = JSON.stringify(j).length
    const walk = (o) => {
      if (Array.isArray(o)) return o.filter((x) => !FAKE.test(JSON.stringify(x))).map(walk)
      if (o && typeof o === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(o)) {
          if (FAKE.test(k)) continue
          out[k] = walk(v)
        }
        return out
      }
      return o
    }
    const cleaned = walk(j)
    writeAtomic(p, JSON.stringify(cleaned))
    say(`  ${rel}  ${before} → ${JSON.stringify(cleaned).length} 字节`)
    say(`  内容：${JSON.stringify(cleaned).slice(0, 200)}`)
  }
}

// ── ⑥ 连贯性线程文件：直接删 ──────────────────────────────
say('\n=== ⑥ 连贯性线程 ===')
for (const rel of ['brain/cohere/qq_999000111.json', 'brain/cohere/qq_999000222.json', 'brain/cohere/qq_learn-probe.json']) {
  const p = path.join(D, rel)
  if (fs.existsSync(p)) {
    backup(rel)
    fs.rmSync(p)
    say(`  删除 ${rel}`)
  } else say(`  ${rel}  (不存在)`)
}

say('\n=== 备份目录 ===')
say('  ' + BK)
say('  里面是改动前的原文件（文件名把 / 换成 __）')
