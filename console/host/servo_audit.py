"""Per-robot N03 expectations and explicit, read-only SSH audit invocation.

Uses the existing reviewed board scripts unchanged. Never stops services or writes registers.
"""
import copy
from pathlib import Path
from host.management_jobs import absolute, settings
from host.ssh_checks import stamp
from protocol.model import joint_manifest

SCRIPT_HASHES = {'audit-servo-config.py':'acedff4f5314f90aeadf186eb476fc2739be84e8ad58b306ebe08cb9c7205bef',
                'test-dxl-communication.py':'7d15b2a05e5433ca44a564461a97ddde7a0cb5174eae641a8b9b6f8a45f65ac0'}
REMOTE = r'''
import hashlib,json,os,subprocess
from pathlib import Path

def collect(script, hashes):
 if os.geteuid()!=0: raise RuntimeError('Administrator root SSH is required to inspect all serial owners; no sudo is used')
 path=Path(script)
 for name,digest in hashes.items():
  file=path.with_name(name)
  if not file.is_file(): raise RuntimeError('Missing reviewed audit script: '+str(file)+'. Install the existing scripts or correct the audit path; no files were uploaded.')
  if hashlib.sha256(file.read_bytes()).hexdigest()!=digest: raise RuntimeError('Audit script revision differs; review it before use: '+str(file))
 services={}
 for name in ('robotd','padd','netpadd','openchicken-agent'):
  p=subprocess.run(['systemctl','show',name+'.service','--property=LoadState,ActiveState'],capture_output=True,text=True,timeout=5)
  state=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
  if state.get('LoadState') not in ('loaded','not-found') or state.get('ActiveState') not in ('inactive','failed'):
   raise RuntimeError(name+' is active or its state is unknown; refusing shared bus access. Stop owners manually after securing the robot; this check does not stop services.')
  services[name]=state
 device=Path('/dev/openchicken-dxl').resolve(strict=True)
 owners=subprocess.run(['fuser',str(device)],capture_output=True,text=True,timeout=5)
 if owners.returncode!=1 or owners.stdout.strip() or owners.stderr.strip():
  raise RuntimeError('Serial device is busy or ownership cannot be verified: '+(owners.stdout+owners.stderr)[-1000:])
 p=subprocess.run(['python3',str(path)],capture_output=True,text=True,timeout=45)
 if p.returncode: raise RuntimeError((p.stderr or p.stdout)[-4000:])
 lines=[line[len('RESULT_JSON='):] for line in p.stdout.splitlines() if line.startswith('RESULT_JSON=')]
 if len(lines)!=1: raise RuntimeError('Audit did not return one RESULT_JSON record')
 return dict(audit=json.loads(lines[0]),services=services,script=str(path),script_hashes=hashes)
'''


def defaults():
    return [dict(name=j['name'],id=j['id'],direction=0,homing_offset=j['homing_offset']) for j in joint_manifest()]


def validate_expected(rows):
    if not isinstance(rows,list) or len(rows)!=14: raise ValueError('Expected exactly 14 joints')
    names={j['name'] for j in joint_manifest()};seen=set();ids=set()
    for row in rows:
        if not isinstance(row,dict) or set(row)!={'name','id','direction','homing_offset'}: raise ValueError('Invalid joint expectation fields')
        if row['name'] not in names or row['name'] in seen: raise ValueError('Duplicate or unknown joint name')
        for key,lo,hi in [('id',0,252),('direction',0,1),('homing_offset',-2147483648,2147483647)]:
            if type(row[key]) is not int or not lo<=row[key]<=hi: raise ValueError('Invalid '+key)
        if row['id'] in ids: raise ValueError('Joint IDs must be unique')
        seen.add(row['name']);ids.add(row['id'])
    return copy.deepcopy(rows)


def compare(expected, audit):
    if not isinstance(audit,dict) or audit.get('motor_writes_sent') is not False: raise ValueError('Read-only audit evidence is missing')
    results=audit.get('results')
    if not isinstance(results,list) or len(results)>14: raise ValueError('Invalid audit joint records')
    actual={}
    for item in results:
        identity=item.get('id');fields=item.get('fields')
        if type(identity) is not int or identity not in {j['id'] for j in joint_manifest()} or identity in actual or not isinstance(fields,dict): raise ValueError('Invalid/duplicate audit ID')
        for key in ('id_register','drive_mode','homing_offset','torque','hardware_error'):
            value=fields.get(key)
            if type(value) is not int: raise ValueError('Missing integer register: '+key)
        if not 0<=fields['drive_mode']<=255 or fields['torque'] not in (0,1) or not 0<=fields['hardware_error']<=255: raise ValueError('Invalid register value')
        actual[identity]=fields
    rows=[]
    for entry in validate_expected(expected):
        fields=actual.get(entry['id']);differences=[]
        if fields:
            values=dict(id=fields['id_register'],direction=fields['drive_mode']&1,homing_offset=fields['homing_offset'])
            differences=[dict(field=k,actual=values[k],expected=entry[k]) for k in values if values[k]!=entry[k]]
            status='unsafe' if fields['torque'] or fields['hardware_error'] else 'different' if differences else 'match'
        else: values=None;status='missing'
        rows.append(dict(name=entry['name'],expected=entry,actual=values,fields=fields,differences=differences,status=status))
    return rows


