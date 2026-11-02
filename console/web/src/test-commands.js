import { english } from './i18n.js?v=20261101-commissioning';
const t=(zh,en)=>english?en:zh;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const q=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const settings=new Map();
const services='robotd.service tofd.service openchicken-agent.service';
const ownership=`systemctl is-active robotd.service tofd.service openchicken-agent.service padd.service netpadd.service\nfuser -v /dev/openchicken-dxl /dev/i2c-openchicken`;
const rpc=(methods)=>`python3 - <<'PY'\nimport json, socket\ns = socket.socket(socket.AF_UNIX)\ns.settimeout(3)\ns.connect('/run/robotd/robotd.sock')\nf = s.makefile('rwb')\nfor i, method in enumerate(${JSON.stringify(methods)}, 1):\n    f.write((json.dumps(dict(jsonrpc='2.0', id=i, method=method, params={}))+'\\n').encode())\n    f.flush()\n    while True:\n        line = f.readline()\n        if not line: raise RuntimeError('IPC closed')\n        reply = json.loads(line)\n        if reply.get('id') == i:\n            if reply.get('error'): raise RuntimeError(reply['error'])\n            print(json.dumps(dict(method=method, result=reply.get('result')), ensure_ascii=False, indent=2))\n            break\nf.close()\ns.close()\nPY`;
const block=(title,command,review=false,needs=[])=>({title,command,review,needs});

