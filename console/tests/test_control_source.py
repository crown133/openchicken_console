import asyncio
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from agent import control_source
from agent.control_stream import ControlStream
from host.server import Console

class GateTests(unittest.TestCase):
    def test_missing_bluetooth_and_transition_are_closed(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(control_source,'MODE',Path(folder)/'mode'):
            for mode in (None,'bluetooth','switching','unavailable'):
                if mode:control_source.MODE.write_text(mode)
                self.assertFalse(control_source.console_allowed())
                with self.assertRaises(ValueError):control_source.require_console()
            control_source.MODE.write_text('console')
            self.assertTrue(control_source.console_allowed())
            control_source.require_console()

class SourceTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, mode='bluetooth'):
        c=SimpleNamespace(runtime_owners={},event=Mock())
        conn=SimpleNamespace(robot_id='robot',state={'control_source':{'mode':mode},'enabled':False,'bringup':'Limp'},request=AsyncMock(return_value={'mode':'console','available':True}))
        return c,conn
    def message(self,kind,**payload):return dict(type=kind,payload=payload,sent_at=time.time()*1000)
    async def test_claim_blocked_for_native_and_unknown(self):
        for mode in ('bluetooth','switching',None):
            c,conn=self.fixture(mode)
            with self.assertRaises(ValueError):await Console.runtime_command(c,conn,'me',self.message('claim'),{})
            self.assertEqual(c.runtime_owners,{})
    async def test_console_claim_and_limp_only_switch(self):
        c,conn=self.fixture('console');leases={}
        await Console.runtime_command(c,conn,'me',self.message('claim'),leases)
        self.assertEqual(c.runtime_owners,{'robot':'me'})
        conn.state['bringup']='Ready'
        with self.assertRaises(ValueError):await Console.runtime_command(c,conn,'me',self.message('control_source',mode='bluetooth'),leases)
        conn.request.assert_not_called()
        conn.state['bringup']='Limp'
        await Console.runtime_command(c,conn,'me',self.message('control_source',mode='console'),leases)
        self.assertEqual(c.runtime_owners,{});self.assertEqual(leases,{})
        self.assertEqual(conn.request.call_args.args[0]['payload'],{'mode':'console'})
    async def test_other_window_cannot_switch(self):
        c,conn=self.fixture();c.runtime_owners={'robot':'other'}
        with self.assertRaises(ValueError):await Console.runtime_command(c,conn,'me',self.message('control_source',mode='console'),{})
        conn.request.assert_not_called()
    async def test_queued_motion_rechecks_gate(self):
        allowed=True
        def gate():
            if not allowed:raise ValueError('source changed')
        rpc=SimpleNamespace(call=AsyncMock(),close=AsyncMock());errors=[]
        stream=ControlStream(lambda:rpc,lambda:rpc,lambda:None,lambda:None,lambda *a:errors.append(a),gate)
        stream.submit('drive',{'vx':.1,'vy':0,'vyaw':0,'deadline':time.monotonic()+.2})
        allowed=False
        await asyncio.sleep(.01)
        rpc.call.assert_not_called();self.assertEqual(len(errors),1)
        await stream.clear()

if __name__=='__main__':unittest.main()
