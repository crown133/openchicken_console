const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-webgl']});
 const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],remote=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/(run|preview|scan|connect)$/.test(r.url()))remote.push(r.url());});
 const base=process.env.CONSOLE_URL||'http://127.0.0.1:18108';
 try{
 await page.goto(base+'/en/commissioning/');
 const row=await page.evaluate(async()=>{
  const current=await(await fetch('/api/robots')).json();
  const saved=await(await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:current.revision,robot:{robot_id:'notes-fixture',name:'Notes fixture',hostname:'fixture',address:'192.0.2.88',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:''}})})).json();return saved.robots.find(r=>r.robot_id==='notes-fixture');
 });
 await page.goto(base+'/en/commissioning/?robot=notes-fixture');await page.click('[data-stage="2"]');await page.waitForSelector('.servo-audit [data-joint]');
 assert.equal(await page.locator('.servo-audit [data-joint]').count(),14);assert.equal(await page.locator('#test-guide [data-record]').count(),0);assert.equal(await page.locator('#test-guide .test-card').count(),0);
 assert.equal(await page.locator('.servo-audit [name=notes]').getAttribute('required'),null);
 await page.click('.servo-audit button[type=submit]');await page.waitForFunction(()=>document.querySelector('[data-read]')?.disabled===false);
 await page.selectOption('[name=mechanical-0]','checked');await page.fill('[name=joint-note-0]','Checked direction and zero');await page.click('.servo-audit button[type=submit]');await page.waitForFunction(()=>document.querySelector('[data-read]')?.disabled===false);
 const data=await page.evaluate(async id=>(await(await fetch(`/api/robots/${id}/management/joints`)).json()),row.id);
 assert.equal(data.revision,1,'Notes do not invalidate readback revision');assert.equal(data.annotations[data.expected[0].name].status,'checked');
 await page.reload();await page.click('[data-stage="2"]');await page.waitForSelector('[name=mechanical-0]');assert.equal(await page.locator('[name=mechanical-0]').inputValue(),'checked');assert.equal(await page.locator('[name=joint-note-0]').inputValue(),'Checked direction and zero');
 await page.click('[data-tab=history]');await page.locator('[data-history] > details').filter({hasText:'Update notes & mechanical checks'}).locator(':scope > summary').click();assert.match(await page.locator('[data-history]').innerText(),/Checked direction and zero/);
 // Load a saved audit fixture in History; no SSH request is executed.
 await page.route(`**/api/robots/${row.id}/management`,async route=>{const response=await route.fetch();const value=await response.json();value.servo_history.push({id:'audit-fixture',operation:'joint_readback',created_at:'2026-11-04T01:00:00Z',status:'completed'});await route.fulfill({json:value});});
 await page.route('**/api/management/jobs/audit-fixture',route=>route.fulfill({json:{id:'audit-fixture',profile_id:row.id,status:'completed',operation:'joint_readback',log:[],result:{captured_at:'2026-11-04T01:00:00Z',target:{address:row.address},rows:[{name:data.expected[0].name,expected:data.expected[0],actual:{id:10,direction:0,homing_offset:7},status:'different'}]}}}));
 await page.click('[data-tab=tests]');await page.click('[data-tab=history]');await page.waitForSelector('[data-servo-job]',{state:'attached'});await page.locator('[data-servo-job]').locator('..').locator(':scope > summary').click();await page.click('[data-servo-job]');await page.waitForFunction(()=>document.querySelector('[data-readback-result]').textContent.includes('Different'));assert.match(await page.locator('[data-readback-result]').innerText(),/10 \/ 0 \/ 7/);
 await page.click('[data-tab=tests]');await page.click('[data-stage="2"]');await page.fill('[name=offset-0]','11');assert.equal(await page.locator('[name=mechanical-0]').inputValue(),'unchecked');await page.click('[data-stage="1"]');await page.click('[data-stage="2"]');assert.equal(await page.locator('[name=joint-note-0]').inputValue(),'Checked direction and zero');
 await page.locator('.servo-audit').screenshot({path:'/tmp/openchicken-n03-compact.png'});
 for(const width of [1500,780,390]){await page.setViewportSize({width,height:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No page overflow at ${width}`);}
 await page.goto(base+'/commissioning/?robot=notes-fixture');await page.click('[data-stage="2"]');await page.waitForSelector('[name=mechanical-0]');assert.match(await page.locator('.servo-audit thead').innerText(),/机械核对（可选）/);
 assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);console.log('PASS N03 compact: optional per-joint checks/notes, persistence, stable parameter revision, no manual cards, readback History, bilingual responsive UI; no robot calls.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
