import { ServoAudit } from './servo-audit.js';
import { sshCredentials } from './ssh-credentials.js';
import { english } from './i18n.js?v=20261104-lt-pwm';
const t=(zh,en)=>english?en:zh;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=value=>JSON.stringify(value,null,2);
const labels={deploy_root:t('机器人部署目录','Robot deployment directory'),admin_user:t('安装与更新的管理员 SSH 用户','Administrator SSH user for setup and updates'),robotctl:'robotctl',robot_config:'robotd.toml',pad_config:t('padd 实际配置文件（单独核对）','Actual padd configuration file (verify separately)'),model_root:t('用户策略目录','User policy directory'),robot_socket:'robotd socket',config_socket:'configd socket'};
const title={joint_readback:t('N03 参数差异与回读','N03 Parameter diff & readback'),configd_inspect:t('检查 configd 安装与配置','Inspect configd setup'),configd_apply:t('应用 configd 配置并验证','Apply configd setup & verify'),pad_bind:t('应用原生手柄绑定','Apply native pad binding'),pad_reset_binding:t('恢复原生按键默认','Reset native pad button'),program_status:t('查询当前程序','Query installed program'),program_apply:t('部署所选版本','Deploy selected build'),program_rollback:t('恢复上一程序版本','Roll back program'),refresh:t('查询原生策略','Query native policies'),add_skill:t('新增 / 替换技能','Add / replace skill'),load_slot:t('替换策略槽位','Replace policy slot'),disable_slot:t('停用可选槽位','Disable optional slot'),reset_slot:t('槽位恢复出厂默认','Reset slot to shipped default'),remove_skill:t('移除技能定义','Remove skill definition'),restore:t('恢复历史策略版本','Restore archived policy'),pad_status:t('查询蓝牙手柄','Query Bluetooth controller'),pad_pair:t('配对蓝牙手柄','Pair Bluetooth controller'),pad_forget:t('解除配对','Forget controller')};
async function api(path,body){
 const options=body instanceof FormData?{method:'POST',body}:body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
 const response=await fetch(path,{...options,cache:'no-store'});const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data;
}
export class Management {
 constructor(anchor,{commissioning=false}={}){
  this.commissioning=commissioning;this.generation=0;
  sshCredentials.subscribe(()=>{const input=this.dialog?.querySelector('input[name=password]');if(input)input.value=sshCredentials.get(this.row,this.passwordUser);});
  this.root=document.createElement('section');this.root.className='panel management-panel';anchor.before(this.root);
  if(!commissioning){
   this.root.innerHTML=`<div class="panel-head"><h2>${t('机器人蓝牙手柄','Robot Bluetooth controller')}</h2><a href="${english?'/en':''}/commissioning/">${t('配置与配对','Configure & pair')}</a></div><p class="hint">${t('RT 右扳机：按至 30% 播放一次鸡叫，松开后再按可重播。需蓝牙手柄已连接且 padd 正在运行。','RT trigger: cross 30% to play one rooster crow; release and press again to replay. Requires a connected Bluetooth controller and running padd.')}</p><div class="management-body" data-pad></div>`;
   this.timer=setInterval(()=>{if(this.row&&!document.hidden)void this.refresh();},5000);return;
  }
  this.tests=anchor;
  const nav=document.createElement('nav');nav.className='management-tabs';anchor.before(nav);this.root.before(nav);
  nav.innerHTML=[['tests',t('新机测试','New robot tests')],['program',t('程序部署','Program deployment')],['policies',t('策略与技能','Policies & skills')],['pad',t('蓝牙手柄','Bluetooth controller')],['history',t('历史与验收','History & acceptance')]].map(([id,label])=>`<button data-tab="${id}">${label}</button>`).join('');
  nav.onclick=event=>{const tab=event.target.closest('[data-tab]');if(tab)this.selectTab(tab.dataset.tab);};this.nav=nav;
  this.root.innerHTML=`<div class="panel-head"><h2 data-heading></h2><span data-management-target></span></div><div class="management-body"><p data-error role="alert"></p>
  <div data-page="program"><details><summary>${t('机器人路径与账户','Robot paths & accounts')}</summary><p class="hint">${t('每台机器人只需在这里核对并保存一次，策略和蓝牙管理共用这些配置。默认值符合实际部署时无需修改；这里填写的是机器人端已有的路径与账户。','Review and save once per robot; policy and Bluetooth management share these settings. Keep the defaults if they match the deployment. These are existing paths and accounts on the robot.')}</p><form data-settings class="management-fields"></form></details><p>${t('选择本机 deploy 仓库归档的 Radxa 应用包。首次装机依赖与硬件初始化仍在新机测试中完成。','Select a Radxa application package archived by the local deploy repository. Initial dependencies and hardware setup remain in New robot tests.')}</p><form data-repository class="management-inline"><label>${t('监控主机上的 deploy 仓库','Deploy repository on the monitor host')}<input name="deploy_repository" placeholder="/home/cyz/openchicken/openchicken_deploy" required></label><button>${t('保存路径','Save path')}</button><button type="button" data-list>${t('刷新版本','Refresh builds')}</button></form><div data-builds></div><div data-installed></div><div class="management-actions"><button data-op="program_apply">${title.program_apply}</button><button data-op="program_status">${title.program_status}</button><button data-op="program_rollback">${title.program_rollback}</button></div><p class="hint">${t('更新前须停止运动并松力；脚本保留配置、标定、策略和依赖。不会自动使能。程序回退与策略历史恢复分别执行。','Stop and relax before updating. The script preserves configuration, calibration, policies and dependencies without enabling motion. Program rollback and policy restore are separate operations.')}</p></div>
  <div data-page="policies"><div class="management-actions"><button data-op="refresh">${title.refresh}</button></div><div data-native></div><details open><summary>${t('导入策略到当前机器人档案','Import a policy into this robot dossier')}</summary><form data-upload class="management-fields"><label>ONNX<input type="file" name="model" accept=".onnx" required></label><label>${t('JSON 清单（可选）','JSON manifest (optional)')}<input type="file" name="manifest" accept=".json"></label><label>${t('技能名称','Skill name')}<input name="name" placeholder="polite_bow" pattern="[a-z][a-z0-9_]*"></label><label>${t('用途','Purpose')}<select name="slot"><option value="">${t('普通技能','Generic skill')}</option>${['walk','stand','sitstand','ground_pick','kick_left','kick_right','roulade'].map(v=>`<option>${v}</option>`).join('')}</select></label><label>${t('模型类型','Model kind')}<select name="kind"><option>episodic</option><option>perpetual</option><option>scripted</option></select></label><label>${t('持续时间（秒）','Duration (seconds)')}<input name="duration" type="number" min="0.001" max="3600" step="any"></label><label class="wide">${t('JSON 参数（导入后可编辑，基本参数以上方表单为准）','JSON parameters (editable; fields above override basic values)')}<textarea name="manifest_json" rows="5"></textarea></label><button class="primary">${t('保存策略草稿','Save policy draft')}</button></form><p class="hint">${t('未选择 JSON 时生成原生 61 维观测清单；tracking 请上传 embedded ONNX 配套 JSON（history 10×48 + time_step，14 动作，50 Hz）。这里核对声明，不代表 ONNX 推理或动作已验收。导入后先预览，再上传应用。','Without JSON, the form generates a native 61D manifest. For tracking, upload the embedded ONNX sidecar JSON (history 10×48 + time_step, 14 actions, 50 Hz). This validates declarations, not ONNX inference or physical behavior. Import, review, then apply.')}</p></details><div data-versions></div><a data-monitor>${t('切换运行监控验收所选动作','Test selected action in Monitor')}</a><details><summary>${t('动作按键绑定','Action input bindings')}</summary><form data-bindings class="management-fields"><label>${t('键盘','Keyboard')}<select name="keyboard"><option value="">${t('无','None')}</option>${['Digit6','Digit7','Digit8','Digit9','Digit0'].map(key=>`<option>${key}</option>`).join('')}</select></label><label>${t('浏览器 Xbox 组合键','Browser Xbox chord')}<select name="gamepad"><option value="">${t('无','None')}</option><option value="RB">LB + RB</option><option value="X">LB + X</option><option value="Y">LB + Y</option></select></label><button name="mode" value="draft">${t('保存绑定草稿','Save binding draft')}</button><button name="mode" value="publish">${t('发布已验收版本的绑定','Publish verified version bindings')}</button></form><p class="hint">${t('统一的基础动作、停止和长按行为保留。发布要求该机器人配置已确认，且加载已确认或实物验收通过；已发布的额外绑定用于运行页；原生蓝牙手柄绑定单独预览和应用。','Unified core actions, stop and hold behavior are protected. Publication requires confirmed configuration and loading or physical acceptance for this robot. Published extra bindings are used by Monitor. Native Bluetooth bindings are reviewed and applied separately.')}</p><pre data-bindings-preview></pre><div class="management-inline"><label>${t('原生蓝牙手柄按键','Native Bluetooth button')}<select data-native-button>${['lb_a','lb_down','lb_left','lb_right','lb_up'].map(v=>`<option>${v}</option>`).join('')}</select></label><button data-op="pad_bind">${title.pad_bind}</button><button data-op="pad_reset_binding">${title.pad_reset_binding}</button></div><p class="hint">${t('仅在停止并松力后修改。预览会显示原绑定；写入后重新查询。','Changes require Limp. Review the previous binding; the result is queried after writing.')}</p></details><div class="management-inline"><label>${t('目标槽位','Target slot')}<select data-slot>${['walk','stand','sitstand','ground_pick','kick_left','kick_right','roulade'].map(v=>`<option>${v}</option>`).join('')}</select></label><button data-op="add_skill">${title.add_skill}</button><button data-op="load_slot">${title.load_slot}</button><button data-op="reset_slot">${title.reset_slot}</button><button data-op="disable_slot">${title.disable_slot}</button><button data-op="restore">${title.restore}</button></div><div class="management-inline"><label>${t('移除定义名称（模型与历史保留）','Definition to remove (model and history retained)')}<input data-remove placeholder="polite_bow"></label><button data-op="remove_skill">${title.remove_skill}</button></div></div>
  <div data-page="pad"><p class="hint">${t('RT 右扳机：按至 30% 播放一次鸡叫，松开后再按可重播。需蓝牙手柄已连接且 padd 正在运行。','RT trigger: cross 30% to play one rooster crow; release and press again to replay. Requires a connected Bluetooth controller and running padd.')}</p><p>${t('手柄直接连接 Radxa 的蓝牙，与插在监控电脑上的浏览器 Xbox 输入分开。需先具备 BlueZ、configd 授权、本机 padd 和输入设备权限，并设置 netpad.enabled=false。','This controller connects directly to Radxa Bluetooth, separately from the browser Xbox input on the monitor computer. Requires BlueZ, configd authorization, local padd, input permissions and netpad.enabled=false.')}</p><ol><li>${t('打开手柄，长按顶部 Sync，直到指示灯快速闪烁。','Power on the controller and hold Sync until its light flashes rapidly.')}</li><li>${t('点击配对，核对目标后输入 SSH 密码；普通扫描约 30 秒；北通兼容模式随后会定向查询并验证绑定。','Choose Pair, verify the target and enter the SSH password. Ordinary discovery takes about 30 seconds; BETOP mode also performs directed discovery and verifies bonding.')}</li><li>${t('分别核对配对、信任、连接与 padd 状态。实物动作仍需在运行页验收。','Check pairing, trust, connection and padd separately. Validate physical actions in Monitor.')}</li></ol><div data-pad></div><div class="management-inline"><label>${t('手柄 MAC（配对可留空）','Controller MAC (optional for pairing)')}<input data-mac placeholder="AA:BB:CC:DD:EE:FF"></label><label><input type="checkbox" data-betop-classic>${t('北通 Xbox 兼容（需填写 Xbox 模式 MAC）','BETOP Xbox compatibility (Xbox mode MAC required)')}</label><button data-op="pad_status">${title.pad_status}</button><button data-op="pad_pair">${title.pad_pair}</button><button data-op="pad_forget">${title.pad_forget}</button></div></div>
  <div data-page="history"><p>${t('配置落盘、模型加载、实物动作分别记录；版本导入或上传成功不会自动通过验收。','Configuration, model loading and physical acceptance are recorded separately. Import or upload never passes acceptance automatically.')}</p><form data-acceptance class="management-fields"><label>${t('策略版本','Policy version')}<select name="version_id" data-test-version></select></label><label>${t('实物验收','Physical acceptance')}<select name="status"><option value="passed">${t('通过','Passed')}</option><option value="failed">${t('失败','Failed')}</option><option value="skipped">${t('跳过','Skipped')}</option></select></label><label class="wide">${t('操作员、实际观察、证据或跳过原因','Operator, observations, evidence or reason for skipping')}<textarea name="notes" required maxlength="4000"></textarea></label><button>${t('保存人工验收','Save operator acceptance')}</button></form><div data-history></div></div>
  <section class="management-job"><h3>${t('操作进度与结果','Operation progress & result')}</h3><p data-job-status>${t('尚无操作','No operation yet')}</p><a data-log-download hidden>${t('下载完整命令日志','Download full command log')}</a><pre data-log></pre><details><summary>${t('原生结果与证据','Native result & evidence')}</summary><pre data-result></pre></details></section></div>`;
  this.root.onclick=event=>{const button=event.target.closest('[data-op]');if(button)void this.preview(button.dataset.op);};
  (this.settingsForm||this.root.querySelector('[data-settings]')).onsubmit=event=>{event.preventDefault();void this.run(async()=>{await api(this.url('configure'),Object.fromEntries(new FormData(event.target)));await this.refresh();});};
  for(const selector of ['[data-mac]','[data-betop-classic]'])this.root.querySelector(selector).addEventListener('change',()=>{
   if(this.row)try{localStorage.setItem(`openchicken.pad.${this.row.id}`,JSON.stringify({mac:this.root.querySelector('[data-mac]').value,betop_classic:this.root.querySelector('[data-betop-classic]').checked}));}catch{}
  });
  this.root.querySelector('[data-repository]').onsubmit=event=>{event.preventDefault();void this.run(()=>api('/api/management/settings',Object.fromEntries(new FormData(event.target))));};
  this.root.querySelector('[data-list]').onclick=()=>void this.run(()=>this.listBuilds());
  this.root.querySelector('[data-upload]').onsubmit=event=>{event.preventDefault();void this.run(()=>this.upload(event.target));};
  this.root.querySelector('[data-upload] [name=manifest]').onchange=event=>void this.run(()=>this.prefillManifest(event.target));
  this.root.querySelector('[data-bindings]').onsubmit=event=>{event.preventDefault();void this.run(async()=>{const form=new FormData(event.target),keyboard=form.get('keyboard'),button=form.get('gamepad');await api(this.url('bindings'),{version_id:this.root.querySelector('[data-version]').value,publish:event.submitter.value==='publish',bindings:{keyboard:keyboard?[{code:keyboard,event:'press'}]:[],browser_gamepad:button?[{mapping:'standard',buttons:['LB',button],event:'press'}]:[]}});await this.refresh();});};
  this.root.querySelector('[data-acceptance]').onsubmit=event=>{event.preventDefault();void this.run(async()=>{const body=Object.fromEntries(new FormData(event.target));body.deployment_id=this.data.versions.find(v=>v.id===body.version_id)?.deployment?.id;await api(this.url('tests'),body);await this.refresh();});};
  this.setup=document.createElement('section');this.setup.className='configd-setup';
  this.setup.innerHTML=`<h3>${t('Configd 服务配置','Configd setup')}</h3><p>${t('先检查服务并查看差异，再确认安装或启动。只处理 configd，不启用 padd 或运控；--allow-user 授予的原生配置权限不只蓝牙配对。路径与账户使用程序部署页的共享设置。','Inspect service state and review the diff before confirming installation or startup. Only configd is changed; padd and motion are not enabled. --allow-user grants native configuration rights beyond Bluetooth pairing. Paths and accounts use the shared Program deployment settings.')}</p><div class="management-actions"><button data-setup-op="configd_inspect">${title.configd_inspect}</button><button data-setup-op="configd_apply" disabled>${title.configd_apply}</button></div><div data-setup-state></div><p data-setup-error role="alert"></p><p data-setup-progress role="status"></p><pre data-setup-log></pre><details><summary>${t('执行结果与备份位置','Result & backup location')}</summary><pre data-setup-result></pre></details>`;
  this.tests.querySelector('.initialization-panel').prepend(this.setup);
  this.setup.onclick=event=>{const button=event.target.closest('[data-setup-op]');if(button)void this.preview(button.dataset.setupOp);};
  this.root.querySelector('[data-page="pad"]').insertAdjacentHTML('afterbegin',`<button data-open-setup>${t('打开新机测试中的 Configd 配置','Open Configd setup in New robot tests')}</button>`);
  this.root.querySelector('[data-open-setup]').onclick=()=>{this.selectTab('tests');this.setup.scrollIntoView({block:'center',behavior:'smooth'});};
  this.joints=new ServoAudit(this.tests,()=>this.preview('joint_readback'));
  this.selectTab('tests');
 }
 url(action){if(!this.row)throw Error(t('请先建档并选择机器人','Create and select a robot dossier first'));return `/api/robots/${this.row.id}/management${action?'/'+action:''}`;}
 async run(work){if(this.working)return;this.working=true;this.onUpdate?.();try{this.operationError='';this.root.querySelector('[data-error]').textContent='';if(this.setup)this.setup.querySelector('[data-setup-error]').textContent='';await work();}catch(error){this.root.querySelector('[data-error]').textContent=error.message;if(this.setup)this.setup.querySelector('[data-setup-error]').textContent=error.message;const note=this.joints?.root.querySelector('[data-servo-message]');if(note)note.textContent=error.message;this.operationError=error.message;this.onUpdate?.();}finally{this.working=false;this.onUpdate?.();}}
 selectTab(tab){this.tab=tab;this.tests.hidden=tab!=='tests';this.root.hidden=tab==='tests';this.nav.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));this.root.querySelectorAll('[data-page]').forEach(e=>e.hidden=e.dataset.page!==tab);this.root.querySelector('[data-heading]').textContent=this.nav.querySelector(`[data-tab="${tab}"]`).textContent;if(tab!=='tests')void this.run(()=>this.refresh());}
 setProfile(row){
  sshCredentials.select(row);this.joints?.setProfile(row);
  if(this.row?.id===row?.id&&this.row?.address===row?.address&&this.row?.ssh_user===row?.ssh_user&&this.row?.ssh_port===row?.ssh_port)return;
  this.row=row;if(this.setup){this.setup.querySelectorAll('[data-setup-state],[data-setup-error],[data-setup-progress],[data-setup-log],[data-setup-result]').forEach(e=>e.textContent='');this.setup.querySelectorAll('button').forEach(e=>e.disabled=true);}this.generation++;this.historyJob=false;this.data=null;this.lastOperation=null;this.jobId=null;clearTimeout(this.pollTimer);this.dialog?.close();this.dialog?.remove();this.dialog=null;
  if(this.commissioning){this.root.querySelector('[data-management-target]').textContent=row?`${row.robot_id} · ${row.address}`:t('请先选择机器人档案','Select a robot dossier');(this.settingsForm||this.root.querySelector('[data-settings]')).innerHTML='';(this.jobPanel||this.root).querySelector('[data-log]').textContent='';(this.jobPanel||this.root).querySelector('[data-result]').textContent='';(this.jobPanel||this.root).querySelector('[data-job-status]').textContent=t('尚无操作','No operation yet');this.root.querySelectorAll('[data-versions],[data-native],[data-history]').forEach(e=>e.textContent='');this.root.querySelectorAll('button').forEach(e=>e.disabled=!row);}
  if(this.commissioning){
   let saved={};try{saved=JSON.parse(localStorage.getItem(`openchicken.pad.${row?.id}`)||'{}');}catch{}
   this.root.querySelector('[data-mac]').value=saved.mac||'';
   this.root.querySelector('[data-betop-classic]').checked=saved.betop_classic===true;
  }
  void this.refresh();
 }
 async refresh(){
  if(!this.row){this.renderPad();return;}
  const generation=this.generation;
  try{
   const data=await api(this.url());if(generation!==this.generation)return;this.data=data;this.renderPad();
   if(!this.commissioning)return;
   const form=(this.settingsForm||this.root.querySelector('[data-settings]'));if(!form.children.length)form.innerHTML=Object.entries(data.settings).map(([key,value])=>`<label>${labels[key]||key}<input name="${key}" value="${esc(value)}" ${key==='pad_config'?'':'required'}></label>`).join('')+`<button>${t('保存路径与账户','Save paths & accounts')}</button>`;
   if(!this.loadedRepo){const host=await api('/api/management/settings');if(generation!==this.generation)return;this.root.querySelector('[name=deploy_repository]').value=host.deploy_repository;this.loadedRepo=true;}
   this.renderPolicies();this.renderProgram();this.renderHistory();this.renderSetup();this.onUpdate?.();
   this.root.querySelectorAll('[data-op]').forEach(b=>b.disabled=data.busy);
   if(!this.historyJob&&data.latest_job&&this.jobId!==data.latest_job){this.jobId=data.latest_job;void this.poll(data.latest_job,generation);}
  }catch(error){if(generation!==this.generation)return;if(this.commissioning){this.root.querySelector('[data-error]').textContent=error.message;if(this.setup)this.setup.querySelector('[data-setup-error]').textContent=error.message;}else this.root.querySelector('[data-pad]').textContent=t('状态未知 · 查询失败','Unknown · query failed');}
 }
 renderSetup(){
  if(!this.setup)return;
  const entry=this.data?.policy_management?.configd_setup;
  const matches=entry?.target?.address===this.row?.address&&entry?.target?.port===this.row?.ssh_port&&entry?.target?.user===this.row?.ssh_user&&Object.entries(this.data?.settings||{}).every(([key,value])=>entry.settings?.[key]===value);
  const result=matches?entry.result:null;
  this.setup.querySelector('[data-setup-op=configd_inspect]').disabled=!this.row||this.data?.busy;
  this.setup.querySelector('[data-setup-op=configd_apply]').disabled=!result?.can_apply||this.data?.busy;
  this.setup.querySelector('[data-setup-state]').innerHTML=result?`<p>${t('上次检查','Last check')} · ${esc(entry.queried_at)} · configd: <strong>${esc(result.service.LoadState)} / ${esc(result.service.ActiveState)}</strong> · ${esc(result.config_socket)}</p>${result.blockers?.length?`<p>${esc(result.blockers.join(' · '))}</p>`:''}<details><summary>${t('拟执行操作与服务文件差异','Proposed actions & service diff')}</summary><pre>${esc(result.actions.join('\n'))}\n\n${esc(result.diff||t('服务文件无差异','No unit-file changes'))}</pre></details>`:`<p>${t('尚无匹配当前目标与设置的检查结果。点击检查，仅查询，不安装。','No inspection matching this target and its settings. Inspect first; inspection makes no changes.')}</p>`;
 }
 renderPad(){
  const element=this.root.querySelector('[data-pad]');if(!element)return;
  const entry=this.data?.policy_management?.direct_pad;
  const targetMatches=entry?.target?.address===this.row?.address&&entry?.target?.port===this.row?.ssh_port&&entry?.target?.user===this.row?.ssh_user;
  if(!entry||entry.status!=='known'||!targetMatches){element.textContent=t('蓝牙连接状态未知，请在配置页查询。','Bluetooth state unknown. Query it in Commissioning.');return;}
  const result=entry.result;
  element.innerHTML=`<p class="hint">${t('上次 SSH 查询（非实时）','Last SSH observation (not live)')} · ${esc(entry.queried_at)}</p><p>padd: <strong>${esc(result.driver)}</strong></p>${result.pads.length?result.pads.map(p=>`<div class="management-pad"><strong>${esc(p.name||'Controller')}</strong> <code>${esc(p.mac)}</code> · ${p.paired?t('已持久绑定','Bonded'):t('未完成绑定','Not bonded')} · ${p.trusted?t('已信任','Trusted'):t('未信任','Not trusted')} · ${p.connected?t('当时已连接','Connected at query'):t('当时未连接','Disconnected at query')} · ${p.input_ready===true?t('输入设备就绪','Input device ready'):p.input_ready===false?t('输入设备未就绪','Input device not ready'):t('输入设备未检查','Input device not checked')}</div>`).join(''):`<p>${t('查询时没有配对手柄','No paired controller at query time')}</p>`}`;
 }
 async listBuilds(){const data=await api('/api/management/packages');this.builds=data.packages;this.root.querySelector('[data-builds]').innerHTML=data.packages.length?`<label>${t('部署版本','Build')}<select data-build>${data.packages.map(p=>`<option value="${esc(p.build_id)}">${esc(p.build_id)} · ${(p.size/1048576).toFixed(1)} MiB</option>`).join('')}</select></label><p class="hint">${t('详细包摘要、更新范围在执行前预览中展示。','Package digest and update scope appear in the execution preview.')}</p>`:`<p>${t('尚无部署包。先在 deploy 仓库终端执行构建打包。','No package available. Build and package in the deploy repository terminal first.')}</p>`;if(data.packages.length)this.root.querySelector('[data-builds]').insertAdjacentHTML('beforeend',`<details><summary>${t('构建版本详情','Build version details')}</summary><table><thead><tr>${['Build','Software / API','Git','Built at'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${data.packages.map(p=>`<tr><td>${esc(p.build_id)}</td><td>${esc(p.build_info.version)} / ${esc(p.build_info.api_version)}</td><td>${esc(p.build_info.revision||'—')} ${p.build_info.dirty?'dirty':''}</td><td>${esc(p.build_info.build_time)}</td></tr>`).join('')}</tbody></table></details>`);if(data.skipped?.length)this.root.querySelector('[data-builds]').insertAdjacentHTML('beforeend',`<details><summary>${t('未识别的部署包','Unrecognized packages')} (${data.skipped.length})</summary><pre>${esc(json(data.skipped))}</pre></details>`);}
 renderPolicies(){
  const data=this.data,versions=data.versions;
  const current=this.root.querySelector('[data-version]')?.value;
  this.root.querySelector('[data-versions]').innerHTML=`<label>${t('档案中的策略版本','Archived policy version')}<select data-version>${versions.map(v=>`<option value="${v.id}">${esc(v.params.name)} · ${esc(v.created_at)} · ${v.sha256.slice(0,12)}</option>`).join('')}</select></label><p class="hint">${t('配置 / 加载 / 实物验收','Config / load / physical acceptance')}</p><div>${versions.map(v=>`<p><code>${v.id.slice(0,8)}</code> ${esc(v.params.name)} · ${esc(v.config_result)} / ${esc(v.load_result)} / ${esc(v.motion_test)}</p>`).join('')}</div>`;
  if(versions.some(v=>v.id===current))this.root.querySelector('[data-version]').value=current;
  const testSelect=this.root.querySelector('[data-test-version]'),testValue=testSelect.value;testSelect.innerHTML=versions.filter(v=>v.deployment).map(v=>`<option value="${v.id}">${esc(v.params.name)} · ${v.id.slice(0,8)}</option>`).join('');if(versions.some(v=>v.id===testValue))testSelect.value=testValue;
  const showBindings=()=>{const version=versions.find(v=>v.id===this.root.querySelector('[data-version]').value),entry=version?.bindings_draft?.bindings||version?.params.bindings||{};const link=this.root.querySelector('[data-monitor]');link.hidden=!version?.deployment;link.href=`${english?'/en':''}/?robot=${encodeURIComponent(this.row.robot_id)}&skill=${encodeURIComponent(version?.params.name||'')}`;this.root.querySelector('[data-bindings] [name=keyboard]').value=entry.keyboard?.[0]?.code||'';this.root.querySelector('[data-bindings] [name=gamepad]').value=entry.browser_gamepad?.[0]?.buttons?.[1]||'';this.root.querySelector('[data-bindings-preview]').textContent=json({draft:entry,native:data.policy_management.native_bindings||null});};
  this.root.querySelector('[data-version]').onchange=showBindings;showBindings();
  const saved=data.policy_management.last_query;const query=saved?.target?.address===this.row.address&&saved?.target?.user===this.row.ssh_user&&saved?.target?.port===this.row.ssh_port?saved:null;
  this.root.querySelector('[data-native]').innerHTML=query?`<p class="hint">${t('原生查询快照','Native query snapshot')} · ${esc(query.queried_at)}</p><table><thead><tr><th>${t('槽位','Slot')}</th><th>${t('实际路径','Actual path')}</th><th>${t('错误','Error')}</th></tr></thead><tbody>${query.result.policies.slots.map(s=>`<tr><td>${esc(s.slot)}</td><td>${esc(s.path||'—')}</td><td>${esc(s.error||'—')}</td></tr>`).join('')}</tbody></table><details><summary>${t('技能定义与原生结果','Skill definitions & native result')}</summary><pre>${esc(json(query.result))}</pre></details>`:`<p>${t('尚未查询机器人实际策略','Robot policies have not been queried')}</p>`;
 }
 renderHistory(){
  const items=[...(this.data.policy_management.history||[]),...(this.data.program_deployment.history||[]),...(this.data.servo_history||[])].sort((a,b)=>String(b.created_at||b.at).localeCompare(String(a.created_at||a.at)));
  const mechanical={unchecked:t('未核对','Unchecked'),checked:t('已核对','Checked'),issue:t('有问题','Issue')};
  this.root.querySelector('[data-history]').innerHTML=items.map(item=>{
   const name=item.operation==='save_expectations'?t('N03 保存关节表','N03 Save joint table'):item.operation==='save_joint_notes'?t('N03 更新备注与机械核对','N03 Update notes & mechanical checks'):title[item.operation]||item.operation;
   const annotations=Object.entries(item.annotations||{}).filter(([,v])=>v.status!=='unchecked'||v.notes);
   const content=item.operation==='joint_readback'?`<div data-readback-result></div><button data-servo-job="${esc(item.id)}">${t('查看读数与差异','View readback & differences')}</button>`:item.operation==='save_expectations'||item.operation==='save_joint_notes'?`<p>${esc(item.notes||'')}</p>${annotations.length?`<table><thead><tr><th>${t('关节','Joint')}</th><th>${t('机械核对','Mechanical check')}</th><th>${t('备注','Notes')}</th></tr></thead><tbody>${annotations.map(([joint,v])=>`<tr><td>${esc(joint)}</td><td>${mechanical[v.status]||'—'}</td><td>${esc(v.notes)}</td></tr>`).join('')}</tbody></table>`:''}<details><summary>${t('保存的参数快照','Saved parameter snapshot')}</summary><pre>${esc(json(item.expected))}</pre></details>`:`<pre>${esc(json(item))}</pre>`;
   return `<details><summary>${esc(item.created_at||item.at)} · ${esc(name)} · ${esc(item.status||t('已保存','Saved'))}</summary>${content}${item.id?`<button data-job="${esc(item.id)}">${t('查看日志与证据','View logs & evidence')}</button>`:''}</details>`;
  }).join('');
  const previous=Object.entries(this.data.n03_records||{});
  if(previous.length)this.root.querySelector('[data-history]').insertAdjacentHTML('beforeend',`<details><summary>${t('以前的 N03 人工记录','Previous N03 operator records')}</summary>${previous.map(([key,value])=>`<p>${esc(key)} · ${esc(value.status)} · ${esc(value.notes||'')}</p>`).join('')}</details>`);
  this.root.querySelectorAll('[data-servo-job]').forEach(button=>button.onclick=()=>void this.showReadback(button));
  this.root.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{this.historyJob=true;this.jobId=b.dataset.job;void this.poll(this.jobId,this.generation);this.onShowDiagnostics?.();});
 }
 async showReadback(button){
  const generation=this.generation,element=button.parentElement.querySelector('[data-readback-result]');button.disabled=true;
  try{
   const job=await api('/api/management/jobs/'+button.dataset.servoJob);if(generation!==this.generation)return;
   const result=job.result,rows=result?.rows;
   if(!rows){element.textContent=job.error||t('本次没有读数','No readback for this attempt');return;}
   const statuses={match:t('一致','Match'),different:t('有差异','Different'),missing:t('未读到','Missing'),unsafe:t('力矩/报警','Torque / fault')};
   const values=v=>v?`${v.id} / ${v.direction} / ${v.homing_offset}`:'—';
   element.innerHTML=`<p>${esc(result.captured_at)} · ${esc(result.target?.address)} · ${t('方向 0=正向、1=反向；偏置单位 count','Direction 0=normal, 1=reversed; offset in counts')}</p><table><thead><tr><th>${t('关节','Joint')}</th><th>${t('期望 ID / 方向 / 偏置','Expected ID / direction / offset')}</th><th>${t('实测 ID / 方向 / 偏置','Read ID / direction / offset')}</th><th>${t('比较','Comparison')}</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.name)}</td><td>${esc(values(row.expected))}</td><td>${esc(values(row.actual))}</td><td>${statuses[row.status]||'—'}</td></tr>`).join('')}</tbody></table>`;
  }catch(error){element.textContent=error.message;}finally{button.disabled=false;}
 }
 renderProgram(){
  const section=this.data.program_deployment,entries=[section.last_query,section.last_change].filter(Boolean).sort((a,b)=>b.queried_at.localeCompare(a.queried_at)),entry=entries[0],result=entry?.target?.address===this.row.address&&entry?.target?.user===this.row.ssh_user&&entry?.target?.port===this.row.ssh_port?entry.result:null;
  this.root.querySelector('[data-installed]').innerHTML=result?`<p>${t('最近程序结果','Latest program result')}: <strong>${esc(result.build_id||'—')}</strong> · ${esc(result.status)} · ${esc(entry.queried_at)}</p><p>${t('遥测反馈','Telemetry')}: ${esc(section.telemetry?.status||'not_checked')}</p><details><summary>${t('版本与服务详情','Version & service details')}</summary><pre>${esc(json(result))}</pre></details>`:`<p>${t('尚未查询实际程序版本；验收策略前请先查询。','Query the installed program before accepting a policy.')}</p>`;
 }
 async prefillManifest(input){
  const form=input.form,file=input.files[0],generation=this.generation;
  if(!file){form.elements.manifest_json.value='';return;}
  if(file.size>131072)throw Error('Manifest must be under 128 KiB');
  const submit=form.querySelector('button');submit.disabled=true;
  try{
   const value=JSON.parse(await file.text());if(generation!==this.generation)return;
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected a JSON manifest object');
   value.unwind_s=0;value.command??={encoding:'constant'};value.command.idle=[0,0,0];value.openchicken??={};value.openchicken.execution??={};value.openchicken.execution.command=[0,0,0];
   form.elements.manifest_json.value=json(value);
   for(const [field,fieldValue] of Object.entries({name:value.name||'',kind:value.kind||'episodic',slot:value.slot||'',duration:value.duration_s??''}))form.elements[field].value=fieldValue;
  }catch(error){input.value='';form.elements.manifest_json.value='';throw error;}finally{submit.disabled=false;}
 }
 async upload(form){
  const values=new FormData(form),model=values.get('model'),source=values.get('manifest_json');
  const value=source.trim()?JSON.parse(source):{schema_version:2,model_api:1,file:'policy.onnx',obs_len:61,action_len:14,robot:{model:'microduck',servos:'xl330',control_hz:50},chain:false,entry_pose:'standing',command:{encoding:'constant',idle:[0,0,0]}};
  value.name=values.get('name');value.kind=values.get('kind');value.unwind_s=0;
  if(values.get('slot'))value.slot=values.get('slot');else delete value.slot;
  if(String(values.get('duration')).trim())value.duration_s=Number(values.get('duration'));else delete value.duration_s;
  value.command??={encoding:'constant'};value.command.idle=[0,0,0];value.openchicken??={};value.openchicken.execution??={};value.openchicken.execution.command=[0,0,0];
  const body=new FormData();body.append('model',model);if(values.get('manifest')?.size)body.append('original_manifest',values.get('manifest'));body.append('manifest',new Blob([json(value)],{type:'application/json'}),'manifest.json');await api(this.url('import'),body);await this.refresh();
 }
 async preview(operation){await this.run(()=>this.perform(operation));}
 async credentials(operation,user,preview,confirm){
  const saved=sshCredentials.get(this.row,user);
  if(saved&&!confirm)return saved;
  return new Promise(resolve=>{
   this.dialog?.close();this.dialog?.remove();const dialog=document.createElement('dialog');this.dialog=dialog;this.passwordUser=user;dialog.className='management-preview';
   const detail=preview.detail||{},specific=detail.package?.build_id||detail.version?.params?.name||detail.name||detail.slot||'';
   const facts=[[t('手柄 MAC','Controller MAC'),detail.mac],[t('配对方式','Pairing mode'),operation==='pad_pair'?(detail.betop_classic?t('北通 Xbox 兼容','BETOP Xbox compatibility'):t('标准流程','Standard')):null],[t('槽位','Slot'),detail.slot],[t('模型摘要','Model SHA256'),detail.version?.sha256],[t('部署包摘要','Package SHA256'),detail.package?.sha256],[t('部署目录','Deployment directory'),operation.startsWith('program_')?preview.context?.settings?.deploy_root:null]].filter(([,value])=>value);
   dialog.innerHTML=`<form><div class="panel-head"><h2>${esc(title[operation]||operation)}</h2><button type="button" data-close>${t('取消','Cancel')}</button></div><p>${esc(this.row.robot_id)} · ${esc(this.row.address)} · ${esc(user)}</p>${specific?`<p>${esc(specific)}</p>`:''}${facts.map(([label,value])=>`<p>${label}: ${esc(value)}</p>`).join('')}${operation==='joint_readback'?`<p>${t('确认机器人已支撑、无力矩且总线空闲。只读取参数，不停服务、不写舵机。','Confirm support, torque off and an idle bus. Reads parameters only; no service shutdown or servo writes.')}</p>`:''}${!saved?`<label>${t('SSH 密码（本页面复用）','SSH password (reused on this page)')}<input type="password" name="password" required autocomplete="off" maxlength="1024"></label>`:`<p>${t('使用本页面已保存的账户凭据','Using credentials already entered on this page')}</p>`}<button class="primary" type="submit">${confirm?t('确认执行','Confirm'):t('继续','Continue')}</button></form>`;
   let answer=null;dialog.onclose=()=>{dialog.remove();resolve(answer);};dialog.querySelector('[data-close]').onclick=()=>dialog.close();
   dialog.querySelector('form').onsubmit=e=>{e.preventDefault();answer=sshCredentials.get(this.row,user)||dialog.querySelector('[name=password]')?.value||null;dialog.close();};document.body.append(dialog);dialog.showModal();
  });
 }
 async perform(operation,{wait=false}={}){
  const generation=this.generation;
  const body={operation,betop_classic:operation==='pad_pair'&&Boolean(this.root.querySelector('[data-betop-classic]')?.checked),button:this.root.querySelector('[data-native-button]')?.value,version_id:this.root.querySelector('[data-version]')?.value,slot:this.root.querySelector('[data-slot]').value,name:this.root.querySelector('[data-remove]').value,mac:this.root.querySelector('[data-mac]').value,build_id:this.root.querySelector('[data-build]')?.value};
  const preview=await api(this.url('preview'),body);if(generation!==this.generation)return null;
  const user=operation.startsWith('program_')||['configd_apply','joint_readback'].includes(operation)?preview.context.settings.admin_user:this.row.ssh_user;
  const confirm=!['refresh','program_status','pad_status','pad_pair','pad_forget','configd_inspect','configd_apply'].includes(operation);
  const password=await this.credentials(operation,user,preview,confirm);if(!password||generation!==this.generation)return null;
  sshCredentials.set(this.row,user,password);
  const job=await api(this.url('run'),{token:preview.token,password});if(generation!==this.generation)return null;
  this.historyJob=false;this.jobId=job.id;this.lastOperation=job;this.onUpdate?.();
  if(!wait){await this.refresh();void this.poll(job.id,generation);return job;}
  let result=job;
  while(['queued','running'].includes(result.status)){
   await new Promise(resolve=>setTimeout(resolve,700));if(generation!==this.generation)return null;
   result=await api('/api/management/jobs/'+job.id);if(generation!==this.generation)return null;this.lastOperation=result;this.onUpdate?.();
  }
  await this.refresh();if(generation!==this.generation)return null;
  if(result.status!=='completed')throw Error(result.error||t('操作失败','Operation failed'));
  return result;
 }
 async installConfigd(){await this.run(async()=>{
  const generation=this.generation;
  const inspected=await this.perform('configd_inspect',{wait:true});if(!inspected||generation!==this.generation)return;
  if(!inspected.result?.can_apply)throw Error(inspected.result?.blockers?.join(' · ')||t('检查未通过','Inspection failed'));
  await this.perform('configd_apply',{wait:true});
 });}
 async poll(id,generation){
  clearTimeout(this.pollTimer);
  try{const job=await api('/api/management/jobs/'+id);if(generation!==this.generation||id!==this.jobId)return;
   this.lastOperation=job;this.onUpdate?.();
   if(job.operation==='joint_readback')await this.joints?.showJob(job);
   (this.jobPanel||this.root).querySelector('[data-job-status]').textContent=`${title[job.operation]||job.operation} · ${job.status}${job.error?' · '+job.error:''}`;
   if(this.setup&&job.operation.startsWith('configd_')){
    this.setup.querySelector('[data-setup-progress]').textContent=`${title[job.operation]} · ${job.status}${job.error?' · '+job.error:''}`;
    this.setup.querySelector('[data-setup-log]').textContent=(job.log||[]).join('\n');
    this.setup.querySelector('[data-setup-result]').textContent=json(job.result||{});
   }
   const download=(this.jobPanel||this.root).querySelector('[data-log-download]');download.hidden=!job.log_file;download.href='/api/management/jobs/'+id+'/log';(this.jobPanel||this.root).querySelector('[data-log]').textContent=(job.log||[]).join('\n');(this.jobPanel||this.root).querySelector('[data-result]').textContent=json({before:job.before,result:job.result,native_result:job.native_result,remote_path:job.remote_path,precondition:job.precondition});
   if(['queued','running'].includes(job.status))this.pollTimer=setTimeout(()=>void this.poll(id,generation),700);else await this.refresh();
  }catch(error){if(generation===this.generation)this.root.querySelector('[data-error]').textContent=error.message;}
 }
}
