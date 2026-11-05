"""Console-owned, explicitly reviewed configd setup over SSH."""
import hashlib
import json
import re
from pathlib import Path
from host.ssh_checks import stamp


PREFLIGHT = '''import json, pathlib, stat, subprocess
p=subprocess.run(['systemctl','show','configd.service','--property=LoadState,ActiveState'],capture_output=True,text=True,timeout=5)
s=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
f=pathlib.Path(SOCKET_PATH)
try: present=stat.S_ISSOCK(f.stat().st_mode)
except FileNotFoundError: present=False
print(json.dumps(dict(service=s,socket_present=present)))
'''


async def require_configd(job, session):
    result = await session.ssh(['python3','-c',PREFLIGHT.replace('SOCKET_PATH',repr(job['settings']['config_socket']))],True)
    job['configd_preflight']=result
    state=result.get('service',{})
    if state.get('LoadState')=='not-found':
        raise ValueError('configd.service is not installed. Open New robot tests → Configd setup, inspect and review installation.')
    if state.get('ActiveState')!='active':
        raise ValueError('configd.service is not running. Open New robot tests → Configd setup to inspect and start it.')
    if not result.get('socket_present'):
        raise ValueError('configd is active but the configured socket is missing. Inspect Configd setup and compare Robot paths & accounts with the service socket.')


class ConfigdSetup:
    def __init__(self, jobs):
        self.jobs = jobs

    def script(self):
        path=Path(__file__).with_name('configd_remote.py')
        source=path.read_text()
        return source,hashlib.sha256(source.encode()).hexdigest()

    def preview(self, identity, operation):
        if operation not in ('configd_inspect','configd_apply'): raise ValueError('Unknown configd setup operation')
        _,digest=self.script(); context=self.jobs.context(identity)
        detail=dict(script_sha256=digest,config=dict(deploy_root=context['settings']['deploy_root'],
                    config_socket=context['settings']['config_socket'],allow_user=context['target']['user']))
        if operation=='configd_apply':
            if context['settings']['admin_user']!='root': raise ValueError('Configd installation requires Administrator SSH user = root; no sudo is used')
            entry=self.jobs.row(identity).get('policy_management',{}).get('configd_setup',{})
            if entry.get('target')!=context['target'] or entry.get('settings')!=context['settings'] or entry.get('script_sha256')!=digest:
                raise ValueError('Inspect configd for this target and these settings first')
            result=entry['result']
            if not re.fullmatch('[0-9a-f]{64}',result.get('fingerprint','')): raise ValueError('Saved configd inspection is invalid. Run Inspect again before installation.')
            if not result.get('can_apply'): raise ValueError('; '.join(result.get('blockers',[])) or 'Inspect configd first')
            detail.update(fingerprint=result['fingerprint'],diff=result['diff'],desired=result['desired'],
                          actions=result['actions'],scope=result['scope'])
        return self.jobs.preview(identity,operation,detail)

    async def execute(self, job, session):
        source,digest=self.script()
        if digest!=job['detail']['script_sha256']: raise ValueError('Setup script changed; inspect and preview again')
        action='apply' if job['operation']=='configd_apply' else 'inspect'
        request=dict(action=action,config=job['detail']['config'])
        if action=='apply':
            request.update(fingerprint=job['detail']['fingerprint'],job_id=job['id'])
            job['mutation_started']=True; job['config_result']='unknown'; self.jobs.save(job)
        result=await session.ssh(['python3','-c',source+'\nprint(json.dumps(dispatch('+repr(request)+')))'],True,180,sha256_fields=('fingerprint',))
        job['result']=result
        if action=='inspect':
            self.jobs.registry.record_management(job['profile_id'],'policy_management',{'configd_setup':dict(
                result=result,target=job['target'],settings=job['settings'],script_sha256=digest,job_id=job['id'],queried_at=stamp())})
        else:
            job['status']='completed' if result.get('status')=='success' else 'failed'
            job['config_result']='confirmed' if job['status']=='completed' else 'unknown'
            job['load_result']='not_applicable'; job['motion_test']='not_applicable'
            if job['status']=='failed': job['error']=result.get('error','Configd verification failed; inspect before retrying')
            pad=result.get('verification',{}).get('pad_status')
            self.jobs.registry.record_management(job['profile_id'],'policy_management',{
                'configd_setup':dict(result=result['after'],target=job['target'],settings=job['settings'],script_sha256=digest,job_id=job['id'],queried_at=stamp()) if result.get('after') else {}, 'direct_pad':dict(status='known' if pad else 'unknown',result=pad,target=job['target'],queried_at=stamp())})
