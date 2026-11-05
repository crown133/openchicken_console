import { Management } from './management.js?v=20261104-betop-pair';
import { TestWorkspace } from './test-workspace.js';
import { CommissioningTelemetry } from './commissioning-telemetry.js?v=20261101-early-zmq';
import { SshChecks } from './ssh-checks.js?v=20261103-shared-ssh';
import { english } from './i18n.js?v=20261101-commissioning';
import { stages } from './commissioning-steps.js?v=20261101-early-zmq';
export let commissioning=location.pathname.endsWith('/commissioning/')||new URLSearchParams(location.search).get('mode')==='commissioning';
export function setWorkspaceMode(mode){commissioning=mode==='commissioning';document.documentElement.dataset.page=mode;}
const t=(zh,en)=>english?en:zh;
const pick=pair=>pair[english?1:0];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields=[['robot_id','robot_id','text'],['name',t('显示名称','Display name'),'text'],['hostname','hostname','text'],['address',t('IP / 主机地址','IP / host address'),'text'],['ssh_user',t('SSH 用户','SSH user'),'text'],['ssh_port',t('SSH 端口','SSH port'),'number'],['state_port',t('状态端口','State port'),'number'],['control_port',t('控制端口','Control port'),'number'],['robot_public_key',t('机器人 CURVE 公钥（可后补）','Robot CURVE public key (optional)'),'text']];
const hints={
 robot_id:t('自动建议未占用的编号，可修改；与正式机器人配置保持一致。','Suggested unused ID; editable. Match the deployed robot configuration.'),
 hostname:t('连接后执行 hostname，将实际输出填在这里；可先留空。','After connecting, run hostname and enter its output. May be left blank initially.'),
 address:t('填写路由器分配给新机器人的实际 IP；建议保留地址。','Enter the robot IP assigned by your router; a DHCP reservation is recommended.'),
 ssh_user:t('填写烧录或首次开机时创建的 Linux 登录用户，不一定等于 robot_id。','Enter the Linux account created during imaging or first boot; it may differ from robot_id.'),
 ssh_port:t('SSH 登录端口，默认 22。','SSH login port, default 22.'),
 state_port:t('正式监控状态端口，默认 5557；不是 SSH 端口。','Runtime telemetry port, default 5557; not the SSH port.'),
 control_port:t('正式运控端口，默认 5558；不是 SSH 端口。','Runtime command port, default 5558; not the SSH port.'),
 robot_public_key:t('用于后续 ZMQ 配对，SSH 登录不需要此公钥，可先留空。','Used later for ZMQ pairing, not SSH login. May be left blank initially.')
};
const sshCommand=values=>{
 const user=String(values.ssh_user||'').trim(),host=String(values.address||'').trim(),port=Number(values.ssh_port);
 if(!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)||!Number.isInteger(port)||port<1||port>65535)return '';
 return `ssh -p ${port} -l ${user} ${host}`;
};
const connectionGuide=(values,id)=>{
 const command=sshCommand(values);
 return `<div class="ssh-guide"><strong>${t('连接新机 · 网页检查或主机终端','Connect a new robot · Browser checks or host terminal')}</strong><ol><li>${t('机器人与监控主机接入可互通的网络，确认机器人已开启 SSH。','Connect the robot and monitor host to reachable networks; ensure SSH is enabled on the robot.')}</li><li>${t('填写实际 IP 和 SSH 用户，在监控主机终端运行下方命令。','Enter the actual IP and SSH user, then run the command below in a terminal on the monitor host.')}</li><li>${t('首次连接核对主机指纹；按提示使用密码或已配置的 SSH 密钥。登录后运行 hostname，回填实际名称。','Verify the host fingerprint on first connection; authenticate with your password or configured SSH key. Run hostname after login and enter the actual name above.')}</li></ol><div class="ssh-command"><code data-ssh-command>${esc(command)||t('填写实际 IP、SSH 用户和有效端口后生成命令','Enter the actual IP, SSH user and valid port to generate a command')}</code><button type="button" id="${id}" ${command?'':'disabled'}>${t('复制命令','Copy command')}</button></div><p class="hint">${t('保存档案后，在测试页上方的 SSH 实际检查中核对指纹、输入密码并执行 N01。也可复制此命令手动登录。5557/5558 与 CURVE 公钥用于后续正式监控。','After saving, verify the fingerprint, enter the password and run N01 in Execute SSH checks. You can also copy this command for manual login. Ports 5557/5558 and CURVE are for later runtime monitoring.')}</p></div>`;
};
export class RobotManager {
 constructor({select,current,notify,release,telemetryState,switchMode}) {
  this.switchMode=switchMode;this.telemetryState=telemetryState;this.select=select;this.current=current;this.notify=notify;this.release=release;this.data={revision:-1,robots:[],default_id:null};this.stage=0;this.item=0;this.dirty=false;
  const nav=document.createElement('nav');nav.className='page-navigation';nav.setAttribute('aria-label',t('工作页面','Workspace'));
  nav.innerHTML=`<div role="group" aria-label="${t('工作模式','Workspace mode')}"><button data-workspace="monitor">${t('运行监控','Monitor')}</button><button data-workspace="commissioning">${t('配置测试','Commissioning')}</button><span id="workspace-connection" class="badge" role="status"></span></div><div><span class="muted" id="registry-status"></span><button id="manage-robots">${t('机器人管理','Manage robots')}</button><button id="new-robot" class="primary">＋ ${t('新机建档','New robot')}</button></div>`;
  nav.querySelectorAll('[data-workspace]').forEach(button=>button.onclick=()=>void this.switchMode(button.dataset.workspace));
  document.querySelector('.titlebar').before(nav);
  document.body.insertAdjacentHTML('beforeend',`<dialog id="robot-manager"><div class="panel-head"><h2>${t('机器人档案','Robot dossiers')}</h2><button data-close>${t('关闭','Close')}</button></div><p class="hint">${t('档案在两个页面共享。SSH 只读检查在测试页执行；测试页可配置并连接早期只读 ZMQ；正式运控仍由启动配置管理。','Dossiers are shared between pages. Run read-only SSH checks from Commissioning; Commissioning supports early read-only ZMQ setup and connections; production runtime remains managed by startup configuration.')}</p><div id="dossier-list"></div><button id="manager-add">＋ ${t('新机建档','New robot')}</button></dialog>
  <dialog id="robot-editor"><form id="dossier-form"><div class="panel-head"><h2 id="dossier-title">${t('编辑机器人档案','Edit robot dossier')}</h2><button type="button" data-close>${t('关闭','Close')}</button></div><div class="dossier-fields">${fields.map(([key,label,type])=>`<label>${label}<input name="${key}" type="${type}" ${key==='robot_id'?'required pattern="[A-Za-z0-9_-]{1,64}"':''} ${type==='number'?'required min="1" max="65535" step="1"':'maxlength="200"'} autocomplete="off">${hints[key]?`<small>${esc(hints[key])}</small>`:''}</label>`).join('')}<label class="wide">${t('硬件、供电与装配备注','Hardware, power and assembly notes')}<textarea name="notes" maxlength="4000" rows="3"></textarea></label></div><p class="hint">${t('hostname 与 SSH 用户分别填写。不要在备注中保存密码或私钥。修改档案不会修改机器人端配置。','Enter hostname and SSH user separately. Do not store passwords or private keys in notes. Editing a dossier does not change robot-side configuration.')}</p><div id="dossier-connection-guide"></div><p id="dossier-error" role="alert"></p><div class="dialog-actions"><button type="submit" class="primary">${t('保存档案','Save dossier')}</button></div></form></dialog>`);
  document.querySelectorAll('#robot-manager [data-close],#robot-editor [data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  document.getElementById('manage-robots').onclick=()=>{void this.release();this.list();document.getElementById('robot-manager').showModal();};
  document.getElementById('new-robot').onclick=document.getElementById('manager-add').onclick=()=>this.edit();
  document.getElementById('dossier-form').onsubmit=event=>{event.preventDefault();void this.save(event.currentTarget);};
  document.getElementById('dossier-form').addEventListener('input',()=>this.updateConnectionGuide());
  this.setupTests();
 }
 confirmSelection(id) {
  return !commissioning||!(this.dirty||this.management?.joints?.dirty)||id===this.current()||confirm(t('切换机器人将放弃未保存的记录，继续？','Switch robots and discard the unsaved record?'));
 }
 async init() {
  await this.refresh();
  const query=new URLSearchParams(location.search).get('robot');
  const row=this.data.robots.find(r=>r.robot_id===query)||this.data.robots.find(r=>r.id===this.data.default_id);
  // Selection only: this never acquires control or starts a robot.
  if(row)await this.select(row.robot_id);
  this.management=new Management(document.querySelector('.commissioning-panel'),{commissioning:true});
  this.monitorManagement=new Management(document.querySelector('.control-panel'));
  this.management.root.classList.add('commissioning-only');
  this.monitorManagement.root.classList.add('monitor-only');
  this.workspace=new TestWorkspace(this);
  this.management.setProfile(this.data.robots.find(r=>r.robot_id===this.current()));
  this.applyMode();
  this.timer=setInterval(()=>{if(!document.hidden)void this.refresh();},2000);
 }
 applyMode(){
  const mode=commissioning?'commissioning':'monitor';
  setWorkspaceMode(mode);
  document.querySelectorAll('[data-workspace]').forEach(button=>{button.classList.toggle('active',button.dataset.workspace===mode);button.setAttribute('aria-pressed',String(button.dataset.workspace===mode));});
  document.querySelector('.titlebar .eyebrow').textContent=commissioning?t('新机配置 / 测试工作台','COMMISSIONING / TEST WORKSPACE'):t('机器人监控','ROBOT MONITOR');
  const row=this.data.robots.find(r=>r.robot_id===this.current());
  this.monitorManagement?.setProfile(row);
  if(commissioning)this.renderTests();
  const url=new URL(location.href);url.pathname=english?'/en/':'/';url.searchParams.set('mode',mode);
  url.searchParams.delete('robot');
  history.replaceState(null,'',url);
 }
 async refresh() {
  if(this.loading)return;
  this.loading=true;
  try {
   const response=await fetch('/api/robots',{cache:'no-store'});if(!response.ok)throw Error(t('档案服务不可用','Dossier service unavailable'));
   const data=await response.json();
   document.getElementById('registry-status').textContent=t('档案已同步','Dossiers synced');
   if(data.revision!==this.data.revision){this.data=data;this.management?.setProfile(data.robots.find(r=>r.robot_id===this.current()));this.list();if(commissioning&&!this.dirty)this.renderTests();}
  } catch(error){document.getElementById('registry-status').textContent=error.message;}
  finally{this.loading=false;}
 }
 async change(body) {
  const response=await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||t('保存失败','Save failed'));
  this.data=data;this.list();return data;
 }
 list() {
  const target=document.getElementById('dossier-list');
  target.innerHTML=this.data.robots.length?this.data.robots.map(r=>`<div class="dossier-row"><div><strong>${esc(r.name||r.robot_id)}</strong> <span class="badge">${r.id===this.data.default_id?t('默认','Default'):t('待配置','Draft')}</span><p class="hint">${esc(r.robot_id)} · ${esc(r.address||'—')} · ${esc(r.hostname||'—')}</p></div><div><button data-open="${r.id}">${t('选择','Select')}</button><button data-edit="${r.id}">${t('编辑','Edit')}</button><button data-default="${r.id}">${r.id===this.data.default_id?t('取消默认','Clear default'):t('设为默认','Set default')}</button><button data-delete="${r.id}">${t('删除','Delete')}</button></div></div>`).join(''):`<p class="hint">${t('尚无档案，点击新机建档。已有启动配置加载的连接仍由原配置管理。','No dossiers yet. Add a new robot. Connections loaded from startup configuration remain managed by that configuration.')}</p>`;
  target.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>this.edit(this.data.robots.find(r=>r.id===b.dataset.edit)));
  target.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{this.select(this.data.robots.find(r=>r.id===b.dataset.open).robot_id);document.getElementById('robot-manager').close();});
  target.querySelectorAll('[data-default]').forEach(b=>b.onclick=async()=>{try{await this.change({action:'default',revision:this.data.revision,id:b.dataset.default===this.data.default_id?null:b.dataset.default});}catch(e){this.notify(e.message);}});
  target.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{
   const row=this.data.robots.find(r=>r.id===b.dataset.delete),revision=this.data.revision;
   if(!confirm(t(`删除 ${row.robot_id} 的本地连接档案？历史验收记录保留，不删除机器人端内容。`,`Remove the local dossier for ${row.robot_id}? Historical records are retained; robot-side files are untouched.`)))return;
   try{await this.change({action:'delete',revision,id:row.id});if(commissioning)this.renderTests();}catch(e){this.notify(e.message);}
  });
 }
 edit(row) {
  void this.release();
  const form=document.getElementById('dossier-form');this.editId=row?.id;this.editRevision=this.data.revision;
  const used=new Set([...this.data.robots.map(r=>r.robot_id),...Array.from(document.querySelectorAll('[data-robot]'),e=>e.dataset.robot)]);
  let number=2;while(used.has(`openchicken${number}`))number++;
  form.reset();const values=row||{robot_id:`openchicken${number}`,name:`OpenChicken ${number}`,ssh_port:22,state_port:5557,control_port:5558};
  document.getElementById('dossier-title').textContent=row?t('编辑机器人档案','Edit robot dossier'):t('新机建档','New robot dossier');
  form.elements.address.placeholder=t('如 192.168.3.182（填写实际地址）','e.g. 192.168.3.182 — use the actual address');
  form.elements.ssh_user.placeholder=t('烧录时设置的登录用户','Login user configured during imaging');
  form.elements.hostname.placeholder=t('可先留空，SSH 连接后读取','Optional initially; read after SSH login');
  for(const [key] of fields)form.elements[key].value=values[key]??'';
  form.elements.notes.value=values.notes||'';document.getElementById('dossier-error').textContent='';
  this.updateConnectionGuide();
  document.getElementById('robot-editor').showModal();
 }
 bindCopy(id,command) {
  document.getElementById(id).onclick=async()=>{
   try{await navigator.clipboard.writeText(command);this.notify(t('SSH 命令已复制，请在监控主机终端运行','SSH command copied; run it in the monitor host terminal'));}
   catch{this.notify(t('复制失败，请手动选择并复制命令','Copy failed; select and copy the command manually'));}
  };
 }
 updateConnectionGuide() {
  const values=Object.fromEntries(new FormData(document.getElementById('dossier-form')));
  document.getElementById('dossier-connection-guide').innerHTML=connectionGuide(values,'copy-editor-ssh');
  this.bindCopy('copy-editor-ssh',sshCommand(values));
 }
 async save(form) {
  const button=form.querySelector('[type=submit]');button.disabled=true;
  try {
   const robot=Object.fromEntries(new FormData(form));for(const key of ['ssh_port','state_port','control_port'])robot[key]=Number(robot[key]);
   await this.change({action:'save',revision:this.editRevision,id:this.editId,robot});
   document.getElementById('robot-editor').close();document.getElementById('robot-manager').close();
   await this.select(robot.robot_id);this.notify(t('档案已保存；尚未建立新的机器人连接','Dossier saved; no new robot connection has been established'));
  }catch(e){document.getElementById('dossier-error').textContent=e.message;}
  finally{button.disabled=false;}
 }
 setupTests() {
  const section=document.createElement('section');section.className='panel commissioning-panel';
  section.innerHTML=`<div class="panel-head"><h2>${t('新机配置与测试','New robot commissioning')}</h2><span class="badge">${t('SSH 只读检查 + 人工验收','Read-only SSH checks + operator acceptance')}</span></div><div class="commissioning-grid"><nav id="test-stages" aria-label="${t('测试阶段','Test stages')}"></nav><div id="test-guide"></div></div>`;
  document.querySelector('.control-panel').before(section);
  const ssh=document.createElement('div');ssh.className='ssh-panel';section.querySelector('.commissioning-grid').before(ssh);
  this.ssh=new SshChecks(ssh,{applyHostname:async(id,hostname)=>{
   await this.refresh();const row=this.data.robots.find(r=>r.id===id);
   if(!row)throw Error(t('档案已删除','Dossier was removed'));
   if(row.hostname&&row.hostname!==hostname&&!confirm(t(`将 hostname 从 ${row.hostname} 改为实测的 ${hostname}？请确认是目标机器人。`,`Change hostname from ${row.hostname} to measured ${hostname}? Verify this is the intended robot.`)))return false;
   const robot=Object.fromEntries(fields.map(([key])=>[key,row[key]]));robot.notes=row.notes;robot.hostname=hostname;
   await this.change({action:'save',revision:this.data.revision,id,robot});this.renderTests();return true;
  }});
  const telemetry=document.createElement('div');telemetry.className='telemetry-panel';ssh.after(telemetry);this.telemetry=new CommissioningTelemetry(telemetry);
 }
 updateSelection(id) {
  this.management?.setProfile(this.data.robots.find(r=>r.robot_id===id));
  this.monitorManagement?.setProfile(this.data.robots.find(r=>r.robot_id===id));
  if(!commissioning||this.selected===id)return;
  this.selected=id;this.dirty=false;this.renderTests();
 }
 renderTests() {
  if(!commissioning)return;
  const row=this.data.robots.find(r=>r.robot_id===this.current());
  this.ssh.setProfile(row);this.telemetry.setProfile(row);
  document.getElementById('test-stages').innerHTML=stages.map((s,i)=>`<button class="${i===this.stage?'active':''}" data-stage="${i}" aria-current="${i===this.stage?'step':'false'}"><strong>${s[0]}</strong> ${esc(pick(s[1]))}</button>`).join('');
  document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{
   this.stage=Number(b.dataset.stage);this.item=0;this.renderTests();
  });
  this.workspace?.setStage(row,this.stage);
 }
}
