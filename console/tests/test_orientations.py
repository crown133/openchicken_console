import copy,hashlib,itertools,json,math,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,Mock
from test_readonly import ROOT,configs,fixture
from test_joints import FakeJoints
from test_imus import FakeBus
from agent.imu_probe import ImuProbe
from agent.imu_orientation import Orientations
from agent.imu_mounting import rotation,transform,DIRECTIONS
from agent.attitude_filter import AttitudeFilter,G,norm
from agent.fusion_agent import FusionAgent
from protocol.readonly import FUSION_PROTOCOL,POWER_PROTOCOL,validate_state


def setup_profile(directory):
    profile=json.loads((ROOT/'agent/imu_calibration.json').read_text());profile['robot_id']='test-radxa'
    path=directory/'calibration.json';path.write_text(json.dumps(profile))
    return path,hashlib.sha256(path.read_bytes()).hexdigest()


def build_agent(directory):
    path,digest=setup_profile(directory);a,h=configs('tcp://127.0.0.1:15559')
    for c in [a,h]:c.update(protocol=FUSION_PROTOCOL,calibration_id=digest)
    orientation=Orientations(path,'test-radxa',digest)
    power=Mock();power.sample.return_value=dict(controller='gpio@fe760000',offset=12,line='PIN_31',sample_time=10.,raw=True,value=True,stable_samples=3,valid=True,error=None)
    bus=FakeBus();agent=FusionAgent(a,FakeJoints(),ImuProbe(bus),power,orientation,fixture(directory))
    return agent,h,power,bus,path


