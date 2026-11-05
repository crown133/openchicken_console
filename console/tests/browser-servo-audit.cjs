const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-webgl']});
 const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.stack));
 const base=process.env.CONSOLE_URL||'http://127.0.0.1:18108';
 try{
 await page.goto(base+'/en/commissioning/');
 const row=await page.evaluate(async()=>{const data=await(await fetch('/api/robots')).json();const saved=await(await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:data.revision,robot:{robot_id:'servo-fixture',name:'Servo fixture',hostname:'fixture',address:'192.0.2.77',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:''}})})).json();return saved.robots.find(r=>r.robot_id==='servo-fixture');});
 await page.goto(base+'/en/commissioning/?robot=servo-fixture');await page.waitForSelector('[data-stage="2"]');await page.click('[data-stage="2"]');
 await page.waitForSelector('.servo-audit [data-joint]');assert.equal(await page.locator('.servo-audit [data-joint]').count(),14);
 assert.ok(await page.locator('[data-read]').isDisabled());
 await page.fill('.servo-audit [name=notes]','Fixture assembly reference');await page.click('.servo-audit [type=submit]');
 await page.waitForSelector('[data-read]:enabled');
 const data=await page.evaluate(async id=>(await(await fetch(`/api/robots/${id}/management/joints`)).json()),row.id);
 assert.equal(data.revision,1);assert.equal(data.expected.find(j=>j.id===13).homing_offset,-512);
 await page.fill('.servo-audit [name=id-0]','11');await page.fill('.servo-audit [name=notes]','Invalid duplicate');await page.click('.servo-audit [type=submit]');
 await page.waitForFunction(()=>document.querySelector('[data-servo-message]').textContent.includes('unique'));
 await page.fill('.servo-audit [name=id-0]','10');await page.fill('.servo-audit [name=offset-0]','25');await page.click('.servo-audit [type=submit]');await page.waitForSelector('[data-read]:enabled');
 const result={job_id:'servo-job',captured_at:'fixture time',target:{address:row.address,port:22,user:'robot'},revision:2,rows:data.expected.map((j,i)=>({name:j.name,actual:{id:j.id,direction:0,homing_offset:j.homing_offset},status:i===0?'different':'match'}))};
 let ran=0,job;
 await page.route(`**/api/robots/${row.id}/management/run`,async route=>{ran++;assert.equal(route.request().postDataJSON().password,'fixture-admin');job={id:'servo-job',profile_id:row.id,operation:'joint_readback',status:'completed',log:['Read-only fixture audit'],result};await route.fulfill({json:job});});
 await page.route('**/api/management/jobs/servo-job',route=>route.fulfill({json:job}));
 await page.route(`**/api/robots/${row.id}/management/joints`,async route=>{if(route.request().method()==='GET'){const response=await route.fetch();const current=await response.json();if(ran)current.latest=result;await route.fulfill({json:current});}else await route.continue();});
 await page.click('[data-read]');await page.waitForSelector('.management-preview[open]');assert.match(await page.locator('.management-preview').textContent(),/SSH root/);
 await page.fill('.management-preview [name=password]','fixture-admin');await page.click('.management-preview [type=submit]');assert.equal(ran,0);
 await page.check('[data-servo-confirm]');await page.click('.management-preview [type=submit]');
 await page.waitForFunction(()=>document.querySelector('[data-servo-progress]').textContent.includes('completed'));
 assert.equal(ran,1);assert.match(await page.locator('.servo-audit [data-joint=right_hip_yaw] [data-diff]').textContent(),/Different/);
 assert.match(await page.locator('[data-servo-message]').textContent(),/not live/);
 const saved=await page.evaluate(async id=>(await(await fetch('/api/robots')).json()).robots.find(r=>r.id===id),row.id);assert.deepEqual(saved.results,{});
 for(const width of [1500,780,390]){await page.setViewportSize({width,height:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No overflow ${width}`);}
 await page.goto(base+'/commissioning/?robot=servo-fixture');await page.waitForSelector('[data-stage="2"]');await page.click('[data-stage="2"]');await page.waitForSelector('.servo-audit [data-joint]');assert.match(await page.locator('.servo-audit h3').textContent(),/参数差异/);
 assert.equal(await page.locator('.servo-audit [name=offset-0]').inputValue(),'25');
 assert.deepEqual(errors,[]);console.log('PASS N03: 14 joints, save/restore expectations, duplicate rejection, read-only confirmation, diff results, no auto acceptance, bilingual/responsive. SSH mocked.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
