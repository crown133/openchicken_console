import copy
import json
from pathlib import Path
import tempfile
import unittest
from protocol.pad import VERSION, DEFAULTS, load_profile, calls
from host.robot_registry import RobotRegistry


class PadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'robotd.toml'
        self.path.write_text('')
        self.profile = load_profile(self.path)

    def payload(self, **values):
        return dict(version=VERSION, sha256=self.profile['sha256'], **values)

    def test_native_defaults_and_partial_overrides(self):
        self.assertEqual(self.profile['parameters'], DEFAULTS)
        self.path.write_text('[pad_head]\nhead_yaw_max = 0.5\n[pad_axes.drive.vx]\ngain = 2.0\n')
        profile = load_profile(self.path)
        self.assertEqual(profile['parameters']['pad_head']['head_yaw_max'], .5)
        self.assertEqual(profile['parameters']['pad_head']['neck_pitch_max'], 2.5)
        self.assertEqual(profile['parameters']['pad_axes']['drive']['vx']['gain'], 2.)
        self.assertNotEqual(profile['sha256'], self.profile['sha256'])

    def test_missing_invalid_or_different_native_contract_blocks_input(self):
        with self.assertRaises(ValueError): load_profile(None)
        for text in ('[pad_axes]\ndeadzone=0.12', '[pad_drive]\nvx_max=0.6', '[pad_head]\nhead_yaw_max=nan', '[pad_axes.drive.vx]\nsource="bad"', '[pad]\nlb_a=4'):
            self.path.write_text(text)
            with self.assertRaises(ValueError): load_profile(self.path)

    def test_custom_native_binding_is_forwarded_and_invalidates_old_profile(self):
        self.path.write_text('[pad]\nlb_left="bow"\n')
        profile = load_profile(self.path)
        self.assertNotEqual(profile['sha256'], self.profile['sha256'])
        with self.assertRaises(ValueError): calls('pad_command', self.payload(actions=['kick_left']), profile)
        payload = dict(version=VERSION, sha256=profile['sha256'], actions=['kick_left'])
        self.assertEqual(calls('pad_command', payload, profile), [('robot.do', {'skill':'bow'})])

    def test_home_is_disable_then_init_not_relax(self):
        result = calls('pad_command', self.payload(actions=['home']), self.profile)
        self.assertEqual(result[-2:], [('robot.enable', {'on':False,'toggle':False}), ('robot.init',{})])
        self.assertNotIn('robot.relax', [x[0] for x in result])
        self.assertEqual(calls('pad_command', self.payload(actions=['toggle']), self.profile), [('robot.enable', {'on':False,'toggle':True})])

    def test_actions_rest_shutdown_and_chirp_forward_native_names(self):
        for action in ('sit_toggle','ground_pick','kick_left','kick_right','roulade'):
            self.assertEqual(calls('pad_command', self.payload(actions=[action]), self.profile), [('robot.do', {'skill':action})])
        for action in ('rest','shutdown','init'):
            self.assertEqual(calls('pad_command', self.payload(actions=[action]), self.profile), [('robot.'+action,{})])
        self.assertEqual(calls('pad_command',self.payload(actions=['chirp']),self.profile), [('robot.sound',{'tag':'chirp'})])

    def test_atomic_validation_of_continuous_frame(self):
        payload=self.payload(velocity=dict(vx=.2,vy=-.15,vyaw=.5),head=dict(neck_pitch=.1,head_pitch=0,head_roll=0,head_yaw=0),pose=dict(z=-.02,roll=.1,pitch=0,active=True),mouth=.7,wheee=True,crow=True)
        result=calls('pad_input',payload,self.profile)
        self.assertEqual([x[0] for x in result],['robot.move','robot.head','robot.pose','robot.mouth','robot.sound','robot.sound'])
        self.assertEqual(result[-2:], [('robot.sound',{'tag':'wheee','hold':True}),('robot.sound',{'tag':'chirp','hold':True})])
        for change in (dict(mouth=1.1),dict(wheee='true'),dict(crow='true'),dict(sha256='old'),dict(velocity=dict(vx=1,vy=0,vyaw=0)),dict(head={'neck_pitch':float('nan')})):
            with self.assertRaises(ValueError): calls('pad_input',dict(payload,**change),self.profile)
        suspended=dict(payload,head=None,pose=None,mouth=0,wheee=False,velocity=dict(vx=0,vy=0,vyaw=0))
        self.assertEqual([x[0] for x in calls('pad_input',suspended,self.profile)],['robot.move','robot.mouth','robot.sound','robot.sound'])

    def test_dossier_keeps_stable_identity_and_unverified_hardware(self):
        registry=RobotRegistry(Path(self.temp.name)/'robots.json')
        fields=dict(robot_id='test',name='test',hostname='radxa',address='192.0.2.1',ssh_user='',ssh_port=22,state_port=5557,control_port=5558,robot_public_key='',notes='')
        saved=registry.change(dict(action='save',revision=0,robot=fields))
        identity=saved['robots'][0]['id']
        registry.record_pad('test',self.profile)
        registry.record_pad('test',self.profile)
        row=registry.public()['robots'][0]
        self.assertEqual(len(row['pad_history']),1)
        self.assertFalse(row['pad_mapping']['hardware_verified'])
        self.assertFalse(row['pad_mapping']['native_mapping_verified'])
        self.assertFalse(row['pad_mapping']['audio_verified'])
        fields.update(robot_id='renamed',address='192.0.2.2')
        registry.change(dict(action='save',revision=registry.data['revision'],id=identity,robot=fields))
        self.assertEqual(registry.public()['robots'][0]['pad_history'],row['pad_history'])


if __name__=='__main__': unittest.main()
