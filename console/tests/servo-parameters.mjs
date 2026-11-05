import assert from 'node:assert/strict';
globalThis.location={pathname:'/en/'};
const {parameterValues}=await import('../web/src/servo-parameters.js');
const joint={id:13,name:'right_knee',p:null,i:null,d:null,drive_mode:null,torque:null,error:0};
const fields={id_register:13,position_p_gain:200,position_i_gain:0,position_d_gain:0,pwm_slope:255,pwm_limit:885,homing_offset:-12,drive_mode:1,torque:1,hardware_error:4};
const profile={robot_id:'robot',address:'192.0.2.1',ssh_port:22,ssh_user:'robot',servo_audit:{latest:{source:'ssh_readback',captured_at:'2026-11-04T00:00:00Z',target:{address:'192.0.2.1',port:22,user:'robot'},rows:[{name:'right_knee',expected:{id:13},fields}]}}};
const state={robot_id:'robot',online:true};
let result=parameterValues(joint,state,profile),get=key=>result.values.find(v=>v.key===key);
assert.equal(get('p').value,200);assert.equal(get('i').value,0);assert.equal(get('homing_offset').value,-12);
assert.equal(get('p').source,'n03');assert.equal(get('torque').value,null);assert.equal(get('error').value,0);assert.equal(get('error').source,'live');
result=parameterValues({...joint,p:300,torque:false},state,profile);assert.equal(get('p').value,300);assert.equal(get('p').source,'live');assert.equal(get('torque').value,false);
result=parameterValues(joint,{...state,online:false},profile);assert.equal(get('p').value,200);assert.equal(get('error').value,null);
for(const update of [{address:'different'},{robot_id:'other'},{ssh_user:'other'}]){result=parameterValues(joint,state,{...profile,...update});assert.equal(get('p').value,null);}
const wrong=structuredClone(profile);wrong.servo_audit.latest.rows[0].fields.id_register=23;
assert.equal(parameterValues(joint,state,wrong).capturedAt,null);
result=parameterValues(joint,state,profile,{recorded:true});assert.equal(get('p').value,null);assert.equal(get('error').source,'recorded');
result=parameterValues(joint,state,{...profile,servo_audit:{expected:[{id:13,p:999}]}});assert.equal(get('p').value,null);
console.log('PASS servo parameters: actual values, zero/negative, live precedence, target/ID isolation, historical provenance, transient-state and replay separation.');
