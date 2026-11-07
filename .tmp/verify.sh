#!/bin/bash
# 可归因验证（2026-11-08）：把 108 套拆成小批，每批独立退出码。
#
# 背景：这台机器的长静默命令不可靠（实测 51~73 秒被 SIGKILL，日志停在半截）。
# 分批后每批 <40 秒、每套打印一行（有输出），退出码逐批可见；
# 任何一套失败 → 该批 rc=1 → 最终 rc=1。
#
#   bash .tmp/verify.sh list          # 打印解析到的套数
#   bash .tmp/verify.sh batch 0 20    # 跑 [0,20)
cd /home/dsh/plugins/dsh_bot || exit 9

if [ "$1" = "list" ]; then
  node - <<'NODE'
const fs = require('fs')
const src = fs.readFileSync('tools/run-tests.mjs', 'utf8')
const start = src.indexOf('const TESTS = [')
if (start < 0) { console.error('NO_TESTS_ARRAY'); process.exit(3) }
let i = src.indexOf('\n', start)
const out = []
while (i >= 0 && i < src.length) {
  const end = src.indexOf('\n', i + 1)
  const line = src.slice(i + 1, end < 0 ? src.length : end)
  if (/^\s*\]/.test(line)) break
  const m = line.match(/'([^']+\.mjs)'/)
  if (m) out.push(m[1])
  i = end
}
fs.writeFileSync('/tmp/tests.txt', out.join('\n'))
console.log('TESTS_PARSED=' + out.length)
NODE
  exit $?
fi

if [ "$1" = "batch" ]; then
  from=${2:-0}
  count=${3:-20}
  [ -s /tmp/tests.txt ] || { echo 'NO_LIST'; exit 3; }
  mapfile -t LIST < /tmp/tests.txt
  fail=0
  ran=0
  for ((idx = from; idx < from + count && idx < ${#LIST[@]}; idx++)); do
    f=${LIST[$idx]}
    node "test/$f" > /tmp/one-test.log 2>&1
    rc=$?
    ran=$((ran + 1))
    echo "[$idx] $f rc=$rc"
    if [ "$rc" -ne 0 ]; then
      fail=1
      tail -3 /tmp/one-test.log | cut -c1-160
    fi
  done
  echo "BATCH from=$from ran=$ran fail=$fail"
  [ "$fail" -eq 0 ]
  exit $?
fi

echo 'usage: verify.sh list | verify.sh batch <from> <count>'
exit 2
