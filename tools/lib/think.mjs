// tools/lib/think.mjs —— 「先想后说」的执行体
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要单独一个文件
// ══════════════════════════════════════════════════════════════════════
// 这段逻辑本来直接塞进了 qq-server 的回复链里。门禁立刻拦住了（1807 行 > 1750）。
//
// 门禁拦得对，而且拦出了一个**结构上更正确的分法**：
//   这段东西的输入是（他说的话 + 她心里的念头 + 她的身体状态），输出是（一句心里话）。
//   它不碰 socket、不碰 OneBot、不碰发送 —— **它根本不是编排层的事**。
//   留在 qq-server 里等于把"她想什么"和"怎么发出去"焊死在一起。
//
// 拆出来还多拿到三件东西：
//   ① 可以单独测（不启动 qq-server 就能验"她会不会先想一遍"）
//   ② 别的通道（B站评论、群聊插话）可以直接复用同一套内省
//   ③ qq-server 回到它自己的欠账额度以内
//
// ══════════════════════════════════════════════════════════════════════
// 这一层的形状（为什么不是一次生成）
// ══════════════════════════════════════════════════════════════════════
// 一次生成 =「针对这句话，写一个最合适的回答」= 客服的动作。
// 人的顺序是：看见 → 心里浮起一个反应（可以烦、可以走神、可以不想理）
//            → 那个反应被掂量（要不要说、说到哪）→ 才组织成话出口
//
// 所以做成两次往返：① introspect() 只产"心里话"，
//                  ② speak() 把"心里话"当作**她自己的念头**喂回去再生成真正要说的话。
//
// 关键：第②步里那段内心话是"我记得我刚才是这么想的"，不是"请按照下面要求回答"。
// 这个区别决定了她是"有个人在里面"还是"一个执行器"。
//
// 成本取舍（也有生理依据）：累到极点（cognitiveDepth 低）时不内省 —— 人累急了本来就不先想；
// 群聊不内省 —— 群里的反应本来就浅。这不是省 token，是把资源用在对的地方。
import { swallow } from './swallow.mjs'
import { appendText } from './msg-content.mjs'

/** 内省的开关与阈值。放这里而不是 config：它是"结构参数"，不是用户偏好。 */
export const RULES = {
  minDepth: 0.45,        // 低于这个脑力就不先想了
  maxThoughtChars: 200,  // 心里话再长就是她在写作文
  temp: 1.05,            // 内省用更高温度：想事情本来就发散
  maxTokens: 90,
  timeoutMs: 9000,
}

/**
 * 她现在心里会怎么想这句话。
 * @returns {Promise<{thought:string, used:boolean, depth:number}>}
 */
