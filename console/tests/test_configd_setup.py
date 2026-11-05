"""Configd setup tests: all remote commands and service changes are mocked."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, AsyncMock
from host import configd_remote as remote
from host.configd_setup import ConfigdSetup, require_configd
from host.management_jobs import ManagementJobs, settings
from host.robot_registry import RobotRegistry
from host.ssh_checks import SshChecks

class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);(self.root/'current/bin').mkdir(parents=True)
        for name in ('configd','robotctl'):
            p=self.root/'current/bin'/name;p.write_text('test fixture only');p.chmod(0o700)
        self.values=dict(deploy_root=str(self.root),config_socket='/run/configd/configd.sock',allow_user='robot')
        self.unit=self.root/'configd.service'
        self.stack=[]
        for target,value in [('UNIT',self.unit),('BACKUPS',self.root/'backups')]:
            context=patch.object(remote,target,value);context.start();self.addCleanup(context.stop)
        account=SimpleNamespace(pw_uid=1000,pw_gid=1000)
        for target,value in [('pwd.getpwnam',account),('grp.getgrgid',SimpleNamespace(gr_name='robot'))]:
            context=patch('host.configd_remote.'+target,return_value=value);context.start();self.addCleanup(context.stop)
        self.state=patch.object(remote,'unit_state',side_effect=lambda name: {'LoadState':'not-found','ActiveState':'inactive','FragmentPath':'','DropInPaths':''} if name=='configd.service' else {'LoadState':'loaded','ActiveState':'active'})
        self.state.start();self.addCleanup(self.state.stop)

    def test_inspect_no_writes_and_blockers(self):
        result=remote.inspect(self.values)
        self.assertTrue(result['can_apply']);self.assertIn('--allow-user robot',result['desired'])
        self.assertIn('Group=robot',result['desired']);self.assertFalse(self.unit.exists())
        (self.root/'current/bin/configd').unlink()
        self.assertIn('Deploy the configd executable first',remote.inspect(self.values)['blockers'])
        with patch.object(remote,'unit_state',return_value={'LoadState':'loaded','ActiveState':'inactive','DropInPaths':'custom.conf'}):
            blockers=remote.inspect(self.values)['blockers']
            self.assertIn('Initialize and start system BlueZ first',blockers)
            self.assertIn('Existing configd drop-ins require manual review',blockers)

    def test_socket_and_privilege_boundaries(self):
        with self.assertRaises(ValueError):remote.config(dict(self.values,config_socket='/run/robotd/robotd.sock'))
        with self.assertRaises(ValueError):remote.config(dict(self.values,deploy_root='/tmp/../etc'))
        with patch.object(remote.os,'geteuid',return_value=1000):
            with self.assertRaisesRegex(ValueError,'administrator'):remote.apply({'config':self.values})

    def test_changed_snapshot_cannot_apply(self):
        request=dict(config=self.values,fingerprint='old',job_id='a'*32)
        with patch.object(remote.os,'geteuid',return_value=0),patch.object(remote,'run') as commands:
            with self.assertRaisesRegex(ValueError,'state changed'):remote.apply(request)
            commands.assert_not_called();self.assertFalse(self.unit.exists())

    def test_apply_backs_up_and_only_changes_configd(self):
        before=remote.inspect(self.values)
        with patch.object(remote.os,'geteuid',return_value=0),patch.object(remote,'run',return_value='') as commands,patch.object(remote,'verify',return_value={'pad_status':{'pads':[],'driver':'inactive'},'queried_as':'robot'}):
            result=remote.apply(dict(config=self.values,fingerprint=before['fingerprint'],job_id='a'*32))
        self.assertEqual(result['status'],'success')
        self.assertEqual(self.unit.read_text(),before['desired'])
        self.assertTrue((Path(result['backup'])/'previous.service').exists())
        self.assertEqual([call.args[0] for call in commands.call_args_list],[['systemctl','daemon-reload'],['systemctl','enable','configd.service'],['systemctl','start','configd.service']])

    def test_failure_keeps_backup_and_does_not_claim_success(self):
        before=remote.inspect(self.values)
        with patch.object(remote.os,'geteuid',return_value=0),patch.object(remote,'run',side_effect=ValueError('service failed')):
            result=remote.apply(dict(config=self.values,fingerprint=before['fingerprint'],job_id='b'*32))
        self.assertEqual(result['status'],'failed');self.assertIn('service failed',result['error'])
        saved=json.loads((Path(result['backup'])/'record.json').read_text())
        self.assertEqual(saved['status'],'failed')

    def test_verification_uses_ordinary_account(self):
        with patch.object(remote,'unit_state',return_value={'ActiveState':'active'}),patch.object(Path,'is_socket',return_value=True),patch.object(remote.os,'geteuid',return_value=0),patch.object(remote.os,'getgrouplist',return_value=[1000]),patch.object(remote,'run',return_value='{"pads":[],"driver":"inactive"}') as command:
            result=remote.verify(self.values)
        self.assertEqual(command.call_args.kwargs['user'],1000)
        self.assertEqual(result['queried_as'],'robot')

class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        registry=RobotRegistry(self.root/'robots.json')
        self.row=registry.change(dict(action='save',revision=0,robot=dict(robot_id='test_robot',name='Fixture',hostname='fixture',address='192.0.2.2',ssh_user='robot',ssh_port=22,state_port=5557,control_port=5558,robot_public_key='',notes='')))['robots'][0]
        self.checks=SshChecks(registry);self.jobs=ManagementJobs(self.checks);self.setup=ConfigdSetup(self.jobs)
    async def asyncTearDown(self):
        await self.jobs.close(None);await self.checks.close(None);self.tmp.cleanup()

    async def test_preview_needs_no_deploy_repository_but_apply_needs_matching_inspection(self):
        identity=self.row['id'];preview=self.setup.preview(identity,'configd_inspect')
        self.assertIn('script_sha256',preview['detail'])
        with self.assertRaisesRegex(ValueError,'Inspect configd'):self.setup.preview(identity,'configd_apply')
        context=self.jobs.context(identity)
        entry=dict(target=context['target'],settings=context['settings'],script_sha256=self.setup.script()[1],result=dict(can_apply=True,fingerprint='a'*64,diff='+service',desired='service',actions=[],scope='configd only'))
        self.jobs.registry.record_management(identity,'policy_management',{'configd_setup':entry})
        self.assertEqual(self.setup.preview(identity,'configd_apply')['detail']['fingerprint'],'a'*64)
        self.jobs.registry.record_management(identity,'management_settings',{'config_socket':'/run/configd/changed.sock'})
        with self.assertRaisesRegex(ValueError,'Inspect configd'):self.setup.preview(identity,'configd_apply')

    async def test_inspection_preserves_digest_and_old_redacted_records_require_recheck(self):
        identity=self.row['id'];context=self.jobs.context(identity)
        digest='01abc'+'f'*59
        inspection=dict(can_apply=True,fingerprint=digest,diff='',desired='unit',actions=[],scope='configd only')
        session=SimpleNamespace(ssh=AsyncMock(return_value=inspection))
        preview=self.setup.preview(identity,'configd_inspect')
        job=dict(id='e'*32,operation='configd_inspect',detail=preview['detail'],**context)
        await self.setup.execute(job,session)
        self.assertEqual(session.ssh.call_args.kwargs['sha256_fields'],('fingerprint',))
        self.assertEqual(self.setup.preview(identity,'configd_apply')['detail']['fingerprint'],digest)
        entry=self.jobs.row(identity)['policy_management']['configd_setup']
        entry['result']['fingerprint']=digest.replace('abc','[redacted]')
        self.jobs.registry.record_management(identity,'policy_management',{'configd_setup':entry})
        with self.assertRaisesRegex(ValueError,'Run Inspect again'):self.setup.preview(identity,'configd_apply')

    async def test_missing_service_gives_actionable_error(self):
        session=SimpleNamespace(ssh=AsyncMock(return_value={'service':{'LoadState':'not-found'},'socket_present':False}))
        with self.assertRaisesRegex(ValueError,'New robot tests'):await require_configd({'settings':settings(self.row)},session)
        self.assertEqual(session.ssh.await_count,1)
        self.assertEqual(session.ssh.call_args.args[0][0],'python3')

    async def test_script_change_rejects_execution(self):
        session=SimpleNamespace(ssh=AsyncMock())
        with self.assertRaisesRegex(ValueError,'script changed'):await self.setup.execute({'detail':{'script_sha256':'stale'}},session)
        session.ssh.assert_not_called()

if __name__=='__main__':unittest.main()
