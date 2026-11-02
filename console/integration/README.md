# 机器人端运控接入：审阅稿

**2026-10-30 正式接入实现：** 硬件统一由底层运控访问；14 DXL＋机身I²C适配并回 `DynamixelIo`，监控使用 `agent.runtime_agent` 转发现有IPC，头部复用 `tofd`。API47。旧新增锁存、精度准入、新Rust agent/遥测IPC等草案取消；临时直接采集入口不用于生产。详细配置与边界见 [接入说明](2026-10-28-deploy-plan.md)。以下旧阶段记录保留为历史，不代表当前待办或运行状态。

**2026-10-30当前开发约束：** 新增控制台功能按已引入的microduck风格和安全标准实现，复用现有IPC/状态机/Safety，不自行增加另一套门槛、控制保护或复杂框架。接收端不重复推导传感器换算；测试只覆盖实际改动。T4后续和板端记录回放已取消。下文旧方案中的额外锁存、跨机时钟精度门槛、新遥测IPC/Rust agent等是待重新对照上游的设计草案，不是自动实施要求；已明确用户约定的差异须单列，不悄悄增删。见[精简审查](../../artifacts/console-simplification-review-20261030/REVIEW.md)。

**2026-10-30实时3D更新：** 用户要求显示当前机器人状态，已接入14关节反馈及机身LSM6DSV16X融合朝向；位置固定，BMI088不驱动头部，显示“仅监控/映射待校验”。WebGL实际加载、关节/四元数一致性、三轴旋转、失效回退及定格回放通过；不改变策略验收或控制权限。[验证结果](../../artifacts/console-live-3d-20261030/browser-result.json)。

当前协议 `openchicken-observation-t5-v1`，14关节速度进入遥测/录制，按ID对应策略顺序；数据读后时间跨度平均约36ms、最大约80ms，仍仅监控，BMI088待办保留。见[观测接入记录](../../robots/openchicken1/records/20261030OBSERVATION-console-test/record.md)。

**2026-10-30当前状态：** 已恢复8089只读监控，T5独立Runtime加载、两个官方模型各1000步合成推理通过；速度/真实观测只读版本已部署，65秒1247帧与录制/退出恢复通过；M04策略使用及运动未放行，头部BMI088异常仍待办。见[本轮记录](../../robots/openchicken1/records/20261029T5-console-test/record.md)。以下日期较早的暂停/未加载说明为历史状态。

**最新状态：用户准备断电，实机测试已暂停；SSH单次超时，未确认正常退出恢复，不再重连。头部BMI088数据不正确，已记 IMU-HEAD-01 TODO，后续再测，数据准确性未验收。下文“已上线”及进程信息为断联前记录。**

**2026-10-29 当前双IMU融合已上线：** `openchicken-orientation-t5-v1` 在 http://127.0.0.1:8089/ 显示机身与头部RPY；LSM6DSV16X按 `[Y,-X,Z]` 转换，BMI088暂按同机身轴向。真实浏览器短录制回放通过，5秒快速观察两路有效、舵机全部无力矩；观察序列有3帧跳过，未定位。仅监控、相对航向，头部安装/零偏仍暂定，不驱动3D或策略。因用户电池电量紧张，65秒观察和新版本退出/重启验收暂缓。详见[上线记录](../../robots/openchicken1/records/20261029IMUFUSION-console-test/record.md)；以下为历史阶段记录，旧“等待四元数/融合未实现”说明不代表当前状态。

**2026-10-29 T4/T5进展：** 30分钟只读观察完成：34952帧、平均51.50ms、5次单帧DXL读取超时（下一帧均恢复），双IMU/Pin31无无效样本。多页面、录制和隔离故障恢复已验证；高温时曾限频1.608GHz，用户已调整散热。T4部分通过，超时待定位。关节ID按用户已有标定接受，停止继续被动复测；电压粗略对照已接受，切电/音频暂缓。现进入T5依赖与模型检查，独立Runtime加载待批准，官方策略已定位到Hugging Face固定v8提交，真实观测尚不完整。详见[T4记录](../../robots/openchicken1/records/20261029T4-console-test/record.md)；下文保留历史进展。

2026-10-29 Pin31增量：临时 `agent.power_agent` 已部署，单线路预打开后降权为普通用户，Pin31保持输入、按3样本去抖；`openchicken-power-t3-v1`携带独立电源状态。静态高电平上行、录制、退出释放及重启通过，见[实机记录](../../robots/openchicken1/records/20261029POWER-console-test/record.md)。未做物理供电切换，不替代正式运控或电源保护。

