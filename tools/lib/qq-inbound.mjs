// qq-inbound —— QQ 单条消息的入站预处理（纯 IO + 组装，无发送逻辑）
//
// ══════════════════════════════════════════════════════════════════════
// 从 qq-server.mjs 拆出（2026-11-07），两个原因
// ══════════════════════════════════════════════════════════════════════
// ① 体积：qq-server 已经超过门禁额度。这一段是"拿到消息 → 变成她读得懂的
//    一段文本 + 一组图片路径"，没有闭包状态，是唯一能零风险搬走的整块。
// ② 它顺手暴露并修掉一个**从上线起就没跑过**的功能：
//      const vf = await sampleVideoFrames({ url })
//    `sampleVideoFrames` 在整个仓库里**没有定义，也没有 import** ——
//    每次收到视频都是 ReferenceError，被 try/catch 吞掉，videoNote 永远为空。
//    也就是"抽帧看视频"这件事从来没发生过，而日志/文档都写着已经支持。
//    正确接口是 videoframe.mjs 的 sampleVideo(seg)。
//
// 顺序很重要：**先视频后图片**。视频帧要并进同一个视觉通道，
// 而且视频失败时的"没能打开"要追加到 extra 里（诚实说明，不许装看过）。
import fs from 'node:fs'
import path from 'node:path'
import { ingestImages } from './qq-image-ingest.mjs'
import { sampleVideo } from './videoframe.mjs'
import { swallow } from './swallow.mjs'
import { textOf } from './msg-content.mjs'
import { dataPath } from './paths.mjs'

/**
 * @param {object} o
 * @param {object} o.evt          OneBot 事件
 * @param {object} o.parsed       parseMessage 的结果（text/images/videos/…）
 * @param {string} o.text         正文字符串
 * @param {string} o.quoteLine    引用行（可能为空）
 * @param {string} o.extra        已有附加说明（连发提示等）
 * @param {string|number} o.selfId 自己的号（从正文里去掉 @ 自己）
 * @param {string} o.chatId
 * @param {boolean} o.isGroup
 * @param {object} [o.memory]     memory 模块（图片判定的"上一轮语气"）
 * @param {AbortSignal} [o.signal] 用户插话时中止看视频（只交付已经看到的部分）
 * @param {Function} [o.log]
 */
