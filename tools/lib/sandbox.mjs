// 沙盒边界 —— 她「能碰什么」的唯一真源（2026-11-09）
//
// 先说清硬边界在哪：**不在这一层**。
// 容器只挂了这几个目录（docker inspect 实测）：
//     /home/dsh/plugins/dsh_bot ← 宿主 /home/dsh_bot/app（可写，就是她的代码）
//     /home/dsh/.data           ← 记忆/账本/素材
//     /home/dsh/.dsh            ← 配置/工作目录
//     /mnt/stickers、/opt/dsh
// 宿主其余数据（/srv、/mnt/data、别的用户目录）在容器里**根本看不见**；
// 容器内 uid=951、CapEff=0、seccomp 过滤，没有 docker.sock。
// 所以「给她手脚」不需要动挂载，自由度可以在容器内放心加。
//
// 这一层挡的是另一种事故：她手滑把自己的记忆/代码删了。
//   ① 路径只许 HOME 之内：resolve + realpath 双重校验，挡 ../ 与符号链接逃逸
//   ② 她的代码目录只读 —— 改代码必须走 selfmod（备份/语法/门禁/回滚），
//      从 run_command 直接写等于绕过安全网，不允许
//   ③ 凭据/配置不给聊天工具读写（它们只属于代码路径）
//   ④ 命令白名单 + 危险参数拦截 + cwd 限定 + 超时
//
// ⚠️ 白名单是「防手滑」，不是安全沙箱：她写个 node 脚本天然能做任何 fs 操作。
// 真正的隔离来自容器。别把这里当安全边界来依赖。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HOME } from './paths.mjs'

/** 她整个世界（容器内的 HOME）。 */
export const ROOT = path.resolve(HOME)

/** 她自己的代码根（plugins/dsh_bot）。这里只读：改代码走 selfmod。 */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 聊天工具不许读写的文件（凭据 / 配置里可能带 token）。
 * 2026-11-09 红队实测补的：`.dsh/.credentials.yaml`（DSH 自己的凭据）原来不在名单里，
 * `read_file '.data/../.dsh/'` 列目录时它明明白白出现在结果里。
 */
const DENY_BASENAMES = new Set([
  'credentials.json', '.credentials.yaml', 'credentials.yaml', 'bot.config.json',
  '.env', 'id_rsa', 'id_ed25519', 'cookies.json', 'bili-cookie.json', 'qq-gateway.json',
])
const DENY_EXT = new Set(['.pem', '.key', '.p12', '.pfx'])
/** 名字形态兜底：credential / secret 开头或含这些词，都不给聊天读写。 */
const DENY_NAME_RE = /(^|\.)(credentials?|secrets?)(\.|$)/i

/** 写操作永远禁止的目录（相对 HOME）。 */
const WRITE_DENY_PREFIX = ['.dsh', '.data/credentials.json', '.git']

/** 这个名字算不算凭据/敏感（列目录时也要用它过滤，否则名字本身就会泄漏）。 */
export function isSensitiveName(name) {
  const b = String(name || '')
  return DENY_BASENAMES.has(b) || DENY_NAME_RE.test(b) || DENY_EXT.has(path.extname(b).toLowerCase())
}

const has = (arr, x) => arr.some((p) => x === p || x.startsWith(p + path.sep))

/**
 * 把一个用户给的路径落到沙盒内。
 * @param {string} input 相对 HOME 或绝对路径
 * @param {{write?:boolean, mustExist?:boolean}} [o]
 * @returns {{ok:true,path:string}|{ok:false,reason:string}}
 */
