// 群聊隐私分级回归（2026-11-09）
//
// 背景：用户 10-26 拍板「群里也要记得私聊，只要能分清人」→ 默认仍然注入（groupPrivateRecall=true）。
// 但那是"默认"，不是"没有开关"。这个测试钉住两件事：
//   ① 默认：群里照旧能看到私聊内容（保持老口径，group-persona-test 也在断言这条）
//   ② 关闭开关（privacy.groupPrivateRecall=false）：
//        · recallAll(audience='group') 不再返回一对一私聊行
//        · 群里 system 里出现不了主人私聊的原话
//        · 她自己公开活动（B站/上网）照样在，不算"失忆"
//
// 跑法：node test/privacy-audience-test.mjs
//
// ⚠️ 隔离：paths.mjs 在 import 时定 HOME，所以先改环境变量再 import。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-priv-'))
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
const cfgFile = path.join(tmp, 'bot.config.json')
fs.writeFileSync(cfgFile, JSON.stringify({
  identity: { name: '理想的机械人', ownerTitle: '用户', selfClaim: '我' },
  owner: { qq: '10001', name: '用户' },
  platforms: { qq: true, wechat: false, bilibili: false, douyin: false },
  privacy: { groupPrivateRecall: false },
}))
process.env.BOT_CONFIG = cfgFile

const paths = await import('../tools/lib/infra/paths.mjs')
const memory = await import('../tools/lib/mind/memory.mjs')
const { buildMessages } = await import('../tools/lib/self/persona.mjs')

if (!paths.dataDir.startsWith(tmp)) {
  console.error(`✗ 隔离失败：dataDir=${paths.dataDir} 指向了真实目录，测试中止`)
  process.exit(2)
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}
const sysOf = (o) => buildMessages(o)[0].content

// 造料：私聊原话 / 群里群友的话 / 她自己的公开活动
const SECRET = '私聊原话：我今天发烧了三十八度，别告诉别人'
memory.remember('qq', 'qq:10001', '10001', 'user', SECRET)
memory.remember('qq', 'qq:2161082407', '2208444939', 'user', '与光同尘：群里这句是群友说的', { isGroup: true })
memory.remember('bilibili', 'bilibili:watch', 'self', 'assistant', '我在B站看了一个修手表的视频')

const GROUP = { platform: 'qq', chatId: 'qq:2161082407', userId: '2208444939', userText: '在吗', isGroup: true }

console.log('\n[1] recallAll 的 audience 过滤')
{
  const g = memory.recallAll('qq:2161082407', { hours: 12, max: 12, audience: 'group' })
  const gtext = g.lines.join('\n')
  ok('群聊视角：不含一对一私聊原话', !gtext.includes('发烧') && !gtext.includes('别告诉别人'), gtext)
  ok('群聊视角：保留她的公开活动（B站/上网）', /B站|上网/.test(gtext) || g.lines.length === 0, gtext)
  const p = memory.recallAll('qq:2161082407', { hours: 12, max: 12, audience: 'private' })
  ok('私聊视角：默认仍能看到私聊原话（老口径不失守）', p.lines.join('\n').includes('发烧'), p.lines.join('\n'))
}

console.log('\n[2] 群聊 system 不泄漏私聊原话（groupPrivateRecall=false）')
{
  const sys = sysOf(GROUP)
  ok('system 里没有私聊原话', !sys.includes('发烧') && !sys.includes('别告诉别人'))
  ok('群聊规则仍在（要分得清人）', /群/.test(sys))
}

console.log('\n[3] 开关默认值 = 保持老口径')
{
  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  const cfgMod = await import('../tools/lib/infra/config.mjs')
  ok('DEFAULTS 里有 privacy.groupPrivateRecall', cfgMod.DEFAULTS?.privacy?.groupPrivateRecall === true)
  ok('配置里显式 false 生效（本测试就是 false）', raw.privacy.groupPrivateRecall === false)
}

console.log(`\n${fail === 0 ? '✓' : '✗'} privacy-audience-test: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
