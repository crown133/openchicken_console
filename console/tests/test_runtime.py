"""Console integration against fake IPC sockets; no body code or hardware is executed."""
import asyncio
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
from agent.runtime_agent import RuntimeAgent
from host.server import Console
from protocol.runtime import PROTOCOL, snapshot, orientation
from protocol.model import joint_manifest
from test_readonly import configs

NAMES = [j['name'] for j in joint_manifest()][5:10] + [j['name'] for j in joint_manifest()][10:] + ['mouth'] + [j['name'] for j in joint_manifest()][:5]


def frame():
    return dict(t_ns=time.monotonic_ns(), joints=list(range(15)), targets=[2.]*15,
                submitted=[1.]*15, velocities=[.3]*15, currents_ma=[10.]*15,
                joint_feedback_valid=[i != 9 for i in range(15)],
                imu=dict(gyro=[1.,2.,3.], accel=[0.,0.,9.8], quat=[1.,0.,0.,0.]),
                safety=dict(gravity=[0.,0.,-1.]), enabled=False, bringup='Ready', policy='held')


class MappingTests(unittest.TestCase):
    def test_uses_runtime_order_and_submitted_not_requested(self):
        result = snapshot('robot','boot',1,time.monotonic(),frame(),{'joint_names':NAMES},
                          {'battery':{'volts':7.4},'imu':{'ready':True}}, {}, None, {}, True, True)
        self.assertEqual(result['joints'][0]['position'],10)
        self.assertEqual(result['joints'][0]['requested'],2.)
        self.assertEqual(result['joints'][0]['submitted'],1.)
        self.assertEqual(result['system']['voltage'],7.4)
        self.assertNotIn(34,[j['id'] for j in result['joints']])
        self.assertIsNone(result['joints'][0]['torque'])

    def test_head_mount_is_applied_once_to_vectors_and_quaternion(self):
        q=[0.,0.,0.,1.]
        result=orientation(dict(quat=q,gyro=[1.,2.,3.],accel=[4.,5.,6.]),10,True)
        self.assertEqual(result['quat'],[1.,0.,0.,0.])
        self.assertEqual(result['gyro_rad_s'],[-1.,-2.,3.])
        self.assertEqual(result['accel_m_s2'],[-4.,-5.,6.])
        self.assertEqual(q,[0.,0.,0.,1.])


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_state_and_commands_use_existing_ipc(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
            path=str(Path(directory)/'robot.sock')
            calls=[]; writers=set()
            async def handle(reader,writer):
                writers.add(writer)
                try:
                    while raw:=await reader.readline():
                        request=json.loads(raw);method=request['method'];calls.append((method,request['params']))
                        result={'accepted':True}
                        if method=='robot.model':result={'joint_names':NAMES}
                        elif method=='robot.health':result={'battery':{'volts':7.4},'imu':{'ready':True}}
                        elif method=='robot.policies':result={'skills':['kick_left','kick_right','roulade'],'sitting':False}
                        elif method=='robot.skills':result={'built_in':['sit_toggle'],'skills':[{'name':'unloaded_skill'}]}
                        writer.write((json.dumps(dict(jsonrpc='2.0',id=request['id'],result=result))+'\n').encode())
                        await writer.drain()
                        if method in ('robot.subscribe','head_imu.stream'):
                            while not writer.is_closing():
                                sample=frame() if method=='robot.subscribe' else dict(t_ns=time.monotonic_ns(),gyro=[1.,2.,3.],accel=[0.,0.,9.8],quat=[0.,0.,0.,1.])
                                writer.write((json.dumps(dict(method='robot.state' if method=='robot.subscribe' else 'head_imu.frame',params=sample))+'\n').encode())
                                await writer.drain();await asyncio.sleep(.02)
                except (ConnectionError,asyncio.CancelledError):pass
                finally:writer.close();writers.discard(writer)
            server=await asyncio.start_unix_server(handle,path)
            def endpoint():
                with socket.socket() as s:
                    s.bind(('127.0.0.1',0));return 'tcp://127.0.0.1:'+str(s.getsockname()[1])
            agent_config,host_config=configs(endpoint())
            control=endpoint()
            for c in (agent_config,host_config):c.update(protocol=PROTOCOL,control_endpoint=control,robot_socket=path,head_socket=path)
            agent=RuntimeAgent(agent_config);stop=asyncio.Event()
            running=asyncio.create_task(agent.run(stop))
            console=Console(record_root=Path(directory)/'records',demos=0,readonly=host_config)
            try:
                await console.start({})
                async def wait_state():
                    while not (console.frame('browser')['robots'][0].get('joints_valid') and
                               'sit_toggle' in console.frame('browser')['robots'][0].get('capabilities',{}).get('skills',[])):
                        await asyncio.sleep(.02)
                await asyncio.wait_for(wait_state(),5)
                state=console.frame('browser')['robots'][0]
                self.assertEqual(state['joints'][0]['position'],10)
                self.assertTrue(state['online'])
                self.assertEqual(set(state['capabilities']['skills']),{'sit_toggle','kick_left','kick_right','roulade'})
                leases={}
                async def send(kind,payload=None):
                    return await console.command('browser',dict(robot_id=host_config['robot_id'],type=kind,payload=payload or {},sent_at=time.time()*1000),leases)
                await send('claim');before=len(calls)
                await send('heartbeat')
                self.assertEqual(len(calls),before)
                await send('init');await send('enable')
                await send('drive',{'vx':.1,'vyaw':.2})
                for vx,vyaw in [(.12,0),(-.12,0),(0,.4),(0,-.4)]:
                    await send('drive',{'vx':vx,'vyaw':vyaw})
                    self.assertIn(('robot.move',{'vx':vx,'vy':0.,'vyaw':vyaw}),calls)
                for skill in ['sit_toggle','kick_left','kick_right','roulade']:
                    await send('action',{'skill':skill})
                    self.assertIn(('robot.do',{'skill':skill}),calls)
                await send('relax')
                self.assertIn(('robot.move',{'vx':.1,'vy':0.,'vyaw':.2}),calls)
                self.assertIn(('robot.init',{}),calls)
                self.assertIn(('robot.enable',{'on':True}),calls)
                self.assertIn(('robot.relax',{}),calls)
                self.assertFalse(console.runtime_owners)
                self.assertFalse(any(name in Path(ROOT/'agent/runtime_agent.py').read_text() for name in ('joint_probe', 'imu_probe', 'serial_port')))
            finally:
                stop.set();await asyncio.wait_for(running,5)
                await console.close({})
                server.close();await server.wait_closed()
                for writer in list(writers):writer.close()


if __name__=='__main__':unittest.main()
