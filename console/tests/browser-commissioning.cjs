const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 const base=process.env.CONSOLE_TEST_URL||'http://127.0.0.1:8095/';
 try{
  const context=await browser.newContext({viewport:{width:1600,height:1100}}),p=await context.newPage(),errors=[];
  context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));p.on('pageerror',e=>errors.push(e.message));
  await p.goto(new URL('en/',base).href);await p.locator('.joint-node').first().waitFor();
  assert.equal(await p.locator('.robot-card.selected .badge').textContent(),'SIM','Use isolated simulation only');
  const name='qa-'+Date.now();
  await p.locator('#new-robot').click();await p.locator('[name=robot_id]').fill(name);
  await p.locator('[name=name]').fill('New robot QA');await p.locator('[name=address]').fill('192.168.3.182');
  await p.locator('[name=hostname]').fill('radxa-new');await p.locator('[name=ssh_user]').fill('robot');
  await p.locator('#dossier-form [type=submit]').click();await p.waitForFunction(id=>document.querySelector('#robot-title').textContent===id,name);
  assert.equal(await p.locator('.robot-card.selected .badge').textContent(),'DRAFT');
  assert.ok(await p.locator('#start').isDisabled());assert.match(await p.locator('#mode-banner').textContent(),/no real samples/);
  await p.locator('#manage-robots').click();const row=p.locator('.dossier-row').filter({hasText:name});
  await row.locator('[data-default]').click();await p.locator('#robot-manager [data-close]').click();
  const q=await context.newPage();await q.goto(new URL('en/commissioning/',base).href);
  await q.waitForFunction(id=>document.querySelector('#robot-title').textContent===id,name);
  assert.ok(await q.locator('.model-panel').isVisible());assert.ok(await q.locator('.schematic-panel').isVisible());assert.ok(await q.locator('.chart-panel').isVisible());
  assert.ok(await q.locator('.control-panel').isHidden());assert.ok(await q.locator('#start').isHidden());
  assert.equal(await q.locator('[data-stage]').count(),10);assert.equal(await q.locator('[data-item]').count(),3);
  await q.locator('[data-stage="2"]').click();await q.locator('[data-item="2"]').click();
  await q.locator('#test-result [name=status]').selectOption('deferred');await q.locator('#test-result [name=notes]').fill('QA record only; no physical tests. Waiting for assembly.');
  await q.locator('#test-result [type=submit]').click();await q.waitForFunction(()=>document.querySelector('#result-message').textContent==='Operator record saved');
  await q.reload();await q.locator('[data-stage="2"]').click();await q.locator('[data-item="2"]').click();
  assert.equal(await q.locator('#test-result [name=status]').inputValue(),'deferred');
  assert.match(await q.locator('#test-result [name=notes]').inputValue(),/no physical tests/);
  // Two stale editors cannot overwrite each other.
  await p.bringToFront();await p.locator('#manage-robots').click();await row.locator('[data-edit]').click();
  await q.bringToFront();await q.locator('#manage-robots').click();await q.locator('.dossier-row').filter({hasText:name}).locator('[data-edit]').click();
  await q.locator('#dossier-form [name=name]').fill('Updated in test window');await q.locator('#dossier-form [type=submit]').click();await q.waitForFunction(()=>!document.querySelector('#robot-editor').open);
  await p.bringToFront();await p.locator('#dossier-form [name=name]').fill('Stale edit');await p.locator('#dossier-form [type=submit]').click();
  await p.waitForFunction(()=>document.querySelector('#dossier-error').textContent.includes('another window'));
  await p.locator('#robot-editor [data-close]').click();await p.locator('#robot-manager [data-close]').click();
  // A forged control request sent through the test stream is rejected by the server.
  assert.equal(await q.evaluate(async()=>{
   const ws=new WebSocket(`ws://${location.host}/commissioning/ws`);
   return await new Promise(resolve=>{ws.onopen=()=>ws.send(JSON.stringify({id:'no-motion',type:'init',robot_id:'demo-01'}));ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id==='no-motion'){ws.close();resolve(r.ok);}};});
  }),false);
  await q.bringToFront();await q.locator('#theme-toggle').click();
  if(process.env.SCREENSHOT_DIR)await q.screenshot({path:process.env.SCREENSHOT_DIR+'/commissioning-dark.png',fullPage:true});
  await q.setViewportSize({width:390,height:844});assert.ok(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.SCREENSHOT_DIR)await q.locator('.commissioning-panel').screenshot({path:process.env.SCREENSHOT_DIR+'/commissioning-mobile.png'});
  assert.equal(await q.locator('.commissioning-panel').evaluate(e=>/[\u3400-\u9fff]/.test(e.textContent)),false);
  await q.goto(new URL('commissioning/',base).href);await q.locator('[data-stage]').first().waitFor();
  assert.match(await q.locator('.commissioning-panel h2').first().textContent(),/新机/);
  // Delete the draft, retain archived history, and synchronize the other page.
  await q.locator('#manage-robots').click();q.once('dialog',d=>d.accept());
  await q.locator('.dossier-row').filter({hasText:name}).locator('[data-delete]').click();
  await q.waitForFunction(id=>!Array.from(document.querySelectorAll('.robot-card')).some(e=>e.dataset.robot===id),name);
  await p.bringToFront();await p.waitForFunction(id=>!Array.from(document.querySelectorAll('.robot-card')).some(e=>e.dataset.robot===id),name);
  assert.deepEqual(errors,[]);
  console.log('PASS: create/select/default/reload, shared dossier updates, conflict rejection, retained test records, observer command rejection, themes/languages/mobile, deletion sync. No SSH or hardware execution.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
