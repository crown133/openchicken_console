import sys
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from host.server import Console

class PwmBridgeTests(unittest.IsolatedAsyncioTestCase):
    def setup(self):
        console=SimpleNamespace(runtime_owners={})
        conn=SimpleNamespace(robot_id='robot',received_at=time.monotonic(),state={'sample_time':12.,'capabilities':{'pwm':True}},request=AsyncMock(return_value={'enabled':True}))
        msg={'type':'pwm','sent_at':time.time()*1000,'payload':{'action':'enable','pulse_us':1500,'interface':'J15','session':'a'*32}}
        return console,conn,msg
    async def test_uses_existing_channel_without_claiming_body(self):
        c,conn,msg=self.setup();await Console.runtime_command(c,conn,'window',msg,{})
        sent=conn.request.call_args.args[0]
        self.assertEqual(sent['type'],'pwm');self.assertGreater(sent['payload']['deadline'],12.)
        self.assertLessEqual(sent['payload']['deadline'],12.25);self.assertEqual(c.runtime_owners,{})
    async def test_no_capability_or_stale_feedback_rejected(self):
        for case in ('old','unavailable','owned'):
            c,conn,msg=self.setup()
            if case=='old':conn.received_at-=1
            elif case=='unavailable':conn.state['capabilities']['pwm']=False
            else:c.runtime_owners['robot']='other'
            with self.assertRaises(ValueError):await Console.runtime_command(c,conn,'window',msg,{})
            conn.request.assert_not_called()

if __name__=='__main__':unittest.main()

class PwmAgentTests(unittest.IsolatedAsyncioTestCase):
    async def run_command(self,kind,payload):
        import asyncio,json
        from unittest.mock import Mock
        from agent.runtime_agent import RuntimeAgent
        from protocol.pad import VERSION,DEFAULTS,BINDINGS
        class Socket:
            def __init__(self):self.sent=[];self.used=False
            def setsockopt(self,*a):pass
            def bind(self,*a):pass
            def close(self):pass
            async def recv_multipart(self):
                if self.used:raise asyncio.CancelledError()
                self.used=True
                return [b'peer',json.dumps({'id':1,'robot_id':'robot','type':kind,'payload':dict(version=VERSION,sha256='test',deadline=time.monotonic()+.2,**payload)}).encode()]
            async def send_multipart(self,data):self.sent.append(json.loads(data[1]))
        socket=Socket();agent=RuntimeAgent.__new__(RuntimeAgent)
        agent.robot_socket='unused'
        agent.config={'robot_id':'robot','public_key':'x','secret_key':'x','control_endpoint':'unused'}
        agent.rpc=SimpleNamespace(call=AsyncMock(return_value={'accepted':True}),close=AsyncMock())
        agent.pwm_rpc=SimpleNamespace(call=AsyncMock(return_value={'enabled':True}),close=AsyncMock())
        agent.source_rpc=SimpleNamespace(close=AsyncMock())
        agent.pwm_state={'version':2};agent.pwm_session='a'*32
        agent.pad_profile={'version':VERSION,'sha256':'test','parameters':DEFAULTS,'bindings':BINDINGS}
        with patch('agent.runtime_agent.require_console'), patch('agent.runtime_agent.console_allowed', return_value=True):
            with self.assertRaises(asyncio.CancelledError):await agent.commands(SimpleNamespace(socket=lambda *args:socket))
        self.assertTrue(socket.sent[0]['ok'],socket.sent)
        return agent
    async def test_rt_only_requests_sound_robotd_owns_the_paired_action(self):
        agent=await self.run_command('pad_command',{'actions':['chirp']})
        self.assertEqual(agent.rpc.call.call_args.args,('robot.sound',{'tag':'chirp'}))
        agent.pwm_rpc.call.assert_not_called()
    async def test_lt_normalized_value_forwarded_separately(self):
        agent=await self.run_command('pad_input',{'velocity':{'vx':0,'vy':0,'vyaw':0},'head':None,'pose':None,'mouth':.75,'wheee':True})
        method,params=agent.pwm_rpc.call.call_args.args
        self.assertEqual(params['action'],'trigger');self.assertEqual(params['value'],.75)
        self.assertEqual(params['source'],'console')
