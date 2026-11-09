# 工作台：让她的"手"够到文件与本机（2026-11-09）

> 起因（用户原话）：能不能在保证**容器外部数据安全**的前提下提高她的自由度，
> 让她在 QQ 里真的能办公 —— 之前让她搜索、去 B 站找视频和专栏、在本地找东西，
> 她"都不会，或者分辨不了"。

## 0. 先说诊断（实测，不是猜）

用现有工具清单跑四条真实请求（2026-11-09，容器内 `chatWithTools`）：

| 请求 | 旧行为 | 真因 |
|---|---|---|
| B 站找专栏文章 | 搜到视频，明确回"专栏我搜不到" | 搜索接口只用了 `search_type=video`，专栏是另一套结果 |
| 本地有没有南京的资料 | "我没有读文件系统的工具" | 聊天工具清单里确实没有任何 fs 工具 |
| 帮我写个脚本统计一下 | "我做不到，你得自己跑" | 同上，且聊天工具单件 12 秒、整链 30 秒 |
| B 站找某条视频 | ✅ 正确定位 | 这条一直是好的 |

结论：她**没有编谎**，是清单里真的没有那几只手。所以问题不是"人格/分辨力"，
是**能力面**：`CLI 有、聊天入口没有`，以及 `能力有了但装不进 12 秒`。

## 1. 安全边界在哪（先钉死，再谈自由度）

`docker inspect` 实测，容器只挂了这几个路径：

```
/home/dsh/plugins/dsh_bot ← 宿主 /home/dsh_bot/app（她的代码，可写）
/home/dsh/.data           ← 记忆/账本/素材
/home/dsh/.dsh            ← 配置/工作目录
/mnt/stickers、/opt/dsh
```

宿主其它数据（`/srv`、`/mnt/data`、其他用户目录）**不在容器里**；
容器内 `uid=951`、`CapEff=0`（无任何 capability）、seccomp 过滤、没有 docker.sock。

所以「给她手脚」不需要动任何挂载 —— 她的爆炸半径 = 她自己的数据 + 她自己的代码。
**容器是边界，白名单不是。**

`sandbox.mjs` 那一层挡的是另一种事故：她手滑删掉自己的记忆。规则：

1. 路径只许 `HOME` 之内（`resolve` + `realpath` 双重校验，`../` 与软链接逃逸都拒）
2. 代码目录**只读** —— 改代码必须走 `selfmod`（备份/语法/门禁/回滚），从 `run_command` 写等于绕过安全网
3. `credentials.json` / `bot.config.json` / `*.pem|key` 聊天里不读写
4. 命令白名单 + 危险参数拦截 + 不走 shell + 8 秒上限；`rm/sudo/docker/ssh/sh` 一律拒，`git` 只放只读子命令

## 2. 三层结构（为什么不是"把预算调大"）

```
聊天（12s/件，30s/条）          办公台（独立进程，12min/20步）
─────────────────────          ─────────────────────────────
find_files / read_file   ──→   同一批工具，只是不限时
write_file / run_command        ↓
bili_search / bili_article      产出落 .data/office/<id>/report.md
office_task（只立项，<1s）──→   跑完 sendOwnerQQ 主动汇报
```

把聊天预算调大是错的方向：那会让每句闲聊都可能变慢。多步活必须**立项**，
这是 `research_topic → research work` 已经验证过的形态。

## 3. 落点

| 能力 | 文件 |
|---|---|
| 路径/命令边界 | `tools/lib/sandbox.mjs`（新） |
| 找/读/写/跑 | `tools/lib/workbench.mjs`（新） |
| 办公台引擎 | `tools/lib/office.mjs`（新）+ `tools/commands/office.mjs`（新） |
| 工具注册与分发 | `tools/lib/tools.mjs`（+`bili_article`/`office_task`/四个工作台工具；`look_up` 不再在有/无浏览器都先试一次） |
| 专栏接口 | `tools/lib/bili-web.mjs`（`searchArticles` / `articleDetail`，`/x/article/view?id=`，-509 重试） |
| 系统提示词 | `tools/lib/persona.mjs` `capabilityBlock()` 加"哪只手接哪件事" |
| 开关默认值 | `tools/lib/config.mjs` `workbench` / `office` |
| CLI | `tools/bot.mjs` 注册 `office` |
| 回归测试 | `test/workbench-test.mjs`（26 条，已注册进 `tools/run-tests.mjs`） |

## 4. 判据（实测数字）

- `test/workbench-test.mjs`：26 条全过（`../`穿越、软链逃逸、凭据、代码只读、`rm/sudo/sh/git commit/sed -i/find -exec`、512KB 上限、1.2 秒超时杀进程）
- 工具清单：`CHAT_TOOLS` = 14 个（`qq-server` 启动日志实测打印）
- 专栏：`bili_search type=article` 返回 6 篇；`bili_article cv27300566` 读到 8875 字正文
- 办公台：`office start` < 1.5 秒立项；一个 6 步任务 45 秒内 `done`，产出 `report.md` + 结论（204 个 json / 最大 2.63 MiB 来自工具输出）
- 边界实测：`run_command "node -e while(true){}"` 1.2 秒被杀；`write_file` 600KB 拒；写 `plugins/dsh_bot/tools/lib/tools.mjs` 拒（提示走 selfmod）

## 5. 开关

```jsonc
"workbench": { "enabled": true, "exec": true, "write": true },
"office":    { "enabled": true, "maxSteps": 20, "maxMinutes": 12 }
```

关掉 `workbench.enabled` → 四个工作台工具与 `office_task` 直接从工具清单消失（清单即承诺），
不是"给她了再拦"。

## 6. 已知边界（别当成 bug）

- 容器里没有 chromium → `browse_page` 不出现，`look_up` 的 fetch 走静态抓取；SPA/公众号读不全
- 单件工具 12 秒：网络搜索正常 3~9 秒，够；不够的活请走 `office_task`
- `run_command` 不走 shell：`|`、`>`、`&&` 都只是普通字符，要管道就写进脚本再 `node x.mjs`
- 办公台同时只跑一件（第二件会被告知"手上还压着一件"），避免她把自己机器跑满
