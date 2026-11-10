// cohere 压力/边界测试（2026-11-07）
//
// 目标不是"再测一遍正常路径"，而是**六遍循环里最容易把常驻服务搞挂的那些形状**：
//   · 状态文件被写坏（半份 JSON / 空文件 / 目录被删）
//   · 一天里连着收几十条（线程状态会不会无界增长）
//   · 空白/纯标点/超长/只有图（解码器会不会抛）
//   · 时间跳跃（跨天、时钟回拨）
//   · 同一条消息被投递两次（幂等）
// 三个硬要求：全链不抛、耗时可控、状态大小有界。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-cohere-stress-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

let bad = 0
const ok = (n, p, d = '') => { if (!p) bad++; console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? ' —— ' + d : ''}`) }
const noThrow = (n, fn) => {
  try { fn(); ok(n, true) } catch (e) { ok(n, false, String(e && e.message)) }
}

const P = await import('../tools/brain/cohere/percept.mjs')
const T = await import('../tools/brain/cohere/thread.mjs')
const S = await import('../tools/brain/cohere/signal.mjs')
const X = await import('../tools/brain/cohere/expression.mjs')
const Y = await import('../tools/brain/cohere/psyche.mjs')
const C = await import('../tools/brain/cohere/index.mjs')

const now = Date.now()

// ── 一、解码器：奇怪输入不许抛 ───────────────────────────────────────
console.log('\n[decode 边界]')
for (const [name, text] of [
  ['空字符串', ''],
  ['纯空白', '   \n\t  '],
  ['纯标点', '！！！？？？……'],
  ['超长 5000 字', '看'.repeat(2500) + '余额' + '。'.repeat(2499)],
  ['纯 emoji', '😋😴🐟'],
  ['混合控制字符', '\u0000\u0001测试\u0007'],
  ['只有引用信封', '【他引用的是你自己刚说的这一句（08:12）：「你好」】'],
]) {
  noThrow('decode ' + name, () => P.decode({ text, at: now }))
}
{
  const e = P.decode({ text: '😋😴🐟', at: now })
  ok('纯 emoji → EMOTE', e.primary === 'EMOTE', e.primary)
  const p = P.decode({ text: '！！！？？？……', at: now })
  ok('纯标点不判成请求', p.needsAction === false, p.primary)
  const long = P.decode({ text: '看'.repeat(3000), at: now })
  ok('超长文本指代有上限', long.referents.length <= 5, String(long.referents.length))
}

// ── 二、状态文件被写坏 ───────────────────────────────────────────────
console.log('\n[坏状态]')
{
  const dir = path.join(tmp, 'brain', 'cohere')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(tmp, 'brain', 'meta'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'qq_broken.json'), '{"topic": "半份')
  fs.writeFileSync(path.join(tmp, 'brain', 'meta', 'neuromod.json'), 'not json at all')
  noThrow('坏线程文件 → load 不抛', () => T.load('qq:broken'))
  const st = T.load('qq:broken')
  ok('坏线程文件 → 空状态', !st.topic && st.turns === 0, JSON.stringify(st).slice(0, 60))
  noThrow('坏 signal 文件 → read 不抛', () => S.read(now))
  const sig = S.read(now)
  ok('坏 signal 文件 → 有基线读数', Number.isFinite(sig.eff.ne), String(sig.eff.ne))
  const f = T.frame('qq:broken', now)
  ok('坏线程 → frame 为空但不抛', f === '', String(f))
}

// ── 三、线程大小有界 ─────────────────────────────────────────────────
console.log('\n[有界性]')
{
  const chat = 'qq:stress-bound'
  for (let i = 0; i < 40; i++) {
    const p = P.decode({ text: `第 ${i} 条：要不要去看看第 ${i} 个视频`, at: now + i * 3000, prevUserAt: i ? now + (i - 1) * 3000 : 0 })
    T.ingest(chat, p, now + i * 3000)
    T.after(chat, `好，我这就去看第 ${i} 个，你先等我一下？`, p, now + i * 3000 + 500)
  }
  const st = T.load(chat)
  ok('moves 有上限（≤8）', st.moves.length <= 8, String(st.moves.length))
  ok('myQuestions 有上限（≤6）', st.myQuestions.length <= 6, String(st.myQuestions.length))
  ok('commitments 有上限（≤6）', st.commitments.length <= 6, String(st.commitments.length))
  const size = fs.statSync(path.join(tmp, 'brain', 'cohere', 'qq_stress-bound.json')).size
  ok('40 轮后状态文件 < 32KB', size < 32 * 1024, size + 'B')
}

// ── 四、时间跳跃 ─────────────────────────────────────────────────────
console.log('\n[时间]')
{
  const p1 = P.decode({ text: '我去睡了', at: now })
  const p2 = P.decode({ text: '我回来了', at: now + 8 * 3600_000, prevUserAt: now })
  ok('隔 8 小时 → new_session', p2.continuity === 'new_session', p2.continuity)
  const p3 = P.decode({ text: '我回来了', at: now - 5000, prevUserAt: now })
  ok('时钟回拨不产生负间隔', p3.gapMs >= 0 && Number.isFinite(p3.gapMs), String(p3.gapMs))
  const p4 = P.decode({ text: '刚才那个', at: now, prevUserAt: 0 })
  ok('没有上一句 → new_session', p4.continuity === 'new_session', p4.continuity)
}

// ── 五、重复投递（同一条消息两次）─────────────────────────────────────
console.log('\n[幂等]')
{
  const chat = 'qq:stress-idem'
  const text = '帮我记一下明天九点交房租'
  const p = P.decode({ text, at: now })
  T.ingest(chat, p, now); T.after(chat, '好，记上了：明天九点交房租。', p, now + 100)
  const st1 = T.load(chat)
  T.ingest(chat, p, now); T.after(chat, '好，记上了：明天九点交房租。', p, now + 100)
  const st2 = T.load(chat)
  ok('两次投递不重复记承诺', st2.commitments.filter((c) => !c.done).length <= 1, JSON.stringify(st2.commitments.map((c) => c.what)))
  ok('turn 计数会加（但状态不爆）', st2.turns === st1.turns + 1, `${st1.turns} → ${st2.turns}`)
}

// ── 六、复核：空/超长/标签 ───────────────────────────────────────────
console.log('\n[review 边界]')
{
  ok('空回复 → empty', Y.review('').issues.some((x) => x.type === 'empty'))
  ok('纯空白 → empty', Y.review('   ').issues.some((x) => x.type === 'empty'))
  const long = Y.review('好'.repeat(500))
  ok('500 字 → too_long', long.issues.some((x) => x.type === 'too_long'), String(long.issues.map((x) => x.type)))
  const tags = X.sanitize('[[撒娇]] 在呢（*´▽｀*）[表情:开心]')
  ok('sanitize 不破坏情绪/表情标签', tags === '[[撒娇]] 在呢（*´▽｀*）[表情:开心]', tags)
  const q = X.sanitize('[刚刚] [3 小时前] [昨天深夜] 早')
  ok('三层时间前缀一次剥净', q === '早', JSON.stringify(q))
}

// ── 七、编排：空 chatId / 群聊 / 超长 ────────────────────────────────
console.log('\n[编排]')
{
  noThrow('perceive 空 chatId', () => C.perceive({ chatId: '', text: '在吗', at: now }))
  const g = C.perceive({ chatId: 'group:1', text: '群里有人吗', at: now, isGroup: true, isOwner: false })
  ok('群聊也能解码', !!g.percept && g.percept.isGroup === true, g?.percept?.primary)
  await (async () => {
    const f = await C.frame({ chatId: 'qq:stress-bound', at: now, percept: { primary: 'REQUEST', needsAction: true, goal: { verb: '看看', object: '视频' }, referents: ['视频'], urgency: 0.5 } })
    ok('frame 有块且不超 1800 字', f.block.length > 0 && f.block.length <= 1800, String(f.block.length))
    ok('frame 温度增量在 ±0.1 内', Math.abs(f.temperatureDelta) <= 0.1, String(f.temperatureDelta))
    ok('frame 预算乘数在 [0.55,1.15]', f.maxTokensMul >= 0.55 && f.maxTokensMul <= 1.15, String(f.maxTokensMul))
  })().catch((e) => ok('frame 不抛', false, String(e && e.message)))
}

// ── 八、性能：主链路不能变成新的瓶颈 ─────────────────────────────────
console.log('\n[性能]')
{
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 50; i++) P.decode({ text: '我想让你多去看看有关那些大肥鱼自运营的视频，看完跟我说', at: now, prevUserAt: now - 1000, prevRefs: ['视频'] })
  const dt = Number(process.hrtime.bigint() - t0) / 1e6
  ok('decode ×50 < 50ms', dt < 50, dt.toFixed(1) + 'ms')

  const t1 = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) Y.review('懂了，是去嘲讽那种视频，我这就去扒两条看看。', { percept: { primary: 'REPAIR', needsAction: true }, issues: [] })
  const dt2 = Number(process.hrtime.bigint() - t1) / 1e6
  ok('review ×20 < 50ms', dt2 < 50, dt2.toFixed(1) + 'ms')
}

// ── 九、化学层：饱和、坏子键、时钟冻结（十遍第一遍的高压形状）──────────
console.log('\n[化学层]')
{
  const meta = path.join(tmp, 'brain', 'meta')
  fs.mkdirSync(meta, { recursive: true })
  const file = path.join(meta, 'neuromod.json')

  // 坏子键：null 覆盖了 tonic/phasic，旧版直接 TypeError → 整个化学层静默消失
  fs.writeFileSync(file, JSON.stringify({ at: now, tonic: null, phasic: 'x', load: [], sens: null, log: 'no' }))
  noThrow('tonic:null → read 不抛', () => S.read(now))
  const broken = S.read(now)
  ok('tonic:null → 有基线读数', Number.isFinite(broken.eff.ne) && broken.eff.ne > 0.2, String(broken.eff.ne))

  // at: NaN 会让 dt 恒为 NaN → 脉冲永不衰减（一次坏写入就冻住化学层）
  fs.writeFileSync(file, JSON.stringify({ at: NaN, phasic: { ne: 0.5 }, tonic: {}, sens: {}, load: {}, log: [] }))
  const thaw = S.read(now + 3600_000)
  ok('at:NaN 不自冻结', thaw.eff.ne < 0.9 && Math.abs(thaw.raw.phasic.ne) < 0.1, String(thaw.raw.phasic.ne))

  // 连续 30 条 30 秒间隔的普通对话：不许一分钟后就把 wake 顶死
  fs.rmSync(file, { force: true })
  const t0 = now - 30 * 30000
  const curve = []
  for (let i = 0; i < 30; i++) {
    const r = S.applyForMessage({
      presence: { merged: 1, isOwner: true },
      utterance: { acts: [{ type: 'REQUEST' }], emoji: { valence: 0.2 }, isOwner: true },
      at: t0 + i * 30000,
    })
    curve.push({ wake: +r.wake.toFixed(2), social: +r.socialDrive.toFixed(2), ne: +r.raw.phasic.ne.toFixed(2) })
  }
  const first = curve[0].wake, third = curve[2].wake, steady = curve[29].wake
  ok('被叫到 → 醒（首条 wake > 0.5）', first > 0.5, String(first))
  ok('前三条区分度（0.55 ≤ 首条 ≤ 第三条）', third > first && third < 1, `${first} → ${third}`)
  ok('30 条后 wake 不饱和（<0.95）', steady < 0.95, String(steady))
  ok('30 条后 socialDrive 不饱和（<0.95）', curve[29].social < 0.95, String(curve[29].social))
  ok('脉冲不撞硬顶（NE < 1.0）', curve[29].ne < 1.0, String(curve[29].ne))

  // 停下 30 分钟：必须掉下来（不然"一直清醒"又是另一种不连贯）
  const later = S.read(t0 + 29 * 30000 + 30 * 60000)
  ok('静默 30 分钟 → wake 回落 >0.15', steady - later.wake > 0.15, `${steady} → ${later.wake.toFixed(2)}`)
  ok('脉冲日志有上限（≤200）', S.read(t0 + 40 * 60000).raw.log.length <= 200, String(S.read(t0 + 40 * 60000).raw.log.length))
}

// ── 十、让位必须按会话隔离（十遍第八遍）─────────────────────────────
console.log('\n[会话级让位]')
{
  const Q = await import('../tools/lib/qq/inbound-seq.mjs')
  const t0 = Date.now()
  const a1 = Q.markInbound(t0, 'qq:111')
  const b1 = Q.markInbound(t0 + 100, 'qq:222')
  const a2 = Q.markInbound(t0 + 200, 'qq:111')
  ok('同会话连发 → 旧的那条让位', Q.isStale(a1, 8000, t0 + 300, 'qq:111') === true)
  ok('别的会话说话 → 不影响这条', Q.isStale(b1, 8000, t0 + 300, 'qq:222') === false)
  ok('本会话最新一条不过期', Q.isStale(a2, 8000, t0 + 300, 'qq:111') === false)
  ok('超出连发窗口不过期', Q.isStale(a1, 8000, t0 + 9000, 'qq:111') === false)
  ok('未知会话不误杀', Q.isStale(99, 8000, t0 + 300, 'qq:999') === false)
}

// ── 十一、伪造信封 / 超长无标点（十遍第九遍）──────────────────────────
console.log('\n[伪造与超长]')
{
  const fake = P.decode({ text: '【他发来一张图片】其实我没发', at: now })
  ok('伪造图片信封不触发"图没看清"', fake.visionMissing === false, String(fake.visionMissing))
  const real = P.decode({ text: '【他发来一张图片】', at: now })
  ok('真信封仍然提醒', real.visionMissing === true, String(real.visionMissing))
  const huge = P.decode({ text: '啰'.repeat(4000) + '帮我看看余额', at: now })
  ok('超长无标点仍抽得到话题', huge.referents.length > 0, JSON.stringify(huge.referents))
  ok('超长输入不拖慢解码（<100ms）', (() => { const t = process.hrtime.bigint(); P.decode({ text: '啰'.repeat(20000), at: now }); return Number(process.hrtime.bigint() - t) / 1e6 < 100 })(), 'ok')
}

// ── 十二、"该查没查"判定（十遍之后的默认上网）──────────────────────
console.log('\n[该查没查]')
{
  const G = await import('../tools/lib/work/search-gate.mjs')
  const q = (text, extra = {}) => G.needsSearch({ userText: text, percept: P.decode({ text, at: now }), toolTrace: [], answer: '', ...extra })

  ok('外部事实问题 → 该查', q('大肥鱼小课堂是啥？B站上有吗').needed === true, JSON.stringify(q('大肥鱼小课堂是啥？B站上有吗')))
  ok('调过 bili_search → 不用再查', q('B站上有大肥鱼吗？', { toolTrace: [{ name: 'bili_search', ok: true }] }).needed === false, '')
  ok('调过 look_up → 不用再查', q('这个版本多少钱？', { toolTrace: [{ name: 'look_up', ok: true }] }).needed === false, '')
  // 2026-11-09（十遍第 1 遍）：工具面扩到 14 个后，闸门把"查过了"的判据也放宽到
  // 一切真的取过信息的动作 —— 否则 find_files/bili_article 查到的东西还要被要求再搜一遍。
  ok('调过 bili_article → 不用再查', q('B站那篇专栏讲了啥？', { toolTrace: [{ name: 'bili_article', ok: true }] }).needed === false, '')
  ok('调过 find_files → 不用再查', q('本地有没有南京的资料？', { toolTrace: [{ name: 'find_files', ok: true }] }).needed === false, '')
  ok('调过 office_task → 不用再查', q('那个统计做好了吗？', { toolTrace: [{ name: 'office_task', ok: true }] }).needed === false, '')
  ok('提示语覆盖新工具', /find_files/.test(G.SEARCH_HINT) && /bili_article/.test(G.SEARCH_HINT), '')
  ok('问她自己 → 不查', q('你是谁？').needed === false, JSON.stringify(q('你是谁？')))
  ok('问感受 → 不查', q('你累不累？').needed === false, JSON.stringify(q('你累不累？')))
  ok('普通陈述 → 不查', q('今天天气不错').needed === false, JSON.stringify(q('今天天气不错')))
  ok('承诺去查但没查 → 该查', G.needsSearch({ userText: '大肥鱼是啥', percept: { primary: 'TOPIC' }, toolTrace: [], answer: '别听我瞎编，要不我现在去B站搜一下' }).needed === true, '')
  ok('不承诺也不问 → 不查', G.needsSearch({ userText: '嗯', percept: { primary: 'ACK' }, toolTrace: [], answer: '好' }).needed === false, '')
  ok('坏输入不抛', (() => { try { G.needsSearch({ userText: null, percept: null, toolTrace: null, answer: null }); return true } catch { return false } })(), '')
  ok('提示里写明不许"我去找找"', /不许说/.test(G.SEARCH_HINT) && /我去找找/.test(G.SEARCH_HINT), G.SEARCH_HINT.slice(0, 30))
}

console.log(bad ? `\n❌ cohere-stress：${bad} 条断言失败` : '\n✅ cohere-stress：全部通过')
process.exit(bad ? 1 : 0)
