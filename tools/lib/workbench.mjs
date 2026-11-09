// workbench —— 她的手（2026-11-09）：找文件、读文件、写文件、跑命令。
//
// 病根（2026-11-09 实测，不是猜）：在 QQ 里让她"在本地找东西 / 写个脚本统计一下"，
// 她会**如实说做不到** —— 因为聊天工具清单里只有 9 个（记忆/上网/B站视频/日记），
// 没有一件能碰文件系统。她的 CLI 有 selfsrc/selfmod/produce/ffmpeg，但聊天链路够不着。
// 用户的感受是"她不会、分辨不了"；真实原因是**手没长出来**。
//
// 能力清单即承诺：这里每一个函数都真的能跑，跑不成如实回错。
// 边界在 sandbox.mjs（容器本身就是边界；这里挡手滑）。
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, resolvePath, runSandboxed, isSensitiveName } from './sandbox.mjs'

/** 遍历时跳过的大目录（她的浏览器 profile 有几千个文件，扫它没意义还慢）。 */
const SKIP_DIR = new Set([
  'node_modules', '.git', 'browser-profile', 'asr-models', 'asr-venv', 'face-models',
  'node-llama', 'chromium', 'cache', 'tmp',
])
/**
 * 绝对路径级的噪音源。
 * /home/dsh/app 是镜像里 bake 的 0.4.0 旧副本（实测 inode 与 plugins/dsh_bot 不同，
 * 两份 package.json 版本 0.4.0 / 0.5.0），**不是跑的那份**。
 * 不排掉它会让她"找自己的代码"找到过时版本，还让每个结果出现两遍。
 */
const SKIP_ABS = new Set([path.join(ROOT, 'app')])
const MAX_SCAN = 30000
const MAX_HITS = 20
const MAX_READ_LINES = 400
const MAX_WRITE_BYTES = 512 * 1024

function humanSize(n) {
  const x = Number(n || 0)
  if (x >= 1 << 20) return (x / (1 << 20)).toFixed(1) + 'MB'
  if (x >= 1024) return (x / 1024).toFixed(1) + 'KB'
  return x + 'B'
}

/**
 * 找文件：按名字，或按内容（字面量，不用正则 —— 模型给正则十次有三次是坏语法）。
 * @param {{query:string, dir?:string, mode?:'name'|'content', limit?:number}} a
 */
export function findFiles(a = {}) {
  const q = String(a.query || '').trim()
  if (!q) return { ok: false, result: '没给要找什么。' }
  const mode = a.mode === 'content' ? 'content' : 'name'
  const base = resolvePath(a.dir || ROOT, { mustExist: true })
  if (!base.ok) return { ok: false, result: base.reason }
  const limit = Math.max(1, Math.min(MAX_HITS, Number(a.limit) || 12))
  const needles = [q.toLowerCase()]
  const t0 = Date.now()
  const hits = []
  let scanned = 0
  const seen = new Set()

  const stack = [base.path]
  while (stack.length && hits.length < limit && scanned < MAX_SCAN && Date.now() - t0 < 3000) {
    const dir = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.data') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || SKIP_ABS.has(p)) continue
        stack.push(p)
        continue
      }
      // 同一个实体文件只报一次（容器里可能有软链/重复挂载指向同一份）
      let real = p
      try { real = fs.realpathSync(p) } catch { /* 断链就按原路径算，下面 stat 会再失败 */ }
      if (seen.has(real)) continue
      scanned++
      let stat = null
      try { stat = fs.statSync(p) } catch { continue }
      seen.add(real)
      if (isSensitiveName(e.name)) continue          // 凭据/密钥不进检索结果，连路径都不给
      if (mode === 'name') {
        if (e.name.toLowerCase().includes(needles[0])) hits.push({ path: p, size: stat.size, line: 0, text: '' })
      } else {
        if (stat.size > 2 * 1024 * 1024) continue            // 大文件不 grep（视频/模型）
        let text = ''
        try { text = fs.readFileSync(p, 'utf8') } catch { continue }
        const i = text.toLowerCase().indexOf(needles[0])
        if (i < 0) continue
        const line = text.slice(0, i).split('\n').length
        const lineStart = text.lastIndexOf('\n', i) + 1
        const lineEnd = text.indexOf('\n', i)
        hits.push({ path: p, size: stat.size, line, text: text.slice(lineStart, lineEnd < 0 ? i + 200 : lineEnd).trim().slice(0, 200) })
      }
      if (hits.length >= limit) break
    }
  }
  if (!hits.length) {
    return { ok: true, result: `在 ${path.relative(ROOT, base.path) || '.'} 里没找到「${q}」（扫了 ${scanned} 个文件）` }
  }
  const lines = hits.map((h) => path.relative(ROOT, h.path) + (h.line ? `:${h.line}` : '') + `  ${humanSize(h.size)}` + (h.text ? '\n    ' + h.text : ''))
  return {
    ok: true,
    result: `找到 ${hits.length} 个（扫了 ${scanned} 个文件）：\n` + lines.join('\n')
      + '\n（要读哪个用 read_file，路径就是上面这些相对路径；这些都是她容器里的文件。）',
  }
}

