// 她的原生工具集（10-31）—— 让她聊天时真的能动手，而不是嘴上说。
//
// 病根（10-27 起反复出现）：她回"好，我记下了""这就去看"，但**没有任何东西真的记**。
// 于是用户被答应了 5 次、执行 0 次。根因不是她懒，是她**没有手**——
// 聊天链路是纯文本，工具能力只写在 system prompt 里（"你可以跑命令"），模型没法真的调。
//
// 现在：把最常用的几个动作做成 **OpenAI function calling** 工具，
// 聊天时带 tools 声明，模型自己决定调不调。调完把结果回灌，她再说话。
//
// 设计原则：
//   ① 工具要少而准（多了模型会乱调，也费 token）
//   ② 每个工具都有副作用上界（额度、频率、白名单）
//   ③ 调完必须把"做成了什么"写进记忆，否则她下一轮又不记得
//   ④ 失败要如实回给模型（让它说"我没做成"，而不是编）
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataPath, dshPath } from './paths.mjs'
import { config } from './config.mjs'
import * as promises from './promises.mjs'
import * as memory from './memory.mjs'
import { swallow } from './swallow.mjs'
import { searchVideos as biliSearch, searchArticles, articleDetail, playText } from './bili-web.mjs'
import * as workbench from './workbench.mjs'

const execFileAsync = promisify(execFile)

/**
 * 浏览器能力探测（2026-11-07）。
 *
 * 病根：工具清单告诉模型"你能用内置浏览器打开网页"，而生产容器里
 * **根本没有 chromium**（`spawn chromium ENOENT`）。于是每一轮想上网的对话
 * 都会调一次 browse_page，崩一次、超时一次，白烧 8~15 秒 ——
 * 用户感受是"她转得特别慢"，而她自己得到的是"我又没查成"。
 *
 * 能力不在就别把工具递给她：清单即承诺。宁可少一个工具，
 * 也不要让她反复去够一个不存在的东西。
 */
// 能力探测只有一份：tools/lib/browser.mjs 的 hasChromium()。
// 两处各写一份，就会出现"清单里没有 browse_page，但 web search 还在起浏览器"的错位。
let HAS_BROWSER = false
try {
  const { hasChromium } = await import('./browser.mjs')
  HAS_BROWSER = hasChromium()
} catch { HAS_BROWSER = false }

