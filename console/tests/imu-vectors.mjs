import assert from 'node:assert/strict';
import {mountedImu,rawImu} from '../web/src/imu_raw.js';
const s={source:'robot',online:true,sample_time:10,
  head_imu_raw:{valid:true,frame:'sensor_axes',orientation_calibrated:false,sample_time:10,
    accel_m_s2:[1,2,9],gyro_rad_s:[.1,.2,.3],temperature_c:40},
  head_imu:{valid:true,frame:'head_to_world',vectors_frame:'head_axes',sample_time:10,
    accel_m_s2:[-1,-2,9],gyro_rad_s:[-.09,-.18,.27]}};
const before=structuredClone(s), mounted=mountedImu(s,'head_imu');
assert.deepEqual(mounted.accel_m_s2,[-1,-2,9]);
assert.deepEqual(mounted.gyro_rad_s,[-.09,-.18,.27]);
assert.equal(mounted.temperature_c,40);
assert.deepEqual(rawImu(s,'head_imu_raw').accel_m_s2,[1,2,9]);
assert.deepEqual(s,before);
for(const change of [{valid:false},{sample_time:9.9},{vectors_frame:'sensor_axes'},
  {vectors_frame:'body_axes'},{frame:'sensor_to_world'},{accel_m_s2:[1,NaN,3]},{gyro_rad_s:null}])
  assert.equal(mountedImu({...s,head_imu:{...s.head_imu,...change}},'head_imu'),null);
for(const change of [{online:false},{source:'snapshot'},{sample_time:11},{sample_time:9}])
  assert.equal(mountedImu({...s,...change},'head_imu'),null);
assert.equal(mountedImu({...s,head_imu:undefined},'head_imu'),null);
assert.equal(mountedImu(s,'imu'),null);
console.log('PASS: mounted vectors, unchanged raw values, timestamps, frames, invalid/offline rejection');
