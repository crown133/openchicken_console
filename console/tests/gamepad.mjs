import assert from 'node:assert/strict';
import {XboxInput,readXbox,mapAxis} from '../web/src/gamepad.js';
const pad=()=>({index:0,id:'Xbox test',mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false}))});
let count=0;function test(name,fn){fn();console.log('PASS',name);count++;}
test('signs, full scale, deadzone and clamping',()=>{
 const p=pad();p.axes=[-1,-1,-1,0];assert.deepEqual(readXbox(p).velocity,{vx:.4,vy:.3,vyaw:1});
 p.axes=[1,1,1,0];assert.deepEqual(readXbox(p).velocity,{vx:-.4,vy:-.3,vyaw:-1});
 assert.equal(mapAxis(.12,.4),0);assert.equal(mapAxis(2,.4),.4);assert.equal(mapAxis(NaN,.4),0);
});
test('unknown mapping or invalid axes rejected',()=>{const p=pad();p.mapping='';assert.equal(readXbox(p),null);p.mapping='standard';p.axes[0]=NaN;assert.equal(readXbox(p),null);});
test('all five commands are edge triggered; held chords never repeat',()=>{
 for(const [indices,expected] of [[[9],'init'],[[4,1],'relax'],[[4,0],'sit_toggle'],[[4,2],'kick_left'],[[4,3],'kick_right']]){
  const x=new XboxInput(),p=pad();x.poll(p,0,'r');indices.forEach(i=>p.buttons[i].pressed=true);
  assert.equal(x.poll(p,20,'r').command,expected);assert.equal(x.poll(p,40,'r').command,null);
 }
});
test('emergency chord wins simultaneous buttons',()=>{const x=new XboxInput(),p=pad();x.poll(p,0,'r');[4,0,1,2,3,9].forEach(i=>p.buttons[i].pressed=true);assert.equal(x.poll(p,20,'r').command,'relax');});
test('plugging in off-center does not move or activate a held start',()=>{const x=new XboxInput(),p=pad();p.axes[0]=1;p.buttons[9].pressed=true;assert.equal(x.poll(p,0,'r').status,'neutral');assert.equal(x.poll(p,20,'r').command,null);p.axes[0]=0;p.buttons[9].pressed=false;assert.equal(x.poll(p,40,'r').status,'ready');});
test('280 ms stall zeros output and requires neutral',()=>{const x=new XboxInput(),p=pad();x.poll(p,0,'r');p.axes[1]=-1;assert.equal(x.poll(p,20,'r').velocity.vx,.4);const r=x.poll(p,300,'r');assert.equal(r.fault,true);assert.equal(r.velocity.vx,0);assert.equal(x.poll(p,320,'r').status,'neutral');p.axes[1]=0;assert.equal(x.poll(p,340,'r').status,'ready');});
test('disconnect, blur and robot boot change release control',()=>{for(const kind of ['disconnect','blur','boot']){const x=new XboxInput(),p=pad();x.poll(p,0,'r');const r=kind==='disconnect'?x.poll(null,20,'r'):kind==='blur'?x.poll(p,20,'r',false):x.poll(p,20,'other');assert.equal(r.fault,true);assert.equal(r.velocity.vx,0);}});
test('unchanged timestamp does not expire a freshly polled held stick',()=>{const x=new XboxInput(),p=pad();p.timestamp=1;x.poll(p,0,'r');p.axes[1]=-1;for(let t=20;t<=500;t+=20)assert.equal(x.poll(p,t,'r').velocity.vx,.4);});
console.log(`${count} gamepad checks passed`);
