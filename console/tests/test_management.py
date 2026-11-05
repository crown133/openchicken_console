import asyncio
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from aiohttp import FormData
from aiohttp.test_utils import TestClient, TestServer
from host import policy_package as package
from host.management_jobs import ManagementJobs, NativeFailure, settings, program_evidence
from host.policy_management import PolicyManagement
from host.program_deployment import ProgramDeployment
from host.robot_registry import RobotRegistry
from host.server import create_app
from host.ssh_checks import SshChecks, private_json

EXAMPLE=json.loads((Path(__file__).parents[1]/'integration/examples/policy-package.example.json').read_text())
TRACKING=json.loads((Path(__file__).parents[1]/'integration/examples/tracking-package.example.json').read_text())
PASSWORD='test-password-78423'

def registry_at(root):
    registry=RobotRegistry(root/'robots.json')
    robot=dict(robot_id='test_robot',name='Fixture',hostname='test-host',address='192.0.2.2',ssh_user='robot',ssh_port=22,state_port=5557,control_port=5558,robot_public_key='',notes='')
    row=registry.change(dict(action='save',revision=0,robot=robot))['robots'][0]
    return registry,row

class PackageTests(unittest.TestCase):
    def test_tracking_sidecar_and_native_defaults(self):
        value=copy.deepcopy(TRACKING)
        params=package.manifest(value);package.validate_skill(value)
        self.assertEqual(params['duration'],12)
        self.assertEqual(params['command'],[0,0,0])
        self.assertNotIn('obs_len',value)
        value['inputs']['history']['shape']=[1,10,61]
        with self.assertRaisesRegex(ValueError,'history'):package.manifest(value)
        value=copy.deepcopy(TRACKING);value['inputs']['time_step']['dtype']='float32'
        with self.assertRaisesRegex(ValueError,'int64'):package.manifest(value)
        value=copy.deepcopy(TRACKING);value['inputs']['motion_latent']={'shape':[1,32],'dtype':'float32'}
        with self.assertRaises(ValueError):package.manifest(value)
        value=copy.deepcopy(TRACKING);value['reference_storage']='external'
        with self.assertRaises(ValueError):package.manifest(value)
        self.assertEqual(package.manifest(EXAMPLE)['name'],'polite_bow')

    def test_translation_and_unsupported_parameters(self):
        args=package.add_arguments(package.manifest(EXAMPLE),'/policies/model.onnx')
        self.assertNotIn('--json',args);self.assertIn('--hold',args)
        for key,value in [('chain',True),('action_scale',.25),('gain_ratio',.5),('obs_len',60),('duration_s',float('nan'))]:
            manifest=copy.deepcopy(EXAMPLE);manifest[key]=value
            with self.assertRaises(ValueError):package.manifest(manifest)
        with self.assertRaises(ValueError):package.editable({'chain':True})
        with self.assertRaises(ValueError):package.bindings({'keyboard':[{'code':'Space','event':'press'}]})
        with self.assertRaises(ValueError):package.bindings({'browser_gamepad':[{'mapping':'standard','buttons':['LB','B'],'event':'press'}]})

    def test_definition_is_not_runtime_version_proof(self):
        params=package.manifest(EXAMPLE)
        skill={k:v for k,v in params.items() if k!='bindings'};skill['path']='/model.onnx'
        data={'policies':{'enabled':True,'skills':['polite_bow'],'slots':[]},'skills':{'skills':[skill]}}
        self.assertEqual(package.assess(data,'add_skill',params,'/model.onnx'),('confirmed','unknown'))
        data['policies'].update(slots=[{'slot':'walk','path':'/model.onnx','error':None}],enabled=False)
        self.assertEqual(package.assess(data,'load_slot',params,'/model.onnx','walk'),('confirmed','unknown'))
        data['policies']['enabled']=True
        self.assertEqual(package.assess(data,'load_slot',params,'/model.onnx','walk'),('confirmed','confirmed'))
        data['policies']['slots'][0]['error']='shape mismatch'
        self.assertEqual(package.assess(data,'load_slot',params,'/model.onnx','walk')[1],'failed')

