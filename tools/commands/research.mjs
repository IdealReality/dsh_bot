// commands/research —— 让她"去 B 站专门看一类视频并按六轴递归研究"的手。
//
// 现象（2026-11-07）：用户在 QQ 里让她去看某一类视频、从化学/生物学/哲学/主观/精神学/心理学
// 往下研究，她的表现是"答应得很顺，回来看见什么说什么，第二轮开始换词重复"。
// 能力缺口有三层：
//   ① 没有"按类找一批视频"的入口（只有 feed 随机刷 / 指定 bvid）；
//   ② 没有把问题往下递的结构（见 brain/research/engine）；
//   ③ 修好后也没有让它在后台真的跑完并回来汇报的通道（本文件）。
//
// 为什么必须是后台进程 + 队列外：
//   qq-server 的工具链总预算 30 秒、单个工具 12 秒（见 lib/agent.mjs）。
//   一次研究要看十几条视频、做十几次模型调用，塞进聊天循环必然把回复拖死。
//   所以这里的契约是：**聊天只负责立项（<1 秒），研究在独立进程里跑，跑完主动汇报**。
//   她答应"这就去看"之后真的有人去看 —— 这是这条链路存在的唯一理由。
//
// 状态是唯一真相：每步落盘，进程随时可死；重启后 `research work` 接着跑。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { apiGet, makeHeaders } from '../lib/bili/bili-api.mjs'
import { loadCred } from '../lib/infra/cred.mjs'
import { config } from '../lib/infra/config.mjs'
import * as llm from '../lib/work/llm.mjs'
import * as memory from '../lib/mind/memory.mjs'
import { dataPath } from '../lib/infra/paths.mjs'
import { appendJsonl } from '../brain/json.mjs'
import { swallow } from '../lib/infra/swallow.mjs'
import { sendOwnerQQ } from '../lib/infra/notify.mjs'
import * as tree from '../brain/research/tree.mjs'
import * as engine from '../brain/research/engine.mjs'
import * as notes from '../brain/research/notes.mjs'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOT = path.join(HERE, '..', 'bot.mjs')
const LOG = () => dataPath('research/log.jsonl')
const log = (obj) => { try { appendJsonl(LOG(), { at: Date.now(), ...obj }) } catch (e) { swallow(e, 'research:log') } }

const arg = (argv, name, d = '') => {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? d) : d
}
const has = (argv, name) => argv.includes(name)

// ── B 站检索（研究用：按轴的关键词组合搜一批，不追播放量）──────────────────
/** "mm:ss" / "hh:mm:ss" / 秒数 → 分钟。 */
function minutesOf(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return Math.round(d / 60)
  const s = String(d ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Math.round(Number(s) / 60)
  const p = s.split(':').map(Number)
  if (p.length === 2 && p.every(Number.isFinite)) return Math.round(p[0] + p[1] / 60)
  if (p.length === 3 && p.every(Number.isFinite)) return Math.round(p[0] * 60 + p[1] + p[2] / 60)
  return 0
}

export async function searchVideos(queries, { limit = 8, exclude = new Set() } = {}) {
  const cred = loadCred()
  const H = makeHeaders(cred)
  const out = []
  const seen = new Set()
  for (const q of queries || []) {
    const u = new URL('https://api.bilibili.com/x/web-interface/search/type')
    u.searchParams.set('search_type', 'video')
    u.searchParams.set('keyword', String(q).slice(0, 50))
    u.searchParams.set('page', '1')
    let j = null
    try {
      j = await apiGet(u.href, H, { soft: true })
    } catch (e) { swallow(e, 'research:search'); continue }
    for (const x of j?.data?.result ?? []) {
      const bvid = String(x?.bvid || '')
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || seen.has(bvid) || exclude.has(bvid)) continue
      seen.add(bvid)
      out.push({
        bvid,
        title: String(x.title ?? '').replace(/<[^>]+>/g, '').slice(0, 120),
        owner: String(x.author ?? '').slice(0, 40),
        durMin: minutesOf(x.duration),
        desc: String(x.description ?? '').slice(0, 160),
        play: Number(x.play) || 0,
      })
    }
    if (out.length >= limit * 2) break
  }
  // 排序：时长在"能讲清一件事"的区间优先，其次标题里带"机制/原理/研究/为什么"的，
  // 播放量只做微弱加权（热门不等于有内容）。
  const score = (v) => {
    const m = v.durMin
    let s = m >= 8 && m <= 45 ? 3 : m > 45 && m <= 150 ? 1 : m > 0 && m < 5 ? -2 : 0
    if (/机制|原理|为什么|研究|实验|解释|科学|如何/.test(v.title)) s += 1.5
    if (/合集|直播回放|切片|教程/.test(v.title)) s -= 1
    s += Math.min(1, Math.log10(Math.max(1, v.play)) / 8)
    return s
  }
  return out.sort((a, b) => score(b) - score(a)).slice(0, Math.max(1, Number(limit) || 8))
}

