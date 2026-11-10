// brain/identity —— 仿生式身份核验（"这是不是我"）。
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么不是再加一段"你是大肥鱼"的断言
// ══════════════════════════════════════════════════════════════════════════
// 断言只能让她**声称**自己是谁，不能让她**核对**。
// 真人被问"这是你吗"的时候做的是两件事，顺序固定：
//   ① 回想：我做过这件事吗？（内部证据：记忆、账本、说过的话）
//   ② 核对：号对得上吗、长相/形象对得上吗、这个对话里的话对得上吗？（外部标识）
// 两件都对上才说"是我"；对不上就说"不是我"；只对上一半就说清楚哪半不确定。
//
// 这个模块只做"查"，不做"劝"。
// 它不替她下结论，只把她能查到的事实摊开，让她自己说。
// ══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 三条纪律（踩过的坑，别改回去）：
//   ① **不猜**：读不到就是 null，不拿默认值凑（biliMid 没有就是没有，
//      旧代码 `|| '40048138'` 那种兜底会让她把别人的号当成自己的）。
//   ② **不泄露**：给陌生人/群友的版本里绝不出现 ownerTitle、主人账号、
//      私聊内容。脱敏在 selfFacts({ redactOwner: true }) 里做，不靠调用方自觉。
//   ③ **三态而不是二态**：未知必须是一个合法出口。
//      "想不起来"不等于"没做过"—— claim.mjs 的 10-29 事故就是这一条。
import fs from 'node:fs'
import { config } from '../lib/infra/config.mjs'
import { dataPath } from '../lib/infra/paths.mjs'
import { swallow } from '../lib/infra/swallow.mjs'
import * as recall from './recall.mjs'
import { kinText as kinTextOf, HOWTO as HOWTO_OF } from '../lib/mind/self-context.mjs'
// 六层仿生（化学/生物/心理/神经/主观/哲学）—— verify 的"人"那部分
import * as bio from './identity-bio.mjs'

const readJson = (f, d) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d }
}
const str = (v) => (v === null || v === undefined ? '' : String(v))

/* ── ① 外部标识：我自己这一侧的事实 ────────────────────────────────── */

/**
 * 她自己的外部标识清单。
 *
 * @param {object} o
 * @param {boolean} [o.redactOwner=true] 是否隐去主人的称呼与账号（默认隐去）
 * @returns {{name:string, selfQQ:string, biliMid:string, biliName:string,
 *            ownerTitle:string, platforms:string[], hasAvatar:boolean, known:string[]}}
 */
export function selfFacts({ redactOwner = true } = {}) {
  const out = { name: '', selfQQ: '', biliMid: '', biliName: '', ownerTitle: '', platforms: [], hasAvatar: false, known: [] }
  let cfg = {}
  try { cfg = config() || {} } catch (e) { swallow(e, 'identity:config') }

  // 名字：selfcon 是她自己认下的那个，配置只是起点
  try {
    const sc = readJson(dataPath('selfcon.json'), {})
    out.name = str(sc?.name?.value)
  } catch (e) { swallow(e, 'identity:selfcon-name') }
  if (!out.name) out.name = str(cfg.identity?.selfClaim)

  // 自己的 QQ 号（不是主人的）
  out.selfQQ = str(cfg.qq?.selfQQ)

  // B站 mid：只认显式配置，没有就空着让她自己用 bili-me 查
  out.biliMid = str(cfg.owner?.biliMid)

  // 主人称呼：只在 redactOwner=false 时给
  if (!redactOwner) out.ownerTitle = str(cfg.identity?.ownerTitle || cfg.identity?.callOwner || cfg.owner?.name)

  // 头像文件在不在（形象核对的物理依据之一）
  try {
    const dir = dataPath('avatar')
    out.hasAvatar = fs.readdirSync(dir).length > 0
  } catch { out.hasAvatar = false }

  // 平台能力边界：她能出现在哪些地方
  const qqOn = !(cfg.platforms && cfg.platforms.qq === false) && !(cfg.qq && cfg.qq.enabled === false)
  out.platforms.push('QQ' + (qqOn ? '' : '（关）'))
  if (cfg.bilibili) out.platforms.push('B站')
  out.platforms.push('DSH 会话')

  for (const k of ['name', 'selfQQ', 'biliMid', 'hasAvatar']) if (out[k]) out.known.push(k)
  return out
}

