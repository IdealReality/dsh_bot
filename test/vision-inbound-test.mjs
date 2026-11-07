// 视频/图片入站的三处"静默失效"回归（2026-11-07）。
//
// 这三条都是同一个病：**有值、不报错、判定正常**。
//   ① fold 把首条带图 user 的 content 数组 String() 拍平 → 图片段蒸发，
//      模型只看文字就照人设编画面（实测 3 帧红/蓝/绿被编成"橘红光晕穿过水波"）。
//   ② OneBot 只给 file://／裸文件名时 sampleVideo 返回 null 且不留话 →
//      整条视频静默消失，她既不提也不当回事。
//   ③ 下载体积阈值 10KB / 单帧 2KB → 合法短视频与纯色帧被判成"打不开"。
//
// 不出网（只用本地 127.0.0.1 临时 http），不烧模型 token。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-vision-inbound-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* best-effort */ } })

const ROOT = path.resolve(import.meta.dirname, '..')
const { foldSystemIntoUser } = await import('file:///' + path.join(ROOT, 'tools/lib/llm.mjs').replace(/\\/g, '/'))
const { prepareInbound, attachVision } = await import('file:///' + path.join(ROOT, 'tools/lib/qq-inbound.mjs').replace(/\\/g, '/'))
const { dataUri } = await import('file:///' + path.join(ROOT, 'tools/lib/vision.mjs').replace(/\\/g, '/'))
const { sampleVideo } = await import('file:///' + path.join(ROOT, 'tools/lib/videoframe.mjs').replace(/\\/g, '/'))

const results = []
async function ok(name, fn) {
  try { await fn(); results.push([true, name]) } catch (e) { results.push([false, name, e.message]) }
}

const IMG = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }

// ── ① fold：首条 user 带图时，图片段必须活着 ───────────────────────────────
await ok('fold：首条 user 是数组（带图）→ 设定并入 text 段，image_url 段原样保留', () => {
  const msgs = [
    { role: 'system', content: '你是大肥鱼' },
    { role: 'user', content: [{ type: 'text', text: '看这个' }, IMG] },
  ]
  const out = foldSystemIntoUser(msgs, { systemRole: 'fold' })
  assert.equal(out.length, 1, 'system 应被折掉')
  const c = out[0].content
  assert.ok(Array.isArray(c), 'content 必须仍是数组，不能被 String() 拍平')
  assert.equal(c.length, 2, '图片段不能被吞')
  assert.equal(c[1].type, 'image_url')
  assert.ok(c[0].text.startsWith('【设定｜'), '设定应进第一个 text 段')
  assert.ok(c[0].text.includes('看这个'), '原文本不能丢')
  assert.ok(c[0].text.includes('你是大肥鱼'), '人格文本不能丢')
  assert.ok(!c.some((s) => String(s.text || '').includes('[object Object]')), '不能出现拍平后的 [object Object]')
})

await ok('fold：数组里没有 text 段 → 设定补在最前面，图段顺序不乱', () => {
  const msgs = [{ role: 'system', content: '设定' }, { role: 'user', content: [IMG] }]
  const c = foldSystemIntoUser(msgs, { systemRole: 'fold' })[0].content
  assert.equal(c.length, 2)
  assert.equal(c[0].type, 'text')
  assert.equal(c[1].type, 'image_url')
})

await ok('fold：字符串 content 照旧合并（不能回归）', () => {
  const msgs = [{ role: 'system', content: '设定' }, { role: 'user', content: '在吗' }]
  const out = foldSystemIntoUser(msgs, { systemRole: 'fold' })
  assert.equal(typeof out[0].content, 'string')
  assert.ok(out[0].content.includes('在吗') && out[0].content.includes('设定'))
})

await ok('fold：systemRole=keep 时一条都不动', () => {
  const msgs = [{ role: 'system', content: '设定' }, { role: 'user', content: [IMG] }]
  assert.equal(foldSystemIntoUser(msgs, { systemRole: 'keep' }), msgs)
})

// ── ② 入站：拿不到可下载地址必须说话 ───────────────────────────────────────
await ok('入站：video 段只有 file:// → 明确"没看成"，不能静默消失', async () => {
  const r = await prepareInbound({ evt: {}, parsed: { videos: ['file:///data/x.mp4'], images: [] }, text: '【发了一段视频】', extra: '', chatId: 'c', isGroup: false })
  assert.ok(r, '不能整条丢')
  assert.ok(/没有可下载的地址/.test(r.extra || ''), 'extra 要写清楚：' + JSON.stringify(r.extra))
  assert.equal(r.videoNote && /没有可下载的地址/.test(r.videoNote), true, 'videoNote 也要带上')
})

// ── ③ 本地 http：体积阈值 + 失败原因 ───────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-vid-src-'))
const srv = http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname)
  const f = path.join(tmp, name)
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no') }
  res.writeHead(200, { 'Content-Type': 'video/mp4' })
  fs.createReadStream(f).pipe(res)
})
srv.keepAliveTimeout = 60_000   // 测试机默认 5s 会主动关闲置连接，跟真实 CDN 行为不同
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const PORT = srv.address().port
const url = (n) => `http://127.0.0.1:${PORT}/${n}`

