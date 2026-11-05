import { english } from './i18n.js?v=20261101-commissioning';
const t=(zh,en)=>english?en:zh;
const protocols=[
 ['openchicken-system-t1-v1','系统状态 · 不访问硬件','System only · No hardware access','agent.system_agent'],
 ['openchicken-joints-t3-v1','系统＋关节','System + joints','agent.joint_agent'],
 ['openchicken-sensors-t3-v1','系统＋关节＋原始 IMU','System + joints + raw IMUs','agent.imu_agent'],
 ['openchicken-power-t3-v1','增加供电检测（已有入口）','Add power feedback (existing launcher)',null],
 ['openchicken-orientation-t5-v1','增加姿态（已有入口）','Add orientation (existing launcher)',null],
 ['openchicken-observation-t5-v1','完整只读观测（已有入口）','Full read-only observations (existing launcher)',null]
];
const shell=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export class CommissioningTelemetry {
 constructor(element) {
  this.element=element;this.version=0;this.row=null;
  element.innerHTML=`<div class="panel-head"><h2>${t('早期 ZMQ 状态连接','Early ZMQ telemetry')}</h2><span id="telemetry-status" class="badge">${t('未连接','Disconnected')}</span></div><div class="ssh-controls"><p>${t('SSH 用于登录与检查；这里独立连接 Python 只读采集器，将有效状态送到上方 3D、Robot Status 和关节曲线。只订阅状态端口，不连接 5558 运控端口。','SSH is for login and checks. Connect the Python read-only publisher here to feed valid telemetry into 3D, Robot Status and joint charts. Only the telemetry port is used; no port 5558 control connection.')}</p><p id="telemetry-target" class="hint"></p><div class="ssh-actions"><label>${t('反馈协议','Telemetry protocol')}<select id="telemetry-protocol">${protocols.map(([v,zh,en])=>`<option value="${v}">${english?en:zh}</option>`).join('')}</select></label><label id="telemetry-calibration-label" hidden>${t('本机校准 SHA-256','This robot calibration SHA-256')}<input id="telemetry-calibration" maxlength="64"></label></div><div class="ssh-actions"><label>${t('机器人 CURVE 公钥','Robot CURVE public key')}<input id="telemetry-peer" maxlength="40" autocomplete="off"></label><button id="telemetry-prepare">${t('准备／保存只读连接配置','Prepare / save read-only settings')}</button></div><p class="hint">${t('新机先留空机器人公钥，点击准备以生成主机公钥；按下方步骤在机器人生成独立密钥，再粘贴机器人公钥并保存。已有采集器请导入原主机配置，保留原配对。','For a new robot, leave its key blank and prepare the host key first. Generate robot keys using the steps below, paste its public key and save. For an existing publisher, import its host configuration to preserve pairing.')}</p><label>${t('复用已有主机只读配置 JSON（包含主机私钥，不会显示或导出）','Import existing read-only host JSON (includes host private key; never displayed or exported)')}<input id="telemetry-import" type="file" accept="application/json,.json"></label><div class="ssh-actions"><button id="telemetry-connect" class="primary" disabled>${t('连接状态反馈','Connect telemetry')}</button><button id="telemetry-disconnect" disabled>${t('断开状态订阅','Disconnect subscription')}</button><span id="telemetry-age"></span></div><p id="telemetry-message" role="status"></p><p class="hint">${t('连接由两个页面共享。断开只关闭主机订阅，不会停止机器人采集器；SSH 检查结束也不会停止采集。未收到有效帧时保持等待，失联显示过期。','The connection is shared by both pages. Disconnecting only closes the host subscription, not the robot collector; finishing an SSH check also does not stop it. No valid frame means waiting; lost telemetry becomes stale.')}</p><details id="telemetry-guide"><summary>${t('具体配对、启动与收尾步骤','Pairing, startup and finish: exact steps')}</summary><ol><li>${t('先执行 SSH N01，核对并回填实测 hostname。机器人需已部署本工程 Python 采集代码，并安装 pyzmq；这里不自动部署或安装。','Run SSH N01 and apply the verified hostname. The robot must already have this project’s Python collectors and pyzmq installed; this page does not deploy or install them.')}</li><li><label>${t('机器人上的 console 代码目录（建议值，请核对）','Console source directory on robot (suggested; verify)')}<input id="telemetry-remote-root" autocomplete="off"></label><p>${t('在监控主机终端运行以下 SSH 命令登录：','Log in from a terminal on the monitor host:')}</p><pre id="telemetry-ssh-command"></pre></li><li>${t('新机在机器人终端进入代码目录，执行以下配对命令。只在当前目录新建 monitor-agent.json，已有文件时拒绝覆盖；机器人私钥留在机器人上，只复制输出的公钥。已有配对不要执行此步。','For a new robot, enter its source directory and run this pairing command on the robot. It creates monitor-agent.json exclusively, never overwrites it, and retains the robot private key there. Copy only the printed public key. Skip this step for existing pairing.')}<pre id="telemetry-pair-command"></pre></li><li>${t('将输出公钥填入上方，保存。机器人端启动匹配的采集器，然后点击“连接状态反馈”。','Paste the printed key above and save. Start the matching collector on the robot, then click Connect telemetry.')}<pre id="telemetry-start-command"></pre><p id="telemetry-scope"></p></li><li>${t('观察“收到有效状态”、序号递增和数据年龄；系统协议只有系统状态，关节和 IMU 保持未知。关节协议驱动关节图与曲线；原始 IMU 协议不提供 RPY，姿态版本需本机校准。缺失反馈不能标通过。','Verify Receiving, increasing sequence and data age. The system protocol leaves joints and IMUs unknown. The joint protocol feeds joint visuals and charts. Raw IMU does not provide RPY; orientation protocols require robot-specific calibration. Missing feedback cannot be marked passed.')}</li><li>${t('收尾：先停止录制，断开主机订阅，再在运行采集器的机器人终端按 Ctrl+C，检查退出／恢复日志。转正式 robotd/tofd 前必须确认临时采集器退出，不能同时占用总线或 I²C。N08/N09 在运行监控页使用正式运控连接测试。','Finish: stop recording, disconnect the host subscription, then press Ctrl+C in the robot collector terminal and inspect exit/restore logs. Confirm temporary collectors have exited before robotd/tofd takes ownership; do not share bus or I²C. Use the production runtime connection in Monitor for N08/N09.')}</li></ol></details></div>`;
  const nodes=new Map([...element.querySelectorAll('[id]')].map(node=>[node.id,node]));this.$=id=>nodes.get(id);
  this.$('telemetry-protocol').onchange=()=>{this.guide();this.render();};
  for(const id of ['telemetry-peer','telemetry-calibration'])this.$(id).oninput=()=>this.render();
  this.$('telemetry-remote-root').oninput=()=>this.guide();
  this.$('telemetry-prepare').onclick=()=>void this.action('prepare',{protocol:this.$('telemetry-protocol').value,peer_public_key:this.$('telemetry-peer').value,calibration_id:this.$('telemetry-calibration').value},true);
  this.$('telemetry-connect').onclick=()=>void this.action('connect');
  this.$('telemetry-disconnect').onclick=()=>void this.action('disconnect');
  this.$('telemetry-import').onchange=async e=>{
   const file=e.target.files[0],version=this.version;e.target.value='';if(!file)return;
   try{if(file.size>8192)throw Error(t('配置文件过大','Configuration is too large'));const config=JSON.parse(await file.text());if(version===this.version)await this.action('prepare',{config},true);}
   catch{this.$('telemetry-message').textContent=t('导入失败，请检查匹配的主机只读 JSON 配置','Import failed; check the matching read-only host JSON');}
  };
  this.setProfile(null);
 }
 async api(path,body) {
  const response=await fetch('/api/commissioning/telemetry/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Telemetry request failed');return data;
 }
 setProfile(row) {
  const key=JSON.stringify(row?[row.id,row.robot_id,row.address,row.hostname,row.ssh_user,row.ssh_port,row.state_port]:null);
  this.row=row;if(this.key===key)return;this.key=key;this.version++;clearTimeout(this.timer);this.data=null;this.pending=false;
  this.$('telemetry-protocol').value=protocols[0][0];this.$('telemetry-peer').value=row?.robot_public_key||'';this.$('telemetry-calibration').value='';
  this.$('telemetry-remote-root').value=row?.ssh_user?`/home/${row.ssh_user}/openchicken/console`:'';
  this.$('telemetry-message').textContent='';this.$('telemetry-target').textContent=row?`${row.robot_id} · ${row.hostname||'—'} · ${row.address||'—'}:${row.state_port}`:t('先建档并选择机器人','Create and select a robot dossier first');
  this.render();this.guide();if(row)void this.poll(this.version,true);
 }
 fill(data) {
  if(data.config){this.$('telemetry-protocol').value=data.config.protocol;this.$('telemetry-peer').value=data.config.peer_public_key;this.$('telemetry-calibration').value=data.config.calibration_id||'';}
 }
 async poll(version,initial=false) {
  try{const data=await this.api('status/'+this.row.id);if(version!==this.version)return;this.data=data;if(initial){this.fill(data);this.guide();}this.render();}
  catch(e){if(version===this.version)this.$('telemetry-message').textContent=e.message;}
  if(version===this.version)this.timer=setTimeout(()=>void this.poll(version),1500);
 }
 async action(action,fields={},fill=false) {
  if(!this.row||this.pending)return;const version=this.version;this.pending=true;this.render();
  try{const data=await this.api(action,{profile_id:this.row.id,...fields});if(version!==this.version)return;this.data=data;if(fill)this.fill(data);this.$('telemetry-message').textContent=action==='prepare'?t('主机配置已保存；机器人端配置与采集器启动按下方步骤操作。','Host settings saved; follow the steps below to configure and start the robot publisher.'):action==='connect'?t('已建立订阅，收到有效反馈后才显示在线。','Subscription created; online status requires valid telemetry.'):t('已断开主机订阅，机器人采集器仍需单独退出。','Host subscription disconnected; stop the robot collector separately.');this.guide();}
  catch(e){if(version===this.version)this.$('telemetry-message').textContent=e.message;}
  finally{if(version===this.version){this.pending=false;this.render();}}
 }
 render() {
  const d=this.data,active=d&&d.status!=='disconnected',c=d?.config;
  const dirty=c&&(c.protocol!==this.$('telemetry-protocol').value||c.peer_public_key!==this.$('telemetry-peer').value.trim()||(c.calibration_id||'')!==this.$('telemetry-calibration').value.trim());
  const labels={disconnected:t('未连接','Disconnected'),waiting:t('等待有效数据','Waiting for valid telemetry'),receiving:t('收到有效状态','Receiving valid telemetry'),stale:t('反馈已过期','Telemetry stale'),failed:t('订阅异常，请重连','Subscription failed; reconnect')};
  this.$('telemetry-status').textContent=d?.external_connection?t('已有启动配置连接','Connection loaded at startup'):labels[d?.status||'disconnected'];
  this.$('telemetry-status').className='badge '+(d?.status==='receiving'?'green':'');
  this.$('telemetry-age').textContent=d?.age_seconds!=null?`seq ${d.seq} · ${d.age_seconds.toFixed(2)} s`:'';
  this.$('telemetry-connect').disabled=this.pending||!d?.ready||active||d?.external_connection||dirty;
  this.$('telemetry-disconnect').disabled=this.pending||!active;
  for(const id of ['telemetry-prepare','telemetry-import','telemetry-protocol','telemetry-peer','telemetry-calibration'])this.$(id).disabled=this.pending||!this.row||active||d?.external_connection;
 }
 guide() {
  const row=this.row,protocol=this.$('telemetry-protocol').value,entry=protocols.find(p=>p[0]===protocol),config=this.data?.config;
  this.$('telemetry-calibration-label').hidden=!protocol.includes('t5');
  this.$('telemetry-ssh-command').textContent=row?.ssh_user&&row?.address?`ssh -p ${row.ssh_port} -l ${shell(row.ssh_user)} ${shell(row.address)}`:t('先填写 SSH 用户和地址。','Enter the SSH user and address first.');
  const root=this.$('telemetry-remote-root').value.trim(),cd=root?'cd '+shell(root):t('# 填写机器人上的实际代码目录','# Enter the actual source directory on the robot');
  if(config&&this.data.matches&&config.protocol===protocol){
   const agent={role:'agent',protocol:config.protocol,robot_id:config.robot_id,hostname:config.hostname,endpoint:`tcp://0.0.0.0:${row.state_port}`,peer_public_key:config.public_key};if(config.calibration_id)agent.calibration_id=config.calibration_id;
   const script=`import json, os, socket, zmq\nc = json.loads(${JSON.stringify(JSON.stringify(agent))})\nassert socket.gethostname() == c['hostname'], 'hostname mismatch'\npublic, secret = zmq.curve_keypair()\nc.update(public_key=public.decode(), secret_key=secret.decode())\nfd = os.open('monitor-agent.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)\nwith os.fdopen(fd, 'w') as f: json.dump(c, f, indent=2)\nprint('Robot public key:', c['public_key'])`;
   this.$('telemetry-pair-command').textContent=`${cd}\npython3 - <<'PY'\n${script}\nPY`;
  }else this.$('telemetry-pair-command').textContent=t('先准备并保存主机公钥，才能生成匹配本机身份的具体命令。','Prepare the host key first to generate commands matching this robot.');
  this.$('telemetry-start-command').textContent=config?.protocol!==protocol?t('先保存所选协议配置。','Save the selected protocol settings first.'):entry?.[3]?`${cd}\npython3 -m ${entry[3]} --config monitor-agent.json`:t('此版本需要已审阅的 Pin31 文件描述符入口；姿态版本另需本机校准文件。复用已部署入口与原主机配置，不生成缺少参数的启动命令。','This version requires an approved Pin31 file-descriptor launcher; orientation also needs this robot calibration file. Reuse the deployed launcher and original host configuration.');
  this.$('telemetry-scope').textContent=protocol===protocols[0][0]?t('此命令只采集系统状态，不访问舵机、IMU 或运控；不会出现关节／姿态反馈。','This collector reads system status only, with no actuator, IMU or runtime access. It does not provide joint or orientation feedback.'):t('启动前核对硬件所有权：robotd/tofd 与临时采集器不能争用设备。关节版本要求无力矩；IMU 版本会临时配置传感器并在退出时恢复。此处只展示命令，需审阅后在机器人终端执行。已有配置文件路径请替换示例 monitor-agent.json。','Review hardware ownership before starting: robotd/tofd and temporary collectors must not compete. Joint collection requires torque off; IMU collection temporarily configures sensors and restores them on exit. Commands are shown for review, not executed here. Replace monitor-agent.json with your existing configuration path when reusing a deployment.');
 }
}
