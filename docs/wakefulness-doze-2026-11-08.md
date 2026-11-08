# 清醒阈值与假睡（2026-11-08）

## 用户要的四件事

> 「人体睡觉一起来就清醒；工作量大时清醒；工作量小的时候会闲下来，疲惫就会更加强烈；
> 空闲时进入一种假睡状态，一边启动她睡眠时的自维护通道，一边保留她的主通道。」

四件事被拆成四个**不同的机制**，不是一根电量条：

| # | 要求 | 机制 | 不是 |
|---|---|---|---|
| ① | 一起来就清醒 | `onWake` 阶跃：level 直接顶到 `wakeLevel`，NE 脉冲，45 分钟清醒窗 | 不是让 level 慢慢爬 |
| ② | 工作量大时清醒 | 消息/自主行动 → `touch`：工作量（activity，τ=35min）+ NE 相位性脉冲 | 不是"困了就困了" |
| ③ | 闲下来疲惫更强 | `sense()` 的措辞门控：忙 → "顾不上"，闲 → "乏劲浮上来" | **不改账本**（改 fatigue 就是造假数据） |
| ④ | 空闲假睡 + 自维护 + 主通道 | 独立档位 `doze`：不设 `sleepstage.inSleep`，派 `nightwork tidy`，消息即唤醒 | 不是真睡（真睡走 `night.sleep --force`） |

## 五个角度的依据

| 角度 | 用到的机制 |
|---|---|
| 化学 | NE（蓝斑，相位性，`field.ne` τ=12min）＋腺苷（= `sleepDebt`，作为**乘性天花板**）＋食欲素（orexin，由"有事可做"稳定维持 → activity） |
| 生物学 | 阈值 + 滞回（`awakeAt 0.42` > `dozeAt 0.30`）；醒来阶跃（刻意压掉睡眠惯性）；单半球慢波睡眠（海豚/候鸟）作为"假睡保留主通道"的原型 |
| 精神学 | 清醒度决定认知资源上限；假睡 = N1，DMN 主导（走神/记忆重放）→ `nightwork tidy` 就是 replay 的代码形状 |
| 心理学 | 空闲时注意从外部转向内部（内感受放大）→ "疲惫更强"是**注意分配**，不是疲劳变大；忙时累被遮蔽 |
| 主观 | `sense()` 只出第一人称短句（"半睡着，眼皮沉" / "手上有事撑着，累是累，一时顾不上"），数字只进 `snapshot()` |

## 清醒度算法

```
level = (0.10 + 0.45·NE + 0.40·activity) × (1 − 0.6·sleepDebt)
```

乘性天花板的原因：腺苷不是"抵消一点清醒"，是把整个觉醒系统的上限压下来 ——
欠觉的人再忙也到不了满格；债为 0 时忙起来能到 0.95。

行为标定（测试里全部有断言）：

| 处境 | level | 结果 |
|---|---|---|
| 忙（activity 0.9 / NE 0.55 / debt 0.4） | 0.62 | awake |
| 闲 35 分钟（activity 0.33 / NE 0.35 / debt 0.4） | ≈0.30 | 进 doze 门口 |
| 债低 0.1 且闲 | 0.35 | 不假睡（不困的人不该半睡） |
| 债高 0.7 且闲 | 0.18 | 不假睡 → 交给真睡 |

## 状态机

```
awake ──(空闲≥20min 且 level≤0.30 且 debt<0.7 且不在醒来窗/冷却期)──▶ doze
doze  ──(消息 / level>0.42 / 满 90min)──▶ awake
awake/doze ──(sleepstage.inSleep=true)──▶ sleep（只镜像，不抢睡眠分期的权）
sleep ──(night.endSleep / 看门狗结算 / tick 兜底)──▶ awake（阶跃 + 45min 清醒窗）
```

