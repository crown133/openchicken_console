"""Local policy archives and fixed native robotctl operations; no runtime control transport."""
import asyncio
from host.configd_setup import ConfigdSetup, require_configd
from host.servo_audit import ServoAudit
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

from aiohttp import web
from host import policy_package as package
from host.management_jobs import ManagementJobs, NativeFailure, absolute, identifier, settings, program_evidence
from host.program_deployment import ProgramDeployment
from host.ssh_checks import private_json, stamp

# Read-only robot.state subscription, used only as a precondition, never to stop or enable.
LIMP_CHECK = '''import socket,json,time
s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(SOCKET)
s.sendall((json.dumps(dict(jsonrpc='2.0',id=1,method='robot.subscribe',params={'hz':1}))+'\\n').encode())
f=s.makefile('rb');deadline=time.monotonic()+4
while time.monotonic()<deadline:
 line=f.readline(1048576)
 if not line:raise RuntimeError('State stream closed')
 frame=json.loads(line)
 if frame.get('error'):raise RuntimeError(frame['error'])
 if frame.get('method')=='robot.state':
  state=frame['params']
  if state.get('enabled') is not False or state.get('bringup')!='Limp':raise RuntimeError('Stop and relax the supported robot before changing policies')
  print(json.dumps({'enabled':False,'bringup':'Limp'}));break
else:raise RuntimeError('No state received')
'''

PAD_CONFIG_CHECK = '''import json,subprocess
from pathlib import Path
pid=subprocess.check_output(['systemctl','show','padd.service','--property=MainPID','--value'],text=True).strip()
if not pid.isdecimal() or int(pid)==0:raise RuntimeError('padd is not running; its active configuration cannot be verified')
args=Path('/proc/'+pid+'/cmdline').read_bytes().decode().strip('\\0').split('\\0')
if not args or Path(args[0]).name!='padd':raise RuntimeError('Cannot identify the running padd executable')
def option(name,default):
 for i,arg in enumerate(args):
  if arg==name:return args[i+1]
  if arg.startswith(name+'='):return arg.split('=',1)[1]
 return default
actual=option('--config','/etc/robot/robotd.toml')
if not Path(actual).is_absolute():actual=str(Path('/proc/'+pid+'/cwd').resolve()/actual)
if not Path(actual).is_file():raise RuntimeError('The running padd configuration file is missing')
if Path(actual).resolve()!=Path(EXPECTED_CONFIG).resolve():raise RuntimeError('Configured pad path differs from running padd')
if option('--socket','/run/robotd.sock')!=EXPECTED_SOCKET:raise RuntimeError('padd uses a different robotd socket')
print(json.dumps({'config':actual,'pid':int(pid),'verified':True}))
'''


