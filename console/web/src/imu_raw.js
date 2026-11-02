// Sensor axes only; raw values never drive the calibrated orientation viewer.
export function rawImu(state,key) {
  const sample=state?.[key];
  if (state?.source!=='robot' || state.online===false || sample?.valid!==true ||
      sample.frame!=='sensor_axes' || sample.orientation_calibrated!==false ||
      !Number.isFinite(sample.sample_time) || !Number.isFinite(state.sample_time) ||
      state.sample_time<sample.sample_time || state.sample_time-sample.sample_time>.25 ||
      !['accel_m_s2','gyro_rad_s'].every(k=>Array.isArray(sample[k]) && sample[k].length===3 && sample[k].every(Number.isFinite)) ||
      !Number.isFinite(sample.temperature_c)) return null;
  return sample;
}

// Mounted acceleration and bias-corrected angular velocity from the same fusion sample.
export function mountedImu(state,key) {
  if (!['imu','head_imu'].includes(key)) return null;
  if (state?.protocol==='openchicken-runtime-v1') {
    const sample=state[key];
    return state.online!==false && sample?.valid &&
      ['accel_m_s2','gyro_rad_s'].every(k=>Array.isArray(sample[k]) && sample[k].length===3 && sample[k].every(Number.isFinite)) ? sample : null;
  }
  const sample=state?.[key], raw=rawImu(state,key+'_raw');
  if (!raw || sample?.valid!==true || sample.sample_time!==raw.sample_time ||
      sample.vectors_frame!==(key==='imu'?'body_axes':'head_axes') ||
      sample.frame!==(key==='imu'?'body_to_world':'head_to_world') ||
      !['accel_m_s2','gyro_rad_s'].every(k=>Array.isArray(sample[k]) && sample[k].length===3 && sample[k].every(Number.isFinite))) return null;
  return {...sample,temperature_c:raw.temperature_c};
}
