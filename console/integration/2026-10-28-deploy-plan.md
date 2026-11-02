# 控制台与本体运控接入

2026-10-30 按用户批准的精简方案更新。本文取代此前的新 Rust agent、额外遥测 IPC、锁存/epoch、跨机精度准入等设计；旧稿保存在 `artifacts/runtime-simplification-20261030/before/`。

## 硬件所有权

- `robotd` 内的 `DynamixelIo` 访问 14 DXL 和 I²C 机身 LSM6DSV16X；不再另设 `OpenChickenIo`。具体驱动机制见 [robotd 设计](../../openchicken_deploy/docs/design/robotd-design.md)。
- 头部 BMI088 使用原版 `tofd` 的 `head_imu.stream`，以 `--imu-only --imu-hz 50 --bus /dev/i2c-openchicken` 运行可不打开 ToF。原始协议保持 sensor axes；转发层按本机 Rz(180°) 转到头部坐标一次。
- `agent.runtime_agent` 只连接现有 Unix IPC，不导入 DXL/I²C probe，也不融合机身姿态或运行策略。
- 控制台所需数据尚未发布时，在运控中发布已有缓存；不能以缺少字段为由另开串口。
- 运控未覆盖的 CPU 占用、内存和音频枚举沿用同一转发进程的 1 Hz 系统采集。Pin31 可选读取已有输入 fd；不新建进程，不输出 GPIO。

## 现有接口

`robot.model` 给出关节顺序；`robot.subscribe` 给出位置、速度、电流、请求/提交目标、机身姿态和循环状态。`robot.health` 给出电压、SOC 温度和运行诊断，`robot.policies` 给出可用动作与坐姿状态。仅新增发布已采到的加速度、IMU温度、逐关节温度和错误缓存，API 升为47，服务与客户端配套构建。

原来的 15 个逻辑槽保留，嘴部无物理反馈。控制台按运控 joint_names 映射14物理关节，不把占位值当测量。`submitted` 是 RobotIo 写入成功的值，不是逐舵机回执；没有重新读取 Goal Position。未采集的 PID、力矩寄存器等显示未知，不伪造成软件状态。

监控帧协议统一为 `openchicken-runtime-v1`，不是新的运控协议。转发沿用已有 ZMQ TCP/CURVE；机器人 IPC 仍为原 JSON-RPC。页面约50ms更新，状态订阅请求20Hz，慢速状态1Hz。原状态订阅按时间间隔抽取，实际帧率随50Hz循环量化，不宣称严格20Hz。网络、录制和浏览器不进入控制循环。

## 命令

控制台只映射已有 `robot.init / robot.enable / robot.move / robot.stop / robot.relax / robot.do / robot.head`。Start=init；停止按钮=relax。init不隐式enable，不增加锁存、复位、lease/epoch或新的机器人状态机。原Safety、deadman500ms、Coast等行为保留。

浏览器接管只是监控主机上的窗口选择，不复制到机器人状态机；heartbeat不刷新move。保留旧浏览器输入过期检查，网络失败不自动重试运动调用，不将主机monotonic作为机器人deadline。此链路沿用原RPC接收语义，不宣称跨机端到端250ms有效期保证。

缺少可选数据显示未知，不用标定哈希、显示标签、固定刷新率或阶段性strategy_ready标志拒绝整帧。原协议认证、解析及硬件读错误正常保留；不扩展为控制台的安全判定。

## 配置与启动入口

复用现有 CURVE 配置中的 `robot_id / hostname / endpoint / public_key / secret_key / peer_public_key / role`，把 protocol 改为 `openchicken-runtime-v1`。agent 可指定 `robot_socket`、`head_socket`，默认 `/run/robotd.sock`、`/run/tofd.sock`。

需要转发命令时，主机和agent配置同一个 `control_endpoint`；不配置则只显示状态。这里表达实际网络接口是否存在，不是新的运控准入条件。