2026-10-29 双IMU增量：已部署 `agent.imu_agent` / `openchicken-sensors-t3-v1`，头部BMI088与机身LSM6DSV16X的原始六轴和温度同步上行，正常退出会恢复批准的六项临时配置。[实机测试记录](../../robots/openchicken1/records/20261029IMU-console-test/record.md)包含65秒联合采样、录制与恢复证据。此处同步指同帧携带各自时间戳，不是硬件采样同步；姿态标定、融合及运控输入仍待实现。T2音频功能和完整T3仍未验收。

2026-10-29：临时 Python TCP/CURVE 只读链路已完成[T1系统](2026-10-29-t1-readonly.md)及[T3关节/电压接入测试](../../robots/openchicken1/records/20261029T3-console-test/record.md)。T3仅固定14个ID的READ，无命令通道；机械映射、Pin31和运动未验收。这不替代本文后续生产Rust agent与运控集成方案。

当前已实现主机与模拟器闭环，以及 `agent/system_probe.py` 的只读低频采集逻辑。首个 submitted 观测补丁已获用户批准并应用到本地源码；2026-10-28 已在 Docker 中通过 21 项 safety 测试并完成 ARM64 编译。下面是真实接入的明确边界和实施顺序，不代表已上线能力。

具体到 HAT 引脚、设备映射、源码文件、部署与验收的当前方案见[2026-10-28 部署代码修改方案](2026-10-28-deploy-plan.md)。其中包含比旧交接更新的 10 月 28 日增益与动作测试记录。

从真实只读状态到策略移动的测试顺序、入口条件和逐项用例见[控制台分阶段实机测试计划](../../docs/testing/控制台分阶段实机测试计划.md)。现有程序包尚不包含完整真实 agent 链路，不能直接作为只读监控后端启动。

最新范围调整：嘴部关节整体列为 TODO，本期不实现 PWM 控制、角度估计、标定或嘴部模型动画。保留 15 个逻辑槽位，仅接入和显示 14 个 DXL 关节；J15／Pin16／PWM8 接线记录保留。以不影响实际运控为验收重点，不设微秒级遥测开销、固定 CPU／RSS 或硬实时优化门槛。

ONNX 资源约定（2026-10-28）：先复用 MicroDuck 已有模型，保留模型原文件名、来源及兼容性标识，后续再替换为自有模型。当前代码的策略来源为 `pollen-robotics/microduck-policies`，最低版本基线为 `v8`，运行目录为 `/opt/robot/policies/current`；这不是已核实板端安装版本的声明。具体部署时记录选定提交和 SHA-256，并沿用既有模型接口检查。ONNX 模型与 ONNX Runtime 推理库分别管理，复用模型不会替代运行库依赖。下载、校验、集成仍遵守工作区远程资源约定。

## 已确认的硬件与操作约定

2026-10-28 用户确认。本节是控制台接入的当前约定，替代早期方案中“整机只有 14 个关节”“BMI088 可能作为机身 IMU”和“Start 对应 enable”的描述。后续开发直接沿用，不再重复询问 IMU 型号、安装归属和按钮映射；仅在用户明确变更时更新。

| 项目 | 确定约定 | 接入状态 |
| --- | --- | --- |
| Head orientation | HAT 板上的 BMI088 是头部 IMU，走 I²C；加速度地址 0x19、陀螺地址 0x68。对应 `head_imu`，完成安装变换后使用 `head_to_world`、四元数 `[w,x,y,z]`。 | 临时监控入口已接入 `head_imu_raw` 原始六轴和温度；生产常驻采样、姿态标定与融合待实现。不得将其填入机身姿态。 |
| Body orientation | J5 外接机身 IMU 为此前测试的 LSM6DSV16XTR，当前走 I²C，地址 0x6A、WHO_AM_I=0x70。对应 `imu`，完成安装变换后使用 `body_to_world`、四元数 `[w,x,y,z]`。 | 临时监控入口已接入 `imu_raw` 原始六轴和温度；生产常驻采样、姿态处理和运控接入仍为 TODO。后续迁移为 DXL IMU 另列 TODO，当前没有 DXL ID200 数据源。不得用头部 IMU 或单位四元数代替。 |
| 执行器总数 | 实际共 15 个舵机：14 个 DXL（ID10–14、20–24、30–33）＋1 个嘴部 PWM 舵机。 | 保留上游 15 个逻辑关节和 `mouth` 槽位；嘴部不是缺失关节。DXL 总线不访问 ID34。 |
| 嘴部关节 | 用户已确认接 J15：J4 Pin16／GPIO3_B1／PWM8_M0，无位置反馈。 | 整体 TODO：PWM 控制、估计角度、标定、显示及动画均不在本期实现；J15/J16 均不 export、不发脉冲。 |
| Start | 对应状态机 `init`，接入既有 `robot.init` 命令。 | 不自动附加 `robot.enable`，不把 init 返回 accepted 当作初始化完成。初始化完成及动作可用性由状态机报告。 |
| E-stop | 对应状态机 `relax`，接入 `robot.relax` 命令。 | 继续满足已确认的直接断矩并锁存要求，接受机器人可能倒下；不能因重连或普通 init 自动解除。上游 relax 当前无锁存，需在该路径补齐，而不是要求控制台改发另一个急停命令。 |

