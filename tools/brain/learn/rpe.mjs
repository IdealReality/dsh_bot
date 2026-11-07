// brain/learn/rpe —— 化学层：奖励预测误差（多巴胺）驱动的策略强化
//
// ══════════════════════════════════════════════════════════════════════
// 为什么要"仿生"而不是直接抄 Q-learning
// ══════════════════════════════════════════════════════════════════════
// 群聊插件里常见的是 Q 表 / 策略库 / 奖励函数三件套（AstrBot 的 group_chat
// 就是在线 Q-learning + 离线蒸馏）。它的形状是对的，但直接搬过来会缺三样
// 生物才有的东西，而这三样恰好决定了"学出来像不像人"：
//
//   ① **预测误差**：多巴胺编码的不是奖励，是"实际 - 预期"（Schultz 1997）。
//      一直给糖吃，da 回到基线 —— 这叫耐受。没有它，学到的策略会永远膨胀。
//   ② **资格迹**：行为与结果之间隔着几秒到几分钟，必须有一个衰减的记忆桥。
//      这就是"我上一条那么接的，他这条的反应说明接得对不对"。
//   ③ **敏感度漂移**：同一个策略用太多次，受体下调 → 学得越来越慢。
//      对应人话："老用同一招，自己也知道没意思了。"
//
// 所以这里只做三件事：算 reward、算 RPE、给权重一个带耐受的增量。
// 选择逻辑在 strategies.mjs（生物学/精神层），这里不碰。
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 学习率。小一点：一天几十轮对话，学太快会变成"被最后一句驯化"。 */
export const ALPHA = 0.12
/** 预期均值的更新率（比权重更慢，代表"这个策略长期怎么样"）。 */
export const BETA = 0.15
/** 耐受：每次使用后敏感度乘数（下限 0.35）。 */
export const TOLERANCE = 0.03

/**
 * 把"他下一条消息"翻译成一个 -1..1 的奖励。
 *
 * 三个来源，权重刻意不等：
 *   · 情绪价（0.55）：最直接的"他高不高兴"
 *   · 是否继续（0.25）：他没走、还在说 → 这次接法至少没把天聊死
 *   · 明说（0.20）：被夸/被骂，置信度最高但出现频率最低
 *
 * @param {object} o
 * @param {object} [o.nextPercept] 下一条消息的 percept（emoji/primary/continuity）
 * @param {boolean} [o.continued]  是不是同一段对话的延续（不是隔了几小时的重新开场）
 * @param {boolean} [o.praised]    被明确夸/道谢
 * @param {boolean} [o.scolded]    被明确指责/纠正
 */
export function rewardOf({ nextPercept = null, continued = true, praised = false, scolded = false } = {}) {
  const v0 = Number(nextPercept?.emoji?.valence)
  const v = Number.isFinite(v0) ? v0 : 0
  // null = 无法归因（隔了几小时重新开场）：不奖不罚，别把时钟当反馈。
  const cont = continued === null ? 0 : continued ? 1 : -0.5
  const said = praised ? 1 : scolded ? -1 : 0
  // 2026-11-07 实测校准：被明确指责时旧权重只到 +0.05（因为"仍在继续聊"把它抵消了），
  // 等于"被骂了还算正反馈"。明说最可信，权重提到 0.35，情绪价降到 0.45。
  return clamp(0.45 * v + 0.2 * cont + 0.35 * said, -1, 1)
}

/**
 * 一次更新。**纯函数**：输入旧臂状态与奖励，返回新状态。
 *
 * @param {{w:number, mean:number, sens:number, n:number}} arm
 * @param {number} reward -1..1
 * @returns {{arm:object, rpe:number, updated:boolean}}
 */
export function reinforce(arm, reward) {
  // NaN/Infinity 会让 w/mean 变成 null（JSON 里 NaN → null），整条策略从此坏掉。
  // 非有限值直接视为"这次没有信息"，不更新。
  const a = {
    w: clamp(Number(arm?.w ?? 0.5), 0.05, 0.95),
    mean: clamp(Number(arm?.mean ?? 0), -1, 1),
    sens: clamp(Number(arm?.sens ?? 1), 0.35, 1.25),
    n: Number(arm?.n ?? 0),
  }
  const rw = Number(reward)
  if (!Number.isFinite(rw)) return { arm: a, rpe: 0, updated: false }
  const rpe = clamp(rw - a.mean, -1.5, 1.5)
  // 预期先动（慢），权重后动（快一点，但乘敏感度）
  a.mean = clamp(a.mean + BETA * rpe, -1, 1)
  a.w = clamp(a.w + ALPHA * rpe * a.sens, 0.05, 0.95)
  a.n += 1
  return { arm: a, rpe: Number(rpe.toFixed(3)), updated: Math.abs(rpe) > 0.02 }
}

/**
 * 用过一次之后的受体下调（耐受）。
 * 与 reinforce 分开：调用发生在"说了这句话"时，更新发生在"看到反应"时。
 */
export function habituate(arm) {
  const a = {
    w: clamp(Number(arm?.w ?? 0.5), 0.05, 0.95),
    mean: clamp(Number(arm?.mean ?? 0), -1, 1),
    sens: clamp(Number(arm?.sens ?? 1), 0.35, 1.25),
    n: Number(arm?.n ?? 0),
  }
  a.sens = clamp(a.sens * (1 - TOLERANCE), 0.35, 1.25)
  a.n += 1
  return a
}

/** 休息时的缓慢恢复：敏感度朝 1 回归（受体合成）。按小时计。 */
export function recover(arm, hours = 0) {
  const a = { ...(arm || {}) }
  const h = Math.max(0, Number(hours) || 0)
  if (!h) return a
  const rate = 1 - Math.exp(-h / 18)      // 18 小时恢复约 63%
  a.sens = clamp(Number(a.sens ?? 1) + (1 - Number(a.sens ?? 1)) * rate, 0.35, 1.25)
  return a
}
