import { english } from './i18n.js?v=20261104-lt-pwm';
const t=(zh,en)=>english?en:zh;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields=[['p','position_p_gain','P'],['i','position_i_gain','I'],['d','position_d_gain','D'],['pwm_slope','pwm_slope','PWM slope'],['pwm_limit','pwm_limit','PWM limit'],['homing_offset','homing_offset','Homing offset (count)'],['drive_mode','drive_mode','Drive mode']];
const numeric=value=>typeof value==='number'&&Number.isFinite(value);

export function parameterValues(joint,state,profile,{recorded=false}={}){
 const last=profile?.servo_audit?.latest;
 const matching=!recorded&&profile?.robot_id===state.robot_id&&last?.source==='ssh_readback'&&last.captured_at&&
  last.target?.address===profile.address&&last.target?.port===profile.ssh_port&&last.target?.user===profile.ssh_user;
 const row=matching?last.rows?.find(row=>row.name===joint.name&&row.expected?.id===joint.id&&row.fields?.id_register===joint.id):null;
 const snapshot=row?.fields||{};
 const live=state.online!==false||recorded;
 const values=fields.map(([key,register,label])=>({key,label,value:live&&numeric(joint[key])?joint[key]:numeric(snapshot[register])?snapshot[register]:null,
  source:live&&numeric(joint[key])?(recorded?'recorded':'live'):numeric(snapshot[register])?'n03':'missing'}));
 // Torque and faults are transient: an old audit cannot describe their current state.
 values.push({key:'torque',label:t('力矩','Torque'),value:live&&typeof joint.torque==='boolean'?joint.torque:null,source:live&&typeof joint.torque==='boolean'?(recorded?'recorded':'live'):'missing'},
  {key:'error',label:t('硬件错误','Hardware error'),value:live&&numeric(joint.error)?joint.error:null,source:live&&numeric(joint.error)?(recorded?'recorded':'live'):'missing'});
 return {values,capturedAt:values.some(v=>v.source==='n03')?last.captured_at:null};
}

export class ServoParameters {
 constructor(element,{refresh,readback}){
  this.element=element;this.signature='';
  this.tools=document.createElement('div');this.tools.className='servo-parameter-tools';
  this.tools.innerHTML=`<span data-parameter-source role="status"></span><button data-refresh-parameters>${t('加载回读记录','Reload saved readback')}</button><button data-open-readback>${t('N03 参数回读','N03 readback')}</button>`;
  element.before(this.tools);
  this.tools.querySelector('[data-refresh-parameters]').onclick=async()=>{const b=this.tools.querySelector('[data-refresh-parameters]');b.disabled=true;try{await refresh();}finally{b.disabled=false;}};
  this.tools.querySelector('[data-open-readback]').onclick=()=>void readback();
 }
 render(joint,state,profile,options){
  const result=parameterValues(joint,state,profile,options),signature=JSON.stringify([joint.id,result,!!profile]);
  if(signature===this.signature)return;this.signature=signature;
  this.tools.querySelectorAll('button').forEach(b=>b.disabled=!profile);
  const note=this.tools.querySelector('[data-parameter-source]');
  note.textContent=result.capturedAt?t(`N03 实测快照 · ${result.capturedAt} · 非实时`,`N03 measured snapshot · ${result.capturedAt} · Not live`):result.values.slice(0,7).some(v=>v.source!=='missing')?t('参数来自当前显示的数据帧','Parameters from the displayed data frame'):t('运行反馈未提供参数，尚无本机该关节的实测回读；请在 N03 读取。','Runtime parameters unavailable; no matching measured readback. Read in N03.');
  const direction=result.values.find(v=>v.key==='drive_mode');
  if(direction.value!==null)result.values.splice(7,0,{key:'direction',label:t('寄存器方向','Register direction'),value:direction.value&1?t('反向','Reversed'):t('正向','Normal'),source:direction.source});
  this.element.innerHTML=result.values.map(v=>{
   const value=v.value===null?'—':v.key==='torque'?(v.value?t('开启','On'):t('关闭','Off')):v.key==='error'?`0x${v.value.toString(16).padStart(2,'0')}`:v.value;
   const source={n03:t('N03 快照','N03 snapshot'),live:t('实时反馈','Live feedback'),recorded:t('记录值','Recorded'),missing:t('未提供','Unavailable')}[v.source];
   return `<div data-parameter="${v.key}" data-source="${v.source}"><label>${esc(v.label)}</label><b>${esc(value)}</b><small>${source}</small></div>`;
  }).join('');
  const mapping=state.protocol==='openchicken-runtime-v1'?t('运控提供','From runtime'):state.model_verified?t('已校验','Verified'):t('待实机校验','Pending verification');
  this.element.insertAdjacentHTML('beforeend',`<div><label>${t('映射校验','Mapping verification')}</label><b>${mapping}</b></div>`);
 }
}
