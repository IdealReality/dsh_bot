// state-brief —— 把"她此刻在做什么"转成**不伤对话**的一句
//
// ══════════════════════════════════════════════════════════════════════
// 为什么单独一个模块（2026-11-07 十遍第七遍）
// ══════════════════════════════════════════════════════════════════════
// self-state.json 里的 lean 是她自己的说法，例如：
//     "想随便翻翻手机看点轻松的东西，脑子实在转不动了"
// 一个人正在发呆时被叫到，这句话是**真的**；但把它原样塞进 system，
// 模型会把它当成这一轮的**态度** —— 实测她回的是"别让我猜 / 我躺着犯困"。
//
// 上一轮在 persona.buildMessages（shadow 路径）里修过：有人开口时把
// "脑子转不动/啥都不太想干"剥掉，只留"手头在干嘛"。但 assemble（live 路径）
// 还是原样注入 —— 切 brain.mode 就"换一个人"。同一件事两条装配路线不一致，
// 是这个项目反复踩的形状（cleanHistoryLine / selfContextBlock 都犯过）。
//
// 现在两处都调这一个函数：剥的是**静息态的强度**，不是她的体验。

/** 有人在场时补的一句：社会在场反射，不是指令。 */
export const PRESENT_NOTE = '（他这会儿叫我了 —— 先把注意力给他，手头这件事等会儿再说。）'

/**
 * @param {string} lean       self-state 里的原话
 * @param {object} [o]
 * @param {boolean} [o.present] 有人正在跟她说话（= 剥掉静息态的消极描述）
 * @returns {string} 可以直接写进 system 的一句（可能为空）
 */
export function briefState(lean = '', { present = false } = {}) {
  const raw = String(lean || '').trim()
  if (!raw) return ''
  if (!present) return raw
  return raw
    .replace(/(脑子|人)\s*(实在)?\s*(转不动|钝|糊|发钝)了?/g, '')
    .replace(/(啥都不太想干|就想窝着|不想动|困)了?/g, '')
    .replace(/[，,、]\s*(?=[，,。]|$)/g, '')
    // 剥完常留一个孤零零的"，了"（实测："…看点的东西，了"）
    .replace(/[，,、]\s*了\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 有没有足够内容值得写一行（太短就别写，省得 system 里多一句废话）。 */
export function briefUsable(s = '') {
  return String(s || '').trim().length >= 4
}
