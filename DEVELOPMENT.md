# 后续开发工作区

从 2026-11-02 起，OpenChicken 监控台后续开发在此 Git 仓库进行。

- 仓库根目录：`/home/cyz/openchicken/console/openchicken_console`
- 远程 origin：`git@github.com:crown133/openchicken_console.git`
- 监控台源码：本仓库的 `console/` 子目录（保留导出包原有相对路径结构）。
- 启动、依赖及测试：见根目录 `README.md`。
- 原目录 `/home/cyz/openchicken/console` 的旧源码保留；旧监控服务已于 2026-11-02 按用户要求停止。后续从本仓库启动监控，新代码不会自动启动或替换任何机器人端服务。
- 实际连接配置、密钥、运行档案不纳入 Git，新环境需要独立配置。

`FILES.sha256` 用于核对最初导入的导出快照，后续修改由 Git 记录，不代表后续版本文件必须继续匹配该历史清单。

## 2026-11-04：遥控通知与关键操作回执

- 浏览器与主机发送 `reply: false` 的 `pad_input`、`drive`、`head`、普通技能按键和心跳，不创建逐条等待的请求。普通技能按下沿发送一次，不自动重试；发送成功只代表已交给传输层。
- Start/init、Start 长按归位、策略使能/切换、急停/relax、参数写入保留回复；接管、释放及工作区切换也保留会话管理回复。旧客户端未指定 `reply: false` 时保持原请求协议。
- agent 将行走与头部/机身/嘴部/声音处理分开，连续输入每条通道只保留一个最新待执行帧；按键队列最多 8 条。保留原输入有效期，排队及转发都不延长旧输入寿命。停止、归位、释放前取消待处理流；原生 IPC 请求不重试。
- 普通输入的错误通过 `control_notice` 和事件显示，不再因为缺少逐帧回执触发浏览器超时并释放控制。机器人在线状态、输入新鲜度及原生 deadman 机制仍生效。
- agent 通过状态帧发布 `control_stream_version: 1`。启用新输入链路需要同步更新主机和机器人桥接代码；旧 agent 会明确提示升级，不假定它支持新行为。

部署时需带上 `console/agent/runtime_agent.py`、新增的 `console/agent/control_stream.py`、新增的 `console/protocol/control_delivery.py`，以及它们原有的协议依赖；主机更新 `console/host/server.py` 和前端资源。无需修改 robotd 原生 IPC 协议。本次只修改仓库并做离线测试，未部署或重启实机服务。

验证入口：`console/tests/test_control_stream.py`、`test_runtime.py`、`test_pwm_bridge.py`、`browser-input-pause.cjs`、`browser-pad-holds.cjs` 和 `gamepad.mjs`。浏览器测试必须指向独立 SIM 服务，不对运行中的机器人执行。
