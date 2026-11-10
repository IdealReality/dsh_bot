// 验证 remember_fact 修好了：对象输入不再变 [object Object]，userId 用真主号
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-test-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.BOT_CONFIG = path.join(tmp, 'cfg.json')
fs.writeFileSync(process.env.BOT_CONFIG, JSON.stringify({
  owner: { qq: '10001', name: '笨蛋老爸' },
  identity: { ownerTitle: '笨蛋老爸' },
}))

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }

const T = await import('../tools/lib/tools.mjs')
const memory = await import('../tools/lib/memory.mjs')

// 记忆落在 ~/.data/qq/episodes.jsonl（memory.remember → episodeFile('qq')）
const dump = () => {
  try { return fs.readFileSync(path.join(tmp, 'qq', 'episodes.jsonl'), 'utf8') } catch { return '' }
}

console.log('[remember_fact 四种输入]')
const cases = [
  ['字符串', '我喜欢吃白饭', '我喜欢吃白饭'],
  ['对象 {text}', { text: '主人凌晨两点睡' }, '主人凌晨两点睡'],
  ['对象 {value}', { key: '作息', value: '晚睡晚起' }, '晚睡晚起'],
  ['对象没说清', { a: 1, b: 2 }, '{'],
]
for (const [name, input, expect] of cases) {
  const before = dump().length
  const r = await T.runTool('remember_fact', { text: input })
  const added = dump().slice(before)
  ok(`${name} → 「${expect}」`, r.ok && added.includes(expect) && !added.includes('[object Object]'),
    `ok=${r.ok} 新增长度=${added.length} 含[object Object]=${added.includes('[object Object]')}`)
}

console.log('\n[userId 用真主号]')
{
  const all = dump()
  ok('记忆里出现真主号 10001', all.includes('10001'), '')
  ok('不把字面量 owner 当 id', !/"userId":"owner"/.test(all), '')
}

console.log('\n[空输入]')
{
  const r = await T.runTool('remember_fact', { text: '' })
  ok('空文本拒绝', r.ok === false, JSON.stringify(r))
  const r2 = await T.runTool('remember_fact', {})
  ok('缺参数拒绝', r2.ok === false)
}

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ remember_fact 修复验证通过')
process.exit(bad ? 1 : 0)
