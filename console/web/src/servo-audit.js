import { english } from './i18n.js?v=20261104-lt-pwm';
const t=(zh,en)=>english?en:zh;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status={match:t('一致','Match'),different:t('有差异','Different'),missing:t('未读到','Missing'),unsafe:t('力矩/报警待处理','Torque / fault')};
export class ServoAudit {
 constructor(anchor,preview){
  this.root=document.createElement('section');this.root.className='servo-audit';this.root.hidden=true;
  anchor.querySelector('.commissioning-grid').before(this.root);this.preview=preview;this.generation=0;
 }
 setProfile(row,visible=this.visible){
  this.visible=visible;this.root.hidden=!visible;
  const key=JSON.stringify([row?.id,row?.address,row?.ssh_port,row?.ssh_user]);
  if(key!==this.key){this.key=key;this.row=row;this.data=null;this.dirty=false;this.generation++;this.root.textContent='';}
  if(visible&&!this.dirty)void this.refresh();
 }
 async api(body){
  const response=await fetch(`/api/robots/${this.row.id}/management/joints`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const data=await response.json();if(!response.ok)throw Error(data.error);return data;
 }
 async refresh(){
  if(!this.row){this.root.textContent=t('先选择机器人档案','Select a robot dossier first');return;}
  const generation=this.generation;
  try{const data=await this.api();if(generation!==this.generation||this.dirty||this.data&&data.revision<this.data.revision)return;this.data=data;this.render();}
  catch(e){if(generation===this.generation)this.root.textContent=e.message;}
 }
 render(){
  const data=this.data,last=data.latest;
  const sameTarget=last?.target?.address===this.row.address&&last?.target?.port===this.row.ssh_port&&last?.target?.user===this.row.ssh_user;
  const current=sameTarget&&last.revision===data.revision;
  const direction=v=>v===0?t('正向','Normal'):v===1?t('反向','Reversed'):'—';
  this.root.innerHTML=`<h3>N03 · ${t('14 关节参数差异与回读','14-joint parameter diff & readback')}</h3><p>${t('编辑并保存本机期望值，再执行一次只读审计。方向是 Drive Mode bit 0；Homing Offset 单位为 count。默认偏置仅为样机装配参考，必须核对本机机械基准。保存不写舵机、不修改 URDF。','Review and save per-robot expectations, then run one read-only audit. Direction is Drive Mode bit 0; Homing Offset is in counts. Default offsets are assembly references only. Saving does not write servos or change the URDF.')}</p><p>${t('固定支撑并确认无力矩，手动退出总线所有者后再读；运行中会拒绝，不自动停止服务。仅扫描 ID10–14、20–24、30–33，1 Mbps。','Secure/support the robot and confirm torque off. Stop bus owners manually before reading; active services cause refusal, never automatic shutdown. Fixed scan: IDs 10–14, 20–24, 30–33 at 1 Mbps.')}</p><form><div class="servo-table-scroll"><table><thead><tr><th>${t('关节','Joint')}</th><th>${t('期望 ID','Expected ID')}</th><th>${t('期望方向','Expected direction')}</th><th>${t('期望偏置','Expected offset')}</th><th>${t('实测 ID / 方向 / 偏置','Read ID / direction / offset')}</th><th>${t('比较','Comparison')}</th><th>${t('机械核对（可选）','Mechanical check (optional)')}</th><th>${t('备注（可选）','Notes (optional)')}</th></tr></thead><tbody>${data.expected.map((j,i)=>{
   const actual=sameTarget?last.rows.find(r=>r.name===j.name):null,annotation=data.annotations?.[j.name]||{status:'unchecked',notes:''};
   return `<tr data-joint="${esc(j.name)}"><td>${esc(j.name)}</td><td><input name="id-${i}" aria-label="${esc(j.name)} ID" type="number" min="0" max="252" required value="${j.id}"></td><td><select name="direction-${i}" aria-label="${esc(j.name)} direction"><option value="0" ${j.direction===0?'selected':''}>${direction(0)}</option><option value="1" ${j.direction===1?'selected':''}>${direction(1)}</option></select></td><td><input name="offset-${i}" aria-label="${esc(j.name)} offset" type="number" min="-2147483648" max="2147483647" required value="${j.homing_offset}"></td><td>${actual?.actual?`${actual.actual.id} / ${direction(actual.actual.direction)} / ${actual.actual.homing_offset}`:'—'}</td><td data-diff>${current?status[actual?.status]||'—':t('待检查','Not checked')}</td><td><select name="mechanical-${i}" aria-label="${esc(j.name)} mechanical check">${[['unchecked',t('未核对','Unchecked')],['checked',t('已核对','Checked')],['issue',t('有问题','Issue')]].map(([key,label])=>`<option value="${key}" ${annotation.status===key?'selected':''}>${label}</option>`).join('')}</select></td><td><input class="joint-note" name="joint-note-${i}" aria-label="${esc(j.name)} notes" maxlength="1000" value="${esc(annotation.notes)}"></td></tr>`;
  }).join('')}</tbody></table></div><label>${t('机器人端现有审计脚本','Existing audit script on robot')}<input name="script" required value="${esc(data.script)}"></label><label>${t('整体备注（可选）','General notes (optional)')}<input name="notes" value="${esc(data.notes||'')}" maxlength="2000" placeholder="${t('例如：已按本机装配记录核对方向和膝关节偏置','e.g. Verified direction and knee offsets against this robot’s assembly record')}"></label><div class="management-actions"><button type="submit">${t('保存表格','Save table')}</button><button type="button" data-read ${!data.confirmed?'disabled':''}>${t('一键检查 · 参数差异与回读','Check · Parameter diff & readback')}</button><button type="button" data-reload>${t('重新加载已保存值','Reload saved values')}</button><button type="button" data-export ${!last?'disabled':''}>${t('导出读数与差异','Export readback & diff')}</button></div></form><p data-servo-message role="status">${data.confirmed?t('已保存本机期望值','Per-robot expectations saved'):t('默认参考值尚未确认','Reference defaults not yet confirmed')}${last?` · ${esc(last.captured_at)} · ${current?t('上次读取快照（非实时）','Last read snapshot (not live)'):t('旧记录，当前目标/期望值需重新检查','Older record; check current target/expectations again')}`:''}</p><p data-servo-progress role="status">${esc(data.job?`${data.job.status}${data.job.error?' · '+data.job.error:''}`:'')}</p><pre data-servo-log>${esc((data.job?.log||[]).join('\n'))}</pre><details><summary>${t('完整寄存器、差异与证据','Full registers, differences & evidence')}</summary><pre>${esc(last?JSON.stringify(last,null,2):t('暂无读数；不使用模拟值代替实测','No readback; simulated values are not substituted'))}</pre></details><p class="hint">${t('一致仅代表该次参数比较；机械正方向、零位及写后验收仍需人工确认，不自动通过 N03。','Match means this parameter comparison only. Mechanical direction, zero position and post-write acceptance still require operator confirmation; N03 is never auto-accepted.')}</p>`;
  const form=this.root.querySelector('form'),message=this.root.querySelector('[data-servo-message]');
  if(data.busy)form.querySelectorAll('input,select,button').forEach(e=>e.disabled=true);
  form.oninput=event=>{
   this.dirty=true;this.root.querySelector('[data-read]').disabled=true;
   if(/^(id|direction|offset)-/.test(event.target.name)){
    const row=event.target.closest('tr');row.querySelector('[data-diff]').textContent=t('期望值未保存','Unsaved expectations');row.querySelector('[name^=mechanical-]').value='unchecked';
   }
  };
  form.onsubmit=async event=>{
   event.preventDefault();const generation=this.generation,values=new FormData(form);
   const body={revision:data.revision,script:values.get('script'),notes:values.get('notes'),annotations:Object.fromEntries(data.expected.map((j,i)=>[j.name,{status:values.get(`mechanical-${i}`),notes:values.get(`joint-note-${i}`)}])),expected:data.expected.map((j,i)=>({name:j.name,id:Number(values.get(`id-${i}`)),direction:Number(values.get(`direction-${i}`)),homing_offset:Number(values.get(`offset-${i}`))}))};
   try{const result=await this.api(body);if(generation!==this.generation)return;this.dirty=false;this.data=result;this.render();}catch(e){if(generation===this.generation)message.textContent=e.message;}
  };
  this.root.querySelector('[data-read]').onclick=()=>this.preview();
  this.root.querySelector('[data-reload]').onclick=()=>{if(this.dirty&&!confirm(t('放弃未保存的修改？','Discard unsaved expectations?')))return;this.dirty=false;void this.refresh();};
  this.root.querySelector('[data-export]').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(last,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${this.row.robot_id}-N03-${last.job_id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 }
 async showJob(job){
  const generation=this.generation;
  if(job.profile_id!==this.row?.id||!this.root.querySelector('[data-servo-progress]'))return;
  if(!['queued','running'].includes(job.status)&&!this.dirty)await this.refresh();
  if(generation!==this.generation||!this.root.querySelector('[data-servo-progress]'))return;
  this.root.querySelector('[data-servo-progress]').textContent=`${job.status}${job.error?' · '+job.error:''}`;
  this.root.querySelector('[data-servo-log]').textContent=(job.log||[]).join('\n');
 }
}
