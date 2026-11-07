# 大肥鱼 · 默认会上网（2026-11-07）

> 用户的要求：**默认就能会逛 B 站、去网络上搜一些东西**。
> 结论：不是"再加一个工具"，而是这一层原来有三处断的，全部接上之后才有"默认"可言。

---

## 一、三个断点（都是实测，不是推断）

| 断点 | 证据 | 后果 |
|---|---|---|
| **容器里没有 curl** | `docker exec dsh_bot which curl` → `command not found`；`web.mjs` 的 `curlGet` 只用 `execFileSync('curl')` | `web search` / `web fetch` 在生产上**一次都没成功过**；`look_up` 工具一直挂在清单里（"清单即承诺"第 N 次被违反） |
| **B 站搜索 412** | 裸 `fetch` 请求 `/x/web-interface/search/type` → `HTTP 412`（热门接口 200） | 即使有网也搜不到；只有"刷热门"能通 |
| **`body.browse` 是空壳** | `browse: async (d) => { await syncFocus('web', d); stimulate('explore', d) }` | 她"决定去逛"之后**什么都没逛**：状态变了，世界没变 |

## 二、修了什么

### 1. 网页层：fetch 优先，curl 只做代理兜底

`tools/commands/web.mjs` 新增 `httpGet()`：

- Node 18+ 自带 `fetch`，容器直连能出网（实测 Bing RSS **200 / 345ms**）
- 配置了代理且本机有 curl 时才走 curl（`fetch` 不认 `-x`）
- `searchWeb` / `fetchWeb` 改成 async，全部调用点补 `await`（`browseSmart` / `roam` / CLI）

实测（容器内）：

```
node tools/bot.mjs web search 大肥鱼   → 10 条结果，1.34s
```

### 2. B 站层：一个模块，两条消费者

新增 `tools/lib/bili-web.mjs`：

- 先访问 `https://www.bilibili.com/` 拿 `buvid3/buvid4`（`Set-Cookie`，缓存 30 分钟），再请求接口 → 搜索从 **412 变 200**
- `searchVideos()` / `popularVideos()` / `videoInfo()`，外加 `playText` / `durText`
- 聊天工具 `bili_search` 与"自己逛"的 `wander` **共用这一份**（避免第四次"两条路线漂移"）

实测：

```
bili_search("大肥鱼") → 6 条，842ms
  1. 爆炒大肥鱼  BV1pQ4j6oERa · 神奇的SWT · 2009播放
  2. ⚡️没装好，就重来⚡️大肥鱼小课堂 DSH  BV1Zb4E6JEEH · 1.2万播放 · 1:16
```

### 3. 聊天工具：`bili_search`

`tools/lib/tools.mjs` 新增工具（拿 BV 号 → 再 `watch_video` 看那一条）。
`look_up` 的描述也改了 —— 从"上网查东西"改成**什么时候该用**：

> 他提到你不确定的事、新闻/价格/版本号、或者你自己好奇，就先查再回答——别硬编。

### 4. 主动逛：`tools/lib/wander.mjs`

- 没关键词 → 刷 B 站热门（真正的"逛"：碰运气，不是搜索）
- 有关键词 → 搜，挑第一条**没刷到过**的（`pickFresh`）
- 热门条目缺简介时补一次详情（1 次请求，失败就算了）
- 记进看番账本时 **`ok:false`**：刷到 ≠ 看过。不会让她冒充看过，也不会挤掉 `recentShows(onlyReal)` 的名额
- 写一条经验到 `episodes`（`platform: bilibili`，`scope: private`）→ 下次聊天她真的能提起
- **每日额度** `web.wanderPerDay`（默认 6）：她是住在别人机器里的

### 5. 接线：`body.browse`

```js
browse: async (d) => {
  await syncFocus('web', d); stimulate('explore', d)
  const r = await wander({ why: 'self:browse' })     // ← 真的去刷
  if (r.ok) episode.appendAction({ text: '在 B 站刷到《…》', platform: 'bilibili', ... })
}
```

### 6. 好奇规则：两条装配路径共用

`persona-neutral.mjs` 新增 `CURIOSITY_RULE`，`persona.buildMessages`（shadow）与 `brain/assemble`（live）都注入：

```
【不懂就查，别硬编】
· 他提到的东西你没把握（新闻、价格、版本号、某个名字、哪条视频），先 look_up 查一下再说。
· 想聊某个视频却不知道是哪条，用 bili_search 搜到 BV 号，再 watch_video 看那一条。
· 查不到就直说没查到 —— "好像是"编出来的一句，比不知道更糟。
```

## 三、实测（真实网络，容器内）

