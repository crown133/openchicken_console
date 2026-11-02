import unittest
from protocol.model import validate_velocity
from protocol.runtime import command
from agent.simulator import RobotSimulation

class GamepadVelocityTests(unittest.TestCase):
    def test_limits_and_legacy_keyboard(self):
        self.assertEqual(command('drive',{'vx':.4,'vy':-.3,'vyaw':1}),('robot.move',{'vx':.4,'vy':-.3,'vyaw':1}))
        self.assertEqual(command('drive',{'vx':.12,'vyaw':.4})[1]['vy'],0)
        for key,limit in [('vx',.4),('vy',.3),('vyaw',1)]:
            for bad in [limit+.001,-limit-.001,float('nan'),float('inf'),True,'0']:
                with self.subTest(key=key,bad=bad),self.assertRaises(ValueError):
                    command('drive',dict(vx=0,vy=0,vyaw=0,**{})|{key:bad})

    def test_lateral_drive_expires_at_original_deadline(self):
        now=[10.];r=RobotSimulation('sim',lambda:now[0]);seq=[0];token=[None]
        def send(kind,payload=None):
            seq[0]+=1
            return r.command(dict(type=kind,payload=payload or {},robot_id='sim',boot_id=r.boot_id,owner='test',token=token[0],seq=seq[0],deadline=now[0]+.25))
        token[0]=send('claim')['token'];send('init');now[0]+=2.1;r.sample();token[0]=send('claim')['token'];send('enable')
        send('drive',dict(vx=0,vy=.3,vyaw=0));self.assertEqual(r.velocity['vy'],.3)
        now[0]+=.251;r.sample();self.assertEqual(r.velocity.get('vy',0),0)

if __name__=='__main__':unittest.main()
