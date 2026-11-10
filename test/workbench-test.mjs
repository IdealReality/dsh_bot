/**
 * 工作台边界测试 —— 2026-11-09 回归锚点。
 *
 * 为什么值得钉：她 2026-11-09 起在聊天里有了「手」（find_files / read_file /
 * write_file / run_command）。这些手能碰到的是**她的整个容器**，所以每一条边界
 * 都必须有回归测试 —— 一旦哪天有人放宽了 sandbox.mjs，测试要立刻响。
 *
 * 钉住的语义：
 *   · 路径只在 HOME 之内；../ 与符号链接逃逸都拒
 *   · 凭据/配置文件聊天里不读写
 *   · 代码目录只读（改代码必须走 selfmod，带备份/门禁/回滚）
 *   · 命令白名单：rm/sudo/docker/sh 拒；git 只读；sed -i、find -exec 拒
 *   · 超大写入拒
 *
 * 跑法：node test/workbench-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 先把家目录指到临时沙盒，再动态 import（paths.mjs 在 import 时求值 HOME）。
// ⚠️ 不能直接用 os.tmpdir()：run-tests 会把 TMPDIR 指到 test/.tmp（项目目录内），
// 那样 HOME 就落在 APP_ROOT 里面 —— sandbox 的"代码目录只读"会正确地拒绝每一次写，
// 测试于是全红（2026-11-09 实测）。这里固定用系统 /tmp 的独立前缀。
const BASE = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
const TMP = fs.mkdtempSync(path.join(BASE, 'wb-test-'))
process.env.HOME = TMP
delete process.env.USERPROFILE
process.env.BOT_DATA_DIR = path.join(TMP, '.data')
fs.mkdirSync(path.join(process.env.BOT_DATA_DIR, 'notes'), { recursive: true })

const sb = await import('../tools/lib/work/sandbox.mjs')
const wb = await import('../tools/lib/work/workbench.mjs')

let bad = 0
const ok = (c, label) => { console.log((c ? '  ✓ ' : '  ✗ ') + label); if (!c) bad++ }

// ── 1. 路径边界 ─────────────────────────────────────────────────────────────
ok(sb.resolvePath('.data/x.json', {}).ok === true, '家目录内的相对路径 → 放行')
ok(sb.resolvePath('../../etc/passwd', {}).ok === false, '../ 穿越 → 拒')
ok(sb.resolvePath('/etc/passwd', {}).ok === false, '绝对路径指到家外面 → 拒')
ok(sb.resolvePath('.data/credentials.json', {}).ok === false, '凭据文件 → 拒读')
ok(sb.resolvePath('.dsh/x.json', { write: true }).ok === false, '.dsh（配置）→ 拒写')

// 符号链接逃逸
const link = path.join(TMP, '.data', 'escape')
try { fs.symlinkSync('/etc/passwd', link) } catch { /* 无权限建软链就跳过这条 */ }
if (fs.existsSync(link)) ok(sb.resolvePath('.data/escape', {}).ok === false, '软链接指到沙盒外 → 拒')

// ── 2. 代码目录只读（改代码必须走 selfmod）──────────────────────────────────
// 只有 APP_ROOT 落在当前 HOME 之内时才谈得上「代码目录」这条规则（容器里就是这样：
// HOME=/home/dsh，项目在 /home/dsh/plugins/dsh_bot）。测试把 HOME 换成了临时目录，
// 所以这里只在布局吻合时校验，否则不假装通过。
const appRel = path.relative(TMP, path.join(sb.APP_ROOT, 'tools', 'lib', 'work', 'tools.mjs'))
if (!appRel.startsWith('..')) {
  ok(sb.resolvePath(appRel, { write: true }).ok === false, '写自己的代码目录 → 拒（走 selfmod）')
} else {
  console.log('  · 代码目录在本进程 HOME 之外（测试沙盒布局），代码目录只读请在容器内验')
}