| 动作 | 结果 |
|---|---|
| `web search 大肥鱼` | 10 条 / 1.34s |
| `bili_search("大肥鱼")` | 6 条 / 842ms（412 已解） |
| `wander()`（刷热门） | 《⚡️ 坏了，是灭建国 ⚡️》22.0万播放 / 122ms（cookie 已缓存） |
| `wander({keyword:'大肥鱼'})` | 《爆炒大肥鱼》BV1pQ4j6oERa |
| 额度 | 第 7 次 → `今天逛够了（6 次）` |
| 逛完的记忆 | `brain/ep/2026-11.jsonl`：`在 B 站刷到《…》（UP主 哦呼w）`，`scope: private`；`watch-log.json` 一条 `ok:false` |

单测（离线、可重复）：`test/wander-test.mjs` —— 候选挑选/跨天额度/额度 0/播放时长格式化，24 条断言。

## 四、边界

- **只读**：`bili-web` 只做搜索/热门/详情。发弹幕、点赞、投币仍然走 `act` 命令（默认干跑、`--go` 才发、有日额度）。
- **刷到 ≠ 看过**：`wander` 记 `ok:false`；真看必须 `watch_video`（拉字幕/热评/画面），两者在账本里可区分。
- **额度是硬门**：`web.wanderPerDay`（默认 6）。她是客人，不能无限烧主人的流量。
- **群聊不逛**：`browse` 是她的私人时间，不产生对外发言（要发也要走 `act`/主动搭话的门）。

---

## 五、第二道：把"要不要我去查"变成"现在就查"（2026-11-07 追加）

第一次冒烟暴露了一个更根本的问题 —— **工具挂上了，她仍然不查**：

```
他：大肥鱼小课堂那个系列是啥？B站上有吗
她：我真没留意过这个系列叫啥…别听我瞎编。
    要不我现在去B站搜一下，搜到就能看是啥了。
```

也就是说：她知道该查，但把"查"说成了"要不要我去查"，然后等下一轮。
提示词只能提高概率 —— 所以补了一道**确定性闸门** `tools/lib/search-gate.mjs`：

| 判据 | 说明 |
|---|---|
| 这一轮没有任何检索类工具调用 | `look_up` / `bili_search` / `watch_video` / `browse_page` 调过任意一个就不触发 |
| 问的是**外部事实** | B站/视频/新闻/价格/版本/"是什么"/"有没有"/"哪条"…；问她自己（你是谁/你累不累）**不触发** |
| 或者她在回答里**承诺去查** | "我去找找 / 要不我搜一下 / 我帮你查" —— 这类逃避最容易骗过提示词 |

触发后由编排层**带工具重写一次**（只一次，不循环），并在最后一条 user 消息后追加：

```
【先查再说】
· 这题你不确定：现在就调 look_up 或 bili_search，看完再回答。
· 不许说"我去找找 / 要不我搜一下 / 要不要我查"——要么现在查，要么直说不知道。
· 查到几条就挑最对题的 1~2 条，把标题（和 BV 号）说给他。
```

另外 `bili_search` 的结果末尾也加了一句用法提示（"挑 1~2 条最对题的，把标题和 BV 号说给他；
别只回'我去找找'"）—— 第一次冒烟她搜到了却说"没搜到真叫这个名字的UP主"，
因为工具只给了列表、没交代怎么用。**工具要承诺结果，也要交代用法。**

---

## 六、顺带修掉的基础设施问题（不然改动会被"吃掉"）

做这一轮时有两件更严重的事暴露出来：

### 1. `dsh-bot-deploy` 是**假部署 + 误回滚**

```bash
# ③ 构建 STAGE（cp app → /tmp/deploy-stage）
# ④ 权限
# ⑤ 重启        ← 中间从来没有 "把 STAGE 同步进容器"
```

同时健康检查写成 `docker exec ... curl http://127.0.0.1:8081/health`，
而**容器里没有 curl** → 永远 000 → 判定失败 → 走回滚：

```bash
docker cp $BK/deploy-$TS.tar.gz ...
tar -xzf rollback.tar.gz     # 保留 mtime，整份覆盖回上一版
```

本会话里它把主线刚提交的 6 个文件覆盖回去过两次（现象：刚测试通过的文件几分钟后
自己变回上一版，git 里只看到一次 auto 快照，很难查）。

修法：补上 `docker cp $STAGE/. $C:$DST`；健康检查改用 node 的 fetch；
回滚前先把"当前现场"另存一份再覆盖。

### 2. 浏览器缺失会**崩掉整个 CLI**

`browser.mjs` 的 `spawn(CHROME_BIN())` 没挂 `error` handler，
容器里没有 chromium → `ENOENT` 变成 unhandled `'error'` → 进程直接退出。
`web search` 在空结果时会回退到浏览器，于是 `look_up` 子进程死掉、工具返回失败
（实测连调三次全 `✗`，她只能说"没搜到"）。

修法：挂 handler + 立刻返回 null（别等 20s）+ `hasChromium()` 作为**唯一**能力探测
（`tools.mjs` 与 `web.mjs` 都用它，不再各写一份）；没有浏览器就直接走 fetch。

### 3. 自改代码的整文件覆盖