机身 IMU 型号与两颗 IMU 测试结果见[硬件测试总结](../../robots/openchicken1/records/2026-10-25至27-硬件测试总结.md)。两路姿态使用各自的采样时间及有效性，未接入时显示未知；头部与机身不能相互冒充。

本期 `mouth` 槽位禁用，数据无效，DXL 总线不访问 ID34。接口若保留 mouth 元数据，标记为未接入；不生成嘴部目标、反馈、估计值或跟随误差。后续实现时再引入 PWM 原始值和估计来源，不能将无反馈舵机标为实测位置。

急停锁存在机器人端，解除锁存与再次 init 分开。本期处理 14 个 DXL 的断矩确认及各控制入口的禁止重新使能；不声称已验证未接入的嘴部断矩。桌面端保留当前 14 关节模型，只接入真实 init/relax 状态；嘴部不作为本期交付依赖。

语音下达命令和 AI 对话列为 TODO；不开发双向对讲。本期保留相机回传：控制与遥测使用 ZMQ，视频复用 mediad 的 WebRTC 路径。

## 进程与线程边界

```text
机器人
  robotd 控制线程：唯一硬件所有者
    sensors / requested / submitted / validity / tick timing
       │ 最新数值快照，非阻塞交接，忙或满则丢弃遥测
       ▼
  robotd 普通 worker：抽取最新帧、协议编码、Unix domain socket
       │ 20 Hz 关节遥测；与命令 IPC 分开
       ▼
  robot-agent 独立进程：ZMQ、命令校验、控制租约、1 Hz 系统状态
       │ PUB/SUB 遥测 + DEALER/ROUTER 控制，TCP + CURVE
       ▼
监控主机：每机器人独立连接和队列 → 缓存/录制 → WebSocket → 浏览器
```

机器人 agent 生产实现应采用 Rust，并重用 daemon 的 IPC 类型；现有 Python 模拟器不部署成机器人运动服务。不要给每台浏览器建立单独 robotd 订阅，遥测在监控主机扇出。

快照包括内部 15 槽到 14 个 DXL 的显式映射、每字段有效位、servo_fault／torque 位图、sample_ns、seq、requested、submitted、feedback。无有效数据时置有效位为 false；worker 编码为 null，不产生零值反馈。保留 robotd 内部 NUM_JOINTS=15，mouth 槽禁用。优先使用现成的非阻塞队列或 try_lock 最新快照，争用时丢遥测；不为监控单独开发复杂的硬实时设施。

## 源码实际插入点

| 位置（本地 942e58e 基线） | 事实与拟变更 |
| --- | --- |
| `robotd/src/main.rs`，`control_loop` | 控制线程运行策略、安全处理、总线 I/O。新增路径只交接已有数值快照，不等待消费者；JSON、ZMQ、文件和 FK 留给普通 worker。优先复用现有设施，不为监控重构运控调度。 |
| `openchicken-control/src/safety.rs`，`Safety::apply` | `targets` 会被限幅，非有限数会改写为 hold；已按获批的 `001-observe-submitted-targets.patch` 增加 Applied.submitted。成功 write 后返回确实提交的数组，异常返回 Err 时不提供本帧 Applied。尚未接入遥测发送路径。 |
| `robotd/src/main.rs`，`last_targets = targets` 后 | 拟接收 Applied.submitted 并连同 sensors 复制快照；同 tick 配对请求与提交，反馈保留传感器读取时间。用 validity 区分总线失败，不增加读取次数。 |
| `robotd/src/main.rs`，现有 `state.state_tx.receiver_count()` 分支 | 有订阅者时在控制线程组装 Vec、String 和 FK；IPC 的 Hz 参数在发送侧降采样，不能消除控制线程构帧开销。新 agent 必须使用新的轻量遥测 IPC，不能订阅旧全量 state 来声称低开销。旧订阅路径首阶段保持原样。 |
| 慢速系统采集 | agent worker 读取 `/proc/stat`、`/proc/meminfo`、已识别 CPU/SOC thermal zone、ALSA PCM 枚举。当前原型支持通用 power_supply online；本机接入改用 robotd 普通硬件 worker 读取已验证的 Pin31／GPIO3_B4，agent 仅转发。采集无 subprocess、试播或录音；agent 不开串口，不能由电压推断外接电源。 |

