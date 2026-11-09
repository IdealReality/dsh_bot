/**
 * dsh-takeover —— 极小人格接管插件（2026-11-09）
 *
 * 为什么单独一个包：
 *   dsh_bot 的壳 inject: ['sessionController','webServer','connection']，
 *   在 headless/tui 这类没有 webServer 的 profile 里整个壳停在 pending，
 *   连带 agent-prompt.mjs 的 registerTakeover 从不执行 —— 于是会话拿到的
 *   还是宿主原生 system prompt（含 "DeepSeek Harness"），上游 workbuddy 会以
 *   code=11-128 拒绝。
 *
 * 这个包只做一件事：只 inject systemPrompt，调 dsh_bot 里同一份
 * registerTakeover，于是 headless 会话也被她的 complete 段接管。
 * 不碰 scheduler、状态 API、QQ/微信进程 —— 那些仍归 dsh_bot 壳管。
 *
 * 文案与逻辑全部复用 dsh_bot/lib/agent-prompt.mjs，不复制第二份。
 */
import { registerTakeover } from '../lib/agent-prompt.mjs'

export default {
  name: 'dsh-takeover',
  inject: ['systemPrompt'],
  apply(ctx) {
    const out = registerTakeover(ctx, (e, tag) => {
      console.error('[takeover] ' + tag + ': ' + String(e?.message ?? e))
    })
    console.log('[takeover] enabled=' + out.enabled
      + ' registered=' + out.registered
      + ' reason=' + out.verifyReason)
  },
}
