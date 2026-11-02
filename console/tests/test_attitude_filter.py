import math
import unittest
from agent.attitude_filter import AttitudeFilter,G,up_in_sensor,norm


def sample(t, accel=None, gyro=None):
    return dict(valid=True,saturated=False,sample_time=t,
                accel_m_s2=accel if accel is not None else [0.,0.,G],
                gyro_rad_s=gyro if gyro is not None else [0.,0.,0.])


def initialized(bias=None,accel=None):
    f=AttitudeFilter(bias or [0.,0.,0.])
    for i in range(61):r=f.update(sample(i*.01,accel,bias))
    assert r['valid']
    return f


def angular_error(q,r):
    return 2*math.acos(min(1,abs(sum(a*b for a,b in zip(q,r)))))


class Tests(unittest.TestCase):
    def test_stationary_initialization_and_gravity_sign(self):
        f=AttitudeFilter([0,0,0]);self.assertFalse(f.update(sample(0))['valid'])
        f=initialized();r=f.update(sample(.61));self.assertEqual(r['gravity'],[0,0,-1]);self.assertFalse(r['strategy_ready'])
    def test_tilted_initialization(self):
        for axis in [0,1]:
            for angle in [-1.3,-.4,.7,1.4]:
                q=[math.cos(angle/2),0.,0.,0.];q[axis+1]=math.sin(angle/2)
                a=[G*v for v in up_in_sensor(q)];f=initialized(accel=a)
                self.assertLess(angular_error(f.q,q),1e-7)
    def test_constant_yaw_exact_integration(self):
        f=initialized()
        for i in range(1,201):r=f.update(sample(.6+i*.01,gyro=[0,0,math.pi/2]))
        self.assertLess(angular_error(r['quat'],[0,0,0,1]),1e-6)
        self.assertAlmostEqual(norm(r['quat']),1)
    def test_roll_dynamic_truth(self):
        f=initialized()
        for i in range(1,101):
            angle=i*.01*math.pi/2;q=[math.cos(angle/2),math.sin(angle/2),0,0]
            r=f.update(sample(.6+i*.01,[G*v for v in up_in_sensor(q)],[math.pi/2,0,0]))
        self.assertLess(angular_error(r['quat'],q),.02)
    def test_bias_removed_without_learning_during_motion(self):
        bias=[.01,-.02,.03];f=initialized(bias)
        for i in range(1,501):r=f.update(sample(.6+i*.01,gyro=bias))
        self.assertLess(angular_error(r['quat'],[1,0,0,0]),1e-7);self.assertEqual(f.bias,bias)
    def test_acceleration_gate_and_long_rejection(self):
        f=initialized();r=f.update(sample(.61,[G,0,G]));self.assertTrue(r['valid']);self.assertFalse(r['accel_correction_used'])
        for i in range(62,120):r=f.update(sample(i*.01,[G,0,G]))
        self.assertFalse(r['valid']);self.assertIsNone(r['quat'])
    def test_gap_duplicate_nan_saturation(self):
        f=initialized();q=f.q[:];self.assertFalse(f.update(sample(.6))['valid']);self.assertEqual(f.q,q)
        self.assertFalse(f.update(sample(1.))['valid']);self.assertIsNone(f.q)
        for alteration in [dict(valid=False),dict(saturated=True),dict(gyro_rad_s=[float('nan'),0,0]),dict(sample_time=float('inf'))]:
            f=initialized();s=sample(.61);s.update(alteration);self.assertFalse(f.update(s)['valid']);self.assertIsNone(f.q)
    def test_initialization_rejects_moving_sensor(self):
        f=AttitudeFilter([0,0,0])
        for i in range(100):self.assertFalse(f.update(sample(i*.01,gyro=[0,0,.5]))['valid'])
    def test_inverted_start(self):
        f=initialized(accel=[0,0,-G]);self.assertLess(norm([a-b for a,b in zip(up_in_sensor(f.q),[0,0,-1])]),1e-6)
    def test_correction_returns_to_gravity(self):
        f=initialized();f.q=[math.cos(.2),math.sin(.2),0,0]
        for i in range(1,501):r=f.update(sample(.6+i*.01))
        self.assertLess(angular_error(r['quat'],[1,0,0,0]),1e-4)

if __name__=='__main__':unittest.main()
