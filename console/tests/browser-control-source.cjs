const {chromium}=require('/home/cyz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-webgl']});
 try{
  const p=await b.newPage({viewport:{width:1500,height:1100}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{
   window.sourceMode='bluetooth';window.machine='Limp';window.sourceReady=true;window.linkConnected=false;window.inputReady=false;window.sent=[];
   const Native=WebSocket;
   window.WebSocket=class extends Native{
    set onmessage(fn){this.callback=fn;super.onmessage=e=>{
     const d=JSON.parse(e.data);
     if(d.type==='state')for(const r of d.robots||[]){r.source='robot';r.protocol='openchicken-runtime-v1';r.control_source={mode:sourceMode,available:sourceReady,bluetooth_connected:linkConnected,input_ready:inputReady};r.online=true;r.controlled=false;r.control_channel='connected';r.bringup=machine;r.enabled=false;}
     fn({data:JSON.stringify(d)});
    };}
    send(raw){const m=JSON.parse(raw);sent.push(m);
     if(m.type==='control_source'){
      sourceMode=m.payload.mode;this.callback({data:JSON.stringify({type:'reply',id:m.id,ok:true,result:{mode:sourceMode,available:true}})});return;
     }
     super.send(raw);
    }
   };
  });
  await p.goto(process.env.CONSOLE_TEST_URL||'http://127.0.0.1:18108/en/');
  await p.locator('#control-source-panel').waitFor();
  await p.waitForFunction(()=>document.querySelector('#control-source-status').textContent.includes('Direct Bluetooth'));
  assert.equal(await p.locator('#control-source').inputValue(),'bluetooth');
  assert.equal(await p.locator('#control-source option[selected]').getAttribute('value'),'bluetooth');
  assert.equal(await p.locator('#control-source option:checked').textContent(),'Direct Bluetooth');
  assert.equal(await p.locator('#control-source-panel label').textContent(),'Control source');
  assert.equal(await p.locator('#control-source-apply').textContent(),'Switch source');
  const englishOnly=async()=>assert.doesNotMatch(await p.locator('#control-source-panel').innerText(),/[\u3400-\u9fff]/u);
  await englishOnly();
  assert.equal(await p.evaluate(()=>sent.filter(m=>m.type==='control_source').length),0,'Opening the page must not switch the robot');
  assert.equal(await p.locator('#claim').isDisabled(),true);
  assert.equal(await p.locator('#start').isDisabled(),true);
  await p.waitForFunction(()=>!document.querySelector('#control-source-apply').disabled);
  await p.locator('#control-source').selectOption('console');await p.locator('#control-source-apply').click();
  await p.waitForFunction(()=>document.querySelector('#control-source-status').textContent.includes('Bluetooth controller blocked'));
  await englishOnly();
  assert.equal(await p.locator('#claim').isDisabled(),false);
  await p.locator('#control-source').selectOption('bluetooth');await p.locator('#control-source-apply').click();
  await p.waitForFunction(()=>document.querySelector('#claim').disabled);
  assert.ok((await p.locator('#control-source-status').textContent()).includes('Waiting for controller'));
  await p.evaluate(()=>linkConnected=true);
  await p.waitForFunction(()=>document.querySelector('#control-source-status').textContent.includes('Input device initializing'));
  await englishOnly();
  await p.evaluate(()=>inputReady=true);
  await p.waitForFunction(()=>document.querySelector('#control-source-status').textContent.includes('Input ready'));
  await englishOnly();
  await p.evaluate(()=>machine='Ready');
  await p.waitForFunction(()=>document.querySelector('#control-source-apply').disabled);
  assert.equal(await p.locator('#start').isDisabled(),false,'Emergency relax remains usable in Bluetooth mode');
  await p.evaluate(()=>{machine='Limp';sourceReady=false;sourceMode='unavailable';});
  await p.waitForTimeout(150);
  assert.equal(await p.locator('#claim').isDisabled(),true);
  assert.equal(await p.locator('#control-source-apply').isDisabled(),true);
  await englishOnly();
  assert.deepEqual(await p.evaluate(()=>sent.filter(m=>m.type==='control_source').map(m=>m.payload.mode)),['console','bluetooth']);
  assert.ok(await p.evaluate(()=>!sent.some(m=>['init','enable','drive','pad_input','pad_command'].includes(m.type))));
  assert.deepEqual(errors,[]);
  console.log('PASS: source switching UI, native default, console gate, Limp restriction, emergency relax, no automatic motion. Simulator fixture only.');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