// ── 取材料：直接复用 debrief（它已经处理字幕/ASR/热评/画面/串片判定）──────────
/** 把 debrief 的结构化结果压成"可引用材料"。顺序按可靠度：台词 > 字幕 > 画面 > 热评 > 简介。
 *  为什么简介必须最后：它是 UP 自己写的宣传语，最容易和内容无关；
 *  放在开头会让模型优先引用它（引用靠前的材料是模型的天性）。
 *
 *  ⚠ 2026-11-07 真机实测：B站番剧/影视投稿的字幕**经常是别的片的**（串片）。
 *  实测《成瘾真相：一个视频彻底搞懂多巴胺》的字幕整段是"空镜头拍摄技巧"，
 *  六个视角读完都只能判 barren。debrief 已经算好 `subtitleCoherence`（字幕与标题重合率），
 *  低于 5% 就直接丢字幕，并把这件事写进材料（模型和报告都要知道"这段不可用"）。 */
export function packExcerpt(j) {
  const parts = []
  const push = (label, body) => {
    const t = String(body || '').trim()
    if (t) parts.push(`【${label}】${t}`)
  }
  const coh = Number.isFinite(Number(j.subtitleCoherence)) ? Number(j.subtitleCoherence) : null
  const subsBad = coh !== null && coh < 0.05
  if (j.hearText) push('台词·真听音轨', String(j.hearText).slice(0, 700))
  if (Array.isArray(j.subtitleLines) && j.subtitleLines.length) {
    if (subsBad) parts.push(`【字幕已丢弃】与标题重合 ${Math.round(coh * 100)}%，疑似串片，不能当材料`)
    else push('字幕', j.subtitleLines.slice(0, 24).join('\n'))
  }
  if (j.visionDesc) push('画面', String(j.visionDesc).slice(0, 300))
  if (Array.isArray(j.topComments) && j.topComments.length) {
    push('热评', j.topComments.slice(0, 4).map((c) => `${c.name}：${c.text}`).join('\n'))
  }
  if (j.intro) push('简介', String(j.intro).slice(0, 300))
  return parts.join('\n').slice(0, 1400)
}