class ServoAudit:
    def __init__(self,jobs): self.jobs=jobs

    def view(self,identity):
        row=self.jobs.row(identity);data=row.get('servo_audit',{})
        return dict(revision=data.get('revision',0),expected=data.get('expected',defaults()),
                    annotations=data.get('annotations',{}),notes=data.get('notes',''),
                    confirmed=bool(data.get('revision')),script=data.get('script',settings(row)['deploy_root']+'/scripts/audit-servo-config.py'),
                    latest=data.get('latest'),history=data.get('history',[]),
                    job=self.jobs.job(data['latest_job']) if data.get('latest_job') else None,
                    busy=identity in self.jobs.checks.active)

    def save(self,identity,body):
        current=self.view(identity)
        if current['busy']: raise ValueError('Wait for the active task to finish')
        if type(body.get('revision')) is not int or body['revision']!=current['revision']: raise ValueError('Expectations changed; reload before saving')
        expected=validate_expected(body.get('expected'));script=absolute(body.get('script'))
        if Path(script).name!='audit-servo-config.py': raise ValueError('Select the reviewed audit-servo-config.py')
        notes=body.get('notes','')
        if not isinstance(notes,str) or len(notes)>2000: raise ValueError('Notes must be text up to 2000 characters')
        annotations=copy.deepcopy(body.get('annotations',current['annotations']))
        if 'annotations' not in body:
            previous={entry['name']:entry for entry in current['expected']}
            for entry in expected:
                if entry!=previous.get(entry['name']) and entry['name'] in annotations:
                    annotations[entry['name']]['status']='unchecked'
        names={j['name'] for j in expected}
        if not isinstance(annotations,dict) or set(annotations)-names: raise ValueError('Unknown joint annotation')
        for entry in annotations.values():
            if (not isinstance(entry,dict) or set(entry)!={'status','notes'} or
                entry['status'] not in ('unchecked','checked','issue') or
                not isinstance(entry['notes'],str) or len(entry['notes'])>1000):
                raise ValueError('Invalid mechanical check or joint notes')
        changed=not current['confirmed'] or expected!=current['expected'] or script!=current['script']
        value=dict(expected=expected,script=script,revision=current['revision']+int(changed),annotations=annotations,notes=notes)
        self.jobs.registry.record_management(identity,'servo_audit',value,dict(operation='save_expectations' if changed else 'save_joint_notes',at=stamp(),before=current['expected'],**value))
        return self.view(identity)

    def preview(self,identity):
        state=self.view(identity);context=self.jobs.context(identity)
        if context['settings']['admin_user']!='root': raise ValueError('Set administrator SSH user to root for exclusive-owner inspection')
        if not state['confirmed']: raise ValueError('Review and save per-robot expectations first; defaults are assembly references only')
        return self.jobs.preview(identity,'joint_readback',dict(expected=state['expected'],revision=state['revision'],script=state['script'],script_hashes=SCRIPT_HASHES,
            scope='Read-only audit, no register writes, no service changes. Secure/support the robot, torque off and stop all serial owners manually first. Fixed scan: IDs 10–14,20–24,30–33 at UART5 / 1 Mbps. No unknown-ID scan.',
            command=['python3',state['script']]))

    async def execute(self,job,session):
        state=self.view(job['profile_id']);detail=job['detail']
        if state['revision']!=detail['revision'] or state['script']!=detail['script'] or state['expected']!=detail['expected']: raise ValueError('Expectations changed; preview again')
        result=await session.ssh(['python3','-c',REMOTE+'\nprint(json.dumps(collect('+repr(detail['script'])+','+repr(SCRIPT_HASHES)+')))'],True,90)
        rows=compare(detail['expected'],result['audit'])
        entry=dict(job_id=job['id'],captured_at=stamp(),target=job['target'],settings=job['settings'],revision=detail['revision'],expected=detail['expected'],rows=rows,result=result,
                   outcome='match' if all(r['status']=='match' for r in rows) else 'attention',source='ssh_readback')
        job['result']=entry;job['config_result']='not_applicable';job['load_result']='not_applicable';job['motion_test']='untested'
        self.jobs.registry.record_management(job['profile_id'],'servo_audit',{'latest':entry})
