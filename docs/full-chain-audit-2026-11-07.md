# 全链检查 · 六遍修缮（2026-11-07）

对象：整个 dsh_bot 插件（tools/ + lib/ + client.js，约 340 个源文件）。
方法：每遍一个主题，先取证再改，改完用可归因命令验收。

## 第一遍：运行时与运维面

**取证**（只读脚本扫 10,145 个文件 / 2.0GB）：

| 观察 | 数据 |
|---|---|
| 网关日志 ERR | 采样 4000 行 602 条，其中 **570 条是"已有另一个实例 → 让位退出"** |
| 重复行 | `[im-gateway] exited code=0 after 0s, restarting in 300s` ×590 |
| 进程 | RSS 114MB / fds 20（健康） |
| 状态新鲜度 | field/inner/hpa 0 分钟；neuromod 185 分钟（无消息时不动，符合设计）；sleep.json 555 分钟（醒着，正常） |
| 磁盘 | 2.0GB：asr 模型 464MB、旧源码快照 260MB、browser-profile 145MB |

**问题与修复**

1. **让位被当成故障**：`logErr` + `exit(0)` → 守护按"秒退"指数退避到 300s，真崩溃时留下 5 分钟空窗。
   → `exit(75)`（EX_TEMPFAIL）+ INFO 日志；守护识别 75 走固定 10s 重试。
2. **端口占用无 handler**：`listen` 的 error 事件没人接，抛栈崩。
   → 明确日志 + `exit(75)`。
3. **守护退避太钝**：跑满 5 分钟才算稳定、封顶 300s。
   → 60 秒算稳定、封顶 60s。
4. **日志无轮转**：`>> /tmp/im-gateway.log` 无限追加。
   → 启动时 >5MB 归档一份。
5. **旧快照/备份散落**：配置备份 10 个在 `.dsh/` 根目录。
   → 归档到 `.dsh/retired-config-backups/`，保留最近 2 个。

**验收**：手动起第二个实例 → `EXIT=75` + `已有另一个实例在跑（端口 8081）—— 本实例让位（exit 75）`。

## 第二遍：数据一致性

**取证**

| 项 | 结果 |
|---|---|
| 旧库 `qq/episodes.jsonl` vs 新脑 `brain/ep/*.jsonl` | 尾 60 条 **0 缺失**（双写一致） |
| `jsonl` 坏行（抽尾 500 行/文件） | 0 |
| `json` 解析失败 | 1（Chromium 自带的 ThirdPartySets，无关） |
| 段索引 27 条 | 内容存 `closed.jsonl` + index.open，不是独立文件 —— 原假设错误，**非缺陷** |
| 孤儿状态 | cohere 11 个 / working 3 个，其中 10 个是我自己探针留下的测试号 |

**修复**：删测试号状态（`qq_999000111/222`、`qq_final-*`、`qq_probe-*`），只留真实会话。
配置迁移备份（含历史键名）保留最近 2 个，其余归档。

## 第三遍：IO 可靠性

**取证**：`callApi` 网络异常/5xx **直接返回 null**；发送循环不检查返回值；之后**无条件**写 assistant 记忆。
后果：网关重启的几秒里，回复丢失，但她"记得自己说过"——下一轮会引用一句用户从没收到的话。

**修复**

1. `lib/qq-call.mjs`：网络异常 / 5xx 重试一次（400ms）；业务失败不重试。
2. `lib/inbound-dedupe.mjs`：按 `message_id` 去重（10 分钟窗、500 条上限）。
3. **交付核对**：一条都没发出去 → 不写对话记忆，只进 `rememberAudit(kind:'unsent')` + `[ERR]`。
4. 顺带修掉一个真 bug：去重守卫第一次插入时 anchor 失配，`isDuplicate` 只 import 没调用（门禁不报，因为 import 被用到）。补上后实测日志 `重复投递（message_id 已处理）：跳过`。

**验收**：注入同一个 `message_id` 两次 → 第二次被拦；向非好友发送 → `这条一条都没发出去（网关/权限）—— 不进对话记忆`。

## 第四遍：延迟

**取证**（12 个完整轮次，日志时间戳分解）：

```
中位 11.8s · p90 28.8s · 最大 37.3s
典型：停顿 1.5s + 装配 1.6s + 内省 4.7s + 生成/发送 2.5s
```

**修复**

1. **内省快速通道**：EMOTE / ACK / CLOSING 不跑"先想一遍"（省 4~5 秒）。单测：`skippedBy=trivial`、20ms。
2. **生成失败不再静默**：LLM 超时/报错时发一句"等我一下，刚才那句没接住"，而不是整轮无回复。
3. 顺带修掉两处 `o is not defined`（`introspect` 与 `thinkThenSay` 的参数解构漏了 `percept`）——这两个 bug 会让内省整层静默失效。

## 第五遍：故障注入

| 注入 | 结果 |
|---|---|
| `kill -9` qq-server | 守护 10s 内重启（`exited code=137 after 92s, restarting in 10s`），新进程正常监听 |
| `neuromod.json` 写成 `not-json` | 服务不崩，读取回退基线，下一次写入自动重建 |
| `brain/cohere/qq_*.json` 写成 `{broken json` | 不崩；该会话下次写入时重建（测试通过了新建路径） |
| 重复投递同一 `message_id` | 第二次跳过 |

## 第六遍：终检

- `docker exec dsh_bot bash /home/dsh/.dsh/verify.sh` → 4 个退出码全 0、`VERDICT: PASS`
- 全量 102 套测试通过；门禁 344 文件全绿
- 启动日志新增一行「可用工具」，避免"清单撒谎"再现（本机无 chromium → 不列 `browse_page`）

## 遗留（明确不做）

- `snapshots/self-2026-11-02.tar.gz`（260MB）：用户自己的源码快照，不动。
- `browser-profile`（145MB）：容器无 chromium，但装上就能复用，不动。
- ASR 模型 464MB：唯一一份，不是双份（`stat` 硬链接数=1）。
- 未使用导出 168 个：多数是测试/诊断 API 或文档常量，删除收益低于风险。