/** 读一个文本文件的一段（带行号，方便她引用/续写）。 */
export function readText(a = {}) {
  const r = resolvePath(a.path || '', { mustExist: true })
  if (!r.ok) return { ok: false, result: r.reason }
  let stat = null
  try { stat = fs.statSync(r.path) } catch { return { ok: false, result: '读不了这个路径' } }
  if (stat.isDirectory()) {
    let ents = []
    try { ents = fs.readdirSync(r.path, { withFileTypes: true }) } catch { /* 下面统一报错 */ }
    if (!ents.length) return { ok: false, result: '这是个目录，而且读不了（权限或空）' }
    // 凭据文件连名字都不列（红队实测：`.data/../.dsh/` 一列就把 .credentials.yaml 抖出来了）
    const shown = ents.filter((e) => !isSensitiveName(e.name))
    const lines = shown.slice(0, 60).map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    return { ok: true, result: `这是目录（${ents.length} 项）：\n` + lines.join('  ') }
  }
  if (stat.size > 4 * 1024 * 1024) return { ok: false, result: '太大了（' + humanSize(stat.size) + '），先用 run_command 的 grep/wc 看局部' }
  let text = ''
  try { text = fs.readFileSync(r.path, 'utf8') } catch { return { ok: false, result: '不是文本文件（或编码不对），读不了' } }
  const all = text.split('\n')
  const from = Math.max(1, Number(a.from) || 1)
  const n = Math.max(1, Math.min(MAX_READ_LINES, Number(a.lines) || 120))
  const slice = all.slice(from - 1, from - 1 + n)
  const body = slice.map((l, i) => (from + i) + '\t' + l).join('\n')
  return {
    ok: true,
    result: `${path.relative(ROOT, r.path)}（共 ${all.length} 行，这里 ${from}~${from + slice.length - 1}）\n` + body,
  }
}

/** 写/追加一个文件（必须在沙盒内、且不在代码目录）。 */
export function writeText(a = {}) {
  const text = String(a.text ?? '')
  if (!text) return { ok: false, result: '内容为空。' }
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) return { ok: false, result: '一次最多写 512KB' }
  const r = resolvePath(a.path || '', { write: true })
  if (!r.ok) return { ok: false, result: r.reason }
  const append = a.append === true
  try {
    fs.mkdirSync(path.dirname(r.path), { recursive: true })
    if (append) fs.appendFileSync(r.path, text, 'utf8')
    else fs.writeFileSync(r.path, text, 'utf8')
  } catch (e) {
    return { ok: false, result: '写失败：' + String(e?.message || e).slice(0, 120) }
  }
  let size = 0
  try { size = fs.statSync(r.path).size } catch { /* 刚写完，stat 失败不影响结论 */ }
  return { ok: true, result: `${append ? '已追加到' : '已写'} ${path.relative(ROOT, r.path)}（${humanSize(size)}）` }
}

/** 在容器里跑一条命令（白名单、不走 shell、限时）。 */
export async function execCommand(a = {}) {
  const cmd = String(a.cmd || '').trim()
  if (!cmd) return { ok: false, result: '没给命令。' }
  if (cmd.length > 2000) return { ok: false, result: '命令太长了' }
  const t = Math.max(500, Math.min(10000, Number(a.timeoutMs) || 8000))
  const r = await runSandboxed(cmd, { timeoutMs: t, cwd: a.workdir || undefined })
  if (!r.ok && !r.out) return { ok: false, result: '没跑成：这条命令不在允许范围' }
  return { ok: r.ok, result: (r.ok ? '' : '命令没成功（exit ' + (r.code ?? '?') + '）\n') + (r.out || '（没有输出）') }
}
