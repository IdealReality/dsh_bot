// legacy-qq-keys —— 历史配置键名的**唯一**集中处（DSH 插件壳层）
//
// lib/ 不能 import tools/（分层门禁），所以 tools/lib/qq-gateway.mjs 的迁移表
// 无法直接复用。这里单独放一份"读旧键"的兼容层：
//   · 只读不写：面板/接口保存配置时一律写新键 snowluma_*；
//   · 迁移由 qq-server 启动时做（tools/lib/qq-gateway.migrateConfigFile），
//     跑过一次之后配置文件里就再没有旧键；
//   · 本文件被 scripts/check.mjs 列入"允许出现旧键名"的白名单，
//     其他源码出现即失败 —— 防止命名回流。
export const LEGACY_QQ_KEYS = {
  http: 'napcat_http',
  token: 'napcat_token',
  qr: 'napcat_qr_path',
  launcher: 'napcat_launcher',
}

/** SnowLuma 的 OneBot HTTP 基址（新键优先，旧键兜底）。 */
export function qqGateway(qq = {}) {
  const v = qq.snowluma_http || qq[LEGACY_QQ_KEYS.http] || 'http://127.0.0.1:3000'
  return String(v).replace(/\/+$/, '')
}

/** 登录二维码缓存路径（新键优先，旧键兜底）。 */
export function qqQrPath(qq = {}) {
  return String(qq.snowluma_qr_path || qq[LEGACY_QQ_KEYS.qr] || '')
}

/** SnowLuma 账号配置文件：snowluma_<QQ>.json（旧名 napcat_<QQ>.json 仍可识别）。 */
export const QQ_ACCOUNT_FILE_RE = /^(?:napcat|snowluma)_(\d+)\.json$/