class SlotContractTests(unittest.TestCase):
    def test_manifest_kinds_slots_and_units(self):
        value=copy.deepcopy(EXAMPLE)
        value.update(kind='perpetual',slot='walk');value.pop('duration_s')
        self.assertIsNone(package.manifest(value)['duration']);package.validate_slot(value,'walk')
        value['kind']='episodic';value['duration_s']=4
        with self.assertRaisesRegex(ValueError,'perpetual'):package.manifest(value)
        value=copy.deepcopy(EXAMPLE);value['openchicken']['actions']['joint_names'].reverse()
        with self.assertRaisesRegex(ValueError,'Action order'):package.manifest(value)
        value=copy.deepcopy(EXAMPLE);value.update(slot='ground_pick',command={'encoding':'phase','period_s':4,'end_phase':.7})
        package.manifest(value);package.validate_slot(value,'ground_pick')
        with self.assertRaises(ValueError):package.validate_skill(value)
        value=copy.deepcopy(EXAMPLE);value.update(kind='scripted',slot='sitstand',ramp_s=.5,command={'encoding':'posture_flag','sit':1,'stand':0,'slot':0})
        package.manifest(value);package.validate_slot(value,'sitstand')
        result={'policies':{'enabled':True,'slots':[{'slot':'stand','path':None,'overridden':True}]}}
        self.assertEqual(package.assess(result,'disable_slot',{},slot='stand'),('confirmed','confirmed'))

class JobTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.registry,self.row=registry_at(self.root);self.checks=SshChecks(self.registry);self.jobs=ManagementJobs(self.checks)
        self.registry.record_management(self.row['id'],'program_deployment',{'last_query':dict(result={'status':'success','build_id':'test-v1','current_release':'/releases/test-v1'},queried_at='2026-11-03T00:00:00Z',target=self.checks.target(self.row),settings=settings(self.row))})
        private_json(self.checks.trust_path(self.row['id']),dict(target=self.checks.target(self.row),keys=[{'type':'ssh-ed25519','key':'ZmFrZQ==','fingerprint':'fixture'}]))
    async def asyncTearDown(self):
        await self.jobs.close(None);await self.checks.close(None);self.temp.cleanup()
    async def test_special_slots_preview_uses_native_timing_and_socket_defaults(self):
        config=settings(self.row)
        self.assertEqual(config['config_socket'],'/run/configd/configd.sock')
        self.assertEqual(config['pad_config'],config['robot_config'])
        self.assertEqual(settings(dict(self.row,management_settings={'config_socket':'/custom.sock'}))['config_socket'],'/custom.sock')
        policies=PolicyManagement(self.jobs)
        for slot in ('sitstand','ground_pick'):
            value=copy.deepcopy(EXAMPLE);value['slot']=slot
            if slot=='sitstand':value.update(kind='scripted',ramp_s=.5,command={'encoding':'posture_flag','sit':1,'stand':0,'slot':0})
            else:value['command']={'encoding':'phase','period_s':4,'end_phase':.7}
            version='c'*32
            private_json(policies.root(self.row['id'])/'versions'/version/'record.json',dict(id=version,manifest=value,params=package.manifest(value)))
            preview=policies.preview(self.row['id'],'load_slot',{'slot':slot,'version_id':version})
            self.assertEqual(preview['detail']['slot'],slot)
            self.assertIn('model only',preview['detail']['timing'])
    async def test_local_drafts_without_ssh_and_metadata_edit_on_loaded_robot(self):
        current=self.registry.public();robot={k:self.row[k] for k in ('robot_id','name','hostname','address','ssh_user','ssh_port','state_port','control_port','robot_public_key','notes')};robot['ssh_user']=''
        self.registry.change(dict(action='save',revision=current['revision'],id=self.row['id'],robot=robot),reserved={'test_robot'},active={'test_robot'})
        view=PolicyManagement(self.jobs).view(self.row['id']);self.assertEqual(view['versions'],[])
        with self.assertRaisesRegex(ValueError,'SSH user'):self.jobs.context(self.row['id'])
        robot['ssh_user']='robot'
        self.registry.change(dict(action='save',revision=self.registry.public()['revision'],id=self.row['id'],robot=robot),reserved={'test_robot'},active={'test_robot'})
        robot['address']='192.0.2.99'
        with self.assertRaises(ValueError):self.registry.change(dict(action='save',revision=self.registry.public()['revision'],id=self.row['id'],robot=robot),reserved={'test_robot'},active={'test_robot'})

    async def test_busy_target_change_single_use(self):
        token=self.jobs.preview(self.row['id'],'refresh',{})['token'];self.checks.active.add(self.row['id'])
        with self.assertRaisesRegex(ValueError,'Another SSH'):self.jobs.start(self.row['id'],token,PASSWORD,None)
        self.checks.active.clear();self.registry.record_management(self.row['id'],'management_settings',{'robot_socket':'/other.sock'})
        with self.assertRaisesRegex(ValueError,'settings changed'):self.jobs.consume(self.row['id'],token)
        with self.assertRaises(ValueError):self.jobs.consume(self.row['id'],token)
    async def test_password_memory_only_multiple_prompts_and_split_redaction(self):
        job=dict(id='1'*32,profile_id=self.row['id'],target=self.checks.target(self.row),status='running',log=[])
        async with self.jobs.session(job,self.checks.trusted(self.row),PASSWORD) as session:
            self.assertNotIn(PASSWORD,str(session.env))
            for _ in range(2):
                p=await asyncio.create_subprocess_exec(session.env['SSH_ASKPASS'],'robot password:',env=session.env,stdout=asyncio.subprocess.PIPE)
                output,_=await p.communicate();self.assertEqual(output.decode().strip(),PASSWORD)
            for f in session.directory.iterdir():
                if f.is_file():self.assertNotIn(PASSWORD,f.read_text())
            code,out,err=await self.jobs.process([sys.executable,'-c',f"import sys,time;sys.stdout.write({PASSWORD[:6]!r});sys.stdout.flush();time.sleep(.03);print({PASSWORD[6:]!r})"],3,job,PASSWORD)
            self.assertNotIn(PASSWORD,out);self.assertNotIn(PASSWORD,json.dumps(self.jobs.job(job['id'])))
    async def test_structured_digest_survives_password_substring_but_logs_remain_redacted(self):
        password='abc';digest='01abc'+'f'*59
        job=dict(id='5'*32,profile_id=self.row['id'],target=self.checks.target(self.row),status='running',log=[])
        value=dict(fingerprint=digest,diagnostic='password: '+password,after=dict(fingerprint=digest),number=123)
        code,out,err=await self.jobs.process([sys.executable,'-c','print('+repr(json.dumps(value))+')'],3,job,password,sha256_fields=('fingerprint',))
        result=json.loads(out)
        self.assertEqual(code,0);self.assertEqual(result['fingerprint'],digest)
        self.assertEqual(result['after']['fingerprint'],digest)
        self.assertEqual(result['diagnostic'],'password: [redacted]')
        self.assertEqual(result['number'],123)
        saved=self.jobs.job(job['id']);self.assertNotIn(password,json.dumps(saved))
        self.assertNotIn(password,(self.jobs.root/saved['log_file']).read_text())
        # A malformed hash does not get the machine-value exception.
        value['fingerprint']='bad '+password
        _,out,_=await self.jobs.process([sys.executable,'-c','print('+repr(json.dumps(value))+')'],3,job,password,sha256_fields=('fingerprint',))
        self.assertEqual(json.loads(out)['fingerprint'],'bad [redacted]')

    async def test_unknown_requires_query_after_restart(self):
        old=dict(id='2'*32,profile_id=self.row['id'],target=self.checks.target(self.row),operation='add_skill',status='running',mutation_started=True,log=[])
        self.jobs.save(old);restarted=ManagementJobs(self.checks)
        self.assertEqual(restarted.job(old['id'])['status'],'unknown')
        with self.assertRaisesRegex(ValueError,'query actual'):restarted.preview(self.row['id'],'remove_skill',{'name':'bow'})
        restarted.resolve(dict(id='3'*32,profile_id=self.row['id'],target=old['target'],operation='refresh'))
        self.assertIn('token',restarted.preview(self.row['id'],'remove_skill',{'name':'bow'}))
    async def test_dossier_merge_and_archived_completion(self):
        current=self.registry.public();robot={k:self.row[k] for k in ('robot_id','name','hostname','address','ssh_user','ssh_port','state_port','control_port','robot_public_key','notes')};robot['name']='Renamed'
        self.registry.change(dict(action='save',revision=current['revision'],id=self.row['id'],robot=robot))
        self.registry.record_management(self.row['id'],'policy_management',{'latest_job':'fixture'})
        self.assertEqual(self.registry.public()['robots'][0]['name'],'Renamed')
        self.registry.change(dict(action='delete',revision=self.registry.public()['revision'],id=self.row['id']))
        self.registry.record_management(self.row['id'],'policy_management',{}, {'operation':'completed'})
        self.assertEqual(self.registry.data['archives'][0]['policy_management']['history'][0]['operation'],'completed')
    async def test_betop_is_explicit_and_requires_a_mac(self):
        policies=PolicyManagement(self.jobs)
        with self.assertRaisesRegex(ValueError,'explicit MAC'):
            policies.preview(self.row['id'],'pad_pair',{'betop_classic':True})
        with self.assertRaisesRegex(ValueError,'boolean'):
            policies.preview(self.row['id'],'pad_pair',{'mac':'AA:BB:CC:DD:EE:FF','betop_classic':'true'})
        calls=[]
        class Fake:
            async def ssh(self,args,json_output=False,timeout=60):
                calls.append(args)
                if args[0]=='python3':return {'service':{'LoadState':'loaded','ActiveState':'active'},'socket_present':True}
                if 'status' in args:return {'pads':[],'driver':'active'}
                return {'outcome':'paired','pad':{'paired':True}}
        for compat in (False,True):
            job=dict(id='6'*32,profile_id=self.row['id'],target=self.checks.target(self.row),settings=settings(self.row),operation='pad_pair',detail={'mac':'AA:BB:CC:DD:EE:FF','timeout':30,'betop_classic':compat},log=[])
            await policies.execute(job,Fake())
            pair=next(args for args in reversed(calls) if 'pair' in args)
            self.assertEqual('--betop-classic' in pair,compat)

    async def test_pad_failed_outcome_and_idempotent_forget(self):
        policies=PolicyManagement(self.jobs)
        class Fake:
            async def ssh(self,args,json_output=False,timeout=60):
                if args[0]=='python3':return {'service':{'LoadState':'loaded','ActiveState':'active'},'socket_present':True}
                if 'status' in args:return {'pads':[],'driver':'inactive'}
                if 'pair' in args:return {'outcome':'failed','reason':'timeout'}
                return {'removed':False}
        job=dict(id='4'*32,profile_id=self.row['id'],target=self.checks.target(self.row),settings=settings(self.row),operation='pad_pair',detail={'mac':'','timeout':30},log=[])
        with self.assertRaisesRegex(NativeFailure,'Pairing failed'):await policies.execute(job,Fake())
        job['operation']='pad_forget';job['detail']['mac']='AA:BB:CC:DD:EE:FF'
        await policies.execute(job,Fake());self.assertFalse(job['result']['removed']);self.assertEqual(job['config_result'],'confirmed')
        self.assertEqual(self.registry.public()['robots'][0]['policy_management']['direct_pad']['result']['driver'],'inactive')
    async def test_policy_add_upload_hash_guard_and_runtime_unknown(self):
        policies=PolicyManagement(self.jobs);version_id='a'*32
        directory=policies.root(self.row['id'])/'versions'/version_id;directory.mkdir(parents=True)
        (directory/'policy.onnx').write_bytes(b'model');(directory/'manifest.json').write_text(json.dumps(EXAMPLE))
        record=dict(id=version_id,params=package.manifest(EXAMPLE),manifest=EXAMPLE,sha256=hashlib.sha256(b'model').hexdigest(),manifest_sha256=hashlib.sha256((directory/'manifest.json').read_bytes()).hexdigest(),config_result='not_attempted',load_result='not_attempted',motion_test='untested')
        private_json(directory/'record.json',record)
        class Fake:
            def __init__(self):self.commands=[];self.files={};self.added=False;self.limp=True
            async def scp(self,source,remote):self.files[remote]=source.read_bytes()
            async def ssh(inner,args,json_output=False,timeout=60):
                inner.commands.append(args)
                if args[0]=='python3':
                    code=args[-1]
                    if 'robot.subscribe' in code:
                        if not inner.limp:raise NativeFailure('Not limp')
                        return {'enabled':False,'bringup':'Limp'}
                    if "print(json.dumps({'sha256'" in code:
                        path=code.split('p=Path(')[1].split(');')[0];path=__import__('ast').literal_eval(path)
                        return {'sha256':hashlib.sha256(inner.files[path]).hexdigest() if path in inner.files else None}
                    if 'p.replace(' in code:
                        source=__import__('ast').literal_eval(code.split('p=Path(')[1].split(');')[0]);target=__import__('ast').literal_eval(code.split('p.replace(')[1].split(')')[0]);inner.files[target]=inner.files.pop(source)
                    return ''
                if 'list' in args:
                    skill={k:v for k,v in record['params'].items() if k!='bindings'};skill['path']=settings(self.row)['model_root']+'/'+version_id+'/policy.onnx'
                    return {'policies':{'enabled':True,'skills':['polite_bow'],'slots':[]},'skills':{'skills':[skill] if inner.added else []}}
                self.assertIn('add',args);self.assertNotIn('--json',args);inner.added=True;return 'added, reload accepted'
        job=dict(id='5'*32,profile_id=self.row['id'],target=self.checks.target(self.row),settings=settings(self.row),operation='add_skill',detail={'version':record},log=[],status='running')
        session=Fake();session.limp=False
        with self.assertRaises(NativeFailure):await policies.execute(job,session)
        self.assertFalse(session.files);self.assertFalse(session.added)
        session.limp=True;await policies.execute(job,session)
        self.assertEqual(job['config_result'],'confirmed');self.assertEqual(job['load_result'],'unknown');self.assertEqual(job['upload_result'],'verified')
        self.assertEqual(len(session.files),2)
        bindings=record['params']['bindings']
        with self.assertRaisesRegex(ValueError,'Confirm loading'):policies.save_bindings(self.row['id'],{'version_id':version_id,'bindings':bindings,'publish':True})
        policies.acceptance(self.row['id'],{'version_id':version_id,'deployment_id':job['id'],'status':'passed','notes':'Operator fixture; simulated evidence only'})
        policies.save_bindings(self.row['id'],{'version_id':version_id,'bindings':bindings,'publish':True})
        self.assertIn('polite_bow',self.registry.public()['robots'][0]['policy_management']['bindings'])
        preview=policies.preview(self.row['id'],'restore',{'version_id':version_id});self.assertEqual(preview['detail']['version']['params'],record['params'])
        job['id']='6'*32
        await policies.execute(job,session)
        self.assertEqual(policies.version(self.row['id'],version_id)['motion_test'],'untested')
        self.assertEqual(len(policies.version(self.row['id'],version_id)['tests']),1)
        with self.assertRaisesRegex(ValueError,'Deployment changed'):
            policies.acceptance(self.row['id'],{'version_id':version_id,'deployment_id':'5'*32,'status':'passed','notes':'Stale form'})

    async def test_old_model_and_program_evidence_cannot_publish(self):
        policies=PolicyManagement(self.jobs);version_id='b'*32;target=self.checks.target(self.row)
        params=package.manifest(EXAMPLE);program=program_evidence(self.registry.public()['robots'][0])
        deployment=dict(id='c'*32,target=target,settings=settings(self.row),program=program)
        record=dict(id=version_id,params=params,manifest=EXAMPLE,sha256='b'*64,remote_path='/OLD/model.onnx',config_result='confirmed',load_result='unknown',motion_test='passed',last_target=target,deployment=deployment,
                    tests=[dict(status='passed',deployment_id=deployment['id'],program=program)])
        private_json(policies.root(self.row['id'])/'versions'/version_id/'record.json',record)
        skill=dict(params,path='/NEW/model.onnx')
        query=dict(target=target,settings=settings(self.row),job_id='d'*32,result={'policies':{'slots':[],'skills':['polite_bow']},'skills':{'skills':[skill]}})
        self.registry.record_management(self.row['id'],'policy_management',{'last_query':query})
        body=dict(version_id=version_id,bindings=params['bindings'],publish=True)
        with self.assertRaisesRegex(ValueError,'model path'):policies.save_bindings(self.row['id'],body)
        skill['path']='/OLD/model.onnx';self.registry.record_management(self.row['id'],'policy_management',{'last_query':query})
        policies.save_bindings(self.row['id'],body)
        self.registry.record_management(self.row['id'],'program_deployment',{'last_change':dict(result={'status':'success','build_id':'v2'},target=target,settings=settings(self.row),queried_at='2026-11-03T12:00:00Z')})
        with self.assertRaisesRegex(ValueError,'Program version changed'):policies.save_bindings(self.row['id'],body)
        with self.assertRaises(ValueError):policies.preview(self.row['id'],'load_slot',{'version_id':version_id,'slot':'walk'})
        with self.assertRaisesRegex(ValueError,'cannot be disabled'):policies.preview(self.row['id'],'disable_slot',{'slot':'walk'})
        self.assertEqual(policies.preview(self.row['id'],'disable_slot',{'slot':'stand'})['detail']['slot'],'stand')

    async def test_native_pad_config_is_separate_and_verified(self):
        policies=PolicyManagement(self.jobs)
        config=settings(self.row);config['pad_config']='/different/padd.toml'
        class Fake:
            def __init__(self):self.calls=[]
            async def ssh(inner,args,*unused):inner.calls.append(args);return {'verified':True}
        session=Fake();job={'settings':config}
        await policies.native(job,session,['bindings','--json'])
        self.assertEqual(session.calls[0][:2],['python3','-c'])
        self.assertIn('/different/padd.toml',session.calls[0][2])
        self.assertEqual(session.calls[1][session.calls[1].index('--pad-config')+1],'/different/padd.toml')
        config['pad_config']=''
        with self.assertRaisesRegex(ValueError,'actual padd'):await policies.native(job,session,['bindings','--json'])
        await policies.native(job,session,['status','--json'])
        self.assertNotIn('--pad-config',session.calls[-1])

    async def test_program_adapter_fixed_script_admin_target(self):
        repository=self.root/'deploy';(repository/'deploy/radxa').mkdir(parents=True)
        script=repository/'deploy/radxa/deploy.py'
        script.write_text("import json,sys\nfrom pathlib import Path\nif sys.argv[1]=='list':print(json.dumps({'event':'result','status':'success','packages':[],'skipped':[]}))\nelse:\n t=json.loads(Path(sys.argv[sys.argv.index('--target-file')+1]).read_text()); print(json.dumps({'event':'result','status':'success','target':t}))\n")
        program=ProgramDeployment(self.jobs);program.configure({'deploy_repository':str(repository)})
        self.assertEqual((await program.packages())['packages'],[])
        preview=await program.preview(self.row['id'],'status');job=self.jobs.start(self.row['id'],preview['token'],PASSWORD,program.execute)
        await asyncio.gather(*self.jobs.tasks);result=self.jobs.job(job['id'])
        self.assertEqual(result['status'],'completed');self.assertEqual(result['result']['target']['ssh_user'],'root')
        for path in self.jobs.root.rglob('*.json'):self.assertNotIn(PASSWORD,path.read_text())

    async def test_telemetry_requires_matching_real_connection_and_new_feedback(self):
        conn=SimpleNamespace(source='simulation',config={},state={'boot_id':'old','seq':1},received_at=0,timeout=.5)
        program=ProgramDeployment(self.jobs,SimpleNamespace(connections={self.row['robot_id']:conn}))
        job=dict(id='e'*32,profile_id=self.row['id'],target=self.checks.target(self.row),operation='program_apply')
        self.assertEqual((await program.telemetry(job,'old'))['status'],'not_connected')
        conn.source='robot';conn.config={'endpoint':f"tcp://{self.row['address']}:{self.row['state_port']}"}
        async def fresh_frame():
            await asyncio.sleep(.01);conn.state={'boot_id':'new','seq':2};conn.received_at=time.monotonic()
        task=asyncio.create_task(fresh_frame())
        result=await program.telemetry(job,'old');await task
        self.assertEqual(result['status'],'confirmed');self.assertEqual(result['boot_id'],'new');self.assertEqual(result['seq'],2)

