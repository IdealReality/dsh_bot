# 网关命名迁移：去 napcat 化（2026-11-07）

## 一、为什么必须改

网关**一直是 SnowLuma**（OneBot v11 兼容层），容器里从来没有 NapCat。
但配置键沿用了 `napcat_http` / `napcat_token`，于是一路误导到：

| 看到的东西 | 实际会发生什么 |
|---|---|
| 启动日志 `napcat_http: …` | 人去查 NapCat 装没装（它本来就不该在） |
| `token: MISSING` | 其实 token 配在 `qq.napcat_token`，是日志只认 `accessToken` |
| `napcat_launcher: D:/SnowLuma/...` | 看起来像两个网关并存 |
| `D:/NapCat/cache/qrcode.png` 探测 | Linux 上必然不存在，纯噪音 |

这不是审美问题：**误导排障**的代价是每次故障多花十几分钟找错对象。

## 二、改了什么

### 配置键（用户可见）

| 旧 | 新 |
|---|---|
| `qq.napcat_http` | `qq.snowluma_http` |
| `qq.napcat_token` | `qq.snowluma_token` |
| `qq.napcat_launcher` | `qq.snowluma_launcher` |
| `qq.napcat_qr_path` | `qq.snowluma_qr_path` |

### 代码

- 新增 `tools/lib/qq-gateway.mjs`：`gatewayBase / gatewayToken / gatewayLauncher / gatewayQrPath`
  + `migrateConfigFile()` + `bootGateway()`。
  所有调用点不再各自写 `cfg.qq?.xxx || 'http://127.0.0.1:3000'`（默认值散落 = 改一处漏三处）。
- 变量/函数/注释/日志：`NAPCAT` → `SNOWLUMA`、`checkNapcat` → `checkSnowluma`、
  `findNapcatQr` → `findSnowlumaQr`。
- `lib/legacy-qq-keys.mjs`：DSH 插件壳（`lib/` 不能 import `tools/`）的唯一旧键读取处。
- 删除 `D:/NapCat`、`/opt/napcat` 的二维码探测路径（本机不存在）。
- 删除过期备份文件 `client.js.bak-fence-20261104`。

### 自动迁移

`qq-server` 启动时调用 `bootGateway()`：

1. 读配置文件，把旧键值搬到新键，删除旧键；
2. 原文件备份为 `bot.config.json.bak-<时间戳>`（600 权限）；
3. 原子写回（temp + rename，保留 600）；
4. 打一行：`[qq] 配置已迁移：napcat_http→snowluma_http napcat_token→snowluma_token · 备份 …`。

**跑过一次之后，用户的配置文件里再没有旧键。**

#### 踩到的坑（首启连错端口）

迁移完成后必须读**原始用户配置**解析地址，不能用 `config()` 的合并结果：
`DEFAULTS.snowluma_http` 默认 `http://127.0.0.1:3000` 会"新键优先"地遮蔽旧键里的真实地址
`http://172.17.0.1:3010`，首次启动直接连到错误端口（实测日志出现 `token: MISSING` + 3000）。
修法：`bootGateway` 迁移后重新读文件里的 `qq` 段，再与传入对象合并解析。
验证：把配置回滚成旧键 → 重启 → 日志为
`配置已迁移：…` 后接 `网关(SnowLuma): http://172.17.0.1:3010 · token: set`，配置文件只剩 `snowluma_*`。

## 三、防回流（门禁）

`scripts/check.mjs` 新增「旧命名回流」：

- 允许出现旧键名的只有两个兼容层：
  `tools/lib/qq-gateway.mjs`、`lib/legacy-qq-keys.mjs`；
- 其余运行时代码（`tools/`、`lib/`、根目录 JS）出现旧名即失败；
- `test/`、`scripts/`、文档/配置不扫（测试需要构造旧配置来验证迁移）。

门禁自己的匹配串用 `'nap' + 'cat'` 拼接，避免把自己报成违规。

## 四、回滚

1. 配置文件：恢复 `bot.config.json.bak-<时间戳>`；
2. 代码：`git revert b68d82d 253a973`（或直接切回上一提交）；
3. 兼容层保证了**旧配置在旧代码上仍然能用**，不会出现"配置读不出来"的中间态。

## 五、验证记录

| 项 | 结果 |
|---|---|
| 迁移日志 | `配置已迁移：napcat_http→snowluma_http napcat_token→snowluma_token · 备份 …` |
| 迁移后地址/令牌 | `网关(SnowLuma): http://172.17.0.1:3010 · token: set` |
| 配置文件残留 | `grep napcat bot.config.json` → 空；只剩 `snowluma_http` / `snowluma_token` |
| 门禁 | 342 文件全绿（含新的旧命名回流规则） |
| 全量测试 | 102 套通过（可归因脚本：`docker exec dsh_bot bash /home/dsh/.dsh/verify.sh` → `VERDICT: PASS`） |
