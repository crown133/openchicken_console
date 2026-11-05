"""No robot contact: notification classification and bounded, independent IPC lanes."""
import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from agent.control_stream import ControlStream
from protocol.control_delivery import notification
from protocol.pad import VERSION, DEFAULTS, BINDINGS
from host.server import Connection, Console


class DeliveryTests(unittest.TestCase):
    def test_critical_operations_cannot_suppress_replies(self):
        for kind in ('init', 'relax', 'estop', 'enable', 'pwm', 'claim', 'release', 'set_mode'):
            self.assertFalse(notification(dict(type=kind, reply=False)))
        for action in ('init', 'home', 'toggle', 'relax'):
            self.assertFalse(notification(dict(type='pad_command', reply=False, payload={'actions':[action]})))
        self.assertFalse(notification(dict(type='pad_command', reply=False, payload={'actions':['chirp','init']})))
        self.assertFalse(notification(dict(type='pad_command', reply=False, payload={'actions':[{}]})))
        for kind in ('pad_input', 'drive', 'head', 'action', 'heartbeat'):
            self.assertTrue(notification(dict(type=kind, reply=False)))
            self.assertFalse(notification(dict(type=kind)))
        for action in ('sit_toggle', 'ground_pick', 'kick_left', 'kick_right', 'roulade', 'chirp', 'rest', 'shutdown'):
            self.assertTrue(notification(dict(type='pad_command', reply=False, payload={'actions':[action]})))


class StreamTests(unittest.IsolatedAsyncioTestCase):
    def make_stream(self, slow=None):
        self.calls=[];self.errors=[];self.rpcs=[]
        def factory():
            lane=len(self.rpcs)
            async def call(method, params):
                self.calls.append((lane,method,params))
                if slow is not None:await slow(lane,method,params)
                return {'accepted':True}
            rpc=SimpleNamespace(call=call,close=AsyncMock());self.rpcs.append(rpc);return rpc
        profile=dict(version=VERSION,sha256='test',parameters=DEFAULTS,bindings=BINDINGS)
        return ControlStream(factory,factory,lambda:profile,lambda:None,lambda *args:self.errors.append(args))

    def payload(self, vx=0):
        return dict(version=VERSION,sha256='test',deadline=time.monotonic()+.24,
                    velocity=dict(vx=vx,vy=0,vyaw=0),head=None,pose=None,mouth=0,wheee=False,crow=False)

    async def test_slow_auxiliary_does_not_block_movement_and_latest_replaces_pending(self):
        gate=asyncio.Event()
        async def slow(lane, method, params):
            if lane==1:await gate.wait()
        stream=self.make_stream(slow)
        try:
            for i in range(10):
                stream.submit('pad_input',self.payload(i/100))
                await asyncio.sleep(.01)
            self.assertEqual(len([c for c in self.calls if c[1]=='robot.move']),10)
            self.assertEqual(stream.queues['aux'].qsize(),1)
            gate.set();await asyncio.sleep(.02)
            self.assertEqual(len([c for c in self.calls if c[1]=='robot.mouth']),2)
        finally:await stream.clear()

    async def test_clear_discards_queued_targets_and_actions(self):
        gate=asyncio.Event()
        async def slow(*args):await gate.wait()
        stream=self.make_stream(slow)
        stream.submit('pad_input',self.payload(.1));await asyncio.sleep(.01)
        stream.submit('pad_input',self.payload(.2))
        stream.submit('pad_command',dict(self.payload(),actions=['chirp']))
        await stream.clear();before=len(self.calls);gate.set();await asyncio.sleep(.02)
        self.assertEqual(len(self.calls),before)
        self.assertTrue(all(q.empty() for q in stream.queues.values()))
        self.assertFalse(stream.tasks)

    async def test_expired_input_is_not_forwarded_or_renewed(self):
        stream=self.make_stream()
        try:
            with self.assertRaisesRegex(ValueError,'expired'):
                stream.submit('pad_input',dict(self.payload(),deadline=time.monotonic()-.01))
            self.assertFalse(self.calls)
        finally:await stream.clear()

    async def test_rpc_timeout_is_reported_and_not_retried(self):
        async def slow(*args):await asyncio.sleep(1)
        stream=self.make_stream(slow)
        try:
            stream.submit('pad_command',dict(self.payload(),actions=['chirp'],deadline=time.monotonic()+.03))
            await asyncio.sleep(.07)
            self.assertEqual(len(self.calls),1);self.assertEqual(len(self.errors),1)
            self.assertIn('deadline',self.errors[0][1])
        finally:await stream.clear()

    async def test_action_queue_bounded_and_one_edge_executes_once(self):
        stream=self.make_stream()
        try:
            payload=dict(self.payload(),actions=['chirp'])
            for _ in range(8):stream.submit('pad_command',payload)
            with self.assertRaisesRegex(ValueError,'busy'):stream.submit('pad_command',payload)
            await asyncio.sleep(.03)
            self.assertEqual(len(self.calls),8)
        finally:await stream.clear()

    async def test_notify_creates_no_pending_future(self):
        conn=SimpleNamespace(readonly=False,runtime=True,state={'control_stream_version':1},
                             open_control=Mock(),dealer=SimpleNamespace(send_json=AsyncMock()),pending={})
        result=await Connection.notify(conn,dict(type='drive',payload={}))
        self.assertEqual(result,{'sent':True});self.assertFalse(conn.pending)
        self.assertFalse(conn.dealer.send_json.call_args.args[0]['reply'])
        self.assertNotIn('id',conn.dealer.send_json.call_args.args[0])
        conn.state={}
        with self.assertRaisesRegex(ValueError,'Update'):await Connection.notify(conn,dict(type='drive'))

    async def test_host_notification_checks_owner_and_preserves_deadline(self):
        console=SimpleNamespace(runtime_owners={'robot':'window'},record=Mock(),event=Mock())
        conn=SimpleNamespace(robot_id='robot',received_at=time.monotonic()-.02,
                             state={'sample_time':10},notify=AsyncMock(return_value={'sent':True}),request=AsyncMock())
        msg=dict(type='drive',reply=False,sent_at=(time.time()-.02)*1000,payload={'vx':.1})
        await Console.runtime_command(console,conn,'window',msg,{})
        self.assertLess(conn.notify.call_args.args[0]['payload']['deadline'],10.22)
        conn.request.assert_not_called()
        with self.assertRaisesRegex(ValueError,'接管'):await Console.runtime_command(console,conn,'other',msg,{})
