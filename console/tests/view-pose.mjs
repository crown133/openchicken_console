import assert from 'node:assert/strict';
import {modelPose,jointFeed} from '../web/src/view-pose.js';
import {bodyAttitude} from '../web/src/attitude.js';

const state={source:'robot',online:true,protocol:'openchicken-observation-t5-v1',sample_time:10,
  model_verified:false,manifest:[{id:13,name:'right_knee',home:.0049},{id:23,name:'left_knee',home:-.0049}],
  joints:[{id:23,name:'left_knee',valid:true,sample_time:9.98,position:.9,submitted:2},
    {id:13,name:'right_knee',valid:true,sample_time:9.99,position:-1.1,submitted:2}],
  imu:{valid:true,sample_time:9.99,frame:'body_to_world',quat_order:'wxyz',sensor:'LSM6DSV16X',
    quat:[Math.SQRT1_2,Math.SQRT1_2,0,0],monitor_only:true,strategy_ready:false,
    orientation_calibrated:false,mounting_status:'user_confirmed'}};
const before=structuredClone(state),pose=modelPose(state);
assert.ok(jointFeed(state));assert.equal(pose.measuredJoints,2);
assert.deepEqual(pose.feedback,{left_knee:.9,right_knee:-1.1});assert.deepEqual(pose.targets,{});
assert.ok(Math.abs(pose.attitude.roll-Math.PI/2)<1e-8);
assert.equal(bodyAttitude(state),null);assert.deepEqual(state,before);
assert.deepEqual(modelPose({...state,head_imu:{valid:true,quat:[0,0,0,1]}}),pose);
for(const change of [{online:false},{source:'snapshot'},{protocol:'openchicken-system-t1-v1'}]) {
  const result=modelPose({...state,...change});
  assert.deepEqual(result.feedback,{left_knee:-.0049,right_knee:.0049});
  assert.equal(result.attitude,null);assert.equal(result.measuredJoints,0);
}
for(const change of [{valid:false},{sample_time:9},{sample_time:11},{sample_time:NaN},{position:null},{position:NaN}]) {
  const s=structuredClone(state);Object.assign(s.joints[0],change);
  assert.deepEqual(modelPose(s).feedback,{left_knee:-.0049,right_knee:-1.1});
  assert.equal(modelPose(s).measuredJoints,1);
}
for(const change of [{valid:false},{frame:'sensor_to_world'},{quat_order:'xyzw'},
  {mounting_status:'provisional'},{sample_time:9},{sample_time:11},{quat:[0,0,0,0]},{quat:[1,NaN,0,0]}])
  assert.equal(modelPose({...state,imu:{...state.imu,...change}}).attitude,null);
const sim={...state,source:'simulation',imu:{...state.imu,orientation_calibrated:true}};
assert.ok(modelPose(sim).attitude);assert.deepEqual(modelPose(sim).targets,{left_knee:2,right_knee:2});
console.log('PASS live monitor joints/body, no readiness mutation, per-joint stale fallback, snapshot/offline reference, BMI088 isolation and simulation targets');
// Production IPC already supplies mapped feedback and the runtime's attitude.
const runtime=structuredClone(state);
runtime.protocol='openchicken-runtime-v1';
delete runtime.imu.orientation_calibrated;
delete runtime.imu.monitor_only;
delete runtime.imu.strategy_ready;
const livePose=modelPose(runtime);
assert.equal(livePose.measuredJoints,2);
assert.equal(livePose.targets.right_knee,2);
assert.ok(livePose.attitude);
