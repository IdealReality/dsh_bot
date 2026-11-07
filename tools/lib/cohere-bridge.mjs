// tools/lib/cohere-bridge —— 编排层的薄接线
//
// ══════════════════════════════════════════════════════════════════════
// 为什么单独一个文件
// ══════════════════════════════════════════════════════════════════════
// qq-server 已经从 1807 行削到 1793 行（门禁 1750 附近）。连贯性器官
// 要在四条路径上接线（感知/装配/复核/回写），直接铺开写会把它顶破门禁，
// 而且把"她怎么想"和"怎么发"重新焊在一起 —— 那是 think.mjs 拆分时
// 已经踩过一次的形状。
//
// 这里只做三件事：参数整理、错误隔离、给编排层一个稳定的返回形状。
// 业务判断全在 brain/cohere/* 里。
import { swallow } from './swallow.mjs'
import { appendText } from './msg-content.mjs'
import * as cohere from '../brain/cohere/index.mjs'

// 块可以到 1800 字（thread + 体感 + 态度 + 语料 + 社交契约 + 表达结构），
// 旧值 900 会在**段落中间**截掉最后两条 —— 社交契约和表达结构恰好是最后加的。
// 宁可多给几百字，也不能把"不许反问""先接住"这类硬约束截掉。
const MAX_BLOCK = 1500

/** 按段落边界截断（不切句、不切段）。 */
function cutBlocks(s = '', max = MAX_BLOCK) {
  const text = String(s || '')
  if (text.length <= max) return text
  const out = []
  let n = 0
  for (const part of text.split(/\n\n+/)) {
    if (n + part.length + 2 > max) break
    out.push(part)
    n += part.length + 2
  }
  return out.length ? out.join('\n\n') : text.slice(0, max)
}

/**
 * ① 消息进来。同步（只是文件读写 + 规则）。
 * 失败时返回 null —— 调用方按"没有这一层"继续跑，回复不会因此消失。
 */
export function perceive(o = {}) {
  try {
    const r = cohere.perceive(o)
    const cont = r.percept?.continuity
    // 只有真正重开才让 persona 注入"上次断在哪"：同一拍/连续对话里，
    // 历史本来就在 recent，再注一遍会把模型带回上一轮的话题。
    const cueAllowed = !(cont === 'same_beat' || cont === 'continuing')
    return { ...r, cueAllowed }
  } catch (e) {
    swallow(e, 'cohere-bridge:perceive')
    return null
  }
}

/**
 * ② 生成之前：给出要追加到 system 的一段 + 采样参数微调。
 * @returns {{block:string, dT:number, mul:number, line:string, intero:object, defense:object}|null}
 */
export async function frame(coh, o = {}) {
  if (!coh) return null
  try {
    const f = await cohere.frame({
      chatId: o.chatId, userId: o.userId, at: o.at,
      percept: coh.percept, signal: coh.signal, platform: o.platform, isGroup: o.isGroup,
    })
    return {
      block: cutBlocks(f.block || ''),
      dT: Number(f.temperatureDelta || 0),
      mul: Number(f.maxTokensMul || 1),
      line: String(f.line || ''),
      intero: f.intero,
      defense: f.defense,
      cueAllowed: coh.cueAllowed,
    }
  } catch (e) {
    swallow(e, 'cohere-bridge:frame')
    return null
  }
}

/**
 * ③ 出稿复核：清洗 + 问题清单 + 重写提示。
 * 纯读，不写盘；同一轮里可以调两次（初稿/重写稿）。
 */
export function gate(text, o = {}) {
  try {
    return cohere.review(text, {
      chatId: o.chatId, userId: o.userId, isGroup: o.isGroup,
      percept: o.percept, intero: o.intero, ownerQQ: o.ownerQQ, at: o.at,
    })
  } catch (e) {
    swallow(e, 'cohere-bridge:gate')
    return { text: String(text || ''), changed: false, ok: true, issues: [], hard: [], score: 1, hint: '', continuity: 0.5 }
  }
}

