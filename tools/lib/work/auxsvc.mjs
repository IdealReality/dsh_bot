// 辅助服务守护（10-27）
// 病根：辅助服务是**插件启动时 spawn 一次**的子进程，一崩就再没人管。
// 它一崩就再没人管 —— 真实发生：09:46 起过一次，之后进程没了，用户发私信一整天没人回。
// qq-server 是唯一的常驻体（插件会拉它、dsd 里也能看见），所以让它当监工：
//   · 每 90s 探一次 /health，死了就拉起来（带退避，别 crash-loop）
//   · 同时兜 B站 自己作品评论的巡检（用户要的"有新评论就自己去回"）
// 只做**拉起**，不做杀进程：插件自己那份逻辑还在，谁先起算谁的，探测到活着就什么都不做。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config } from '../infra/config.mjs'
import { dataPath } from '../infra/paths.mjs'
import { swallow } from '../infra/swallow.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const BOT_MJS = path.join(ROOT, 'tools', 'bot.mjs')
const SUP_FILE = () => dataPath('aux-supervisor.json')

function readState() {
  try { return JSON.parse(fs.readFileSync(SUP_FILE(), 'utf8')) } catch { return {} }
}
function writeState(s) {
  try { fs.mkdirSync(path.dirname(SUP_FILE()), { recursive: true }); fs.writeFileSync(SUP_FILE(), JSON.stringify(s, null, 1)) } catch (e) { swallow(e, 'auxsvc:writeState') }
}

function say(line) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
  try {
    fs.mkdirSync(path.dirname(SUP_FILE()), { recursive: true })
    fs.appendFileSync(dataPath('aux-supervisor.log'), `${t} ${line}\n`)
  } catch (e) { swallow(e, 'auxsvc:say') }
}

/**
 * 同一句告警在冷却期内只打一次（2026-11-11）。
 * 病根：B站 号被审核时，每 12 分钟一轮巡检都输出同一句「3 条仅自己可见」，
 * 实测 2 周里刷了上千行，真正的状态变化被淹没。判据取前 60 字，避免尾差导致失效。
 */
const WARN_FILE = () => dataPath('aux-warn-state.json')
function sayDedup(line, cooldownMs = 24 * 3600_000) {
  const key = String(line).slice(0, 60)
  try {
    const st = JSON.parse(fs.readFileSync(WARN_FILE(), 'utf8'))
    if (st?.key === key && Date.now() - Number(st.at || 0) < cooldownMs) return false
  } catch { /* 没有状态文件 = 第一次 */ }
  say(line)
  try {
    fs.mkdirSync(path.dirname(WARN_FILE()), { recursive: true })
    fs.writeFileSync(WARN_FILE(), JSON.stringify({ key, at: Date.now() }))
  } catch (e) { swallow(e, 'auxsvc:warnState') }
  return true
}

/** 端口上到底活没活（HTTP /health 优先，退化成 TCP 探测）。 */
export async function probeHealth(port, timeoutMs = 2500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return { alive: false, why: 'HTTP ' + r.status }
    const j = await r.json().catch(() => ({}))
    return { alive: j?.ok !== false, json: j }
  } catch (e) {
    return { alive: false, why: String(e?.message || e).slice(0, 60) }
  }
}

function spawnDetached(args, logName, env = {}) {
  const logPath = dataPath(logName)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const fd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [BOT_MJS, ...args], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env },
  })
  child.unref()
  try { fs.closeSync(fd) } catch (e) { swallow(e, 'auxsvc:spawnDetached') }
  return child
}

