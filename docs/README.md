# docs/ 说明

`docs/` 下除本文件与 **`change-doctrine.md`（现行改动宪章）** 外，都是
**2026-11-08 与上游插件分离之前**的历史记录（设计论证、审计、事故复盘、交接书）。

阅读时注意：

- 其中的命令形态 `feiyu xxx` 是旧 CLI 名，现在的等价入口是 `node tools/bot.mjs xxx`；
- `~/.feiyu-ai/`、`feiyu.config.json`、`/home/feiyu/…`、`D:\dsh_bot` 等路径都已不存在，
  现行为 `~/.data/`、`~/.dsh/bot.config.json`、`/home/dsh/plugins/dsh_bot`（容器内）；
- 旧远端 `baishuyue/dsh_bot` 与 `baishuyue/dsh-feiyu` 已删除，唯一远端是
  `github.com/IdealReality/dsh_bot`。

历史正文不做篡改（改了就失去当时的事实价值）；**现行事实以根目录 `README.md` 与
`DEPLOY.md` 为准**。
