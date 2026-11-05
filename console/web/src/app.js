import { MouthPwm } from './mouth-pwm.js?v=20261104-pwm-copy';
import { ServoParameters } from './servo-parameters.js?v=20261104-readback';
import { ManagedBindings } from './managed-bindings.js?v=20261103-management';
import { RobotManager, commissioning, setWorkspaceMode } from './robot-manager.js?v=20261104-workspace-modes';
import { GamepadView } from './gamepad-view.js?v=20261104-lt-pwm';
import { XboxInput } from './gamepad.js?v=20261104-trigger-neutral';
import { Viewer } from './viewer.js?v=20261104-render-budget';
import { JointChart } from './chart.js?v=20261030-three-curves';
import { rawImu, mountedImu } from './imu_raw.js?v=20261030-head-mount';
import { angleText } from './angles.js';
import { jointFeed, modelPose } from './view-pose.js?v=20261030-live-3d';
import { OrientationPanels } from './orientation-panel.js?v=20261029-fusion-monitor';
import { tr, localize, locale, english } from './i18n.js?v=20261105-control-source';

const $ = id => document.getElementById(id);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, digits=1) => Number.isFinite(n) ? n.toFixed(digits) : '—';
const managedBindings=new ManagedBindings();
let managedButtonsSignature='';
const SKILLS = [['sit_toggle','坐下 / 站起'],['ground_pick','地面拾取'],['kick_left','左脚踢球'],['kick_right','右脚踢球'],['roulade','翻滚']];
let switchingMode=false, modeSelection=null, modeSyncBusy=false;
let socket, connected=false, robots=[], selected='demo-01', jointId=13, held=null;
let frozen=false, frozenState=null, frozenSamples=[], frozenEvents=[], replay=null, replayIndex=0, playing=false;
let latestFrame=null, viewer=null, chart=null, lastUI=0, lastEventKey='', cachedRobot='', schemaKey='';
const pending=new Map(), histories=new Map(), keys=new Set();
const orientationPanels=new OrientationPanels(()=>render(true));
const xbox=new XboxInput();
const gamepadView=new GamepadView($('gamepad-inspector'));
const mouthPwm=new MouthPwm($('mouth-pwm'),{context:()=>({id:selected,online:!!live()?.online,state:live()?.mouth_pwm,allowed:commissioning&&connected&&!switchingMode&&!modeSyncBusy&&modeSelection===selected&&!frozen&&!replay&&!!live()?.online&&!!live()?.capabilities.pwm}),send:(id,payload)=>request('pwm',id,payload)});
let padFrame=null, padSampleAt=0, padCommandBusy=false;
const inputPauses=new Map();
let padConnected=false, renderPending=false, sourceSwitching=false, shownSource=null;
const pauseLabels={
  stall:['页面卡顿','Page stalled'],changed:['手柄或机器人会话已更换','Controller or robot session changed'],focus:['窗口失焦','Window lost focus'],
  disconnected:['手柄断连或设备已更换','Controller disconnected or changed'],
  rejected:['命令未完成或被拒绝','Command failed or rejected'],
  telemetry:['机器人反馈中断','Robot feedback interrupted'],host:['主机连接中断','Host disconnected'],
  stale:['输入采样已过期','Input sample expired'],neutral:['等待摇杆回中','Waiting for neutral input'],
  unavailable:['控制链路不可用','Control unavailable'],input:['手柄读取异常','Controller read failed']
};
function rememberPause(reason,detail='',id=selected) {
  if($('input-source').value!=='xbox')return;
  // Keep the first cause; a later blur/disconnect must not hide the original failure.
  if(!inputPauses.has(id))inputPauses.set(id,{reason,detail,time:new Date().toLocaleTimeString(locale,{hour12:false})});
  renderInputPause();
}
function pauseLabel(pause){const labels=pauseLabels[pause.reason]||pauseLabels.unavailable;return labels[english?1:0];}
function renderInputPause(){
  const pause=inputPauses.get(selected),box=$('input-pause');
  box.hidden=!pause||$('input-source').value!=='xbox';
  if(!pause)return;
  const text=`${pause.time} · ${pauseLabel(pause)}${pause.detail?' · '+tr(pause.detail):''} · ${english?'Center sticks and release buttons, then acquire control again.':'摇杆回中并松开按键，再重新接管控制。'}`;
  if(box.textContent!==text)box.textContent=text;
}
const renderedHTML=new WeakMap();
function setHTML(element,html){
  if(renderedHTML.get(element)===html)return;
  renderedHTML.set(element,html);element.innerHTML=html;
}
let toastTimer, starting=false, stopping=false, startEpoch=0;
function toast(text) { $('toast').textContent=tr(text); $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,4500); }
function request(type, robotId=selected, payload={}, sentAt=Date.now()) {
  if (!connected) return Promise.reject(new Error('主机连接已中断'));
  const id=crypto.randomUUID();
  return new Promise((resolve,reject) => {
    const fail=error=>reject(new Error(`${type}: ${tr(error.message)||(english?'No error detail returned':'未返回错误详情')}`));
    const timer=setTimeout(()=>{pending.delete(id); fail(new Error('请求超时，结果未确认；请检查设备状态'));},type==='control_source'?55000:type==='set_mode'?4000:1300);
    pending.set(id,{resolve,reject:fail,timer});
    socket.send(JSON.stringify({id,type,robot_id:robotId,payload,sent_at:sentAt}));
  });
}
// Notifications have no request timer and are never retried or buffered by the UI.
function notifyControl(type, robotId=selected, payload={}, sentAt=Date.now()) {
  if(!connected || socket.readyState!==WebSocket.OPEN)throw new Error(tr('主机连接已中断'));
  const robot=robots.find(r=>r.robot_id===robotId);
  if(robot?.source==='robot' && robot.control_stream_version!==1)throw new Error(english?'Update the robot agent for notification-based control':'请更新机器人 agent 以支持无逐帧回执控制');
  if(socket.bufferedAmount>0 || Date.now()-sentAt>=150){
    if(!['pad_input','drive','heartbeat'].includes(type))toast(english?'Input busy or expired; action was not sent':'输入拥堵或过期；本次动作未发送');
    return false;
  }
  socket.send(JSON.stringify({type,robot_id:robotId,payload,sent_at:sentAt,reply:false}));
  return true;
}
function live() { return robots.find(r=>r.robot_id===selected); }
function current() { return replay ? replay.samples[replayIndex]?.state : frozen ? frozenState : live() || latestFrame?.empty_state; }
function samples() { return replay ? replay.samples : frozen ? frozenSamples : histories.get(selected)||[]; }
function canReach() { const r=live(); return !switchingMode && modeSelection===selected && !commissioning && connected && !frozen && !replay && r?.online && r.capabilities.motion && r.control_channel!=='connecting' && r.control_channel!=='disconnected' && ['simulation','robot'].includes(r.source); }
function canControl() { const r=live();return canReach()&&!sourceSwitching&&(r?.source!=='robot'||r.control_source?.mode==='console'); }
function ready() { return canControl() && held===selected; }
function clearKeys() { keys.clear(); document.querySelectorAll('[data-key]').forEach(e=>e.classList.remove('active')); }
async function release(reason,detail='') {
  if(held && typeof reason==='string')rememberPause(reason,detail,held);
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
  await mouthPwm.stop();
  await release();
  selected=id; frozen=false; frozenState=null; cachedRobot='';
  await syncWorkspace();
  render(true);
}
async function syncWorkspace(){
  if(!connected||modeSyncBusy||switchingMode||modeSelection===selected)return;
  modeSyncBusy=true;const id=selected;
  try{await request('set_mode',id,{mode:commissioning?'commissioning':'monitor'});modeSelection=id;}
  catch(error){toast(error.message);}
  finally{modeSyncBusy=false;renderControls();}
}
async function switchMode(mode){
  if(switchingMode||modeSyncBusy||mode===(commissioning?'commissioning':'monitor'))return;
  if(!connected){toast(english?'Host disconnected; reconnect before switching modes':'主机已断开，请重连后切换模式');return;}
  if(mode==='commissioning'&&held&&!confirm(english?'Stop and relax this window’s robot, then enter Commissioning?':'停止并松力当前窗口控制的机器人，然后进入配置模式？'))return;
  switchingMode=true;startEpoch++;clearKeys();xbox.reset();padFrame=null;
  try{
    await mouthPwm.stop();
    renderControls();
    await request('set_mode',selected,{mode});held=null;modeSelection=selected;
    setWorkspaceMode(mode);manager.applyMode();render(true);
  }catch(error){held=null;toast(error.message);}
  finally{switchingMode=false;renderControls();}
}
document.addEventListener('click',event=>{
  const link=event.target.closest('a');if(!link)return;
  const url=new URL(link.href,location.href);
  if(url.origin!==location.origin)return;
  if(url.pathname.endsWith('/commissioning/')){event.preventDefault();void switchMode('commissioning');}
  else if(link.hasAttribute('data-monitor')){event.preventDefault();void switchMode('monitor');}
});
function connect() {
  socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${'/ws?mode='+(commissioning?'commissioning':'monitor')}`);
  socket.onopen=()=>{connected=true;modeSelection=null;void syncWorkspace(); $('connection').textContent=tr('主机已连接'); $('connection').className='badge green';};
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.type==='control_notice'){if(message.robot_id===selected)toast(message.error);return;}
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
    if (held && (!robots.find(r=>r.robot_id===held)?.online)) release('telemetry');
    // Keep every telemetry sample; coalesce only the expensive visual updates.
    renderPending=true;
  };
  socket.onclose=()=>{
    if(held)rememberPause('host','',held);
    connected=false; modeSelection=null;held=null; clearKeys();xbox.reset();padFrame=null;
    for (const p of pending.values()) {clearTimeout(p.timer);p.reject(new Error('主机连接已中断'));}
    pending.clear();
    $('connection').textContent=tr('主机已断开'); $('connection').className='badge amber';
    robots=robots.map(r=>({...r,online:false})); render(true);
    setTimeout(connect,1500);
  };
}
function robotList() {
  manager.updateSelection(selected);
  void syncWorkspace();
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
  const mouth=document.createElementNS('http://www.w3.org/2000/svg','g');
  mouth.setAttribute('role','img');mouth.setAttribute('aria-label','Mouth PWM，无位置反馈');
  mouth.innerHTML='<path class="node-leader" d="M220 155H300L322 100"/><circle cx="220" cy="155" r="5" fill="var(--unknown)"/><text x="326" y="95" class="node-name">mouth · PWM</text><text x="326" y="111" class="node-value">无位置反馈</text>';
  $('schematic').append(mouth);
}
function renderManagedBindings() {
  const row=manager?.data.robots.find(r=>r.robot_id===selected),target=row?{address:row.address,port:row.ssh_port,user:row.ssh_user}:null;
  const entries=Object.fromEntries(Object.entries(row?.policy_management?.bindings||{}).filter(([,entry])=>JSON.stringify(entry.target)===JSON.stringify(target)));
  if(managedBindings.configure(entries,`${selected}:${live()?.boot_id}`)&&held)void release();
  const skills=(live()?.capabilities.skills||[]).filter(skill=>!SKILLS.some(([name])=>name===skill));
  const signature=JSON.stringify([selected,skills,entries]);if(signature===managedButtonsSignature)return;managedButtonsSignature=signature;
  document.querySelectorAll('[data-managed-skill]').forEach(button=>button.remove());
  for(const skill of skills){
    const entry=entries[skill];
    const button=document.createElement('button');button.dataset.skill=skill;button.dataset.managedSkill='true';button.disabled=true;
    button.textContent=(entry?.bindings.keyboard[0]?.code.replace('Digit','')||'')+' '+(entry?.label?.[english?'en':'zh']||skill);
    button.onclick=()=>action(skill);if(new URLSearchParams(location.search).get('skill')===skill)button.title=english?'Selected for acceptance; press to run after enabling':'待验收动作；使能后点击执行';$('skills').append(button);
  }
}
function renderControls() {
  mouthPwm.render();
  renderManagedBindings();
  const r=live();
  $('control-source-panel').hidden=r?.source!=='robot';
  const source=r?.control_source;
  const sourceKey=selected+':'+source?.mode;
  if(!sourceSwitching&&shownSource!==sourceKey){shownSource=sourceKey;$('control-source').value=source?.mode==='console'?'console':'bluetooth';}
  $('control-source-status').textContent=sourceSwitching?'正在切换，两路控制暂时禁用':source?.error||({bluetooth:source?.input_ready?'蓝牙直连 · 手柄已连接，输入就绪':source?.bluetooth_connected?'蓝牙直连 · 已连接，输入设备准备中':'蓝牙直连 · 等待手柄连接（切回蓝牙模式并开机，可再次点击切换来源重试）',console:'监控端控制 · 板端手柄蓝牙已屏蔽',switching:'板端正在切换'}[source?.mode]||'控制来源服务未就绪，请更新板端');
  $('control-source-apply').disabled=sourceSwitching||!canReach()||!source?.available||r?.enabled!==false||r?.bringup!=='Limp'||(r?.controlled&&held!==selected);
  $('control-source').disabled=sourceSwitching;
  const connectionLabel=!connected?(english?'Host disconnected':'主机断开'):!r?.online?(english?'Robot offline':'机器人离线'):commissioning?(english?'Robot online · Read-only':'机器人在线 · 只读'):r.control_channel==='not_configured'?(english?'Robot online · Control not configured':'机器人在线 · 控制未配置'):r.controlled&&held!==selected?(english?'Robot online · Control in use':'机器人在线 · 控制被占用'):r.control_channel==='connecting'?(english?'Robot online · Control connecting':'机器人在线 · 控制连接中'):r.control_channel==='connected'?(english?'Robot online · Control connected':'机器人在线 · 控制已连接'):(english?'Robot online · Control unavailable':'机器人在线 · 控制不可用');
  if($('workspace-connection'))$('workspace-connection').textContent=connectionLabel;
  document.querySelectorAll('[data-workspace]').forEach(b=>b.disabled=switchingMode||!connected);
  gamepadView.bindings(r?.pad_profile?.bindings);
  $('claim').disabled=!canControl();$('claim').textContent=held===selected?'释放控制':'接管控制';
  $('enable').textContent=r?.protocol==='openchicken-runtime-v1'?'策略使能':'模拟使能';
  $('enable').disabled=!ready() || r?.enabled || r?.bringup!=='Ready';
  const stopMode=(r?.protocol==='openchicken-runtime-v1' ? r.enabled || ['Homing','Ready'].includes(r.bringup) : !!r?.torqued) || starting || stopping;
  $('start').className=stopMode?'estop-button':'start-button';
  $('start').dataset.action=stopMode?'estop':'start';
  $('start').disabled=!canReach() || (!stopMode&&!canControl()) || stopping || (stopMode?!r?.capabilities.relax:(!r?.capabilities.init || (r?.controlled && held!==selected)));
  $('start').textContent=stopping?'急停中…':stopMode?'急停':'启动';
  $('start').title=$('start').disabled?connectionLabel:stopMode?'E-stop → Relax':'Start → Init';
  $('stop').disabled=!ready();
  const pause=$('input-source').value==='xbox'?inputPauses.get(selected):null;
  renderInputPause();
  $('control-state').textContent=pause?`${english?'Control paused':'控制已暂停'} · ${pauseLabel(pause)}`:replay?'历史回放 · 控制已锁定':frozen?'画面定格 · 控制已释放':!canControl()?'此设备没有可用控制链路':held===selected?(r?.enabled?($('input-source').value==='xbox'?'已接管 · 手柄控制生效':'已接管 · 键盘控制生效'):'已接管 · 策略未使能'):r?.controlled?'其他窗口正在操控':'尚未接管';
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
  $('mode-banner').textContent=state.empty?'尚无机器人连接 · 三维仅为模型参考，所有测量值未知':state.profile_id?'新机档案 · 尚未配置连接；无真实采样数据':commissioning?(english?'Commissioning · Read-only telemetry · Switch to Monitor for motion':'配置模式 · 只读反馈 · 动作测试请切换运行监控'):replay?'历史回放中 · 控制已释放':frozen?'画面已定格 · 控制已释放；后台继续接收数据':historic?`历史配置快照 · ${state.captured_at||'采集时间未记录'} · 灰色数值为历史寄存器换算；三维仅显示参考站姿`:stale?'机器人反馈中断 · 操控已禁用':state.protocol==='openchicken-runtime-v1'?`运控状态 · ${state.policy||'—'} · ${fmt(state.control_loop?.hz)} Hz`:state.source==='robot'?`${jointFeed(state)?'真实关节只读':'真实系统只读'} · ${state.collection_valid?'系统采集有效':'部分系统指标未知'} · 运控未接入`:'模拟数据 · 支持键盘控制及录制；真实机器人尚未接入。';
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
  setHTML($('metrics'),metric('电池电压',`${fmt(sys.voltage)} V`,sys.voltage_source==='dxl_mean'?`${sys.voltage_samples}/14 有效 · 均值 · ${fmt(sys.voltage_min)}–${fmt(sys.voltage_max)} V · ${powerStatus}`:`${powerStatus} · ${note}`)+metric('CPU 温度',`${fmt(sys.cpu_temp)} °C`,`CPU ${fmt(sys.cpu_percent)}% · 内存 ${fmt(sys.memory_percent)}%`)+metric('关节状态',`${state.joints.filter(j=>j.valid && !stale).length} / ${state.joints.length}`,state.source==='robot'?(jointFeed(state)?`只读反馈 · ${state.joints.filter(j=>j.error||j.alert).length} 故障 · ${stale?'力矩未知':state.torqued===false?'无力矩':'力矩未知'}`:'关节与力矩未知'):historic?'历史状态，未实时校验':`${state.joints.filter(j=>j.error).length} 故障 · ${state.enabled?'已使能':'未使能'}`)+metric('扬声器',sys.speaker,'设备枚举与音频验证分开',true)+metric('麦克风',sys.microphone,'设备枚举与采音验证分开',true)+metric('相机','未接入','视频链路未接入',true));
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
  setHTML($('joint-detail'),`<strong title="ID ${joint.id} · ${esc(joint.label)} / ${esc(joint.name)}">ID ${joint.id} · ${esc(joint.label)} / ${esc(joint.name)}</strong><small>当前位置 ${angleText(stale?null:joint.position,angleUnit,true)} · ${fmt(stale?null:joint.voltage)} V · ${fmt(joint.current_ma,0)} mA · ${fmt(joint.temperature,0)} °C${historic?' · 历史值':''}</small>`);
  servoParameters.render(joint,state,manager.data.robots.find(r=>r.robot_id===state.robot_id),{recorded:!!replay||frozen||historic});
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
  // Commissioning owns its translations. Never walk its large hidden forms per frame.
  for(const id of ['robots','robot-subtitle','mode-banner','pose-label','imu-view-label','metrics','joint-select','schematic','joint-detail','axis-joint','events','record-status','packet-info','backend-mode'])localize($(id));

  if (replay) { $('seek').value=replayIndex; $('replay-time').textContent=`${(history[replayIndex].time-history[0].time).toFixed(1)} / ${(history.at(-1).time-history[0].time).toFixed(1)} s`; }
}
async function action(skill) {
  const button=document.querySelector(`[data-skill="${skill}"]`);
  if (!button || button.disabled) return;
  clearKeys();
  try {notifyControl('action',selected,{skill,action_id:crypto.randomUUID()});} catch(e){toast(e.message);}
}
$('skills').innerHTML=SKILLS.map(([skill,label],i)=>`<button data-skill="${skill}" disabled><kbd>${i+1}</kbd>${label}</button>`).join('');
document.querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>action(b.dataset.skill));
$('control-source-apply').onclick=async()=>{
  const id=selected,mode=$('control-source').value;
  if($('control-source-apply').disabled)return;
  sourceSwitching=true;renderControls();
  try {
    await release();
    const state=await request('control_source',id,{mode});
    const robot=robots.find(r=>r.robot_id===id);if(robot)robot.control_source=state;
    toast(mode==='bluetooth'?(state.input_ready?'蓝牙手柄已连接，输入就绪':state.bluetooth_connected?'蓝牙已连接，输入设备准备中':'已切到蓝牙模式，但手柄尚未连接；请确认蓝牙模式和电源后重试'):'已切换监控端控制，可连接电脑接收器后接管');
  } catch(error){toast(error.message);}
  finally{sourceSwitching=false;shownSource=null;renderControls();}
};
$('claim').onclick=async()=>{
  if (held) return release();
  const id=selected;
  try {await request('claim',id); held=id;inputPauses.delete(id);renderInputPause(); if(selected!==id || frozen || replay || document.hidden)await release(); renderControls();} catch(e){rememberPause('rejected',e.message,id);toast(e.message);}
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
    if(held===id && epoch===startEpoch){inputPauses.delete(id);renderInputPause();}
  } catch(e) {rememberPause('rejected',e.message,id);toast(e.message);await release();}
  finally {starting=false;renderControls();}
};
async function stopRobot(fromPad=false) {
  if (fromPad ? !canControl() : $('start').disabled) return;
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
  const customSkill=managedBindings.keyboard(key);if(customSkill){e.preventDefault();action(customSkill);return;}
  if (/^Digit[1-5]$/.test(key)) {action(SKILLS[Number(key.at(-1))-1][0]);return;}
  const button=document.querySelector(`[data-key="${key}"]`);
  if(button && !button.disabled){keys.add(key);button.classList.add('active');}
});
window.addEventListener('keyup',e=>{const key=aliases[e.code]||e.code;keys.delete(key);document.querySelector(`[data-key="${key}"]`)?.classList.remove('active');});
window.addEventListener('blur',()=>release('focus'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)release('focus');});
document.querySelectorAll('[data-key]').forEach(button=>{
  button.onpointerdown=e=>{if(button.disabled || $('input-source').value==='xbox')return;e.preventDefault();button.setPointerCapture(e.pointerId);keys.add(button.dataset.key);button.classList.add('active');};
  button.onpointerup=button.onpointercancel=button.onlostpointercapture=()=>{keys.delete(button.dataset.key);button.classList.remove('active');};
});
const padStatuses={disconnected:'未检测到手柄 · 按任意键连接',unsupported:'手柄布局不受支持',inactive:'手柄控制未激活',neutral:'请回中摇杆并松开按键',interrupted:'输入中断 · 请回中并重新接管',ready:'手柄已连接',configuration:'等待原生手柄配置或 agent 升级'};
function renderInputView() {
  const source=$('input-source').value;
  document.querySelectorAll('[data-input-view]').forEach(element=>element.hidden=element.dataset.inputView!==source);
  document.querySelector('.control-body').dataset.input=source;
}
$('input-source').onchange=()=>{release();xbox.reset();padFrame=null;renderInputView();};
renderInputView();
async function padCommand(commands,sampledAt) {
  if (commands.includes('relax')) {await stopRobot(true);return;}
  if (padCommandBusy) {toast('手柄操作尚未完成；本次按键未执行');return;}
  const profile=live()?.pad_profile,id=selected,epoch=startEpoch;
  if (!profile || !canControl()) return;
  if (held!==id && !commands.some(c=>['init','home','toggle'].includes(c))) return;
  padCommandBusy=true;
  try {
    if(held!==id){await request('claim',id);held=id;inputPauses.delete(id);renderInputPause();}
    if(epoch!==startEpoch || selected!==id || document.hidden || !document.hasFocus() || Date.now()-sampledAt>150){
      if(held===id)await release(document.hidden||!document.hasFocus()?'focus':'stale');return;
    }
    const payload={version:profile.version,sha256:profile.sha256,actions:commands};
    if(commands.some(c=>['init','home','toggle'].includes(c)))await request('pad_command',id,payload,sampledAt);
    else if(!notifyControl('pad_command',id,payload,sampledAt))return;
    if(commands.some(c=>['rest','shutdown'].includes(c))){held=null;xbox.reset();padFrame=null;}
  } catch(e){rememberPause('rejected',e.message,id);toast(e.message);if(held===id)await release();}
  finally {padCommandBusy=false;renderControls();}
}
function pollGamepad(now) {
  try {
    const active=$('input-source').value==='xbox' && canControl() && !document.hidden && document.hasFocus() && !document.querySelector('dialog[open]');
    const pads=navigator.getGamepads?.() || [];
    const pad=Array.from(pads).find(p=>p?.connected);
    padConnected=!!pad?.connected;
    // Raw input display is independent of focus; command gating above still requires it.
    gamepadView.update(pad,now,!document.hidden);
    const previousProfile=xbox.profile?.sha256;
    xbox.configure(live()?.pad_profile);
    if(previousProfile && previousProfile!==xbox.profile?.sha256 && $('input-source').value==='xbox' && held)void release();
    const previousKey=xbox.key;
    const result=xbox.poll(pad,now,`${selected}:${live()?.boot_id}`,active,live());
    result.sampledAt=Date.now();
    padFrame=result;padSampleAt=now;
    const velocity=result.velocity;
    const pause=inputPauses.get(selected);
    const status=(pause?`${english?(padConnected?'Controller connected':'Controller disconnected'):(padConnected?'手柄已连接':'手柄未连接')} · ${english?'Control paused':'控制已暂停'}: ${pauseLabel(pause)}${pause.detail?' · '+tr(pause.detail):''}`:tr(padStatuses[result.status]))+' · '+tr({drive:'行走',head:'头部',head_drive:'头部＋行走',body_pose:'机身姿态＋头部'}[result.mode])+(result.status==='configuration'&&live()?.pad_error?' · '+live().pad_error:'');
    if ($('gamepad-status').textContent!==status) $('gamepad-status').textContent=status;
    const values=`vx ${velocity.vx.toFixed(2)} · vy ${velocity.vy.toFixed(2)} m/s · yaw ${velocity.vyaw.toFixed(2)} rad/s`;
    if ($('gamepad-values').textContent!==values) $('gamepad-values').textContent=values;
    const customSkill=managedBindings.poll(pad,now,active&&ready()&&result.status==='ready',result.commands.length>0||result.fault);
    if(customSkill)void action(customSkill);
    if (result.fault) {release(result.status==='interrupted'?(previousKey!==xbox.key?'changed':'stall'):!padConnected?'disconnected':document.hidden||!document.hasFocus()?'focus':'unavailable');toast('手柄输入中断，已释放控制；请回中并重新接管');}
    else if (result.commands.length) void padCommand(result.commands,result.sampledAt);
  } catch(error) {gamepadView.update(null,now);if(held && $('input-source').value==='xbox')void release('input',error.message);xbox.reset();padFrame=null;}
  requestAnimationFrame(pollGamepad);
}
requestAnimationFrame(pollGamepad);
function renderTelemetry(now){
  requestAnimationFrame(renderTelemetry);
  if(!renderPending||document.hidden||now-lastUI<100)return;
  renderPending=false;lastUI=now;render();
}
requestAnimationFrame(renderTelemetry);
document.addEventListener('visibilitychange',()=>{if(document.hidden)gamepadView.update(null,performance.now(),false);});
let controlBusy=false, wasMoving=false, lastControlTick=performance.now();
setInterval(async()=>{
  const now=performance.now(), gap=now-lastControlTick;lastControlTick=now;
  // Check gaps before the busy/ownership gate: never renew cached input after a stalled frame.
  if (gap>150 && held) {wasMoving=false;await release('stall');return;}
  if(controlBusy || !ready())return;
  const usePad=$('input-source').value==='xbox';
  // A disconnect can arrive between animation frames; verify identity again at send time.
  const connectedPad=usePad?Array.from(navigator.getGamepads?.()||[]).find(p=>p?.connected):null;
  const samePad=connectedPad && xbox.key===JSON.stringify([connectedPad.index,connectedPad.id,`${selected}:${live()?.boot_id}`]);
  if(usePad && (!samePad || !padFrame || padFrame.status!=='ready' || now-padSampleAt>100 || document.hidden || !document.hasFocus())) {
    wasMoving=false;await release(!samePad?'disconnected':document.hidden||!document.hasFocus()?'focus':now-padSampleAt>100?'stale':'neutral');return;
  }
  controlBusy=true;
  const id=held;
  try {
    const r=live();
    const velocity=usePad?padFrame.velocity:{vx:(Number(keys.has('KeyW'))-Number(keys.has('KeyS')))*0.12,vy:0,vyaw:(Number(keys.has('KeyA'))-Number(keys.has('KeyD')))*0.4};
    const moving=Object.values(velocity).some(v=>v!==0);
    if(usePad && padFrame.frame && !padCommandBusy && !stopping) {
      const frame=structuredClone(padFrame.frame),profile=r.pad_profile;
      if(r.bringup!=='Ready' || !r.enabled || r.seated || r.action?.status==='running')frame.velocity={vx:0,vy:0,vyaw:0};
      notifyControl('pad_input',id,{...frame,version:profile.version,sha256:profile.sha256},padFrame.sampledAt);
    } else if (r.bringup==='Ready' && r.enabled && !r.seated && r.action?.status!=='running' && !padCommandBusy && !stopping && (moving||wasMoving))
      notifyControl('drive',id,velocity);
    else notifyControl('heartbeat',id);
    wasMoving=moving;
  } catch(e) {if(held===id)await release('rejected',e.message);toast(e.message);renderControls();}
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
const manager=new RobotManager({select:choose,current:()=>selected,notify:toast,release,telemetryState:live,switchMode});
const servoParameters=new ServoParameters($('parameters'),{
  refresh:async()=>{await manager.refresh();render(true);},
  readback:async()=>{
    if(!commissioning)await switchMode('commissioning');
    if(!commissioning)return;
    manager.stage=2;manager.management.selectTab('tests');manager.renderTests();
    document.querySelector('.servo-audit').scrollIntoView({block:'center',behavior:'smooth'});
  }
});
await manager.init();
connect();
