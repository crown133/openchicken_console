const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-webgl']});
 const page=await browser.newPage({viewport:{width:1500,height:1000}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.CONSOLE_URL||'http://127.0.0.1:18108';
 try{
  await page.goto(base+'/en/');await page.waitForSelector('[data-workspace=commissioning]:enabled');
  await page.evaluate(async()=>{
   const data=await(await fetch('/api/robots')).json();
   await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:data.revision,robot:{robot_id:'fixture',name:'Fixture',hostname:'fixture',address:'192.0.2.55',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:''}})});
  });
  await page.waitForSelector('[data-robot=fixture]');
  await page.evaluate(()=>{window.originalViewer=document.querySelector('#viewer');window.originalChart=document.querySelector('#chart');window.documentMarker='same-document';});
  const initialPages=page.context().pages().length;
  await page.click('[data-workspace=commissioning]');await page.waitForSelector('[data-test-card=system]');
  assert.equal(new URL(page.url()).pathname,'/en/');assert.equal(new URL(page.url()).searchParams.get('mode'),'commissioning');
  assert.equal(await page.locator('#start').isVisible(),false);
  await page.click('[data-stage="2"]');await page.waitForSelector('.servo-audit [data-joint]');
  await page.fill('[name=offset-0]','23');
  await page.click('[data-workspace=monitor]');await page.waitForSelector('.control-panel');
  assert.equal(await page.locator('.management-tabs').isVisible(),false);
  assert.equal(await page.locator('.commissioning-panel').isVisible(),false);
  await page.click('[data-workspace=commissioning]');await page.waitForSelector('.servo-audit [data-joint]');
  assert.equal(await page.locator('[name=offset-0]').inputValue(),'23');
  assert.equal(await page.evaluate(()=>documentMarker==='same-document'&&originalViewer===document.querySelector('#viewer')&&originalChart===document.querySelector('#chart')),true);
  assert.equal(page.context().pages().length,initialPages);
  // A separate read-only session cannot invoke control even if it bypasses the UI.
  const reply=await page.evaluate(()=>new Promise((resolve,reject)=>{
   const ws=new WebSocket(`ws://${location.host}/ws?mode=commissioning`);
   ws.onopen=()=>ws.send(JSON.stringify({id:'forbidden',type:'init',robot_id:'robot',sent_at:Date.now()}));
   ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id==='forbidden'){ws.close();resolve(d);}};ws.onerror=reject;
  }));
  assert.equal(reply.ok,false);assert.match(reply.error,/read-only/);
  await page.screenshot({path:'/tmp/openchicken-unified-workspace.png',fullPage:true});
  await page.reload();await page.waitForSelector('[data-test-card=system]');
  assert.equal(await page.locator('[data-workspace=commissioning]').getAttribute('aria-pressed'),'true');
  await page.goto(base+'/en/commissioning/?robot=fixture');await page.waitForSelector('[data-test-card=system]');
  assert.equal(new URL(page.url()).pathname,'/en/');assert.equal(new URL(page.url()).searchParams.get('mode'),'commissioning');
  await page.goto(base+'/');await page.waitForSelector('[data-workspace=commissioning]:enabled');
  await page.click('[data-workspace=commissioning]');await page.waitForSelector('[data-test-card=system]');
  assert.match(await page.locator('[data-test-card=system]').innerText(),/系统身份/);
  assert.deepEqual(errors,[]);
  console.log('PASS unified workspace: same document/views, preserved N03 edits, read-only backend, legacy links, refresh, English/Chinese; no robot connected.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
