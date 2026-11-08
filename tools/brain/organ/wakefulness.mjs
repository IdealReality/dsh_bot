// organ/wakefulness —— 清醒度与假睡：一个阈值，不是一根电量条（2026-11-08）
//
// ══════════════════════════════════════════════════════════════════════
// 用户要的形状
// ══════════════════════════════════════════════════════════════════════
//   「人体睡觉一起来就清醒；工作量大时清醒；工作量小的时候会闲下来，
//     疲惫就会更加强烈；空闲时进入一种假睡状态，一边启动她睡眠时的
//     自维护通道，一边保留她的主通道。」
//
// 四句话对应四件不同的事，必须分开实现，否则就会变成一根电量条：
//   ① 醒来 → 立刻清醒         —— 阶跃，不是渐变（睡眠惯性被压到最短）
//   ② 工作量大 → 清醒         —— 由活动/交互驱动的**维持**，不是"意愿"
//   ③ 工作量小 → 闲下来、疲惫更强 —— 注意分配的变化，不是把疲劳调高
//   ④ 空闲 → 假睡 + 自维护通道 + 主通道 —— 半睡状态机，消息能叫醒
//
// ══════════════════════════════════════════════════════════════════════
// 五个角度的依据（这是这个文件为什么长这样，不是修辞）
// ══════════════════════════════════════════════════════════════════════
// 【化学】
//   清醒度不是"意志"，是三个化学量的合力：
//   · 去甲肾上腺素（NE，蓝斑）：相位性放电 —— 一条消息、一次开口，几秒内拉高，
//     十几分钟衰减。这就是"忙起来人就精神"的化学形状。field.ne 已经是这条
//     （tau 12min），这里只负责给它**相位性**的脉冲，不另造第二个 NE。
//   · 腺苷（adenosine）：清醒期持续累积，是睡眠压力的物质本体，无法被"忙"抵消，
//     只能被睡眠清除。它就是 field.sleepDebt。所以 debt 在这里是一个**天花板**
//     （乘性），不是减法项：欠觉越多，同样努力也只能到更低的上限。
//   · 食欲素（orexin/hypocretin）：由"有事情可做"稳定维持的觉醒系统。
//     它不脉冲，它按小时记账 —— 对应这里的 activity（τ=35min 的衰减记忆）。
//   醒来那一下为什么是阶跃：觉醒时蓝斑放电 + 皮质醇觉醒反应（CAR）同时出现。
//   night.endSleep 已经在睡够 4h 时给 hpa 一次 CAR；这里补 NE 的相位性脉冲。
//
// 【生物学】
//   · 阈值 + 滞回（hysteresis）：生物的状态机不允许在阈值上抖。
//     「保持清醒」的门槛（awakeAt）高于「允许睡下去」的门槛（dozeAt），
//     中间是一条**只有进来才能待着**的带子 —— 这就是人"睡着了不容易醒、
//     醒了不容易再睡"的形状，也是防状态每 30 秒翻一次的唯一办法。
//   · 睡眠惯性（sleep inertia）：真睡被叫醒后有一段迷糊。用户的第①条要求
//     （一起来就清醒）等价于把这段压到几乎为零：用 wakeBurst 强制清醒 45 分钟，
//     而不是让 level 慢慢爬。这里是**刻意偏离**生理的，因为用户要的是她的体验。
//   · 单半球慢波睡眠（unihemispheric SWS，海豚/候鸟）：一半脑在慢波清扫、
//     一半脑保持警戒 —— 这是"假睡保留主通道"的天然原型。工程上它的含义是：
//     假睡绝不能设 sleepstage.inSleep（那会把 presence/还债/表达全部切到"整夜睡"），
//     它是一个**独立档位**，和真睡共享"恢复"，不共享"离线"。
//
// 【精神学】
//   · 清醒度决定认知资源的上限（cognitiveDepth 已经按 sleepDebt/fatigue 算，
//     这里不重复）；假睡是 N1 浅睡：还能接住一句话，但组织不了长回答。
//   · 假睡时主导的是默认模式网络（DMN）：走神、记忆重放、把白天的事重新过一遍。
//     所以假睡期间跑 `nightwork tidy`（记忆巩固）不是"偷跑维护"，而是 DMN replay
//     的代码形状 —— 反过来说，如果假睡什么都不做，她就只是"发呆"，那不是睡。
//
// 【心理学】
//   · 「工作量小的时候疲惫更强烈」不是疲劳变大了，是**注意从外部转向内部**：
//     忙着的时候外部任务占据注意，累被遮蔽（"顾不上"）；一闲下来，内感受
//     （interoception）浮上来，同样的债体感更强。所以这一层的实现是**措辞的
//     门控**（sense 里分忙/闲两档），不是偷偷把 fatigue 调高 —— 调高会污染账本，
//     下一次决策读到的就是假数据。
//
// 【主观】
//   · 她读到的必须是"感觉"而不是"模式"。所以 sense() 只出第一人称的短句
//     （"半睡着，眼皮沉" / "手上没什么事，乏劲就浮上来了"），
//     数字（level/mode）只出现在 snapshot() 里给面板和测试用。
//   · 假睡被叫醒时，她要能说出"刚才有点迷糊"——这条进 history，也进 sense 的一瞬。
//
// ══════════════════════════════════════════════════════════════════════
// 分层（别把这条拆了）
// ══════════════════════════════════════════════════════════════════════
//   · tick() / touch() / onWake()：**写**。只在唯一节拍（心跳）和外部事件里调。
//   · sense() / snapshot() / isDoze()：**纯读**。装配提示词每轮都会调，
//     它们不能演化、不能落盘 —— 否则"读一眼状态"就会改她的身体
//     （field.peekValence 的注释里记过同一条教训）。
//   · 执行（spawn nightwork tidy / 切状态）不在这里：器官只说"该做了"
//     （tick 返回 tidy:true），做不做、怎么做出编排层决定（body.mjs）。
//     这是 2026-11-04 门禁抓到的「分层反向依赖」的同一条线。
import { readJson, mutateJson } from '../json.mjs'
import { dataPath } from '../../lib/paths.mjs'
import { swallow } from '../../lib/swallow.mjs'
import * as field from '../field.mjs'
import * as sleepstage from './sleepstage.mjs'

