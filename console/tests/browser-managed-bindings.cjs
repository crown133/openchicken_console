const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.stack));
 const target={address:'192.0.2.44',port:22,user:'robot'},entry={target,label:{en:'Bow'},bindings:{keyboard:[{code:'Digit6',event:'press'}],browser_gamepad:[{mapping:'standard',buttons:['LB','RB'],event:'press'}]}};
 const row={id:'a'.repeat(32),robot_id:'demo-01',name:'Demo',address:target.address,ssh_port:22,ssh_user:'robot',hostname:'fixture',results:{},policy_management:{bindings:{bow:entry}}};
 await p.route('**/api/robots',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({revision:1,default_id:row.id,robots:[row]})}));
 await p.routeWebSocket('**/ws',ws=>{const source=ws.connectToServer();source.onMessage(raw=>{const frame=JSON.parse(raw);if(frame.type==='state')for(const robot of frame.robots||[])robot.capabilities.skills.push('bow','first_test');ws.send(JSON.stringify(frame));});ws.onMessage(raw=>{const value=JSON.parse(raw);if(value.type==='action'&&['bow','first_test'].includes(value.payload.skill))ws.send(JSON.stringify({type:'reply',id:value.id,ok:true}));else source.send(raw);});});
 await p.addInitScript(()=>{window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){sent.push(JSON.parse(data));send.call(this,data);};window.pad={connected:true,index:0,id:'Fixture',mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};Object.defineProperty(navigator,'getGamepads',{value:()=>[pad]});});
 await p.goto((process.env.CONSOLE_URL||'http://127.0.0.1:18106')+'/en/');await p.bringToFront();await p.locator('[data-skill=bow]').waitFor({state:'attached'});await p.locator('#input-source').selectOption('keyboard');
 if(await p.locator('#start').getAttribute('data-action')==='estop'){await p.locator('#start').click();await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Limp');}
 await p.locator('#start').click();await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Ready');await p.locator('#enable').click();await p.waitForFunction(()=>!document.querySelector('[data-skill=bow]').disabled);
 await p.locator('[data-skill=first_test]').click();assert.ok(await p.evaluate(()=>sent.some(v=>v.type==='action'&&v.payload.skill==='first_test')));
 await p.locator('.control-panel h2').click();await p.keyboard.press('6');await p.waitForTimeout(150);assert.ok(await p.evaluate(()=>sent.some(v=>v.type==='action'&&v.payload.skill==='bow')));
 await p.locator('#input-source').selectOption('xbox');await p.locator('#claim').click();await p.locator('.control-panel h2').click();await p.waitForTimeout(200);await p.evaluate(()=>{sent=[];[4,5].forEach(i=>pad.buttons[i]={pressed:true,value:1});});await p.waitForTimeout(250);
 assert.equal(await p.evaluate(()=>sent.filter(v=>v.type==='action'&&v.payload.skill==='bow').length),1);
 assert.deepEqual(errors,[]);console.log('PASS live sources: archived action button, keyboard and Xbox single-edge dispatch through existing action; requests intercepted, no robot.');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
