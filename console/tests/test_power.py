"""Fake GPIO and privilege tests; no real device or identity changes."""
import copy
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch,Mock
from test_readonly import configs,fixture,ROOT
from test_joints import FakeJoints
from test_imus import FakeBus
from agent.imu_probe import ImuProbe
from agent.power_probe import PowerProbe
from agent.power_agent import PowerAgent
from protocol.readonly import POWER_PROTOCOL,SENSOR_PROTOCOL,validate_state
from tools.open_pin31 import open_line,handoff,CONSUMER

class PowerTests(unittest.TestCase):
    def test_debounce_bounce_error_recovery_and_read_only_abi(self):
        probe=PowerProbe(9);value=[1];now=[10.]
        def ioctl(fd,op,data,mutate):
            self.assertEqual((fd,op,bytes(data)),(9,0xc010b40e,struct.pack('<QQ',0,1)))
            if value[0] is None:raise OSError('injected failure')
            struct.pack_into('<QQ',data,0,value[0],1)
        with patch('agent.power_probe.fcntl.ioctl',side_effect=ioctl) as io,patch('agent.power_probe.time.monotonic',side_effect=lambda:now[0]):
            def read(v,delta=.11):value[0]=v;now[0]+=delta;return probe.sample()
            self.assertIsNone(read(1)['value']);self.assertIsNone(read(1)['value']);self.assertTrue(read(1)['value']);n=io.call_count
            self.assertTrue(read(0,.01)['value']);self.assertEqual(io.call_count,n)
            self.assertTrue(read(0)['value']);self.assertTrue(read(1)['value'])
            read(0);read(0);self.assertFalse(read(0)['value'])
            failed=read(None);self.assertFalse(failed['valid']);self.assertIsNone(failed['raw']);self.assertIsNone(failed['value'])
            self.assertIsNone(read(1)['value']);read(1);self.assertTrue(read(1)['value']);self.assertTrue(read(1,.4)['value'])

    def setup_request(self,flags=4,name=b'PIN_31',consumer=b'',after_flags=None,fail=False):
        temp=tempfile.TemporaryDirectory(dir=ROOT/'tests');self.addCleanup(temp.cleanup)
        root=Path(temp.name);controller=root/'gpio@fe760000';controller.mkdir()
        chip=root/'gpiochip7';chip.mkdir();(chip/'of_node').symlink_to(controller);calls=[]
        def ioctl(fd,op,data,mutate):
            calls.append(op)
            if op==0xc100b405:
                self.assertEqual(struct.unpack_from('<I',data,64)[0],12);data[:len(name)]=name
                c=consumer if len(calls)==1 else CONSUMER;data[32:32+len(c)]=c
                f=flags if len(calls)==1 else (flags|1 if after_flags is None else after_flags)
                struct.pack_into('<Q',data,72,f)
            elif op==0xc250b407:
                self.assertEqual(len(data),592);self.assertEqual(struct.unpack_from('<I',data,0)[0],12)
                self.assertEqual(data[4:256],bytes(252));self.assertEqual(data[288:560],bytes(272))
                self.assertEqual(struct.unpack_from('<I',data,560)[0],1)
                if fail:raise OSError('busy')
                struct.pack_into('<i',data,588,9)
            else:self.fail('non-read ioctl')
        return root,ioctl,calls

    def test_open_as_is_preserves_bias_and_closes_chip(self):
        root,io,calls=self.setup_request(flags=4|256)
        with patch('tools.open_pin31.os.open',return_value=8) as op,patch('tools.open_pin31.os.close') as close,patch('tools.open_pin31.fcntl.ioctl',side_effect=io):
            self.assertEqual(open_line(root,Path('/fake-dev')),9)
            op.assert_called_once_with(Path('/fake-dev/gpiochip7'),os.O_RDONLY|os.O_CLOEXEC);close.assert_called_once_with(8)
        self.assertEqual(calls,[0xc100b405,0xc250b407,0xc100b405])

    def test_wrong_direction_name_or_owner_refuse_before_request(self):
        for kwargs in ({'flags':5},{'flags':8},{'flags':6},{'name':b'OTHER'},{'consumer':b'busy'}):
            with self.subTest(kwargs=kwargs):
                root,io,calls=self.setup_request(**kwargs)
                with patch('tools.open_pin31.os.open',return_value=8),patch('tools.open_pin31.os.close'),patch('tools.open_pin31.fcntl.ioctl',side_effect=io):
                    with self.assertRaises(RuntimeError):open_line(root)
                self.assertEqual(calls,[0xc100b405])

    def test_changed_flags_and_busy_cleanup(self):
        for kwargs,expected,error in [({'after_flags':9},[9,8],RuntimeError),({'fail':True},[8],OSError)]:
            root,io,calls=self.setup_request(**kwargs)
            with patch('tools.open_pin31.os.open',return_value=8),patch('tools.open_pin31.os.close') as close,patch('tools.open_pin31.fcntl.ioctl',side_effect=io):
                with self.assertRaises(error):open_line(root)
                self.assertEqual([c.args[0] for c in close.call_args_list],expected)

    def test_privilege_drop_precedes_exec(self):
        user=Mock(pw_name='openchicken1',pw_uid=1000,pw_gid=1000);parent=Mock()
        with patch('tools.open_pin31.pwd.getpwnam',return_value=user),patch('tools.open_pin31.os.initgroups',parent.groups),patch('tools.open_pin31.os.setgid',parent.gid),patch('tools.open_pin31.os.setuid',parent.uid),patch('tools.open_pin31.os.getuid',return_value=1000),patch('tools.open_pin31.os.geteuid',return_value=1000),patch('tools.open_pin31.os.set_inheritable',parent.inherit),patch('tools.open_pin31.os.execve',parent.execute):handoff(9)
        self.assertEqual([c[0] for c in parent.mock_calls],['groups','gid','uid','inherit','execute'])
        executable,args,env=parent.execute.call_args.args
        self.assertEqual(executable,'/usr/bin/python3');self.assertIn('agent.power_agent',args);self.assertEqual(set(env),{'PATH','LANG','PYTHONPATH'})

    def test_protocol_unknown_separation_and_independent_failure(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            a,h=configs('tcp://127.0.0.1:15559');a['protocol']=h['protocol']=POWER_PROTOCOL;power=PowerProbe(9)
            def io(fd,op,data,mutate):struct.pack_into('<QQ',data,0,1,1)
            with patch('agent.power_probe.fcntl.ioctl',side_effect=io):
                agent=PowerAgent(a,FakeJoints(),ImuProbe(FakeBus()),power,fixture(Path(t)))
                state=agent.sample();self.assertIsNone(state['system']['external_power']);self.assertTrue(validate_state(state,h))
                for _ in range(2):power.last-=.11;state=agent.sample()
                self.assertTrue(state['system']['external_power']);self.assertTrue(validate_state(state,h))
                bad=copy.deepcopy(state);bad['protocol']=SENSOR_PROTOCOL;self.assertFalse(validate_state(bad,dict(h,protocol=SENSOR_PROTOCOL)))
                for key,value in [('controller','wrong'),('offset',13),('sample_time',state['sample_time']-1),('value',1)]:
                    bad=copy.deepcopy(state);bad['power_input'][key]=value;self.assertFalse(validate_state(bad,h))
                with patch('agent.power_probe.fcntl.ioctl',side_effect=OSError('failed')):power.last-=.11;state=agent.sample()
                self.assertTrue(validate_state(state,h));self.assertIsNone(state['system']['external_power']);self.assertIsNotNone(state['system']['voltage']);self.assertTrue(state['head_imu_raw']['valid']);self.assertTrue(state['joints_valid'])

import asyncio,json,socket,time
from aiohttp import ClientSession,web
from host.server import create_app

class PowerNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_curve_power_states_recording_and_control_denial(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            a,h=configs(f'tcp://127.0.0.1:{port}');a['protocol']=h['protocol']=POWER_PROTOCOL
            value=[1]
            def io(fd,op,data,mutate):
                if value[0] is None:raise OSError('injected read failure')
                struct.pack_into('<QQ',data,0,value[0],1)
            with patch('agent.power_probe.fcntl.ioctl',side_effect=io):
                agent=PowerAgent(a,FakeJoints(),ImuProbe(FakeBus()),PowerProbe(9),fixture(Path(t)))
                stop=asyncio.Event();task=asyncio.create_task(agent.run(stop))
                app=create_app(record_root=Path(t)/'records',demos=0,readonly=h);runner=web.AppRunner(app)
                await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
                url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
                try:
                    async with ClientSession() as session:
                        async with session.ws_connect(url+'/ws',origin=url) as ws:
                            async def wait_power(expected):
                                for _ in range(60):
                                    m=await ws.receive_json(timeout=3)
                                    if m['type']!='state':continue
                                    s=m['robots'][0]
                                    if s.get('power_input') and s['system']['external_power'] is expected:
                                        self.assertTrue(s['joints_valid']);self.assertTrue(s['imu_raw']['valid']);return s
                                self.fail('power value did not propagate')
                            async def command(kind):
                                await ws.send_json(dict(type=kind,id=kind,robot_id='test-radxa',sent_at=time.time()*1000))
                                while True:
                                    m=await ws.receive_json(timeout=3)
                                    if m['type']=='reply':return m
                            await wait_power(True)
                            self.assertFalse((await command('enable'))['ok'])
                            started=await command('record_start');self.assertTrue(started['ok'])
                            value[0]=0;await wait_power(False)
                            value[0]=None;s=await wait_power(None);self.assertIn('injected',s['power_input']['error'])
                            value[0]=1;await wait_power(True);await command('record_stop')
                            rows=[json.loads(line) for line in (Path(t)/'records'/(started['result']['id']+'.jsonl')).read_text().splitlines()]
                            self.assertEqual(rows[0]['data']['protocol'],POWER_PROTOCOL)
                            seen={r['data']['system']['external_power'] for r in rows if r['kind']=='state'}
                            self.assertEqual(seen,{True,False,None});self.assertEqual(rows[-1]['data']['dropped'],0)
                finally:stop.set();await task;await runner.cleanup()
