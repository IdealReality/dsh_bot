// sensory-gain —— 用已有的器官细胞，组装一只「感觉增益」组织。
//
// 这不是新造一套情绪模型（那会变成第三份真相）。它只做一件事：
// **把现成的细胞读数，翻译成视听前端的采样参数**。
//
// 细胞（全部是仓库里已有的、正在跑的东西）：
//   brain/field.cognitiveDepth   此刻能想多深（睡眠债/疲劳/血清素）
//   brain/field.patience         能等多久（急不急）
//   brain/field.irritability     有多冲（皮质醇/血清素/唤醒）
//   brain/organ/metabolism       血糖（energy）
//   brain/field dims.ne          唤醒（亢奋）
//
// 组织（这一层）把它们并成四档「看片姿态」：
//   conserve 省电：脑力低/血糖低 → 2Hz、2 段、2 张、只听前 60 秒
//   alert    警觉：唤醒高/烦躁高 → 8Hz 采样但只看关键（3 段）
//   relaxed  有闲心：脑力高 + 血糖足 + 不烦 → 8Hz、5 段、5 张、看久一点
//   normal   日常：4Hz、4 段、4 张
//
// ⚠️ 诚实声明：这是**启发式映射**，不是生理仿真。依据是"人累的时候确实看得粗、
//    急的时候抓关键、有闲心时才细看"这种可观察规律，不是某条神经通路。
//    所以每一档都带一句 why（进日志），参数永远可被显式覆盖（测试/手动）。
//
// 失败方向：任何读不到 → 回 normal。身体感坏了不该连带视频也看不成。
import { swallow } from './swallow.mjs'

/** 四档参数（显式常量，方便测试与调参）。 */
export const PROFILES = {
  conserve: { fps: 2, maxEvents: 2, maxFrames: 2, maxAnalyzeSec: 45, maxAudioSec: 60 },
  alert: { fps: 8, maxEvents: 3, maxFrames: 4, maxAnalyzeSec: 90, maxAudioSec: 120 },
  relaxed: { fps: 8, maxEvents: 5, maxFrames: 5, maxAnalyzeSec: 180, maxAudioSec: 240 },
  normal: { fps: 4, maxEvents: 4, maxFrames: 4, maxAnalyzeSec: 120, maxAudioSec: 180 },
}

const clamp01 = (v, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : dflt
}

/**
 * 读细胞（可注入，测试用）。
 * @param {{field?:object, metabolism?:object}} deps
 * @returns {Promise<{depth:number, patience:number, irritability:number, ne:number, energy:number, stress:number, source:string}>}
 */
export async function readFactors(deps = {}) {
  const out = { depth: 0.6, patience: 0.6, irritability: 0.25, ne: 0.4, energy: 0.5, stress: 0.2, source: 'fallback' }
  try {
    const F = deps.field || await import('../brain/field.mjs')
    const st = F.evolve()
    out.depth = clamp01(F.cognitiveDepth(st), out.depth)
    out.patience = clamp01(F.patience(st), out.patience)
    out.irritability = clamp01(F.irritability(st), out.irritability)
    out.ne = clamp01(st?.dims?.ne, out.ne)
    out.stress = clamp01(st?.dims?.cortisol, out.stress)
    out.source = 'live'
  } catch (e) { swallow(e, 'sensory-gain:field') }
  try {
    const M = deps.metabolism || await import('../brain/organ/metabolism.mjs')
    const snap = M.snapshot?.()
    if (snap && Number.isFinite(Number(snap.energy))) { out.energy = clamp01(snap.energy, out.energy); out.source = 'live' }
  } catch (e) { swallow(e, 'sensory-gain:metabolism') }
  return out
}

/**
 * 组装：细胞读数 → 采样参数。
 * @param {{factors?:object, field?:object, metabolism?:object}} [deps]
 *   factors 直接给读数（跳过器官），用于测试与手动覆盖。
 * @returns {Promise<{profile:string, fps:number, maxEvents:number, maxFrames:number,
 *   maxAnalyzeSec:number, maxAudioSec:number, why:string, factors:object}>}
 */
export async function sensoryGain(deps = {}) {
  const f = deps.factors ? { ...(await readFactors({ field: null, metabolism: null })), ...deps.factors, source: 'injected' } : await readFactors(deps)
  const pick = (name, why) => ({
    profile: name,
    ...PROFILES[name],
    why,
    factors: f,
  })
  const pct = (v) => (Math.round(Number(v) * 100) / 100).toFixed(2)

  // ① 省电：脑力见底或血糖低 —— 人这时候确实只看个大概。
  if (f.depth < 0.35 || f.energy < 0.25) {
    return pick('conserve', `省电：脑力 ${pct(f.depth)}·血糖 ${pct(f.energy)} → 只抓事件边界（2 段/2 张，只分析前 45 秒）`)
  }
  // ② 警觉：亢奋或烦躁 —— 采样加密（反应快），但不细看（不耐烦）。
  if (f.ne > 0.7 || f.irritability > 0.6) {
    return pick('alert', `警觉：唤醒 ${pct(f.ne)}·烦躁 ${pct(f.irritability)} → 采样加密但只看关键（3 段）`)
  }
  // ③ 有闲心：脑力足 + 血糖足 + 不烦 —— 愿意多看几段。
  if (f.depth > 0.7 && f.energy > 0.5 && f.irritability < 0.35) {
    return pick('relaxed', `有闲心：脑力 ${pct(f.depth)}·血糖 ${pct(f.energy)}·烦躁 ${pct(f.irritability)} → 多看一点（5 段/5 张）`)
  }
  return pick('normal', `日常：脑力 ${pct(f.depth)}·血糖 ${pct(f.energy)}·烦躁 ${pct(f.irritability)} → 4 段/4 张`)
}

/**
 * 把增益合并进 watch 的参数：**调用方显式给的优先**（测试与手动覆盖不被情绪改掉）。
 * @param {object} o 已合并的 watch 选项
 * @param {object} g sensoryGain() 结果
 * @param {object} opts 调用方原始 opts（用来判断"显式给了没"）
 */
export function applyGain(o, g, opts = {}) {
  if (!g) return o
  const has = (k) => Object.prototype.hasOwnProperty.call(opts, k)
  const out = { ...o }
  for (const k of ['fps', 'maxEvents', 'maxFrames', 'maxAnalyzeSec', 'maxAudioSec']) {
    if (!has(k)) out[k] = g[k]
  }
  return out
}
