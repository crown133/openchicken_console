const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 try{
  const p=await b.newPage({viewport:{width:850,height:700}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('http://127.0.0.1:19291/**',route=>{const pathname=new URL(route.request().url()).pathname;if(pathname==='/mouth-pwm.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'../web/src/mouth-pwm.js'),'utf8')});return route.fulfill({contentType:'text/html',body:'<div id="pwm"></div>'});});
  await p.goto('http://127.0.0.1:19291/');await p.bringToFront();
  await p.evaluate(async()=>{
   const {MouthPwm}=await import('/mouth-pwm.js');window.calls=[];window.ctx={id:'test-robot',online:true,allowed:true,state:{version:2,available:true,enabled:false,config:{interface:'J15',min_us:1050,max_us:1400,reverse:true}}};
   window.ui=new MouthPwm(document.querySelector('#pwm'),{context:()=>ctx,send:async(id,payload)=>{calls.push({id,...payload});ctx.state=payload.action==='configure'?{...ctx.state,config:payload.config}:{...ctx.state,enabled:payload.action!=='disable',interface:payload.interface,pulse_us:payload.pulse_us};return ctx.state;}});ui.render();
  });
  assert.equal(await p.evaluate(()=>calls.length),0,'page load must not output');
  await p.locator('[data-slider]').fill('1300');assert.equal(await p.evaluate(()=>calls.length),0,'drag while disabled must not output');
  await p.locator('[data-enable]').click();await p.waitForTimeout(220);
  assert.ok(await p.evaluate(()=>calls.some(c=>c.action==='enable'&&c.interface==='J15'&&c.pulse_us===1300)));
  await p.locator('[data-channel]').selectOption('J16');await p.waitForTimeout(180);
  assert.equal(await p.evaluate(()=>calls.at(-1).action),'disable');
  assert.ok(await p.evaluate(()=>!calls.some(c=>c.action==='enable'&&c.interface==='J16')),'switch must not enable new channel');
  await p.evaluate(()=>ui.render());await p.locator('[data-enable]').click();await p.waitForTimeout(120);
  assert.ok(await p.evaluate(()=>calls.some(c=>c.action==='enable'&&c.interface==='J16')));
  await p.evaluate(()=>window.dispatchEvent(new Event('blur')));await p.waitForTimeout(120);
  assert.equal(await p.evaluate(()=>calls.at(-1).action),'disable');
  await p.evaluate(()=>ui.render());await p.locator('summary').click();await p.locator('[data-min]').fill('1300');await p.locator('[data-save]').click();
  await p.locator('[data-channel]').selectOption('J15');assert.equal(await p.locator('[data-slider]').getAttribute('min'),'1050');
  await p.locator('[data-channel]').selectOption('J16');assert.equal(await p.locator('[data-slider]').getAttribute('min'),'1300');
  await p.locator('[data-min]').fill('999');await p.locator('[data-save]').click();assert.ok((await p.locator('[data-message]').textContent()).includes('1000'));
  await p.evaluate(()=>ui.render());assert.equal(await p.locator('[data-reverse]').isChecked(),true);
  await p.locator('[data-reverse]').uncheck();await p.locator('[data-lt-save]').click();
  assert.ok(await p.evaluate(()=>calls.some(c=>c.action==='configure'&&c.config.reverse===false&&c.config.min_us===1050&&c.config.max_us===1400)));
  await p.evaluate(()=>{ctx.allowed=false;ui.render();});assert.equal(await p.locator('[data-enable]').isDisabled(),true);
  assert.deepEqual(errors,[]);console.log('PASS: no startup output, drag gated, J15/J16 stop-before-switch, blur stop, separate local ranges, range rejection, unavailable gating');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
