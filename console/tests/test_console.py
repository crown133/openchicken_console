import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from aiohttp import ClientSession, web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent.simulator import RobotSimulation
from agent.system_probe import SystemProbe
from host.recording import Recorder
from host.server import create_app, snapshot_from_audit
from protocol.model import JOINTS

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT.parent/'robots/openchicken1/records/servo-config-audit-20261028T024006Z.json'


class SimulationTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.robot = RobotSimulation('test', lambda: self.now)
        self.seq = 0
        self.token = self.send('claim')['token']
        self.initialize()
        self.send('enable')

    def send(self, kind, payload=None, **changes):
        self.seq += 1
        message = dict(type=kind, payload=payload or {}, robot_id='test', boot_id=self.robot.boot_id,
                       owner='browser-a', token=getattr(self, 'token', None), seq=self.seq,
                       deadline=self.now+0.25)
        message.update(changes)
        return self.robot.command(message)

    def initialize(self):
        self.send('init')
        self.now += 2
        self.robot.sample()
        self.token = self.send('claim')['token']

    def test_init_homing_ready_without_enabling_policy(self):
        self.send('relax')
        self.token = self.send('claim')['token']
        self.robot.q[13] = .8
        self.assertEqual(self.robot.sample()['bringup'], 'Limp')
        self.send('init')
        first = self.robot.sample()
        self.assertEqual(first['bringup'], 'Homing')
        self.assertTrue(first['torqued'])
        self.assertFalse(first['enabled'])
        with self.assertRaises(ValueError):
            self.send('enable')
        self.now += .5
        self.send('init')  # A duplicate does not restart the ramp.
        mid = self.robot.sample()
        knee = next(j for j in mid['joints'] if j['id'] == 13)
        self.assertAlmostEqual(knee['position'], .8 + (.0049 - .8) * .25)
        self.now += 1.5
        ready = self.robot.sample()
        self.assertEqual(ready['bringup'], 'Ready')
        self.assertFalse(ready['enabled'])
        self.assertTrue(all(j['torque'] for j in ready['joints']))
        self.token = self.send('claim')['token']
        with self.assertRaises(ValueError):
            self.send('drive', dict(vx=.1, vyaw=0))
        self.send('enable')
        self.send('drive', dict(vx=.1, vyaw=0))

    def test_relax_interrupts_homing_and_stays_limp(self):
        self.send('init')
        self.now += .2
        self.robot.sample()
        position = dict(self.robot.q)
        self.send('relax', owner='observer', token=None)
        self.now += 3
        state = self.robot.sample()
        self.assertEqual(state['bringup'], 'Limp')
        self.assertFalse(state['torqued'])
        self.assertFalse(state['enabled'])
        self.assertEqual(self.robot.q, position)
        self.assertIsNone(self.robot.owner)

    def test_init_preserves_seated_target(self):
        self.robot.seated = True
        self.initialize()
        state = self.robot.sample()
        self.assertEqual(state['bringup'], 'Ready')
        self.assertTrue(state['seated'])
        self.assertAlmostEqual(self.robot.q[13], .0049 - 1.1)
        self.assertAlmostEqual(self.robot.q[23], -.0049 + 1.1)

    def test_deadman_and_owner_expiry(self):
        self.send('drive', {'vx': .12, 'vyaw': .1})
        self.now += .251
        self.robot.sample()
        self.assertEqual(self.robot.velocity, {'vx': 0, 'vyaw': 0})
        self.assertEqual(self.robot.owner, 'browser-a')
        self.now += .56
        self.robot.sample()
        self.assertIsNone(self.robot.owner)

    def test_leases_identity_and_deadlines(self):
        for changes in [dict(owner='browser-b'), dict(robot_id='other'), dict(boot_id='old'),
                        dict(deadline=self.now-.001), dict(deadline=float('nan')),
                        dict(seq=0), dict(token='wrong')]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.send('heartbeat', **changes)
        with self.assertRaises(ValueError):
            self.send('claim', owner='browser-b')

    def test_release_and_reclaim(self):
        self.send('drive', {'vx': .12, 'vyaw': 0})
        self.send('release')
        self.assertEqual(self.robot.velocity['vx'], 0)
        token = self.send('claim', owner='browser-b')['token']
        self.assertNotEqual(self.token, token)

    def test_invalid_velocity_never_applied(self):
        for velocity in [dict(vx=float('nan'), vyaw=0), dict(vx=1, vyaw=0),
                         dict(vx=True, vyaw=0), dict(vx=0), [1, 2]]:
            with self.subTest(velocity=velocity), self.assertRaises(ValueError):
                self.send('drive', velocity)
            self.assertEqual(self.robot.velocity, dict(vx=0, vyaw=0))

    def test_action_dedup_and_completion(self):
        payload = dict(skill='kick_left', action_id='a1')
        first = self.send('action', payload)
        second = self.send('action', payload)
        self.assertEqual(first, second)
        with self.assertRaises(ValueError):
            self.send('action', dict(skill='kick_right', action_id='a1'))
        self.now += .81
        self.robot.sample()
        self.assertEqual(self.robot.results[('browser-a','a1')]['status'], 'completed')
        self.assertEqual(len(self.robot.results), 1)

    def test_simulated_estop_cancels_action_and_requires_restart(self):
        self.send('action', dict(skill='kick_left', action_id='stop-me'))
        self.now += .1
        self.robot.sample()
        position = dict(self.robot.q)
        self.send('estop', owner='observer', token=None)
        self.assertFalse(self.robot.enabled)
        self.assertIsNone(self.robot.owner)
        self.assertEqual(self.robot.action['status'], 'cancelled')
        self.now += .1
        stopped = self.robot.sample()
        self.assertEqual(self.robot.q, position)
        self.assertTrue(all(not joint['torque'] for joint in stopped['joints']))
        self.token = self.send('claim')['token']
        with self.assertRaises(ValueError):
            self.send('drive', dict(vx=.1, vyaw=0))
        self.initialize()
        self.send('enable')
        self.send('drive', dict(vx=.1, vyaw=0))
        self.assertTrue(self.robot.enabled)

    def test_estop_keeps_identity_and_deadline_checks(self):
        for changes in [dict(robot_id='other'), dict(boot_id='old'), dict(deadline=self.now-.01)]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.send('estop', **changes)
            self.assertTrue(self.robot.enabled)

    def test_simulated_imu_contract(self):
        import math
        first = self.robot.sample()['imu']
        self.now += .05
        second = self.robot.sample()['imu']
        self.assertEqual(second['frame'], 'body_to_world')
        self.assertEqual(second['source'], 'simulation')
        self.assertTrue(second['valid'])
        self.assertEqual(second['sample_time'], self.now)
        self.assertAlmostEqual(math.hypot(*second['quat']), 1)
        self.assertNotEqual(first['quat'], second['quat'])

    def test_malformed_request_and_payload(self):
        for request in [[], None, 'bad']:
            with self.assertRaises(ValueError):
                self.robot.command(request)
        with self.assertRaises(ValueError):
            self.send('action', payload='bad')


