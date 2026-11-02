const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const base=process.env.CONSOLE_TEST_URL || 'http://127.0.0.1:8094';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
 const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:2});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/en/',route=>route.fulfill({contentType:'text/html',body:`<html><head><link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/vendor/uplot/dist/uPlot.min.css"></head><body><section class="panel chart-panel"><div class="chart-navigation"><button id="chart-pause">Pause</button><button id="chart-zoom-in">+</button><button id="chart-zoom-out">-</button><button id="chart-reset">Reset</button><span id="chart-status"></span></div><div id="chart"></div><div id="chart-tooltip" hidden></div></section></body></html>`}));
 await page.goto(base+'/en/');
 await page.evaluate(async()=>{
  const {JointChart}=await import('/src/chart.js?v=20261030-chart-navigation');
  window.c=new JointChart(document.getElementById('chart'));
  window.make=(end=60)=>Array.from({length:1201},(_,i)=>({time:end-60+i*.05,state:{robot_id:'fixture',boot_id:'one',online:true,joints:[{id:1,valid:true,position:Math.sin(i*.05)*.1,requested:.1,submitted:.08}]}}));
  window.s=make();c.update(s,1,10,undefined,'degree','live');
 });
 const initial=await page.evaluate(()=>({b:c.bounds(),n:c.plot.data[0].length,h:c.plot.height,label:c.plot.axes[1].label(),canvas:document.querySelector('canvas').width,css:document.querySelector('canvas').getBoundingClientRect().width}));
 assert.equal(initial.n,1201);assert.equal(initial.label,'Angle (°)');assert.ok(initial.h>208);assert.ok(initial.canvas>=initial.css*1.9);
 await page.locator('#chart-pause').click();
 await page.evaluate(()=>{window.before=JSON.stringify(c.plot.data);c.update(make(61),1,10,undefined,'degree','live');});
 assert.ok(await page.evaluate(()=>c.paused && before===JSON.stringify(c.plot.data)));
 await page.locator('#chart-zoom-in').click();
 assert.ok(await page.evaluate(()=>c.bounds().x.max-c.bounds().x.min<10));
 const paused=await page.evaluate(()=>c.bounds());
 await page.evaluate(()=>c.update(make(62),1,10,undefined,'degree','live'));
 assert.deepEqual(await page.evaluate(()=>c.bounds()),paused);
 const rect=await page.locator('#chart .u-over').boundingBox();
 await page.mouse.move(rect.x+rect.width*.5,rect.y+rect.height*.5);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.6,rect.y+rect.height*.6,{steps:4});await page.mouse.up();
 const panned=await page.evaluate(()=>c.bounds());assert.ok(panned.x.min<paused.x.min);assert.ok(panned.y.min>paused.y.min);
 await page.mouse.wheel(0,-100);await page.waitForTimeout(60);
 const wheel=await page.evaluate(()=>c.bounds());assert.ok(wheel.x.max-wheel.x.min<panned.x.max-panned.x.min);
 const deg=await page.evaluate(()=>({value:c.plot.data[3][100],y:c.bounds().y}));
 await page.evaluate(()=>c.update(make(63),1,10,undefined,'rad','live'));
 const rad=await page.evaluate(()=>({value:c.plot.data[3][100],y:c.bounds().y,label:c.plot.axes[1].label()}));
 assert.ok(Math.abs(rad.value-deg.value*Math.PI/180)<1e-12);assert.ok(Math.abs(rad.y.min-deg.y.min*Math.PI/180)<1e-12);assert.equal(rad.label,'Angle (rad)');
 await page.locator('#chart-pause').click();assert.ok(await page.evaluate(()=>!c.paused && c.bounds().x.min===-10 && c.bounds().x.max===0));
 await page.locator('#chart-zoom-in').click();await page.locator('#chart .u-over').dblclick();assert.ok(await page.evaluate(()=>!c.paused && c.bounds().x.min===-10));
 await page.locator('#chart-pause').click();await page.evaluate(()=>c.update(make(),2,10,undefined,'rad','live'));assert.ok(await page.evaluate(()=>!c.paused && c.plot.data[3].every(v=>v===null)));
 await page.evaluate(()=>{const g=make();g[1195].state.online=false;c.update(g,1,10,undefined,'degree','live');});assert.ok(await page.evaluate(()=>c.plot.data[3][1195]===null));
 await page.locator('#chart-pause').click();await page.evaluate(()=>c.update(make(),1,30,undefined,'degree','live'));assert.ok(await page.evaluate(()=>!c.paused && c.bounds().x.min===-30));
 await page.locator('#chart-pause').click();await page.evaluate(()=>c.update(make(),1,30,45,'degree','replay'));assert.ok(await page.evaluate(()=>!c.paused && c.plot.data[0].at(-1)===0 && c.plot.data[0].length===901));
 await page.evaluate(()=>{const sample=make()[0];const many=Array.from({length:10000},(_,i)=>({...sample,time:i*.05}));c.update(many,1,10,400,'degree','large-replay');});assert.equal(await page.evaluate(()=>c.plot.data[0].length),1300);
 await page.evaluate(()=>c.update([],1,10,undefined,'degree','empty'));await page.locator('#chart-zoom-in').click();assert.ok(await page.evaluate(()=>!c.paused));
 await page.evaluate(()=>{c.update(make(),1,10,undefined,'degree','live');document.documentElement.dataset.theme='dark';c.updateTheme();});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.close();
 const ui=await browser.newPage({viewport:{width:1600,height:1100}});ui.on('pageerror',e=>errors.push(e.message));
 for(const lang of ['en/','']){
  await ui.goto(base+'/'+lang);await ui.locator('.joint-node').first().waitFor();
  await ui.locator('#chart-pause').click();assert.equal(await ui.locator('#chart').getAttribute('data-paused'),'true');
  assert.equal(await ui.locator('#chart-pause').textContent(),lang?'Resume following':'恢复跟随');
  await ui.locator('#angle-unit').click();assert.equal(await ui.locator('#chart').getAttribute('data-unit'),'rad');
  await ui.locator('#chart-reset').click();assert.equal(await ui.locator('#chart').getAttribute('data-paused'),'false');
 }
 await ui.setViewportSize({width:390,height:844});assert.ok(await ui.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);console.log('PASS: DPR2, responsive height, axes, pause/resume, XY pan, wheel/button zoom, unit conversion, gaps, source/window/joint resets, replay boundary, empty data, both languages.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
