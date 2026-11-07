#!/bin/bash
# 逐套跑测试并给出可归因的退出码（2026-11-07 验证门）
#
# 为什么不用 `node tools/run-tests.mjs`：全量 108 套在这台机器上要 110 秒，
# 期间一次 OOM/外部信号就会整批 SIGKILL（实测 TESTS_EXIT=137，日志停在 lock-adversarial）。
# 逐套跑：每套自己的退出码就是证据，任何一套失败都会让最终退出码非 0。
cd /home/dsh/plugins/dsh_bot || exit 9

node - <<'NODE'
const fs = require('fs')
const s = fs.readFileSync('tools/run-tests.mjs', 'utf8')
const m = s.match(/const TESTS = \[([\s\S]*?)\]/)
if (!m) { console.error('LIST_PARSE_FAIL'); process.exit(3) }
const list = [...m[1].matchAll(/'([^']+\.mjs)'/g)].map((x) => x[1])
fs.writeFileSync('/tmp/tests.txt', list.join('\n'))
console.log('LIST', list.length)
NODE
[ $? -ne 0 ] && exit 3

fail=0
total=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  total=$((total + 1))
  node "test/$f" > /tmp/one-test.log 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail=$((fail + 1))
    echo "FAIL $f (exit=$rc)"
    tail -4 /tmp/one-test.log | cut -c1-160
  fi
done < /tmp/tests.txt

echo "TOTAL=$total FAIL=$fail"
[ "$fail" -eq 0 ]
