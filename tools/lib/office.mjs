// office —— 她的办公桌（2026-11-09）
//
// 病根：聊天工具链的总预算 30 秒、单个工具 12 秒（agent.mjs 里写死的三层预算）。
// 「写个脚本统计、把一批文件整理一下、把那几篇专栏都读完做个对比」这类活
// 无论工具多齐全都装不进 12 秒 —— 于是她在 QQ 里只能说"我做不到"。
//
// 拆法（不是把预算调大，调大会让她每条闲聊都变慢）：
//   聊天里只「立项 + 回执」（office_task，<1 秒）
//   → 独立进程跑 office work（几十步、十几分钟，不钉住事件循环）
//   → 跑完主动 QQ 汇报，产出落盘
// 这就是 research 已经验证过的形态（research_topic → research work），不是新发明。
//
// 边界不变：她用的还是 tools.mjs 里那几个工具，路径/命令仍过 sandbox.mjs。
// 后台进程多出来的只是「时间和步数」，不是「权限」。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'
import * as llm from './llm.mjs'
import { CHAT_TOOLS, runTool } from './tools.mjs'
import { sendOwnerQQ } from './notify.mjs'

const DIR = () => dataPath('office')
const FILE = () => path.join(DIR(), 'tasks.json')
const BOT = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bot.mjs')

/** 办公时能用哪些工具：只读/写/跑/查，不给"再开一个研究任务"这种套娃。 */
const NAMES = new Set([
  'find_files', 'read_file', 'write_file', 'run_command',
  'look_up', 'bili_search', 'bili_article', 'watch_video', 'check_memory',
])
export const OFFICE_TOOLS = CHAT_TOOLS.filter((t) => NAMES.has(t?.function?.name))

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')) } catch { return { rows: [] } }
}
function writeAll(s) {
  fs.mkdirSync(DIR(), { recursive: true })
  const t = FILE() + '.tmp'
  fs.writeFileSync(t, JSON.stringify(s, null, 2))
  fs.renameSync(t, FILE())
}
function patch(id, fn) {
  const s = readAll()
  const row = (s.rows || []).find((r) => r.id === id)
  if (!row) return null
  fn(row)
  writeAll(s)
  return row
}

let seq = 0
const newId = () => 'of-' + Date.now().toString(36) + '-' + (++seq).toString(36)

const playing = () => (readAll().rows || []).find((r) => r.state === 'running' || r.state === 'queued') || null

/**
 * 立项：只写状态 + 起进程，必须快（聊天工具预算 12 秒，实测 <1 秒）。
 * @param {{goal:string, steps?:number, minutes?:number}} a
 */
export function start(a = {}) {
  const goal = String(a.goal || '').replace(/\s+/g, ' ').trim()
  if (!goal) return { ok: false, reason: '没给要做的事' }
  if (goal.length > 800) return { ok: false, reason: '目标太长了，拆小一点' }
  const cfg = config().office || {}
  if (cfg.enabled === false) return { ok: false, reason: '办公台被关掉了（config.office.enabled=false）' }
  const running = playing()
  if (running) return { ok: true, busy: true, id: running.id, goal: running.goal, note: '手上还有一件没干完' }
  const row = {
    id: newId(), goal, state: 'queued',
    steps: Math.min(40, Math.max(1, Number(a.steps) || Number(cfg.maxSteps) || 20)),
    minutes: Math.min(60, Math.max(1, Number(a.minutes) || Number(cfg.maxMinutes) || 12)),
    createdAt: Date.now(), startedAt: 0, endedAt: 0, step: 0, trace: [], final: '', error: '',
  }
  const s = readAll()
  s.rows = [...(s.rows || []), row].slice(-80)
  writeAll(s)
  let worker = false
  try {
    const p = spawn(process.execPath, [BOT(), 'office', 'work', '--id', row.id], {
      detached: true, stdio: 'ignore', cwd: dataPath(),
    })
    p.unref()
    worker = true
  } catch { worker = false }
  if (!worker) {
    // 起不来就如实记，别让它占着"queued"把后续任务全挡在外面。
    patch(row.id, (x) => { x.state = 'failed'; x.error = '后台进程没起来'; x.endedAt = Date.now() })
    return { ok: false, id: row.id, reason: '后台进程没起来（任务已记下但不会自己跑）' }
  }
  return { ok: true, id: row.id, goal, worker }
}

