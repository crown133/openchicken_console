const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try {
  const p=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{
   window.pad={index:0,id:'Xbox test',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
   Object.defineProperty(navigator,'getGamepads',{value:()=>[pad]});window.sent=[];
   const send=WebSocket.prototype.send;WebSocket.prototype.send=function(raw){sent.push(JSON.parse(raw));return send.call(this,raw);};
  });
  await p.goto(process.env.CONSOLE_TEST_URL||'http://127.0.0.1:18106/en/');await p.bringToFront();await p.locator('.joint-node').first().waitFor();
  assert.equal(await p.locator('.robot-card.selected .badge').textContent(),'SIM');
  if(await p.locator('#start').getAttribute('data-action')==='estop')await p.locator('#start').click();
  await p.locator('#input-source').selectOption('xbox');await p.waitForTimeout(250);
  const press=async(i)=>p.evaluate(i=>pad.buttons[i].pressed=true,i);
  const up=async(i)=>p.evaluate(i=>pad.buttons[i].pressed=false,i);
  const tap=async(i)=>{await press(i);await p.waitForTimeout(100);await up(i);await p.waitForTimeout(150);};
  await tap(9);await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Ready');
  await p.evaluate(()=>sent=[]);await tap(9);
  assert.equal(await p.evaluate(()=>sent.filter(m=>m.type==='pad_command'&&m.payload.actions.includes('toggle')).length),1);
  await tap(13);await p.evaluate(()=>{pad.axes=[.5,-.5,.5,-.5];sent=[];});await p.waitForTimeout(250);
  assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='pad_input'&&m.payload.pose?.active&&m.payload.pose.z===.005&&m.payload.velocity.vx===0)));
  await p.evaluate(()=>pad.axes=[0,0,0,0]);await tap(14);await p.waitForTimeout(180);
  assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='pad_input'&&m.payload.pose?.active===false)));
  await p.evaluate(()=>{sent=[];pad.buttons[7].value=.5;pad.buttons[6].value=.8;});await p.waitForTimeout(260);
  assert.equal(await p.evaluate(()=>sent.filter(m=>m.type==='pad_command'&&m.payload.actions.includes('chirp')).length),0);
  assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='pad_input'&&m.payload.crow)));
  assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='pad_input'&&m.payload.mouth===.8&&m.payload.wheee)));
  await p.evaluate(()=>{pad.buttons[7].value=pad.buttons[6].value=0;sent=[];});await press(9);await p.waitForTimeout(1800);await up(9);await p.waitForTimeout(180);
  assert.deepEqual(await p.evaluate(()=>sent.filter(m=>m.type==='pad_command').flatMap(m=>m.payload.actions)),['home']);
  await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Ready');
  await p.evaluate(()=>sent=[]);await press(8);await p.waitForTimeout(2200);
  assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='pad_command')));await up(8);await p.waitForTimeout(200);
  assert.deepEqual(await p.evaluate(()=>sent.filter(m=>m.type==='pad_command').flatMap(m=>m.payload.actions)),['rest']);
  await tap(9);await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Ready');
  await p.evaluate(()=>sent=[]);await press(8);await p.waitForTimeout(2300);
  assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='pad_command')));await p.waitForTimeout(2000);await up(8);await p.waitForTimeout(200);
  assert.deepEqual(await p.evaluate(()=>sent.filter(m=>m.type==='pad_command').flatMap(m=>m.payload.actions)),['shutdown']);
  assert.deepEqual(errors,[]);console.log('PASS browser: policy toggle, body mode/exit, triggers, Start hold, Select release/rest and hold/shutdown. Simulator only.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
