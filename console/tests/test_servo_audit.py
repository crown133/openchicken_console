import copy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from host.servo_audit import ServoAudit, defaults, compare, validate_expected, REMOTE
from host.management_jobs import ManagementJobs
from host.robot_registry import RobotRegistry
from host.ssh_checks import SshChecks

def audit():
 return dict(motor_writes_sent=False,results=[dict(id=j['id'],fields=dict(id_register=j['id'],drive_mode=j['direction'],homing_offset=j['homing_offset'],torque=0,hardware_error=0)) for j in defaults()])

class ComparisonTests(unittest.TestCase):
 def test_id_mapping_differences(self):
  read=audit();read['results'].reverse();self.assertTrue(all(r['status']=='match' for r in compare(defaults(),read)))
  read['results'][0]['fields'].update(homing_offset=123,drive_mode=5)
  row=next(r for r in compare(defaults(),read) if r['expected']['id']==read['results'][0]['id'])
  self.assertEqual(row['status'],'different');self.assertEqual(row['actual']['direction'],1)
  self.assertEqual({d['field'] for d in row['differences']},{'direction','homing_offset'})
 def test_missing_fault_invalid(self):
  read=audit();read['results'].pop();read['results'][0]['fields']['torque']=1;read['results'][1]['fields']['hardware_error']=1
  rows=compare(defaults(),read);self.assertEqual([r['status'] for r in rows[:2]],['unsafe','unsafe']);self.assertEqual(rows[-1]['status'],'missing')
  for invalid in [dict(read,motor_writes_sent=True),dict(read,results=read['results']+[read['results'][0]])]:
   with self.assertRaises(ValueError):compare(defaults(),invalid)
  read['results'][0]['fields'].pop('homing_offset')
  with self.assertRaises(ValueError):compare(defaults(),read)
 def test_expectations_validation(self):
  for key,value in [('id',True),('direction',2),('homing_offset',.5),('name','unknown')]:
   rows=defaults();rows[0][key]=value
   with self.assertRaises(ValueError):validate_expected(rows)
  rows=defaults();rows[0]['id']=rows[1]['id']
  with self.assertRaisesRegex(ValueError,'unique'):validate_expected(rows)

class RemoteGuardTests(unittest.TestCase):
 def setUp(self):
  ns={};exec(REMOTE,ns);self.collect=ns['collect'];self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.path=Path(self.tmp.name)/'audit-servo-config.py';self.path.write_text('never executed')
  self.hashes={self.path.name:__import__('hashlib').sha256(self.path.read_bytes()).hexdigest()}
 def test_account_and_hash_guards(self):
  with patch('os.geteuid',return_value=1000),patch('subprocess.run') as command:
   with self.assertRaisesRegex(RuntimeError,'root'):self.collect(str(self.path),self.hashes)
   command.assert_not_called()
  with patch('os.geteuid',return_value=0),patch('subprocess.run') as command:
   with self.assertRaisesRegex(RuntimeError,'revision'):self.collect(str(self.path),{self.path.name:'wrong'})
   command.assert_not_called()
 def test_active_unknown_services(self):
  for state in ['LoadState=loaded\nActiveState=active','bad response']:
   with patch('os.geteuid',return_value=0),patch('subprocess.run',return_value=SimpleNamespace(stdout=state)) as command:
    with self.assertRaisesRegex(RuntimeError,'refusing'):self.collect(str(self.path),self.hashes)
    self.assertEqual(command.call_count,1);self.assertEqual(command.call_args.args[0][0],'systemctl')
 def test_busy_bus_refused(self):
  def run(args,**kw):
   if args[0]=='systemctl':return SimpleNamespace(stdout='LoadState=loaded\nActiveState=inactive')
   if args[0]=='fuser':return SimpleNamespace(returncode=0,stdout='123',stderr='')
   self.fail('Audit executed on busy device')
  with patch('os.geteuid',return_value=0),patch('pathlib.Path.resolve',return_value=Path('/dev/fixture')),patch('subprocess.run',side_effect=run):
   with self.assertRaisesRegex(RuntimeError,'busy'):self.collect(str(self.path),self.hashes)

class DossierTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.registry=RobotRegistry(Path(self.tmp.name)/'robots.json');self.rows=[]
  for name in ['one','two']:
   data=self.registry.change(dict(action='save',revision=self.registry.public()['revision'],robot=dict(robot_id=name,name=name,hostname='host',address='192.0.2.2',ssh_user='robot',ssh_port=22,state_port=5557,control_port=5558,robot_public_key='',notes='')))
   self.rows.append(next(r for r in data['robots'] if r['robot_id']==name))
  self.checks=SshChecks(self.registry);self.jobs=ManagementJobs(self.checks);self.audit=ServoAudit(self.jobs)
 async def asyncTearDown(self):
  await self.jobs.close(None);await self.checks.close(None);self.tmp.cleanup()
 async def test_save_isolation_versions_readback(self):
  identity=self.rows[0]['id'];initial=self.audit.view(identity)
  with self.assertRaisesRegex(ValueError,'Review and save'):self.audit.preview(identity)
  body=dict(revision=0,expected=defaults(),script=initial['script'],notes='Verified assembly');self.audit.save(identity,body)
  with self.assertRaisesRegex(ValueError,'changed'):self.audit.save(identity,body)
  self.assertFalse(self.audit.view(self.rows[1]['id'])['confirmed']);preview=self.audit.preview(identity)
  job=dict(id='a'*32,detail=preview['detail'],**preview['context']);session=SimpleNamespace(ssh=AsyncMock(return_value={'audit':audit()}))
  await self.audit.execute(job,session);saved=self.audit.view(identity)
  self.assertEqual(saved['latest']['outcome'],'match');self.assertEqual(job['motion_test'],'untested');self.assertEqual(self.registry.public()['robots'][0]['results'],{})
  changed=dict(body,revision=1);changed['expected']=defaults();changed['expected'][0]['homing_offset']=42;self.audit.save(identity,changed)
  with self.assertRaisesRegex(ValueError,'changed'):await self.audit.execute(job,session)
  self.assertEqual(saved['latest']['expected'][0]['homing_offset'],0)
 async def test_optional_notes_preserve_parameter_revision_and_readback(self):
  identity=self.rows[0]['id'];initial=self.audit.view(identity)
  body=dict(revision=0,expected=defaults(),script=initial['script'])
  saved=self.audit.save(identity,body)
  self.assertEqual(saved['revision'],1)
  preview=self.audit.preview(identity);job=dict(id='d'*32,detail=preview['detail'],**preview['context'])
  session=SimpleNamespace(ssh=AsyncMock(return_value={'audit':audit()}))
  await self.audit.execute(job,session)
  annotations={defaults()[0]['name']:dict(status='checked',notes='Direction checked by hand')}
  updated=self.audit.save(identity,dict(body,revision=1,annotations=annotations,notes=''))
  self.assertEqual(updated['revision'],1)
  self.assertEqual(updated['latest']['revision'],updated['revision'])
  self.assertEqual(updated['annotations'],annotations)
  self.assertEqual(updated['history'][-1]['operation'],'save_joint_notes')
  self.assertEqual(session.ssh.call_count,1,'Saving notes must not trigger another SSH audit')
  self.assertEqual(self.audit.view(self.rows[1]['id'])['annotations'],{})
  from host.policy_management import PolicyManagement
  view=PolicyManagement(self.jobs).view(identity)
  self.assertEqual(view['servo_history'][-1]['annotations'],annotations)
  for invalid in [{'unknown':dict(status='checked',notes='')},{defaults()[0]['name']:dict(status='passed',notes='')}]:
   with self.assertRaises(ValueError):self.audit.save(identity,dict(body,revision=1,annotations=invalid))

 async def test_query_does_not_resolve_policy(self):
  identity=self.rows[0]['id'];target=self.checks.target(self.rows[0]);self.jobs.save(dict(id='b'*32,profile_id=identity,target=target,operation='add_skill',status='unknown',mutation_started=True))
  self.jobs.resolve(dict(id='c'*32,profile_id=identity,target=target,operation='joint_readback'));self.assertTrue(self.jobs.unresolved(identity,'add_skill'))