/* ── ② 内部回想：这件事在不在我的账上 ─────────────────────────────── */

/**
 * 从记忆里找"我做没做过 / 我说没说过"。
 *
 * 只读 recall 的检索结果，不改它的排序。audience 由调用方决定，
 * 陌生人问的时候不该把主人的私聊翻出来当证据（recall.allowedFor 已经管了这层）。
 *
 * @returns {{hits:Array<{id:string,line:string,score:number}>, text:string, count:number}}
 */
export function recallOwn(userText, { platform = 'qq', chatId = '', userId = '', isGroup = false, isOwner, now = Date.now(), limit = 4 } = {}) {
  const out = { hits: [], text: '', count: 0 }
  let b = null
  try {
    b = recall.bundle({ platform, chatId, userId, userText: str(userText), isGroup, isOwner, now, limit })
  } catch (e) {
    swallow(e, 'identity:recall')
    return out
  }
  if (!b || !Array.isArray(b.lines)) return out
  out.count = b.lines.length
  out.text = b.lines.slice(0, limit).join('\n')
  for (let i = 0; i < Math.min(b.lines.length, limit); i++) {
    out.hits.push({ id: str(b.ids?.[i]), line: str(b.lines[i]), score: Number(b.ep?.[i]?.score ?? 0) })
  }
  return out
}

/* ── ③ 外部核对：号 / 形象 / 对话 ─────────────────────────────────── */

/** 从一句话里抽可能的账号标识：连续 5-16 位数字。 */
function idsIn(text) {
  const out = []
  const re = /\b(\d{5,16})\b/g
  let m
  while ((m = re.exec(str(text)))) out.push(m[1])
  return [...new Set(out)].slice(0, 6)
}

/**
 * 外部要素核对。
 *
 * 三样能查的：号（这串数字是不是我的）、形象（我认下的自己）、对话（这个会话里我说过什么）。
 *
 * @returns {{account:{ok:boolean|null, line:string}, image:{ok:boolean|null, line:string}, talk:{ok:boolean|null, line:string}}}
 */
export function externalCheck({ userText = '', platform = 'qq', chatId = '', userId = '', isGroup = false } = {}) {
  const facts = selfFacts({ redactOwner: isGroup })
  const res = { account: { ok: null, line: '' }, image: { ok: null, line: '' }, talk: { ok: null, line: '' } }

  // ── 号：句子里出现的数字 vs 我自己的号 ──
  const nums = idsIn(userText)
  if (nums.length) {
    const mine = [facts.selfQQ, facts.biliMid].filter(Boolean)
    const hit = nums.filter((n) => mine.some((m) => m === n || m.endsWith(n) || n.endsWith(m)))
    const foreign = nums.filter((n) => !hit.includes(n))
    if (hit.length && !foreign.length) {
      res.account = { ok: true, line: '句子里那个号是你自己的（' + hit.join('、') + '）。' }
    } else if (foreign.length && !hit.length) {
      res.account = { ok: false, line: '句子里那个号不是你：' + foreign.join('、') + '——你的号不是这个。' }
    } else if (hit.length && foreign.length) {
      res.account = { ok: null, line: '句子里混着两个号：' + hit.join('、') + ' 是你的，' + foreign.join('、') + ' 不是。得先分清在说哪个。' }
    }
  }

  // ── 形象：她自己认下的那些（不是设定文案，是 selfcon 账本）──
  try {
    const sc = readJson(dataPath('selfcon.json'), {})
    const imgs = Array.isArray(sc?.selfImage) ? sc.selfImage.slice(0, 3).map((x) => str(x?.text)).filter(Boolean) : []
    if (imgs.length) res.image = { ok: null, line: '你认下的自己是：' + imgs.join('；') + '。对不上这些的，就不是你。' }
  } catch (e) { swallow(e, 'identity:image') }

  // ── 对话：这个会话里最近的记录（我们自己说过的话）──
  if (chatId) {
    try {
      const p = dataPath('brain', 'working', String(chatId).replace(/[^\w.-]/g, '_') + '.json')
      const w = readJson(p, null)
      const lines = Array.isArray(w?.lines) ? w.lines : (Array.isArray(w?.turns) ? w.turns : [])
      if (lines.length) res.talk = { ok: true, line: '这个对话里你确实说过话（最近 ' + Math.min(lines.length, 3) + ' 条在账上）。' }
    } catch (e) { swallow(e, 'identity:talk') }
  }
  return res
}