/** 后台真正干活（独立进程）。 */
export async function work(id) {
  const row0 = readAll().rows?.find((r) => r.id === id)
  if (!row0) return { ok: false, reason: '没这个任务' }
  if (row0.state === 'running') return { ok: false, reason: '已经在跑了' }
  const row = patch(id, (r) => { r.state = 'running'; r.startedAt = Date.now(); r.error = '' })
  const outDir = path.join(DIR(), id)
  fs.mkdirSync(outDir, { recursive: true })
  const deadline = Date.now() + (Number(row.minutes) || 12) * 60_000
  const maxSteps = Number(row.steps) || 20

  const sys = [
    '你在一张**办公桌**上做事，不是在聊天。用户给你的是一件具体的事，你要真的做完，然后把结果交出来。',
    `你现在有一台自己的机器（容器里的 /home/dsh），可以用工具：${OFFICE_TOOLS.map((t) => t.function.name).join('、')}。`,
    `产出（脚本、报告、整理结果）写到 .data/office/${id}/ 下面。`,
    '纪律：',
    '① 每步都想清楚再动手；动手前别宣布"我马上做"，直接用工具。',
    '② 工具失败就换办法，别假装成功。三次同一失败就停下来说清楚卡在哪。',
    '③ 最后一条回复不带工具调用，直接给结论：做了什么、结果在哪、有什么没做成。',
    '④ 结论要能被检验：数字从工具输出里来，不许估。',
  ].join('\n')

  let msgs = [{ role: 'system', content: sys }, { role: 'user', content: row.goal }]
  const trace = []
  let final = ''
  let step = 0
  try {
    for (; step < maxSteps && Date.now() < deadline; step++) {
      const left = deadline - Date.now()
      if (left < 5000) break
      const r = await llm.chatRaw(msgs, {
        purpose: 'tool', tools: OFFICE_TOOLS, toolChoice: 'auto',
        max_tokens: 1200, timeoutMs: Math.min(60_000, left),
      })
      const msg = r?.message || {}
      const content = String(msg.content || '').trim()
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      if (!calls.length) { final = content || String(r?.text || ''); break }
      msgs.push({ role: 'assistant', content, tool_calls: calls })
      for (const c of calls) {
        const name = String(c?.function?.name || '')
        let args = {}
        try { args = JSON.parse(String(c?.function?.arguments || '{}')) } catch { args = {} }
        const res = await runTool(name, args).catch((e) => ({ ok: false, result: '工具异常：' + String(e?.message || e).slice(0, 120) }))
        trace.push({ at: Date.now(), name, args, ok: !!res?.ok, result: String(res?.result || '').slice(0, 500) })
        msgs.push({ role: 'tool', tool_call_id: String(c.id || ''), content: String(res?.result || (res?.ok ? '完成' : '失败')).slice(0, 3000) })
      }
      patch(id, (x) => { x.step = step + 1; x.trace = trace.slice(-40) })
      // 上下文太长就压成一条进度摘要。
      // ⚠️ 绝不能对 messages 直接切片：assistant(tool_calls) 与它的 tool 结果是一个原子对，
      // 切在中间会让下游 API 报 "tool_call_id 对应的消息不存在"，整条任务当场失败。
      // 压成「system + 目标 + 一条进度 user 消息」永远合法。
      if (msgs.length > 44) {
        const notes = trace.slice(-10).map((t) => '- ' + t.name + (t.ok ? ' 成功：' : ' 失败：') + String(t.result).replace(/\s+/g, ' ').slice(0, 120)).join('\n')
        msgs = [msgs[0], msgs[1], { role: 'user', content: '【进度摘要】到这里做过这些：\n' + notes + '\n接着做，别重复已经完成的步骤。' }]
      }
    }
    if (!final) {
      // 步数/时间用完了。直接写"没来得及收尾"等于把已经拿到的结果扔掉 ——
      // 实测她常常在最后一步才拿到数据。这里给模型一次"只说话不动手"的收尾机会。
      try {
        const notes = trace.slice(-12).map((t) => '- ' + t.name + (t.ok ? ' 成功：' : ' 失败：') + String(t.result).replace(/\s+/g, ' ').slice(0, 200)).join('\n')
        final = String(await llm.chat([
          { role: 'system', content: '你在给一个已经用了步数预算的任务写结论。只能用文字，不能再调工具。' },
          { role: 'user', content: '目标：' + row.goal + '\n\n已经做到的事（工具记录）：\n' + (notes || '（没动手）') + '\n\n请用三到五句说清：做成了什么、关键结果是什么、哪里没做完。数字只写记录里有的。' },
        ], { purpose: 'tool', max_tokens: 600, timeoutMs: 25_000 }) || '').trim()
      } catch { final = '' }
      if (!final) final = '（步数/时间用完了，没来得及收尾。已做的步骤见报告。）'
    }
    const report = ['# ' + row.goal, '', '产出目录：`' + path.relative('/', outDir) + '`', '', final]
      .concat(['', '## 执行记录', ...trace.map((t) => `- ${t.ok ? '✅' : '❌'} \`${t.name}\` ${JSON.stringify(t.args).slice(0, 160)}`)])
      .join('\n')
    try { fs.writeFileSync(path.join(outDir, 'report.md'), report, 'utf8') } catch { /* 报告写不成不影响结论 */ }
    patch(id, (x) => { x.state = 'done'; x.endedAt = Date.now(); x.final = final.slice(0, 2000); x.trace = trace.slice(-40); x.step = step })
    const okCount = trace.filter((t) => t.ok).length
    const say = '「' + row.goal.slice(0, 40) + '」做完了。'
      + (trace.length ? `动了 ${trace.length} 次手（成 ${okCount}），` : '')
      + '结论：' + final.replace(/\s+/g, ' ').slice(0, 320)
      + '\n（详细在 .data/office/' + id + '/report.md）'
    await sendOwnerQQ(say).catch(() => false)
    return { ok: true, id, final }
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300)
    patch(id, (x) => { x.state = 'failed'; x.endedAt = Date.now(); x.error = msg; x.trace = trace.slice(-40) })
    await sendOwnerQQ('「' + row.goal.slice(0, 40) + '」没做成：' + msg.slice(0, 200)).catch(() => false)
    return { ok: false, reason: msg }
  }
}

export function state(id) {
  const rows = readAll().rows || []
  return id ? rows.find((r) => r.id === id) || null : rows
}
export function stop(id) {
  const row = patch(id, (r) => { if (r.state === 'running' || r.state === 'queued') { r.state = 'stopped'; r.endedAt = Date.now() } })
  return row ? { ok: true, id, state: row.state } : { ok: false, reason: '没这个任务' }
}