export function commandRecipe(step,s) {
 const cd=`cd ${q(s.root)}`;
 const script=(name,args='')=>`${cd}\ntest -f scripts/${name} && python3 scripts/${name}${args?' '+args:''}`;
 const ctl=`${q(s.ctl)} --robot-socket /run/robotd/robotd.sock`;
 const observe=`timeout 5s ${ctl} monitor --hz 5 --json`;
 const roots=['root'];
 const recipes={
 'N02.0':{
  source:'openchicken_deploy/scripts/setup-board.sh; scripts/setup-i2c.sh; deploy/openchicken/configure_hat.py',
  before:t('机器人 SSH 终端、普通登录用户。先查设备映射和占用，不运行总线扫描。','Robot SSH terminal, ordinary login user. Inspect device mapping and owners; no bus scan.'),
  blocks:[block(t('1 · 检查映射、权限和占用','1 · Inspect mapping, permissions and owners'),`id\nreadlink -f /dev/openchicken-dxl\nreadlink -f /dev/i2c-openchicken\nudevadm info --query=path --name=/dev/openchicken-dxl\nudevadm info --query=path --name=/dev/i2c-openchicken\nls -l /dev/openchicken-dxl /dev/i2c-openchicken\n${ownership}`),block(t('2 · 只预览接口和组权限差异','2 · Preview interface and group changes only'),`${cd}\nsh scripts/setup-board.sh --plan\nsh scripts/setup-i2c.sh --plan "$(id -un)"`,false,roots)],
  expected:t('UART 对应 serial@fe690000，I²C 对应 i2c@fe5d0000；用户具有 dialout/i2c 权限。已运行服务可以占用设备，但此时不能再启动底层工具。--plan 只列差异，不代表已配置。','UART maps to serial@fe690000, I²C to i2c@fe5d0000; verify dialout/i2c permissions. Existing services may own devices; do not launch competing tools. --plan is not an applied configuration.'),
  finish:t('保存实际映射与 plan 输出。系统写入另行审阅；不要为得到空闲状态自动停止正在运行的机器人。','Save actual mappings and plan output. Review system changes separately; do not stop a running robot just to make devices idle.')},
 'N02.1':{
  source:'openchicken_deploy/scripts/setup-audio.sh; deploy/openchicken/configure_audio.py',
  before:t('核对实装 Codec 和 12 MHz 时钟；这些检查不播放声音。','Verify the installed codec and 12 MHz clock; these checks do not play audio.'),
  blocks:[block(t('1 · 内核、模块及音频端点','1 · Kernel, modules and audio endpoints'),`uname -r\ncat /proc/asound/cards\naplay -l\narecord -l\nmodinfo snd-soc-tlv320aic3x\nmodinfo snd-soc-tlv320aic3x-i2c`),block(t('2 · 预览音频配置','2 · Preview audio setup'),`${cd}\nsh scripts/setup-audio.sh --plan`,false,roots),block(t('3 · 审阅后才应用，明确的 root 会话','3 · Apply only after review, in an explicit root session'),`${cd}\nsh scripts/setup-audio.sh --apply`,true,roots)],
  expected:t('声卡包含 aic3104，播放和录音各自有端点；模块 vermagic 与当前内核匹配。模块缺失时先处理同内核驱动，不用其他内核的 .ko。','aic3104 has playback and capture endpoints; module vermagic matches the running kernel. Resolve missing drivers for this exact kernel.'),
  finish:t('应用前记录 plan 差异与脚本给出的备份位置。此项不包含自动安装驱动或更新内核；重启复查在下一项。','Record the reviewed diff and script backup location. No automatic driver installation or kernel update; verify after reboot in the next item.')},
 'N02.2':{
  source:'openchicken_deploy/deploy/openchicken/configure_hat.py --verify; scripts/setup-audio.sh --verify',
  before:t('先保存旧 boot_id。只在新机维护窗口、配置已审阅且无运动任务时安排重启；运行中的样机跳过重启。','Save the old boot_id first. Schedule reboot only in an approved new-robot maintenance window with no motion task; skip reboot on an operating sample robot.'),
  blocks:[block(t('1 · 保存重启前标识','1 · Record boot identity before reboot'),`cat /proc/sys/kernel/random/boot_id\nuptime`),block(t('2 · 维护窗口内人工重启','2 · Manual reboot in the maintenance window'),`systemctl reboot`,true),block(t('3 · SSH 重新连接后核查','3 · Verify after reconnecting SSH'),`${cd}\ncat /proc/sys/kernel/random/boot_id\npython3 deploy/openchicken/configure_hat.py --verify\nsh scripts/setup-audio.sh --verify\nreadlink -f /dev/openchicken-dxl\nreadlink -f /dev/i2c-openchicken\nid -nG\nsystemctl --failed --no-page`,false,roots)],
  expected:t('boot_id 变更，设备别名、当前登录用户权限与声卡恢复；inactive/unknown 的未安装服务不等于失败。','boot_id changes; aliases, login-user permissions and audio return. An uninstalled service being inactive/unknown is not itself a failure.'),
  finish:t('分别记录重启前后值；没做真实重启时保持待测，不能以 --verify 代替。','Record before/after values; keep the reboot item pending if no reboot occurred.')},
 'N03.0':{
  source:'openchicken_deploy/scripts/test-dxl-communication.py (--ids, --rounds)',
  before:t('只在新机无力矩、串口无其他所有者时执行。运行中机器人只看已有反馈。该工具固定为 UART5、1 Mbps、ID10–14/20–24/30–33，不支持出厂 ID1 或其他波特率。','Run only torque-off with exclusive serial ownership. Use existing feedback on a running robot. Tool supports UART5, 1 Mbps and IDs 10–14/20–24/30–33, not factory ID1 or other baud rates.'),
  blocks:[block(t('1 · 核对占用','1 · Check ownership'),ownership),block(t('2 · 一轮 Ping 和白名单读取','2 · One Ping/read pass'),script('test-dxl-communication.py','--ids 10 11 12 13 14 20 21 22 23 24 30 31 32 33 --rounds 1'),false,roots)],
  expected:t('RESULT_JSON 中每个 ID 有回复，核对实际型号/固件和 torque_enabled；超时、CRC 或硬件报警逐项记录。样机型号1200/固件53仅供对照。','Each ID responds in RESULT_JSON; verify actual model, firmware and torque_enabled. Record timeouts, CRC errors and alerts individually; sample model1200/firmware53 are references only.'),
  finish:t('脚本自动退出并恢复串口设置，不发送使能或位置写入。出厂 ID 分配尚无通用配置入口，不能把此检查当作已完成改 ID。','The script exits and restores serial settings without enable/position writes. Factory-ID provisioning has no general entry here; this check does not assign IDs.')},
 'N03.1':{
  source:'openchicken_deploy/scripts/audit-servo-config.py; docs/openchicken/舵机参数配置.md',
  before:t('无力矩、独占总线；新机只做必要的一轮读取，已验收且未变更的机器不重复。','Torque off and exclusive bus ownership. Perform the necessary initial read once, not repeatedly on unchanged accepted machines.'),
  blocks:[block(t('读取实际参数和差异','Read actual settings and differences'),script('audit-servo-config.py'),false,roots)],
  expected:t('核对 fields、fixed_mismatches、init_gain_differences，motor_writes_sent 应为 false。将待改项列为 ID／地址／旧值／新值／EEPROM或RAM／原因；P增益属于RAM，不能一律按静态值判错。','Inspect fields, fixed_mismatches and init_gain_differences; motor_writes_sent must be false. List ID/address/old/new/EEPROM or RAM/reason for each proposed change; P gain is RAM and stage-dependent.'),
  finish:t('目前没有可复用的通用参数写入脚本，不提供猜测的 set 命令。先审阅逐项差异再指定写入工具，写后用同一审计命令回读；未写入时不能标“写后回读通过”。','No reusable general parameter-write script is available here. Review each change before choosing a write tool, then use this audit for readback. Do not mark post-write verification passed without a write.')},
 'N03.2':{
  source:'openchicken_deploy/scripts/monitor-joints.py --frames; robotctl/src/main.rs Monitor',
  before:t('无力矩且固定支撑；底层工具与正式服务二选一，不同时启动。','Torque off with support. Choose either the low-level tool or existing runtime feedback, never both.'),
  blocks:[block(t('未启正式服务：读取20帧关节反馈','Before runtime: read 20 joint frames'),script('monitor-joints.py','--frames 20'),false,roots),block(t('正式服务已占用：只订阅IPC','Runtime owns hardware: subscribe to IPC only'),observe,false,['ctl'])],
  expected:t('在网页选中同一关节，轻微手动移动并核对 ID、正方向、简图、3D 与曲线。count2048=0rad，软件不再重复加 Homing Offset。','Select the same joint in the UI and gently move it by hand; verify ID, sign, schematic, 3D and chart. count2048=0rad; do not reapply Homing Offset.'),
  finish:t('20帧自动结束；IPC命令5秒后 timeout 返回124属正常限时结束。当前没有 robotctl 时只用网页已有反馈，不另开总线。','20 frames finish automatically; timeout exit124 after five seconds is expected. If robotctl is unavailable, use existing web feedback, not another bus reader.')},
 'N04.0':{
  source:'docs/testing/标准配置与测试流程.md §扬声器／麦克风; ALSA utilities',
  before:t('在机器人终端执行。先确认设备名、音量和现场允许发声/录音；麦克风不要被其他程序占用。','Run on the robot. Verify device name, volume and consent to playback/recording; microphone must not be busy.'),
  blocks:[block(t('1 · 枚举与只读 mixer 回读','1 · Enumerate and read mixer'),`aplay -l\narecord -l\namixer -c aic3104 cget name='PCM Playback Volume'\namixer -c aic3104 cget name='PGA Capture Volume'\namixer -c aic3104 cget name='AGC Switch'`),block(t('2 · 440Hz 短音，实际发声','2 · 440Hz short tone: emits sound'),`timeout 8s speaker-test -D plughw:aic3104 -c 2 -r 48000 -F S16_LE -t sine -f 440 -l 1`,true),block(t('3 · RAM临时录音并回放，先静音再说话','3 · Record in RAM then replay: silence followed by speech'),`OC_AUDIO_DIR=$(mktemp -d /dev/shm/openchicken-audio.XXXXXX)\narecord -q -D plughw:aic3104 -f S16_LE -r 48000 -c 2 -d 8 -t wav "$OC_AUDIO_DIR/mic.wav" && aplay -q -D plughw:aic3104 "$OC_AUDIO_DIR/mic.wav"\nprintf 'Temporary audio: %s\\n' "$OC_AUDIO_DIR/mic.wav"`,true)],
  expected:t('短音听得见、无明显破音；录音可辨识静音和说话，两通道不能持续全零或削波。命令成功只证明设备可打开，不替代听音。','Hear a clean tone and distinguish silence/speech in recording. Both channels must not be persistently zero or clipped. Command success does not replace listening.'),
  finish:t('确认 arecord/aplay 已退出；需要证据时先取回临时 WAV，再仅删除显示的本次临时目录。设备忙时保留错误，不自动终止其他程序。','Confirm arecord/aplay exited; retrieve the temporary WAV if needed, then remove only the displayed test directory. Preserve busy-device errors; do not kill other programs.')},
 'N04.1':{
  source:'openchicken_deploy/scripts/test-j5-imu.py; console/agent/runtime_agent.py (robot.subscribe / head_imu.stream)',
  before:t('已有 robotd/tofd 时用网页和IPC反馈。J5底层命令只用于无人占用I²C器件的新机；它不是头部BMI088测试器。','Use web/IPC feedback when robotd/tofd owns hardware. Low-level J5 commands are for a new robot with the device unowned; this is not a BMI088 tester.'),
  blocks:[block(t('1 · 核对所有者','1 · Verify owners'),ownership),block(t('2 · J5只识别，不配置采样','2 · Identify J5 without sampling configuration'),script('test-j5-imu.py','--bus /dev/i2c-openchicken --address 0x6a'),false,roots),block(t('3 · 已审阅的新机：临时采样5秒','3 · Reviewed new robot: five-second temporary sampling'),`${cd}\nOC_IMU_DIR=$(mktemp -d /dev/shm/openchicken-imu.XXXXXX)\npython3 scripts/test-j5-imu.py --bus /dev/i2c-openchicken --address 0x6a --seconds 5 --output "$OC_IMU_DIR/capture"\nprintf 'Temporary IMU evidence: %s\\n' "$OC_IMU_DIR/capture"`,true,roots),block(t('已有正式服务：读取机身状态','Existing runtime: observe body state'),observe,false,['ctl']),block(t('已有 tofd：读取10帧头部反馈','Existing tofd: read ten head frames'),"timeout 5s python3 - <<'PYHEAD'\nimport json, socket\nwith socket.socket(socket.AF_UNIX) as s:\n    s.settimeout(3)\n    s.connect('/run/tofd/tofd.sock')\n    with s.makefile('rwb') as f:\n        f.write((json.dumps(dict(jsonrpc='2.0', id=1, method='head_imu.stream', params={}))+'\\n').encode())\n        f.flush()\n        count = 0\n        while count < 10:\n            line = f.readline()\n            if not line: raise RuntimeError('Head IPC closed')\n            reply = json.loads(line)\n            if reply.get('error'): raise RuntimeError(reply['error'])\n            if reply.get('method') == 'head_imu.frame':\n                print(json.dumps(reply.get('params'), ensure_ascii=False), flush=True)\n                count += 1\nPYHEAD")],
  expected:t('J5 WHO_AM_I=0x70，地址按实际接线核对（也支持0x6b）；静止重力约1g、角速度接近静止值。头部在网页 Head orientation 单独观察，不能用 J5 结果代签；原始六轴协议没有 RPY。','J5 WHO_AM_I=0x70; verify actual address (0x6b is also supported), static gravity near1g and near-rest gyro. Inspect head separately in Head orientation; J5 does not validate the head. Raw six-axis telemetry has no RPY.'),
  finish:t('检查 report.json 的恢复结果；采样会临时写IMU寄存器，不能称为纯只读。头部没有已部署入口时保持待测，不用全总线扫描代替。','Check restoration in report.json. Sampling temporarily writes IMU registers and is not purely read-only. Without a deployed head-feedback entry, leave it pending; do not substitute a whole-bus scan.')},
 'N04.2':{
  source:'console/agent/runtime_agent.py robot.health; console/agent/power_probe.py inherited input FD',
  before:t('正式 robotd 已运行时只读取缓存电压；Pin31 使用已运行的输入采集入口。','With runtime active, read cached voltage only; use the existing input collector for Pin31.'),
  blocks:[block(t('读取 robotd 缓存健康／电压','Read cached robotd health / voltage'),rpc(['robot.health']))],
  expected:t('查看 battery.volts 并与仪表注明测点后的读数粗略对照。Pin31在网页 Battery power查看；允许现场切换供电时分别记录0/1，不能据此判断电量或正在充电。','Compare battery.volts with a meter at the documented measurement point. Inspect Battery power for Pin31; record0/1 during an approved supply change. It does not measure charge or charging.'),
  finish:t('恢复原供电连接。Pin31需要专用输入FD入口，此页不生成猜测的 gpioget 命令来抢占既有GPIO；缺失时暂缓该项。','Restore original power wiring. Pin31 requires its dedicated input-FD launcher; do not take the line with a guessed gpioget command. Defer if feedback is absent.')},
 'N05.0':{
  source:'openchicken_deploy/deploy/radxa/*.service; console/agent/runtime_agent.py',
  before:t('现有机器运行时只查状态，不执行下面的启动块。新机需先完成审阅后的服务安装，退出临时采集器并确认总线/I²C所有权已释放。','For an operating robot inspect status only; do not run the startup block. A new robot needs reviewed service installation and temporary collectors stopped with hardware released.'),
  blocks:[block(t('1 · 查询服务和IPC路径','1 · Inspect services and IPC paths'),`systemctl show ${services} --property=Id,LoadState,ActiveState,SubState,MainPID,User,ExecStart\nls -l /run/robotd/robotd.sock /run/tofd/tofd.sock\n${ownership}`),block(t('2 · 仅已安装并审阅的新机服务，管理员会话','2 · Only installed/reviewed new-robot services, administrator session'),`systemctl start robotd.service tofd.service openchicken-agent.service`,true),block(t('3 · 启动后检查','3 · Inspect after startup'),`systemctl is-active ${services}\njournalctl -u robotd.service -u tofd.service -u openchicken-agent.service -n 40 --no-pager`) ],
  expected:t('服务 active、socket存在且权限正确；robotd拥有DXL/机身IMU，tofd拥有头部IMU。页面保持Limp / enabled=false；没有服务文件时先完成参数化部署，不复制样机用户路径。','Services active, sockets present with correct permissions; robotd owns DXL/body IMU and tofd owns head IMU. UI remains Limp/disabled. Missing units require parameterized deployment, not copied sample-user paths.'),
  finish:t('只保留一组硬件所有者，正常运行服务无需停掉。此处不执行 init/enable，不把 systemctl 返回成功当作全部传感器通过。','Keep one set of hardware owners; leave normally operating services running. No init/enable here; systemctl success is not complete sensor acceptance.')},
 'N05.1':{
  source:'console/protocol/readonly.py load_config; console/agent/runtime_agent.py',
  before:t('核对相同robot_id、hostname和双方公钥。不要把私钥粘贴到记录。早期只读连接和正式runtime连接使用匹配协议。','Match robot_id, hostname and peer keys without pasting private keys into reports. Early read-only and runtime connections need matching protocols.'),
  blocks:[block(t('机器人：核对实际身份和监听端口','Robot: inspect identity and listeners'),`hostname\nip -br address\nss -ltn\nsystemctl show openchicken-agent.service --property=MainPID,ActiveState,ExecStart`)],
  expected:t('机器人监听档案中的状态端口（通常5557）；正式运控还需配置控制端口（通常5558）。早期只读连接只订阅状态。按上方配对步骤操作，不将“主机已连接”误判为机器人在线。','Robot listens on the dossier telemetry port (usually5557); production control also needs its control port (usually5558). Early telemetry subscribes only to state. Host connected does not mean robot online.'),
  finish:t('上方“早期 ZMQ 状态连接”可配置只读协议；正式runtime仍由已审阅的主机启动配置接入。端口存在不证明CURVE认证成功，要看有效帧序号递增。','Use Early ZMQ telemetry above for read-only setup; production runtime uses reviewed host startup settings. Listening ports do not prove CURVE authentication; verify increasing valid-frame sequence.')},
 'N05.2':{
  source:'robotctl/src/main.rs Monitor; console/agent/runtime_agent.py robot.model / robot.health',
  before:t('正式服务已接管硬件；本项只订阅已有IPC，不另启DXL或IMU工具。','Production services own the hardware; subscribe to IPC only, without separate DXL/IMU collectors.'),
  blocks:[block(t('1 · 读取模型映射和健康','1 · Read model mapping and health'),rpc(['robot.model','robot.health'])),block(t('2 · 5Hz观察5秒','2 · Observe five seconds at5Hz'),observe,false,['ctl'])],
  expected:t('14个joint_feedback_valid，模型joint_names与页面对应，双IMU有效；观察bringup、enabled、loop。监控订阅5Hz不代表运控只有5Hz，运控循环看loop约50Hz。','Verify14 joint_feedback_valid entries, matching joint_names, both IMUs, bringup, enabled and loop. A5Hz subscription does not imply a5Hz control loop; inspect loop near50Hz.'),
  finish:t('timeout在5秒后返回124属限时结束，其他错误单独记录；结束订阅不会停止正式服务。','Timeout exit124 after five seconds is expected; record other errors separately. Ending subscription does not stop services.')},
 'N06.0':{
  source:'artifacts/console-t5-review-20261029/ort-api-check.c; deploy/radxa/robotd.service',
  before:t('以下路径必须填机器人上的实际文件；固定发布版本、Runtime和模型，不安装或更新依赖。','Enter actual robot-side file paths; pin release, Runtime and models without installing/updating dependencies.'),
  blocks:[block(t('1 · 查Runtime环境与模型槽','1 · Inspect Runtime environment and model slots'),`systemctl show robotd.service --property=ExecStart,Environment\n${rpc(['robot.policies'])}`),block(t('2 · 记录实际文件哈希','2 · Record file hashes'),`sha256sum -- ${q(s.ort)} ${q(s.model)}`,false,['ort','model']),block(t('3 · 用已有隔离检查器加载Runtime','3 · Load Runtime with the existing isolated checker'),`env -u LD_PRELOAD -u LD_LIBRARY_PATH timeout 20s ${q(s.api)} ${q(s.ort)}`,false,['api','ort'])],
  expected:t('参考版本1.28.0、C API23可用，loaded_path应等于指定库。sha256需与固定发布清单对照，不能凭文件名验收。','Reference Runtime1.28.0 with C API23 available; loaded_path matches the specified library. Compare hashes with the pinned release manifest, not filenames.'),
  finish:t('ort-api-check是历史构建工具，不保证新机已部署。缺失时记录待部署，不临时执行下载物；仅库加载通过不能代替模型推理。','ort-api-check is a previously built tool, not guaranteed installed on new robots. Record missing deployment; do not execute downloaded artifacts ad hoc. Library loading does not prove inference.')},
 'N06.1':{
  source:'artifacts/console-t5-review-20261029/policy-check/src/main.rs; POLICY-REVIEW.md',
  before:t('填已部署的policy-offline-check、Runtime和模型绝对路径；这是合成输入隔离推理，不连接舵机。已有运动任务时另安排空闲测试窗口，避免额外CPU负载。','Enter deployed policy-offline-check, Runtime and model absolute paths. This uses synthetic input with no actuator connection. Use an idle test window rather than adding CPU load during motion.'),
  blocks:[block(t('只做1步必要的模型接口／推理检查','One necessary model-interface/inference step'),`env -u LD_PRELOAD -u LD_LIBRARY_PATH ORT_DYLIB_PATH=${q(s.ort)} timeout 20s ${q(s.checker)} ${q(s.model)} 1`,false,['ort','checker','model'])],
  expected:t('输出passed=true、source=synthetic_offline、input_shape=[1,61]、action_shape=[1,14]，输出有限且退出码0。更换模型后分别记录，不能把合成推理写成真实闭环通过。','Expect passed=true, source=synthetic_offline, input_shape=[1,61], action_shape=[1,14], finite output and exit0. Record each model separately; synthetic inference is not closed-loop acceptance.'),
  finish:t('命令自动退出，不启动robotd、不加载运行中的策略槽。检查器尚未部署时此项待测；不要用robotctl policy load代替离线验证。','Command exits without starting robotd or changing active policy slots. Keep pending if checker is absent; do not substitute robotctl policy load.')},
 'N06.2':{
  source:'openchicken_deploy/openchicken-control/src/obs.rs; console/agent/runtime_agent.py; 新机标准部署与测试流程.md §7',
  before:t('使用正在运行的IPC反馈及该发布对应的源码；不新开硬件采集、不启用策略。','Use existing IPC feedback and source matching the release; no extra hardware collector or policy enable.'),
  blocks:[block(t('1 · 读取关节顺序与模型槽','1 · Read joint order and policy slots'),rpc(['robot.model','robot.policies'])),block(t('2 · 抽看实时输入来源','2 · Observe live input sources'),observe,false,['ctl'])],
  expected:t('核对61维：机身角速度3＋投影重力3＋相对默认位置14＋关节速度14＋上一原始网络输出14＋命令13；角度rad、速度rad/s，排除虚拟嘴部。IPC不会直接提供完整61维时，应结合该版本obs.rs核对，不伪造观测向量。','Verify61 inputs: body gyro3 + projected gravity3 + relative joints14 + joint velocities14 + previous raw policy output14 + commands13. Use rad/rad/s, exclude virtual beak. If IPC does not expose all61 values, review the matching obs.rs rather than inventing them.'),
  finish:t('保存实际模型顺序和来源核对结论；Limp/policy=held不代表策略闭环。N08/N09再到运行监控测试实际行为。','Record model order and source checks. Limp/policy=held does not prove closed-loop operation; test actual behavior in Monitor at N08/N09.')}
 };
 const recipe=recipes[step];
 // Keep relative-path commands in a subshell; a failed cd must not run tools elsewhere.
 if(recipe)recipe.blocks=recipe.blocks.map(b=>b.needs.includes('root')?{...b,command:`(
set -e
${b.command}
)`}:b);
 return recipe;
}