class OrientationTests(unittest.TestCase):
    def test_user_mounts_and_all_right_handed_permutations(self):
        count=0
        for directions in itertools.permutations(DIRECTIONS,3):
            try:r=rotation(dict(zip(['x','y','z'],directions)))
            except ValueError:continue
            count+=1;self.assertEqual([norm(row) for row in r],[1,1,1]);self.assertEqual(norm(transform(r,[1,2,3])),norm([1,2,3]))
        self.assertEqual(count,24)
        self.assertEqual(transform(rotation({'x':'right','y':'forward','z':'up'}),[1,2,3]),[2,-1,3])
        with self.assertRaises(ValueError):rotation({'x':'forward','y':'right','z':'up'})

    def test_pinned_profile_and_level_reference(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            path,digest=setup_profile(Path(t));o=Orientations(path,'test-radxa',digest)
            body,matrix,_=o.entries['imu_raw'];a=transform(matrix,body['level_reference_accel_m_s2'])
            self.assertLess(abs(a[0])+abs(a[1]),1e-8);self.assertGreater(a[2],0)
            self.assertEqual(o.entries['head_imu_raw'][1],[[-1,0,0],[0,-1,0],[0,0,1]])
            with self.assertRaises(ValueError):Orientations(path,'another',digest)
            with self.assertRaises(ValueError):Orientations(path,'test-radxa','0'*64)

    def test_head_half_turn_vectors_bias_gravity_and_attitude(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            path,digest=setup_profile(Path(t))
            for roll,pitch in [(.2,-.3),(-.2,.3),(0.,0.)]:
                o=Orientations(path,'test-radxa',digest)
                entry,_,fusion=o.entries['head_imu_raw'];bias=entry['gyro_bias_rad_s']
                self.assertEqual(fusion.bias,[-bias[0],-bias[1],bias[2]])
                # Independent Rz(yaw) Ry(pitch) Rx(roll) gravity with yaw=0.
                accel=[-G*math.sin(pitch),G*math.sin(roll)*math.cos(pitch),G*math.cos(roll)*math.cos(pitch)]
                expected=AttitudeFilter([0.,0.,0.])
                for i in range(31):
                    omega=[0.,0.,0.] if i<12 else [.06,-.08,.1]
                    raw=dict(valid=True,saturated=False,sample_time=i*.05,
                             accel_m_s2=[-accel[0],-accel[1],accel[2]],
                             gyro_rad_s=[bias[0]-omega[0],bias[1]-omega[1],bias[2]+omega[2]])
                    state={'imu_raw':copy.deepcopy(raw),'head_imu_raw':raw};before=copy.deepcopy(state)
                    result=o.sample(state)['head_imu']
                    reference=expected.update(dict(raw,accel_m_s2=accel,gyro_rad_s=omega))
                    self.assertEqual(state,before)
                    self.assertEqual(result['valid'],reference['valid'])
                    if not result['valid']:
                        self.assertIsNone(result['accel_m_s2']);self.assertIsNone(result['gyro_rad_s']);continue
                    self.assertEqual(result['vectors_frame'],'head_axes')
                    self.assertEqual(result['accel_m_s2'],accel)
                    for a,b in zip(result['gyro_rad_s'],omega):self.assertAlmostEqual(a,b)
                    for field in ['quat','gravity']:
                        for a,b in zip(result[field],reference[field]):self.assertAlmostEqual(a,b)
                    if i==11:
                        w,x,y,z=result['quat']
                        self.assertAlmostEqual(math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),roll)
                        self.assertAlmostEqual(math.asin(2*(w*y-z*x)),pitch)

    def test_wire_failure_recovery_and_old_protocol_rejection(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            agent,h,power,bus,path=build_agent(Path(t));now=[10.]
            with patch('time.monotonic',side_effect=lambda:now[0]):
                def next_state():
                    now[0]+=.05;power.sample.return_value['sample_time']=now[0];return agent.sample()
                s=next_state();self.assertTrue(validate_state(s,h));self.assertFalse(s['imu']['valid'])
                for _ in range(20):s=next_state();self.assertTrue(validate_state(s,h))
                self.assertTrue(s['imu']['valid']);self.assertTrue(s['head_imu']['valid'])
                self.assertFalse(s['imu']['strategy_ready']);self.assertEqual(bus.writes,[])
                original=copy.deepcopy(s)
                metadata=copy.deepcopy(original)
                metadata['imu'].update(method='updated-filter',nominal_update_hz=50,
                                       mounting_status='confirmed',gyro_bias_status='calibrated',
                                       level_reference_status='recorded',gravity=[round(v,3) for v in s['imu']['gravity']])
                self.assertTrue(validate_state(metadata,h))
                for key,value in [('accel_m_s2',[float('nan'),0,0]),('accel_m_s2',None),('accel_m_s2',[1,2]),('vectors_frame','sensor_axes'),('vectors_frame','body_axes')]:
                    bad=copy.deepcopy(original);bad['head_imu'][key]=value;self.assertFalse(validate_state(bad,h),(key,value))
                legacy=copy.deepcopy(original)
                for key in ['imu','head_imu']:
                    legacy[key].pop('accel_m_s2');legacy[key].pop('vectors_frame')
                self.assertTrue(validate_state(legacy,h))
                partial=copy.deepcopy(original);partial['head_imu'].pop('accel_m_s2');self.assertFalse(validate_state(partial,h))
                for key,value in [('strategy_ready',True),('orientation_calibrated',True),('monitor_only',False),('quat',[1,1,0,0]),('gravity',[float('nan'),0,0]),('gyro_rad_s',[float('nan'),0,0]),('calibration_id','0'*64),('frame','sensor_to_world'),('sample_time',0)]:
                    bad=copy.deepcopy(original);bad['imu'][key]=value;self.assertFalse(validate_state(bad,h),(key,value))
                old=copy.deepcopy(original);old['protocol']=POWER_PROTOCOL;self.assertFalse(validate_state(old,dict(h,protocol=POWER_PROTOCOL)))
                bus.failed={0x6a};s=next_state();self.assertTrue(validate_state(s,h));self.assertFalse(s['imu']['valid']);self.assertIsNone(s['imu']['quat']);self.assertIsNone(s['imu']['accel_m_s2']);self.assertTrue(s['head_imu']['valid'])
                bus.failed.clear()
                for _ in range(20):s=next_state()
                self.assertTrue(s['imu']['valid']);self.assertTrue(validate_state(s,h));self.assertEqual(bus.writes,[])

    def test_opener_drops_identity_before_fusion_exec(self):
        from tools.open_fusion_pin31 import handoff
        calls=[]
        with patch('tools.open_fusion_pin31.pwd.getpwnam',return_value=Mock(pw_name='openchicken1',pw_uid=1000,pw_gid=1000)),patch('tools.open_fusion_pin31.os.initgroups',side_effect=lambda *a:calls.append('groups')),patch('tools.open_fusion_pin31.os.setgid',side_effect=lambda *a:calls.append('gid')),patch('tools.open_fusion_pin31.os.setuid',side_effect=lambda *a:calls.append('uid')),patch('tools.open_fusion_pin31.os.getuid',return_value=1000),patch('tools.open_fusion_pin31.os.geteuid',return_value=1000),patch('tools.open_fusion_pin31.os.set_inheritable'),patch('tools.open_fusion_pin31.os.execve',side_effect=lambda *a:calls.append(a)):
            handoff(9)
        self.assertEqual(calls[:3],['groups','gid','uid']);args=calls[3][1]
        self.assertIn('agent.fusion_agent',args);self.assertIn('agent/imu_calibration.json',args)


import asyncio,socket,time
from aiohttp import ClientSession,web
from host.server import create_app

class OrientationNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_protocol_recording_control_denial_and_independent_failure(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            agent,h,power,bus,path=build_agent(Path(t))
            with socket.socket() as socket_:socket_.bind(('127.0.0.1',0));port=socket_.getsockname()[1]
            agent.config['endpoint']=h['endpoint']=f'tcp://127.0.0.1:{port}'
            power.sample.side_effect=lambda:dict(controller='gpio@fe760000',offset=12,line='PIN_31',sample_time=time.monotonic(),raw=True,value=True,stable_samples=3,valid=True,error=None)
            stop=asyncio.Event();task=asyncio.create_task(agent.run(stop))
            app=create_app(record_root=Path(t)/'records',demos=0,readonly=h);runner=web.AppRunner(app)
            await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start();url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
            try:
                async with ClientSession() as session:
                    async with session.ws_connect(url+'/ws',origin=url) as ws:
                        async def wait_valid(valid):
                            for _ in range(80):
                                msg=await ws.receive_json(timeout=3)
                                if msg['type']=='state':
                                    s=msg['robots'][0]
                                    if 'imu' in s and s['imu']['valid']==valid and s['head_imu']['valid']:
                                        self.assertTrue(validate_state(s,h));return s
                            self.fail('fusion state missing')
                        async def command(kind):
                            await ws.send_json(dict(type=kind,id=kind,robot_id='test-radxa',sent_at=time.time()*1000))
                            while True:
                                m=await ws.receive_json(timeout=3)
                                if m['type']=='reply':return m
                        await wait_valid(True);self.assertFalse((await command('enable'))['ok'])
                        recording=await command('record_start');self.assertTrue(recording['ok'])
                        bus.failed={0x6a};s=await wait_valid(False);self.assertIsNone(s['imu']['quat']);self.assertTrue(s['joints_valid'])
                        bus.failed.clear();await wait_valid(True);await command('record_stop')
                        rows=[json.loads(l) for l in (Path(t)/'records'/(recording['result']['id']+'.jsonl')).read_text().splitlines()]
                        self.assertEqual(rows[0]['data']['protocol'],FUSION_PROTOCOL)
                        self.assertEqual({r['data']['imu']['valid'] for r in rows if r['kind']=='state'},{True,False})
                        heads=[r['data']['head_imu'] for r in rows if r['kind']=='state' and r['data']['head_imu']['valid']]
                        self.assertTrue(heads)
                        for head in heads:self.assertEqual(head['vectors_frame'],'head_axes');self.assertEqual(len(head['accel_m_s2']),3)
                        self.assertEqual(rows[-1]['data']['dropped'],0)
            finally:stop.set();await task;await runner.cleanup()

if __name__=='__main__':unittest.main()
