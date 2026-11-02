"""Isolated T1 TCP/CURVE tests. These are not physical robot acceptance results."""
import asyncio
import copy
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

import zmq
import zmq.asyncio
from aiohttp import ClientSession, web

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from agent.system_agent import SystemAgent
from agent.system_probe import SystemProbe
from host.server import create_app
from protocol.readonly import PROTOCOL, validate_state


def configs(endpoint):
    server_public, server_secret = zmq.curve_keypair()
    client_public, client_secret = zmq.curve_keypair()
    common = dict(protocol=PROTOCOL, robot_id='test-radxa', hostname=socket.gethostname(), endpoint=endpoint)
    agent = dict(common, role='agent', public_key=server_public.decode(), secret_key=server_secret.decode(),
                 peer_public_key=client_public.decode())
    host = dict(common, role='host', public_key=client_public.decode(), secret_key=client_secret.decode(),
                peer_public_key=server_public.decode())
    return agent, host


def fixture(root):
    proc, sysfs = root/'proc', root/'sys'
    (proc/'sys/kernel/random').mkdir(parents=True)
    (proc/'sys/kernel/random/boot_id').write_text('test-os-boot')
    (proc/'stat').write_text('cpu 10 0 10 80 0 0 0 0\n')
    (proc/'meminfo').write_text('MemTotal: 100 kB\nMemAvailable: 70 kB\n')
    (proc/'asound/card1').mkdir(parents=True)
    (proc/'asound/cards').write_text('1 [aic3104]: codec\n')
    (proc/'asound/card1/id').write_text('aic3104')
    (proc/'asound/pcm').write_text('01-00: codec : playback 1 : capture 1\n')
    zone = sysfs/'class/thermal/thermal_zone0'
    zone.mkdir(parents=True)
    (zone/'type').write_text('soc-thermal')
    (zone/'temp').write_text('42500')
    return SystemProbe(proc, sysfs)