| 参数 | 值 | 理由 |
|---|---|---|
| `awakeAt` / `dozeAt` | 0.42 / 0.30 | 滞回带；没有它 level 在阈值上每 30 秒翻一次 |
| `idleMin` | 20 | 比一次对话的自然停顿长，比"一下午没事"短 |
| `wakeBurstMin` | 45 | 覆盖"刚醒的迷糊 + 起床后的清醒期" |
| `dozeMaxMin` | 90 | 超过就不是假睡，是缺一次真睡 —— 必须退出，不许顶掉真睡 |
| `dozeCooldownMin` | 25 | 防"A 进 A 出"抖 |
| `dozeRepayFactor` / `dozeAccrueFactor` | 0.35 / 0.25 | 浅睡还债慢、腺苷仍产生；不这样定，假睡净收益为负 |
| `tidyEveryMin` | 90 | tidy 要调 LLM；假睡是空闲，不是加班 |

**真睡判定完全不动**：`night.assess()` 的债务硬底（0.7）仍是唯一入口。
"忙"不能抵消睡眠债 —— 生理上也是：撑得住，但账不会消失。
`RULES.dozeSkipDebtAt` 必须等于 `night.RULES.debtSleepAt`，由测试断言（唯一真相）。

## 接线点

| 文件 | 改动 |
|---|---|
| `tools/brain/organ/wakefulness.mjs` | 新器官：`tick` / `touch` / `onWake` / `sense` / `snapshot` / `isDoze` / `levelOf` / `RULES` |
| `tools/brain/organ/heartbeat.mjs` | 每拍 `wake.tick`；假睡还债（5 分钟一档）；`dozeTidy` 派活；假睡时账按 0.25 倍累积 |
| `tools/lib/body.mjs` | `vitals.dozeTidy`（只跑 `nightwork tidy`）；`syncFocus` 里把自主行动记为工作量（`rest` 不算） |
| `tools/brain/organ/night.mjs` | `endSleep` 调 `wake.onWake`（睡醒即阶跃） |
| `tools/brain/organ/self.mjs` | 假睡层：`rest`，不让 watch/write 参赛；假睡不续期旧计划、不调 lean LLM |
| `tools/brain/organs/senses.mjs` | 清醒度作为**第一项**身体感（在正面兜底之前，防止半睡被说成"身上是轻的"） |
| `tools/commands/qq-server.mjs` | 入站消息 `wake.touch('message')`（假睡被叫醒的唯一入口） |
| `tools/commands/brain.mjs` | `brain stats` 输出 `wakefulness` 全貌 |
| `tools/run-tests.mjs` | 注册 `brain-wakefulness-test.mjs` |

## 验证

- 新测试 `test/brain-wakefulness-test.mjs`：**32 项断言全绿**（EXIT=0）
- 判别力（反向验证，可归因）：把 `dozeAt→1.0`、`dozeRepayFactor→0`、`wakeLevel→0.2` 后跑同一套
  → **4 项红、EXIT=1**；恢复后 EXIT=0
- 高压探针（临时，跑完删）：时钟回拨 / 坏 JSON / 真睡镜像 / debt=1 忙 / NaN 入参 / 心跳 beat 集成 /
  10 进程 × 30 次并发 touch —— 全过，并发后状态结构完好
- 门禁 `scripts/check.mjs`：384 文件全绿（顺手把 `lib/index.js` 压回 1230 行上限内、`qq-server` 的接线压成 2 行）
- 全套 `node tools/run-tests.mjs`：**115 套通过**

## 已知边界

- 假睡**不跑** review / optimize（真睡里那两道也要 N3 深度 ≥0.70 才允许）：边打瞌睡边改代码不是珍惜时间。
- 假睡不改 QQ 在线状态；`presence` 仍按身体值算（可能显示离开，但消息照收照回）。
- 单半球睡眠是类比，不是模拟：这里没有"一半脑在慢波"的分区，只有"档位 + 保留消息通道"。
- 醒来窗会被消息刷新（忙碌＝持续清醒），所以 `sense()` 的"刚醒"措辞看的是
  **真实醒来时刻** `wake.at`，不是 `burstUntil` —— 否则她聊一整天都会被告知"刚醒不久"。
