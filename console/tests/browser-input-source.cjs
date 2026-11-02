const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const base=process.env.CONSOLE_TEST_URL||'http://127.0.0.1:8095/';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try {
 const p=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{window.pad={index:0,id:'Xbox test',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};Object.defineProperty(navigator,'getGamepads',{value:()=>[pad]});window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(raw){sent.push(JSON.parse(raw));return send.call(this,raw);};});
 await p.goto(new URL('en/',base).href);await p.bringToFront();await p.locator('.joint-node').first().waitFor();
 assert.equal(await p.locator('.robot-card.selected .badge').textContent(),'SIM');
 assert.ok(await p.locator('.dpad').isVisible());assert.ok(await p.locator('#skills').isVisible());assert.ok(await p.locator('#gamepad-inspector').isHidden());assert.ok(await p.locator('#gamepad-values').isHidden());
 if(await p.locator('#start').getAttribute('data-action')==='estop'){await p.locator('#start').click();await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Limp');}
 await p.locator('#start').click();await p.waitForFunction(()=>document.querySelector('#machine-state').textContent==='Ready');await p.locator('#enable').click();await p.waitForTimeout(160);
 await p.evaluate(()=>{sent=[];pad.axes=[-1,-1,-1,0];[0,1,2,3,4,9].forEach(i=>pad.buttons[i]={pressed:true,value:1});});await p.waitForTimeout(300);
 assert.ok(await p.evaluate(()=>!sent.some(m=>['drive','action','init','relax'].includes(m.type))),'Xbox ignored in keyboard mode');
 await p.locator('.control-panel h2').click();await p.keyboard.down('w');await p.waitForTimeout(250);assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='drive'&&m.payload.vx===.12)));
 await p.evaluate(()=>{sent=[];pad.axes=[0,0,0,0];pad.buttons.forEach(b=>{b.pressed=false;b.value=0;});});
 await p.locator('#input-source').selectOption('xbox');await p.waitForTimeout(200);await p.keyboard.up('w');
 assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='release')));assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='drive'&&Object.values(m.payload).some(v=>v!==0))));
 assert.ok(await p.locator('.dpad').isHidden());assert.ok(await p.locator('#skills').isHidden());assert.ok(await p.locator('#gamepad-inspector').isVisible());assert.ok(await p.locator('#claim').isVisible());
 await p.locator('#claim').click();await p.waitForTimeout(160);if(await p.locator('#enable').isEnabled())await p.locator('#enable').click();
 await p.locator('.control-panel h2').click();await p.evaluate(()=>sent=[]);await p.keyboard.down('w');await p.keyboard.press('1');await p.waitForTimeout(220);await p.keyboard.up('w');
 assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='action'||(m.type==='drive'&&Object.values(m.payload).some(v=>v!==0)))),'Keyboard movement/actions ignored in Xbox mode');
 await p.evaluate(()=>{sent=[];pad.axes[1]=-1;});await p.waitForTimeout(250);assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='drive'&&m.payload.vx===.4)));
 await p.evaluate(()=>sent=[]);await p.locator('#input-source').selectOption('keyboard');await p.waitForTimeout(200);
 assert.ok(await p.evaluate(()=>sent.some(m=>m.type==='release')));assert.ok(await p.evaluate(()=>!sent.some(m=>m.type==='drive'&&Object.values(m.payload).some(v=>v!==0))));
 for(const lang of ['en/','']){
 await p.goto(new URL(lang,base).href);await p.locator('.joint-node').first().waitFor();
 for(const width of [1600,390]){
 await p.setViewportSize({width,height:1100});
 for(const source of ['keyboard','xbox']){
 await p.locator('#input-source').selectOption(source);
 assert.equal(await p.locator('#gamepad-inspector').isVisible(),source==='xbox');assert.equal(await p.locator('.dpad').isVisible(),source==='keyboard');
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
 }
 }
 }
 assert.deepEqual(errors,[]);console.log('PASS: exclusive UI, inactive input ignored, both switch directions release and clear motion; English/Chinese, desktop/mobile. Isolated simulator only.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