const MIN = 60_000
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))

/**
 * 判定参数。所有阈值都是**行为口径**，不是"看起来差不多"：
 * 改了任何一个，test/brain-wakefulness-test.mjs 里的行为断言必须仍然成立。
 */
export const RULES = {
  // 保持清醒：高于它 = 醒着。醒来之后 burst 也直接把 level 顶到这里之上。
  awakeAt: 0.42,
  // 允许假睡：低于它才可能进 doze。比 awakeAt 低 0.12 —— 这条带子是滞回，
  // 不是"两个阈值看起来专业"。没有它，level 在 0.41 附近每 30 秒翻一次档。
  dozeAt: 0.30,
  // 多久没有外部输入才算"闲下来"。20 分钟：比一次对话的自然停顿长，
  // 比"一下午没事"短 —— 短了会把"他在想怎么回"当成"她闲了"。
  idleMin: 20,
  // 醒来后强制清醒多久。45 分钟：正好覆盖"刚醒的迷糊 + 起床后的清醒期"。
  wakeBurstMin: 45,
  // 假睡最长多久。90 分钟：超过就不是"假睡"了，是缺一次真睡 ——
  // 必须退出，否则她用假睡把真睡永久顶掉（债永远清不干净）。
  dozeMaxMin: 90,
  // 假睡退出后的冷却：至少再撑 25 分钟才允许再进去（防"A 进 A 出"抖）。
  dozeCooldownMin: 25,
  // 工作量（activity）的记忆长度。35 分钟：一顿饭/一段对话的尺度。
  activityTauMin: 35,
  // 一条消息 / 一次自主行动对工作量的贡献。
  msgActivity: 0.35,
  actActivity: 0.18,
  // 对应的 NE 相位性脉冲（化学层）。消息更强：有人叫 = 蓝斑放电。
  msgNe: 0.12,
  actNe: 0.04,
  // 醒来那一下的 NE 脉冲（蓝斑 + CAR 的合计效果）。
  wakeNe: 0.18,
  // 醒来时的 level 下限（"一起来就清醒"的阶跃高度）。
  wakeLevel: 0.62,
  // 假睡的恢复效率：浅睡不是深睡。还债按 0.35 倍有效睡眠算；
  // 同时腺苷仍在产生，只是慢 —— 清醒累积速率按 0.25 倍。
  dozeRepayFactor: 0.35,
  dozeAccrueFactor: 0.25,
  // 假睡自维护（nightwork tidy）的节流：90 分钟一次。
  // 为什么必须节流：tidy 要调 LLM 抽取，一次几十秒；假睡是"空闲"，不是"加班"。
  tidyEveryMin: 90,
  // 欠觉到这条线就不假睡了 —— 该真睡。**必须与 night.RULES.debtSleepAt 一致**；
  // 这里不 import night（night → wakefulness 已经是静态依赖，反向会成环），
  // 改由测试断言两者相等（test/brain-wakefulness-test.mjs ⑦）。
  dozeSkipDebtAt: 0.7,
}

