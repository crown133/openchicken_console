"""Live management input routes, using fake transports and temporary dossiers."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zmq

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'console'))
from tests.test_management import registry_at,EXAMPLE
from host.management_jobs import ManagementJobs,settings,program_evidence
from host.ssh_checks import SshChecks,private_json
from host import policy_package as package


def candidate(name):
    return __import__('host.'+name, fromlist=[name])


class ManagementInputTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnected_transport_never_queues_or_retries(self):
        module=candidate('server')
        class Dealer:
            calls=0
            async def send_json(self,*args,**kwargs):
                self.calls+=1
                raise zmq.Again()
        conn=module.Connection.__new__(module.Connection);conn.readonly=None;conn.pending={};conn.dealer=Dealer();conn.runtime=True
        with self.assertRaisesRegex(ValueError,'not queued'):await conn.request({'type':'init'})
        self.assertEqual(conn.dealer.calls,1);self.assertFalse(conn.pending)

    async def test_native_binding_preview_write_readback_and_conflict(self):
        module=candidate('policy_management')
        with tempfile.TemporaryDirectory() as directory:
            registry,row=registry_at(Path(directory));checks=SshChecks(registry);jobs=ManagementJobs(checks);policies=module.PolicyManagement(jobs)
            config=settings(row);config['pad_config']='/actual/padd.toml';target=checks.target(row)
            registry.record_management(row['id'],'management_settings',config)
            registry.record_management(row['id'],'program_deployment',{'last_query':dict(result={'status':'success','build_id':'v1'},target=target,settings=config,queried_at='2026-11-03T00:00:00Z')})
            program=program_evidence(registry.public()['robots'][0]);version_id='a'*32;deployment_id='b'*32
            params=package.manifest(EXAMPLE)
            record=dict(id=version_id,params=params,manifest=EXAMPLE,sha256='a'*64,remote_path='/archived/policy.onnx',config_result='confirmed',load_result='unknown',motion_test='passed',last_target=target,
                        deployment=dict(id=deployment_id,target=target,settings=config,program=program),tests=[dict(status='passed',deployment_id=deployment_id,program=program)])
            private_json(policies.root(row['id'])/'versions'/version_id/'record.json',record)
            result={'policies':{'slots':[],'skills':['polite_bow']},'skills':{'skills':[dict(params,path=record['remote_path'])]}}
            mapping=dict(lb_a='sit_toggle',lb_down='ground_pick',lb_left='kick_left',lb_right='kick_right',lb_up='roulade')
            registry.record_management(row['id'],'policy_management',{'last_query':dict(result=result,target=target,settings=config,job_id='query'),
                'native_bindings':dict(result=mapping.copy(),target=target,settings=config)})
            class Fake:
                def __init__(self):self.writes=[]
                async def ssh(self,args,*unused):
                    if args[0]=='python3':return {'verified':True,'bringup':'Limp','enabled':False}
                    if 'list' in args:return result
                    if 'bindings' in args:return mapping.copy()
                    if 'bind' in args:
                        index=args.index('bind');button,skill=args[index+1:index+3];mapping[button]=skill;self.writes.append((button,skill));return {'button':button,'skill':skill}
                    if 'reset' in args:
                        mapping['lb_left']='kick_left';self.writes.append(('reset','lb_left'));return {'reset':['lb_left']}
                    raise AssertionError(args)
            fake=Fake()
            def job(preview):return dict(id='c'*32,**preview['context'],operation=preview['operation'],detail=preview['detail'],status='running',log=[],config_result='not_attempted')
            body=dict(button='lb_left',version_id=version_id)
            preview=policies.preview(row['id'],'pad_bind',body)
            for button in ('start','lb_b','rb'):
                with self.assertRaises(ValueError):policies.preview(row['id'],'pad_bind',dict(body,button=button))
            mapping['lb_left']='changed_elsewhere'
            with self.assertRaisesRegex(ValueError,'changed after preview'):await policies.execute(job(preview),fake)
            self.assertFalse(fake.writes)
            mapping['lb_left']='kick_left';task=job(preview);await policies.execute(task,fake)
            self.assertEqual(fake.writes,[('lb_left','polite_bow')]);self.assertEqual(task['config_result'],'confirmed')
            task=job(policies.preview(row['id'],'pad_reset_binding',body));await policies.execute(task,fake)
            self.assertEqual(mapping['lb_left'],'kick_left');self.assertEqual(task['config_result'],'confirmed')
            await jobs.close(None);await checks.close(None)

if __name__=='__main__':unittest.main()
