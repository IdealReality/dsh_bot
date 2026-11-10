// qq-gateway —— QQ 网关（SnowLuma）的地址/令牌解析 + 历史键名迁移
//
// ══════════════════════════════════════════════════════════════════════
// 为什么单独一个文件（2026-11-07）
// ══════════════════════════════════════════════════════════════════════
// 网关一直是 **SnowLuma**（OneBot v11 兼容层）。但早期项目接的是另一套
// 实现，配置键沿用了 `napcat_*`，于是全仓 20 多处、面板、README、启动日志
// 都在说 NapCat —— 实际容器里根本没有 NapCat。
//
// 这不是"名字不好看"，是**会误导排障**：
//   · 看到 `napcat_http: MISSING` 会去查 NapCat 装没装（它本来就不该在）；
//   · 看到 `napcat_launcher: D:/SnowLuma/...` 会以为两个东西并存。
//
// 所以改名的同时做两件事：
//   ① 统一入口：所有读取都走 gatewayBase()/gatewayToken()，不再各文件自己写
//      `cfg.qq?.xxx || 'http://127.0.0.1:3000'`（默认值散落 = 改一处漏三处）。
//   ② 就地迁移：启动时把旧键搬到新键并从配置文件里删掉，备份原文件。
//      跑过一次之后，**用户的配置文件里再没有旧键**；
//      源码里只剩本文件的 LEGACY_MAP 一处（门禁强制，防回流）。
//
// 环境变量同理：新名 SNOWLUMA_ACCESS_TOKEN，旧名只在迁移窗口读一次。
import fs from 'node:fs'
import { configPath } from '../infra/paths.mjs'
import { swallow } from '../infra/swallow.mjs'

/** 旧键 → 新键。**本文件是全仓唯一允许出现旧键名的地方**（scripts/check.mjs 强制）。 */
const LEGACY_MAP = {
  napcat_http: 'snowluma_http',
  napcat_token: 'snowluma_token',
  napcat_launcher: 'snowluma_launcher',
  napcat_qr_path: 'snowluma_qr_path',
}

const DEFAULT_BASE = 'http://127.0.0.1:3000'

/** 出站 API 基址（SnowLuma 的 OneBot HTTP 服务器）。 */
export function gatewayBase(cfg) {
  const q = cfg?.qq || {}
  const v = q.snowluma_http || q[LEGACY_MAP.napcat_http] || DEFAULT_BASE
  return String(v).replace(/\/+$/, '')
}

/** 出站鉴权 token（SnowLuma 开了 accessToken 时必须带，否则发送全 401）。 */
export function gatewayToken(cfg) {
  const q = cfg?.qq || {}
  const legacyEnv = process.env[String(LEGACY_MAP.napcat_token).toUpperCase() + '_ACCESS_TOKEN']
  return String(
    q.snowluma_token || q.accessToken || q[LEGACY_MAP.napcat_token]
    || process.env.SNOWLUMA_ACCESS_TOKEN || legacyEnv || ''
  )
}

/** 启动器（仅 Windows 桌面部署用；Linux 上由 systemd/entry.sh 管）。 */
export function gatewayLauncher(cfg) {
  const q = cfg?.qq || {}
  return String(q.snowluma_launcher || q[LEGACY_MAP.napcat_launcher] || '')
}

/** 登录二维码缓存路径。 */
export function gatewayQrPath(cfg) {
  const q = cfg?.qq || {}
  return String(q.snowluma_qr_path || q[LEGACY_MAP.napcat_qr_path] || '')
}

/**
 * 把配置文件里的旧键搬到新键，并删除旧键。
 *
 * 为什么"删"而不是"留着兼容"：留着就等于永远有两套名字，
 * 下次排障还是会被误导。迁移只发生一次，之后配置里只有新键。
 * 原文件先备份（同目录 `.bak-<时间戳>`），删错了能捡回来。
 *
 * @returns {{moved:string[], backup:string|null, error?:string}}
 */
export function migrateConfigFile(file = configPath) {
  const out = { moved: [], backup: null }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    if (e?.code !== 'ENOENT') out.error = String(e?.message || e).slice(0, 120)
    return out
  }
  const q = raw && typeof raw === 'object' ? (raw.qq || null) : null
  if (!q || typeof q !== 'object') return out

  for (const [oldKey, newKey] of Object.entries(LEGACY_MAP)) {
    if (!(oldKey in q)) continue
    if (q[newKey] === undefined) q[newKey] = q[oldKey]
    delete q[oldKey]
    out.moved.push(`${oldKey}→${newKey}`)
  }
  if (!out.moved.length) return out

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
    out.backup = `${file}.bak-${stamp}`
    fs.copyFileSync(file, out.backup)
    try { fs.chmodSync(out.backup, 0o600) } catch { /* 备份权限不是关键 */ }
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(raw, null, 1) + '\n', { mode: 0o600 })
    fs.renameSync(temp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* 同上 */ }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120)
    swallow(e, 'qq-gateway:migrate')
  }
  return out
}

/**
 * 启动时一步到位：迁移旧键 → 解析基址/令牌 → 打一行配置来源日志。
 * 编排层只需要 const gw = bootGateway(QQ, log)。
 */
export function bootGateway(qq = {}, log = () => {}, file = configPath) {
  const mg = migrateConfigFile(file)
  try {
    if (mg.moved?.length) log('[qq] 配置已迁移：' + mg.moved.join(' ') + (mg.backup ? ' · 备份 ' + mg.backup : ''))
    else if (mg.error) log('[qq] 配置迁移跳过：' + mg.error)
  } catch { /* 日志失败不挡启动 */ }
  // ⚠️ 必须读**迁移后的原始配置**，不能用调用方传进来的合并对象。
  // 实测踩到的坑：config() 已经把 DEFAULTS.snowluma_http（3000）合并进来，
  // 于是 gatewayBase 的"新键优先"读到的是默认值，把用户旧键里的真实地址
  // （172.17.0.1:3010）遮掉了 —— 首次迁移启动会连到错误端口。
  let user = {}
  try { user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).qq || {} } catch { user = {} }
  const merged = { ...(qq || {}), ...user }
  const base = gatewayBase({ qq: merged })
  const token = gatewayToken({ qq: merged })
  try { log('[qq] config: ' + file + ' · 网关(SnowLuma): ' + base + ' · token: ' + (token ? 'set' : 'MISSING')) } catch { /* 同上 */ }
  return { base, token, migrated: mg.moved || [], backup: mg.backup }
}