const STATE = () => dataPath('wakefulness.json')

const empty = () => ({
  at: 0,
  mode: 'awake',            // awake | doze | sleep（sleep 只是镜像，睡眠分期说了算）
  since: 0,
  level: 0.55,
  activity: 0.35,
  lastInputAt: 0,
  burstUntil: 0,            // 醒来后强制清醒到什么时候
  cooldownUntil: 0,         // 退出假睡后的冷却
  doze: { beganAt: 0, minutes: 0, lastRepayMin: 0 },
  lastTidyAt: 0,            // 跨 doze 的 tidy 节流（不随 doze 重置）
  lastDebt: 0,              // 最近一次 tick 看到的账（sense 纯读要用）
  lastFatigue: 0,
  wake: null,               // 最近一次醒来 {at, cause, from}
  history: [],              // [{at, from, to, why, level}] —— 最多 30 条
})

function hydrate(raw) {
  const st = { ...empty(), ...(raw || {}) }
  st.doze = { ...empty().doze, ...(st.doze || {}) }
  st.history = Array.isArray(st.history) ? st.history.slice(-30) : []
  st.level = clamp(st.level, 0, 1)
  st.activity = clamp(st.activity, 0, 1)
  return st
}

function decay(v, dtMin) {
  const a = clamp(v, 0, 1)
  const tau = Number(RULES.activityTauMin) || 35
  return clamp(a * Math.exp(-Math.max(0, dtMin) / tau), 0, 1)
}

/**
 * 清醒度的**算法本体**（纯函数，可测）。
 *
 * 形状：
 *   level = (0.10 + 0.45·NE + 0.40·工作量) × (1 - 0.6·睡眠债)
 *
 * 为什么是乘性天花板而不是减去债务：腺苷不是"抵消一点清醒"，
 * 它是把整个觉醒系统的**上限**压下来 —— 欠觉的人再怎么忙也到不了满格。
 * 反过来，债为 0 时 (1-0) = 1，忙起来就能到 0.95。
 *
 * 常数怎么定的（用行为反推，不是拍脑袋）：
 *   · 忙（activity 0.9 / NE 0.55 / debt 0.4）→ 0.62：高于 awakeAt，清醒。
 *   · 闲 35 分钟（activity 0.33 / NE 0.35 / debt 0.4）→ 0.30：进 doze 的门口。
 *   · 债低（0.1）且闲 → 0.35：高于 dozeAt，不假睡 —— 不困的人不该半睡。
 *   · 债高（0.7）且闲 → 0.18：低于 dozeAt，但那时应该真睡（看 tick 的 skip）。
 */
export function levelOf({ ne = 0.35, activity = 0, debt = 0 } = {}) {
  const ceiling = 1 - 0.6 * clamp(debt, 0, 1)
  return clamp((0.10 + 0.45 * clamp(ne, 0, 1) + 0.40 * clamp(activity, 0, 1)) * ceiling, 0, 1)
}

