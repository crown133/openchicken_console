// Calibrated body/head-to-world orientation, scalar-first [w,x,y,z].
// Euler display: Rz(yaw) * Ry(pitch) * Rx(roll), radians, right handed.
export function bodyAttitude(state) { if (state?.imu?.orientation_calibrated===false) return null; return imuAttitude(state,state?.imu,'body_to_world'); }
export function headAttitude(state) { if (state?.head_imu?.orientation_calibrated===false) return null; return imuAttitude(state,state?.head_imu,'head_to_world'); }
function imuAttitude(state,imu,frame) {
  const q=imu?.quat;
  if (state?.source==='snapshot' || state?.online===false || imu?.valid!==true ||
      ![frame].flat().includes(imu.frame) ||
      (state.protocol!=='openchicken-runtime-v1' && (!Number.isFinite(imu.sample_time) ||
       !Number.isFinite(state.sample_time) || state.sample_time-imu.sample_time>0.25 || state.sample_time<imu.sample_time)) ||
      !Array.isArray(q) || q.length!==4 ||
      !q.every(Number.isFinite)) return null;
  return quaternionAttitude(q);
}

export function quaternionAttitude(q) {
  if (!Array.isArray(q) || q.length!==4 || !q.every(Number.isFinite)) return null;
  const norm=Math.hypot(...q);
  if (!Number.isFinite(norm) || norm===0) return null;
  const [w,x,y,z]=q.map(v=>v/norm);
  return {quat:[w,x,y,z], roll:Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),
    pitch:Math.asin(Math.max(-1,Math.min(1,2*(w*y-z*x)))),
    yaw:Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))};
}

// Display-only sensor orientation. This does not authorize sensor axes for the 3D body pose.
export function displayAttitude(state, key) {
  if (!['imu','head_imu'].includes(key)) return null;
  const imu=state?.[key];
  if (imu?.quat_order && imu.quat_order!=='wxyz') return null;
  return imuAttitude(state,imu,[key==='imu'?'body_to_world':'head_to_world','sensor_to_world']);
}

export function relativeAttitude(attitude, reference) {
  const [a,b,c,d]=reference.quat, [w,x,y,z]=attitude.quat;
  return quaternionAttitude([a*w+b*x+c*y+d*z, a*x-b*w-c*z+d*y,
    a*y+b*z-c*w-d*x, a*z-b*y+c*x-d*w]);
}