```text
python -m agent.runtime_agent --config <agent配置>
python -m host.server --robot-config <host配置> --port 8089 --demos 0
```

2026-10-30 已退出旧 `fusion_agent`，robotd/tofd取得设备所有权，runtime_agent转发IPC。最初的后台会话部署记录见 `../../artifacts/runtime-simplification-20261030/RESULTS.md`；现已按用户批准方案改为下述 systemd 开机服务。

### Radxa 开机服务与固定配置

板端根目录为 `/home/openchicken1/openchicken_deploy`。服务源文件位于 [deploy/radxa](../../openchicken_deploy/deploy/radxa/)，安装在 `/etc/systemd/system/`；只启用 `robotd`、`tofd`、`openchicken-agent` 三个服务，不运行原版整套安装器。

| 路径 | 用途 |
| --- | --- |
| `current → releases/20261030-boot-api47` | 现有 API 47 二进制和监控转发代码，未重新编译或修改运控 |
| `config/robotd.toml` | 当前机器人参数，只将五个策略文件改到正式路径 |
| `config/agent.private.json` | 原 CURVE 身份与端口，IPC 改到 `/run`；权限 0600，配置目录 0700 |
| `policies/v8-665ae4eb-boot-20261030/` | 已验证的 walk、sitstand、左右 kick、roulade 模型 |
| `deps/` | 已验证的 ONNX Runtime 1.28.0 和 pyzmq 27.1.0，不再引用测试目录 |
| `state/vetbook.json` | 保留的持久记录，独立于发布目录和 `/run` |
| `backups/20261030-boot/` | 切换前备份、固定配置副本、SHA256SUMS、baseline.json 和 activation.json |

robotd 和 tofd 以 `openchicken1` 运行，沿用现有 dialout/i2c 权限。systemd 创建 `/run/robotd/`、`/run/tofd/`，各自保存 IPC socket 和运行身份。Pin31 入口安装于 `/usr/local/lib/openchicken/open_runtime_pin31.py`：仍只取得已有输入 fd，然后降权并 exec 同一个 agent。agent 不新增舵机、IMU 访问。

开机不等待监控端或网络就启动采集和运控进程；agent 监听原 5557/5558 端口，主机按既有配置连接。没有自动 init/enable；操作仍为 Start 回位，再点策略使能。断开监控沿用原版 500 ms deadman，不等于自动断矩。服务的自动重启只重新启动进程，不重放命令。

服务状态和日志使用 `systemctl status robotd tofd openchicken-agent`、`journalctl -u robotd -u tofd -u openchicken-agent -b`。服务管理通过已授权的 root SSH 完成，不使用 sudo；正常运行的三个进程均为 UID 1000。监控台主机没有新增自启动服务。

升级或回退时，在未使能状态先停止三个服务，再切换 `current` 并启动，避免两份进程访问硬件。配置在 `config/` 独立保存，不随二进制回退自动覆盖；需要恢复参数时从对应备份恢复。旧发布目录保留。本次验收和哈希清单位于 [开机部署记录](../../artifacts/boot-autostart-20261030/RESULTS.md)。

T1/T3/T5临时采集模块和旧协议只用于历史诊断与旧记录兼容，不进入正式运行入口。旧独立硬件基准工具从生产examples移除，源文件在本轮before归档，不再把测试前后全寄存器审计或断矩检查放进常驻程序。

## 验证范围

本体相关测试在Radxa执行；本机只交叉编译及运行控制台假IPC/界面测试。修改后检查映射、SFLP数据和轴向、正常50Hz循环、状态转发，随后在授权范围验证原版命令。

T4后续、板端记录回放、固定长测和故障矩阵取消。音频实操、供电切换、相机、嘴部及高级动作继续暂缓。片内SFLP已完成本机真实采样及约50Hz循环上线核对；实物动态姿态精度和生产运控动作尚未验收。