class DataTests(unittest.TestCase):
    def test_system_probe_unknown_and_read_only(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
            root = Path(directory)
            proc, sysfs = root/'proc', root/'sys'
            probe = SystemProbe(proc, sysfs)
            unknown = probe.sample()
            self.assertIsNone(unknown['external_power'])
            self.assertIsNone(unknown['cpu_temp'])
            self.assertEqual(unknown['speaker'], '未知')
            proc.mkdir()
            (proc/'stat').write_text('cpu 10 0 10 80 0 0 0 0 0 0\n')
            (proc/'meminfo').write_text('MemTotal: 100 kB\nMemAvailable: 70 kB\n')
            (proc/'asound').mkdir()
            (proc/'asound/pcm').write_text('00-00: card : playback 1 : capture 1\n')
            (proc/'asound/cards').write_text('0 [aic3104]: board audio\n')
            (proc/'asound/card0').mkdir()
            (proc/'asound/card0/id').write_text('aic3104')
            zone = sysfs/'class/thermal/thermal_zone0'
            zone.mkdir(parents=True)
            (zone/'type').write_text('soc-thermal')
            (zone/'temp').write_text('42500')
            supply = sysfs/'class/power_supply/AC'
            supply.mkdir(parents=True)
            (supply/'type').write_text('Mains')
            (supply/'online').write_text('1')
            probe.sample()
            (proc/'stat').write_text('cpu 20 0 20 160 0 0 0 0 0 0\n')
            state = probe.sample()
            self.assertAlmostEqual(state['cpu_percent'], 20)
            self.assertAlmostEqual(state['memory_percent'], 30)
            self.assertEqual(state['cpu_temp'], 42.5)
            self.assertIsNone(state['external_power'])  # Generic mains is not Pin31.
            self.assertEqual(state['speaker'], '已枚举 · 未验证')
            self.assertFalse(state['audio']['playback_verified'])

    def test_audit_is_historic_and_read_only(self):
        state = snapshot_from_audit(AUDIT)
        self.assertFalse(state['capabilities']['motion'])
        self.assertEqual(len(state['joints']), 14)
        self.assertTrue(all(j['p'] == 400 and j['requested'] is None and not j['valid'] for j in state['joints']))
        self.assertIsNone(state['system']['external_power'])

    def test_recording_format_and_capacity(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
            recorder = Recorder(directory)
            recorder.MAX_BYTES = 350
            result = recorder.start('one', {'schema_version': 1})
            recorder.write('state', {'robot_id': 'one'})
            recorder.write('state', {'large': 'a'*400})
            self.assertFalse(recorder.status()['active'])
            self.assertIsNotNone(recorder.error)
            path = Path(directory)/(result['id']+'.jsonl')
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual([r['kind'] for r in rows], ['metadata', 'state'])
            self.assertLessEqual(path.stat().st_size, 350)

    def test_model_names_and_meshes(self):
        root = ET.parse(ROOT/'models/alpha/robot.urdf').getroot()
        names = {j.attrib['name'] for j in root.findall('joint') if j.attrib['type'] != 'fixed'}
        self.assertEqual(names, {name for _,name,_,_ in JOINTS})
        self.assertEqual(len(root.findall('.//visual')), 59)
        for mesh in root.findall('.//mesh'):
            self.assertTrue((ROOT/'models/alpha'/mesh.attrib['filename']).is_file())


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT/'tests')
        self.app = create_app(AUDIT, self.temp.name, demos=2)
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.url = f'http://127.0.0.1:{port}'
        self.session = ClientSession()
        for _ in range(30):
            if all(c.state for c in self.app['console'].connections.values()):
                break
            await asyncio.sleep(.02)

    async def asyncTearDown(self):
        await self.session.close()
        await self.runner.cleanup()
        self.temp.cleanup()

    async def websocket(self):
        return await self.session.ws_connect(self.url+'/ws', headers={'Origin': self.url})

    async def command(self, ws, kind, robot='demo-01', payload=None):
        import time
        await ws.send_json(dict(id='test', type=kind, robot_id=robot, payload=payload or {}, sent_at=time.time()*1000))
        async def receive():
            while True:
                message = await ws.receive_json()
                if message.get('type') == 'reply':
                    return message
        return await asyncio.wait_for(receive(), 3)

    async def test_refresh_robots_reads_current_registry_without_control(self):
        ws = await self.websocket()
        first = await self.command(ws, 'refresh_robots')
        self.assertTrue(first['ok'])
        self.assertEqual({r['robot_id'] for r in first['result']['robots']},
                         {'openchicken1', 'demo-01', 'demo-02'})
        console = self.app['console']
        console.snapshots['new-snapshot'] = dict(console.snapshots['openchicken1'], robot_id='new-snapshot')
        refreshed = await self.command(ws, 'refresh_robots')
        self.assertIn('new-snapshot', {r['robot_id'] for r in refreshed['result']['robots']})
        for robot in refreshed['result']['robots']:
            if robot['source'] == 'simulation':
                self.assertFalse(robot['controlled'])
                self.assertFalse(robot['enabled'])
        await ws.close()

    async def test_multi_browser_switch_disconnect(self):
        a, b = await self.websocket(), await self.websocket()
        self.assertTrue((await self.command(a, 'claim'))['ok'])
        self.assertFalse((await self.command(b, 'claim'))['ok'])
        self.assertTrue((await self.command(b, 'claim', 'demo-02'))['ok'])
        await self.command(b, 'release', 'demo-02')
        self.assertTrue((await self.command(a, 'claim', 'demo-02'))['ok'])
        self.assertTrue((await self.command(b, 'claim'))['ok'])
        await a.close()
        await asyncio.sleep(.1)
        self.assertTrue((await self.command(b, 'claim', 'demo-02'))['ok'])
        self.assertFalse((await self.command(b, 'enable', 'openchicken1'))['ok'])
        await b.close()

    async def test_english_route_and_observer_estop(self):
        response = await self.session.get(self.url+'/en/')
        self.assertEqual(response.status, 200)
        self.assertIn('Make Life a Little More Fun.', await response.text())
        a, b = await self.websocket(), await self.websocket()
        self.assertTrue((await self.command(a, 'claim'))['ok'])
        self.assertTrue((await self.command(a, 'init'))['ok'])
        for _ in range(22):
            await asyncio.sleep(.1)
            self.assertTrue((await self.command(a, 'heartbeat'))['ok'])
        self.assertTrue((await self.command(a, 'enable'))['ok'])
        self.assertTrue((await self.command(a, 'action', payload=dict(skill='kick_left', action_id='e1')))['ok'])
        self.assertTrue((await self.command(b, 'estop'))['ok'])
        self.assertFalse((await self.command(a, 'drive', payload=dict(vx=.1, vyaw=0)))['ok'])
        self.assertFalse((await self.command(b, 'estop', 'openchicken1'))['ok'])
        await a.close()
        await b.close()

    async def test_workspace_switch_relaxes_own_robot_and_blocks_later_input(self):
        a, b = await self.websocket(), await self.websocket()
        try:
            self.assertTrue((await self.command(a, 'claim'))['ok'])
            self.assertTrue((await self.command(a, 'init'))['ok'])
            self.assertTrue((await self.command(b, 'claim', 'demo-02'))['ok'])
            result = await self.command(a, 'set_mode', payload={'mode':'commissioning'})
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['result']['mode'], 'commissioning')
            self.assertFalse((await self.command(a, 'init'))['ok'])
            self.assertFalse((await self.command(a, 'drive', payload={'vx':.1}))['ok'])
            self.assertTrue((await self.command(b, 'heartbeat', 'demo-02'))['ok'])
            await asyncio.sleep(.1)
            robots = {r['robot_id']:r for r in self.app['console'].frame('test')['robots']}
            self.assertFalse(robots['demo-01']['torqued'])
            self.assertTrue(robots['demo-01']['online'])
            self.assertTrue((await self.command(a, 'set_mode', payload={'mode':'monitor'}))['ok'])
            # Returning to Monitor neither claims nor re-enables the robot.
            self.assertFalse((await self.command(a, 'drive', payload={'vx':.1}))['ok'])
        finally:
            await a.close()
            await b.close()

    async def test_record_download_and_web_origin(self):
        ws = await self.websocket()
        result = await self.command(ws, 'record_start')
        self.assertTrue(result['ok'])
        record_id = result['result']['id']
        active = await self.session.get(self.url+'/api/recordings/'+record_id)
        self.assertEqual(active.status, 409)
        await asyncio.sleep(.15)
        self.assertTrue((await self.command(ws, 'record_stop'))['ok'])
        response = await self.session.get(self.url+'/api/recordings/'+record_id)
        rows = [json.loads(line) for line in (await response.text()).splitlines()]
        self.assertEqual(rows[0]['kind'], 'metadata')
        self.assertTrue(any(row['kind'] == 'state' for row in rows))
        self.assertTrue(all(row['data']['robot_id'] == 'demo-01' for row in rows if row['kind'] == 'state'))
        self.assertEqual(rows[-1]['kind'], 'recording_end')
        denied = await self.session.get(self.url+'/ws', headers={'Origin':'https://untrusted.invalid'})
        self.assertEqual(denied.status, 403)
        denied = await self.session.get(self.url+'/', headers={'Host':'untrusted.invalid'})
        self.assertEqual(denied.status, 403)
        await ws.close()


if __name__ == '__main__':
    unittest.main()
