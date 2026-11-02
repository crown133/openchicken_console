// Display-only regression; WebGL is disabled because these checks exercise 2D UI and chart units.
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');
(async()=>{
 const output=require('node:path').resolve(__dirname,'../../artifacts/console-angle-review');fs.mkdirSync(output,{recursive:true});
 const b=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
  const page=await b.newPage({viewport:{width:1600,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const lang of ['en/','']){
   await page.goto('http://127.0.0.1:8088/'+lang);
   await page.locator('.joint-node').first().waitFor();
   const href=await page.locator('#schematic image').getAttribute('href');assert.match(href,/openchicken-front-v2.png\?v=8acd420b/);
   await page.locator('[data-joint="30"] .node-label-bg').click();
   assert.equal(await page.locator('[data-joint="30"] .node-value').textContent(),'20.0°');
   for(let i=0;i<3;i++){
    await page.locator('#angle-unit').click();
    assert.equal(await page.locator('[data-joint="30"] .node-value').textContent(),'0.349 rad');
    assert.match(await page.locator('#joint-detail').textContent(),/0.3491 rad/);
    assert.equal(await page.locator('#chart').getAttribute('data-unit'),'rad');
    assert.match(await page.locator('#chart-unit').textContent(),/rad/);
    await page.locator('#angle-unit').click();
    assert.equal(await page.locator('[data-joint="30"] .node-value').textContent(),'20.0°');
    assert.equal(await page.locator('#chart').getAttribute('data-unit'),'degree');
   }
   await page.locator('#angle-unit').click();
   for(const [id,x,y] of [[32,260,142],[33,180,129],[31,220,177]]){
    assert.equal(await page.locator(`[data-joint="${id}"] .node-dot`).getAttribute('cx'),String(x));
    assert.equal(await page.locator(`[data-joint="${id}"] .node-dot`).getAttribute('cy'),String(y));
   }
   await page.locator('.schematic-panel').screenshot({path:output+(lang?'/english-status.png':'/chinese-status.png')});
   if(lang){
    await page.locator('#joint-select').selectOption('31');assert.match(await page.locator('#joint-detail').textContent(),/0.3491 rad/);
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.locator('#chart-unit').isVisible(),true);
    console.log('Mobile unit',await page.locator('#chart-unit').evaluate(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON(),color:getComputedStyle(e).color}))); 
    await page.locator('.schematic-panel').screenshot({path:output+'/mobile-status.png'});
    await page.locator('.chart-panel').screenshot({path:output+'/mobile-chart.png'});
    const values=await page.evaluate(async()=>{
     const {JointChart}=await import('/src/chart.js?v=20261028-angle-units');
     const element=document.createElement('div');element.style.width='700px';document.body.append(element);
     const chart=new JointChart(element);
     const samples=[1,2].map(time=>({time,state:{online:true,joints:[{id:30,valid:true,requested:Math.PI/2,submitted:Math.PI/4,position:Math.PI/6}]}}));
     chart.update(samples,30,10,undefined,'degree');const degrees=chart.plot.data.slice(1).map(series=>series[0]);
     chart.update(samples,30,10,undefined,'rad');const radians=chart.plot.data.slice(1).map(series=>series[0]);
     chart.plot.setCursor({left:chart.plot.valToPos(0,'x'),top:20});
     const tooltip=document.querySelector('#chart-tooltip').textContent;
     chart.update(samples,30,10,undefined,'degree');const back=chart.plot.data.slice(1).map(series=>series[0]);
     chart.plot.destroy();element.remove();document.querySelector('#chart-tooltip').hidden=true;
     return {degrees,radians,back,tooltip,source:samples[0].state.joints[0].position};
    });
    [90,45,30].forEach((v,i)=>assert.ok(Math.abs(values.degrees[i]-v)<1e-10));
    [Math.PI/2,Math.PI/4,Math.PI/6].forEach((v,i)=>assert.ok(Math.abs(values.radians[i]-v)<1e-10));
    assert.deepEqual(values.back,values.degrees);assert.equal(values.source,Math.PI/6);assert.match(values.tooltip,/rad/);
    const text=await page.locator('body').innerText();assert.deepEqual(text.split('\n').filter(t=>/[\u3400-\u9fff]/u.test(t)),[]);
    fs.writeFileSync(output+'/curve-conversion.json',JSON.stringify(values,null,2));
    await page.setViewportSize({width:1600,height:1100});
   }
  }
  assert.deepEqual(errors,[]);console.log('Passed: latest image, beak-free markers, both languages, reversible degree/rad conversion, all three curves and tooltip, source radians preserved, mobile width and unit label.');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