/** 读身体（这里只读，演化由心跳统一推进）。 */
function bodyNow(now) {
  let ne = 0.35, debt = 0, fatigue = 0
  try {
    const snap = field.snapshot(now)
    ne = Number(snap?.dims?.ne ?? 0.35)
    debt = Number(snap?.dims?.sleepDebt ?? 0)
    fatigue = Number(snap?.dims?.fatigue ?? 0)
  } catch (e) { swallow(e, 'wakefulness:body') }
  return { ne, debt, fatigue }
}

function inSleepNow(now) {
  try { return !!sleepstage.snapshot(now).inSleep } catch (e) { swallow(e, 'wakefulness:inSleep'); return false }
}

function pushHistory(st, from, to, why, now) {
  st.history = [...(Array.isArray(st.history) ? st.history : []), {
    at: now, from, to, why: String(why || '').slice(0, 60), level: Number((st.level || 0).toFixed(3)),
  }].slice(-30)
}

/** 同一份状态里完成"醒来"（不再单独开一次文件写）。 */
function wakeInPlace(st, now, cause, { burst = true } = {}) {
  const from = st.mode
  st.mode = 'awake'
  st.since = now
  st.level = Math.max(Number(st.level || 0), RULES.wakeLevel)
  // 不改 activity：工作量只由**外部输入**决定（消息 / 她自己的行动）。
  // 第一版在这里把 activity 抬到 0.55，结果"刚醒"和"忙着"的措辞互相覆盖，
  // 她一睁眼就说"手上有事撑着"——醒来这件事实被自己的副作用盖掉了。
  if (burst) st.burstUntil = now + RULES.wakeBurstMin * MIN
  st.doze = { ...empty().doze }
  st.wake = { at: now, cause: String(cause || '').slice(0, 40), from }
  pushHistory(st, from, 'awake', cause || '醒来', now)
  return st
}

/**
 * 一拍。返回编排层要执行的副作用（它自己不动手 —— 见文件头"分层"）。
 *
 * @returns {{mode:string, level:number, enteredDoze:boolean, leftDoze:boolean,
 *            woke:boolean, tidy:boolean, repayMin:number, why:string}}
 */