/** 工具定义（OpenAI tools 格式）。只放陪聊时真的用得上的。 */
const RAW_CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remember_promise',
      description: '记一条你答应用户的事/待办（到点会被提醒）。只在用户明确要你记、或你真的承诺要做某件事时用。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', description: '要做什么，简洁一句话' },
          dueAt: { type: 'string', description: '什么时候提醒，格式 2026-11-01 09:00；不确定就留空' },
        },
        required: ['what'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: '记住关于用户的一件长期事实（他爱吃什么、在做什么工作、家里的事）。只记长期有用的，不记闲聊。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '事实本身，一句完整的话' },
          tag: { type: 'string', description: '分类：food/work/health/family/habit/other' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_memory',
      description: '查你自己的记忆：以前说过什么、答应过什么、关于用户记得什么。不确定的时候先查，别瞎编。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的关键词或问题' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_diary',
      description: '往你自己的日记里写一段（private=不加滤镜的真心话；owner=写给老爹的信）。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string', enum: ['private', 'owner'], description: 'private 或 owner' },
          text: { type: 'string', description: '日记内容' },
        },
        required: ['book', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look_up',
      description: '上网查东西（她不知道但想知道的事）。搜关键词或读一个网页。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['search', 'fetch'], description: 'search=搜关键词，fetch=读网页' },
          q: { type: 'string', description: '关键词或 URL' },
        },
        required: ['mode', 'q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bili_search',
      description: '在 B 站搜东西：视频（标题/BV号/UP主/播放量）或专栏文章（标题/作者/阅读量/链接）。'
        + '用户说"去B站找/看看…的视频或文章/专栏"时用这个。'
        + 'type=video 只搜视频，type=article 只搜专栏，type=both（默认，两类都搜）。'
        + '搜到视频想细看用 watch_video；搜到专栏想读正文用 bili_article。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜什么（可以就是普通一句话）' },
          type: { type: 'string', enum: ['video', 'article', 'both'], description: '搜视频/专栏/两者，默认 both' },
          sort: { type: 'string', enum: ['relevance', 'pubdate', 'click'], description: '排序：相关/最新/最多播放，默认相关' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bili_article',
      description: '读一篇 B 站专栏的正文（bili_search type=article 搜到的 cv 号）。用户说"把那篇专栏念给我听/讲了什么"时用。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '专栏号，cv123456 或纯数字' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watch_video',
      description: '看懂一条 B站视频（元信息+字幕+热评+画面）。她答应"这就去看"时用这个，不要只嘴上说。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号，如 BV1xx' },
        },
        required: ['bvid'],
      },
    },
  },
  {
    // 2026-11-07（用户要求）：「在 QQ 里叫她去 B 站专门看一类视频，
    // 从化学/生物学/哲学/主观/精神学/心理学几个方面研究与提升」。
    // 她以前的做法是嘴上答应 + 回来复述标题；这个工具把"答应"变成"立项 + 后台真的跑"。
    // 注意：它只立项（<1 秒），研究本身在独立进程里跑完再主动汇报 —— 不能阻塞聊天。
    type: 'function',
    function: {
      name: 'research_topic',
      description: '去 B站找一类视频，按 化学/生物学/心理学/主观/哲学/精神学 六个视角一层层往下研究，跑完会主动汇报。'
        + '他说"去B站专门看某类视频""研究/深挖一下某个题目""从几个方面想想"时用这个。'
        + '调用后**照实说已经开工**，别假装已经想完了，也别只说"这就去看"。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '要研究的具体题目（一句话，如"多巴胺与短视频成瘾"）' },
          rounds: { type: 'number', description: '往下追几层，默认 3（0~3）' },
          videos: { type: 'number', description: '最多看几条视频，默认 14（1~48）' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_page',
      description: '用你的内置浏览器打开网页：像真人一样渲染（电脑/手机两种身份自动识别），JS 画出来的正文也能读，还能点击/输入/截图。比 look_up 的 fetch 强得多，读文章/帖子/公众号优先用它。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的 http(s) 链接' },
          device: { type: 'string', enum: ['auto', 'pc', 'mobile'], description: '设备身份：auto=按域名猜（默认），pc=电脑，mobile=手机' },
          links: { type: 'boolean', description: '要不要列出页面上可点的链接（想继续点就开）' },
          full: { type: 'boolean', description: '懒加载页（要滑到底才加载的）传 true，自动滑到底喂全' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: '在她的容器里找文件：按文件名，或按文件内容里的字面量。'
        + '用户说"本地找一下/有没有关于…的文件/那个资料放哪了"时**先用这个再回答**，别直接说找不到。'
        + '范围是她的家目录（记忆、日记、素材、下载的文档、脚本、日志）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找的名字片段，或内容里的字面量' },
          mode: { type: 'string', enum: ['name', 'content'], description: '按文件名（默认）还是按文件内容' },
          dir: { type: 'string', description: '从哪个目录开始，默认整个家目录；可以给 .data/diary 这种相对路径' },
          limit: { type: 'number', description: '最多几条，默认 12' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读她容器里一个文本文件（带行号，可分页）。find_files 找到之后用它看内容；用户让她"看看那个文件写的什么"时用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对家目录或绝对路径，必须在容器里）' },
          from: { type: 'number', description: '从第几行开始，默认 1' },
          lines: { type: 'number', description: '读多少行，默认 120（最多 400）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把内容写进她容器里的文件（笔记、草稿、脚本、跑出来的结果）。append=true 是追加。'
        + '她的代码目录是只读的 —— 要改自己的代码用 selfmod，不要用这个。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '写到哪（相对家目录的路径，如 .data/notes/统计.md）' },
          text: { type: 'string', description: '要写的内容' },
          append: { type: 'boolean', description: 'true=追加到末尾，默认覆盖' },
        },
        required: ['path', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在她的容器里跑一条命令（不走 shell，不支持管道/重定向）：统计、格式转换、跑她刚写好的脚本。'
        + '可用：node / python3 / ffmpeg / git(只读) / grep / find / sed(不改文件) / jq / tar 等；'
        + '不许 rm、sudo、docker、ssh。跑不超过 8 秒，长活先写成脚本再后台跑。',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: '命令行，如 "python3 x.py" 或 "wc -l .data/sent-log.json"' },
          workdir: { type: 'string', description: '在哪个目录跑，默认家目录' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 8000，最多 10000' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'office_task',
      description: '把一件需要多步才能做完的活交给你的办公台：写并跑脚本、做统计、整理一批文件、把几篇专栏/文章读完做对比、批量处理素材。'
        + '你聊天里每件工具只有 12 秒，这种活必须立项交给后台，跑完会主动汇报给你爹。'
        + '他说"帮我统计/整理/写个脚本/批量弄一下/把这几篇看完"这类多步活时用这个。'
        + '调用后照实说"已经开工"，别现在硬做，也别假装已经做完了。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '要做的这件事，一句话说清交付物（如"统计 .data/sent-log.json 里各人的回复条数，结果写成 md"）' },
          steps: { type: 'number', description: '最多几步，默认 20' },
          minutes: { type: 'number', description: '最多几分钟，默认 12' },
        },
        required: ['goal'],
      },
    },
  },
]