class PolicyManagement:
    def __init__(self, jobs): self.jobs = jobs

    def root(self, profile): return self.jobs.root/'policies'/identifier(profile)

    def version(self, profile, version):
        path = self.root(profile)/'versions'/identifier(version)/'record.json'
        if not path.exists(): raise ValueError('Policy version not found')
        return json.loads(path.read_text())

    def current_version(self, identity, version, require_acceptance=False):
        row = self.jobs.checks.profile(identity)
        section = row.get('policy_management', {})
        query = section.get('last_query', {})
        deployment = version.get('deployment', {})
        context = self.jobs.context(identity)
        if self.jobs.unresolved(identity, 'add_skill') or self.jobs.unresolved(identity, 'program_apply'):
            raise ValueError('Query the unresolved operation before using an acceptance or binding')
        if (not deployment or deployment.get('target') != context['target'] or deployment.get('settings') != context['settings']
                or version.get('config_result') != 'confirmed' or query.get('target') != context['target']
                or query.get('settings') != context['settings'] or query.get('job_id') == deployment.get('before_query')):
            raise ValueError('Confirm configuration for this deployment and query this target again')
        result = query.get('result', {})
        if deployment.get('slot'):
            actual = next((s for s in result.get('policies', {}).get('slots', []) if s.get('slot') == deployment['slot']), {})
            matches = actual.get('path') == version.get('remote_path') and not actual.get('error')
        else:
            matches = package.definition_matches(version, result) and version['params']['name'] in result.get('policies', {}).get('skills', [])
        if not matches or result.get('policies', {}).get('change_error'):
            raise ValueError('The queried model path or parameters no longer match this archived version')
        program = program_evidence(row)
        if not program or program.get('unknown_job') or program.get('target') != context['target'] or program.get('settings') != context['settings']:
            raise ValueError('Query the installed program version for this robot before acceptance or publication')
        if deployment.get('program') != program:
            raise ValueError('Program version changed; reapply and verify this policy before acceptance or publication')
        if require_acceptance:
            accepted = version.get('tests', [])[-1:]
            passed = bool(accepted and accepted[0]['status'] == 'passed'
                          and accepted[0].get('deployment_id') == deployment['id'] and accepted[0].get('program') == program)
            loaded = deployment.get('slot') and result.get('policies', {}).get('enabled') is True
            if not loaded and not passed:
                raise ValueError('Confirm loading or record physical acceptance for this deployment and program version')
        return deployment, program

    def invalidate(self, job, name=None, slot=None):
        row = self.jobs.row(job['profile_id'])
        published = row.get('policy_management', {}).get('bindings', {})
        for path in (self.root(job['profile_id'])/'versions').glob('*/record.json'):
            version = json.loads(path.read_text())
            if (name and version['params']['name'] == name) or (slot and version.get('slot') == slot):
                version.update(config_result='unknown', load_result='unknown', motion_test='untested')
                published.pop(version['params']['name'], None)
                private_json(path, version)
        if name: published.pop(name, None)
        self.jobs.registry.record_management(job['profile_id'], 'policy_management', {'bindings':published})

    def view(self, identity):
        row = self.jobs.row(identity)
        versions = [json.loads(p.read_text()) for p in (self.root(identity)/'versions').glob('*/record.json')]
        return dict(profile_id=identity, settings=settings(row), versions=sorted(versions,key=lambda v:v['created_at'],reverse=True),
                    policy_management=row.get('policy_management', {}), program_deployment=row.get('program_deployment', {}),
                    servo_history=row.get('servo_audit',{}).get('history',[]),
                    n03_records={key:value for key,value in row.get('results',{}).items() if key.startswith('N03.')},
                    latest_job=self.jobs.latest.get(identity), busy=identity in self.jobs.checks.active)

    async def upload(self, identity, request):
        self.jobs.row(identity)
        if identity in self.jobs.checks.active: raise ValueError('Another task is running for this robot')
        root = self.root(identity)/'versions'; root.mkdir(parents=True,exist_ok=True)
        version = uuid.uuid4().hex
        with tempfile.TemporaryDirectory(prefix='.import-',dir=root) as temporary:
            directory = Path(temporary); reader = await request.multipart(); fields = set(); total = 0
            while part := await reader.next():
                if part.name not in ('model','manifest','original_manifest') or part.name in fields: raise ValueError('Upload one model and one JSON manifest')
                fields.add(part.name); size=0; filename='policy.onnx' if part.name=='model' else part.name+'.json'
                if part.name=='model' and not (part.filename or '').lower().endswith('.onnx'): raise ValueError('Select an ONNX model')
                with (directory/filename).open('wb') as output:
                    while chunk := await part.read_chunk(65536):
                        size+=len(chunk); total+=len(chunk)
                        if size>(256*1024*1024 if part.name=='model' else 131072) or total>257*1024*1024: raise ValueError('Upload too large (model 256 MiB, manifest 128 KiB)')
                        output.write(chunk)
                if not size: raise ValueError('Uploaded file is empty')
            if not {'model','manifest'} <= fields: raise ValueError('Provide a model and manifest, or generate the manifest from the form')
            manifest=json.loads((directory/'manifest.json').read_text()); params=package.manifest(manifest)
            digest=await asyncio.to_thread(lambda: hashlib.sha256((directory/'policy.onnx').read_bytes()).hexdigest())
            record=dict(id=version, profile_id=identity, created_at=stamp(), sha256=digest, size=(directory/'policy.onnx').stat().st_size,
                manifest_sha256=hashlib.sha256((directory/'manifest.json').read_bytes()).hexdigest(), manifest=manifest, params=params,
                config_result='not_attempted', load_result='not_attempted', motion_test='untested', contract='declared_only_not_inference_verified')
            if 'original_manifest' in fields:
                json.loads((directory/'original_manifest.json').read_text())
                record['original_manifest_sha256'] = hashlib.sha256((directory/'original_manifest.json').read_bytes()).hexdigest()
            private_json(directory/'record.json',record)
            os.rename(directory,root/version)
        self.jobs.registry.record_management(identity,'policy_management',{},dict(operation='import',version_id=version,sha256=digest,created_at=stamp()))
        return record

    def preview(self, identity, action, body):
        if action not in ('refresh','add_skill','remove_skill','load_slot','reset_slot','disable_slot','restore','pad_status','pad_pair','pad_forget','pad_bind','pad_reset_binding'):
            raise ValueError('Unknown policy operation')
        detail={}
        if action in ('add_skill','load_slot','restore'):
            version=self.version(identity,body.get('version_id')); detail['version']=version
        if action == 'restore' and detail['version'].get('slot'):
            detail['slot'] = detail['version']['slot']
        if action in ('load_slot','reset_slot','disable_slot'):
            slot=body.get('slot')
            if slot not in package.SLOTS: raise ValueError('Unknown native policy slot')
            detail['slot']=slot
            if action == 'disable_slot' and slot == 'walk': raise ValueError('The walk slot cannot be disabled')
        if 'version' in detail:
            if detail.get('slot'):
                package.validate_slot(detail['version']['manifest'], detail['slot'])
                if detail['slot'] in ('sitstand', 'ground_pick'):
                    detail['timing'] = 'Replaces the model only; phase/posture timing remains configured by the native policy set and robotd.toml. Manifest timing is archived, not applied.'
            else: package.validate_skill(detail['version']['manifest'])
        if action=='remove_skill': detail['name']=package.name(body.get('name'))
        if action in ('pad_bind','pad_reset_binding'):
            button=body.get('button')
            if button not in ('lb_a','lb_down','lb_left','lb_right','lb_up'): raise ValueError('Only the five native LB skill chords are configurable')
            row=self.jobs.row(identity); snapshot=row.get('policy_management',{}).get('native_bindings',{})
            context=self.jobs.context(identity)
            if snapshot.get('target')!=context['target'] or snapshot.get('settings')!=context['settings'] or button not in snapshot.get('result',{}):
                raise ValueError('Query native bindings and verify the running padd configuration first')
            detail.update(button=button,previous=snapshot['result'][button])
            if action=='pad_bind':
                version=self.version(identity,body.get('version_id'));self.current_version(identity,version,require_acceptance=True)
                detail.update(version=version,skill=version['params']['name'])
        if action in ('pad_pair','pad_forget'):
            mac=body.get('mac','').strip().upper()
            if (action=='pad_forget' or mac) and not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}',mac): raise ValueError('Enter a Bluetooth MAC address')
            compatibility=body.get('betop_classic',False)
            if type(compatibility) is not bool: raise ValueError('betop_classic must be boolean')
            if compatibility and (action!='pad_pair' or not mac): raise ValueError('BETOP Xbox compatibility requires an explicit MAC')
            detail.update(mac=mac,timeout=30,betop_classic=compatibility)
        return self.jobs.preview(identity,action,detail)

    async def native(self, job, session, args, policy=False, json_output=True, timeout=90):
        config=job['settings']
        prefix=[config['robotctl'],'--robot-socket',config['robot_socket'],'--config-socket',config['config_socket']]
        if policy: prefix+=['policy','--file',config['robot_config']]
        elif args[0] in ('bindings', 'bind', 'reset'):
            if not config.get('pad_config'): raise ValueError('Set the actual padd configuration path in Robot paths & accounts first')
            probe=PAD_CONFIG_CHECK.replace('EXPECTED_CONFIG',repr(config['pad_config'])).replace('EXPECTED_SOCKET',repr(config['robot_socket']))
            job['pad_config_check']=await session.ssh(['python3','-c',probe],True)
            prefix+=['--pad-config',config['pad_config'],'pad']
        else: prefix+=['pad']
        return await session.ssh(prefix+args,json_output,timeout)

    async def query(self, job, session):
        result=await self.native(job,session,['list','--json'],True)
        if not isinstance(result,dict) or not isinstance(result.get('policies',{}).get('slots'),list) or not isinstance((result.get('skills') or {}).get('skills'),list):
            raise ValueError('This robotctl release does not provide policy slots and skill definitions')
        self.jobs.registry.record_management(job['profile_id'],'policy_management',{'last_query':dict(result=result,queried_at=stamp(),target=job['target'],settings=job['settings'],job_id=job['id'])})
        row = self.jobs.row(job['profile_id']); published = row.get('policy_management', {}).get('bindings', {})
        for name, entry in list(published.items()):
            version = self.version(job['profile_id'], entry['version_id'])
            try: self.current_version(job['profile_id'], version, require_acceptance=True)
            except ValueError: published.pop(name)
        self.jobs.registry.record_management(job['profile_id'], 'policy_management', {'bindings':published})
        return result

    async def pad_status(self,job,session):
        try:
            result=await self.native(job,session,['status','--json'])
            if not isinstance(result,dict) or not isinstance(result.get('pads'),list) or 'driver' not in result: raise ValueError('Unsupported pad status response')
            entry=dict(status='known',result=result,queried_at=stamp(),target=job['target'])
        except Exception as error:
            self.jobs.registry.record_management(job['profile_id'],'policy_management',{'direct_pad':dict(status='unknown',queried_at=stamp(),target=job['target'])})
            raise
        self.jobs.registry.record_management(job['profile_id'],'policy_management',{'direct_pad':entry})
        return result

    async def execute(self,job,session):
        action=job['operation']; detail=job['detail']; config=job['settings']
        if action in ('pad_status','pad_pair','pad_forget'):
            try: await require_configd(job,session)
            except Exception:
                self.jobs.registry.record_management(job['profile_id'],'policy_management',{'direct_pad':dict(status='unknown',target=job['target'],queried_at=stamp())})
                raise
        if action == 'restore' and detail.get('slot'): action='load_slot'
        if action in ('pad_bind','pad_reset_binding'):
            await self.query(job,session)
            if action=='pad_bind': self.current_version(job['profile_id'],self.version(job['profile_id'],detail['version']['id']),require_acceptance=True)
            before=await self.native(job,session,['bindings','--json'])
            if before.get(detail['button'])!=detail['previous']: raise ValueError('Native binding changed after preview; query and preview again')
            job['bindings_before']=before
            job['precondition']=await session.ssh(['python3','-c',LIMP_CHECK.replace('SOCKET',repr(config['robot_socket']))],True)
            args=['bind',detail['button'],detail['skill'],'--json'] if action=='pad_bind' else ['reset',detail['button'],'--json']
            job.update(mutation_started=True,config_result='unknown');self.jobs.save(job)
            job['native_result']=await self.native(job,session,args)
            after=await self.native(job,session,['bindings','--json']);job['result']=after
            defaults={'lb_a':'sit_toggle','lb_down':'ground_pick','lb_left':'kick_left','lb_right':'kick_right','lb_up':'roulade'}
            expected=detail['skill'] if action=='pad_bind' else defaults[detail['button']]
            if after.get(detail['button'])!=expected: raise ValueError('Native binding write is not confirmed; query bindings before retrying')
            job['config_result']='confirmed';job['load_result']='not_applicable'
            self.jobs.registry.record_management(job['profile_id'],'policy_management',{'native_bindings':dict(result=after,queried_at=stamp(),target=job['target'],settings=config)})
            return
        if action.startswith('pad_'):
            if action=='pad_status': job['result']=await self.pad_status(job,session);return
            args=['pair']+([detail['mac']] if detail['mac'] else [])+['--timeout','30','--json'] if action=='pad_pair' else ['forget',detail['mac'],'--json']
            if action=='pad_pair' and detail.get('betop_classic'):
                args+=['--betop-classic']
                job['log'].append('BETOP Xbox: normal scan, then directed discovery if needed; waiting for persistent bonding and input enumeration.')
            job['mutation_started']=True;self.jobs.save(job)
            result=await self.native(job,session,args,timeout=150);job['result']=result
            try: job['after']=await self.pad_status(job,session)
            except Exception: job['log'].append('Status refresh failed; connection state is unknown.')
            if action=='pad_pair' and result.get('outcome')!='paired': raise NativeFailure('Pairing failed: '+json.dumps(result,ensure_ascii=False))
            if action=='pad_forget' and type(result.get('removed')) is not bool: raise ValueError('Unsupported forget response')
            job['config_result']='confirmed';return
        before=await self.query(job,session);job['before']=before
        job['bindings_before']=copy.deepcopy(self.jobs.checks.profile(job['profile_id']).get('policy_management',{}).get('bindings',{}))
        if action=='refresh':
            job['result']=before
            try: job['native_bindings']=await self.native(job,session,['bindings','--json'])
            except (NativeFailure, ValueError) as error: job['native_bindings']={'status':'unavailable','error':str(error)}
            self.jobs.registry.record_management(job['profile_id'],'policy_management',{'native_bindings':dict(result=job['native_bindings'],queried_at=stamp(),target=job['target'],settings=job['settings'])})
            return
        if 'version' in detail:
            evidence=program_evidence(self.jobs.row(job['profile_id']))
            if not evidence or evidence.get('unknown_job') or evidence.get('target')!=job['target'] or evidence.get('settings')!=config:
                raise ValueError('Query the installed program with these robot settings before applying a policy')
        params=detail.get('version',{}).get('params',{'name':detail.get('name')})
        old=next((s for s in before['skills']['skills'] if s.get('name')==params['name']),None)
        if old and action in ('add_skill','restore','remove_skill'): package.editable(old)
        # No auto-relax or homing: the operator must already have made the robot safe.
        job['precondition']=await session.ssh(['python3','-c',LIMP_CHECK.replace('SOCKET',repr(config['robot_socket']))],True)
        remote=None
        if 'version' in detail:
            version=detail['version']; directory=self.root(job['profile_id'])/'versions'/version['id']
            digest=await asyncio.to_thread(lambda:hashlib.sha256((directory/'policy.onnx').read_bytes()).hexdigest())
            if digest!=version['sha256']: raise ValueError('Archived model hash mismatch')
            remote_dir=config['model_root']+'/'+version['id'];remote=remote_dir+'/policy.onnx'
            # An existing immutable version may only be reused when its bytes match.
            prepare="from pathlib import Path; p=Path("+repr(remote_dir)+"); p.mkdir(parents=True,exist_ok=True)"
            await session.ssh(['python3','-c',prepare])
            for filename,expected in [('policy.onnx',version['sha256']),('manifest.json',version['manifest_sha256'])]:
                path=remote_dir+'/'+filename
                check="from pathlib import Path; import hashlib,json; p=Path("+repr(path)+"); print(json.dumps({'sha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None}))"
                current=await session.ssh(['python3','-c',check],True)
                if current['sha256'] is not None and current['sha256']!=expected: raise ValueError('Remote immutable policy version has different bytes')
                if current['sha256'] is None:
                    temporary=path+'.upload-'+job['id']
                    await session.scp(directory/filename,temporary)
                    commit="from pathlib import Path; import hashlib; p=Path("+repr(temporary)+"); assert hashlib.sha256(p.read_bytes()).hexdigest()=="+repr(expected)+"; p.replace("+repr(path)+")"
                    await session.ssh(['python3','-c',commit])
                    if (await session.ssh(['python3','-c',check],True))['sha256']!=expected: raise ValueError('Uploaded file hash mismatch')
            job['remote_path']=remote;job['upload_result']='verified'
        # Recheck after upload; no stale cached telemetry is accepted as the precondition.
        await session.ssh(['python3','-c',LIMP_CHECK.replace('SOCKET',repr(config['robot_socket']))],True)
        if action in ('add_skill','restore'): args=package.add_arguments(params,remote);as_json=False
        elif action=='remove_skill': args=['remove',detail['name']];as_json=False
        elif action in ('load_slot','disable_slot'): args=['load',detail['slot'],remote if action=='load_slot' else 'none','--json'];as_json=True
        else: args=['reset',detail['slot'],'--json'];as_json=True
        self.invalidate(job, params.get('name'), detail.get('slot'))
        if 'version' in detail:
            record = self.version(job['profile_id'], detail['version']['id'])
            record['deployment'] = dict(id=job['id'], target=job['target'], settings=job['settings'], slot=detail.get('slot'), before_query=job['id'], program=program_evidence(self.jobs.row(job['profile_id'])))
            private_json(self.root(job['profile_id'])/'versions'/record['id']/'record.json', record)
        job.update(mutation_started=True,config_result='unknown',load_result='unknown');self.jobs.save(job)
        native_error=None
        try: job['native_result']=await self.native(job,session,args,True,as_json)
        except NativeFailure as error: native_error=error
        after=await self.query(job,session);job['result']=after
        job['config_result'],job['load_result']=package.assess(after,action,params,remote,detail.get('slot'))
        if job['load_result']=='failed' or native_error:
            job['status']='failed'
            if native_error: job['error']=str(native_error)
        if 'version' in detail:
            version=detail['version']; record=self.version(job['profile_id'],version['id'])
            record.update(config_result=job['config_result'],load_result=job['load_result'],motion_test='untested',remote_path=remote,last_operation=job['id'],last_target=job['target'],slot=detail.get('slot'))
            record['deployment'].pop('before_query', None)
            private_json(self.root(job['profile_id'])/'versions'/version['id']/'record.json',record)
        if action=='remove_skill':
            # Previously published input mappings cannot survive removal of their definition.
            row=self.jobs.checks.profile(job['profile_id'])
            published=row.get('policy_management',{}).get('bindings',{})
            published.pop(detail['name'],None)
            self.jobs.registry.record_management(job['profile_id'],'policy_management',{'bindings':published})

    def save_bindings(self, identity, body):
        if identity in self.jobs.checks.active: raise ValueError('Wait for the active task to finish')
        version=self.version(identity,body.get('version_id'))
        value=package.bindings(body.get('bindings',{}))
        if version['params']['name'] in {'sit_toggle','ground_pick','kick_left','kick_right','roulade'}:
            raise ValueError('The unified native actions retain their existing protected bindings')
        row=self.jobs.row(identity)
        section=row.get('policy_management',{})
        published=section.get('bindings',{})
        used_keys={item['code'] for name,entry in published.items() if name!=version['params']['name'] for item in entry['bindings']['keyboard']}
        used_chords={tuple(item['buttons']) for name,entry in published.items() if name!=version['params']['name'] for item in entry['bindings']['browser_gamepad']}
        if any(item['code'] in used_keys for item in value['keyboard']) or any(tuple(item['buttons']) in used_chords for item in value['browser_gamepad']):
            raise ValueError('This input is already assigned to another skill')
        entry=dict(version_id=version['id'],sha256=version['sha256'],bindings=value,label=version['manifest'].get('openchicken',{}).get('label',{}),
                   target=self.jobs.checks.target(row),created_at=stamp())
        if body.get('publish') is True:
            deployment, program = self.current_version(identity, version, require_acceptance=True)
            entry.update(deployment_id=deployment['id'], program=program)
            query=section.get('last_query',{})
            available=(query.get('result',{}).get('policies') or {}).get('skills',[])
            if version['config_result']!='confirmed' or (version['load_result']!='confirmed' and version['motion_test']!='passed') or version.get('last_target')!=entry['target'] or query.get('target')!=entry['target'] or version['params']['name'] not in available:
                raise ValueError('Confirm configuration and loading (or record physical acceptance) for this target, then query its native skills before publishing')
            published[version['params']['name']]=entry
            self.jobs.registry.record_management(identity,'policy_management',{'bindings':published},dict(operation='publish_bindings',**entry))
        else:
            self.jobs.registry.record_management(identity,'policy_management',{},dict(operation='draft_bindings',**entry))
        version['bindings_draft']=entry
        private_json(self.root(identity)/'versions'/version['id']/'record.json',version)
        return entry

    def acceptance(self,identity,body):
        if identity in self.jobs.checks.active: raise ValueError('Wait for the active task to finish')
        version=self.version(identity,body.get('version_id'))
        status=body.get('status');notes=body.get('notes','')
        if status not in ('passed','failed','skipped') or not isinstance(notes,str) or not notes.strip() or len(notes)>4000:
            raise ValueError('Record passed/failed/skipped with operator and evidence notes')
        deployment, program = self.current_version(identity, version)
        if body.get('deployment_id') != deployment['id']: raise ValueError('Deployment changed; refresh before recording acceptance')
        entry=dict(operation='motion_test',version_id=version['id'],sha256=version['sha256'],status=status,notes=notes,created_at=stamp(),
            deployment_id=deployment['id'],target=deployment['target'],program=program)
        version['motion_test']=status;version.setdefault('tests',[]).append(entry)
        private_json(self.root(identity)/'versions'/version['id']/'record.json',version)
        self.jobs.registry.record_management(identity,'policy_management',{},entry)
        return version


