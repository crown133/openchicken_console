import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from host import initialization_probe as probe
from host.ssh_checks import check_script


class InitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.context = dict(deploy_root=str(self.root), robot_config=str(self.root/'config/robotd.toml'),
                            pad_config=str(self.root/'config/robotd.toml'), robot_socket='/run/robotd/robotd.sock',
                            config_socket='/run/configd/configd.sock', robot_id='fixture')
        (self.root/'config').mkdir()
        (self.root/'config/robotd.toml').write_text('[netpad]\nenabled = false\n')
        (self.root/'config/agent.private.json').write_text(json.dumps(dict(robot_id='fixture', hostname='fixture-host',
            public_key='P'*40, secret_key='S'*40, peer_public_key='H'*40)))
        self.commands = []

    def command(self, argv):
        self.commands.append(argv)
        if argv[:2] == ['systemctl', 'show']:
            if argv[2] == 'configd.service': return dict(exit_code=1, stdout='LoadState=not-found\nActiveState=inactive\n', stderr='')
            return dict(exit_code=0, stdout='LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nUser=robot\n', stderr='')
        if argv == ['bluetoothctl', 'show']: return dict(exit_code=0, stdout='Controller XX\n\tPowered: yes\n', stderr='')
        return dict(exit_code=0, stdout='', stderr='')

    def collect(self):
        with patch.object(probe, 'command', self.command), patch.object(probe.socket, 'gethostname', return_value='fixture-host'):
            return probe.collect(self.context)

    def test_missing_service_is_distinct_from_bluetooth_and_no_keys_exported(self):
        data = self.collect(); sections = {s['id']:s for s in data['sections']}
        self.assertEqual(sections['configd']['state'], 'attention')
        self.assertEqual(sections['adapter']['state'], 'observed')
        self.assertEqual(sections['identity']['state'], 'observed')
        for secret in ('P'*40, 'S'*40, 'H'*40): self.assertNotIn(secret, json.dumps(data))
        self.assertEqual(sections['calibration']['state'], 'manual')
        self.assertEqual(sections['boot']['state'], 'manual')
        self.assertEqual(sections['runtime']['state'], 'manual')
        for args in self.commands:
            self.assertIn(args[0], ('id', 'fuser', 'systemctl', 'bluetoothctl', 'aplay', 'arecord'))
            if args[0] == 'systemctl': self.assertEqual(args[1], 'show')
            if args[0] in ('aplay', 'arecord'): self.assertEqual(args[1:], ['-l'])

    def test_missing_config_and_command_failure_stay_unknown(self):
        (self.root/'config/agent.private.json').unlink()
        with patch.object(probe, 'command', return_value={'error':'Permission denied'}):
            rows = {s['id']:s for s in probe.collect(self.context)['sections']}
        self.assertEqual(rows['identity']['state'], 'unknown')
        self.assertEqual(rows['configd']['state'], 'unknown')
        self.assertEqual(rows['adapter']['state'], 'unknown')
        self.assertEqual(rows['deployment']['state'], 'attention')

    def test_stage_checks_only_collect_their_own_sections(self):
        for stage, expected in probe.STAGES.items():
            self.commands.clear()
            with patch.object(probe, 'command', self.command):
                data = probe.collect(self.context, stage)
            self.assertEqual(data['check'], 'stage_'+stage)
            self.assertEqual({s['id'] for s in data['sections']}, expected)
            self.assertNotIn('S'*40, json.dumps(data))
            if stage in ('N01', 'N02', 'N06'):
                self.assertFalse(any(c[0] in ('systemctl', 'bluetoothctl', 'aplay', 'arecord') for c in self.commands))
            if stage == 'N04':
                units = [c[2] for c in self.commands if c[0] == 'systemctl']
                self.assertEqual(set(units), {'openchicken-speaker-init.service', 'aic3104-init.service'})
            compile(check_script('stage_'+stage, self.context), '<stage-check>', 'exec')
        with self.assertRaises(ValueError): probe.collect(self.context, 'N03')

    def test_remote_script_uses_snapshot_context_and_compiles(self):
        script = check_script('initialization', self.context)
        compile(script, '<remote-inventory>', 'exec')
        self.assertIn(repr(self.context), script)
        self.assertNotIn('secret_key=', script)
        self.assertIn("kind='system'", check_script('system').replace(' ', ''))


if __name__ == '__main__': unittest.main()
