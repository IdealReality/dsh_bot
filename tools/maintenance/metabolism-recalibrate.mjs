#!/usr/bin/env node
// 一次性：代谢标定迁移（2026-11-08）
//
// 旧标定下无 binge 的普通日程每天净 -0.41，energy 必然见底到 0（实测 7 天模拟）。
// 修好标定不会自动还清历史欠账（新口径每天只 +0.015），所以这里做一次显式迁移：
// 只把**已经见底**且长期运行（messages ≥ 100）的读数拉回到 0.35 —— 相当于
// "饿了一天、睡了一觉"的水平，刚过 sensory-gain 的 conserve 门槛（0.25）。
//
// 幂等：stats.recalibrated 记了日期就不再动。生产读数不是 0 时什么都不做。
// `--force` 是人明确要求的补正（例如修并发覆盖之后手动拔一次电），会覆盖幂等标记。
import * as meta from '../brain/organ/metabolism.mjs'

const force = process.argv.includes('--force')
const r = meta.recalibrate(Date.now(), { force })
console.log('metabolism-recalibrate: ' + JSON.stringify(r))
console.log('  当前：' + JSON.stringify(meta.snapshot()))
process.exit(0)