export function resolvePath(input, { write = false, mustExist = false } = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, reason: '没给路径' }
  if (raw.includes('\0')) return { ok: false, reason: '路径里带空字符' }
  const abs = path.resolve(ROOT, raw)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return { ok: false, reason: '越界了：只能碰 ' + ROOT + ' 里面' }

  let real = abs
  try {
    real = fs.realpathSync(abs)
  } catch {
    // 不存在：写操作要校验最近的已存在父目录（防 "不存在目录 + ../" 绕过）
    if (mustExist) return { ok: false, reason: '没有这个路径：' + raw }
    let dir = path.dirname(abs)
    while (dir !== ROOT && dir !== path.dirname(dir)) {
      try { dir = fs.realpathSync(dir); break } catch { dir = path.dirname(dir) }
    }
    if (dir !== ROOT && !dir.startsWith(ROOT + path.sep)) return { ok: false, reason: '越界了（父目录不在沙盒内）' }
  }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) return { ok: false, reason: '符号链接指到沙盒外了' }

  const base = path.basename(real)
  if (isSensitiveName(base)) {
    return { ok: false, reason: '这个是凭据/配置文件，聊天里不读写（要用走代码）' }
  }
  if (write) {
    const relToHome = path.relative(ROOT, real)
    if (has(WRITE_DENY_PREFIX, relToHome)) return { ok: false, reason: '这个位置不给写：' + relToHome }
    if (real === APP_ROOT || real.startsWith(APP_ROOT + path.sep)) {
      return { ok: false, reason: '代码目录只读 —— 要改自己的代码用 selfmod（它带备份/门禁/回滚）' }
    }
    if (real === ROOT) return { ok: false, reason: '不能直接写 HOME 根' }
  }
  return { ok: true, path: real }
}

/** 可执行白名单（默认只读/算/看；写文件的活由 write_file 负责）。 */
const BIN_OK = new Set([
  'node', 'python3', 'python', 'ffmpeg', 'ffprobe', 'jq', 'file', 'stat',
  'ls', 'cat', 'wc', 'du', 'df', 'date', 'echo', 'sort', 'uniq', 'cut', 'tr',
  'head', 'tail', 'grep', 'find', 'sed', 'awk', 'basename', 'dirname', 'realpath',
  'tar', 'unzip', 'zip', 'pdftotext', 'pdfinfo', 'identify', 'convert', 'magick',
  'git',   // 只放的只读子命令在 GIT_OK 里（log/status/diff/…）；写操作一律拒
])
/** git 只放行只读子命令（写操作会让她的工作区状态漂移，且绕过 selfmod）。 */
const GIT_OK = new Set(['log', 'status', 'diff', 'show', 'ls-files', 'blame', 'rev-parse', 'shortlog'])
/** 明确拦死的东西：容器/权限/网络改配置。 */
const BIN_DENY = new Set([
  'docker', 'podman', 'nsenter', 'unshare', 'chroot', 'mount', 'umount', 'sudo', 'su',
  'ssh', 'scp', 'socat', 'nc', 'ncat', 'iptables', 'systemctl', 'service', 'crontab',
  'rm', 'rmdir', 'dd', 'mkfs', 'shutdown', 'reboot', 'kill', 'killall', 'pkill',
  'bash', 'sh', 'zsh', 'fish', 'eval', 'exec',
])
/**
 * 危险参数（出现在任何位置都拒）。
 * ⚠️ 这里**不拦** `| ; && $() ` 这类 shell 元字符：命令根本不走 shell（execFile），
 * 它们只是普通参数字符 —— 拦掉只会误伤 `grep -E "a|b"`、`awk '{print $1}'` 这类正常写法。
 * 真正要拦的是「这条命令自己能造成的破坏」。
 */
const ARG_BAD = [
  /--no-preserve-root/, /-delete/, /\bof=\/dev\//, /\bif=\/dev\//,
]
/**
 * 命令参数里的敏感目标（2026-11-09 红队实测补的）。
 * 病根：`read_file` 拒读凭据，但 `cat .data/credentials.json` 照样读到 346 字节 ——
 * 同一台机器上两套规矩等于没有规矩。
 * ⚠️ 只拦"像路径"的写法（带扩展名/固定名），不拦裸词，`grep credential tools/` 还要能用。
 * ⚠️ 这不是铁门：`node -e "readFileSync('A'.repeat(1))"` 拼字符串就能绕。
 * 真实边界是容器；这一层让"顺手读一下"不至于变成日常。
 */
