const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-webgl']});
 const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.CONSOLE_URL||'http://127.0.0.1:18108';
 try{
 await page.goto(base+'/en/commissioning/');
 const row=await page.evaluate(async()=>{
  const data=await(await fetch('/api/robots')).json();
  const saved=await(await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:data.revision,robot:{robot_id:'configd-fixture',name:'Configd fixture',hostname:'fixture',address:'192.0.2.55',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:''}})})).json();return saved.robots.find(r=>r.robot_id==='configd-fixture');
 });
 const data=await page.evaluate(async id=>(await(await fetch(`/api/robots/${id}/management`)).json()),row.id);
 let operation,job,ran=0;
 const target={address:row.address,port:row.ssh_port,user:row.ssh_user};
 const inspection={can_apply:true,service:{LoadState:'not-found',ActiveState:'inactive'},config_socket:'/run/configd/configd.sock',actions:['Install configd.service','Start configd.service'],diff:'+ExecStart=/home/robot/openchicken_deploy/current/bin/configd',blockers:[]};
 await page.route(`**/api/robots/${row.id}/management`,route=>route.fulfill({json:data}));
 await page.route(`**/api/robots/${row.id}/management/preview`,route=>{
  operation=route.request().postDataJSON().operation;
  return route.fulfill({json:{token:'test-token',context:{settings:data.settings},detail:inspection}});
 });
 await page.route(`**/api/robots/${row.id}/management/run`,route=>{
  ran++;assert.equal(route.request().postDataJSON().password,operation==='configd_apply'?'admin-password':'fixture-password');
  data.policy_management.configd_setup={target,settings:data.settings,result:inspection,queried_at:'fixture time'};
  job={id:'fake-job',operation,status:'completed',log:['Fixture SSH result'],result:operation==='configd_apply'?{status:'success',backup:'/var/backups/openchicken-configd/fixture',verification:{queried_as:'robot'}}:inspection};
  return route.fulfill({json:job});
 });
 await page.route('**/api/management/jobs/fake-job',route=>route.fulfill({json:job}));
 await page.goto(base+'/en/commissioning/?robot=configd-fixture');
 await page.waitForSelector('[data-setup-op=configd_inspect]:enabled');
 assert.ok(await page.locator('[data-setup-op=configd_apply]').isDisabled());
 await page.fill('#ssh-password','fixture-password');
 await page.click('[data-setup-op=configd_inspect]');await page.waitForSelector('.management-preview[open]');
 assert.equal(await page.locator('.management-preview [name=password]').inputValue(),'fixture-password','Checks password reused by management');
 assert.match(await page.locator('.management-preview').textContent(),/No local deploy repository/);
 await page.fill('.management-preview [name=password]','fixture-password');await page.click('.management-preview [type=submit]');
 await page.waitForSelector('[data-setup-op=configd_apply]:enabled');
 await page.click('[data-setup-op=configd_apply]');await page.waitForSelector('.management-preview[open]');
 assert.match(await page.locator('.management-preview').textContent(),/SSH root/);
 assert.equal(await page.locator('.management-preview [name=password]').inputValue(),'','Never reuse ordinary password for root');
 await page.fill('.management-preview [name=password]','admin-password');await page.click('.management-preview [type=submit]');
 assert.equal(ran,1,'Required review checkbox blocks submission');
 await page.check('[data-setup-confirm]');await page.click('.management-preview [type=submit]');
 await page.waitForFunction(()=>document.querySelector('[data-setup-result]').textContent.includes('/var/backups/'));
 assert.equal(ran,2);assert.match(await page.locator('[data-setup-progress]').textContent(),/completed/);
 assert.equal(await page.locator('#ssh-password').inputValue(),'fixture-password','Admin password never replaces ordinary password');
 await page.click('[data-setup-op=configd_apply]');await page.waitForSelector('.management-preview[open]');
 assert.equal(await page.locator('.management-preview [name=password]').inputValue(),'admin-password','Admin password reused');
 await page.click('.management-preview [data-close]');
 await page.click('[data-tab=pad]');await page.click('[data-op=pad_status]');await page.waitForSelector('.management-preview[open]');
 assert.equal(await page.locator('.management-preview [name=password]').inputValue(),'fixture-password','Bluetooth uses ordinary password');
 await page.fill('.management-preview [name=password]','fixture-password');await page.click('.management-preview [type=submit]');
 await page.waitForSelector('.management-preview',{state:'detached'});
 await page.click('[data-open-setup]');assert.ok(await page.locator('.configd-setup').isVisible());
 await page.click('#ssh-clear-passwords');assert.equal(await page.locator('#ssh-password').inputValue(),'');
 await page.click('[data-setup-op=configd_apply]');await page.waitForSelector('.management-preview[open]');
 assert.equal(await page.locator('.management-preview [name=password]').inputValue(),'','Forget clears administrator password too');
 await page.click('.management-preview [data-close]');
 await page.click('[data-setup-op=configd_inspect]');await page.waitForSelector('.management-preview[open]');
 await page.fill('.management-preview [name=password]','fixture-password');await page.click('.management-preview [type=submit]');
 await page.waitForSelector('.management-preview',{state:'detached'});
 assert.equal(await page.locator('#ssh-password').inputValue(),'fixture-password','Management credentials shared back to checks');
 await page.click('[data-setup-op=configd_inspect]');await page.waitForSelector('.management-preview[open]');
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
 assert.equal(await page.locator('.management-preview [name=password]').inputValue(),'','Page exit clears open dialog too');
 await page.click('.management-preview [data-close]');
 await page.fill('#ssh-password','reload-secret');
 assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('reload-secret')),false);
 await page.reload();await page.waitForSelector('[data-setup-op=configd_inspect]:enabled');
 assert.equal(await page.locator('#ssh-password').inputValue(),'','Reload clears page credentials');
 for(const width of [1500,780,390]){await page.setViewportSize({width,height:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No overflow at ${width}`);}
 await page.goto(base+'/commissioning/?robot=configd-fixture');await page.waitForSelector('.configd-setup');assert.match(await page.locator('.configd-setup').textContent(),/检查 configd/);
 assert.deepEqual(errors,[]);console.log('PASS configd UI: inspect, review, checkbox, admin account, results, navigation, languages and responsive layout; all SSH calls mocked.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