/** B站 自己作品评论巡检：到点就跑一次 replies --own-only --go（额度/自刹车由它自己管）。 */
// sig/same/nextAt：同样结论的连续次数与"下次最早什么时候再跑"（2026-11-11）
const lastOwnScan = { at: 0, running: false, tries: [], lastStart: 0, sig: '', same: 0, nextAt: 0 }
export async function ensureBiliOwnReply({ everyMin = 0 } = {}) {
  const cfg = config()
  const rp = cfg.bilibili?.replies ?? {}
  if (!cfg.bilibili || cfg.bilibili.enabled === false) return { skipped: 'bilibili 关着' }
  if (rp.enabled !== true || rp.ownWorks === false) return { skipped: 'bilibili.replies 关着' }
  const every = Number(everyMin || rp.autoMin || 12) * 60_000
  const nowMs = Date.now()
  if (!everyMin && nowMs - lastOwnScan.at < every) return { skipped: '还没到点' }
  // 2026-11-11：连续几轮结论一模一样就指数退避（12min → 1h → 4h → 16h → 24h 封顶）。
  // 病根：B站 号被审核时每 12 分钟跑一轮，结论永远是「最近 3 条评论里 3 条仅自己可见」，
  // 实测连刷两周、上千次 API 调用。结论一变（有新评论/审核结束）立刻复位。
  if (!everyMin && nowMs < lastOwnScan.nextAt) return { skipped: '结论没变，退避中', until: lastOwnScan.nextAt }
  if (lastOwnScan.running) return { skipped: '上一轮还在跑' }

  // 退避（10-31 补）：10 分钟内连续起 3 次都没成 → 拉长间隔，别 crash-loop 刷进程。
  lastOwnScan.tries = (lastOwnScan.tries || []).filter((t) => nowMs - t < 10 * 60_000)
  if (lastOwnScan.tries.length >= 3 && nowMs - Number(lastOwnScan.lastStart || 0) < 10 * 60_000) {
    return { skipped: '退避中', backedOff: true, tries: lastOwnScan.tries.length }
  }
  lastOwnScan.lastStart = nowMs
  lastOwnScan.tries.push(nowMs)
  lastOwnScan.running = true
  try {
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BOT_MJS, 'replies', '--own-only', '--go', '--max', '2'], { windowsHide: true })
      let buf = ''
      let settled = false
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
      // 2026-11-11：原来没有超时 —— B站 一慢，这一轮永远 running，
      // 之后每一拍都返回"上一轮还在跑"，巡检等于静默死掉。
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } done(buf + '\n[巡检超时 120s，已终止]') }, 120_000)
      child.stdout.on('data', (d) => { buf += d.toString() })
      child.stderr.on('data', (d) => { buf += d.toString() })
      child.on('exit', () => done(buf))
      child.on('error', (e) => done(buf + '\n' + e.message))
    })
    lastOwnScan.at = Date.now()
    const interesting = out.split('\n').filter((l) => /已回复|回评失败|新评论|⛔|⚠|自己作品/.test(l)).slice(0, 6).join(' | ')
    // 结论签名 → 连续相同次数 → 退避（只在自动节拍里生效，显式 everyMin 不受影响）
    const sig = interesting.slice(0, 80)
    if (sig && sig === lastOwnScan.sig) lastOwnScan.same = (lastOwnScan.same || 0) + 1
    else { lastOwnScan.same = 0; lastOwnScan.sig = sig }
    const backoffMin = lastOwnScan.same >= 2 ? Math.min(24 * 60, 60 * Math.pow(4, Math.min(lastOwnScan.same - 2, 3))) : 0
    lastOwnScan.nextAt = backoffMin ? Date.now() + backoffMin * 60_000 : 0
    if (interesting) sayDedup(`B站 自己作品巡检：${interesting}`)
    return { ran: true, out: interesting, backoffMin }
  } finally {
    lastOwnScan.running = false
  }
}

/** qq-server 启动时挂上：先原地修一次，之后每 90s 探活。 */
export function superviseAux({ intervalMs = 90_000 } = {}) {
  const tick = async () => {
    try { await ensureBiliOwnReply() } catch (e) { say('B站 巡检出错：' + String(e.message).slice(0, 80)) }
  }
  setTimeout(() => { void tick() }, 8_000)
  return setInterval(() => { void tick() }, Math.max(30_000, intervalMs))
}