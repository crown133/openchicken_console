const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-webgl']});
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],remote=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST'&&/ssh\/run|management\/run/.test(r.url()))remote.push(r.url());});
 const base=process.env.CONSOLE_URL||'http://127.0.0.1:18108';
 try{
  await page.goto(base+'/en/?mode=commissioning');await page.waitForSelector('[data-workspace=monitor]:enabled');
  const saved=await page.evaluate(async()=>{
   const data=await(await fetch('/api/robots')).json();
   return await(await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:data.revision,robot:{robot_id:'servo-fixture',name:'Fixture',hostname:'fixture',address:'192.0.2.55',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:''}})})).json();
  });
  const row=saved.robots.find(r=>r.robot_id==='servo-fixture');
  row.servo_audit={latest:{source:'ssh_readback',captured_at:'2026-11-04T01:02:03Z',target:{address:row.address,port:22,user:'robot'},rows:[{name:'right_knee',expected:{id:13},fields:{id_register:13,position_p_gain:200,position_i_gain:0,position_d_gain:0,pwm_slope:255,pwm_limit:885,homing_offset:-12,drive_mode:1,torque:1,hardware_error:4}}]}};
  saved.revision+=10;
  await page.route('**/api/robots',r=>r.request().method()==='GET'?r.fulfill({json:saved}):r.continue());
  await page.waitForFunction(()=>document.querySelector('[data-parameter=p] b')?.textContent==='200');
  assert.match(await page.locator('[data-parameter-source]').innerText(),/N03 measured snapshot.*2026-11-04T01:02:03Z.*Not live/);
  assert.equal(await page.locator('[data-parameter=torque] b').innerText(),'—');
  assert.equal(await page.locator('[data-parameter=error] b').innerText(),'—');
  row.servo_audit.latest.rows[0].fields.position_p_gain=250;saved.revision++;
  await page.click('[data-refresh-parameters]');
  await page.waitForFunction(()=>document.querySelector('[data-parameter=p] b')?.textContent==='250');
  await page.click('[data-open-readback]');await page.waitForSelector('.servo-audit [data-joint]');
  assert.match(await page.locator('.stage-heading').innerText(),/N03/);
  await page.click('[data-workspace=monitor]');await page.waitForSelector('.control-panel');
  assert.equal(await page.locator('[data-parameter=p] b').innerText(),'250');
  await page.click('[data-open-readback]');await page.waitForSelector('.servo-audit [data-joint]');
  assert.equal(await page.locator('[data-workspace=commissioning]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
  console.log('PASS parameter panel: snapshot/time, local reload, N03 navigation from both modes; no SSH execution.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
