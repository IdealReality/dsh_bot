// _isolate.mjs —— 测试公用前置：把「数据目录 / 家目录」指到临时目录。
//
// 为什么需要：`swallow()` 把吞掉的异常写进 dataPath('logs','swallowed.log')，
// 而 dataPath 解析的是 USERPROFILE/HOME 或 BOT_DATA_DIR。没隔离的测试一旦故意抛错
// （channel-test 的 'boom'、lifecycle-test 的 'x'），就会把这些测试噪声写进她的**真实**台账。
// 2026-11-08 实测：真实 swallowed.log 里躺着 channel:handle ×72 'boom' 与 lifecycle:boom ×68 'x'，
// 而 diagnose 现在会把近 24 小时的台账聚合出来 —— 测试噪声直接变成"她有问题"的假警报。
//
// 用法：在测试文件的**第一个** import 写成
//     import './_isolate.mjs'
// ESM 按声明顺序求值依赖，所以它会在业务模块（paths.mjs 等）读 env 之前生效。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-iso-'))
process.env.BOT_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
delete process.env.DSH_HOME

export const TEST_TMP = tmp
