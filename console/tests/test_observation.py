import copy
import math
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from test_joints import blocks
from test_orientations import ROOT,build_agent
from agent.joint_probe import JointProbe,decode
from protocol.observation import POLICY_IDS,sensor_observation
from protocol.readonly import OBSERVATION_PROTOCOL,FUSION_PROTOCOL,validate_state


def velocity_blocks(device_id=10,raw=-100):
    config,runtime=blocks(device_id)
    runtime=bytearray(runtime);runtime[64:68]=raw.to_bytes(4,'little',signed=True)
    return config,bytes(runtime)


class ObservationTests(unittest.TestCase):
    def test_signed_velocity_and_existing_read_scope(self):
        for raw in (-2**31,-100,-1,0,1,100,2**31-1):
            a,b=velocity_blocks(raw=raw)
            value=decode(a,b,include_velocity=True)
            self.assertEqual(value['raw_velocity'],raw)
            self.assertAlmostEqual(value['velocity'],raw*.229*2*math.pi/60)
            self.assertNotIn('velocity',decode(a,b))
        probe=JointProbe(-1,include_velocity=True)
        probe.configs={i:velocity_blocks(i)[0] for i in POLICY_IDS}
        calls=[]
        def read(fd,i,address,size,stats):
            calls.append((i,address,size))
            if i==23:raise TimeoutError('test')
            return velocity_blocks(i)[1],False
        with patch('agent.joint_probe.read',side_effect=read):rows=probe.sample()
        self.assertEqual(len(calls),14)
        self.assertEqual({(a,n) for _,a,n in calls},{(64,83)})
        bad=next(j for j in rows if j['id']==23)
        self.assertFalse(bad['valid']);self.assertIsNone(bad['velocity']);self.assertNotIn('raw_velocity',bad)
        good=next(j for j in rows if j['id']==20)
        self.assertLessEqual(good['read_started_at'],good['sample_time'])

    def test_policy_order_and_home_match_production_source(self):
        root=ROOT.parent/'openchicken_deploy'
        text=(root/'openchicken-ipc-proto/src/lib.rs').read_text()
        part=re.search(r'pub const JOINT_IDS:.*?= \[(.*?)\];',text,re.S)[1]
        ids=[int(x) for x in re.findall(r'\d+',re.sub(r'//[^\n]*','',part))]
        self.assertEqual(tuple(i for i in ids if i!=34),POLICY_IDS)
        text=(root/'openchicken-control/src/model.rs').read_text()
        part=re.search(r'pub const DEFAULT_POSITION:.*?= \[(.*?)\];',text,re.S)[1]
        home=[float(x) for x in re.findall(r'-?\d+\.\d+',re.sub(r'//[^\n]*','',part))]
        from protocol.model import joint_manifest
        expected={j['id']:j['home'] for j in joint_manifest()}
        self.assertEqual({i:h for i,h in zip(ids,home) if i!=34},expected)

    def test_protocol_validation_reordering_and_missing_values(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            agent,config,power,bus,path=build_agent(Path(t))
            agent.config['protocol']=config['protocol']=OBSERVATION_PROTOCOL
            # Use the real optional decoding path with fake serial responses.
            probe=JointProbe(-1,include_velocity=True)
            probe.configs={i:velocity_blocks(i)[0] for i in POLICY_IDS};agent.joint_probe=probe
            now=[10.]
            def read(fd,i,address,size,stats):return velocity_blocks(i,raw=i)[1],False
            with patch('time.monotonic',side_effect=lambda:now[0]),patch('agent.joint_probe.read',side_effect=read):
                for _ in range(25):
                    now[0]+=.05;power.sample.return_value['sample_time']=now[0];state=agent.sample()
            self.assertTrue(validate_state(state,config))
            rounded=copy.deepcopy(state)
            for joint in rounded['joints']:joint['velocity']=round(joint['velocity'],3)
            self.assertTrue(validate_state(rounded,config))
            report=sensor_observation(state)
            self.assertEqual(report['policy_joint_ids'],list(POLICY_IDS))
            self.assertEqual(report['velocity_rad_s'],[i*.229*2*math.pi/60 for i in POLICY_IDS])
            self.assertTrue(report['measured_fields_available'])
            self.assertFalse(report['strategy_ready']);self.assertIsNone(report['policy_input'])
            shuffled=copy.deepcopy(state);shuffled['joints'].reverse()
            self.assertEqual(sensor_observation(shuffled),report)
            old=copy.deepcopy(state);old['protocol']=FUSION_PROTOCOL
            self.assertFalse(validate_state(old,dict(config,protocol=FUSION_PROTOCOL)))
            for key,value in [('raw_velocity',True),('velocity',float('nan')),('velocity_unit','rpm'),('velocity_frame','trunk'),('read_started_at',now[0]+1),('sample_time',now[0]+1)]:
                bad=copy.deepcopy(state);bad['joints'][0][key]=value
                self.assertFalse(validate_state(bad,config),(key,value))
            missing=copy.deepcopy(state);missing['joints'][0]['velocity']=None
            report=sensor_observation(missing);self.assertFalse(report['measured_fields_available']);self.assertIn(None,report['velocity_rad_s'])
            missing=copy.deepcopy(state);missing['imu']['valid']=False
            report=sensor_observation(missing);self.assertIsNone(report['body_projected_gravity']);self.assertFalse(report['head_imu_used'])


import asyncio
import json
import socket
import time
from aiohttp import ClientSession,web
from host.server import create_app


class ObservationNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_velocity_transport_recording_and_independent_timeout(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as t:
            agent,config,power,bus,path=build_agent(Path(t))
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            for c in (agent.config,config):c.update(protocol=OBSERVATION_PROTOCOL,endpoint=f'tcp://127.0.0.1:{port}')
            agent.joint_probe.probe.include_velocity=True
            power.sample.side_effect=lambda:dict(controller='gpio@fe760000',offset=12,line='PIN_31',sample_time=time.monotonic(),raw=True,value=True,valid=True,stable_samples=3,error=None)
            stop=asyncio.Event();task=asyncio.create_task(agent.run(stop))
            app=create_app(record_root=Path(t)/'records',demos=0,readonly=config);runner=web.AppRunner(app)
            await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start();url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
            try:
                async with ClientSession() as client:
                    async with client.ws_connect(url+'/ws',origin=url) as ws:
                        async def wait_joint(valid):
                            for _ in range(100):
                                m=await ws.receive_json(timeout=3)
                                if m['type']=='state':
                                    s=m['robots'][0]
                                    if s.get('imu',{}).get('valid') and s['joints'][0]['valid']==valid:
                                        self.assertTrue(validate_state(s,config));return s
                            self.fail('observation state missing')
                        async def command(kind):
                            await ws.send_json(dict(type=kind,id=kind,robot_id='test-radxa',sent_at=time.time()*1000))
                            while True:
                                m=await ws.receive_json(timeout=3)
                                if m['type']=='reply':return m
                        state=await wait_joint(True)
                        self.assertEqual(state['joints'][0]['velocity'],0)
                        self.assertFalse((await command('enable'))['ok'])
                        recording=await command('record_start');self.assertTrue(recording['ok'])
                        agent.joint_probe.failed={10};state=await wait_joint(False)
                        self.assertIsNone(state['joints'][0]['velocity'])
                        self.assertIsNotNone(state['joints'][1]['velocity'])
                        agent.joint_probe.failed.clear();await wait_joint(True);await command('record_stop')
                        rows=[json.loads(l) for l in (Path(t)/'records'/(recording['result']['id']+'.jsonl')).read_text().splitlines()]
                        self.assertEqual(rows[0]['data']['protocol'],OBSERVATION_PROTOCOL)
                        self.assertEqual({r['data']['joints'][0]['velocity'] for r in rows if r['kind']=='state'},{None,0})
                        self.assertEqual(rows[-1]['data']['dropped'],0)
            finally:
                stop.set();await task;await runner.cleanup()


if __name__=='__main__':unittest.main()
