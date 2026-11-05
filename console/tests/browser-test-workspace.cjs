// Isolated server only: all remote execution routes below are mocked.
const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-webgl']});
 const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.CONSOLE_URL||'http://127.0.0.1:18108';
 try{
 await page.goto(base+'/en/commissioning/');await page.waitForSelector('[data-test-card=system]');
 const row=await page.evaluate(async()=>{
  const data=await(await fetch('/api/robots')).json();
  const saved=await(await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:data.revision,robot:{robot_id:'workspace-fixture',name:'Workspace fixture',hostname:'fixture',address:'192.0.2.55',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:''}})})).json();return saved.robots.find(r=>r.robot_id==='workspace-fixture');
 });
 const data=await page.evaluate(async id=>(await(await fetch(`/api/robots/${id}/management`)).json()),row.id);
 const target={address:row.address,port:22,user:'robot'},jobs={};let operation,serial=0;
 const sections=[{id:'system',state:'observed',evidence:{hostname:'fixture',kernel:'fixture kernel',architecture:'aarch64'}},{id:'deployment',state:'observed',evidence:{files:[{path:'/fixture/robotctl',exists:true}]}},{id:'identity',state:'observed',evidence:{identity:{robot_id:row.robot_id,hostname:'fixture',protocol:'fixture'}}}];
 await page.route('**/api/commissioning/ssh/**',route=>{
  const url=route.request().url();
  if(url.includes('/status/'))return route.fulfill({json:{trusted:true,busy:false,latest_stages:{}}});
  if(url.endsWith('/run')){const body=route.request().postDataJSON();requests.push(body.check);assert.equal(body.password,'fixture-password');const id='ssh-'+(++serial);jobs[id]={id,profile_id:row.id,robot_id:row.robot_id,target,check:body.check,stage:body.check.slice(6),status:'completed',log:['DIAGNOSTIC_SENTINEL'],finished_at:'2026-11-03T16:00:00Z',result:{sections:body.check==='stage_N01'?sections:[{id:'interfaces',state:'observed',evidence:{devices:[{path:'/dev/openchicken-dxl',exists:true,readable:true,writable:true}]}}]}};return route.fulfill({json:jobs[id]});}
  if(url.includes('/jobs/'))return route.fulfill({json:jobs[url.split('/').pop()]});
  throw Error('Unexpected SSH request '+url);
 });
 await page.route(`**/api/robots/${row.id}/management`,route=>route.fulfill({json:data}));
 const inspection={can_apply:true,service:{LoadState:'not-found',ActiveState:'inactive'},config_socket:'/run/configd/configd.sock',actions:['Install service'],blockers:[],diff:'+fixture'};
 await page.route(`**/api/robots/${row.id}/management/preview`,route=>{operation=route.request().postDataJSON().operation;return route.fulfill({json:{token:'fixture-token',context:{settings:data.settings},detail:inspection}});});
 await page.route(`**/api/robots/${row.id}/management/run`,route=>{
  requests.push(operation);assert.equal(route.request().postDataJSON().password,operation==='configd_apply'?'admin-password':'fixture-password');
  const result=operation==='configd_apply'?{status:'success',verification:{}}:inspection;
  data.policy_management.configd_setup={target,settings:data.settings,result:operation==='configd_apply'?{...inspection,service:{LoadState:'loaded',ActiveState:'active',UnitFileState:'enabled'}}:inspection,queried_at:'2026-11-03T16:00:00Z'};
  const id='management-'+(++serial);jobs[id]={id,profile_id:row.id,operation,status:'completed',result,log:['MANAGEMENT_SENTINEL']};return route.fulfill({json:jobs[id]});
 });
 await page.route('**/api/management/jobs/*',route=>route.fulfill({json:jobs[route.request().url().split('/').pop()]}));
 await page.goto(base+'/en/commissioning/?robot=workspace-fixture');
 await page.waitForFunction(()=>document.querySelector('[data-connection-target]')?.textContent.includes('workspace-fixture'));
 await page.click('[data-connections]');await page.fill('#ssh-password','fixture-password');await page.click('.workspace-dialog[open] > .panel-head [data-close]');
 await page.click('.stage-heading [data-action=stage_N01]');await page.waitForFunction(()=>document.querySelector('[data-test-card=system]').textContent.includes('fixture kernel'));
 assert.equal(await page.locator('pre:visible').count(),0);assert.equal(await page.locator('[data-test-card=configd]').count(),0);
 await page.click('[data-stage="1"]');await page.click('.stage-heading [data-action=stage_N02]');await page.waitForFunction(()=>document.querySelector('[data-test-card=interfaces]').textContent.includes('accessible'));
 assert.equal(await page.locator('.management-preview[open]').count(),0,'No repeat password dialog');
 await page.click('[data-stage="2"]');await page.waitForSelector('.servo-audit [data-joint]');assert.equal(await page.locator('.servo-audit [data-joint]').count(),14);
 await page.fill('[name=offset-0]','23');await page.click('[data-stage="0"]');await page.click('[data-stage="2"]');assert.equal(await page.locator('[name=offset-0]').inputValue(),'23','Preserve unsaved table across phase changes');
 await page.click('[data-stage="4"]');await page.click('[data-action=install-configd]');await page.waitForSelector('.management-preview[open]');
 assert.match(await page.locator('.management-preview').innerText(),/root/);assert.equal(await page.locator('.management-preview input[type=checkbox]').count(),0);
 await page.fill('.management-preview [name=password]','admin-password');await page.click('.management-preview [type=submit]');
 await page.waitForFunction(()=>document.querySelector('[data-test-card=configd]').textContent.includes('Running'));
 assert.deepEqual(requests,['stage_N01','stage_N02','configd_inspect','configd_apply']);
 await page.click('[data-action=configd_inspect]');await page.waitForFunction(()=>document.querySelector('[data-test-card=configd]').textContent.includes('Not installed'));
 assert.equal(await page.locator('.management-preview[open]').count(),0,'Reuse ordinary password after admin operation');
 await page.click('[data-stage="0"]');await page.click('[data-test-card=system] [data-record]');await page.selectOption('.workspace-dialog[open] [name=status]','passed');await page.fill('.workspace-dialog[open] [name=notes]','Fixture accepted');await page.click('.workspace-dialog[open] form button');
 await page.waitForFunction(()=>document.querySelector('[data-test-card=system]').textContent.includes('Fixture accepted'));
 assert.equal(await page.locator('[data-test-card=deployment]').innerText().then(v=>v.includes('Operator record')),false);
 await page.click('[data-diagnostics]');assert.ok(await page.locator('#ssh-log').isVisible());assert.match(await page.locator('#ssh-log').innerText(),/DIAGNOSTIC_SENTINEL/);await page.click('.workspace-dialog[open] > .panel-head [data-close]');
 for(const stage of [3,4,5,6,7,8,9]){await page.click(`[data-stage="${stage}"]`);assert.equal(await page.locator('pre:visible').count(),0);}
 for(const tab of ['program','policies','pad','history']){await page.click(`[data-tab=${tab}]`);assert.equal(await page.locator('[data-settings]:visible').count(),0);}
 await page.click('[data-tab=tests]');await page.click('[data-stage="4"]');
 for(const width of [1500,780,390]){await page.setViewportSize({width,height:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No overflow at ${width}`);}
 await page.setViewportSize({width:1500,height:1100});await page.locator('.management-tabs').scrollIntoViewIfNeeded().catch(()=>{});await page.screenshot({path:'/tmp/oc-tests-light.png',fullPage:true});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'/tmp/oc-tests-dark.png',fullPage:true});
 await page.goto(base+'/commissioning/?robot=workspace-fixture');await page.waitForSelector('[data-test-card=system]');assert.match(await page.locator('[data-test-card=system]').innerText(),/系统身份/);
 assert.deepEqual(errors,[]);console.log('PASS phase workspace: scoped checks, compact results, credential reuse, one-flow configd, preserved N03 edits, records, diagnostics, bilingual layout; remote calls mocked.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
