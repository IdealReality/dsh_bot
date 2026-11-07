// search-gate —— "该查没查"的判定（2026-11-07）
//
// ══════════════════════════════════════════════════════════════════════
// 为什么需要一道闸
// ══════════════════════════════════════════════════════════════════════
// 工具已经挂上了（look_up / bili_search / watch_video），system 里也写了
// "不懂就查"。但实测她仍然会：
//   他：「大肥鱼小课堂那个系列是啥？B站上有吗」
//   她：「我真没留意过…别听我瞎编。要不我现在去B站搜一下，搜到就能看是啥了」
//
// 也就是说：**她知道该查，但把"查"说成了"要不要我去查"**，然后等下一轮。
// 提示词只能提高概率，闸门才能保证结果 —— 与 cohere 的复核同一个道理。
//
// 判据（保守，只在"确实该查"时触发）：
//   ① 这一轮**没有任何检索类工具调用**
//   ② 这句话是问题 / 或者她在回答里承诺去查（"我去找找/要不我搜一下"）
//   ③ 问题指向**外部事实**（B站/视频/新闻/价格/版本/某个东西是啥），
//      而不是她自己的状态、关系、感受（那些查也没用）
//
// 触发后由编排层带工具重写一次 —— 只重写一次，不循环。
import { swallow } from './swallow.mjs'

/** 检索类工具：调过任意一个就不算"该查没查"。 */
export const SEARCH_TOOLS = new Set(['look_up', 'bili_search', 'watch_video', 'browse_page'])

/** 外部事实信号：命中才算"查得出来"的问题。 */
const EXTERNAL = /(B站|b站|bilibili|视频|UP主|up主|新闻|最新|价格|多少钱|几块|版本|更新|发布|是什么|是啥|哪个|哪条|哪部|有没有|怎么样|测评|攻略|教程|攻略|怎么用|怎么做|怎么弄|怎么装|怎么下载|谁做的|谁唱|谁写)/

/** 她自己的事 / 关系 / 感受：这些查也没用，别触发。 */
const SELFISH = /(你是谁|你在干嘛|你在做什么|你吃了吗|你累不累|你困|你心情|你开心|你难过|你想(我|他|吃)|咱俩|我们(之间|认识)|你叫什么|你多大|你住在)/

/** 承诺去查但没查（最典型的一种逃避）。 */
const PROMISE_SEARCH = /(我|咱).{0,12}(搜|查|找).{0,6}(一下|一搜|一查|找看)|我去找找|我看看有没有|要不我.{0,12}(搜|查|找)|我帮你(搜|查)/

/**
 * @param {object} o
 * @param {string} o.userText
 * @param {object} [o.percept]  cohere 解码结果
 * @param {Array}  [o.toolTrace] 这一轮真的调过的工具
 * @param {string} [o.answer] 她准备发出去的话
 * @returns {{needed:boolean, why:string}}
 */
export function needsSearch({ userText = '', percept = null, toolTrace = [], answer = '' } = {}) {
  try {
    const used = new Set((Array.isArray(toolTrace) ? toolTrace : []).map((t) => String(t?.name || '')))
    for (const n of SEARCH_TOOLS) if (used.has(n)) return { needed: false, why: 'already-used' }

    const q = String(userText || '')
    const a = String(answer || '')
    if (SELFISH.test(q)) return { needed: false, why: 'self-topic' }

    // 承诺去查 → 现在就去查（不管问题形态）
    if (PROMISE_SEARCH.test(a)) return { needed: true, why: 'promised-not-done' }

    // 不只看句末问号：中文疑问常常靠"吗/呢/啥/有没有"结尾，而 percept 的
    // primary 在测试/旁路调用里可能是空的。判据宁可宽一点，后面还有 EXTERNAL 兜着。
    const isQuestion = percept?.primary === 'QUESTION'
      || /[？?]/.test(q)
      || /(吗|呢|是不是|有没有|是什么|是啥|怎么|为什么|为啥|哪|谁|多少)\s*[。！!~～]?$/.test(q)
      || /(吗|呢|是不是|有没有|是什么|是啥|怎么|为什么|为啥|哪个|哪条|谁|多少)/.test(q)
    if (!isQuestion) return { needed: false, why: 'not-a-question' }
    if (!EXTERNAL.test(q)) return { needed: false, why: 'not-external' }
    return { needed: true, why: 'fact-question' }
  } catch (e) {
    swallow(e, 'search-gate')
    return { needed: false, why: 'error' }
  }
}

/** 附在最后一条 user 消息上的重写指令（不新增 system，避免打乱采样）。 */
export const SEARCH_HINT = '\n\n【先查再说】\n'
  + '· 这题你不确定：现在就调 look_up 或 bili_search，看完再回答。\n'
  + '· 不许说"我去找找 / 要不我搜一下 / 要不要我查"——要么现在查，要么直说不知道。\n'
  + '· 查到几条就挑最对题的 1~2 条，把标题（和 BV 号）说给他。'
