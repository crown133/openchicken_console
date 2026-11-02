const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const base=process.env.CONSOLE_TEST_URL||'http://127.0.0.1:8095/';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
 const p=await browser.newPage({viewport:{width:1600,height:1200},deviceScaleFactor:1});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{window.pad=null;Object.defineProperty(navigator,'getGamepads',{value:()=>pad?[pad]:[]});window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(raw){sent.push(JSON.parse(raw));return send.call(this,raw);};});
 for(const lang of ['en/','']){
  await p.goto(new URL(lang,base).href);await p.bringToFront();await p.locator('.joint-node').first().waitFor();
  await p.waitForFunction(()=>document.querySelector('#gamepad-inspector').dataset.state==='disconnected');
  assert.equal(await p.locator('[data-pad-axis="0"]').textContent(),'—');
  await p.evaluate(()=>pad={index:0,id:'Xbox Wireless Controller (test)',connected:true,mapping:'standard',axes:[.65,-.45,-.5,.3],buttons:Array.from({length:17},()=>({pressed:false,value:0}))});
  await p.waitForFunction(()=>document.querySelector('#gamepad-inspector').dataset.state==='connected');
  assert.equal(await p.locator('[data-pad-axis="0"]').textContent(),'0.650');
  assert.equal(await p.locator('[data-pad-stick="0"]').getAttribute('transform'),'translate(11.05 -7.65)');
  // Observe every standard button without arming robot control.
  for(let i=0;i<17;i++){
   await p.evaluate(index=>{pad.buttons.forEach(b=>{b.pressed=false;b.value=0});pad.buttons[index]={pressed:true,value:1};},i);
   await p.waitForFunction(index=>document.querySelector(`[data-pad-button="${index}"]`).classList.contains('is-pressed'),i);
   assert.equal(await p.locator('.pad-button.is-pressed').count(),1);
  }
  await p.evaluate(()=>{pad.buttons.forEach(b=>{b.pressed=false;b.value=0});[4,0,2].forEach(i=>pad.buttons[i]={pressed:true,value:1});pad.buttons[6]={pressed:false,value:.35};pad.buttons[7]={pressed:true,value:.8};});
  await p.waitForFunction(()=>document.querySelector('[data-pad-trigger-value="0"]').textContent==='35%');
  assert.equal(await p.locator('[data-pad-trigger-value="1"]').textContent(),'80%');
  assert.equal(await p.locator('[data-pad-chord="4,0"]').evaluate(e=>e.classList.contains('is-pressed')),true);
  assert.equal(await p.locator('[data-pad-chord="4,2"]').evaluate(e=>e.classList.contains('is-pressed')),true);
  assert.deepEqual(await p.evaluate(()=>sent),[],'Read-only inspection must not send any commands');
  if(lang){
   
   await p.locator('#theme-toggle').click();
   assert.equal(await p.locator('#gamepad-inspector').evaluate(e=>/[\u3400-\u9fff]/u.test(e.textContent)),false);
  }
  await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  
  await p.evaluate(()=>pad.mapping='');await p.waitForFunction(()=>document.querySelector('#gamepad-inspector').dataset.state==='unsupported');
  assert.equal(await p.locator('.pad-button.is-pressed').count(),0);assert.equal(await p.locator('[data-pad-axis="0"]').textContent(),'—');
  await p.evaluate(()=>pad=null);await p.waitForFunction(()=>document.querySelector('#gamepad-inspector').dataset.state==='disconnected');
  assert.equal(await p.locator('[data-pad-trigger-value="1"]').textContent(),'—');
  await p.setViewportSize({width:1600,height:1200});
 }
 assert.deepEqual(errors,[]);console.log('PASS: 17 buttons, 4 stick axes, analog triggers, combo highlighting, no-control readout, disconnect and unsupported reset, languages/themes/mobile.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
