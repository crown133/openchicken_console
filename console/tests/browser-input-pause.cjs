const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.pad={index:0,id:'Xbox test',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
   Object.defineProperty(navigator,'getGamepads',{value:()=>pad?[pad]:[]});
   window.sent=[];window.noticePad=false;window.dropCriticalReply=false;
   const send=WebSocket.prototype.send;
   WebSocket.prototype.send=function(raw){
    const data=JSON.parse(raw);sent.push(data);
    if(window.dropCriticalReply&&data.type==='pad_command')return;
    if(window.noticePad&&data.type==='pad_input'){
     window.noticePad=false;
     queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'control_notice',robot_id:data.robot_id,error:'Diagnostic rejection'})})));
    }
    return send.call(this,raw);
   };
  });
  await page.goto(process.env.CONSOLE_TEST_URL||'http://127.0.0.1:18108/en/');
  await page.locator('.joint-node').first().waitFor();await page.bringToFront();
  assert.equal(await page.locator('.robot-card.selected .badge').textContent(),'SIM','Never run against a real robot');
  await page.waitForTimeout(500);
  const acquire=async()=>{
   await page.evaluate(()=>{pad.axes=[0,0,0,0];pad.buttons.forEach(b=>{b.pressed=false;b.value=0;});sent=[];});
   await page.waitForTimeout(150);await page.locator('#claim').click();
   await page.waitForFunction(()=>sent.some(m=>m.type==='pad_input'));
   try{await page.waitForFunction(()=>document.querySelector('#input-pause').hidden,{},{timeout:5000});}catch(e){console.log(await page.evaluate(()=>({sent,pause:document.querySelector('#input-pause').textContent,toast:document.querySelector('#toast').textContent,status:document.querySelector('#control-state').textContent})));throw e;}
  };
  const paused=async(reason)=>{
   await page.waitForFunction(text=>!document.querySelector('#input-pause').hidden&&document.querySelector('#input-pause').textContent.includes(text),reason);
   assert.match(await page.locator('#control-state').textContent(),/Control paused/);
   assert.ok(await page.evaluate(()=>sent.some(m=>m.type==='release')));
  };
  await acquire();
  await page.evaluate(()=>{sent=[];const until=performance.now()+280;while(performance.now()<until){};});
  await paused('Page stalled');
  await page.evaluate(()=>{sent=[];pad.axes=[0,0,0,0];});await page.waitForTimeout(500);
  assert.match(await page.locator('#gamepad-status').textContent(),/Controller connected · Control paused: Page stalled/);
  assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='pad_input').length),0);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.match(await page.locator('#input-pause').textContent(),/Page stalled/,'A later blur must not replace the original cause');
  await acquire();
  await page.evaluate(()=>{sent=[];window.dispatchEvent(new Event('blur'));});await paused('Window lost focus');
  await page.waitForTimeout(500);assert.match(await page.locator('#gamepad-status').textContent(),/Control paused: Window lost focus/);
  await acquire();
  await page.evaluate(()=>{sent=[];pad.connected=false;});await paused('Controller disconnected');
  await page.evaluate(()=>pad.connected=true);await page.waitForTimeout(350);
  assert.match(await page.locator('#gamepad-status').textContent(),/Controller connected · Control paused: Controller disconnected/);
  await acquire();
  await page.evaluate(()=>{sent=[];noticePad=true;});
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Diagnostic rejection'));
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('#input-pause').isVisible(),false,'A notification error must not release control');
  const frames=await page.evaluate(()=>sent.filter(m=>m.type==='pad_input'));
  assert.ok(frames.length>=12,'Sampling must continue beyond the former reply timeout');
  assert.ok(frames.every(m=>m.reply===false&&!m.id));
  assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='release').length),0);
  await page.evaluate(()=>{sent=[];dropCriticalReply=true;pad.buttons[9].pressed=true;});
  await page.waitForTimeout(120);await page.evaluate(()=>pad.buttons[9].pressed=false);
  await paused('Request timed out');
  await page.waitForFunction(()=>document.querySelector('#gamepad-status').textContent.includes('pad_command: Request timed out'));
  await page.evaluate(()=>dropCriticalReply=false);
  await acquire();assert.deepEqual(errors,[]);
  await page.setViewportSize({width:600,height:850});
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.waitForTimeout(200);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Pause reason must wrap');
  if(process.env.PAUSE_SCREENSHOT){await page.setViewportSize({width:1600,height:1100});await page.waitForTimeout(200);await page.locator('.control-panel').screenshot({path:process.env.PAUSE_SCREENSHOT});}
  console.log('PASS simulator: ordinary notifications continue without replies; asynchronous error does not release control; critical timeout, stall, focus, disconnect, re-acquire and narrow layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
