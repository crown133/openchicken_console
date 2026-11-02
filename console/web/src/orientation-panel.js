import {displayAttitude, relativeAttitude} from './attitude.js?v=20261029-fusion-monitor';
import {rawImu} from './imu_raw.js';
import {tr} from './i18n.js?v=20261101-commissioning';

// Browser-session display zero only; never writes telemetry, robot settings or 3D pose.
export class OrientationPanels {
  constructor(onChange) {
    this.panels=[['head_imu','head-imu'],['imu','imu']].map(([key,id])=>({key,id,reference:null,identity:null}));
    for (const panel of this.panels) {
      const toggle=document.getElementById(panel.id+'-calibrate');
      toggle.onchange=()=>{
        panel.reference=null;
        document.getElementById(panel.id+'-calibration-guide').hidden=!toggle.checked;
        onChange();
      };
      document.getElementById(panel.id+'-set-zero').onclick=()=>{
        if (!panel.current || !this.canSetZero) return;
        panel.reference={quat:[...panel.current.quat]};
        onChange();
      };
    }
  }
  render(state, {frozen=false,replay=false}={}) {
    this.canSetZero=!frozen && !replay && state.online!==false && state.source!=='snapshot';
    for (const panel of this.panels) {
      const {key,id}=panel, toggle=document.getElementById(id+'-calibrate');
      const sample=state[key], current=displayAttitude(state,key);
      const identity=JSON.stringify([state.robot_id,state.boot_id,state.source,sample?.frame,!!replay]);
      if (panel.identity!==identity || state.online===false) {
        panel.reference=null;toggle.checked=false;
        document.getElementById(id+'-calibration-guide').hidden=true;
        panel.identity=identity;
      }
      panel.current=current;
      const result=current && (toggle.checked && panel.reference?relativeAttitude(current,panel.reference):current);
      for (const axis of ['roll','pitch','yaw'])
        document.getElementById(id+'-'+axis).textContent=result?`${(result[axis]*180/Math.PI).toFixed(1)}°`:'—';
      const zero=document.getElementById(id+'-set-zero');
      zero.disabled=!current || !this.canSetZero;
      zero.textContent=tr(panel.reference?'重新设置零位':'设为显示零位');
      let status;
      if (state.online===false) status='IMU 数据无效或已失联';
      else if (!current) {
        const raw=rawImu(state,key+'_raw');
        status=sample?'四元数无效或过期':state[key+'_raw']?(raw?(raw.saturated?'IMU 量程饱和 · 姿态未标定':'等待四元数 · 原始六轴已接入'):'IMU 数据无效或已失联'):'等待四元数';
      }
      else status=toggle.checked && panel.reference?'已应用本地显示零位':sample.frame==='sensor_to_world'?'传感器坐标系 · 未校准':'四元数角度 · 未设置显示零位';
      if (current && sample?.monitor_only) {
        status='六轴融合 · 相对航向 · 仅监控';
        if (sample.mounting_status==='provisional') status+=' · 安装方向暂定';
        if (sample.gyro_bias_status==='provisional_noise_flagged') status+=' · 零偏待复核';
        if (toggle.checked && panel.reference) status+=' · 已应用本地显示零位';
      }
      if (current && state.source==='simulation') status='模拟 IMU 姿态 · '+status;
      if (replay) status='录制姿态 · '+status;
      else if (frozen) status='已定格姿态 · '+status;
      document.getElementById(id+'-status').textContent=tr(status);
    }
  }
}
