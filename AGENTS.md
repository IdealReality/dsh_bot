# AGENTS.md —— 改这个仓库的开发约定

> 这是**开发约定**，给改代码的人 / agent 看。
> 她自己的运行身份是 `AGENTS.template.md`（部署到工作目录那份），两者不要混。

## 第一条：先读宪章

任何涉及"她"的状态 / 行为 / 表达的改动，动手前必须读 `docs/change-doctrine.md`。
那份文件规定了五维参照（化学 / 生物学 / 心理学 / 主观 / 哲学）的**强制落点**与**强制判据**。

## 硬规矩

1. **五维都要有落点**：每一维说出 `文件:符号`。只改 prompt / `persona.template.md` / 文案字符串，不算实现。
2. **五维都要有判据**：一条断言或一条数字区间，跑测试 **exit 0**；并给出旧实现红、新实现绿的证据。
3. **可归因**：新机制必须在 `~/.data/brain/*.json` 留下可读状态，事后能复盘数值。
4. **不变量 I5–I8**：单向依赖 / 体液唯一 / 语言无状态 / 可归因。见宪章第 2 节。
5. **收尾验证不许吞退出码**：不用 `| head` / `| tail` / `| grep` / `|| true` / 后台 `&` 代替结果。
   跑 `node test/<name>-test.mjs` 或 `node run-tests.mjs`，看退出码本身。
6. **六问进提交信息**：现象 / 机制 / 器官形状 / 曲线验收 / 接线点 / 副作用。

## 环境事实

- 源码：宿主 `/home/dsh_bot/app` = 容器 `/home/dsh/plugins/dsh_bot`（bind mount，改宿主即生效）。
- 状态：宿主 `/home/dsh_bot/data-home` = 容器 `/home/dsh/.data`；脑内状态 `~/.data/brain/`。
- 写权限：目录属主 `dsh:dsh`，`baka` 只有读权限；写入用 `sudo install -o dsh -g dsh -m 644`。
- 测试入口 `run-tests.mjs`；单测在 `test/*-test.mjs`。
