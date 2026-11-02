import { RobotManager, commissioning } from './robot-manager.js?v=20261101-test-commands';
import { GamepadView } from './gamepad-view.js?v=20261030-xbox-shape';
import { XboxInput } from './gamepad.js?v=20261030-xbox';
import { Viewer } from './viewer.js?v=20261030-live-3d';
import { JointChart } from './chart.js?v=20261030-three-curves';
import { rawImu, mountedImu } from './imu_raw.js?v=20261030-head-mount';
import { angleText } from './angles.js';
import { jointFeed, modelPose } from './view-pose.js?v=20261030-live-3d';
import { OrientationPanels } from './orientation-panel.js?v=20261029-fusion-monitor';
import { tr, localize, locale } from './i18n.js?v=20261101-commissioning';

const $ = id => document.getElementById(id);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, digits=1) => Number.isFinite(n) ? n.toFixed(digits) : '—';
const SKILLS = [['sit_toggle','坐下 / 站起'],['ground_pick','地面拾取'],['kick_left','左脚踢球'],['kick_right','右脚踢球'],['roulade','翻滚']];
let socket, connected=false, robots=[], selected='demo-01', jointId=13, held=null;
let frozen=false, frozenState=null, frozenSamples=[], frozenEvents=[], replay=null, replayIndex=0, playing=false;
let latestFrame=null, viewer=null, chart=null, lastUI=0, lastEventKey='', cachedRobot='', schemaKey='';
const pending=new Map(), histories=new Map(), keys=new Set();
const orientationPanels=new OrientationPanels(()=>render(true));
const xbox=new XboxInput();
const gamepadView=new GamepadView($('gamepad-inspector'));
let padFrame=null, padSampleAt=0, padCommandBusy=false;
let toastTimer, starting=false, stopping=false, startEpoch=0;
function toast(text) { $('toast').textContent=tr(text); $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,4500); }
function request(type, robotId=selected, payload={}) {
  if (!connected) return Promise.reject(new Error('主机连接已中断'));
  const id=crypto.randomUUID();
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{pending.delete(id); reject(new Error('请求超时，结果未确认；请检查设备状态'));},1300);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,type,robot_id:robotId,payload,sent_at:Date.now()}));
  });
}
function live() { return robots.find(r=>r.robot_id===selected); }
function current() { return replay ? replay.samples[replayIndex]?.state : frozen ? frozenState : live() || latestFrame?.empty_state; }
function samples() { return replay ? replay.samples : frozen ? frozenSamples : histories.get(selected)||[]; }
function canControl() { const r=live(); return !commissioning && connected && !frozen && !replay && r?.online && r.capabilities.motion && ['simulation','robot'].includes(r.source); }
function ready() { return canControl() && held===selected; }
function clearKeys() { keys.clear(); document.querySelectorAll('[data-key]').forEach(e=>e.classList.remove('active')); }
async function release() {
  startEpoch++;
  clearKeys();
  xbox.reset();padFrame=null;
  const id=held;
  held=null;
  if (id && connected) { try { await request('release',id); } catch (e) { toast(e.message); } }
  renderControls();
}
async function choose(id) {
  if (id===selected || replay || !manager.confirmSelection(id)) return;
  await release();
  selected=id; frozen=false; frozenState=null; cachedRobot='';
  render(true);
}
function connect() {
  socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${commissioning?'/commissioning/ws':'/ws'}`);
  socket.onopen=()=>{connected=true; $('connection').textContent=tr('主机已连接'); $('connection').className='badge green';};
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if (message.type==='reply') {
      const promise=pending.get(message.id);
      if (promise) { clearTimeout(promise.timer); pending.delete(message.id); message.ok ? promise.resolve(message.result) : promise.reject(new Error(message.error)); }
      return;
    }
    latestFrame=message; robots=message.robots;
    if (!robots.length) selected='';
    if (robots.length && !robots.some(r=>r.robot_id===selected)) selected=robots[0].robot_id;
    for (const state of robots) {
      if (!['simulation','robot'].includes(state.source) || state.sample_time==null) continue;
      let history=histories.get(state.robot_id);
      if (!history || history.at(-1)?.state.boot_id!==state.boot_id) {history=[]; histories.set(state.robot_id,history);}
      const last=history.at(-1);
      if (!last || last.state.seq!==state.seq || last.state.online!==state.online) {
        const time=state.online===false && last ? last.time+0.001 : state.sample_time;
        if (last && time-last.time>3/(state.telemetry_hz||20))
          history.push({time:Math.max(last.time+0.0001,time-0.001),state:{...state,online:false}});
        history.push({time,state});
        if (history.length>1300) history.splice(0,history.length-1300);
      }
    }
    if (held && (!robots.find(r=>r.robot_id===held)?.online)) release();
    if (performance.now()-lastUI>(jointFeed(current())?45:90)) {lastUI=performance.now(); render();}
  };
  socket.onclose=()=>{
    connected=false; held=null; clearKeys();xbox.reset();padFrame=null;
    for (const p of pending.values()) {clearTimeout(p.timer);p.reject(new Error('主机连接已中断'));}
    pending.clear();
    $('connection').textContent=tr('主机已断开'); $('connection').className='badge amber';
    robots=robots.map(r=>({...r,online:false})); render(true);
    setTimeout(connect,1500);
  };
}
function robotList() {
  manager.updateSelection(selected);
  const key=robots.map(r=>`${r.robot_id}:${r.online}:${r.controlled}`).join() + selected + !!replay;
  if (key===cachedRobot) return;
  cachedRobot=key;
  $('robots').innerHTML=robots.map(r=>`<button class="robot-card ${r.robot_id===selected?'selected':''}" aria-pressed="${r.robot_id===selected}" data-robot="${esc(r.robot_id)}" ${replay?'disabled':''}><span class="badge">${r.profile_id?'DRAFT':r.source==='simulation'?'SIM':r.source==='robot'?'REAL':'快照'}</span><span class="dot ${r.online?'green':''}"></span><small>${r.profile_id?'待配置':r.source==='snapshot'?'历史配置':r.online?'在线':'离线'}</small><strong>${esc(r.robot_id)}</strong><small>${r.joints.length} 关节 · ${r.profile_id?'尚未接入':r.controlled?'已被接管':r.source==='simulation'?'模拟机器人':r.source==='robot'?(r.protocol==='openchicken-runtime-v1'?'运控状态':jointFeed(r)?'关节只读':'系统只读'):'未连接实时数据'}</small></button>`).join('');
  document.querySelectorAll('[data-robot]').forEach(b=>b.onclick=()=>choose(b.dataset.robot));
}
function metric(label,value,note,text=false) { return `<div class="metric"><label>${label}</label><strong class="${text?'text':''}">${esc(value)}</strong><small>${esc(note)}</small></div>`; }
function color(joint,state) {
  if (state.source==='snapshot' || state.online===false || !joint.valid) return 'var(--unknown)';
  return joint.error || joint.status==='error' ? 'var(--red)' : joint.status==='warning' || !joint.torque ? 'var(--amber)' : 'var(--green)';
}
function createSchematic(state) {
  // Head-chain anchors use URDF default-pose FK heights: 0.15244 / 0.19943 / 0.21812 / 0.23262 m.
  // Illustration mapping: trunk (220,230), 900 px/m. This is a schematic, not a calibration.
  // Head callouts are offset around the beak for readability; head pitch is on the centerline.
  const positions={33:[180,129,125,true],32:[260,142,145,false],31:[220,177,180,true],30:[243,201,205,false],
    10:[200,270,265,true],11:[180,289,300,true],12:[184,310,335,true],13:[186,337,370,true],14:[187,404,417,true],
    20:[240,270,265,false],21:[260,289,300,false],22:[256,310,335,false],23:[254,337,370,false],24:[253,404,417,false]};
  $('schematic').innerHTML=`<image href="/src/assets/openchicken-front-v2.png?v=8acd420b" x="67" y="0" width="306" height="459" aria-hidden="true"/><text x="18" y="473" class="side-label">机器人右侧 / R</text><text x="326" y="473" class="side-label">机器人左侧 / L</text>`;
  for (const j of state.joints) {
    const [x,y,labelY,left]=positions[j.id];
    const tx=left?18:326, edge=left?114:322, elbow=left?132:308;
    const group=document.createElementNS('http://www.w3.org/2000/svg','g');
    group.setAttribute('class','joint-node');group.setAttribute('tabindex','0');group.setAttribute('role','button');
    group.setAttribute('aria-label',`${j.label} ID ${j.id}`);group.dataset.joint=j.id;
    group.innerHTML=`<title>${esc(j.label)} · ID ${j.id}</title><rect class="node-label-bg" x="${tx-6}" y="${labelY-15}" width="100" height="34" rx="3"/><path class="node-leader" d="M${x} ${y}H${elbow}L${edge} ${labelY}"/><circle class="node-ring" cx="${x}" cy="${y}" r="6" fill="white" stroke-width="1.5"/><circle class="node-dot" cx="${x}" cy="${y}" r="3.5"/><text class="node-name" x="${tx}" y="${labelY-3}">${j.id} · ${esc(j.label)}</text><text class="node-value" x="${tx}" y="${labelY+12}"/>`;
    const select=()=>{jointId=j.id;$('joint-select').value=jointId;render(true);};
    group.onclick=select;group.onkeydown=e=>{if(e.key==='Enter' || e.key===' '){e.preventDefault();e.stopPropagation();select();}};
    $('schematic').append(group);
  }
}
function renderControls() {
  const r=live();
  $('claim').disabled=!canControl();$('claim').textContent=held===selected?'释放控制':'接管控制';
  $('enable').textContent=r?.protocol==='openchicken-runtime-v1'?'策略使能':'模拟使能';
  $('enable').disabled=!ready() || r?.enabled || r?.bringup!=='Ready';
  const stopMode=(r?.protocol==='openchicken-runtime-v1' ? r.enabled || ['Homing','Ready'].includes(r.bringup) : !!r?.torqued) || starting || stopping;
  $('start').className=stopMode?'estop-button':'start-button';
  $('start').dataset.action=stopMode?'estop':'start';
  $('start').disabled=!canControl() || stopping || (stopMode?!r?.capabilities.relax:(!r?.capabilities.init || (r?.controlled && held!==selected)));
  $('start').textContent=stopping?'急停中…':stopMode?'急停':'启动';
  $('start').title=stopMode?'E-stop → Relax':'Start → Init';
  $('stop').disabled=!ready();
  $('control-state').textContent=replay?'历史回放 · 控制已锁定':frozen?'画面定格 · 控制已释放':!canControl()?'此设备没有可用控制链路':held===selected?(r?.enabled?($('input-source').value==='xbox'?'已接管 · 手柄控制生效':'已接管 · 键盘控制生效'):'已接管 · 策略未使能'):r?.controlled?'其他窗口正在操控':'尚未接管';
  const movingAllowed=ready() && r.bringup==='Ready' && r.enabled && !r.seated && r.action?.status!=='running';
  document.querySelectorAll('[data-key]').forEach(b=>b.disabled=!movingAllowed);
  document.querySelectorAll('[data-skill]').forEach(b=>b.disabled=!ready() || r.bringup!=='Ready' || !r.enabled || r.action?.status==='running' || !r.capabilities.skills.includes(b.dataset.skill) || (r.seated && b.dataset.skill!=='sit_toggle'));
  const displayed=current();
  $('backend-mode').textContent=displayed?.profile_id?'待配置':displayed?.protocol==='openchicken-runtime-v1'?'运控 IPC':displayed?.source==='robot'?(jointFeed(displayed)?'真实关节只读':'真实系统只读'):'本地开发 · 模拟控制';
  $('control-mode').textContent=displayed?.profile_id?'待配置':displayed?.protocol==='openchicken-runtime-v1'?'运控':displayed?.source==='robot'?(jointFeed(displayed)?'关节只读':'系统只读'):'模拟';
  $('machine-source').textContent=displayed?.source==='simulation'?'SIM':displayed?.source==='robot'?'REAL':displayed?.source==='snapshot'?'快照':'—';
  $('machine-state').textContent=displayed?.source==='snapshot'?'未知':displayed?.online===false?'离线':displayed?.source==='robot' && displayed.protocol!=='openchicken-runtime-v1'?'运控未接入':['Limp','Homing','Ready'].includes(displayed?.bringup)?displayed.bringup:'未知';
  $('action-state').textContent=displayed?.action?`${SKILLS.find(s=>s[0]===displayed.action.skill)?.[1]||displayed.action.skill} · ${displayed.action.status==='running'?'执行中':displayed.action.status==='cancelled'?'已取消':'已完成'}`:'动作由所选设备的能力列表提供';
  $('freeze').textContent=frozen?'返回实时':'定格画面';$('freeze').disabled=!!replay;
  $('record').disabled=!!replay || !connected || (r?.source==='snapshot' && !latestFrame?.recording.active);
  localize(document.querySelector('.control-panel'));localize(document.querySelector('.toolbar'));localize(document.querySelector('.review-tools'));localize(document.querySelector('header'));
}
function renderRawImus(state) {
  for (const [key,id,sensor] of [['head_imu_raw','head-imu','BMI088'],['imu_raw','imu','LSM6DSV16X']]) {
    const runtime=state.protocol==='openchicken-runtime-v1', imuKey=key.replace('_raw','');
    const mounted=runtime || (key==='head_imu_raw' && state.head_imu?.vectors_frame==='head_axes');
    const box=$(id+'-raw'), sample=mounted?mountedImu(state,imuKey):rawImu(state,key), connected=!!state[runtime?imuKey:key];
    box.hidden=!connected;
    if (!connected) continue;
    const vector=key=>sample?sample[key].map(v=>fmt(v,3)).join(' / '):'— / — / —';
    box.innerHTML=`<span>${sensor} · ${tr(runtime?(imuKey==='imu'?'机身坐标系':'鸡头坐标系'):mounted?'鸡头坐标系 · 角速度已去零偏':'传感器原始轴')}</span><div>a XYZ: ${vector('accel_m_s2')} m/s²</div><div>ω XYZ: ${vector('gyro_rad_s')} rad/s</div><div>T: ${fmt(sample?.temperature_c)} °C</div>`;
  }
}
function render(force=false) {
  robotList();
  const state=current(); if (!state) return;
  const historic=state.source==='snapshot', stale=state.online===false && !replay && !frozen;
  $('robot-title').textContent=state.empty?'尚无机器人':state.robot_id;
  $('robot-subtitle').textContent=state.empty?'点击新机建档，添加第一台机器人':`OPENCHICKEN ALPHA / ${state.joints.length} 个关节 / ${state.profile_id?'待配置':historic?'历史审计':replay?'录制回放':state.source==='robot'?(state.protocol==='openchicken-runtime-v1'?'运控状态':jointFeed(state)?'关节只读':'系统只读'):'本地模拟机器人'}`;
  $('mode-banner').textContent=state.empty?'尚无机器人连接 · 三维仅为模型参考，所有测量值未知':state.profile_id?'新机档案 · 尚未配置连接；无真实采样数据':commissioning?'配置测试只读展示 · 实际动作请在运行监控页操作':replay?'历史回放中 · 控制已释放':frozen?'画面已定格 · 控制已释放；后台继续接收数据':historic?`历史配置快照 · ${state.captured_at||'采集时间未记录'} · 灰色数值为历史寄存器换算；三维仅显示参考站姿`:stale?'机器人反馈中断 · 操控已禁用':state.protocol==='openchicken-runtime-v1'?`运控状态 · ${state.policy||'—'} · ${fmt(state.control_loop?.hz)} Hz`:state.source==='robot'?`${jointFeed(state)?'真实关节只读':'真实系统只读'} · ${state.collection_valid?'系统采集有效':'部分系统指标未知'} · 运控未接入`:'模拟数据 · 支持键盘控制及录制；真实机器人尚未接入。';
  const pose=modelPose(state);
  $('pose-label').textContent=state.empty||state.profile_id?'参考站姿 · 关节未采集':state.source==='robot'?(pose.referenceOnly?(stale?'反馈中断 · 三维参考姿态':'参考站姿 · 关节未采集'):
    `${replay?'回放关节反馈':frozen?'已定格关节反馈':'实机关节反馈'}${state.protocol==='openchicken-runtime-v1'?' · 运控关节映射':state.model_verified?'':' · 仅监控 · 映射待校验'}${pose.measuredJoints<state.joints.length?' · 缺失关节显示参考角度':''}`):historic?'参考站姿 · 历史寄存器未标定':replay?'回放反馈位置':frozen?'已定格':stale?'反馈中断 · 保留最后姿态':'反馈位置';
  const attitude=pose.attitude;
  const imuLabel=attitude?(state.source==='robot'?`${replay?'录制机身 IMU 朝向':frozen?'已定格机身 IMU 朝向':'机身 IMU 朝向'} · 仅监控 · 相对航向 · 位置固定`:replay?'录制姿态':frozen?'已定格姿态':state.source==='simulation'?'模拟 IMU 姿态':'机身 IMU 姿态'):'IMU 未接入或数据无效 · 机身朝向使用参考值';
  $('imu-view-label').textContent=imuLabel;
  orientationPanels.render(state,{frozen,replay:!!replay});
  renderRawImus(state);
  const sys=stale?{cpu_percent:null,memory_percent:null,cpu_temp:null,voltage:null,external_power:null,speaker:'未知',microphone:'未知'}:state.system, note=historic?'历史测量':stale?'离线':state.source==='simulation'?'模拟测量':'实时测量';
  const powerStatus=sys.external_power==null?'电池供电状态未知':sys.external_power?'电池供电已接入':'电池供电未接入';
  $('metrics').innerHTML=metric('电池电压',`${fmt(sys.voltage)} V`,sys.voltage_source==='dxl_mean'?`${sys.voltage_samples}/14 有效 · 均值 · ${fmt(sys.voltage_min)}–${fmt(sys.voltage_max)} V · ${powerStatus}`:`${powerStatus} · ${note}`)+metric('CPU 温度',`${fmt(sys.cpu_temp)} °C`,`CPU ${fmt(sys.cpu_percent)}% · 内存 ${fmt(sys.memory_percent)}%`)+metric('关节状态',`${state.joints.filter(j=>j.valid && !stale).length} / ${state.joints.length}`,state.source==='robot'?(jointFeed(state)?`只读反馈 · ${state.joints.filter(j=>j.error||j.alert).length} 故障 · ${stale?'力矩未知':state.torqued===false?'无力矩':'力矩未知'}`:'关节与力矩未知'):historic?'历史状态，未实时校验':`${state.joints.filter(j=>j.error).length} 故障 · ${state.enabled?'已使能':'未使能'}`)+metric('扬声器',sys.speaker,'设备枚举与音频验证分开',true)+metric('麦克风',sys.microphone,'设备枚举与采音验证分开',true)+metric('相机','未接入','视频链路未接入',true);
  const key=state.robot_id+state.joints.map(j=>j.id).join();
  if (schemaKey!==key) {
    schemaKey=key;
    $('joint-select').innerHTML=state.joints.map(j=>`<option value="${j.id}">${j.id} · ${esc(j.label)}</option>`).join('');
    if (!state.joints.some(j=>j.id===jointId)) jointId=state.joints[0].id;
    $('joint-select').value=jointId;createSchematic(state);
  }
  const angleUnit=$('angle-unit').value;
  $('chart-unit').textContent=tr(angleUnit==='rad'?'单位 rad · 悬停查看数值':'单位 degree (°) · 悬停查看数值');
  for (const joint of state.joints) {
    const node=document.querySelector(`[data-joint="${joint.id}"]`), tint=color(joint,state);
    node.classList.toggle('selected',joint.id===jointId);
    node.setAttribute('aria-pressed',String(joint.id===jointId));
    node.querySelector('.node-ring').setAttribute('stroke',joint.id===jointId?'#ff5250':tint);
    node.querySelector('.node-dot').setAttribute('fill',tint);
    const value=node.querySelector('.node-value');value.setAttribute('fill',tint);value.textContent=angleText(stale?null:joint.position,angleUnit);
  }
  const joint=state.joints.find(j=>j.id===jointId);
  $('joint-detail').innerHTML=`<strong title="ID ${joint.id} · ${esc(joint.label)} / ${esc(joint.name)}">ID ${joint.id} · ${esc(joint.label)} / ${esc(joint.name)}</strong><small>当前位置 ${angleText(stale?null:joint.position,angleUnit,true)} · ${fmt(stale?null:joint.voltage)} V · ${fmt(joint.current_ma,0)} mA · ${fmt(joint.temperature,0)} °C${historic?' · 历史值':''}</small>`;
  const params=[['P / I / D',`${joint.p??'—'} / ${joint.i??'—'} / ${joint.d??'—'}`],['PWM slope / limit',`${joint.pwm_slope??'—'} / ${joint.pwm_limit??'—'}`],['Homing offset',joint.homing_offset??'—'],['Drive mode',joint.drive_mode??'—'],['寄存器方向',joint.drive_mode==null?'未知':joint.drive_mode&1?'反向':'正向'],['力矩',joint.torque==null?'未知':joint.torque?'开启':'关闭'],['硬件错误',joint.error==null?'未知':`0x${Number(joint.error).toString(16).padStart(2,'0')}`],['映射校验',state.protocol==='openchicken-runtime-v1'?'运控提供':state.model_verified?'已校验':'待实机校验']];
  $('parameters').innerHTML=params.map(([label,value])=>`<div><label>${label}</label><b>${esc(value)}</b></div>`).join('');
  const showAxes=$('joint-axes').checked;
  $('axis-info').hidden=!showAxes;
  $('axis-joint').textContent=`ID ${joint.id} · ${joint.label} / ${joint.name}`;
  viewer?.update(state,jointId,$('ghost').checked,showAxes);
  const history=samples();
  chart?.update(history,jointId,Number($('window').value),replay?history[replayIndex]?.time:undefined,angleUnit,`${selected}:${replay?'replay':frozen?'frozen':'live'}`);
  renderControls();
  if (latestFrame) {
    const rec=latestFrame.recording;
    $('record').textContent=rec.active?'■ 结束录制':'● 开始录制';
    $('record-status').textContent=rec.active?`${rec.robot_id} · ${(rec.bytes/1024).toFixed(0)} KiB`:rec.error||'尚未录制';
    const events=replay?replay.events.filter(e=>e.time<=replay.samples[replayIndex].time):frozen?frozenEvents:latestFrame.events;
    const eventKey=JSON.stringify(events);
    if (eventKey!==lastEventKey || force) {
      lastEventKey=eventKey;
      $('events').innerHTML=events.filter(e=>e.robot_id===selected||e.robot_id==='system').slice(0,25).map(e=>`<div class="event"><time>${new Date(e.time*1000).toLocaleTimeString(locale,{hour12:false})}</time><span>${esc(e.message)}</span></div>`).join('');
    }
    $('packet-info').textContent=`丢帧 ${state.dropped||0} · 录制丢帧 ${rec.dropped||0} · ${state.telemetry_hz||20} Hz`;
  }
  localize(document.querySelector('main'));
  if (replay) { $('seek').value=replayIndex; $('replay-time').textContent=`${(history[replayIndex].time-history[0].time).toFixed(1)} / ${(history.at(-1).time-history[0].time).toFixed(1)} s`; }
}
async function action(skill) {
  const button=document.querySelector(`[data-skill="${skill}"]`);
  if (!button || button.disabled) return;
  clearKeys();
  try {await request('action',selected,{skill,action_id:crypto.randomUUID()});} catch(e){toast(e.message);}
}
$('skills').innerHTML=SKILLS.map(([skill,label],i)=>`<button data-skill="${skill}" disabled><kbd>${i+1}</kbd>${label}</button>`).join('');
document.querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>action(b.dataset.skill));
$('claim').onclick=async()=>{
  if (held) return release();
  const id=selected;
  try {await request('claim',id); held=id; if(selected!==id || frozen || replay || document.hidden)await release(); renderControls();} catch(e){toast(e.message);}
};
async function startRobot() {
  if ($('start').disabled || starting || stopping || $('start').dataset.action!=='start') return;
  const id=selected, epoch=++startEpoch;starting=true;renderControls();
  try {
    if (held!==id) await request('claim',id);
    if (epoch!==startEpoch || selected!==id || frozen || replay || document.hidden) {
      try {await request('release',id);} catch {} return;
    }
    held=id;
    await request('init',id);
  } catch(e) {toast(e.message);await release();}
  finally {starting=false;renderControls();}
};
async function stopRobot() {
  if ($('start').disabled) return;
  startEpoch++;clearKeys();xbox.reset();padFrame=null;stopping=true;const id=selected;renderControls();
  try {await request('relax',id);if(held===id)held=null;}
  catch(e) {toast(e.message);}
  finally {stopping=false;renderControls();}
};
$('refresh-robots').onclick=async()=>{
  if(commissioning){await manager.refresh();toast('档案已同步');return;}
  const button=$('refresh-robots'), known=new Set(robots.map(r=>r.robot_id));
  button.disabled=true;button.setAttribute('aria-busy','true');
  try {
    const result=await request('refresh_robots');
    robots=result.robots;cachedRobot='';render(true);
    const added=robots.filter(r=>!known.has(r.robot_id)).length;
    toast(`${tr('设备列表已刷新')} · ${robots.length} ${tr('台设备')} · ${added?`${tr('新增设备')} ${added}`:tr('未发现新设备')} · ${tr('仅查询本地主机')}`);
  } catch(e) {toast(e.message);}
  finally {button.disabled=false;button.setAttribute('aria-busy','false');}
};
$('start').onclick=()=>{if($('start').dataset.action==='estop')stopRobot();else startRobot();};
$('enable').onclick=()=>request('enable').catch(e=>toast(e.message));
$('stop').onclick=()=>{clearKeys();if($('input-source').value==='xbox'){void release();return;}if(ready())request('stop').catch(e=>toast(e.message));};
$('freeze').onclick=async()=>{if(!frozen){frozenState=structuredClone(live());frozenSamples=[...(histories.get(selected)||[])];frozenEvents=latestFrame.events;await release();}frozen=!frozen;render(true);};
$('ghost').onchange=()=>render(true);
$('joint-axes').onchange=()=>render(true);
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>viewer?.setView(button.dataset.view);
$('joint-select').onchange=e=>{jointId=Number(e.target.value);render(true);};
$('window').onchange=()=>render(true);
$('angle-unit').onclick=()=>{
  const button=$('angle-unit');
  button.value=button.value==='degree'?'rad':'degree';
  button.firstChild.nodeValue=button.value==='degree'?'degree (°) ':'rad ';
  render(true);
};
$('reset-camera').onclick=()=>viewer?.reset();
$('record').onclick=async()=>{try{await request(latestFrame.recording.active?'record_stop':'record_start');}catch(e){toast(e.message);}};

const aliases={ArrowUp:'KeyW',ArrowDown:'KeyS',ArrowLeft:'KeyA',ArrowRight:'KeyD'};
function inputContext(e) { return e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,textarea,select,[contenteditable=true],dialog[open]'); }
window.addEventListener('keydown',e=>{
  if (inputContext(e)) return;
  if(e.code==='Escape'){release();return;}
  if(e.code==='Space' && $('input-source').value==='xbox'){e.preventDefault();$('stop').click();return;}
  if (!ready() || $('input-source').value==='xbox') return;
  const key=aliases[e.code]||e.code;
  if (['KeyW','KeyS','KeyA','KeyD','Space'].includes(key) || /^Digit[1-5]$/.test(key)) e.preventDefault();
  if (e.repeat) return;
  if (key==='Space') { $('stop').click();return; }
  if (/^Digit[1-5]$/.test(key)) {action(SKILLS[Number(key.at(-1))-1][0]);return;}
  const button=document.querySelector(`[data-key="${key}"]`);
  if(button && !button.disabled){keys.add(key);button.classList.add('active');}
});
window.addEventListener('keyup',e=>{const key=aliases[e.code]||e.code;keys.delete(key);document.querySelector(`[data-key="${key}"]`)?.classList.remove('active');});
window.addEventListener('blur',release);
document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
document.querySelectorAll('[data-key]').forEach(button=>{
  button.onpointerdown=e=>{if(button.disabled || $('input-source').value==='xbox')return;e.preventDefault();button.setPointerCapture(e.pointerId);keys.add(button.dataset.key);button.classList.add('active');};
  button.onpointerup=button.onpointercancel=button.onlostpointercapture=()=>{keys.delete(button.dataset.key);button.classList.remove('active');};
});
const padStatuses={disconnected:'未检测到手柄 · 按任意键连接',unsupported:'手柄布局不受支持',inactive:'手柄控制未激活',neutral:'请回中摇杆并松开按键',interrupted:'输入中断 · 请回中并重新接管',ready:'手柄已连接'};
function renderInputView() {
  const source=$('input-source').value;
  document.querySelectorAll('[data-input-view]').forEach(element=>element.hidden=element.dataset.inputView!==source);
  document.querySelector('.control-body').dataset.input=source;
}
$('input-source').onchange=()=>{release();xbox.reset();padFrame=null;renderInputView();};
renderInputView();
async function padCommand(command) {
  if (command==='relax') {await stopRobot();return;}
  if (padCommandBusy) return;
  padCommandBusy=true;
  try {
    if (command==='init') await startRobot();
    else await action(command);
  } finally {padCommandBusy=false;}
}
function pollGamepad(now) {
  try {
    const active=$('input-source').value==='xbox' && canControl() && !document.hidden && document.hasFocus() && !document.querySelector('dialog[open]');
    const pads=navigator.getGamepads?.() || [];
    const pad=Array.from(pads).find(p=>p?.connected);
    gamepadView.update(pad,now,!document.hidden && document.hasFocus());
    const result=xbox.poll(pad,now,`${selected}:${live()?.boot_id}`,active);
    padFrame=result;padSampleAt=now;
    const velocity=result.velocity;
    const status=tr(padStatuses[result.status]);
    if ($('gamepad-status').textContent!==status) $('gamepad-status').textContent=status;
    const values=`vx ${velocity.vx.toFixed(2)} · vy ${velocity.vy.toFixed(2)} m/s · yaw ${velocity.vyaw.toFixed(2)} rad/s`;
    if ($('gamepad-values').textContent!==values) $('gamepad-values').textContent=values;
    if (result.fault) {release();toast('手柄输入中断，已释放控制；请回中并重新接管');}
    else if (result.command) void padCommand(result.command);
  } catch {gamepadView.update(null,now);if(held && $('input-source').value==='xbox')void release();xbox.reset();padFrame=null;}
  requestAnimationFrame(pollGamepad);
}
requestAnimationFrame(pollGamepad);
window.addEventListener('blur',()=>gamepadView.update(null,performance.now(),false));
document.addEventListener('visibilitychange',()=>{if(document.hidden)gamepadView.update(null,performance.now(),false);});
let controlBusy=false, wasMoving=false, lastControlTick=performance.now();
setInterval(async()=>{
  const now=performance.now(), gap=now-lastControlTick;lastControlTick=now;
  // Check gaps before the busy/ownership gate: never renew cached input after a stalled frame.
  if (gap>150 && held) {wasMoving=false;await release();return;}
  if(controlBusy || !ready())return;
  const usePad=$('input-source').value==='xbox';
  // A disconnect can arrive between animation frames; verify identity again at send time.
  const connectedPad=usePad?Array.from(navigator.getGamepads?.()||[]).find(p=>p?.connected):null;
  const samePad=connectedPad && xbox.key===JSON.stringify([connectedPad.index,connectedPad.id,`${selected}:${live()?.boot_id}`]);
  if(usePad && (!samePad || !padFrame || padFrame.status!=='ready' || now-padSampleAt>100 || document.hidden || !document.hasFocus())) {
    wasMoving=false;await release();return;
  }
  controlBusy=true;
  const id=held;
  try {
    const r=live();
    const velocity=usePad?padFrame.velocity:{vx:(Number(keys.has('KeyW'))-Number(keys.has('KeyS')))*0.12,vy:0,vyaw:(Number(keys.has('KeyA'))-Number(keys.has('KeyD')))*0.4};
    const moving=Object.values(velocity).some(v=>v!==0);
    if (r.bringup==='Ready' && r.enabled && !r.seated && r.action?.status!=='running' && !padCommandBusy && !stopping && (moving||wasMoving))
      await request('drive',id,velocity);
    else await request('heartbeat',id);
    wasMoving=moving;
  } catch(e) {if(held===id)await release();toast(e.message);renderControls();}
  finally {controlBusy=false;}
},100);

async function loadReplay(text) {
  const rows=text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const metadata=rows.find(r=>r.kind==='metadata')?.data;
  const states=rows.filter(r=>r.kind==='state').map(r=>({time:r.host_time,state:r.data}));
  const validState=s=>s && s.schema_version===1 && s.system && s.capabilities && Array.isArray(s.capabilities.skills) &&
    Array.isArray(s.joints) && s.joints.length===14 && s.joints.every(j=>j && Number.isInteger(j.id) && typeof j.name==='string' && (Number.isFinite(j.position) || (j.position===null && j.valid===false))) &&
    new Set(s.joints.map(j=>j.id)).size===14 && s.joints.every(j=>[10,11,12,13,14,20,21,22,23,24,30,31,32,33].includes(j.id));
  if(metadata?.schema_version!==1 || typeof metadata.robot_id!=='string' || !states.length || states.some(r=>!Number.isFinite(r.time)||!validState(r.state)||r.state.robot_id!==metadata.robot_id)) throw new Error('文件不是可识别的 14 关节单机器人录制');
  for (let i=1;i<states.length;i++) if(states[i].time<=states[i-1].time) states[i].time=states[i-1].time+0.0001;
  await release();
  replay={samples:states,events:rows.filter(r=>r.kind==='event').map(r=>({...r.data,time:r.host_time})).reverse()};replayIndex=0;playing=false;frozen=false;selected=metadata.robot_id;
  $('seek').max=states.length-1;$('replay-bar').hidden=false;$('history-dialog').close();render(true);
}
$('history').onclick=async()=>{
  await release(); $('history-dialog').showModal();
  try {
    const records=await (await fetch('/api/recordings')).json();
    $('recordings').replaceChildren();
    if(!records.length)$('recordings').textContent='暂无录制。选择在线设备后可开始录制。';
    for(const item of records){
      const row=document.createElement('div');row.className='record-row';
      row.innerHTML=`<span>${esc(item.id)}<br><small>${(item.bytes/1024).toFixed(1)} KiB</small></span><button>回放</button><a href="/api/recordings/${encodeURIComponent(item.id)}" download>下载</a>`;
      row.querySelector('button').onclick=async()=>{try{const response=await fetch(`/api/recordings/${encodeURIComponent(item.id)}`);if(!response.ok)throw new Error(await response.text());await loadReplay(await response.text());}catch(e){toast(e.message);}};
      $('recordings').append(row);
    }
  }catch(e){toast(e.message);}
  localize($('history-dialog'));
};
$('close-history').onclick=()=>$('history-dialog').close();
$('import').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>64*1024*1024)throw new Error('文件超过 64 MiB');await loadReplay(await file.text());}catch(err){toast(err.message);}e.target.value='';};
$('exit-replay').onclick=()=>{replay=null;playing=false;cachedRobot='';$('replay-bar').hidden=true;render(true);};
$('seek').oninput=e=>{replayIndex=Number(e.target.value);playing=false;$('play').textContent='播放';render(true);};
$('play').onclick=()=>{if(replayIndex===replay.samples.length-1)replayIndex=0;playing=!playing;playStart=performance.now();sampleStart=replay.samples[replayIndex].time;$('play').textContent=tr(playing?'暂停回放':'播放');};
let playStart=0,sampleStart=0;
setInterval(()=>{if(!playing||!replay)return;const time=sampleStart+(performance.now()-playStart)/1000;while(replayIndex<replay.samples.length-1 && replay.samples[replayIndex+1].time<=time)replayIndex++;if(replayIndex===replay.samples.length-1){playing=false;$('play').textContent='播放';}render();},50);
$('csv').onclick=()=>{
  const lines=['time,robot_id,joint_id,requested_rad,submitted_rad,position_rad,error_rad'];
  for(const s of samples()){
    const j=s.state.joints.find(j=>j.id===jointId);
    if(!j?.valid || s.state.online===false)continue;
    lines.push([s.time,JSON.stringify(s.state.robot_id),j.id,j.requested??'',j.submitted??'',j.position??'',Number.isFinite(j.submitted)?j.submitted-j.position:''].join(','));
  }
  const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`joint-${jointId}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
function renderTheme() {
  const dark=document.documentElement.dataset.theme==='dark';
  $('theme-toggle').setAttribute('aria-pressed',String(dark));
  $('theme-toggle').title=tr(dark?'切换浅色模式':'切换深色模式');
  chart?.updateTheme();
  viewer?.updateTheme();
}
$('theme-toggle').onclick=()=>{
  const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme=theme;
  try {localStorage.setItem('openchicken-theme',theme);} catch {}
  renderTheme();
};
$('theme-toggle').onkeydown=e=>{if(e.key===' ' || e.key==='Enter')e.stopPropagation();};
renderTheme();
setInterval(()=>$('clock').textContent=new Date().toLocaleTimeString(locale,{hour12:false}),1000);
try {viewer=new Viewer($('viewer')); viewer.load().then(()=>{$('viewer').dataset.loaded='true';render(true);}).catch(e=>{ $('model-error').hidden=false;$('model-error').textContent=tr(e.message); });}
catch(e){$('model-error').hidden=false;$('model-error').textContent=tr(`三维视图不可用：${e.message}`);}
localize(document.documentElement);
chart=new JointChart($('chart'));
const manager=new RobotManager({select:choose,current:()=>selected,notify:toast,release});
await manager.init();
connect();