export async function fetchMaterials(bvid) {
  const t0 = Date.now()
  try {
    const r = await execFileAsync(process.execPath, [BOT, 'debrief', '--bvid', bvid, '--json'], {
      encoding: 'utf8', timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    const m = String(r.stdout || '').match(/\{[\s\S]*\}/)
    if (!m) return { ok: false, why: 'debrief 没有输出 JSON' }
    const j = JSON.parse(m[0])
    const excerpt = packExcerpt(j)
    return {
      ok: true,
      title: j.title || '', owner: j.owner || '',
      durMin: Number(j.durationMin) || 0,
      seenVia: Array.isArray(j.seenVia) ? j.seenVia : [],
      coherence: Number.isFinite(Number(j.subtitleCoherence)) ? Number(j.subtitleCoherence) : null,
      excerpt,
      tookMs: Date.now() - t0,
    }
  } catch (e) {
    const out = String(e?.stdout || '')
    const m = out.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const j = JSON.parse(m[0])
        return {
          ok: true, title: j.title || '', owner: j.owner || '', durMin: Number(j.durationMin) || 0,
          seenVia: Array.isArray(j.seenVia) ? j.seenVia : [], coherence: null,
          excerpt: packExcerpt(j), tookMs: Date.now() - t0,
        }
      } catch { /* 落到失败分支 */ }
    }
    return { ok: false, why: String(e?.message || e).slice(0, 160), tookMs: Date.now() - t0 }
  }
}

async function chat(messages, opts = {}) {
  // 同 engine.callChat：llm.chat 只认 max_tokens（下划线），驼峰会被静默忽略。
  const r = await llm.chat(messages, { purpose: 'deep', max_tokens: 900, temperature: 0.35, ...opts })
  return typeof r === 'string' ? r : String(r?.content ?? r?.text ?? '')
}

function deps(nowFn = () => Date.now()) {
  return {
    chat,
    searchVideos,
    fetchMaterials,
    notify: (text) => sendOwnerQQ(text),
    log: (m) => log({ kind: 'step', msg: String(m).slice(0, 300) }),
    now: nowFn,
  }
}

// ── 状态读写（唯一真相在磁盘）──────────────────────────────────────────
function readState(id) {
  return tree.loadState(id)
}

function persist(state) {
  const r = tree.saveState(state)
  if (!r.ok) log({ kind: 'save-fail', id: state.id, why: r.reason })
  return r.ok
}

function update(id, fn) {
  return tree.updateState(id, fn)
}

/** 确保研究存在（同 topic 未完成 → 续跑；已完成 → 返回已有，不重复花钱）。 */
export function ensureResearch({ topic, budget = {}, now = Date.now() } = {}) {
  const t = String(topic || '').replace(/\s+/g, ' ').trim()
  if (!t) return { ok: false, reason: 'empty-topic' }
  // id 碰撞防御：极少数情况下两个不同题目会落到同一个 id（哈希 + 长度）。
  // 真发生时绝不覆盖旧研究 —— 那会把别人的结论当成自己的（"第二次研究"静默返回旧结果）。
  let id = tree.idOfTopic(t)
  let cur = readState(id)
  let salt = 1
  while (cur && cur.topic !== t && salt <= 3) {
    id = tree.idOfTopic(`${t}#${salt++}`)
    cur = readState(id)
  }
  if (cur && cur.topic !== t) return { ok: false, reason: 'id-collision', id }
  if (cur) {
    if (cur.status === 'done') return { ok: true, id, resumed: false, done: true, state: cur }
    if (cur.status === 'paused' || cur.status === 'failed') {
      update(id, (s) => { s.status = 'running'; s.updatedAt = now; return s })
    }
    return { ok: true, id, resumed: true, state: readState(id) }
  }
  const made = tree.createState({ topic: t, budget, now })
  if (!made.ok) return { ok: false, reason: made.reason }
  if (!persist(made.state)) return { ok: false, reason: 'save-failed', state: made.state }
  return { ok: true, id: made.state.id, resumed: false, state: made.state }
}