class ProbeTests(unittest.TestCase):
    def test_card_binding_unknown_inputs_and_initial_cpu(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
            probe = fixture(Path(directory))
            state = probe.sample()
            self.assertIsNone(state['cpu_percent'])
            self.assertIsNone(state['external_power'])
            self.assertAlmostEqual(state['memory_percent'], 30)
            self.assertTrue(state['audio']['microphone_present'])
            (probe.proc/'stat').write_text('cpu 20 0 20 160 0 0 0 0\n')
            self.assertAlmostEqual(probe.sample()['cpu_percent'], 20)
            (probe.proc/'asound/card1/id').write_text('USB')
            self.assertFalse(probe.sample()['audio']['speaker_present'])
            (probe.proc/'asound/pcm').unlink()
            self.assertIsNone(probe.sample()['audio']['microphone_present'])
            (probe.proc/'meminfo').write_text('malformed')
            (probe.sys/'class/thermal/thermal_zone0/temp').write_text('unavailable')
            state = probe.sample()
            self.assertIsNone(state['memory_percent'])
            self.assertIsNone(state['cpu_temp'])


class ReadonlyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT/'tests')
        self.root = Path(self.temp.name)
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            endpoint = f'tcp://127.0.0.1:{s.getsockname()[1]}'
        self.agent_config, self.host_config = configs(endpoint)
        self.agent = SystemAgent(self.agent_config, fixture(self.root))
        self.stop = asyncio.Event()
        self.task = asyncio.create_task(self.agent.run(self.stop))
        self.app = create_app(record_root=self.root/'recordings', demos=0, readonly=self.host_config)
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        self.url = f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
        self.session = ClientSession()
        self.console = self.app['console']
        self.conn = self.console.connections['test-radxa']
        for _ in range(100):
            if self.conn.received_at:
                break
            await asyncio.sleep(.025)
        self.assertTrue(self.conn.received_at, 'CURVE telemetry handshake failed')

    async def asyncTearDown(self):
        self.stop.set()
        await self.task
        await self.session.close()
        await self.runner.cleanup()
        self.temp.cleanup()

    async def ws_command(self, ws, kind):
        await ws.send_json(dict(type=kind, id='test', robot_id='test-radxa', sent_at=time.time()*1000))
        while True:
            message = await asyncio.wait_for(ws.receive_json(), 2)
            if message['type'] == 'reply':
                return message

    async def test_real_source_two_observers_control_denial_and_recording(self):
        self.assertEqual(self.conn.state['source'], 'robot')
        self.assertTrue(validate_state(self.conn.state, self.host_config))
        self.assertIsNone(self.conn.dealer)
        self.assertTrue(all(not j['valid'] and j['position'] is None and j['torque'] is None
                            for j in self.conn.state['joints']))
        a = await self.session.ws_connect(self.url+'/ws', headers={'Origin': self.url})
        b = await self.session.ws_connect(self.url+'/ws', headers={'Origin': self.url})
        for ws in (a, b):
            response = await self.ws_command(ws, 'refresh_robots')
            self.assertEqual(response['result']['robots'][0]['source'], 'robot')
            for kind in ('claim', 'init', 'enable', 'drive', 'action', 'relax', 'estop', 'write_register'):
                self.assertFalse((await self.ws_command(ws, kind))['ok'])
        result = await self.ws_command(a, 'record_start')
        self.assertTrue(result['ok'])
        await asyncio.sleep(1.1)
        self.assertTrue((await self.ws_command(a, 'record_stop'))['ok'])
        rows = [json.loads(line) for line in
                (self.root/'recordings'/(result['result']['id']+'.jsonl')).read_text().splitlines()]
        self.assertEqual(rows[0]['data']['source'], 'robot')
        self.assertEqual(rows[0]['data']['clock_domain'], 'agent_monotonic')
        self.assertTrue(any(row['kind'] == 'state' for row in rows))
        self.assertFalse(any(row['kind'] == 'command' for row in rows))
        await a.close()
        await b.close()

    async def test_wrong_curve_client_and_wrong_server_key_receive_nothing(self):
        context = zmq.asyncio.Context()
        for wrong_server in (False, True):
            sub = context.socket(zmq.SUB)
            try:
                public, secret = zmq.curve_keypair()
                sub.curve_publickey = self.host_config['public_key'].encode() if wrong_server else public
                sub.curve_secretkey = self.host_config['secret_key'].encode() if wrong_server else secret
                sub.curve_serverkey = public if wrong_server else self.agent_config['public_key'].encode()
                sub.setsockopt(zmq.SUBSCRIBE, b'')
                sub.setsockopt(zmq.LINGER, 0)
                sub.connect(self.host_config['endpoint'])
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(sub.recv(), 1.2)
            finally:
                sub.close()
        context.term()

    async def test_identity_schema_and_fake_joint_values_are_rejected(self):
        for changes in ({'robot_id':'wrong'}, {'source':'simulation'}, {'hostname':'wrong'},
                        {'protocol':'old'}, {'seq':True}, {'sample_time':float('nan')},
                        {'enabled':True}, {'capabilities':{'motion':True}}):
            self.assertFalse(validate_state(dict(self.conn.state, **changes), self.host_config))
        state = copy.deepcopy(self.conn.state)
        state['joints'][0]['position'] = 0
        self.assertFalse(validate_state(state, self.host_config))

    async def test_duplicate_old_boot_and_out_of_order_do_not_refresh_connection(self):
        self.stop.set()
        await self.task
        base = copy.deepcopy(self.conn.state)
        packets = [dict(base), dict(base, robot_id='other'), dict(base, seq=base['seq']-1),
                   dict(base, boot_id='new-boot', seq=1), dict(base, seq=base['seq']+1)]
        queue = asyncio.Queue()
        for packet in packets:
            queue.put_nowait(packet)
        received_before = self.conn.received_at
        with patch.object(self.conn.sub, 'recv_json', side_effect=queue.get):
            receiver = asyncio.create_task(self.console.receive(self.conn))
            await asyncio.sleep(.03)
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
        self.assertEqual(self.conn.state['boot_id'], 'new-boot')
        self.assertEqual(self.conn.state['seq'], 1)
        self.assertGreater(self.conn.received_at, received_before)
        self.conn.received_at = time.monotonic()-3.1
        self.assertFalse(self.console.frame('observer')['robots'][0]['online'])

    async def test_browser_command_expiry_is_not_renewed(self):
        # The real connection stays blocked; test the existing simulation-only path.
        self.conn.readonly = None
        self.conn.received_at = time.monotonic()
        self.conn.request = AsyncMock(return_value={})
        before = time.monotonic()
        await self.console.command('owner', dict(robot_id='test-radxa', type='stop',
                                                sent_at=(time.time()-.20)*1000), {})
        self.assertLess(self.conn.request.call_args.args[0]['deadline']-before, .07)
        self.conn.request.reset_mock()
        with self.assertRaises(ValueError):
            await self.console.command('owner', dict(robot_id='test-radxa', type='drive',
                                                    sent_at=(time.time()-.26)*1000), {})
        self.conn.request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
