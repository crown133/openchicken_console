import assert from 'node:assert/strict';
import {bodyAttitude,headAttitude} from '../web/src/attitude.js';
const sample=q=>({source:'simulation',online:true,sample_time:10,imu:{valid:true,frame:'body_to_world',sample_time:10,quat:q}});
const near=(a,b)=>assert.ok(Math.abs(a-b)<3e-8,`${a} != ${b}`);
for(const [axis,q] of [['roll',[Math.SQRT1_2,Math.SQRT1_2,0,0]],['pitch',[Math.SQRT1_2,0,Math.SQRT1_2,0]],['yaw',[Math.SQRT1_2,0,0,Math.SQRT1_2]]]) {
  const result=bodyAttitude(sample(q));near(result[axis],Math.PI/2);
  const negative=bodyAttitude(sample(q.map(v=>-v)));near(negative[axis],result[axis]);
}
assert.equal(bodyAttitude(sample([0,0,0,0])),null);
assert.equal(bodyAttitude(sample([NaN,0,0,0])),null);
assert.equal(bodyAttitude(sample([1,0,0])),null);
for(const change of [{source:'snapshot'},{online:false},{sample_time:10.3},{sample_time:9}])
  assert.equal(bodyAttitude({...sample([1,0,0,0]),...change}),null);
for(const change of [{valid:false},{frame:'sensor_to_world'},{sample_time:null}]) {
  const state=sample([1,0,0,0]);Object.assign(state.imu,change);assert.equal(bodyAttitude(state),null);
}
near(bodyAttitude(sample([1.01,0,0,0])).quat[0],1);
console.log('Attitude: axis rotations, quaternion sign/normalization, stale/invalid/snapshot rejection passed');

const headSample={...sample([1,0,0,0]),head_imu:{valid:true,frame:'head_to_world',sample_time:10,quat:[Math.SQRT1_2,0,0,Math.SQRT1_2]}};
near(headAttitude(headSample).yaw,Math.PI/2);
near(bodyAttitude(headSample).yaw,0);
assert.equal(headAttitude(sample([1,0,0,0])),null);
for(const change of [{valid:false},{frame:'body_to_world'},{sample_time:9.7},{sample_time:10.1},{quat:[0,0,0,0]},{quat:[NaN,0,0,0]}])
  assert.equal(headAttitude({...headSample,head_imu:{...headSample.head_imu,...change}}),null);
for(const change of [{online:false},{source:'snapshot'}])assert.equal(headAttitude({...headSample,...change}),null);
console.log('Head attitude: independent IMU, missing, stale, wrong-frame and invalid data checks passed');
