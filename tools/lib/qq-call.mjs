// qq-call —— 调 SnowLuma 的 OneBot API（带一次重试）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么单独一个文件（2026-11-07 全链检查）
// ══════════════════════════════════════════════════════════════════════
// 原来的 callApi 在网络抖动/网关重启时**直接返回 null**：
// 消息就此消失，而她那边还照常把"我说过这句话"写进记忆 ——
// 记忆与事实分叉，下一次她引用一句用户从没见过的回复。
//
// 现在两层处理：
//   ① 网络异常 / 5xx：隔 400ms 重试一次（网关重启通常几秒内恢复，一次重试覆盖大部分抖动）；
//   ② 业务失败（4xx / retcode≠0）：**不重试**（对方明确拒绝，重试只会刷屏），交调用方决定。
//
// 只对"可安全重放"的动作自动重试：send_* 在 QQ 侧不是严格幂等，但一次重试的窗口里
// 重复发送的概率远低于"整个回复丢失"的概率；而且 server 侧有会话内 5 秒去重兜底。
import { swallow } from './swallow.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} o
 * @param {string} o.base    OneBot HTTP 基址（SnowLuma）
 * @param {string} [o.token] accessToken
 * @param {Function} [o.logErr]
 * @param {number} [o.retryMs]
 */
export function makeCallApi({ base, token = '', logErr = () => {}, retryMs = 400 } = {}) {
  const root = String(base || '').replace(/\/+$/, '')
  return async function callApi(action, payload = {}, timeout = 20000, attempt = 0) {
    try {
      const r = await fetch(`${root}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      })
      if (!r.ok) {
        if (r.status >= 500 && attempt < 1) {
          await sleep(retryMs)
          return callApi(action, payload, timeout, attempt + 1)
        }
        logErr(`[qq] ${action} 失败: HTTP ${r.status}`)
        return null
      }
      return await r.json().catch(() => null)
    } catch (e) {
      if (attempt < 1) {
        await sleep(retryMs)
        return callApi(action, payload, timeout, attempt + 1)
      }
      logErr(`[qq] ${action} 异常: ${e?.message || e}`)
      swallow(e, 'qq-call:' + action)
      return null
    }
  }
}
