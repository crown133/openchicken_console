// Uses installed Chrome; controls are tested separately without WebGL on software-only hosts.
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const base=process.env.CONSOLE_URL||'http://127.0.0.1:8088';
const output=new URL('../../artifacts/console-status-review/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
const launch=extra=>chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--enable-unsafe-swiftshader',...extra]});
const errors=[];
async function englishOnly(page) {
  const leftovers=await page.evaluate(()=>{
    const nodes=[...document.querySelectorAll('body *')].filter(n=>!n.closest('script,style'));
    return nodes.flatMap(n=>[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent).concat([n.getAttribute('aria-label')||'',n.getAttribute('title')||''])).filter(s=>/[\u3400-\u9fff]/u.test(s));
  });
  assert.deepEqual(leftovers,[],'English page has untranslated text');
}
let browser=await launch(['--disable-webgl']);
try {
  const page=await browser.newPage({viewport:{width:1600,height:1100}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/en/');
  await page.locator('#robot-title').filter({hasText:'demo-01'}).waitFor();
  await englishOnly(page);
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.match(await page.locator('.brand span').textContent(),/Make Life a Little More Fun\./);
  assert.equal(await page.locator('#record').isVisible(),false);
  assert.equal(await page.locator('.toolbar button').count(),1);
  await page.locator('#start').click();
  await page.locator('#start.estop-button').filter({hasText:'E-stop'}).waitFor();
  await page.locator('#machine-state').filter({hasText:'Ready'}).waitFor();
  await page.locator('#enable:enabled').click();
  await page.locator('[data-skill="kick_left"]:enabled').waitFor();
  await page.waitForFunction(()=>document.querySelector('#imu-roll').textContent!=='0.0°');
  await page.locator('[data-skill="kick_left"]').click();
  await page.locator('#action-state').filter({hasText:'Running'}).waitFor();
  await page.locator('#start').click();
  await page.locator('#action-state').filter({hasText:'Cancelled'}).waitFor();
  await page.locator('#start.start-button:enabled').waitFor();
  assert.equal(await page.locator('[data-key="KeyW"]').isDisabled(),true);
  await englishOnly(page);
  await page.locator('[data-robot="openchicken1"]').click();
  assert.equal(await page.locator('#start').isDisabled(),true);
  assert.equal(await page.locator('#imu-roll').textContent(),'—');
  await englishOnly(page);
  await page.locator('.review-tools summary').click();
  await page.locator('#history').click();
  await page.locator('#history-dialog').waitFor();
  await englishOnly(page);
  await page.locator('#close-history').click();
  console.log('English UI / simulated start, action cancellation, E-stop and read-only snapshot passed (WebGL disabled).');
} finally {await browser.close();}
browser=await launch([]);
try {
  const page=await browser.newPage({viewport:{width:1600,height:1100}});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
  await page.goto(base+'/en/');
  await page.locator('#viewer[data-loaded=true]').waitFor({timeout:90000});
  await page.waitForFunction(()=>!document.querySelector('#viewer').getContext('webgl2').isContextLost());
  await page.waitForTimeout(2000);
  await englishOnly(page);
  const model=await page.evaluate(async()=>{
    const THREE=await import('three');
    const {default:Loader}=await import('/vendor/urdf-loader/src/URDFLoader.js');
    const {Viewer}=await import('/src/viewer.js');
    const loader=new Loader();loader.loadMeshCb=(_url,_manager,done)=>done(new THREE.Object3D());
    const robot=loader.parse(await(await fetch('/models/alpha-full/robot.urdf')).text());
    const ghost=robot.clone(), scene=new THREE.Scene(), jointFrame=new THREE.Group();
    const jointAxis=new THREE.ArrowHelper();jointFrame.add(jointAxis);scene.add(robot,ghost,jointFrame);
    const viewer={robot,ghost,jointFrame,jointAxis};
    const state={source:'simulation',online:true,sample_time:1,imu:{valid:true,sample_time:1,frame:'body_to_world',quat:[Math.SQRT1_2,0,0,Math.SQRT1_2]},
      joints:[{id:30,name:'neck_pitch',position:.3491,submitted:.2}]};
    Viewer.prototype.update.call(viewer,state,30,true,true);scene.updateMatrixWorld(true);
    const expected=new THREE.Quaternion(0,0,Math.SQRT1_2,Math.SQRT1_2);
    const actual=robot.links.body_0.getWorldQuaternion(new THREE.Quaternion());
    const ghostQ=ghost.links.body_0.getWorldQuaternion(new THREE.Quaternion());
    const origin=robot.links.body_0.getWorldPosition(new THREE.Vector3());
    const axisError=Math.max(...jointFrame.matrixWorld.elements.map((x,i)=>Math.abs(x-robot.joints.neck_pitch.matrixWorld.elements[i])));
    state.imu.valid=false;Viewer.prototype.update.call(viewer,state,30,true,true);scene.updateMatrixWorld(true);
    return {rotationError:actual.angleTo(expected),ghostError:ghostQ.angleTo(expected),origin:origin.toArray(),axisError,
      resetError:robot.links.body_0.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion())};
  });
  assert.ok(model.rotationError<1e-7 && model.ghostError<1e-7 && model.axisError<1e-7 && model.resetError<1e-7,JSON.stringify(model));
  assert.deepEqual(model.origin,[0,0,.12]);
  for(const [id,y] of [[30,201],[31,177],[32,142],[33,129]]) {
    assert.equal(Number(await page.locator(`[data-joint="${id}"] .node-dot`).getAttribute('cy')),y);
    await page.locator(`[data-joint="${id}"] .node-label-bg`).click();
    assert.equal(await page.locator('#joint-select').inputValue(),String(id));
  }
  await page.screenshot({path:output+'english-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:output+'english-mobile.png',fullPage:true});
  await page.goto(base+'/');
  await page.locator('#viewer[data-loaded=true]').waitFor({timeout:90000});
  await page.setViewportSize({width:1600,height:1100});
  await page.waitForTimeout(2000);
  await page.screenshot({path:output+'chinese-desktop.png',fullPage:true});
  assert.match(await page.locator('.schematic-panel h2').textContent(),/机器人状态/);
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  assert.deepEqual(errors,[]);
  const result={passed:true,model,checks:['English URL and Chinese URL','English static, dynamic, snapshot and dialog text',
    'simulated start / action cancellation / E-stop without WebGL','hardware snapshot buttons disabled',
    'IMU numeric updates / unknown state','body and ghost quaternion / fixed body origin / joint axes / invalid-data reset',
    'four URDF-referenced head and neck anchors','English desktop and 390px mobile layout','slogan','no JS or HTTP errors'],
    limitation:'Control interactions tested with WebGL disabled; real WebGL validated separately due to software renderer latency. No hardware IMU or E-stop connected.'};
  await writeFile(output+'results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser.close();}