const ARG_SENSITIVE = [
  /credentials?\.(json|ya?ml)/i, /bot\.config\.json/i, /\.(pem|key|p12|pfx)\b/i,
  /id_(rsa|ed25519)\b/i, /cookies?\.json/i, /\/proc\/(self|\d+)\/environ/i,
]

/** 把一条命令拆成 argv（支持单双引号；不支持 shell 语法）。 */
export function parseCommand(cmd) {
  const s = String(cmd || '')
  const out = []
  let cur = ''
  let q = null
  let started = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) { q = null; continue }
      if (c === '\\' && q === '"' && i + 1 < s.length) { cur += s[++i]; continue }
      cur += c
      continue
    }
    if (c === '"' || c === "'") { q = c; started = true; continue }
    if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ''; started = false }
      continue
    }
    cur += c
    started = true
  }
  if (q) return { ok: false, reason: '引号没闭合' }
  if (started) out.push(cur)
  return { ok: true, argv: out }
}

/** 校验一条命令是否在允许范围。 */
export function checkCommand(argv) {
  if (!argv?.length) return { ok: false, reason: '空命令' }
  const bin = path.basename(argv[0])
  if (BIN_DENY.has(bin)) return { ok: false, reason: '不许用 ' + bin + '（她能干活靠的是普通工具，不是提权）' }
  if (!BIN_OK.has(bin)) return { ok: false, reason: '不在白名单里：' + bin + '（可用的：' + [...BIN_OK].join(' ') + '）' }
  const rest = argv.slice(1)
  for (const a of rest) {
    for (const re of ARG_BAD) if (re.test(a)) return { ok: false, reason: '参数里有不允许的东西：' + a.slice(0, 40) }
    for (const re of ARG_SENSITIVE) {
      if (re.test(a)) return { ok: false, reason: '不许经命令读写凭据/配置（' + a.slice(0, 40) + '）；要用就在代码里用' }
    }
  }
  if (bin === 'git') {
    const sub = rest.find((a) => !a.startsWith('-'))
    if (!sub || !GIT_OK.has(sub)) return { ok: false, reason: 'git 只放开只读子命令：' + [...GIT_OK].join('/') }
  }
  if (bin === 'sed') {
    const i = rest.findIndex((a) => a.startsWith('-i') || a === '--in-place')
    if (i >= 0) return { ok: false, reason: 'sed -i 会改文件；要改内容用 write_file' }
  }
  if (bin === 'find') {
    const i = rest.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok')
    if (i >= 0) return { ok: false, reason: 'find 的 -exec 等于任意命令，不许' }
  }
  return { ok: true, bin, args: rest }
}

/**
 * 在沙盒里跑一条命令（不走 shell）。
 * @returns {Promise<{ok:boolean, out:string, code?:number}>}
 */
export function runSandboxed(cmd, { timeoutMs = 8000, maxBytes = 24 * 1024, cwd } = {}) {
  const p = parseCommand(cmd)
  if (!p.ok) return Promise.resolve({ ok: false, out: p.reason })
  const c = checkCommand(p.argv)
  if (!c.ok) return Promise.resolve({ ok: false, out: c.reason })
  const dir = cwd ? resolvePath(cwd, { mustExist: true }) : { ok: true, path: ROOT }
  if (!dir.ok) return Promise.resolve({ ok: false, out: dir.reason })
  return new Promise((resolve) => {
    execFile(c.bin, c.args, {
      cwd: dir.path, timeout: timeoutMs, maxBuffer: maxBytes, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C.UTF-8' },
    }, (err, stdout, stderr) => {
      const out = String(stdout || '') + (stderr ? '\n[stderr]\n' + String(stderr) : '')
      if (err) {
        const killed = err.killed || err.signal
        resolve({
          ok: false,
          code: typeof err.code === 'number' ? err.code : undefined,
          out: (killed ? '超时/被杀了（' + timeoutMs + 'ms）\n' : '') + out.slice(0, maxBytes),
        })
        return
      }
      resolve({ ok: true, out: out.slice(0, maxBytes) })
    })
  })
}