/** ③b 构造重写消息：把 hint 贴到最后一条 user 上（与群聊/天数重写同一套形状）。 */
export function rewriteMessages(messages, hint) {
  if (!Array.isArray(messages) || !messages.length || !hint) return messages
  const out = messages.slice()
  // 最后一条可能带着图片/视频帧（content 是数组）：用 appendText 补话，
  // 直接拼字符串会把图段拍成 "[object Object]"，她这轮就看不见画面了。
  out[out.length - 1] = appendText({ ...out[out.length - 1], role: 'user' }, hint)
  return out
}

/** ④ 真发出去之后：回写线程 + 奖赏脉冲。 */
export function sent(chatId, reply, percept, o = {}) {
  try { return cohere.after(chatId, reply, percept, o) } catch (e) { swallow(e, 'cohere-bridge:sent'); return [] }
}

/** 面板/诊断。 */
export function status(chatId) {
  try { return cohere.status(chatId) } catch (e) { swallow(e, 'cohere-bridge:status'); return null }
}

/** 诊断：解释一句话被怎么理解（不落盘）。 */
export function explain(text, extra = {}) {
  try { return cohere.explain(text, extra) } catch (e) { swallow(e, 'cohere-bridge:explain'); return null }
}

/**
 * ②b 把 frame 的结果直接落到 messages 上（qq-server 只留一行调用）。
 * @returns {{dT:number, mul:number, line:string}}
 */
export async function applyFrame(coh, o = {}) {
  const f = await frame(coh, o)
  if (!f) return { dT: 0, mul: 1, line: '' }
  try {
    if (f.block && Array.isArray(o.messages) && o.messages[0]) o.messages[0].content += '\n\n' + f.block
  } catch (e) { swallow(e, 'cohere-bridge:applyFrame') }
  return { dT: f.dT, mul: f.mul, line: f.line, intero: f.intero, defense: f.defense }
}

/**
 * ③c 复核 + 一次重写。这是编排层唯一需要知道的"补救动作"。
 *
 * @param {object} o
 * @param {string} o.text      初稿
 * @param {Array}  o.messages  原始消息（重写时复用）
 * @param {Function} o.chat     llm.chat
 * @param {Function} o.clean    guard.clean
 * @param {number} o.temperature
 * @returns {{text:string, ok:boolean, issues:object[], hard:object[]}}
 */