/** 工作台四件（配置里能单独关，见 DEFAULTS.workbench）。 */
const WORKBENCH_TOOLS = new Set(['find_files', 'read_file', 'write_file', 'run_command'])

/** 出口：按**当前机器真的具备的能力**过滤（清单即承诺）。 */
export const CHAT_TOOLS = RAW_CHAT_TOOLS.filter((t) => {
  const n = t?.function?.name
  if (n === 'browse_page') return HAS_BROWSER
  if (n === 'office_task') {
    if ((config().office || {}).enabled === false) return false
    return (config().workbench || {}).enabled !== false   // 办公台靠工作台的手，手没了立项也没意义
  }
  if (WORKBENCH_TOOLS.has(n)) {
    const w = config().workbench || {}
    if (w.enabled === false) return false
    if (n === 'run_command' && w.exec === false) return false
    if (n === 'write_file' && w.write === false) return false
  }
  return true
})

/** 跑一条 bot CLI（限时、限输出）。 */
async function runCli(args, timeoutMs = 60000) {
  const node = process.execPath
  const cli = dshPath('..', 'plugins', 'dsh_bot', 'tools', 'bot.mjs')
  // 用插件自身路径更稳
  const BOT_CLI_PATH = process.env.BOT_CLI || new URL('../bot.mjs', import.meta.url).pathname
  try {
    const r = await execFileAsync(node, [BOT_CLI_PATH, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    return { ok: true, out: String(r.stdout || '').trim() }
  } catch (e) {
    return { ok: false, out: String(e?.stdout || '').trim(), err: String(e?.stderr || e?.message || '').slice(0, 400) }
  }
}

/**
 * 执行一次工具调用。
 * @param {string} name 工具名
 * @param {object} args 参数（模型给的 JSON）
 * @returns {Promise<{ok:boolean, result:string}>} result 是回灌给模型看的文本
 */
export async function runTool(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {}
  try {
    switch (name) {
      case 'remember_promise': {
        const what = String(a.what || '').trim()
        if (!what) return { ok: false, result: '没写要记什么，记不了。' }
        let dueMin = 120
        if (a.dueAt) {
          const t = new Date(String(a.dueAt).replace(/-/g, '/'))
          if (!Number.isNaN(t.getTime())) dueMin = Math.max(1, Math.round((t.getTime() - Date.now()) / 60000))
        }
        const item = promises.add(what, { what, kind: 'todo', dueMin })
        return { ok: true, result: `已记进承诺账本：${what}` + (a.dueAt ? `（${a.dueAt}）` : `（约 ${dueMin} 分钟后提醒）`) + (item?.id ? ` id=${item.id}` : '') }
      }

      case 'remember_fact': {
        // 2026-11-11 修两个真 bug（数据体检发现的）：
        //
        // ① `a.text` 可能不是字符串。模型偶尔把对象塞进来（{key, value} / {content}），
        //    旧代码 `String(a.text)` → `[object Object]`，原样写进记忆：
        //    实测 ep 里真有一条 gist = 「用户：（关于用户：[object Object]）」。
        //    这种记忆不但没用，还会被 recall 召回。这里先尝试从对象里取有意义的字段，
        //    取不到再 JSON.stringify（至少留下原始结构，能人工救）。
        //
        // ② userId 写字面量 'owner'。结果 ep 里 who.others[0].id === "owner"，
        //    认人链路（ownerLine / diagnose 的认人检查）看到一串不是号的字符串。
        //    改成读配置里的真主号；读不到才退回 'owner'。
        const rawText = a.text
        const text = (
          typeof rawText === 'string' ? rawText
            : rawText && typeof rawText === 'object'
              ? String(rawText.text || rawText.content || rawText.value || rawText.fact || JSON.stringify(rawText))
              : String(rawText ?? '')
        ).trim()
        if (!text) return { ok: false, result: '没写内容，记不了。' }
        // 走 owner-facts，让她下次真的"记得"
        const oaf = await import('./owner-facts.mjs')
        const got = oaf.learnFromOwner ? oaf.learnFromOwner(text) : []
        const ownerQQ = (() => { try { return String(config().owner?.qq || '') || 'owner' } catch { return 'owner' } })()
        memory.remember('qq', 'qq:owner-notes', ownerQQ, 'system', `（关于用户：${text}）`, { allowSelfTest: true })
        return { ok: true, result: `记住了：${text}` + (got?.length ? `（${got.map((g) => g.key).join('/')}）` : '') }
      }

      case 'check_memory': {
        const q = String(a.query || '').trim()
        if (!q) return { ok: false, result: '没给关键词。' }
        const hits = []
        // ① 语义/关键词记忆
        try {
          for (const h of memory.recall(q, 5) || []) hits.push(String(h))
        } catch (e) { swallow(e, 'tools:check_memory:recall') }
        // ② 承诺账本：先精确包含，再退回"最近 5 条未完成"——
        //    实测问题：她说"明早九点交房租"，模型查"交房租"，精确包含能中；
        //    但模型有时会给"房租"或"交钱"，包含就中不了。短 query 再兜一层关键词重叠。
        try {
          const all = promises.list('open') || []
          const norm = (x) => String(x || '').replace(/\s+/g, '')
          const exact = all.filter((x) => norm(x.what || x.text).includes(norm(q)))
          let picked = exact
          if (!picked.length) {
            // 关键词重叠：把 query 切成 2 字片段，命中任意一个就算相关
            const grams = []
            const qq = norm(q)
            for (let i = 0; i + 2 <= qq.length; i++) grams.push(qq.slice(i, i + 2))
            picked = all.filter((x) => { const t = norm(x.what || x.text); return grams.some((g) => t.includes(g)) })
          }
          if (!picked.length && all.length) picked = all.slice(-5)   // 最后兜底：把最近的在办事项列出来
          for (const p of picked.slice(0, 5)) {
            const due = p.dueAt ? '（' + new Date(Number(p.dueAt)).toLocaleString('zh-CN', { hour12: false }) + '）' : ''
            hits.push('[承诺] ' + (p.what || p.text) + due + ' 状态=' + (p.state || 'open'))
          }
        } catch (e) { swallow(e, 'tools:check_memory:promises') }
        return { ok: true, result: hits.length ? hits.slice(0, 8).join('\n') : '记忆里没查到相关的东西，也没挂着相关的待办。' }
      }

      case 'write_diary': {
        const book = a.book === 'owner' ? 'owner' : 'private'
        const text = String(a.text || '').trim()
        if (!text) return { ok: false, result: '没写内容。' }
        const r = await runCli(['diary', '--book', book, '--append', text], 30000)
        return { ok: r.ok, result: r.ok ? `已写进${book === 'owner' ? '给老爹的信' : '你的私人日记'}。` : `日记没写成：${r.err || r.out}` }
      }

      case 'browse_page': {
        const url = String(a.url || '').trim()
        if (!url) return { ok: false, result: '没给链接。' }
        const dev = ['pc', 'mobile'].includes(a.device) ? a.device : 'auto'
        const args = ['browser', 'read', url, '--device', dev]
        if (a.links) args.push('--links')
        if (a.full) args.push('--full')
        const r = await runCli(args, 90000)
        if (!r.ok) return { ok: false, result: `浏览器没读成：${(r.err || r.out || '').slice(0, 200)}` }
        return { ok: true, result: String(r.out || '').slice(0, 1800) }
      }

      case 'look_up': {
        const mode = a.mode === 'fetch' ? 'fetch' : 'search'
        const q = String(a.q || '').trim()
        if (!q) return { ok: false, result: '没给关键词。' }
        if (mode === 'fetch') {
          // 2026-11-09：能力不存在就别去够它。容器里没有 chromium（hasChromium=false），
          // 旧代码仍然先跑一次 `browser read`（spawn 立刻失败）再落回 web fetch ——
          // 白烧一次进程，而且在 12 秒的工具预算里还要靠外面 Promise.race 硬杀。
          // 另外 90s/60s 的超时本来就超过单个工具预算，孤儿进程会留在容器里。
          const BUDGET = 9000
          if (HAS_BROWSER) {
            const b = await runCli(['browser', 'read', q, '--device', 'auto'], BUDGET)
            if (b.ok) return { ok: true, result: String(b.out || '').slice(0, 1800) }
          }
          const r = await runCli(['web', 'fetch', q], BUDGET)
          if (!r.ok) return { ok: false, result: `上网没成：${(r.err || r.out || '').slice(0, 200)}` }
          return { ok: true, result: String(r.out || '').slice(0, 1800) }
        }
        const r = await runCli(['web', 'search', q], 9000)
        if (!r.ok) return { ok: false, result: `上网没成：${(r.err || r.out || '').slice(0, 200)}` }
        const text = String(r.out || '').slice(0, 2400)
        // 工具要交代"接下来怎么用"（同 bili_search 的教训）：搜到不给她说清楚，
        // 她会回"我去找找"或者把标题念一遍就当答完了。
        return {
          ok: true,
          result: text.includes('没搜到对题')
            ? text
            : text + '\n（挑 1~2 条最对题的，把标题和站点名说给他；要看正文就用 browse_page 读那条链接，别把搜索列表直接当答案念。）',
        }
      }

      case 'bili_search': {
        const kw = String(a.keyword || '').trim()
        if (!kw) return { ok: false, result: '没给关键词。' }
        const sortMap = { relevance: 'totalrank', pubdate: 'pubdate', click: 'click' }
        const order = sortMap[String(a.sort || 'relevance')] || 'totalrank'
        const type = ['video', 'article'].includes(a.type) ? a.type : 'both'
        const parts = []
        const errs = []
        if (type !== 'article') {
          try {
            const items = await biliSearch(kw, { order, limit: 6 })
            if (items.length) {
              parts.push('【视频 ' + items.length + ' 条】\n' + items.map((v, i) => (i + 1) + '. ' + v.title + '\n   ' + v.bvid + ' · ' + v.author + ' · ' + playText(v.play) + '播放' + (v.duration ? ' · ' + v.duration : '')).join('\n'))
            } else {
              parts.push('【视频】没搜到')
            }
          } catch (e) { errs.push('视频：' + String(e?.message || e).slice(0, 60)) }
        }
        if (type !== 'video') {
          try {
            const arts = await searchArticles(kw, { order, limit: 6 })
            if (arts.length) {
              parts.push('【专栏 ' + arts.length + ' 篇】\n' + arts.map((x, i) => (i + 1) + '. ' + x.title + '\n   cv' + x.id + ' · ' + x.author + ' · ' + playText(x.view) + '阅读' + '\n   ' + x.url).join('\n'))
            } else {
              parts.push('【专栏】没搜到')
            }
          } catch (e) { errs.push('专栏：' + String(e?.message || e).slice(0, 60)) }
        }
        if (!parts.length) return { ok: false, result: 'B 站搜索没成：' + (errs.join('；') || '没有结果') }
        const hasHit = /【(视频|专栏) [1-9]/.test(parts.join('\n'))
        if (!hasHit) return { ok: true, result: 'B 站没搜到「' + kw + '」。' + (errs.length ? '（' + errs.join('；') + '）' : '') }
        return {
          ok: true,
          result: '「' + kw + '」\n' + parts.join('\n\n') + (errs.length ? '\n（没成的那部分：' + errs.join('；') + '）' : '')
            + '\n（挑 1~2 条最对题的，把标题和 BV 号/cv 号说给他；视频细看用 watch_video，专栏正文用 bili_article。别只回"我去找找"。）',
        }
      }

      case 'bili_article': {
        const id = String(a.id || '').trim()
        if (!id) return { ok: false, result: '没给专栏号。' }
        try {
          const d = await articleDetail(id)
          return {
            ok: true,
            result: `${d.title} · ${d.author}${d.pubdate ? ' · ' + new Date(d.pubdate * 1000).toLocaleDateString('zh-CN') : ''} · ${d.words} 字\n${d.url}\n\n${d.text}`,
          }
        } catch (e) {
          return { ok: false, result: '专栏没读成：' + String(e?.message || e).slice(0, 100) }
        }
      }

      case 'find_files':
      case 'read_file':
      case 'write_file':
      case 'run_command': {
        const w = config().workbench || {}
        if (w.enabled === false) return { ok: false, result: '工作台被关掉了（config.workbench.enabled=false），我现在碰不了文件。' }
        if (name === 'run_command' && w.exec === false) return { ok: false, result: '跑命令这块被关掉了（config.workbench.exec=false）。' }
        if (name === 'write_file' && w.write === false) return { ok: false, result: '写文件这块被关掉了（config.workbench.write=false）。' }
        if (name === 'find_files') return workbench.findFiles(a)
        if (name === 'read_file') return workbench.readText(a)
        if (name === 'write_file') return workbench.writeText(a)
        return workbench.execCommand(a)
      }

      case 'office_task': {
        const goal = String(a.goal || '').replace(/\s+/g, ' ').trim()
        if (!goal) return { ok: false, result: '没说要做什么。' }
        const cfg = config().office || {}
        if (cfg.enabled === false) return { ok: false, result: '办公台关着（config.office.enabled=false），接不了活。' }
        const office = await import('./office.mjs')
        const r = office.start({ goal, steps: a.steps, minutes: a.minutes })
        if (!r.ok) return { ok: false, result: '立项没成：' + (r.reason || '未知原因') }
        if (r.busy) {
          return { ok: true, result: `手上还压着一件没干完（${r.id}）：「${r.goal}」。这件先排着，等那个收尾我就接着做。` }
        }
        return {
          ok: true,
          result: `已经开工（${r.id}）：「${goal}」。${r.worker ? '后台进程已经起来了，' : '后台进程没起来，但任务已经记下了，'}`
            + '我在这边继续跟你说话，跑完主动告诉你。现在照实说"已经开始弄了"，别提前编结果。',
        }
      }

      case 'watch_video': {
        const bvid = String(a.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return { ok: false, result: 'BV 号格式不对。' }
        const r = await runCli(['debrief', '--bvid', bvid], 120000)
        if (!r.ok) return { ok: false, result: `没看成：${(r.err || r.out || '').slice(0, 200)}` }
        return { ok: true, result: String(r.out || '').slice(0, 2200) }
      }

      case 'research_topic': {
        const topic = String(a.topic || '').replace(/\s+/g, ' ').trim()
        if (!topic) return { ok: false, result: '没给要研究的题目。' }
        const args = ['research', 'start', '--topic', topic]
        const rounds = Number(a.rounds)
        if (Number.isFinite(rounds) && rounds >= 0) args.push('--depth', String(Math.min(3, Math.max(0, rounds))))
        const videos = Number(a.videos)
        if (Number.isFinite(videos) && videos > 0) args.push('--videos', String(Math.min(48, Math.max(1, videos))))
        // 立项本身必须快：只建状态 + spawn 后台进程，实测 <1s。
        // 12 秒的工具预算不是给"看十几条视频"用的 —— 那是后台进程的事。
        const r = await runCli(args, 20000)
        if (!r.ok) return { ok: false, result: `立项没成：${(r.err || r.out || '').slice(0, 200)}` }
        let j = null
        try { j = JSON.parse(String(r.out).match(/\{[\s\S]*\}/)?.[0] || 'null') } catch { j = null }
        if (!j?.ok) return { ok: false, result: `立项没成：${String(r.out || '').slice(0, 200)}` }
        if (j.done) return { ok: true, result: `「${j.topic}」我之前已经研究过了（${j.id}），结果还在。要我再往下挖就直说。` }
        return {
          ok: true,
          result: `已经开工（${j.id}）：「${j.topic}」。${j.worker ? '后台进程已起来，' : '后台进程没起来，但我已经把题记下了，'}`
            + `会去 B站按六轴找视频、一层层往下看，跑完主动告诉他。现在先照实说"已经开始看了"，别提前编结论。`,
        }
      }

      default:
        return { ok: false, result: `没有这个工具：${name}` }
    }
  } catch (e) {
    return { ok: false, result: `工具 ${name} 出错：${String(e?.message ?? e).slice(0, 200)}` }
  }
}