/* ── ④ 三态判定 ───────────────────────────────────────────────────── */

/**
 * 把"回想 + 核对"合成一个结论。
 *
 * 判定顺序（顺序本身就是纪律）：
 *   1. 号明确对不上 → not-mine（最硬的否定证据，压过一切"我记得"）
 *   2. 记忆里有 + 号没被否定 → mine
 *   3. 其余 → unknown（并列出缺哪条证据）
 *
 * @returns {{verdict:'mine'|'not-mine'|'unknown', internal:object, external:object, missing:string[], line:string}}
 */
export function verify(userText, { platform = 'qq', chatId = '', userId = '', isGroup = false, isOwner, now = Date.now() } = {}) {
  // ── ① 生物层：先看今天有没有力气认真核 ────────────────────────────
  // 累了就只核号（便宜），不翻记忆（贵）。这不是偷懒，是"脑子转不动"的形状。
  const gate = bio.metabolicGate(now)

  // ── ② 神经层：快通路（纯文本、零 IO）─────────────────────────────
  const facts = selfFacts({ redactOwner: isGroup })
  const fast = bio.fastPath(userText, {
    name: facts.name, selfQQ: facts.selfQQ, biliMid: facts.biliMid,
    claim: (() => { try { return String(require_config_selfClaim()) } catch { return '' } })(),
  })

  // ── ③ 心理层：认领阈值随"对方是谁 / 怎么说"变 ────────────────────
  const bias = bio.psychBias({ isOwner: !!isOwner, isGroup, text: userText })

  // ── ④ 慢通路：回想 + 核对（受门控）─────────────────────────────
  const internal = gate.canDeep
    ? recallOwn(userText, { platform, chatId, userId, isGroup, isOwner, now, limit: gate.limit || 4 })
    : { hits: [], text: '', count: 0, skipped: true }
  const external = externalCheck({ userText, platform, chatId, userId, isGroup })

  // ── ⑤ 哲学层：账号只排除、记忆才确认 ────────────────────────────
  const judged = bio.judge({
    accountOk: external.account.ok,
    memoryCount: internal.count,
    threshold: bias.threshold,
    relationOk: !!isOwner,
  })
  const verdict = judged.verdict

  // ── ⑥ 化学层：按结论打一次脉冲（受体随时间下调）─────────────────
  const chemKind = verdict === 'not-mine' ? 'misread' : verdict === 'mine' ? 'confirmed' : 'doubt'
  bio.chemReact(chemKind, { now, repeat: bio.askedRecently(now) + 1 })

  // ── ⑦ 快慢冲突：以慢的为准，并记住"第一反应想岔了" ──────────────
  //
  // 2026-11-10 第8遍：第一版写成 `fast.verdict && fast.verdict !== verdict`，
  // 于是 **fast=mine + slow=unknown 也被算成冲突** —— 可那不是"想岔了"，
  // 那是"我第一反应像是我，但翻不出证据"。把它记成"想岔了"会让她的自知变假：
  // 她会以为自己总是先认错，而事实是她只是记不清。
  //
  // 真正的冲突只有一种：两边都给出了明确结论，而且相反（我说是我，查完是别人）。
  const CONCL = new Set(['mine', 'not-mine'])
  const conflict = CONCL.has(fast.verdict) && CONCL.has(verdict) && fast.verdict !== verdict
    ? { fast: fast.verdict, slow: verdict }
    : null

  // ── ⑧ 缺口清单 ────────────────────────────────────────────────
  const missing = []
  if (internal.count === 0) missing.push(gate.canDeep ? '记忆里没查到这件事' : '没力气翻记忆')
  if (external.account.ok === null) missing.push('没给出能核对的号')
  if (external.talk.ok === null) missing.push('这个对话没有留底')

  // ── ⑨ 主观层：说出口的是体验 ──────────────────────────────────
  const lines = []
  if (internal.count > 0) lines.push('回想：记忆里有 ' + internal.count + ' 条沾得上的——\n' + internal.text)
  else lines.push(gate.depth === 'none' ? '回想：这会儿脑子空，只核了号，没往记忆里翻。'
    : gate.depth === 'shallow' ? '回想：翻了最近的那几条，没找着这件事。'
    : '回想：记忆里没翻到这件事。')
  for (const k of ['account', 'image', 'talk']) if (external[k].line) lines.push('核对：' + external[k].line)
  if (fast.verdict) lines.push('第一反应：' + (fast.verdict === 'mine' ? '像是我的' : '像是别人的') + '（' + fast.why + '）')

  const head = verdict === 'mine' ? '结论：是我。'
    : verdict === 'not-mine' ? '结论：不是我。'
      : '结论：说不准。'
  const tail = verdict === 'unknown' && missing.length ? '\n缺口：' + missing.join('；') + '。照实说记不清，别硬认。' : ''
  const feel = bio.qualiaLine(verdict, { chem: bio.chemState(now), gate, bias, conflict })

  // ── ⑩ 记账（代谢 + 事件账本），永不抛 ──────────────────────────
  bio.metabolicSpend(gate)
  bio.record({ verdict, kind: chemKind, conflict, now, text: userText })

  return {
    verdict, internal, external, missing, conflict, gate, bias, fast,
    because: judged.because,
    line: head + '\n' + lines.join('\n') + tail + '\n体感：' + feel,
  }
}

