"""Console integration against fake IPC sockets; no body code or hardware is executed."""
import asyncio
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
import zmq

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
    def setUp(self):
        from unittest.mock import patch
        for name in ('require_console', 'console_allowed'):
            mock = patch('agent.runtime_agent.'+name, return_value=True)
            mock.start(); self.addCleanup(mock.stop)

    async def test_state_and_commands_use_existing_ipc(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
            path=str(Path(directory)/'robot.sock')
            calls=[]; writers=set(); slow_aux=False
            async def handle(reader,writer):
                writers.add(writer)
                try:
                    while raw:=await reader.readline():
                        request=json.loads(raw);method=request['method'];calls.append((method,request['params']))
                        if slow_aux and method=='robot.mouth':await asyncio.sleep(.12)
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
            pad_config=Path(directory)/'robotd.toml';pad_config.write_text('')
            agent_config['pad_config']=str(pad_config)
            agent=RuntimeAgent(agent_config);stop=asyncio.Event()
            async def fake_source_states():
                agent.control_source={'mode':'console','available':True,'error':None}
                await stop.wait()
            agent.source_states=fake_source_states
            running=asyncio.create_task(agent.run(stop))
            console=Console(record_root=Path(directory)/'records',demos=0,readonly=host_config)
            try:
                await console.start({})
                from host.workspace_session import WorkspaceSession
                workspace = WorkspaceSession(console, 'browser', {})
                await workspace.select('monitor', host_config['robot_id'])
                async def wait_state():
                    while not (console.frame('browser')['robots'][0].get('joints_valid') and
                               'sit_toggle' in console.frame('browser')['robots'][0].get('capabilities',{}).get('skills',[])):
                        await asyncio.sleep(.02)
                await asyncio.wait_for(wait_state(),5)
                # Telemetry SUB and command DEALER perform independent CURVE handshakes.
                # Wait for the command connection explicitly, without queuing a robot command.
                self.assertTrue(await console.connections[host_config['robot_id']].dealer.poll(5000, zmq.POLLOUT))
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
                from protocol.pad import VERSION
                profile=agent.pad_profile
                def pad_payload(**values):
                    return dict(version=VERSION,sha256=profile['sha256'],**values)
                for action in ('toggle','home','ground_pick','rest','shutdown','chirp'):
                    await send('claim')
                    await send('pad_command',pad_payload(actions=[action]))
                self.assertIn(('robot.enable',{'on':False,'toggle':True}),calls)
                self.assertIn(('robot.rest',{}),calls)
                self.assertIn(('robot.shutdown',{}),calls)
                home=calls.index(('robot.enable',{'on':False,'toggle':False}))
                self.assertEqual(calls[home+1],('robot.init',{}))
                await send('pad_input',pad_payload(velocity=dict(vx=0,vy=0,vyaw=0),head=None,pose=None,mouth=.7,wheee=True,crow=True))
                self.assertIn(('robot.mouth',{'open':.7}),calls)
                self.assertIn(('robot.sound',{'tag':'wheee','hold':True}),calls)
                before=len(calls)
                with self.assertRaises(ValueError):
                    await console.command('browser',dict(robot_id=host_config['robot_id'],type='pad_command',payload=pad_payload(actions=['init']),sent_at=(time.time()-.28)*1000),leases)
                self.assertEqual(before,len(calls))
                with self.assertRaises(ValueError):
                    await send('pad_command',dict(pad_payload(actions=['init']),sha256='wrong'))
                self.assertEqual(before,len(calls))
                # Full host -> CURVE/ZMQ -> agent -> native IPC notification path.
                # A slow mouth response must not stall the next movement frame.
                slow_aux=True;before=len(calls)
                for i in range(12):
                    result=await console.command('browser',dict(robot_id=host_config['robot_id'],
                        type='pad_input',reply=False,sent_at=time.time()*1000,
                        payload=pad_payload(velocity=dict(vx=i/100,vy=0,vyaw=0),head=None,
                                            pose=None,mouth=.3,wheee=False,crow=False)),leases)
                    self.assertEqual(result,{'sent':True})
                    self.assertFalse(console.connections[host_config['robot_id']].pending)
                    await asyncio.sleep(.03)
                movement=[params['vx'] for method,params in calls[before:] if method=='robot.move']
                self.assertEqual(movement,[i/100 for i in range(12)])
                for _ in range(2):
                    await console.command('browser',dict(robot_id=host_config['robot_id'],
                        type='pad_command',reply=False,sent_at=time.time()*1000,
                        payload=pad_payload(actions=['chirp'])),leases)
                    await asyncio.sleep(.03)
                self.assertEqual(sum(method=='robot.sound' and params=={'tag':'chirp'}
                                     for method,params in calls[before:]),2)
                slow_aux=False
                await send('release')
                self.assertIn(('robot.pose',{'z':0,'roll':0,'pitch':0,'active':False}),calls)
                self.assertIn(('robot.sound',{'tag':'wheee','hold':False}),calls)
                await send('relax')
                after_relax=len(calls);await asyncio.sleep(.15)
                self.assertFalse(any(method=='robot.move' for method,_ in calls[after_relax:]))
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
