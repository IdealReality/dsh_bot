// lib/env —— 环境变量统一入口（前缀 BOT_）
//
// 2026-11-02 改名 FEIYU_ → BOT_；2026-11-08 与上游插件彻底分离，
// 删掉了 FEIYU_* 的读写兼容层：现在**只有** BOT_* 生效，外部脚本若还写着
// 旧前缀会立刻暴露（启动即读到默认值），而不是静默半通。
//
// 这样做的代价是旧运维命令要一次性改完；收益是环境层不再有第二套命名，
// 不会再出现"某台机器设了旧名、另一台设了新名"的分叉。

const ALIAS = {
  // 数据与配置
  DATA_DIR: 'DATA_DIR',
  HOME: 'HOME',                 // 注意：这是 BOT_HOME，不是系统 HOME
  CONFIG: 'CONFIG',
  ROOT: 'ROOT',
  CLI: 'CLI',
  MJS: 'MJS',                   // 指向 tools/bot.mjs（旧 bot.mjs）
  NODE: 'NODE',
  PYTHON: 'PYTHON',
  // 开关
  DEBUG: 'DEBUG',
  NO_CACHE: 'NO_CACHE',
  TEST_SKIP_LEDGER: 'TEST_SKIP_LEDGER',
  BRAIN_MIRROR: 'BRAIN_MIRROR',
  // 服务
  PROXY: 'PROXY',
  INBOUND_TOKEN: 'INBOUND_TOKEN',
  BROWSER_URL: 'BROWSER_URL',
  TTS_PYTHON: 'TTS_PYTHON',
  ASR_PROXY_OK: 'ASR_PROXY_OK',
}

/**
 * 读一个环境变量。
 * @param {string} name 短名（不含前缀），例如 'DATA_DIR'
 * @param {string} [def] 默认值
 */
export function env(name, def = '') {
  const k = String(name || '').toUpperCase()
  const v = process.env['BOT_' + k]
  return v !== undefined && v !== '' ? v : def
}

/** 是否设置了。 */
export function hasEnv(name) {
  const k = String(name || '').toUpperCase()
  const v = process.env['BOT_' + k]
  return v !== undefined && v !== ''
}

/** 写环境变量（只写 BOT_ 前缀）。 */
export function setEnv(name, value) {
  const k = String(name || '').toUpperCase()
  process.env['BOT_' + k] = String(value)
  return value
}

export const KEYS = Object.keys(ALIAS)
