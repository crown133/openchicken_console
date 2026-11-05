import { english } from './i18n.js?v=20261101-commissioning';
const t=(zh,en)=>english?en:zh;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const inventoryItems=[
 ['system','N01','系统身份','System identity'],['deployment','N01','程序与目录','Programs & directories'],['identity','N01','机器人通信身份','Robot identity'],
 ['interfaces','N02','设备接口与权限','Device interfaces & permissions'],
 ['audio','N04','扬声器与麦克风','Speaker & microphone'],['openchicken-speaker-init','N04','音频初始化','Audio initialization'],['pin31','N04','供电反馈入口','Power feedback setup'],
 ['robotd','N05','运控服务','Robot runtime'],['tofd','N05','头部 IMU 服务','Head IMU service'],['openchicken-agent','N05','监控桥接','Monitor bridge'],['configd','N05','配置服务','Configuration service'],['padd','N05','本机手柄服务','Local controller service'],['bluetooth','N05','系统蓝牙','System Bluetooth'],['adapter','N05','蓝牙适配器','Bluetooth adapter'],['sockets','N05','服务连接','Service connections'],['input','N05','手柄输入权限','Controller input access'],['pad_config','N05','手柄模式','Controller mode'],
 ['runtime','N06','Runtime 与模型','Runtime & models']
];
export function summarize(item){
 if(!item)return {status:t('未检查','Not checked'),text:'',tone:'unknown'};
 const e=item.evidence||{},id=item.id;let status=t('已读取','Read'),text='',tone=item.state==='attention'?'attention':'neutral';
 if(e.alternative_active)return {status:t('已配置替代服务','Alternative configured'),text:e.alternative_active,tone:'good'};
 if(e.service){
  const s=e.service;
  if(s.LoadState==='not-found')return {status:t('未安装','Not installed'),text:t('需要配置此服务','Service setup required'),tone:'attention'};
  if(!s.LoadState)return {status:t('未知','Unknown'),text:t('未能读取服务状态','Service state unavailable'),tone:'unknown'};
  status=s.ActiveState==='active'?t('运行中','Running'):t('未运行','Stopped');tone=s.ActiveState==='active'?'good':'attention';text=s.UnitFileState==='enabled'?t('已设置开机启动','Starts at boot'):t('未设置开机启动','Not enabled at boot');
 }else if(id==='system'){text=[e.hostname,e.architecture,e.kernel].filter(Boolean).join(' · ');}
 else if(id==='deployment'){const files=e.files||[],missing=files.filter(f=>f.exists===false);status=missing.length?t('文件缺失','Files missing'):files.length?t('文件齐全','Files present'):t('未知','Unknown');text=missing.length?missing.map(f=>f.path.split('/').pop()).join(', '):t(`${files.length} 项程序和配置已找到`,`${files.length} program/configuration files found`);}
 else if(id==='interfaces'){text=(e.devices||[]).map(d=>`${d.path.split('/').pop()}: ${d.exists===false?t('缺失','missing'):d.readable&&d.writable?t('可访问','accessible'):t('权限待核对','check access')}`).join(' · ');status=item.state==='observed'?t('接口已找到','Interfaces found'):t('需处理','Needs attention');if(e.owners?.stdout?.trim())text+=' · '+t('设备已有占用者','Devices have active owners');}
 else if(id==='identity'){const v=e.identity;if(v){text=[v.robot_id,v.hostname,v.protocol].filter(Boolean).join(' · ');status=item.state==='observed'?t('身份匹配','Identity matches'):t('身份或密钥需核对','Check identity / keys');}else {status=t('未知','Unknown');text=t('未能读取通信配置','Communication configuration unavailable');}}
 else if(id==='adapter'){const powered=/Powered:\s*yes/.test(e.stdout||'');status=powered?t('已开启','Powered on'):e.error?t('未知','Unknown'):t('未开启','Powered off');tone=powered?'good':'attention';text=t('配对和控制连接分别验证','Pairing and controller operation are checked separately');}
 else if(id==='sockets'){const files=Array.isArray(e)?e:[],required=files.filter(f=>f.required!==false&&(f.required===true||f.path!=='/run/configd.sock'));const missing=required.filter(f=>!f.socket);status=missing.length?t('连接入口缺失','Connection endpoint missing'):t('入口已找到','Endpoints found');text=missing.map(f=>f.path.split('/').slice(-2).join('/')).join(' · ');}
 else if(id==='audio'){const play=e.playback?.exit_code===0&&/card \d/.test(e.playback.stdout||''),mic=e.capture?.exit_code===0&&/card \d/.test(e.capture.stdout||'');status=t('功能待验证','Function not tested');text=`${t('播放设备','Playback')}: ${play?t('已识别','detected'):t('未确认','unknown')} · ${t('录音设备','Capture')}: ${mic?t('已识别','detected'):t('未确认','unknown')}`;}
 else if(id==='runtime'){text=t(`找到 ${e.runtime_libraries?.length||0} 个 Runtime 文件、${e.policy_files?.length||0} 个模型；尚未验证推理。`,`${e.runtime_libraries?.length||0} Runtime files and ${e.policy_files?.length||0} models found; inference not verified.`);status=t('文件已检查','Files checked');}
 else if(id==='input'){text=t(`${e.events?.length||0} 个输入设备；padd 用户：${e.padd_user||'未配置'}`,`${e.events?.length||0} input devices; padd user: ${e.padd_user||'not configured'}`);status=t('需核对实际使用账户','Verify service account');}
 else if(id==='pad_config'){status=e.netpad_enabled===false?t('本机输入','Local input'):e.netpad_enabled===true?t('网络输入','Network input'):t('使用原生默认值','Native defaults');text=t('按部署版本核对手柄映射','Check mappings against the deployed version');}
 else if(id==='pin31'){status=e.launcher?.exists?t('入口已配置','Launcher present'):t('未配置','Not configured');text=t('实时电压与供电状态见机器人反馈','Voltage and power state come from robot telemetry');}
 else {status=t('待人工验证','Manual verification');}
 if(item.state==='unknown'&&!e.service)status=t('未知','Unknown');
 return {status,text,tone};
}
// Compact archive view used only inside diagnostics; phase workspace owns actions.
export function renderInitialization(element,job=null){
 const rows=job?.result?.sections||[];
 element.innerHTML=rows.length?rows.map(item=>{const label=inventoryItems.find(i=>i[0]===item.id);if(!label)return '';const s=summarize(item);return `<div data-initialization-item="${esc(item.id)}"><strong>${esc(english?label[3]:label[2])}</strong> · ${esc(s.status)}<p>${esc(s.text)}</p></div>`;}).join(''):`<p>${t('暂无检查记录','No inspection recorded')}</p>`;
}
