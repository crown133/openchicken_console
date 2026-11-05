const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.pad={index:0,id:'Offline display test',connected:true,mapping:'standard',axes:[.5,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
   Object.defineProperty(navigator,'getGamepads',{value:()=>pad?[pad]:[]});
   window.focused=true;window.hiddenForTest=false;
   Object.defineProperty(document,'hasFocus',{value:()=>focused});
   Object.defineProperty(document,'hidden',{get:()=>hiddenForTest});
   window.sent=[];const send=WebSocket.prototype.send;
   WebSocket.prototype.send=function(raw){sent.push(JSON.parse(raw));return send.call(this,raw);};
  });
  await page.goto((process.env.CONSOLE_URL||'http://127.0.0.1:18108')+'/en/?mode=monitor');
  await page.waitForFunction(()=>document.querySelector('[data-pad-axis="0"]')?.textContent==='0.500');
  assert.equal(await page.locator('.robot-card').count(),0,'Use an isolated server without robots');
  await page.evaluate(()=>{focused=false;window.dispatchEvent(new Event('blur'));pad.axes[0]=-.75;pad.buttons[0]={pressed:true,value:1};pad.buttons[7]={pressed:true,value:.6};});
  await page.waitForFunction(()=>document.querySelector('[data-pad-axis="0"]').textContent==='-0.750',null,{timeout:3000});
  assert.equal(await page.locator('#gamepad-inspector').getAttribute('data-state'),'connected');
  assert.equal(await page.locator('[data-pad-button="0"]').evaluate(e=>e.classList.contains('is-pressed')),true);
  assert.equal(await page.locator('[data-pad-trigger-value="1"]').textContent(),'60%');
  assert.equal(await page.locator('#claim').isDisabled(),true);
  await page.evaluate(()=>{hiddenForTest=true;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.querySelector('#gamepad-inspector').dataset.state==='paused');
  await page.evaluate(()=>{hiddenForTest=false;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.querySelector('[data-pad-axis="0"]').textContent==='-0.750');
  await page.evaluate(()=>pad=null);
  await page.waitForFunction(()=>document.querySelector('#gamepad-inspector').dataset.state==='disconnected');
  assert.equal(await page.locator('[data-pad-axis="0"]').textContent(),'—');
  assert.deepEqual(await page.evaluate(()=>sent.filter(m=>m.type!=='set_mode')),[],'Display must not send robot commands');
  assert.deepEqual(errors,[]);
  console.log('PASS: no robot, live readout while unfocused, hidden-page pause, disconnect reset, no control commands.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
