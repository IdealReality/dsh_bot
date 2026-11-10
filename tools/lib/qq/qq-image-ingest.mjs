// qq-image-ingest —— QQ 图片入站：下载 + 判定"表情包还是正经图"
//
// ══════════════════════════════════════════════════════════════════════
// 从 qq-server.mjs 拆出（2026-11-07）
// ══════════════════════════════════════════════════════════════════════
// 原因有两条，第二条更重要：
//   ① qq-server 已经 1858 行，超过门禁额度（1750）。这一段是**纯 IO + 判定**，
//      没有闭包耦合，是唯一可以零风险搬走的一块。
//   ② 它本来就是一条独立的感受通路：图片进来 → 下载 → 判断性质 → 给一个标记。
//      留在 handle() 里，等于把"看见"和"怎么回"焊死（think.mjs 拆分时同样的教训）。
//
// 判定规则本身仍归 lib/image-kind.mjs —— 这里只负责**拿到图**并调用它。
// 失败绝不抛：她可以看不到图，但不能因此不回消息。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataPath } from '../infra/paths.mjs'
import { swallow } from '../infra/swallow.mjs'

const execFileAsync = promisify(execFile)

/**
 * @param {object} o
 * @param {string[]} o.images          OneBot 给的图片 URL 列表
 * @param {object} o.evt               原始事件（取 message 段判断图片类型）
 * @param {string} o.text              这条消息的正文（判定"没配文小图"的性质）
 * @param {string} o.chatId
 * @param {object} [o.memory]          memory 模块（取上一轮语气）
 * @param {Function} [o.log]
 * @returns {Promise<{imageDesc:string, imageIsSticker:boolean, imageUris:string[]}>}
 */
export async function ingestImages(o = {}) {
  const images = Array.isArray(o.images) ? o.images.filter(Boolean) : []
  const out = { imageDesc: '', imageIsSticker: false, imageUris: [] }
  if (!images.length) return out

  const log = typeof o.log === 'function' ? o.log : () => {}
  try {
    fs.mkdirSync(dataPath('qq-img'), { recursive: true })
    const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
    for (const u of images.slice(0, 3)) {
      const dl = path.join(dataPath('qq-img'), `img-${Date.now()}-${Math.floor(Math.random() * 1e4)}.jpg`)
      try {
        await execFileAsync(exe, ['-sS', '-L', '-m', '30', '-A', 'Mozilla/5.0', '-o', dl, u], { timeout: 35000, windowsHide: true })
      } catch (e) { swallow(e, 'qq-img:download') }
      if (fs.existsSync(dl) && fs.statSync(dl).size > 2000) out.imageUris.push(dl)
    }

    // 表情包是**语气**，不是内容；当成图片去描述，回复就变成说明文了。
    try {
      const { classifyImage } = await import('../media/image-kind.mjs')
      const seg0 = (Array.isArray(o.evt?.message) ? o.evt.message : []).find((x) => x?.type === 'image')
      // 最近语气：看上一轮他的用词，轻松/严肃决定"没配文小图"该当什么
      let prevText = ''
      try { prevText = String(o.memory?.recent?.(o.chatId)?.slice(-1)[0]?.text || '') } catch { prevText = '' }
      const tone = /(哈哈|笑死|好家伙|草|乐|梗|表情包|😂|🤣|🐟)/.test(prevText) ? 'light'
        : /(难受|难过|烦|焦虑|压力|急|怎么办)/.test(prevText) ? 'serious' : ''
      const c = classifyImage({ file: out.imageUris[0], seg: seg0, text: o.text, recentTone: tone })
      if (c.kind === 'sticker') {
        out.imageDesc = `【他发了个表情包当语气】（${c.why}）`
        out.imageIsSticker = true
        log(`[qq] 🎭 判为表情包（${c.why}）—— 按语气处理，不描述画面`)
      } else if (c.kind === 'photo') {
        out.imageDesc = '【他发来一张图片，让你看】（我看到了原图）'
        log(`[qq] 🖼 判为正经图片（${c.why}）`)
      } else {
        out.imageDesc = '【他发来一张图片】（拿不准是表情包还是内容，先按语气理解，真看不清再问）'
      }
    } catch (e) {
      swallow(e, 'qq-img:classify')
      out.imageDesc = out.imageUris.length ? '【他发来一张图片】' : '【他发来一张图片，但下载失败】'
    }

    // 表情包下载失败**不算失败** —— 它的信息是"他用了个表情"，不需要图片内容。
    // 只有正经图下载失败才该告诉她"没看到"。
    if (!out.imageUris.length) {
      try {
        const { classifyImage } = await import('../media/image-kind.mjs')
        const seg0 = (Array.isArray(o.evt?.message) ? o.evt.message : []).find((x) => x?.type === 'image')
        const cb = classifyImage({ seg: seg0, text: o.text })
        if (cb.kind === 'sticker') {
          out.imageDesc = `【他发了个表情包当语气】（${cb.why}）`
          out.imageIsSticker = true
        } else {
          out.imageDesc = '【他发来一张图片，但下载失败，看不到内容】'
        }
      } catch (e) { swallow(e, 'qq-img:classify-fallback') }
    }
  } catch (e) {
    swallow(e, 'qq-img:ingest')
    out.imageDesc = '【他发来一张图片】'
  }
  return out
}
