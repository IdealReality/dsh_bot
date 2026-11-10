// 带工具的多轮对话循环（10-31）—— 她"真的能动手"的那一层。
//
// 为什么需要单独一层：llm.chat() 是单次请求；工具调用需要
//   模型 → 要调工具 → 我执行 → 结果回灌 → 模型再说
// 这个循环最多几轮（防死循环），每轮都落记忆。
import { CHAT_TOOLS, runTool } from './tools.mjs'
import * as llm from './llm.mjs'
import { swallow } from '../infra/swallow.mjs'

const MAX_ROUNDS = 4          // 最多 4 轮工具调用（再多就是模型在绕圈）
// ══════════════════════════════════════════════════════════════════════
// 2026-11-07：原来的单轮超时是 130 秒 —— 实测一次聊天里两个工具失败，
// 整条回复拖到 38 秒才发出去（用户感受就是"转得特别慢"）。
// 聊天是有在场感的：超过 20 秒，再正确的话也变成"她刚才走神了"。
// 所以加三层预算，从外到内收：
//   · 整条工具链 30 秒（含最多 4 轮）
//   · 单轮（模型+工具）20 秒
//   · 单个工具 12 秒（网络搜索正常要 3~9 秒）
// 超预算就带着已有结果收尾，绝不无限等 —— 工具是手，不是脑子。
const TOTAL_BUDGET_MS = 30_000
const ROUND_TIMEOUT_MS = 20_000
const ONE_TOOL_MS = 12_000   // 网络类工具（search/fetch）留够：8 秒会把正常请求也切掉

/**
 * 带工具的 chat。
 * @param {Array} messages 初始 messages（含 system，会被 fold 进 user）
 * @param {object} opts { purpose, temperature, maxTokens, onToolResult }
 * @returns {Promise<{text:string, tools:Array<{name,args,ok,result}>}>}
 */
export async function chatWithTools(messages, opts = {}) {
  const used = []
  let msgs = [...messages]
  const deadline = Date.now() + TOTAL_BUDGET_MS
  // 是否启用工具：默认开，可用 opts.tools === false 关掉
  const enableTools = opts.tools !== false
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() > deadline) {
      swallow(new Error('工具链总预算用完（' + TOTAL_BUDGET_MS + 'ms），带着已有结果收尾'), 'agent:budget')
      break
    }
    // 每轮的 LLM 超时不能总给 20 秒：第一轮用掉 20s 后，第二轮还会再拿 20s，
    // 四条命令加起来最坏 80s —— 与"整条 30s"的承诺不符（实测用户感受就是转很久）。
    // 这里让它只领**剩余预算**，最低 2s（低于这个值干脆别发请求）。
    const remaining = deadline - Date.now()
    if (remaining < 2000) {
      swallow(new Error('工具链剩余预算不足（' + remaining + 'ms），收尾'), 'agent:budget')
      break
    }
    const body = {
      purpose: opts.purpose || 'chat',
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      tools: enableTools ? CHAT_TOOLS : undefined,
      toolChoice: enableTools ? 'auto' : undefined,
      timeoutMs: Math.min(ROUND_TIMEOUT_MS, remaining),
    }
    let r
    try {
      r = await llm.chatRaw(msgs, body)
    } catch (e) {
      // 没有 chatRaw 就退回普通 chat（不支持工具，但不至于整轮失败）
      swallow(e, 'agent:chatRaw')
      const text = await llm.chat(msgs, body)
      return { text, tools: used }
    }
    const msg = r?.message || {}
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const content = String(msg.content ?? '').trim()

    // 没有工具调用 → 结束
    if (!calls.length) {
      return { text: content || String(r?.text || ''), tools: used }
    }

    // 有工具调用：把 assistant 消息（含 tool_calls）加进历史，再逐个执行
    msgs = [...msgs, { role: 'assistant', content: content || '', tool_calls: calls }]
    for (const c of calls) {
      const name = String(c?.function?.name || '')
      let args = {}
      try { args = JSON.parse(String(c?.function?.arguments || '{}')) } catch (e) { swallow(e, 'agent:parse-args') }
      // 单个工具 12 秒（网络类工具正常要 3~9s）：一个工具卡住不许拖垮整条回复
      let res
      try {
        res = await Promise.race([
          runTool(name, args),
          new Promise((r) => setTimeout(() => r({ ok: false, result: '工具超时（' + ONE_TOOL_MS + 'ms）' }), ONE_TOOL_MS)),
        ])
      } catch (e) {
        res = { ok: false, result: '工具异常：' + String(e?.message || e).slice(0, 80) }
      }
      if (!res || typeof res !== 'object') res = { ok: false, result: '工具无返回' }
      used.push({ name, args, ok: res.ok, result: String(res.result || '').slice(0, 400) })
      msgs.push({
        role: 'tool',
        tool_call_id: String(c.id || ''),
        content: String(res.result || (res.ok ? '完成' : '失败')).slice(0, 3000),
      })
      try { opts.onToolResult?.(name, args, res) } catch (e) { swallow(e, 'agent:onToolResult') }
    }
    // 继续下一轮，让模型根据工具结果说话
  }
  // 轮数用完：强制要一句收尾（不再给工具）
  try {
    const text = await llm.chat(msgs, { purpose: opts.purpose || 'chat', max_tokens: 400, tools: false, timeoutMs: 10_000 })
    return { text, tools: used }
  } catch (e) {
    swallow(e, 'agent:final')
    return { text: used.length ? '（做完了，但没来得及说）' : '（这次没接上）', tools: used }
  }
}
