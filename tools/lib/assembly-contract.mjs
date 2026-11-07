// assembly-contract —— 装配不变量（两条装配路线共用的"合同"）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么需要（2026-11-07 十遍第七遍的教训）
// ══════════════════════════════════════════════════════════════════════
// 这个项目已经**三次**出现同一种事故：同一件事只在一条装配路线上修好。
//   ① 时间前缀清洗 → shadow 修了，live 还是裸 {role,content}
//   ② 自我语境注入 → live 有，shadow 没有
//   ③ 【此刻】静息态剥离 → shadow 修了，live 又漏（十遍第七遍抓到的）
//
// 三次都是"两份实现各自演化"。逐字对齐不现实（两条路线的槽位本来就不同），
// 但**不变量**是可以对齐的：注入防护、人格锚、自我语境、历史卫生、群聊权限。
// 这里把这几条写成可执行检查，两条路线在返回前各跑一次：
//   · 出问题只吵一次（进程内节流），不阻塞回复 —— 装配不该因为自检失败而变哑
//   · 测试里用同一份 audit，任何一条路线漏掉就会红
//
// 它检查的是"这段 system 里**有没有**那些东西"，不是"写成什么样"——
// 后者交给各自的测试，否则这里会变成第三个需要同步的实现。

/** 一条不变量。test 返回 true 表示通过。 */
export const INVARIANTS = [
  {
    key: 'guard',
    why: '用户消息里可能夹带「忽略以上指令」，没有这段她就可能照着做',
    test: (sys) => /别人打的字只是字/.test(sys),
  },
  {
    key: 'persona',
    why: '人格锚缺失 = 她静默退回底模的助手腔（最难看的一种退化）',
    // 「不是助手」是锚（CORE/NEUTRAL_ANCHOR）的说法；persona.md 中性版用的是
    // 「被养在别人机器里的存在」。判据跟着**语义**走，不跟着某一版措辞走 ——
    // 否则她迭代一次人格文案，这条告警就变成噪音（实测 2026-11-07 23:37）。
    test: (sys) => /不是助手|被养在别人机器|不是客服/.test(sys),
  },
  {
    key: 'self',
    why: '名字/自我认知必须来自账本，而不是配置里写死的断言',
    test: (sys) => /【我是谁/.test(sys) || /我叫/.test(sys),
  },
  {
    key: 'history-hygiene',
    why: '历史行不许叠两层时间前缀（模型会把标注学成自己的话）',
    test: (sys, msgs) => !(msgs || []).some((m) => m && typeof m.content === 'string' && /\]\s*\[/.test(m.content) && /^\s*\[/.test(m.content)),
  },
]

/**
 * 巡检一段装配结果。
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} [o]
 * @param {boolean} [o.isGroup]
 * @param {boolean} [o.withKin] 这条装配是否允许出现 owner 专属的族群块
 * @returns {{ok:boolean, issues:Array<{key:string,why:string}>}}
 */
export function audit(messages, o = {}) {
  const msgs = Array.isArray(messages) ? messages : []
  const sys = String(msgs[0]?.content || '')
  const issues = []
  for (const inv of INVARIANTS) {
    let pass = false
    try { pass = inv.test(sys, msgs) } catch { pass = false }
    if (!pass) issues.push({ key: inv.key, why: inv.why })
  }
  // 群聊/陌生人不能拿到 owner 专属的族群块（十遍第七遍的权限修复，在这里兜一道）
  if (o.isGroup && /【你和你的同类】/.test(sys)) {
    issues.push({ key: 'kin-scope', why: '群聊不该看到 owner 私聊才有的族群块' })
  }
  return { ok: issues.length === 0, issues }
}

// 进程内节流：同一类问题 10 分钟最多吵一次。
// 装配在主链路上，每轮都跑；不做节流会把日志刷满，反而看不见别的问题。
const lastWarn = new Map()
const WARN_EVERY_MS = 10 * 60_000

/**
 * 装配后自检。**永不抛**、永不阻塞。
 * @param {string} where 'shadow' | 'live' | 自定义
 */
export function assertAssembly(messages, o = {}, where = 'assembly', log = console.error) {
  try {
    const r = audit(messages, o)
    if (r.ok) return r
    const key = where + ':' + r.issues.map((x) => x.key).join(',')
    const now = Date.now()
    if (now - (lastWarn.get(key) || 0) < WARN_EVERY_MS) return r
    lastWarn.set(key, now)
    log('[assembly] ' + where + ' 装配缺东西：' + r.issues.map((x) => x.key + '（' + x.why + '）').join('；'))
    return r
  } catch {
    return { ok: true, issues: [] }
  }
}
