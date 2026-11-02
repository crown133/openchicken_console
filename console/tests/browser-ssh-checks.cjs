const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');const assert=require('node:assert/strict');
const base=(process.env.CONSOLE_TEST_URL||'http://127.0.0.1:8097').replace(/\/$/,'');
(async()=>{const b=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});try{
const p=await b.newPage({viewport:{width:1500,height:1100}}),errors=[],requests=[];p.on('pageerror',e=>errors.push(e.message));
const id='a'.repeat(32),jobId='b'.repeat(32);let trusted=false,latest=null,revision=1;
let row={id,robot_id:'openchicken2',name:'Test robot',hostname:'',address:'192.0.2.44',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:'',results:{}};
await p.route('**/api/robots',async route=>{
 if(route.request().method()==='POST'){const body=route.request().postDataJSON();row={...row,...body.robot};revision++;}
 await route.fulfill({contentType:'application/json',body:JSON.stringify({revision,default_id:id,robots:[row]})});
});
// Feed the saved draft without any simulated telemetry.
await p.routeWebSocket('**/commissioning/ws',ws=>{
 const source=ws.connectToServer();source.onMessage(raw=>{const frame=JSON.parse(raw);if(frame.type==='state')frame.robots=[{...frame.empty_state,empty:false,robot_id:row.robot_id,profile_id:id}];ws.send(JSON.stringify(frame));});
});
await p.route('**/api/commissioning/ssh/**',async route=>{
 const action=new URL(route.request().url()).pathname.split('/').at(-1);let data;
 if(route.request().method()==='POST'){
  const body=route.request().postDataJSON();requests.push({action,check:body.check});
  if(action==='scan')data={token:'token',target:{address:row.address,port:22,user:'robot'},keys:[{type:'ssh-ed25519',fingerprint:'SHA256:test-fixture-only'}]};
  if(action==='trust'){trusted=true;data={trusted:true};}
  if(action==='run'){
   assert.equal(body.password,'test-password');assert.equal(body.check,'system');assert.ok(trusted);
   latest={id:jobId,profile_id:id,robot_id:row.robot_id,target:{address:row.address,port:22,user:'robot'},check:'system',stage:'N01',status:'completed',created_at:'2026-11-01T00:00:00Z',finished_at:'2026-11-01T00:00:01Z',read_only:true,hostname_matches:true,log:['Read-only collection completed.'],result:{hostname:'radxa-measured',user:'robot',check:'system',read_only:true,kernel:'test-kernel'}};
   data=latest;
  }
 }else if(route.request().url().includes('/status/'))data={trusted,busy:false,latest_job:latest?.id,target:{address:row.address,port:22,user:'robot'}};
 else data=latest;
 await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
});
await p.goto(base+'/en/commissioning/');await p.locator('#ssh-target').filter({hasText:'openchicken2'}).waitFor({timeout:10000}).catch(async e=>{console.log(errors,await p.locator('body').innerText());throw e;});
assert.ok(await p.locator('[data-ssh-check=system]').isDisabled());await p.locator('#ssh-scan').click();await p.locator('#ssh-trust').waitFor();assert.ok(await p.locator('#ssh-trust').isDisabled());
await p.locator('#ssh-fingerprint-confirm').check();await p.locator('#ssh-trust').click();await p.locator('#ssh-password').fill('test-password');await p.locator('[data-ssh-check=system]').click();
await p.waitForFunction(()=>document.querySelector('#ssh-log').textContent.includes('radxa-measured'));
assert.equal(await p.locator('#ssh-password').inputValue(),'');assert.ok(await p.locator('[data-ssh-check=system]').isDisabled());assert.ok(await p.locator('#ssh-result').isVisible());
await p.locator('#ssh-hostname').click();await p.waitForFunction(()=>document.querySelector('#ssh-message').textContent.includes('Measured hostname saved'));assert.equal(row.hostname,'radxa-measured');
await p.reload();await p.waitForFunction(()=>document.querySelector('#ssh-log').textContent.includes('radxa-measured'));assert.equal(await p.locator('#ssh-password').inputValue(),'');assert.ok(await p.locator('[data-ssh-check=system]').isDisabled());
await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
assert.equal(await p.locator('.ssh-panel').evaluate(e=>/[\u3400-\u9fff]/.test(e.textContent)),false);
if(process.env.SCREENSHOT_DIR)await p.locator('.ssh-panel').screenshot({path:process.env.SCREENSHOT_DIR+'/ssh-mobile.png'});
await p.goto(base+'/commissioning/');await p.waitForFunction(()=>document.querySelector('#ssh-log').textContent.includes('radxa-measured'));assert.match(await p.locator('.ssh-panel h2').textContent(),/实际检查/);
assert.deepEqual(requests.map(r=>r.action),['scan','trust','run']);assert.deepEqual(errors,[]);
console.log('PASS: fingerprint confirmation, password-required checks, password cleared, actual-result rendering, hostname apply, reload restores results without retry, Chinese/English/mobile. Mock transport only; no robot SSH.');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
