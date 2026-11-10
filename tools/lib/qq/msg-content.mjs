// msg-content —— 消息 content 的统一读写（2026-11-07）。
//
// 病根：一条 user 消息的 content 有两种形态 ——
//   字符串                                  （纯文本）
//   [{type:'text'}, {type:'image_url'}]     （带图/视频帧，原生视觉通道）
// 编排层好几处写的是 `String(last.content || '') + 提示`，遇到数组就变成
// "[object Object],[object Object]" —— 图片整段蒸发，模型只看文字就开始编画面。
// 实测 2026-11-07：3 帧红/蓝/绿被她说成"画质糊得跟隔层水似的，后半段那堆分镜我一个都没对明白"。
//
// 这两个函数就是那一类 bug 的唯一出口：读文本用 textOf，往消息里补话用 appendText。

/** 一条消息的纯文本部分（数组只取 text 段，不把图拍成字符串）。 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  let out = ''
  for (const s of content) if (s && s.type === 'text') out += String(s.text ?? '')
  return out
}

/**
 * 往一条消息末尾追加文本，**保留图片/视频帧段**。
 * @param {object} msg 原消息（不改原对象）
 * @param {string} text 要追加的提示
 * @returns {object} 新消息
 */
export function appendText(msg, text) {
  const t = String(text ?? '')
  if (!msg || !t) return msg
  if (Array.isArray(msg.content)) {
    const segs = msg.content.slice()
    const i = segs.findIndex((s) => s && s.type === 'text')
    if (i >= 0) segs[i] = { ...segs[i], text: String(segs[i].text ?? '') + t }
    else segs.unshift({ type: 'text', text: t })
    return { ...msg, content: segs }
  }
  return { ...msg, content: String(msg.content ?? '') + t }
}