export async function prepareInbound(o = {}) {
  const log = typeof o.log === 'function' ? o.log : () => {}
  const parsed = o.parsed || {}
  let extra = String(o.extra || '')
  let imageDesc = ''
  let imageIsSticker = false
  const imageUris = []
  let videoNote = ''

  // ── 视频：真的抽帧看，而不是只打一个【发了一段视频】占位 ──────────────
  // 只处理第一个视频：抽帧是 IO 密集动作，不该拖垮这一轮回复。
  try {
    const vurl = (parsed.videos || []).find(Boolean)
    if (vurl) {
      const raw = String(vurl)
      const isHttp = /^https?:\/\//.test(raw)
      const vf = await sampleVideo({ url: isHttp ? raw : '' }, { opts: { signal: o.signal } })
      if (vf) {
        if (vf.interrupted) log?.(`[qq] ⏹ 看视频被打断：只看到 ${vf.seenTo || 0}s / ${vf.frames?.length || 0} 帧（他插话了，先答他）`)
        // note 是前提（几秒、几段、听清几句），timeline 是逐段的画面+声音事实。
        // 两个都要进正文 —— 只给 note 她就会"知道有视频但说不出里面发生了什么"。
        videoNote = [vf.note, vf.timeline].filter(Boolean).join('\n')
        // 看片姿态（省电/警觉/有闲心/日常）：不写这行，事后没人知道
        // "这次为什么只给两段"是身体状态还是解析失败。
        if (vf.meta?.gain?.why) log?.(`[qq] 👁 ${vf.meta.gain.why}`)
        if (Array.isArray(vf.frames) && vf.frames.length) {
          // ⚠ 2026-11-07 根因：帧原本留在 /tmp/bot-vid-*，紧跟着 vf.cleanup() 把目录删了，
          // 等 attachVision 去读这些路径时文件已经不存在 —— dataUri 抛错被 swallow 吞掉，
          // 于是**一条都没进请求**，而日志照样写"图片已并入（3张）"（日志取的是数组长度）。
          // 表现就是她收到视频只会照文本标记编（"鱼缸水草""画质糊"）。
          // 正确做法：帧复制进 qq-img（和图片同一个生命周期，qq-server 发完统一清理）。
          const keep = dataPath('qq-img')
          try { fs.mkdirSync(keep, { recursive: true }) } catch (e) { swallow(e, 'qq-inbound:vid-dir') }
          for (const f of vf.frames) {
            const dst = path.join(keep, `vid-${Date.now()}-${path.basename(f)}`)
            try { fs.copyFileSync(f, dst); imageUris.push(dst) } catch (e) { swallow(e, 'qq-inbound:vid-keep') }
          }
          if (!imageUris.length) {
            videoNote = '【他发来一段视频，但画面没保留下来——你没看成。别装看过，直接问他视频里是什么】'
            extra = (extra ? extra + ' ' : '') + videoNote
          }
        }
        // 诚实降级：没打开就在 extra 里说清楚
        if (!vf.frames?.length && /没能打开/.test(videoNote)) extra = (extra ? extra + ' ' : '') + videoNote
        try { vf.cleanup?.() } catch { /* temp */ }
      } else if (!isHttp) {
        // 2026-11-07：OneBot 只给了 file://／裸文件名时 sampleVideo 直接返回 null，
        // 这条视频会**静默消失**（她既不提也不当回事，用户以为她看过）。
        // 没拿到可下载地址也要说出来 —— 能力边界要诚实。
        videoNote = '【他发来一段视频，但消息里没有可下载的地址——你没看成。别装看过，直接问他视频里是什么】'
        extra = (extra ? extra + ' ' : '') + videoNote
      }
    }
  } catch (e) { swallow(e, 'qq-inbound:videoframe') }

  // ── 图片：下载 + 判定"表情包/正经图" ────────────────────────────────
  try {
    const images = Array.isArray(parsed.images) ? parsed.images : []
    if (images.length) {
      const r = await ingestImages({ images, evt: o.evt, text: o.text, chatId: o.chatId, memory: o.memory, log })
      imageDesc = r.imageDesc
      imageIsSticker = r.imageIsSticker
      for (const f of r.imageUris) imageUris.push(f)
    }
  } catch (e) { swallow(e, 'qq-inbound:images') }

  // ── 组装成"他说的正文" ─────────────────────────────────────────────
  // 引用行拼在正文前面（记忆里也留着，回头能还原上下文）。
  const selfId = String(o.selfId ?? '')
  let body = String(o.text || '')
  if (selfId) {
    try { body = body.replace(new RegExp(`@?${selfId}\\s*`), '').trim() } catch { body = body.trim() }
  }
  const parts = [o.quoteLine, body, extra, imageDesc]
  const raw = parts.filter(Boolean).join(' ')
  if (!raw) return null

  // 群聊：把说话人昵称带上，她才知道在跟谁说话；记忆里也留着"谁说了什么"。
  const display = o.isGroup ? String(o.evt?.sender?.card || o.evt?.sender?.nickname || '').trim() : ''
  const said = (o.isGroup && display) ? `${display}：${raw}` : raw
  const userText = said
  const memText = o.quoteLine ? `${o.quoteLine} ${said}` : said

  return { imageDesc, imageIsSticker, imageUris, videoNote, extra, userText, memText, display, raw }
}

/**
 * 把图片/视频帧并进最后一条 user 消息（原生视觉通道，一次调用完成看图+回复）。
 * 抽自 qq-server：10 行纯拼装，留在编排层只会让它继续膨胀。
 */
export function attachVision(messages, { imageUris = [], imageIsSticker = false, videoNote = '', dataUri, log } = {}) {
  if (!Array.isArray(messages) || !messages.length) return 0
  if (!imageUris.length || imageIsSticker) return 0
  try {
    const last = messages[messages.length - 1]
    const content = [{ type: 'text', text: textOf(last.content) }]
    let added = 0
    for (const f of imageUris) {
      try { content.push({ type: 'image_url', image_url: { url: dataUri(f) } }); added++ } catch { /* 单张失败不挡整条 */ }
    }
    // 2026-11-07：以前这里打的是 imageUris.length —— 文件早被删了也照样说"3张"，
    // 排查时被骗了三轮。日志必须报**真的进包张数**。
    if (!added) {
      log?.(`[qq] ⚠ 图片/视频帧一个都没读进来（${imageUris.length} 个路径不可读）——这轮她看不到画面`)
      return 0
    }
    messages[messages.length - 1] = { role: 'user', content }
    log?.(`[qq] 🖼 图片已并入聊天请求（${added}/${imageUris.length}张）`)
    if (videoNote && !/没能打开/.test(videoNote)) {
      const c = messages[messages.length - 1]
      if (Array.isArray(c.content)) c.content[0].text = (videoNote + '\n' + (c.content[0]?.text || '')).slice(0, 3000)
    }
    return added
  } catch { return 0 }
}
