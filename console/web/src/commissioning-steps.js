// Local operating guidance, derived from docs/testing/新机标准部署与测试流程.md (V1).
// These are instructions and operator records, not executable robot commands.
export const stages=[
 ['N01',['建档与系统','Identity & system'],['确认新机身份、镜像和硬件基线。','Identify the new robot, image and hardware baseline.'],['机器人已烧录、接入网络；准备实际硬件信息。','Flash the image, connect the network and prepare hardware details.'],[
  [['系统身份','System identity'],['读取 hostname、系统、内核、架构和启动介质，核对 IP 与 SSH 用户。','Read hostname, OS, kernel, architecture and boot media; verify IP and SSH user.']],
  [['硬件与供电','Hardware & power'],['记录主板/HAT 编号、舵机型号、传感器与供电接法，附装配证据位置。','Record board/HAT IDs, actuator model, sensors, power wiring and assembly evidence.']],
  [['单机身份检查','Unique identity'],['完成 SSH N01 并回填实测 hostname；在“早期 ZMQ 状态连接”准备主机公钥，按展开步骤生成机器人端配置、保存机器人公钥并连接。不要复制样机密钥或校准。','Run SSH N01 and apply the measured hostname. Prepare the host key in Early ZMQ telemetry, follow its pairing steps, save the robot public key and connect. Do not clone keys or calibration.']]],
  ['身份和硬件信息与本机相符；上方 SSH N01 可执行系统检查，早期 ZMQ 连接提供持续状态。','Identity and hardware match this robot. Run SSH N01 above for system checks; early ZMQ provides ongoing telemetry.']],
 ['N02',['接口与驱动','Interfaces & drivers'],['确认稳定设备路径、权限和匹配的驱动。','Verify stable device paths, permissions and matching drivers.'],['核对板型与当前内核；配置写入前审阅差异。','Check board and kernel versions; review changes before applying configuration.'],[
  [['UART / I²C','UART / I²C'],['按控制器身份检查 /dev/openchicken-dxl 与 /dev/i2c-openchicken，核对权限和占用进程。','Check /dev/openchicken-dxl and /dev/i2c-openchicken against controller identity, permissions and owners.']],
  [['音频驱动','Audio driver'],['核对 Codec、时钟、声卡和驱动版本；不跨内核复制模块。','Verify codec, clock, sound card and driver version. Do not copy modules across kernels.']],
  [['重启复查','Reboot check'],['在配置获准应用后重启一次，复查设备别名、权限和驱动。','After approved configuration changes, reboot once and verify aliases, permissions and drivers.']]],
  ['重启后接口可用；未执行的写入和重启保持待测。','Interfaces remain available after reboot. Unperformed changes and reboot checks remain pending.']],
 ['N03',['舵机与机械','Servos & mechanics'],['核对 14 个 DXL 的身份、参数与机械映射。','Verify identity, settings and mechanical mapping of all 14 DXL servos.'],['无力矩；底层配置工具与 robotd 不同时访问总线。','Torque off. Low-level configuration tools must not share the bus with robotd.'],[
  [['通信与 ID','Communication & IDs'],['逐台确认型号、固件、ID 和安装位置；重复出厂 ID 分开配置，不广播改同一 ID。','Identify model, firmware, ID and location. Configure duplicate factory IDs individually; never broadcast one ID.']],
  [['参数差异与回读','Parameter diff & readback'],['读取必要参数，列旧值/新值及 EEPROM/RAM 类型；获准后写入并回读，保存恢复值。','Read required settings, review old/new values and EEPROM/RAM type, then apply approved changes and read back. Save originals.']],
  [['方向与机械零位','Direction & mechanical zero'],['选中关节，轻微手动活动对应部位；对照简图、3D 和曲线确认 ID 与正方向。安装零位不等于默认站姿。','Select a joint and gently move it by hand. Compare schematic, 3D and curves for ID and direction. Assembly zero is not the default standing pose.']]],
  ['参数回读与机械方向分别签收；结束确认无力矩、工具退出。','Sign off parameter readback and mechanical direction separately. Finish torque-off with tools stopped.']],
 ['N04',['外设功能','Peripherals'],['分别验证音频、双 IMU、电压和供电检测。','Verify audio, both IMUs, voltage and power detection separately.'],['运行服务已接管的设备只读现有反馈；不另开采集争用硬件。','Use existing feedback for devices owned by running services; do not start competing collectors.'],[
  [['扬声器与麦克风','Speaker & microphone'],['播放短音并现场听音；录制安静/说话片段并回放，分别记录双通道非零、削波和听感。','Play a short tone and listen; record silence and speech, then replay. Record nonzero channels, clipping and listening results separately.']],
  [['机身与头部 IMU','Body & head IMUs'],['核对安装坐标；观察重力、角速度、四元数和轻微转动。查看两个 orientation 与 3D，不重复安装旋转。','Verify mounting axes, gravity, angular rate, quaternion and gentle rotation. Compare both orientation panels and 3D; avoid applying mounting rotation twice.']],
  [['电压与 Pin31','Voltage & Pin31'],['仪表粗略对照 DXL 母线电压；条件允许时检查无/有外部供电两种状态。Pin31 不表示电量或充电。','Compare DXL bus voltage with a meter; check external supply absent/present when practical. Pin31 does not measure charge or charging.']]],
  ['枚举、实际功能和现场确认分别记录；可暂缓非行走项目。','Record enumeration, actual function and field confirmation separately. Non-locomotion items may be deferred.']],
 ['N05',['运控与监控接入','Runtime & monitoring'],['正式服务接管硬件，并核对监控连接。','Transfer hardware ownership to production services and verify monitoring.'],['在临时采集器终端按 Ctrl+C 并检查退出／恢复日志，断开早期 ZMQ 订阅；确认硬件释放，再按已审阅的部署方案交给正式服务。','Press Ctrl+C in the temporary collector terminal and check exit/restore logs; disconnect early telemetry. Verify hardware release before the reviewed production-service handover.'],[
  [['服务与 IPC','Services & IPC'],['检查 robotd、tofd 和 agent；显式核对 /run/robotd/robotd.sock、/run/tofd/tofd.sock。','Check robotd, tofd and agent, including /run/robotd/robotd.sock and /run/tofd/tofd.sock explicitly.']],
  [['双端连接配置','Paired connection settings'],['核对 robot_id、实际 hostname、5557/5558 或选定端口；独立密钥互换公钥，私钥不进入报告。','Match robot_id, actual hostname and selected ports (normally 5557/5558). Exchange public keys; keep private keys out of reports.']],
  [['真实遥测','Real telemetry'],['确认来源为真实机器人、14 关节和两路 IMU 有效；启动为 Limp / enabled=false。分别记录运控和显示频率。','Verify real source, 14 joints and both IMUs. Startup must be Limp / enabled=false. Record runtime and display rates separately.']]],
  ['接入成功不等于动作验收；新增连接不能自动 init 或 enable。','Connection success is not motion acceptance. Adding a connection must not automatically init or enable.']],
 ['N06',['Runtime 与策略','Runtime & policies'],['核对固定模型、接口和真实观测。','Verify pinned models, interfaces and real observations.'],['固定发布版本和 SHA256；隔离推理不下发舵机输出。','Pin release versions and SHA256. Isolated inference must not dispatch actuator output.'],[
  [['版本与加载','Versions & loading'],['记录适配程序、ONNX Runtime、模型版本与哈希；分别验证动态库和模型加载。','Record adapted binaries, ONNX Runtime, model versions and hashes. Verify library and model loading separately.']],
  [['模型接口','Model interface'],['验证 [1,61] → [1,14] 与必要的一次板端推理；哈希正确不等于推理通过。','Verify [1,61] → [1,14] and a necessary on-board inference check. Matching hashes do not prove inference works.']],
  [['观测来源与顺序','Observation sources & order'],['核对机身 IMU、关节顺序、rad/rad/s、默认位置扣除和上一网络原始输出；排除虚拟嘴部。','Verify body IMU, joint order, rad/rad/s, default-position subtraction and previous raw network output; exclude the virtual beak.']]],
  ['模型加载、隔离推理与物理动作各自签收；不复制样机校准常数。','Sign off loading, isolated inference and physical motion separately. Do not copy sample-specific calibration constants.']],
 ['N07',['回位与松力','Homing & relax'],['验证初次动作、Ready 和实际松力。','Verify initial motion, Ready and actual torque release.'],['现场确认固定支撑、行程和停止条件；在运行监控页操作。','Confirm support, travel and stopping conditions on site. Operate from the monitor page.'],[
  [['必要的小幅验证','Required small motion'],['仅对未确认的新装配，审阅指定关节、起点、目标和幅度后执行必要的小幅验证。','For unverified assemblies only, review joint, initial position, target and amplitude before a necessary small-motion check.']],
  [['Start → Ready','Start → Ready'],['在控制台按 Start；观察 init 回位与 Homing → Ready。原姿态分类可能回 home 或 seat。','Press Start in the monitor; observe init and Homing → Ready. Pose classification may select home or seat.']],
  [['Relax 与现场松力','Relax & physical torque release'],['在控制台按顶部急停/relax；查看 enabled=false 并现场确认松力。accepted 不能代替完成。','Use the monitor E-stop/relax; verify enabled=false and physical torque release. Accepted is not completed.']]],
  ['记录实际动作与结束状态；本页不提供运动命令入口。','Record actual behavior and end state. This page provides no motion command entry.']],
 ['N08',['控制台：基础策略闭环','Monitor: basic policy loop'],['验证起身、零速度站立与停止语义。','Verify rising, zero-velocity stance and stop semantics.'],['N07 已确认；支撑和现场停止条件有效。','Complete N07; maintain suitable support and stopping conditions.'],[
  [['手动使能与起身','Manual enable & rise'],['Start 后等待 Ready，再手动使能策略，速度请求先为零，观察坐姿起身或默认策略。','Wait for Ready after Start, then manually enable with zero velocity. Observe rising or the default policy.']],
  [['零速度站立','Zero-velocity stance'],['短暂观察姿态、关节跟随和控制循环频率，异常先检查观测与装配。','Briefly observe posture, joint tracking and loop rate. Investigate observations and assembly first if abnormal.']],
  [['停止与结束','Stop & finish'],['区分停止行走归零速度与顶部 relax 关闭力矩；结束后记录现场松力。','Distinguish stop walking (zero velocity) from relax (torque off). Record physical torque release at the end.']]],
  ['真实闭环行为独立验收，不用模型加载或按钮可点代签。','Accept real closed-loop behavior independently; model loading and enabled buttons are not evidence.']],
 ['N09',['控制台：移动与动作','Monitor: movement & actions'],['逐项验证基础移动和动作效果。','Verify basic movement and actions individually.'],['先通过基础站立；以机器人自身坐标解释方向。','Verify basic stance first; interpret directions in robot coordinates.'],[
  [['前后与转向','Translation & turning'],['分别测试前进、后退、左转、右转和松键停止，对照请求、反馈与实际方向。各方向单独记录。','Test forward, backward, left/right turn and release-to-stop. Compare commands, feedback and motion; record each direction.']],
  [['坐下与站起','Sit & stand'],['单独执行 sit_toggle，观察完整过程和结束状态，记录坐下与站起各自结果。','Run sit_toggle separately; observe the full sequence and end state. Record sitting and standing separately.']],
  [['踢球与翻滚','Kicks & rollover'],['基础移动确认后逐项测试左踢、右踢、翻滚；分别记录，未执行的动作保持待测。','After basic movement, test left kick, right kick and rollover individually. Untested actions remain pending.']]],
  ['结束使用 relax 并确认最终状态；不将模型存在标为动作通过。','Finish with relax and verify the final state. Model availability is not action acceptance.']],
 ['N10',['固化与交付','Persistence & handover'],['保存单机配置并验证真实重启。','Preserve robot-specific configuration and verify a real reboot.'],['明确本轮通过项、暂缓项和发布版本；审阅服务修改。','Identify accepted/deferred items and release version; review service changes.'],[
  [['发布与备份','Release & backup'],['保存 current/releases、config、policies、deps、state、backups 的实际位置，记录版本及恢复路径。','Record actual current/releases, config, policies, deps, state and backups locations, versions and recovery paths.']],
  [['真实重启','Real reboot'],['确认服务自行启动、监控重连、关节/IMU/电压恢复且仍未使能；软件重启不能代替供电切换。','Verify service autostart, monitor reconnect and joint/IMU/voltage recovery while still disabled. A reboot is not a power-cycle test.']],
  [['交付记录','Handover record'],['分别归档通用版本、单机配置和验收结果；保留暂缓与遗留问题，普通报告不含私钥。','Archive common versions, robot-specific configuration and acceptance results separately. Preserve deferred issues; exclude private keys.']]],
  ['重启不自动 init、enable 或恢复运动；报告只描述实际完成范围。','Reboot must not init, enable or resume motion. Reports describe only work actually completed.']]
];
