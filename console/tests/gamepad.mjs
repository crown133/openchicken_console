import assert from 'node:assert/strict';
import fs from 'node:fs';
import {XboxInput,readXbox,mapAxis,MAPPING_VERSION} from '../web/src/gamepad.js';
const profile={version:MAPPING_VERSION,sha256:'test',parameters:JSON.parse(fs.readFileSync(new URL('../protocol/pad-defaults.json',import.meta.url)))};
const make=()=>({index:0,id:'Xbox test',mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))});
let count=0;function test(name,fn){fn();console.log('PASS',name);count++;}
function setup(config=profile){const x=new XboxInput(config),p=make();let time=0;const tick=(dt=20,r={bringup:'Ready'})=>x.poll(p,time+=dt,'robot',true,r);tick();return {x,p,tick,press(...ids){for(const i of ids)p.buttons[i].pressed=true;},up(...ids){for(const i of ids)p.buttons[i].pressed=false;},wait(ms){let result;while(ms>0){const step=Math.min(ms,20);result=tick(step);ms-=step;}return result;}};}
test('native deadzone, half scale, gain and clamp',()=>{
 assert.equal(mapAxis(.099,.4),0);assert.ok(Math.abs(mapAxis(.1,.4)-.04)<1e-12);assert.equal(mapAxis(.5,.4),.2);assert.equal(mapAxis(-.5,.4),-.2);assert.equal(mapAxis(.5,.4,2),.4);assert.equal(mapAxis(2,.4),.4);assert.equal(mapAxis(NaN,.4),0);
});
test('reject unsupported and malformed pads',()=>{const p=make();p.mapping='';assert.equal(readXbox(p),null);p.mapping='standard';p.axes[0]=NaN;assert.equal(readXbox(p),null);p.axes[0]=0;p.buttons.length=10;assert.equal(readXbox(p),null);});
test('five action chords fire once; releasing permits retrigger',()=>{
 for(const [index,skill] of [[0,'sit_toggle'],[13,'ground_pick'],[14,'kick_left'],[15,'kick_right'],[12,'roulade']]){
  const t=setup();t.press(4,index);assert.deepEqual(t.tick().commands,[skill]);assert.deepEqual(t.wait(500).commands,[]);t.up(index);t.tick();t.press(index);assert.deepEqual(t.tick().commands,[skill]);
 }
});
test('LB+B beats everything, including Start/Select and before neutral arming',()=>{const t=setup();t.press(4,0,1,12,13,14,15,8,9);assert.deepEqual(t.tick().commands,['relax']);assert.deepEqual(t.tick().commands,[]);const x=new XboxInput(null);assert.deepEqual(x.poll(t.p,0,'r').commands,['relax']);});
test('face buttons alone and RB do nothing',()=>{for(const i of [0,1,2,3,5]){const t=setup();t.press(i);assert.deepEqual(t.tick().commands,[]);}});
test('LB+X/Y are no longer skills',()=>{for(const i of [2,3]){const t=setup();t.press(4,i);assert.deepEqual(t.tick().commands,[]);}});
test('LB suppresses motion and does not leak mode changes on release',()=>{const t=setup();t.p.axes=[1,-1,1,-1];t.press(4,12);const a=t.tick();assert.equal(a.mode,'drive');assert.deepEqual(a.velocity,{vx:0,vy:0,vyaw:0});assert.equal(a.frame.head,null);t.up(4);assert.equal(t.tick().mode,'drive');t.up(12);t.tick();t.press(12);assert.equal(t.tick().mode,'head');});
test('all four native modes and signs',()=>{
 const t=setup();t.p.axes=[.5,-.5,.5,-.5];let a=t.tick();assert.deepEqual(a.velocity,{vx:.2,vy:-.15,vyaw:-.5});
 t.press(12);a=t.tick();assert.deepEqual(a.velocity,{vx:0,vy:0,vyaw:0});assert.deepEqual(a.frame.head,{neck_pitch:1.25,head_pitch:-1.25,head_yaw:-1.25,head_roll:1.25});t.up(12);t.tick();
 t.press(15);a=t.tick();assert.deepEqual(a.velocity,{vx:.2,vy:0,vyaw:-.5});assert.equal(a.frame.head.neck_pitch,0);t.up(15);t.tick();
 t.press(13);a=t.tick();assert.deepEqual(a.velocity,{vx:0,vy:0,vyaw:0});assert.equal(a.frame.pose.z,.005);assert.equal(a.frame.pose.roll,.1309);t.p.axes[1]=.5;assert.equal(t.tick().frame.pose.z,-.0125);
 t.up(13);t.tick();t.press(14);a=t.tick();assert.equal(a.frame.pose.active,false);assert.deepEqual(Object.values(a.frame.head),[0,0,0,0]);
});
test('native profile gain and angle limits applied',()=>{const p=structuredClone(profile);p.parameters.pad_head.head_yaw_max=.6;p.parameters.pad_axes.head.head_yaw.gain=2;const t=setup(p);t.press(12);t.p.axes[0]=.5;assert.equal(t.tick().frame.head.head_yaw,-.6);});
test('Start short only on release; init vs toggle based on feedback',()=>{
 for(const [bringup,expected] of [['Limp',['init']],['Ready',['toggle']],['Homing',[]],[undefined,[]]]){const t=setup();t.press(9);assert.deepEqual(t.tick(20,{bringup}).commands,[]);t.wait(100);t.up(9);assert.deepEqual(t.tick(20,{bringup}).commands,expected);}
});
test('Start 1.5 s holds home once, resets mode, suppresses release',()=>{const t=setup();t.press(13);t.tick();t.up(13);t.press(9);t.tick();assert.deepEqual(t.wait(1480).commands,[]);const a=t.tick();assert.deepEqual(a.commands,['home']);assert.equal(a.mode,'drive');assert.deepEqual(t.wait(500).commands,[]);t.up(9);assert.deepEqual(t.tick().commands,[]);});
test('Select short does nothing and 2–4 s RELEASE rests',()=>{for(const duration of [100,2000,3900]){const t=setup();t.press(8);t.tick();assert.deepEqual(t.wait(duration).commands,[]);t.up(8);assert.deepEqual(t.tick(0).commands,duration>=2000?['rest']:[]);}});
test('Select 4 s shuts down exactly once, no rest at 2 s',()=>{const t=setup();t.press(8);t.tick();assert.deepEqual(t.wait(2000).commands,[]);assert.deepEqual(t.wait(1980).commands,[]);assert.deepEqual(t.tick().commands,['shutdown']);assert.deepEqual(t.wait(500).commands,[]);t.up(8);assert.deepEqual(t.tick().commands,[]);});
test('LB consumes holds; releasing LB does not resurrect Start',()=>{const t=setup();t.press(9);t.tick();t.wait(1000);t.press(4);t.tick();t.up(4);t.wait(1000);t.up(9);assert.deepEqual(t.tick().commands,[]);});
test('RT holds crow and opens mouth; LT retains wheee',()=>{const t=setup();t.p.buttons[7].value=.29;let a=t.tick();assert.deepEqual(a.commands,[]);assert.equal(a.frame.crow,false);assert.equal(a.frame.mouth,.29);t.p.buttons[7].value=.3;a=t.tick();assert.deepEqual(a.commands,[]);assert.equal(a.frame.crow,true);assert.equal(t.tick().frame.crow,true);t.p.buttons[6].value=.8;a=t.tick();assert.equal(a.frame.mouth,.8);assert.equal(a.frame.wheee,true);t.p.buttons[6].value=0;t.p.buttons[7].value=1;a=t.tick();assert.equal(a.frame.mouth,1);assert.equal(a.frame.wheee,false);assert.equal(a.frame.crow,true);t.p.buttons[7].value=0;assert.equal(t.tick().frame.crow,false);});
test('new pad held off-center cannot move or init',()=>{const p=make(),x=new XboxInput(profile);p.axes[0]=1;p.buttons[9].pressed=true;assert.equal(x.poll(p,0,'r').status,'neutral');assert.deepEqual(x.poll(p,20,'r').commands,[]);});
test('280 ms stall clears holds and requires neutral',()=>{const t=setup();t.press(8);t.tick();t.wait(3900);const a=t.tick(280);assert.equal(a.fault,true);assert.deepEqual(a.commands,[]);assert.equal(t.tick().status,'neutral');t.up(8);assert.equal(t.tick().status,'ready');});
test('disconnect, focus loss and boot change discard control',()=>{for(const mode of ['disconnect','focus','boot']){const t=setup();const a=t.x.poll(mode==='disconnect'?null:t.p,40,mode==='boot'?'new':'robot',mode!=='focus');assert.equal(a.fault,true);assert.deepEqual(a.velocity,{vx:0,vy:0,vyaw:0});}});
test('missing or changed native configuration disarms',()=>{const t=setup(null);assert.equal(t.tick().status,'configuration');const s=setup();s.press(9);s.tick();s.x.configure({...profile,sha256:'changed'});assert.equal(s.tick().status,'neutral');});
test('stable gamepad timestamp does not expire freshly sampled input',()=>{const t=setup();t.p.timestamp=1;t.p.axes[1]=-1;for(let i=0;i<100;i++)assert.equal(t.tick().velocity.vx,.4);});
test('threshold crossed on the release sample is still a long hold',()=>{for(const [button,duration,command] of [[9,1500,'home'],[8,4000,'shutdown']]){const t=setup();t.press(button);t.tick();t.wait(duration-20);t.up(button);assert.deepEqual(t.tick().commands,[command]);assert.deepEqual(t.tick().commands,[]);}});
test('trigger rest tolerance allows up to 5% without changing raw values',()=>{
 for(const index of [6,7])for(const value of [0,.001,.049,.05,.051,.3]){
  const p=make(),x=new XboxInput(profile);p.buttons[index].value=value;
  const sample=readXbox(p);assert.equal(sample.neutral,value<=.05);
  assert.equal(sample[index===6?'lt':'rt'],value);
  const result=x.poll(p,0,'robot');assert.equal(result.status,value<=.05?'ready':'neutral');
  assert.deepEqual(result.commands,[]);assert.deepEqual(result.velocity,{vx:0,vy:0,vyaw:0});
 }
 const p=make();p.buttons[6].value=.05;p.buttons[7].value=.05;
 assert.equal(readXbox(p).neutral,true);
 p.buttons[0].pressed=true;assert.equal(readXbox(p).neutral,false);
 p.buttons[0].pressed=false;p.axes[0]=.1;assert.equal(readXbox(p).neutral,false);
 p.axes[0]=0;p.buttons[6].pressed=true;assert.equal(readXbox(p).neutral,false);
});
console.log(`${count} gamepad checks passed`);
