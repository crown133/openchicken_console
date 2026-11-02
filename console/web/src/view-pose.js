// Visualization only: these selections do not change calibration or control readiness.
import {bodyAttitude,displayAttitude} from './attitude.js?v=20261029-fusion-monitor';

export const jointFeed = state => ['openchicken-joints-t3-v1','openchicken-sensors-t3-v1',
  'openchicken-power-t3-v1','openchicken-orientation-t5-v1','openchicken-observation-t5-v1','openchicken-runtime-v1'].includes(state?.protocol);

export function modelPose(state) {
  const real=state.source==='robot', runtime=state.protocol==='openchicken-runtime-v1';
  const referenceOnly=(state.source==='snapshot' && !state.model_verified) ||
    (real && (!jointFeed(state) || state.online===false));
  const feedback={},targets={};
  let measuredJoints=0;
  for (const joint of state.joints) {
    const mapping=state.manifest?.find(j=>j.id===joint.id);
    const fresh=!real || (runtime && joint.valid===true) || (joint.valid===true && mapping?.name===joint.name &&
      Number.isFinite(joint.sample_time) && Number.isFinite(state.sample_time) &&
      state.sample_time>=joint.sample_time && state.sample_time-joint.sample_time<=0.25);
    const measured=!referenceOnly && fresh && Number.isFinite(joint.position);
    const position=measured?joint.position:mapping?.home;
    if (Number.isFinite(position)) feedback[joint.name]=position;
    if (measured) measuredJoints++;
    if ((!real || runtime) && !referenceOnly && Number.isFinite(joint.submitted)) targets[joint.name]=joint.submitted;
  }
  let attitude=bodyAttitude(state);
  const imu=state.imu;
  if (!attitude && real && ['openchicken-orientation-t5-v1','openchicken-observation-t5-v1'].includes(state.protocol) &&
      imu?.frame==='body_to_world' && imu.quat_order==='wxyz' && imu.sensor==='LSM6DSV16X' &&
      imu.monitor_only===true && imu.strategy_ready===false && imu.orientation_calibrated===false &&
      imu.mounting_status==='user_confirmed') attitude=displayAttitude(state,'imu');
  return {feedback,targets,attitude,measuredJoints,referenceOnly};
}
