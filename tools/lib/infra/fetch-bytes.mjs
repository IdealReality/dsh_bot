// fetch-bytes —— 取原始字节（原生 http/https，一次请求一条独立 socket）。
//
// 为什么不用 fetch：undici 的连接池会复用**已被对端关掉**的闲置 socket，
// 连续取第二个 URL 必抛 "fetch failed"（2026-11-07 实测：同一条链上取两个
// 视频地址就复现）。视频/音轨只下一次，不值得为此调池子。
import http from 'node:http'
import https from 'node:https'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'

/**
 * @param {string} url
 * @param {{timeoutMs?:number, maxBytes?:number, redirects?:number, headers?:object, signal?:AbortSignal}} [opts]
 *   signal：用户插话时立刻掐掉下载（2026-11-08）。55MB 的视频在回环上也要几秒，
 *   "他问了句话，却要等下载完才能回"和"实时"是矛盾的。
 * @returns {Promise<Buffer>}
 */
export function httpGet(url, { timeoutMs = 30_000, maxBytes = 300 * 1024 * 1024, redirects = 0, headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const abortErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e }
    if (signal && signal.aborted) return reject(abortErr())
    let u
    try { u = new URL(url) } catch { return reject(new Error('bad url')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('unsupported scheme ' + u.protocol))
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get(u, { agent: false, headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, timeout: timeoutMs }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location && redirects < 5) {
        res.resume()
        return resolve(httpGet(new URL(res.headers.location, u).href, { timeoutMs, maxBytes, redirects: redirects + 1, headers, signal }))
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)) }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBytes) { req.destroy(new Error('too large')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    const onAbort = () => { try { req.destroy(abortErr()) } catch { /* 已关闭 */ } }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => { try { signal?.removeEventListener('abort', onAbort) } catch { /* ignore */ } })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}