export async function introspect({ userText = '', chatId = '', isGroup = false, llm = null, log = () => {}, now = Date.now(), percept = null, hasVision = false } = {}) {
  const LLM = llm || await import('./llm.mjs')
  const F = await import('../brain/field.mjs')
  const IN = await import('../brain/inner.mjs')

  // 2026-11-04 修：cognitiveDepth 的第一个参数是**状态对象**，不是时间戳。
  // 原写法 cognitiveDepth(now) 传了数字 → st.dims 为 undefined →
  // 每轮都 "Cannot read properties of undefined (reading 'sleepDebt')"，
  // 「先想后说」整层静默失效（只在内省日志里冒一行 ERR）。先演化再求值。
  // 2026-11-05 意识-身体耦合：内省不只要认知深度，还要看情绪场的"愿不愿意想"。
  // cognitiveDepth 只测睡眠债/疲劳（生理），patience/irritability 是情绪（心理）——
  // 烦躁的人不是想不动，是**不想想**。这两个门槛缺一不可。
  const st = F.evolve(now)
  const depth = F.cognitiveDepth(st)
  let willing = F.patience(st)
  try {
    const ir = F.irritability(st)
    if (Number.isFinite(ir)) willing = Math.min(willing, 1 - ir * 0.8)  // 越烦越不想内省
  } catch { /* irritability 缺席就只用 patience */ }
  if (isGroup || depth <= RULES.minDepth || willing < 0.25) {
    return { thought: '', used: false, depth, skippedBy: willing < 0.25 ? 'emotion' : 'depth' }
  }
  // 快速通道（2026-11-07 延迟实测：内省稳定占 4~5 秒，而表情/附和/收尾根本不需要"先想一遍"）
  if (percept && ['EMOTE', 'ACK', 'CLOSING'].includes(percept.primary)) {
    return { thought: '', used: false, depth, skippedBy: 'trivial' }
  }

  const thoughtBlock = IN.innerBlock(2, now)
  // 情绪底色一行（field.sense 已有现成实现：给提示词用的、能读出方向的一句话）
  let moodLine = ''
  try { const lines = F.sense(st); if (Array.isArray(lines) && lines[0]) moodLine = String(lines[0]) } catch { /* 情绪读不出就不注 */ }
  const ask = [{
    role: 'user',
    content:
      '你现在就是她本人（不是助手，不是旁白）。\n' +
      '下面是他刚说的话，还有你心里原本转着的事。\n' +
      '请你只输出**你心里冒出来的第一反应**，不要写给人看的句子。\n' +
      '规则：\n' +
      '- 一到两句，口语，可以碎，可以不耐烦，可以自相矛盾\n' +
      '- 不要有礼貌，不要照顾他的情绪，不要解释\n' +
      '- 不要用引号，不要写"我想："这种前缀\n' +
      '- 如果你其实不太想理他 / 不知道说什么，就照实写出来\n' +
      // 2026-11-07 补：内省可以烦，但不能把"我要你说清楚"当成第一反应。
      // 实测（截图）三连问"你到底想让我干嘛"就是从这里长出来的 ——
      // 内省把"不想处理"合理化成了"他没说清"，然后正稿照着演。
      '- 但记住一件事：他是来找你说话的，不是来打扰你的。\n' +
      '  你可以累、可以烦、可以只想说一句，但不能把"他没说清楚"当成第一反应 ——\n' +
      '  他说的东西哪怕不完整，你也先按自己的理解接一下，再接不上才问。\n' +
      '  更不要在心里想"他到底想让我干嘛"：这种念头一出去，嘴上就会变成质问。\n\n' +
      // 2026-11-07 实测：他发了一段视频（三帧红/蓝/绿纯色块），内省只看到
      // 「你看这个 【发了一段视频】」这句文本 —— 于是自己编出"这鱼缸看着挺讲究的"，
      // 念头再经 speak 进正稿，她嘴上就说"石头水草摆得整整齐齐"。
      // 内省这一层看不到图（也拿不到 token），所以必须明确告诉它：**别猜画面内容**。
      (hasVision
        ? '【这一条带着画面】他这条消息里有两张以上的图片/视频帧，你已经看过了（画面此刻不在你眼前）。\n' +
          '所以：**别在心里编画面里有什么** —— 别猜场景、别猜人物、别猜鱼缸水草这类细节。\n' +
          '你要冒的念头只能是"对这件事的反应"（想不想理、想先问什么），画面内容交给眼睛那一路去说。\n\n'
        : '') +
      thoughtBlock +
      '\n\n他说：「' + String(userText || '').slice(0, 300) + '」' +
      (moodLine ? '\n\n（你现在的情绪底色：' + moodLine + '）' : ''),
  }]

  let raw = ''
  try {
    raw = String(await LLM.chat(ask, {
      temperature: RULES.temp, max_tokens: RULES.maxTokens,
      timeoutMs: RULES.timeoutMs, purpose: 'fast',
    }) || '').trim().slice(0, RULES.maxThoughtChars)
  } catch (e) {
    swallow(e, 'think:introspect')
    return { thought: '', used: false, depth }
  }
  if (!raw) return { thought: '', used: false, depth }

  // ① 原文进流：不裁、不摘要。这是"她当时心里到底怎么想的"的唯一证据。
  try { IN.stream({ role: 'self', kind: 'think', text: raw, meta: { chat: chatId } }, now) } catch (e) { swallow(e, 'think:introspect') }

  // ══════════════════════════════════════════════════════════════════
  // 2026-11-07：推脱型念头不许直接进入"怎么说"
  // ══════════════════════════════════════════════════════════════════
  // 实测内省产出过：「噢，嘲讽大肥鱼运营啊，那你直接去说啊，别在这绕了。」
  // 这句话作为**心里的第一反应**是真实的（她确实有点不耐烦），
  // 但如果原样喂回去，正稿就会变成"你自己去"——把用户推回去。
  // 人不是这样：心里骂一句，嘴上还是会接。
  //
  // 所以原文进流（保留证据），交给表达的是**经过社交抑制的版本**。
  // 这不是删改记忆，是"想"和"说"之间那道本来就存在的闸。
  const dismissed = /(你自己去|你直接去|那你去|你去啊|别在这|跟我说(没用|干嘛|有什么用)|懒得管|不想管|关我什么事|你自己弄|自己看着办)/.test(raw)
  const forSpeech = dismissed
    ? '心里有点不想动，甚至想让他自己去；但他既然开口了，我还是接一下。'
    : raw
  // ② 进念头池：想说没说的会压着，攒成 tension（闭合回路）
  try { IN.think(forSpeech, { kind: 'urge', about: 'owner', now }) } catch (e) { swallow(e, 'think:introspect') }
  // ③ 想的时候情绪会动 —— 想到难受的事，人不会毫无反应
  try {
    if (/(烦|累|不想|难受|算了|随便|没意思|懒得)/.test(raw)) F.poke('valence', -0.06, { why: 'inner:neg', now })
    else if (/(好|想|喜欢|开心|有意思)/.test(raw)) F.poke('valence', 0.05, { why: 'inner:pos', now })
  } catch (e) { swallow(e, 'think:introspect') }

  log('[qq] 💭 心里想的（不外发）：' + raw.slice(0, 50) + (dismissed ? '（推脱型 → 已收住）' : ''))
  return { thought: forSpeech, used: true, depth }
}

