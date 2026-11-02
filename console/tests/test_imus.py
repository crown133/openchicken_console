"""IMU fake I/O tests. No device nodes are opened."""
import asyncio
import copy
import json
import math
from pathlib import Path
import socket
import struct
import tempfile
import time
import unittest
from unittest.mock import patch

from test_readonly import configs,fixture,ROOT
from test_joints import FakeJoints
from agent.imu_probe import BASELINE,SETUP,Bus,ImuProbe,decode_bmi,decode_lsm,temporary_setup
from agent.imu_agent import SensorAgent
from protocol.readonly import SENSOR_PROTOCOL,validate_state
from host.server import create_app
from aiohttp import ClientSession,web


class FakeBus:
    def __init__(self):
        self.regs=copy.deepcopy(BASELINE);self.writes=[];self.failed=set();self.fail_write=None
    def read(self,address,reg,size=1):
        if address in self.failed:raise OSError('injected bus NACK')
        if (address,reg,size)==(0x19,0x03,1):return b'\x80'
        if (address,reg,size)==(0x19,0x12,9):return struct.pack('<3h',0,0,5461)+b'\x01\x02\x03'
        if (address,reg,size)==(0x68,0x02,6):return struct.pack('<3h',16,-16,0)
        if (address,reg,size)==(0x19,0x22,2):return b'\x00\x00'
        if (address,reg,size)==(0x6a,0x1e,1):return b'\x03'
        if (address,reg,size)==(0x6a,0x20,14):return struct.pack('<7h',256,0,100,-100,16393,0,0)
        return bytes([self.regs[address][reg]])
    def write(self,address,reg,value):
        self.writes.append((address,reg,value));self.regs[address][reg]=value
        if self.fail_write==(address,reg,value):
            self.fail_write=None
            raise OSError('injected failure after hardware write')