def install_management(app,checks):
    jobs=ManagementJobs(checks);policies=PolicyManagement(jobs);program=ProgramDeployment(jobs, app['console'])
    setup=ConfigdSetup(jobs);joints=ServoAudit(jobs)
    app['management']=jobs;app.on_cleanup.append(jobs.close)
    async def handler(request):
        try:
            identity=request.match_info.get('profile'); action=request.match_info.get('action')
            if request.method=='GET':
                if action=='joints': result=joints.view(identity)
                elif action=='settings': result=program.settings()
                elif action=='packages': result=await program.packages()
                elif 'job' in request.match_info:
                    result=jobs.job(request.match_info['job'])
                    if request.match_info.get('log'):
                        path=jobs.root/'logs'/(result['id']+'.log')
                        if not path.is_file(): raise ValueError('No command log available')
                        return web.FileResponse(path,headers={'Cache-Control':'no-store','Content-Disposition':'attachment; filename="'+result['id']+'.log"'})
                else: result=policies.view(identity)
            else:
                if request.headers.get('Origin') not in (f'http://{request.host}',f'https://{request.host}'): raise web.HTTPForbidden(text='Same-origin requests only')
                if action=='import':
                    if request.content_type!='multipart/form-data': raise web.HTTPUnsupportedMediaType()
                    result=await policies.upload(identity,request)
                else:
                    if request.content_type!='application/json': raise web.HTTPUnsupportedMediaType()
                    body=await request.json()
                    if not isinstance(body,dict): raise ValueError('Expected a JSON object')
                    if action=='joints': result=joints.save(identity,body)
                    elif action=='settings': result=program.configure(body)
                    elif action=='configure':
                        row=jobs.row(identity)
                        if identity in checks.active: raise ValueError('Wait for the active task to finish')
                        expected=set(settings(row))
                        if set(body)!=expected: raise ValueError('Unexpected settings fields')
                        for key,value in body.items():
                            if key=='admin_user':
                                if not isinstance(value,str) or not re.fullmatch('[a-z_][a-zA-Z0-9_-]*',value): raise ValueError('Invalid administrator SSH user')
                            elif key=='pad_config' and value=='': pass
                            else: body[key]=absolute(value)
                        checks.registry.record_management(identity,'management_settings',body)
                        checks.registry.record_management(identity,'policy_management',{'bindings':{}});result=body
                    elif action=='preview':
                        operation=body.get('operation','')
                        if not isinstance(operation,str): raise ValueError('Invalid operation')
                        if operation=='joint_readback': result=joints.preview(identity)
                        elif operation.startswith('configd_'): result=setup.preview(identity,operation)
                        elif operation.startswith('program_'): result=await program.preview(identity,operation[8:],body.get('build_id'))
                        else: result=policies.preview(identity,operation,body)
                    elif action=='run':
                        token=body.get('token');preview=jobs.tokens.get(token)
                        if not preview: raise ValueError('Preview again before execution')
                        execute=joints.execute if preview['operation']=='joint_readback' else setup.execute if preview['operation'].startswith('configd_') else program.execute if preview['operation'].startswith('program_') else policies.execute
                        result=jobs.start(identity,token,body.get('password'),execute)
                    elif action=='tests': result=policies.acceptance(identity,body)
                    elif action=='bindings': result=policies.save_bindings(identity,body)
                    else: raise ValueError('Unknown management operation')
            return web.json_response(result,headers={'Cache-Control':'no-store'})
        except (ValueError,TypeError,KeyError,OSError,asyncio.TimeoutError) as error:
            return web.json_response({'error':str(error) or 'Operation timed out'},status=400)
    app.router.add_get('/api/management/{action:settings|packages}',handler)
    app.router.add_post('/api/management/{action:settings}',handler)
    app.router.add_get('/api/management/jobs/{job}',handler)
    app.router.add_get('/api/management/jobs/{job}/{log:log}',handler)
    app.router.add_get('/api/robots/{profile}/management',handler)
    app.router.add_get('/api/robots/{profile}/management/{action:joints}',handler)
    app.router.add_post('/api/robots/{profile}/management/{action}',handler)
    return policies
