import asyncio
import json
from pathlib import Path
import socket
import tempfile
import unittest

import zmq
from aiohttp.test_utils import TestClient, TestServer
from agent.system_agent import SystemAgent
from host.server import create_app, Connection
from host.commissioning_telemetry import CommissioningTelemetry
from host.robot_registry import RobotRegistry
from protocol.readonly import PROTOCOL, JOINT_PROTOCOL


def profile(port):
    return dict(robot_id='new-robot',name='New robot',hostname=socket.gethostname(),address='127.0.0.1',
                ssh_user='robot',ssh_port=22,state_port=port,control_port=5558,robot_public_key='',notes='')


class TelemetryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        registry=RobotRegistry(self.root/'robots.json')
        row=registry.change(dict(action='save',revision=0,robot=profile(port)))['robots'][0];self.identity=row['id']
        self.app=create_app(demos=0,registry_path=registry.path,record_root=self.root/'records')
        self.client=TestClient(TestServer(self.app));await self.client.start_server()
        self.console=self.app['console'];self.manager=CommissioningTelemetry(self.console,Connection)
        self.stop=None;self.agent_task=None

    async def asyncTearDown(self):
        await self.manager.close(None)
        if self.stop:self.stop.set();await self.agent_task
        await self.client.close();self.tmp.cleanup()

    def prepare(self):
        return self.manager.prepare(self.identity,dict(protocol=PROTOCOL,peer_public_key=''))

    async def test_private_keys_stable_and_status_never_exposes_secrets(self):
        public=self.prepare();first=self.manager.read(self.identity)
        again=self.prepare()
        self.assertEqual(public['config']['public_key'],again['config']['public_key'])
        self.assertNotIn(first['secret_key'],json.dumps(public));self.assertNotIn('secret_key',public['config'])
        self.assertFalse(public['ready']);self.assertEqual(self.manager.path(self.identity).stat().st_mode & 0o777,0o600)
        with self.assertRaises(ValueError):self.manager.connect(self.identity)
        self.assertEqual(self.console.connections,{})

    async def test_import_rejects_runtime_control_identity_bad_keys_and_unknown_fields(self):
        self.prepare();config=self.manager.read(self.identity);public,_=zmq.curve_keypair();config['peer_public_key']=public.decode()
        self.manager.prepare(self.identity,{'config':config})
        before=self.manager.path(self.identity).read_bytes()
        for key,value in [('protocol','openchicken-runtime-v1'),('control_endpoint','tcp://127.0.0.1:5558'),('robot_id','other'),('hostname','other'),('endpoint','tcp://127.0.0.1:3'),('secret_key','x'*40),('peer_public_key','~'*40),('command','init')]:
            wrong=dict(config);wrong[key]=value
            with self.assertRaises((ValueError,zmq.ZMQError)):
                self.manager.prepare(self.identity,{'config':wrong})
            self.assertEqual(self.manager.path(self.identity).read_bytes(),before)

    async def start_publisher(self, protocol=PROTOCOL):
        self.prepare();config=self.manager.read(self.identity);public,secret=zmq.curve_keypair()
        config['protocol']=protocol;config['peer_public_key']=public.decode();self.manager.prepare(self.identity,{'config':config})
        agent_config=dict(config,role='agent',public_key=public.decode(),secret_key=secret.decode(),peer_public_key=config['public_key'])
        class Probe:
            proc=Path('/proc')
            def sample(self):
                return dict(cpu_percent=12,cpu_temp=40,memory_percent=20,voltage=None,external_power=None,speaker='未知',microphone='未知')
        if protocol==JOINT_PROTOCOL:
            from agent.joint_agent import JointAgent
            from test_joints import FakeJoints
            joints=FakeJoints();joints.count=2304
            agent=JointAgent(agent_config,joints,Probe())
        else:
            agent=SystemAgent(agent_config,Probe())
        agent.period=.03
        self.stop=asyncio.Event();self.agent_task=asyncio.create_task(agent.run(self.stop))
        return agent

    async def test_real_curve_stream_readonly_stale_disconnect_reconnect_and_restart(self):
        agent=await self.start_publisher()
        initial=self.manager.connect(self.identity);self.assertEqual(initial['status'],'waiting')
        conn=self.console.connections['new-robot'];self.assertIsNone(conn.dealer);self.assertFalse(conn.runtime)
        for _ in range(100):
            if conn.received_at:break
            await asyncio.sleep(.03)
        self.assertTrue(conn.received_at,'Actual local CURVE stream failed')
        self.assertEqual(self.manager.status(self.identity)['status'],'receiving')
        self.assertEqual(self.console.frame('observer')['robots'][0]['system']['cpu_percent'],12)
        for kind in ('claim','init','enable','relax','velocity','action'):
            with self.assertRaises(ValueError):await conn.request({'type':kind})
        self.stop.set();await self.agent_task
        conn.received_at-=4
        self.assertEqual(self.manager.status(self.identity)['status'],'stale')
        self.assertFalse(self.console.frame('observer')['robots'][0]['online'])
        with self.assertRaises(ValueError):self.prepare()
        self.assertEqual(self.manager.connect(self.identity)['status'],'stale')
        await self.manager.disconnect(self.identity)
        self.assertEqual(self.console.connections,{})
        self.assertTrue(self.console.frame('observer')['robots'][0]['profile_id'])
        self.assertIsNone(self.console.frame('observer')['robots'][0]['joints'][0]['position'])
        self.assertEqual(self.manager.connect(self.identity)['seq'],0)
        await self.manager.disconnect(self.identity)
        restored=CommissioningTelemetry(self.console,Connection)
        self.assertTrue(restored.status(self.identity)['ready']);self.assertEqual(restored.status(self.identity)['status'],'disconnected')

    async def test_joint_feedback_reaches_shared_frame_without_control(self):
        await self.start_publisher(JOINT_PROTOCOL)
        self.manager.connect(self.identity)
        conn=self.console.connections['new-robot']
        for _ in range(100):
            if conn.received_at:break
            await asyncio.sleep(.03)
        self.assertTrue(conn.received_at)
        state=self.console.frame('commissioning-observer')['robots'][0]
        self.assertEqual(state['protocol'],JOINT_PROTOCOL)
        self.assertTrue(all(j['valid'] for j in state['joints']))
        self.assertAlmostEqual(state['joints'][0]['position'],.39269908169872414)
        self.assertFalse(state['capabilities']['motion']);self.assertIsNone(conn.dealer)
        self.assertFalse(state['torqued'])

    async def test_dossier_changes_require_matching_configuration(self):
        await self.start_publisher()
        registry=self.console.registry;row=registry.public()['robots'][0]
        values={key:row[key] for key in profile(1)};values['hostname']='another-host'
        registry.change(dict(action='save',revision=registry.data['revision'],id=self.identity,robot=values))
        self.assertFalse(self.manager.status(self.identity)['matches'])
        with self.assertRaises(ValueError):self.manager.connect(self.identity)

    async def test_api_origin_no_secret_response_and_runtime_blocked(self):
        base='/api/commissioning/telemetry/'
        payload=dict(profile_id=self.identity,protocol=PROTOCOL,peer_public_key='')
        response=await self.client.post(base+'prepare',json=payload);self.assertEqual(response.status,403)
        headers={'Origin':str(self.client.make_url('')).rstrip('/')}
        response=await self.client.post(base+'prepare',json=payload,headers=headers);self.assertEqual(response.status,200)
        result=await response.json();self.assertNotIn('secret_key',result['config'])
        private=self.manager.read(self.identity)
        response=await self.client.get(base+'status/'+self.identity);self.assertNotIn(private['secret_key'],await response.text())
        response=await self.client.post(base+'prepare',json=dict(payload,protocol='openchicken-runtime-v1'),headers=headers)
        self.assertEqual(response.status,400)
        self.assertEqual(self.console.connections,{})


if __name__=='__main__':unittest.main()
