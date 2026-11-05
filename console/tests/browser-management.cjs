const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-webgl']});
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.CONSOLE_URL||'http://127.0.0.1:18106';
 try{
 await page.goto(base+'/en/commissioning/');
 await page.waitForSelector('.management-tabs');
 const row=await page.evaluate(async()=>{
  let data=await(await fetch('/api/robots')).json();let row=data.robots.find(r=>r.robot_id==='management-fixture');
  if(!row){data=await(await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:data.revision,robot:{robot_id:'management-fixture',name:'Management fixture',hostname:'fixture',address:'192.0.2.44',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:'Isolated browser test'}})})).json();row=data.robots.find(r=>r.robot_id==='management-fixture');}return row;
 });
 await page.goto(base+'/en/commissioning/?robot=management-fixture');await page.waitForSelector('.management-tabs');
 await page.click('[data-tab=policies]');await page.waitForSelector('[data-settings] input',{state:'attached'});
 assert.equal(await page.locator('.commissioning-panel').isVisible(),false);
 assert.ok(await page.locator('#viewer').isVisible());assert.ok(await page.locator('[data-upload]').isVisible());
 await page.locator('[data-upload] [name=model]').setInputFiles({name:'fixture.onnx',mimeType:'application/octet-stream',buffer:Buffer.alloc(16384,1)});
 assert.equal(await page.locator('[data-upload] [name=command], [data-upload] [name=unwind], [data-upload] [name=unwind_s]').count(),0);
 assert.equal(await page.locator('[data-upload] [name=duration]').inputValue(),'');
 await page.locator('[data-upload] [name=duration]').fill('4');
 await page.locator('[data-upload] [name=name]').fill('fixture_bow');await page.locator('[data-upload] button').click();
 await page.waitForFunction(()=>document.querySelector('[data-version]')?.options.length>0);
 assert.match(await page.locator('[data-versions]').textContent(),/not_attempted/);
 const fs=require('node:fs'),path=require('node:path');
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../integration/examples/policy-package.example.json'),'utf8'));
 manifest.openchicken.execution.command=[.2,.1,.3];manifest.command.idle=[.1,0,0];manifest.unwind_s=2;
 await page.locator('[data-upload] [name=manifest]').setInputFiles({name:'policy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
 await page.waitForFunction(()=>document.querySelector('[data-upload] [name=name]').value==='polite_bow');
 await page.locator('[data-upload] [name=duration]').fill('6');
 // Editing raw JSON cannot reintroduce removed parameters in the effective package.
 await page.locator('[data-upload] [name=manifest_json]').fill(JSON.stringify(manifest));
 await page.locator('[data-upload] button').click();
 await page.waitForFunction(()=>document.querySelector('[data-version]')?.options.length===2);
 const imported=await page.evaluate(async id=>(await(await fetch(`/api/robots/${id}/management`)).json()).versions.find(v=>v.params.name==='polite_bow'),row.id);
 assert.equal(imported.params.duration,6);assert.equal(imported.manifest.duration_s,6);assert.ok(imported.original_manifest_sha256);
 assert.deepEqual(imported.params.command,[0,0,0]);assert.deepEqual(imported.params.unwind,[0,0,0]);assert.equal(imported.params.unwind_s,0);
 assert.deepEqual(imported.manifest.openchicken.execution.command,[0,0,0]);assert.deepEqual(imported.manifest.command.idle,[0,0,0]);assert.equal(imported.manifest.unwind_s,0);
 const tracking=JSON.parse(fs.readFileSync(path.join(__dirname,'../integration/examples/tracking-package.example.json'),'utf8'));
 await page.locator('[data-upload] [name=manifest]').setInputFiles({name:'policy_interface.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(tracking))});
 await page.waitForFunction(()=>document.querySelector('[data-upload] [name=name]').value==='tracking_demo');
 await page.locator('[data-upload] button').click();
 await page.waitForFunction(()=>document.querySelector('[data-version]')?.options.length===3);
 const embedded=await page.evaluate(async id=>(await(await fetch(`/api/robots/${id}/management`)).json()).versions.find(v=>v.params.name==='tracking_demo'),row.id);
 assert.equal(embedded.manifest.schema,tracking.schema);assert.deepEqual(embedded.manifest.inputs,tracking.inputs);assert.equal(embedded.manifest.obs_len,undefined);assert.equal(embedded.params.duration,12);
 await page.locator('[data-version]').selectOption(embedded.id);await page.click('[data-op=add_skill]');await page.waitForSelector('.management-preview[open]');assert.match(await page.locator('.management-preview').textContent(),/tracking_demo/);await page.locator('.management-preview [data-close]').click();
 await page.locator('[data-version]').selectOption({label:await page.locator('[data-version] option').filter({hasText:'fixture_bow'}).textContent()});
 await page.click('[data-op=add_skill]');await page.waitForSelector('.management-preview[open]');
 assert.match(await page.locator('.management-preview').textContent(),/fixture_bow/);
 await page.locator('.management-preview [data-close]').click();
 await page.click('[data-tab=pad]');assert.equal(await page.locator('[data-settings]').isVisible(),false);assert.match(await page.locator('[data-pad]').textContent(),/unknown/);
 await page.click('[data-op=pad_pair]');await page.waitForSelector('.management-preview[open]');assert.match(await page.locator('.management-preview').textContent(),/Standard/);await page.locator('.management-preview [data-close]').click();
 await page.locator('[data-betop-classic]').check();
 await page.click('[data-op=pad_pair]');await page.waitForFunction(()=>document.querySelector('[data-error]').textContent.includes('explicit MAC'));
 await page.locator('[data-mac]').fill('AA:BB:CC:DD:EE:FF');await page.locator('[data-mac]').dispatchEvent('change');
 await page.click('[data-op=pad_pair]');await page.waitForSelector('.management-preview[open]');
 assert.match(await page.locator('.management-preview').textContent(),/BETOP Xbox compatibility/);
 assert.match(await page.locator('.management-preview').textContent(),/AA:BB:CC:DD:EE:FF/);
 await page.locator('.management-preview [data-close]').click();
 await page.reload();await page.waitForSelector('.management-tabs');await page.click('[data-tab=pad]');
 assert.equal(await page.locator('[data-betop-classic]').isChecked(),true);
 assert.equal(await page.locator('[data-mac]').inputValue(),'AA:BB:CC:DD:EE:FF');
 await page.click('[data-tab=program]');await page.locator('[name=deploy_repository]').fill('/missing/deploy');await page.locator('[data-repository] button').first().click();await page.waitForFunction(()=>document.querySelector('[data-error]').textContent.includes('deploy.py'));
 await page.click('[data-tab=history]');assert.match(await page.locator('[data-history]').textContent(),/import/);
 await page.click('[data-tab=tests]');assert.ok(await page.locator('.commissioning-panel').isVisible());
 for(const lang of ['en/','']){
  await page.goto(base+'/'+lang+'commissioning/?robot=management-fixture');await page.waitForSelector('.management-tabs');await page.click('[data-tab=policies]');await page.waitForSelector('[data-settings] input',{state:'attached'});
  for(const width of [1600,780,390]){await page.setViewportSize({width,height:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No overflow ${lang} ${width}`);}
 }
 await page.setViewportSize({width:1600,height:1100});await page.goto(base+'/en/?robot=management-fixture');await page.waitForSelector('.management-panel [data-pad]');assert.match(await page.locator('.management-panel').textContent(),/Robot Bluetooth/);
 assert.deepEqual(errors,[]);console.log('PASS management: import, preview-only, unknown Bluetooth, repository validation, history, both languages, responsive tabs; no robot contacted.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