export function renderTestCommands(element,step,row) {
 if(!/^N0[2-6]\.[0-2]$/.test(step))return;
 const key=row?.id||'unselected';
 if(!settings.has(key))settings.set(key,{root:row?.ssh_user?`/home/${row.ssh_user}/openchicken_deploy`:row?.robot_id==='openchicken1'?'/home/openchicken1/openchicken_deploy':'',ctl:'robotctl',ort:'',model:'',api:'',checker:''});
 const s=settings.get(key),fields=[['root',t('机器人上的工程根目录（包含 scripts/，请核实建议值）','Robot source root (contains scripts/; verify suggestion)')],['ctl',t('robotctl 命令或实际路径','robotctl command or actual path')],...(step.startsWith('N06')?[['ort',t('Runtime 动态库绝对路径','Absolute Runtime library path')],['model',t('本次模型绝对路径','Absolute model path')],['api',t('ort-api-check 绝对路径（已部署才填）','Absolute ort-api-check path (if deployed)')],['checker',t('policy-offline-check 绝对路径（已部署才填）','Absolute policy-offline-check path (if deployed)')]]:[])];
 element.className='test-command-guide';
 element.innerHTML=`<h3>${t('具体执行命令与判定','Commands and acceptance')}</h3><p class="command-manual">${t('在机器人 SSH 终端人工执行；复制按钮只复制，不会运行。命令未执行不代表已通过。','Run manually in the robot SSH terminal. Copy only copies; it does not execute. Unexecuted commands are not passed tests.')}</p><details class="command-paths"><summary>${t('核对机器人上的工具路径','Verify robot-side tool paths')}</summary>${fields.map(([name,label])=>`<label>${label}<input data-command-path="${name}" value="${esc(s[name])}" autocomplete="off" spellcheck="false"></label>`).join('')}<p>${t('工具缺失时保留待测，不自动安装。路径只影响此处命令文本，不修改机器人配置。','Missing tools remain pending; nothing is installed automatically. Paths affect command text only, not robot configuration.')}</p></details><div class="command-recipe"></div>`;
 const update=()=>{
  const recipe=commandRecipe(step,s);const target=element.querySelector('.command-recipe');
  target.innerHTML=`<p><strong>${t('准备：','Before: ')}</strong>${esc(recipe.before)}</p>${recipe.blocks.map((b,i)=>{const missing=b.needs.filter(n=>!s[n].trim()||(n!=='ctl'&&!s[n].startsWith('/')));return `<section class="command-block ${b.review?'command-review':''}"><div><strong>${esc(b.title)}</strong><button type="button" data-copy-command="${i}" ${missing.length?'disabled':''}>${t('复制命令','Copy command')}</button></div>${b.review?`<p class="command-caution">${t('需先审阅并确认前置条件；此页不执行此操作。','Review and confirm preconditions first; this page does not execute this operation.')}</p>`:''}${missing.length?`<p class="command-caution">${t('先在上方填写所需绝对路径：','Enter required absolute paths above: ')}${missing.join(', ')}</p>`:''}<pre><code>${esc(missing.length?t('路径未配置；填写后显示完整命令。','Paths missing; complete them to display the command.'):b.command)}</code></pre><span data-copy-status="${i}" role="status"></span></section>`;}).join('')}<p><strong>${t('看什么：','Expect: ')}</strong>${esc(recipe.expected)}</p><p><strong>${t('收尾／未覆盖：','Finish / limitations: ')}</strong>${esc(recipe.finish)}</p><small>${t('核对来源：','Source checked: ')}${esc(recipe.source)}</small>`;
  target.querySelectorAll('[data-copy-command]').forEach(button=>button.onclick=async()=>{const i=Number(button.dataset.copyCommand);try{await navigator.clipboard.writeText(recipe.blocks[i].command);target.querySelector(`[data-copy-status="${i}"]`).textContent=t('已复制，尚未执行','Copied; not executed');}catch{target.querySelector(`[data-copy-status="${i}"]`).textContent=t('无法访问剪贴板，请手动选中命令复制','Clipboard unavailable; select and copy the command manually');}});
 };
 element.querySelectorAll('[data-command-path]').forEach(input=>input.oninput=()=>{s[input.dataset.commandPath]=input.value.trim();update();});update();
 if(!s.root)element.querySelector('.command-paths').open=true;
}