class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_exceeds_json_limit_no_remote_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);registry,row=registry_at(root);app=create_app(demos=0,record_root=root/'records',registry_path=registry.path)
            async with TestClient(TestServer(app)) as client:
                origin=str(client.make_url('/')).rstrip('/');url=f"/api/robots/{row['id']}/management/import"
                response=await client.post(url,data=b'no origin');self.assertEqual(response.status,403)
                def body():
                    data=FormData();data.add_field('model',b'fake-onnx'*8192,filename='model.onnx');data.add_field('manifest',json.dumps(EXAMPLE),filename='manifest.json');return data
                response=await client.post(url,data=body(),headers={'Origin':origin});data=await response.json()
                self.assertEqual(response.status,200,data);self.assertEqual(data['config_result'],'not_attempted');version=data['id']
                self.assertEqual(data['sha256'],hashlib.sha256(b'fake-onnx'*8192).hexdigest())
                response=await client.post(url,data=body(),headers={'Origin':origin});self.assertNotEqual((await response.json())['id'],version)
                response=await client.get(f"/api/robots/{row['id']}/management");data=await response.json();self.assertEqual(len(data['versions']),2);self.assertFalse(data['busy'])
                response=await client.post(f"/api/robots/{row['id']}/management/preview",json={'operation':'shell','command':'touch /tmp/no'},headers={'Origin':origin});self.assertEqual(response.status,400)

if __name__=='__main__':unittest.main()
