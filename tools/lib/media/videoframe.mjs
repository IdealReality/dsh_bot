// videoframe —— QQ 视频段的入口：交给 watch（视网膜 + 耳朵）去真的看和听。
//
// 历史（别退回去）：
//   2026-11-05 这里还是"下载 → ffmpeg 均匀抽 3 帧"。两个结构性错误后来都爆了：
//     ① 帧落在 /tmp，抽完就 cleanup，attachVision 之后才读 → 一条都没进请求（日志还写"3张"）；
//     ② 3 帧均匀采样看不见动作，也听不到声音 —— 她只能说"我看了"，内容全靠编。
//   2026-11-08 起：抽帧/切窗/事件分割/注视点/拼贴/听写全部交给
//     retina.mjs（预测误差）+ audition.mjs（语音与声音事件）+ watch.mjs（视听对齐）。
//   2026-11-08 晚：入口统一到 **organ/vision**（器官门面）—— 它负责记账
//     （看了几次、几次没看成、平均多久、耳朵是否可用），并透传增量印象。
//     这里只保留"QQ 消息段 → 器官"这一层适配，不做任何图像处理。
import * as vision from '../../brain/organ/vision.mjs'
import { swallow } from '../infra/swallow.mjs'

/**
 * 视频段 → { frames: string[], note: string, meta, cleanup } | null。
 *
 * @param {{url?:string, file_id?:string}} seg video 段的 data（url 直链优先）
 * @param {{getVideoUrl?:Function, opts?:object}} [o]
 *   getVideoUrl: 旧接口保留 —— file_id 需要调用方先用 OneBot get_video 换 URL。
 *   opts: 透传给 watchMedia（maxEvents / maxFrames / budgetMs / maxAnalyzeSec …）
 * @returns {Promise<null | {frames:string[], note:string, timeline:string, meta:object, cleanup:Function}>}
 */
export async function sampleVideo(seg, { getVideoUrl, opts = {} } = {}) {
  try {
    let url = String(seg?.url || '').trim()
    if (!url && seg?.file_id && typeof getVideoUrl === 'function') {
      const r = await getVideoUrl(String(seg.file_id))
      url = String(r || '').trim()
    }
    if (!url || !/^https?:\/\//.test(url)) return null
    const w = await vision.look({ url }, opts)
    if (!w.ok) {
      // 诚实兜底：说清楚没看成，带上具体原因（HTTP 403 / 没有音轨 / 超出预算 / 被他打断…）
      return {
        frames: [],
        note: w.note || `【他发来一段视频，但没能打开看（${w.why || '未知原因'}）——不知道里面是什么。别装看过，直接问他视频里是什么】`,
        timeline: '',
        meta: w.meta || {},
        interrupted: Boolean(w.interrupted),
        cleanup: w.cleanup,
      }
    }
    return {
      frames: w.frames,
      // note 是"她应该知道的前提"，timeline 是逐段事实；两者一起进正文
      note: w.note,
      timeline: w.timeline,
      meta: w.meta,
      interrupted: Boolean(w.interrupted),
      seenTo: Number(w.seenTo) || 0,
      cleanup: w.cleanup,
    }
  } catch (e) {
    swallow(e, 'videoframe:sample')
    return null
  }
}
