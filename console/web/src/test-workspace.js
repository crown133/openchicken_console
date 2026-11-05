import { inventoryItems, summarize } from './initialization-view.js';
import { english } from './i18n.js?v=20261101-commissioning';
import { stages } from './commissioning-steps.js?v=20261101-early-zmq';
import { sshCredentials } from './ssh-credentials.js';
const t=(zh,en)=>english?en:zh;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pick=v=>v[english?1:0];
const labels={pending:t('待验证','Pending'),passed:t('通过','Passed'),failed:t('失败','Failed'),deferred:t('暂缓','Deferred'),not_applicable:t('不适用','Not applicable'),accepted:t('现场确认','Accepted on site')};
const hints={
 system:['读取实际 hostname、架构和内核，与档案核对。','Read hostname, architecture and kernel; compare with the dossier.'],
 deployment:['检查 current、五个程序、配置及监控桥接文件。','Inspect current, five binaries, configuration and bridge files.'],
 identity:['核对 robot_id、hostname、协议及密钥配置状态。','Compare robot ID, hostname, protocol and key configuration.'],
 interfaces:['检查 UART/I²C 别名、权限和当前占用者。','Inspect UART/I²C aliases, access and current owners.'],
 audio:['识别播放和录音设备；实际录放音另行验证。','Detect playback/capture devices; test their function separately.'],
 'openchicken-speaker-init':['检查音频初始化服务及已部署的替代服务。','Check audio initialization and existing alternatives.'],
 pin31:['检查既有供电反馈入口，状态见实时遥测。','Check the existing power feedback launcher; observe live telemetry.'],
 robotd:['检查安装、运行、自启状态；不会启动运控。','Inspect installation, runtime and boot state; does not start motion.'],
 tofd:['检查头部 IMU 服务是否安装并运行。','Inspect head IMU service installation and state.'],
 'openchicken-agent':['检查监控桥接服务，反馈有效性另行验证。','Inspect the monitor bridge; verify live data separately.'],
 configd:['检查 configd；缺失时可安装并启动。','Inspect configd; install and start it if missing.'],
 padd:['检查本机手柄服务；自动配置待接入。','Inspect the local controller service; automatic setup is pending.'],
 bluetooth:['检查系统蓝牙服务是否安装并运行。','Inspect the system Bluetooth service.'],
 adapter:['配对前将手柄置于 Sync 闪烁模式。','Before pairing, hold Sync until the controller flashes.'],
 sockets:['核对当前配置中的服务 socket 是否存在。','Check socket endpoints against the selected configuration.'],
 input:['检查输入设备权限及 padd 的实际账户。','Inspect input-device permissions and the padd account.'],
 pad_config:['读取本机/网络输入模式与映射配置。','Read local/network input mode and mapping configuration.'],
 runtime:['检查 Runtime 和模型文件，再查询原生策略。','Inspect Runtime/model files, then query native policies.']
};
const jobLabels={queued:t('等待执行','Queued'),running:t('执行中','Running'),completed:t('已完成','Completed'),failed:t('失败','Failed'),unknown:t('结果未确认','Result unknown'),interrupted:t('执行中断','Interrupted')};
function download(name,value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export class TestWorkspace {
 constructor(manager){
  this.manager=manager;this.ssh=manager.ssh;this.management=manager.management;this.stage='N01';this.row=null;
  const section=document.querySelector('.commissioning-panel');section.classList.add('phase-workspace');
  this.bar=document.createElement('div');this.bar.className='commissioning-connection-bar';
  this.bar.innerHTML=`<strong data-connection-target></strong><span data-connection-ssh></span><span data-connection-telemetry></span><button data-connections>${t('连接设置','Connection settings')}</button><button data-diagnostics>${t('诊断记录','Diagnostics')}</button>`;
  document.querySelector('.titlebar').before(this.bar);
  this.connection=this.dialog(t('连接设置','Connection settings'));
  this.diagnostics=this.dialog(t('诊断记录','Diagnostics'));
  this.bar.querySelector('[data-connections]').onclick=()=>this.connection.showModal();
  this.bar.querySelector('[data-diagnostics]').onclick=()=>this.diagnostics.showModal();
  this.connection.querySelector('[data-body]').append(this.ssh.element,manager.telemetry.element);
  this.ssh.element.querySelector('.panel-head h2').textContent='SSH';
  this.ssh.element.querySelector('.ssh-controls > p.hint:not([id])').textContent=t('首次连接核对指纹。同一账户的密码在本页面复用。','Verify the fingerprint on first connection. Credentials are reused on this page.');
  this.ssh.$('ssh-check-buttons').hidden=true;
  this.ssh.$('ssh-result').classList.add('diagnostic-evidence');
  this.diagnostics.querySelector('[data-body]').append(this.ssh.$('ssh-result'),this.ssh.element.querySelector('.initialization-panel'));
  const controls=manager.telemetry.element.querySelector('.ssh-controls');
  controls.querySelectorAll(':scope > p:not([id])').forEach(p=>p.remove());
  this.diagnostics.querySelector('[data-body]').append(manager.telemetry.$('telemetry-guide'));
  this.management.root.querySelector('.management-body').insertAdjacentHTML('afterbegin','<p class="phase-operation" role="status" data-management-summary></p>');
  this.management.jobPanel=this.management.root.querySelector('.management-job');this.diagnostics.querySelector('[data-body]').append(this.management.jobPanel);
  this.diagnostics.querySelector('[data-body]').insertAdjacentHTML('afterbegin',`<p>${t('原始结果仅用于诊断。日常操作请使用阶段检查项。','Raw evidence is available here for troubleshooting. Use the phase cards for routine operations.')}</p><button data-export-diagnostics>${t('导出当前机器人记录','Export robot records')}</button>`);
  this.diagnostics.querySelector('[data-export-diagnostics]').onclick=()=>download((this.row?.robot_id||'robot')+'-diagnostics.json',{robot:this.row,ssh:this.ssh.jobs,operation:this.management.lastOperation,joints:this.management.joints.data});
  // Service paths are shared across all tabs, so keep their form in connection settings.
  this.management.settingsForm=this.management.root.querySelector('[data-settings]');const paths=this.management.settingsForm.closest('details');this.connection.querySelector('[data-body]').append(paths);
  const edit=document.createElement('button');edit.textContent=t('编辑 IP 与账户','Edit IP & accounts');edit.onclick=()=>{this.connection.close();manager.edit(this.row);};this.connection.querySelector('[data-body]').prepend(edit);
  this.management.root.querySelector('[data-open-setup]').onclick=()=>{this.management.selectTab('tests');this.manager.stage=4;this.manager.renderTests();document.querySelector('.stage-heading').scrollIntoView({block:'start'});};
  this.management.onShowDiagnostics=()=>this.diagnostics.showModal();
  this.ssh.onUpdate=()=>this.update();this.management.onUpdate=()=>this.update();
  this.timer=setInterval(()=>this.live(),1000);
 }
 dialog(title){const dialog=document.createElement('dialog');dialog.className='workspace-dialog';dialog.innerHTML=`<div class="panel-head"><h2>${title}</h2><button data-close>${t('关闭','Close')}</button></div><div data-body></div>`;dialog.querySelector('[data-close]').onclick=()=>dialog.close();document.body.append(dialog);return dialog;}
 setStage(row,index){
  if(this.row?.id!==row?.id||this.row?.address!==row?.address||this.row?.ssh_user!==row?.ssh_user||this.row?.ssh_port!==row?.ssh_port){this.connection.close();this.diagnostics.close();this.recordDialog?.close();}
  this.row=row;this.index=index;this.stage=stages[index][0];this.render();
 }
 update(){if(!this.row)return;this.render();}
 evidence(id){
  const jobs=Object.values(this.ssh.jobs||{}).filter(j=>j.status==='completed').sort((a,b)=>String(b.finished_at).localeCompare(String(a.finished_at)));
  for(const job of jobs){const item=job.result?.sections?.find(v=>v.id===id);if(item)return {...item,at:job.finished_at};}
  return null;
 }
 action(label,action){return `<button data-action="${action}" ${!this.row||this.ssh.busy||this.management.working||this.management.data?.busy?'disabled':''}>${label}</button>`;}
 card(id,name,summary,buttons='',record=null){
  const saved=record!==null?this.row?.results?.[`${this.stage}.${record}`]:null;
  return `<article class="test-card" data-test-card="${id}"><div class="test-card-main"><h3>${esc(name)}</h3><span class="badge ${summary.tone||''}" data-card-status>${esc(summary.status)}</span><p data-card-detail>${esc(summary.text)}</p>${summary.at?`<small>${t('读取快照','Snapshot')} · ${esc(summary.at)}</small>`:''}${saved?.status&&saved.status!=='pending'?`<small>${t('人工记录','Operator record')}: ${labels[saved.status]}${saved.notes?' · '+esc(saved.notes):''}</small>`:''}</div><div class="test-card-actions">${buttons}${record!==null?`<button data-record="${record}" ${!this.row?'disabled':''}>${t('记录验证结果','Record result')}</button>`:''}</div></article>`;
 }
 render(){
  if(this.rendering)return;this.rendering=true;
  try{
   const guide=document.getElementById('test-guide');if(!guide)return;
   // Preserve the editable N03 form across unrelated status updates.
   const jointNode=this.management.joints.root;jointNode.remove();
   const stage=stages[this.index??0],check=this.stage==='N03'?'joint':this.index<6?'stage_'+this.stage:null;
   let html=`<div class="stage-heading"><div><h2>${this.stage} · ${esc(pick(stage[1]))}</h2></div>${check?this.action(this.stage==='N03'?t('读取并比较','Read & compare'):t('检查本阶段','Check this phase'),check):''}</div><p class="phase-operation" role="status" data-phase-operation></p><div class="test-card-list">`;
   const records={N01:{system:0,identity:2},N02:{interfaces:0},N04:{audio:0},N05:{robotd:0,sockets:1},N06:{runtime:0}};
   for(const item of inventoryItems.filter(v=>v[1]===this.stage)){
    const [id,,zh,en]=item,e=this.evidence(id);let summary={...summarize(e),at:e?.at},button=this.action(t('检查','Check'),'stage_'+this.stage);
    if(!e)summary.text=pick(hints[id]);
    if(id==='configd'){
     const entry=this.management.data?.policy_management?.configd_setup;
     if(entry&&this.row&&entry.target?.address===this.row.address&&entry.target?.user===this.row.ssh_user&&entry.target?.port===this.row.ssh_port&&Object.entries(this.management.data.settings).every(([key,value])=>entry.settings?.[key]===value)){summary={...summarize({id,evidence:{service:entry.result?.service}}),at:entry.queried_at};}
     button=this.action(t('检查','Check'),'configd_inspect')+this.action(t('安装并启动','Install & start'),'install-configd');
    }
    if(id==='adapter')button=this.action(t('查询手柄','Query controller'),'pad_status')+this.action(t('配对','Pair'),'pad_pair');
    if(id==='padd')summary.text=summary.status===t('未安装','Not installed')?t('自动配置待 deploy 端接入','Automatic setup requires deploy support'):summary.text;
    if(id==='runtime')button=this.action(t('检查文件','Check files'),'stage_N06')+this.action(t('查询策略','Query policies'),'refresh')+this.action(t('管理策略','Manage policies'),'tab:policies');
    html+=this.card(id,english?en:zh,summary,button,records[this.stage]?.[id]??null);
   }
   const manual=(id,zh,en,textZh,textEn,record,action='')=>this.card(id,t(zh,en),{status:t('待人工验证','Manual verification'),text:t(textZh,textEn)},action,record);
   if(this.stage==='N01')html+=manual('hardware','硬件与供电记录','Hardware & power record','记录主板、舵机和供电接法，对照本机装配信息。','Record board, servo and power wiring against this robot’s assembly.',1);
   if(this.stage==='N02')html+=manual('driver','驱动与音频接口','Drivers & audio interfaces','自动配置待接入；在 N04 检查音频设备。','Automatic setup pending; inspect audio devices in N04.',1)+manual('reboot','重启后复查','Check after reboot','维护时重启后重新检查接口，记录实际结果。','Recheck interfaces after a maintenance reboot and record the result.',2);
   if(this.stage==='N03')html+=`</div><p class="hint">${t('读取前确认无力矩、总线空闲。保存期望值只更新档案。','Read with torque off and the bus idle. Saving expectations updates the dossier only.')}</p><div data-joint-slot></div><div class="test-card-list">`;
   if(this.stage==='N04'){
    html+=this.card('imu-live',t('机身与头部 IMU','Body & head IMUs'),{status:t('等待反馈','Waiting for telemetry'),text:''},'',1);
    html+=this.card('power-live',t('电池电压与供电','Battery voltage & power'),{status:t('等待反馈','Waiting for telemetry'),text:''},'',2);
    html+=manual('audio-function','播放与录音测试','Playback & recording test','播放、录音按钮待板端测试接口接入；当前只检查设备枚举。','Playback/recording actions require a board-side test interface; current checks enumerate devices.',null);
    html+=manual('camera','相机','Camera','按实际安装情况记录；自动测试待接入。','Record installed hardware; automatic testing is pending.',null);
   }
   if(this.stage==='N05'){
    html+=this.card('telemetry-live',t('状态反馈','Telemetry'),{status:'',text:''},this.action(t('连接设置','Connection settings'),'connections'),2);
    html+=manual('recovery','断线与恢复','Disconnect & recovery','现场验证断线、恢复和数据过期显示。','Verify disconnection, recovery and stale-data display on site.',null);
    const pad=this.management.data?.policy_management?.direct_pad;if(pad&&this.row&&pad.target?.address===this.row.address&&pad.target?.user===this.row.ssh_user&&pad.target?.port===this.row.ssh_port&&pad.status==='known')html+=this.card('controller',t('蓝牙手柄','Bluetooth controller'),{status:pad.result?.pads?.some(p=>p.connected)?t('查询时已连接','Connected at query'):t('查询时未连接','Disconnected at query'),text:t('配对与动作分别验收','Pairing and physical actions are separate'),at:pad.queried_at},this.action(t('手柄管理','Manage controller'),'tab:pad'));
   }
   if(this.stage==='N06'){
    html+=manual('model-interface','模型接口','Model interface','核对输入、输出和训练约定；在策略管理中查看模型定义。','Verify model inputs, outputs and training contract in Policies & skills.',1,this.action(t('管理策略','Manage policies'),'tab:policies'));
    html+=manual('inference','离线推理与观测','Offline inference & observations','一键离线推理待 deploy 端接入，文件存在不代表推理通过。','One-click isolated inference requires deploy support; file presence is not inference success.',2);
    const query=this.management.data?.policy_management?.last_query;
    if(query&&this.row&&query.target?.address===this.row.address&&query.target?.user===this.row.ssh_user&&query.target?.port===this.row.ssh_port)html+=this.card('policy-result',t('策略查询结果','Policy query result'),{status:t('已读取','Read'),text:(query.result?.policies?.slots||[]).map(s=>`${s.slot}: ${s.error||t('已返回','reported')}`).join(' · '),at:query.queried_at});
   }
   if(this.index>=6)for(let i=0;i<3;i++)html+=manual('manual-'+i,stage[4][i][0][0],stage[4][i][0][1],stage[4][i][1][0],stage[4][i][1][1],i,this.index<9?this.action(t('打开运行监控','Open Monitor'),'monitor'):'');
   html+='</div>';guide.innerHTML=html;
   if(this.stage==='N03'){guide.querySelector('[data-joint-slot]').append(jointNode);jointNode.hidden=false;this.management.joints.setProfile(this.row,true);}else {jointNode.hidden=true;this.management.joints.visible=false;this.management.joints.setProfile(this.row,false);}
   guide.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>void this.act(b.dataset.action));
   guide.querySelectorAll('[data-record]').forEach(b=>b.onclick=()=>this.record(Number(b.dataset.record)));
   this.live();
  }finally{this.rendering=false;}
 }
 async act(action){
  try{
   this.message='';this.management.operationError='';
   if(action==='connections'){this.connection.showModal();return;}
   if(action==='monitor'){window.open(`${english?'/en/':'/'}?robot=${encodeURIComponent(this.row.robot_id)}`,'_blank','noopener');return;}
   if(action.startsWith('tab:')){this.management.selectTab(action.slice(4));return;}
   if(action.startsWith('stage_')){
    if(!this.ssh.trusted||!sshCredentials.get(this.row)){this.connection.showModal();this.ssh.$('ssh-message').textContent=t('先确认指纹并填写 SSH 密码，然后返回执行检查。','Verify the fingerprint and enter the SSH password, then run the check.');return;}
    await this.ssh.run(action);return;
   }
   if(action==='joint'){if(!this.management.joints.data?.confirmed||this.management.joints.dirty){this.message=t('先保存本机期望值','Save this robot’s expectations first');this.live();return;}await this.management.preview('joint_readback');return;}
   if(action==='install-configd'){await this.management.installConfigd();return;}
   await this.management.preview(action);
  }catch(e){this.message=e.message;this.live();}
 }
 live(){
  this.bar.querySelector('[data-connections]').disabled=!this.row;
  this.bar.querySelector('[data-connection-target]').textContent=this.row?`${this.row.robot_id} · ${this.row.address}`:t('未选择机器人','No robot selected');
  const job=this.ssh.job,valid=!!job&&!!this.row&&job.profile_id===this.row.id&&job.target?.address===this.row.address&&job.target?.port===this.row.ssh_port&&job.target?.user===this.row.ssh_user&&job.status==='completed';
  this.bar.querySelector('[data-connection-ssh]').textContent='SSH · '+(this.ssh.busy?t('检查中','Checking'):valid?t('上次登录成功','Last login succeeded'):this.ssh.trusted?t('指纹已确认','Fingerprint verified'):t('未验证','Not verified'));
  const state=this.manager.telemetryState?.(),live=!!state&&!!this.row&&state.robot_id===this.row.robot_id&&state.source==='robot'&&state.online===true;
  const telemetryText=live?t('在线','Online'):state?.source==='simulation'?t('模拟数据','Simulation'):t('未收到新鲜实机反馈','No fresh robot telemetry');
  this.bar.querySelector('[data-connection-telemetry]').textContent=t('遥测 · ','Telemetry · ')+telemetryText;
  const update=(id,status,text)=>{const card=document.querySelector(`[data-test-card="${id}"]`);if(card){card.querySelector('[data-card-status]').textContent=status;card.querySelector('[data-card-detail]').textContent=text;}};
  update('telemetry-live',telemetryText,t('与 3D、机器人状态和曲线共用连接','Shared with 3D, Robot Status and joint charts'));
  const imu=v=>v?.valid?t('有效','Valid'):t('未知','Unknown');
  update('imu-live',live?t('实机反馈','Robot feedback'):telemetryText,live?`${t('机身','Body')}: ${imu(state.imu)} · ${t('头部','Head')}: ${imu(state.head_imu)}`:'');
  const voltage=state?.system?.voltage,power=state?.system?.external_power;
  update('power-live',live?t('实机反馈','Robot feedback'):telemetryText,live?`${Number.isFinite(voltage)?voltage.toFixed(2)+' V':'—'} · ${power===true?t('供电已接入','Power connected'):power===false?t('供电未接入','Power disconnected'):t('供电未知','Power unknown')}`:'');
  const status=document.querySelector('[data-phase-operation]'),op=this.management.lastOperation;
  const phaseOp=op&&(op.operation==='joint_readback'?this.stage==='N03':op.operation==='refresh'?this.stage==='N06':op.operation?.startsWith('configd_')||op.operation?.startsWith('pad_')?this.stage==='N05':false);
  const active=phaseOp?op:job?.check==='stage_'+this.stage?job:null;
  const brief=error=>error?String(error).split('\n')[0].slice(0,140)+' · '+t('详情见诊断记录','See Diagnostics'):'';
  if(status)status.textContent=this.message||brief(this.management.operationError)||(active?`${jobLabels[active.status]||active.status}${active.error?' · '+brief(active.error):''}`:'');
  const managementSummary=document.querySelector('[data-management-summary]');if(managementSummary)managementSummary.textContent=this.management.operationError?brief(this.management.operationError):op?`${jobLabels[op.status]||op.status}${op.error?' · '+brief(op.error):''}`:'';
 }
 record(index){
  const stage=this.stage,row=this.row;if(!row)return;
  const step=`${stage}.${index}`,saved=row.results?.[step]||{status:'pending',notes:''};
  const dialog=this.dialog(t('记录验证结果','Record verification'));this.recordDialog=dialog;
  dialog.querySelector('[data-body]').innerHTML=`<form><p>${stage} · ${esc(pick(stages[this.index][4][index][0]))}</p><label>${t('结果','Result')}<select name="status">${Object.entries(labels).map(([key,value])=>`<option value="${key}" ${saved.status===key?'selected':''}>${value}</option>`).join('')}</select></label><label>${t('观察与备注','Observations & notes')}<textarea name="notes" maxlength="8000">${esc(saved.notes)}</textarea></label><p role="alert"></p><button class="primary">${t('保存','Save')}</button></form>`;
  dialog.onclose=()=>dialog.remove();dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await this.manager.refresh();if(this.row?.id!==row.id)throw Error(t('机器人已切换','Robot changed'));await this.manager.change({action:'result',revision:this.manager.data.revision,id:row.id,step,result:Object.fromEntries(new FormData(e.target))});dialog.close();this.manager.renderTests();}catch(error){dialog.querySelector('[role=alert]').textContent=error.message;}};dialog.showModal();
 }
}