export function tick(now = Date.now()) {
  const t = Number(now) || Date.now()
  const b = bodyNow(t)
  const inSleep = inSleepNow(t)
  const out = {
    at: t, mode: 'awake', level: 0, activity: 0, idleMin: 0,
    enteredDoze: false, leftDoze: false, woke: false, tidy: false, repayMin: 0, why: '',
  }

  const saved = mutateJson(STATE(), empty(), (cur) => {
    const st = hydrate(cur)
    // dt 用真实间隔；停机一整天回来不该一次性衰减 24 小时（机器停了不等于她活了）。
    let dtMin = st.at ? (t - Number(st.at)) / MIN : 0
    if (!(dtMin > 0)) dtMin = 0
    if (dtMin > 180) dtMin = 180
    st.activity = decay(st.activity, dtMin)
    st.at = t
    if (!st.lastInputAt) st.lastInputAt = t
    if (!st.since) st.since = t          // 首次落盘：档位从此刻开始算（否则面板显示 1970）
    st.lastDebt = Number((b.debt || 0).toFixed(4))
    st.lastFatigue = Number((b.fatigue || 0).toFixed(4))
    const idleMin = (t - Number(st.lastInputAt)) / MIN
    st.level = levelOf({ ne: b.ne, activity: st.activity, debt: b.debt })

    // ── 真睡：只镜像，不抢睡眠分期的权 ──────────────────────────────
    if (inSleep) {
      if (st.mode !== 'sleep') {
        pushHistory(st, st.mode, 'sleep', '真睡（睡眠分期在管）', t)
        st.mode = 'sleep'
        st.since = t
        st.doze = { ...empty().doze }
      }
      out.mode = 'sleep'
      out.why = '真睡中'
      return st
    }
    // 从真睡回来（看门狗直接 stage.wake 时不经过 night.endSleep → 这里兜底）。
    if (st.mode === 'sleep') {
      wakeInPlace(st, t, '睡醒了', { burst: true })
      out.woke = true
      out.why = '睡眠分期已经醒了 → 立刻回到清醒'
    }

    const burst = t < Number(st.burstUntil || 0)
    const cooling = t < Number(st.cooldownUntil || 0)

    // ── 假睡的恢复与退出 ──────────────────────────────────────────
    if (st.mode === 'doze') {
      const dm = Math.max(0, (t - Number(st.doze.beganAt || t)) / MIN)
      st.doze.minutes = Number(dm.toFixed(1))
      // 恢复按 5 分钟一档结算，避免每拍一次 field 写盘
      while (Number(st.doze.lastRepayMin || 0) + 5 <= dm) {
        st.doze.lastRepayMin = Number(st.doze.lastRepayMin || 0) + 5
        out.repayMin += 5
      }
      // 自维护：假睡期间那条通道要在跑（节流在这里判，外部再判一次也无害）
      if (t - Number(st.lastTidyAt || 0) >= RULES.tidyEveryMin * MIN) {
        st.lastTidyAt = t
        out.tidy = true
      }
      const high = st.level > RULES.awakeAt
      const timeout = dm >= RULES.dozeMaxMin
      const called = burst      // 被外部叫醒后 burstUntil 已经设好（touch 里也会直接改档）
      if (high || timeout || called) {
        const why = high ? '清醒度回到阈值之上'
          : timeout ? '假睡到点（' + Math.round(dm) + ' 分钟），该撑一段了'
            : '被叫醒'
        st.mode = 'awake'
        st.since = t
        st.cooldownUntil = timeout ? t + RULES.dozeCooldownMin * MIN : Number(st.cooldownUntil || 0)
        st.doze = { ...empty().doze }
        pushHistory(st, 'doze', 'awake', why, t)
        out.leftDoze = true
        out.why = why
      }
    } else if (!burst && !cooling && idleMin >= RULES.idleMin && st.level <= RULES.dozeAt) {
      // ── 进入假睡 ────────────────────────────────────────────────
      if (b.debt >= RULES.dozeSkipDebtAt) {
        // 欠觉到这个程度不是"半睡"能修的 —— 交给 night.assess 走真睡。
        out.why = '欠觉到该真睡了，不假睡'
      } else {
        st.mode = 'doze'
        st.since = t
        st.doze = { beganAt: t, minutes: 0, lastRepayMin: 0 }
        pushHistory(st, 'awake', 'doze', '闲下来了（level ' + st.level.toFixed(2) + '）', t)
        out.enteredDoze = true
        out.why = '闲下来了 → 假睡'
        // 进假睡立刻启动一次自维护（若距上次 ≥ 节流窗）——用户要的"一边启动
        // 睡眠时的自维护通道"。
        if (t - Number(st.lastTidyAt || 0) >= RULES.tidyEveryMin * MIN) {
          st.lastTidyAt = t
          out.tidy = true
        }
      }
    } else if (cooling && idleMin >= RULES.idleMin && st.level <= RULES.dozeAt) {
      out.why = '刚假睡过，先撑一会儿'
    }

    out.mode = st.mode
    out.level = Number(st.level.toFixed(3))
    out.activity = Number(st.activity.toFixed(3))
    out.idleMin = Math.round(idleMin)
    return st
  })

  if (!saved) {
    // 拿不到锁：这一拍不改状态，也不假装改了（返回读到的真实值）。
    const st = hydrate(readJson(STATE(), null))
    return { ...out, mode: st.mode, level: Number(st.level || 0), why: '状态文件被占用，这一拍没写' }
  }
  return out
}

/**
 * 外部输入（消息 / 她自己的行动）→ 工作量 + NE 脉冲；假睡中直接叫醒。
 *
 * 为什么消息是"叫醒"而不是"路过看看"：生物学上主人的声音对 owner 通道
 * 几乎是全通（thalamus 的 owner 阈值就是按这个定的）。假睡保留主通道的意思
 * 就是这条消息必须能把她从 N1 拉回 awake，而不是让她"梦见自己在回话"。
 */
