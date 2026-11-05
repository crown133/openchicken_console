const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const base=process.env.CONSOLE_URL;
  await page.goto(base+'/en/?mode=monitor');
  await page.waitForSelector('[data-workspace=commissioning]:enabled');
  assert.equal(await page.locator('#mouth-pwm').count(),1);
  assert.equal(await page.locator('#mouth-pwm').isVisible(),false);
  assert.equal(await page.locator('.schematic-panel #mouth-pwm').count(),0);
  await page.evaluate(async()=>{
   const data=await(await fetch('/api/robots')).json();
   await fetch('/api/robots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',revision:data.revision,robot:{robot_id:'fixture',name:'Fixture',hostname:'fixture',address:'192.0.2.55',ssh_user:'robot',ssh_port:22,state_port:5557,control_port:5558,robot_public_key:'',notes:''}})});
  });
  await page.waitForSelector('[data-robot=fixture]');
  await page.click('[data-workspace=commissioning]');
  await page.waitForFunction(()=>document.documentElement.dataset.page==='commissioning');
  assert.equal(await page.locator('#mouth-pwm').isVisible(),true);
  assert.equal(await page.locator('#mouth-pwm [data-enable]').isDisabled(),true);
  await page.click('[data-workspace=monitor]');
  await page.waitForFunction(()=>document.documentElement.dataset.page==='monitor');
  assert.equal(await page.locator('#mouth-pwm').isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS UI: calibration only visible in Commissioning, removed from Robot Status, offline output disabled, mode switching works.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
