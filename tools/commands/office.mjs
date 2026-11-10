// office —— 办公台 CLI（聊天里 office_task 立项，后台 office work 干活）
//
//   node bot.mjs office start --goal "统计我这周跟谁聊得最多，结果写成 md" [--steps 20] [--minutes 12]
//   node bot.mjs office work --id of-xxx      （由 start 自动 spawn，一般不用手动）
//   node bot.mjs office list | status [--id of-xxx] | report --id of-xxx | stop --id of-xxx
import * as office from '../lib/work/office.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export async function run(argv = []) {
  const sub = argv[0] || 'list'
  if (sub === 'start') {
    const goal = arg(argv, '--goal') || argv.slice(1).filter((a) => !a.startsWith('--')).join(' ')
    const r = office.start({ goal, steps: Number(arg(argv, '--steps')) || undefined, minutes: Number(arg(argv, '--minutes')) || undefined })
    console.log(JSON.stringify(r))
    if (!r.ok) process.exitCode = 1
    return
  }
  if (sub === 'work') {
    const id = arg(argv, '--id')
    if (!id) { console.error('用法：office work --id <id>'); process.exitCode = 2; return }
    const r = await office.work(id)
    console.log(JSON.stringify({ ok: r.ok, id, final: String(r.final || r.reason || '').slice(0, 200) }))
    return
  }
  if (sub === 'stop') {
    const r = office.stop(arg(argv, '--id'))
    console.log(JSON.stringify(r))
    if (!r.ok) process.exitCode = 1
    return
  }
  if (sub === 'report') {
    const id = arg(argv, '--id')
    const st = office.state(id)
    if (!st) { console.error('没这个任务'); process.exitCode = 1; return }
    console.log('目标：' + st.goal + '\n状态：' + st.state + (st.error ? '｜' + st.error : ''))
    console.log('\n结论：' + (st.final || '（还没收尾）'))
    const t = (st.trace || []).slice(-12)
    if (t.length) console.log('\n最近动作：\n' + t.map((x) => (x.ok ? '✅ ' : '❌ ') + x.name + ' ' + JSON.stringify(x.args).slice(0, 120)).join('\n'))
    return
  }
  if (sub === 'status' || sub === 'list') {
    const id = arg(argv, '--id')
    const rows = office.state(id)
    if (id) { console.log(JSON.stringify(rows, null, 1).slice(0, 2000)); return }
    if (!rows?.length) { console.log('（办公台还没干过活）'); return }
    for (const r of rows.slice(-8)) {
      const t = r.endedAt ? Math.round((r.endedAt - r.startedAt) / 60000) + 'min' : '—'
      console.log(`${r.id}  ${r.state.padEnd(8)}  ${t.padStart(6)}  ${r.goal.slice(0, 60)}`)
    }
    return
  }
  console.error('用法：office start --goal "…" | work --id x | list | status [--id x] | report --id x | stop --id x')
  process.exitCode = 2
}
