import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=new URL('../../',import.meta.url).pathname;
const output='/home/cyz/openchicken/artifacts/console-imu-review-20261029/browser/';
await mkdir(output,{recursive:true});
process.env.TMPDIR='/home/cyz/openchicken/artifacts/t3-browser-tmp';
await mkdir(process.env.TMPDIR,{recursive:true});
const fixture=spawn('/home/cyz/miniconda3/envs/LocoMujoco/bin/python',
  ['-B','-u','console/tests/imus_fixture.py'],{cwd:root,stdio:['pipe','pipe','pipe']});
let log='';
fixture.stdout.on('data',chunk=>{log+=chunk;});
fixture.stderr.on('data',chunk=>{log+=chunk;});
let browser;
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(log)),10000);
    fixture.stdout.on('data',()=>{if(log.includes('FIXTURE_READY')){clearTimeout(timer);resolve();}});
    fixture.on('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}: ${log}`));});
  });
  browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',
    args:['--no-sandbox','--disable-webgl']});
  const page=await browser.newPage({viewport:{width:1500,height:1100}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18089/');
  await page.locator('#mode-banner').filter({hasText:'真实关节只读'}).waitFor();
  assert.equal(await page.locator('#robot-title').textContent(),'test-radxa');
  assert.equal(await page.locator('#machine-source').textContent(),'REAL');
  assert.equal(await page.locator('#machine-state').textContent(),'运控未接入');
  assert.match(await page.locator('#parameters').textContent(),/力矩关闭/);
  assert.match(await page.locator('#parameters').textContent(),/0x01/);
  assert.match(await page.locator('#parameters').textContent(),/-512/);
  assert.match(await page.locator('#metrics').textContent(),/电池电压/);
  assert.match(await page.locator('#metrics').textContent(),/相机/);
  assert.equal(await page.locator('#backend-mode').textContent(),'真实关节只读');
  assert.match(await page.locator('#metrics').textContent(),/14\/14 有效/);
  assert.match(await page.locator('#pose-label').textContent(),/映射待校验/);
  fixture.stdin.write('move\n');
  await page.locator('#joint-detail').filter({hasText:'90.0'}).waitFor();
  fixture.stdin.write('fail\n');
  await page.locator('#metrics').filter({hasText:'13/14 有效'}).waitFor();
  assert.match(await page.locator('#joint-detail').textContent(),/—/);
  fixture.stdin.write('restore\n');
  await page.locator('#metrics').filter({hasText:'14/14 有效'}).waitFor();
  for(const id of ['start','claim','enable','stop'])assert.equal(await page.locator('#'+id).isDisabled(),true);
  assert.match(await page.locator('#head-imu-raw').textContent(),/BMI088.*m\/s².*rad\/s/);
  assert.match(await page.locator('#imu-raw').textContent(),/LSM6DSV16X.*m\/s².*rad\/s/);
  for(const id of ['imu-roll','imu-pitch','imu-yaw','head-imu-roll','head-imu-pitch','head-imu-yaw'])assert.equal(await page.locator('#'+id).textContent(),'—');
  fixture.stdin.write('imu_fail_head\n');
  await page.locator('#head-imu-status').filter({hasText:'无效'}).waitFor();
  assert.match(await page.locator('#head-imu-raw').textContent(),/— \/ — \/ —/);
  assert.match(await page.locator('#imu-status').textContent(),/等待四元数/);
  fixture.stdin.write('imu_fail_body\n');
  await page.locator('#imu-status').filter({hasText:'无效'}).waitFor();
  assert.match(await page.locator('#head-imu-status').textContent(),/等待四元数/);
  fixture.stdin.write('imu_restore\n');
  await page.locator('#imu-status').filter({hasText:'等待四元数'}).waitFor();
  await page.locator('.review-tools summary').click();
  await page.locator('#freeze').click();
  assert.match(await page.locator('#mode-banner').textContent(),/画面已定格/);
  await page.locator('#freeze').click();
  await page.locator('#record').click();
  await page.waitForTimeout(2200);
  await page.locator('#record').click();
  await page.locator('#history').click();
  await page.locator('#recordings button').first().click();
  await page.locator('#mode-banner').filter({hasText:'历史回放'}).waitFor();
  assert.equal(await page.locator('#machine-source').textContent(),'REAL');
  assert.equal(await page.locator('#start').isDisabled(),true);
  await page.reload();
  await page.locator('#mode-banner').filter({hasText:'真实关节只读'}).waitFor();
  await page.screenshot({path:output+'local-fixture-live.png',fullPage:true});
  fixture.stdin.write('stop\n');
  await page.locator('#machine-state').filter({hasText:'离线'}).waitFor({timeout:8000});
  assert.doesNotMatch(await page.locator('#metrics').textContent(),/42\.5/);
  assert.match(await page.locator('#joint-detail').textContent(),/—/);
  assert.match(await page.locator('#head-imu-raw').textContent(),/— \/ — \/ —/);
  assert.match(await page.locator('#imu-raw').textContent(),/— \/ — \/ —/);
  await page.screenshot({path:output+'local-fixture-offline.png',fullPage:true});
  fixture.stdin.write('restart\n');
  await page.locator('#mode-banner').filter({hasText:'真实关节只读'}).waitFor({timeout:8000});
  await page.goto('http://127.0.0.1:18089/en/');
  await page.locator('#machine-state').filter({hasText:'Motion runtime disconnected'}).waitFor();
  assert.equal(await page.locator('#start').isDisabled(),true);
  assert.deepEqual(errors,[]);
  await writeFile(output+'results.json',JSON.stringify({passed:true,
    scope:'Local fake IMUs, DXL and procfs over CURVE; WebGL disabled; no hardware access',
    checks:['two named IMUs and SI units','independent sensor failure/recovery','uncalibrated Euler stays unknown','offline raw values cleared','real-source badge','raw angle conversion and torque off','per-servo voltage and mean','single servo timeout/recovery','reference pose until mapping verified','all controls disabled','freeze',
      'joint and voltage recording and replay','offline metrics cleared','agent restart','English status','no JS errors']},null,2)+'\n');
  console.log('IMU browser fixture checks passed. No robot accessed.');
} finally {
  if(browser)await browser.close();
  fixture.stdin.end('quit\n');
  await new Promise(resolve=>fixture.exitCode!==null?resolve():fixture.once('exit',resolve));
  await writeFile(output+'fixture.log',log);
}
