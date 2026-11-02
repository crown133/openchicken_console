// Read-only browser QA: no simulator command, enable, record or hardware path.
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const output=new URL('../../artifacts/console-model-inspection/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
const fixture=JSON.parse(await readFile(new URL('../../artifacts/console-model-review/reference-poses.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,
  args:['--no-sandbox','--enable-unsafe-swiftshader'],env:{...process.env,TMPDIR:output}});
const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
try {
  await page.goto('http://127.0.0.1:8088/');
  await page.locator('#viewer[data-loaded="true"]').waitFor({timeout:90000});
  await page.waitForTimeout(1200);
  const result=await page.evaluate(async fixture=>{
    const THREE=await import('three');
    const {default:Loader}=await import('/vendor/urdf-loader/src/URDFLoader.js');
    const loader=new Loader();
    loader.loadMeshCb=(_url,_manager,done)=>done(new THREE.Object3D());
    const robot=loader.parse(await (await fetch('/models/alpha-full/robot.urdf')).text());
    for(const joint of Object.values(robot.joints))joint.ignoreLimits=true;
    let compared=0,maxError=0;
    for(const test of fixture){
      robot.setJointValues(test.angles);robot.updateMatrixWorld(true);
      for(const [name,expected] of Object.entries(test.matrices)){
        const actual=robot.frames[name]?.matrixWorld.elements;
        if(!actual)throw new Error(`Missing frame ${name}`);
        for(let row=0;row<4;row++)for(let col=0;col<4;col++)
          maxError=Math.max(maxError,Math.abs(actual[col*4+row]-expected[row][col]));
        compared++;
      }
    }
    const clone=robot.clone();
    const original=robot.links.body_14.matrixWorld.clone();
    clone.setJointValues(fixture[1].angles);clone.updateMatrixWorld(true);robot.updateMatrixWorld(true);
    if(!original.equals(robot.links.body_14.matrixWorld))throw new Error('Target ghost changed feedback model');
    const {Viewer}=await import('/src/viewer.js');
    const canvas=document.createElement('canvas');
    canvas.style.cssText='width:300px;height:300px';document.body.append(canvas);
    const viewer=new Viewer(canvas);
    viewer.robot=robot;viewer.ghost=clone;viewer.scene.add(robot,clone);
    const names=Object.keys(fixture[0].angles);
    let axesCompared=0,axesMaxError=0,axisDirectionMaxError=0;
    for(const test of fixture){
      const state={source:'simulation',joints:names.map((name,id)=>({id,name,
        position:test.angles[name],submitted:-test.angles[name]}))};
      for(const joint of state.joints){
        viewer.update(state,joint.id,true,true);viewer.scene.updateMatrixWorld(true);
        const urdfJoint=robot.joints[joint.name];
        const expected=test.matrices[urdfJoint.children[0].name];
        const actual=viewer.jointFrame.matrixWorld.elements;
        for(let row=0;row<4;row++)for(let col=0;col<4;col++)
          axesMaxError=Math.max(axesMaxError,Math.abs(actual[col*4+row]-expected[row][col]));
        const expectedAxis=new THREE.Vector3(...expected.slice(0,3).map(row=>
          row[0]*urdfJoint.axis.x+row[1]*urdfJoint.axis.y+row[2]*urdfJoint.axis.z)).normalize();
        const actualAxis=new THREE.Vector3(0,1,0).transformDirection(viewer.jointAxis.matrixWorld);
        axisDirectionMaxError=Math.max(axisDirectionMaxError,expectedAxis.distanceTo(actualAxis));
        if(viewer.jointFrame.parent!==viewer.scene)throw new Error('Axes entered a model tree');
        axesCompared++;
      }
    }
    const homes=fixture[1].angles;
    const historic={source:'snapshot',model_verified:false,
      manifest:names.map((name,id)=>({id,home:homes[name]})),
      joints:names.map((name,id)=>({id,name,position:2,submitted:2}))};
    viewer.update(historic,0,true,true);
    if(viewer.ghost.visible)throw new Error('Historical snapshot displayed a target pose');
    for(const name of names)if(robot.joints[name].jointValue[0]!==homes[name])
      throw new Error('Inspection used uncalibrated historical position');
    viewer.update(historic,0,false,false);
    if(viewer.jointFrame.visible)throw new Error('Axes did not hide');
    viewer.update(historic,-1,false,true);
    if(viewer.jointFrame.visible)throw new Error('Unknown joint retained visible axes');
    for(const [view,direction] of Object.entries({front:[0,1,0],side:[-1,0,0],top:[0,0,-1]})){
      viewer.setView(view);
      if(viewer.camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(...direction))>2e-6)
        throw new Error(`Incorrect camera direction: ${view}`);
    }
    viewer.reset();
    if(viewer.camera.position.distanceTo(new THREE.Vector3(0.34,-0.42,0.27))>1e-8 || viewer.camera.up.z!==1)
      throw new Error('Camera reset failed after top view');
    viewer.resize.disconnect();viewer.controls.dispose();viewer.renderer.dispose();canvas.remove();
    return {poses:fixture.length,compared,maxError,ghostIndependent:true,
      axesCompared,axesMaxError,axisDirectionMaxError,historicReference:true,cameraViews:true};
  },fixture);
  assert.ok(result.maxError<2e-7,JSON.stringify(result));
  assert.equal(result.axesCompared,420);
  assert.ok(result.axesMaxError<2e-7 && result.axisDirectionMaxError<2e-7,JSON.stringify(result));
  await page.reload();
  await page.locator('#viewer[data-loaded="true"]').waitFor({timeout:90000});
  assert.equal(await page.locator('#axis-info').isVisible(),false);
  await page.locator('#joint-axes').check();
  await page.locator('#joint-select').selectOption('13');
  await page.locator('#axis-joint').filter({hasText:'ID 13 · 右膝 / right_knee'}).waitFor();
  for(const view of ['front','side','top']){
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(100);
    await page.locator('.model-panel').screenshot({path:output+`view-${view}.png`});
  }
  await page.locator('#reset-camera').click();
  await page.locator('[data-joint="24"] .node-label-bg').click();
  await page.locator('#axis-joint').filter({hasText:'ID 24 · 左踝 / left_ankle'}).waitFor();
  await page.screenshot({path:output+'desktop.png',fullPage:true});
  await page.locator('.viewport').screenshot({path:output+'model-home.png'});
  await page.locator('[data-robot="openchicken1"]').click();
  await page.locator('#pose-label').filter({hasText:'参考站姿'}).waitFor();
  await page.locator('.model-panel').screenshot({path:output+'snapshot-reference.png'});
  await page.locator('[data-robot="demo-01"]').click();
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('[data-view="top"]').click();
  await page.screenshot({path:output+'mobile.png',fullPage:true});
  await page.locator('#joint-axes').uncheck();
  assert.equal(await page.locator('#axis-info').isVisible(),false);
  assert.deepEqual(errors,[]);
  result.errors=errors;
  await writeFile(output+'browser-results.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{if(errors.length)console.error(errors);await browser.close();}
