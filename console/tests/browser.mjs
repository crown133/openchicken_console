// Uses an already-installed Playwright and Chrome; never downloads a browser.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const uiOnly = process.env.CONSOLE_UI_ONLY === '1';
const output = new URL('../../artifacts/console-light-review/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'], env: {...process.env, TMPDIR: output}});
const context = await browser.newContext({viewport: {width: 1600, height: 1100}, deviceScaleFactor: 1});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const failures = [], httpFailures = [];
page.on('pageerror', error => failures.push(error.message));
page.on('response', response => {if(response.status() >= 400)httpFailures.push(`${response.status()} ${response.url()}`);});
try {
  const response = await page.goto('http://127.0.0.1:8088/');
  assert.equal(response.status(), 200);
  await page.locator('#robot-title').filter({hasText:'demo-01'}).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.joint-node').length===14 && document.querySelectorAll('.robot-card').length===4);
  await page.locator('#viewer[data-loaded="true"]').waitFor();
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('#model-error').isVisible(),false);
  const layout=await page.evaluate(async()=>{
    const image=new Image();image.src=document.querySelector('#schematic image').getAttribute('href');await image.decode();
    const model=document.querySelector('.model-panel').getBoundingClientRect();
    const fleet=document.querySelector('.fleet').getBoundingClientRect();
    const status=document.querySelector('.schematic-panel').getBoundingClientRect();
    return {modelRight:model.right,modelTop:model.top,modelBottom:model.bottom,fleetBottom:fleet.bottom,statusLeft:status.left,statusTop:status.top,statusBottom:status.bottom,background:getComputedStyle(document.body).backgroundColor,
      schematicWidth:image.naturalWidth,stage:getComputedStyle(document.querySelector('.viewport')).backgroundImage};
  });
  assert.ok(layout.fleetBottom<layout.modelTop, 'robot fleet must be above the monitoring panels');
  assert.ok(layout.statusLeft>layout.modelRight && Math.abs(layout.statusTop-layout.modelTop)<1 && Math.abs(layout.statusBottom-layout.modelBottom)<1, 'URDF and robot status panels must align');
  assert.equal(layout.background,'rgb(242, 244, 245)');
  assert.equal(layout.schematicWidth,1024);
  assert.ok(layout.stage.includes('39, 51, 61'), 'preserve existing stage background');
  for(const id of [10,11,12,13,14,20,21,22,23,24,30,31,32,33]){
    await page.locator(`[data-joint="${id}"] .node-label-bg`).click();
    assert.equal(await page.locator('#joint-select').inputValue(),String(id));
    assert.equal(await page.locator(`[data-joint="${id}"]`).getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('#joint-detail').innerText(),new RegExp(`ID ${id} ·`));
  }
  await page.locator('[data-joint="13"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#joint-select').inputValue(),'13');
  await page.screenshot({path:output+'desktop.png',fullPage:true});
  await page.locator('.review-tools summary').click();
  if (!uiOnly) {
    await page.locator('#claim').click();
    await page.locator('#control-state').filter({hasText:'已接管'}).waitFor();
    if(await page.locator('#machine-state').textContent()==='Limp')await page.locator('#start').click();
    await page.locator('#machine-state').filter({hasText:'Ready'}).waitFor();
    if(await page.locator('#enable').isEnabled())await page.locator('#enable').click();
    await page.locator('[data-key="KeyW"]:enabled').waitFor();
    await page.locator('#record').click();
    await page.locator('#record').filter({hasText:'结束录制'}).waitFor();
    const before = await page.locator('[data-joint="13"] .node-value').textContent();
    await page.keyboard.down('w');
    await page.waitForTimeout(500);
    const after = await page.locator('[data-joint="13"] .node-value').textContent();
    assert.notEqual(before, after, 'keyboard must change simulated feedback');
    await page.keyboard.up('w');
    await page.locator('#stop').click();
    await page.locator('[data-skill="kick_left"]').click();
    await page.locator('#action-state').filter({hasText:'已完成'}).waitFor();
    await page.locator('#ghost').check();
    await page.locator('#record').click();
    await page.locator('#record').filter({hasText:'开始录制'}).waitFor();
    await page.locator('#freeze').click();
    await page.locator('#mode-banner').filter({hasText:'画面已定格'}).waitFor();
    assert.equal(await page.locator('#claim').isDisabled(),true);
    await page.locator('#freeze').click();
    await page.locator('[data-robot="openchicken1"]').click();
    await page.locator('#mode-banner').filter({hasText:'历史配置快照'}).waitFor();
    assert.equal(await page.locator('#claim').isDisabled(),true);
    assert.match(await page.locator('#parameters').textContent(),/400 \/ 0 \/ 0/);
    await page.locator('[data-robot="demo-02"]').click();
    await page.locator('#claim').click();
    await page.locator('#control-state').filter({hasText:'已接管'}).waitFor();
    await page.locator('[data-robot="demo-03"]').click();
    await page.locator('#control-state').filter({hasText:'尚未接管'}).waitFor();
    await page.locator('#history').click();
    await page.locator('.record-row button').first().click();
    await page.locator('#replay-bar').waitFor();
    assert.equal(await page.locator('#claim').isDisabled(),true);
    await page.locator('#play').click();
    await page.waitForTimeout(250);
    assert.ok(Number(await page.locator('#seek').inputValue())>0);
    await page.locator('#exit-replay').click();
  }
  await page.locator('#freeze').click();
  await page.locator('#mode-banner').filter({hasText:'画面已定格'}).waitFor();
  assert.equal(await page.locator('#claim').isDisabled(),true);
  await page.locator('#freeze').click();
  await page.locator('[data-robot="openchicken1"]').click();
  await page.locator('#pose-label').filter({hasText:'参考站姿'}).waitFor();
  assert.equal(await page.locator('#claim').isDisabled(),true);
  assert.match(await page.locator('#parameters').textContent(),/400 \/ 0 \/ 0/);
  await page.locator('[data-robot="demo-01"]').click();
  await page.locator('#joint-axes').check();
  await page.locator('#axis-info').waitFor();
  for(const view of ['front','side','top'])await page.locator(`[data-view="${view}"]`).click();
  await page.locator('#reset-camera').click();
  await page.locator('#joint-axes').uncheck();
  for(const width of [1280,1024,768]){
    await page.setViewportSize({width,height:1000});
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), `layout must fit ${width}px`);
  }
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(250);
  await page.locator('[data-joint="24"] .node-label-bg').click();
  assert.equal(await page.locator('#joint-select').inputValue(),'24');
  await page.screenshot({path:output+'mobile.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'mobile page must fit viewport');
  assert.deepEqual(failures,[]);
  assert.deepEqual(httpFailures,[]);
  const result={passed:true, mode:uiOnly?'read-only UI':'full simulated interaction',
    checks:['light theme / fleet above aligned panels / unchanged stage background','schematic asset loads',
      'all 14 joint selections link to chart and details','keyboard joint selection',
      '390 / 768 / 1024 / 1280px layouts','URDF and meshes load','14 joints / 4 robots',
      'freeze / read-only snapshot','joint axes / camera buttons','no JS/HTTP errors'],
    controlChecks:uiOnly?'not run in this mode':['keyboard feedback changes','action completes',
      'recording','freeze releases control','robot switching releases control','history playback']};
  await writeFile(output+(uiOnly?'ui-results.json':'browser-results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} catch(error) {
  console.error(await page.locator('#control-state').textContent(),await page.locator('#toast').textContent());
  await page.screenshot({path:output+'failure.png',fullPage:true});
  throw error;
} finally {
  if(failures.length || httpFailures.length)console.error({failures,httpFailures});
  await browser.close();
}
