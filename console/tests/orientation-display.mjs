import assert from 'node:assert/strict';
import {bodyAttitude,displayAttitude,relativeAttitude,quaternionAttitude} from '../web/src/attitude.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const q=[Math.SQRT1_2,Math.SQRT1_2,0,0];
const s={source:'robot',online:true,sample_time:10,imu:{frame:'sensor_to_world',valid:true,sample_time:10,quat:q}};
near(displayAttitude(s,'imu').roll,Math.PI/2);assert.equal(bodyAttitude(s),null);
const original=structuredClone(s);const attitude=displayAttitude(s,'imu');
const zero=relativeAttitude(attitude,attitude);for(const a of ['roll','pitch','yaw'])near(zero[a],0);
assert.deepEqual(s,original);
const yaw=a=>quaternionAttitude([Math.cos(a/2),0,0,Math.sin(a/2)]);
near(relativeAttitude(yaw(-170*Math.PI/180),yaw(170*Math.PI/180)).yaw,20*Math.PI/180);
for(const change of [{valid:false},{sample_time:9},{quat:[0,0,0,0]},{quat:[1,NaN,0,0]},{quat_order:'xyzw'},{frame:'head_to_world'}])
 assert.equal(displayAttitude({...s,imu:{...s.imu,...change}},'imu'),null);
assert.equal(displayAttitude({...s,online:false},'imu'),null);
assert.equal(displayAttitude({...s,source:'snapshot'},'imu'),null);
assert.equal(displayAttitude({...s,head_imu:{...s.imu,quat:[1,0,0,0]}},'head_imu').roll,0);
assert.equal(displayAttitude({source:'robot',imu_raw:{valid:true}},'imu'),null);
console.log('PASS: sensor-frame display, 3D frame isolation, relative quaternion zero/sign wrap, invalid/stale/order rejection, independent head/body, no raw-data estimation or mutation');

const monitor={...s,imu:{...s.imu,frame:"body_to_world",orientation_calibrated:false}};
assert.equal(bodyAttitude(monitor),null);assert.ok(displayAttitude(monitor,"imu"));
