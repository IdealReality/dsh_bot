// 清剩余 3 条脏记忆 + working 残留
import fs from 'node:fs'
import path from 'node:path'

const D = '/home/dsh/.data'
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
// 容器内只能写挂载进来的目录（.data → 宿主 data-home），宿主 backups 在容器里不可见
const BK = path.join(D, '_testclean2-' + TS)
try { fs.mkdirSync(BK, { recursive: true }) } catch { }

// 判定：测试号 / 对象字符串化
const isBad = (r) => {
  if (!r || typeof r !== 'object') return false
  const others = r.who?.others || []
  if (others.some((o) => String(o?.id) === '1' || String(o?.id) === '999')) return true
  const chat = String(r.where?.chat || r.chat || '')
  if (chat === 'qq:owner-notes' || chat === 'qq:1' || chat === 'qq:999') return true
  if (/\[object Object\]/.test(String(r.gist || r.text || r.head || ''))) return true
  return false
}

for (const rel of ['brain/ep/2026-11.jsonl', 'brain/log/stream.jsonl', 'brain/log/delivery.jsonl', 'brain/log/claims.jsonl']) {
  const p = path.join(D, rel)
  if (!fs.existsSync(p)) { console.log(`${rel} (无)`); continue }
  fs.copyFileSync(p, path.join(BK, rel.replace(/\//g, '__')))
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  const keep = []
  const removed = []
  for (const l of lines) {
    if (!l.trim()) continue
    let r = null
    try { r = JSON.parse(l) } catch { keep.push(l); continue }
    if (isBad(r)) { removed.push(String(r.gist || r.text || r.head || '').slice(0, 40)); continue }
    keep.push(l)
  }
  fs.writeFileSync(p, keep.join('\n') + '\n')
  console.log(`${rel}  ${lines.filter((x) => x.trim()).length} → ${keep.length}（删 ${removed.length}）`)
  for (const x of removed) console.log('    - ' + x)
}

// working 残留
const w = path.join(D, 'brain/working/qq_999000111.json')
if (fs.existsSync(w)) {
  fs.copyFileSync(w, path.join(BK, 'brain__working__qq_999000111.json'))
  fs.rmSync(w)
  console.log('删除 working/qq_999000111.json')
}
console.log('\n备份:', BK)