function spawnWorker(id, { chain = 0 } = {}) {
  try {
    const child = spawn(process.execPath, [BOT, 'research', 'work', '--id', id, '--worker', '--chain', String(chain)], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    child.unref()
    log({ kind: 'spawn', id, pid: child.pid, chain })
    return { ok: true, pid: child.pid }
  } catch (e) {
    log({ kind: 'spawn-fail', id, why: String(e?.message || e).slice(0, 160) })
    return { ok: false, why: String(e?.message || e).slice(0, 160) }
  }
}

// ── 汇报（一次研究最多一次；失败不标记，下次还有机会）──────────────────────
async function report(state, { force = false } = {}) {
  if (!state || state.status !== 'done') return { ok: false, why: 'not-done' }
  const cfg = config().research || {}
  if (state.reportSentAt && !force) return { ok: false, why: 'already-reported' }
  if (cfg.reportToOwner === false) return { ok: false, why: 'disabled' }
  if (!force) {
    const day = new Date().toLocaleDateString('sv-SE')
    const sent = tree.listStates().filter((s) => new Date(Number(s.reportSentAt) || 0).toLocaleDateString('sv-SE') === day).length
    if (sent >= Number(cfg.reportDailyMax ?? 3)) return { ok: false, why: 'daily-cap' }
  }
  const text = notes.notifyText(state)
  const ok = await sendOwnerQQ(text)
  if (!ok) return { ok: false, why: 'send-failed' }
  update(state.id, (s) => { s.reportSentAt = Date.now(); s.updatedAt = Date.now(); return s })
  try {
    memory.remember('bilibili', `bilibili:research:${state.id}`, 'self', 'assistant', notes.memoryLine(state), { allowSelfTest: true })
  } catch (e) { swallow(e, 'research:remember') }
  log({ kind: 'report', id: state.id, chars: text.length })
  return { ok: true }
}

// ── 研究专用的心跳锁（2026-11-07 容器重建实测）──────────────────────────
// 为什么不用 lib/lock：那个锁按 **pid 存活**判断持有者，而容器重建后 PID 命名空间重置，
// 旧锁里的 pid 很可能被新容器里的某个进程"复用" → 永远判 held → watchdog 永远不续跑。
// 实测：她自改代码触发容器重启（23:37），研究 worker 被杀，状态停在 running。
// 研究锁按**时间**判断：worker 每步 touch 一次；超过 ttl 未 touch 才允许抢占。
const LOCK_TTL_MS = 3 * 60_000
const lockPathOf = (id) => path.join(dataPath('locks'), 'research-' + String(id).replace(/[^\w.-]/g, '_') + '.lock')

export function acquireResearchLock(id, { now = Date.now(), ttlMs = LOCK_TTL_MS } = {}) {
  const f = lockPathOf(id)
  try { fs.mkdirSync(path.dirname(f), { recursive: true }) } catch { /* 目录存在或被占 */ }
  const mine = { pid: process.pid, at: now, token: `${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
  const readOwn = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(f, 'utf8'))
      return cur?.token === mine.token ? cur : null
    } catch { return null }
  }
  const mk = () => {
    const fd = fs.openSync(f, 'wx')     // O_EXCL：并发只有一个成功
    try { fs.writeSync(fd, JSON.stringify(mine)) } finally { fs.closeSync(fd) }
    return {
      ok: true,
      token: mine.token,
      // 只删自己的锁：被 TTL 抢占后旧 worker 复活，绝不许删掉新 worker 的锁
      release: () => { if (readOwn()) { try { fs.rmSync(f, { force: true }) } catch { /* 已不在 */ } } },
      // 返回 false = 锁已经不是我的（被看门狗按 TTL 抢走）→ 调用方必须停手
      touch: () => {
        if (!readOwn()) return false
        try { fs.writeFileSync(f, JSON.stringify({ ...mine, at: Date.now() })) } catch { /* 写不进就等别人按 ttl 抢 */ }
        return true
      },
    }
  }
  try { return mk() } catch (e) {
    if (e?.code !== 'EEXIST') return { ok: false, why: 'broken:' + String(e?.code || e?.message).slice(0, 30) }
  }
  let old = null
  try { old = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { old = null }
  const at = Number(old?.at) || 0
  if (at && now - at < ttlMs) return { ok: false, why: 'held' }
  // 过期（容器重启/进程被 SIGKILL）：清掉再抢，仍然只有一个能建成
  try { fs.rmSync(f, { force: true }) } catch { /* ignore */ }
  try { return mk() } catch { return { ok: false, why: 'race' } }
}

// ── worker：真正把研究跑完的进程 ────────────────────────────────────────
export async function work(id, { chain = 0 } = {}) {
  const lock = acquireResearchLock(id)
  if (!lock.ok) {
    log({ kind: 'work-skip', id, why: lock.why })
    return { ok: false, why: 'locked' }
  }
  const t0 = Date.now()
  const maxMs = Number(config().research?.workerMinutes ?? 25) * 60_000
  let steps = 0
  try {
    for (;;) {
      const st = readState(id)
      if (!st) return { ok: false, why: 'no-state' }
      if (st.status !== 'running') {
        if (st.status === 'done') await report(st)
        return { ok: true, status: st.status, steps }
      }
      const r = await engine.step(st, deps(), { now: Date.now() })
      const saved = persist(st)
      // 写不进去就别再往下跑了：继续跑只会让"已经算出来的东西"在进程退出时全部丢失，
      // 而且会照常花模型/网络预算（实测磁盘满时最贵的浪费）。
      if (!saved) return { ok: false, why: 'persist-failed', steps }
      // 锁丢了（被 watchdog 按 TTL 抢走）→ 立刻停手，否则两个 worker 会互相覆盖状态
      if (!lock.touch()) return { ok: false, why: 'lock-lost', steps }
      steps++
      if (r.done) {
        const after = readState(id) || st
        if (after.status === 'done') await report(after)
        return { ok: true, status: after.status, steps, last: r.action }
      }
      if (Date.now() - t0 > maxMs) {
        // 单进程时间到：把接力棒交给下一个 worker（研究总预算仍在 state.budget 里）
        if (chain < 6) spawnWorker(id, { chain: chain + 1 })
        log({ kind: 'handoff', id, steps, chain })
        return { ok: true, status: 'running', steps, handoff: true }
      }
    }
  } catch (e) {
    log({ kind: 'work-error', id, why: String(e?.message || e).slice(0, 200) })
    update(id, (s) => { s.lastError = String(e?.message || e).slice(0, 300); return s })
    return { ok: false, why: String(e?.message || e).slice(0, 200) }
  } finally {
    try { lock.release() } catch { /* ignore */ }
  }
}

// ── watchdog：worker 死了但状态还在 running → 重新拉起（维护用）──────────────
export function watchdog({ now = Date.now(), staleMin = 6, dry = false } = {}) {
  const out = []
  for (const s of tree.listStates({ now })) {
    if (s.status !== 'running') continue
    if (now - Number(s.used?.lastStepAt || s.updatedAt) < staleMin * 60_000) continue
    const id = s.id
    if (dry) { out.push({ id, staleMin: Math.round((now - Number(s.used?.lastStepAt || s.updatedAt)) / 60000), restarted: false, dry: true }); continue }
    const probe = acquireResearchLock(id, { now })
    if (probe.ok) {
      try { probe.release() } catch { /* ignore */ }
      const r = spawnWorker(id)
      out.push({ id, restarted: r.ok })
    } else {
      out.push({ id, restarted: false, why: probe.why || 'alive' })
    }
  }
  if (out.length) log({ kind: 'watchdog', out })
  return out
}

function summaryLine(s) {
  const sum = tree.summarize(s)
  const axes = Object.entries(sum.axes).filter(([, v]) => v.claims > 0).map(([k, v]) => `${k}:${v.claims}`).join(' ')
  return `${s.id} [${s.status}] 「${s.topic}」 步${sum.steps} 视频${sum.videos} 结论${sum.claims} ${axes}`
}

export async function run(argv = []) {
  const cmd = argv[0] || 'status'
  const cfgResearch = config().research || {}
  if (cfgResearch.enabled === false) { console.log('research 已在配置里关闭（research.enabled=false）'); return }

  if (cmd === 'start') {
    const topic = arg(argv, '--topic', '')
    const budget = {}
    for (const [k, key] of [['--steps', 'maxSteps'], ['--videos', 'maxVideos'], ['--llm', 'maxLlmCalls'], ['--minutes', 'maxMinutes'], ['--depth', 'maxDepth']]) {
      const v = Number(arg(argv, k, ''))
      if (Number.isFinite(v) && v > 0) budget[key] = v
    }
    const r = ensureResearch({ topic, budget })
    if (!r.ok) { console.log(JSON.stringify({ ok: false, reason: r.reason })); process.exitCode = 1; return }
    if (r.done) {
      console.log(JSON.stringify({ ok: true, id: r.id, topic: r.state.topic, done: true, note: '这个题已经研究过（结果可 research report 查看）' }))
      return
    }
    const w = spawnWorker(r.id)
    console.log(JSON.stringify({
      ok: true, id: r.id, topic: r.state.topic, resumed: r.resumed,
      worker: w.ok ? w.pid : null, budget: r.state.budget,
      note: w.ok ? '已在后台开始；跑完会主动汇报。' : '已立项，但后台进程没起来（可稍后 research work --id）',
    }))
    return
  }

  if (cmd === 'work') {
    const id = arg(argv, '--id', '')
    if (!id) { console.log(JSON.stringify({ ok: false, reason: 'no-id' })); process.exitCode = 1; return }
    const r = await work(id, { chain: Number(arg(argv, '--chain', '0')) || 0 })
    console.log(JSON.stringify(r))
    return
  }

  if (cmd === 'report') {
    const id = arg(argv, '--id', '')
    const s = id ? readState(id) : tree.listStates()[0]
    if (!s) { console.log('没有这个研究'); process.exitCode = 1; return }
    process.stdout.write(notes.reportMarkdown(s))
    if (has(argv, '--push')) {
      const r = await report(s, { force: has(argv, '--force') })
      console.log(r.ok ? '已汇报到 QQ' : `没汇报：${r.why}`)
    }
    return
  }

  if (cmd === 'status') {
    const id = arg(argv, '--id', '')
    if (id) {
      const s = readState(id)
      if (!s) { console.log('没有这个研究'); process.exitCode = 1; return }
      if (has(argv, '--json')) { console.log(JSON.stringify(tree.summarize(s), null, 1)); return }
      process.stdout.write(notes.reportMarkdown(s))
      return
    }
    const list = tree.listStates()
    if (!list.length) { console.log('还没有研究过什么。'); return }
    console.log(JSON.stringify({ ok: true, rows: list.map((s) => ({ id: s.id, topic: s.topic, status: s.status, updatedAt: s.updatedAt, ageMin: s.ageMin })) }, null, 1))
    return
  }

  if (cmd === 'list') {
    const list = tree.listStates()
    if (!list.length) { console.log('还没有研究过什么。'); return }
    for (const s of list) console.log(summaryLine(s))
    return
  }

  if (cmd === 'stop') {
    const id = arg(argv, '--id', '')
    if (!id) { console.log('用法：research stop --id <id>'); process.exitCode = 1; return }
    const s = update(id, (st) => { st.status = 'paused'; st.updatedAt = Date.now(); return st })
    console.log(s ? `已暂停 ${id}` : '没有这个研究')
    return
  }

  if (cmd === 'watchdog') {
    const out = watchdog({ dry: has(argv, '--dry') })
    console.log(JSON.stringify({ ok: true, out }, null, 1))
    return
  }

  console.log('用法：research start --topic "…" [--steps N --videos N --llm N --minutes N --depth N] | work --id <id> | status [--id] | list | report --id [--push] | stop --id | watchdog')
  process.exitCode = 1
}

export default { run, ensureResearch, searchVideos, fetchMaterials, packExcerpt, watchdog }
