# 后续开发工作区

从 2026-11-02 起，OpenChicken 监控台后续开发在此 Git 仓库进行。

- 仓库根目录：`/home/cyz/openchicken/console/openchicken_console`
- 远程 origin：`git@github.com:crown133/openchicken_console.git`
- 监控台源码：本仓库的 `console/` 子目录（保留导出包原有相对路径结构）。
- 启动、依赖及测试：见根目录 `README.md`。
- 原目录 `/home/cyz/openchicken/console` 的旧源码和既有运行进程，本次未迁移或替换；新代码不会自动更新旧进程。
- 实际连接配置、密钥、运行档案不纳入 Git，新环境需要独立配置。

`FILES.sha256` 用于核对最初导入的导出快照，后续修改由 Git 记录，不代表后续版本文件必须继续匹配该历史清单。
