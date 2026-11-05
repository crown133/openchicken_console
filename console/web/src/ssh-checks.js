import { sshCredentials } from './ssh-credentials.js';
import { renderInitialization } from './initialization-view.js?v=20261103-first-boot';
import { english } from './i18n.js?v=20261101-commissioning';
const t=(zh,en)=>english?en:zh;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const checks=[['system','N01 · 连接与系统检查','N01 · Connect & inspect system'],['interfaces','N02 · 接口与权限检查','N02 · Inspect interfaces & permissions'],['audio','N04 · 音频枚举（不录放音）','N04 · Enumerate audio (no playback/recording)'],['services','N05 · 服务与 IPC 路径检查','N05 · Inspect services & IPC paths']];
export class SshChecks {
 constructor(element,{applyHostname}) {
  this.element=element;this.applyHostname=applyHostname;this.row=null;this.version=0;this.job=null;this.trusted=false;this.busy=false;this.jobs={};
  element.innerHTML=`<div class="panel-head"><h2>${t('SSH 实际检查','Execute SSH checks')}</h2><span id="ssh-status" class="badge">${t('未连接','Not connected')}</span></div><div class="ssh-controls"><p id="ssh-target" class="hint"></p><p class="hint">${t('先核对主机指纹，再输入密码并选择检查。密码在当前页面的检查、策略和蓝牙等栏目间复用，管理员账户单独记住；切换机器人、修改连接信息或刷新页面后清除，不写入磁盘。只读检查不改配置、不读写舵机、不启动或停止服务。','Verify the host fingerprint, enter the password once, then select checks. The password is shared across checks and management on this page; administrator credentials are remembered separately. Credentials are cleared when switching robots, changing connection details or reloading; it is not saved to disk. Checks are read-only: no configuration changes, actuator access or service changes.')}</p><div class="ssh-actions"><button id="ssh-scan" type="button">1 · ${t('读取主机指纹','Read host fingerprint')}</button><label>${t('SSH 密码（当前页面复用）','SSH password (reuse on this page)')}<input id="ssh-password" type="password" autocomplete="off" maxlength="1024"></label><button id="ssh-clear-passwords" type="button">${t('清除已记住的密码','Forget saved passwords')}</button></div><div id="ssh-fingerprints" hidden></div><div id="ssh-check-buttons">${checks.map(([key,zh,en])=>`<button type="button" data-ssh-check="${key}" disabled>${english?en:zh}</button>`).join('')}</div><p id="ssh-message" role="status"></p><section class="initialization-panel"><div class="ssh-actions"><h3>${t('首次装机初始化','First-boot initialization')}</h3><button type="button" data-ssh-check="initialization" disabled>${t('检查初始化缺项','Check setup requirements')}</button></div><div id="initialization-result"></div></section><div id="ssh-result" hidden><div class="ssh-actions"><strong id="ssh-job-title"></strong><button id="ssh-hostname" type="button" hidden>${t('将实测 hostname 写入档案','Use measured hostname in dossier')}</button><button id="ssh-export" type="button">${t('导出检查结果','Export check result')}</button></div><p id="ssh-job-target" class="hint"></p><pre id="ssh-log"></pre><p class="hint">${t('采集完成不代表硬件验收通过。可在下方记录现场结论；数据缺失或命令失败会原样保留。','Collection completion does not mean hardware acceptance. Record field conclusions below; missing data and failed subcommands remain visible.')}</p></div></div>`;
  const nodes=new Map([...element.querySelectorAll('[id]')].map(node=>[node.id,node]));this.$=id=>nodes.get(id);
  this.$('ssh-scan').onclick=()=>void this.scan();
  this.$('ssh-password').oninput=()=>{sshCredentials.set(this.row,this.row?.ssh_user,this.$('ssh-password').value);this.buttons();};
  this.$('ssh-clear-passwords').onclick=()=>sshCredentials.clear();
  sshCredentials.subscribe(()=>{this.$('ssh-password').value=sshCredentials.get(this.row);this.buttons();});
  element.querySelectorAll('[data-ssh-check]').forEach(b=>b.onclick=()=>void this.run(b.dataset.sshCheck));
  this.$('ssh-export').onclick=()=>{
   if(!this.job)return;
   const url=URL.createObjectURL(new Blob([JSON.stringify(this.job,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${this.job.robot_id}-${this.job.check}-${this.job.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  renderInitialization(this.$('initialization-result'));
  this.buttons();
  this.$('ssh-hostname').onclick=async()=>{
   const hostname=this.job?.result?.hostname;
   if(!hostname||!this.row||this.job.profile_id!==this.row.id||this.job.target.address!==this.row.address||this.job.target.port!==this.row.ssh_port||this.job.target.user!==this.row.ssh_user)return;
   try{if(!await this.applyHostname(this.row.id,hostname))return;this.$('ssh-message').textContent=t('实测 hostname 已保存','Measured hostname saved');}catch(e){this.error(e);}
  };
 }
 async api(path,body) {
  const response=await fetch('/api/commissioning/ssh/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  let data;try{data=await response.json();}catch{throw Error(t('SSH 检查服务尚未加载，需要重启此预览服务','SSH check routes are unavailable; restart this preview service'));}
  if(!response.ok)throw Error(data.error||t('SSH 请求失败','SSH request failed'));return data;
 }
 setProfile(row) {
  const key=row?JSON.stringify([row.id,row.address,row.ssh_port,row.ssh_user]):'';
  this.row=row;sshCredentials.select(row);
  if(this.profileKey===key)return;
  renderInitialization(this.$('initialization-result'));
  this.jobs={};this.profileKey=key;this.version++;clearTimeout(this.timer);this.job=null;this.trusted=false;this.busy=false;
  this.$('ssh-password').value=sshCredentials.get(row);this.$('ssh-fingerprints').hidden=true;this.$('ssh-result').hidden=true;this.$('ssh-message').textContent='';
  this.$('ssh-status').textContent=t('未连接','Not connected');
  this.$('ssh-target').textContent=row?`${row.robot_id} · ${row.ssh_user||'—'}@${row.address||'—'}:${row.ssh_port}`:t('先新机建档并选择该机器人，再填写实际 IP 和 SSH 用户。','Create and select a dossier with the actual IP and SSH user.');
  this.buttons();if(row?.address&&row?.ssh_user)void this.restore();
 }
 buttons() {
  const available=!!(this.row?.address&&this.row?.ssh_user);
  this.$('ssh-scan').disabled=!available||this.busy;
  [...this.element.querySelectorAll('[data-ssh-check]'),...this.$('initialization-result').parentElement.querySelectorAll('[data-ssh-check]')].forEach(b=>b.disabled=!available||!this.trusted||this.busy||!this.$('ssh-password').value);this.onUpdate?.();
 }
 error(e) {this.$('ssh-message').textContent=e.message;this.onUpdate?.();}
 remember(job){if(job?.profile_id!==this.row?.id||job.target?.address!==this.row.address||job.target?.port!==this.row.ssh_port||job.target?.user!==this.row.ssh_user)return;this.jobs[job.check]=job;this.onUpdate?.();}
 async restore() {
  const version=this.version;
  try{const status=await this.api('status/'+this.row.id);if(version!==this.version)return;this.trusted=status.trusted;this.busy=status.busy;this.$('ssh-status').textContent=this.trusted?t('指纹已确认 · 尚未登录','Fingerprint trusted · Not logged in'):t('需确认指纹','Verify fingerprint');this.buttons();if(status.latest_initialization){const job=await this.api('jobs/'+status.latest_initialization);if(version!==this.version)return;this.showInitialization(job);this.remember(job);}
   for(const id of Object.values(status.latest_stages||{})){const job=await this.api('jobs/'+id);if(version!==this.version)return;this.remember(job);}
   if(status.latest_job)await this.poll(status.latest_job,version);}
  catch(e){if(version===this.version)this.error(e);}
 }
 async scan() {
  const version=this.version,id=this.row.id;this.busy=true;this.buttons();this.$('ssh-message').textContent=t('正在读取 SSH 主机指纹…','Reading SSH host fingerprints…');
  try{
   const scan=await this.api('scan',{profile_id:id});if(version!==this.version)return;
   const box=this.$('ssh-fingerprints');box.hidden=false;
   box.innerHTML=`<p>${t('这是网络上读取到的公钥，尚未验证身份。请与机器人本机或可信记录中的主机指纹核对后确认。','These keys were read from the network and are not yet authenticated. Compare them with the robot console or a trusted record before confirming.')}</p><p class="hint">${t('机器人本机可读取：','On the robot console, inspect:')} <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code></p>${scan.keys.map(k=>`<p><strong>${escape(k.type)}</strong> <code>${escape(k.fingerprint)}</code></p>`).join('')}<label><input id="ssh-fingerprint-confirm" type="checkbox"> ${t('已核对显示的主机指纹','I have verified the displayed host fingerprints')}</label><button id="ssh-trust" type="button" disabled>${t('信任此主机','Trust this host')}</button>`;
   box.querySelector('#ssh-fingerprint-confirm').onchange=e=>box.querySelector('#ssh-trust').disabled=!e.target.checked;
   box.querySelector('#ssh-trust').onclick=async()=>{
    const button=box.querySelector('#ssh-trust');button.disabled=true;
    try{await this.api('trust',{profile_id:id,token:scan.token});if(version!==this.version)return;this.trusted=true;box.hidden=true;this.$('ssh-status').textContent=t('指纹已确认 · 尚未登录','Fingerprint trusted · Not logged in');this.$('ssh-message').textContent=t('输入密码，然后点击 N01 连接与系统检查。','Enter the password, then select N01 Connect & inspect system.');this.buttons();}catch(e){if(version===this.version){this.error(e);button.disabled=false;}}
   };
   this.$('ssh-message').textContent=t('请核对指纹；读取公钥不代表已经连接登录。','Verify the fingerprints; reading keys is not an authenticated login.');
  }catch(e){if(version===this.version)this.error(e);}
  finally{if(version===this.version){this.busy=false;this.buttons();}}
 }
 async run(check) {
  const version=this.version,password=this.$('ssh-password').value,id=this.row.id;
  this.busy=true;this.buttons();this.$('ssh-message').textContent=t('正在提交只读检查…','Submitting read-only check…');
  try{const job=await this.api('run',{profile_id:id,check,password});if(version===this.version)await this.poll(job.id,version);}
  catch(e){if(version===this.version){this.busy=false;this.buttons();this.error(e);}}
 }
 showInitialization(job) {
  if(job.check!=='initialization'||job.profile_id!==this.row?.id||job.target.address!==this.row.address||job.target.port!==this.row.ssh_port||job.target.user!==this.row.ssh_user)return;
  renderInitialization(this.$('initialization-result'),job);
 }
 async poll(id,version) {
  try{
   const job=await this.api('jobs/'+id);if(version!==this.version)return;
   this.showInitialization(job);this.remember(job);
   this.job=job;this.busy=['queued','running'].includes(job.status);this.buttons();
   const names={queued:t('排队中','Queued'),running:t('正在执行','Running'),completed:t('采集完成 · 非持续连接','Collected · No persistent session'),failed:t('检查失败','Check failed'),interrupted:t('执行中断 · 结果待核实','Interrupted · Completion unconfirmed')};
   this.$('ssh-status').textContent=names[job.status]||job.status;
   this.$('ssh-result').hidden=false;this.$('ssh-job-title').textContent=`${job.stage} / ${job.check} · ${names[job.status]||job.status}`;
   this.$('ssh-job-target').textContent=`${job.robot_id} · ${job.target.user}@${job.target.address}:${job.target.port} · ${job.finished_at||job.created_at}`;
   this.$('ssh-log').textContent=[...job.log,job.error||'',job.result?JSON.stringify(job.result,null,2):''].filter(Boolean).join('\n');
   const hostname=job.result?.hostname;
   this.$('ssh-hostname').hidden=!hostname||hostname.includes('[redacted]')||this.busy||job.target.address!==this.row.address||job.target.port!==this.row.ssh_port||job.target.user!==this.row.ssh_user;
   this.$('ssh-message').textContent=job.hostname_matches===false?t('实测 hostname 与档案不同，请核对设备身份后再回填。','Measured hostname differs from the dossier; verify identity before applying it.'):job.status==='completed'?t('实际结果已保存。请根据观察单独填写验收结论。','Actual results saved. Record acceptance separately based on observations.'):job.error||'';
   if(this.busy)this.timer=setTimeout(()=>void this.poll(id,version),700);
  }catch(e){if(version===this.version){this.error(e);this.timer=setTimeout(()=>void this.poll(id,version),2000);}}
 }
}