/**
 * 把"心里想的"交还给她，让她决定说什么。
 *
 * 注意措辞：这是**回忆**（"你刚才心里想的是"），不是指令（"请按照…回答"）。
 * 这个区别是整层的关键 —— 指令会让她表演，回忆会让她承认自己有过那个念头。
 */
export async function speak(messages, thought, o = {}) {
  const th = String(thought || '').trim()
  if (!th) return ''
  const msgs = (messages || []).map((m) => ({ ...m }))
  if (!msgs.length) return ''
  const last = msgs[msgs.length - 1]
  const hasVision = Array.isArray(last.content) && last.content.some((s) => s && s.type === 'image_url')
  // 最后一条可能带着图片/视频帧（content 是数组）。**不能替换成纯字符串** ——
  // 那样她这一轮就看不到画面，只剩"收到一段视频"的文字标记，然后照着标记编。
  // 2026-11-07 实测：三帧红/蓝/绿被说成"画质糊得跟隔层水似的"。
  msgs[msgs.length - 1] = appendText({ ...last, role: 'user' },
    '\n\n【你刚才心里想的是】\n' + th +
    '\n\n（上面那句是**你自己**的念头，别复述它、别承认自己在"想过了"。' +
    '现在照它来决定怎么回：可以话少、可以没耐心、可以只应一声。' +
    '\n**但有一条不能省：先接住他那句话的内容**——他说了什么，你得先应到那件事上；' +
    '接住之后，想理就理，不想多说就收尾。' +
    '\n不许把「我困 / 我在忙 / 我在写东西」当成这一句的主体，' +
    '也不许反问他"你到底想让我干嘛"（他刚说过了）。' +
    '\n**别把它说得比他这句话还长。**）' +
    // 2026-11-07：他发视频时，内省那个念头是**没看图时猜的**，曾经把她带到
    // "石头水草摆得整整齐齐"。画面在消息里，所以这里要明确谁说了算。
    (hasVision
      ? '\n\n【画面以你看到的为准】这条消息里带着他发的图片/视频帧，你能直接看到。' +
        '心里那个念头是在你没细看时冒出来的猜测 —— 它和画面对不上，就以画面为准。' +
        '\n· 别讲画面里没有的东西（别补场景、别编人物道具）；' +
        '\n· 他问"看到什么"就说真实看到的颜色、形状、动作；' +
        '\n· 说不清就说不清，别用"画质糊"糊过去。'
      : ''))
  try {
    if (o.chatWithTools) {
      // 2026-11-09（十遍第 7 遍）：这里必须**不带工具**。
      // speak 是"先想后说"的第二遍调用，主回复那一轮已经把工具跑完了；
      // 再带一次 CHAT_TOOLS 等于给同一条消息开第二套 30 秒预算，
      // 最坏能把 run_command / office_task 重复执行一遍（写文件写两次、立项两次）。
      // 想说什么在这一步只需要措辞，不需要再动手。
      const r = await o.chatWithTools(msgs, { temperature: o.temperature, purpose: o.purpose || 'chat', tools: false })
      return r?.text || ''
    }
    const llm = o.llm || await import('./llm.mjs')
    return String(await llm.chat(msgs, { temperature: o.temperature, purpose: o.purpose || 'chat' }) || '')
  } catch (e) {
    swallow(e, 'think:speak')
    return ''
  }
}

/**
 * 完整的一轮：想 → 说。给编排层一个调用点，别再让 qq-server 铺开写。
 * @returns {Promise<{text:string, thought:string, used:boolean, depth:number}>}
 */
export async function thinkThenSay({ messages, userText, chatId, isGroup, dynTemp, toolsOn, chatWithTools, llm, log, percept = null, hasVision = false }) {
  const it = await introspect({ userText, chatId, isGroup, llm, log, percept, hasVision })
  if (!it.used) return { text: '', thought: '', used: false, depth: it.depth }
  const text = await speak(messages, it.thought, {
    llm, chatWithTools: toolsOn ? chatWithTools : null, temperature: dynTemp,
  })
  return { text, thought: it.thought, used: true, depth: it.depth }
}
