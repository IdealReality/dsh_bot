// wander —— "自己逛 B 站"的纯逻辑测试（2026-11-07）
//
// 这里**不联网**：真实的搜索/热门由冒烟脚本验证（容器内实测 122~842ms）。
// 单测盯的是那些"网络好好的也不会被发现"的错：
//   · 刷到过的条目又刷一次（重复的逛没有信息量）
//   · 跨天额度没归零（第二天就不能逛了）
//   · 额度 0 还能逛（配置写 0 就该彻底停）
//   · 播放/时长的显示把 1.2万 写成 12000、把 76 秒写成 1:76
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-wander-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }

const W = await import('../tools/lib/wander.mjs')
const B = await import('../tools/lib/bili-web.mjs')

const now = Date.parse('2026-11-07T12:00:00Z')
const todayKey = new Date(now).toISOString().slice(0, 10)

console.log('\n[pickFresh]')
{
  const pool = [{ bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' }]
  ok('没刷过 → 取第一条', W.pickFresh(pool, []).bvid === 'BV1', '')
  ok('刷过第一条 → 取第二条', W.pickFresh(pool, ['BV1']).bvid === 'BV2', '')
  ok('全刷过 → 退回第一条（不空手）', W.pickFresh(pool, ['BV1', 'BV2', 'BV3']).bvid === 'BV1', '')
  ok('空池 → null', W.pickFresh([], ['BV1']) === null, '')
  ok('没有 bvid 的条目被过滤', W.pickFresh([{ title: 'x' }, { bvid: 'BV9' }], []).bvid === 'BV9', '')
  ok('seen 不是数组也不崩', W.pickFresh(pool, null).bvid === 'BV1', '')
}

console.log('\n[tally]')
{
  ok('同一天计数', W.tally({ day: todayKey, count: 2 }, 6, now).count === 2, '')
  ok('同一天还有额度', W.tally({ day: todayKey, count: 2 }, 6, now).allowed === true, '')
  ok('额度用完', W.tally({ day: todayKey, count: 6 }, 6, now).allowed === false, '')
  ok('跨天归零', W.tally({ day: '2026-11-06', count: 6 }, 6, now).count === 0, '')
  ok('跨天恢复额度', W.tally({ day: '2026-11-06', count: 6 }, 6, now).allowed === true, '')
  ok('配置 0 → 一次也不逛', W.tally({ day: todayKey, count: 0 }, 0, now).allowed === false, '')
  ok('负数配置按 0 处理', W.tally({ day: todayKey, count: 0 }, -3, now).allowed === false, '')
}

console.log('\n[格式化]')
{
  ok('1.2 万播放', B.playText(12345) === '1.2万', B.playText(12345))
  ok('1.5 亿播放', B.playText(150000000) === '1.5亿', B.playText(150000000))
  ok('不足一万原样', B.playText(999) === '999', B.playText(999))
  ok('76 秒 → 1:16', B.durText(76) === '1:16', B.durText(76))
  ok('3725 秒 → 1:02:05', B.durText(3725) === '1:02:05', B.durText(3725))
  ok('已是 mm:ss 原样', B.durText('3:29') === '3:29', B.durText('3:29'))
  ok('空时长 → 空', B.durText('') === '' && B.durText(null) === '', '')
}

console.log('\n[兴趣词]')
{
  // 空目录 → 没有兴趣词（退回热门）
  ok('没有语料 → null', W.interestKeyword({ now }) === null, String(W.interestKeyword({ now })))
  const dir = path.join(tmp, 'brain', 'learn')
  fs.mkdirSync(dir, { recursive: true })
  const nowMs = now
  fs.writeFileSync(path.join(dir, 'lexicon.json'), JSON.stringify({
    chats: { 'qq:1': {
      '站上有': { n: 9, lastAt: nowMs },      // 分词垃圾（含虚词）→ 必须被滤掉
      '摸鱼': { n: 8, lastAt: nowMs },        // 2 字太泛 → 滤掉
      '大肥鱼': { n: 6, lastAt: nowMs },      // 合格
      '过时词': { n: 9, lastAt: nowMs - 30 * 86400_000 },  // 30 天前 → 不算
    } },
  }))
  const kw = W.interestKeyword({ now })
  ok('垃圾词/过短/过期都被滤掉', kw === '大肥鱼', String(kw))
}

console.log('\n[导出与状态]')
{
  // 这一段**不联网**：真实逛由冒烟脚本验证（容器内 122~842ms）。
  ok('wander 是函数', typeof W.wander === 'function', typeof W.wander)
  ok('status 可读且不联网', typeof W.status().count === 'number', JSON.stringify(W.status()))
  ok('search/popular 都导出', typeof W.search === 'function' && typeof W.popular === 'function', '')
  ok('纯函数不读盘也不抛', (() => { try { W.pickFresh(null, null); W.tally(null, 6, now); return true } catch { return false } })(), '')
}

console.log(bad ? `\n❌ wander：${bad} 条断言失败` : '\n✅ wander：全部通过')
process.exit(bad ? 1 : 0)