class ImuTests(unittest.TestCase):
    def test_units_sign_temperature_and_no_fake_orientation(self):
        bmi=decode_bmi(struct.pack('<3h',16384,-16384,0)+b'\xff\xff\xff',struct.pack('<3h',16384,-16384,0),b'\xff\xe0')
        self.assertAlmostEqual(bmi['accel_m_s2'][0],3*9.80665)
        self.assertAlmostEqual(bmi['gyro_rad_s'][1],math.radians(-1000))
        self.assertEqual(bmi['temperature_c'],22.875);self.assertEqual(bmi['sensor_time_ticks'],2**24-1)
        self.assertFalse(bmi['orientation_calibrated']);self.assertNotIn('quat',bmi)
        lsm=decode_lsm(struct.pack('<7h',-256,100,-100,0,16393,0,0))
        self.assertEqual(lsm['temperature_c'],24);self.assertAlmostEqual(lsm['gyro_rad_s'][0],math.radians(1.75))
        self.assertAlmostEqual(lsm['accel_m_s2'][0],16393*.000061*9.80665)

    def test_only_six_reviewed_setup_registers_and_restore(self):
        bus=FakeBus();report={}
        with patch('agent.imu_probe.time.sleep'):
            with temporary_setup(bus,report) as probe:
                self.assertTrue(all(s['valid'] for s in probe.sample().values()))
        self.assertEqual(bus.writes[:6],list(SETUP));self.assertEqual(bus.regs,BASELINE)
        self.assertTrue(report['restored']);self.assertEqual(len(bus.writes),12)

    def test_partial_setup_failure_restores_all_attempted_registers(self):
        bus=FakeBus();report={};bus.fail_write=SETUP[4]
        with patch('agent.imu_probe.time.sleep'):
            with self.assertRaises(OSError):
                with temporary_setup(bus,report):self.fail('setup should fail')
        self.assertEqual(bus.regs,BASELINE);self.assertTrue(report['restored'])

    def test_restore_failure_is_reported_and_other_restores_continue(self):
        bus=FakeBus();report={}
        with patch('agent.imu_probe.time.sleep'):
            with self.assertRaises(RuntimeError):
                with temporary_setup(bus,report):
                    bus.fail_write=(0x6a,0x11,0)
        self.assertFalse(report['restored']);self.assertTrue(report['restore_errors'])
        self.assertEqual(len(bus.writes),12)
        self.assertEqual(bus.regs,BASELINE)

    def test_not_ready_has_no_valid_zero_sample(self):
        bus=FakeBus();read=bus.read
        def delayed(address,reg,size=1):
            return b'\x00' if (address,reg)==(0x6a,0x1e) else read(address,reg,size)
        with patch.object(bus,'read',side_effect=delayed):
            sample=ImuProbe(bus).sample()
        self.assertTrue(sample['head_imu_raw']['valid']);self.assertFalse(sample['imu_raw']['valid'])
        self.assertIsNone(sample['imu_raw']['accel_m_s2'])

    def test_changed_baseline_sends_no_writes(self):
        bus=FakeBus();report={};bus.regs[0x6a][0x10]=6
        with self.assertRaises(ValueError):
            with temporary_setup(bus,report):self.fail('active sensor must be rejected')
        self.assertEqual(bus.writes,[])

    def test_unapproved_addresses_registers_and_values_rejected_before_ioctl(self):
        bus=Bus.__new__(Bus)
        for args in ((0x18,0x10,0,6),(0x6a,0x12,0,0x80),(0x19,0x7e,0,0xb6),(0x68,0x10,0,3),(0x6b,0x0f,1,None)):
            with self.assertRaises(ValueError):bus.transfer(*args)

    def test_sensor_failure_does_not_hide_other_sensor_or_reuse_values(self):
        bus=FakeBus();probe=ImuProbe(bus);bus.failed={0x19}
        frame=probe.sample();self.assertFalse(frame['head_imu_raw']['valid']);self.assertTrue(frame['imu_raw']['valid'])
        self.assertIsNone(frame['head_imu_raw']['raw_accel']);self.assertIsNone(frame['head_imu_raw']['accel_m_s2'])
        bus.failed.clear();self.assertTrue(probe.sample()['head_imu_raw']['valid'])

    def test_frame_validation_rejects_nonfinite_future_stale_and_orientation(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            a,h=configs('tcp://127.0.0.1:15559');a['protocol']=h['protocol']=SENSOR_PROTOCOL
            agent=SensorAgent(a,FakeJoints(),ImuProbe(FakeBus()),fixture(Path(t)))
            state=agent.sample();self.assertTrue(validate_state(state,h))
            rounded=copy.deepcopy(state)
            for key in ('imu_raw','head_imu_raw'):
                for field in ('accel_m_s2','gyro_rad_s'):
                    rounded[key][field]=[round(v,3) for v in rounded[key][field]]
            self.assertTrue(validate_state(rounded,h))
            for mutate in [lambda s:s['imu_raw']['accel_m_s2'].__setitem__(0,float('nan')),
                           lambda s:s['head_imu_raw'].update(sample_time=s['sample_time']+1),
                           lambda s:s.update(sample_time=s['sample_time']+1),
                           lambda s:s['imu_raw'].update(sensor='BMI088'),
                           lambda s:s['imu_raw'].update(quat=[1,0,0,0]),
                           lambda s:s.update(imu={'valid':True,'quat':[1,0,0,0]})]:
                bad=copy.deepcopy(state);mutate(bad);self.assertFalse(validate_state(bad,h))
            agent.imus.bus.failed={0x19};self.assertTrue(validate_state(agent.sample(),h))


class ImuNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_dual_imu_upload_recording_and_control_denial(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            a,h=configs(f'tcp://127.0.0.1:{port}');a['protocol']=h['protocol']=SENSOR_PROTOCOL
            agent=SensorAgent(a,FakeJoints(),ImuProbe(FakeBus()),fixture(Path(t)))
            stop=asyncio.Event();task=asyncio.create_task(agent.run(stop))
            app=create_app(record_root=Path(t)/'recordings',demos=0,readonly=h);runner=web.AppRunner(app)
            await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
            url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
            try:
                async with ClientSession() as session:
                    async with session.ws_connect(url+'/ws',origin=url) as ws:
                        for _ in range(100):
                            msg=await ws.receive_json(timeout=3)
                            state=msg['robots'][0]
                            if state.get('imu_raw',{}).get('valid'):break
                        self.assertTrue(state['head_imu_raw']['valid']);self.assertTrue(state['joints_valid'])
                        self.assertNotIn('imu',state);self.assertNotIn('head_imu',state)
                        async def command(kind):
                            await ws.send_json(dict(type=kind,id=kind,robot_id='test-radxa',sent_at=time.time()*1000))
                            while True:
                                reply=await ws.receive_json(timeout=3)
                                if reply['type']=='reply':return reply
                        self.assertFalse((await command('enable'))['ok'])
                        started=await command('record_start');self.assertTrue(started['ok'])
                        await asyncio.sleep(.2);await command('record_stop')
                        rows=[json.loads(l) for l in (Path(t)/'recordings'/(started['result']['id']+'.jsonl')).read_text().splitlines()]
                        self.assertEqual(rows[0]['data']['protocol'],SENSOR_PROTOCOL)
                        self.assertTrue(any(r['kind']=='state' and r['data']['head_imu_raw']['sensor']=='BMI088' and r['data']['imu_raw']['sensor']=='LSM6DSV16X' for r in rows))
            finally:stop.set();await task;await runner.cleanup()
