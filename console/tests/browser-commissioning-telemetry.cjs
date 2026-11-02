const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const base=(process.env.CONSOLE_TEST_URL||'http://127.0.0.1:8097').replace(/\/$/,'');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});try{
 const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],actions=[];page.on('pageerror',e=>errors.push(e.message));
 const id='a'.repeat(32),row={id,robot_id:'fixture-robot',name:'Fixture',hostname:'fixture-host',address:'192.0.2.44',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:'',results:{}};
 let state={config:null,ready:false,matches:false,status:'disconnected',seq:0,age_seconds:null,external_connection:false};
 await page.route('**/api/robots',r=>r.fulfill({json:{revision:1,default_id:id,robots:[row]}}));
 await page.routeWebSocket('**/commissioning/ws',ws=>{const source=ws.connectToServer();source.onMessage(raw=>{const frame=JSON.parse(raw);if(frame.type==='state')frame.robots=[{...(frame.empty_state||frame.robots[0]),empty:false,robot_id:row.robot_id,profile_id:id}];ws.send(JSON.stringify(frame));});});
 await page.route('**/api/commissioning/ssh/**',r=>r.fulfill({json:{trusted:false,busy:false}}));
 await page.route('**/api/commissioning/telemetry/**',async r=>{
  if(r.request().method()==='POST'){
   const action=new URL(r.request().url()).pathname.split('/').at(-1),body=r.request().postDataJSON();actions.push(action);
   if(action==='prepare'){assert.equal(body.protocol,'openchicken-system-t1-v1');state.config={role:'host',robot_id:row.robot_id,hostname:row.hostname,endpoint:'tcp://192.0.2.44:5557',protocol:body.protocol,public_key:'0'.repeat(40),peer_public_key:body.peer_public_key};state.matches=true;state.ready=!!body.peer_public_key;}
   if(action==='connect')state={...state,status:'waiting'};
   if(action==='disconnect')state={...state,status:'disconnected',seq:0,age_seconds:null};
  }
  await r.fulfill({json:state});
 });
 await page.goto(base+'/en/commissioning/');await page.locator('#telemetry-target').filter({hasText:'fixture-robot'}).waitFor();
 assert.ok(await page.locator('#telemetry-connect').isDisabled());
 await page.locator('#telemetry-prepare').click();await page.waitForFunction(()=>document.querySelector('#telemetry-message').textContent.includes('Host settings saved'));
 await page.locator('#telemetry-guide').evaluate(e=>e.open=true);
 const command=await page.locator('#telemetry-pair-command').textContent();assert.match(command,/os\.O_EXCL/);assert.match(command,/fixture-host/);assert.match(command,/0{40}/);assert.doesNotMatch(command,/control_endpoint/);
 require('node:child_process').execFileSync('/home/cyz/miniconda3/envs/LocoMujoco/bin/python',['-c',"import sys; compile(sys.stdin.read(), '<pairing-preview>', 'exec')"],{input:command.split("python3 - <<'PY'\n")[1].replace(/\nPY$/,'')});
 assert.match(await page.locator('#telemetry-start-command').textContent(),/agent.system_agent/);
 await page.locator('#telemetry-peer').fill('1'.repeat(40));await page.locator('#telemetry-prepare').click();await page.waitForFunction(()=>!document.querySelector('#telemetry-connect').disabled);
 await page.locator('#telemetry-protocol').selectOption('openchicken-joints-t3-v1');assert.ok(await page.locator('#telemetry-connect').isDisabled());
 await page.locator('#telemetry-protocol').selectOption('openchicken-system-t1-v1');await page.locator('#telemetry-connect').click();await page.waitForFunction(()=>document.querySelector('#telemetry-status').textContent.includes('Waiting'));
 assert.ok(await page.locator('#telemetry-prepare').isDisabled());state={...state,status:'receiving',seq:42,age_seconds:.02};await page.waitForFunction(()=>document.querySelector('#telemetry-status').textContent.includes('Receiving'));
 state={...state,status:'stale',age_seconds:4};await page.waitForFunction(()=>document.querySelector('#telemetry-status').textContent.includes('stale'));
 await page.locator('#telemetry-disconnect').click();await page.waitForFunction(()=>document.querySelector('#telemetry-status').textContent==='Disconnected');
 for(const stage of [7,8]){await page.locator(`[data-stage="${stage}"]`).click();assert.equal(await page.locator('.monitor-handoff').getAttribute('href'),'/en/?robot=fixture-robot');assert.equal(await page.locator('.monitor-handoff').getAttribute('target'),'_blank');}
 assert.equal(await page.locator('.telemetry-panel').evaluate(e=>/[\u3400-\u9fff]/.test(e.textContent)),false);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.locator('.telemetry-panel .ssh-controls').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 if(process.env.SCREENSHOT_DIR)await page.locator('.telemetry-panel').screenshot({path:process.env.SCREENSHOT_DIR+'/telemetry-mobile.png'});
 await page.goto(base+'/commissioning/');await page.locator('#telemetry-target').filter({hasText:'fixture-robot'}).waitFor();assert.match(await page.locator('.telemetry-panel h2').textContent(),/早期 ZMQ/);
 assert.deepEqual(actions,['prepare','prepare','connect','disconnect']);assert.deepEqual(errors,[]);
 console.log('PASS: early telemetry setup, generated pairing instructions, unsaved settings guard, waiting/receiving/stale, disconnect, N08/N09 monitor links, English/Chinese/mobile. Browser transport mocked.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
