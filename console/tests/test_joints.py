"""Candidate T3 tests: fake register reads only; no hardware access."""
import asyncio
import copy
import json
import math
from pathlib import Path
import socket
import tempfile
import time
import unittest
from unittest.mock import patch

from test_readonly import configs, fixture, ROOT
from agent.joint_probe import JointProbe, decode, read_packet, require_no_torque, wire
from agent.joint_agent import JointAgent
from protocol.readonly import JOINT_PROTOCOL, validate_state
from host.server import create_app
from aiohttp import ClientSession, web


def blocks(device_id=10, count=2048, voltage=75, torque=0, error=0):
    image=bytearray(147)
    for address,size,value,signed in [(7,1,device_id,False),(8,1,3,False),(13,1,2,False),
            (20,4,-512,True),(36,2,885,False),(62,1,255,False),(64,1,torque,False),
            (70,1,error,False),(84,2,400,False),(132,4,count,True),(144,2,voltage,False),(146,1,35,False)]:
        image[address:address+size]=value.to_bytes(size,'little',signed=signed)
    return bytes(image[:64]),bytes(image[64:])


class FakeJoints:
    def __init__(self):
        self.probe=JointProbe(-1)
        self.probe.configs={i:blocks(i)[0] for i in wire.JOINTS}
        self.stats=self.probe.stats
        self.failed=set()
        self.count=2048
    def sample(self):
        def fake(fd,device_id,address,size,stats):
            if device_id in self.failed:raise TimeoutError('injected single servo timeout')
            return blocks(device_id,self.count,75+(device_id%2),error=int(device_id==13))[1],device_id==13
        with patch('agent.joint_probe.read',side_effect=fake):
            return self.probe.sample()


class JointTests(unittest.TestCase):
    def test_fixed_read_packet_scope_and_crc(self):
        for device_id in wire.JOINTS:
            for address,size in ((0,64),(64,83)):
                packet=read_packet(device_id,address,size)
                self.assertEqual(packet[7],2)
                self.assertEqual(wire.crc16(packet[:-2]),int.from_bytes(packet[-2:],'little'))
        for args in ((34,64,83),(254,64,83),(10,64,1),(10,116,4)):
            with self.assertRaises(ValueError):read_packet(*args)
        for instruction in (3,4,5,6,8,0x83,0x93):
            with self.assertRaises(ValueError):wire.packet(10,instruction,b'\x40\x00\x01')

    def test_decode_signed_count_and_offset_not_reapplied(self):
        a,b=blocks(count=2048,error=1)
        row=decode(a,b,True)
        self.assertEqual(row['position'],0)
        self.assertEqual(row['homing_offset'],-512)
        self.assertEqual(row['voltage'],7.5)
        self.assertEqual(row['status'],'error')
        self.assertAlmostEqual(decode(*blocks(count=1024))['position'],-math.pi/2)
        self.assertLess(decode(*blocks(count=-1))['position'],-math.pi)

    def test_single_failure_invalidates_only_that_servo_and_recovers(self):
        fake=FakeJoints();fake.failed={13};joints=fake.sample()
        self.assertEqual(sum(j['valid'] for j in joints),13)
        failed=next(j for j in joints if j['id']==13)
        self.assertIsNone(failed['position']);self.assertIsNone(failed['voltage']);self.assertIsNone(failed['torque'])
        fake.failed.clear()
        self.assertTrue(all(j['valid'] for j in fake.sample()))

    def test_torque_enabled_aborts_without_issuing_control(self):
        with self.assertRaises(RuntimeError):require_no_torque([decode(*blocks(torque=1))])
        require_no_torque([decode(*blocks(torque=0))])

    def test_validator_aggregation_and_system_cadence(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            agent_config,host_config=configs('tcp://127.0.0.1:15558')
            agent_config['protocol']=host_config['protocol']=JOINT_PROTOCOL
            fake=FakeJoints();system=fixture(Path(t));agent=JointAgent(agent_config,fake,system)
            with patch.object(system,'sample',wraps=system.sample) as sample:
                state=agent.sample();agent.sample();self.assertEqual(sample.call_count,1)
            self.assertTrue(validate_state(state,host_config))
            self.assertEqual(state['system']['voltage_samples'],14)
            display=copy.deepcopy(state);display['telemetry_hz']=19
            display['joints'][0].update(label='Right hip yaw',position=.0001)
            display['system']['voltage']=round(display['system']['voltage'],2)
            self.assertTrue(validate_state(display,host_config))
            for mutate in [lambda s:s['joints'][0].update(position=float('nan')),
                           lambda s:s['joints'][0].update(torque=True),
                           lambda s:s['joints'][0].update(submitted=0),
                           lambda s:s['joints'][0].update(id=11),
                           lambda s:s['system'].update(voltage=float('nan')),
                           lambda s:s.update(model_verified=True)]:
                altered=copy.deepcopy(state);mutate(altered);self.assertFalse(validate_state(altered,host_config))
            fake.failed={13};state=agent.sample();self.assertTrue(validate_state(state,host_config));self.assertEqual(state['system']['voltage_samples'],13)
            fake.failed=set(wire.JOINTS);state=agent.sample()
            self.assertTrue(validate_state(state,host_config));self.assertIsNone(state['system']['voltage'])
            self.assertIsNone(state['torqued'])


class JointNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_feedback_recording_and_no_control_channel(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            a,h=configs(f'tcp://127.0.0.1:{port}');a['protocol']=h['protocol']=JOINT_PROTOCOL
            agent=JointAgent(a,FakeJoints(),fixture(Path(t)))
            stop=asyncio.Event();task=asyncio.create_task(agent.run(stop))
            app=create_app(record_root=Path(t)/'recordings',demos=0,readonly=h)
            runner=web.AppRunner(app);await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
            url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
            try:
                conn=app['console'].connections['test-radxa']
                for _ in range(100):
                    if conn.received_at:break
                    await asyncio.sleep(.025)
                self.assertTrue(conn.received_at);self.assertIsNone(conn.dealer)
                self.assertEqual(conn.state['protocol'],JOINT_PROTOCOL)
                async with ClientSession() as session:
                    async with session.ws_connect(url+'/ws',origin=url) as ws:
                        async def command(kind):
                            await ws.send_json(dict(id=kind,type=kind,robot_id='test-radxa',sent_at=time.time()*1000))
                            while True:
                                reply=await ws.receive_json(timeout=3)
                                if reply['type']=='reply':return reply
                        for kind in ('init','relax','drive','write_register'):
                            self.assertFalse((await command(kind))['ok'])
                        result=await command('record_start');self.assertTrue(result['ok'])
                        await asyncio.sleep(.25);self.assertTrue((await command('record_stop'))['ok'])
                        rows=[json.loads(x) for x in (Path(t)/'recordings'/(result['result']['id']+'.jsonl')).read_text().splitlines()]
                        self.assertEqual(rows[0]['data']['protocol'],JOINT_PROTOCOL)
                        self.assertTrue(any(r['kind']=='state' and r['data']['joints'][0]['raw_position']==2048 for r in rows))
            finally:
                stop.set();await task;await runner.cleanup()
