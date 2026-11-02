import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from aiohttp.test_utils import TestClient, TestServer
from host.robot_registry import RobotRegistry, Conflict
from host.server import create_app


def robot(name='new-robot'):
    return dict(robot_id=name, name='', hostname='radxa', address='192.168.3.182',
                ssh_user='robot', ssh_port=22, state_port=5557, control_port=5558,
                robot_public_key='', notes='Assembly reference')


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)/'registry.json'
        self.registry = RobotRegistry(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def change(self, **body):
        return self.registry.change(dict(revision=self.registry.data['revision'], **body))

    def test_persistence_default_archive_and_history(self):
        identity = self.change(action='save', robot=robot())['robots'][0]['id']
        self.change(action='default', id=identity)
        self.change(action='result', id=identity, step='N03.2', result={'status':'accepted','notes':'Operator confirmed direction; photo reference'})
        loaded = RobotRegistry(self.path)
        self.assertEqual(loaded.data, self.registry.data)
        self.assertEqual(loaded.data['default_id'], identity)
        self.change(action='save', id=identity, robot=robot('renamed'))
        self.assertEqual(self.registry.data['robots'][0]['id'], identity)
        self.change(action='delete', id=identity)
        self.assertIsNone(self.registry.data['default_id'])
        self.assertEqual(self.registry.public()['robots'], [])
        self.assertNotIn('archives', self.registry.public())
        self.assertEqual(self.registry.data['archives'][0]['results']['N03.2']['status'], 'accepted')

    def test_conflicts_and_validation_leave_disk_unchanged(self):
        data = self.change(action='save', robot=robot())
        before = self.path.read_bytes()
        with self.assertRaises(Conflict):
            self.registry.change(dict(revision=0, action='save', robot=robot('other')))
        with self.assertRaises(Conflict):self.change(action='save', robot=robot())
        for field, value in [('ssh_port',True),('state_port',0),('robot_id','../x'),('address','x;echo evil'),('robot_public_key','~'*40)]:
            values=robot('other');values[field]=value
            with self.assertRaises(ValueError):self.change(action='save',robot=values)
        values=robot('other');values['secret_key']='do-not-store'
        with self.assertRaises(ValueError):self.change(action='save',robot=values)
        with self.assertRaises(ValueError):
            self.change(action='result',id=data['robots'][0]['id'],step='N01.0',result={'status':'passed','notes':''})
        self.assertEqual(self.path.read_bytes(),before)

    def test_failed_write_leaves_old_revision_and_file(self):
        self.change(action='save',robot=robot());before=copy.deepcopy(self.registry.data)
        with patch('host.robot_registry.os.replace',side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):self.change(action='save',robot=robot('second'))
        self.assertEqual(self.registry.data,before)
        self.assertEqual(json.loads(self.path.read_text()),before)
        self.assertEqual(list(self.path.parent.glob('.robots-*')),[])

    def test_two_registry_instances_cannot_overwrite_a_newer_file(self):
        other=RobotRegistry(self.path)
        self.change(action='save',robot=robot())
        with self.assertRaises(Conflict):
            other.change(dict(action='save',revision=0,robot=robot('other')))
        self.assertEqual(other.public()['robots'][0]['robot_id'],'new-robot')

    def test_reserved_identity_and_active_delete(self):
        with self.assertRaises(Conflict):
            self.registry.change(dict(action='save',revision=0,robot=robot()),reserved={'new-robot'})
        row=self.change(action='save',robot=robot())['robots'][0]
        with self.assertRaises(Conflict):
            self.registry.change(dict(action='delete',revision=1,id=row['id']),active={'new-robot'})


class RegistryApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        app=create_app(demos=0,record_root=Path(self.tmp.name)/'records',registry_path=Path(self.tmp.name)/'robots.json')
        self.client=TestClient(TestServer(app));await self.client.start_server()
        self.origin=str(self.client.make_url('/')).rstrip('/')

    async def asyncTearDown(self):
        await self.client.close();self.tmp.cleanup()

    async def test_origin_validation_and_readonly_stream(self):
        body=dict(action='save',revision=0,robot=robot())
        response=await self.client.post('/api/robots',json=body);self.assertEqual(response.status,403)
        response=await self.client.post('/api/robots',json=body,headers={'Origin':self.origin})
        self.assertEqual(response.status,200);row=(await response.json())['robots'][0]
        async with self.client.ws_connect('/commissioning/ws',headers={'Origin':self.origin}) as ws:
            frame=await ws.receive_json();state=frame['robots'][0]
            self.assertEqual(state['profile_id'],row['id']);self.assertFalse(state['online'])
            self.assertFalse(state['capabilities']['motion'])
            self.assertTrue(all(j['position'] is None for j in state['joints']))
            await ws.send_json(dict(id='forbidden',type='init',robot_id='new-robot'))
            while True:
                message=await ws.receive_json()
                if message['type']=='reply':break
            self.assertFalse(message['ok'])
        for path in ['/commissioning/','/en/commissioning/']:
            response=await self.client.get(path);self.assertEqual(response.status,200)


if __name__=='__main__':unittest.main()
