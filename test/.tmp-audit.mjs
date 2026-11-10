// 十遍循环 4~9 遍的取证脚本（不入库，只跑一次看数据）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'id-audit-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
for (const d of ['brain/meta', 'brain/ep', 'brain/working']) fs.mkdirSync(path.join(tmp, d), { recursive: true })

const B = await import('../tools/brain/identity-bio.mjs')
const I = await import('../tools/brain/identity.mjs')
const field = await import('../tools/brain/field.mjs')
const inner = await import('../tools/brain/inner.mjs')

const now = Date.now()
const dim = (k) => Number(field.evolve(now)?.dims?.[k] ?? 0)

console.log('=== 第4遍 化学：连续 20 次被问身份，ne 会不会顶到 1 ===')
{
  for (let i = 0; i < 20; i++) B.chemReact('asked', { now, repeat: i + 1 })
  console.log('ne =', dim('ne').toFixed(3), '| cortisol =', dim('cortisol').toFixed(3))
  console.log('判定：', dim('ne') < 0.85 ? '可控（不会顶死）' : '⚠ 顶到高位，需加封顶')
}

console.log('\n=== 第5遍 生物：低能量时门控真的降级吗 ===')
{
  fs.writeFileSync(path.join(tmp, 'metabolism.json'), JSON.stringify({ energy: 0.1, pendingDigest: 0, lastTickAt: 0 }))
  const g = B.metabolicGate(now)
  console.log('energy=0.1 →', JSON.stringify(g))
  fs.writeFileSync(path.join(tmp, 'metabolism.json'), JSON.stringify({ energy: 0.9, pendingDigest: 0, lastTickAt: 0 }))
  const g2 = B.metabolicGate(now)
  console.log('energy=0.9 →', JSON.stringify(g2))
  console.log('判定：', (!g.canDeep && g2.canDeep) ? '门控有效' : '⚠ 门控没生效')
}

console.log('\n=== 第6遍 心理：阈值 3 能不能达到（recall limit=4） ===')
{
  // 造 5 条沾边的记忆
  const rows = []
  for (let i = 0; i < 5; i++) {
    rows.push(JSON.stringify({
      id: 'ep-audit-' + i, at: now - i * 3600_000, atIso: '',
      who: { self: 'dsh_bot', others: [] }, where: { platform: 'qq', chat: 'qq:1', group: null },
      scope: 'private', act: 'say', gist: '大肥鱼 发的 视频 第' + i + '条', quote: '',
      feel: { valence: 0, arousal: 0.3, label: '日常' }, salience: 0.5, novelty: 0.5, entities: [], evidence: [], srcEv: '',
    }))
  }
  fs.writeFileSync(path.join(tmp, 'brain', 'ep', '2026-11.jsonl'), rows.join('\n') + '\n')
  const v = I.verify('大肥鱼这是你发的视频吗', { platform: 'qq', chatId: 'qq:1', userId: '9', isGroup: false, isOwner: false })
  console.log('陌生人问 + 有记忆 →', v.verdict, '| 内部命中', v.internal.count, '| 阈值', v.bias.threshold)
  const v2 = I.verify('就是你吧，肯定是你发的视频', { platform: 'qq', chatId: 'qq:1', userId: '9', isGroup: false, isOwner: false })
  console.log('奉承句 + 有记忆 →', v2.verdict, '| 阈值', v2.bias.threshold)
  console.log('判定：', v.verdict === 'mine' ? '正常问能认' : '⚠ 正常问也认不出')
}

console.log('\n=== 第7遍 神经：冲突写内心流会不会刷爆 ===')
{
  const before = inner.snapshot?.()?.items?.length ?? 0
  for (let i = 0; i < 10; i++) B.record({ verdict: 'mine', conflict: { fast: 'not-mine', slow: 'mine' }, now })
  const after = inner.snapshot?.()?.items?.length ?? 0
  console.log('inner 条目', before, '→', after, '（本段 +10 次冲突）')
  console.log('判定：', after - before <= 10 ? '有界' : '⚠ 无界增长')
}

console.log('\n=== 第8遍 主观：三态实际措辞 ===')
{
  fs.rmSync(path.join(tmp, 'brain', 'ep'), { recursive: true, force: true })
  for (const [n, t] of [['mine?', '大肥鱼这是你发的吗'], ['not-mine', '这号 123456789 是你吗'], ['unknown', '是你吗']]) {
    const v = I.verify(t, { platform: 'qq', chatId: 'qq:1', userId: '9', isGroup: false, isOwner: false })
    console.log(`[${n}] verdict=${v.verdict}`)
    console.log('  ' + String(v.line).split('\n').slice(-1)[0])
  }
}

console.log('\n=== 第9遍 哲学：主人 + 无记忆 会不会乱认 ===')
{
  console.log('owner/无记忆 →', B.judge({ accountOk: null, memoryCount: 0, threshold: 1, relationOk: true }).verdict, '(应 unknown)')
  console.log('owner/1条记忆 →', B.judge({ accountOk: null, memoryCount: 1, threshold: 1, relationOk: true }).verdict, '(应 mine)')
  console.log('别人号+5条记忆 →', B.judge({ accountOk: false, memoryCount: 5, threshold: 1 }).verdict, '(应 not-mine，排除优先)')
}