补丁只是公开已有写入结果，不改变增益、目标值、范围、写入顺序或 watchdog。用户已批准应用并进行离线验证；应用时的生产代码差异经静态核对与批准的补丁一致。基线和修改后哈希在 `patch-baseline.json`，含测试差异在 `001-applied-with-tests.patch`，这些文件保留改名前的历史证据。三个现有 fake-IO 测试增加 submitted 与实际写入记录的逐项比较；新增测试验证普通目标和 NaN hold 的写入失败均返回 Err，恢复写入后报告新目标。2026-10-28 已在 Rust 1.94.1 Docker 环境运行 `cargo test --offline --locked -p openchicken-control safety::tests`，**21 项全部通过**；`robotd` 等 ARM64 release 程序编译通过。此次选定测试共 239 项通过，未执行完整 workspace 测试或实机验收，详见[构建验证记录](../../artifacts/radxa-build-20261028-r3/BUILD-REPORT.md)。

## 协议与控制约束

- 遥测 PUB 有界 HWM，丢弃可以接受；带 robot_id、boot_id、seq、单调采样时间、配置／模型版本。新会话清空旧曲线与控制租约，不拼接跨启动轨迹。
- 控制 DEALER/ROUTER 使用单独通道；每条请求有 request_id、owner_session、lease、seq、deadline、类型与参数。HWM 满时拒绝，不能排队重放旧速度。
- TCP/CURVE 公钥须显式绑定 robot_id；主机认证 Web 用户及控制角色。心跳、UI 隐藏按钮均不能取代机器人端租约检查。第一阶段回环服务的同源和 Host 限制不能当作生产鉴权。
- 不能跨机器直接比较 `time.monotonic()`。真实握手估计 robot 单调时钟偏移与不确定度，命令 deadline 换算到 robot 时钟域，扣除不确定度；无法满足精度时拒绝接管。不能在收到旧命令后简单重新赋予完整 TTL。
- 速度为最新值意图；机器人运控内保留本地过期检查，即使 agent 或网络线程阻塞也自行归零。实际超时值需与上游现有 deadman 共同确认，不能直接复制模拟器常数覆盖生产配置。
- 特定动作按 capability 列表生成 UI，含动作参数、动作编号、接受／执行／完成／拒绝／中断状态。动作编号去重，超时只查询结果，不盲重试。网络断开时正在执行的有限动作按 robotd 安全状态机处理；停止行走不能被宣传为硬件急停。
- 主机切换选中机器人先停止旧连续输入、释放旧租约，再接管新设备。禁止广播运动控制。

## 不影响实际运控的验收

以实际动作和控制循环是否受到影响为准，不追求监控链路的硬实时指标；无实机结果前不声称“零开销”。

| 项目 | 验证方式 |
| --- | --- |
| 监控交接 | 网络、序列化和录制不进入运控循环；消费者忙或队列满时丢弃遥测，不阻塞控制。 |
| 控制与动作 | 同机比较监控开关前后的实际动作、控制周期、超时及总线错误；如有可归因于监控的退化，先降低遥测／视频负载并解决后再上线。 |
| 实现复杂度 | 优先现成队列和普通 worker，不要求专用 SPSC、零分配证明、CPU 核隔离或实时调度改造。 |
| CPU/RSS | 观察资源使用是否稳定、是否抢占运控资源；不设固定 3% CPU 或 30 MiB RSS 门槛，有问题时再针对性优化。 |
| 背压与故障 | 暂停主机接收、断网、停止 agent、磁盘满、缓慢浏览器、10 个查看页面；运控周期和原有安全行为不得依赖它们。检查序号丢帧、记录丢帧及过期拒绝。 |
| 基线工况 | 在相同电源、策略与动作下比较无监控、遥测、视频、录制、多页面和网络劣化，覆盖稳定运行及故障恢复。运动测试须在 14 DXL／实际机身 IMU 适配和机构验证完成后单独授权；不等待嘴部 TODO。 |

## 后续实施顺序

1. 首个 submitted 观测补丁已批准、应用并通过 Docker 内的 21 项 safety 测试；ARM64 编译已完成，实机接入仍待后续步骤。
2. 生成并审阅简单的快照交接／IPC worker diff，随后在 fake-IO 检验不订阅旧全量 state、慢消费者不拖慢循环、缺失字段标记正确。
3. 实现 Rust agent、TCP/CURVE 和时钟协商；先两台电脑或隔离进程模拟测试，再审批只读板端遥测部署。
4. 按已确认约定完成内部 15 槽到 14 DXL 的适配、两路 I²C IMU 接入、方向和零位核对，特别是右膝；嘴部完整功能和机身 IMU 后续迁移 DXL 分别跟踪 TODO。审批 init/relax 接入、relax 锁存、运控动作入口与本地 deadman diff。
5. 完成监控开关及并发场景下的运控影响验证后再正式开放真实接管与动作。10 月 28 日测试已实际写入并回读 P=200，之后掉电仍可能恢复 RAM 默认值；详见最新部署方案的证据基线。后续 init 的增益初始化作为明确的运控补丁审阅，不在只读监控部署时写入。
