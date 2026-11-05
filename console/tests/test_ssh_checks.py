import asyncio
import base64
import json
import os
import shlex
from pathlib import Path
import sys
import tempfile
import unittest
from aiohttp.test_utils import TestClient, TestServer
from host.robot_registry import RobotRegistry
from host.ssh_checks import SshChecks, REMOTE, install_ssh_checks, private_json
from host.server import create_app

PASSWORD='Unit-test-secret-7931'


class SshTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ssh-test-')
        self.registry=RobotRegistry(Path(self.temp.name)/'robots.json')
        values=dict(robot_id='test-robot',name='',hostname='',address='192.0.2.44',ssh_user='robot',ssh_port=2222,state_port=5557,control_port=5558,robot_public_key='',notes='')
        self.row=self.registry.change(dict(revision=0,action='save',robot=values))['robots'][0]
        self.runner=SshChecks(self.registry)
        self.commands=[]
        self.mode='success'
        self.asked_password=False
        async def fake_process(argv,timeout,env=None):
            self.commands.append(argv)
            self.assertNotIn(PASSWORD,' '.join(argv))
            if argv[0]=='/usr/bin/ssh-keyscan':
                if self.mode=='offline':return 1,'','Connection refused'
                return 0,'host ssh-ed25519 '+base64.b64encode(b'fixture-public-key').decode()+'\n',''
            self.assertEqual(argv[0],'/usr/bin/ssh')
            self.assertIn('StrictHostKeyChecking=yes',argv)
            self.assertIn('ClearAllForwardings=yes',argv)
            self.assertIn('PreferredAuthentications=password',argv)
            self.assertNotIn(PASSWORD,str(env))
            # Exercise the actual askpass executable and in-memory Unix socket, not a fake password return.
            proc=await asyncio.create_subprocess_exec(env['SSH_ASKPASS'],"robot password:",env=env,stdout=asyncio.subprocess.PIPE)
            data,_=await proc.communicate()
            self.assertEqual(data,PASSWORD.encode()+b'\n');self.assertEqual(proc.returncode,0);self.asked_password=True
            if self.mode=='wrong-password':return 255,'','Permission denied '+PASSWORD
            if self.mode=='timeout':raise asyncio.TimeoutError()
            if self.mode=='invalid-json':return 0,'not-json',''
            script=shlex.split(argv[-1])[2]
            kind=next(('stage_'+stage for stage in ('N01','N02','N04','N05','N06') if script.rstrip().endswith(repr(stage)+')))')), 'initialization' if 'def collect(context,' in script else 'system')
            return 0,json.dumps(dict(check=kind,hostname='actual-radxa',user='robot',read_only=True,number=0,diagnostic=PASSWORD)),''
        self.runner.process=fake_process

    async def asyncTearDown(self):
        await self.runner.close(None);self.temp.cleanup()

    async def trust(self):
        scan=await self.runner.scan(self.row['id'])
        self.assertTrue(scan['keys'][0]['fingerprint'].startswith('SHA256:'))
        self.runner.confirm(self.row['id'],scan['token'])

    async def finish(self):
        job=self.runner.start(self.row['id'],'system',PASSWORD)
        await asyncio.gather(*list(self.runner.tasks))
        return self.runner.job(job['id'])

    async def test_explicit_trust_and_password_job_with_no_secret_files(self):
        with self.assertRaises(ValueError):self.runner.start(self.row['id'],'system',PASSWORD)
        await self.trust()
        job=await self.finish()
        self.assertTrue(self.asked_password)
        self.assertEqual(job['status'],'completed')
        self.assertEqual(job['result']['hostname'],'actual-radxa')
        self.assertEqual(job['result']['diagnostic'],'[redacted]')
        self.assertEqual(job['result']['number'],0)
        for p in Path(self.temp.name).rglob('*'):
            if p.is_file():self.assertNotIn(PASSWORD,p.read_text())
        restored=SshChecks(self.registry)
        self.assertEqual(restored.status(self.row['id'])['latest_job'],job['id'])
        self.assertTrue(restored.status(self.row['id'])['trusted'])

    async def test_initialization_context_and_result_survive_other_checks(self):
        await self.trust()
        self.registry.record_management(self.row['id'], 'management_settings', {'deploy_root':'/home/robot/custom', 'config_socket':'/run/custom/configd.sock'})
        job=self.runner.start(self.row['id'], 'initialization', PASSWORD)
        await asyncio.gather(*list(self.runner.tasks))
        saved=self.runner.job(job['id'])
        self.assertEqual(saved['status'], 'completed')
        self.assertEqual(saved['check_context']['config_socket'], '/run/custom/configd.sock')
        self.assertEqual(saved['check_context']['deploy_root'], '/home/robot/custom')
        self.assertNotIn(PASSWORD, json.dumps(saved))
        script=shlex.split(self.commands[-1][-1])[2]
        compile(script, '<remote>', 'exec')
        await self.finish()
        restored=SshChecks(self.registry)
        self.assertEqual(restored.status(self.row['id'])['latest_initialization'], job['id'])
        self.assertNotEqual(restored.status(self.row['id'])['latest_job'], job['id'])

    async def test_stage_results_are_kept_separately_after_restart(self):
        await self.trust()
        ids = {}
        for stage in ('N01', 'N02', 'N04', 'N05', 'N06'):
            job = self.runner.start(self.row['id'], 'stage_'+stage, PASSWORD)
            await asyncio.gather(*list(self.runner.tasks))
            result = self.runner.job(job['id'])
            self.assertEqual(result['status'], 'completed', result.get('error'))
            ids[stage] = job['id']
        restored = SshChecks(self.registry)
        self.assertEqual(restored.status(self.row['id'])['latest_stages'], ids)

    async def test_scan_token_target_change_and_unapproved_operations(self):
        scan=await self.runner.scan(self.row['id'])
        with self.assertRaises(ValueError):self.runner.confirm(self.row['id'],'bad-token')
        self.row['address']='192.0.2.45'
        values={k:self.row[k] for k in ('robot_id','name','hostname','address','ssh_user','ssh_port','state_port','control_port','robot_public_key','notes')}
        self.registry.change(dict(revision=1,action='save',id=self.row['id'],robot=values))
        with self.assertRaises(ValueError):self.runner.confirm(self.row['id'],scan['token'])
        await self.trust()
        for kind in ('init','relax','enable','write-servo','reboot'):
            with self.assertRaises(ValueError):self.runner.start(self.row['id'],kind,PASSWORD)

    async def test_auth_failure_timeout_and_bad_output(self):
        await self.trust()
        for mode in ('wrong-password','timeout','invalid-json'):
            self.mode=mode
            job=await self.finish()
            self.assertEqual(job['status'],'failed')
            self.assertNotIn(PASSWORD,json.dumps(job))
        self.mode='offline'
        with self.assertRaises(ValueError):await self.runner.scan(self.row['id'])

    async def test_restart_marks_unfinished_jobs_without_replaying(self):
        private_json(self.runner.root/'jobs'/('a'*32+'.json'),dict(id='a'*32,profile_id=self.row['id'],status='running'))
        runner=SshChecks(self.registry)
        self.assertEqual(runner.job('a'*32)['status'],'interrupted')
        self.assertEqual(self.commands,[])

    async def test_single_flight_and_changed_target_invalidates_trust(self):
        await self.trust()
        self.runner.active.add(self.row['id'])
        with self.assertRaises(ValueError):self.runner.start(self.row['id'],'system',PASSWORD)
        self.runner.active.clear()
        self.row['ssh_user']='different'
        self.assertIsNone(self.runner.trusted(self.row))

    async def test_actual_process_timeout_and_bounded_output(self):
        real=SshChecks(self.registry)
        with self.assertRaises(asyncio.TimeoutError):
            await real.process([sys.executable,'-c','import time;time.sleep(10)'],.05)
        with self.assertRaises(ValueError):
            await real.process([sys.executable,'-c','print("x"*200000)'],2)
        self.assertEqual(real.processes,set())

    async def test_remote_collectors_execute_readonly_locally(self):
        # These fixed programs only read system files and list device/service metadata.
        for kind in ('system','interfaces','audio','services'):
            process=await asyncio.create_subprocess_exec(sys.executable,'-c',REMOTE.replace('CHECK_KIND',repr(kind)),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            stdout,stderr=await process.communicate()
            self.assertEqual(process.returncode,0,stderr.decode())
            result=json.loads(stdout);self.assertEqual(result['check'],kind);self.assertTrue(result['read_only'])


class SshApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_origin_required_before_any_ssh_activity(self):
        with tempfile.TemporaryDirectory() as temp:
            app=create_app(demos=0,record_root=Path(temp)/'records',registry_path=Path(temp)/'robots.json')
            async with TestClient(TestServer(app)) as client:
                response=await client.post('/api/commissioning/ssh/run',json={'profile_id':'none','password':PASSWORD})
                self.assertEqual(response.status,403)
                origin=str(client.make_url('/')).rstrip('/')
                response=await client.post('/api/commissioning/ssh/run',json={'profile_id':'none','password':PASSWORD},headers={'Origin':origin})
                self.assertEqual(response.status,400)
                self.assertNotIn(PASSWORD,await response.text())


if __name__=='__main__':unittest.main()
