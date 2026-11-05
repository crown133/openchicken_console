import assert from 'node:assert/strict';
import {ManagedBindings} from '../web/src/managed-bindings.js';
const mapper=new ManagedBindings(),bindings={bow:{bindings:{keyboard:[{code:'Digit6',event:'press'}],browser_gamepad:[{mapping:'standard',buttons:['LB','RB'],event:'press'}]}}};
const pad={connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
function press(...indices){pad.buttons.forEach((b,i)=>{b.pressed=indices.includes(i);b.value=b.pressed?1:0;});}
assert.equal(mapper.configure(bindings,'robot-a'),true);assert.equal(mapper.configure(bindings,'robot-a'),false);
assert.equal(mapper.keyboard('Digit6'),'bow');assert.equal(mapper.keyboard('Space'),null);
press(4,5);assert.equal(mapper.poll(pad,0,true),null,'held input at activation never triggers');
press();mapper.poll(pad,10,true);press(4,5);assert.equal(mapper.poll(pad,20,true),'bow');assert.equal(mapper.poll(pad,30,true),null,'no hold repetition');
press(4);mapper.poll(pad,40,true);press(4,5);assert.equal(mapper.poll(pad,50,true),'bow');
press();mapper.poll(pad,60,true);press(4,5,1);assert.equal(mapper.poll(pad,70,true),null,'LB+B priority');
press();mapper.poll(pad,80,true);press(4,5);assert.equal(mapper.poll(pad,90,true,true),null,'native commands suppress extra skills');
assert.equal(mapper.poll(pad,100,false),null);assert.equal(mapper.poll(pad,110,true),null,'input switch requires neutral');
press();mapper.poll(pad,120,true);press(4,5);assert.equal(mapper.poll(pad,400,true),null,'stall disarms');
mapper.configure(bindings,'robot-b');assert.equal(mapper.poll(pad,410,true),null,'robot switch disarms');
console.log('PASS: custom bindings preserve native priority, edge semantics, input selection, neutral arming and stall handling.');