// ── 3. 命令白名单 ───────────────────────────────────────────────────────────
const chk = (cmd) => sb.checkCommand(sb.parseCommand(cmd).argv || [])
ok(chk('wc -l .data/sent-log.json').ok === true, 'wc → 放行')
ok(chk('python3 -c "print(1)"').ok === true, 'python3 -c → 放行（引号能正确拆）')
ok(chk('rm -rf .data').ok === false, 'rm → 拒')
ok(chk('sudo cat /etc/passwd').ok === false, 'sudo → 拒')
ok(chk('docker ps').ok === false, 'docker → 拒')
ok(chk('sh -c "ls"').ok === false, 'sh → 拒（不走 shell）')
ok(chk('git log --oneline').ok === true, 'git log → 放行')
ok(chk('git commit -m x').ok === false, 'git commit（写） → 拒')
ok(chk('sed -i s/a/b/ x.md').ok === false, 'sed -i → 拒')
ok(chk('find . -name "*.json" -exec rm {} ;').ok === false, 'find -exec → 拒')
ok(sb.parseCommand('grep -E "a|b" f').ok === true, '"a|b" 不算 shell 管道（execFile 没有 shell 语义）')

// ── 3b. 红队实测补的（2026-11-09 十遍第 3 遍）──────────────────────────────
// 病根：read_file 拒读凭据，但 `cat .data/credentials.json` 读到 346 字节；
// `.dsh/.credentials.yaml` 也不在名单里。同一台机器两套规矩 = 没有规矩。
fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.dsh', '.credentials.yaml'), 'k: v\n')
ok(sb.isSensitiveName('.credentials.yaml') && sb.isSensitiveName('credentials.json'), '敏感文件名识别（含 .credentials.yaml）')
ok(sb.resolvePath('.dsh/.credentials.yaml', {}).ok === false, '.dsh/.credentials.yaml → 拒读')
ok(chk('cat .data/credentials.json').ok === false, 'cat 凭据 → 拒（命令与 read_file 同一套规矩）')
ok(chk('cat /proc/self/environ').ok === false, '/proc/self/environ → 拒')
ok(chk('grep credential tools/x.mjs').ok === true, '裸词 credential 仍可 grep（只拦路径形态）')
ok(sb.resolvePath('.git/config', { write: true }).ok === false, '写 .git → 拒（不污染 HOME 的 git 语义）')

// ── 4. 工具层：读写与限界 ───────────────────────────────────────────────────
const w1 = wb.writeText({ path: '.data/notes/t.md', text: 'hello\n' })
ok(w1.ok === true, 'write_file 正常写 → 成功')
ok(fs.existsSync(path.join(process.env.BOT_DATA_DIR, 'notes', 't.md')), '文件真的落盘了')
ok(wb.readText({ path: '.data/notes/t.md', lines: 5 }).result.includes('hello'), 'read_file 读得回来')
ok(wb.writeText({ path: '.data/notes/big.md', text: 'x'.repeat(600 * 1024) }).ok === false, '单次写 >512KB → 拒')
ok(wb.readText({ path: '.data/credentials.json' }).ok === false, 'read_file 读凭据 → 拒')

// ── 5. find_files：名字 / 内容 / 不存在目录 ─────────────────────────────────
fs.writeFileSync(path.join(TMP, '.data', 'notes', 'nanjing.md'), '南京 小吃 记录\n第二行\n')
const byName = wb.findFiles({ query: 'nanjing', mode: 'name', dir: '.data' })
ok(byName.ok === true && byName.result.includes('nanjing.md'), 'find_files 按名字找到')
const byContent = wb.findFiles({ query: '南京', mode: 'content', dir: '.data' })
ok(byContent.ok === true && byContent.result.includes('nanjing.md'), 'find_files 按内容找到，且带行内容')
ok(wb.findFiles({ query: 'x', dir: '.data/nope' }).ok === false, 'find_files 不存在目录 → 如实报错')

// ── 6. 执行：超时要杀回来，不许挂死 ─────────────────────────────────────────
const t0 = Date.now()
const slow = await sb.runSandboxed('node -e "while(true){}"', { timeoutMs: 1200 })
ok(slow.ok === false && Date.now() - t0 < 6000, 'run_command 死循环 → 超时被杀（' + (Date.now() - t0) + 'ms）')

// 清理
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录，删不掉不影响结论 */ }

console.log(bad ? '\n✗ 工作台边界测试：' + bad + ' 条不过' : '\n✓ 工作台边界测试全过')
process.exitCode = bad ? 1 : 0