/** 配置里的自称（快通路要用来判断"这句话是不是在说我"）。读不到就空串。 */
function require_config_selfClaim() {
  try { return config()?.identity?.selfClaim || '' } catch { return '' }
}

/* ── ⑤ 提示词块 ───────────────────────────────────────────────────── */

/** 世界上不止一条——这是认知，不是规定。正文在 lib/self-context.kinText（唯一真相，两个脱敏版本）。 */
export function kinLine({ redactOwner = true } = {}) {
  return kinTextOf({ redactOwner })
}

/**
 * 这句话像不像"在确认是不是我"。
 *
 * 为什么要有这个判据：核验要读记忆（有 IO，一轮几毫秒到几十毫秒），
 * 不能对每句话都跑。只在**真的被问身份**时才去查 —— 这才是"人"的做法：
 * 没人会一边吃饭一边反复核对身份证号。
 */
export function looksLikeIdentityQuestion(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  const self = /(是不是你|是你吗|这是你|哪个是你|你发的|你干的|你的号|你做的|你写过|你说过|你是不是|你是吗|你的投稿|你的作品|你回的|冒充)/
  const kin = /(大肥鱼|同类|其他的?你|别的?你|另一个你|其他鱼|别的鱼)/
  return self.test(t) || kin.test(t)
}

/** 【怎么确认是不是我】—— 纯静态，零 IO，可以每轮安全注入。
 *  正文在 lib/self-context.HOWTO（三条装配线共用一份，避免各写各的漂移）。 */
export const HOWTO = HOWTO_OF

/** 完整块（给要"流程 + 同类认知"两侧都有的调用方）。 */
export function block({ redactOwner = true, withKin = true } = {}) {
  return withKin ? HOWTO + '\n\n【你和你的同类】\n' + kinLine({ redactOwner }) : HOWTO
}