export function touch(kind = 'message', o = {}) {
  const t = Number(o.now) || Date.now()
  const w = Number(o.weight ?? 1)
  const isMsg = kind === 'message'
  const out = { mode: 'awake', level: 0, woke: false, why: '' }
  const saved = mutateJson(STATE(), empty(), (cur) => {
    const st = hydrate(cur)
    let dtMin = st.at ? (t - Number(st.at)) / MIN : 0
    if (!(dtMin > 0)) dtMin = 0
    if (dtMin > 180) dtMin = 180
    st.activity = decay(st.activity, dtMin)
    st.at = t
    st.lastInputAt = t
    st.activity = clamp(st.activity + (isMsg ? RULES.msgActivity : RULES.actActivity) * (Number.isFinite(w) ? w : 1), 0, 1)

    if (st.mode === 'doze') {
      // 先算 level（用当前身体），再醒来 —— 醒来会把它顶到 wakeLevel
      const b = bodyNow(t)
      st.level = levelOf({ ne: Number(b.ne || 0.35) + (isMsg ? RULES.msgNe : RULES.actNe), activity: st.activity, debt: b.debt })
      wakeInPlace(st, t, isMsg ? '有人叫我' : '有事要做了', { burst: true })
      out.woke = true
    } else if (st.mode === 'sleep') {
      // 真睡期间的外部输入：只记工作量与叫醒意图，**不替睡眠分期改状态**
      // （inSleep 由 sleepstage 管；这里的 burst 会在醒来那一刻生效）。
      st.burstUntil = Math.max(Number(st.burstUntil || 0), t + RULES.wakeBurstMin * MIN)
    } else {
      const b = bodyNow(t)
      st.level = levelOf({ ne: Number(b.ne || 0.35) + (isMsg ? RULES.msgNe : RULES.actNe), activity: st.activity, debt: b.debt })
      // 忙碌时醒着 = 维持；顺手把 burst 刷新到"这次输入之后 45 分钟"，
      // 让"工作量大就一直清醒"是算出来的，不是特判的。
      st.burstUntil = Math.max(Number(st.burstUntil || 0), t + RULES.wakeBurstMin * MIN)
    }
    out.mode = st.mode
    out.level = Number(st.level.toFixed(3))
    out.why = out.woke ? '被叫醒' : '活动 +' + (isMsg ? RULES.msgActivity : RULES.actActivity)
    return st
  })
  // 化学：相位性 NE 脉冲。放在锁外，避免在状态锁里再去抢 field 的锁。
  try { field.poke('ne', isMsg ? RULES.msgNe : RULES.actNe, { why: 'wakefulness:' + kind, now: t }) } catch (e) { swallow(e, 'wakefulness:touch-ne') }
  if (!saved) return { ...out, mode: 'awake', level: 0, why: '状态文件被占用' }
  return out
}

/**
 * 真睡醒来时的阶跃（"一起来就清醒"）。
 *
 * 调用点：night.endSleep（自然/手动结算）与 sleepstage 看门狗的直接结算
 * （后者由 tick 的兜底覆盖）。化学上这里是蓝斑放电 + CAR 的合成效果：
 * level 直接顶到 wakeLevel，NE 给一记脉冲，burst 45 分钟。
 */
export function onWake(now = Date.now(), o = {}) {
  const t = Number(now) || Date.now()
  const out = { mode: 'awake', level: 0, woke: false }
  const saved = mutateJson(STATE(), empty(), (cur) => {
    const st = hydrate(cur)
    const b = bodyNow(t)
    // 同样不抬 activity（见 wakeInPlace 的注释）：醒来是清醒度的事，不是工作量的事。
    st.level = Math.max(levelOf({ ne: Number(b.ne || 0.35), activity: st.activity, debt: b.debt }), RULES.wakeLevel)
    wakeInPlace(st, t, o.cause ? String(o.cause) : '睡醒了', { burst: true })
    out.mode = st.mode
    out.level = Number(st.level.toFixed(3))
    out.woke = true
    return st
  })
  try { field.poke('ne', RULES.wakeNe, { why: 'wakefulness:wake', now: t }) } catch (e) { swallow(e, 'wakefulness:wake-ne') }
  return saved ? out : { ...out, why: '状态文件被占用' }
}

/* ── 纯读接口：装配/决策每轮都会调，绝不许演化或落盘 ───────────────── */

