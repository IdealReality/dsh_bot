/**
 * 办公台状态机测试 —— 2026-11-09（十遍第 5 遍）回归锚点。
 *
 * 为什么值得钉：办公台的状态是**三个进程**在改（聊天里 start、worker 每步 patch、用户 stop）。
 * 旧实现是裸的 read-modify-write，没有锁；也没有回收机制。
 * 实测（并发 8 个 start）两个后果：
 *   · 竞态窗口里两边都看到空档 → 同时起两个 worker，第二个覆盖第一个的 trace
 *   · worker 被 docker 重启杀掉后任务永远停在 running → 此后所有活都被"手上还压着一件"挡掉
 *
 * 钉住：并发只允许 1 个真立项、状态文件永远可解析、僵尸会被回收、回收后能接着立项。
 * 跑法：node test/office-state-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const BASE = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
const TMP = fs.mkdtempSync(path.join(BASE, 'of-state-'))
process.env.BOT_DATA_DIR = TMP
process.env.HOME = process.env.HOME || TMP
process.env.BOT_DEBUG = '1'          // paths.mjs 要求：开了调试就必须显式隔离数据目录（这里已给）

const office = await import('../tools/lib/office.mjs')
const FILE = path.join(TMP, 'office', 'tasks.json')
const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'bot.mjs')

let bad = 0
const ok = (c, label, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + label + (c ? '' : ' → ' + extra)); if (!c) bad++ }
const rows = () => (JSON.parse(fs.readFileSync(FILE, 'utf8')).rows || [])
const killWorkers = () => {
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue
    let c = ''
    try { c = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { continue }
    if (c.includes('office work --id of-')) { try { process.kill(+p, 'SIGTERM') } catch { /* 已退 */ } }
  }
}

// ── 1. 并发立项：8 个独立进程同时 start，只能有 1 个真立项 ──────────────────
const run = (goal) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, 'office', 'start', '--goal', goal, '--steps', '2', '--minutes', '1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { out += d })
  p.on('close', () => resolve(out.trim()))
})
const parsed = (await Promise.all(Array.from({ length: 8 }, (_, i) => run('并发探针 ' + i))))
  .map((o) => { try { return JSON.parse(o) } catch { return { raw: o.slice(0, 60) } } })
ok(parsed.filter((r) => r.ok && !r.busy).length === 1, '8 个并发 start 只有 1 个真立项', JSON.stringify(parsed.slice(0, 2)))
ok(parsed.filter((r) => r.busy).length === 7, '其余 7 个被告知"手上还压着一件"', String(parsed.filter((r) => r.busy).length))
ok(rows().length === 1, '状态文件里只有一行（没被写重）', String(rows().length))
ok((() => { try { JSON.parse(fs.readFileSync(FILE, 'utf8')); return true } catch { return false } })(), '状态文件可解析（原子写没被写坏）')

// ── 2. 僵尸回收：worker 没了，任务不能永远占位 ──────────────────────────────
killWorkers()
await new Promise((r) => setTimeout(r, 300))
const s = JSON.parse(fs.readFileSync(FILE, 'utf8'))
for (const r of s.rows) if (r.state === 'running' || r.state === 'queued') { r.state = 'stopped'; r.endedAt = Date.now() }
s.rows.push({
  id: 'of-zombie-1', goal: '僵尸任务', state: 'running', steps: 5, minutes: 1,
  createdAt: Date.now() - 3 * 3600e3, startedAt: Date.now() - 3 * 3600e3,
  endedAt: 0, step: 3, trace: [], final: '', error: '',
})
fs.writeFileSync(FILE, JSON.stringify(s))

const after = office.start({ goal: '僵尸之后的第一个活', steps: 2, minutes: 1 })
const zombie = rows().find((x) => x.id === 'of-zombie-1')
ok(zombie.state === 'failed', '超期的 running 被回收成 failed', zombie.state)
ok(/进程没了/.test(zombie.error || ''), '回收时写清原因', zombie.error)
ok(after.ok && !after.busy, '回收之后能接着立项', JSON.stringify(after).slice(0, 90))

// ── 3. stop 语义 ────────────────────────────────────────────────────────────
killWorkers()
const st = office.stop(after.id)
ok(st.ok && st.state === 'stopped', 'stop 把在跑的任务置 stopped', JSON.stringify(st))
ok(office.stop('of-not-exist').ok === false, 'stop 不存在的任务 → 如实失败')

killWorkers()
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录，删不掉不影响结论 */ }
console.log(bad ? '\n✗ 办公台状态机：' + bad + ' 条不过' : '\n✓ 办公台状态机测试全过')
process.exitCode = bad ? 1 : 0