try {
  // ★ 本轮根因回归：抽完帧就删目录，attachVision 读不到文件 → 一条都没进请求，
  //   而日志还写"3张"。这里要证明：prepareInbound 返回的帧路径**在清理后依然可读**，
  //   并且 attachVision 真的把它们放进 content。
  const realMp4 = path.join(tmp, 'real.mp4')
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2',
      '-filter_complex', '[0][1]concat=n=2:v=1:a=0[o]', '-map', '[o]', '-pix_fmt', 'yuv420p', realMp4], { timeout: 30_000 })
  } catch { /* 没有 ffmpeg 就跳过这条（容器/CI 各有环境） */ }

  if (fs.existsSync(realMp4)) {
    await ok('入站：视频帧落到持久目录，attachVision 真能把它们带进请求', async () => {
      const r = await prepareInbound({ evt: {}, parsed: { videos: [url('real.mp4')], images: [] }, text: '【发了一段视频】', extra: '', chatId: 'c', isGroup: false })
      assert.ok(r && r.imageUris.length > 0, '应抽到帧：' + JSON.stringify(r && r.imageUris))
      for (const f of r.imageUris) assert.ok(fs.existsSync(f) && fs.statSync(f).size > 0, '帧文件必须还在：' + f)
      const msgs = [{ role: 'user', content: '你看这个' }]
      const put = attachVision(msgs, { imageUris: r.imageUris, videoNote: r.videoNote, dataUri })
      assert.equal(put, r.imageUris.length, '并入张数要等于帧数')
      const segs = msgs[msgs.length - 1].content
      assert.equal(segs.filter((s) => s.type === 'image_url').length, r.imageUris.length)
    })
  }

  // 3KB 的"视频"：旧阈值 10KB 直接判失败；现在要能过下载这一关（随后 ffmpeg 会因为不是真片子失败，
  // 但失败原因必须是 ffprobe/ffmpeg 那一层，而不是 "video too small"）。
  fs.writeFileSync(path.join(tmp, 'tiny.mp4'), Buffer.alloc(3_000, 1))
  fs.writeFileSync(path.join(tmp, 'empty.mp4'), Buffer.alloc(10, 1))

  await ok('下载：3KB 不再被"太小"挡掉（阈值 2KB）', async () => {
    const r = await sampleVideo({ url: url('tiny.mp4') })
    assert.equal(r.frames.length, 0)
    assert.ok(!/too small/.test(r.note), '不该再报 too small：' + r.note)
    assert.ok(/没能(打开看|解开)/.test(r.note), '失败要带原因：' + r.note)
  })

  await ok('下载：真空文件仍然判失败，且原因可读', async () => {
    const r = await sampleVideo({ url: url('empty.mp4') })
    assert.ok(/too small|视频太小/.test(r.note), 'note=' + r.note)
  })

  await ok('下载：404 → 失败文案带 HTTP 状态', async () => {
    const r = await sampleVideo({ url: url('nope.mp4') })
    assert.ok(/HTTP 404/.test(r.note), 'note=' + r.note)
  })
} finally {
  srv.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ④ content 是数组时，任何"补一句话"的地方都不许把它拍平 ────────────────
await ok('msg-content：textOf 只取 text 段，appendText 保图段', async () => {
  const { textOf, appendText } = await import('file:///' + path.join(ROOT, 'tools/lib/msg-content.mjs').replace(/\\/g, '/'))
  assert.equal(textOf('abc'), 'abc')
  assert.equal(textOf([{ type: 'text', text: 'ab' }, IMG]), 'ab')
  const m = appendText({ role: 'user', content: [{ type: 'text', text: '看这个' }, IMG] }, '\n补充')
  assert.ok(Array.isArray(m.content))
  assert.equal(m.content.length, 2)
  assert.equal(m.content[0].text, '看这个\n补充')
  assert.equal(m.content[1].type, 'image_url')
  const m2 = appendText({ role: 'user', content: [IMG] }, '只有提示')
  assert.equal(m2.content.length, 2)
  assert.equal(m2.content[0].type, 'text')
})

await ok('think.speak：念头进 text 段，视频帧仍在（否则她照着标记编）', async () => {
  const { speak } = await import('file:///' + path.join(ROOT, 'tools/lib/think.mjs').replace(/\\/g, '/'))
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '你看这个' }, IMG] }]
  let captured = null
  await speak(msgs, '这画面有点眼熟', { llm: { chat: async (m) => { captured = m; return '好' } } })
  assert.ok(captured, '应发出请求')
  const c = captured[captured.length - 1].content
  assert.ok(Array.isArray(c), 'content 必须仍是数组')
  assert.equal(c.length, 2)
  assert.equal(c[1].type, 'image_url')
  assert.ok(c[0].text.includes('你看这个') && c[0].text.includes('这画面有点眼熟'))
  assert.ok(c[0].text.includes('画面以你看到的为准'), '带图时必须明确画面优先（否则念头里的猜测会盖过眼睛）')
})

await ok('cohere-bridge.rewriteMessages：提示补充后图段仍在', async () => {
  const { rewriteMessages } = await import('file:///' + path.join(ROOT, 'tools/lib/cohere-bridge.mjs').replace(/\\/g, '/'))
  const out = rewriteMessages([{ role: 'user', content: [{ type: 'text', text: '看' }, IMG] }], '【重写】重说一遍')
  const c = out[out.length - 1].content
  assert.ok(Array.isArray(c))
  assert.equal(c.length, 2)
  assert.equal(c[1].type, 'image_url')
  assert.ok(c[0].text.includes('重说一遍'))
})

const bad = results.filter(([o]) => !o)
for (const [o, n, m] of results) console.log((o ? '✓ ' : '✗ ') + n + (o ? '' : ' — ' + m))
if (bad.length) process.exit(1)
console.log('vision-inbound ✓ 全部通过')
process.exit(0)