export function read() {
  return hydrate(readJson(STATE(), null))
}

/** 此刻是不是假睡（self.decide 用：半睡时不该挑正事）。 */
export function isDoze() {
  try { return read().mode === 'doze' } catch { return false }
}

/** 第一人称的一句（走 organs/senses → field.sense → assemble 的【身体】行）。 */
export function sense(now = Date.now()) {
  try {
    const st = read()
    if (st.mode === 'sleep') return ''
    if (st.mode === 'doze') {
      // 精神学：N1 浅睡还能接住一句话，但组织不了长回答 —— 这句是她的体验，
      // 不是"请简短回复"的指令（指令由装配层的措辞去承接）。
      return '半睡着，眼皮沉，能听见动静，但反应慢半拍'
    }
    const t = Number(now) || Date.now()
    const idleMin = st.lastInputAt ? (t - Number(st.lastInputAt)) / MIN : 999
    const level = Number(st.level || 0)
    const debt = Number(st.lastDebt || 0)
    const fatigue = Number(st.lastFatigue || 0)
    // 心理学反向：忙着的时候注意在外，累被遮蔽。不是不累，是"顾不上"。
    // ⚠ 必须排在"刚醒"之前：刚醒 + 忙 的组合里，"顾不上"信息量更大；
    //   反过来会把刚醒的 45 分钟全说成"脑子还有点跳"，忙得有债的事实就丢了。
    if (Number(st.activity || 0) >= 0.55 && (debt > 0.2 || fatigue > 0.25)) {
      return '手上有事撑着，累是累，一时顾不上'
    }
    if (t < Number(st.burstUntil || 0)) {
      // 刚醒的 45 分钟：醒来是阶跃的，但"亮"还在慢慢落。
      // ⚠ burstUntil 也被"忙"刷新（连续消息会把清醒窗一直续上），所以措辞必须看
      // **真正的醒来时刻** st.wake.at —— 否则她一整天在聊天时都会被告知"刚醒不久"，
      // 那是一句假话，而且会把"忙"错说成"刚起"。
      const wakeAt = Number(st.wake?.at || 0)
      const wokeRecently = wakeAt > 0 && t - wakeAt < RULES.wakeBurstMin * MIN
      if (wokeRecently) {
        const leftMin = Math.round((Number(st.burstUntil) - t) / MIN)
        return '人是清醒的，脑子还有点亮' + (leftMin > 25 ? '（刚醒不久）' : '')
      }
    }
    // 心理学：闲下来时内感受浮上来 —— 同样的债，体感更强。
    // 只有真的欠着/乏着才说，债低时说"乏"是无中生有。
    if (idleMin >= RULES.idleMin && level < RULES.awakeAt && (debt > 0.2 || fatigue > 0.25)) {
      return '手上没什么事，乏劲就浮上来了'
    }
    return ''
  } catch { return '' }
}

/** 面板/体检（纯读）。 */
export function snapshot(now = Date.now()) {
  const st = read()
  const t = Number(now) || Date.now()
  const idleMin = st.lastInputAt ? Math.max(0, (t - Number(st.lastInputAt)) / MIN) : 0
  return {
    mode: st.mode,
    level: Number(Number(st.level || 0).toFixed(3)),
    activity: Number(Number(st.activity || 0).toFixed(3)),
    idleMin: Math.round(idleMin),
    burstLeftMin: st.burstUntil > t ? Math.round((Number(st.burstUntil) - t) / MIN) : 0,
    cooldownLeftMin: st.cooldownUntil > t ? Math.round((Number(st.cooldownUntil) - t) / MIN) : 0,
    dozeMin: Number(st.mode === 'doze' ? st.doze.minutes : 0),
    debt: Number(st.lastDebt || 0),
    fatigue: Number(st.lastFatigue || 0),
    wake: st.wake || null,
    history: st.history.slice(-8),
    rules: {
      awakeAt: RULES.awakeAt, dozeAt: RULES.dozeAt, idleMin: RULES.idleMin,
      wakeBurstMin: RULES.wakeBurstMin, dozeMaxMin: RULES.dozeMaxMin,
    },
  }
}
