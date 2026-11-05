const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
  const p=await b.newPage({viewport:{width:1600,height:1100}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{
   window.pad={index:0,id:'Xbox test',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false}))};
   Object.defineProperty(navigator,'getGamepads',{value:()=>window.pad?[window.pad]:[]});
   window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(raw){window.sent.push(JSON.parse(raw));return send.call(this,raw);};
  });
  await p.goto(process.env.CONSOLE_TEST_URL||'http://127.0.0.1:8095/en/');await p.locator('.joint-node').first().waitFor();await p.bringToFront();
  assert.equal(await p.locator('.robot-card.selected .badge').textContent(),'SIM','This test only operates an isolated simulator');
  if(await p.locator('#start').getAttribute('data-action')==='estop') {
   await p.locator('#start').click();await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Limp');
  }
  await p.evaluate(()=>sent=[]);
  await p.locator('#input-source').selectOption('xbox');await p.waitForTimeout(150);
  const chord=async(indices)=>{await p.evaluate(ids=>ids.forEach(i=>pad.buttons[i].pressed=true),indices);await p.waitForTimeout(120);await p.evaluate(()=>pad.buttons.forEach(b=>b.pressed=false));await p.waitForTimeout(130);};
  await chord([9]);await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Ready');
  assert.equal(await p.evaluate(()=>sent.filter(m=>m.type==='pad_command'&&m.payload.actions.includes('init')).length),1);
  assert.equal(await p.evaluate(()=>sent.filter(m=>m.type==='enable').length),0);
  await p.locator('#enable').click();await p.waitForTimeout(160);
  await p.evaluate(()=>{sent=[];pad.axes=[-1,-1,-1,0];});await p.waitForTimeout(260);
  const drives=await p.evaluate(()=>sent.filter(m=>m.type==='pad_input'));assert.ok(drives.some(m=>m.payload.velocity.vx===.4&&m.payload.velocity.vy===.3&&m.payload.velocity.vyaw===1));
  await p.evaluate(()=>pad.axes=[0,0,0,0]);await p.waitForTimeout(180);assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='pad_input'&&Object.values(m.payload.velocity).every(v=>v===0))));
  // Chords sent once, simulator confirms sit/stand and supports both kicks.
  for(const [button,skill,wait] of [[0,'sit_toggle',2200],[0,'sit_toggle',2200],[14,'kick_left',1000],[15,'kick_right',1000]]){
   await p.evaluate(()=>sent=[]);await chord([4,button]);assert.equal(await p.evaluate(skill=>sent.filter(m=>m.type==='pad_command'&&m.payload.actions.includes(skill)).length,skill),1);await p.waitForTimeout(wait);
  }
  // A real main-thread long task must release instead of renewing the old stick command.
  await p.evaluate(()=>{pad.axes[1]=-1;sent=[];});await p.waitForTimeout(180);
  await p.evaluate(()=>{sent=[];const end=performance.now()+280;while(performance.now()<end){};});await p.waitForTimeout(200);
  assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='release')));assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='pad_input'&&m.payload.velocity.vx!==0)));
  await p.evaluate(()=>pad.axes=[0,0,0,0]);await p.waitForTimeout(100);await p.locator('#claim').click();await p.waitForTimeout(160);
  await p.evaluate(()=>{pad.axes[1]=-1;sent=[];});await p.waitForTimeout(160);await p.evaluate(()=>{pad=null;sent=[];});await p.waitForTimeout(180);
  assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='release')));assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='pad_input'&&m.payload.velocity.vx!==0)));
  await p.evaluate(()=>pad={index:0,id:'Xbox test',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false}))});await p.waitForTimeout(150);
  await p.locator('#claim').click();await p.waitForTimeout(150);await p.evaluate(()=>{pad.axes[1]=-1;sent=[];});await p.waitForTimeout(160);
  await p.keyboard.press('Space');await p.waitForTimeout(180);assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='release')));
  await p.evaluate(()=>{sent=[];});await p.waitForTimeout(180);assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='pad_input'&&m.payload.velocity.vx!==0)));
  await p.evaluate(()=>pad.axes[1]=0);await p.waitForTimeout(100);await p.locator('#claim').click();await p.waitForTimeout(150);
  await p.evaluate(()=>{sent=[];window.dispatchEvent(new Event('blur'));});await p.waitForTimeout(180);assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='release')));
  await p.evaluate(()=>sent=[]);await chord([4,1]);assert.equal(await p.evaluate(()=>sent.filter(m=>m.type==='relax').length),1);
  await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Limp');
  await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS browser + simulator: init only, 3-axis full range, center zero, all chords, 280ms stall, disconnect, emergency, narrow layout. No real gamepad or robot used.');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