`selfmod.apply/selfApply` 会直接把提案里的完整文件内容写回。如果提案是几分钟前
基于旧内容生成的，写回就等于把别人刚提交的改动整份覆盖。加乐观锁：
提案之后文件 mtime 变过 → 放弃写回并记 conflict。

### 4. 门禁误报（她自己写的代码被冤枉）

`function finalize(state, now = Date.now(), why = '')` 被报 "why 从未声明" ——
形参解析用 `\\(([^)]*)\\)`，遇到 `Date.now()` 的 `)` 就截断，后面的形参全丢。
改用配平后的形参块切分。规则误报比漏报更坏：久了没人看。

## 七、最终状态

```
node tools/run-tests.mjs   → ✓ 106 套（exit 0）
node scripts/check.mjs     → ✅ 365 文件（exit 0）
sudo dsh-bot-deploy --no-restart → exit 0，同步 261 文件（不再回滚）

真实冒烟（QQ 私聊，问「大肥鱼小课堂那个系列是啥？B站上有吗」）：
  🌐 该查没查（fact-question）→ 重写：bili_search✓ look_up✓
  她回：B站上真有…「⚡️这三句话已被人类拉黑⚡️」UP主卡布奇诺ultra，
        八十几万播放，BV1qbn16kEFh。还有条「⚡️大肥鱼教人类学⚡️」，BV1CAnN6uEUN…
        我自己还没点开过，光看标题猜是一分多钟的小科普。

主动逛（生产首次）：
  wander → 《近十几年的梗都在这里了》299.4万播放 · BV1mv4Y6rESW
  web/wander.json: {day:"2026-11-07", count:1, seen:[BV1mv4Y6rESW]}
```

---

## 八、第二轮：逛得像她自己（2026-11-07 深夜）

第一版的 `wander` 只会**刷热门** —— 那是"刷推荐流"，不是"她的兴趣"。
这一轮把选题改成四级，并且把"逛到"变成"惦记着"：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 显式关键词 | 有人指定/研究需要 |
| 2 | **`bot.mjs feed` 的偏好选题** | 复用现成的"热门+搜索+偏好命中（美食/猫咪/AI）+ 7 天内去重"评分。自己再写一套就是第四份"两条路线漂移" |
| 3 | 最近常说的词（`lexicon.json`） | **只读**，不 import brain（避免 lib→brain 反向依赖）；含虚词/2 字词/7 天外的词一律过滤 |
| 4 | 热门 | 真正的"瞎逛" |

实测（生产）：

```
source=feed → 《【AI拨号机器人】读A岛经典短篇《机器爱人》》· 猫菇Maogu · 1.3万播放
              （命中她的偏好"AI 与 Agent 工具"）
```

### 两个当场抓到的坑

1. **分词垃圾当搜索词**：`lexicon` 是无分词的字块统计，"B站上有吗" 会切出「站上有」，
   拿它去搜，第一条搜出**"P站，无码视频"**。修：兴趣词必须 3~4 字且不含
   虚词/助词/代词（的了是在我你他这那就也都还又要会能说看去来上下里吧呢…）。
   现在生产语料过滤后没有合格词 → 安全地退回热门。
2. **擦边内容进记忆**：热门/搜索里确实会出现成人向标题，而"逛到"会写进 episode、
   可能被说起。加 `BLOCKED` 过滤（无码/裸露/色情/约炮/里番/P站…），
   **不是审查她，是不把这类内容当成"今天的新鲜事"记下来**。

### 逛完要"惦记"

`body.browse` 在**当天第一次**逛到时写一条 inner（`kind: reflect`）：

```
刚在 B 站刷到《…》，有点想看
```

下一轮 system 的【心里还悬着】会带出来 —— 这样"逛过"才是她的经历，
而不是一条只写进 jsonl 的日志。只写第一次：每次都写会把 inner 池刷满，
反而挤掉真正没说完的话。

### 为什么"现在"不一定在逛（如实记录）

`body.browse` 只是候选之一，选不选由 `self.decide()` 的权重 + 她的第一人称判断决定。
实测（凌晨 00:00 前后）：

```
heartbeat 在跑（field.json 每分钟更新）
但 self-state 停在 23:41 —— 说明这一段时间她一直选的是同一个动作（深夜偏向 rest）
```

这不是"逛坏了"，是她的作息：**深夜本来就该休息**。为了让"会逛"不等于"永远不逛"，
加了一条仿生权重：**多久没出去转**（读 `web/wander.json` 的 `last.at`）——

| 距上次逛 | browse 权重 |
|---|---|
| < 6 小时 | +0 |
| ≥ 6 小时 | +0.15 |
| ≥ 24 小时 | +0.25 |

（把它设成 25 小时前做过一次对照：日志里仍未见 `[body] 🧭 逛到` —— decide 那几拍
仍然选了别的。真实验证见"手动触发"与单测；"自然触发"要等她白天自己想起来。）