export async function gateAndRewrite(o = {}) {
  // ②a "该查没查"（2026-11-07）：检索类工具一次没调、又是外部事实问题（或她承诺去查）
  // → 带工具重写一次。提示词管概率，闸门管结果；只重写一次，不循环。
  // 实测病象：「大肥鱼小课堂是啥？B站上有吗」→「要不我现在去B站搜一下」然后等下一轮。
  try {
    const { needsSearch, SEARCH_HINT } = await import('./search-gate.mjs')
    const need = needsSearch({ userText: o.userText, percept: o.percept, toolTrace: o.toolTrace, answer: o.text })
    if (need.needed && typeof o.chatWithTools === 'function' && Array.isArray(o.messages) && o.messages.length) {
      const msgs = o.messages.slice()
      const last = msgs[msgs.length - 1]
      msgs[msgs.length - 1] = appendText({ ...last, role: 'user' }, SEARCH_HINT)
      const r = await o.chatWithTools(msgs, {
        temperature: Math.min(1.05, Number(o.temperature || 0.9) + 0.03), purpose: 'chat', max_tokens: 800,
      })
      const t2 = String(r?.text || '')
      const tools = Array.isArray(r?.tools) ? r.tools : []
      const used = tools.some((t) => t.ok)
      // 日志要能区分三种结果（2026-11-08 修）：调了工具成功 / 调了但全失败 / **一个都没调**。
      // 旧写法在"没调工具"时打出「重写：」后面空白，看起来像成功，实际只是把
      // 「我去查查」换成另一句空话，还覆盖了原答案。
      o.log?.('[qq] 🌐 该查没查（' + need.why + '）→ 重写：'
        + (tools.length ? tools.map((t) => t.name + (t.ok ? '✓' : '✗')).join(' ') : '没调工具'))
      if (t2 && used) {
        o.text = o.clean ? o.clean(t2) : t2
      } else if (t2 && !used) {
        // 一次成功调用都没有：不拿它覆盖原答案（那只是把一句空话换成另一句）。
        swallow(new Error('search-gate: rewrite had no successful tool call'), 'cohere-bridge:searchgate')
      }
    }
  } catch (e) { swallow(e, 'cohere-bridge:searchgate') }

  const ctx = {
    chatId: o.chatId, userId: o.userId, isGroup: o.isGroup,
    percept: o.percept, intero: o.intero, ownerQQ: o.ownerQQ, at: o.at,
  }
  let rv = gate(o.text, ctx)
  let text = rv.text || o.text
  if (rv.changed) o.log?.('[qq] 🧹 清掉标注：' + JSON.stringify(String(o.text || '').slice(0, 18)) + ' → ' + JSON.stringify(String(text).slice(0, 18)))
  if (rv.ok) {
    if (rv.issues?.length) o.log?.('[qq] 🔎 连贯性软提示：' + rv.issues.map((x) => x.type).join(','))
    return { text, ok: true, issues: rv.issues || [], hard: [] }
  }
  o.log?.('[qq] 🔁 连贯性复核：' + rv.hard.map((x) => x.type).join(',') + ' → 重写一次')
  try {
    const a2 = await o.chat?.(rewriteMessages(o.messages, rv.hint), {
      temperature: Math.min(1.05, Number(o.temperature || 0.9) + 0.04), purpose: 'chat',
    })
    const o2 = o.clean ? o.clean(a2) : String(a2 || '')
    if (!o2) return { text, ok: false, issues: rv.issues || [], hard: rv.hard || [] }
    const r2 = gate(o2, ctx)
    o.log?.('[qq] 🔁 重写后：' + (r2.ok ? '通过' : '仍有 ' + r2.hard.map((x) => x.type).join(',')))
    if (r2.ok) return { text: r2.text || o2, ok: true, issues: r2.issues || [], hard: [] }
    // 重写一次仍不通过 → **机械兜底**：删掉违规句，绝不让"你到底想让我干嘛"
    // 这类句子发出去。宁可短、宁可平淡，也不要一句把人推回去的话。
    // 这是本层的最后一道闸，也是"根治"与"提示词祈求"的分界：
    // 提示词只能提高概率，闸门才能保证结果。
    const fixed = cohere.psyche.scrub(r2.text || o2, r2.hard, o.percept)
    o.log?.('[qq] 🧯 兜底清理：' + JSON.stringify(String(r2.text || o2).slice(0, 24)) + ' → ' + JSON.stringify(String(fixed).slice(0, 24)))
    return { text: fixed, ok: false, issues: r2.issues || [], hard: r2.hard || [] }
  } catch (e) {
    o.logErr?.('[qq] 重写失败，保留原稿：' + String(e?.message || e).slice(0, 80))
    return { text, ok: false, issues: rv.issues || [], hard: rv.hard || [] }
  }
}

/** ①b 接收 + 一行日志（编排层只关心"有没有"和日志）。 */
export function perceiveLogged(o = {}, log = null) {
  const coh = perceive(o)
  try {
    const p = coh?.percept
    const lr = coh?.learned?.scored
    if (lr && log) log('[qq] 🎓 上次「' + lr.name + '」reward ' + lr.reward + ' rpe ' + lr.rpe)
    if (p && log) {
      const G = p.goal
      log('[qq] 🧭 ' + p.primary + (G ? '→' + G.verb + (G.object ? ' ' + G.object.slice(0, 12) : '') : '')
        + ' · ' + p.continuity + (coh.cueAllowed ? ' · 可接上次话头' : ''))
    }
  } catch (e) { swallow(e, 'cohere-bridge:perceiveLogged') }
  return coh
}
