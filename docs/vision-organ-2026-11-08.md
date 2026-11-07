# 视觉器官（2026-11-08 晚）

## 一、为什么要"器官化"

看视频的能力早就齐了（预测误差切事件、色度、显著性、人脸口型、声音纹理、跨通道对齐），
但它们是**四个文件里的函数**：`retina` / `audition` / `watch` / `videoframe`。

没有一个地方能回答"她的眼睛现在怎么样"：

| 问题 | 之前 | 现在 |
|---|---|---|
| 今天看了几次？几次没看成？ | 只有日志里零散一行 | `vision.snapshot()`：looks / ok / fail / interrupted / okRate / avgMs / lastFailWhy |
| 最近一次覆盖了整片的多少？ | 只有时间线里一句"只抽看了 N 段" | `last.coverage`（0~1），打断时是"看到 X 秒 / 全片" |
| 耳朵现在可用吗？ | 每次到用的时候才知道 | `snapshot().ear` |
| 她**在看的当下**知道什么？ | 只能等整片 decode 完 | `onProgress` 每解完一个窗口就交付一次印象（默认 3 秒档） |
| "没看成"会变成体感吗？ | 不会，永远只有日志 | `field.sense()` 里会出现"刚才那段视频没看成（打不开）"，6 小时后自动消失 |

## 二、契约（与 pain / vitals / metabolism 同一家族）

```
look(input, opts)   看一次（唯一入口，videoframe 也走这里）
read()              最近一次读数
sense()             第一人称体感（多数时候空）
llmState()          表达参数（只看了开头 / 没听清人话 → 收着说）
snapshot()          体检读数
phrase(imp)         增量印象 → 一句可测事实（不含语义）
```

状态文件：`brain/meta/vision.json`（`mutateJson` 真锁，跨进程安全）。
**器官不决策**：要不要说、要不要再看一遍，是行为层的事。

## 三、增量印象（这次真正新增的能力）

```
retina.analyze(onProgress)   →  每个窗口解完回调一次
    ↓  { t0, t1, cuts, moved, peak, detail, partial, windowsDone }
vision.look(onImpression)    →  透传（并把错误隔离在回调外）
    ↓
qq-inbound                   →  第一条印象进日志：👁 印象 0.0-3.0s：有动作（此时整片还没解完）
```

要点：**回调绝不允许拖垮解码**（try/catch 包住），**未解完的窗口说"还没看清"**
（`phrase({partial:true})`），不许把没看的区间写成"静止"。

刻意没做：让她在看的过程中主动发消息。器官只交付印象，要不要开口是
`body`/`qq-server` 的判断 —— 否则长片每 3 秒一条，会变成刷屏。

## 四、转写终于能被掐断

上一轮遗留：插话后 whisper 还在后台跑完，结果被丢弃。现在 `execFile` 的 `signal`
一路传下去（`audition.listen → asr-core.transcribe`），进程被直接杀掉；并且
`transcribe` 的 catch 会区分 **AbortError（被打断）** 和真实异常（不把"她插话"
记成"ASR 坏了"）。

## 五、接线与依赖方向

`videoframe.mjs`（tools/lib）→ `brain/organ/vision.mjs` 是 lib → brain 的反向依赖，
已按既有机制登记进 `check.mjs` 的 `ALLOWED_REVERSE`（与 `cohere-bridge` /
`sensory-gain` 同形：器官在脑、适配层在 lib）。

体感走 `brain/organs/senses.mjs` 的命名空间（动态 import 断环），`field` 永不知道
vision 的存在 —— 这是 2026-11-03 定的规矩，新增器官只挂接线板。

## 六、判据（全部可复现）

| 判据 | 命令 | 期望 |
|---|---|---|
| 器官六组断言 | `node test/vision-organ-test.mjs` | 退出码 0；记账 / 增量印象 / 失败原因 / 体感 / 表达 / phrase |
| 依赖方向 | `node scripts/check.mjs` | 退出码 0（376+ 文件；新增白名单有理由） |
| 全量 | `node tools/run-tests.mjs` | 退出码 0；111 → 112 套 |
| 生产链路 | 伪造 OneBot 视频事件 | 日志出现 `👁 印象 0.0-3.0s：…（此时整片还没解完）`；`vision.json` 的 `looks` +1 |

实测（隔离数据目录）：

```
vision.sense:    "刚才那段视频没看成（打不开）"
vision.snapshot: {"looks":1,"ok":0,"fail":1,"okRate":0,"avgMs":1,"lastFailWhy":"没有拿到可读的文件",...}
field.sense:     "感觉刚才那段视频没看成（打不开）。"
```

生产链路（真实 QQ 私聊，3 秒素材：1.5s 静止 + 1.5s 动态）：

```
[qq] 👁 印象 0.0-3.0s：换了镜头（此时整片还没解完）
[qq] 👁 日常：脑力 0.44·血糖 0.33·烦躁 0.40 → 4 段/4 张
vision.json: looks=1 ok=1 coverage=1 ms=975 frames=3 events=2 · ear=true
```

注意顺序：印象先出（20:12:32.353），随后才是看片姿态与整片结论（20:12:33.089）——
"边看边知道"在生产里是真的，不是只在单测里。
